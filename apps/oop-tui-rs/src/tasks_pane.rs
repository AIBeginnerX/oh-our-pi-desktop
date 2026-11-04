//! The task list under the conversation (`/tasks`): the thread's last `turn.plan.updated` list.
//! Ports `deriveActivePlanState` (packages/client-runtime/src/threadPlan.ts) and
//! the former TypeScript terminal's tasks pane.

use crate::app::{Active, App};
use crate::panels_common::{Ctx, Row, clip, fill, row_width, s, sp};
use crate::text::width;
use crate::thread::Activity;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::cmp::Ordering;

/// Shortest terminal that keeps a usable conversation above the task list.
pub const MIN_TASKS_ROWS: u16 = 16;
/// Narrowest terminal the task list is offered in.
pub const MIN_TASKS_COLUMNS: u16 = 40;

/// Why the task list cannot be used at this size; `None` when it can.
pub fn unavailable(columns: u16, rows: u16) -> Option<String> {
    if rows < MIN_TASKS_ROWS {
        return Some(fill(
            s(
                "Terminal is shorter than {min} rows, so the task list is unavailable (now {now})",
                "터미널 높이가 {min}줄 미만이라 작업 목록을 쓸 수 없습니다 (지금 {now}줄)",
            ),
            &[
                ("min", MIN_TASKS_ROWS.to_string()),
                ("now", rows.to_string()),
            ],
        ));
    }
    if columns < MIN_TASKS_COLUMNS {
        return Some(fill(
            s(
                "Terminal is narrower than {min} columns, so the task list is unavailable (now {now})",
                "터미널 폭이 {min}칸 미만이라 작업 목록을 쓸 수 없습니다 (지금 {now}칸)",
            ),
            &[
                ("min", MIN_TASKS_COLUMNS.to_string()),
                ("now", columns.to_string()),
            ],
        ));
    }
    None
}

/// Rows of the whole pane, its rule included: about a third of the terminal.
pub fn pane_rows(terminal_rows: u16) -> u16 {
    (terminal_rows / 3).clamp(5, 12)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub step: String,
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub explanation: Option<String>,
    pub steps: Vec<Step>,
}

/// What the pane has to say: the thread's last task list, none yet, or a thread still being read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Plan(Plan),
    Empty,
    Loading,
}

fn plan_of(activity: &Activity) -> Option<Plan> {
    let raw = activity.payload["plan"].as_array()?;
    let steps: Vec<Step> = raw
        .iter()
        .filter_map(|entry| {
            let step = entry.get("step")?.as_str()?.to_string();
            let status = match entry["status"].as_str() {
                Some("completed") => Status::Completed,
                Some("inProgress") => Status::InProgress,
                _ => Status::Pending,
            };
            Some(Step { step, status })
        })
        .collect();
    if steps.is_empty() {
        return None;
    }
    Some(Plan {
        explanation: activity
            .payload
            .get("explanation")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        steps,
    })
}

fn lifecycle_rank(kind: &str) -> u8 {
    if kind.ends_with(".started") || kind == "tool.started" {
        0
    } else if kind.ends_with(".progress") || kind.ends_with(".updated") {
        1
    } else if kind.ends_with(".completed") || kind.ends_with(".resolved") {
        2
    } else {
        1
    }
}

/// `compareActivitiesByOrder`: the server's sequence, else the time, then the lifecycle, then id.
fn by_order(left: &Activity, right: &Activity) -> Ordering {
    match (left.sequence, right.sequence) {
        (Some(l), Some(r)) if l != r => return l.cmp(&r),
        (Some(_), None) => return Ordering::Greater,
        (None, Some(_)) => return Ordering::Less,
        _ => {}
    }
    left.created_at
        .cmp(&right.created_at)
        .then_with(|| lifecycle_rank(&left.kind).cmp(&lifecycle_rank(&right.kind)))
        .then_with(|| left.id.cmp(&right.id))
}

/// The thread's task list: the latest plan of the current turn, else of any turn, so a list from an
/// earlier turn stays through follow-up messages. `None` when there is none, or when the latest
/// update cleared it.
pub fn derive_plan(activities: &[Activity], latest_turn: Option<&str>) -> Option<Plan> {
    let mut plans: Vec<&Activity> = activities
        .iter()
        .filter(|a| a.kind == "turn.plan.updated")
        .collect();
    plans.sort_by(|a, b| by_order(a, b));
    let latest = latest_turn
        .and_then(|turn| {
            plans
                .iter()
                .rev()
                .find(|a| a.turn_id.as_deref() == Some(turn))
        })
        .or_else(|| plans.last())?;
    plan_of(latest)
}

