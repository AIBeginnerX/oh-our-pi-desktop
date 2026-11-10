//! The conversation as lines: messages, finished tool calls, notices and plans in the order they
//! happened. A port of the shape of the former TypeScript terminal's transcript, as a pure function of the
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
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

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

/// The conversation's rows and, for each, what a selection may take of it. The rows stay in the
/// segments the block cache laid out, so a rebuild joins the unchanged ones by a reference-count
/// bump instead of copying every line again.
#[derive(Default)]
pub struct Transcript {
    segs: Vec<Seg>,
    /// The line index each segment starts at, parallel to `segs`.
    starts: Vec<usize>,
    total: usize,
}

/// One laid-out block as the transcript holds it, shared with the block cache.
struct Seg {
    lines: Rc<[Line<'static>]>,
    meta: Rc<[RowMeta]>,
}

impl Transcript {
    pub fn len(&self) -> usize {
        self.total
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// The segment `row` falls in, with where its lines start among them.
    fn seg_of(&self, row: usize) -> Option<(usize, usize)> {
        let seg = match self.starts.binary_search(&row) {
            Ok(at) => at,
            Err(at) => at.checked_sub(1)?,
        };
        Some((seg, row - *self.starts.get(seg)?))
    }

    pub fn line(&self, row: usize) -> Option<&Line<'static>> {
        let (seg, at) = self.seg_of(row)?;
        self.segs.get(seg)?.lines.get(at)
    }

    /// What a selection may take of `row`.
    pub fn meta(&self, row: usize) -> Option<RowMeta> {
        let (seg, at) = self.seg_of(row)?;
        self.segs.get(seg)?.meta.get(at).copied()
    }

    /// Walks the rows; the tests read the picture as a whole.
    #[cfg(test)]
    pub fn iter(&self) -> impl Iterator<Item = &Line<'static>> {
        self.segs.iter().flat_map(|seg| seg.lines.iter())
    }

    /// The rows as flat slices, for the clipboard and the tests, which take whole blocks at once.
    pub fn rows(&self) -> (Vec<Line<'static>>, Vec<RowMeta>) {
        let mut lines = Vec::with_capacity(self.total);
        let mut meta = Vec::with_capacity(self.total);
        for seg in &self.segs {
            lines.extend(seg.lines.iter().cloned());
            meta.extend(seg.meta.iter().copied());
        }
        (lines, meta)
    }

    /// Lays the joined segments end to end, so a row keeps its number.
    fn stacked(segs: Vec<Seg>) -> Self {
        let mut starts = Vec::with_capacity(segs.len());
        let mut total = 0;
        for seg in &segs {
            starts.push(total);
            total += seg.lines.len();
        }
        Transcript {
            segs,
            starts,
            total,
        }
    }
}

/// Most finished blocks (one message or one tool line) kept laid out; past it the least recently
/// used go first. Threads parked by the recent-thread cache keep theirs until then.
const CACHED_BLOCKS: usize = 1500;

/// One laid-out block and what it was made from.
struct Block {
    /// Hash of everything but the id that the lines depend on (the text, whether it still streams).
    fingerprint: u64,
    /// The build that last used it, for eviction.
    used: u64,
    lines: Rc<[Line<'static>]>,
    rows: Rc<[RowMeta]>,
}

/// The laid-out lines of each message and tool line, by id, so a frame re-wraps and re-styles only
/// the block whose content changed (the message still streaming) and joins the rest from memory.
/// Another width, theme or symbol set empties it: those change every line.
#[derive(Default)]
pub struct BlockCache {
    scope: Option<(usize, Theme, Symbols)>,
    blocks: HashMap<String, Block>,
    builds: u64,
    pub hits: usize,
    pub misses: usize,
}

impl BlockCache {
    fn enter(&mut self, w: usize, th: &Theme, sym: &Symbols) {
        if self.scope != Some((w, *th, *sym)) {
            self.blocks.clear();
            self.scope = Some((w, *th, *sym));
        }
        self.builds += 1;
    }

