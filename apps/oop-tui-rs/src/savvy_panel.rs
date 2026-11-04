//! The Savvy panel: how the running work stands. A progress bar built from counts the server
//! reported (the plan's steps, the crew's tasks, a workflow's agents), and one block per member of
//! the crew with its role, model, context use and cost. The same bar sits on the composer's top
//! border while a turn runs (`draw_input_bar`). While work runs and animations are on, a neon
//! glow slides along the bar (`glow`); it stops when the work is done, waits or is idle.
//!
//! Nothing is estimated. A value the data does not carry reads `—`:
//! - the lead's `ctx N%` is the thread's last `context-window.updated` (`usedTokens` over
//!   `maxTokens`; only the Claude and Codex adapters report one, and `—` without a window size);
//! - the lead's cost is the sum of the session's `owned-usage` reports, which only Claude's
//!   running `total_cost_usd` gives (the TypeScript client's rule), so `—` for every other provider;
//! - a crew task's cost is what its `task.completed` usage reported (`costUsd`), `—` while it runs
//!   or when the provider gave none; its context lives in the task's own thread, which this one
//!   does not hold, so `ctx —`;
//! - a provider's subagent has a model and a role when the provider said so, never a cost or context.
//!
//! Each crew member also has a bar of its own. A task with a TODO list reports its items, so its
//! bar is two-toned (verified cells, lighter claimed cells, empty for the rest) with the share of
//! items verified or claimed, and failed or blocked items named in words as well as colour. For
//! any other member no count exists in the data (a task's own thread is not held here), so a running
//! member's bar is the indeterminate marker, a finished one is whole in success colour, a failed or
//! blocked one whole in error colour, and one that stopped, ended partial or was never used is
//! empty; the word beside the bar says which, so colour is not the only hint.
//!
//! The overall bar's total is whichever real count applies, in this order: the running workflow's agents,
//! the crew's items while some still run (every task's TODO items, a task with no list counting as
//! one), else the crew tasks, the turn's plan steps. With none of them the bar is an
//! indeterminate marker labelled "no total", never a percentage.

use crate::app::App;
use crate::flow::{
    AgentStatus, CrewPhase, CrewTask, CrewTodos, FlowInput, NodeState, Proof, Role, Waiting,
    agent_model, crew_board, waiting_crew,
};
use crate::panels_common::*;
use crate::text::width as cells_of;
use crate::theme::{Symbols, Theme};
use crate::thread::{Activity, Thread};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::collections::HashMap;

/// Members listed before the rest are folded into a count.
const MEMBER_LIMIT: usize = 10;
/// The widest the bar on the composer grows, and the narrowest that still reads as a bar.
const INPUT_BAR_MAX: usize = 20;
const INPUT_BAR_MIN: usize = 6;
/// The composer must be this wide before it carries a bar.
const INPUT_BAR_COLUMNS: u16 = 30;

// ---- progress -----------------------------------------------------------------------------------

/// What the bar counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    Workflow,
    Crew,
    Plan,
}

