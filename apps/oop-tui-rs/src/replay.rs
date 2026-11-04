//! Replay Theater: a step-through view of the turn that just finished. The steps come from the
//! thread's own data (the prompt, what the agent said, every tool call with what it touched and what
//! it reported, the files the turn changed, the final answer) by a pure function, `steps`, so the
//! derivation is tested without a screen. The view takes over the conversation area, keeps the header
//! and the composer, and is local to this client: it adds nothing to the thread, to the transcript
//! the reader scrolls, or to what is sent to the provider.
//!
//! The button, `/replay` and Ctrl-R open it. A step opens with a short reveal (only with animations
//! on) and the clock only runs while it reveals or while autoplay is on; a paused view never repaints.

use crate::app::{Active, App, Geo};
use crate::diff_report;
use crate::markdown;
use crate::panels_common::s;
use crate::text::{parse_iso_ms, sanitize, truncate, width, wrap};
use crate::theme::{Symbols, Theme};
use crate::thread::{Activity, LatestTurn, Role, Thread};
use crate::transcript::{first_line, format_duration, result_summary, shell_command, tool_title};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::Value;
use std::cell::{Cell, RefCell};

/// Lines of one tool's output a step keeps; the rest is counted.
const OUTPUT_LINES: usize = 200;
/// Files named in a "touched" fact before the rest are counted.
const FILES_LISTED: usize = 8;
/// Clock ticks (250 ms each) a step takes to reveal, when animations are on.
const REVEAL_TICKS: usize = 3;
/// Clock ticks autoplay stays on one step: three seconds.
const AUTOPLAY_TICKS: usize = 12;
/// Lines a wheel notch or an arrow scrolls a long step.
const SCROLL_LINES: usize = 3;
const BUTTON: &str = "[Replay]";

