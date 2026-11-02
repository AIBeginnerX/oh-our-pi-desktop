//! The conversation as lines: messages, finished tool calls, notices and plans in the order they
//! happened. A port of the shape of apps/oop-tui/src/state/transcript.ts, as a pure function of the
//! thread, so a cache keyed on the thread's revision and the width is enough to keep scrolling cheap.
//! Not here: the spinner and the live error line (they change with the clock, not the thread) and
//! the approval and question panels (they wait for the user; `ui.rs` draws them).

use crate::markdown;
use crate::text::{Join, parse_iso_ms, sanitize, truncate, width, wrap, wrap_flow};
use crate::theme::{Symbols, Theme};
use crate::thread::{Activity, Role, Thread};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use std::collections::HashMap;

/// A command or path after a tool's name stops here, so one long command is not a wall of text.
const DETAIL_COLUMNS: usize = 90;
/// Changed files named under a file edit before the rest are counted.
const FILES_LISTED: usize = 3;

/// What a row of the conversation lets a selection take: the cells `[from, to)` hold the text (a
/// bubble's border and padding, a bullet, a rail are layout, not text), and `join` says whether the
/// row continues the one above it, so wrapped text copies as the lines that were typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowMeta {
    pub from: usize,
    pub to: usize,
    pub join: Join,
}

impl Default for RowMeta {
    fn default() -> Self {
        RowMeta {
            from: 0,
            to: usize::MAX,
            join: Join::New,
        }
    }
}

/// The conversation's rows and, for each, what a selection may take of it.
#[derive(Default)]
pub struct Transcript {
    pub lines: Vec<Line<'static>>,
    pub meta: Vec<RowMeta>,
}

#[cfg(test)]
pub fn lines(thread: &Thread, w: usize, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    build(thread, w, th, sym).lines
}

pub fn build(thread: &Thread, w: usize, th: &Theme, sym: &Symbols) -> Transcript {
    let w = w.max(10);
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
            .map(|m| (m.created_at.as_str(), Item::Message(m))),
    );
    items.extend(
        thread
            .activities
            .iter()
            .map(|a| (a.created_at.as_str(), Item::Activity(a))),
    );
    items.extend(
        thread
            .proposed_plans
            .iter()
            .map(|p| (p.created_at.as_str(), Item::Plan(p))),
    );
    // ISO stamps order as text; the sort is stable, so ties keep messages before activities.
    items.sort_by(|a, b| a.0.cmp(b.0));

    let mut out: Vec<Line<'static>> = Vec::new();
    let mut meta: Vec<RowMeta> = Vec::new();
    let mut starts: HashMap<String, i64> = HashMap::new();
    // A run of tool lines and notices stays together; everything else is a block with a gap after.
    let mut in_run = false;
    for (_, item) in items {
        let (block, rows, run): (Vec<Line<'static>>, Option<Vec<RowMeta>>, bool) = match item {
            Item::Message(message) => {
                let (lines, rows) = message_lines(message, w, th, sym);
                (lines, Some(rows), false)
            }
            Item::Plan(plan) => (plan_lines(&plan.plan_markdown, w, th, sym), None, false),
            Item::Activity(activity) => {
                let id = activity.payload["toolCallId"].as_str().map(str::to_string);
                if activity.kind == "tool.started" {
                    if let (Some(id), Some(at)) = (id, parse_iso_ms(&activity.created_at)) {
                        starts.insert(id, at);
                    }
                    continue;
                }
                let elapsed = id
                    .and_then(|id| starts.remove(&id))
                    .zip(parse_iso_ms(&activity.created_at))
                    .map(|(start, end)| end - start);
                (activity_lines(activity, elapsed, w, th, sym), None, true)
            }
        };
        if block.is_empty() {
            continue;
        }
        if !out.is_empty() && !(run && in_run) {
            out.push(Line::default());
            meta.push(RowMeta::default());
        }
        meta.extend(rows.unwrap_or_else(|| vec![RowMeta::default(); block.len()]));
        out.extend(block);
        in_run = run;
    }
    Transcript { lines: out, meta }
}