impl Basis {
    fn word(self) -> &'static str {
        match self {
            Basis::Workflow => s("workflow agents", "workflow 에이전트"),
            Basis::Crew => s("crew tasks", "crew 작업"),
            Basis::Plan => s("plan steps", "계획 단계"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    /// `done` of `total`, both reported by the server.
    Steps {
        done: usize,
        total: usize,
        basis: Basis,
    },
    /// A crew task with a TODO list: items by how far they got, and how the task ended (`None`
    /// while it runs).
    Items(Items),
    /// Work is running and nothing says how much there is.
    Indeterminate,
    /// A crew member that is no longer running. It has no count of its own, so its bar is whole
    /// or empty by how it ended, never a share.
    Ended(End),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Items {
    pub todos: CrewTodos,
    pub end: Option<End>,
}

impl Items {
    /// Proven items as a whole percent, rounded down. Claimed items are not counted.
    fn percent(self) -> usize {
        self.todos.proven() * 100 / self.todos.total
    }
}

/// How a crew member ended (or that it has not begun).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Done,
    Failed,
    Blocked,
    Partial,
    Stopped,
}

impl End {
    fn word(self) -> &'static str {
        match self {
            End::Done => state_word(NodeState::Completed),
            End::Failed => state_word(NodeState::Failed),
            End::Blocked => s("Blocked", "막힘"),
            End::Partial => s("Partial", "일부 완료"),
            End::Stopped => state_word(NodeState::Cancelled),
        }
    }
}

fn plan_counts(thread: &Thread, turn: Option<&str>) -> Option<(usize, usize)> {
    let update = thread.activities.iter().rev().find(|a| {
        a.kind == "turn.plan.updated"
            && (a.turn_id.is_none() || turn.is_none() || a.turn_id.as_deref() == turn)
    })?;
    let steps: Vec<&serde_json::Value> = update.payload["plan"]
        .as_array()?
        .iter()
        .filter(|entry| {
            entry["step"]
                .as_str()
                .is_some_and(|step| !step.trim().is_empty())
        })
        .collect();
    let done = steps
        .iter()
        .filter(|entry| entry["status"] == "completed")
        .count();
    (!steps.is_empty()).then_some((done, steps.len()))
}

/// The work the bar counted, when every part of it came in successfully: the newest workflow
/// with all its agents completed, else the lead's crew with all its tasks completed. Full, and
/// kept so while the lead still writes its answer after the last report and once the turn is over;
/// a failed, stopped or partial part is no success to show, so it gives no bar here.
fn all_in(thread: &Thread) -> Option<Progress> {
    let full = |total: usize, basis| Progress::Steps {
        done: total,
        total,
        basis,
    };
    if let Some(group) = agent_model(thread).workflows.last() {
        let members = group.members();
        if group.workflow.status == AgentStatus::Completed
            && !members.is_empty()
            && members.iter().all(|m| m.status == AgentStatus::Completed)
        {
            return Some(full(members.len(), Basis::Workflow));
        }
    }
    let board = crew_board(thread, thread.session_running())?;
    // The thread is already cut to its latest work, and a follow-up turn of the crew (an audit
    // fix, a late report) is part of it, so the board need not be the newest turn's.
    if board.tasks.is_empty() || !board.tasks.iter().all(|t| t.phase == CrewPhase::Completed) {
        return None;
    }
    // Filled to the last cell, but only the proven part solid: claimed work keeps its lighter tone.
    Some(
        crew_items(&board.tasks, Some(End::Done))
            .unwrap_or_else(|| full(board.tasks.len(), Basis::Crew)),
    )
}

/// The crew's items as one bar, when the board holds item-level evidence: some task has a TODO
/// list, or a task with none ended with a proof that is no proof. A task with no list is one item:
/// verified once it completed with `Verified` or with no proof at all (auditors and older servers
/// send none), claimed when it completed `NotVerified` or `Inconclusive`, failed or blocked as it
/// ended so, otherwise pending. `None` for a plain crew, which keeps counting tasks.
fn crew_items(tasks: &[CrewTask], end: Option<End>) -> Option<Progress> {
    let mut todos = CrewTodos::default();
    let mut evidence = false;
    for task in tasks {
        match task.todos {
            Some(list) => {
                evidence = true;
                todos.total += list.total;
                todos.verified += list.verified;
                todos.claimed += list.claimed;
                todos.failed += list.failed;
                todos.blocked += list.blocked;
                todos.out_of_scope += list.out_of_scope;
            }
            None => {
                todos.total += 1;
                match (task.phase, task.proof) {
                    (CrewPhase::Completed, Some(Proof::NotVerified | Proof::Inconclusive)) => {
                        evidence = true;
                        todos.claimed += 1;
                    }
                    (CrewPhase::Completed, _) => todos.verified += 1,
                    (CrewPhase::Failed, _) => todos.failed += 1,
                    (CrewPhase::Blocked, _) => todos.blocked += 1,
                    _ => {}
                }
            }
        }
    }
    evidence.then_some(Progress::Items(Items { todos, end }))
}

/// How far the running turn is; `None` while nothing runs, unless its work all came in (see
/// `all_in`), when the bar stays full.
pub fn progress_of(thread: &Thread) -> Option<Progress> {
    if !thread.session_running() {
        return all_in(thread);
    }
    let workflow = agent_model(thread)
        .workflows
        .into_iter()
        .find(|group| group.workflow.status.active() && !group.members().is_empty());
    if let Some(group) = workflow {
        let members = group.members();
        return Some(Progress::Steps {
            done: members.iter().filter(|m| m.status.terminal()).count(),
            total: members.len(),
            basis: Basis::Workflow,
        });
    }
    if let Some(board) = crew_board(thread, true)
        && board.current
        && board.running > 0
    {
        if let Some(items) = crew_items(&board.tasks, None) {
            return Some(items);
        }
        return Some(Progress::Steps {
            done: board.settled,
            total: board.tasks.len(),
            basis: Basis::Crew,
        });
    }
    let turn = thread
        .session
        .as_ref()
        .and_then(|s| s.active_turn_id.as_deref())
        .or(thread.latest_turn.as_ref().map(|t| t.turn_id.as_str()));
    if let Some((done, total)) = plan_counts(thread, turn) {
        return Some(Progress::Steps {
            done,
            total,
            basis: Basis::Plan,
        });
    }
    // A plan the lead is working through outranks the finished work before it; with none, the
    // finished work stays full while the lead writes its answer.
    if let Some(full) = all_in(thread) {
        return Some(full);
    }
    Some(Progress::Indeterminate)
}

/// The bar as `bar_width` cells: filled up to the share done, or a short marker that bounces
/// (still, with animations off) for a total nobody knows.
fn bar_cells(ctx: &Ctx, progress: Progress, bar_width: usize) -> Row {
    let done = match progress {
        Progress::Steps { done, total, .. } => done >= total,
        Progress::Items(items) => {
            items.end == Some(End::Done) && items.todos.proven() >= items.todos.total
        }
        _ => false,
    };
    let cells = cells_of_bar(
        ctx,
        progress,
        bar_width,
        (ctx.g.full, ctx.g.rule),
        if done { ctx.success() } else { ctx.accent() },
    );
    if is_unfinished_count(progress) {
        glow(ctx, cells)
    } else {
        cells
    }
}

/// A bar with a count whose work is not all in yet: the one the running glow belongs to. A bar
/// of an unknown total already has its bouncing marker, and an ended one nothing moves.
fn is_unfinished_count(progress: Progress) -> bool {
    match progress {
        Progress::Steps { done, total, .. } => done < total,
        Progress::Items(items) => items.end.is_none() && items.todos.finished() < items.todos.total,
        Progress::Indeterminate | Progress::Ended(_) => false,
    }
}

/// How strongly the glow lights a cell at 0, 1 and 2 cells from its centre.
const GLOW: [f32; 3] = [1.0, 0.6, 0.25];

/// `style` lit by `amount` (0 to 1): truecolor is mixed toward white, other colour levels take
/// white from the middle of the glow outward, and with no colour at all (NO_COLOR) it is bold.
fn lit(style: Style, amount: f32) -> Style {
    match style.fg {
        Some(Color::Rgb(r, g, b)) => {
            let mix = |c: u8| (f32::from(c) + (255.0 - f32::from(c)) * amount * 0.8).round() as u8;
            style.fg(Color::Rgb(mix(r), mix(g), mix(b)))
        }
        Some(Color::Reset) | None => style.add_modifier(Modifier::BOLD),
        Some(_) if amount >= 0.6 => style.fg(Color::White).add_modifier(Modifier::BOLD),
        Some(_) => style.add_modifier(Modifier::BOLD),
    }
}

/// A glow that runs across and back along the bar's cells with the clock: lit at its centre and
/// fading over two cells either side, entering and leaving past the ends. Still with animations
/// off. The caller says when work runs; this only moves the light.
fn glow(ctx: &Ctx, cells: Row) -> Row {
    let width = row_width(&cells);
    if !ctx.animations || width == 0 {
        return cells;
    }
    // A wide bar is crossed in about the time a narrow one is.
    let span = width + GLOW.len();
    let step = (ctx.tick * width.div_ceil(12)) % (span * 2);
    let centre =
        if step <= span { step } else { span * 2 - step } as isize - GLOW.len() as isize + 1;
    let mut out: Row = Vec::new();
    let mut at = 0isize;
    for cell in cells {
        for ch in cell.content.chars() {
            let amount = GLOW.get(at.abs_diff(centre)).copied();
            let style = amount.map_or(cell.style, |a| lit(cell.style, a));
            at += 1;
            match out.last_mut() {
                Some(last) if last.style == style => last.content.to_mut().push(ch),
                _ => out.push(sp(ch.to_string(), style)),
            }
        }
    }
    out
}

/// `bar_cells` with the glyphs (filled, empty) and the colour of the filled part to draw with.
fn cells_of_bar(
    ctx: &Ctx,
    progress: Progress,
    bar_width: usize,
    (full, empty): (&str, &str),
    fill_style: Style,
) -> Row {
    match progress {
        Progress::Items(items) => {
            let (verified, claimed) = item_cells(items, bar_width);
            vec![
                sp(full.repeat(verified), fill_style),
                sp(ctx.g.claimed.repeat(claimed), fill_style),
                sp(empty.repeat(bar_width - verified - claimed), ctx.dim()),
            ]
        }
        Progress::Steps { done, total, .. } => {
            let filled = ((done.min(total) * bar_width * 2 + total) / (total * 2)).min(bar_width);
            vec![
                sp(full.repeat(filled), fill_style),
                sp(empty.repeat(bar_width - filled), ctx.dim()),
            ]
        }
        Progress::Ended(end) => {
            let whole = matches!(end, End::Done | End::Failed | End::Blocked);
            let (cell, style) = if whole {
                (full, fill_style)
            } else {
                (empty, ctx.dim())
            };
            vec![sp(cell.repeat(bar_width), style)]
        }
        Progress::Indeterminate => {
            let marker = 3.min(bar_width);
            let span = bar_width - marker;
            let at = if ctx.animations && span > 0 {
                let cycle = span * 2;
                let step = ctx.tick % cycle;
                if step <= span { step } else { cycle - step }
            } else {
                0
            };
            vec![
                sp(empty.repeat(at), ctx.dim()),
                sp(full.repeat(marker), fill_style),
                sp(empty.repeat(span - at), ctx.dim()),
            ]
        }
    }
}

/// The least cells of a bar that still reads as one inside its ends, and the most it grows to.
const STATUS_BAR_MIN: usize = 6;
const STATUS_BAR_MAX: usize = 40;

/// The Savvy panel's bar in `room` cells: its ends around the filled and empty cells, then the
/// share and the count. Narrower, the count goes first, then the share; then the bare bar, then
/// the bar without its ends; with no room for even that, nothing. The colour is the state: success
/// once every step is done, warning while the user is asked, accent otherwise. The share rounds
/// down, and a bar never shows full or empty before the count is.
fn status_bar(ctx: &Ctx, progress: Progress, waiting: bool, room: usize) -> Row {
    let [block, empty] = ctx.g.block;
    let [left, right] = ctx.g.ends;
    let complete = match progress {
        Progress::Steps { done, total, .. } => done >= total,
        Progress::Ended(end) => end == End::Done,
        // A bar of claimed items is not a success, even when its task ended Done.
        Progress::Items(items) => match items.end {
            Some(end) => end == End::Done && items.todos.proven() >= items.todos.total,
            None => items.todos.proven() >= items.todos.total,
        },
        Progress::Indeterminate => false,
    };
    let tone = if complete {
        ctx.success()
    } else if matches!(
        progress,
        Progress::Ended(End::Failed | End::Blocked)
            | Progress::Items(Items {
                end: Some(End::Failed | End::Blocked),
                ..
            })
    ) {
        ctx.error()
    } else if waiting {
        ctx.warning()
    } else {
        ctx.accent()
    };
    let plain = |text: String| vec![(text, false)];
    let labels: Vec<Label> = match progress {
        Progress::Steps { done, total, .. } => {
            let percent = done.min(total) * 100 / total;
            vec![
                plain(format!("{percent}% {} {done}/{total}", ctx.g.separator)),
                plain(format!("{percent}%")),
            ]
        }
        Progress::Items(items) => item_labels(ctx, items),
        Progress::Indeterminate | Progress::Ended(_) => vec![plain(label_of(progress))],
    };
    let build = |bar_width: usize, label: &[(String, bool)], ends: bool| -> Row {
        let cells = match progress {
            // Rounding must not draw a full bar early or an empty one once something is done.
            Progress::Steps { done, total, .. } => {
                let want = match done.min(total) {
                    0 => 0,
                    n if n >= total => bar_width,
                    n => (n * bar_width / total)
                        .max(1)
                        .min(bar_width.saturating_sub(1)),
                };
                vec![
                    sp(block.repeat(want), tone),
                    sp(empty.repeat(bar_width - want), ctx.dim()),
                ]
            }
            Progress::Items(items) => {
                let (verified, claimed) = item_cells(items, bar_width);
                vec![
                    sp(block.repeat(verified), tone),
                    sp(ctx.g.claimed.repeat(claimed), tone),
                    sp(empty.repeat(bar_width - verified - claimed), ctx.dim()),
                ]
            }
            Progress::Indeterminate | Progress::Ended(_) => {
                cells_of_bar(ctx, progress, bar_width, (block, empty), tone)
            }
        };
        // Light runs along a bar only while its work does: not done, and not waiting for the user.
        let cells = if is_unfinished_count(progress) && !complete && !waiting {
            glow(ctx, cells)
        } else {
            cells
        };
        let mut row = Row::new();
        if ends {
            row.push(sp(left, ctx.dim()));
        }
        row.extend(cells);
        if ends {
            row.push(sp(right, ctx.dim()));
        }
        if !label.is_empty() {
            row.push(sp(" ", ctx.text()));
        }
        for (text, alarm) in label {
            let style = if *alarm {
                ctx.error()
            } else if complete {
                tone
            } else {
                ctx.text()
            };
            row.push(sp(text.clone(), style));
        }
        row
    };
    for label in labels.iter().filter(|label| !label.is_empty()) {
        let fixed = label_cells(label) + 3;
        if room >= fixed + STATUS_BAR_MIN {
            return build((room - fixed).min(STATUS_BAR_MAX), label, true);
        }
    }
    if room >= STATUS_BAR_MIN + 2 {
        return build((room - 2).min(STATUS_BAR_MAX), &[], true);
    }
    build(room.min(STATUS_BAR_MAX), &[], false)
}

/// A label as parts, each with whether it is drawn in the error colour.
type Label = Vec<(String, bool)>;

fn label_cells(label: &[(String, bool)]) -> usize {
    label.iter().map(|(text, _)| cells_of(text)).sum()
}

/// The labels of an item bar, longest first: `50% 10/20 │ 3 unproven │ 2 failed`, then without
/// what is unproven and the scope marker, then the share alone. The share and the count are of
/// proven items. Failed and blocked are words as well as a colour.
fn item_labels(ctx: &Ctx, items: Items) -> Vec<Label> {
    let todos = items.todos;
    let sep = ctx.g.separator;
    let head = format!("{}% {}/{}", items.percent(), todos.proven(), todos.total);
    let mut alarms: Label = Vec::new();
    for (n, template) in [
        (todos.failed, s("{n} failed", "실패 {n}")),
        (todos.blocked, s("{n} blocked", "막힘 {n}")),
    ] {
        if n > 0 {
            alarms.push((
                format!(" {sep} {}", fill(template, &[("n", n.to_string())])),
                true,
            ));
        }
    }
    let mut long: Label = vec![(head.clone(), false)];
    if todos.claimed > 0 {
        long.push((
            format!(
                " {sep} {}",
                fill(
                    s("{n} unproven", "미증명 {n}"),
                    &[("n", todos.claimed.to_string())]
                )
            ),
            false,
        ));
    }
    long.extend(alarms.clone());
    if todos.out_of_scope > 0 {
        long.push((
            format!(
                " {sep} {}",
                fill(
                    s("{n} out of scope", "범위 밖 {n}"),
                    &[("n", todos.out_of_scope.to_string())]
                )
            ),
            false,
        ));
    }
    let mut mid: Label = vec![(head, false)];
    mid.extend(alarms);
    vec![long, mid, vec![(format!("{}%", items.percent()), false)]]
}

/// Cells of a bar `width` wide that are verified and that are claimed. Rounding must not draw a
/// full bar early or an empty one once something is done, and a task that ended short of done
/// never fills the bar.
fn item_cells(items: Items, width: usize) -> (usize, usize) {
    let todos = items.todos;
    let finished = todos.finished();
    let ended_short = !matches!(items.end, None | Some(End::Done));
    let done_cells = match finished {
        0 => 0,
        n if n >= todos.total && !ended_short => width,
        n if n >= todos.total => width.saturating_sub(1).max(1).min(width),
        n => (n * width / todos.total)
            .max(1)
            .min(width.saturating_sub(1).max(1))
            .min(width),
    };
    if done_cells == width && todos.proven() >= todos.total {
        // Every item is proven and the task did not end short: the whole bar is one solid colour.
        // Items that are only claimed keep their lighter cells, so such a bar never reads as done.
        return (width, 0);
    }
    let mut verified = match todos.verified.min(todos.total) {
        0 => 0,
        n => (n * width / todos.total).max(1).min(done_cells),
    };
    if todos.claimed > 0 && done_cells >= 2 {
        verified = verified.min(done_cells - 1);
    }
    (verified, done_cells - verified)
}

fn label_of(progress: Progress) -> String {
    match progress {
        Progress::Steps { done, total, .. } => format!("{done}/{total}"),
        Progress::Items(items) => format!("{}/{}", items.todos.proven(), items.todos.total),
        Progress::Indeterminate => s("no total", "총량 없음").to_string(),
        Progress::Ended(end) => end.word().to_string(),
    }
}

/// The bar for the composer's border: a space, the bar, its label, a space. `None` when `room` is
/// too small for even a short bar.
pub fn input_bar(ctx: &Ctx, progress: Progress, room: usize) -> Option<Row> {
    let label = label_of(progress);
    let fixed = cells_of(&label) + 3;
    if room < fixed + INPUT_BAR_MIN {
        return None;
    }
    let bar_width = (room - fixed).min(INPUT_BAR_MAX);
    let mut row = vec![sp(" ", Style::default())];
    row.extend(bar_cells(ctx, progress, bar_width));
    row.push(sp(format!(" {label} "), ctx.dim()));
    Some(row)
}

/// Draws the bar on the right of the composer's top border while a turn runs; nothing when idle.
/// It keeps to the right half, so the composer's title is never covered.
pub fn draw_input_bar(frame: &mut Frame, composer: Rect, app: &App) {
    if composer.width < INPUT_BAR_COLUMNS || composer.height < 3 {
        return;
    }
    let progress = if app.request_pending() {
        Progress::Indeterminate
    } else if !app.conv.thread.session_running() {
        return;
    } else if let Some(progress) =
        progress_of(&crate::work_scope::latest_work(&app.conv.thread).thread)
    {
        progress
    } else {
        return;
    };
    // Nothing is progressing while the user is asked: no glow, no moving marker.
    let waiting = app.approval().is_some() || app.pending_input().is_some();
    let ctx = Ctx::new(
        &app.theme,
        &app.sym,
        app.tick,
        app.settings.animations && !waiting,
    );
    let room = usize::from(composer.width / 2).saturating_sub(2);
    let Some(row) = input_bar(&ctx, progress, room) else {
        return;
    };
    let cells = row_width(&row);
    let x = composer.right().saturating_sub(1 + cells as u16);
    frame.render_widget(
        Paragraph::new(Line::from(row)),
        Rect::new(x, composer.y, cells as u16, 1),
    );
}

// ---- the members --------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
    Working,
    /// Waits for the user (an approval or an answer).
    Waiting,
    Idle,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub role: String,
    pub model: Option<String>,
    /// 0 to 100; `None` when no window size was reported.
    pub ctx: Option<u8>,
    pub cost: Option<f64>,
    pub work: Work,
    /// The member's own bar; `None` for the lead, whose bar is the overall one above the crew.
    pub bar: Option<Progress>,
}

