//! The `/stats` screen's numbers and rows: ported from the former TypeScript terminal's stats view. Three
//! tabs over the tool calls the thread's activities record. Every number comes from an activity;
//! nothing is estimated, and the hour is the viewer's local one.

use crate::panels_common::{Ctx, Row, clip, margin, pad, row_width, s, sp};
use crate::text::{civil_from_days, parse_iso_ms, truncate, width, wrap};
use crate::thread::Activity;
use crate::transcript::{first_line, result_summary, tool_failed, tool_title};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;

pub const HOURS: usize = 24;
const BAR_COLUMNS: usize = 20;
const TOP_HOURS: usize = 5;
/// The tool box is no wider than this, so a wide terminal does not stretch a few short lines.
const BOX_COLUMNS: usize = 48;
/// Below this the tool tab stacks its list over its box instead of putting them side by side.
const SIDE_BY_SIDE_FROM: usize = 60;

// ---- words (the render.stats.* keys of the former TypeScript terminal) ------------------------------------

fn tab_labels() -> [&'static str; 3] {
    [
        s("[1] Overview", "[1] 개요"),
        s("[2] By hour", "[2] 시간대"),
        s("[3] Tools", "[3] 도구"),
    ]
}
pub fn hint() -> &'static str {
    s("r:refresh q:close", "r:새로고침 q:닫기")
}
fn recent_only() -> &'static str {
    s("Recent activity only", "최근 활동만 집계")
}
fn none() -> &'static str {
    s(
        "No tool activity to show yet",
        "아직 집계할 도구 활동이 없습니다",
    )
}
fn summary_tpl() -> &'static str {
    s(
        "{extra}Calls {calls}  Failure rate {rate}",
        "{extra}호출 {calls}  실패율 {rate}",
    )
}
fn tool_count_tpl() -> &'static str {
    s("Tools {count}  ", "도구 {count}  ")
}
fn split_tpl() -> &'static str {
    s(
        "{failed} failed/{ok} ok  {calls}x",
        "{failed}실패/{ok}성공 {calls}회",
    )
}
fn calls_only_tpl() -> &'static str {
    s("{calls}x", "{calls}회")
}
fn more_tools_tpl() -> &'static str {
    s("… and {count} more", "… 외 {count}개")
}
fn peak_tpl() -> &'static str {
    s("  Peak {hour}", "  최다 {hour}")
}
fn hour_word() -> &'static str {
    s("Hour", "시간")
}
fn busy_hours() -> &'static str {
    s("Busiest hours", "많은 시간")
}
fn hour_failed_tpl() -> &'static str {
    s("({count} failed)", "({count}실패)")
}
fn hour_calls_tpl() -> &'static str {
    s("{calls}x", "{calls}회")
}
fn detail_calls_tpl() -> &'static str {
    s(
        "Calls {calls}  Failed {failed}  Succeeded {ok}",
        "호출 {calls}  실패 {failed}  성공 {ok}",
    )
}
fn last_call() -> &'static str {
    s("Last call", "마지막 호출")
}
fn no_last_failure() -> &'static str {
    s("No failures yet", "마지막 실패 없음")
}
fn last_failure_tpl() -> &'static str {
    s("Last failure {reason}", "마지막 실패 {reason}")
}

/// A template whose `{name}` holes are filled with styled pieces; the rest is `base`.
fn tpl(template: &str, parts: &[(&str, Row)], base: Style) -> Row {
    let mut out: Row = Vec::new();
    let mut rest = template;
    while !rest.is_empty() {
        let hole = parts
            .iter()
            .filter_map(|(name, row)| rest.find(&format!("{{{name}}}")).map(|at| (at, name, row)))
            .min_by_key(|(at, ..)| *at);
        match hole {
            Some((at, name, row)) => {
                if at > 0 {
                    out.push(sp(&rest[..at], base));
                }
                out.extend(row.iter().cloned());
                rest = &rest[at + name.len() + 2..];
            }
            None => {
                out.push(sp(rest, base));
                break;
            }
        }
    }
    out
}

