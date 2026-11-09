//! `/crew`: turn the crew on or off for a thread, choose its preset and the model of each role,
//! list the fallback models each role takes when its own fails, make a thread's settings the
//! default, and follow the crew's tasks: the settings arithmetic, the model list, and the screen
//! (main, preset, model, fallback and task views).
//!
//! The default crew lives in the server's settings (`crew`); a thread's own crew lives with the
//! thread on the server (`thread.crew.set`). A change in a thread gives that thread its own crew and
//! touches nothing else; on a conversation not started yet it is kept in the draft and goes out
//! with the first message. Only "make default" writes the settings, over the settings read just
//! now (see `server_settings`). "Use the default crew" takes the thread's own crew away.

use crate::app::{Active, App, Msg};
use crate::commands::{self, Ctx};
use crate::crew::{self, Brain, ModelOption, ROLES, Resolved};
use crate::crew_text::{text, text_with};
use crate::flow::{
    CrewBoard, CrewNoteKind, CrewPhase, CrewTask, Waiting, crew_board, is_crew_sub_thread,
    waiting_crew,
};
use crate::i18n::{Lang, lang, tr};
use crate::notes::Tone;
use crate::panels_common::{
    evidence_word, flat, format_cost, format_elapsed, phase_word, proof_word, tokens_word,
};
use crate::screen::Screen;
use crate::server_settings::{self, Patched};
use crate::text::{sanitize, truncate, width, wrap};
use crate::thread::Activity;
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

pub const RETRY_RPC: &str = "crew.retryTask";
pub const STOP_RPC: &str = "crew.stopTasks";

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
    /// The fallback lists as stored (the thread's over the default's), which an edit rewrites.
    listed: [Vec<Value>; 3],
    /// The thread has a crew of its own, rather than running the default.
    own: bool,
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
        listed,
        own,
    } = crew::resolve(&app.config, app.own_crew(), brain);
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
        listed,
        problem: brain_problem(&app.config, brain),
        own,
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
        json!({"enabled": false, "preset": "recommended", "pinned": {}, "fallbacks": {}})
    }
}