/// The last context-window report as a share of the window; `None` without a usable pair.
pub fn context_percent(thread: &Thread) -> Option<u8> {
    let report = thread.activities.iter().rev().find(|a| {
        a.kind == "context-window.updated"
            && a.payload["usedTokens"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
    })?;
    let used = report.payload["usedTokens"].as_f64()?;
    let max = report.payload["maxTokens"]
        .as_f64()
        .filter(|m| m.is_finite() && *m > 0.0)?;
    Some((used / max * 100.0).clamp(0.0, 100.0).round() as u8)
}

/// What the lead's session has cost: the growth of each running total Claude reported. A total
/// that fell is a session starting over; a zero says nothing. `None` when no report counts.
#[cfg(test)]
pub fn lead_cost(thread: &Thread) -> Option<f64> {
    lead_cost_in(thread, |_| true)
}

/// The same, counting only the growth the reports `counts` picks brought: the totals before them
/// are the starting point, so the cost of one piece of work is not the whole session's.
pub fn lead_cost_in(thread: &Thread, counts: impl Fn(&Activity) -> bool) -> Option<f64> {
    let mut reports: Vec<(String, String, f64, &Activity)> = Vec::new();
    for activity in thread.activities.iter().filter(|a| a.kind == "owned-usage") {
        let payload = &activity.payload;
        let source = &payload["source"];
        let (Some(driver), Some(cost)) = (source["driver"].as_str(), payload["costUsd"].as_f64())
        else {
            continue;
        };
        if payload["scope"] != "main-turn"
            || driver != "claudeAgent"
            || !cost.is_finite()
            || cost < 0.0
        {
            continue;
        }
        let key = source["runtimeEventId"]
            .as_str()
            .unwrap_or(&activity.id)
            .to_string();
        let session = format!("{driver}:{}", source["instanceId"].as_str().unwrap_or(""));
        match reports.iter_mut().find(|(k, ..)| *k == key) {
            Some(known) => *known = (key, session, cost, activity),
            None => reports.push((key, session, cost, activity)),
        }
    }
    let mut last: HashMap<&str, f64> = HashMap::new();
    let (mut total, mut any) = (0.0, false);
    for (_, session, cost, activity) in &reports {
        if *cost <= 0.0 {
            continue;
        }
        let before = last.get(session.as_str()).copied().unwrap_or(0.0);
        if counts(activity) {
            total += if *cost >= before {
                cost - before
            } else {
                *cost
            };
            any = true;
        }
        last.insert(session, *cost);
    }
    any.then_some(total)
}

fn role_name(role: &str) -> String {
    match role {
        "worker" => role_word(Role::Worker).to_string(),
        "expert" => role_word(Role::Expert).to_string(),
        "auditor" => role_word(Role::Auditor).to_string(),
        other => {
            let other = flat(other);
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        }
    }
}

/// The lead, the crew's tasks (only roles that started; unused roles get no row), and the provider's
/// subagents, each with what is known of it.
pub fn members(input: &FlowInput) -> Vec<Member> {
    let thread = input.thread;
    let running = thread.session_running();
    let lead_work = if input.lead_waiting.is_some() {
        Work::Waiting
    } else if running {
        Work::Working
    } else {
        Work::Idle
    };
    let mut out = vec![Member {
        role: s("Lead", "리드").to_string(),
        model: input
            .lead_model
            .as_deref()
            .map(flat)
            .filter(|m| !m.is_empty()),
        ctx: context_percent(thread),
        cost: input.lead_cost,
        work: lead_work,
        bar: None,
    }];
    let board = crew_board(
        thread,
        thread
            .session
            .as_ref()
            .is_some_and(|s| s.status == "running"),
    );
    let waiting = waiting_crew(input.children, thread);
    let mut task_ids: Vec<&str> = Vec::new();
    if let Some(board) = &board {
        for task in &board.tasks {
            task_ids.push(&task.task_id);
            let asks = task.thread_id.as_deref().is_some_and(|id| {
                waiting
                    .get(id)
                    .is_some_and(|w| matches!(w, Waiting::Approval | Waiting::Input))
            });
            out.push(Member {
                role: role_name(&task.role),
                model: task.model.as_deref().map(flat).filter(|m| !m.is_empty()),
                ctx: None,
                cost: task.cost,
                work: match task.phase {
                    CrewPhase::Running if asks => Work::Waiting,
                    CrewPhase::Running => Work::Working,
                    CrewPhase::Failed => Work::Failed,
                    _ => Work::Idle,
                },
                // A task with a TODO list has its items to count. Without one the data holds no
                // per-task count (its own thread is not loaded here), so a running task is
                // indeterminate and an ended one whole or empty by outcome.
                bar: Some(match (task.todos, task.phase) {
                    (Some(todos), phase) => Progress::Items(Items {
                        todos,
                        end: match phase {
                            CrewPhase::Running => None,
                            CrewPhase::Completed => Some(End::Done),
                            CrewPhase::Partial => Some(End::Partial),
                            CrewPhase::Blocked => Some(End::Blocked),
                            CrewPhase::Failed => Some(End::Failed),
                            CrewPhase::Stopped => Some(End::Stopped),
                        },
                    }),
                    (None, phase) => match phase {
                        CrewPhase::Running => Progress::Indeterminate,
                        CrewPhase::Completed => Progress::Ended(End::Done),
                        CrewPhase::Partial => Progress::Ended(End::Partial),
                        CrewPhase::Blocked => Progress::Ended(End::Blocked),
                        CrewPhase::Failed => Progress::Ended(End::Failed),
                        CrewPhase::Stopped => Progress::Ended(End::Stopped),
                    },
                }),
            });
        }
    }
    let roster = agent_model(thread);
    let nested = roster.workflows.iter().flat_map(|group| group.members());
    for agent in roster.direct.iter().chain(nested) {
        // A subagent that never started has no work to show.
        if task_ids.contains(&agent.id.as_str()) || agent.status == AgentStatus::Pending {
            continue;
        }
        out.push(Member {
            role: agent
                .role
                .as_deref()
                .map(role_name)
                .unwrap_or_else(|| role_word(Role::Subagent).to_string()),
            model: agent.model.as_deref().map(flat).filter(|m| !m.is_empty()),
            ctx: None,
            cost: None,
            work: match agent.status {
                AgentStatus::Running => Work::Working,
                AgentStatus::Waiting => Work::Waiting,
                AgentStatus::Failed => Work::Failed,
                _ => Work::Idle,
            },
            bar: Some(match agent.status {
                AgentStatus::Running | AgentStatus::Waiting => Progress::Indeterminate,
                AgentStatus::Failed => Progress::Ended(End::Failed),
                AgentStatus::Completed | AgentStatus::Idle => Progress::Ended(End::Done),
                // Pending is skipped above; it is listed only to keep the match exhaustive.
                AgentStatus::Cancelled | AgentStatus::Interrupted | AgentStatus::Pending => {
                    Progress::Ended(End::Stopped)
                }
            }),
        });
    }
    out
}

// ---- drawing ------------------------------------------------------------------------------------

fn dash() -> &'static str {
    "—"
}

fn work_word(work: Work) -> &'static str {
    match work {
        Work::Working => state_word(NodeState::Running),
        Work::Waiting => state_word(NodeState::Blocked),
        Work::Idle => s("Idle", "유휴"),
        Work::Failed => state_word(NodeState::Failed),
    }
}

/// The stats line of a member: `ctx 42% · cost $0.31 · Working`, `—` for what is not known.
pub fn stats_text(member: &Member) -> String {
    let ctx = member
        .ctx
        .map_or_else(|| dash().to_string(), |pct| format!("{pct}%"));
    let cost = member.cost.map_or_else(|| dash().to_string(), format_cost);
    format!(
        "ctx {ctx} · {} {cost} · {}",
        s("cost", "비용"),
        work_word(member.work)
    )
}

