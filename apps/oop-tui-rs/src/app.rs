//! The application state and its reactions: keys, mouse, paste, stream items, link changes. Drawing
//! lives in `ui.rs` and reads this state; nothing here touches the terminal, so it is tested without
//! one. Commands go out through the builders in `commands.rs`.

use crate::clipboard::{self, Why};
use crate::commands::{self, Bootstrap, Ctx, Turn};
use crate::i18n::tr;
use crate::input::Input;
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
/// Lines one wheel notch moves.
const WHEEL_LINES: usize = 3;

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
    },
    Older {
        id: String,
        result: Result<Value, String>,
    },
    /// A copy to the clipboard has finished.
    Copied(clipboard::Outcome),
    /// The result of work a command started in the background (a request to the server, a lookup):
    /// it runs on the app with the screen as it is by then.
    Ext(Box<dyn FnOnce(&mut App) + Send>),
}

/// The two views of the right-hand panel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Workflow,
    Agents,
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

/// The lines of the conversation, kept until the thread, its revision or the width changes.
struct Cached {
    thread_id: String,
    revision: u64,
    width: usize,
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
    pub settings: Settings,
    pub theme: Theme,
    pub sym: Symbols,
    pub modal: Option<Modal>,
    pub approval_cursor: usize,
    pub question: QuestionState,
    pub view: View,
    pub notice: Option<String>,
    /// A command line for the TypeScript terminal that the main loop runs with the screen given
    /// back (`/provider`); and the server and home this session was started with, which it gets.
    pub pending_handoff: Option<Vec<String>>,
    pub handoff_server: Option<String>,
    pub handoff_home: Option<String>,
    /// `/tasks`: the task list is shown under the conversation.
    pub tasks_on: bool,
    /// The terminal's size as of the last drawing or resize: (columns, rows).
    pub term_size: Cell<(u16, u16)>,
    /// What slash commands said under the conversation (see `notes.rs`).
    pub notes: Vec<crate::notes::Note>,
    /// A full-body screen over the conversation, when one is open (see `screen.rs`).
    pub screen: Option<Box<dyn crate::screen::Screen>>,
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
    pub clip_plan: clipboard::Plan,
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
    pub pet_shown: Cell<Option<(pet::PetState, usize, pet::Tone)>>,
    /// A fixed clock for the pet, in tests.
    pub pet_clock: Option<i64>,
    /// A model picked with `/model` or `/effort`, sent with the next turn.
    pub(crate) model_override: Option<Value>,
    /// A mode the user picked on an open thread, shown until the server's own value catches up
    /// (the server may not echo a mode change to this stream before the next turn).
    runtime_intent: Option<String>,
    pub(crate) interaction_intent: Option<String>,
    draft_runtime_mode: String,
    draft_interaction_mode: String,
    visited: HashMap<String, i64>,
    answered: HashSet<String>,
    cwd_project: Option<String>,
    draft_project: Option<String>,
    adding: Option<String>,
    auto_selected: bool,
    pub(crate) origin: Option<String>,
    pub(crate) bearer: Option<String>,
    /// Tick at which a queued message was sent; the next waits for the agent to start on it.
    pub(crate) awaiting: Option<usize>,
    /// What `/undo`, `/diff` and `/history` are waiting for (see `cmd_history.rs`).
    pub(crate) threadops: crate::cmd_history::State,
    cache: RefCell<Option<Cached>>,
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
            settings: Settings::default(),
            theme: theme::LAVENDER,
            sym: Symbols::pick(false),
            modal: None,
            approval_cursor: 0,
            question: QuestionState::default(),
            view: View::default(),
            notice: None,
            pending_handoff: None,
            handoff_server: None,
            handoff_home: None,
            tasks_on: false,
            term_size: Cell::new((0, 0)),
            notes: Vec::new(),
            screen: None,
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
            clip_plan: clipboard::plan(|k| std::env::var(k).ok(), clipboard::Platform::current()),
            launch: None,
            copy_job: None,
            side_open: true,
            side_view: Side::Workflow,
            side_rect: Cell::new(Rect::default()),
            pinned_flow: None,
            panel_scroll: Cell::new(0),
            pet_memory: pet::Memory::new(now_ms()),
            pet_shown: Cell::new(None),
            pet_clock: None,
            model_override: None,
            runtime_intent: None,
            interaction_intent: None,
            draft_runtime_mode: "full-access".into(),
            draft_interaction_mode: "default".into(),
            visited: HashMap::new(),
            answered: HashSet::new(),
            cwd_project: None,
            draft_project: None,
            adding: None,
            auto_selected: false,
            origin: None,
            bearer: None,
            awaiting: None,
            threadops: Default::default(),
            cache: RefCell::new(None),
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
    /// folder is not a project yet.
    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        if self.shell.loaded && self.cwd_project.is_none() {
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
        {
            return c.lines.clone();
        }
        let lines = Rc::new(crate::transcript::build(
            &self.conv.thread,
            width,
            &self.theme,
            &self.sym,
        ));
        *cache = Some(Cached {
            thread_id: self.conv.thread_id.clone(),
            revision: self.conv.revision,
            width,
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
            } => {
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
                        self.active = Active::None;
                    }
                    self.notice = Some(format!("thread: {reason}"));
                }
            }
            Msg::Dispatched {
                result,
                open,
                answered,
            } => match result {
                Ok(()) => {
                    if let Some(id) = open.filter(|_| matches!(self.active, Active::Draft(_))) {
                        self.open_thread(&id);
                    }
                }
                Err(reason) => {
                    if let Some(request) = answered {
                        self.answered.remove(&request);
                    }
                    self.awaiting = None;
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
        crate::cmd_history::on_thread(self);
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

    fn on_shell_changed(&mut self) {
        self.cwd_project = self
            .shell
            .projects
            .iter()
            .find(|p| same_folder(&p.workspace_root, &self.cwd))
            .map(|p| p.id.clone());
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
        crate::cmd_history::on_leave(self);
        self.notes.clear();
        self.pinned_flow = None;
        self.panel_scroll.set(0);
        crate::cmd_goal::drop_draft_goal(self);
        if let Active::Thread(id) = &self.active {
            self.visited.insert(id.clone(), now_ms());
        }
        self.abort_thread();
        self.modal = None;
        self.queue.clear();
        self.awaiting = None;
        self.model_override = None;
        self.runtime_intent = None;
        self.interaction_intent = None;
        self.scroll.set(0);
        self.total.set((0, 0));
        self.approval_cursor = 0;
        self.question = QuestionState::default();
    }

    pub(crate) fn start_draft(&mut self, project_id: &str) {
        self.leave_thread();
        self.draft_id = None;
        self.active = Active::Draft(project_id.to_string());
        self.draft_project = Some(project_id.to_string());
        self.conv = Conversation::default();
        self.focus = Focus::Composer;
    }

    pub(crate) fn open_thread(&mut self, id: &str) {
        self.leave_thread();
        self.visited.insert(id.to_string(), now_ms());
        self.active = Active::Thread(id.to_string());
        self.conv = Conversation::new(id);
        self.focus = Focus::Composer;
        self.subscribe_thread(id);
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
        tokio::spawn(async move {
            let path = format!(
                "/api/orchestration/threads/{id}?reasoningMessages=true&turnLimit={TURN_WINDOW}&beforeCursor={}",
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
        tokio::spawn(async move {
            let result = rpc.call(DISPATCH_RPC, command).await.map(|_| ());
            let _ = tx.send(Msg::Dispatched {
                result,
                open,
                answered,
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
        self.side_view = match self.side_view {
            Side::Workflow => Side::Agents,
            Side::Agents => Side::Workflow,
        };
    }

    /// `/dag-workflow` and `/dag-agents`: each shows its own view; with the panel closed it opens,
    /// with the other view up it switches, and the same command again (or `off`) closes it. The
    /// words after it also pick which flow the Workflow view shows (`N`, `next`, `prev`, `live`).
    fn panel_command(&mut self, view: Side, argument: &str) -> bool {
        let usage = match view {
            Side::Workflow => "/dag-workflow [on|off|N|next|prev|live]",
            Side::Agents => "/agents [on|off|live]",
        };
        let Some(action) = side::parse_flow_action(argument) else {
            self.notice = Some(format!("{}{usage}", s("Usage: ", "사용법: ")));
            return true;
        };
        let open = self.side_open;
        let shown = open.then_some(self.side_view);
        let movement = side::plan_panel_move(view, action, shown);
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
                Side::Agents => matches!(
                    action,
                    side::FlowAction::Pick(_) | side::FlowAction::Next | side::FlowAction::Prev
                )
                .then(|| {
                    fill(
                        s(
                            "The Agents panel shows the current turn. Pick a flow with {command} <number>.",
                            "Agents 창은 현재 턴을 보여 줍니다. 흐름 고르기는 {command} <번호> 로 합니다.",
                        ),
                        &[("command", "/dag-workflow".into())],
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
            self.notice = Some(tr("notice.panelOn").into());
        }
        true
    }

    fn pet_now(&self) -> i64 {
        self.pet_clock.unwrap_or_else(now_ms)
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

    /// The model the next message goes to, with the colour its provider gives Mocha's coffee. A
    /// thread's model changing is a switch; opening another thread is not.
    fn pet_model(&self) -> Option<pet::Model> {
        let scope = match &self.active {
            Active::Thread(id) => id.clone(),
            Active::Draft(project) => format!("draft:{project}"),
            Active::None => return None,
        };
        let selection = self.current_model()?;
        let instance = selection["instanceId"].as_str().unwrap_or_default();
        let model = selection["model"].as_str().unwrap_or_default();
        let driver = self.config["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["instanceId"].as_str() == Some(instance))
            .and_then(|p| p["driver"].as_str());
        Some(pet::Model {
            scope,
            key: format!("{instance}/{model}"),
            tone: pet::tone_of(driver, instance, model),
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

    /// The colours the pet is drawn in for `state`.
    pub fn pet_look(&self, state: pet::PetState) -> pet::Look {
        self.pet_memory.look(state)
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
        let at =
            |r: Rect| m.column >= r.x && m.column < r.right() && m.row >= r.y && m.row < r.bottom();
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let up = m.kind == MouseEventKind::ScrollUp;
                if let Some(screen) = self.screen.as_mut() {
                    screen.wheel(up);
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

    /// Takes the selected text from the conversation and queues it for the clipboard.
    fn copy_selection(&mut self) {
        let Some(range) = self.selection.range() else {
            return;
        };
        let width = usize::from(self.geo.get().area.width);
        let transcript = self.transcript(width);
        let text = selection::text(&transcript.lines, &transcript.meta, range);
        if text.is_empty() {
            self.selection.clear();
            return;
        }
        let osc52 = clipboard::osc52(&text, self.clip_plan.tmux, clipboard::OSC52_MAX_BASE64);
        self.copy_job = Some(CopyJob {
            text,
            osc52,
            plan: self.clip_plan.clone(),
        });
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
            self.quit = true;
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
        match self.focus {
            Focus::Composer if self.approval().is_some() => self.on_approval_key(key),
            Focus::Composer if self.pending_input().is_some() => self.on_question_key(key),
            Focus::Composer => self.on_composer_key(key),
            Focus::List => self.on_list_key(key),
        }
    }

    fn on_paste(&mut self, text: &str) {
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
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
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
            KeyCode::Char('a') if ctrl => self.input.home(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char(ch) if !ctrl => self.input.insert(ch),
            KeyCode::Backspace => self.input.backspace(),
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => self.input.left(),
            KeyCode::Right => self.input.right(),
            KeyCode::Home => self.input.home(),
            KeyCode::End => self.input.end(),
            KeyCode::Up => {
                if !self.input.up() {
                    self.input.history_back();
                }
            }
            KeyCode::Down => {
                if !self.input.down() {
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
                if let Some(id) = project.or_else(|| self.draft_project_id()) {
                    self.start_draft(&id);
                }
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

    /// A draft in the project of the working folder, else the last one used.
    fn new_thread(&mut self) {
        if let Some(id) = self.draft_project_id() {
            self.start_draft(&id);
        } else {
            self.notice = Some(tr("notice.pickFirst").into());
        }
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
        if self.adding.is_some() {
            return;
        }
        let project_id = new_id();
        let title = std::path::Path::new(&self.cwd)
            .file_name()
            .map_or_else(|| self.cwd.clone(), |n| n.to_string_lossy().into_owned());
        self.adding = Some(project_id.clone());
        self.notice = Some(tr("notice.adding").into());
        let command = commands::project_create(&Ctx::fresh(), &project_id, &title, &self.cwd);
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
            KeyCode::Backspace => {
                if let Some(Modal::Models { filter, cursor }) = &mut self.modal {
                    filter.pop();
                    *cursor = 0;
                }
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(Modal::Models { filter, cursor }) = &mut self.modal {
                    filter.push(ch);
                    *cursor = 0;
                }
            }
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

    fn submit(&mut self) {
        let text = self.input.text();
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let word = trimmed.split_whitespace().next().unwrap_or_default();
        if word.starts_with('/') && !word[1..].contains('/') {
            let argument = trimmed[word.len()..].trim().to_string();
            if self.run_slash(&word[1..].to_lowercase(), &argument) {
                self.input.take(true);
            } else {
                self.notice = Some(tr("notice.unknownCommand").into());
            }
            return;
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
                Some(on) => {
                    self.settings.sidebar = on.unwrap_or(!self.settings.sidebar);
                    if !self.list_shown() {
                        self.focus = Focus::Composer;
                    }
                }
                None => self.notice = Some(tr("notice.sidebarUsage").into()),
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
            "dag-agents" | "agents" => return self.panel_command(Side::Agents, argument),
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
        self.dispatch(command, None, None);
        true
    }

    /// Advances the spinner; true when the screen changes by it.
    pub fn on_tick(&mut self) -> bool {
        self.tick = self.tick.wrapping_add(1);
        self.refresh_pet();
        // The pet moves the screen only when its picture changes.
        let pet_changed = self.settings.pet && {
            let state = self.pet_state();
            let shown = (state, self.pet_frame(state), self.pet_look(state).tone);
            self.pet_shown.get() != Some(shown)
        };
        if self
            .awaiting
            .is_some_and(|since| self.tick.wrapping_sub(since) > 20)
        {
            self.awaiting = None;
        }
        pet_changed
            || self.settings.animations && crate::side::is_live(self)
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

/// The word after `/sidebar`, `/pet` or `/mouse`: nothing toggles, `on` and `off` set; else `None`.
/// Said for `off` aimed at a view that is not the one shown, which would otherwise do nothing in
/// silence.
fn off_elsewhere(view: Side, shown: Side) -> String {
    let name = |side: Side| match side {
        Side::Workflow => "Workflow",
        Side::Agents => "Agents",
    };
    let command = match shown {
        Side::Workflow => "/dag-workflow",
        Side::Agents => "/dag-agents",
    };
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
fn copy_notice(outcome: &clipboard::Outcome) -> String {
    let count = outcome.chars.to_string();
    let why = |why: &Why| {
        tr(match why {
            Why::Missing => "copy.missing",
            Why::Failed => "copy.fail",
            Why::Timeout => "copy.timeout",
        })
    };
    let fill = |key: &str, extra: &[(&str, &str)]| {
        let mut text = tr(key).replace("{count}", &count);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread::Role;
    use ratatui::crossterm::event::{KeyEventState, MouseEvent};
    use tokio::sync::mpsc::unbounded_channel;

    pub fn key_with(code: KeyCode, modifiers: KeyModifiers) -> Msg {
        Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }))
    }

    pub fn key(code: KeyCode) -> Msg {
        key_with(code, KeyModifiers::NONE)
    }

    fn type_text(app: &mut App, text: &str) {
        for ch in text.chars() {
            app.handle(key(KeyCode::Char(ch)));
        }
    }

    pub fn no_last_model(app: &mut App) {
        app.last_model_path = std::env::temp_dir().join(format!(
            "oop-rs-none-{}/last-model.json",
            std::process::id()
        ));
    }

    pub fn app_with_project() -> App {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        no_last_model(&mut app);
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
            "threads": [{"id": "t1", "projectId": "p1", "title": "안녕 스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app
    }

    fn config() -> Value {
        json!({"threadSnapshotPagination": true, "providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true,
            "models": [
              {"slug": "gpt-5", "name": "GPT-5", "isDefault": true, "capabilities": {"optionDescriptors": [{"id": "reasoningEffort", "type": "select", "options": [{"id": "low", "label": "Low"}, {"id": "high", "label": "High", "isDefault": true}]}]}},
              {"slug": "gpt-5-mini", "name": "GPT-5 mini"}]}]})
    }

    fn ids(app: &App) -> Vec<String> {
        app.rows()
            .into_iter()
            .map(|r| match r {
                Row::AddFolder => "add".into(),
                Row::Item(Nav::New { .. }) => "new".into(),
                Row::Item(Nav::Thread(t)) => t.id,
                Row::Item(other) => format!("{other:?}"),
            })
            .collect()
    }

    fn thread_event(app: &mut App, sequence: u64, kind: &str, payload: Value) {
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "event", "event": {"sequence": sequence, "type": kind, "occurredAt": "2026-01-01T00:00:00.000Z", "payload": payload}}),
        });
    }

    /// An app with thread t1 open, loaded with a finished conversation.
    fn open_thread() -> App {
        let mut app = app_with_project();
        app.link = LinkStatus::Online;
        app.config = config();
        app.handle(key(KeyCode::Tab));
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Enter));
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 5, "page": {"hasMore": true, "beforeCursor": "c1"}, "thread": {
                "id": "t1", "title": "안녕 스레드", "runtimeMode": "approval-required", "interactionMode": "default",
                "modelSelection": {"instanceId": "codex", "model": "gpt-5"}, "messages": [
                {"id": "u1", "role": "user", "text": "hi", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}}),
        });
        app
    }

    #[tokio::test]
    async fn the_working_folder_project_opens_a_draft_and_lists_its_threads() {
        let app = app_with_project();
        assert_eq!(app.active, Active::Draft("p1".into()));
        assert_eq!(app.focus, Focus::Composer);
        assert_eq!(ids(&app), vec!["new", "t1"]);
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_project_offers_to_add_it() {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/elsewhere", "/tmp", tx);
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1, "projects": [], "threads": []}})));
        assert_eq!(ids(&app), vec!["add", "new"]);
        assert_eq!(app.active, Active::None);
        app.handle(key(KeyCode::Tab));
        app.focus = Focus::List;
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.log[0]["type"], "project.create");
    }

    #[tokio::test]
    async fn sending_without_a_provider_says_so_instead_of_dispatching() {
        let mut app = app_with_project();
        type_text(&mut app, "hello");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.notice.as_deref(), Some(tr("notice.noProvider")));
        assert_eq!(
            app.input.text(),
            "hello",
            "the text stays so it can be sent after fixing the cause"
        );
        assert!(app.log.is_empty());
    }

    #[tokio::test]
    async fn the_first_message_starts_a_thread_on_the_default_model_and_is_remembered() {
        let mut app = app_with_project();
        app.config = config();
        type_text(&mut app, "build it");
        app.handle(key(KeyCode::Enter));
        let command = &app.log[0];
        assert_eq!(command["type"], "thread.turn.start");
        assert_eq!(
            command["modelSelection"],
            json!({"instanceId": "codex", "model": "gpt-5"})
        );
        assert_eq!(command["bootstrap"]["createThread"]["projectId"], "p1");
        assert!(app.input.is_empty());
        app.handle(key(KeyCode::Up));
        assert_eq!(app.input.text(), "build it", "Up recalls what was sent");
    }

    #[tokio::test]
    async fn the_composer_edits_wide_characters_and_several_lines() {
        let mut app = app_with_project();
        type_text(&mut app, "안녕x");
        app.handle(key(KeyCode::Left));
        app.handle(key(KeyCode::Backspace));
        assert_eq!(app.input.text(), "안x");
        app.handle(key(KeyCode::End));
        app.handle(key_with(KeyCode::Char('j'), KeyModifiers::CONTROL));
        type_text(&mut app, "둘째");
        app.handle(key_with(KeyCode::Enter, KeyModifiers::ALT));
        assert_eq!(app.input.text(), "안x\n둘째\n");
        app.handle(Msg::Term(Event::Paste("a\r\nb".into())));
        assert_eq!(app.input.text(), "안x\n둘째\na\nb");
    }

    #[tokio::test]
    async fn tab_moves_between_list_and_composer_and_enter_opens_a_thread() {
        let mut app = app_with_project();
        app.handle(key(KeyCode::Tab));
        assert_eq!(app.focus, Focus::List);
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.active, Active::Thread("t1".into()));
        assert_eq!(app.focus, Focus::Composer);
    }

    #[tokio::test]
    async fn slash_exit_quits_and_unknown_commands_keep_the_text() {
        let mut app = app_with_project();
        type_text(&mut app, "/foo");
        app.handle(key(KeyCode::Enter));
        assert!(!app.quit && app.notice.is_some());
        assert_eq!(app.input.text(), "/foo");
        app.input.take(false);
        type_text(&mut app, "/exit");
        app.handle(key(KeyCode::Enter));
        assert!(app.quit);
    }

    #[tokio::test]
    async fn a_path_is_a_message_not_a_command() {
        let mut app = app_with_project();
        app.config = config();
        type_text(&mut app, "/Users/x/file.rs is broken");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.log[0]["type"], "thread.turn.start");
    }

    #[tokio::test]
    async fn esc_stops_a_running_turn_and_enter_queues_until_it_ends() {
        let mut app = open_thread();
        thread_event(
            &mut app,
            6,
            "thread.session-set",
            json!({"session": {"status": "running", "activeTurnId": "turn-9", "updatedAt": "x"}}),
        );
        assert!(app.conv.busy());
        app.handle(key(KeyCode::Esc));
        assert_eq!(app.log.last().unwrap()["type"], "thread.turn.interrupt");
        assert_eq!(app.log.last().unwrap()["turnId"], "turn-9");
        assert_eq!(app.focus, Focus::Composer);

        type_text(&mut app, "next one");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.queue.len(), 1);
        assert_eq!(app.log.len(), 1, "nothing is sent while the turn runs");
        thread_event(
            &mut app,
            7,
            "thread.session-set",
            json!({"session": {"status": "ready", "updatedAt": "y"}}),
        );
        assert!(app.queue.is_empty());
        let sent = app.log.last().unwrap();
        assert_eq!(
            (sent["type"].as_str(), sent["message"]["text"].as_str()),
            (Some("thread.turn.start"), Some("next one"))
        );
        assert_eq!(
            sent["runtimeMode"], "approval-required",
            "an open thread keeps its own mode"
        );
    }

    #[tokio::test]
    async fn an_approval_takes_the_keys_and_answers_once() {
        let mut app = open_thread();
        thread_event(
            &mut app,
            6,
            "thread.activity-appended",
            json!({"activity": {"id": "a", "tone": "approval", "kind": "approval.requested", "summary": "s",
            "payload": {"requestId": "r1", "requestKind": "command", "detail": "rm -rf build"}, "createdAt": "2026-01-01T00:00:02.000Z"}}),
        );
        assert_eq!(app.state_key(), "state.waiting");
        type_text(&mut app, "x");
        assert!(
            app.input.is_empty(),
            "typing does not leak into the composer"
        );
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Enter));
        let command = app.log.last().unwrap();
        assert_eq!(command["type"], "thread.approval.respond");
        assert_eq!(
            (command["requestId"].as_str(), command["decision"].as_str()),
            (Some("r1"), Some("acceptForSession"))
        );
        // No server in this test: the answer cannot go out, so the panel stays for a retry.
        assert_eq!(app.notice.as_deref(), Some(tr("notice.offline")));
        assert!(app.approval().is_some());
        // Once an answer is on its way the panel is gone, so a second Enter cannot repeat it.
        app.answered.insert("r1".into());
        assert!(app.approval().is_none());
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.log.len(), 1, "a second Enter does not answer again");
    }

    #[tokio::test]
    async fn a_question_collects_its_answers_and_sends_them_together() {
        let mut app = open_thread();
        thread_event(
            &mut app,
            6,
            "thread.activity-appended",
            json!({"activity": {"id": "q", "tone": "info", "kind": "user-input.requested", "summary": "s",
            "payload": {"requestId": "r2", "questions": [
                {"id": "color", "header": "C", "question": "Which?", "options": [{"label": "red", "description": ""}, {"label": "blue", "description": ""}]},
                {"id": "tags", "header": "T", "question": "Tags?", "multiSelect": true, "options": [{"label": "a", "description": ""}, {"label": "b", "description": ""}]}]},
            "createdAt": "2026-01-01T00:00:02.000Z"}}),
        );
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Enter));
        assert!(app.log.is_empty(), "the second question is still open");
        app.handle(key(KeyCode::Char(' ')));
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Char(' ')));
        app.handle(key(KeyCode::Enter));
        let command = app.log.last().unwrap();
        assert_eq!(command["type"], "thread.user-input.respond");
        assert_eq!(
            command["answers"],
            json!({"color": "blue", "tags": ["a", "b"]})
        );
    }

    #[tokio::test]
    async fn model_mode_and_effort_pickers_change_the_next_turn() {
        let mut app = open_thread();
        let path =
            std::env::temp_dir().join(format!("oop-rs-app-{}/last-model.json", std::process::id()));
        app.last_model_path = path.clone();
        type_text(&mut app, "/model mini");
        app.handle(key(KeyCode::Enter));
        assert_eq!(
            app.model_display(),
            "codex/gpt-5-mini",
            "one match is picked outright"
        );
        assert_eq!(
            settings::read_last_model(&path).unwrap()["model"],
            "gpt-5-mini"
        );
        type_text(&mut app, "/model");
        app.handle(key(KeyCode::Enter));
        assert!(matches!(app.modal, Some(Modal::Models { .. })));
        app.handle(key(KeyCode::Esc));
        type_text(&mut app, "/mode full");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.log.last().unwrap()["runtimeMode"], "full-access");
        app.handle(key(KeyCode::Char('x')));
        app.input.take(false);
        app.model_override = None;
        type_text(&mut app, "/effort low");
        app.handle(key(KeyCode::Enter));
        type_text(&mut app, "go");
        app.handle(key(KeyCode::Enter));
        let sent = app.log.last().unwrap();
        assert_eq!(
            sent["modelSelection"]["options"],
            json!([{"id": "reasoningEffort", "value": "low"}])
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[tokio::test]
    async fn plan_mode_is_sent_with_the_next_turn_of_a_draft() {
        let mut app = app_with_project();
        app.config = config();
        type_text(&mut app, "/plan");
        app.handle(key(KeyCode::Enter));
        type_text(&mut app, "design it");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.log[0]["interactionMode"], "plan");
    }

    #[tokio::test]
    async fn scrolling_up_to_the_top_asks_for_older_turns_once() {
        let mut app = open_thread();
        app.scroll_max.set(5);
        app.scroll_up(3);
        assert_eq!(app.scroll.get(), 3);
        assert!(!app.conv.loading_older);
        // No server is connected in this test, so the request is only recorded as not possible.
        app.origin = Some("http://127.0.0.1:1".into());
        app.bearer = Some("b".into());
        app.scroll_up(3);
        assert!(app.conv.loading_older, "the top was reached");
        app.scroll_up(3);
        app.handle(Msg::Older {
            id: "t1".into(),
            result: Ok(json!({"snapshotSequence": 4, "page": {"hasMore": false, "beforeCursor": null}, "thread": {"messages": [
                {"id": "u0", "role": "user", "text": "earlier", "streaming": false, "createdAt": "2026-01-01T00:00:00.000Z"}]}})),
        });
        assert_eq!(app.conv.thread.messages[0].id, "u0");
        assert!(!app.conv.has_more && !app.conv.loading_older);
        app.handle(Msg::Term(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })));
        assert_eq!(app.scroll.get(), 6, "the wheel moves three lines");
    }

    #[tokio::test]
    async fn the_list_skips_headers_and_toggles_shelves() {
        let mut app = app_with_project();
        app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 2, "thread": {"id": "t2", "projectId": "p1", "title": "old", "settledOverride": "settled", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
        app.handle(key(KeyCode::Tab));
        app.handle(key(KeyCode::Down));
        app.handle(key(KeyCode::Down));
        assert!(matches!(
            app.rows()[app.selected],
            Row::Item(Nav::Shelf { .. })
        ));
        app.handle(key(KeyCode::Enter));
        assert!(app.view.settled_open);
        assert!(ids(&app).contains(&"t2".to_string()));
    }

    /// The whole path of a streamed reply with a fake server standing in for the provider: the
    /// server sends a thread snapshot and then deltas, each only after the previous chunk is
    /// acknowledged (as the real one does). The assistant text must grow chunk by chunk and the
    /// final screen must show it, with the user's message right-aligned above it.
    #[tokio::test]
    async fn a_streamed_reply_grows_on_screen_chunk_by_chunk() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let chunk = |id: &Value, item: Value| {
                Message::text(
                    json!({"_tag": "Chunk", "requestId": id, "values": [item]}).to_string(),
                )
            };
            let message = |seq: u64, text: &str, streaming: bool| {
                json!({"kind": "event", "event": {"sequence": seq, "type": "thread.message-sent", "payload": {
                    "messageId": "a1", "role": "assistant", "text": text, "streaming": streaming, "createdAt": "2026-01-01T00:00:02.000Z"}}})
            };
            let mut queue = vec![
                message(4, "안", true),
                message(5, "녕", true),
                message(6, "하세요", true),
                message(7, "안녕하세요", false),
            ];
            queue.reverse();
            let mut thread_request = Value::Null;
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let m: Value = serde_json::from_str(text.as_str()).unwrap();
                match m["_tag"].as_str() {
                    Some("Request") if m["tag"] == SHELL_RPC => {
                        let snapshot = json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
                            "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
                            "threads": [{"id": "t1", "projectId": "p1", "title": "stream", "updatedAt": "z"}]}});
                        ws.send(chunk(&m["id"], snapshot)).await.unwrap();
                    }
                    Some("Request") if m["tag"] == THREAD_RPC => {
                        thread_request = m["id"].clone();
                        let snapshot = json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 3, "thread": {"title": "stream",
                            "messages": [{"id": "u1", "role": "user", "text": "안녕?", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}});
                        ws.send(chunk(&thread_request, snapshot)).await.unwrap();
                    }
                    Some("Ack") if m["requestId"] == thread_request => {
                        if let Some(next) = queue.pop() {
                            ws.send(chunk(&thread_request, next)).await.unwrap();
                        }
                    }
                    _ => {}
                }
            }
        });

        let (tx, mut rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        no_last_model(&mut app);
        let rpc = Rpc::connect(&format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        app.handle(Msg::Connected {
            rpc,
            config: json!({}),
            server: "fake".into(),
            origin: String::new(),
            bearer: String::new(),
        });
        let mut next = async |app: &mut App| {
            let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("a message in time")
                .unwrap();
            app.handle(msg);
        };
        while !app.shell.loaded {
            next(&mut app).await;
        }
        // Tab to the list, down to the thread, Enter: open it.
        for code in [KeyCode::Tab, KeyCode::Down, KeyCode::Enter] {
            app.handle(key(code));
        }
        let mut seen = Vec::new();
        loop {
            next(&mut app).await;
            if let Some(m) = app.conv.thread.messages.last()
                && m.role == Role::Assistant
            {
                if seen.last() != Some(&m.text) {
                    seen.push(m.text.clone());
                }
                if !m.streaming && m.text == "안녕하세요" {
                    break;
                }
            }
        }
        assert_eq!(
            seen,
            vec!["안", "안녕", "안녕하세요"],
            "the reply grew a chunk at a time, then settled"
        );
        assert!(!app.conv.busy());
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 40)).unwrap();
        terminal.draw(|f| crate::ui::draw(f, &app)).unwrap();
        // A wide character's second cell is blank in the buffer, so compare without spaces.
        let text: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();
        let text = text.replace(' ', "");
        assert!(text.contains("안녕하세요") && text.contains("안녕?"));
    }

    #[tokio::test]
    async fn a_picked_mode_shows_at_once_and_yields_to_the_server_value() {
        let mut app = open_thread();
        assert_eq!(app.runtime_mode(), "approval-required");
        app.set_runtime_mode("auto");
        assert_eq!(
            app.runtime_mode(),
            "auto",
            "shown before the server echoes it"
        );
        assert_eq!(app.log.last().unwrap()["type"], "thread.runtime-mode.set");
        thread_event(
            &mut app,
            9,
            "thread.runtime-mode-set",
            json!({"runtimeMode": "auto", "updatedAt": "2026-01-01T00:00:09.000Z"}),
        );
        assert!(app.runtime_intent.is_none(), "the server caught up");
        assert_eq!(app.runtime_mode(), "auto");
        app.set_interaction_mode("plan");
        assert_eq!(app.interaction_mode(), "plan");
    }

    #[tokio::test]
    async fn the_panel_commands_pick_flows_and_say_why_not() {
        crate::i18n::init(Some("en"));
        let mut app = open_thread();
        app.side_open = false;
        type_text(&mut app, "/dag-workflow x");
        app.handle(key(KeyCode::Enter));
        assert_eq!(
            app.notice.as_deref(),
            Some("Usage: /dag-workflow [on|off|N|next|prev|live]")
        );
        app.input.take(true);
        type_text(&mut app, "/dag-workflow 2");
        app.handle(key(KeyCode::Enter));
        assert_eq!(app.notice.as_deref(), Some("There is no flow to pick."));
        assert!(!app.side_open, "a refused pick opens nothing");
        app.input.take(true);
        type_text(&mut app, "/dag-workflow live");
        app.handle(key(KeyCode::Enter));
        assert!(app.side_open && app.side_view == Side::Workflow);
        type_text(&mut app, "/dag-agents 1");
        app.handle(key(KeyCode::Enter));
        assert!(
            app.notice
                .as_deref()
                .is_some_and(|n| n.starts_with("The Agents panel shows the current turn")),
            "{:?}",
            app.notice
        );
        app.input.take(true);
        type_text(&mut app, "/dag-agents");
        app.handle(key(KeyCode::Enter));
        assert!(
            app.side_open && app.side_view == Side::Agents,
            "switches without closing"
        );
        app.input.take(true);
        type_text(&mut app, "/dag-workflow off");
        app.handle(key(KeyCode::Enter));
        assert!(
            app.side_open,
            "off for the view that is not shown closes nothing"
        );
        assert!(
            app.notice
                .as_deref()
                .is_some_and(|n| n.contains("close it with /dag-agents"))
        );
    }

    #[tokio::test]
    async fn the_wheel_over_the_panel_moves_the_panel_and_elsewhere_the_conversation() {
        let mut app = open_thread();
        app.side_open = true;
        app.side_rect.set(Rect::new(100, 5, 40, 20));
        let wheel = |column: u16, kind: MouseEventKind| {
            Msg::Term(Event::Mouse(MouseEvent {
                kind,
                column,
                row: 10,
                modifiers: KeyModifiers::NONE,
            }))
        };
        app.handle(wheel(110, MouseEventKind::ScrollDown));
        assert_eq!(app.panel_scroll.get(), WHEEL_LINES as i32);
        app.handle(wheel(110, MouseEventKind::ScrollUp));
        app.handle(wheel(110, MouseEventKind::ScrollUp));
        assert_eq!(app.panel_scroll.get(), -(WHEEL_LINES as i32));
        assert_eq!(app.scroll.get(), 0, "the conversation did not move");
        app.handle(wheel(20, MouseEventKind::ScrollUp));
        assert_eq!(
            app.scroll.get(),
            WHEEL_LINES,
            "left of the panel it is the conversation's"
        );
        assert_eq!(app.panel_scroll.get(), -(WHEEL_LINES as i32));
    }
}
