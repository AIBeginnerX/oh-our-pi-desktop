//! The application state and its reactions: keys, mouse, paste, stream items, link changes. Drawing
//! lives in `ui.rs` and reads this state; nothing here touches the terminal, so it is tested without
//! one. Commands go out through the builders in `commands.rs`.

use crate::clipboard::{self, Why};
use crate::commands::{self, Bootstrap, Ctx, Turn};
use crate::i18n::tr;
use crate::input::{Input, Move};
use crate::link::Target;
use crate::panels_common::{fill, s};
use crate::pet;
use crate::selection::{self, End, Pos, Selection};
use crate::settings::{self, Settings};
use crate::side;
use crate::sidebar::{self, Nav, SETTLED_PAGE, Section, View};
use crate::state::{
    Choice, Conversation, EffortControl, PendingApproval, PendingInput, Shell, ThreadShell,
    effort_control, effort_of, first_usable_model, model_name, usable_models, with_option,
};
use crate::text::{iso_now, new_id, parse_iso_ms};
use crate::theme::{self, Symbols, Theme};
use crate::transcript::Transcript;
use crate::wire::{Rpc, RpcStream, StreamMsg};
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

pub const SHELL_RPC: &str = "orchestration.subscribeShell";
pub const THREAD_RPC: &str = "orchestration.subscribeThread";
pub const DISPATCH_RPC: &str = "orchestration.dispatchCommand";
pub const CONFIG_RPC: &str = "server.getConfig";

/// Turns a thread opens with, and the size of each page of older ones.
pub const TURN_WINDOW: u32 = 20;
/// Threads viewed lately whose folded state is kept, so going back to one resumes from where it
/// was left instead of reading its window again and laying it out from nothing.
pub const RECENT_THREADS: usize = 4;
/// Lines one wheel notch moves.
const WHEEL_LINES: usize = 3;
/// How long the header keeps a tip before the next one.
pub const TIP_EVERY_MS: i64 = 20_000;

/// How the provider on screen is signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthKind {
    ApiKey,
    /// A subscription, with the server's name for the plan when it gives one.
    Subscription(Option<String>),
    SignedOut,
    /// Signed in some other way the server names (a cloud account); shown by that name.
    Other(String),
    /// The server did not say, or the provider is not known.
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LinkStatus {
    Connecting,
    /// Connecting, with what is being done about it (starting the server, pairing).
    Starting(String),
    Online,
    Reconnecting(String),
    Failed(String),
}

pub enum Msg {
    Term(Event),
    Link(LinkStatus),
    Connected {
        rpc: Rpc,
        config: Value,
        server: String,
        /// Where the server is and the login the socket used, for the HTTP page of older turns.
        origin: String,
        bearer: String,
        /// The label the host announces itself with, for the computer picker.
        label: String,
        /// The gateway computer the session talks to; `None` for this computer.
        remote: Option<crate::link::Remote>,
    },
    Shell(Value),
    ShellEnd(Option<String>),
    Thread {
        id: String,
        item: Value,
    },
    ThreadEnd {
        id: String,
        reason: Option<String>,
    },
    Dispatched {
        result: Result<(), String>,
        open: Option<String>,
        /// A request the command answered; forgotten again when the command failed.
        answered: Option<String>,
        /// The id of the message the command sent, if it was a turn start.
        sent: Option<String>,
    },
    Older {
        id: String,
        result: Result<Value, String>,
    },
    /// A copy to the clipboard has finished.
    Copied(clipboard::Outcome),
    /// The clipboard was read for a paste (Ctrl-V, Cmd-V in the message box).
    Clip(Result<String, clipboard::Why>),
    /// The result of work a command started in the background (a request to the server, a lookup):
    /// it runs on the app with the screen as it is by then.
    Ext(Box<dyn FnOnce(&mut App) + Send>),
}

/// The views of the right-hand panel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Workflow,
    Agents,
    Savvy,
    Files,
}

/// How one thread's right-hand panel is set: the view picked, the flow pinned in the Workflow view
/// and how far the wheel moved the body. `App` keeps the on-screen thread's in its own fields and
/// the others' here, so switching threads puts each back as it was left.
#[derive(Clone, PartialEq, Eq, Debug)]
struct SideSetting {
    view: Side,
    pinned_flow: Option<String>,
    scroll: i32,
}

/// Where the conversation sits on the screen as of the last drawing, so the mouse can say which
/// row and cell of it a pointer is over.
#[derive(Clone, Copy, Default, Debug)]
pub struct Geo {
    pub area: Rect,
    /// Blank rows above a short conversation.
    pub pad: usize,
    /// The conversation row at the first row that shows one.
    pub start: usize,
    /// Rows of the transcript proper (not the live lines under it).
    pub rows: usize,
}

/// What the command line asked for at start: `--continue`, `--mode`, and a message to send.
#[derive(Default, Debug, Clone)]
pub struct Launch {
    pub continue_last: bool,
    pub mode: Option<String>,
    pub prompt: Option<String>,
}