fn plain(text: impl Into<String>, style: Style) -> Row {
    vec![sp(text, style)]
}

// ---- the numbers ----------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolStat {
    pub name: String,
    pub calls: usize,
    pub failed: usize,
    pub last_at: Option<i64>,
    pub last_failure_at: Option<i64>,
    pub last_failure: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Hour {
    pub calls: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tally {
    pub list: Vec<ToolStat>,
    pub hours: [Hour; HOURS],
    pub calls: usize,
    pub failed: usize,
}

/// Seconds the viewer's clock is ahead of UTC at this instant (their zone, daylight time included).
#[cfg(unix)]
fn local_offset_secs(utc_secs: i64) -> i64 {
    let at = utc_secs as libc::time_t;
    // SAFETY: `tm` is plain data that `localtime_r` fills; a failure leaves it untouched and is
    // reported by the null return.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&at, &mut tm) }.is_null() {
        0
    } else {
        // `tm_gmtoff` is a `c_long`: 32 bits on some targets.
        #[allow(clippy::useless_conversion)]
        i64::from(tm.tm_gmtoff)
    }
}

/// Windows has no `localtime_r`: the zone is not read there and times are UTC.
#[cfg(not(unix))]
fn local_offset_secs(_utc_secs: i64) -> i64 {
    0
}

/// `(year, month, day, hour, minute)` of an instant, `offset` seconds ahead of UTC.
pub fn local_fields(ms: i64, offset: i64) -> (i64, i64, i64, i64, i64) {
    let secs = ms.div_euclid(1000) + offset;
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    (year, month, day, rem / 3600, rem % 3600 / 60)
}

fn local_time(ms: i64) -> String {
    let (year, month, day, hour, minute) = local_fields(ms, local_offset_secs(ms.div_euclid(1000)));
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}")
}

/// Finished and refused tools only: a tool that is still running has no outcome to count.
pub fn tally(activities: &[Activity]) -> Tally {
    tally_with(activities, |ms| local_offset_secs(ms.div_euclid(1000)))
}

fn tally_with(activities: &[Activity], offset_of: impl Fn(i64) -> i64) -> Tally {
    let mut list: Vec<ToolStat> = Vec::new();
    let mut hours = [Hour::default(); HOURS];
    let (mut calls, mut failed) = (0, 0);
    for activity in activities {
        if activity.kind != "tool.completed" && activity.kind != "tool.denied" {
            continue;
        }
        let name = tool_title(activity);
        let at = list.iter().position(|stat| stat.name == name);
        let stat = match at {
            Some(at) => &mut list[at],
            None => {
                list.push(ToolStat {
                    name,
                    ..Default::default()
                });
                list.last_mut().expect("just pushed")
            }
        };
        let fail = tool_failed(activity);
        let when = parse_iso_ms(&activity.created_at);
        stat.calls += 1;
        calls += 1;
        if let Some(when) = when
            && stat.last_at.is_none_or(|last| when >= last)
        {
            stat.last_at = Some(when);
        }
        if fail {
            stat.failed += 1;
            failed += 1;
            if let Some(when) = when
                && stat.last_failure_at.is_none_or(|last| when >= last)
            {
                stat.last_failure_at = Some(when);
                let reason = result_summary(&activity.payload["data"], true);
                stat.last_failure = if reason.is_empty() {
                    first_line(&activity.payload["detail"])
                } else {
                    reason
                };
            }
        }
        if let Some(when) = when {
            let (.., hour, _) = local_fields(when, offset_of(when));
            let hour = &mut hours[hour as usize % HOURS];
            hour.calls += 1;
            if fail {
                hour.failed += 1;
            }
        }
    }
    list.sort_by(|left, right| {
        right
            .calls
            .cmp(&left.calls)
            .then_with(|| left.name.cmp(&right.name))
    });
    Tally {
        list,
        hours,
        calls,
        failed,
    }
}