/// Which `room` rows of `count` steps to show so that step `focus` is among them. The steps cut
/// off take a row each for the "above" and "below" counts, so a window that touches an end gives
/// its marker row back to the steps. Returns `(start, size)`.
pub fn window_of(count: usize, focus: usize, room: usize) -> (usize, usize) {
    if count <= room {
        return (0, count);
    }
    let inner = room.saturating_sub(2).max(1);
    let wanted = focus as i64 - ((inner as i64 - 1) / 2);
    let start = wanted.min((count - inner) as i64).max(0) as usize;
    if start == 0 {
        return (0, room.saturating_sub(1).max(1));
    }
    if start + inner >= count {
        let size = room.saturating_sub(1).max(1);
        return (count - size, size);
    }
    (start, inner)
}

/// The step to keep in view: the one under way, else the next to do, else the last.
fn focus_of(steps: &[Step]) -> usize {
    steps
        .iter()
        .position(|s| s.status == Status::InProgress)
        .or_else(|| steps.iter().position(|s| s.status == Status::Pending))
        .unwrap_or(steps.len().saturating_sub(1))
}

fn one_line(value: &str) -> String {
    crate::panels_common::flat(value)
}

fn more_above(count: usize) -> String {
    fill(
        s("… {count} more above", "… 위로 {count}개"),
        &[("count", count.to_string())],
    )
}

fn more_below(count: usize) -> String {
    fill(
        s("… {count} more below", "… 아래로 {count}개"),
        &[("count", count.to_string())],
    )
}

/// The pane as exactly `rows` rows of at most `columns` cells: a rule that carries the count of
/// finished steps, the plan's explanation when it has one, then the steps with `☑` done, `◐` under
/// way and `☐` waiting.
pub fn render(content: &Content, columns: usize, rows: usize, ctx: &Ctx) -> Vec<Line<'static>> {
    let empty: &[Step] = &[];
    let steps = match content {
        Content::Plan(plan) => &plan.steps[..],
        _ => empty,
    };
    let done = steps
        .iter()
        .filter(|s| s.status == Status::Completed)
        .count();
    let title = if steps.is_empty() {
        s("Tasks", "작업").to_string()
    } else {
        fill(
            s("Tasks {done}/{total}", "작업 {done}/{total}"),
            &[
                ("done", done.to_string()),
                ("total", steps.len().to_string()),
            ],
        )
    };
    let border = Style::default().fg(ctx.th.border);
    let brand = Style::default()
        .fg(ctx.th.brand)
        .add_modifier(Modifier::BOLD);
    let lead: Row = vec![
        sp(ctx.g.rule.repeat(2), border),
        sp(" ", Style::default()),
        sp(title, brand),
        sp(" ", Style::default()),
    ];
    let mut header = lead.clone();
    header.push(sp(
        ctx.g.rule.repeat(columns.saturating_sub(row_width(&lead))),
        border,
    ));
    let mut lines: Vec<Row> = vec![header];
    let (done_mark, active_mark, open_mark) = if ctx.ascii {
        ("[x]", "[~]", "[ ]")
    } else {
        ("☑", "◐", "☐")
    };
    match content {
        Content::Loading => lines.push(vec![sp(s("Loading…", "불러오는 중…"), ctx.dim())]),
        Content::Empty => lines.push(vec![sp(
            s("No tasks yet", "아직 작업 목록이 없습니다"),
            ctx.dim(),
        )]),
        Content::Plan(plan) => {
            let explanation = one_line(plan.explanation.as_deref().unwrap_or(""));
            if !explanation.is_empty() {
                lines.push(vec![sp(explanation, ctx.dim())]);
            }
            let room = rows.saturating_sub(lines.len()).max(1);
            let (start, size) = window_of(steps.len(), focus_of(steps), room);
            let below = steps.len() - start - size;
            if start > 0 {
                lines.push(vec![sp(more_above(start), ctx.dim())]);
            }
            for step in &steps[start..start + size] {
                let text = one_line(&step.step);
                lines.push(match step.status {
                    Status::Completed => vec![
                        sp("  ", Style::default()),
                        sp(done_mark, ctx.success()),
                        sp(" ", Style::default()),
                        sp(text, ctx.dim()),
                    ],
                    Status::InProgress => vec![
                        sp("  ", Style::default()),
                        sp(active_mark, ctx.accent()),
                        sp(" ", Style::default()),
                        sp(text, ctx.bold()),
                    ],
                    Status::Pending => vec![
                        sp("  ", Style::default()),
                        sp(open_mark, ctx.muted()),
                        sp(" ", Style::default()),
                        sp(text, ctx.muted()),
                    ],
                });
            }
            if below > 0 {
                lines.push(vec![sp(more_below(below), ctx.dim())]);
            }
        }
    }
    let mut shown: Vec<Line<'static>> = lines
        .into_iter()
        .take(rows)
        .map(|row| Line::from(clip(row, columns)))
        .collect();
    while shown.len() < rows {
        shown.push(Line::default());
    }
    shown
}