/// A copy waiting for the main loop: the text, and the OSC 52 sequence to write for it.
pub struct CopyJob {
    pub text: String,
    pub osc52: Option<String>,
    pub plan: clipboard::Plan,
    /// What the text is, in words, for the notice ("1 command (2 lines)").
    pub what: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    List,
    Composer,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Active {
    None,
    /// A new thread in this project; it exists on the server once the first message is sent.
    Draft(String),
    Thread(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Row {
    AddFolder,
    Item(Nav),
}

impl Row {
    fn selectable(&self) -> bool {
        !matches!(self, Row::Item(Nav::Header(_)))
    }
}

/// A list the user picks from; it takes the keys until it is closed.
#[derive(Clone, PartialEq, Debug)]
pub enum Modal {
    Models {
        filter: String,
        cursor: usize,
    },
    Mode {
        cursor: usize,
    },
    Effort {
        cursor: usize,
    },
    /// A list a command made (`/theme`, `/undo`, ...); `cmd::picked` gets the answer.
    Pick(Pick),
}

/// A plain list of rows with a title. `id` says whose it is; `data` is whatever the owner needs to
/// act on the answer (the value behind each row, say).
#[derive(Clone, PartialEq, Debug)]
pub struct Pick {
    pub id: &'static str,
    pub title: String,
    pub items: Vec<String>,
    pub cursor: usize,
    pub data: Vec<String>,
    /// Text typed into the list, for a list whose last row asks for it (see `folder.rs`).
    pub typed: Option<String>,
}

/// How far the user is through the questions of one request.
#[derive(Default, Debug)]
pub struct QuestionState {
    pub request_id: String,
    pub index: usize,
    /// An option, or one past the last for "your own answer".
    pub cursor: usize,
    pub picked: Vec<bool>,
    pub text: String,
    pub answers: serde_json::Map<String, Value>,
}

/// The lines of the conversation, kept until the thread, its revision, the width, the theme or the
/// symbol set changes.
struct Cached {
    thread_id: String,
    revision: u64,
    width: usize,
    /// The colours and marks it was drawn in: another theme is another picture.
    theme: Theme,
    sym: Symbols,
    lines: Rc<Transcript>,
}

pub struct App {
    pub version: String,
    pub cwd: String,
    pub home: String,
    pub server: Option<String>,
    pub link: LinkStatus,
    pub rpc: Option<Rpc>,
    pub config: Value,
    pub shell: Shell,
    pub focus: Focus,
    pub selected: usize,
    pub active: Active,
    pub conv: Conversation,
    pub input: Input,
    /// What was half-typed in each thread (and each new-thread draft) the box was left in; the box
    /// belongs to the thread on screen, so it is saved here when the thread changes and put back
    /// when it is returned to. Only messages with something in them are kept.
    drafts: HashMap<String, crate::input::Saved>,
    /// The panel's setting of each thread (and draft) that is not on screen, by `draft_key`.
    side_settings: HashMap<String, SideSetting>,
    pub settings: Settings,
    pub theme: Theme,
    pub sym: Symbols,
    pub modal: Option<Modal>,
    pub approval_cursor: usize,
    pub question: QuestionState,
    pub view: View,
    pub notice: Option<String>,
    /// `/provider`: the request the main loop runs in the foreground (`cmd_provider::take_request`),
    /// and the server and home this session was started with, which it talks to.
    pub pending_provider: Option<crate::provider_args::ProviderRequest>,
    /// The bell rings once after the next draw (`notify.rs`); the main loop writes it.
    pub bell_pending: bool,
    /// Ctrl-Z was pressed: the main loop gives the terminal back and stops the process
    /// (`terminal::suspend_process`). Unix only.
    pub suspend_requested: bool,
    pub notifier: crate::notify::Notifier,
    pub provider_server: Option<String>,
    pub provider_home: Option<String>,
    /// `/tasks`: the task list is shown under the conversation.
    pub tasks_on: bool,
    /// The terminal's size as of the last drawing or resize: (columns, rows).
    pub term_size: Cell<(u16, u16)>,
    /// What slash commands said under the conversation (see `notes.rs`).
    pub notes: Vec<crate::notes::Note>,
    /// A full-body screen over the conversation, when one is open (see `screen.rs`).
    pub screen: Option<Box<dyn crate::screen::Screen>>,
    /// The Replay Theater view and its button (see `replay.rs`).
    pub replay: crate::replay::State,
    /// What `/theme`, `/update`, `/threads` and `/projects` keep (see `cmd_misc.rs`).
    pub misc: crate::cmd_misc::State,
    pub quit: bool,
    pub tick: usize,
    /// Messages typed while the agent works; sent one at a time as each turn ends.
    pub queue: VecDeque<String>,
    /// Lines the conversation is scrolled up from its end; 0 follows the end. A `Cell` because the
    /// drawing, which knows the real line count, corrects it.
    pub scroll: Cell<usize>,
    /// The most the conversation can scroll, and its size, as of the last drawing.
    pub scroll_max: Cell<usize>,
    pub page: Cell<usize>,
    pub total: Cell<(usize, usize)>,
    pub last_model_path: PathBuf,
    /// The mouse is reported to the app (wheel, click, drag to copy); `/mouse` and `OOP_MOUSE=off`.
    pub mouse: bool,
    pub selection: Selection,
    /// The screen's width as of the last drawing.
    pub width: Cell<u16>,
    pub geo: Cell<Geo>,
    /// The list's rectangle and, for each row on screen, its y and index into `rows()`.
    pub list_hits: RefCell<(Rect, Vec<(u16, usize)>)>,
    /// The same for the open picker: its rectangle and, for each row on screen, its y and index.
    pub modal_hits: RefCell<(Rect, Vec<(u16, usize)>)>,
    pub clip_plan: clipboard::Plan,
    /// The message box's command list, mouse and clipboard state (see `composer.rs`).
    pub composer: crate::composer::State,
    /// The command line's wishes, carried out once when the projects and threads are known.
    pub launch: Option<Launch>,
    copy_job: Option<CopyJob>,
    /// The right-hand panel: open, which view, and how far its view is scrolled.
    pub side_open: bool,
    pub side_view: Side,
    pub side_rect: Cell<Rect>,
    /// The flow `/dag-workflow N` pinned in the Workflow view (`None` follows the live one), and how
    /// far the wheel moved the panel's body.
    pub pinned_flow: Option<String>,
    pub panel_scroll: Cell<i32>,
    /// Mocha, the header pet: what she remembers, and the picture last drawn.
    pet_memory: pet::Memory,
    pub pet_shown: Cell<Option<(pet::PetState, usize)>>,
    /// The usage panel as last drawn: its pane width and height, and its rows. `None` while hidden.
    pub usage_drawn: RefCell<Option<(u16, u16, Vec<String>)>>,
    /// A fixed clock for the pet and the header's tips, in tests.
    pub pet_clock: Option<i64>,
    /// The tip last drawn; the app repaints for a tip only when the next one differs.
    pub tip_shown: Cell<Option<usize>>,
    /// Running inside OOP Terminal's own window, which has split keys the tips may name.
    pub in_oop_terminal: bool,
    /// A model picked with `/model` or `/effort`, sent with the next turn.
    pub(crate) model_override: Option<Value>,
    /// A mode the user picked on an open thread, shown until the server's own value catches up
    /// (the server may not echo a mode change to this stream before the next turn).
    runtime_intent: Option<String>,
    pub(crate) interaction_intent: Option<String>,
    draft_runtime_mode: String,
    draft_interaction_mode: String,
    /// The crew picked on a conversation not started yet; it goes out with the first message.
    pub(crate) draft_crew: Option<Value>,
    visited: HashMap<String, i64>,
    answered: HashSet<String>,
    cwd_project: Option<String>,
    draft_project: Option<String>,
    adding: Option<String>,
    auto_selected: bool,
    pub(crate) origin: Option<String>,
    pub(crate) bearer: Option<String>,
    /// The label of the host server, for the computer picker's first row.
    pub host_label: String,
    /// The gateway computer the session talks to; `None` on this computer.
    pub remote: Option<crate::link::Remote>,
    /// The computer the link should talk to, changed by the computer picker, and the nudge the
    /// link reconnects on when it does (see `link::supervise`).
    target: tokio::sync::watch::Sender<Target>,
    switch: std::sync::Arc<tokio::sync::Notify>,
    /// Tick at which a queued message was sent; the next waits for the agent to start on it.
    pub(crate) awaiting: Option<usize>,
    /// The message just sent to the open thread (its id, the tick it left): until it comes back
    /// the right-hand panel and the composer's bar show a fresh start, not the work before it. It
    /// ends on the message's echo, on that send failing, or on leaving the thread, never on a
    /// timer: a slow echo (a reconnect) must not bring the work before it back.
    pub(crate) sent: Option<(String, usize)>,
    /// What `/undo`, `/diff` and `/history` are waiting for (see `cmd_history.rs`).
    pub(crate) threadops: crate::cmd_history::State,
    /// The thread usage line under the conversation (see `usage_footer.rs`).
    pub(crate) usage: crate::usage_footer::State,
    cache: RefCell<Option<Cached>>,
    /// The laid-out blocks behind `cache`, so a new revision re-lays-out only what changed.
    blocks: RefCell<crate::transcript::BlockCache>,
    /// Threads left lately, least recently viewed first (see `RECENT_THREADS`).
    recent: Vec<Conversation>,
    tx: UnboundedSender<Msg>,
    shell_task: Option<JoinHandle<()>>,
    thread_task: Option<JoinHandle<()>>,
    /// The server's config events (settings, provider statuses), folded into `config`.
    config_task: Option<JoinHandle<()>>,
    /// The id a draft's thread will have, once something (a goal) needs it before the first
    /// message; `send` uses it and a new draft starts without one.
    pub(crate) draft_id: Option<String>,
    /// Every command built, for the tests.
    #[cfg(test)]
    pub log: Vec<Value>,
}

/// Forwards one subscription's items into the app's message queue. Aborting the task drops the
/// stream, which tells the server to stop.
fn forward(
    mut stream: RpcStream,
    tx: UnboundedSender<Msg>,
    wrap: impl Fn(StreamMsg) -> Msg + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = stream.rx.recv().await {
            let end = matches!(message, StreamMsg::End(_));
            if tx.send(wrap(message)).is_err() || end {
                break;
            }
        }
    })
}

fn now_ms() -> i64 {
    parse_iso_ms(&iso_now()).unwrap_or(0)
}

impl App {
    pub fn new(version: &str, cwd: &str, home: &str, tx: UnboundedSender<Msg>) -> Self {
        App {
            version: version.to_string(),
            cwd: cwd.to_string(),
            home: home.to_string(),
            server: None,
            link: LinkStatus::Connecting,
            rpc: None,
            config: Value::Null,
            shell: Shell::default(),
            focus: Focus::List,
            selected: 0,
            active: Active::None,
            conv: Conversation::default(),
            input: Input::default(),
            drafts: HashMap::new(),
            side_settings: HashMap::new(),
            settings: Settings::default(),
            bell_pending: false,
            suspend_requested: false,
            notifier: Default::default(),
            theme: theme::LAVENDER,
            sym: Symbols::pick(false),
            modal: None,
            approval_cursor: 0,
            question: QuestionState::default(),
            view: View::default(),
            notice: None,
            pending_provider: None,
            provider_server: None,
            provider_home: None,
            tasks_on: false,
            term_size: Cell::new((0, 0)),
            notes: Vec::new(),
            screen: None,
            replay: Default::default(),
            misc: Default::default(),
            quit: false,
            tick: 0,
            queue: VecDeque::new(),
            scroll: Cell::new(0),
            scroll_max: Cell::new(0),
            page: Cell::new(10),
            total: Cell::new((0, 0)),
            last_model_path: settings::last_model_path(),
            mouse: std::env::var("OOP_MOUSE").map_or(true, |v| !v.eq_ignore_ascii_case("off")),
            selection: Selection::default(),
            width: Cell::new(0),
            geo: Cell::new(Geo::default()),
            list_hits: RefCell::new((Rect::default(), Vec::new())),
            modal_hits: RefCell::new((Rect::default(), Vec::new())),
            clip_plan: clipboard::plan(|k| std::env::var(k).ok(), clipboard::Platform::current()),
            composer: crate::composer::State::new(clipboard::read_plan(
                |k| std::env::var(k).ok(),
                clipboard::Platform::current(),
            )),
            launch: None,
            copy_job: None,
            side_open: true,
            side_view: Side::Workflow,
            side_rect: Cell::new(Rect::default()),
            pinned_flow: None,
            panel_scroll: Cell::new(0),
            pet_memory: pet::Memory::new(now_ms()),
            pet_shown: Cell::new(None),
            usage_drawn: RefCell::new(None),
            pet_clock: cfg!(test).then_some(0), // tests must not see the wall clock turn the tips
            tip_shown: Cell::new(None),
            in_oop_terminal: false,
            model_override: None,
            runtime_intent: None,
            interaction_intent: None,
            draft_runtime_mode: "full-access".into(),
            draft_interaction_mode: "default".into(),
            draft_crew: None,
            visited: HashMap::new(),
            answered: HashSet::new(),
            cwd_project: None,
            draft_project: None,
            adding: None,
            auto_selected: false,
            origin: None,
            bearer: None,
            host_label: String::new(),
            remote: None,
            target: tokio::sync::watch::channel(Target::This).0,
            switch: std::sync::Arc::new(tokio::sync::Notify::new()),
            awaiting: None,
            sent: None,
            threadops: Default::default(),
            usage: Default::default(),
            cache: RefCell::new(None),
            blocks: RefCell::new(Default::default()),
            recent: Vec::new(),
            tx,
            shell_task: None,
            thread_task: None,
            config_task: None,
            draft_id: None,
            #[cfg(test)]
            log: Vec::new(),
        }
    }

    /// Applies what `settings.json` says; a theme the build does not have is reported once.
    pub fn configure(&mut self, settings: Settings, warnings: Vec<String>) {
        let level = theme::color_level(
            |k| std::env::var(k).ok(),
            std::io::IsTerminal::is_terminal(&std::io::stdout()),
        );
        let (theme, name, warnings_of_theme) = theme::startup(
            settings.theme.as_deref(),
            level,
            |k| std::env::var(k).ok(),
            &crate::server::config_dir(),
        );
        self.theme = theme;
        self.misc.theme_name = name;
        self.misc.level = level;
        self.sym = Symbols::pick(settings.ascii);
        self.side_open = settings.workflow;
        self.settings = settings;
        let all: Vec<String> = warnings.into_iter().chain(warnings_of_theme).collect();
        if !all.is_empty() {
            self.notice = Some(all.join(" · "));
        }
    }

    // --- derived views ----------------------------------------------------------------------

    /// The list as the desktop sidebar has it; the "add this folder" row leads when the working
    /// folder is not a project yet. On another computer the working folder is a path here, so it
    /// is never offered.
    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        if self.shell.loaded && self.remote.is_none() && self.cwd_project.is_none() {
            rows.push(Row::AddFolder);
        }
        if !self.shell.loaded {
            return rows;
        }
        let current = self.thread_id();
        let nav = sidebar::build(&sidebar::Input {
            threads: &self.shell.threads,
            projects: &self.shell.projects,
            current_id: current.as_deref(),
            draft: matches!(self.active, Active::Draft(_)),
            now_ms: now_ms(),
            visited: &self.visited,
            view: &self.view,
        });
        rows.extend(nav.into_iter().map(Row::Item));
        rows
    }

