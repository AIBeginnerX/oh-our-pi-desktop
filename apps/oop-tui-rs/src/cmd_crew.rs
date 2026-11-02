//! `/crew`: turn the crew on or off for a thread, choose its preset and the model of each role, make
//! a thread's settings the default, and follow the crew's tasks. A port of `runCrewCommand`,
//! `saveCrew`, `openCrewThread`, `backToLead` of the TypeScript controller, of
//! apps/oop-tui/src/app/crew.ts (the settings arithmetic and the model list) and of
//! apps/oop-tui/src/app/crewScreen.ts (the screen: main, preset, model and task views).
//!
//! The crew settings live in the server's settings (`crew`): the defaults, and an override per
//! thread. A change is written over the settings read just now (see `server_settings`). In a
//! thread it lands in that thread's override; on a conversation not started yet it changes the
//! defaults.

use crate::app::{Active, App, Msg};
use crate::crew::{self, Brain, ModelOption, ROLES, Resolved};
use crate::crew_text::{text, text_with};
use crate::flow::{
    CrewBoard, CrewNoteKind, CrewPhase, CrewTask, Waiting, crew_board, is_crew_sub_thread,
    waiting_crew,
};
use crate::i18n::{Lang, lang, tr};
use crate::notes::Tone;
use crate::panels_common::{
    evidence_word, flat, format_cost, format_elapsed, phase_word, tokens_word,
};
use crate::screen::Screen;
use crate::server_settings::{self, Patched};
use crate::text::{sanitize, truncate, width, wrap};
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

pub const RETRY_RPC: &str = "crew.retryTask";

// ---- the words ----------------------------------------------------------------------------------

/// `Worker`, `Expert`, `Auditor` (`CREW_ROLE_LABEL`).
pub fn role_name(role: &str) -> String {
    match role {
        "worker" => "Worker".into(),
        "expert" => "Expert".into(),
        "auditor" => "Auditor".into(),
        other => other.to_string(),
    }
}

struct Preset {
    value: &'static str,
    label_key: &'static str,
    hint_key: &'static str,
    /// Other words `/crew preset <word>` accepts.
    aliases: &'static [&'static str],
}

const PRESETS: [Preset; 4] = [
    Preset {
        value: "recommended",
        label_key: "providers.crew.preset.recommended",
        hint_key: "providers.crew.preset.recommendedHint",
        aliases: &["pick"],
    },
    Preset {
        value: "speed",
        label_key: "providers.crew.preset.speed",
        hint_key: "providers.crew.preset.speedHint",
        aliases: &["fast"],
    },
    Preset {
        value: "quality",
        label_key: "providers.crew.preset.quality",
        hint_key: "providers.crew.preset.qualityHint",
        aliases: &[],
    },
    Preset {
        value: "budget",
        label_key: "providers.crew.preset.budget",
        hint_key: "providers.crew.preset.budgetHint",
        aliases: &["cheap"],
    },
];

fn preset_label(value: &str) -> String {
    PRESETS
        .iter()
        .find(|p| p.value == value)
        .map_or(value.to_string(), |p| text(p.label_key).to_string())
}

/// The preset a `/crew preset` argument names: the value, an alias or the label.
pub fn parse_preset(word: &str) -> Option<&'static str> {
    let wanted = word.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    PRESETS
        .iter()
        .find(|p| {
            p.value == wanted
                || p.aliases.contains(&wanted.as_str())
                || text(p.label_key) == word.trim()
        })
        .map(|p| p.value)
}

fn preset_words() -> String {
    PRESETS.map(|p| p.value).join("|")
}

/// The role (an index into `ROLES`) a `/crew model` argument names.
pub fn parse_role(word: &str) -> Option<usize> {
    let wanted = word.trim().to_lowercase();
    ROLES.iter().position(|role| *role == wanted)
}

fn role_hint(role: usize) -> &'static str {
    text(match role {
        0 => "providers.crew.role.worker",
        1 => "providers.crew.role.expert",
        _ => "providers.crew.role.auditor",
    })
}

fn on_off(on: bool) -> &'static str {
    text(if on { "session.c.on" } else { "session.c.off" })
}

// ---- the thread on screen, and its crew -------------------------------------------------------

/// The thread on screen is a crew task's own thread, and the lead that handed it out.
pub struct Sub {
    pub lead: Option<String>,
}

pub fn crew_sub(app: &App) -> Option<Sub> {
    let Active::Thread(id) = &app.active else {
        return None;
    };
    let known = app.shell.threads.iter().find(|t| t.id == *id)?;
    is_crew_sub_thread(known).then(|| Sub {
        lead: known.parent_thread_id.clone(),
    })
}

/// `Worker · subject`: a crew thread's title without the `Crew ` it begins with.
fn sub_label(title: &str) -> String {
    ["Worker", "Expert", "Auditor"]
        .iter()
        .find(|role| title.starts_with(&format!("Crew {role} · ")))
        .map_or(title, |_| &title["Crew ".len()..])
        .to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// A crew thread that waits for the user.
#[derive(Clone, Debug)]
struct WaitingThread {
    id: String,
    title: String,
    kind: Waiting,
}

/// Everything the screen draws from, read fresh for each frame (`CrewContext`).
struct Context {
    enabled: bool,
    preset: String,
    roles: [Option<ModelOption>; 3],
    pinned: [bool; 3],
    /// A change lands in the thread's own override, not in the defaults.
    thread_scope: bool,
    /// Why the thread's model cannot lead a crew.
    problem: Option<String>,
    board: Option<CrewBoard>,
    waiting: Vec<WaitingThread>,
    options: Vec<ModelOption>,
    /// What the preset alone would put in each role, which Auto stands for.
    autos: [Option<ModelOption>; 3],
    now: i64,
}

fn brain_of(model: &Option<Value>) -> Brain<'_> {
    let model = model.as_ref()?;
    Some((model["instanceId"].as_str()?, model["model"].as_str()?))
}