/// What the pane shows for the thread on screen.
pub fn content_of(app: &App) -> Content {
    match &app.active {
        Active::Thread(id) if app.conv.thread_id == *id => {
            if !app.conv.loaded {
                return Content::Loading;
            }
            let latest = app
                .conv
                .thread
                .latest_turn
                .as_ref()
                .map(|turn| turn.turn_id.as_str())
                .filter(|id| !id.is_empty());
            derive_plan(&app.conv.thread.activities, latest).map_or(Content::Empty, Content::Plan)
        }
        Active::Thread(_) => Content::Loading,
        _ => Content::Empty,
    }
}

/// The rows the pane takes from the conversation column; 0 when it is off or the terminal is too
/// small (the command closes it then, see `cmd_stats::on_resize`).
pub fn rows_for(app: &App, terminal: Rect, main: Rect) -> u16 {
    if !app.tasks_on || unavailable(terminal.width, terminal.height).is_some() {
        return 0;
    }
    pane_rows(terminal.height).min(main.height.saturating_sub(5))
}

pub fn draw(frame: &mut Frame, area: Rect, app: &App) {
    let ctx = Ctx::new(&app.theme, &app.sym, app.tick, app.settings.animations);
    let lines = render(
        &content_of(app),
        usize::from(area.width),
        usize::from(area.height),
        &ctx,
    );
    frame.render_widget(Paragraph::new(lines), area);
}