fn member_block(ctx: &Ctx, member: &Member, room: usize) -> Vec<Row> {
    let tone = match member.work {
        Work::Working => ctx.accent(),
        Work::Waiting => ctx.warning(),
        Work::Failed => ctx.error(),
        Work::Idle => ctx.dim(),
    };
    let model = match &member.model {
        Some(model) => sp(model.clone(), ctx.text()),
        None => sp(dash(), ctx.dim()),
    };
    let mut rows = vec![
        clip(
            vec![
                sp(member.role.clone(), ctx.bold()),
                sp("  ", ctx.text()),
                model,
            ],
            room,
        ),
        clip(vec![sp(stats_text(member), tone)], room),
    ];
    if let Some(progress) = member.bar {
        // Only a working member repaints the panel, so only its marker may move.
        let still = Ctx {
            th: ctx.th,
            g: ctx.g,
            spinner: ctx.spinner,
            ascii: ctx.ascii,
            tick: ctx.tick,
            animations: ctx.animations && member.work == Work::Working,
        };
        rows.push(status_bar(
            &still,
            progress,
            member.work == Work::Waiting,
            room,
        ));
    }
    rows
}

/// The Savvy panel as lines for a pane `width` x `height` cells.
pub fn lines(
    input: &FlowInput,
    width: usize,
    height: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let ctx = Ctx::new(th, sym, input.tick, input.animations);
    let room = width.saturating_sub(2).max(8);
    let mut out = head(&ctx, View::Savvy, room);
    if !input.online {
        out.push(margin(clip(
            vec![sp(
                s(
                    "Disconnected · showing what arrived last",
                    "연결 끊김 · 마지막으로 받은 내용",
                ),
                ctx.warning(),
            )],
            room,
        )));
    }
    if input.loading {
        out.extend(say(
            &ctx,
            if input.online {
                s("Loading the thread…", "스레드를 불러오는 중…")
            } else {
                s(
                    "The thread loads once you are connected.",
                    "연결되면 이 스레드를 불러옵니다.",
                )
            },
            room,
        ));
        return finish(&ctx, out, width, height);
    }
    let heading = |text: &str| vec![sp(text.to_string(), ctx.dim())];
    let mut body: Vec<Row> = vec![heading(s("Progress", "진행"))];
    // A request just sent has no work yet: a fresh bar stands for it until its message returns.
    let progress = if input.pending {
        Some(Progress::Indeterminate)
    } else {
        progress_of(input.thread)
    };
    match progress {
        None => body.push(vec![sp(
            s("Idle · nothing is running", "유휴 · 실행 중인 작업 없음"),
            ctx.dim(),
        )]),
        Some(progress) => {
            body.push(status_bar(
                &ctx,
                progress,
                input.lead_waiting.is_some(),
                room,
            ));
            body.push(vec![sp(
                match progress {
                    Progress::Steps { basis, .. } => basis.word().to_string(),
                    Progress::Items(_) => s("crew items", "crew 항목").to_string(),
                    Progress::Indeterminate | Progress::Ended(_) => s(
                        "working · the provider reported no total",
                        "작업 중 · 제공자가 총량을 알려 주지 않음",
                    )
                    .to_string(),
                },
                ctx.dim(),
            )]);
        }
    }
    body.push(vec![]);
    body.push(heading(s("Crew", "크루")));
    let all = members(input);
    let mut focus = None;
    let shown = all.len().min(MEMBER_LIMIT);
    for member in all.iter().take(shown) {
        if focus.is_none() && matches!(member.work, Work::Working | Work::Waiting) {
            focus = Some(body.len());
        }
        body.extend(member_block(&ctx, member, room));
        body.push(vec![]);
    }
    if all.len() > shown {
        body.push(vec![sp(
            fill(
                s("+{count} more", "그 외 {count}"),
                &[("count", (all.len() - shown).to_string())],
            ),
            ctx.dim(),
        )]);
    }
    let available = height.saturating_sub(out.len());
    let body: Vec<Row> = body
        .into_iter()
        .map(|row| margin(clip(row, room)))
        .collect();
    out.extend(window_scrolled(
        &ctx,
        body,
        focus.unwrap_or(0),
        available,
        input.scroll,
    ));
    finish(&ctx, out, width, height)
}