fn message_lines(
    m: &crate::thread::Message,
    w: usize,
    th: &Theme,
    sym: &Symbols,
) -> (Vec<Line<'static>>, Vec<RowMeta>) {
    let plain = |lines: Vec<Line<'static>>, from: usize| {
        let meta = vec![
            RowMeta {
                from,
                ..RowMeta::default()
            };
            lines.len()
        ];
        (lines, meta)
    };
    match m.role {
        Role::User => user_lines(&m.text, w, th, sym),
        Role::Assistant => {
            if m.text.trim().is_empty() {
                return (Vec::new(), Vec::new());
            }
            let lines = markdown::render(&m.text, w.saturating_sub(2), th, sym)
                .into_iter()
                .enumerate()
                .map(|(i, mut line)| {
                    let lead = if i == 0 {
                        Span::styled(format!("{} ", sym.bullet), Style::new().fg(th.brand))
                    } else {
                        Span::raw("  ")
                    };
                    line.spans.insert(0, lead);
                    line
                })
                .collect();
            plain(lines, 2)
        }
        Role::Reasoning => plain(
            wrap(&sanitize(&m.text), w.saturating_sub(3))
                .into_iter()
                .map(|l| {
                    Line::from(Span::styled(
                        format!("  {l}"),
                        th.dim_style().add_modifier(Modifier::ITALIC),
                    ))
                })
                .collect(),
            2,
        ),
        Role::System => plain(
            wrap(&sanitize(&m.text), w.saturating_sub(3))
                .into_iter()
                .map(|l| Line::from(Span::styled(format!("  {l}"), Style::new().fg(th.warning))))
                .collect(),
            2,
        ),
    }
}

/// Least cells of text a user's box gets, whatever the room.
const MIN_INNER: usize = 8;

/// The user's own message: a block against the right edge of the `w`-column conversation, in the
/// theme's `user_fg` inside a rounded box, so it is told apart from the agent's text on the left. The
/// box is as wide as its longest row plus a border and a space on each side, and never wider than
/// four fifths of the room (width rules of apps/oop-tui/src/render/userBubble.ts), so a long message
/// wraps inside it. Every width is a display width: a Korean syllable takes two cells and every row
/// ends in the same column. Where the terminal can fill behind text the box also carries the
/// `user_bg` tint; with no colour at all the box itself is what sets the message apart. Only the text
/// cells are selectable, so copying a message gives the message without the border.
fn user_lines(
    text: &str,
    w: usize,
    th: &Theme,
    sym: &Symbols,
) -> (Vec<Line<'static>>, Vec<RowMeta>) {
    // A border and a space of padding on each side.
    let frame = 4;
    let most = w
        .saturating_sub(frame)
        .min(MIN_INNER.max((w * 8 / 10).saturating_sub(frame)))
        .max(1);
    let clean = sanitize(text);
    let rows: Vec<(String, Join)> = clean
        .split('\n')
        .flat_map(|line| {
            if line.is_empty() {
                vec![(String::new(), Join::New)]
            } else {
                wrap_flow(line, most)
            }
        })
        .map(|(row, join)| (row.trim_end().to_string(), join))
        .collect();
    let inner = rows.iter().map(|(r, _)| width(r)).max().unwrap_or(1).max(1);
    let lead = " ".repeat(w.saturating_sub(inner + frame));
    let [tl, tr, bl, br] = sym.corners;
    let tint = if th.fills_user() {
        Style::new().bg(th.user_bg)
    } else {
        Style::new()
    };
    let ink = tint.fg(th.user_fg);
    let edge = |left: &str, right: &str| {
        Line::from(vec![
            Span::raw(lead.clone()),
            Span::styled(format!("{left}{}{right}", sym.rule.repeat(inner + 2)), ink),
        ])
    };
    let mut lines = vec![edge(tl, tr)];
    let mut meta = vec![RowMeta::default()];
    let from = lead.chars().count() + 2;
    for (row, join) in rows {
        let fill = " ".repeat(inner - width(&row));
        lines.push(Line::from(vec![
            Span::raw(lead.clone()),
            Span::styled(format!("{} ", sym.bar), ink),
            Span::styled(format!("{row}{fill}"), ink),
            Span::styled(format!(" {}", sym.bar), ink),
        ]));
        meta.push(RowMeta {
            from,
            to: from + inner,
            join,
        });
    }
    lines.push(edge(bl, br));
    meta.push(RowMeta::default());
    // The border rows are not text: nothing of them is taken.
    for index in [0, meta.len() - 1] {
        meta[index] = RowMeta {
            from: usize::MAX,
            to: usize::MAX,
            join: Join::New,
        };
    }
    (lines, meta)
}

