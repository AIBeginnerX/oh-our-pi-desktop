//! The application state and its reactions: keys, mouse, paste, stream items, link changes. Drawing
//! lives in `ui.rs` and reads this state; nothing here touches the terminal, so it is tested without
//! one. Commands go out through the builders in `commands.rs`.

use crate::clipboard::{self, Why};
use crate::commands::{self, Ctx};
use crate::i18n::tr;
use crate::input::Input;
use crate::link::Target;
use crate::panels_common::{fill, s};
use crate::pet;
use crate::selection::Selection;
use crate::settings::{self, Settings};
use crate::side;
use crate::sidebar::{self, Nav, View};
use crate::state::{
    Conversation, EffortControl, PendingApproval, PendingInput, Shell, ThreadShell, effort_control,
    effort_of, model_name, usable_models,
};
use crate::text::{iso_now, new_id, parse_iso_ms};
use crate::theme::{self, Symbols, Theme};
use crate::transcript::Transcript;
use crate::wire::{CallError, Rpc};
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind,
};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;
use tokio::time::Instant;

mod connection;
mod interaction;
mod submission;

const SHELL_RETRY_MIN: Duration = Duration::from_millis(250);
const SHELL_RETRY_MAX: Duration = Duration::from_secs(4);

pub const SHELL_RPC: &str = "orchestration.subscribeShell";
pub const THREAD_RPC: &str = "orchestration.subscribeThread";
pub const DISPATCH_RPC: &str = "orchestration.dispatchCommand";
pub const CONFIG_RPC: &str = "server.getConfig";

pub(crate) async fn call_dispatch(rpc: &Rpc, command: Value) -> Result<Value, CallError> {
    rpc.start_call(DISPATCH_RPC, command)?.await
}

pub(crate) fn dispatch_notice(error: CallError) -> String {
    match error {
        CallError::TimedOut => tr("notice.dispatchUnconfirmed").into(),
        error => error.to_string(),
    }
}

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
        /// The new thread and the draft view that submitted it.
        open: Option<(String, u64)>,
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
    pub(crate) attachments: crate::cmd_attach::State,
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
    shell_retry_notice: Option<String>,
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
    /// Changes on leaving a thread, even when the user comes back before an RPC returns.
    pub thread_view_epoch: u64,
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
    /// Last memory suggestion check per project; opening a project asks at most hourly.
    pub(crate) memory_asked: std::collections::HashMap<String, i64>,
    /// The saved memory the composer is editing instead of a message (see `cmd_memory.rs`).
    pub(crate) memory_edit: Option<crate::cmd_memory::Edit>,
    /// The thread usage line under the conversation (see `usage_footer.rs`).
    pub(crate) usage: crate::usage_footer::State,
    cache: RefCell<Option<Cached>>,
    /// The laid-out blocks behind `cache`, so a new revision re-lays-out only what changed.
    blocks: RefCell<crate::transcript::BlockCache>,
    /// Threads left lately, least recently viewed first (see `RECENT_THREADS`).
    recent: Vec<Conversation>,
    tx: UnboundedSender<Msg>,
    shell_task: Option<JoinHandle<()>>,
    shell_epoch: u64,
    shell_retry_at: Option<Instant>,
    shell_backoff: Duration,
    shell_started: Instant,
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

pub(crate) fn now_ms() -> i64 {
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
            attachments: Default::default(),
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
            shell_retry_notice: None,
            pending_provider: None,
            provider_server: None,
            provider_home: None,
            tasks_on: false,
            term_size: Cell::new((0, 0)),
            notes: Vec::new(),
            thread_view_epoch: 0,
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
            memory_asked: Default::default(),
            memory_edit: None,
            usage: Default::default(),
            cache: RefCell::new(None),
            blocks: RefCell::new(Default::default()),
            recent: Vec::new(),
            tx,
            shell_task: None,
            shell_epoch: 0,
            shell_retry_at: None,
            shell_backoff: SHELL_RETRY_MIN,
            shell_started: Instant::now(),
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
                self.abort_shell();
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
                self.clear_shell_retry_notice();
                self.on_shell_changed();
            }
            Msg::ShellEnd(reason) => {
                if self.shell_task.take().is_none() || self.rpc.as_ref().is_none_or(Rpc::is_closed)
                {
                    return;
                }
                if let Some(reason) = reason
                    && self.shell_retry_notice.is_none()
                {
                    self.notice = Some(reason.clone());
                    self.shell_retry_notice = Some(reason);
                }
                let now = Instant::now();
                if now - self.shell_started >= SHELL_RETRY_MAX {
                    self.shell_backoff = SHELL_RETRY_MIN;
                }
                self.shell_retry_at = Some(now + self.shell_backoff);
                self.shell_backoff = (self.shell_backoff * 2).min(SHELL_RETRY_MAX);
            }
            Msg::Thread { id, item } => {
                if self.thread_id().as_deref() == Some(id.as_str()) {
                    if let Some(error) = self.conv.apply(&item) {
                        self.notice = Some(format!("{}: {error}", tr("notice.threadFailed")));
                        return;
                    }
                    if self.conv.deleted {
                        // The draft remains available in input history after the thread is gone.
                        if self.memory_edit.is_some() {
                            while self.input.history_forward() {}
                            self.input.take(true);
                        }
                        crate::cmd_memory::leave_edit(self);
                        while self.input.history_forward() {}
                        self.input.take(true);
                        self.park_conversation();
                        self.leave_thread();
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
                    if let Some((id, epoch)) = open
                        && self.thread_view_epoch == epoch
                        && matches!(self.active, Active::Draft(_))
                    {
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
                let failure = match result {
                    Ok(snapshot) => self
                        .conv
                        .apply_older(&snapshot)
                        .map(|error| error.to_string()),
                    Err(reason) => Some(reason),
                };
                if let Some(reason) = &failure {
                    self.conv.loading_older = false;
                    self.notice = Some(format!("{}: {reason}", tr("notice.olderFailed")));
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
            && !crate::cmd_attach::blocks_queue(self)
            && self.has_connection()
            && let Some(text) = self.queue.pop_front()
            && self.send(&text)
        {
            self.awaiting = Some(self.tick);
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

    fn leave_thread(&mut self) {
        self.thread_view_epoch += 1;
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
        crate::cmd_memory::opened(self);
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
        crate::cmd_memory::opened(self);
    }

    /// Makes `next` the thread on screen, and the message box goes with it: what is half-typed is
    /// kept for the thread being left, and the one being entered gets its own back (an empty box
    /// if it has none). With no thread on screen the box has no owner, so what is typed there
    /// follows into whatever opens next, unless that has a draft of its own.
    fn switch_to(&mut self, next: Active) {
        crate::cmd_memory::leave_edit(self);
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

    /// Advances the spinner; true when the screen changes by it.
    pub fn on_tick(&mut self) -> bool {
        self.tick = self.tick.wrapping_add(1);
        if self.shell_retry_at.is_some_and(|at| Instant::now() >= at) {
            self.shell_retry_at = None;
            self.subscribe_shell();
        }
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