    /// The header's state word: what is true now.
    pub fn state_key(&self) -> &'static str {
        if self.link != LinkStatus::Online {
            return if matches!(self.link, LinkStatus::Connecting | LinkStatus::Starting(_)) {
                "state.connecting"
            } else {
                "state.offline"
            };
        }
        let waiting = self.shell.threads.iter().any(|t| {
            Some(&t.id) == self.thread_id().as_ref()
                && (t.has_pending_approvals || t.has_pending_user_input)
        }) || self.approval().is_some()
            || self.pending_input().is_some();
        if self.conv.session().is_some_and(|s| s.status == "error") {
            "state.error"
        } else if waiting {
            "state.waiting"
        } else if self.conv.busy() {
            "state.working"
        } else {
            "state.idle"
        }
    }

    pub fn thread_id(&self) -> Option<String> {
        match &self.active {
            Active::Thread(id) => Some(id.clone()),
            _ => None,
        }
    }

    /// The crew the thread on screen has of its own, `None` when it runs the default crew: the one
    /// the server holds with the thread, or (before the thread exists) the one picked in the draft.
    pub fn own_crew(&self) -> Option<&Value> {
        match &self.active {
            Active::Thread(id) => match self.thread_shell(id) {
                Some(shell) => shell.crew.as_ref(),
                None => self.draft_crew.as_ref(),
            },
            Active::Draft(_) => self.draft_crew.as_ref(),
            Active::None => None,
        }
    }

    pub fn thread_shell(&self, id: &str) -> Option<&ThreadShell> {
        self.shell.threads.iter().find(|t| t.id == id)
    }

    /// The model the next turn runs on.
    pub fn current_model(&self) -> Option<Value> {
        if let Some(model) = &self.model_override {
            return Some(model.clone());
        }
        match &self.active {
            Active::Thread(_) if !self.conv.thread.model_selection.is_null() => {
                Some(self.conv.thread.model_selection.clone())
            }
            Active::Draft(project) => self.model_for(project),
            _ => None,
        }
    }

    pub fn model_display(&self) -> String {
        self.current_model()
            .map(|m| model_name(&m))
            .unwrap_or_default()
    }

    pub fn effort_display(&self) -> Option<String> {
        effort_of(&self.config, &self.current_model()?)
    }

    pub fn runtime_mode(&self) -> String {
        match &self.active {
            Active::Thread(_) if self.runtime_intent.is_some() => {
                self.runtime_intent.clone().unwrap_or_default()
            }
            Active::Thread(_) if !self.conv.thread.runtime_mode.is_empty() => {
                self.conv.thread.runtime_mode.clone()
            }
            _ => self.draft_runtime_mode.clone(),
        }
    }

    pub fn interaction_mode(&self) -> String {
        match &self.active {
            Active::Thread(_) if self.interaction_intent.is_some() => {
                self.interaction_intent.clone().unwrap_or_default()
            }
            Active::Thread(_) if !self.conv.thread.interaction_mode.is_empty() => {
                self.conv.thread.interaction_mode.clone()
            }
            _ => self.draft_interaction_mode.clone(),
        }
    }

    /// The conversation as lines for a pane `width` wide, rebuilt only when the thread changed.
    pub fn transcript(&self, width: usize) -> Rc<Transcript> {
        let mut cache = self.cache.borrow_mut();
        if let Some(c) = cache.as_ref()
            && c.thread_id == self.conv.thread_id
            && c.revision == self.conv.revision
            && c.width == width
            && c.theme == self.theme
            && c.sym == self.sym
        {
            return c.lines.clone();
        }
        let lines = Rc::new(crate::transcript::build_cached(
            &self.conv.thread,
            width,
            &self.theme,
            &self.sym,
            &mut self.blocks.borrow_mut(),
        ));
        *cache = Some(Cached {
            thread_id: self.conv.thread_id.clone(),
            revision: self.conv.revision,
            width,
            theme: self.theme,
            sym: self.sym,
            lines: lines.clone(),
        });
        lines
    }

    /// The approval the agent waits for, with the choices to offer.
    pub fn approval(&self) -> Option<PendingApproval> {
        self.conv
            .pending_approvals()
            .into_iter()
            .find(|p| !self.answered.contains(&p.request_id))
    }

    /// `(decision, label)` for an approval: the provider's own, else the standard four.
    pub fn approval_options(&self, pending: &PendingApproval) -> Vec<(String, String)> {
        if !pending.options.is_empty() {
            return pending.options.clone();
        }
        ["accept", "acceptForSession", "decline", "cancel"]
            .iter()
            .map(|d| (d.to_string(), tr(&format!("approval.{d}")).to_string()))
            .collect()
    }

    pub fn pending_input(&self) -> Option<PendingInput> {
        self.conv
            .pending_inputs()
            .into_iter()
            .find(|p| !self.answered.contains(&p.request_id) && !p.questions.is_empty())
    }

    /// Models matching the picker's filter.
    pub fn filtered_models(&self, filter: &str) -> Vec<crate::state::ModelChoice> {
        let wanted = filter.to_lowercase();
        usable_models(&self.config)
            .into_iter()
            .filter(|m| {
                wanted.is_empty()
                    || format!("{} {} {}", m.provider, m.name, m.slug)
                        .to_lowercase()
                        .contains(&wanted)
            })
            .collect()
    }

    pub fn effort_choices(&self) -> Option<EffortControl> {
        effort_control(&self.config, &self.current_model()?)
    }

    // --- messages ---------------------------------------------------------------------------

    pub fn handle(&mut self, msg: Msg) {
        self.react(msg);
        crate::composer::sync(self);
        self.refresh_pet();
    }

    fn react(&mut self, msg: Msg) {
        match msg {
            Msg::Term(Event::Key(key)) if key.kind != KeyEventKind::Release => self.on_key(key),
            Msg::Term(Event::Mouse(mouse)) => self.on_mouse(mouse),
            Msg::Term(Event::Paste(text)) => self.on_paste(&text),
            Msg::Term(Event::Resize(columns, rows)) => {
                self.selection.clear();
                crate::cmd_stats::on_resize(self, columns, rows);
            }
            Msg::Term(_) => {}
            Msg::Copied(outcome) => self.notice = Some(copy_notice(&outcome)),
            Msg::Clip(result) => crate::composer::pasted(self, result),
            Msg::Ext(job) => job(self),
            Msg::Link(status) => {
                if status != LinkStatus::Online {
                    self.rpc = None;
                    self.abort_streams();
                }
                self.link = status;
            }
            Msg::Connected {
                rpc,
                config,
                server,
                origin,
                bearer,
                label,
                remote,
            } => {
                // Another computer (or this one again) is another project list: everything the
                // last session showed is let go, and its list opens fresh.
                let switched = self.remote.as_ref().map(|r| r.environment_id.clone())
                    != remote.as_ref().map(|r| r.environment_id.clone());
                if self.server.as_ref() != Some(&server) || switched {
                    self.recent.clear();
                }
                if switched {
                    self.reset_for_computer();
                }
                self.remote = remote;
                self.host_label = label;
                self.rpc = Some(rpc);
                self.config = config;
                self.server = Some(server);
                self.origin = Some(origin);
                self.bearer = Some(bearer);
                self.link = LinkStatus::Online;
                crate::cmd_misc::on_connected(self);
                self.subscribe_shell();
                self.subscribe_config();
                if let Active::Thread(id) = self.active.clone() {
                    self.subscribe_thread(&id);
                }
            }
            Msg::Shell(item) => {
                self.shell.apply(&item);
                self.on_shell_changed();
            }
            Msg::ShellEnd(reason) => {
                if let (Some(reason), true) = (reason, self.rpc.is_some()) {
                    self.notice = Some(reason);
                }
            }
            Msg::Thread { id, item } => {
                if self.thread_id().as_deref() == Some(id.as_str()) {
                    self.conv.apply(&item);
                    if self.conv.deleted {
                        // Its draft goes with it: there is no thread left to return to.
                        self.input.take(false);
                        self.side_settings.remove(&id);
                        self.pinned_flow = None;
                        self.panel_scroll.set(0);
                        self.active = Active::None;
                        self.notice = Some(tr("notice.deleted").into());
                    } else {
                        self.after_thread_update();
                    }
                }
            }
            Msg::ThreadEnd { id, reason } => {
                if self.thread_id().as_deref() != Some(id.as_str()) || self.rpc.is_none() {
                    return;
                }
                if let Some(reason) = reason {
                    if !self.conv.loaded {
                        self.switch_to(Active::None);
                    }
                    self.notice = Some(format!("thread: {reason}"));
                }
            }
            Msg::Dispatched {
                result,
                open,
                answered,
                sent,
            } => match result {
                Ok(()) => {
                    if let Some(id) = open.filter(|_| matches!(self.active, Active::Draft(_))) {
                        // The draft became this thread: what was typed since the send comes along.
                        let carried = self.input.stash_draft();
                        self.open_thread(&id);
                        if let Some(saved) = carried {
                            self.input.restore(saved);
                        }
                    }
                }
                Err(reason) => {
                    if let Some(request) = answered {
                        self.answered.remove(&request);
                    }
                    self.awaiting = None;
                    // Only the send that failed gives up its fresh start; another command's
                    // failure (an approval reply) leaves it.
                    if sent.is_some() && self.sent.as_ref().map(|(id, _)| id) == sent.as_ref() {
                        self.sent = None;
                    }
                    self.notice = Some(reason);
                }
            },
            Msg::Older { id, result } => {
                if self.thread_id().as_deref() != Some(id.as_str()) {
                    return;
                }
                let failure = result.as_ref().err().cloned();
                match result {
                    Ok(snapshot) => self.conv.apply_older(&snapshot),
                    Err(reason) => {
                        self.conv.loading_older = false;
                        self.notice = Some(format!("{}: {reason}", tr("notice.olderFailed")));
                    }
                }
                crate::cmd_history::on_older(self, failure);
            }
        }
    }

    /// The thread changed: clear a panel that was answered elsewhere, send the next queued message
    /// once the agent is idle.
    fn after_thread_update(&mut self) {
        self.ring_for_update();
        crate::cmd_history::on_thread(self);
        crate::usage_footer::on_thread(self);
        if self.runtime_intent.as_deref() == Some(self.conv.thread.runtime_mode.as_str()) {
            self.runtime_intent = None;
        }
        if self.interaction_intent.as_deref() == Some(self.conv.thread.interaction_mode.as_str()) {
            self.interaction_intent = None;
        }
        if self.awaiting.is_some() {
            if self.conv.busy() {
                self.awaiting = None;
            }
            return;
        }
        if !self.conv.busy()
            && self.approval().is_none()
            && self.pending_input().is_none()
            && !crate::cmd_history::undo_active(self)
            && let Some(text) = self.queue.pop_front()
        {
            self.awaiting = Some(self.tick);
            self.send(&text);
        }
    }

    /// `notify`: asks the notifier whether this update of the open thread is worth a bell.
    fn ring_for_update(&mut self) {
        let Some(id) = self.thread_id() else {
            return;
        };
        let busy = self.conv.busy();
        let pending_key = self
            .conv
            .pending_approvals()
            .first()
            .map(|p| format!("approval:{}", p.request_id))
            .or_else(|| {
                self.conv
                    .pending_inputs()
                    .first()
                    .map(|p| format!("input:{}", p.request_id))
            });
        let update = crate::notify::Update {
            thread_id: &id,
            busy,
            pending_key,
            queue_goes_on: !self.queue.is_empty() && !busy,
            notify: self.settings.notify,
        };
        if self.notifier.observe(&update) {
            self.bell_pending = true;
        }
    }

    fn on_shell_changed(&mut self) {
        // On another computer the working folder is a path on this one, and matches nothing there.
        self.cwd_project = if self.remote.is_none() {
            self.shell
                .projects
                .iter()
                .find(|p| same_folder(&p.workspace_root, &self.cwd))
                .map(|p| p.id.clone())
        } else {
            None
        };
        if let Some(id) = self.adding.clone() {
            if self.shell.projects.iter().any(|p| p.id == id) {
                self.adding = None;
                self.notice = None;
                self.start_draft(&id);
            }
        } else if !self.auto_selected && self.shell.loaded {
            self.auto_selected = true;
            if let Some(id) = self.cwd_project.clone() {
                self.start_draft(&id);
            }
        }
        if self.shell.loaded
            && let Some(launch) = self.launch.take()
        {
            self.run_launch(launch);
        }
        crate::cmd_misc::after_shell(self);
        let count = self.rows().len();
        self.selected = self.selected.min(count.saturating_sub(1));
    }

    /// `oop --continue`, `oop --mode m`, `oop "message"`: the latest thread of this folder's
    /// project, or a new one in it; the message goes out as soon as the conversation is open.
    fn run_launch(&mut self, launch: Launch) {
        if let Some(mode) = launch.mode {
            self.draft_runtime_mode = mode;
        }
        if launch.continue_last
            && let Some(project) = self.cwd_project.clone()
            && let Some(latest) = self
                .shell
                .threads
                .iter()
                .filter(|t| {
                    t.project_id == project
                        && t.archived_at.is_none()
                        && t.parent_thread_id.is_none()
                })
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                .map(|t| t.id.clone())
        {
            self.open_thread(&latest);
        }
        if let Some(prompt) = launch.prompt {
            if self.active == Active::None {
                self.notice = Some(tr("notice.pickFirst").into());
            } else {
                self.send(&prompt);
            }
        }
    }

    /// A way for work in the background to hand its result back (`Msg::Ext`).
    pub fn sender(&self) -> UnboundedSender<Msg> {
        self.tx.clone()
    }

    /// Which computer the session talks to, for the tests of the picker.
    #[cfg(test)]
    pub fn link_target(&self) -> Target {
        self.target.borrow().clone()
    }

    /// What the link needs to reach another computer: the target it reconnects on, and the nudge
    /// that drops the live session so the reconnect starts at once (`link::supervise`).
    pub fn link_control(
        &self,
    ) -> (
        tokio::sync::watch::Sender<Target>,
        std::sync::Arc<tokio::sync::Notify>,
    ) {
        (self.target.clone(), self.switch.clone())
    }

    /// The picker's answer: the link drops the session and comes back on `target`, whose projects
    /// screen opens when it is connected. An unchanged choice does nothing.
    pub fn use_computer(&mut self, target: Target) {
        if *self.target.borrow() == target {
            return;
        }
        self.notice = Some(s("Switching computer…", "컴퓨터를 전환하는 중…").to_string());
        self.target.send_replace(target);
        self.switch.notify_one();
    }

    /// The last session's view of a computer is not the next one's: the conversation, the project
    /// list, everything drafted and every pending question go, and the new computer's project
    /// list opens as soon as its snapshot arrives.
    fn reset_for_computer(&mut self) {
        self.leave_thread();
        self.recent.clear();
        self.drafts.clear();
        self.side_settings.clear();
        self.visited.clear();
        self.answered.clear();
        self.cwd_project = None;
        self.draft_project = None;
        self.adding = None;
        self.auto_selected = false;
        self.threadops = Default::default();
        self.shell = Shell::default();
        self.conv = Conversation::default();
        self.active = Active::None;
        self.selected = 0;
        self.scroll.set(0);
        self.input.take(false);
        self.notice = None;
        crate::lists::open_projects(self);
    }

    fn leave_thread(&mut self) {
        crate::cmd_history::on_leave(self);
        self.notes.clear();
        crate::cmd_goal::drop_draft_goal(self);
        if let Active::Thread(id) = &self.active {
            self.visited.insert(id.clone(), now_ms());
        }
        self.abort_thread();
        self.modal = None;
        self.queue.clear();
        self.awaiting = None;
        self.sent = None;
        self.model_override = None;
        self.runtime_intent = None;
        self.interaction_intent = None;
        self.scroll.set(0);
        self.total.set((0, 0));
        self.approval_cursor = 0;
        self.question = QuestionState::default();
    }

    /// Keeps the open thread's state for a quick return, and the last few only.
    fn park_conversation(&mut self) {
        let conv = std::mem::take(&mut self.conv);
        if conv.loaded && !conv.deleted && !conv.thread_id.is_empty() {
            self.recent.retain(|c| c.thread_id != conv.thread_id);
            self.recent.push(conv);
            if self.recent.len() > RECENT_THREADS {
                self.recent.remove(0);
            }
        }
    }

    pub(crate) fn start_draft(&mut self, project_id: &str) {
        self.park_conversation();
        self.leave_thread();
        self.draft_id = None;
        self.draft_crew = None;
        self.switch_to(Active::Draft(project_id.to_string()));
        self.draft_project = Some(project_id.to_string());
        self.conv = Conversation::default();
        self.focus = Focus::Composer;
    }

    pub(crate) fn open_thread(&mut self, id: &str) {
        self.park_conversation();
        self.leave_thread();
        self.visited.insert(id.to_string(), now_ms());
        self.switch_to(Active::Thread(id.to_string()));
        // A thread left lately comes back as it was and catches up from its last sequence; one the
        // shell no longer lists is read afresh.
        let known = self.shell.loaded && self.shell.threads.iter().any(|t| t.id == id);
        let parked = self.recent.iter().position(|c| c.thread_id == id);
        self.conv = match parked {
            Some(at) if known => {
                let mut conv = self.recent.remove(at);
                conv.loading_older = false;
                conv.revision += 1;
                conv
            }
            _ => Conversation::new(id),
        };
        self.focus = Focus::Composer;
        self.subscribe_thread(id);
    }

    /// Makes `next` the thread on screen, and the message box goes with it: what is half-typed is
    /// kept for the thread being left, and the one being entered gets its own back (an empty box
    /// if it has none). With no thread on screen the box has no owner, so what is typed there
    /// follows into whatever opens next, unless that has a draft of its own.
    fn switch_to(&mut self, next: Active) {
        if let Some(key) = draft_key(&self.active) {
            match self.input.stash_draft() {
                Some(saved) => {
                    self.drafts.insert(key, saved);
                }
                None => {
                    self.drafts.remove(&key);
                }
            }
        }
        if let Some(saved) = draft_key(&next).and_then(|key| self.drafts.remove(&key)) {
            self.input.restore(saved);
        }
        self.keep_side_setting(&next);
        self.active = next;
    }

    /// The panel's view, pin and scroll go with the thread being left, and the one being entered
    /// gets its own back. A thread not seen before starts unpinned and unscrolled, on the view
    /// that is up (that choice is the user's, not the thread's data).
    fn keep_side_setting(&mut self, next: &Active) {
        if let Some(key) = draft_key(&self.active) {
            let setting = SideSetting {
                view: self.side_view,
                pinned_flow: self.pinned_flow.take(),
                scroll: self.panel_scroll.get(),
            };
            self.side_settings.insert(key, setting);
        }
        self.pinned_flow = None;
        self.panel_scroll.set(0);
        if let Some(saved) = draft_key(next).and_then(|key| self.side_settings.remove(&key)) {
            self.side_view = saved.view;
            self.pinned_flow = saved.pinned_flow;
            self.panel_scroll.set(saved.scroll);
        }
    }

    // --- subscriptions ----------------------------------------------------------------------

    fn abort_thread(&mut self) {
        if let Some(task) = self.thread_task.take() {
            task.abort();
        }
    }

    fn abort_streams(&mut self) {
        self.abort_thread();
        if let Some(task) = self.shell_task.take() {
            task.abort();
        }
        if let Some(task) = self.config_task.take() {
            task.abort();
        }
    }

    /// Follows the server's config events for the rest of the session, so the crew line, the model
    /// lists and the goals stay current when settings change (here or in another client).
    fn subscribe_config(&mut self) {
        if let Some(task) = self.config_task.take() {
            task.abort();
        }
        let Some(rpc) = self.rpc.clone() else { return };
        let stream = rpc.stream(crate::config_fold::CONFIG_STREAM, json!({}));
        self.config_task = Some(forward(stream, self.tx.clone(), |message| match message {
            StreamMsg::Item(event) => Msg::Ext(Box::new(move |app| app.apply_config_event(&event))),
            // The socket's own end is what the link watches; a stream that ends alone just stops
            // updating until the next connect.
            StreamMsg::End(_) => Msg::Ext(Box::new(|_| {})),
        }));
    }

    /// Folds one config event into `config`.
    pub fn apply_config_event(&mut self, event: &Value) {
        crate::config_fold::fold(&mut self.config, event);
    }

    fn subscribe_shell(&mut self) {
        let Some(rpc) = self.rpc.clone() else { return };
        let payload = if self.shell.loaded {
            json!({"afterSequence": self.shell.sequence})
        } else {
            json!({})
        };
        let stream = rpc.stream(SHELL_RPC, payload);
        self.shell_task = Some(forward(stream, self.tx.clone(), |m| match m {
            StreamMsg::Item(item) => Msg::Shell(item),
            StreamMsg::End(reason) => Msg::ShellEnd(reason),
        }));
    }

    /// Opens a thread's stream. A thread already on screen resumes after the last event applied;
    /// a new one opens on its latest turns (the older ones are read as they are scrolled to).
    fn subscribe_thread(&mut self, id: &str) {
        self.abort_thread();
        // The usage line is this thread's, not the last one's, and is asked for afresh.
        crate::usage_footer::opened(self, id);
        let Some(rpc) = self.rpc.clone() else { return };
        let mut payload = json!({"threadId": id});
        let flags = [
            ("reasoningMessages", "reasoningMessages"),
            ("threadResumeCompletionMarker", "requestCompletionMarker"),
        ];
        for (offered, field) in flags {
            if self.config[offered] == Value::Bool(true) {
                payload[field] = Value::Bool(true);
            }
        }
        if let (true, Some(sequence)) = (
            self.conv.loaded && self.conv.thread_id == id,
            self.conv.sequence,
        ) {
            payload["afterSequence"] = json!(sequence);
        } else if self.config["threadSnapshotPagination"] == Value::Bool(true) {
            payload["turnLimit"] = json!(TURN_WINDOW);
        }
        let stream = rpc.stream(THREAD_RPC, payload);
        let thread_id = id.to_string();
        self.thread_task = Some(forward(stream, self.tx.clone(), move |m| match m {
            StreamMsg::Item(item) => Msg::Thread {
                id: thread_id.clone(),
                item,
            },
            StreamMsg::End(reason) => Msg::ThreadEnd {
                id: thread_id.clone(),
                reason,
            },
        }));
    }

    /// Reads the page of turns before the oldest one held, over HTTP.
    pub(crate) fn request_older(&mut self) {
        let (Some(id), Some(cursor), Some(origin), Some(bearer)) = (
            self.thread_id(),
            self.conv.older_cursor.clone(),
            self.origin.clone(),
            self.bearer.clone(),
        ) else {
            return;
        };
        if !self.conv.has_more || self.conv.loading_older {
            return;
        }
        self.conv.loading_older = true;
        self.conv.revision += 1;
        let tx = self.tx.clone();
        // On another computer the environment's HTTP answers behind the gateway path of the host.
        let prefix = self.remote.as_ref().map_or(String::new(), |r| {
            crate::gateway::environment_prefix(&r.environment_id)
        });
        tokio::spawn(async move {
            let path = format!(
                "{prefix}/api/orchestration/threads/{id}?reasoningMessages=true&turnLimit={TURN_WINDOW}&beforeCursor={}",
                crate::http::form_encode(&cursor)
            );
            let headers = [("Authorization", format!("Bearer {bearer}"))];
            let result = crate::http::request(
                "GET",
                &origin,
                &path,
                &headers,
                None,
                std::time::Duration::from_secs(20),
            )
            .await
            .and_then(|answer| {
                if answer.status == 200 {
                    answer.json()
                } else {
                    Err(format!("the server answered {}", answer.status))
                }
            });
            let _ = tx.send(Msg::Older { id, result });
        });
    }

    pub(crate) fn dispatch(
        &mut self,
        command: Value,
        open: Option<String>,
        answered: Option<String>,
    ) {
        #[cfg(test)]
        self.log.push(command.clone());
        let Some(rpc) = self.rpc.clone() else {
            if let Some(request) = answered {
                self.answered.remove(&request);
            }
            self.notice = Some(tr("notice.offline").into());
            return;
        };
        let tx = self.tx.clone();
        let sent = (command["type"] == "thread.turn.start")
            .then(|| command["message"]["messageId"].as_str().map(str::to_string))
            .flatten();
        tokio::spawn(async move {
            let result = rpc.call(DISPATCH_RPC, command).await.map(|_| ());
            let _ = tx.send(Msg::Dispatched {
                result,
                open,
                answered,
                sent,
            });
        });
    }

    // --- panels, list and pet ---------------------------------------------------------------

    /// The thread list is open (it gives way on a narrow screen).
    pub fn list_shown(&self) -> bool {
        // Before the first drawing the width is not known; the list is assumed to be there.
        let width = self.width.get();
        self.settings.sidebar && (width == 0 || width >= crate::ui::SIDEBAR_MIN_COLUMNS)
    }

    /// The right-hand panel has room and is open.
    pub fn side_shown(&self) -> bool {
        self.side_open && self.active != Active::None && self.side_rect.get().width > 0
    }

    fn flip_side(&mut self) {
        self.side_view = self.side_view.next();
    }

    /// A click on a title of the panel's tab bar shows that view.
    fn click_side_tab(&mut self, column: u16, row: u16) {
        let rect = self.side_rect.get();
        // The bar is the panel's first row, inside the border on the left and a one-cell margin.
        if row != rect.y {
            return;
        }
        let offset = usize::from(column.saturating_sub(rect.x + 2));
        if column >= rect.x + 2
            && let Some(view) = crate::panels_common::tab_at(offset)
        {
            self.side_view = Side::of(view);
            self.panel_scroll.set(0);
        }
    }

    /// `/dag-workflow`, `/savvy` and `/files`: each shows its own view; with the panel closed it opens,
    /// with the other view up it switches, and the same command again (or `off`) closes it. The
    /// words after it also pick which flow the Workflow view shows (`N`, `next`, `prev`, `live`).
    fn panel_command(&mut self, view: Side, argument: &str) -> bool {
        let usage = match view {
            Side::Workflow => "/dag-workflow [on|off|N|next|prev|live]",
            Side::Agents => "/panel [on|off]",
            Side::Savvy => "/savvy [on|off]",
            Side::Files => "/files [on|off]",
        };
        let Some(action) = side::parse_flow_action(argument) else {
            self.notice = Some(format!("{}{usage}", s("Usage: ", "사용법: ")));
            return true;
        };
        let open = self.side_open;
        let shown = open.then_some(self.side_view);
        let mut movement = side::plan_panel_move(view, action, shown);
        // A panel with no room (no thread, window too narrow) is not on screen, so there is nothing
        // for the bare command to close: it asks for the panel and says why it cannot be seen.
        if movement == side::PanelMove::Close
            && action == side::FlowAction::Toggle
            && !self.panel_fits()
        {
            movement = side::PanelMove::Open;
        }
        if movement == side::PanelMove::Close {
            self.side_open = false;
            self.notice = Some(tr("notice.panelOff").into());
            return true;
        }
        if action == side::FlowAction::Off {
            if let Some(shown) = shown.filter(|shown| *shown != view) {
                self.notice = Some(off_elsewhere(view, shown));
            }
            return true;
        }
        if !matches!(action, side::FlowAction::Toggle | side::FlowAction::On) {
            let problem = match view {
                Side::Workflow => {
                    let (ids, live) = side::flow_ids(self);
                    let result = side::choose_flow(&ids, live, &mut self.pinned_flow, action);
                    self.panel_scroll.set(0);
                    result.err()
                }
                Side::Agents | Side::Savvy | Side::Files => matches!(
                    action,
                    side::FlowAction::Pick(_) | side::FlowAction::Next | side::FlowAction::Prev
                )
                .then(|| {
                    fill(
                        s(
                            "The {view} panel shows the current turn. Pick a flow with {command} <number>.",
                            "{view} 창은 현재 턴을 보여 줍니다. 흐름 고르기는 {command} <번호> 로 합니다.",
                        ),
                        &[
                            ("view", view.name().into()),
                            ("command", "/dag-workflow".into()),
                        ],
                    )
                }),
            };
            if let Some(problem) = problem {
                self.notice = Some(problem);
                return true;
            }
        }
        if movement == side::PanelMove::Nothing {
            return true;
        }
        self.side_open = true;
        self.side_view = view;
        if movement == side::PanelMove::Open {
            self.notice = Some(self.panel_on_notice());
        }
        true
    }

    fn pet_now(&self) -> i64 {
        self.pet_clock.unwrap_or_else(now_ms)
    }

    /// Which tip the header shows: the tips turn over every `TIP_EVERY_MS` on the wall clock, so a
    /// repaint is due only when this number changes.
    pub fn tip_index(&self) -> usize {
        let slot = usize::try_from(self.pet_now().max(0) / TIP_EVERY_MS).unwrap_or(0);
        slot % crate::i18n::tip_count(self.in_oop_terminal)
    }

    /// The window title: the product's line, never a thread's name, with a mark in front while a
    /// turn runs.
    pub fn window_title(&self) -> String {
        let mark = if self.state_key() == "state.working" {
            format!("{} ", if self.settings.ascii { "*" } else { "◆" })
        } else {
            String::new()
        };
        format!("{mark}OOP — {}", crate::i18n::TAGLINE)
    }

    /// The provider instance the next turn runs on, from the server's config.
    fn current_provider(&self) -> Option<&Value> {
        let model = self.current_model()?;
        let instance = model["instanceId"].as_str()?;
        self.config["providers"]
            .as_array()?
            .iter()
            .find(|p| p["instanceId"].as_str() == Some(instance))
    }

    /// The provider's name for the header: its display name, else its instance id.
    pub fn provider_name(&self) -> Option<String> {
        let model = self.current_model()?;
        self.current_provider()
            .and_then(|p| p["displayName"].as_str())
            .or_else(|| model["instanceId"].as_str())
            .map(str::to_string)
    }

    /// How the provider is signed in, from `auth` of its entry in the server's config
    /// (`ServerProviderAuth`): never guessed, `Unknown` when the server does not say.
    pub fn auth_kind(&self) -> AuthKind {
        let Some(auth) = self.current_provider().map(|p| &p["auth"]) else {
            return AuthKind::Unknown;
        };
        let label = auth["label"].as_str().filter(|l| !l.is_empty());
        if auth["status"].as_str() == Some("unauthenticated") {
            AuthKind::SignedOut
        } else if auth["type"].as_str() == Some("apiKey") {
            AuthKind::ApiKey
        } else if auth["type"].as_str() == Some("chatgpt")
            || label.is_some_and(|l| l.to_lowercase().ends_with("subscription"))
        {
            AuthKind::Subscription(label.map(str::to_string))
        } else {
            label.map_or(AuthKind::Unknown, |l| AuthKind::Other(l.to_string()))
        }
    }

    /// The folder the open thread works in: its worktree, else its project's folder, else where
    /// oop was started.
    pub fn workdir(&self) -> String {
        let project = |id: &str| {
            self.shell
                .projects
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.workspace_root.as_str())
        };
        let candidates: Vec<Option<&str>> = match &self.active {
            Active::Thread(id) => {
                let loaded = self.conv.thread_id == *id;
                let shell = self.thread_shell(id);
                vec![
                    self.conv.thread.worktree_path.as_deref().filter(|_| loaded),
                    shell.and_then(|t| t.worktree_path.as_deref()),
                    shell.and_then(|t| project(&t.project_id)),
                    project(&self.conv.thread.project_id).filter(|_| loaded),
                ]
            }
            Active::Draft(project_id) => vec![project(project_id)],
            Active::None => Vec::new(),
        };
        pick_folder(candidates, &self.cwd)
    }

    /// What the thread is doing, as far as the pet cares.
    fn pet_observation(&self) -> pet::Observation {
        let phase = match &self.active {
            Active::None => pet::Phase::None,
            Active::Draft(_) => pet::Phase::Idle,
            Active::Thread(_) => {
                if self.approval().is_some() || self.pending_input().is_some() {
                    pet::Phase::Waiting
                } else if self.conv.session().is_some_and(|s| s.status == "error") {
                    pet::Phase::Error
                } else if self.conv.busy() {
                    pet::Phase::Working
                } else {
                    pet::Phase::Idle
                }
            }
        };
        let tool = self
            .conv
            .thread
            .activities
            .iter()
            .rev()
            .find(|a| a.kind.starts_with("tool."))
            .is_some_and(|a| a.kind == "tool.started" || a.kind == "tool.updated");
        pet::Observation {
            phase,
            tool,
            streaming: self.streaming_tail(),
            online: !matches!(
                self.link,
                LinkStatus::Reconnecting(_) | LinkStatus::Failed(_)
            ),
            model: self.pet_model(),
        }
    }

    /// The model the next message goes to. A thread's model changing is a switch (she jumps);
    /// opening another thread is not.
    fn pet_model(&self) -> Option<pet::Model> {
        let scope = match &self.active {
            Active::Thread(id) => id.clone(),
            Active::Draft(project) => format!("draft:{project}"),
            Active::None => return None,
        };
        let selection = self.current_model()?;
        let instance = selection["instanceId"].as_str().unwrap_or_default();
        let model = selection["model"].as_str().unwrap_or_default();
        Some(pet::Model {
            scope,
            key: format!("{instance}/{model}"),
        })
    }

    pub fn pet_state(&self) -> pet::PetState {
        self.pet_memory
            .state(&self.pet_observation(), self.pet_now())
    }

    /// The frame the pet shows now: still on the first when animations are off.
    pub fn pet_frame(&self, state: pet::PetState) -> usize {
        if self.settings.animations {
            self.pet_memory.frame(state, self.pet_now())
        } else {
            0
        }
    }

    /// How far right in her strip the pet stands: she paces it while a turn runs (animations on),
    /// `roam` being the cells the strip she is drawn in has to spare.
    pub fn pet_offset(&self, state: pet::PetState, roam: usize) -> usize {
        if self.settings.animations {
            pet::offset(state, self.pet_now(), roam)
        } else {
            0
        }
    }

    fn refresh_pet(&mut self) {
        let observation = self.pet_observation();
        self.pet_memory.observe(&observation, self.pet_now());
    }

    // --- mouse, selection and copying -------------------------------------------------------

    /// The conversation row and cell under a pointer; `None` outside the conversation or over the
    /// blank rows above a short one. With `clamp`, a pointer past an edge counts as that edge.
    fn pos_at(&self, x: u16, y: u16, clamp: bool) -> Option<Pos> {
        let g = self.geo.get();
        let a = g.area;
        if a.width == 0 || a.height == 0 {
            return None;
        }
        let inside = x >= a.x && x < a.right() && y >= a.y && y < a.bottom();
        if !inside && !clamp {
            return None;
        }
        let x = x.clamp(a.x, a.right() - 1);
        let y = y.clamp(a.y, a.bottom() - 1);
        let line = usize::from(y - a.y);
        let row = if line < g.pad {
            if !clamp {
                return None;
            }
            g.start
        } else {
            g.start + line - g.pad
        };
        if g.rows == 0 {
            return None;
        }
        Some(Pos {
            row: row.min(g.rows - 1),
            col: usize::from(x - a.x),
        })
    }

    fn on_mouse(&mut self, m: MouseEvent) {
        self.on_mouse_at(m, std::time::Instant::now());
    }

    /// `on_mouse` with the time of the event, which a double click is told by.
    pub(crate) fn on_mouse_at(&mut self, m: MouseEvent, now: std::time::Instant) {
        if crate::composer::mouse(self, m, now) {
            return;
        }
        if self.modal.is_some() {
            self.on_modal_mouse(m);
            return;
        }
        let at =
            |r: Rect| m.column >= r.x && m.column < r.right() && m.row >= r.y && m.row < r.bottom();
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let up = m.kind == MouseEventKind::ScrollUp;
                if let Some(screen) = self.screen.as_mut() {
                    screen.wheel(up);
                    return;
                }
                if crate::replay::on_wheel(self, up) {
                    return;
                }
                // Over the right-hand panel the wheel moves the panel's body.
                if self.side_shown() && at(self.side_rect.get()) {
                    let step = WHEEL_LINES as i32;
                    self.panel_scroll
                        .set(self.panel_scroll.get() + if up { -step } else { step });
                    return;
                }
                // The panel follows the live work and windows itself; the wheel is the
                // conversation's.
                if up {
                    self.scroll_up(WHEEL_LINES)
                } else {
                    self.scroll_down(WHEEL_LINES)
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if crate::replay::on_click(self, m.column, m.row) {
                    self.selection.press(None);
                    return;
                }
                let list = self.list_hits.borrow().clone();
                if self.list_shown() && at(list.0) {
                    self.selection.press(None);
                    if let Some((_, index)) = list.1.iter().find(|(y, _)| *y == m.row) {
                        self.selected = *index;
                        self.focus = Focus::List;
                        self.activate_row();
                    }
                    return;
                }
                if self.side_shown() && at(self.side_rect.get()) {
                    self.selection.press(None);
                    self.click_side_tab(m.column, m.row);
                    return;
                }
                self.selection.press(self.pos_at(m.column, m.row, false));
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let a = self.geo.get().area;
                if m.row < a.y {
                    self.scroll_up(1);
                } else if m.row >= a.bottom() {
                    self.scroll_down(1);
                }
                if let Some(pos) = self.pos_at(m.column, m.row, true) {
                    self.selection.drag(pos);
                }
            }
            MouseEventKind::Up(MouseButton::Left) => match self.selection.release() {
                End::Select => self.copy_selection(),
                End::Click | End::None => {}
            },
            _ => {}
        }
    }

    /// Queues `text` for the clipboard: OSC 52 and the platform's tool, as the main loop carries out.
    pub fn copy_text(&mut self, text: String) {
        self.copy_named(text, None);
    }

    /// `copy_text`, with a name for the notice to give the text.
    pub fn copy_named(&mut self, text: String, what: Option<String>) {
        let osc52 = clipboard::osc52(&text, self.clip_plan.tmux, clipboard::OSC52_MAX_BASE64);
        self.copy_job = Some(CopyJob {
            text,
            osc52,
            plan: self.clip_plan.clone(),
            what,
        });
    }

    /// Takes the selected text from the conversation and queues it for the clipboard.
    fn copy_selection(&mut self) {
        let Some(range) = self.selection.range() else {
            return;
        };
        let width = usize::from(self.geo.get().area.width);
        let (lines, meta) = self.transcript(width).rows();
        let text = selection::text(&lines, &meta, range);
        if text.is_empty() {
            self.selection.clear();
            return;
        }
        self.copy_text(text);
    }

    /// The copy the main loop has to carry out, if any.
    pub fn take_copy(&mut self) -> Option<CopyJob> {
        self.copy_job.take()
    }

    // --- scrolling --------------------------------------------------------------------------

    pub fn scroll_up(&mut self, lines: usize) {
        let next = self.scroll.get() + lines;
        self.scroll.set(next);
        if next >= self.scroll_max.get() {
            self.request_older();
        }
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll.set(self.scroll.get().saturating_sub(lines));
    }

    // --- keys -------------------------------------------------------------------------------

    fn on_key(&mut self, key: KeyEvent) {
        self.selection.clear();
        self.pet_memory.touch(self.pet_now());
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
            crate::composer::ctrl_c(self);
            return;
        }
        #[cfg(unix)]
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('z')) {
            self.suspend_requested = true;
            return;
        }
        // The side panel's two tabs: Shift-Tab flips them, and Tab too where the list is not open
        // to take it.
        if self.side_shown()
            && self.modal.is_none()
            && (key.code == KeyCode::BackTab || (key.code == KeyCode::Tab && !self.list_shown()))
        {
            self.flip_side();
            return;
        }
        if crate::replay::on_key(self, key) {
            return;
        }
        if let Some(mut screen) = self.screen.take() {
            if !screen.key(key, self) && self.screen.is_none() {
                self.screen = Some(screen);
            }
            return;
        }
        if self.modal.is_some() {
            self.on_modal_key(key);
            return;
        }
        if self.pane_key(key) {
            return;
        }
        match self.focus {
            Focus::Composer if self.approval().is_some() => self.on_approval_key(key),
            Focus::Composer if self.pending_input().is_some() => self.on_question_key(key),
            Focus::Composer => self.on_composer_key(key),
            Focus::List => self.on_list_key(key),
        }
    }

    pub(crate) fn on_paste(&mut self, text: &str) {
        match &mut self.modal {
            Some(Modal::Models { filter, cursor }) => {
                filter.push_str(&text.replace(['\n', '\r'], " "));
                *cursor = 0;
                return;
            }
            Some(_) => return,
            None => {}
        }
        if self.pending_input().is_some() && self.focus == Focus::Composer {
            self.question
                .text
                .push_str(&text.replace(['\n', '\r'], " "));
            return;
        }
        self.focus = Focus::Composer;
        self.input.paste(text);
    }

    fn on_composer_key(&mut self, key: KeyEvent) {
        if crate::composer::key(self, key) {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let sup = key.modifiers.contains(KeyModifiers::SUPER);
        let alt = key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Enter if alt => self.input.newline(),
            KeyCode::Enter => self.submit(),
            KeyCode::Char('j') if ctrl => self.input.newline(),
            KeyCode::Tab if self.list_shown() => self.focus = Focus::List,
            KeyCode::Esc => {
                if self.conv.busy() && self.thread_id().is_some() {
                    self.interrupt();
                } else {
                    self.focus = Focus::List;
                }
            }
            KeyCode::Char('u') if ctrl => self.input.kill_to_start(),
            KeyCode::Char('k') if ctrl => self.input.kill_to_end(),
            KeyCode::Char('w') if ctrl => self.input.kill_word(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char(ch) if !ctrl && !sup => self.input.insert(ch),
            KeyCode::Backspace => self.input.backspace(),
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => {
                self.input.mv(Move::Left, false);
            }
            KeyCode::Right => {
                self.input.mv(Move::Right, false);
            }
            KeyCode::Home => {
                self.input.mv(Move::Home, false);
            }
            KeyCode::End => {
                self.input.mv(Move::End, false);
            }
            KeyCode::Up => {
                if !self.input.mv(Move::Up, false) {
                    self.input.history_back();
                }
            }
            KeyCode::Down => {
                if !self.input.mv(Move::Down, false) {
                    self.input.history_forward();
                }
            }
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            _ => {}
        }
    }

    fn on_list_key(&mut self, key: KeyEvent) {
        let rows = self.rows();
        let step = |from: usize, forward: bool| -> usize {
            let mut at = from;
            loop {
                let next = if forward {
                    (at + 1).min(rows.len().saturating_sub(1))
                } else {
                    at.saturating_sub(1)
                };
                if next == at || rows.get(next).is_some_and(Row::selectable) {
                    return if rows.get(next).is_some_and(Row::selectable) {
                        next
                    } else {
                        from
                    };
                }
                at = next;
            }
        };
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.selected = step(self.selected, false),
            KeyCode::Down | KeyCode::Char('j') => self.selected = step(self.selected, true),
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            KeyCode::Char('q') => self.quit = true,
            // The composer is reachable with no thread open: slash commands (`/provider`, `/theme`,
            // `/projects`, ...) need no thread, and a plain message there says to pick one first.
            KeyCode::Tab | KeyCode::Esc => self.focus = Focus::Composer,
            KeyCode::Char('n') => {
                let project = match rows.get(self.selected) {
                    Some(Row::Item(Nav::Thread(row))) => {
                        self.thread_shell(&row.id).map(|t| t.project_id.clone())
                    }
                    _ => None,
                };
                self.new_thread_in(project);
            }
            KeyCode::Enter => self.activate_row(),
            _ => {}
        }
    }

    /// Opens the selected row of the list: a thread, a new thread, a shelf, "show more".
    fn activate_row(&mut self) {
        let rows = self.rows();
        match rows.get(self.selected).cloned() {
            Some(Row::AddFolder) => self.add_folder(),
            Some(Row::Item(Nav::New { .. })) => self.new_thread(),
            Some(Row::Item(Nav::Thread(row))) => self.open_thread(&row.id),
            Some(Row::Item(Nav::Shelf { section, .. })) => match section {
                Section::Snoozed => self.view.snoozed_open = !self.view.snoozed_open,
                _ => self.view.settled_open = !self.view.settled_open,
            },
            Some(Row::Item(Nav::More { .. })) => self.view.settled_shown += SETTLED_PAGE,
            _ => {}
        }
    }

    /// A new thread: the folder is chosen first (see `folder.rs`), the project in use leading.
    pub(crate) fn new_thread(&mut self) {
        self.new_thread_in(None);
    }

    /// The same, with `project` leading the list of folders where one is asked for.
    pub(crate) fn new_thread_in(&mut self, project: Option<String>) {
        crate::folder::open(self, project);
    }

    /// The project a new thread goes in: the working folder's, else the last one used, else the
    /// first there is.
    pub(crate) fn draft_project_id(&self) -> Option<String> {
        self.cwd_project
            .clone()
            .or_else(|| self.draft_project.clone())
            .or_else(|| self.shell.projects.first().map(|p| p.id.clone()))
    }

    pub(crate) fn add_folder(&mut self) {
        let cwd = self.cwd.clone();
        self.add_project(&cwd);
    }

    /// The project already rooted at `folder`, if there is one.
    pub(crate) fn project_in(&self, folder: &str) -> Option<String> {
        self.shell
            .projects
            .iter()
            .find(|p| same_folder(&p.workspace_root, folder))
            .map(|p| p.id.clone())
    }

    /// Asks the server to add `folder` as a project; a draft in it opens once the list shows it.
    pub(crate) fn add_project(&mut self, folder: &str) {
        if self.adding.is_some() {
            return;
        }
        let project_id = new_id();
        let title = std::path::Path::new(folder)
            .file_name()
            .map_or_else(|| folder.to_string(), |n| n.to_string_lossy().into_owned());
        self.adding = Some(project_id.clone());
        self.notice = Some(tr("notice.adding").into());
        let command = commands::project_create(&Ctx::fresh(), &project_id, &title, folder);
        self.dispatch(command, None, None);
    }

    // --- approvals and questions ------------------------------------------------------------

    fn on_approval_key(&mut self, key: KeyEvent) {
        let Some(pending) = self.approval() else {
            return;
        };
        let options = self.approval_options(&pending);
        let last = options.len().saturating_sub(1);
        self.approval_cursor = self.approval_cursor.min(last);
        let pick = match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.approval_cursor = self.approval_cursor.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.approval_cursor = (self.approval_cursor + 1).min(last);
                None
            }
            KeyCode::Char(c @ '1'..='9') => {
                let index = c as usize - '1' as usize;
                (index <= last).then_some(index)
            }
            KeyCode::Enter => Some(self.approval_cursor),
            KeyCode::Tab | KeyCode::Esc => {
                self.focus = Focus::List;
                None
            }
            KeyCode::PageUp => {
                self.scroll_up(self.page.get().max(1));
                None
            }
            KeyCode::PageDown => {
                self.scroll_down(self.page.get().max(1));
                None
            }
            _ => None,
        };
        let (Some(index), Some(thread_id)) = (pick, self.thread_id()) else {
            return;
        };
        self.answered.insert(pending.request_id.clone());
        self.approval_cursor = 0;
        let command = commands::approval_respond(
            &Ctx::fresh(),
            &thread_id,
            &pending.request_id,
            &options[index].0,
        );
        self.dispatch(command, None, Some(pending.request_id));
    }

    fn on_question_key(&mut self, key: KeyEvent) {
        let Some(pending) = self.pending_input() else {
            return;
        };
        if self.question.request_id != pending.request_id {
            self.question = QuestionState {
                request_id: pending.request_id.clone(),
                ..Default::default()
            };
        }
        let index = self.question.index.min(pending.questions.len() - 1);
        let question = &pending.questions[index];
        let own = question.options.len();
        if self.question.picked.len() != own {
            self.question.picked = vec![false; own];
        }
        let state = &mut self.question;
        match key.code {
            KeyCode::Up => state.cursor = state.cursor.saturating_sub(1),
            KeyCode::Down => state.cursor = (state.cursor + 1).min(own),
            KeyCode::Tab | KeyCode::Esc => self.focus = Focus::List,
            KeyCode::PageUp => self.scroll_up(self.page.get().max(1)),
            KeyCode::PageDown => self.scroll_down(self.page.get().max(1)),
            KeyCode::Char(' ') if question.multi_select && state.cursor < own => {
                state.picked[state.cursor] = !state.picked[state.cursor];
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.cursor = own;
                state.text.push(ch);
            }
            KeyCode::Backspace => {
                state.text.pop();
            }
            KeyCode::Enter => {
                let label = |i: usize| question.options[i].0.clone();
                let typed = state.text.trim().to_string();
                let answer = if question.multi_select {
                    let mut chosen: Vec<String> =
                        (0..own).filter(|i| state.picked[*i]).map(label).collect();
                    if !typed.is_empty() {
                        chosen.push(typed);
                    }
                    if chosen.is_empty() && state.cursor < own {
                        chosen.push(label(state.cursor));
                    }
                    (!chosen.is_empty()).then(|| json!(chosen))
                } else if !typed.is_empty() {
                    Some(json!(typed))
                } else if state.cursor < own {
                    Some(json!(label(state.cursor)))
                } else {
                    None
                };
                let Some(answer) = answer else { return };
                state.answers.insert(question.id.clone(), answer);
                state.index += 1;
                state.cursor = 0;
                state.text.clear();
                state.picked.clear();
                if state.index >= pending.questions.len() {
                    let answers = Value::Object(std::mem::take(&mut state.answers));
                    *state = QuestionState::default();
                    let Some(thread_id) = self.thread_id() else {
                        return;
                    };
                    self.answered.insert(pending.request_id.clone());
                    let command = commands::user_input_respond(
                        &Ctx::fresh(),
                        &thread_id,
                        &pending.request_id,
                        &answers,
                    );
                    self.dispatch(command, None, Some(pending.request_id));
                }
            }
            _ => {}
        }
    }

    // --- pickers ----------------------------------------------------------------------------

    fn on_modal_key(&mut self, key: KeyEvent) {
        let Some(modal) = self.modal.clone() else {
            return;
        };
        let count = match &modal {
            Modal::Models { filter, .. } => self.filtered_models(filter).len(),
            Modal::Mode { .. } => commands::RUNTIME_MODES.len(),
            Modal::Effort { .. } => self.effort_choices().map_or(0, |c| c.choices.len()),
            Modal::Pick(pick) => pick.items.len(),
        };
        let cursor_of = |m: &Modal| match m {
            Modal::Models { cursor, .. } | Modal::Mode { cursor } | Modal::Effort { cursor } => {
                *cursor
            }
            Modal::Pick(pick) => pick.cursor,
        };
        let cursor = cursor_of(&modal).min(count.saturating_sub(1));
        let set_cursor = |app: &mut App, to: usize| match &mut app.modal {
            Some(
                Modal::Models { cursor, .. } | Modal::Mode { cursor } | Modal::Effort { cursor },
            ) => *cursor = to,
            Some(Modal::Pick(pick)) => pick.cursor = to,
            None => {}
        };
        match key.code {
            KeyCode::Esc => self.modal = None,
            KeyCode::Up => set_cursor(self, cursor.saturating_sub(1)),
            KeyCode::Down => set_cursor(self, (cursor + 1).min(count.saturating_sub(1))),
            KeyCode::Backspace => match &mut self.modal {
                Some(Modal::Models { filter, cursor }) => {
                    filter.pop();
                    *cursor = 0;
                }
                Some(Modal::Pick(pick)) => crate::folder::backspace(pick),
                _ => {}
            },
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                match &mut self.modal {
                    Some(Modal::Models { filter, cursor }) => {
                        filter.push(ch);
                        *cursor = 0;
                    }
                    Some(Modal::Pick(pick)) => crate::folder::type_char(pick, ch),
                    _ => {}
                }
            }
            // No path typed yet: the list waits for one instead of closing.
            KeyCode::Enter if matches!(&modal, Modal::Pick(pick) if crate::folder::waits_for_path(pick, cursor)) =>
                {}
            KeyCode::Enter if count > 0 => {
                self.modal = None;
                match modal {
                    Modal::Models { filter, .. } => {
                        if let Some(model) = self.filtered_models(&filter).get(cursor).cloned() {
                            self.pick_model(&model.instance_id, &model.slug);
                        }
                    }
                    Modal::Mode { .. } => self.set_runtime_mode(commands::RUNTIME_MODES[cursor].0),
                    Modal::Effort { .. } => {
                        if let Some(control) = self.effort_choices() {
                            let value = control.choices[cursor].0.clone();
                            self.pick_effort(&control.descriptor_id, &value);
                        }
                    }
                    Modal::Pick(pick) => crate::cmd::picked(self, &pick, cursor),
                }
            }
            _ => {}
        }
    }

    /// The mouse over an open list: a click on a row picks it, the wheel moves the pointer; the
    /// rest does nothing, so a list is never answered by a click that was meant for what is behind it.
    fn on_modal_mouse(&mut self, m: MouseEvent) {
        match m.kind {
            MouseEventKind::ScrollUp => self.on_modal_key(KeyEvent::from(KeyCode::Up)),
            MouseEventKind::ScrollDown => self.on_modal_key(KeyEvent::from(KeyCode::Down)),
            MouseEventKind::Down(MouseButton::Left) => {
                let (rect, rows) = self.modal_hits.borrow().clone();
                let inside = m.column >= rect.x
                    && m.column < rect.right()
                    && m.row >= rect.y
                    && m.row < rect.bottom();
                let Some((_, index)) = rows.iter().find(|(y, _)| inside && *y == m.row) else {
                    return;
                };
                match &mut self.modal {
                    Some(
                        Modal::Models { cursor, .. }
                        | Modal::Mode { cursor }
                        | Modal::Effort { cursor },
                    ) => *cursor = *index,
                    Some(Modal::Pick(pick)) => pick.cursor = *index,
                    None => return,
                }
                self.on_modal_key(KeyEvent::from(KeyCode::Enter));
            }
            _ => {}
        }
    }

    fn pick_model(&mut self, instance_id: &str, model: &str) {
        let selection = json!({"instanceId": instance_id, "model": model});
        settings::write_last_model(&self.last_model_path, &selection);
        self.notice = Some(format!(
            "{}: {}",
            tr("notice.model"),
            model_name(&selection)
        ));
        self.model_override = Some(selection);
    }

    fn pick_effort(&mut self, descriptor_id: &str, value: &str) {
        let Some(model) = self.current_model() else {
            return;
        };
        let selection = with_option(&model, descriptor_id, value);
        settings::write_last_model(&self.last_model_path, &selection);
        self.notice = Some(format!("{}: {value}", tr("notice.effort")));
        self.model_override = Some(selection);
    }

    fn set_runtime_mode(&mut self, mode: &str) {
        if self.thread_id().is_some()
            && mode != self.conv.thread.runtime_mode
            && let Some(refusal) = crate::cmd_goal::mode_refusal(self, "session.c.whatPermission")
        {
            self.notice = Some(refusal);
            return;
        }
        let label = tr(&format!("mode.{mode}"));
        self.notice = Some(format!("{}: {label}", tr("notice.mode")));
        match self.thread_id() {
            Some(id) => {
                let command = commands::runtime_mode_set(&Ctx::fresh(), &id, mode);
                self.runtime_intent = Some(mode.to_string());
                self.dispatch(command, None, None);
            }
            None => self.draft_runtime_mode = mode.to_string(),
        }
    }

    fn set_interaction_mode(&mut self, mode: &str) {
        if self.thread_id().is_some()
            && mode != self.conv.thread.interaction_mode
            && let Some(refusal) = crate::cmd_goal::mode_refusal(self, "session.c.whatWorkMode")
        {
            self.notice = Some(refusal);
            return;
        }
        self.notice = Some(
            tr(if mode == "plan" {
                "notice.planOn"
            } else {
                "notice.planOff"
            })
            .into(),
        );
        match self.thread_id() {
            Some(id) => {
                let command = commands::interaction_mode_set(&Ctx::fresh(), &id, mode);
                self.interaction_intent = Some(mode.to_string());
                self.dispatch(command, None, None);
            }
            None => self.draft_interaction_mode = mode.to_string(),
        }
    }

    fn interrupt(&mut self) {
        let Some(id) = self.thread_id() else {
            self.notice = Some(tr("notice.nothingRunning").into());
            return;
        };
        let turn = self.conv.session().and_then(|s| s.active_turn_id.clone());
        self.notice = Some(tr("notice.stopping").into());
        self.notifier.stop_requested(&id);
        let command = commands::turn_interrupt(&Ctx::fresh(), &id, turn.as_deref());
        self.dispatch(command, None, None);
    }

    // --- sending ----------------------------------------------------------------------------

    /// What a new thread in `project_id` runs on: the last model picked (when this server still
    /// has it), else the project's default, else the first usable provider's default.
    fn model_for(&self, project_id: &str) -> Option<Value> {
        if let Some(selection) = settings::read_last_model(&self.last_model_path)
            && usable_models(&self.config).iter().any(|m| {
                selection["instanceId"] == m.instance_id.as_str()
                    && selection["model"] == m.slug.as_str()
            })
        {
            return Some(selection);
        }
        let project = self.shell.projects.iter().find(|p| p.id == project_id)?;
        if let Some(selection) = project
            .default_model_selection
            .clone()
            .filter(|s| !s.is_null())
        {
            return Some(selection);
        }
        first_usable_model(&self.config)
            .map(|Choice { instance_id, model }| json!({"instanceId": instance_id, "model": model}))
    }

    pub(crate) fn submit(&mut self) {
        let text = self.input.text();
        let mut trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let word = trimmed.split_whitespace().next().unwrap_or_default();
        if word.starts_with('/') && self.input.starts_with_slash() && !word[1..].contains('/') {
            let argument = trimmed[word.len()..].trim().to_string();
            if self.run_slash(&word[1..].to_lowercase(), &argument) {
                self.input.take(true);
                return;
            }
            // Not ours: an installed provider skill goes out as the `$name` mention the composer
            // inserts, which each provider turns into its own invocation.
            let Some(name) = self.provider_skill(&word[1..]) else {
                self.notice = Some(tr("notice.unknownCommand").into());
                return;
            };
            trimmed = format!("${name} {argument}").trim_end().to_string();
        }
        match &self.active {
            Active::None => self.notice = Some(tr("notice.pickFirst").into()),
            Active::Thread(_) if self.conv.busy() => {
                self.queue.push_back(trimmed);
                self.input.take(true);
                self.notice = Some(tr("notice.queued").into());
            }
            _ => {
                if self.send(&trimmed) {
                    self.input.take(true);
                }
            }
        }
    }

    /// The name of the provider skill a typed `/word` calls, if some provider lists it as enabled
    /// and invocable by the user.
    fn provider_skill(&self, word: &str) -> Option<String> {
        let model = self.current_model();
        let current = model.as_ref().and_then(|m| m["instanceId"].as_str());
        let providers = self.config["providers"].as_array()?;
        providers
            .iter()
            .filter(|p| p["instanceId"].as_str() == current)
            .chain(
                providers
                    .iter()
                    .filter(|p| p["instanceId"].as_str() != current),
            )
            .flat_map(|p| p["skills"].as_array().into_iter().flatten())
            .filter(|k| k["enabled"].as_bool().unwrap_or(true) && k["userInvocable"] != false)
            .filter_map(|k| k["name"].as_str())
            .find(|name| name.eq_ignore_ascii_case(word))
            .map(str::to_string)
    }

    /// Runs a `/command`; false when it is not one.
    fn run_slash(&mut self, name: &str, argument: &str) -> bool {
        match name {
            "exit" | "quit" => self.quit = true,
            "model" | "models" => {
                if self.config.is_null() {
                    self.notice = Some(tr("notice.offline").into());
                } else if usable_models(&self.config).is_empty() {
                    self.notice = Some(tr("notice.noProvider").into());
                } else {
                    let matches = self.filtered_models(argument);
                    if !argument.is_empty() && matches.len() == 1 {
                        self.pick_model(&matches[0].instance_id, &matches[0].slug);
                    } else {
                        self.modal = Some(Modal::Models {
                            filter: argument.to_string(),
                            cursor: 0,
                        });
                    }
                }
            }
            "mode" => {
                if argument.is_empty() {
                    let current = self.runtime_mode();
                    let cursor = commands::RUNTIME_MODES
                        .iter()
                        .position(|(value, ..)| *value == current)
                        .unwrap_or(0);
                    self.modal = Some(Modal::Mode { cursor });
                } else if let Some(mode) = commands::parse_runtime_mode(argument) {
                    self.set_runtime_mode(mode);
                } else {
                    self.notice = Some(tr("notice.modeWords").into());
                }
            }
            "effort" => match self.effort_choices() {
                None => self.notice = Some(tr("notice.noEffort").into()),
                Some(control) if argument.is_empty() => {
                    let current = self.effort_display();
                    let cursor = control
                        .choices
                        .iter()
                        .position(|(v, _)| Some(v) == current.as_ref())
                        .unwrap_or(0);
                    self.modal = Some(Modal::Effort { cursor });
                }
                Some(control) => {
                    let wanted = argument.to_lowercase();
                    match control
                        .choices
                        .iter()
                        .find(|(v, l)| v.to_lowercase() == wanted || l.to_lowercase() == wanted)
                    {
                        Some((value, _)) => self.pick_effort(&control.descriptor_id, value),
                        None => {
                            let words: Vec<&str> =
                                control.choices.iter().map(|(v, _)| v.as_str()).collect();
                            self.notice = Some(format!(
                                "{}: {}",
                                tr("notice.effortWords"),
                                words.join(", ")
                            ));
                        }
                    }
                }
            },
            "plan" => self.set_interaction_mode("plan"),
            "default" => self.set_interaction_mode("default"),
            "new" => {
                self.new_thread();
                self.focus = Focus::Composer;
            }
            "help" => self.notice = Some(tr("notice.help").into()),
            "sidebar" => match flag_word(argument) {
                Some(on) => self.set_list(on),
                None => self.notice = Some(tr("notice.sidebarUsage").into()),
            },
            "panel" => match flag_word(argument) {
                Some(on) => self.set_panel(on),
                None => self.notice = Some(tr("notice.panelToggleUsage").into()),
            },
            "pet" => match flag_word(argument) {
                Some(on) => {
                    self.settings.pet = on.unwrap_or(!self.settings.pet);
                    self.notice = Some(
                        tr(if self.settings.pet {
                            "notice.petOn"
                        } else {
                            "notice.petOff"
                        })
                        .into(),
                    );
                }
                None => self.notice = Some(tr("notice.petUsage").into()),
            },
            "usage" => match flag_word(argument) {
                Some(on) => crate::cmd_misc::set_usage(self, on),
                None => self.notice = Some(tr("notice.usageUsage").into()),
            },
            "mouse" => match flag_word(argument) {
                Some(on) => {
                    self.mouse = on.unwrap_or(!self.mouse);
                    self.selection.clear();
                    self.notice = Some(
                        tr(if self.mouse {
                            "notice.mouseOn"
                        } else {
                            "notice.mouseOff"
                        })
                        .into(),
                    );
                }
                None => self.notice = Some(tr("notice.mouseUsage").into()),
            },
            "dag-workflow" | "workflow" => return self.panel_command(Side::Workflow, argument),
            "savvy" => return self.panel_command(Side::Savvy, argument),
            "files" => return self.panel_command(Side::Files, argument),
            _ => return crate::cmd::run(self, name, argument),
        }
        true
    }

    /// Builds and sends one user message to the open thread or, from a draft, starts the thread.
    fn send(&mut self, text: &str) -> bool {
        if let Some(refusal) = crate::cmd_history::sending_blocked(self) {
            self.notice = Some(refusal);
            return false;
        }
        let runtime_mode = self.runtime_mode();
        let interaction_mode = self.interaction_mode();
        let message_id = new_id();
        let ctx = Ctx::fresh();
        let command = match self.active.clone() {
            Active::None => {
                self.notice = Some(tr("notice.pickFirst").into());
                return false;
            }
            Active::Draft(project_id) => {
                let Some(model) = self
                    .model_override
                    .clone()
                    .or_else(|| self.model_for(&project_id))
                else {
                    self.notice = Some(tr("notice.noProvider").into());
                    return false;
                };
                let thread_id = self.draft_id.take().unwrap_or_else(new_id);
                let crew = self.draft_crew.clone();
                let command = commands::turn_start(
                    &ctx,
                    &Turn {
                        thread_id: &thread_id,
                        message_id: &message_id,
                        text,
                        model: Some(&model),
                        runtime_mode: &runtime_mode,
                        interaction_mode: &interaction_mode,
                        bootstrap: Some(Bootstrap {
                            project_id: &project_id,
                            crew: crew.as_ref(),
                        }),
                    },
                );
                self.notice = None;
                self.dispatch(command, Some(thread_id), None);
                return true;
            }
            Active::Thread(thread_id) => commands::turn_start(
                &ctx,
                &Turn {
                    thread_id: &thread_id,
                    message_id: &message_id,
                    text,
                    model: self.model_override.as_ref(),
                    runtime_mode: &runtime_mode,
                    interaction_mode: &interaction_mode,
                    bootstrap: None,
                },
            ),
        };
        self.notice = None;
        self.scroll.set(0);
        self.sent = Some((message_id, self.tick));
        self.dispatch(command, None, None);
        true
    }

    /// A request was sent and its message has not come back yet: no work of it exists, and the
    /// work before it is not this one's.
    pub fn request_pending(&self) -> bool {
        self.sent
            .as_ref()
            .is_some_and(|(id, _)| !self.conv.thread.messages.iter().any(|m| &m.id == id))
    }

    /// Advances the spinner; true when the screen changes by it.
    pub fn on_tick(&mut self) -> bool {
        self.tick = self.tick.wrapping_add(1);
        self.refresh_pet();
        // A tip moves the screen only when the next one is another tip.
        let tip_changed = self
            .tip_shown
            .get()
            .is_some_and(|shown| shown != self.tip_index());
        // The pet moves the screen only when its picture changes.
        let pet_changed = self.settings.pet && {
            let state = self.pet_state();
            let shown = (state, self.pet_frame(state));
            self.pet_shown.get() != Some(shown)
        };
        if self
            .awaiting
            .is_some_and(|since| self.tick.wrapping_sub(since) > 20)
        {
            self.awaiting = None;
        }
        let replay_moved = crate::replay::tick(self);
        // The usage panel moves the screen only when a countdown in it reads differently.
        let usage_changed = crate::usage_panel::changed(self);
        // Older pages are let go only from the bottom, with nothing selected or being read in.
        let trimmed = self.scroll.get() == 0
            && !self.selection.active()
            && !self.conv.loading_older
            && !crate::cmd_history::loading(self)
            && self.conv.trim();
        trimmed
            || pet_changed
            || usage_changed
            || tip_changed
            || replay_moved
            || self.settings.animations && (self.request_pending() || crate::side::is_live(self))
            || self.settings.animations
                && (self.conv.busy()
                    || matches!(
                        self.link,
                        LinkStatus::Connecting
                            | LinkStatus::Starting(_)
                            | LinkStatus::Reconnecting(_)
                    ))
    }

    /// The last message is still being written, so its text is the sign of work.
    pub fn streaming_tail(&self) -> bool {
        self.conv
            .thread
            .messages
            .last()
            .is_some_and(|m| m.streaming)
    }
}