/// Why a thread running on `brain` cannot use the crew (`crewBrainProblem`).
fn brain_problem(config: &Value, brain: Brain) -> Option<String> {
    let Some((instance, _)) = brain else {
        return Some(text("providers.crew.noModels").into());
    };
    let provider = config["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["instanceId"].as_str() == Some(instance));
    let Some(provider) = provider else {
        return Some(text("providers.crew.unknownModel").into());
    };
    if !crew::brain_cannot(config, brain) {
        return None;
    }
    let name = provider["displayName"]
        .as_str()
        .or_else(|| provider["driver"].as_str())
        .unwrap_or_default();
    Some(text_with(
        "providers.crew.badBrain",
        &[("name", name.to_string())],
    ))
}

fn context(app: &App, now: i64) -> Context {
    let model = app.current_model();
    let brain = brain_of(&model);
    let thread = match &app.active {
        Active::Thread(id) => Some(id.as_str()),
        _ => None,
    };
    let Resolved {
        enabled,
        preset,
        roles,
        pinned,
    } = crew::resolve(&app.config, thread, brain);
    let loaded = thread.is_some_and(|id| app.conv.loaded && app.conv.thread_id == id);
    let board = loaded
        .then(|| crew_board(&app.conv.thread, app.conv.busy()))
        .flatten();
    let waiting = if loaded {
        let map = waiting_crew(&app.shell.threads, &app.conv.thread);
        app.shell
            .threads
            .iter()
            .filter_map(|t| {
                map.get(&t.id).map(|kind| WaitingThread {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    kind: *kind,
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    Context {
        autos: crew::auto_picks(&app.config, brain, &preset),
        options: crew::model_options(&app.config),
        problem: brain_problem(&app.config, brain),
        thread_scope: thread.is_some(),
        enabled,
        preset,
        roles,
        pinned,
        board,
        waiting,
        now,
    }
}

/// `Crew work is waiting for approval — /crew`, with a count when several wait.
pub fn waiting_text(kinds: &[Waiting]) -> Option<String> {
    let approvals = kinds.iter().filter(|k| **k == Waiting::Approval).count();
    match kinds.len() {
        0 => None,
        1 => Some(
            text(if approvals > 0 {
                "providers.crew.waitOneApproval"
            } else {
                "providers.crew.waitOneInput"
            })
            .into(),
        ),
        count => Some(text_with(
            if approvals == count {
                "providers.crew.waitManyApproval"
            } else {
                "providers.crew.waitManyMixed"
            },
            &[("count", count.to_string())],
        )),
    }
}

// ---- the settings arithmetic ------------------------------------------------------------------

/// The crew settings the server reported; a server that sent none has the defaults.
pub fn crew_settings(settings: &Value) -> Value {
    if settings["crew"].is_object() {
        settings["crew"].clone()
    } else {
        json!({"enabled": false, "preset": "recommended", "pinned": {}, "threads": {}})
    }
}

/// What a command or a key asks to change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Change {
    pub enabled: Option<bool>,
    pub preset: Option<String>,
    /// A model pins the role; `None` puts it back on Auto.
    pub pins: Vec<(&'static str, Option<Value>)>,
}

/// The next crew settings after `change`, the way the desktop app writes them (`applyCrewChange`).
/// In a thread the change lands in that thread's override, where a null pin means Auto even if the
/// defaults pin the role; without a thread it changes the defaults themselves. Everything else is
/// kept.
pub fn apply_change(settings: &Value, thread_id: Option<&str>, change: &Change) -> Value {
    let mut next = settings.clone();
    let mut scoped = Map::new();
    if let Some(enabled) = change.enabled {
        scoped.insert("enabled".into(), json!(enabled));
    }
    if let Some(preset) = &change.preset {
        scoped.insert("preset".into(), json!(preset));
    }
    let Some(thread_id) = thread_id else {
        let mut pinned = settings["pinned"].as_object().cloned().unwrap_or_default();
        for (role, selection) in &change.pins {
            match selection {
                None => {
                    pinned.remove(*role);
                }
                Some(selection) => {
                    pinned.insert((*role).into(), selection.clone());
                }
            }
        }
        for (key, value) in scoped {
            next[key] = value;
        }
        next["pinned"] = Value::Object(pinned);
        return next;
    };
    let mut entry = settings["threads"][thread_id]
        .as_object()
        .cloned()
        .unwrap_or_default();
    entry.extend(scoped);
    let mut pinned = entry
        .get("pinned")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (role, selection) in &change.pins {
        pinned.insert((*role).into(), selection.clone().unwrap_or(Value::Null));
    }
    entry.insert("pinned".into(), Value::Object(pinned));
    let mut threads = settings["threads"].as_object().cloned().unwrap_or_default();
    threads.insert(thread_id.to_string(), Value::Object(entry));
    next["threads"] = Value::Object(threads);
    next
}

/// "Use this crew for new chats": what the thread runs with (on or off, preset, and the roles
/// pinned by hand) becomes the default. Threads' own overrides stay as they are
/// (`crewAsDefault`).
pub fn as_default(settings: &Value, crew: &Resolved) -> Value {
    let mut pinned = Map::new();
    for (slot, role) in ROLES.iter().enumerate() {
        if let (true, Some(option)) = (crew.pinned[slot], &crew.roles[slot]) {
            pinned.insert(
                (*role).into(),
                json!({"instanceId": option.instance_id, "model": option.model}),
            );
        }
    }
    let mut next = settings.clone();
    next["enabled"] = json!(crew.enabled);
    next["preset"] = json!(crew.preset);
    next["pinned"] = Value::Object(pinned);
    next
}

enum Save {
    Change(Change),
    /// Make what the thread runs with the default for new threads.
    Default,
}

/// Writes a crew change over the settings read just now, then says what was done.
fn save(app: &mut App, change: Save, label: String, value: String) {
    let scope = match &app.active {
        Active::Thread(id) => Some(id.clone()),
        _ => None,
    };
    let providers = app.config["providers"].clone();
    let brain: Option<(String, String)> = app.current_model().and_then(|m| {
        Some((
            m["instanceId"].as_str()?.to_string(),
            m["model"].as_str()?.to_string(),
        ))
    });
    let active = app.active.clone();
    server_settings::patch(
        app,
        move |current| {
            let crew = crew_settings(current);
            let next = match &change {
                Save::Change(change) => apply_change(&crew, scope.as_deref(), change),
                Save::Default => {
                    let config = json!({"settings": {"crew": crew}, "providers": providers});
                    let brain = brain.as_ref().map(|(a, b)| (a.as_str(), b.as_str()));
                    as_default(&crew, &crew::resolve(&config, scope.as_deref(), brain))
                }
            };
            Some(json!({"crew": next}))
        },
        move |app, result| {
            if app.active != active {
                return;
            }
            match result {
                Err(message) => {
                    let line = format!("{}: {message}", text("session.c.crewSaveFailed"));
                    app.say(Tone::Error, &line);
                }
                Ok(Patched { .. }) => app.note(Tone::Done, &label, vec![value]),
            }
        },
    );
}

fn pin_change(role: usize, selection: Option<Value>) -> Change {
    Change {
        pins: vec![(ROLES[role], selection)],
        ..Default::default()
    }
}

fn selection_of(option: &ModelOption) -> Value {
    json!({"instanceId": option.instance_id, "model": option.model})
}

// ---- the model list of a role -----------------------------------------------------------------

/// One row of the model list for a role: Auto, or a model the environment can run now.
#[derive(Clone, Debug, PartialEq)]
enum PickItem {
    Auto {
        note: String,
    },
    Model {
        option: ModelOption,
        label: String,
        note: String,
    },
}

impl PickItem {
    fn label(&self) -> &str {
        match self {
            PickItem::Auto { .. } => "Auto",
            PickItem::Model { label, .. } => label,
        }
    }

    fn note(&self) -> &str {
        match self {
            PickItem::Auto { note } | PickItem::Model { note, .. } => note,
        }
    }
}

fn tier_word(tier: u8) -> &'static str {
    text(match tier {
        1 => "providers.crew.tier.fast",
        2 => "providers.crew.tier.balanced",
        _ => "providers.crew.tier.strong",
    })
}

/// `scoreQueryMatch` (packages/shared/src/searchRanking.ts) with the tiers the pickers use: exact,
/// prefix, after a word break, anywhere, and (for words of three letters or more) letters in order.
fn score_token(field: &str, token: &str, base: usize) -> Option<usize> {
    if field.is_empty() || token.is_empty() {
        return None;
    }
    let (field_chars, token_len) = (field.chars().count(), token.chars().count());
    let penalty = field_chars.saturating_sub(token_len).min(64);
    let index_of = |needle: &str| field.find(needle).map(|at| field[..at].chars().count());
    if field == token {
        return Some(base);
    }
    if field.starts_with(token) {
        return Some(base + 2 + penalty);
    }
    let boundary = [" ", "-", "_", "/"]
        .iter()
        .filter_map(|marker| index_of(&format!("{marker}{token}")).map(|at| at + 1))
        .min();
    if let Some(at) = boundary {
        return Some(base + 4 + at * 2 + penalty);
    }
    if let Some(at) = index_of(token) {
        return Some(base + 6 + at * 2 + penalty);
    }
    if token_len >= 3 {
        return subsequence(field, token).map(|score| base + 100 + score);
    }
    None
}

fn subsequence(value: &str, query: &str) -> Option<usize> {
    let wanted: Vec<char> = query.chars().collect();
    let (mut next, mut first, mut previous, mut gaps) = (0, None, None::<usize>, 0);
    for (at, ch) in value.chars().enumerate() {
        if ch != wanted[next] {
            continue;
        }
        first.get_or_insert(at);
        if let Some(previous) = previous {
            gaps += at - previous - 1;
        }
        previous = Some(at);
        next += 1;
        if next == wanted.len() {
            let first = first.unwrap_or(0);
            let span = at - first + 1 - wanted.len();
            let length = (value.chars().count() - wanted.len()).min(64);
            return Some(first * 2 + gaps * 3 + span + length);
        }
    }
    None
}

/// How well the typed words match a model's fields (best field first), lower is better; `None`
/// when a word matches no field (`scoreFields`).
fn score_fields(fields: &[String], query: &str) -> Option<usize> {
    let mut total = 0;
    for token in query.to_lowercase().split_whitespace() {
        let best = fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| score_token(field, token, index * 10))
            .min()?;
        total += best;
    }
    Some(total)
}

/// What the model list of a role offers for the typed words: Auto first (when the words do not
/// rule it out), then the models that match, best first.
fn pick_items(ctx: &Context, role: usize, query: &str) -> Vec<PickItem> {
    let mut scored: Vec<(usize, usize, PickItem)> = Vec::new();
    for (index, option) in ctx.options.iter().enumerate() {
        let fields: Vec<String> = [&option.label, &option.driver, &option.provider_label]
            .iter()
            .map(|f| f.trim().to_lowercase())
            .chain(std::iter::once(
                [&option.label, &option.driver, &option.provider_label]
                    .iter()
                    .filter(|f| !f.is_empty())
                    .map(|f| f.trim().to_lowercase())
                    .collect::<Vec<_>>()
                    .join(" "),
            ))
            .collect();
        let Some(score) = score_fields(&fields, query) else {
            continue;
        };
        let default = if option.is_default {
            format!(" · {}", text("providers.cmd.default"))
        } else {
            String::new()
        };
        scored.push((
            score,
            index,
            PickItem::Model {
                label: format!("{} / {}", option.provider_label, option.label),
                note: format!("{}{default}", tier_word(option.tier)),
                option: option.clone(),
            },
        ));
    }
    scored.sort_by_key(|(score, index, _)| (*score, *index));
    let needle = query.trim().to_lowercase();
    let mut items = Vec::new();
    if needle.is_empty() || text("providers.crew.autoWords").contains(&needle) {
        items.push(PickItem::Auto {
            note: match &ctx.autos[role] {
                None => text("providers.crew.noneAvailable").into(),
                Some(pick) => text_with(
                    "providers.crew.recommended",
                    &[
                        ("model", pick.label.clone()),
                        ("provider", pick.provider_label.clone()),
                    ],
                ),
            },
        });
    }
    items.extend(scored.into_iter().map(|(.., item)| item));
    items
}

/// Whether the item is what the role has now: Auto for an unpinned role, else the pinned model.
fn is_current(item: &PickItem, ctx: &Context, role: usize) -> bool {
    match item {
        PickItem::Auto { .. } => !ctx.pinned[role],
        PickItem::Model { option, .. } => {
            ctx.pinned[role]
                && ctx.roles[role]
                    .as_ref()
                    .is_some_and(|r| r.instance_id == option.instance_id && r.model == option.model)
        }
    }
}

/// How a role's model reads: `Auto · Haiku` for an unpinned role, the model alone when pinned.
fn role_model_text(ctx: &Context, role: usize) -> String {
    match &ctx.roles[role] {
        None => text("providers.crew.noneAvailable").into(),
        Some(option) => format!(
            "{}{}",
            if ctx.pinned[role] { "" } else { "Auto · " },
            option.label
        ),
    }
}

// ---- the rows of the board --------------------------------------------------------------------

/// `Worker  In progress · the task's title`.
fn task_headline(task: &CrewTask) -> String {
    format!(
        "{}  {}{}",
        role_name(&task.role),
        phase_word(task),
        task.title
            .as_ref()
            .map_or(String::new(), |t| format!(" · {t}"))
    )
}

fn task_elapsed(task: &CrewTask, now: i64) -> Option<String> {
    let start = task.started_ms?;
    let end = if task.phase == CrewPhase::Running {
        Some(now)
    } else {
        task.completed_ms
    }?;
    Some(format_elapsed((end - start).max(0)))
}

fn task_usage(task: &CrewTask) -> Option<String> {
    let tokens = tokens_word(task.tokens?);
    Some(match task.cost {
        Some(cost) => format!("{tokens} · {}", format_cost(cost)),
        None => tokens,
    })
}

/// The dim part of a board row: model, time, usage.
fn task_note(task: &CrewTask, now: i64) -> String {
    [
        task.model.clone(),
        task_elapsed(task, now),
        task_usage(task),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// The lines of one task's detail screen, each a `name  value` pair.
fn task_detail(task: &CrewTask, now: i64, waiting: Option<Waiting>) -> Vec<(String, String)> {
    let wait = match waiting {
        None => "",
        Some(Waiting::Approval) => text("render.crew.waitApproval"),
        Some(Waiting::Input) => text("render.crew.waitInput"),
    };
    let mut rows = vec![
        (
            text("render.crew.field.task").to_string(),
            task.title
                .clone()
                .unwrap_or_else(|| text("render.crew.untitled").to_string()),
        ),
        (
            text("render.crew.field.role").to_string(),
            role_name(&task.role),
        ),
        (
            text("render.crew.field.status").to_string(),
            format!("{}{wait}", phase_word(task)),
        ),
    ];
    if let Some(model) = &task.model {
        rows.push((text("render.crew.field.model").to_string(), model.clone()));
    }
    if let Some(elapsed) = task_elapsed(task, now) {
        rows.push((text("render.crew.field.elapsed").to_string(), elapsed));
    }
    if let Some(usage) = task_usage(task) {
        rows.push((text("render.crew.field.usage").to_string(), usage));
    }
    if let Some(evidence) = task.evidence {
        rows.push((
            text("render.crew.field.evidence").to_string(),
            evidence_word(evidence).to_string(),
        ));
    }
    if let Some(summary) = &task.summary {
        rows.push((
            text("render.crew.field.summary").to_string(),
            summary.clone(),
        ));
    }
    rows
}

fn note_text(kind: CrewNoteKind, detail: &Value) -> String {
    match kind {
        CrewNoteKind::AuditSkipped => text_with(
            "render.crew.auditSkipped",
            &[(
                "files",
                detail.as_u64().map_or(String::new(), |count| {
                    text_with(
                        "render.crew.auditSkippedFiles",
                        &[("count", count.to_string())],
                    )
                }),
            )],
        ),
        CrewNoteKind::FollowUp => text(if detail.as_str() == Some("audit") {
            "render.crew.followUpAudit"
        } else {
            "render.crew.followUp"
        })
        .into(),
    }
}

impl Context {
    fn waiting_of(&self, task: &CrewTask) -> Option<Waiting> {
        let id = task.thread_id.as_deref()?;
        self.waiting.iter().find(|w| w.id == id).map(|w| w.kind)
    }

    fn task(&self, task_id: &str) -> Option<&CrewTask> {
        self.board
            .as_ref()?
            .tasks
            .iter()
            .find(|t| t.task_id == task_id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Row {
    Toggle,
    Preset,
    Role(usize),
    AutoAll,
    Default,
    /// An index into the board's tasks.
    Task(usize),
    /// A crew thread that waits for the user but is on no board; an index into `waiting`.
    Thread(usize),
}

/// Waiting threads first, then the settings, then the tasks of the board.
fn main_rows(ctx: &Context) -> Vec<Row> {
    let tasks = ctx.board.as_ref().map_or(&[][..], |b| &b.tasks[..]);
    let mut rows: Vec<Row> = ctx
        .waiting
        .iter()
        .enumerate()
        .filter(|(_, w)| {
            !tasks
                .iter()
                .any(|t| t.thread_id.as_deref() == Some(w.id.as_str()))
        })
        .map(|(i, _)| Row::Thread(i))
        .collect();
    rows.extend([Row::Toggle, Row::Preset]);
    rows.extend((0..ROLES.len()).map(Row::Role));
    if ctx.pinned.iter().any(|p| *p) {
        rows.push(Row::AutoAll);
    }
    if ctx.thread_scope {
        rows.push(Row::Default);
    }
    rows.extend((0..tasks.len()).map(Row::Task));
    rows
}

fn row_id(ctx: &Context, row: Row) -> String {
    match row {
        Row::Role(role) => format!("role:{}", ROLES[role]),
        Row::Task(i) => format!(
            "task:{}",
            ctx.board.as_ref().map_or("", |b| &b.tasks[i].task_id)
        ),
        Row::Thread(i) => format!("thread:{}", ctx.waiting[i].id),
        Row::Toggle => "toggle".into(),
        Row::Preset => "preset".into(),
        Row::AutoAll => "autoAll".into(),
        Row::Default => "default".into(),
    }
}

// ---- the views --------------------------------------------------------------------------------

/// The screen `/crew` opens: the crew and its board, and the lists reached from them.
#[derive(Clone, Debug, PartialEq)]
enum View {
    Main {
        selected: usize,
        /// The row the pointer is on, by identity. Rows come and go (a thread starts waiting, a
        /// task ends), so the index is worked out from this each time and never trusted alone.
        row_id: Option<String>,
    },
    Preset {
        selected: usize,
    },
    Model {
        role: usize,
        selected: usize,
        query: String,
    },
    Task {
        task_id: String,
        selected: usize,
        confirm_stop: bool,
    },
}

impl View {
    fn selected(&self) -> usize {
        match self {
            View::Main { selected, .. }
            | View::Preset { selected }
            | View::Model { selected, .. }
            | View::Task { selected, .. } => *selected,
        }
    }
}

/// The main screen with the pointer on the row at `index`.
fn main_view_at(ctx: &Context, index: usize) -> View {
    let rows = main_rows(ctx);
    let at = index.min(rows.len().saturating_sub(1));
    View::Main {
        selected: at,
        row_id: rows.get(at).map(|row| row_id(ctx, *row)),
    }
}

/// The view with its index brought in line with the rows now listed. A pointer whose row has gone
/// stays at its place in the list, held inside it.
fn settle(view: &View, ctx: &Context) -> View {
    let View::Main {
        selected,
        row_id: id,
    } = view
    else {
        return view.clone();
    };
    let rows = main_rows(ctx);
    let found = id
        .as_ref()
        .and_then(|id| rows.iter().position(|row| row_id(ctx, *row) == *id));
    main_view_at(ctx, found.unwrap_or(*selected))
}

fn row_index(ctx: &Context, wanted: impl Fn(&Row) -> bool) -> usize {
    main_rows(ctx).iter().position(wanted).unwrap_or(0)
}

/// The first screen: the pointer starts on a request that waits for the user, else on the first row.
fn open_view(ctx: &Context) -> View {
    let waiting = main_rows(ctx).iter().position(|row| match row {
        Row::Thread(_) => true,
        Row::Task(i) => ctx
            .board
            .as_ref()
            .is_some_and(|b| ctx.waiting_of(&b.tasks[*i]).is_some()),
        _ => false,
    });
    main_view_at(ctx, waiting.unwrap_or(0))
}

/// The model list of a role; the pointer starts on the role's current model.
fn model_view(ctx: &Context, role: usize, query: &str) -> View {
    let current = pick_items(ctx, role, query)
        .iter()
        .position(|item| is_current(item, ctx, role));
    View::Model {
        role,
        selected: current.unwrap_or(0),
        query: query.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskItem {
    Open,
    Stop,
    Retry,
    Back,
    Confirm,
    Cancel,
}

fn task_items(task: &CrewTask, confirm_stop: bool) -> Vec<TaskItem> {
    if confirm_stop {
        return vec![TaskItem::Confirm, TaskItem::Cancel];
    }
    let mut items = Vec::new();
    if task.actions.open && task.thread_id.is_some() {
        items.push(TaskItem::Open);
    }
    if task.actions.stop && task.thread_id.is_some() {
        items.push(TaskItem::Stop);
    }
    if task.actions.retry {
        items.push(TaskItem::Retry);
    }
    items.push(TaskItem::Back);
    items
}

fn count_of(view: &View, ctx: &Context) -> usize {
    match view {
        View::Main { .. } => main_rows(ctx).len(),
        View::Preset { .. } => PRESETS.len(),
        View::Model { role, query, .. } => pick_items(ctx, *role, query).len(),
        View::Task {
            task_id,
            confirm_stop,
            ..
        } => ctx
            .task(task_id)
            .map_or(0, |task| task_items(task, *confirm_stop).len()),
    }
}

// ---- keys -------------------------------------------------------------------------------------

/// What the app must do for a key; the screen itself only moves between its views.
#[derive(Clone, Debug, PartialEq)]
enum Effect {
    None,
    Toggle,
    Preset(&'static str),
    Pin { role: usize, pick: PickItem },
    AutoAll,
    Default,
    Open(String),
    Stop(TaskRef),
    Retry(TaskRef),
}

/// What an effect needs of a task, which is all that is kept of it.
#[derive(Clone, Debug, PartialEq)]
struct TaskRef {
    task_id: String,
    role: String,
    thread_id: Option<String>,
}

impl From<&CrewTask> for TaskRef {
    fn from(task: &CrewTask) -> Self {
        TaskRef {
            task_id: task.task_id.clone(),
            role: task.role.clone(),
            thread_id: task.thread_id.clone(),
        }
    }
}

struct KeyResult {
    /// The view after the key; `None` closes the screen.
    view: Option<View>,
    effect: Effect,
    notice: Option<String>,
}

fn stay(view: Option<View>) -> KeyResult {
    KeyResult {
        view,
        effect: Effect::None,
        notice: None,
    }
}

fn with_effect(view: Option<View>, effect: Effect) -> KeyResult {
    KeyResult {
        view,
        effect,
        notice: None,
    }
}

/// Longest search, in characters.
const SEARCH_LIMIT: usize = 60;

/// The search text after `typed` was added: one line, no leading space, no doubled spaces, cut to
/// the limit (`appendToSearch`).
fn append_to_search(query: &str, typed: &str) -> String {
    let mut out = String::new();
    for ch in query.chars().chain(sanitize(typed).chars()) {
        if ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
    }
    out.chars().take(SEARCH_LIMIT).collect()
}

fn with_selected(view: &View, ctx: &Context, selected: usize) -> View {
    match view {
        View::Main { .. } => main_view_at(ctx, selected),
        View::Preset { .. } => View::Preset { selected },
        View::Model { role, query, .. } => View::Model {
            role: *role,
            selected,
            query: query.clone(),
        },
        View::Task {
            task_id,
            confirm_stop,
            ..
        } => View::Task {
            task_id: task_id.clone(),
            selected,
            confirm_stop: *confirm_stop,
        },
    }
}

/// One key on the screen. The arrows and the digits 1-9 move the pointer, Enter acts, Esc goes back
/// a step (or closes). The model list also takes letters, which narrow it, so there the digits are
/// letters too. Nothing a key does is sent from here: the app carries out the effect.
fn crew_key(shown: &View, ctx: &Context, key: KeyEvent) -> KeyResult {
    let view = settle(shown, ctx);
    let count = count_of(&view, ctx);
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let go = |selected: usize| stay(Some(with_selected(&view, ctx, selected)));
    let back = || -> KeyResult {
        match &view {
            View::Main { .. } => stay(None),
            View::Task {
                task_id,
                confirm_stop,
                ..
            } => {
                if *confirm_stop {
                    return stay(Some(View::Task {
                        task_id: task_id.clone(),
                        selected: 0,
                        confirm_stop: false,
                    }));
                }
                stay(Some(main_view_at(
                    ctx,
                    row_index(
                        ctx,
                        |row| matches!(row, Row::Task(i) if ctx.board.as_ref().is_some_and(|b| b.tasks[*i].task_id == *task_id)),
                    ),
                )))
            }
            View::Preset { .. } => stay(Some(main_view_at(
                ctx,
                row_index(ctx, |row| *row == Row::Preset),
            ))),
            View::Model { role, .. } => stay(Some(main_view_at(
                ctx,
                row_index(ctx, |row| *row == Row::Role(*role)),
            ))),
        }
    };

    if let View::Model {
        role,
        selected: _,
        query,
    } = &view
    {
        let edit = |query: String| {
            stay(Some(View::Model {
                role: *role,
                selected: 0,
                query,
            }))
        };
        match key.code {
            KeyCode::Char('u') if ctrl => return edit(String::new()),
            KeyCode::Char(ch) if !ctrl && !alt => {
                return edit(append_to_search(query, &ch.to_string()));
            }
            KeyCode::Backspace => {
                let next = if ctrl || alt {
                    String::new()
                } else {
                    let mut chars: Vec<char> = query.chars().collect();
                    chars.pop();
                    chars.into_iter().collect()
                };
                return edit(next);
            }
            _ => {}
        }
    } else if let KeyCode::Char(ch) = key.code {
        if ctrl || alt {
            return stay(Some(view));
        }
        if ch == 'q' {
            return back();
        }
        if let Some(index) = ch.to_digit(10).filter(|d| *d >= 1).map(|d| d as usize - 1)
            && index < count
        {
            return go(index);
        }
        return stay(Some(view));
    }
    match key.code {
        KeyCode::Up => go(view.selected().saturating_sub(1)),
        KeyCode::Down => go((view.selected() + 1).min(count.saturating_sub(1))),
        KeyCode::Esc => match &view {
            View::Model { role, query, .. } if !query.is_empty() => stay(Some(View::Model {
                role: *role,
                selected: 0,
                query: String::new(),
            })),
            _ => back(),
        },
        KeyCode::Enter => activate(&view, ctx),
        _ => stay(Some(view)),
    }
}

fn activate(view: &View, ctx: &Context) -> KeyResult {
    match view {
        View::Preset { selected } => {
            let Some(preset) = PRESETS.get(*selected) else {
                return stay(Some(view.clone()));
            };
            with_effect(
                Some(main_view_at(ctx, row_index(ctx, |row| *row == Row::Preset))),
                Effect::Preset(preset.value),
            )
        }
        View::Model {
            role,
            selected,
            query,
        } => {
            let Some(pick) = pick_items(ctx, *role, query).get(*selected).cloned() else {
                return KeyResult {
                    view: Some(view.clone()),
                    effect: Effect::None,
                    notice: Some(text("providers.crewScreen.noMatch").into()),
                };
            };
            with_effect(
                Some(main_view_at(
                    ctx,
                    row_index(ctx, |row| *row == Row::Role(*role)),
                )),
                Effect::Pin { role: *role, pick },
            )
        }
        View::Task {
            task_id,
            selected,
            confirm_stop,
        } => {
            let Some(task) = ctx.task(task_id) else {
                return stay(Some(main_view_at(ctx, 0)));
            };
            let Some(item) = task_items(task, *confirm_stop).get(*selected).copied() else {
                return stay(Some(main_view_at(ctx, 0)));
            };
            let here = |selected: usize, confirm_stop: bool| {
                Some(View::Task {
                    task_id: task_id.clone(),
                    selected,
                    confirm_stop,
                })
            };
            match item {
                TaskItem::Open => match &task.thread_id {
                    None => stay(Some(view.clone())),
                    Some(id) => with_effect(None, Effect::Open(id.clone())),
                },
                TaskItem::Stop => stay(here(1, true)),
                TaskItem::Confirm => with_effect(here(0, false), Effect::Stop(task.into())),
                TaskItem::Retry => with_effect(Some(view.clone()), Effect::Retry(task.into())),
                TaskItem::Cancel => stay(here(0, false)),
                TaskItem::Back => stay(Some(main_view_at(
                    ctx,
                    row_index(
                        ctx,
                        |row| matches!(row, Row::Task(i) if ctx.board.as_ref().is_some_and(|b| b.tasks[*i].task_id == *task_id)),
                    ),
                ))),
            }
        }
        View::Main { selected, .. } => {
            let Some(row) = main_rows(ctx).get(*selected).copied() else {
                return stay(Some(view.clone()));
            };
            match row {
                Row::Toggle => with_effect(Some(view.clone()), Effect::Toggle),
                Row::AutoAll => with_effect(Some(view.clone()), Effect::AutoAll),
                Row::Default => with_effect(Some(view.clone()), Effect::Default),
                Row::Preset => stay(Some(View::Preset {
                    selected: PRESETS
                        .iter()
                        .position(|p| p.value == ctx.preset)
                        .unwrap_or(0),
                })),
                Row::Role(role) => stay(Some(model_view(ctx, role, ""))),
                Row::Task(i) => stay(Some(View::Task {
                    task_id: ctx
                        .board
                        .as_ref()
                        .map_or(String::new(), |b| b.tasks[i].task_id.clone()),
                    selected: 0,
                    confirm_stop: false,
                })),
                Row::Thread(i) => with_effect(None, Effect::Open(ctx.waiting[i].id.clone())),
            }
        }
    }
}

// ---- carrying out an effect -------------------------------------------------------------------

fn offline(app: &mut App) {
    app.notice = Some(tr("notice.offline").into());
}

fn run_effect(app: &mut App, effect: Effect, ctx: &Context) {
    match effect {
        Effect::None => {}
        Effect::Toggle => {
            let enabled = !ctx.enabled;
            if enabled && let Some(problem) = &ctx.problem {
                app.notice = Some(problem.clone());
            }
            save(
                app,
                Save::Change(Change {
                    enabled: Some(enabled),
                    ..Default::default()
                }),
                "Crew".into(),
                on_off(enabled).into(),
            );
        }
        Effect::Preset(preset) => save(
            app,
            Save::Change(Change {
                preset: Some(preset.into()),
                ..Default::default()
            }),
            text("session.c.crewPreset").into(),
            preset_label(preset),
        ),
        Effect::Pin { role, pick } => {
            let (selection, value) = match &pick {
                PickItem::Auto { .. } => (None, "Auto".to_string()),
                PickItem::Model { option, label, .. } => {
                    (Some(selection_of(option)), label.clone())
                }
            };
            save(
                app,
                Save::Change(pin_change(role, selection)),
                text_with("session.c.roleModel", &[("role", role_name(ROLES[role]))]),
                value,
            );
        }
        Effect::AutoAll => save(
            app,
            Save::Change(Change {
                pins: ROLES.iter().map(|role| (*role, None)).collect(),
                ..Default::default()
            }),
            text("session.c.crewRoleModels").into(),
            text("session.c.allAuto").into(),
        ),
        Effect::Default => save(
            app,
            Save::Default,
            text("session.c.crewDefault").into(),
            text("session.c.crewDefaultNote").into(),
        ),
        Effect::Open(id) => open_thread(app, &id),
        Effect::Stop(task) => stop_task(app, &task),
        Effect::Retry(task) => retry_task(app, &task),
    }
}

/// Opens a crew task's own thread, or the lead it came from (`openCrewThread`).
fn open_thread(app: &mut App, id: &str) {
    let Some(target) = app.shell.threads.iter().find(|t| t.id == id).cloned() else {
        app.notice = Some(text("session.c.threadNotFound").into());
        return;
    };
    app.open_thread(id);
    if is_crew_sub_thread(&target) {
        app.note(
            Tone::Info,
            text("session.c.crewTaskThread"),
            vec![text("session.c.crewTaskThreadNote").into()],
        );
    }
}

/// `/crew back`: from a crew task's thread to the lead that handed it out.
fn back_to_lead(app: &mut App) {
    match crew_sub(app) {
        None => app.notice = Some(text("session.c.crewBackOnlyInTask").into()),
        Some(Sub { lead: None }) => app.notice = Some(text("session.c.leadUnknown").into()),
        Some(Sub { lead: Some(lead) }) => open_thread(app, &lead),
    }
}

/// Interrupts the task's own thread, which ends the task as stopped; it can be retried after.
fn stop_task(app: &mut App, task: &TaskRef) {
    let Some(thread_id) = &task.thread_id else {
        return;
    };
    if app.rpc.is_none() {
        return offline(app);
    }
    let command = crate::commands::turn_interrupt(&crate::commands::Ctx::fresh(), thread_id, None);
    app.dispatch(command, None, None);
    app.note(
        Tone::Done,
        "Crew",
        vec![text_with(
            "session.c.crewStopRequested",
            &[("role", role_name(&task.role))],
        )],
    );
}

static RETRYING: AtomicBool = AtomicBool::new(false);

/// Runs a task that ended without finishing again, as a new task of the same lead.
fn retry_task(app: &mut App, task: &TaskRef) {
    let (Some(rpc), Active::Thread(lead)) = (app.rpc.clone(), app.active.clone()) else {
        return offline(app);
    };
    if RETRYING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, task) = (app.sender(), task.clone());
    tokio::spawn(async move {
        let outcome = rpc
            .call(
                RETRY_RPC,
                json!({"leadThreadId": lead, "taskId": task.task_id}),
            )
            .await;
        RETRYING.store(false, Ordering::SeqCst);
        let _ = tx.send(Msg::Ext(Box::new(move |app| match outcome {
            Ok(_) => app.note(
                Tone::Done,
                "Crew",
                vec![text_with(
                    "session.c.crewRestarted",
                    &[("role", role_name(&task.role))],
                )],
            ),
            Err(detail) => {
                let line = text_with(
                    "session.c.crewRetryFailed",
                    &[(
                        "detail",
                        sanitize(&detail)
                            .lines()
                            .next()
                            .unwrap_or_default()
                            .to_string(),
                    )],
                );
                app.say(Tone::Error, &line);
            }
        })));
    });
}

// ---- the command ------------------------------------------------------------------------------

/// `/crew` opens the screen; `/crew on|off`, `/crew preset <name>`, `/crew model <role> [model|auto]`
/// and `/crew default` change it directly; `/crew back` leaves a crew task's thread.
pub fn run(app: &mut App, argument: &str) {
    if matches!(app.active, Active::None) {
        app.notice = Some(tr("notice.pickFirst").into());
        return;
    }
    let args: Vec<&str> = argument.split_whitespace().collect();
    let word = args.first().map(|w| w.to_lowercase());
    if crew_sub(app).is_some() {
        match word.as_deref() {
            None | Some("back") => back_to_lead(app),
            Some(_) => app.notice = Some(text("session.c.crewBackOnly").into()),
        }
        return;
    }
    let ctx = context(app, now_ms());
    let Some(word) = word else {
        app.screen = Some(Box::new(CrewScreen {
            view: open_view(&ctx),
        }));
        return;
    };
    match word.as_str() {
        "on" | "off" => {
            let enabled = word == "on";
            if enabled && let Some(problem) = &ctx.problem {
                app.notice = Some(problem.clone());
            }
            if enabled == ctx.enabled {
                if app.notice.is_none() {
                    app.notice = Some(text_with(
                        "session.c.crewAlready",
                        &[("state", on_off(enabled).into())],
                    ));
                }
                return;
            }
            save(
                app,
                Save::Change(Change {
                    enabled: Some(enabled),
                    ..Default::default()
                }),
                "Crew".into(),
                on_off(enabled).into(),
            );
        }
        "preset" => {
            let Some(name) = args.get(1) else {
                let selected = PRESETS
                    .iter()
                    .position(|p| p.value == ctx.preset)
                    .unwrap_or(0);
                app.screen = Some(Box::new(CrewScreen {
                    view: View::Preset { selected },
                }));
                return;
            };
            let Some(preset) = parse_preset(name) else {
                app.notice = Some(text_with(
                    "session.c.unknownPreset",
                    &[("value", flat(name)), ("words", preset_words())],
                ));
                return;
            };
            save(
                app,
                Save::Change(Change {
                    preset: Some(preset.into()),
                    ..Default::default()
                }),
                text("session.c.crewPreset").into(),
                preset_label(preset),
            );
        }
        "model" => run_model(app, &ctx, &args),
        "default" => {
            if !ctx.thread_scope {
                app.notice = Some(text("session.c.crewDefaultAlready").into());
                return;
            }
            save(
                app,
                Save::Default,
                text("session.c.crewDefault").into(),
                text("session.c.crewDefaultNote").into(),
            );
        }
        "back" => back_to_lead(app),
        _ => {
            app.notice = Some(text_with(
                "session.c.crewUsage",
                &[("words", preset_words())],
            ))
        }
    }
}

/// `/crew model <role> [model|auto]`.
fn run_model(app: &mut App, ctx: &Context, args: &[&str]) {
    let role = match args.get(1) {
        None => {
            app.notice = Some(text("session.c.crewModelUsage").into());
            return;
        }
        Some(word) => match parse_role(word) {
            Some(role) => role,
            None => {
                app.notice = Some(text_with("session.c.unknownRole", &[("value", flat(word))]));
                return;
            }
        },
    };
    let query = args[2..].join(" ");
    let label = text_with("session.c.roleModel", &[("role", role_name(ROLES[role]))]);
    if query.is_empty() {
        app.screen = Some(Box::new(CrewScreen {
            view: model_view(ctx, role, ""),
        }));
        return;
    }
    if query.to_lowercase() == "auto" {
        save(
            app,
            Save::Change(pin_change(role, None)),
            label,
            "Auto".into(),
        );
        return;
    }
    let matches: Vec<PickItem> = pick_items(ctx, role, &query)
        .into_iter()
        .filter(|item| matches!(item, PickItem::Model { .. }))
        .collect();
    match matches.as_slice() {
        [
            PickItem::Model {
                option,
                label: name,
                ..
            },
        ] => save(
            app,
            Save::Change(pin_change(role, Some(selection_of(option)))),
            label,
            name.clone(),
        ),
        [] => {
            app.notice = Some(text_with(
                "session.c.noModelNamed",
                &[("query", flat(&query))],
            ));
        }
        // Several models fit the words: the list, already narrowed, lets the user choose.
        _ => {
            app.screen = Some(Box::new(CrewScreen {
                view: model_view(ctx, role, &query),
            }));
        }
    }
}

/// Nothing opens a `Modal::Pick` for the crew; the screen has its own lists.
pub fn picked(_app: &mut App, _pick: &crate::app::Pick, _index: usize) {}

// ---- the screen -------------------------------------------------------------------------------

pub struct CrewScreen {
    view: View,
}

/// Rows of a task's summary the detail screen keeps; the rest is in the task's own thread.
const SUMMARY_ROWS: usize = 5;

/// One list row: its label, and a note after it.
struct Item {
    label: String,
    note: String,
}

fn numbered(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .enumerate()
        .map(|(i, item)| Item {
            label: if i < 9 {
                format!("{}  {}", i + 1, item.label)
            } else {
                item.label
            },
            note: item.note,
        })
        .collect()
}

/// What one frame of the screen shows: a title, lines over the list, the list and the pointer.
struct Content {
    title: String,
    before: Vec<(String, Shade)>,
    items: Vec<Item>,
    selected: usize,
    empty: String,
}

#[derive(Clone, Copy)]
enum Shade {
    Plain,
    Dim,
    Warning,
}

fn dim(line: impl Into<String>) -> (String, Shade) {
    (line.into(), Shade::Dim)
}

fn frame_of(shown: &View, ctx: &Context, room: usize) -> Content {
    let view = settle(shown, ctx);
    let scope = text(if ctx.thread_scope {
        "providers.crewScreen.scopeThread"
    } else {
        "providers.crewScreen.scopeDefault"
    });
    match &view {
        View::Preset { selected } => Content {
            title: text("providers.crewScreen.presetTitle").into(),
            items: numbered(
                PRESETS
                    .iter()
                    .map(|p| Item {
                        label: text(p.label_key).into(),
                        note: [
                            if p.value == ctx.preset {
                                text("providers.screen.current")
                            } else {
                                ""
                            },
                            text(p.hint_key),
                        ]
                        .iter()
                        .filter(|part| !part.is_empty())
                        .copied()
                        .collect::<Vec<_>>()
                        .join(" · "),
                    })
                    .collect(),
            ),
            selected: *selected,
            empty: String::new(),
            before: vec![dim(text_with(
                "providers.crewScreen.presetNote",
                &[("scope", scope.to_string())],
            ))],
        },
        View::Model {
            role,
            selected,
            query,
        } => Content {
            title: text_with(
                "providers.crewScreen.roleModel",
                &[("role", role_name(ROLES[*role]))],
            ),
            items: pick_items(ctx, *role, query)
                .iter()
                .map(|item| Item {
                    label: item.label().into(),
                    note: [
                        if is_current(item, ctx, *role) {
                            text("providers.screen.current")
                        } else {
                            ""
                        },
                        item.note(),
                    ]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" · "),
                })
                .collect(),
            selected: *selected,
            empty: text("providers.crewScreen.noMatch").into(),
            before: vec![if query.is_empty() {
                dim(text_with(
                    "providers.crewScreen.typeToFilter",
                    &[("hint", role_hint(*role).to_string())],
                ))
            } else {
                (
                    format!(
                        "{} {}",
                        text("providers.crewScreen.search"),
                        sanitize(query)
                    ),
                    Shade::Plain,
                )
            }],
        },
        View::Task {
            task_id,
            selected,
            confirm_stop,
        } => {
            let Some(task) = ctx.task(task_id) else {
                return Content {
                    title: text("providers.crewScreen.taskTitle").into(),
                    items: Vec::new(),
                    selected: 0,
                    empty: text("providers.crewScreen.taskGone").into(),
                    before: Vec::new(),
                };
            };
            let waiting = ctx.waiting_of(task);
            let pad: usize = if lang() == Lang::Ko { 4 } else { 9 };
            let summary_name = text("render.crew.field.summary");
            let mut before = Vec::new();
            for (name, value) in task_detail(task, ctx.now, waiting) {
                let filler = " ".repeat(pad.saturating_sub(name.chars().count()));
                let mut rows = wrap(&format!("{name}{filler} {}", sanitize(&value)), room);
                if name == summary_name && rows.len() > SUMMARY_ROWS {
                    rows.truncate(SUMMARY_ROWS - 1);
                    rows.push("…".into());
                }
                before.extend(rows.into_iter().map(|row| (row, Shade::Plain)));
            }
            let label = |item: TaskItem| -> Item {
                let (label, note) = match item {
                    TaskItem::Open => (
                        "providers.crewScreen.openSub",
                        if waiting.is_none() {
                            "providers.crewScreen.openSubNote"
                        } else {
                            "providers.crewScreen.openSubWaitingNote"
                        },
                    ),
                    TaskItem::Stop => {
                        ("providers.crewScreen.stop", "providers.crewScreen.stopNote")
                    }
                    TaskItem::Retry => (
                        "providers.crewScreen.retry",
                        "providers.crewScreen.retryNote",
                    ),
                    TaskItem::Back => ("providers.crewScreen.toBoard", ""),
                    TaskItem::Confirm => (
                        "providers.crewScreen.confirmStop",
                        "providers.crewScreen.confirmStopNote",
                    ),
                    TaskItem::Cancel => ("providers.crewScreen.cancel", ""),
                };
                Item {
                    label: text(label).into(),
                    note: if note.is_empty() {
                        String::new()
                    } else {
                        text(note).into()
                    },
                }
            };
            Content {
                title: if *confirm_stop {
                    text("providers.crewScreen.stopQuestion").into()
                } else {
                    text_with(
                        "providers.crewScreen.roleTask",
                        &[("role", role_name(&task.role))],
                    )
                },
                items: numbered(
                    task_items(task, *confirm_stop)
                        .into_iter()
                        .map(label)
                        .collect(),
                ),
                selected: *selected,
                empty: String::new(),
                before,
            }
        }
        View::Main { selected, .. } => {
            let wait_label = |kind: Waiting| {
                text(match kind {
                    Waiting::Approval => "providers.crewScreen.waitApproval",
                    Waiting::Input => "providers.crewScreen.waitInput",
                })
            };
            let items = main_rows(ctx)
                .into_iter()
                .map(|row| match row {
                    Row::Toggle => Item {
                        label: format!(
                            "Crew  {}",
                            text(if ctx.enabled {
                                "providers.cmd.on"
                            } else {
                                "providers.cmd.off"
                            })
                        ),
                        note: scope.into(),
                    },
                    Row::Preset => Item {
                        label: format!(
                            "{}  {}",
                            text("providers.crewScreen.preset"),
                            preset_label(&ctx.preset)
                        ),
                        note: PRESETS
                            .iter()
                            .find(|p| p.value == ctx.preset)
                            .map_or(String::new(), |p| text(p.hint_key).into()),
                    },
                    Row::Role(role) => Item {
                        label: format!(
                            "{}  {}",
                            role_name(ROLES[role]),
                            role_model_text(ctx, role)
                        ),
                        note: role_hint(role).into(),
                    },
                    Row::AutoAll => Item {
                        label: text("providers.crewScreen.autoAll").into(),
                        note: text("providers.crewScreen.autoAllNote").into(),
                    },
                    Row::Default => Item {
                        label: text("providers.crewScreen.makeDefault").into(),
                        note: text("providers.crewScreen.makeDefaultNote").into(),
                    },
                    Row::Thread(i) => Item {
                        label: format!(
                            "{}  {}",
                            wait_label(ctx.waiting[i].kind),
                            sub_label(&ctx.waiting[i].title)
                        ),
                        note: text("providers.crewScreen.enterToOpen").into(),
                    },
                    Row::Task(i) => {
                        let task = &ctx.board.as_ref().expect("a task row has a board").tasks[i];
                        let wait = ctx
                            .waiting_of(task)
                            .map_or(String::new(), |kind| format!(" · {}", wait_label(kind)));
                        Item {
                            label: format!("{}{wait}", task_headline(task)),
                            note: task_note(task, ctx.now),
                        }
                    }
                })
                .collect();
            let mut before = Vec::new();
            if let Some(problem) = &ctx.problem {
                before.extend(
                    wrap(&sanitize(problem), room)
                        .into_iter()
                        .map(|row| (row, Shade::Warning)),
                );
            }
            let kinds: Vec<Waiting> = ctx.waiting.iter().map(|w| w.kind).collect();
            if let Some(line) = waiting_text(&kinds) {
                before.extend(
                    wrap(&line, room)
                        .into_iter()
                        .map(|row| (row, Shade::Warning)),
                );
            }
            match &ctx.board {
                None => before.push(dim(text("providers.crewScreen.noTasks"))),
                Some(board) => {
                    before.push(dim(crate::panels_common::board_summary(board)));
                    for note in &board.notes {
                        before.extend(
                            wrap(&note_text(note.kind, &note.detail), room)
                                .into_iter()
                                .map(|row| (row, Shade::Dim)),
                        );
                    }
                }
            }
            Content {
                title: "Crew".into(),
                items: numbered(items),
                selected: *selected,
                empty: String::new(),
                before,
            }
        }
    }
}

impl Screen for CrewScreen {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App) {
        let t = &app.theme;
        let wide = usize::from(area.width).saturating_sub(4).max(8);
        let ctx = context(app, now_ms());
        let content = frame_of(&self.view, &ctx, wide);
        let tone = |tone: Shade| match tone {
            Shade::Plain => Style::new(),
            Shade::Dim => t.dim_style(),
            Shade::Warning => Style::new().fg(t.warning),
        };
        let mut lines: Vec<Line> = vec![Line::from(Span::styled(
            format!(" {}", sanitize(&content.title)),
            Style::new().fg(t.brand).add_modifier(Modifier::BOLD),
        ))];
        for (row, kind) in &content.before {
            lines.push(Line::from(Span::styled(
                format!("  {}", sanitize(row)),
                tone(*kind),
            )));
        }
        lines.push(Line::default());
        if content.items.is_empty() {
            lines.push(Line::from(Span::styled(
                format!("  {}", content.empty),
                t.dim_style(),
            )));
        }
        let room = usize::from(area.height).saturating_sub(lines.len()).max(1);
        let first = (content.selected + 1).saturating_sub(room);
        for (index, item) in content.items.iter().enumerate().skip(first).take(room) {
            let selected = index == content.selected;
            let mark = if selected { app.sym.prompt } else { " " };
            let label_style = if selected {
                Style::new().fg(t.brand).add_modifier(Modifier::BOLD)
            } else {
                Style::new()
            };
            let label = truncate(
                &sanitize(&item.label).replace('\n', " "),
                wide.saturating_sub(2),
            );
            let left = width(&label) + 2;
            let mut spans = vec![Span::styled(format!(" {mark} {label}"), label_style)];
            let note_room = wide.saturating_sub(left + 2);
            if !item.note.is_empty() && note_room >= 6 {
                spans.push(Span::styled(
                    format!("  {}", truncate(&flat(&item.note), note_room)),
                    t.dim_style(),
                ));
            }
            lines.push(Line::from(spans));
        }
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool {
        let ctx = context(app, now_ms());
        let result = crew_key(&self.view, &ctx, key);
        if let Some(notice) = result.notice {
            app.notice = Some(notice);
        }
        let closes = result.view.is_none();
        if let Some(view) = result.view {
            self.view = view;
        }
        run_effect(app, result.effect, &ctx);
        closes
    }

    fn hint(&self) -> String {
        // The hint is drawn from the status line, which has no app to read; the view alone says it.
        match &self.view {
            View::Main { .. } => text("providers.crewScreen.hintMain"),
            View::Preset { .. } => text("providers.crewScreen.hintPreset"),
            View::Model { query, .. } if query.is_empty() => text("providers.crewScreen.hintModel"),
            View::Model { .. } => text("providers.crewScreen.hintModelClear"),
            View::Task {
                confirm_stop: true, ..
            } => text("providers.crewScreen.hintConfirm"),
            View::Task { .. } => text("providers.crewScreen.hintTask"),
        }
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::Note;
    use crate::panels_common::scenes;
    use crate::server_settings::{UPDATE_SETTINGS, fake};
    use crate::state::{Conversation, ThreadShell};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn english() {
        crate::i18n::init(Some("en"));
    }

    fn model(slug: &str, name: &str, default: bool) -> Value {
        json!({"slug": slug, "name": name, "isDefault": default})
    }

    fn providers() -> Value {
        json!([
            {"instanceId": "claude", "driver": "claudeAgent", "displayName": "Claude", "enabled": true,
             "installed": true, "status": "ready", "auth": {"status": "authenticated"},
             "models": [model("claude-haiku-5-5", "Haiku 5.5", false), model("claude-sonnet-5-5", "Sonnet 5.5", true),
                        model("claude-opus-5-5", "Opus 5.5", false)]},
            {"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
             "installed": true, "status": "ready", "auth": {"status": "authenticated"},
             "models": [model("gpt-5", "GPT-5", true), model("gpt-5-mini", "GPT-5 mini", false)]},
            {"instanceId": "grok", "driver": "grok", "displayName": "Grok", "enabled": true,
             "installed": true, "status": "ready", "auth": {"status": "authenticated"},
             "models": [model("grok-4", "Grok 4", true)]}
        ])
    }

    fn app_with(crew: Value) -> App {
        english();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        app.config = json!({"settings": {"crew": crew}, "providers": providers()});
        app
    }

    /// The thread `lead`, on Claude, loaded, with the given activities.
    fn on_lead(app: &mut App, activities: Vec<Value>, running: bool) {
        let mut thread = scenes::thread(activities, running);
        thread.model_selection = json!({"instanceId": "claude", "model": "claude-sonnet-5-5"});
        app.active = Active::Thread("lead".into());
        app.conv = Conversation::new("lead");
        app.conv.loaded = true;
        app.conv.thread = thread;
        app.shell.threads = vec![
            serde_json::from_value(json!({"id": "lead", "projectId": "p1", "title": "Lead"}))
                .unwrap(),
        ];
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn letter(ch: char) -> KeyEvent {
        key(KeyCode::Char(ch))
    }

    #[test]
    fn presets_and_roles_are_named_by_value_alias_or_label() {
        english();
        assert_eq!(parse_preset("speed"), Some("speed"));
        assert_eq!(parse_preset(" FAST "), Some("speed"));
        assert_eq!(parse_preset("cheap"), Some("budget"));
        assert_eq!(parse_preset("pick"), Some("recommended"));
        assert_eq!(parse_preset("OOP pick"), Some("recommended"));
        assert_eq!(parse_preset(""), None);
        assert_eq!(parse_preset("nope"), None);
        assert_eq!(parse_role("Expert"), Some(1));
        assert_eq!(parse_role("boss"), None);
        assert_eq!(preset_words(), "recommended|speed|quality|budget");
    }

    #[test]
    fn a_change_in_a_thread_lands_in_its_override_and_keeps_the_rest() {
        let settings = json!({"enabled": false, "preset": "recommended",
            "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5"}},
            "threads": {"other": {"enabled": true, "pinned": {}},
                        "t1": {"preset": "speed", "pinned": {"expert": {"instanceId": "claude", "model": "claude-opus-5-5"}}}}});
        let next = apply_change(
            &settings,
            Some("t1"),
            &Change {
                enabled: Some(true),
                pins: vec![
                    ("worker", None),
                    (
                        "auditor",
                        Some(json!({"instanceId": "codex", "model": "gpt-5"})),
                    ),
                ],
                ..Default::default()
            },
        );
        assert_eq!(next["enabled"], false, "the defaults are not touched");
        assert_eq!(next["pinned"], settings["pinned"]);
        assert_eq!(next["threads"]["other"], settings["threads"]["other"]);
        let entry = &next["threads"]["t1"];
        assert_eq!(entry["enabled"], true);
        assert_eq!(
            entry["preset"], "speed",
            "the override keeps its own preset"
        );
        assert_eq!(
            entry["pinned"]["worker"],
            Value::Null,
            "a null pin means Auto over the defaults' pin"
        );
        assert_eq!(entry["pinned"]["expert"]["model"], "claude-opus-5-5");
        assert_eq!(entry["pinned"]["auditor"]["model"], "gpt-5");
    }

    #[test]
    fn a_change_without_a_thread_changes_the_defaults() {
        let settings = json!({"enabled": false, "preset": "recommended",
            "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5"}}, "threads": {"t1": {"enabled": true}}});
        let next = apply_change(
            &settings,
            None,
            &Change {
                preset: Some("quality".into()),
                pins: vec![
                    ("worker", None),
                    (
                        "expert",
                        Some(json!({"instanceId": "claude", "model": "m"})),
                    ),
                ],
                ..Default::default()
            },
        );
        assert_eq!(next["preset"], "quality");
        assert_eq!(next["enabled"], false);
        assert!(
            next["pinned"].get("worker").is_none(),
            "Auto removes the pin"
        );
        assert_eq!(next["pinned"]["expert"]["model"], "m");
        assert_eq!(next["threads"], settings["threads"]);
    }

    #[test]
    fn make_default_copies_what_the_thread_runs_with_and_only_hand_picked_models() {
        let config = json!({"settings": {"crew": {"enabled": false, "preset": "recommended", "pinned": {},
            "threads": {"t1": {"enabled": true, "preset": "quality",
                "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}}}}}}, "providers": providers()});
        let resolved = crew::resolve(&config, Some("t1"), Some(("claude", "claude-sonnet-5-5")));
        let next = as_default(&config["settings"]["crew"], &resolved);
        assert_eq!(next["enabled"], true);
        assert_eq!(next["preset"], "quality");
        assert_eq!(
            next["pinned"],
            json!({"worker": {"instanceId": "codex", "model": "gpt-5-mini"}})
        );
        assert_eq!(
            next["threads"], config["settings"]["crew"]["threads"],
            "overrides stay"
        );
    }

    #[test]
    fn the_model_list_puts_auto_first_and_ranks_the_models_that_match() {
        let app = app_with(json!({"enabled": true}));
        let ctx = context(&app, 0);
        let all = pick_items(&ctx, 0, "");
        assert!(matches!(all[0], PickItem::Auto { .. }));
        assert_eq!(all.len(), 1 + 6);
        assert!(
            all[0].note().starts_with("Recommended: "),
            "{}",
            all[0].note()
        );
        let hits = pick_items(&ctx, 0, "mini");
        assert_eq!(
            hits.len(),
            1,
            "Auto is ruled out by the words, one model fits: {hits:?}"
        );
        assert_eq!(hits[0].label(), "Codex / GPT-5 mini");
        let by_provider = pick_items(&ctx, 0, "claude opus");
        assert_eq!(
            by_provider[0].label(),
            "Claude / Opus 5.5",
            "every word must match, in any field"
        );
        assert!(pick_items(&ctx, 0, "zzzz").is_empty());
        assert!(matches!(
            pick_items(&ctx, 0, "auto")[0],
            PickItem::Auto { .. }
        ));
        assert!(all.iter().any(|i| i.note().contains("default")));
    }

    #[test]
    fn the_status_of_the_thread_model_explains_why_the_crew_cannot_start() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, vec![], false);
        assert!(context(&app, 0).problem.is_none());
        app.conv.thread.model_selection = json!({"instanceId": "grok", "model": "grok-4"});
        let problem = context(&app, 0).problem.expect("grok cannot lead");
        assert!(problem.contains("Grok"), "{problem}");
        app.conv.thread.model_selection = json!({"instanceId": "gone", "model": "x"});
        assert_eq!(
            context(&app, 0).problem.as_deref(),
            Some(text("providers.crew.unknownModel"))
        );
    }

    fn pressed(shown: &View, ctx: &Context, code: KeyEvent) -> KeyResult {
        crew_key(shown, ctx, code)
    }

    #[test]
    fn the_main_screen_lists_settings_then_tasks_and_keys_move_the_pointer() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(
            &mut app,
            vec![
                scenes::crew(
                    "task.started",
                    6,
                    "w1",
                    "worker",
                    json!({"title": "fix it"}),
                ),
                scenes::crew(
                    "task.completed",
                    20,
                    "w1",
                    "worker",
                    json!({"status": "completed"}),
                ),
            ],
            false,
        );
        let ctx = context(&app, scenes::ms(100));
        let rows = main_rows(&ctx);
        assert_eq!(
            rows,
            [
                Row::Toggle,
                Row::Preset,
                Row::Role(0),
                Row::Role(1),
                Row::Role(2),
                Row::Default,
                Row::Task(0)
            ],
            "no Auto-all row while nothing is pinned; a thread has the make-default row"
        );
        let view = open_view(&ctx);
        assert_eq!(view.selected(), 0);
        let down = pressed(&view, &ctx, key(KeyCode::Down));
        assert_eq!(down.view.unwrap().selected(), 1);
        let digit = pressed(&view, &ctx, letter('7'));
        assert_eq!(digit.view.unwrap().selected(), 6);
        let beyond = pressed(&view, &ctx, letter('9'));
        assert_eq!(
            beyond.view.unwrap().selected(),
            0,
            "a digit past the last row does nothing"
        );
        assert!(
            pressed(&view, &ctx, key(KeyCode::Esc)).view.is_none(),
            "Esc closes the main screen"
        );
        assert!(pressed(&view, &ctx, letter('q')).view.is_none());
        let up = pressed(&view, &ctx, key(KeyCode::Up));
        assert_eq!(
            up.view.unwrap().selected(),
            0,
            "the pointer stays inside the list"
        );
    }

    #[test]
    fn enter_on_a_setting_asks_for_its_change_and_on_a_list_opens_it() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, vec![], false);
        let ctx = context(&app, 0);
        let at = |row: Row| {
            let selected = main_rows(&ctx).iter().position(|r| *r == row).unwrap();
            main_view_at(&ctx, selected)
        };
        assert_eq!(
            pressed(&at(Row::Toggle), &ctx, key(KeyCode::Enter)).effect,
            Effect::Toggle
        );
        assert_eq!(
            pressed(&at(Row::Default), &ctx, key(KeyCode::Enter)).effect,
            Effect::Default
        );
        let preset = pressed(&at(Row::Preset), &ctx, key(KeyCode::Enter))
            .view
            .unwrap();
        assert_eq!(preset, View::Preset { selected: 0 });
        let chosen = pressed(&View::Preset { selected: 2 }, &ctx, key(KeyCode::Enter));
        assert_eq!(chosen.effect, Effect::Preset("quality"));
        assert!(
            matches!(chosen.view, Some(View::Main { .. })),
            "back to the main screen"
        );
        let model = pressed(&at(Row::Role(1)), &ctx, key(KeyCode::Enter))
            .view
            .unwrap();
        assert_eq!(
            model,
            View::Model {
                role: 1,
                selected: 0,
                query: String::new()
            },
            "Auto is the current choice"
        );
    }

    #[test]
    fn the_model_list_filters_as_letters_are_typed_and_esc_clears_before_it_goes_back() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, vec![], false);
        let ctx = context(&app, 0);
        let mut view = View::Model {
            role: 0,
            selected: 0,
            query: String::new(),
        };
        for ch in "mini".chars() {
            view = pressed(&view, &ctx, letter(ch)).view.unwrap();
        }
        assert_eq!(
            view,
            View::Model {
                role: 0,
                selected: 0,
                query: "mini".into()
            },
            "'q' and digits are letters here too"
        );
        let pick = pressed(&view, &ctx, key(KeyCode::Enter));
        match pick.effect {
            Effect::Pin {
                role: 0,
                pick: PickItem::Model { option, .. },
            } => assert_eq!(option.model, "gpt-5-mini"),
            other => panic!("{other:?}"),
        }
        let backspace = pressed(&view, &ctx, key(KeyCode::Backspace)).view.unwrap();
        assert!(matches!(&backspace, View::Model { query, .. } if query == "min"));
        let cleared = pressed(&view, &ctx, key(KeyCode::Esc)).view.unwrap();
        assert!(matches!(&cleared, View::Model { query, .. } if query.is_empty()));
        assert!(matches!(
            pressed(&cleared, &ctx, key(KeyCode::Esc)).view,
            Some(View::Main { .. })
        ));
        // no match: Enter says so and stays
        let none = View::Model {
            role: 0,
            selected: 0,
            query: "zzzz".into(),
        };
        let result = pressed(&none, &ctx, key(KeyCode::Enter));
        assert_eq!(result.effect, Effect::None);
        assert_eq!(
            result.notice.as_deref(),
            Some(text("providers.crewScreen.noMatch"))
        );
        let ctrl_u = KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL);
        assert!(
            matches!(&pressed(&view, &ctx, ctrl_u).view, Some(View::Model { query, .. }) if query.is_empty())
        );
        assert_eq!(
            append_to_search("a ", "  b"),
            "a b",
            "doubled spaces and leading space go"
        );
        assert_eq!(append_to_search("", " "), "");
    }

    fn running_board() -> Vec<Value> {
        vec![
            scenes::crew(
                "task.started",
                6,
                "w1",
                "worker",
                json!({"title": "fix the parser"}),
            ),
            scenes::crew(
                "task.started",
                7,
                "e1",
                "expert",
                json!({"title": "hard part"}),
            ),
            scenes::crew(
                "task.completed",
                30,
                "e1",
                "expert",
                json!({"status": "failed"}),
            ),
        ]
    }

    #[test]
    fn a_task_offers_open_stop_and_retry_as_it_stands() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, running_board(), true);
        let ctx = context(&app, scenes::ms(40));
        let board = ctx.board.as_ref().expect("a board");
        let (running, failed) = (&board.tasks[0], &board.tasks[1]);
        assert_eq!(
            task_items(running, false),
            [TaskItem::Open, TaskItem::Stop, TaskItem::Back]
        );
        assert_eq!(
            task_items(failed, false),
            [TaskItem::Open, TaskItem::Retry, TaskItem::Back]
        );
        assert_eq!(
            task_items(failed, true),
            [TaskItem::Confirm, TaskItem::Cancel]
        );
        // an auditor is not retried, a task with no thread cannot be opened or stopped
        let mut auditor = failed.clone();
        auditor.role = "auditor".into();
        auditor.actions.retry = false;
        assert_eq!(
            task_items(&auditor, false),
            [TaskItem::Open, TaskItem::Back]
        );
        assert!(running.actions.stop && running.actions.open && !running.actions.retry);
        assert!(failed.actions.retry && !failed.actions.stop);
    }

    #[test]
    fn stopping_a_task_asks_first_and_then_names_the_task() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, running_board(), true);
        let ctx = context(&app, scenes::ms(40));
        let task_row = main_rows(&ctx)
            .iter()
            .position(|r| *r == Row::Task(0))
            .unwrap();
        let task = pressed(&main_view_at(&ctx, task_row), &ctx, key(KeyCode::Enter))
            .view
            .unwrap();
        assert_eq!(
            task,
            View::Task {
                task_id: "w1".into(),
                selected: 0,
                confirm_stop: false
            }
        );
        let ask = pressed(
            &View::Task {
                task_id: "w1".into(),
                selected: 1,
                confirm_stop: false,
            },
            &ctx,
            key(KeyCode::Enter),
        );
        assert_eq!(
            ask.effect,
            Effect::None,
            "nothing is stopped before it is confirmed"
        );
        let asked = ask.view.unwrap();
        assert_eq!(
            asked,
            View::Task {
                task_id: "w1".into(),
                selected: 1,
                confirm_stop: true
            },
            "the pointer starts on Cancel"
        );
        let cancel = pressed(&asked, &ctx, key(KeyCode::Enter));
        assert_eq!(cancel.effect, Effect::None);
        let confirm = pressed(
            &View::Task {
                task_id: "w1".into(),
                selected: 0,
                confirm_stop: true,
            },
            &ctx,
            key(KeyCode::Enter),
        );
        assert_eq!(
            confirm.effect,
            Effect::Stop(TaskRef {
                task_id: "w1".into(),
                role: "worker".into(),
                thread_id: Some("th-w1".into())
            })
        );
        let esc = pressed(&asked, &ctx, key(KeyCode::Esc)).view.unwrap();
        assert!(
            matches!(
                esc,
                View::Task {
                    confirm_stop: false,
                    ..
                }
            ),
            "Esc only leaves the question"
        );
        let retry = pressed(
            &View::Task {
                task_id: "e1".into(),
                selected: 1,
                confirm_stop: false,
            },
            &ctx,
            key(KeyCode::Enter),
        );
        assert!(
            matches!(retry.effect, Effect::Retry(TaskRef { ref task_id, .. }) if task_id == "e1")
        );
        let open = pressed(
            &View::Task {
                task_id: "e1".into(),
                selected: 0,
                confirm_stop: false,
            },
            &ctx,
            key(KeyCode::Enter),
        );
        assert_eq!(open.effect, Effect::Open("th-e1".into()));
        assert!(open.view.is_none(), "opening a thread closes the screen");
    }

    #[test]
    fn a_pointer_follows_its_row_when_rows_come_and_go() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, running_board(), true);
        let ctx = context(&app, scenes::ms(40));
        let on_task = main_view_at(
            &ctx,
            main_rows(&ctx)
                .iter()
                .position(|r| *r == Row::Role(1))
                .unwrap(),
        );
        // A model gets pinned: an "Auto for all" row appears above the roles' end; the pointer stays on the expert.
        app.config["settings"]["crew"]["pinned"] =
            json!({"worker": {"instanceId": "codex", "model": "gpt-5"}});
        let after = context(&app, scenes::ms(40));
        assert!(main_rows(&after).contains(&Row::AutoAll));
        let settled = settle(&on_task, &after);
        assert_eq!(
            row_id(&after, main_rows(&after)[settled.selected()]),
            "role:expert"
        );
    }

    #[test]
    fn a_crew_thread_that_waits_for_the_user_starts_the_pointer_and_is_listed_first() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, running_board(), true);
        app.shell
            .threads
            .push(scenes::shell("th-w1", "Crew Worker · fix the parser", true));
        app.shell.threads.push(scenes::shell(
            "th-old",
            "Crew Expert · an earlier thing",
            false,
        ));
        let ctx = context(&app, scenes::ms(40));
        assert_eq!(ctx.waiting.len(), 1);
        let rows = main_rows(&ctx);
        assert!(
            !rows.iter().any(|r| matches!(r, Row::Thread(_))),
            "it is on the board already: shown as a task row"
        );
        let view = open_view(&ctx);
        let task = ctx
            .board
            .as_ref()
            .unwrap()
            .tasks
            .iter()
            .position(|t| t.task_id == "w1")
            .unwrap();
        assert_eq!(
            rows[view.selected()],
            Row::Task(task),
            "the pointer starts on the request that waits"
        );
        // A waiting thread that is on no board is a row of its own, at the top.
        app.shell
            .threads
            .push(scenes::shell("th-x", "Crew Auditor · a review", true));
        let ctx = context(&app, scenes::ms(40));
        let rows = main_rows(&ctx);
        assert!(matches!(rows[0], Row::Thread(_)));
        let open = pressed(&open_view(&ctx), &ctx, key(KeyCode::Enter));
        assert_eq!(open.effect, Effect::Open("th-x".into()));
        assert_eq!(
            waiting_text(&ctx.waiting.iter().map(|w| w.kind).collect::<Vec<_>>()).as_deref(),
            Some("2 crew tasks are waiting for approval — /crew")
        );
    }

    fn rows_of(app: &App, w: u16, h: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal
            .draw(|f| app.screen.as_ref().unwrap().draw(f, f.area(), app))
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| {
                (0..w)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn the_screen_draws_the_settings_and_the_board() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, running_board(), true);
        run(&mut app, "");
        let rows = rows_of(&app, 100, 24).join("\n");
        for wanted in [
            "Crew  on",
            "this thread",
            "Preset  OOP pick",
            "Worker  Auto · Haiku 5.5",
            "Expert  Auto · Opus 5.5",
            "Auditor  Auto · Opus 5.5",
            "Use as new chat default",
            "Worker  In progress · fix the parser",
            "Expert  Failed · hard part",
        ] {
            assert!(rows.contains(wanted), "{wanted:?} in\n{rows}");
        }
        assert!(
            rows.contains("1  Crew") && rows.contains("This turn"),
            "{rows}"
        );
        assert_eq!(
            app.screen.as_ref().unwrap().hint(),
            text("providers.crewScreen.hintMain")
        );
    }

    #[test]
    fn the_task_screen_shows_the_detail_and_a_long_summary_is_cut() {
        let mut app = app_with(json!({"enabled": true}));
        let long = "word ".repeat(200);
        on_lead(
            &mut app,
            vec![
                scenes::crew(
                    "task.started",
                    6,
                    "w1",
                    "worker",
                    json!({"title": "fix the parser"}),
                ),
                scenes::crew(
                    "task.completed",
                    26,
                    "w1",
                    "worker",
                    json!({"status": "completed", "summary": long}),
                ),
            ],
            false,
        );
        app.screen = Some(Box::new(CrewScreen {
            view: View::Task {
                task_id: "w1".into(),
                selected: 0,
                confirm_stop: false,
            },
        }));
        let rows = rows_of(&app, 44, 30);
        let shown = rows.join("\n");
        for wanted in [
            "Worker task",
            "Task      fix the parser",
            "Status    Done",
            "Elapsed   20s",
            "Open sub-thread",
            "Back to board",
        ] {
            assert!(shown.contains(wanted), "{wanted:?} in\n{shown}");
        }
        assert!(shown.contains('…'), "the summary is cut: {shown}");
        assert!(!shown.contains("Retry"), "a finished task is not retried");
    }

    #[test]
    fn a_task_that_has_left_the_board_says_so() {
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, vec![], false);
        app.screen = Some(Box::new(CrewScreen {
            view: View::Task {
                task_id: "gone".into(),
                selected: 0,
                confirm_stop: false,
            },
        }));
        assert!(
            rows_of(&app, 80, 12)
                .join("\n")
                .contains(text("providers.crewScreen.taskGone"))
        );
    }

    fn notes(app: &App) -> String {
        app.notes
            .iter()
            .map(|n| match n {
                Note::Text { title, body, .. } => format!("{title} {}", body.join(" ")),
                Note::Rows { .. } => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn connected_on_lead() -> (fake::Fake, App, tokio::sync::mpsc::UnboundedReceiver<Msg>) {
        english();
        let fake = fake::start_with(json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}, "threads": {"other": {"enabled": true}}}}), providers()).await;
        let (mut app, rx) = fake::connected(&fake).await;
        on_lead(&mut app, vec![], false);
        (fake, app, rx)
    }

    fn stored(fake: &fake::Fake) -> Value {
        fake.settings.lock().unwrap()["crew"].clone()
    }

    #[tokio::test]
    async fn crew_on_writes_the_threads_override_and_says_so() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        run(&mut app, "on");
        fake::pump(&mut app, &mut rx, |a| !a.notes.is_empty()).await;
        let crew = stored(&fake);
        assert_eq!(crew["threads"]["lead"]["enabled"], true);
        assert_eq!(crew["enabled"], false, "the defaults stay off");
        assert_eq!(
            crew["threads"]["other"],
            json!({"enabled": true}),
            "another thread's override stays"
        );
        assert!(notes(&app).contains("Crew on"), "{}", notes(&app));
        let calls = fake.called(UPDATE_SETTINGS).len();
        run(&mut app, "on");
        assert!(
            app.notice.as_deref().is_some_and(|n| n.contains("already")),
            "{:?}",
            app.notice
        );
        assert_eq!(
            fake.called(UPDATE_SETTINGS).len(),
            calls,
            "nothing is sent for what already is"
        );
    }

    #[tokio::test]
    async fn crew_off_preset_and_default_go_to_the_server() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        run(&mut app, "preset fast");
        fake::pump(&mut app, &mut rx, |a| !a.notes.is_empty()).await;
        assert_eq!(stored(&fake)["threads"]["lead"]["preset"], "speed");
        assert!(notes(&app).contains("Crew preset Speed"), "{}", notes(&app));
        run(&mut app, "preset nope");
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains("recommended|speed|quality|budget")
        );
        // The crew on this thread, then "default": new threads get what this thread runs with.
        run(&mut app, "on");
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["crew"]["threads"]["lead"]["enabled"] == true
        })
        .await;
        run(&mut app, "default");
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["crew"]["enabled"] == true
        })
        .await;
        let crew = stored(&fake);
        assert_eq!(
            (crew["enabled"].clone(), crew["preset"].clone()),
            (json!(true), json!("speed"))
        );
        assert_eq!(
            crew["threads"]["lead"]["enabled"], true,
            "the override stays"
        );
        run(&mut app, "off");
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["crew"]["threads"]["lead"]["enabled"] == false
        })
        .await;
        assert_eq!(stored(&fake)["threads"]["lead"]["enabled"], false);
    }

    #[tokio::test]
    async fn crew_model_pins_a_model_or_puts_the_role_back_on_auto() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        run(&mut app, "model worker gpt-5 mini");
        fake::pump(&mut app, &mut rx, |a| !a.notes.is_empty()).await;
        assert_eq!(
            stored(&fake)["threads"]["lead"]["pinned"]["worker"],
            json!({"instanceId": "codex", "model": "gpt-5-mini"})
        );
        assert!(
            notes(&app).contains("Worker model Codex / GPT-5 mini"),
            "{}",
            notes(&app)
        );
        run(&mut app, "model worker auto");
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["crew"]["threads"]["lead"]["pinned"]["worker"].is_null()
        })
        .await;
        assert_eq!(
            stored(&fake)["threads"]["lead"]["pinned"]["worker"],
            Value::Null
        );
        // usage and unknown words
        run(&mut app, "model");
        assert_eq!(
            app.notice.as_deref(),
            Some(text("session.c.crewModelUsage"))
        );
        run(&mut app, "model boss");
        assert!(app.notice.as_deref().unwrap().contains("boss"));
        run(&mut app, "model worker zzzz");
        assert!(app.notice.as_deref().unwrap().contains("zzzz"));
        // several matches open the narrowed list
        assert!(app.screen.is_none());
        run(&mut app, "model expert claude");
        let screen = rows_of(&app, 100, 20).join("\n");
        assert!(
            screen.contains("Claude / Opus 5.5") && screen.contains("Claude / Haiku 5.5"),
            "{screen}"
        );
        assert!(!screen.contains("Codex /"), "{screen}");
        assert!(screen.contains("Search: claude"), "{screen}");
    }

    #[tokio::test]
    async fn on_a_conversation_not_started_the_crew_settings_are_the_defaults() {
        english();
        let fake = fake::start_with(json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}, "threads": {}}}), providers()).await;
        let (mut app, mut rx) = fake::connected(&fake).await;
        app.active = Active::Draft("p1".into());
        run(&mut app, "default");
        assert_eq!(
            app.notice.as_deref(),
            Some(text("session.c.crewDefaultAlready"))
        );
        run(&mut app, "preset budget");
        fake::pump(&mut app, &mut rx, |a| !a.notes.is_empty()).await;
        assert_eq!(stored(&fake)["preset"], "budget");
        assert_eq!(stored(&fake)["threads"], json!({}));
    }

    #[tokio::test]
    async fn a_failed_save_is_reported_and_nothing_is_recorded_as_done() {
        english();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        app.config = json!({"settings": {"crew": {"enabled": false}}, "providers": providers()});
        on_lead(&mut app, vec![], false);
        run(&mut app, "on");
        assert!(
            notes(&app).contains(crate::i18n::tr("notice.offline")),
            "{}",
            notes(&app)
        );
        assert!(!notes(&app).contains("Crew on"));
    }

    #[tokio::test]
    async fn a_settings_update_from_the_stream_refreshes_what_the_crew_line_reads() {
        english();
        let fake = fake::start_with(json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}, "threads": {}}}), providers()).await;
        let (mut app, mut rx) = fake::connected(&fake).await;
        on_lead(&mut app, vec![], false);
        let line = |app: &App| {
            let model = app.current_model();
            crew::roles_of(&app.config, Some("lead"), brain_of(&model), true)
        };
        // The stream's snapshot arrives first; the crew is off.
        fake::pump(&mut app, &mut rx, |a| {
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .any(|(t, _)| t == "subscribeServerConfig")
                && a.config["providers"].is_array()
        })
        .await;
        assert!(line(&app).is_none());
        // Another client turns the crew on and pins the worker: the server announces it.
        let now = json!({"crew": {"enabled": true, "preset": "recommended", "threads": {},
            "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}}}});
        *fake.settings.lock().unwrap() = now.clone();
        fake.events
            .send(json!({"type": "settingsUpdated", "payload": {"settings": now}}))
            .unwrap();
        fake::pump(&mut app, &mut rx, |a| line(a).is_some()).await;
        let roles = line(&app).expect("the crew line has input now");
        assert_eq!(roles[0].model.as_deref(), Some("GPT-5 mini"));
        assert_eq!(roles[1].model.as_deref(), Some("Opus 5.5"));
    }

    #[tokio::test]
    async fn my_own_change_shows_at_once_without_waiting_for_the_stream() {
        let (_fake, mut app, mut rx) = connected_on_lead().await;
        run(&mut app, "on");
        // Only the answer to the patch is handled; the stream's own announcement may come later.
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["crew"]["threads"]["lead"]["enabled"] == true
        })
        .await;
        let model = app.current_model();
        assert!(crew::roles_of(&app.config, Some("lead"), brain_of(&model), true).is_some());
    }

    #[tokio::test]
    async fn in_a_crew_task_thread_only_back_works_and_it_returns_to_the_lead() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        app.shell
            .threads
            .push(scenes::shell("th-w1", "Crew Worker · fix", false));
        app.active = Active::Thread("th-w1".into());
        assert!(crew_sub(&app).is_some());
        run(&mut app, "on");
        assert_eq!(app.notice.as_deref(), Some(text("session.c.crewBackOnly")));
        assert!(fake.called(UPDATE_SETTINGS).is_empty());
        run(&mut app, "back");
        assert_eq!(
            app.active,
            Active::Thread("lead".into()),
            "the lead is open again"
        );
        // The note that belongs to a task thread is not shown on the lead.
        assert!(!notes(&app).contains(text("session.c.crewTaskThread")));
        // /crew back on a lead says what it is for.
        run(&mut app, "back");
        assert_eq!(
            app.notice.as_deref(),
            Some(text("session.c.crewBackOnlyInTask"))
        );
        // A task thread whose lead is not known cannot go back.
        app.shell.threads.push(
            serde_json::from_value::<ThreadShell>(
                json!({"id": "orphan", "projectId": "p1", "title": "Crew Expert · x"}),
            )
            .unwrap(),
        );
        app.active = Active::Thread("orphan".into());
        run(&mut app, "");
        assert_eq!(app.notice.as_deref(), Some(text("session.c.leadUnknown")));
        let _ = &mut rx;
    }

    #[tokio::test]
    async fn opening_a_crew_thread_says_what_it_is_and_an_unknown_thread_is_refused() {
        let (_fake, mut app, _rx) = connected_on_lead().await;
        app.shell
            .threads
            .push(scenes::shell("th-w1", "Crew Worker · fix", false));
        open_thread(&mut app, "th-w1");
        assert_eq!(app.active, Active::Thread("th-w1".into()));
        assert!(
            notes(&app).contains(text("session.c.crewTaskThread")),
            "{}",
            notes(&app)
        );
        open_thread(&mut app, "nowhere");
        assert_eq!(
            app.notice.as_deref(),
            Some(text("session.c.threadNotFound"))
        );
        assert_eq!(app.active, Active::Thread("th-w1".into()));
    }

    #[tokio::test]
    async fn retry_asks_the_server_to_run_the_task_again_and_stop_interrupts_its_thread() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        on_lead(&mut app, running_board(), true);
        let task = |id: &str, role: &str| TaskRef {
            task_id: id.into(),
            role: role.into(),
            thread_id: Some(format!("th-{id}")),
        };
        retry_task(&mut app, &task("e1", "expert"));
        fake::pump(&mut app, &mut rx, |a| {
            notes(a).contains("Restarted the Expert task")
        })
        .await;
        assert_eq!(
            fake.called(RETRY_RPC),
            [json!({"leadThreadId": "lead", "taskId": "e1"})]
        );
        stop_task(&mut app, &task("w1", "worker"));
        assert!(
            notes(&app).contains("Requested to stop the Worker task"),
            "{}",
            notes(&app)
        );
        assert_eq!(
            app.log
                .last()
                .map(|c| (c["type"].clone(), c["threadId"].clone())),
            Some((json!("thread.turn.interrupt"), json!("th-w1")))
        );
    }

    #[tokio::test]
    async fn a_screen_key_carries_out_what_it_asks_and_closes_when_it_leaves() {
        let (fake, mut app, mut rx) = connected_on_lead().await;
        run(&mut app, "");
        let mut screen = app.screen.take().unwrap();
        assert!(
            !screen.key(key(KeyCode::Enter), &mut app),
            "the toggle keeps the screen open"
        );
        fake::pump(&mut app, &mut rx, |a| !a.notes.is_empty()).await;
        assert_eq!(stored(&fake)["threads"]["lead"]["enabled"], true);
        assert!(
            screen.key(key(KeyCode::Esc), &mut app),
            "Esc on the main screen closes it"
        );
    }
}