    fn block(
        &mut self,
        key: String,
        fingerprint: u64,
        make: impl FnOnce() -> (Vec<Line<'static>>, Vec<RowMeta>),
    ) -> (Rc<[Line<'static>]>, Rc<[RowMeta]>) {
        if let Some(b) = self.blocks.get_mut(&key)
            && b.fingerprint == fingerprint
        {
            b.used = self.builds;
            self.hits += 1;
            return (b.lines.clone(), b.rows.clone());
        }
        self.misses += 1;
        let (lines, rows) = make();
        let (lines, rows): (Rc<[Line<'static>]>, Rc<[RowMeta]>) = (Rc::from(lines), Rc::from(rows));
        self.blocks.insert(
            key,
            Block {
                fingerprint,
                used: self.builds,
                lines: lines.clone(),
                rows: rows.clone(),
            },
        );
        (lines, rows)
    }

    fn trim(&mut self) {
        if self.blocks.len() <= CACHED_BLOCKS {
            return;
        }
        let mut by_age: Vec<(u64, String)> = self
            .blocks
            .iter()
            .map(|(key, b)| (b.used, key.clone()))
            .collect();
        by_age.sort_unstable();
        for (_, key) in by_age.into_iter().take(self.blocks.len() - CACHED_BLOCKS) {
            self.blocks.remove(&key);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.blocks.len()
    }
}

fn fingerprint(parts: impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
pub fn lines(thread: &Thread, w: usize, th: &Theme, sym: &Symbols) -> Vec<Line<'static>> {
    build(thread, w, th, sym).rows().0
}

/// The latest answer, which `/copy` reads: the agent's messages (in time order) since the user last
/// spoke before the last of them, so a closing "Done." after a command does not hide the command, and
/// a question just sent does not hide the answer before it.
pub fn answer(thread: &Thread) -> Vec<&crate::thread::Message> {
    let mut messages: Vec<&crate::thread::Message> = thread.messages.iter().collect();
    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let Some(last) = messages
        .iter()
        .rposition(|m| m.role == Role::Assistant && !m.text.trim().is_empty())
    else {
        return Vec::new();
    };
    let start = messages[..last]
        .iter()
        .rposition(|m| m.role == Role::User)
        .map_or(0, |i| i + 1);
    messages[start..=last]
        .iter()
        .filter(|m| m.role == Role::Assistant && !m.text.trim().is_empty())
        .copied()
        .collect()
}

/// Each message of the latest answer with where its code blocks sit among the answer's.
fn marks(thread: &Thread) -> HashMap<&str, markdown::Mark> {
    let answer = answer(thread);
    let counts: Vec<usize> = answer
        .iter()
        .map(|m| markdown::code_blocks(&m.text).len())
        .collect();
    let total: usize = counts.iter().sum();
    let mut first = 1;
    let mut out = HashMap::new();
    for (m, count) in answer.iter().zip(counts) {
        if count > 0 {
            out.insert(m.id.as_str(), markdown::Mark { first, total });
        }
        first += count;
    }
    out
}

#[cfg(test)]
pub fn build(thread: &Thread, w: usize, th: &Theme, sym: &Symbols) -> Transcript {
    build_cached(thread, w, th, sym, &mut BlockCache::default())
}

pub fn build_cached(
    thread: &Thread,
    w: usize,
    th: &Theme,
    sym: &Symbols,
    cache: &mut BlockCache,
) -> Transcript {
    let w = w.max(10);
    cache.enter(w, th, sym);
    let marks = marks(thread);
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

    let mut segs: Vec<Seg> = Vec::new();
    let mut starts: HashMap<String, i64> = HashMap::new();
    // A run of tool lines and notices stays together; everything else is a block with a gap after.
    let mut in_run = false;
    for (_, item) in items {
        let (lines, rows, run) = match item {
            Item::Message(message) => {
                let mark = marks.get(message.id.as_str()).copied();
                let print = fingerprint((
                    &message.text,
                    message.streaming,
                    message.role as u8,
                    mark.map(|m| (m.first, m.total)),
                ));
                let (lines, rows) = cache.block(format!("m{}", message.id), print, || {
                    message_lines(message, mark, w, th, sym)
                });
                (lines, Some(rows), false)
            }
            Item::Plan(plan) => {
                let lines: Rc<[Line<'static>]> =
                    Rc::from(plan_lines(&plan.plan_markdown, w, th, sym));
                (lines, None, false)
            }
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
                let print = fingerprint((
                    &activity.kind,
                    &activity.summary,
                    &activity.tone,
                    activity.sequence,
                    elapsed,
                ));
                let (lines, rows) = cache.block(format!("a{}", activity.id), print, || {
                    let lines = activity_lines(activity, elapsed, w, th, sym);
                    let rows = vec![RowMeta::default(); lines.len()];
                    (lines, rows)
                });
                (lines, Some(rows), true)
            }
        };
        if lines.is_empty() {
            continue;
        }
        if !segs.is_empty() && !(run && in_run) {
            segs.push(Seg {
                lines: Rc::from(vec![Line::default()]),
                meta: Rc::from(vec![RowMeta::default()]),
            });
        }
        let meta = rows.unwrap_or_else(|| Rc::from(vec![RowMeta::default(); lines.len()]));
        segs.push(Seg { lines, meta });
        in_run = run;
    }
    cache.trim();
    Transcript::stacked(segs)
}

fn message_lines(
    m: &crate::thread::Message,
    mark: Option<markdown::Mark>,
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
        // A long message (a big paste) shows its first line and a count; the text is whole.
        Role::User => user_lines(
            crate::paste::fold(&m.text).as_deref().unwrap_or(&m.text),
            w,
            th,
            sym,
        ),
        Role::Assistant => {
            if m.text.trim().is_empty() {
                return (Vec::new(), Vec::new());
            }
            let lines =
                markdown::render_marked(&m.text, w.saturating_sub(2), th, sym, m.streaming, mark)
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
/// four fifths of the room (the former TypeScript terminal's width rules), so a long message
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
/// tool reported, when the activity carries any. A quiet exit (`exit 1` dim after the line) is a
/// query's "no", never a failure.
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
    let quiet = crate::flow::is_quiet_command_exit(&a.payload);
    let reported = data["item"]["durationMs"].as_f64();
    let duration = format_duration(reported.or(elapsed_ms.map(|e| e as f64)).unwrap_or(0.0));

    let (mark, name_color) = if quiet {
        (sym.idle, th.muted)
    } else if failed {
        (sym.cross, th.error)
    } else {
        (sym.done, th.tool)
    };
    let mark_color = if quiet {
        th.muted
    } else if failed {
        th.error
    } else {
        th.success
    };
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
    let mut tail = duration
        .as_ref()
        .map(|d| format!("  {d}"))
        .unwrap_or_default();
    if quiet {
        tail.push_str(" · exit 1");
    }
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

    let mut result = result_summary(data, failed && !quiet);
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
    use crate::theme::{ASCII, LAVENDER, UNICODE};
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

    /// A whole transcript as text, without styling.
    fn text_of(t: &Transcript) -> Vec<String> {
        plain(&t.rows().0)
    }

    fn tool(id: &str, at: &str, kind: &str, payload: Value) -> Value {
        json!({"id": id, "tone": "tool", "kind": kind, "summary": "Ran", "payload": payload, "createdAt": at})
    }

    /// A synthetic long thread: `n` finished exchanges (a user line, a markdown reply with a code
    /// block, one tool call) and a streaming reply at the end.
    fn long_thread(n: usize, streaming_text: &str) -> Thread {
        let mut messages = Vec::new();
        let mut activities = Vec::new();
        for i in 0..n {
            let at = |_: usize| format!("2026-01-01T00:{:02}:{:02}.000Z", i / 60, i % 60);
            messages.push(json!({"id": format!("u{i}"), "role": "user", "text": format!("question {i} about the code"), "createdAt": at(0)}));
            messages.push(json!({"id": format!("a{i}"), "role": "assistant",
                "text": format!("## Answer {i}\n\nSome **bold** text and `code` that is long enough to wrap across a couple of rows of a normal terminal window, {}.\n\n- one\n- two\n\n```rust\nfn main() {{ println!(\"{i}\"); }}\n```\n", "word ".repeat(30)),
                "createdAt": at(0)}));
            activities.push(tool(
                &format!("t{i}"),
                &at(0),
                "tool.completed",
                json!({"toolCallId": format!("c{i}"), "detail": "ls -la"}),
            ));
        }
        messages.push(json!({"id": "live", "role": "assistant", "streaming": true, "text": streaming_text, "createdAt": "2027-01-01T00:00:00.000Z"}));
        thread(json!(messages), json!(activities))
    }

    #[test]
    fn a_finished_block_is_laid_out_once_and_only_the_streaming_one_again() {
        let (th, sym) = (LAVENDER, UNICODE);
        let mut cache = BlockCache::default();
        let mut t = long_thread(5, "first");
        let first = build_cached(&t, 80, &th, &sym, &mut cache);
        assert_eq!((cache.hits, cache.misses), (0, 16));
        // The same thread again: every block is a hit and the picture is the same.
        let again = build_cached(&t, 80, &th, &sym, &mut cache);
        assert_eq!((cache.hits, cache.misses), (16, 16));
        assert_eq!(text_of(&first), text_of(&again));
        assert_eq!(first.rows().1, again.rows().1);
        // A delta on the streaming message re-lays out that message alone.
        t.messages.last_mut().unwrap().text.push_str(" more");
        let grown = build_cached(&t, 80, &th, &sym, &mut cache);
        assert_eq!((cache.hits, cache.misses), (31, 17));
        assert_eq!(text_of(&grown), plain(&lines(&t, 80, &th, &sym)));
    }

    #[test]
    fn another_width_theme_or_symbol_set_lays_everything_out_again() {
        let t = long_thread(3, "x");
        let mut cache = BlockCache::default();
        build_cached(&t, 80, &LAVENDER, &UNICODE, &mut cache);
        let blocks = cache.misses;
        build_cached(&t, 80, &LAVENDER, &UNICODE, &mut cache);
        assert_eq!(cache.misses, blocks);
        let narrow = build_cached(&t, 40, &LAVENDER, &UNICODE, &mut cache);
        assert_eq!(cache.misses, 2 * blocks);
        assert_eq!(text_of(&narrow), plain(&lines(&t, 40, &LAVENDER, &UNICODE)));
        build_cached(&t, 40, &LAVENDER, &ASCII, &mut cache);
        assert_eq!(cache.misses, 3 * blocks);
        let plain_theme = LAVENDER.for_level(0);
        build_cached(&t, 40, &plain_theme, &ASCII, &mut cache);
        assert_eq!(cache.misses, 4 * blocks);
    }

    #[test]
    fn the_least_recently_used_blocks_go_first() {
        let (th, sym) = (LAVENDER, UNICODE);
        let mut cache = BlockCache::default();
        // Two threads, each a little over half the cache; the second pushes the first out.
        let per = CACHED_BLOCKS / 2 / 3 + 1;
        let one = long_thread(per, "x");
        let mut two = long_thread(per, "x");
        for m in &mut two.messages {
            m.id = format!("b{}", m.id);
        }
        for a in &mut two.activities {
            a.id = format!("b{}", a.id);
        }
        build_cached(&one, 80, &th, &sym, &mut cache);
        build_cached(&two, 80, &th, &sym, &mut cache);
        assert!(cache.len() <= CACHED_BLOCKS);
        // The second thread is whole in memory; the first lost its oldest blocks.
        let misses = cache.misses;
        build_cached(&two, 80, &th, &sym, &mut cache);
        assert_eq!(cache.misses, misses);
        build_cached(&one, 80, &th, &sym, &mut cache);
        assert!(cache.misses > misses);
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

    #[test]
    fn a_chart_in_a_reply_keeps_its_height_rows_and_placeholder_while_streaming() {
        let chart = "```chart\n{\"type\":\"bar\",\"labels\":[\"a\",\"b\"],\"series\":[{\"name\":\"x\",\"data\":[3,5]}]}\n```";
        let reply = |text: &str, streaming: bool| {
            thread(
                json!([{"id": "a", "role": "assistant", "text": text, "streaming": streaming, "createdAt": "2026-01-01T00:00:00.000Z"}]),
                json!([]),
            )
        };
        let done = reply(&format!("look\n{chart}\nok"), false);
        let first = build(&done, 70, &LAVENDER, &UNICODE);
        let (first_lines, first_meta) = first.rows();
        assert_eq!(first_meta.len(), first_lines.len());
        // Every later frame of the reveal (and the settled one) has the same number of rows.
        for _ in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let again = build(&done, 70, &LAVENDER, &UNICODE);
            assert_eq!(again.len(), first.len());
            assert_eq!(again.rows().1.len(), again.len());
        }
        let rows = plain(&first_lines).join("\n");
        assert!(rows.contains("look") && rows.contains("ok") && !rows.contains("\"type\""));
        // A narrower terminal re-renders at its own width.
        let narrow = build(&done, 40, &LAVENDER, &UNICODE);
        assert!(
            narrow
                .iter()
                .all(|l| crate::text::width(&plain(std::slice::from_ref(l))[0]) <= 40)
        );
        // Still streaming with the fence open: one placeholder row, not a half-drawn chart.
        let open = reply("look\n```chart\n{\"type\":\"ba", true);
        let rows = plain(&build(&open, 70, &LAVENDER, &UNICODE).rows().0);
        assert_eq!(
            rows.iter().filter(|r| r.contains("chart")).count(),
            1,
            "{rows:?}"
        );
    }
}