/// What a command or a key asks to change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Change {
    pub enabled: Option<bool>,
    pub preset: Option<String>,
    /// A model pins the role; `None` puts it back on Auto.
    pub pins: Vec<(&'static str, Option<Value>)>,
    /// The role's complete fallback list, in order; an empty list clears it.
    pub fallbacks: Vec<(&'static str, Vec<Value>)>,
}

/// A thread's next crew after `change`, stored as the thread's complete crew (`applyCrewChange`).
/// A null pin is kept: it means Auto even when the default pins the role. Everything the change
/// does not name stays as it was, so editing one role never moves the others.
pub fn apply_change(current: Option<&Value>, change: &Change) -> Value {
    let mut entry = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(enabled) = change.enabled {
        entry.insert("enabled".into(), json!(enabled));
    }
    if let Some(preset) = &change.preset {
        entry.insert("preset".into(), json!(preset));
    }
    let mut pinned = entry
        .get("pinned")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (role, selection) in &change.pins {
        pinned.insert((*role).into(), selection.clone().unwrap_or(Value::Null));
    }
    entry.insert("pinned".into(), Value::Object(pinned));
    if !change.fallbacks.is_empty() {
        let mut listed = entry
            .get("fallbacks")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (role, list) in &change.fallbacks {
            listed.insert((*role).into(), json!(list));
        }
        entry.insert("fallbacks".into(), Value::Object(listed));
    }
    Value::Object(entry)
}

/// "Use this crew for new chats": what the thread runs with (on or off, preset, the roles pinned
/// by hand, and each role's fallback list) becomes the default. It is the only way the default is
/// edited, and no thread's own crew changes with it (`crewAsDefault`).
pub fn as_default(settings: &Value, crew: &Resolved) -> Value {
    let mut pinned = Map::new();
    let mut listed = Map::new();
    for (slot, role) in ROLES.iter().enumerate() {
        if let (true, Some(option)) = (crew.pinned[slot], &crew.roles[slot]) {
            pinned.insert(
                (*role).into(),
                json!({"instanceId": option.instance_id, "model": option.model}),
            );
        }
        // The list as stored, so a model whose provider is away for now is not dropped.
        let fallbacks = &crew.listed[slot];
        if !fallbacks.is_empty() {
            listed.insert((*role).into(), json!(fallbacks));
        }
    }
    let mut next = settings.clone();
    next["enabled"] = json!(crew.enabled);
    next["preset"] = json!(crew.preset);
    next["pinned"] = Value::Object(pinned);
    next["fallbacks"] = Value::Object(listed);
    next
}

enum Save {
    Change(Change),
    /// Make what the thread runs with the default for new threads.
    Default,
    /// Take the thread's own crew away, so it runs the default crew again.
    Reset,
}

/// Gives the thread on screen its own crew (`None`: takes it away), then says what was done. On a
/// draft the crew is kept until the first message creates the thread.
fn set_own(app: &mut App, next: Option<Value>, label: String, value: String) {
    match app.active.clone() {
        Active::Thread(id) => {
            let command = commands::crew_set(&Ctx::fresh(), &id, next.as_ref());
            app.dispatch(command, None, None);
            if app.rpc.is_none() {
                return;
            }
        }
        Active::Draft(_) => app.draft_crew = next,
        Active::None => return,
    }
    app.note(Tone::Done, &label, vec![value]);
}

/// Carries out a crew change: in the thread's own crew, or (`Save::Default`) in the settings.
fn save(app: &mut App, change: Save, label: String, value: String) {
    match change {
        Save::Change(change) => {
            let next = apply_change(app.own_crew(), &change);
            set_own(app, Some(next), label, value);
        }
        Save::Reset => set_own(app, None, label, value),
        Save::Default => save_default(app, label, value),
    }
}

/// Makes what the thread runs with the default for new threads: the one write to the settings,
/// made over the settings read just now.
fn save_default(app: &mut App, label: String, value: String) {
    let own = app.own_crew().cloned();
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
            let config = json!({"settings": {"crew": crew}, "providers": providers});
            let brain = brain.as_ref().map(|(a, b)| (a.as_str(), b.as_str()));
            let next = as_default(&crew, &crew::resolve(&config, own.as_ref(), brain));
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

/// What the model list offers when it fills a fallback list: the models alone, for Auto is not
/// something a role can fall back to.
fn pick_for(ctx: &Context, role: usize, query: &str, for_fallback: bool) -> Vec<PickItem> {
    let items = pick_items(ctx, role, query);
    if for_fallback {
        items
            .into_iter()
            .filter(|item| !matches!(item, PickItem::Auto { .. }))
            .collect()
    } else {
        items
    }
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

/// A role's fallback models on one line: `A, B` in order, else `none`.
fn fallback_text(ctx: &Context, role: usize) -> String {
    if ctx.listed[role].is_empty() {
        return text("providers.crewScreen.fallbackNone").into();
    }
    ctx.listed[role]
        .iter()
        .map(|selection| match listed_option(ctx, selection) {
            Some(option) => option.label.clone(),
            None => selection["model"].as_str().unwrap_or("?").to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The model a stored fallback entry names, when this environment can run it now.
fn listed_option<'a>(ctx: &'a Context, selection: &Value) -> Option<&'a ModelOption> {
    ctx.options
        .iter()
        .find(|option| crew::same_selection(selection, option))
}

/// `Provider / Model` for a stored fallback entry; one that cannot run now shows its raw ids.
fn listed_label(ctx: &Context, selection: &Value) -> String {
    match listed_option(ctx, selection) {
        Some(option) => format!("{} / {}", option.provider_label, option.label),
        None => format!(
            "{} / {}",
            selection["instanceId"].as_str().unwrap_or("?"),
            selection["model"].as_str().unwrap_or("?")
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
        task.proof.map(|proof| proof_word(proof).to_string()),
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
    if let Some(proof) = task.proof {
        rows.push((
            text("render.crew.field.proof").to_string(),
            proof_word(proof).to_string(),
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
        CrewNoteKind::ResultsDropped => text_with(
            "render.crew.resultsDropped",
            &[("count", detail.as_u64().unwrap_or(0).to_string())],
        ),
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
    /// The role's fallback list, reached from its own row.
    Fallbacks(usize),
    AutoAll,
    Default,
    Reset,
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
    for role in 0..ROLES.len() {
        rows.push(Row::Role(role));
        rows.push(Row::Fallbacks(role));
    }
    if ctx.pinned.iter().any(|p| *p) {
        rows.push(Row::AutoAll);
    }
    if ctx.own {
        rows.extend([Row::Default, Row::Reset]);
    }
    rows.extend((0..tasks.len()).map(Row::Task));
    rows
}

fn row_id(ctx: &Context, row: Row) -> String {
    match row {
        Row::Role(role) => format!("role:{}", ROLES[role]),
        Row::Fallbacks(role) => format!("fallback:{}", ROLES[role]),
        Row::Task(i) => format!(
            "task:{}",
            ctx.board.as_ref().map_or("", |b| &b.tasks[i].task_id)
        ),
        Row::Thread(i) => format!("thread:{}", ctx.waiting[i].id),
        Row::Toggle => "toggle".into(),
        Row::Preset => "preset".into(),
        Row::AutoAll => "autoAll".into(),
        Row::Default => "default".into(),
        Row::Reset => "reset".into(),
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
        /// Picking a model to add to the role's fallback list, rather than to pin the role.
        for_fallback: bool,
    },
    /// A role's fallback list: Enter on an entry takes it out, the last item opens the picker.
    Fallback {
        role: usize,
        selected: usize,
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
            | View::Fallback { selected, .. }
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
fn model_view(ctx: &Context, role: usize, query: &str, for_fallback: bool) -> View {
    let items = pick_for(ctx, role, query, for_fallback);
    let current = if for_fallback {
        None
    } else {
        items.iter().position(|item| is_current(item, ctx, role))
    };
    View::Model {
        role,
        selected: current.unwrap_or(0),
        query: query.to_string(),
        for_fallback,
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
        View::Model {
            role,
            query,
            for_fallback,
            ..
        } => pick_for(ctx, *role, query, *for_fallback).len(),
        // The role's entries, and the item that opens the picker.
        View::Fallback { role, .. } => ctx.listed[*role].len() + 1,
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
    Pin {
        role: usize,
        pick: PickItem,
    },
    /// Appends the model to the role's fallback list.
    AddFallback {
        role: usize,
        option: ModelOption,
    },
    /// Takes the stored entry out of the role's fallback list, runnable now or not.
    RemoveFallback {
        role: usize,
        selection: Value,
    },
    AutoAll,
    Default,
    Reset,
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
        View::Model {
            role,
            query,
            for_fallback,
            ..
        } => View::Model {
            role: *role,
            selected,
            query: query.clone(),
            for_fallback: *for_fallback,
        },
        View::Fallback { role, .. } => View::Fallback {
            role: *role,
            selected,
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
            View::Model {
                role, for_fallback, ..
            } => stay(Some(match for_fallback {
                // The picker goes back to the list it fills, a pin to the settings row.
                true => View::Fallback {
                    role: *role,
                    selected: 0,
                },
                false => main_view_at(ctx, row_index(ctx, |row| *row == Row::Role(*role))),
            })),
            View::Fallback { role, .. } => stay(Some(main_view_at(
                ctx,
                row_index(ctx, |row| *row == Row::Fallbacks(*role)),
            ))),
        }
    };

    if let View::Model {
        role,
        selected: _,
        query,
        ..
    } = &view
    {
        let for_fallback = matches!(
            &view,
            View::Model {
                for_fallback: true,
                ..
            }
        );
        let edit = |query: String| {
            stay(Some(View::Model {
                role: *role,
                selected: 0,
                query,
                for_fallback,
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
            View::Model {
                role,
                query,
                for_fallback,
                ..
            } if !query.is_empty() => stay(Some(View::Model {
                role: *role,
                selected: 0,
                query: String::new(),
                for_fallback: *for_fallback,
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
            for_fallback,
        } => {
            let Some(pick) = pick_for(ctx, *role, query, *for_fallback)
                .get(*selected)
                .cloned()
            else {
                return KeyResult {
                    view: Some(view.clone()),
                    effect: Effect::None,
                    notice: Some(text("providers.crewScreen.noMatch").into()),
                };
            };
            if *for_fallback {
                // A model goes onto the list; the pointer waits on it for the next key.
                let PickItem::Model { option, .. } = pick else {
                    return stay(Some(view.clone()));
                };
                return with_effect(
                    Some(View::Fallback {
                        role: *role,
                        selected: ctx.listed[*role].len(),
                    }),
                    Effect::AddFallback {
                        role: *role,
                        option,
                    },
                );
            }
            with_effect(
                Some(main_view_at(
                    ctx,
                    row_index(ctx, |row| *row == Row::Role(*role)),
                )),
                Effect::Pin { role: *role, pick },
            )
        }
        View::Fallback { role, selected } => {
            let entries = &ctx.listed[*role];
            if *selected >= entries.len() {
                return stay(Some(View::Model {
                    role: *role,
                    selected: 0,
                    query: String::new(),
                    for_fallback: true,
                }));
            }
            with_effect(
                Some(View::Fallback {
                    role: *role,
                    selected: *selected,
                }),
                Effect::RemoveFallback {
                    role: *role,
                    selection: entries[*selected].clone(),
                },
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
                Row::Reset => with_effect(Some(view.clone()), Effect::Reset),
                Row::Preset => stay(Some(View::Preset {
                    selected: PRESETS
                        .iter()
                        .position(|p| p.value == ctx.preset)
                        .unwrap_or(0),
                })),
                Row::Role(role) => stay(Some(model_view(ctx, role, "", false))),
                Row::Fallbacks(role) => stay(Some(View::Fallback { role, selected: 0 })),
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
        Effect::AddFallback { role, option } => {
            let mut list = ctx.listed[role].clone();
            if list
                .iter()
                .any(|selection| crew::same_selection(selection, &option))
            {
                app.notice = Some(text("providers.crewScreen.alreadyListed").into());
                return;
            }
            if list.len() >= crew::CREW_FALLBACK_LIMIT {
                app.notice = Some(text_with(
                    "providers.crewScreen.fallbackFull",
                    &[("max", crew::CREW_FALLBACK_LIMIT.to_string())],
                ));
                return;
            }
            let label = format!("{} / {}", option.provider_label, option.label);
            list.push(selection_of(&option));
            save(
                app,
                Save::Change(Change {
                    fallbacks: vec![(ROLES[role], list)],
                    ..Default::default()
                }),
                text_with(
                    "session.c.roleFallbacks",
                    &[("role", role_name(ROLES[role]))],
                ),
                label,
            );
        }
        Effect::RemoveFallback { role, selection } => {
            let Some(at) = ctx.listed[role]
                .iter()
                .position(|entry| *entry == selection)
            else {
                return;
            };
            let label = listed_label(ctx, &selection);
            let mut list = ctx.listed[role].clone();
            list.remove(at);
            save(
                app,
                Save::Change(Change {
                    fallbacks: vec![(ROLES[role], list)],
                    ..Default::default()
                }),
                text_with(
                    "session.c.roleFallbacks",
                    &[("role", role_name(ROLES[role]))],
                ),
                label,
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
        Effect::Reset => save(
            app,
            Save::Reset,
            text("session.c.crewReset").into(),
            text("session.c.crewResetNote").into(),
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

static STOPPING: AtomicBool = AtomicBool::new(false);

/// How many tasks the server says `crew.stopTasks` stopped.
fn stopped_count(result: &Value) -> usize {
    result["stopped"].as_array().map_or(0, Vec::len)
}

/// How many tasks were interrupted but had not ended when the server stopped waiting for them.
fn stopping_count(result: &Value) -> usize {
    result["stopping"].as_array().map_or(0, Vec::len)
}

/// `/crew stop [id|all]`: the server stops the lead's running crew tasks, one by id or all of them.
fn stop_tasks(app: &mut App, task_id: Option<String>) {
    let (Some(rpc), Active::Thread(lead)) = (app.rpc.clone(), app.active.clone()) else {
        return offline(app);
    };
    // An older server has no crew.stopTasks; the /crew screen still interrupts a task's thread.
    if app.config["environment"]["capabilities"]["crew"]["stopTasks"] != true {
        return app.say(Tone::Error, text("session.c.crewStopUnsupported"));
    }
    if STOPPING.swap(true, Ordering::SeqCst) {
        return;
    }
    let tx = app.sender();
    tokio::spawn(async move {
        let mut payload = json!({"leadThreadId": lead});
        if let Some(task_id) = task_id {
            payload["taskId"] = json!(task_id);
        }
        let outcome = rpc.call(STOP_RPC, payload).await;
        STOPPING.store(false, Ordering::SeqCst);
        let _ = tx.send(Msg::Ext(Box::new(move |app| match outcome {
            Ok(result) => {
                let (stopped, stopping) = (stopped_count(&result), stopping_count(&result));
                let line = if stopping > 0 {
                    text_with("session.c.crewStopping", &[("count", stopping.to_string())])
                } else if stopped == 0 {
                    text("session.c.crewStopNone").to_string()
                } else {
                    text_with("session.c.crewStopped", &[("count", stopped.to_string())])
                };
                app.note(Tone::Done, "Crew", vec![line]);
            }
            Err(detail) => {
                let line = format!(
                    "{}: {}",
                    text("session.c.crewStopFailed"),
                    sanitize(&detail).lines().next().unwrap_or_default()
                );
                app.say(Tone::Error, &line);
            }
        })));
    });
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
        "reset" => {
            if !ctx.own {
                app.notice = Some(text("session.c.crewDefaultAlready").into());
                return;
            }
            save(
                app,
                Save::Reset,
                text("session.c.crewReset").into(),
                text("session.c.crewResetNote").into(),
            );
        }
        "default" => {
            if !ctx.own {
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
        "stop" => stop_tasks(
            app,
            args.get(1)
                .filter(|target| !target.eq_ignore_ascii_case("all"))
                .map(|target| target.to_string()),
        ),
        "log" => show_log(app),
        "back" => back_to_lead(app),
        _ => {
            app.notice = Some(text_with(
                "session.c.crewUsage",
                &[("words", preset_words())],
            ))
        }
    }
}

// ---- /crew log -----------------------------------------------------------------------------------

/// Rows of the decision log `/crew log` writes into the conversation; the clipboard gets them all.
const LOG_ROWS: usize = 10;

/// The cell limit of the TSV, in characters.
const CELL_LIMIT: usize = 500;

/// One decision of the crew: who the lead handed what to, why, on what evidence, how it came out.
/// The same table as the TypeScript terminal and the desktop app derive from the lead's activities.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LogRow {
    ts: String,
    phase: String,
    decision: String,
    why: String,
    evidence: String,
    result: String,
}

fn payload_str(payload: &Value, key: &str) -> String {
    payload[key].as_str().unwrap_or("").trim().to_string()
}

fn join_words(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

fn log_row(activity: &Activity) -> Option<LogRow> {
    let payload = &activity.payload;
    let task_id = payload_str(payload, "taskId");
    // Provider-native tasks (the plan's own steps, Agent subagents) emit the same task kinds
    // without a role; they are not the crew's decisions.
    let crew_role = Some(payload_str(payload, "crewRole")).filter(|role| !role.is_empty());
    if activity.kind.starts_with("task.") && crew_role.is_none() {
        return None;
    }
    let role = crew_role.unwrap_or_else(|| "worker".to_string());
    let title = payload_str(payload, "title");
    let row = |phase: String, decision: String, why: String, evidence: String, result: &str| {
        Some(LogRow {
            ts: activity.created_at.clone(),
            phase,
            decision,
            why,
            evidence,
            result: result.to_string(),
        })
    };
    match activity.kind.as_str() {
        "task.started" => {
            let model = Some(payload_str(payload, "model"))
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| role.clone());
            let thread = payload_str(payload, "threadId");
            row(
                format!("delegate:{role}"),
                if title.is_empty() {
                    format!("handed to {model}")
                } else {
                    format!("handed to {model}: {title}")
                },
                payload_str(payload, "why"),
                join_words(&[
                    format!("task:{task_id}"),
                    if thread.is_empty() {
                        String::new()
                    } else {
                        format!("thread:{thread}")
                    },
                ]),
                "running",
            )
        }
        // Only a model switch is a decision; the checklist's progress row is not.
        "task.progress" if activity.summary.contains(" switched to ") => {
            let model = payload_str(payload, "model");
            row(
                "fallback".into(),
                format!(
                    "switched to {}",
                    if model.is_empty() {
                        "another model"
                    } else {
                        &model
                    }
                ),
                payload_str(payload, "summary"),
                format!("task:{task_id}"),
                "retrying",
            )
        }
        "task.completed" if role == "auditor" => {
            let verdict = Some(payload_str(payload, "verdict"))
                .filter(|verdict| !verdict.is_empty())
                .or_else(|| Some(payload_str(payload, "status")).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| "unknown".to_string());
            row(
                "audit".into(),
                format!("auditor {verdict}"),
                String::new(),
                format!("task:{task_id}"),
                &verdict,
            )
        }
        "task.completed" => {
            let status = payload_str(payload, "status");
            let outcome = match status.as_str() {
                "completed" => "finished",
                "partial" => "finished part",
                "blocked" => "blocked",
                "failed" => "failed",
                "stopped" | "interrupted" => "stopped",
                "" => "ended",
                other => other,
            };
            let total = payload["todoTotal"].as_u64().unwrap_or(0);
            let verified = payload["todoVerified"].as_u64().unwrap_or(0);
            // A missing verdict is an older server, which never proved anything.
            let result = match payload["proof"].as_str() {
                Some("verified") => "VERIFIED",
                Some("not-verified") => "NOT VERIFIED",
                Some("inconclusive") => "INCONCLUSIVE",
                _ => "UNKNOWN",
            };
            row(
                format!("result:{role}"),
                format!("{role} {outcome}"),
                String::new(),
                join_words(&[
                    format!("task:{task_id}"),
                    if total == 0 {
                        String::new()
                    } else {
                        format!("todos {verified}/{total}")
                    },
                ]),
                result,
            )
        }
        "crew.follow-up" => row(
            "follow-up".into(),
            "lead got a follow-up turn".into(),
            payload_str(payload, "reason"),
            String::new(),
            "queued",
        ),
        "crew.stopped" | "crew.stopping" => {
            let ids: Vec<&str> = payload["taskIds"]
                .as_array()
                .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let stopping = activity.kind == "crew.stopping";
            // A stop the user asked for carries only the server's `reason`.
            let why = Some(payload_str(payload, "why"))
                .filter(|why| !why.is_empty())
                .unwrap_or_else(|| payload_str(payload, "reason"));
            row(
                "stop".into(),
                format!(
                    "{} {} {}",
                    if stopping { "stopping" } else { "stopped" },
                    ids.len(),
                    if ids.len() == 1 { "task" } else { "tasks" }
                ),
                why,
                if ids.is_empty() {
                    String::new()
                } else {
                    format!("tasks:{}", ids.join(","))
                },
                if stopping { "stopping" } else { "stopped" },
            )
        }
        _ => None,
    }
}

/// The decision rows of the lead's crew activities, oldest first. Task activities without a crew
/// role are left out, as are the provider's own plan steps and Agent subagents; `crew.stopped` and
/// `crew.stopping` stay, because a stop is the lead's.
fn decision_log(activities: &[Activity]) -> Vec<LogRow> {
    let mut ordered: Vec<(usize, &Activity)> = activities.iter().enumerate().collect();
    ordered.sort_by(|(ia, a), (ib, b)| {
        a.created_at
            .cmp(&b.created_at)
            .then(a.sequence.unwrap_or(0).cmp(&b.sequence.unwrap_or(0)))
            .then(ia.cmp(ib))
    });
    ordered
        .into_iter()
        .filter_map(|(_, activity)| log_row(activity))
        .collect()
}

/// One TSV cell on one line: control characters and line breaks become spaces, and a cell a
/// spreadsheet would read as a formula (`=`, `+`, `-`, `@`) gets a leading `'`.
fn tsv_cell(value: &str) -> String {
    let spaced: String = value
        .chars()
        .map(|c| {
            if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let flat: String = spaced
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(CELL_LIMIT)
        .collect();
    if flat.starts_with(['=', '+', '-', '@']) {
        format!("'{flat}")
    } else {
        flat
    }
}

/// The log as TSV: a header line, then a line per row.
fn decision_log_tsv(rows: &[LogRow]) -> String {
    let mut lines = vec!["ts\tphase\tdecision\twhy\tevidence\tresult".to_string()];
    for row in rows {
        lines.push(
            [
                &row.ts,
                &row.phase,
                &row.decision,
                &row.why,
                &row.evidence,
                &row.result,
            ]
            .map(|cell| tsv_cell(cell))
            .join("\t"),
        );
    }
    lines.join("\n")
}

/// The newest `limit` rows as lines for the conversation: the UTC time, the phase, the decision and
/// its result, then the lead's reason. Server strings are cleaned for the terminal.
fn decision_log_lines(rows: &[LogRow], limit: usize) -> Vec<String> {
    let start = rows.len().saturating_sub(limit);
    rows[start..]
        .iter()
        .map(|row| {
            let why = flat(&row.why);
            format!(
                "{}Z {} · {} · {}{}",
                row.ts.get(11..19).unwrap_or(&row.ts),
                flat(&row.phase),
                flat(&row.decision),
                flat(&row.result),
                if why.is_empty() {
                    String::new()
                } else {
                    format!(" — {why}")
                }
            )
        })
        .collect()
}

/// `/crew log`: the newest decision rows go into the conversation and the whole log, as TSV, to the
/// clipboard. It is read from the lead's activities now, so it is a snapshot.
fn show_log(app: &mut App) {
    let loaded =
        matches!(&app.active, Active::Thread(id) if app.conv.loaded && app.conv.thread_id == *id);
    let rows = if loaded {
        decision_log(&app.conv.thread.activities)
    } else {
        Vec::new()
    };
    if rows.is_empty() {
        app.notice = Some(text("session.c.crewLogEmpty").into());
        return;
    }
    let lines = decision_log_lines(&rows, LOG_ROWS);
    let title = text_with(
        "session.c.crewLogTitle",
        &[
            ("shown", lines.len().to_string()),
            ("total", rows.len().to_string()),
        ],
    );
    app.note(Tone::Info, &title, lines);
    app.copy_text(decision_log_tsv(&rows));
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
            view: model_view(ctx, role, "", false),
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
                view: model_view(ctx, role, &query, false),
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
    let scope = text(if ctx.own {
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
            for_fallback,
        } => {
            let items = pick_for(ctx, *role, query, *for_fallback);
            Content {
                title: text_with(
                    if *for_fallback {
                        "providers.crewScreen.roleFallbacks"
                    } else {
                        "providers.crewScreen.roleModel"
                    },
                    &[("role", role_name(ROLES[*role]))],
                ),
                items: items
                    .iter()
                    .map(|item| {
                        let picked = match item {
                            PickItem::Model { option, .. } => {
                                if *for_fallback {
                                    ctx.listed[*role]
                                        .iter()
                                        .any(|s| crew::same_selection(s, option))
                                        .then(|| text("providers.crewScreen.alreadyListed"))
                                } else if is_current(item, ctx, *role) {
                                    Some(text("providers.screen.current"))
                                } else {
                                    None
                                }
                            }
                            PickItem::Auto { .. } => is_current(item, ctx, *role)
                                .then(|| text("providers.screen.current")),
                        };
                        Item {
                            label: item.label().into(),
                            note: [picked.unwrap_or_default(), item.note()]
                                .iter()
                                .filter(|part| !part.is_empty())
                                .copied()
                                .collect::<Vec<_>>()
                                .join(" · "),
                        }
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
            }
        }
        View::Fallback { role, selected } => {
            let mut items = ctx.listed[*role]
                .iter()
                .map(|selection| Item {
                    label: listed_label(ctx, selection),
                    note: text(if listed_option(ctx, selection).is_some() {
                        "providers.crewScreen.fallbackRemoveNote"
                    } else {
                        "providers.crewScreen.fallbackAwayNote"
                    })
                    .into(),
                })
                .collect::<Vec<_>>();
            items.push(Item {
                label: text("providers.crewScreen.fallbackAdd").into(),
                note: text("providers.crewScreen.fallbackAddNote").into(),
            });
            let mut before = Vec::new();
            if ctx.listed[*role].is_empty() {
                before.push(dim(text("providers.crewScreen.fallbackNoneYet")));
            }
            Content {
                title: text_with(
                    "providers.crewScreen.roleFallbacks",
                    &[("role", role_name(ROLES[*role]))],
                ),
                items,
                selected: *selected,
                empty: String::new(),
                before,
            }
        }
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
                    Row::Fallbacks(role) => Item {
                        label: format!(
                            "{}  {}",
                            text_with(
                                "session.c.roleFallbacks",
                                &[("role", role_name(ROLES[role]))]
                            ),
                            fallback_text(ctx, role)
                        ),
                        note: text("providers.crewScreen.fallbackNote").into(),
                    },
                    Row::AutoAll => Item {
                        label: text("providers.crewScreen.autoAll").into(),
                        note: text("providers.crewScreen.autoAllNote").into(),
                    },
                    Row::Default => Item {
                        label: text("providers.crewScreen.makeDefault").into(),
                        note: text("providers.crewScreen.makeDefaultNote").into(),
                    },
                    Row::Reset => Item {
                        label: text("providers.crewScreen.resetToDefault").into(),
                        note: text("providers.crewScreen.resetToDefaultNote").into(),
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
            View::Fallback { .. } => text("providers.crewScreen.hintFallback"),
            View::Task {
                confirm_stop: true, ..
            } => text("providers.crewScreen.hintConfirm"),
            View::Task { .. } => text("providers.crewScreen.hintTask"),
        }
        .to_string()
    }
}

#[cfg(test)]
#[path = "cmd_crew_tests.rs"]
mod tests;