/// The key a thread's half-typed message is kept under: its id, or `draft:` and the project for a
/// new thread; none where there is no thread.
fn draft_key(active: &Active) -> Option<String> {
    match active {
        Active::None => None,
        Active::Draft(project) => Some(format!("draft:{project}")),
        Active::Thread(id) => Some(id.clone()),
    }
}

/// The word after `/sidebar`, `/pet` or `/mouse`: nothing toggles, `on` and `off` set; else `None`.
/// Said for `off` aimed at a view that is not the one shown, which would otherwise do nothing in
/// silence.
fn off_elsewhere(view: Side, shown: Side) -> String {
    let name = Side::name;
    let command = shown.command();
    fill(
        s(
            "The {view} panel is not open. The {shown} panel is open now; close it with {command}.",
            "{view} 창은 열려 있지 않습니다. 지금은 {shown} 창이 열려 있고, {command} 로 닫습니다.",
        ),
        &[
            ("view", name(view).into()),
            ("shown", name(shown).into()),
            ("command", command.into()),
        ],
    )
}

fn flag_word(argument: &str) -> Option<Option<bool>> {
    match argument.trim().to_lowercase().as_str() {
        "" => Some(None),
        "on" => Some(Some(true)),
        "off" => Some(Some(false)),
        _ => None,
    }
}