#[allow(dead_code)]
fn cells(text: &str) -> usize {
    width(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::plain;
    use crate::theme::{LAVENDER, UNICODE};
    use serde_json::{Value, json};

    fn update(id: &str, turn: &str, at: &str, sequence: Option<u64>, payload: Value) -> Activity {
        Activity {
            id: id.into(),
            kind: "turn.plan.updated".into(),
            turn_id: Some(turn.into()),
            created_at: at.into(),
            sequence,
            payload,
            ..Default::default()
        }
    }

    fn plan(steps: &[(&str, &str)]) -> Value {
        json!({"explanation": "do it", "plan": steps.iter().map(|(s, st)| json!({"step": s, "status": st})).collect::<Vec<_>>()})
    }

    fn ctx() -> Ctx<'static> {
        crate::i18n::init(Some("en"));
        let theme: &'static _ = Box::leak(Box::new(LAVENDER));
        Ctx::new(theme, &UNICODE, 0, false)
    }

    #[test]
    fn the_latest_update_of_the_current_turn_wins_over_a_later_one_of_another_turn() {
        let activities = vec![
            update(
                "a",
                "t1",
                "2026-01-01T00:00:01.000Z",
                Some(1),
                plan(&[("one", "pending")]),
            ),
            update(
                "b",
                "t2",
                "2026-01-01T00:00:02.000Z",
                Some(2),
                plan(&[("two", "completed")]),
            ),
            update(
                "c",
                "t1",
                "2026-01-01T00:00:03.000Z",
                Some(3),
                plan(&[("one", "inProgress")]),
            ),
        ];
        let current = derive_plan(&activities, Some("t2")).unwrap();
        assert_eq!(current.steps[0].step, "two");
        // with no current turn, or none with a plan, the newest of any turn stays
        assert_eq!(derive_plan(&activities, None).unwrap().steps[0].step, "one");
        assert_eq!(
            derive_plan(&activities, Some("t9")).unwrap().steps[0].status,
            Status::InProgress
        );
        assert_eq!(derive_plan(&[], None), None);
    }

    #[test]
    fn order_follows_the_sequence_then_the_clock_and_unknown_status_is_pending() {
        let activities = vec![
            update(
                "late",
                "t",
                "2026-01-01T00:00:09.000Z",
                Some(1),
                plan(&[("first", "pending")]),
            ),
            update(
                "early",
                "t",
                "2026-01-01T00:00:01.000Z",
                Some(2),
                plan(&[("second", "weird")]),
            ),
        ];
        let got = derive_plan(&activities, Some("t")).unwrap();
        assert_eq!(
            got.steps,
            vec![Step {
                step: "second".into(),
                status: Status::Pending
            }]
        );
        // one with a sequence sorts after one without
        let mixed = vec![
            update(
                "x",
                "t",
                "2026-01-01T00:00:09.000Z",
                Some(1),
                plan(&[("seq", "pending")]),
            ),
            update(
                "y",
                "t",
                "2026-01-01T00:00:10.000Z",
                None,
                plan(&[("none", "pending")]),
            ),
        ];
        assert_eq!(derive_plan(&mixed, None).unwrap().steps[0].step, "seq");
    }

    #[test]
    fn an_update_that_leaves_no_steps_clears_the_list() {
        let activities = vec![
            update(
                "a",
                "t",
                "2026-01-01T00:00:01.000Z",
                Some(1),
                plan(&[("one", "pending")]),
            ),
            update(
                "b",
                "t",
                "2026-01-01T00:00:02.000Z",
                Some(2),
                json!({"plan": []}),
            ),
        ];
        assert_eq!(derive_plan(&activities, Some("t")), None);
        let junk = update(
            "c",
            "t",
            "2026-01-01T00:00:03.000Z",
            Some(3),
            json!({"plan": [1, {"status": "completed"}]}),
        );
        assert_eq!(derive_plan(&[junk], None), None);
    }

    #[test]
    fn the_window_keeps_the_focus_and_gives_a_marker_row_back_at_an_end() {
        assert_eq!(window_of(3, 0, 5), (0, 3));
        // 10 steps, 5 rows: at the top 4 steps + "below"
        assert_eq!(window_of(10, 0, 5), (0, 4));
        // at the bottom 4 steps + "above"
        assert_eq!(window_of(10, 9, 5), (6, 4));
        // in the middle 3 steps between two markers
        assert_eq!(window_of(10, 5, 5), (4, 3));
        for focus in 0..10 {
            let (start, size) = window_of(10, focus, 5);
            assert!((start..start + size).contains(&focus), "{focus}");
        }
    }

    #[test]
    fn the_pane_has_exactly_the_rows_it_was_given() {
        let content = Content::Plan(Plan {
            explanation: Some("do  it".into()),
            steps: vec![
                Step {
                    step: "read".into(),
                    status: Status::Completed,
                },
                Step {
                    step: "write".into(),
                    status: Status::InProgress,
                },
                Step {
                    step: "ship".into(),
                    status: Status::Pending,
                },
            ],
        });
        let rows = plain(&render(&content, 30, 7, &ctx()));
        assert_eq!(rows.len(), 7);
        assert!(
            rows[0].starts_with("── Tasks 1/3 ") && rows[0].chars().count() == 30,
            "{rows:?}"
        );
        assert_eq!(rows[1], "do it");
        assert_eq!(rows[2], "  ☑ read");
        assert_eq!(rows[3], "  ◐ write");
        assert_eq!(rows[4], "  ☐ ship");
        assert_eq!(rows[5], "");
        let tight = plain(&render(&content, 30, 4, &ctx()));
        assert_eq!(tight.len(), 4);
        assert_eq!(tight[2], "… 1 more above");
        assert_eq!(tight[3], "  ◐ write");
        let empty = plain(&render(&Content::Empty, 30, 5, &ctx()));
        assert!(empty[0].contains("Tasks") && empty[1] == "No tasks yet");
        assert_eq!(
            plain(&render(&Content::Loading, 30, 5, &ctx()))[1],
            "Loading…"
        );
    }

    #[test]
    fn size_limits_and_rows_follow_the_typescript_pane() {
        assert_eq!(pane_rows(16), 5);
        assert_eq!(pane_rows(30), 10);
        assert_eq!(pane_rows(60), 12);
        assert!(
            unavailable(80, 15).unwrap().contains("16")
                && unavailable(80, 15).unwrap().contains("15")
        );
        assert!(unavailable(39, 30).unwrap().contains("40"));
        assert_eq!(unavailable(40, 16), None);
    }
}