/// The tools the tool tab lists, in the order it lists them: most calls first.
pub fn tool_names(activities: &[Activity]) -> Vec<String> {
    tally(activities)
        .list
        .into_iter()
        .map(|stat| stat.name)
        .collect()
}

fn percent(part: usize, whole: usize) -> usize {
    if whole == 0 {
        0
    } else {
        (part as f64 / whole as f64 * 100.0).round() as usize
    }
}

// ---- the rows -------------------------------------------------------------------------------------

pub struct Input<'a> {
    pub activities: &'a [Activity],
    /// The server sent only the recent part of the thread, so the numbers cover just that.
    pub has_older: bool,
    /// 0 overview, 1 hours of the day, 2 one tool at a time.
    pub tab: usize,
    /// The tool picked on the tool tab, by name so a list that reorders keeps the pick.
    pub selected: Option<&'a str>,
    pub width: usize,
    /// The most rows the view may use.
    pub rows: usize,
}

fn widest(texts: &[String]) -> usize {
    texts.iter().map(|t| width(t)).max().unwrap_or(0)
}

fn bold(ctx: &Ctx) -> Style {
    ctx.bold()
}

/// The `/stats` screen for one thread; the rows are the whole screen, redrawn on a key press and
/// never on a timer.
pub fn render(input: &Input, ctx: &Ctx) -> Vec<Line<'static>> {
    let w = input.width.max(1);
    let limit = input.rows;
    let inner = w.saturating_sub(1).max(1);
    let data = tally(input.activities);
    let note: Row = if input.has_older {
        plain(recent_only(), ctx.dim())
    } else {
        Vec::new()
    };

    let inverse = Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD);
    let mut tabs: Row = Vec::new();
    for (index, label) in tab_labels().iter().enumerate() {
        if index > 0 {
            tabs.push(sp(" ", Style::default()));
        }
        let text = format!(" {label} ");
        tabs.push(sp(
            text,
            if index == input.tab {
                inverse
            } else {
                Style::default()
            },
        ));
    }
    let tabs_width = row_width(&tabs);
    let hint = plain(hint(), ctx.dim());
    let hint_width = row_width(&hint);
    let head = if tabs_width + 2 + hint_width <= w {
        let mut head = tabs;
        head.push(sp(
            " ".repeat(w - tabs_width - hint_width),
            Style::default(),
        ));
        head.extend(hint);
        head
    } else {
        tabs
    };

    let mut out: Vec<Row> = vec![head, Vec::new()];
    let line = |out: &mut Vec<Row>, row: Row| out.push(margin(row));
    // The numbers line, followed by the note on the same row when it fits and on its own when not.
    let summary_line = |out: &mut Vec<Row>, text: Row| {
        if note.is_empty() {
            line(out, text);
        } else if row_width(&text) + 2 + row_width(&note) <= inner {
            let mut row = text;
            row.push(sp("  ", Style::default()));
            row.extend(note.iter().cloned());
            line(out, row);
        } else {
            line(out, text);
            line(out, note.clone());
        }
    };
    if data.list.is_empty() {
        summary_line(&mut out, plain(none(), ctx.dim()));
        return fit(out, w, limit);
    }

    let summary = |extra: Row| -> Row {
        let rate = format!("{}%", percent(data.failed, data.calls));
        tpl(
            summary_tpl(),
            &[
                ("extra", extra),
                ("calls", plain(data.calls.to_string(), bold(ctx))),
                (
                    "rate",
                    plain(
                        rate,
                        if data.failed > 0 {
                            ctx.error()
                        } else {
                            bold(ctx)
                        },
                    ),
                ),
            ],
            Style::default(),
        )
    };

    if input.tab == 0 {
        let count = tpl(
            tool_count_tpl(),
            &[("count", plain(data.list.len().to_string(), bold(ctx)))],
            Style::default(),
        );
        summary_line(&mut out, summary(count));
        out.push(Vec::new());
        let spare = limit.saturating_sub(out.len());
        let shown: &[ToolStat] = if data.list.len() > spare && spare >= 2 {
            &data.list[..spare - 1]
        } else {
            &data.list
        };
        let name_texts: Vec<String> = shown.iter().map(|t| t.name.clone()).collect();
        let names = 16.min(widest(&name_texts)).min((inner / 3).max(4));
        let full: Vec<String> = shown
            .iter()
            .map(|tool| {
                crate::panels_common::fill(
                    split_tpl(),
                    &[
                        ("failed", tool.failed.to_string()),
                        ("ok", (tool.calls - tool.failed).to_string()),
                        ("calls", tool.calls.to_string()),
                    ],
                )
            })
            .collect();
        let wide = widest(&full);
        // On a narrow screen the bar matters more than the split, so the split gives way first.
        let compact = (inner as i64 - names as i64 - 1 - wide as i64 - 1) < 6;
        let counts: Vec<String> = if compact {
            shown
                .iter()
                .map(|tool| {
                    crate::panels_common::fill(
                        calls_only_tpl(),
                        &[("calls", tool.calls.to_string())],
                    )
                })
                .collect()
        } else {
            full
        };
        let counts_width = widest(&counts);
        let bar = (inner as i64 - names as i64 - 1 - counts_width as i64 - 1)
            .clamp(1, BAR_COLUMNS as i64) as usize;
        for (tool, count) in shown.iter().zip(&counts) {
            let mut row = pad(plain(truncate(&tool.name, names), ctx.accent()), names);
            row.push(sp(" ", Style::default()));
            row.extend(bar_of(tool, bar, ctx));
            row.push(sp(" ", Style::default()));
            row.push(sp(count.clone(), ctx.dim()));
            line(&mut out, row);
        }
        if shown.len() < data.list.len() {
            let more = crate::panels_common::fill(
                more_tools_tpl(),
                &[("count", (data.list.len() - shown.len()).to_string())],
            );
            line(&mut out, plain(more, ctx.dim()));
        }
        return fit(out, w, limit);
    }

    if input.tab == 1 {
        let mut peak = 0;
        for (index, hour) in data.hours.iter().enumerate() {
            if hour.calls > data.hours[peak].calls {
                peak = index;
            }
        }
        let most = data.hours[peak].calls;
        let mut first = summary(Vec::new());
        if most > 0 {
            first.extend(tpl(
                peak_tpl(),
                &[("hour", plain(format!("{peak:02}:00"), bold(ctx)))],
                Style::default(),
            ));
        }
        summary_line(&mut out, first);
        out.push(Vec::new());
        let glyphs = if ctx.ascii {
            [".", ":", "*", "#"]
        } else {
            ["░", "▒", "▓", "█"]
        };
        let mut cells: Row = Vec::new();
        for (index, hour) in data.hours.iter().enumerate() {
            let level = if hour.calls == 0 {
                0
            } else {
                (((hour.calls as f64 / most as f64) * 3.0).ceil() as usize).max(1)
            };
            let glyph = glyphs[level.min(3)];
            cells.push(sp(
                glyph,
                if level == 0 {
                    ctx.dim()
                } else if index == peak {
                    ctx.warning()
                } else {
                    ctx.accent()
                },
            ));
        }
        let hour_label = hour_word();
        let label_width = width(hour_label) + 2;
        let mut hours_row = plain(hour_label, bold(ctx));
        hours_row.push(sp("  ", Style::default()));
        hours_row.extend(cells);
        line(&mut out, hours_row);
        let axis = |marks: &[(usize, char)]| -> String {
            (0..HOURS)
                .map(|hour| {
                    marks
                        .iter()
                        .find(|(at, _)| *at == hour)
                        .map_or(' ', |(_, c)| *c)
                })
                .collect()
        };
        let tens = axis(&[(0, '0'), (10, '1'), (20, '2')]);
        let ones = axis(&[
            (0, '0'),
            (5, '5'),
            (10, '0'),
            (15, '5'),
            (20, '0'),
            (23, '3'),
        ]);
        for marks in [tens, ones] {
            line(
                &mut out,
                plain(format!("{}{marks}", " ".repeat(label_width)), ctx.dim()),
            );
        }
        out.push(Vec::new());
        line(&mut out, plain(busy_hours(), bold(ctx)));
        let mut ranked: Vec<(usize, Hour)> = data
            .hours
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, hour)| hour.calls > 0)
            .collect();
        ranked.sort_by(|(li, l), (ri, r)| r.calls.cmp(&l.calls).then(li.cmp(ri)));
        for (index, hour) in ranked.into_iter().take(TOP_HOURS) {
            let mut row = plain(
                format!(
                    "  {index:02}:00  {}",
                    crate::panels_common::fill(
                        hour_calls_tpl(),
                        &[("calls", hour.calls.to_string())]
                    )
                ),
                Style::default(),
            );
            if hour.failed > 0 {
                row.push(sp("  ", Style::default()));
                row.push(sp(
                    crate::panels_common::fill(
                        hour_failed_tpl(),
                        &[("count", hour.failed.to_string())],
                    ),
                    ctx.error(),
                ));
            }
            line(&mut out, row);
        }
        return fit(out, w, limit);
    }

    if !note.is_empty() {
        line(&mut out, note.clone());
    }
    let room = limit.saturating_sub(out.len());
    let selected = input
        .selected
        .and_then(|name| data.list.iter().position(|tool| tool.name == name))
        .unwrap_or(0);
    let current = &data.list[selected];
    let side_by_side = w >= SIDE_BY_SIDE_FROM;
    let marker = if ctx.ascii { ">" } else { "▶" };
    let list_texts: Vec<String> = data
        .list
        .iter()
        .map(|tool| format!("  {} ({})", tool.name, tool.calls))
        .collect();
    let list_width = if side_by_side {
        ((w as f64 * 0.4).floor() as usize).min(widest(&list_texts))
    } else {
        inner
    };
    let box_width = if side_by_side {
        BOX_COLUMNS.min(inner.saturating_sub(list_width + 2))
    } else {
        inner
    };
    let boxed = tool_box(current, box_width, ctx);
    // The list keeps the picked tool in view; stacked, it gives the box the rows it needs first.
    let wanted_rows = if side_by_side {
        room as i64
    } else {
        6.min(room as i64 - boxed.len() as i64 - 1)
    };
    let list_rows = (data.list.len() as i64).min(wanted_rows).max(1) as usize;
    let from = selected
        .saturating_sub(list_rows / 2)
        .min(data.list.len() - list_rows);
    let inverse = Style::default().add_modifier(Modifier::REVERSED);
    let list: Vec<Row> = data
        .list
        .iter()
        .enumerate()
        .skip(from)
        .take(list_rows)
        .map(|(index, tool)| {
            let picked = index == selected;
            let count = format!(" ({})", tool.calls);
            let name = truncate(
                &tool.name,
                list_width.saturating_sub(2 + width(&count)).max(1),
            );
            let text = format!("{} {name}{count}", if picked { marker } else { " " });
            let row = pad(plain(text, Style::default()), list_width);
            let style = if picked {
                Some(inverse)
            } else if tool.failed == tool.calls {
                Some(ctx.error())
            } else {
                None
            };
            match style {
                Some(style) => row
                    .into_iter()
                    .map(|span| sp(span.content.to_string(), style))
                    .collect(),
                None => row,
            }
        })
        .collect();
    if side_by_side {
        for index in 0..list.len().max(boxed.len()) {
            let mut row = pad(list.get(index).cloned().unwrap_or_default(), list_width);
            row.push(sp("  ", Style::default()));
            row.extend(boxed.get(index).cloned().unwrap_or_default());
            line(&mut out, row);
        }
    } else {
        let list_len = list.len();
        for row in list {
            line(&mut out, row);
        }
        if room as i64 - list_len as i64 > 1 {
            out.push(Vec::new());
        }
        for row in boxed {
            line(&mut out, row);
        }
    }
    fit(out, w, limit)
}