/// What to tell the user about a finished copy, in the words of the TypeScript terminal.
pub(crate) fn copy_notice(outcome: &clipboard::Outcome) -> String {
    let count = outcome.chars.to_string();
    let why = |why: &Why| {
        tr(match why {
            Why::Missing => "copy.missing",
            Why::Failed => "copy.fail",
            Why::Timeout => "copy.timeout",
        })
    };
    let fill = |key: &str, extra: &[(&str, &str)]| {
        // A named copy ("1 command (2 lines)") says that instead of a character count.
        let key = match (&outcome.what, key) {
            (Some(_), "copy.done") => "copy.doneWhat",
            (Some(_), "copy.terminal") => "copy.terminalWhat",
            _ => key,
        };
        let mut text = tr(key)
            .replace("{count}", &count)
            .replace("{what}", outcome.what.as_deref().unwrap_or(""));
        for (name, value) in extra {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    };
    match &outcome.tool {
        Some((_, Ok(()))) => fill("copy.done", &[]),
        Some((tool, Err(reason))) if outcome.osc52_sent => {
            fill("copy.toolFailed", &[("tool", tool), ("why", why(reason))])
        }
        Some((_, Err(reason))) => fill("copy.failed", &[("why", why(reason))]),
        None if outcome.osc52_sent => fill("copy.terminal", &[]),
        None => fill(
            "copy.failed",
            &[(
                "why",
                tr(if outcome.too_large {
                    "copy.tooLarge"
                } else {
                    "copy.noWay"
                }),
            )],
        ),
    }
}

fn same_folder(a: &str, b: &str) -> bool {
    let canonical = |p: &str| {
        std::fs::canonicalize(p).map_or_else(
            |_| p.trim_end_matches('/').to_string(),
            |c| c.to_string_lossy().into_owned(),
        )
    };
    canonical(a) == canonical(b)
}

/// The first candidate that names a folder (blank ones are skipped, so an empty worktree does not
/// hide the project's folder), else `cwd`.
pub(crate) fn pick_folder<'a>(
    candidates: impl IntoIterator<Item = Option<&'a str>>,
    cwd: &str,
) -> String {
    candidates
        .into_iter()
        .flatten()
        .find(|p| !p.trim().is_empty())
        .unwrap_or(cwd)
        .to_string()
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