// --- steps ----------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// What the user asked.
    Prompt,
    /// The model's reasoning text.
    Thinking,
    /// Assistant text before the final answer.
    Message,
    /// A tool call with what it ran, touched and reported.
    Tool,
    /// A plan the turn proposed.
    Plan,
    /// The files the turn changed (from the turn's checkpoint).
    Diff,
    /// A warning, an error or a context compaction.
    Notice,
    /// An activity this build has no view for: shown as one plain line, never skipped.
    Summary,
    /// The assistant's final message.
    Answer,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Prompt => s("Prompt", "프롬프트"),
            Kind::Thinking => s("Thinking", "생각"),
            Kind::Message => s("Assistant", "응답"),
            Kind::Tool => s("Tool", "도구"),
            Kind::Plan => s("Plan", "계획"),
            Kind::Diff => s("Changes", "변경"),
            Kind::Notice => s("Notice", "알림"),
            Kind::Summary => s("Activity", "활동"),
            Kind::Answer => s("Answer", "최종 답변"),
        }
    }

    fn color(self, th: &Theme) -> ratatui::style::Color {
        match self {
            Kind::Prompt => th.user_fg,
            Kind::Thinking => th.dim,
            Kind::Message | Kind::Plan => th.brand,
            Kind::Tool => th.tool,
            Kind::Diff => th.accent,
            Kind::Notice => th.warning,
            Kind::Summary => th.muted,
            Kind::Answer => th.success,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub kind: Kind,
    /// What the step is about, next to its type in the title: the tool's name, the file count.
    pub subject: String,
    /// `(label, value)` rows above the body: the command, what a tool touched, how long it took.
    pub facts: Vec<(&'static str, String)>,
    pub body: String,
    /// The body is markdown (the assistant's text, a plan); else it is plain text (tool output).
    pub markdown: bool,
}

fn step(kind: Kind, subject: &str, body: &str, markdown: bool) -> Step {
    Step {
        kind,
        subject: sanitize(subject).replace('\n', " "),
        facts: Vec::new(),
        body: sanitize(body).trim_end().to_string(),
        markdown,
    }
}

/// The turn the button and `/replay` are about: the thread's latest turn, once it is over.
pub fn finished_turn(thread: &Thread) -> Option<&LatestTurn> {
    thread
        .latest_turn
        .as_ref()
        .filter(|t| matches!(t.state.as_str(), "completed" | "error" | "interrupted"))
}

/// The steps of the thread's latest finished turn, in the order the work happened; `None` when
/// there is no finished turn or nothing of it to show.
pub fn steps(thread: &Thread) -> Option<Vec<Step>> {
    let turn = finished_turn(thread)?;
    let id = turn.turn_id.as_str();
    let done = turn.completed_at.as_deref();

    // The user's message carries no turn id: it is the last one sent before the turn's first trace.
    let tagged = |t: &Option<String>| t.as_deref() == Some(id);
    let first_trace = thread
        .messages
        .iter()
        .filter(|m| m.role != Role::User && tagged(&m.turn_id))
        .map(|m| m.created_at.as_str())
        .chain(
            thread
                .activities
                .iter()
                .filter(|a| tagged(&a.turn_id))
                .map(|a| a.created_at.as_str()),
        )
        .min();
    let started = [
        Some(turn.requested_at.as_str()).filter(|t| !t.is_empty()),
        first_trace,
    ]
    .into_iter()
    .flatten()
    .min();
    let prompt = thread
        .messages
        .iter()
        .find(|m| m.role == Role::User && tagged(&m.turn_id))
        .or_else(|| {
            thread
                .messages
                .iter()
                .filter(|m| m.role == Role::User && m.turn_id.is_none())
                .rfind(|m| started.is_none_or(|at| m.created_at.as_str() <= at))
        });
    let window_start = prompt
        .map(|m| m.created_at.as_str())
        .or(started)
        .unwrap_or_default();
    // Work that carries no turn id belongs to the turn when it happened inside its window.
    let member = |turn_id: &Option<String>, at: &str| match turn_id {
        Some(other) => other == id,
        None => at >= window_start && done.is_none_or(|end| at <= end),
    };

    enum Item<'a> {
        Message(&'a crate::thread::Message),
        Activity(&'a Activity),
        Plan(&'a crate::thread::Plan),
    }
    let mut items: Vec<(&str, Item)> = Vec::new();
    items.extend(
        thread
            .messages
            .iter()
            .filter(|m| m.role != Role::User && member(&m.turn_id, &m.created_at))
            .map(|m| (m.created_at.as_str(), Item::Message(m))),
    );
    items.extend(
        thread
            .activities
            .iter()
            .filter(|a| member(&a.turn_id, &a.created_at))
            .map(|a| (a.created_at.as_str(), Item::Activity(a))),
    );
    items.extend(
        thread
            .proposed_plans
            .iter()
            .filter(|p| member(&p.turn_id, &p.created_at))
            .map(|p| (p.created_at.as_str(), Item::Plan(p))),
    );
    items.sort_by(|a, b| a.0.cmp(b.0));

    // The final answer: the message the turn names, else its last assistant message with text.
    let assistant =
        |m: &&crate::thread::Message| m.role == Role::Assistant && !m.text.trim().is_empty();
    let members: Vec<&crate::thread::Message> = items
        .iter()
        .filter_map(|(_, item)| match item {
            Item::Message(m) => Some(*m),
            _ => None,
        })
        .filter(assistant)
        .collect();
    let answer = turn
        .assistant_message_id
        .as_ref()
        .and_then(|want| members.iter().find(|m| &m.id == want))
        .or(members.last())
        .copied();

    let mut out: Vec<Step> = Vec::new();
    if let Some(prompt) = prompt {
        out.push(step(Kind::Prompt, "", &prompt.text, false));
    }
    // Tools announced and not yet reported: id, title and start time.
    let mut open: Vec<(String, String, Option<i64>)> = Vec::new();
    for (_, item) in &items {
        match item {
            Item::Message(m) => match m.role {
                Role::Assistant if answer.is_some_and(|a| a.id == m.id) => {}
                Role::Assistant if m.text.trim().is_empty() => {}
                Role::Assistant => out.push(step(Kind::Message, "", &m.text, true)),
                Role::Reasoning if !m.text.trim().is_empty() => {
                    out.push(step(Kind::Thinking, "", &m.text, false));
                }
                Role::System if !m.text.trim().is_empty() => {
                    out.push(step(Kind::Notice, "", &m.text, false));
                }
                _ => {}
            },
            Item::Plan(plan) => out.push(step(Kind::Plan, "", &plan.plan_markdown, true)),
            Item::Activity(a) => activity_step(a, &mut open, &mut out),
        }
    }
    for (_, title, _) in open {
        let mut pending = step(Kind::Summary, &title, "", false);
        pending.facts.push((
            s("Status", "상태"),
            s(
                "started, no result was recorded",
                "시작됨, 결과가 기록되지 않음",
            )
            .into(),
        ));
        out.push(pending);
    }
    if let Some(changed) = diff_step(thread, id) {
        out.push(changed);
    }
    if let Some(answer) = answer {
        out.push(step(Kind::Answer, "", &answer.text, true));
    }
    (!out.is_empty()).then_some(out)
}

fn activity_step(a: &Activity, open: &mut Vec<(String, String, Option<i64>)>, out: &mut Vec<Step>) {
    let call = a.payload["toolCallId"].as_str().map(str::to_string);
    match a.kind.as_str() {
        "tool.started" => {
            if let Some(call) = call {
                open.push((call, tool_title(a), parse_iso_ms(&a.created_at)));
            }
        }
        "tool.completed" | "tool.denied" => {
            let began = call
                .and_then(|call| open.iter().position(|(id, ..)| *id == call))
                .and_then(|at| open.remove(at).2);
            out.push(tool_step(a, began));
        }
        "runtime.error" | "runtime.warning" => {
            let detail = first_line(&a.payload["detail"]);
            let detail = if detail.is_empty() {
                first_line(&a.payload["message"])
            } else {
                detail
            };
            let mut notice = step(Kind::Notice, "", &join_summary(&a.summary, &detail), false);
            if a.kind == "runtime.error" {
                notice.subject = s("Error", "오류").into();
            }
            out.push(notice);
        }
        "context-compaction" => out.push(step(
            Kind::Notice,
            "",
            s("Context compacted", "컨텍스트 압축됨"),
            false,
        )),
        _ => {
            // Whatever else the server records: one plain line, so nothing is skipped silently.
            let detail = first_line(&a.payload["detail"]);
            let mut other = step(
                Kind::Summary,
                &a.kind,
                &join_summary(&a.summary, &detail),
                false,
            );
            if other.body.is_empty() {
                other.body = sanitize(&a.kind);
            }
            out.push(other);
        }
    }
}

fn join_summary(summary: &str, detail: &str) -> String {
    let summary = first_line(&Value::String(summary.to_string()));
    match (summary.is_empty(), detail.is_empty()) {
        (_, true) => summary,
        (true, false) => detail.to_string(),
        (false, false) => format!("{summary} - {detail}"),
    }
}

/// The output a finished tool kept, whole (the transcript shows its first line); a failed tool's
/// error comes first.
fn tool_output(data: &Value, failed: bool) -> String {
    let item = &data["item"];
    let error = if item["error"].is_string() {
        &item["error"]
    } else {
        &item["error"]["message"]
    };
    let mut candidates: Vec<&Value> = Vec::new();
    if failed {
        candidates.push(error);
    }
    candidates.extend([
        &item["aggregatedOutput"],
        &item["result"]["content"],
        &data["rawOutput"]["content"],
        &data["result"]["content"],
    ]);
    candidates
        .into_iter()
        .filter_map(Value::as_str)
        .map(|text| sanitize(text).trim_end().to_string())
        .find(|text| !text.trim().is_empty())
        .unwrap_or_else(|| result_summary(data, failed))
}

fn capped(text: String) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= OUTPUT_LINES {
        return text;
    }
    let more = lines.len() - OUTPUT_LINES;
    format!(
        "{}\n… {more} {}",
        lines[..OUTPUT_LINES].join("\n"),
        s("more lines", "줄 더 있음")
    )
}

fn tool_step(a: &Activity, began: Option<i64>) -> Step {
    let data = &a.payload["data"];
    let failed = crate::transcript::tool_failed(a);
    let mut tool = step(Kind::Tool, &tool_title(a), "", false);

    let detail = sanitize(a.payload["detail"].as_str().unwrap_or_default());
    let detail = shell_command(detail.trim());
    if !detail.is_empty() {
        let label = if a.payload["itemType"] == "command_execution" {
            s("Command", "명령")
        } else {
            s("Input", "입력")
        };
        tool.facts.push((label, detail));
    }
    let files: Vec<String> = data["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| first_line(&f["path"]))
        .filter(|p| !p.is_empty())
        .collect();
    if !files.is_empty() {
        let mut touched = files
            .iter()
            .take(FILES_LISTED)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        if files.len() > FILES_LISTED {
            touched.push_str(&format!(
                " +{} {}",
                files.len() - FILES_LISTED,
                s("more", "개 더")
            ));
        }
        tool.facts.push((s("Touched", "변경 대상"), touched));
    }
    let status = if a.kind == "tool.denied" {
        s("denied", "거부됨")
    } else if failed {
        s("failed", "실패")
    } else {
        s("completed", "완료")
    };
    tool.facts.push((s("Status", "상태"), status.into()));
    let reported = data["item"]["durationMs"].as_f64();
    let elapsed = began
        .zip(parse_iso_ms(&a.created_at))
        .map(|(start, end)| (end - start) as f64);
    if let Some(took) = reported.or(elapsed).and_then(format_duration) {
        tool.facts.push((s("Time", "소요"), took));
    }
    tool.body = capped(tool_output(data, failed));
    tool
}

/// The files the turn changed, from its checkpoint: the paths and line counts `/diff` starts with.
/// The diff text itself lives on the server, so the step points at `/diff` for it.
fn diff_step(thread: &Thread, turn_id: &str) -> Option<Step> {
    let checkpoint = thread
        .checkpoints
        .iter()
        .find(|c| c.turn_id == turn_id && !c.files.is_empty())?;
    let (count, additions, deletions) = diff_report::totals(&checkpoint.files);
    let subject = format!(
        "{count} {}  +{additions} -{deletions}",
        if count == 1 {
            s("file", "파일")
        } else {
            s("files", "파일")
        }
    );
    let mut rows: Vec<String> = checkpoint
        .files
        .iter()
        .map(|f| {
            let kind = f
                .kind
                .chars()
                .next()
                .map_or('M', |c| c.to_ascii_uppercase());
            format!(
                "{kind}  {}  +{} -{}",
                sanitize(&f.path),
                f.additions,
                f.deletions
            )
        })
        .collect();
    rows.push(String::new());
    rows.push(
        s(
            "/diff shows every changed line.",
            "/diff 로 바뀐 줄 전체를 볼 수 있습니다.",
        )
        .into(),
    );
    Some(step(Kind::Diff, &subject, &rows.join("\n"), false))
}

// --- the open view ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Prev,
    Next,
    Play,
    Close,
}

/// An open replay: the steps were derived when it opened and stay as they were, so live events on
/// the thread move nothing under the reader.
struct Session {
    thread_id: String,
    steps: Vec<Step>,
    index: usize,
    /// Lines the step's content is scrolled from its top; the drawing corrects it.
    scroll: Cell<usize>,
    max_scroll: Cell<usize>,
    view_rows: Cell<usize>,
    /// The clock tick at which this step opened (for its reveal and for autoplay).
    opened: usize,
    playing: bool,
}

impl Session {
    /// Moves to step `to` (kept inside the steps); a move to another step starts it from its top.
    fn go(&mut self, to: usize, tick: usize) {
        let to = to.min(self.steps.len().saturating_sub(1));
        if to != self.index {
            self.index = to;
            self.scroll.set(0);
            self.opened = tick;
        }
    }

    fn scroll_by(&self, lines: isize) {
        let to = self.scroll.get().saturating_add_signed(lines);
        self.scroll.set(to.min(self.max_scroll.get()));
    }
}

#[derive(Default)]
pub struct State {
    session: Option<Session>,
    /// Where the `[Replay]` button was drawn last, empty when it is not on screen.
    button: Cell<Rect>,
    /// The buttons of the open view, as of the last drawing.
    hits: RefCell<Vec<(Rect, Action)>>,
}

/// True while the view is open on the thread on screen.
pub fn is_open(app: &App) -> bool {
    app.replay
        .session
        .as_ref()
        .is_some_and(|s| s.thread_id == app.conv.thread_id)
}

/// A view left behind by another thread opening is dropped.
fn drop_stale(app: &mut App) {
    if app.replay.session.is_some() && !is_open(app) {
        app.replay.session = None;
    }
}

/// The `[Replay]` button shows on a thread whose latest turn is over, once nothing is running and
/// the view is not already open.
pub fn button_visible(app: &App) -> bool {
    matches!(app.active, Active::Thread(_))
        && app.conv.loaded
        && !app.conv.busy()
        && !is_open(app)
        && finished_turn(&app.conv.thread).is_some()
}

/// The button's row, for the last line of the conversation.
pub fn button_line(app: &App) -> Line<'static> {
    Line::from(vec![
        Span::raw("  "),
        Span::styled(
            s(BUTTON, "[리플레이]"),
            Style::new()
                .fg(app.theme.brand)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" Ctrl-R", app.theme.dim_style()),
    ])
}

/// Remembers where the button landed: it is the conversation's row `index` of `total`, and the
/// window shows rows `start..end` below `pad` blank ones.
pub fn place_button(app: &App, area: Rect, pad: usize, rows: (usize, usize, usize)) {
    let (index, start, end) = rows;
    let rect = if button_visible(app) && index >= start && index < end {
        let label = width(s(BUTTON, "[리플레이]")) as u16;
        let y = area.y + (pad + index - start) as u16;
        Rect::new(area.x + 2, y, label.min(area.width.saturating_sub(2)), 1)
    } else {
        Rect::default()
    };
    app.replay.button.set(rect);
}

/// Opens the view on the latest finished turn, or says why it cannot.
pub fn open(app: &mut App) {
    if app.conv.busy() {
        app.notice = Some(
            s(
                "A turn is running. Replay opens when it finishes.",
                "작업이 진행 중입니다. 끝나면 리플레이를 열 수 있습니다.",
            )
            .into(),
        );
        return;
    }
    let Some(steps) = steps(&app.conv.thread) else {
        app.notice = Some(
            s(
                "No finished turn to replay yet.",
                "아직 리플레이할 끝난 턴이 없습니다.",
            )
            .into(),
        );
        return;
    };
    app.selection.clear();
    app.notice = None;
    app.replay.session = Some(Session {
        thread_id: app.conv.thread_id.clone(),
        steps,
        index: 0,
        scroll: Cell::new(0),
        max_scroll: Cell::new(0),
        view_rows: Cell::new(1),
        opened: app.tick,
        playing: false,
    });
}

fn close(app: &mut App) {
    app.replay.session = None;
}

/// `/replay`.
pub fn command(app: &mut App) {
    if is_open(app) {
        return;
    }
    open(app);
}

fn act(app: &mut App, action: Action) {
    let tick = app.tick;
    let Some(view) = app.replay.session.as_mut() else {
        return;
    };
    let last = view.steps.len() - 1;
    match action {
        Action::Prev => view.go(view.index.saturating_sub(1), tick),
        Action::Next => view.go(view.index + 1, tick),
        Action::Play => {
            if view.playing {
                view.playing = false;
            } else {
                if view.index == last {
                    view.go(0, tick);
                }
                view.playing = true;
                view.opened = tick;
            }
        }
        Action::Close => close(app),
    }
}

/// A key while the view is open, or Ctrl-R to open it. True when the key was taken. Keys the view
/// has no use for are taken too (the composer is not typed into behind it), except those an
/// approval or a question waiting in the composer needs.
pub fn on_key(app: &mut App, key: ratatui::crossterm::event::KeyEvent) -> bool {
    use ratatui::crossterm::event::{KeyCode, KeyModifiers};
    drop_stale(app);
    let plain = !key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
    if !is_open(app) {
        let opens = key.code == KeyCode::Char('r')
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && app.screen.is_none()
            && app.modal.is_none()
            && matches!(app.active, Active::Thread(_));
        if opens {
            open(app);
        }
        return opens;
    }
    let waiting = app.approval().is_some() || app.pending_input().is_some();
    let rows = app
        .replay
        .session
        .as_ref()
        .map_or(1, |view| view.view_rows.get());
    let page = rows.saturating_sub(1).max(1) as isize;
    match key.code {
        KeyCode::Esc => close(app),
        KeyCode::Right | KeyCode::Char('n') if plain => act(app, Action::Next),
        KeyCode::Left | KeyCode::Char('p') if plain => act(app, Action::Prev),
        KeyCode::Home => go_to(app, 0),
        KeyCode::End => go_to(app, usize::MAX),
        KeyCode::Char(' ') if plain => act(app, Action::Play),
        KeyCode::PageDown => scroll(app, page),
        KeyCode::PageUp => scroll(app, -page),
        KeyCode::Down if !waiting => scroll(app, SCROLL_LINES as isize),
        KeyCode::Up if !waiting => scroll(app, -(SCROLL_LINES as isize)),
        _ if waiting && !matches!(key.code, KeyCode::Char('n' | 'p' | ' ')) => return false,
        _ => {}
    }
    true
}

fn go_to(app: &mut App, to: usize) {
    let tick = app.tick;
    if let Some(view) = app.replay.session.as_mut() {
        view.go(to, tick);
    }
}

fn scroll(app: &App, lines: isize) {
    if let Some(view) = &app.replay.session {
        view.scroll_by(lines);
    }
}

/// The wheel scrolls the step's content. True when the view is open and took it.
pub fn on_wheel(app: &mut App, up: bool) -> bool {
    if !is_open(app) {
        return false;
    }
    let lines = SCROLL_LINES as isize;
    scroll(app, if up { -lines } else { lines });
    true
}

/// A left click: on the `[Replay]` button it opens the view, on one of the view's buttons it does
/// that button's work. True when the click was one of them.
pub fn on_click(app: &mut App, x: u16, y: u16) -> bool {
    let at = |r: Rect| r.width > 0 && x >= r.x && x < r.right() && y >= r.y && y < r.bottom();
    drop_stale(app);
    if is_open(app) {
        let hit = app
            .replay
            .hits
            .borrow()
            .iter()
            .find(|(rect, _)| at(*rect))
            .map(|(_, action)| *action);
        if let Some(action) = hit {
            act(app, action);
            return true;
        }
        return false;
    }
    if button_visible(app) && at(app.replay.button.get()) {
        open(app);
        return true;
    }
    false
}

/// Advances autoplay and the reveal on the app's clock; true when the screen changes by it. A view
/// that is paused and fully revealed answers false, so it costs no repaint.
pub fn tick(app: &mut App) -> bool {
    drop_stale(app);
    let now = app.tick;
    let animations = app.settings.animations;
    let Some(view) = app.replay.session.as_mut() else {
        return false;
    };
    let mut moved = false;
    if view.playing && now.wrapping_sub(view.opened) >= AUTOPLAY_TICKS {
        let next = view.index + 1;
        view.go(next, now);
        view.opened = now;
        view.playing = next + 1 < view.steps.len();
        moved = true;
    }
    moved || (animations && now.wrapping_sub(view.opened) <= REVEAL_TICKS)
}

pub fn hint() -> &'static str {
    s(
        "←/→ n/p step · Home/End ends · Space autoplay · ↑/↓ scroll · Esc close",
        "←/→ n/p 이동 · Home/End 처음/끝 · Space 자동 재생 · ↑/↓ 스크롤 · Esc 닫기",
    )
}

// --- drawing ----------------------------------------------------------------------------------

/// The step's content as lines `w` cells wide: the fact rows, a gap, then the body.
fn content(step: &Step, w: usize, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    let label_w = step.facts.iter().map(|(l, _)| width(l)).max().unwrap_or(0);
    for (label, value) in &step.facts {
        let room = w.saturating_sub(label_w + 3).max(8);
        for (i, row) in wrap(&sanitize(value), room).into_iter().enumerate() {
            let lead = if i == 0 {
                format!(" {label}{}  ", " ".repeat(label_w - width(label)))
            } else {
                " ".repeat(label_w + 3)
            };
            out.push(Line::from(vec![
                Span::styled(lead, th.dim_style()),
                Span::raw(row),
            ]));
        }
    }
    if !step.facts.is_empty() && !step.body.is_empty() {
        out.push(Line::default());
    }
    if step.markdown {
        out.extend(
            markdown::render(&step.body, w.saturating_sub(2).max(8), th, sym)
                .into_iter()
                .map(|mut line| {
                    line.spans.insert(0, Span::raw(" "));
                    line
                }),
        );
    } else {
        let ink = if step.kind == Kind::Thinking {
            th.dim_style().add_modifier(Modifier::ITALIC)
        } else {
            Style::new()
        };
        for row in step.body.split('\n') {
            for part in wrap(row, w.saturating_sub(2).max(8)) {
                out.push(Line::from(Span::styled(format!(" {part}"), ink)));
            }
        }
    }
    out
}

/// Draws the view in the conversation's place.
pub fn draw(frame: &mut Frame, area: Rect, app: &App) {
    let Some(view) = app.replay.session.as_ref() else {
        return;
    };
    let th = &app.theme;
    let w = usize::from(area.width);
    let h = area.height;
    // The conversation is not on screen: a pointer over this area is over no row of it.
    app.geo.set(Geo {
        area,
        ..Geo::default()
    });
    let current = &view.steps[view.index];
    let total = view.steps.len();
    let row = |y: u16| Rect::new(area.x, area.y + y, area.width, 1);

    // Title: Step 3/12 · Tool · Bash
    if h >= 1 {
        let mut spans = vec![
            Span::styled(
                format!(" {} {}/{total}", s("Step", "단계"), view.index + 1),
                Style::new().fg(th.brand).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" · ", th.dim_style()),
            Span::styled(
                current.kind.label(),
                Style::new()
                    .fg(current.kind.color(th))
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if !current.subject.is_empty() {
            spans.push(Span::styled(" · ", th.dim_style()));
            spans.push(Span::raw(current.subject.clone()));
        }
        // Colours stay while the title fits; a title cut to the width is drawn plain.
        let plain: String = spans.iter().map(|span| span.content.as_ref()).collect();
        let line = if width(&plain) <= w {
            Line::from(spans)
        } else {
            Line::from(truncate(&plain, w))
        };
        frame.render_widget(Paragraph::new(line), row(0));
    }

    // Progress: a bar and the share done.
    if h >= 2 {
        let tail = format!(" {}%", (view.index + 1) * 100 / total);
        let bar = w.saturating_sub(2 + width(&tail)).max(1);
        let filled = ((view.index + 1) * bar).div_ceil(total).min(bar);
        let (on, off) = if app.settings.ascii {
            ("#", "-")
        } else {
            ("█", "░")
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::raw(" "),
                Span::styled(on.repeat(filled), Style::new().fg(th.brand)),
                Span::styled(off.repeat(bar - filled), th.dim_style()),
                Span::styled(tail, th.dim_style()),
            ])),
            row(1),
        );
    }

    // Content: scrolls when long, revealed line by line for a moment after the step opens.
    let body_rows = h.saturating_sub(3);
    let lines = content(current, w, th, &app.sym);
    let view_rows = usize::from(body_rows).max(1);
    let max = lines.len().saturating_sub(view_rows);
    let scroll = view.scroll.get().min(max);
    view.scroll.set(scroll);
    view.max_scroll.set(max);
    view.view_rows.set(view_rows);
    let age = app.tick.wrapping_sub(view.opened);
    let reveal = if app.settings.animations && age < REVEAL_TICKS {
        (lines.len() * (age + 1)).div_ceil(REVEAL_TICKS + 1)
    } else {
        lines.len()
    };
    if body_rows > 0 {
        let shown: Vec<Line> = lines
            .iter()
            .take(reveal)
            .skip(scroll)
            .take(view_rows)
            .cloned()
            .collect();
        frame.render_widget(
            Paragraph::new(shown),
            Rect::new(area.x, area.y + 2, area.width, body_rows),
        );
    }

    // Buttons, and where the content stands when it is long.
    let mut hits = Vec::new();
    if h >= 3 {
        let y = h - 1;
        let play = if view.playing {
            s("[Pause]", "[일시정지]")
        } else {
            s("[Play]", "[재생]")
        };
        let buttons = [
            (s("[Prev]", "[이전]"), Action::Prev, view.index == 0),
            (s("[Next]", "[다음]"), Action::Next, view.index + 1 == total),
            (play, Action::Play, false),
            (s("[Close]", "[닫기]"), Action::Close, false),
        ];
        let mut spans = vec![Span::raw(" ")];
        let mut x = area.x + 1;
        for (label, action, inert) in buttons {
            let cells = width(label) as u16;
            if x + cells > area.right() {
                break;
            }
            hits.push((Rect::new(x, area.y + y, cells, 1), action));
            let style = if inert {
                th.dim_style()
            } else {
                Style::new().fg(th.brand).add_modifier(Modifier::BOLD)
            };
            spans.push(Span::styled(label, style));
            spans.push(Span::raw(" "));
            x += cells + 1;
        }
        if max > 0 {
            let first = scroll + 1;
            let last = (scroll + view_rows).min(lines.len());
            let place = format!("{first}-{last}/{} ", lines.len());
            let used = usize::from(x - area.x);
            if used + width(&place) < w {
                spans.push(Span::raw(" ".repeat(w - used - width(&place))));
                spans.push(Span::styled(place, th.dim_style()));
            }
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), row(y));
    }
    *app.replay.hits.borrow_mut() = hits;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{LinkStatus, Msg};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{
        Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseButton,
        MouseEvent, MouseEventKind,
    };
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    fn thread_json(state: &str) -> Value {
        json!({
            "id": "t", "title": "demo",
            "latestTurn": {"turnId": "turn-2", "state": state, "requestedAt": "2026-01-01T00:01:00.000Z",
                "completedAt": "2026-01-01T00:01:20.000Z", "assistantMessageId": "a2"},
            "session": {"status": if state == "running" { "running" } else { "ready" }},
            "messages": [
                {"id": "u1", "role": "user", "text": "first question", "turnId": null, "createdAt": "2026-01-01T00:00:00.000Z"},
                {"id": "a1", "role": "assistant", "text": "first answer", "turnId": "turn-1", "createdAt": "2026-01-01T00:00:05.000Z"},
                {"id": "u2", "role": "user", "text": "Add a --verbose flag", "turnId": null, "createdAt": "2026-01-01T00:01:00.000Z"},
                {"id": "r2", "role": "reasoning", "text": "I will read main.rs first", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:01.000Z"},
                {"id": "m2", "role": "assistant", "text": "Reading the entry point.", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:02.000Z"},
                {"id": "a2", "role": "assistant", "text": "Done: `--verbose` now prints the **steps**.", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:19.000Z"}
            ],
            "activities": [
                {"id": "x0", "kind": "tool.completed", "summary": "Ran", "turnId": "turn-1", "createdAt": "2026-01-01T00:00:03.000Z", "payload": {"title": "Old tool"}},
                {"id": "x1", "kind": "tool.started", "summary": "Ran", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:03.000Z", "payload": {"toolCallId": "c1", "title": "Bash"}},
                {"id": "x2", "kind": "tool.completed", "summary": "Ran", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:05.500Z",
                 "payload": {"toolCallId": "c1", "title": "Bash", "itemType": "command_execution", "detail": "/bin/zsh -lc 'cargo test'", "data": {"item": {"aggregatedOutput": "running 3 tests\ntest result: ok. 3 passed"}}}},
                {"id": "x3", "kind": "tool.completed", "summary": "Patch", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:10.000Z",
                 "payload": {"title": "Patch", "itemType": "file_change", "data": {"files": [{"path": "src/main.rs"}, {"path": "src/cli.rs"}]}}},
                {"id": "x4", "kind": "tool.completed", "summary": "Ran", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:12.000Z",
                 "payload": {"title": "Edit", "status": "failed", "data": {"item": {"error": {"message": "no such file"}}}}},
                {"id": "x5", "kind": "runtime.warning", "summary": "Slow disk", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:13.000Z", "payload": {"message": "took long"}},
                {"id": "x6", "kind": "something.new", "summary": "A new kind of record", "turnId": "turn-2", "createdAt": "2026-01-01T00:01:14.000Z", "payload": {}}
            ],
            "checkpoints": [
                {"turnId": "turn-2", "checkpointTurnCount": 2, "status": "ready", "completedAt": "2026-01-01T00:01:21.000Z",
                 "files": [{"path": "src/main.rs", "kind": "modified", "additions": 12, "deletions": 3}, {"path": "src/cli.rs", "kind": "added", "additions": 40, "deletions": 0}]}
            ]
        })
    }

    fn thread(state: &str) -> Thread {
        serde_json::from_value(thread_json(state)).unwrap()
    }

    fn kinds(steps: &[Step]) -> Vec<Kind> {
        steps.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn steps_follow_the_latest_turn_only_and_unknown_activity_is_a_summary() {
        let steps = steps(&thread("completed")).unwrap();
        assert_eq!(
            kinds(&steps),
            vec![
                Kind::Prompt,
                Kind::Thinking,
                Kind::Message,
                Kind::Tool,
                Kind::Tool,
                Kind::Tool,
                Kind::Notice,
                Kind::Summary,
                Kind::Diff,
                Kind::Answer
            ]
        );
        assert_eq!(
            steps[0].body, "Add a --verbose flag",
            "the prompt of this turn"
        );
        let text = format!("{steps:?}");
        assert!(!text.contains("Old tool") && !text.contains("first answer"));
        let bash = &steps[3];
        assert_eq!(bash.subject, "Bash");
        assert!(bash.facts.contains(&("Command", "cargo test".to_string())));
        assert!(
            bash.facts.contains(&("Time", "2.5s".to_string())),
            "{bash:?}"
        );
        assert_eq!(bash.body, "running 3 tests\ntest result: ok. 3 passed");
        assert!(
            steps[4]
                .facts
                .contains(&("Touched", "src/main.rs, src/cli.rs".to_string()))
        );
        assert_eq!(steps[5].body, "no such file");
        assert!(steps[5].facts.contains(&("Status", "failed".to_string())));
        assert_eq!(steps[7].subject, "something.new");
        assert_eq!(steps[7].body, "A new kind of record");
        assert_eq!(steps[8].subject, "2 files  +52 -3");
        assert!(steps[8].body.contains("M  src/main.rs  +12 -3"));
        assert!(steps[8].body.contains("A  src/cli.rs  +40 -0"));
        assert_eq!(steps[9].body, "Done: `--verbose` now prints the **steps**.");
    }

    #[test]
    fn a_running_turn_and_a_thread_without_a_turn_have_no_steps() {
        assert!(steps(&thread("running")).is_none());
        assert!(steps(&Thread::default()).is_none());
        // A tool that never reported shows as a step of its own, not as nothing.
        let mut t = thread_json("completed");
        t["activities"] = json!([{"id": "s", "kind": "tool.started", "summary": "Ran", "turnId": "turn-2",
            "createdAt": "2026-01-01T00:01:03.000Z", "payload": {"toolCallId": "c9", "title": "Grep"}}]);
        let steps = steps(&serde_json::from_value(t).unwrap()).unwrap();
        assert!(
            steps
                .iter()
                .any(|s| s.kind == Kind::Summary && s.subject == "Grep")
        );
    }

    #[test]
    fn work_without_a_turn_id_inside_the_turn_is_kept() {
        let mut t = thread_json("completed");
        t["activities"] = json!([{"id": "n", "kind": "tool.completed", "summary": "Ran", "turnId": null,
            "createdAt": "2026-01-01T00:01:06.000Z", "payload": {"title": "Untagged"}},
            {"id": "o", "kind": "tool.completed", "summary": "Ran", "turnId": null,
            "createdAt": "2026-01-01T00:00:02.000Z", "payload": {"title": "BeforeTheTurn"}}]);
        let steps = steps(&serde_json::from_value(t).unwrap()).unwrap();
        let subjects: Vec<&str> = steps.iter().map(|s| s.subject.as_str()).collect();
        assert!(subjects.contains(&"Untagged") && !subjects.contains(&"BeforeTheTurn"));
    }

    #[test]
    fn long_tool_output_is_capped_and_counted() {
        let mut t = thread_json("completed");
        let output = (0..300)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        t["activities"] = json!([{"id": "n", "kind": "tool.completed", "summary": "Ran", "turnId": "turn-2",
            "createdAt": "2026-01-01T00:01:06.000Z", "payload": {"title": "Big", "data": {"item": {"aggregatedOutput": output}}}}]);
        let steps = steps(&serde_json::from_value(t).unwrap()).unwrap();
        let big = steps.iter().find(|s| s.subject == "Big").unwrap();
        assert!(big.body.ends_with("… 100 more lines"), "{}", big.body);
        assert_eq!(big.body.lines().count(), OUTPUT_LINES + 1);
    }

    #[test]
    fn navigation_stays_inside_the_steps() {
        let mut view = Session {
            thread_id: "t".into(),
            steps: steps(&thread("completed")).unwrap(),
            index: 0,
            scroll: Cell::new(0),
            max_scroll: Cell::new(0),
            view_rows: Cell::new(1),
            opened: 0,
            playing: false,
        };
        let last = view.steps.len() - 1;
        view.go(0usize.saturating_sub(1), 1);
        assert_eq!(view.index, 0);
        view.go(view.index + 1, 2);
        assert_eq!(view.index, 1);
        view.go(usize::MAX, 3);
        assert_eq!(view.index, last);
        view.go(last + 1, 4);
        assert_eq!(view.index, last);
        assert_eq!(
            view.opened, 3,
            "a move that changes nothing restarts nothing"
        );
    }

    // --- the app around it ---

    fn app_with(state: &str) -> App {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        app.last_model_path = std::env::temp_dir().join("oop-rs-replay-none/last-model.json");
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p", "title": "demo", "workspaceRoot": "/Users/x/demo"}],
            "threads": [{"id": "t", "projectId": "p", "title": "demo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app.handle(Msg::Link(LinkStatus::Online));
        app.active = Active::Thread("t".into());
        app.conv = crate::state::Conversation::new("t");
        app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": thread_json(state)}}));
        app
    }

    fn rows(app: &App, w: u16, h: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| crate::ui::draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < w {
                    let symbol = buffer[(x, y)].symbol();
                    row.push_str(symbol);
                    x += u16::try_from(width(symbol).max(1)).unwrap_or(1);
                }
                row.trim_end().to_string()
            })
            .collect()
    }

    fn key(app: &mut App, code: KeyCode) {
        press(app, code, KeyModifiers::NONE);
    }

    fn press(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
        app.handle(Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })));
    }

    fn click(app: &mut App, x: u16, y: u16) {
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            app.handle(Msg::Term(Event::Mouse(MouseEvent {
                kind,
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            })));
        }
    }

    fn find(rows: &[String], needle: &str) -> (u16, u16) {
        rows.iter()
            .enumerate()
            .find_map(|(y, row)| {
                row.find(needle)
                    .map(|at| (width(&row[..at]) as u16, y as u16))
            })
            .unwrap_or_else(|| panic!("{needle} is not on the screen:\n{}", rows.join("\n")))
    }

    fn index(app: &App) -> usize {
        app.replay.session.as_ref().unwrap().index
    }

    #[tokio::test]
    async fn the_button_is_on_the_last_line_after_a_turn_and_hidden_while_one_runs() {
        let app = app_with("completed");
        let screen = rows(&app, 100, 30);
        let (_, y) = find(&screen, "[Replay]");
        let last_text = screen.iter().rposition(|r| r.contains("Done:")).unwrap();
        assert!(
            usize::from(y) > last_text,
            "after the final message:\n{}",
            screen.join("\n")
        );
        assert!(
            !screen[usize::from(y) + 1..]
                .iter()
                .any(|r| r.contains("Done:"))
        );

        // A turn running: no button.
        let running = app_with("running");
        assert!(
            !rows(&running, 100, 30)
                .iter()
                .any(|r| r.contains("[Replay]"))
        );
        // A streaming reply is a running turn too.
        let mut streaming = app_with("completed");
        streaming.conv.thread.messages.last_mut().unwrap().streaming = true;
        assert!(!button_visible(&streaming));
        // A draft has none.
        let mut draft = app_with("completed");
        draft.active = Active::Draft("p".into());
        assert!(!button_visible(&draft));
    }

    #[tokio::test]
    async fn the_button_appears_when_the_turn_finishes() {
        let mut app = app_with("running");
        assert!(!button_visible(&app));
        app.handle(Msg::Thread {
            id: "t".into(),
            item: json!({"kind": "event", "event": {"sequence": 3, "type": "thread.session-set", "occurredAt": "2026-01-01T00:01:21.000Z",
                "payload": {"threadId": "t", "session": {"threadId": "t", "status": "ready", "providerName": "codex", "runtimeMode": "full-access", "activeTurnId": null, "lastError": null, "updatedAt": "2026-01-01T00:01:21.000Z"}}}}),
        });
        app.conv.thread.latest_turn.as_mut().unwrap().state = "completed".into();
        assert!(button_visible(&app));
    }

    #[tokio::test]
    async fn clicking_the_button_slash_replay_and_ctrl_r_open_the_view() {
        let mut app = app_with("completed");
        let screen = rows(&app, 100, 30);
        let (x, y) = find(&screen, "[Replay]");
        click(&mut app, x + 2, y);
        assert!(is_open(&app));
        assert!(app.log.is_empty(), "nothing was sent anywhere");

        let mut app = app_with("completed");
        for c in "/replay".chars() {
            key(&mut app, KeyCode::Char(c));
        }
        key(&mut app, KeyCode::Enter);
        assert!(is_open(&app));

        let mut app = app_with("completed");
        press(&mut app, KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert!(is_open(&app));
        assert!(
            !rows(&app, 100, 30).iter().any(|r| r.contains("[Replay]")),
            "no button while open"
        );
        assert!(app.log.is_empty());
    }

    #[tokio::test]
    async fn slash_replay_says_so_without_a_finished_turn() {
        let mut app = app_with("completed");
        app.conv.thread.latest_turn = None;
        for c in "/replay".chars() {
            key(&mut app, KeyCode::Char(c));
        }
        key(&mut app, KeyCode::Enter);
        assert!(!is_open(&app));
        assert_eq!(
            app.notice.as_deref(),
            Some("No finished turn to replay yet.")
        );
        let mut running = app_with("running");
        command(&mut running);
        assert!(!is_open(&running));
        assert!(running.notice.as_deref().unwrap().contains("running"));
    }

    #[tokio::test]
    async fn keys_and_buttons_move_by_one_and_stop_at_the_ends() {
        let mut app = app_with("completed");
        open(&mut app);
        let total = app.replay.session.as_ref().unwrap().steps.len();
        assert_eq!(index(&app), 0);
        key(&mut app, KeyCode::Left);
        key(&mut app, KeyCode::Char('p'));
        assert_eq!(index(&app), 0, "no step before the first");
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Char('n'));
        assert_eq!(index(&app), 2);
        key(&mut app, KeyCode::End);
        assert_eq!(index(&app), total - 1);
        key(&mut app, KeyCode::Right);
        assert_eq!(index(&app), total - 1, "no step after the last");
        key(&mut app, KeyCode::Home);
        assert_eq!(index(&app), 0);

        let screen = rows(&app, 100, 30);
        assert!(
            screen
                .iter()
                .any(|r| r.contains(&format!("Step 1/{total}")))
        );
        let (x, y) = find(&screen, "[Next]");
        click(&mut app, x, y);
        assert_eq!(index(&app), 1);
        let (x, y) = find(&rows(&app, 100, 30), "[Prev]");
        click(&mut app, x + 1, y);
        assert_eq!(index(&app), 0);
        assert!(
            app.input.is_empty(),
            "keys are not typed into the composer behind it"
        );
        let (x, y) = find(&rows(&app, 100, 30), "[Close]");
        click(&mut app, x, y);
        assert!(!is_open(&app));
    }

    #[tokio::test]
    async fn close_returns_to_the_conversation_at_the_same_scroll() {
        let mut app = app_with("completed");
        let before = rows(&app, 100, 12);
        app.scroll.set(3);
        let scrolled = rows(&app, 100, 12);
        let (scroll, max, total) = (app.scroll.get(), app.scroll_max.get(), app.total.get());
        assert!(
            scroll > 0 && scroll <= max,
            "the fixture has a conversation longer than the window"
        );
        assert_ne!(before, scrolled);

        open(&mut app);
        key(&mut app, KeyCode::Right);
        let inside = rows(&app, 100, 12);
        assert!(inside.iter().any(|r| r.contains("Step 2/")));
        assert_eq!(
            (app.scroll.get(), app.scroll_max.get(), app.total.get()),
            (scroll, max, total)
        );
        // The wheel scrolls the replay, not the conversation.
        app.handle(Msg::Term(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 40,
            row: 5,
            modifiers: KeyModifiers::NONE,
        })));
        assert_eq!(app.scroll.get(), scroll);

        key(&mut app, KeyCode::Esc);
        assert!(!is_open(&app));
        assert_eq!(
            rows(&app, 100, 12),
            scrolled,
            "the same lines in the same place"
        );
        assert_eq!(app.scroll.get(), scroll);
    }

    #[tokio::test]
    async fn the_view_adds_nothing_to_the_transcript_or_the_selection() {
        let mut app = app_with("completed");
        let w = 98;
        let before = app.transcript(w);
        let _ = rows(&app, 100, 30);
        let with_button = app.transcript(w);
        assert_eq!(before.lines.len(), with_button.lines.len());
        assert_eq!(
            app.geo.get().rows,
            before.lines.len(),
            "the button row is not a selectable row"
        );
        open(&mut app);
        let _ = rows(&app, 100, 30);
        assert_eq!(
            app.geo.get().rows,
            0,
            "no conversation row is under the pointer while it is open"
        );
        close(&mut app);
        let _ = rows(&app, 100, 30);
        assert_eq!(app.geo.get().rows, before.lines.len());
        assert_eq!(app.transcript(w).lines.len(), before.lines.len());
        assert!(app.log.is_empty());
    }

    #[tokio::test]
    async fn live_events_keep_the_view_open_and_unchanged() {
        let mut app = app_with("completed");
        open(&mut app);
        key(&mut app, KeyCode::Right);
        let shown = steps(&app.conv.thread).unwrap().len();
        // The next turn starts on this thread while the view is open.
        app.handle(Msg::Thread {
            id: "t".into(),
            item: json!({"kind": "event", "event": {"sequence": 3, "type": "thread.message-sent", "occurredAt": "2026-01-01T00:02:00.000Z",
                "payload": {"threadId": "t", "messageId": "u3", "role": "user", "text": "next", "turnId": null, "streaming": false,
                    "createdAt": "2026-01-01T00:02:00.000Z", "updatedAt": "2026-01-01T00:02:00.000Z"}}}),
        });
        app.conv.thread.session.as_mut().unwrap().status = "running".into();
        assert!(is_open(&app), "a live event does not close it");
        assert_eq!(index(&app), 1);
        assert_eq!(app.replay.session.as_ref().unwrap().steps.len(), shown);
        let _ = rows(&app, 100, 30);

        // Another thread opening drops the view.
        app.conv = crate::state::Conversation::new("other");
        assert!(!is_open(&app));
        assert!(!tick(&mut app));
        assert!(app.replay.session.is_none());
    }

    #[tokio::test]
    async fn autoplay_advances_on_the_clock_and_a_paused_view_never_repaints() {
        let mut app = app_with("completed");
        open(&mut app);
        // The reveal repaints for under a second, then nothing.
        let mut repaints = 0;
        for _ in 0..10 {
            app.tick += 1;
            repaints += usize::from(tick(&mut app));
        }
        assert_eq!(repaints, REVEAL_TICKS, "{repaints}");

        key(&mut app, KeyCode::Char(' '));
        assert!(app.replay.session.as_ref().unwrap().playing);
        for _ in 0..AUTOPLAY_TICKS - 1 {
            app.tick += 1;
            tick(&mut app);
        }
        assert_eq!(index(&app), 0);
        app.tick += 1;
        assert!(tick(&mut app));
        assert_eq!(index(&app), 1);
        key(&mut app, KeyCode::Char(' '));
        assert!(!app.replay.session.as_ref().unwrap().playing);
        let at = index(&app);
        // The step autoplay moved to reveals once; after that the clock repaints nothing.
        for _ in 0..=REVEAL_TICKS {
            app.tick += 1;
            tick(&mut app);
        }
        for _ in 0..40 {
            app.tick += 1;
            assert!(!tick(&mut app));
        }
        assert_eq!(index(&app), at);

        // Playing from the last step starts over; autoplay stops on reaching the last.
        key(&mut app, KeyCode::End);
        key(&mut app, KeyCode::Char(' '));
        assert_eq!(index(&app), 0);
        let last = app.replay.session.as_ref().unwrap().steps.len() - 1;
        key(&mut app, KeyCode::End);
        key(&mut app, KeyCode::Left);
        assert_eq!(index(&app), last - 1);
        assert!(app.replay.session.as_ref().unwrap().playing);
        app.tick += AUTOPLAY_TICKS;
        assert!(tick(&mut app));
        assert_eq!(index(&app), last);
        assert!(!app.replay.session.as_ref().unwrap().playing);
    }

    #[tokio::test]
    async fn no_reveal_without_animations() {
        let mut app = app_with("completed");
        app.settings.animations = false;
        open(&mut app);
        assert!(!tick(&mut app));
        let text = rows(&app, 100, 30).join("\n");
        assert!(text.contains("Add a --verbose flag"), "{text}");
    }

    #[tokio::test]
    async fn long_content_scrolls_and_the_title_names_the_step() {
        let mut app = app_with("completed");
        app.conv.thread.messages.last_mut().unwrap().text = (0..60)
            .map(|i| format!("paragraph {i}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        app.settings.animations = false;
        open(&mut app);
        key(&mut app, KeyCode::End);
        let top = rows(&app, 100, 20);
        assert!(top.iter().any(|r| r.contains("Answer")));
        assert!(top.iter().any(|r| r.contains("paragraph 0")));
        assert!(!top.iter().any(|r| r.contains("paragraph 59")));
        key(&mut app, KeyCode::PageDown);
        let down = rows(&app, 100, 20);
        assert!(!down.iter().any(|r| r.contains("paragraph 0\n")) && down != top);
        for _ in 0..80 {
            key(&mut app, KeyCode::PageDown);
            let _ = rows(&app, 100, 20);
        }
        assert!(
            rows(&app, 100, 20)
                .iter()
                .any(|r| r.contains("paragraph 59"))
        );
        key(&mut app, KeyCode::Home);
        assert_eq!(
            app.replay.session.as_ref().unwrap().scroll.get(),
            0,
            "a new step starts at its top"
        );
    }

    #[tokio::test]
    async fn an_approval_waiting_still_gets_its_keys() {
        let mut app = app_with("completed");
        open(&mut app);
        // Letters are the view's or nobody's; arrows reach a waiting approval.
        key(&mut app, KeyCode::Char('x'));
        assert!(app.input.is_empty());
        assert!(on_key(
            &mut app,
            KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
        ));
    }

    #[tokio::test]
    async fn a_step_as_plain_text() {
        let mut app = app_with("completed");
        app.settings.animations = false;
        open(&mut app);
        key(&mut app, KeyCode::Char('n'));
        key(&mut app, KeyCode::Char('n'));
        key(&mut app, KeyCode::Char('n'));
        let screen = rows(&app, 72, 16);
        println!("{}", screen.join("\n"));
        assert!(screen[1].contains("Step 4/10") || screen.iter().any(|r| r.contains("Step 4/10")));
        assert!(
            screen
                .iter()
                .any(|r| r.contains("Command") && r.contains("cargo test"))
        );
        assert!(
            screen
                .iter()
                .any(|r| r.contains("[Prev] [Next] [Play] [Close]"))
        );
    }
}