/// Every row cut to the width, and the whole cut to the rows the screen gave.
fn fit(rows: Vec<Row>, w: usize, limit: usize) -> Vec<Line<'static>> {
    rows.into_iter()
        .take(limit)
        .map(|row| Line::from(clip(row, w)))
        .collect()
}

/// Failed and succeeded calls as one bar of `columns` cells, failures first.
fn bar_of(tool: &ToolStat, columns: usize, ctx: &Ctx) -> Row {
    let (ok, bad) = if ctx.ascii {
        ("#", "x")
    } else {
        ("█", "█")
    };
    let failed_cells = if tool.failed == 0 {
        0
    } else if tool.failed == tool.calls {
        columns
    } else {
        ((tool.failed as f64 / tool.calls as f64 * columns as f64).round() as usize)
            .max(1)
            .min(columns.saturating_sub(1))
    };
    vec![
        sp(bad.repeat(failed_cells), ctx.error()),
        sp(ok.repeat(columns - failed_cells), ctx.success()),
    ]
}

/// One tool's numbers in a box, for the tool tab.
fn tool_box(tool: &ToolStat, outer: usize, ctx: &Ctx) -> Vec<Row> {
    let inside = outer.saturating_sub(4).max(1);
    let succeeded = tool.calls - tool.failed;
    let mut body: Vec<Row> = vec![
        plain(
            truncate(&tool.name, inside),
            ctx.accent().add_modifier(Modifier::BOLD),
        ),
        Vec::new(),
        tpl(
            detail_calls_tpl(),
            &[
                ("calls", plain(tool.calls.to_string(), bold(ctx))),
                ("failed", plain(tool.failed.to_string(), ctx.error())),
                ("ok", plain(succeeded.to_string(), ctx.success())),
            ],
            Style::default(),
        ),
        {
            let mut row = plain(last_call(), ctx.dim());
            row.push(sp(
                format!(
                    " {}",
                    tool.last_at.map_or_else(|| "-".to_string(), local_time)
                ),
                Style::default(),
            ));
            row
        },
        Vec::new(),
    ];
    if tool.failed == 0 {
        body.push(plain(no_last_failure(), ctx.dim()));
    } else {
        let reason = if tool.last_failure.is_empty() {
            "-"
        } else {
            tool.last_failure.as_str()
        };
        let text = truncate(
            &crate::panels_common::fill(last_failure_tpl(), &[("reason", reason.to_string())]),
            inside * 3,
        );
        for piece in wrap(&text, inside).into_iter().take(3) {
            body.push(plain(piece, ctx.error()));
        }
    }
    let g = ctx.g;
    let side = || sp(g.vertical, ctx.dim());
    let edge = |left: &'static str, right: &'static str| -> Row {
        plain(
            format!(
                "{left}{}{right}",
                g.horizontal.repeat(outer.saturating_sub(2))
            ),
            ctx.dim(),
        )
    };
    let mut rows = vec![edge(g.corners[0], g.corners[1])];
    for row in body {
        let mut boxed = vec![side(), sp(" ", Style::default())];
        boxed.extend(pad(clip(row, inside), inside));
        boxed.push(sp(" ", Style::default()));
        boxed.push(side());
        rows.push(boxed);
    }
    rows.push(edge(g.corners[2], g.corners[3]));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::plain as plain_lines;
    use crate::theme::{LAVENDER, UNICODE};
    use serde_json::{Value, json};

    fn tool(kind: &str, title: &str, at: &str, status: &str, data: Value) -> Activity {
        Activity {
            id: format!("{title}-{at}"),
            kind: kind.into(),
            summary: title.into(),
            created_at: at.into(),
            payload: json!({"title": title, "status": status, "data": data}),
            ..Default::default()
        }
    }

    fn sample() -> Vec<Activity> {
        vec![
            tool(
                "tool.completed",
                "Read",
                "2026-01-01T09:10:00.000Z",
                "completed",
                Value::Null,
            ),
            tool(
                "tool.completed",
                "Read",
                "2026-01-01T09:20:00.000Z",
                "completed",
                Value::Null,
            ),
            tool(
                "tool.completed",
                "Read",
                "2026-01-01T13:00:00.000Z",
                "completed",
                Value::Null,
            ),
            tool(
                "tool.completed",
                "Bash",
                "2026-01-01T09:30:00.000Z",
                "failed",
                json!({"item": {"error": "exit 2"}}),
            ),
            tool(
                "tool.denied",
                "Edit",
                "2026-01-01T13:30:00.000Z",
                "declined",
                Value::Null,
            ),
            tool(
                "tool.started",
                "Grep",
                "2026-01-01T13:31:00.000Z",
                "inProgress",
                Value::Null,
            ),
        ]
    }

    fn ctx() -> Ctx<'static> {
        crate::i18n::init(Some("en"));
        // Leaked once per test: the theme must outlive the context.
        let theme: &'static _ = Box::leak(Box::new(LAVENDER));
        Ctx::new(theme, &UNICODE, 0, false)
    }

    fn text(width: usize, rows: usize, tab: usize, selected: Option<&str>) -> Vec<String> {
        let activities = sample();
        let lines = render(
            &Input {
                activities: &activities,
                has_older: false,
                tab,
                selected,
                width,
                rows,
            },
            &ctx(),
        );
        plain_lines(&lines)
    }

    #[test]
    fn only_finished_and_refused_tools_are_counted_most_calls_first() {
        let data = tally_with(&sample(), |_| 0);
        let names: Vec<_> = data
            .list
            .iter()
            .map(|t| (t.name.as_str(), t.calls, t.failed))
            .collect();
        assert_eq!(names, [("Read", 3, 0), ("Bash", 1, 1), ("Edit", 1, 1)]);
        assert_eq!((data.calls, data.failed), (5, 2));
        // the hours are the viewer's own: with a zone 2 hours ahead the 09:xx calls fall in hour 11
        let ahead = tally_with(&sample(), |_| 7200);
        assert_eq!(ahead.hours[11].calls, 3);
        assert_eq!(ahead.hours[11].failed, 1);
        assert_eq!(ahead.hours[15].calls, 2);
        assert_eq!(data.hours[9].calls, 3);
        assert_eq!(data.list[1].last_failure, "exit 2");
    }

    #[test]
    fn local_fields_follow_the_offset_across_midnight() {
        let ms = parse_iso_ms("2026-01-01T23:30:00.000Z").unwrap();
        assert_eq!(local_fields(ms, 0), (2026, 1, 1, 23, 30));
        assert_eq!(local_fields(ms, 3600), (2026, 1, 2, 0, 30));
        assert_eq!(local_fields(ms, -86_400), (2025, 12, 31, 23, 30));
    }

    #[test]
    fn the_overview_lists_each_tool_with_its_bar_and_the_failure_rate() {
        let rows = text(80, 20, 0, None);
        assert!(
            rows[0].contains("[1] Overview") && rows[0].contains("q:close"),
            "{rows:?}"
        );
        assert!(
            rows[2].contains("Tools 3")
                && rows[2].contains("Calls 5")
                && rows[2].contains("Failure rate 40%"),
            "{rows:?}"
        );
        assert!(
            rows[4].contains("Read") && rows[4].contains("0 failed/3 ok  3x"),
            "{rows:?}"
        );
        assert!(
            rows[5].contains("Bash") && rows[5].contains("1 failed/0 ok  1x"),
            "{rows:?}"
        );
        // a tool that only failed is a bar of failures only
        assert!(rows[5].contains(&"█".repeat(20)));
        assert!(rows.iter().all(|r| width(r) <= 80));
    }

    #[test]
    fn too_few_rows_cut_the_list_and_say_how_many_are_left() {
        let rows = text(80, 6, 0, None);
        assert_eq!(rows.len(), 6, "{rows:?}");
        assert!(rows[5].contains("… and 2 more"), "{rows:?}");
    }

    #[test]
    fn a_narrow_screen_gives_the_split_up_before_the_bar() {
        let rows = text(28, 20, 0, None);
        assert!(
            rows[4].contains("3x") && !rows[4].contains("failed/"),
            "{rows:?}"
        );
        assert!(rows.iter().all(|r| width(r) <= 28));
    }

    #[test]
    fn the_hours_tab_marks_the_peak_and_ranks_the_busy_hours() {
        let rows = text(80, 30, 1, None);
        let joined = rows.join("\n");
        assert!(rows[0].contains("[2] By hour"));
        // local hours depend on the machine's zone: assert the shape, not the hour
        assert!(joined.contains("Peak "), "{joined}");
        assert!(joined.contains("Busiest hours"), "{joined}");
        assert!(
            rows.iter().any(|r| r.starts_with(" Hour  ")
                && r.chars().filter(|c| "░▒▓█".contains(*c)).count() == 24),
            "{joined}"
        );
        assert!(
            rows.iter().any(|r| r.contains("0         1         2")),
            "{joined}"
        );
        assert!(
            rows.iter().any(|r| r.contains("0    5    0    5    0  3")),
            "{joined}"
        );
        assert!(rows.iter().any(|r| r.contains("3x")), "{joined}");
        assert!(
            rows.iter()
                .any(|r| r.contains("(1 failed)") || r.contains("(2 failed)")),
            "{joined}"
        );
    }

    #[test]
    fn the_tool_tab_shows_the_picked_tool_beside_the_list() {
        let rows = text(90, 20, 2, Some("Bash"));
        let joined = rows.join("\n");
        assert!(rows[0].contains("[3] Tools"));
        assert!(joined.contains("▶ Bash (1)"), "{joined}");
        assert!(joined.contains("  Read (3)"), "{joined}");
        assert!(
            joined.contains("Calls 1  Failed 1  Succeeded 0"),
            "{joined}"
        );
        assert!(joined.contains("Last failure exit 2"), "{joined}");
        assert!(joined.contains("╭") && joined.contains("╯"), "{joined}");
        // a name that is not a tool picks the first
        assert!(
            text(90, 20, 2, Some("nothing"))
                .join("\n")
                .contains("▶ Read (3)")
        );
        // a tool without failures says so
        assert!(
            text(90, 20, 2, Some("Read"))
                .join("\n")
                .contains("No failures yet")
        );
    }

    #[test]
    fn a_narrow_screen_stacks_the_list_over_the_box() {
        let rows = text(40, 24, 2, None);
        let list_at = rows.iter().position(|r| r.contains("▶ Read (3)")).unwrap();
        let box_at = rows.iter().position(|r| r.contains('╭')).unwrap();
        assert!(box_at > list_at, "{rows:?}");
        assert!(rows.iter().all(|r| width(r) <= 40));
    }

    #[test]
    fn with_nothing_to_count_it_says_so_and_a_cut_thread_is_noted() {
        let lines = render(
            &Input {
                activities: &[],
                has_older: true,
                tab: 0,
                selected: None,
                width: 80,
                rows: 10,
            },
            &ctx(),
        );
        let rows = plain_lines(&lines);
        assert!(
            rows[2].contains("No tool activity to show yet")
                && rows[2].contains("Recent activity only"),
            "{rows:?}"
        );
        let narrow = render(
            &Input {
                activities: &[],
                has_older: true,
                tab: 0,
                selected: None,
                width: 40,
                rows: 10,
            },
            &ctx(),
        );
        let rows = plain_lines(&narrow);
        assert!(rows[3].contains("Recent activity only"), "{rows:?}");
    }
}