/// Work runs (or a request has just gone out) and animations are on, so the bar's glow and the
/// markers move with the clock.
pub fn is_live(input: &FlowInput) -> bool {
    input.animations
        && !input.loading
        && (input.pending
            || input.thread.session_running() && progress_of(input.thread).is_some()
            || members(input).iter().any(|m| m.work == Work::Working))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::CrewRoleModel;
    use crate::panels_common::plain;
    use crate::panels_common::scenes::{self, act, crew, input, thread};
    use crate::theme::{ASCII, LAVENDER, UNICODE};
    use serde_json::{Value, json};

    fn render(input: &FlowInput, width: usize, height: usize) -> Vec<String> {
        plain(&lines(input, width, height, &LAVENDER, &UNICODE))
    }

    fn ctx_of(tick: usize, animations: bool) -> Ctx<'static> {
        Ctx::new(&LAVENDER, &UNICODE, tick, animations)
    }

    fn text_of(row: &Row) -> String {
        row.iter().map(|s| s.content.as_ref()).collect()
    }

    fn plan(sec: i64, steps: &[(&str, &str)]) -> Value {
        let plan: Vec<Value> = steps
            .iter()
            .map(|(step, status)| json!({"step": step, "status": status}))
            .collect();
        act("turn.plan.updated", sec, json!({"plan": plan}))
    }

    // ---- where the bar's numbers come from ----

    #[test]
    fn nothing_runs_so_there_is_no_bar() {
        let idle = thread(
            vec![plan(2, &[("a", "completed"), ("b", "pending")])],
            false,
        );
        assert_eq!(progress_of(&idle), None);
    }

    #[test]
    fn the_plan_gives_done_of_total() {
        let t = thread(
            vec![
                plan(2, &[("a", "pending")]),
                plan(
                    5,
                    &[
                        ("a", "completed"),
                        ("b", "inProgress"),
                        ("c", "pending"),
                        ("  ", "pending"),
                    ],
                ),
            ],
            true,
        );
        assert_eq!(
            progress_of(&t),
            Some(Progress::Steps {
                done: 1,
                total: 3,
                basis: Basis::Plan
            }),
            "the newest plan counts, and a step with no text is no step"
        );
    }

    #[test]
    fn a_plan_of_an_earlier_turn_is_not_this_turns() {
        let mut old = plan(2, &[("a", "completed")]);
        old["turnId"] = json!("t0");
        assert_eq!(
            progress_of(&thread(vec![old], true)),
            Some(Progress::Indeterminate)
        );
    }

    #[test]
    fn crew_tasks_count_while_some_still_run_and_outrank_the_plan() {
        let t = scenes::failed();
        // the failed scene: w1 failed, e1 running
        let mut with_plan = t.activities.clone();
        with_plan.push(
            serde_json::from_value(plan(6, &[("a", "completed"), ("b", "pending")])).unwrap(),
        );
        let t = Thread {
            activities: with_plan,
            ..t
        };
        assert_eq!(
            progress_of(&t),
            Some(Progress::Steps {
                done: 1,
                total: 2,
                basis: Basis::Crew
            })
        );
        // every task has ended: the crew's count says nothing about the turn, the plan does
        let mut all_done = t.activities.clone();
        all_done.push(
            serde_json::from_value(crew(
                "task.completed",
                40,
                "e1",
                "expert",
                json!({"status": "completed"}),
            ))
            .unwrap(),
        );
        let t = Thread {
            activities: all_done,
            ..t
        };
        assert_eq!(
            progress_of(&t),
            Some(Progress::Steps {
                done: 1,
                total: 2,
                basis: Basis::Plan
            })
        );
    }

    #[test]
    fn a_running_workflow_counts_its_agents() {
        assert_eq!(
            progress_of(&scenes::workflow(false)),
            Some(Progress::Steps {
                done: 2,
                total: 4,
                basis: Basis::Workflow
            })
        );
    }

    #[test]
    fn with_no_total_anywhere_the_bar_is_indeterminate() {
        assert_eq!(
            progress_of(&scenes::lead_only()),
            Some(Progress::Indeterminate)
        );
    }

    // ---- ctx and cost ----

    #[test]
    fn context_is_the_last_report_over_the_window_and_dash_without_one() {
        let ctx = |sec, used: Value, max: Value| {
            act(
                "context-window.updated",
                sec,
                json!({"usedTokens": used, "maxTokens": max}),
            )
        };
        let t = thread(
            vec![
                ctx(2, json!(10), json!(100)),
                ctx(3, json!(42_000), json!(100_000)),
            ],
            false,
        );
        assert_eq!(context_percent(&t), Some(42));
        assert_eq!(
            context_percent(&thread(vec![ctx(2, json!(5), Value::Null)], false)),
            None,
            "no window size"
        );
        assert_eq!(
            context_percent(&thread(vec![ctx(2, json!(5), json!(0))], false)),
            None
        );
        // a report with no usable count does not shadow the one before it
        let t = thread(
            vec![
                ctx(2, json!(50), json!(100)),
                ctx(3, json!("x"), json!(100)),
            ],
            false,
        );
        assert_eq!(context_percent(&t), Some(50));
        let over = thread(vec![ctx(2, json!(300), json!(100))], false);
        assert_eq!(context_percent(&over), Some(100));
        assert_eq!(context_percent(&thread(vec![], false)), None);
    }

    fn usage(sec: i64, id: &str, driver: &str, cost: f64) -> Value {
        act(
            "owned-usage",
            sec,
            json!({"scope": "main-turn", "costUsd": cost, "source": {"driver": driver, "instanceId": "i", "runtimeEventId": id}}),
        )
    }

    #[test]
    fn the_lead_cost_is_the_growth_of_claudes_running_totals_and_nothing_else() {
        let t = thread(
            vec![
                usage(2, "e1", "claudeAgent", 0.10),
                usage(3, "e2", "claudeAgent", 0.25),
                usage(4, "e3", "claudeAgent", 0.05),
            ],
            false,
        );
        // 0.10, then +0.15, then the total fell to 0.05: a new session adds all of it
        let cost = lead_cost(&t).unwrap();
        assert!((cost - 0.30).abs() < 1e-9, "{cost}");
        assert_eq!(
            lead_cost(&thread(vec![usage(2, "e1", "codex", 3.0)], false)),
            None,
            "another driver's meaning is unknown"
        );
        assert_eq!(
            lead_cost(&thread(vec![usage(2, "e1", "claudeAgent", 0.0)], false)),
            None,
            "a zero says nothing"
        );
        assert_eq!(lead_cost(&thread(vec![], false)), None);
        let mut child = usage(2, "e1", "claudeAgent", 1.0);
        child["payload"]["scope"] = json!("child");
        assert_eq!(lead_cost(&thread(vec![child], false)), None);
    }

    #[test]
    fn each_member_shows_what_is_known_and_a_dash_for_the_rest() {
        let mut activities = scenes::failed().activities;
        activities.push(
            serde_json::from_value(act(
                "context-window.updated",
                7,
                json!({"usedTokens": 30, "maxTokens": 100}),
            ))
            .unwrap_or_default(),
        );
        let t = Thread {
            activities,
            ..scenes::failed()
        };
        let roles = [
            CrewRoleModel {
                role: "worker",
                model: Some("sonnet".into()),
            },
            CrewRoleModel {
                role: "auditor",
                model: None,
            },
        ];
        let mut i = input(&t, &[], 45);
        i.crew = Some(&roles);
        let all = members(&i);
        let lead = &all[0];
        assert_eq!(
            (
                lead.role.as_str(),
                lead.model.as_deref(),
                lead.ctx,
                lead.cost
            ),
            ("Lead", Some("claude-opus-5"), Some(30), None)
        );
        assert_eq!(lead.work, Work::Working);
        let worker = all.iter().find(|m| m.role == "Worker").unwrap();
        assert_eq!((worker.work, worker.ctx), (Work::Failed, None));
        assert_eq!(worker.cost, None, "the failed task reported no cost");
        let expert = all.iter().find(|m| m.role == "Expert").unwrap();
        assert_eq!(expert.work, Work::Working);
        assert!(
            all.iter().all(|m| m.role != "Auditor"),
            "a role set up and not used has no row"
        );
        assert_eq!(stats_text(lead), "ctx 30% · cost — · Working");
    }

    #[test]
    fn only_members_that_started_have_a_bar() {
        let roles = [
            CrewRoleModel {
                role: "worker",
                model: None,
            },
            CrewRoleModel {
                role: "expert",
                model: None,
            },
            CrewRoleModel {
                role: "auditor",
                model: None,
            },
        ];
        let started =
            |role: &str, id: &str| crew("task.started", 5, id, role, json!({"title": "T"}));
        let mut t = thread(vec![started("worker", "w1")], true);
        let names = |t: &Thread| {
            let mut i = input(t, &[], 45);
            i.crew = Some(&roles);
            members(&i).into_iter().map(|m| m.role).collect::<Vec<_>>()
        };
        assert_eq!(names(&t), ["Lead", "Worker"]);
        t.activities
            .push(serde_json::from_value(started("auditor", "a1")).unwrap_or_default());
        assert_eq!(names(&t), ["Lead", "Worker", "Auditor"]);
    }

    #[test]
    fn a_crew_task_reports_its_own_cost_when_the_provider_gave_one() {
        let t = thread(
            vec![
                crew("task.started", 5, "w1", "worker", json!({"title": "Fix"})),
                crew(
                    "task.completed",
                    30,
                    "w1",
                    "worker",
                    json!({"status": "completed", "usage": {"inputTokens": 100, "outputTokens": 50, "costUsd": 0.42}}),
                ),
            ],
            false,
        );
        let all = members(&input(&t, &[], 45));
        let worker = all.iter().find(|m| m.role == "Worker").unwrap();
        assert_eq!(worker.cost, Some(0.42));
        assert_eq!(worker.work, Work::Idle);
        assert!(stats_text(worker).contains("cost $0.42"));
    }

    // ---- the bar ----

    #[test]
    fn the_bar_fills_by_the_real_share_and_never_says_a_percent() {
        let ctx = ctx_of(0, true);
        let bar = |done, total| {
            text_of(&bar_cells(
                &ctx,
                Progress::Steps {
                    done,
                    total,
                    basis: Basis::Plan,
                },
                10,
            ))
        };
        assert_eq!(bar(0, 4), "──────────");
        assert_eq!(bar(1, 4), "━━━───────");
        assert_eq!(bar(2, 4), "━━━━━─────");
        assert_eq!(bar(4, 4), "━━━━━━━━━━");
        assert_eq!(
            bar(9, 4),
            "━━━━━━━━━━",
            "more done than the total holds the bar full"
        );
        let row = input_bar(
            &ctx,
            Progress::Steps {
                done: 3,
                total: 7,
                basis: Basis::Crew,
            },
            30,
        )
        .unwrap();
        let text = text_of(&row);
        assert!(text.contains("3/7") && !text.contains('%'), "{text:?}");
    }

    fn steps(done: usize, total: usize) -> Progress {
        Progress::Steps {
            done,
            total,
            basis: Basis::Plan,
        }
    }

    fn bar_text(progress: Progress, waiting: bool, room: usize) -> String {
        text_of(&status_bar(&ctx_of(0, true), progress, waiting, room))
    }

    #[test]
    fn the_status_bar_has_ends_cells_a_share_and_a_count() {
        let cells =
            |full: usize, empty: usize| format!("{}{}", "█".repeat(full), "░".repeat(empty));
        assert_eq!(
            bar_text(steps(1, 4), false, 30),
            format!("▕{}▏ 25% │ 1/4", cells(4, 14))
        );
        assert_eq!(
            bar_text(steps(4, 4), false, 30),
            format!("▕{}▏ 100% │ 4/4", cells(17, 0))
        );
        assert_eq!(
            bar_text(steps(0, 4), false, 24),
            format!("▕{}▏ 0% │ 0/4", cells(0, 13))
        );
        assert_eq!(
            bar_text(steps(2, 3), false, 30),
            format!("▕{}▏ 66% │ 2/3", cells(12, 6)),
            "the share rounds down"
        );
        let ascii = Ctx::new(&LAVENDER, &ASCII, 0, true);
        assert_eq!(
            text_of(&status_bar(&ascii, steps(1, 2), false, 20)),
            "[####----] 50% | 1/2"
        );
    }

    #[test]
    fn the_bar_is_never_full_or_empty_before_the_count_is() {
        for total in [3, 7, 50, 200] {
            let bar = |done| bar_text(steps(done, total), false, 20);
            assert!(
                !bar(1).contains('░') || bar(1).contains('█'),
                "{total}: something is done"
            );
            assert!(bar(total - 1).contains('░'), "{total}: one step is left");
            assert!(!bar(total).contains('░'), "{total}: all done");
            assert!(!bar(0).contains('█'), "{total}: nothing done");
        }
    }

    #[test]
    fn the_status_bar_gives_up_the_count_then_the_share_then_its_ends() {
        let p = steps(1, 4);
        assert!(
            bar_text(p, false, 16).ends_with(" 25%"),
            "{}",
            bar_text(p, false, 16)
        );
        assert!(!bar_text(p, false, 16).contains('/'));
        let bare = bar_text(p, false, 11);
        assert!(
            bare.starts_with('▕') && bare.ends_with('▏') && !bare.contains('%'),
            "{bare}"
        );
        let ends_gone = bar_text(p, false, 7);
        assert_eq!(ends_gone, "█░░░░░░", "{ends_gone}");
        for progress in [p, steps(0, 1), steps(9, 9), Progress::Indeterminate] {
            for room in 0..70 {
                for ctx in [ctx_of(3, true), Ctx::new(&LAVENDER, &ASCII, 3, false)] {
                    let row = status_bar(&ctx, progress, false, room);
                    assert!(row_width(&row) <= room, "{progress:?} {room}");
                }
            }
        }
        assert!(bar_text(Progress::Indeterminate, false, 30).contains("no total"));
        assert!(!bar_text(Progress::Indeterminate, false, 12).contains("no total"));
    }

    #[test]
    fn the_bar_takes_the_colour_of_the_work_state() {
        let fill = |progress, waiting| {
            status_bar(&ctx_of(0, false), progress, waiting, 30)
                .iter()
                .find(|span| span.content.contains('█'))
                .and_then(|span| span.style.fg)
        };
        assert_eq!(fill(steps(1, 4), false), Some(LAVENDER.accent), "running");
        assert_eq!(
            fill(steps(1, 4), true),
            Some(LAVENDER.warning),
            "waiting for the user"
        );
        assert_eq!(fill(steps(4, 4), false), Some(LAVENDER.success), "done");
        assert_ne!(LAVENDER.accent, LAVENDER.warning);
        assert_ne!(LAVENDER.warning, LAVENDER.success);
    }

    #[test]
    fn an_unknown_total_is_a_labelled_marker_that_moves_only_with_animations() {
        let at = |tick, animations| {
            text_of(&input_bar(&ctx_of(tick, animations), Progress::Indeterminate, 30).unwrap())
        };
        let still: Vec<String> = (0..6).map(|n| at(n, false)).collect();
        assert!(still.windows(2).all(|w| w[0] == w[1]), "{still:?}");
        let moving: Vec<String> = (0..6).map(|n| at(n, true)).collect();
        assert!(moving.windows(2).any(|w| w[0] != w[1]));
        for text in still.iter().chain(&moving) {
            assert!(
                text.contains("no total") && !text.contains('%') && !text.contains('/'),
                "{text:?}"
            );
        }
    }

    #[test]
    fn the_bar_takes_the_room_it_is_given_and_goes_when_there_is_none() {
        for progress in [
            Progress::Indeterminate,
            Progress::Steps {
                done: 12,
                total: 99,
                basis: Basis::Plan,
            },
        ] {
            for room in 0..40 {
                if let Some(row) = input_bar(&ctx_of(3, true), progress, room) {
                    assert!(row_width(&row) <= room, "{room}: {}", row_width(&row));
                    assert!(row_width(&row) <= INPUT_BAR_MAX + 12);
                }
            }
            assert!(input_bar(&ctx_of(0, true), progress, 8).is_none());
        }
    }

    // ---- the bar: complete, running, and no walker ----

    fn styles_of(row: &Row) -> Vec<Style> {
        row.iter()
            .flat_map(|s| s.content.chars().map(|_| s.style))
            .collect()
    }

    #[test]
    fn a_completed_bar_is_filled_to_the_last_cell_at_every_width() {
        let ctx = ctx_of(0, false);
        // The cells between the ends, whichever label rides beside them.
        let cells = |progress, room| -> String {
            let text = text_of(&status_bar(&ctx, progress, false, room));
            text.chars()
                .skip(1)
                .take_while(|c| *c != '\u{258f}')
                .collect()
        };
        for room in [9, 12, 25, 42, 60] {
            for total in [3, 5, 7] {
                let bars = [
                    cells(steps(total, total), room),
                    cells(Progress::Items(items(total, total, 0, None)), room),
                ];
                for bar in bars {
                    assert!(bar.chars().count() >= STATUS_BAR_MIN, "{room}/{total}");
                    assert!(bar.chars().all(|c| c == '█'), "{room}/{total}: {bar}");
                }
                // Items all in but the last ones only claimed: filled to the last cell, yet the
                // claimed ones stay a lighter tone, so the bar is never the solid success bar.
                for (verified, claimed) in [(total - 1, 1), (0, total)] {
                    let bar = cells(Progress::Items(items(total, verified, claimed, None)), room);
                    assert!(bar.chars().count() >= STATUS_BAR_MIN, "{room}/{total}");
                    assert!(
                        bar.chars().all(|c| c == '█' || c == '▒') && bar.contains('▒'),
                        "{room}/{total}: {bar}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_claimed_tail_stays_while_the_items_are_not_all_in() {
        let text = item_text(items(4, 1, 2, None), false, 32);
        assert!(text.contains('▒') && text.contains('░'), "{text}");
    }

    #[test]
    fn the_glow_runs_while_work_runs_and_stops_when_it_does_not() {
        let at = |tick, animations, progress, waiting| {
            styles_of(&status_bar(
                &ctx_of(tick, animations),
                progress,
                waiting,
                30,
            ))
        };
        let running = steps(2, 5);
        let frames: Vec<_> = (0..6).map(|t| at(t, true, running, false)).collect();
        assert!(
            frames.windows(2).all(|w| w[0] != w[1]),
            "it moves every tick"
        );
        let still = at(0, false, running, false);
        assert!(
            (0..6).all(|t| at(t, false, running, false) == still),
            "animations off"
        );
        assert!(frames.iter().all(|f| *f != still), "and it is a glow");
        let done = steps(5, 5);
        assert_eq!(at(0, true, done, false), at(3, true, done, false), "done");
        assert_eq!(
            at(0, true, running, true),
            at(3, true, running, true),
            "waiting"
        );
        // the composer's border bar glows the same way
        let bar = |tick, progress| styles_of(&bar_cells(&ctx_of(tick, true), progress, 20));
        assert_ne!(bar(0, running), bar(4, running));
        assert_eq!(bar(0, done), bar(4, done));
        // an idle session has no bar at all
        let idle = thread(vec![], false);
        assert_eq!(progress_of(&idle), None);
        let mut i = input(&idle, &[], 5);
        i.animations = true;
        assert!(!render(&i, 40, 30).join("\n").contains('█'));
        assert!(!is_live(&i));
    }

    #[test]
    fn the_glow_falls_back_without_truecolor() {
        assert_eq!(
            lit(Style::default().fg(Color::Cyan), 1.0).fg,
            Some(Color::White)
        );
        assert!(
            lit(Style::default(), 1.0)
                .add_modifier
                .contains(Modifier::BOLD)
        );
        assert_eq!(
            lit(Style::default().fg(Color::Rgb(0, 0, 0)), 1.0).fg,
            Some(Color::Rgb(204, 204, 204))
        );
    }

    #[test]
    fn a_member_block_has_no_walking_figure() {
        let t = crew_thread();
        let mut i = input(&t, &[], 45);
        i.animations = true;
        let text = render(&i, 40, 60).join("\n");
        assert!(
            !text.contains('▀') && !text.contains('▄') && !text.contains('▌'),
            "{text}"
        );
    }

    // ---- a bar whose work is all in while the lead is still finishing ----

    /// The parallel scene with both crew tasks reported completed.
    fn crew_all_in(running: bool) -> Thread {
        let mut acts = scenes::parallel().activities;
        for (sec, id, role) in [(30, "w1", "worker"), (31, "e1", "expert")] {
            acts.push(
                serde_json::from_value(crew(
                    "task.completed",
                    sec,
                    id,
                    role,
                    json!({"status": "completed"}),
                ))
                .unwrap(),
            );
        }
        Thread {
            activities: acts,
            ..thread(vec![], running)
        }
    }

    fn all_in(total: usize, basis: Basis) -> Option<Progress> {
        Some(Progress::Steps {
            done: total,
            total,
            basis,
        })
    }

    #[test]
    fn a_crew_whose_tasks_are_all_in_stays_a_full_bar_while_the_lead_finishes() {
        let t = crew_all_in(true);
        assert!(t.session_running());
        assert_eq!(progress_of(&t), all_in(2, Basis::Crew));
        // the turn is over: the end state still reads complete
        assert_eq!(progress_of(&crew_all_in(false)), all_in(2, Basis::Crew));
    }

    /// A finished worker with `counts(5, verified, claimed, 0, 0)` items, in a turn that is over.
    fn finished_worker(verified: usize, claimed: usize, running: bool) -> Thread {
        let mut done = crew("task.completed", 8, "w1", "worker", json!({}));
        done["payload"]["status"] = json!("completed");
        thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew(
                    "task.progress",
                    4,
                    "w1",
                    "worker",
                    counts(5, verified, claimed, 0, 0),
                ),
                done,
            ],
            running,
        )
    }

    fn bar_row(progress: Progress, room: usize) -> (String, Row) {
        let ctx = Ctx::new(&LAVENDER, &UNICODE, 0, false);
        let row = status_bar(&ctx, progress, false, room);
        (text_of(&row), row)
    }

    #[test]
    fn a_finished_crew_bar_is_whole_but_shows_unproven_work_lighter() {
        for running in [true, false] {
            let progress = progress_of(&finished_worker(3, 2, running)).unwrap();
            assert_eq!(progress, Progress::Items(items(5, 3, 2, Some(End::Done))));
            let (text, row) = bar_row(progress, 40);
            assert!(!text.contains('░'), "{text}");
            assert!(text.contains('▒') && text.contains('█'), "{text}");
            assert!(text.contains("60% 3/5 │ 2 unproven"), "{text}");
            let ctx = Ctx::new(&LAVENDER, &UNICODE, 0, false);
            assert!(row.iter().all(|c| c.style != ctx.success()), "{text}");
            // the composer's bar is whole too
            let composer = text_of(&bar_cells(&ctx, progress, 20));
            assert!(
                !composer.contains('░') && composer.contains('▒'),
                "{composer}"
            );
        }
    }

    #[test]
    fn a_finished_crew_with_every_item_proven_is_a_solid_success_bar() {
        let progress = progress_of(&finished_worker(5, 0, false)).unwrap();
        let ctx = Ctx::new(&LAVENDER, &UNICODE, 0, false);
        let (text, row) = bar_row(progress, 40);
        let bar: String = text.chars().filter(|c| "█▒░".contains(*c)).collect();
        assert!(!bar.is_empty() && bar.chars().all(|c| c == '█'), "{text}");
        assert!(row.iter().any(|c| c.style == ctx.success()));
        let composer = text_of(&bar_cells(&ctx, progress, 20));
        assert_eq!(composer, ctx.g.full.repeat(20));
    }

    #[test]
    fn a_task_without_a_list_is_one_item_by_its_proof() {
        let one = |proof: Option<&str>| {
            let mut done = crew("task.completed", 8, "e1", "expert", json!({}));
            done["payload"]["status"] = json!("completed");
            if let Some(proof) = proof {
                done["payload"]["proof"] = json!(proof);
            }
            let t = thread(
                vec![crew("task.started", 3, "e1", "expert", json!({})), done],
                false,
            );
            progress_of(&t)
        };
        assert_eq!(
            one(Some("inconclusive")),
            Some(Progress::Items(items(1, 0, 1, Some(End::Done))))
        );
        assert_eq!(
            one(Some("not-verified")),
            Some(Progress::Items(items(1, 0, 1, Some(End::Done))))
        );
        // no proof field (an auditor, an older server) counts as done, as a plain full bar
        assert_eq!(one(None), all_in(1, Basis::Crew));
        assert_eq!(one(Some("verified")), all_in(1, Basis::Crew));
        // with a list beside it, the no-proof task is a verified item
        let mut done = crew("task.completed", 8, "e1", "expert", json!({}));
        done["payload"]["status"] = json!("completed");
        let mut worker = crew("task.completed", 8, "w1", "worker", json!({}));
        worker["payload"]["status"] = json!("completed");
        let t = thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew("task.progress", 4, "w1", "worker", counts(2, 1, 1, 0, 0)),
                worker,
                crew("task.started", 3, "e1", "expert", json!({})),
                done,
            ],
            false,
        );
        assert_eq!(
            progress_of(&t),
            Some(Progress::Items(items(3, 2, 1, Some(End::Done))))
        );
    }

    #[test]
    fn a_workflow_whose_agents_are_all_in_stays_a_full_bar_while_the_lead_finishes() {
        assert_eq!(
            progress_of(&scenes::workflow_in(true, true)),
            all_in(4, Basis::Workflow)
        );
        assert_eq!(
            progress_of(&scenes::workflow_in(true, false)),
            all_in(4, Basis::Workflow)
        );
    }

    #[test]
    fn a_failed_or_stopped_end_is_not_painted_as_a_full_bar() {
        // w1 failed, e1 reported: no success to show, the plan or the unknown total takes over
        let mut t = scenes::failed();
        t.activities.push(
            serde_json::from_value(crew(
                "task.completed",
                40,
                "e1",
                "expert",
                json!({"status": "completed"}),
            ))
            .unwrap(),
        );
        assert!(!matches!(
            progress_of(&t),
            Some(Progress::Steps {
                basis: Basis::Crew,
                ..
            })
        ));
        // an idle thread with no work still has no bar
        assert_eq!(progress_of(&thread(vec![], false)), None);
    }

    #[test]
    fn the_finished_bar_is_solid_in_the_panel_and_on_the_composer_border() {
        for (progress, total) in [
            (progress_of(&crew_all_in(true)), 2),
            (progress_of(&scenes::workflow_in(true, true)), 4),
        ] {
            let progress = progress.expect("a bar");
            assert_eq!(
                progress,
                Progress::Steps {
                    done: total,
                    total,
                    basis: match total {
                        2 => Basis::Crew,
                        _ => Basis::Workflow,
                    }
                }
            );
            let ctx = ctx_of(7, true);
            for width in [7, 10, 23, 40] {
                // the bare bar between its ends
                let row = status_bar(&ctx, progress, false, width + 2);
                let cells: Vec<_> = row.iter().filter(|s| s.content.contains('█')).collect();
                let count: usize = cells.iter().map(|s| s.content.chars().count()).sum();
                assert!(count >= STATUS_BAR_MIN, "{width}");
                assert!(!text_of(&row).contains('░'), "{width}: {}", text_of(&row));
                assert!(
                    cells.iter().all(|s| s.style.fg == Some(LAVENDER.success)),
                    "success colour and no glow"
                );
                // the composer's border bar
                let border = bar_cells(&ctx, progress, width);
                assert_eq!(text_of(&border), "━".repeat(width), "{width}");
                assert!(
                    border
                        .iter()
                        .filter(|s| !s.content.is_empty())
                        .all(|s| s.style == ctx.success()),
                    "success colour, no glow"
                );
            }
        }
    }

    #[test]
    fn a_running_plan_outranks_a_workflow_that_is_all_in() {
        let mut t = scenes::workflow_in(true, true);
        t.activities.push(
            serde_json::from_value(plan(
                80,
                &[
                    ("a", "completed"),
                    ("b", "completed"),
                    ("c", "inProgress"),
                    ("d", "pending"),
                    ("e", "pending"),
                ],
            ))
            .unwrap(),
        );
        assert_eq!(
            progress_of(&t),
            Some(Progress::Steps {
                done: 2,
                total: 5,
                basis: Basis::Plan
            })
        );
    }

    // ---- the panel ----

    fn live_scene() -> Thread {
        let mut activities = scenes::parallel().activities;
        activities.push(
            serde_json::from_value(act(
                "context-window.updated",
                7,
                json!({"usedTokens": 42_000, "maxTokens": 100_000}),
            ))
            .unwrap_or_default(),
        );
        activities
            .push(serde_json::from_value(usage(8, "u1", "claudeAgent", 0.31)).unwrap_or_default());
        Thread {
            activities,
            ..scenes::parallel()
        }
    }

    #[test]
    fn the_panel_lists_each_member_with_role_model_ctx_cost() {
        let t = live_scene();
        let mut i = input(&t, &[], 45);
        let roles = [CrewRoleModel {
            role: "auditor",
            model: Some("opus-5".into()),
        }];
        i.crew = Some(&roles);
        let text = render(&i, 40, 30);
        let expected = [
            " Workflow │ Agents │ Savvy │ Files",
            " ────────────────────━━━━━─────────────",
            " Progress",
            " ▕░░░░░░░░░░░░░░░░░░░░░░░░░░░▏ 0% │ 0/2",
            " crew tasks",
            " ",
            " Crew",
            " Lead  claude-opus-5",
            " ctx 42% · cost $0.31 · Working",
            " ",
            " Worker  claude-sonnet-5",
            " ctx — · cost — · Working",
            " ▕███░░░░░░░░░░░░░░░░░░░░░░░░▏ no total",
            " ",
            " Expert  claude-sonnet-5",
            " ctx — · cost — · Working",
            " ▕███░░░░░░░░░░░░░░░░░░░░░░░░▏ no total",
            " ",
        ];
        assert_eq!(text, expected);
    }

    #[test]
    fn idle_is_said_in_words_and_no_bar_is_drawn() {
        let t = thread(vec![], false);
        let text = render(&input(&t, &[], 45), 40, 20);
        assert!(
            text.iter().any(|l| l.contains("Idle · nothing is running")),
            "{text:#?}"
        );
        assert!(
            !text.iter().skip(2).any(|l| l.contains('━')),
            "no bar while idle"
        );
    }

    #[test]
    fn the_panel_fits_every_size_and_both_symbol_sets() {
        let t = live_scene();
        for (w, h) in [(8, 3), (20, 6), (33, 5), (36, 24), (50, 10), (72, 40)] {
            for (th, sym) in [(&LAVENDER, &UNICODE), (&LAVENDER, &ASCII)] {
                let mut i = input(&t, &[], 45);
                i.animations = true;
                i.tick = 5;
                let rows = lines(&i, w, h, th, sym);
                assert!(rows.len() <= h, "{w}x{h}: {}", rows.len());
                for line in plain(&rows) {
                    assert!(crate::text::width(&line) <= w, "{w}x{h}: {line:?}");
                }
            }
        }
    }

    #[test]
    fn many_members_are_folded_into_a_count() {
        let mut activities = Vec::new();
        for n in 0..15 {
            activities.push(crew(
                "task.started",
                5,
                &format!("w{n}"),
                "worker",
                json!({"title": "x"}),
            ));
        }
        let t = thread(activities, true);
        let text = render(&input(&t, &[], 45), 40, 80);
        assert!(text.iter().any(|l| l.contains("more")), "{text:#?}");
        assert_eq!(
            text.iter().filter(|l| l.contains("Worker")).count(),
            MEMBER_LIMIT - 1
        );
    }

    #[test]
    fn the_clock_runs_only_while_a_member_works_and_animations_are_on() {
        let t = live_scene();
        let mut i = input(&t, &[], 45);
        assert!(!is_live(&i), "animations are off");
        i.animations = true;
        assert!(is_live(&i));
        i.loading = true;
        assert!(!is_live(&i));
        let idle = thread(vec![], false);
        let mut i = input(&idle, &[], 45);
        i.animations = true;
        assert!(!is_live(&i), "nothing works, nothing repaints");
        let mut waiting = input(&t, &[], 45);
        waiting.animations = true;
        waiting.lead_waiting = Some(Waiting::Approval);
        assert!(members(&waiting)[0].work == Work::Waiting);
    }

    // ---- one bar per crew member ----

    fn crew_thread() -> Thread {
        thread(
            vec![
                crew("task.started", 5, "w1", "worker", json!({"title": "A"})),
                crew("task.started", 6, "e1", "expert", json!({"title": "B"})),
                crew("task.started", 7, "w2", "worker", json!({"title": "C"})),
                crew("task.started", 8, "w3", "worker", json!({"title": "D"})),
                crew(
                    "task.completed",
                    20,
                    "w2",
                    "worker",
                    json!({"status": "completed"}),
                ),
                crew(
                    "task.completed",
                    21,
                    "w3",
                    "worker",
                    json!({"status": "failed", "summary": "boom"}),
                ),
            ],
            true,
        )
    }

    fn bars_of(i: &FlowInput, width: usize) -> Vec<String> {
        let all = members(i);
        let ctx = ctx_of(0, false);
        all.iter()
            .filter_map(|m| m.bar)
            .map(|p| text_of(&status_bar(&ctx, p, false, width)))
            .collect()
    }

    #[test]
    fn each_crew_member_has_its_own_bar_by_its_own_state() {
        let t = crew_thread();
        let i = input(&t, &[], 45);
        let all = members(&i);
        assert_eq!(all[0].bar, None, "the lead keeps the overall bar");
        let bars: Vec<_> = all.iter().filter_map(|m| m.bar).collect();
        assert_eq!(
            bars,
            [
                Progress::Indeterminate,
                Progress::Indeterminate,
                Progress::Ended(End::Done),
                Progress::Ended(End::Failed),
            ]
        );
        let text = bars_of(&i, 30);
        assert!(
            text[0].contains("no total") && !text[0].contains('%'),
            "{text:?}"
        );
        assert!(
            text[1].contains("no total") && !text[1].contains('%'),
            "{text:?}"
        );
        assert_eq!(text[2], format!("▕{}▏ Done", "█".repeat(23)));
        assert_eq!(text[3], format!("▕{}▏ Failed", "█".repeat(21)));
    }

    #[test]
    fn done_is_success_failed_is_error_waiting_is_warning_and_a_stop_is_empty() {
        let ctx = ctx_of(0, false);
        let fill = |progress, waiting| {
            let row = status_bar(&ctx, progress, waiting, 30);
            row.iter()
                .find(|c| c.content.contains('█'))
                .map(|c| c.style)
        };
        assert_eq!(fill(Progress::Ended(End::Done), false), Some(ctx.success()));
        assert_eq!(fill(Progress::Ended(End::Failed), false), Some(ctx.error()));
        assert_eq!(
            fill(Progress::Ended(End::Blocked), false),
            Some(ctx.error())
        );
        assert_eq!(fill(Progress::Indeterminate, true), Some(ctx.warning()));
        assert_eq!(fill(Progress::Indeterminate, false), Some(ctx.accent()));
        for end in [End::Partial, End::Stopped] {
            let text = text_of(&status_bar(&ctx, Progress::Ended(end), false, 30));
            assert!(!text.contains('█') && text.ends_with(end.word()), "{text}");
        }
        // The word beside the bar carries the state without colour.
        assert!(
            text_of(&status_bar(&ctx, Progress::Ended(End::Blocked), false, 30))
                .ends_with("Blocked")
        );
    }

    #[test]
    fn a_working_member_marker_moves_but_a_waiting_one_does_not() {
        let t = crew_thread();
        let mut i = input(&t, &[], 45);
        i.animations = true;
        let mut at = |tick: usize| {
            i.tick = tick;
            render(&i, 40, 60)
        };
        let (a, b) = (at(0), at(2));
        let bar_rows = |rows: &[String]| -> Vec<String> {
            rows.iter()
                .filter(|l| l.contains("no total"))
                .cloned()
                .collect()
        };
        assert_ne!(
            bar_rows(&a),
            bar_rows(&b),
            "a working member's marker walks"
        );
        let waiting = Progress::Indeterminate;
        let still = Ctx::new(&LAVENDER, &UNICODE, 3, false);
        assert_eq!(
            text_of(&status_bar(&still, waiting, true, 30)),
            text_of(&status_bar(
                &Ctx::new(&LAVENDER, &UNICODE, 9, false),
                waiting,
                true,
                30
            ))
        );
    }

    #[test]
    fn the_panel_shows_a_bar_row_per_crew_member() {
        let t = crew_thread();
        let text = render(&input(&t, &[], 45), 40, 60);
        let bars: Vec<&String> = text.iter().filter(|l| l.contains('▕')).collect();
        // the overall bar and four members
        assert_eq!(bars.len(), 5, "{text:#?}");
        assert!(bars[1].contains("no total") && bars[2].contains("no total"));
        assert!(bars[3].ends_with("Done") && bars[4].ends_with("Failed"));
    }

    #[test]
    fn member_bars_never_overflow_at_any_width() {
        let t = crew_thread();
        for width in 0..60 {
            for sym in [&UNICODE, &ASCII] {
                let ctx = Ctx::new(&LAVENDER, sym, 4, true);
                for p in [
                    Progress::Indeterminate,
                    Progress::Ended(End::Done),
                    Progress::Ended(End::Failed),
                ] {
                    let cells = row_width(&status_bar(&ctx, p, false, width));
                    assert!(
                        cells <= width.max(STATUS_BAR_MIN) && (width >= 1 || cells == 0),
                        "{width}: {cells}"
                    );
                }
            }
        }
        for (w, h) in [(8, 4), (14, 12), (20, 30), (33, 60)] {
            for sym in [&UNICODE, &ASCII] {
                let rows = lines(&input(&t, &[], 45), w, h, &LAVENDER, sym);
                assert!(rows.len() <= h);
                for line in plain(&rows) {
                    assert!(crate::text::width(&line) <= w, "{w}x{h}: {line:?}");
                }
            }
        }
    }

    // ---- crew TODO items ----

    fn counts(
        total: usize,
        verified: usize,
        claimed: usize,
        failed: usize,
        blocked: usize,
    ) -> Value {
        json!({
            "todoTotal": total, "todoVerified": verified, "todoClaimed": claimed,
            "todoFailed": failed, "todoBlocked": blocked,
        })
    }

    fn items(total: usize, verified: usize, claimed: usize, end: Option<End>) -> Items {
        Items {
            todos: CrewTodos {
                total,
                verified,
                claimed,
                ..CrewTodos::default()
            },
            end,
        }
    }

    fn item_text(items: Items, ascii: bool, room: usize) -> String {
        let ctx = Ctx::new(&LAVENDER, if ascii { &ASCII } else { &UNICODE }, 0, false);
        text_of(&status_bar(&ctx, Progress::Items(items), false, room))
    }

    fn worker_todos(i: &FlowInput) -> Option<CrewTodos> {
        match members(i).iter().find(|m| m.role == "Worker")?.bar? {
            Progress::Items(items) => Some(items.todos),
            _ => None,
        }
    }

    #[test]
    fn todo_counts_come_from_the_latest_activity_and_the_final_report_stays() {
        let started = crew("task.started", 3, "w1", "worker", json!({"title": "Build"}));
        let t = thread(
            vec![
                started.clone(),
                crew("task.progress", 4, "w1", "worker", counts(20, 0, 0, 0, 0)),
            ],
            true,
        );
        let got = worker_todos(&input(&t, &[], 45)).unwrap();
        assert_eq!(
            (got.total, got.verified),
            (20, 0),
            "all pending at the start"
        );

        let mut later = crew("task.progress", 6, "w1", "worker", counts(20, 5, 2, 1, 0));
        later["payload"]["outOfScope"] =
            json!({"files": ["a.ts", "b.ts"], "more": 3, "shared": false});
        let t = thread(
            vec![
                started.clone(),
                crew("task.progress", 4, "w1", "worker", counts(20, 0, 0, 0, 0)),
                later.clone(),
            ],
            true,
        );
        let got = worker_todos(&input(&t, &[], 45)).unwrap();
        assert_eq!(
            (got.verified, got.claimed, got.failed, got.out_of_scope),
            (5, 2, 1, 5),
            "the last write wins"
        );

        let mut done = crew("task.completed", 9, "w1", "worker", counts(21, 10, 3, 2, 1));
        done["payload"]["status"] = json!("partial");
        let late = crew("task.progress", 10, "w1", "worker", counts(21, 1, 1, 0, 0));
        let t = thread(vec![started.clone(), later, done, late], true);
        let all = members(&input(&t, &[], 45));
        let worker = all.iter().find(|m| m.role == "Worker").unwrap();
        let Some(Progress::Items(it)) = worker.bar else {
            panic!("{:?}", worker.bar)
        };
        assert_eq!(
            (it.todos.total, it.todos.verified),
            (21, 10),
            "completed values stay"
        );
        assert_eq!(it.end, Some(End::Partial));

        let none = thread(vec![started], true);
        assert_eq!(
            worker_todos(&input(&none, &[], 45)),
            None,
            "no list, no items"
        );
    }

    #[test]
    fn the_two_tone_bar_and_its_percent() {
        let ctx = ctx_of(0, false);
        // 13 of 20 finished, 10 of them proven: 50%, and the 3 claimed ones are named.
        let wide = item_text(items(20, 10, 3, None), false, 60);
        assert!(wide.contains("50% 10/20 │ 3 unproven"), "{wide}");
        let cells: String = wide.chars().filter(|c| "█▒░".contains(*c)).collect();
        assert_eq!(cells.matches('█').count(), 17, "{wide}");
        assert_eq!(cells.matches('▒').count(), 5, "{wide}");
        assert!(cells.matches('░').count() > 0);
        assert!(cells.find('█') < cells.find('▒') && cells.find('▒') < cells.find('░'));
        // The share floors: 1 of 3 is 33%, 2 of 3 is 66%.
        assert!(item_text(items(3, 2, 0, None), false, 40).contains("66% 2/3"));
        // ASCII needs a different glyph for each.
        let ascii = item_text(items(20, 10, 3, None), true, 60);
        assert!(
            ascii.contains('#') && ascii.contains('=') && ascii.contains('-'),
            "{ascii}"
        );
        // Something done is never empty, one item short is never full.
        let nearly = item_text(items(200, 199, 0, None), false, 20);
        assert!(nearly.contains('░'), "{nearly}");
        let first = item_text(items(200, 0, 1, None), false, 20);
        assert!(first.contains('▒'), "{first}");
        let row = status_bar(&ctx, Progress::Items(items(4, 1, 1, None)), false, 30);
        assert!(row.iter().any(|c| c.content.contains('▒')));
    }

    #[test]
    fn failed_and_blocked_are_words_in_the_error_colour_and_scope_has_a_marker() {
        let mut it = items(20, 10, 3, None);
        it.todos.failed = 2;
        it.todos.blocked = 1;
        it.todos.out_of_scope = 4;
        let ctx = ctx_of(0, false);
        let row = status_bar(&ctx, Progress::Items(it), false, 80);
        let text = text_of(&row);
        assert!(
            text.contains("2 failed")
                && text.contains("1 blocked")
                && text.contains("4 out of scope"),
            "{text}"
        );
        let failed = row.iter().find(|c| c.content.contains("2 failed")).unwrap();
        assert_eq!(failed.style, ctx.error());
        // A narrower bar gives up verified and scope first, then the count, keeping the words.
        let mid = item_text(it, false, 44);
        assert!(
            mid.contains("2 failed") && !mid.contains("unproven"),
            "{mid}"
        );
    }

    #[test]
    fn an_ended_task_with_items_left_keeps_its_true_percent_and_never_looks_full() {
        for end in [End::Partial, End::Failed, End::Blocked, End::Stopped] {
            let text = item_text(items(20, 18, 1, Some(end)), false, 40);
            assert!(
                text.contains("90% 18/20") && text.contains('░'),
                "{end:?}: {text}"
            );
            // Even a count that reached the total must not fill the bar when it ended short.
            let all = item_text(items(4, 4, 0, Some(end)), false, 30);
            assert!(all.contains('░'), "{end:?}: {all}");
        }
        let done = item_text(items(4, 4, 0, Some(End::Done)), false, 30);
        assert!(!done.contains('░') && done.contains("100%"), "{done}");
        let began = item_text(items(4, 1, 0, Some(End::Partial)), false, 30);
        assert!(began.contains('█') && began.contains("25%"), "{began}");
    }

    #[test]
    fn a_bar_of_claimed_items_is_zero_percent_and_never_a_solid_success_bar() {
        let ctx = ctx_of(0, false);
        for end in [None, Some(End::Done)] {
            let all_claimed = items(5, 0, 5, end);
            let row = status_bar(&ctx, Progress::Items(all_claimed), false, 40);
            let text = text_of(&row);
            assert!(text.contains("0% 0/5 │ 5 unproven"), "{end:?}: {text}");
            assert!(
                text.contains('▒') && !text.contains('█'),
                "claimed cells only: {text}"
            );
            assert!(
                row.iter().all(|c| c.style != ctx.success()),
                "{end:?}: nothing in the success colour"
            );
        }
        // The same count proven is the solid success bar.
        let proven = status_bar(
            &ctx,
            Progress::Items(items(5, 5, 0, Some(End::Done))),
            false,
            40,
        );
        assert!(!text_of(&proven).contains('▒') && proven.iter().any(|c| c.style == ctx.success()));
        // The run glow still stops once every item is finished, claimed or not.
        assert!(!is_unfinished_count(Progress::Items(items(5, 0, 5, None))));
        assert!(is_unfinished_count(Progress::Items(items(5, 0, 4, None))));
        // The input bar's label counts proven items too.
        assert_eq!(label_of(Progress::Items(items(5, 2, 3, None))), "2/5");
    }

    #[test]
    fn the_overall_bar_sums_items_and_counts_a_task_without_a_list_as_one() {
        let mut done = crew(
            "task.completed",
            8,
            "e1",
            "expert",
            json!({"summary": "ok"}),
        );
        done["payload"]["status"] = json!("completed");
        let mut unproven = done.clone();
        let mut proven = done;
        proven["payload"]["proof"] = json!("verified");
        let t = thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew("task.progress", 4, "w1", "worker", counts(20, 8, 2, 0, 0)),
                crew("task.started", 3, "e1", "expert", json!({})),
                proven,
                crew("task.started", 3, "a1", "auditor", json!({})),
            ],
            true,
        );
        assert_eq!(
            progress_of(&t),
            Some(Progress::Items(items(22, 9, 2, None))),
            "8 of 20 proven items, a verified task without a list (1 of 1), a running one (0 of 1)"
        );
        // The same task with an inconclusive proof is finished but not a proven item: claimed.
        unproven["payload"]["proof"] = json!("inconclusive");
        let t = thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew("task.progress", 4, "w1", "worker", counts(20, 8, 2, 0, 0)),
                crew("task.started", 3, "e1", "expert", json!({})),
                unproven,
                crew("task.started", 3, "a1", "auditor", json!({})),
            ],
            true,
        );
        assert_eq!(
            progress_of(&t),
            Some(Progress::Items(items(22, 8, 3, None)))
        );
        // Without any list the crew's tasks count as before.
        let plain = thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew("task.started", 3, "a1", "auditor", json!({})),
            ],
            true,
        );
        assert_eq!(
            progress_of(&plain),
            Some(Progress::Steps {
                done: 0,
                total: 2,
                basis: Basis::Crew
            })
        );
        // Items added later lower the share; that is accepted.
        let grown = thread(
            vec![
                crew("task.started", 3, "w1", "worker", json!({})),
                crew("task.progress", 4, "w1", "worker", counts(20, 8, 2, 0, 0)),
                crew("task.progress", 5, "w1", "worker", counts(40, 8, 2, 0, 0)),
            ],
            true,
        );
        assert_eq!(
            progress_of(&grown),
            Some(Progress::Items(items(40, 8, 2, None)))
        );
    }

    #[test]
    fn item_bars_never_overflow_in_unicode_or_ascii() {
        let mut full = items(20, 10, 3, None);
        full.todos.failed = 2;
        full.todos.blocked = 1;
        full.todos.out_of_scope = 4;
        for it in [
            full,
            items(3, 3, 0, Some(End::Partial)),
            items(200, 0, 1, None),
        ] {
            for room in 0..90 {
                for sym in [&UNICODE, &ASCII] {
                    let ctx = Ctx::new(&LAVENDER, sym, 0, false);
                    let cells = row_width(&status_bar(&ctx, Progress::Items(it), false, room));
                    assert!(
                        cells <= room.max(STATUS_BAR_MIN) && (room >= 1 || cells == 0),
                        "{room}: {cells}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_panel_with_items_shows_the_member_bar_and_fits_every_width() {
        let mut later = crew("task.progress", 6, "w1", "worker", counts(20, 10, 3, 2, 0));
        later["payload"]["outOfScope"] = json!({"files": ["a.ts"], "more": 0, "shared": true});
        let t = thread(
            vec![crew("task.started", 3, "w1", "worker", json!({})), later],
            true,
        );
        let rows = render(&input(&t, &[], 45), 70, 40);
        assert!(
            rows.iter()
                .any(|l| l.contains("50% 10/20 │ 3 unproven │ 2 failed")),
            "{rows:#?}"
        );
        assert!(rows.iter().any(|l| l.contains("crew items")));
        for (w, h) in [(8, 6), (14, 14), (20, 30), (33, 40)] {
            for sym in [&UNICODE, &ASCII] {
                for line in plain(&lines(&input(&t, &[], 45), w, h, &LAVENDER, sym)) {
                    assert!(crate::text::width(&line) <= w, "{w}x{h}: {line:?}");
                }
            }
        }
    }
}