fn plan_lines(markdown_text: &str, w: usize, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    let mut out = vec![Line::from(Span::styled(
        format!("  {}", crate::i18n::tr("transcript.plan")),
        Style::new().fg(th.brand).add_modifier(Modifier::BOLD),
    ))];
    out.extend(
        markdown::render(markdown_text, w.saturating_sub(2), th, sym)
            .into_iter()
            .map(|mut l| {
                l.spans.insert(0, Span::raw("  "));
                l
            }),
    );
    out
}

fn activity_lines(
    a: &Activity,
    elapsed_ms: Option<i64>,
    w: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let described = || {
        let detail = first_line(&a.payload["detail"]);
        let detail = if detail.is_empty() {
            first_line(&a.payload["message"])
        } else {
            detail
        };
        let summary = first_line(&Value::String(a.summary.clone()));
        if detail.is_empty() {
            summary
        } else {
            format!("{summary} - {detail}")
        }
    };
    let notice = |color, mark: &str, text: String, bold: bool| -> Vec<Line<'static>> {
        let style = if bold {
            Style::new().fg(color).add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(color)
        };
        wrap(&text, w.saturating_sub(3))
            .into_iter()
            .enumerate()
            .map(|(i, row)| {
                let lead = if i == 0 {
                    format!("{mark}  ")
                } else {
                    "   ".into()
                };
                Line::from(Span::styled(format!("{lead}{row}"), style))
            })
            .collect()
    };
    match a.kind.as_str() {
        "tool.completed" | "tool.denied" => tool_lines(a, elapsed_ms, w, th, sym),
        "runtime.error" => notice(th.error, sym.cross, described(), true),
        "runtime.warning" => notice(th.warning, sym.warning, described(), false),
        "context-compaction" => {
            let tokens = match (
                a.payload["beforeTokens"].as_u64(),
                a.payload["afterTokens"].as_u64(),
            ) {
                (Some(before), Some(after)) => {
                    format!(" ({} → {})", format_tokens(before), format_tokens(after))
                }
                _ => String::new(),
            };
            let text = format!("{}{tokens}", crate::i18n::tr("transcript.compaction"));
            vec![Line::from(vec![
                Span::styled(format!("{}  ", sym.done), Style::new().fg(th.success)),
                Span::styled(
                    truncate(&text, w.saturating_sub(3)),
                    Style::new().fg(th.accent),
                ),
            ])]
        }
        _ => Vec::new(),
    }
}

fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1000 {
        format!("{:.1}k", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

/// The first non-empty line of a server string, cleaned for the terminal; "" for anything else.
pub(crate) fn first_line(value: &Value) -> String {
    value
        .as_str()
        .map(|s| {
            sanitize(s)
                .split('\n')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

/// The command a provider ran, without the `/bin/zsh -lc '…'` around it. The closing quote may be
/// gone when the server cut the detail short.
pub fn shell_command(detail: &str) -> String {
    let Some((head, args)) = detail.trim_start().split_once(' ') else {
        return detail.to_string();
    };
    let shell = head.rsplit('/').next().unwrap_or(head);
    if !matches!(shell, "sh" | "bash" | "zsh" | "dash") {
        return detail.to_string();
    }
    let args = args.trim_start();
    let Some(inner) = args
        .strip_prefix("-lc ")
        .or_else(|| args.strip_prefix("-c "))
    else {
        return detail.to_string();
    };
    let inner = inner.trim_start();
    let Some(quote) = inner.chars().next().filter(|q| *q == '\'' || *q == '"') else {
        return inner.to_string();
    };
    let body = &inner[1..];
    let body = body.strip_suffix(quote).unwrap_or(body);
    if quote == '\'' {
        body.replace("'\\''", "'")
    } else {
        body.to_string()
    }
}

/// A tool took long enough to be worth saying how long; a quicker one is left unmarked.
pub fn format_duration(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms < 1000.0 {
        return None;
    }
    let seconds = ms / 1000.0;
    Some(if seconds < 10.0 {
        format!("{seconds:.1}s")
    } else if seconds < 60.0 {
        format!("{}s", seconds.round() as u64)
    } else {
        let whole = seconds.round() as u64;
        format!("{}m {}s", whole / 60, whole % 60)
    })
}

pub(crate) fn tool_title(a: &Activity) -> String {
    [
        first_line(&a.payload["title"]),
        first_line(&Value::String(a.summary.clone())),
        first_line(&a.payload["toolName"]),
    ]
    .into_iter()
    .find(|t| !t.is_empty())
    .unwrap_or_else(|| "tool".into())
}

pub(crate) fn tool_failed(a: &Activity) -> bool {
    a.kind == "tool.denied" || matches!(a.payload["status"].as_str(), Some("failed" | "declined"))
}

/// The one line of output the server keeps for a finished tool, or why it failed.
pub(crate) fn result_summary(data: &Value, failed: bool) -> String {
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
        .map(first_line)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
}

fn changed_files(data: &Value) -> Vec<String> {
    data["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| first_line(&f["path"]))
        .filter(|p| !p.is_empty())
        .collect()
}

/// `◇  name  command  2.3s` (`✗` in the mark's place when it failed), then a dim row with what the
/// tool reported, when the activity carries any.
fn tool_lines(
    a: &Activity,
    elapsed_ms: Option<i64>,
    w: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let data = &a.payload["data"];
    let title = tool_title(a);
    let detail = shell_command(&first_line(&a.payload["detail"]));
    let failed = tool_failed(a);
    let reported = data["item"]["durationMs"].as_f64();
    let duration = format_duration(reported.or(elapsed_ms.map(|e| e as f64)).unwrap_or(0.0));

    let (mark, name_color) = if failed {
        (sym.cross, th.error)
    } else {
        (sym.done, th.tool)
    };
    let mark_color = if failed { th.error } else { th.success };
    let mut spans = vec![
        Span::styled(
            format!("{mark}  "),
            Style::new().fg(mark_color).add_modifier(if failed {
                Modifier::BOLD
            } else {
                Modifier::empty()
            }),
        ),
        Span::styled(
            title.clone(),
            Style::new().fg(name_color).add_modifier(Modifier::BOLD),
        ),
    ];
    let tail = duration
        .as_ref()
        .map(|d| format!("  {d}"))
        .unwrap_or_default();
    let used = 3 + width(&title) + width(&tail) + 2;
    let room = DETAIL_COLUMNS.min(w.saturating_sub(used));
    if !detail.is_empty() && room >= 4 {
        spans.push(Span::styled(
            format!("  {}", truncate(&detail, room)),
            th.muted_style(),
        ));
    }
    if !tail.is_empty() {
        spans.push(Span::styled(tail, th.dim_style()));
    }
    let mut rows = vec![Line::from(spans)];

    let mut result = result_summary(data, failed);
    if result.is_empty() && a.payload["itemType"] == "file_change" {
        let files = changed_files(data);
        let listed = files
            .iter()
            .take(FILES_LISTED)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        result = if files.len() > FILES_LISTED {
            format!("{listed} +{} more", files.len() - FILES_LISTED)
        } else {
            listed
        };
    }
    if !result.is_empty() && result != detail && result != title {
        let color = if failed { th.error } else { th.dim };
        rows.push(Line::from(vec![
            Span::styled(format!("{}  ", sym.bar), th.dim_style()),
            Span::styled(
                truncate(&result, w.saturating_sub(3)),
                Style::new().fg(color),
            ),
        ]));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{LAVENDER, UNICODE};
    use serde_json::json;

    fn thread(messages: Value, activities: Value) -> Thread {
        serde_json::from_value(json!({"messages": messages, "activities": activities})).unwrap()
    }

    fn plain(lines: &[Line]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    fn tool(id: &str, at: &str, kind: &str, payload: Value) -> Value {
        json!({"id": id, "tone": "tool", "kind": kind, "summary": "Ran", "payload": payload, "createdAt": at})
    }

    #[test]
    fn messages_tools_and_notices_come_out_in_time_order() {
        let t = thread(
            json!([
                {"id": "u", "role": "user", "text": "run it", "createdAt": "2026-01-01T00:00:00.000Z"},
                {"id": "a", "role": "assistant", "text": "**Done** with `x`", "createdAt": "2026-01-01T00:00:09.000Z"}
            ]),
            json!([
                tool(
                    "t1",
                    "2026-01-01T00:00:01.000Z",
                    "tool.started",
                    json!({"toolCallId": "c1"})
                ),
                tool(
                    "t2",
                    "2026-01-01T00:00:04.500Z",
                    "tool.completed",
                    json!({"toolCallId": "c1", "title": "Bash", "detail": "/bin/zsh -lc 'ls -la'", "data": {"item": {"aggregatedOutput": "total 8\nrest"}}})
                ),
                tool(
                    "w",
                    "2026-01-01T00:00:05.000Z",
                    "runtime.warning",
                    json!({"message": "slow"})
                ),
            ]),
        );
        let rows = plain(&lines(&t, 60, &LAVENDER, &UNICODE));
        let text = rows.join("\n");
        let order: Vec<usize> = [
            "run it",
            "◇  Bash  ls -la  3.5s",
            "│  total 8",
            "▲  Ran - slow",
            "● Done with x",
        ]
        .iter()
        .map(|needle| {
            text.find(needle)
                .unwrap_or_else(|| panic!("{needle} in\n{text}"))
        })
        .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{text}");
        assert!(
            !rows.iter().any(|r| r.contains("/bin/zsh")),
            "the shell wrapper is removed"
        );
    }

    #[test]
    fn a_failed_tool_leads_with_a_cross_and_shows_why() {
        let t = thread(
            json!([]),
            json!([tool(
                "t",
                "2026-01-01T00:00:01.000Z",
                "tool.completed",
                json!({"title": "Edit", "status": "failed", "data": {"item": {"error": {"message": "no such file\nmore"}}}})
            )]),
        );
        let out = lines(&t, 60, &LAVENDER, &UNICODE);
        let rows = plain(&out);
        assert_eq!(rows[0], "✗  Edit");
        assert_eq!(rows[1], "│  no such file");
        assert_eq!(out[1].spans[1].style.fg, Some(LAVENDER.error));
    }

    #[test]
    fn file_changes_name_their_files() {
        let t = thread(
            json!([]),
            json!([tool(
                "t",
                "2026-01-01T00:00:01.000Z",
                "tool.completed",
                json!({"title": "Patch", "itemType": "file_change", "data": {"files": [{"path": "a"}, {"path": "b"}, {"path": "c"}, {"path": "d"}]}})
            )]),
        );
        assert_eq!(
            plain(&lines(&t, 60, &LAVENDER, &UNICODE))[1],
            "│  a, b, c +1 more"
        );
    }

    #[test]
    fn shell_wrappers_and_durations() {
        assert_eq!(
            shell_command("/bin/zsh -lc 'echo '\\''hi'\\'''"),
            "echo 'hi'"
        );
        assert_eq!(shell_command("bash -c \"ls\""), "ls");
        assert_eq!(shell_command("git status"), "git status");
        assert_eq!(shell_command("/bin/zsh -lc 'cut off"), "cut off");
        assert_eq!(format_duration(500.0), None);
        assert_eq!(format_duration(2300.0).as_deref(), Some("2.3s"));
        assert_eq!(format_duration(75_000.0).as_deref(), Some("1m 15s"));
    }

    #[test]
    fn user_messages_sit_on_the_right_and_every_line_fits() {
        let t = thread(
            json!([{"id": "u", "role": "user", "text": "안녕하세요 반갑습니다 오늘 날씨가 좋네요", "createdAt": "1"}]),
            json!([]),
        );
        for line in lines(&t, 20, &LAVENDER, &UNICODE) {
            let cells: usize = line.spans.iter().map(|s| width(&s.content)).sum();
            assert!(cells <= 20, "{line:?}");
        }
    }
}
