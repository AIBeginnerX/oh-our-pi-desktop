//! The Files panel: the files this thread has touched, as a tree, built from the tool activities
//! (`tool.started` / `tool.updated` / `tool.completed`) of the thread on screen. Reads and edits
//! have their own colours; a file whose tool is still running pulses until the tool ends, and a
//! finished one keeps a steady colour with a read or edit mark. Pure functions from the read model
//! to lines, like the panels beside it.
//!
//! Where a path comes from depends on the provider, and the server slims every tool payload before
//! it is stored (`ActivityPayloadProjection.ts`), so several places are tried and a payload that
//! names no path is skipped:
//! - `data.files[].path`: what the server collects from any path-like key (Codex `file_change`
//!   items, ACP providers, MCP calls);
//! - `data.locations[].path`, `data.input` / `data.rawInput` / `data.item` with `path`,
//!   `filePath`, `file_path`, `notebook_path`: the unslimmed forms;
//! - the `detail` line: Claude writes `Read: {"file_path":"…"}` (the slimmed payload drops the
//!   input but keeps this line, cut at 400 characters), an image view writes the bare path.

use crate::flow::{Cat, FlowInput, tool_category, tool_name};
use crate::panels_common::*;
use crate::text::{char_width, sanitize, width};
use crate::theme::{Symbols, Theme};
use crate::thread::Thread;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// Files kept for the tree; a thread that touched more shows the first of them.
const FILE_LIMIT: usize = 400;
/// Paths read from one tool call (a patch may name many).
const PATHS_PER_CALL: usize = 24;
/// How deep the payload is searched for path keys.
const SEARCH_DEPTH: usize = 4;
/// Characters the pulse lights at once.
const PULSE_WIDTH: usize = 3;

/// What a tool did with a file. `Write` is a whole file put down: the `Write` tool, or a change the
/// provider calls an add. The `Write` tool does not say whether the file was there before, so it
/// reads "written", not "new".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Touch {
    Read,
    Edit,
    Write,
}

/// How a file stands in the tree once its tools have ended: the latest call failed, else the
/// strongest thing done to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileState {
    Read,
    Edit,
    Write,
    Failed,
}

/// One file of the thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileUse {
    pub path: String,
    pub read: bool,
    pub edited: bool,
    /// Put down whole by a write (an edit too, as far as `edited` goes).
    pub written: bool,
    /// The latest call that ended on it failed or was declined; a later one that works clears it.
    pub failed: bool,
    /// A tool of the running turn is working on it now (an edit or write outranks a read).
    pub active: Option<Touch>,
}

impl FileUse {
    /// An edited file counts as edited even if it was read first.
    pub fn touch(&self) -> Touch {
        if self.written {
            Touch::Write
        } else if self.edited {
            Touch::Edit
        } else {
            Touch::Read
        }
    }

    pub fn state(&self) -> FileState {
        if self.failed {
            FileState::Failed
        } else {
            match self.touch() {
                Touch::Write => FileState::Write,
                Touch::Edit => FileState::Edit,
                Touch::Read => FileState::Read,
            }
        }
    }
}

// ---- reading the activities ---------------------------------------------------------------------

const PATH_KEYS: [&str; 8] = [
    "path",
    "filePath",
    "file_path",
    "notebook_path",
    "relativePath",
    "newPath",
    "oldPath",
    "filename",
];

const NESTED_KEYS: [&str; 11] = [
    "item",
    "input",
    "rawInput",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
    "locations",
];

/// A string that can be a file path: one line, no control characters, not a URL.
fn plausible(text: &str) -> Option<String> {
    let text = text.trim();
    let ok = !text.is_empty()
        && text.len() <= 1024
        && !text.contains("://")
        && !text.chars().any(char::is_control);
    ok.then(|| {
        // A Windows path is read with its backslashes as separators.
        if text.contains('\\') && !text.contains('/') {
            text.replace('\\', "/")
        } else {
            text.to_string()
        }
    })
}

fn push_path(out: &mut Vec<String>, text: &str) {
    if out.len() < PATHS_PER_CALL
        && let Some(path) = plausible(text)
        && !out.contains(&path)
    {
        out.push(path);
    }
}

/// Walks the payload for path-like keys the way the server does when it slims it.
fn collect_paths(value: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > SEARCH_DEPTH || out.len() >= PATHS_PER_CALL {
        return;
    }
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect_paths(v, out, depth + 1)),
        Value::Object(map) => {
            for key in PATH_KEYS {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    push_path(out, text);
                }
            }
            for key in NESTED_KEYS {
                if let Some(nested) = map.get(key) {
                    collect_paths(nested, out, depth + 1);
                }
            }
        }
        _ => {}
    }
}

/// The string after `"key":"` in text that may be JSON cut short; `None` when it is not closed.
fn quoted_after(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let rest = &text[text.find(&needle)? + needle.len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let mut chars = rest.strip_prefix('"')?.chars();
    let mut out = String::new();
    loop {
        match chars.next()? {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' | 'r' | 't' => return None,
                other => out.push(other),
            },
            ch => out.push(ch),
        }
    }
}

/// Paths in a `detail` line: `Name: {json}` (maybe cut), or a bare path.
fn paths_from_detail(detail: &str, out: &mut Vec<String>) {
    let detail = detail.trim();
    if let Some(open) = detail.find('{') {
        let body = &detail[open..];
        if let Ok(json) = serde_json::from_str::<Value>(body) {
            collect_paths(&json, out, 0);
        } else {
            for key in PATH_KEYS {
                if let Some(text) = quoted_after(body, key) {
                    push_path(out, &text);
                }
            }
        }
        return;
    }
    // An image view's detail is the path alone.
    if !detail.contains(char::is_whitespace) && detail.contains(['/', '.']) {
        push_path(out, detail);
    }
}

/// The paths a tool payload names; empty for a shape this build does not know.
pub fn paths_of(payload: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_paths(&payload["data"], &mut out, 0);
    if out.is_empty()
        && let Some(detail) = payload["detail"].as_str()
    {
        paths_from_detail(detail, &mut out);
    }
    out
}

/// The paths a payload says were added (`kind: "add"` / `{"type": "add"}` beside a path, as Codex
/// writes its changes); the slimmed `files` list keeps no kind, so those are not found.
fn collect_added(value: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > SEARCH_DEPTH || out.len() >= PATHS_PER_CALL {
        return;
    }
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect_added(v, out, depth + 1)),
        Value::Object(map) => {
            let kind = map.get("kind");
            let word = kind
                .and_then(Value::as_str)
                .or_else(|| kind.and_then(|k| k["type"].as_str()));
            if matches!(word, Some("add" | "added" | "create" | "new")) {
                for key in PATH_KEYS {
                    if let Some(text) = map.get(key).and_then(Value::as_str) {
                        push_path(out, text);
                    }
                }
            }
            for key in NESTED_KEYS {
                if let Some(nested) = map.get(key) {
                    collect_added(nested, out, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn failed(status: Option<&str>) -> bool {
    matches!(status, Some("failed" | "error" | "declined"))
}

fn finished(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("completed" | "failed" | "error" | "declined" | "cancelled" | "stopped")
    )
}

struct Call {
    touch: Touch,
    paths: Vec<String>,
    /// Paths the provider says this call added.
    added: Vec<String>,
    /// The `Write` tool: every path is written whole.
    write_tool: bool,
    done: bool,
    failed: bool,
    turn: Option<String>,
}

/// The files the thread's read and edit tools named, in the order they first appeared. While the
/// session runs, the files of calls that have not ended (in the running turn) are `active`.
pub fn touched(thread: &Thread) -> Vec<FileUse> {
    let running = thread.session_running();
    let current_turn = thread
        .session
        .as_ref()
        .and_then(|s| s.active_turn_id.clone())
        .or_else(|| thread.latest_turn.as_ref().map(|t| t.turn_id.clone()));
    let mut calls: Vec<Call> = Vec::new();
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for activity in &thread.activities {
        if !matches!(
            activity.kind.as_str(),
            "tool.started" | "tool.updated" | "tool.completed"
        ) || !activity.payload.is_object()
        {
            continue;
        }
        let payload = &activity.payload;
        let name = tool_name(payload).unwrap_or_default();
        let touch = match tool_category(&name, &payload["data"]["kind"], &payload["itemType"]) {
            Some(Cat::Read) => Touch::Read,
            Some(Cat::Edit) => Touch::Edit,
            _ => continue,
        };
        let paths = paths_of(payload);
        let mut added = Vec::new();
        collect_added(&payload["data"], &mut added, 0);
        let write_tool = name.eq_ignore_ascii_case("write");
        let id = payload["toolCallId"].as_str().filter(|id| !id.is_empty());
        let done = activity.kind == "tool.completed"
            || finished(payload["status"].as_str())
            || id.is_none();
        let at = match id.and_then(|id| by_id.get(id).copied()) {
            Some(at) => at,
            None => {
                calls.push(Call {
                    touch,
                    paths: Vec::new(),
                    added: Vec::new(),
                    write_tool: false,
                    done: false,
                    failed: false,
                    turn: activity.turn_id.clone(),
                });
                if let Some(id) = id {
                    by_id.insert(id, calls.len() - 1);
                }
                calls.len() - 1
            }
        };
        let call = &mut calls[at];
        call.touch = touch;
        call.done |= done;
        call.failed |= failed(payload["status"].as_str());
        call.write_tool |= write_tool;
        for path in added {
            if !call.added.contains(&path) {
                call.added.push(path);
            }
        }
        for path in paths {
            if !call.paths.contains(&path) {
                call.paths.push(path);
            }
        }
    }
    let mut files: Vec<FileUse> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for call in &calls {
        let live = running
            && !call.done
            && (current_turn.is_none() || call.turn.is_none() || call.turn == current_turn);
        for path in &call.paths {
            let at = match index.get(path) {
                Some(at) => *at,
                None if files.len() >= FILE_LIMIT => continue,
                None => {
                    files.push(FileUse {
                        path: path.clone(),
                        read: false,
                        edited: false,
                        written: false,
                        failed: false,
                        active: None,
                    });
                    index.insert(path.clone(), files.len() - 1);
                    files.len() - 1
                }
            };
            let file = &mut files[at];
            let touch =
                if call.touch == Touch::Edit && (call.write_tool || call.added.contains(path)) {
                    Touch::Write
                } else {
                    call.touch
                };
            match touch {
                Touch::Read => file.read = true,
                Touch::Edit => file.edited = true,
                Touch::Write => {
                    file.edited = true;
                    file.written = true;
                }
            }
            if call.done {
                file.failed = call.failed;
            }
            if live && !matches!(file.active, Some(Touch::Edit | Touch::Write)) {
                file.active = Some(touch);
            }
        }
    }
    files
}

// ---- the tree -----------------------------------------------------------------------------------

#[derive(Default)]
struct Node {
    children: BTreeMap<String, Node>,
    file: Option<FileUse>,
}

/// What a row of the tree is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowKind {
    Dir,
    File(FileUse),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeRow {
    pub depth: usize,
    /// A directory chain of single children is one name: `src/ui`.
    pub name: String,
    pub kind: RowKind,
}

/// The shared directory of every file (`/Users/me/proj`), and the rows under it. A directory that
/// holds one directory only is merged with it; directories come before files, each sorted by name.
pub fn tree(files: &[FileUse]) -> (String, Vec<TreeRow>) {
    let mut root = Node::default();
    for file in files {
        let absolute = file.path.starts_with('/');
        let mut node = &mut root;
        let parts = file
            .path
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".");
        let mut parts: Vec<&str> = parts.collect();
        if absolute {
            parts.insert(0, "/");
        }
        let Some(last) = parts.len().checked_sub(1) else {
            continue;
        };
        for (i, part) in parts.iter().enumerate() {
            node = node.children.entry((*part).to_string()).or_default();
            if i == last {
                node.file = Some(file.clone());
            }
        }
    }
    // The directories every file shares are the header, not rows.
    let mut shared: Vec<String> = Vec::new();
    let mut node = &root;
    while node.children.len() == 1 {
        let (name, child) = node.children.iter().next().expect("one child");
        if child.file.is_some() {
            break;
        }
        shared.push(name.clone());
        node = child;
    }
    let mut rows = Vec::new();
    walk(node, 0, &mut rows);
    let header = shared.join("/");
    let header = match header.strip_prefix("//") {
        Some(rest) => format!("/{rest}"),
        None => header,
    };
    (header, rows)
}

fn walk(node: &Node, depth: usize, rows: &mut Vec<TreeRow>) {
    let (dirs, files): (Vec<_>, Vec<_>) = node.children.iter().partition(|(_, c)| c.file.is_none());
    for (name, child) in dirs {
        let (mut label, mut cur) = (name.clone(), child);
        while cur.file.is_none() && cur.children.len() == 1 {
            let (next_name, next) = cur.children.iter().next().expect("one child");
            if next.file.is_some() {
                break;
            }
            label = format!("{}/{next_name}", label.trim_end_matches('/'));
            cur = next;
        }
        rows.push(TreeRow {
            depth,
            name: label,
            kind: RowKind::Dir,
        });
        walk(cur, depth + 1, rows);
    }
    for (name, child) in files {
        if let Some(file) = &child.file {
            rows.push(TreeRow {
                depth,
                name: name.clone(),
                kind: RowKind::File(file.clone()),
            });
        }
    }
}

// ---- cutting long names -------------------------------------------------------------------------

/// The end of `text` in `max` cells, behind an ellipsis when something was cut.
pub fn keep_end(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut tail: Vec<char> = Vec::new();
    let mut used = 1;
    for ch in text.chars().rev() {
        let w = char_width(ch);
        if used + w > max {
            break;
        }
        tail.push(ch);
        used += w;
    }
    tail.push('…');
    tail.into_iter().rev().collect()
}

/// A file name in `max` cells: the start and the end (its extension) kept, the middle an ellipsis.
pub fn keep_ends(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    if max < 4 {
        return crate::text::truncate(text, max);
    }
    let tail_room = (max - 1) / 2;
    let tail = keep_end(text, tail_room + 1);
    let tail = tail.strip_prefix('…').unwrap_or(&tail).to_string();
    let head_room = max - 1 - width(&tail);
    let mut head = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = char_width(ch);
        if used + w > head_room {
            break;
        }
        head.push(ch);
        used += w;
    }
    format!("{head}…{tail}")
}

// ---- drawing ------------------------------------------------------------------------------------

/// A name with a bright window running over it: `tick` moves the window; `None` for the glow
/// leaves the name in `base` alone.
pub fn shimmer(
    name: &str,
    tick: Option<usize>,
    base: Style,
    glow: Style,
) -> Vec<ratatui::text::Span<'static>> {
    let chars: Vec<char> = name.chars().collect();
    let Some(tick) = tick else {
        return vec![sp(name.to_string(), base)];
    };
    let start = (tick % (chars.len() + PULSE_WIDTH)) as isize - PULSE_WIDTH as isize;
    let lit = |i: usize| (i as isize) >= start && (i as isize) < start + PULSE_WIDTH as isize;
    let mut out: Vec<ratatui::text::Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut run_lit = false;
    for (i, ch) in chars.iter().enumerate() {
        if i > 0 && lit(i) != run_lit {
            out.push(sp(
                std::mem::take(&mut run),
                if run_lit { glow } else { base },
            ));
        }
        run_lit = lit(i);
        run.push(*ch);
    }
    if !run.is_empty() {
        out.push(sp(run, if run_lit { glow } else { base }));
    }
    out
}

/// The mark of a state, one cell wide: a shape of its own, so the colours are not the only hint.
fn mark_of(ctx: &Ctx, state: FileState) -> &'static str {
    match (state, ctx.ascii) {
        (FileState::Read, false) => "○",
        (FileState::Edit, false) => "●",
        (FileState::Write, _) => "+",
        (FileState::Failed, false) => "✗",
        (FileState::Read, true) => "r",
        (FileState::Edit, true) => "e",
        (FileState::Failed, true) => "x",
    }
}

/// The theme colour of a state, from the theme's own tokens so every theme carries it: accent for
/// a read, warning for an edit, success for a write, error for a failure.
fn tone_of(ctx: &Ctx, state: FileState) -> Style {
    match state {
        FileState::Read => ctx.accent(),
        FileState::Edit => ctx.warning(),
        FileState::Write => ctx.success(),
        FileState::Failed => ctx.error(),
    }
}

/// The state a running tool puts its file in while it works.
fn state_of_touch(touch: Touch) -> FileState {
    match touch {
        Touch::Read => FileState::Read,
        Touch::Edit => FileState::Edit,
        Touch::Write => FileState::Write,
    }
}

/// The cell after an active file's mark.
fn active_mark(ctx: &Ctx) -> &'static str {
    if ctx.ascii { ">" } else { "›" }
}

/// Below this many cells the legend keeps its marks and counts and drops the words.
const LEGEND_WORDS_MIN: usize = 22;

/// The counts of each state with its mark, which is also the legend of the marks. Reads and edits
/// are always listed; the others once a file is in that state. As many lines of `room` cells as
/// the items need, none split across two.
fn legend(ctx: &Ctx, files: &[FileUse], room: usize) -> Vec<Row> {
    let count = |state: FileState| files.iter().filter(|f| f.state() == state).count();
    let working = files.iter().filter(|f| f.active.is_some()).count();
    let words = room >= LEGEND_WORDS_MIN;
    let item = |mark: &'static str, tone: Style, n: usize, label: String| -> Row {
        if words {
            vec![
                sp(mark, tone),
                sp(format!(" {n} "), ctx.dim()),
                sp(label, ctx.dim()),
            ]
        } else {
            vec![sp(mark, tone), sp(n.to_string(), ctx.dim())]
        }
    };
    let mut items: Vec<Row> = vec![
        item(
            mark_of(ctx, FileState::Read),
            tone_of(ctx, FileState::Read),
            count(FileState::Read),
            s("read", "읽음").to_string(),
        ),
        item(
            mark_of(ctx, FileState::Edit),
            tone_of(ctx, FileState::Edit),
            count(FileState::Edit),
            s("edited", "수정").to_string(),
        ),
    ];
    if count(FileState::Write) > 0 {
        items.push(item(
            mark_of(ctx, FileState::Write),
            tone_of(ctx, FileState::Write),
            count(FileState::Write),
            s("written", "작성").to_string(),
        ));
    }
    if count(FileState::Failed) > 0 {
        items.push(item(
            mark_of(ctx, FileState::Failed),
            tone_of(ctx, FileState::Failed),
            count(FileState::Failed),
            s("failed", "실패").to_string(),
        ));
    }
    if working > 0 {
        items.push(item(
            active_mark(ctx),
            ctx.bold(),
            working,
            s("working", "작업 중").to_string(),
        ));
    }
    let sep = if words {
        format!(" {} ", ctx.g.separator)
    } else {
        " ".to_string()
    };
    let mut rows: Vec<Row> = Vec::new();
    let mut line: Row = Vec::new();
    for item in items {
        if !line.is_empty() && row_width(&line) + width(&sep) + row_width(&item) > room {
            rows.push(clip(std::mem::take(&mut line), room));
        }
        if !line.is_empty() {
            line.push(sp(sep.clone(), ctx.dim()));
        }
        line.extend(item);
    }
    rows.push(clip(line, room));
    rows
}

/// The Files panel as lines for a pane `width` x `height` cells.
pub fn lines(
    input: &FlowInput,
    width: usize,
    height: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let ctx = Ctx::new(th, sym, input.tick, input.animations);
    let room = width.saturating_sub(2).max(8);
    let mut out = head(&ctx, View::Files, room);
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
                s("Loading files…", "파일을 불러오는 중…")
            } else {
                s(
                    "Files load once you are connected.",
                    "연결되면 이 스레드의 파일을 불러옵니다.",
                )
            },
            room,
        ));
        return finish(&ctx, out, width, height);
    }
    let files = touched(input.thread);
    if files.is_empty() {
        if input.online {
            out.extend(empty_state(
                &ctx,
                s("No files yet", "파일이 아직 없습니다"),
                s(
                    "Files the agent reads or edits in the latest work appear here as a tree.",
                    "에이전트가 최신 작업에서 읽거나 수정하는 파일이 트리로 나타납니다.",
                ),
                room,
            ));
        }
        return finish(&ctx, out, width, height);
    }
    out.extend(legend(&ctx, &files, room).into_iter().map(margin));
    let (root, rows) = tree(&files);
    if !root.is_empty() {
        out.push(margin(vec![sp(keep_end(&root, room), ctx.muted())]));
    }
    let pulse = input.animations.then_some(input.tick);
    // Deep trees keep their shape up to a depth, then run on at that indent.
    let max_depth = (room / 4).max(1);
    let mut focus = None;
    let mut body: Vec<Row> = Vec::new();
    for row in &rows {
        let indent = row.depth.min(max_depth) * 2;
        let pad = " ".repeat(indent);
        match &row.kind {
            RowKind::Dir => {
                let name = sanitize(&row.name);
                let label = keep_end(
                    &if name.ends_with('/') {
                        name
                    } else {
                        format!("{name}/")
                    },
                    room.saturating_sub(indent),
                );
                body.push(vec![sp(pad, ctx.text()), sp(label, ctx.dim())]);
            }
            RowKind::File(file) => {
                // A file a tool works on shows what that tool does; otherwise how it stands.
                let state = file.active.map_or(file.state(), state_of_touch);
                let tone = tone_of(&ctx, state);
                let mark = mark_of(&ctx, state);
                // The mark of a working file is followed by `›`, so it reads without its colour too.
                let lead = if file.active.is_some() {
                    format!("{mark}{} ", active_mark(&ctx))
                } else {
                    format!("{mark} ")
                };
                let name = keep_ends(
                    &sanitize(&row.name),
                    room.saturating_sub(indent + crate::text::width(&lead)),
                );
                let mut spans = vec![sp(pad, ctx.text()), sp(lead, tone)];
                if file.active.is_some() {
                    focus.get_or_insert(body.len());
                    let glow = fg(th.brand).add_modifier(Modifier::BOLD);
                    spans.extend(shimmer(
                        &name,
                        pulse,
                        tone.add_modifier(Modifier::BOLD),
                        glow,
                    ));
                } else {
                    spans.push(sp(name, tone));
                }
                body.push(spans);
            }
        }
    }
    let available = height.saturating_sub(out.len());
    let body: Vec<Row> = body.into_iter().map(margin).collect();
    out.extend(window_scrolled(
        &ctx,
        body,
        focus.unwrap_or(0),
        available,
        input.scroll,
    ));
    finish(&ctx, out, width, height)
}

/// A tool is working on a file, so the pulse moves with the clock.
pub fn is_live(input: &FlowInput) -> bool {
    input.animations
        && !input.loading
        && input.thread.session_running()
        && touched(input.thread).iter().any(|f| f.active.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::plain;
    use crate::panels_common::scenes::{act, input, thread};
    use crate::text::width;
    use crate::theme::{ASCII, LAVENDER, UNICODE};
    use ratatui::style::Color;
    use serde_json::json;

    /// A tool activity the way Claude's adapter writes it once the server has slimmed it.
    fn claude(kind: &str, sec: i64, id: &str, name: &str, input: Value, status: &str) -> Value {
        let detail = format!("{name}: {input}");
        act(
            kind,
            sec,
            json!({"toolCallId": id, "status": status, "itemType": "dynamic_tool_call",
                   "detail": detail, "data": {"toolName": name}}),
        )
    }

    fn read(kind: &str, sec: i64, id: &str, path: &str, status: &str) -> Value {
        claude(kind, sec, id, "Read", json!({"file_path": path}), status)
    }

    fn edit(kind: &str, sec: i64, id: &str, path: &str, status: &str) -> Value {
        claude(kind, sec, id, "Edit", json!({"file_path": path}), status)
    }

    fn render(input: &FlowInput, width: usize, height: usize) -> Vec<String> {
        plain(&lines(input, width, height, &LAVENDER, &UNICODE))
    }

    fn file(path: &str, read: bool, edited: bool) -> FileUse {
        FileUse {
            path: path.into(),
            read,
            edited,
            written: false,
            failed: false,
            active: None,
        }
    }

    // ---- where the paths come from ----

    #[test]
    fn a_claude_detail_line_names_the_file_even_when_cut() {
        let whole =
            json!({"detail": "Read: {\"file_path\":\"/a/b.rs\"}", "data": {"toolName": "Read"}});
        assert_eq!(paths_of(&whole), ["/a/b.rs"]);
        let long = format!(
            "Edit: {{\"file_path\":\"/a/c.rs\",\"old_string\":\"{}",
            "x".repeat(380)
        );
        assert_eq!(
            paths_of(&json!({"detail": long, "data": {"toolName": "Edit"}})),
            ["/a/c.rs"],
            "the JSON is cut at 400 characters; the first key is still read"
        );
        let unclosed = json!({"detail": "Read: {\"file_path\":\"/a/d", "data": {}});
        assert!(
            paths_of(&unclosed).is_empty(),
            "a path that is cut is no path"
        );
    }

    #[test]
    fn the_slimmed_files_list_and_the_other_providers_shapes_are_read() {
        let codex = json!({"itemType": "file_change", "data": {"files": [{"path": "src/a.rs"}, {"path": "src/b.rs"}]}});
        assert_eq!(paths_of(&codex), ["src/a.rs", "src/b.rs"]);
        let acp = json!({"data": {"kind": "read", "locations": [{"path": "/w/x.md", "line": 3}]}});
        assert_eq!(paths_of(&acp), ["/w/x.md"]);
        let raw = json!({"data": {"toolName": "read", "input": {"filePath": "C:\\w\\y.ts"}}});
        assert_eq!(paths_of(&raw), ["C:/w/y.ts"]);
        let patch =
            json!({"data": {"item": {"changes": [{"path": "a"}, {"path": "b", "kind": "add"}]}}});
        assert_eq!(paths_of(&patch), ["a", "b"]);
        let image = json!({"itemType": "image_view", "detail": "/tmp/shot.png"});
        assert_eq!(paths_of(&image), ["/tmp/shot.png"]);
    }

    #[test]
    fn shapes_that_name_no_path_are_skipped() {
        for payload in [
            json!(null),
            json!("text"),
            json!({"data": 5}),
            json!({"data": {"files": "nope"}}),
            json!({"data": {"files": [{"path": 3}, {"path": ""}, {"path": "http://x/y"}]}}),
            json!({"detail": "Read the docs and report"}),
            json!({"detail": "Grep: {\"pattern\":\"x\"}"}),
            json!({"data": {"files": [{"path": "bad\npath"}]}}),
        ] {
            assert!(paths_of(&payload).is_empty(), "{payload}");
        }
        let many: Vec<Value> = (0..100).map(|i| json!({"path": format!("f{i}")})).collect();
        assert_eq!(
            paths_of(&json!({"data": {"files": many}})).len(),
            PATHS_PER_CALL,
            "a patch naming hundreds of files is cut"
        );
    }

    // ---- what the thread touched ----

    #[test]
    fn reads_and_edits_are_told_apart_and_an_edit_outranks_a_read() {
        let t = thread(
            vec![
                read("tool.completed", 2, "r1", "/p/a.rs", "completed"),
                read("tool.completed", 3, "r2", "/p/b.rs", "completed"),
                edit("tool.completed", 4, "e1", "/p/a.rs", "completed"),
                claude(
                    "tool.completed",
                    5,
                    "g1",
                    "Grep",
                    json!({"pattern": "x", "path": "/p"}),
                    "completed",
                ),
                claude(
                    "tool.completed",
                    6,
                    "b1",
                    "Bash",
                    json!({"command": "ls /p/c.rs"}),
                    "completed",
                ),
            ],
            false,
        );
        let files = touched(&t);
        assert_eq!(
            files.len(),
            2,
            "searches and commands touch no file: {files:?}"
        );
        assert_eq!(
            (files[0].path.as_str(), files[0].read, files[0].edited),
            ("/p/a.rs", true, true)
        );
        assert_eq!(files[0].touch(), Touch::Edit);
        assert_eq!(files[1].touch(), Touch::Read);
        assert!(
            files.iter().all(|f| f.active.is_none()),
            "the session is idle"
        );
    }

    #[test]
    fn a_file_is_active_only_while_its_tool_runs_in_the_running_turn() {
        let running = thread(
            vec![
                read("tool.completed", 2, "r1", "/p/done.rs", "completed"),
                edit("tool.started", 3, "e1", "/p/busy.rs", ""),
                edit("tool.updated", 4, "e1", "/p/busy.rs", "inProgress"),
                read("tool.started", 5, "r2", "/p/looking.rs", ""),
            ],
            true,
        );
        let files = touched(&running);
        let active: Vec<_> = files
            .iter()
            .filter_map(|f| f.active.map(|a| (f.path.as_str(), a)))
            .collect();
        assert_eq!(
            active,
            [("/p/busy.rs", Touch::Edit), ("/p/looking.rs", Touch::Read)]
        );

        // the tool ends: the pulse stops, the file keeps its edit mark
        let mut done = running.activities.clone();
        done.push(
            serde_json::from_value(edit("tool.completed", 9, "e1", "/p/busy.rs", "completed"))
                .unwrap(),
        );
        let ended = Thread {
            activities: done,
            ..running.clone()
        };
        let busy = touched(&ended)
            .into_iter()
            .find(|f| f.path == "/p/busy.rs")
            .unwrap();
        assert_eq!((busy.active, busy.edited), (None, true));

        // a session that stopped leaves calls that never ended: nothing pulses
        let stopped = thread(
            running
                .activities
                .iter()
                .map(|a| {
                    json!({
            "id": a.id, "tone": a.tone, "kind": a.kind, "summary": a.summary, "payload": a.payload,
            "turnId": a.turn_id, "createdAt": a.created_at})
                })
                .collect(),
            false,
        );
        assert!(touched(&stopped).iter().all(|f| f.active.is_none()));
    }

    #[test]
    fn a_call_left_open_by_an_earlier_turn_does_not_pulse_in_this_one() {
        let mut old = edit("tool.started", 3, "e0", "/p/old.rs", "");
        old["turnId"] = json!("t0");
        let t = thread(
            vec![old, edit("tool.started", 4, "e1", "/p/new.rs", "")],
            true,
        );
        let active: Vec<_> = touched(&t)
            .into_iter()
            .filter(|f| f.active.is_some())
            .map(|f| f.path)
            .collect();
        assert_eq!(active, ["/p/new.rs"]);
    }

    #[test]
    fn a_call_with_no_id_cannot_be_followed_so_it_never_pulses() {
        let mut anonymous = edit("tool.started", 3, "x", "/p/a.rs", "");
        anonymous["payload"]
            .as_object_mut()
            .unwrap()
            .remove("toolCallId");
        let t = thread(vec![anonymous], true);
        assert_eq!(touched(&t)[0].active, None);
    }

    #[test]
    fn the_list_is_bounded() {
        let activities = (0..FILE_LIMIT + 50)
            .map(|i| {
                read(
                    "tool.completed",
                    2,
                    &format!("c{i}"),
                    &format!("/p/f{i}.rs"),
                    "completed",
                )
            })
            .collect();
        assert_eq!(touched(&thread(activities, false)).len(), FILE_LIMIT);
    }

    // ---- the tree ----

    #[test]
    fn the_shared_directory_is_the_header_and_single_child_directories_merge() {
        let files = [
            file("/w/proj/src/ui/a.rs", true, false),
            file("/w/proj/src/ui/deep/er/b.rs", false, true),
            file("/w/proj/Cargo.toml", true, false),
            file("/w/proj/README.md", true, false),
        ];
        let (root, rows) = tree(&files);
        assert_eq!(root, "/w/proj");
        let shown: Vec<(usize, &str)> = rows.iter().map(|r| (r.depth, r.name.as_str())).collect();
        assert_eq!(
            shown,
            [
                (0, "src/ui"),
                (1, "deep/er"),
                (2, "b.rs"),
                (1, "a.rs"),
                (0, "Cargo.toml"),
                (0, "README.md"),
            ],
            "directories before files, each by name"
        );
    }

    #[test]
    fn one_file_is_its_own_row_under_its_directory() {
        let (root, rows) = tree(&[file("/w/proj/a.rs", true, false)]);
        assert_eq!((root.as_str(), rows.len()), ("/w/proj", 1));
        assert_eq!(rows[0].name, "a.rs");
        let (root, rows) = tree(&[file("a.rs", true, false), file("/b.rs", true, false)]);
        assert_eq!(root, "", "a relative and an absolute path share nothing");
        assert_eq!(rows.len(), 3, "the root `/` is a directory row of its own");
        assert_eq!(rows[0].name, "/");
    }

    #[test]
    fn long_names_are_cut_by_cells_not_bytes() {
        assert_eq!(keep_end("/Users/me/dev/project", 10), "…v/project");
        assert_eq!(keep_end("short", 10), "short");
        assert_eq!(keep_ends("really_long_file_name.rs", 12), "really…me.rs");
        for text in [
            "한국어로된아주긴파일이름입니다.rs",
            "混合mixed한글.txt",
            "plain-ascii-name.md",
        ] {
            for max in 0..=24 {
                assert!(width(&keep_end(text, max)) <= max, "{text} {max}");
                assert!(width(&keep_ends(text, max)) <= max, "{text} {max}");
            }
        }
        assert!(keep_ends("한국어로된아주긴파일이름입니다.rs", 12).ends_with(".rs"));
    }

    // ---- the picture ----

    fn busy_thread() -> Thread {
        thread(
            vec![
                read("tool.completed", 2, "r1", "/w/proj/src/lib.rs", "completed"),
                edit(
                    "tool.completed",
                    3,
                    "e1",
                    "/w/proj/src/ui/panel.rs",
                    "completed",
                ),
                read(
                    "tool.completed",
                    4,
                    "r2",
                    "/w/proj/한국어/설명서.md",
                    "completed",
                ),
                edit("tool.started", 5, "e2", "/w/proj/Cargo.toml", ""),
            ],
            true,
        )
    }

    #[test]
    fn the_panel_shows_the_tree_with_marks_and_counts() {
        let t = busy_thread();
        let input = input(&t, &[], 30);
        let text = render(&input, 40, 20);
        let expected = [
            " Workflow │ Agents │ Savvy │ Files",
            " ────────────────────────────━━━━━─────",
            " ○ 2 read │ ● 2 edited │ › 1 working",
            " /w/proj",
            " src/",
            "   ui/",
            "     ● panel.rs",
            "   ○ lib.rs",
            " 한국어/",
            "   ○ 설명서.md",
            " ●› Cargo.toml",
        ];
        assert_eq!(text, expected);
    }

    #[test]
    fn reads_and_edits_have_their_own_colours_and_the_running_one_is_marked() {
        let t = busy_thread();
        let input = input(&t, &[], 30);
        let rows = lines(&input, 40, 20, &LAVENDER, &UNICODE);
        let colour_of = |name: &str| -> Option<Color> {
            rows.iter()
                .flat_map(|l| l.spans.iter())
                .find(|s| s.content.contains(name))
                .and_then(|s| s.style.fg)
        };
        assert_eq!(colour_of("lib.rs"), Some(LAVENDER.accent), "read");
        assert_eq!(colour_of("panel.rs"), Some(LAVENDER.warning), "edit");
        assert_ne!(LAVENDER.accent, LAVENDER.warning);
        // Cargo.toml is being edited: its name is bold (the base style of the pulse), animations or not
        let cargo = rows
            .iter()
            .flat_map(|l| l.spans.iter())
            .find(|s| s.content.contains("Cargo.toml"))
            .unwrap();
        assert!(cargo.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn the_pulse_moves_with_the_tick_and_only_with_animations() {
        let t = busy_thread();
        let glow = |tick: usize, animations: bool| -> Vec<String> {
            let mut i = input(&t, &[], 30);
            i.tick = tick;
            i.animations = animations;
            lines(&i, 40, 20, &LAVENDER, &UNICODE)
                .iter()
                .flat_map(|l| l.spans.iter())
                .filter(|s| {
                    s.style.fg == Some(LAVENDER.brand)
                        && s.style.add_modifier.contains(Modifier::BOLD)
                })
                .map(|s| s.content.to_string())
                .collect()
        };
        assert!(
            glow(0, false).is_empty() && glow(7, false).is_empty(),
            "no animations, no pulse"
        );
        let seen: Vec<_> = (0..12).map(|tick| glow(tick, true)).collect();
        assert!(seen.iter().any(|g| !g.is_empty()));
        assert!(
            seen.windows(2).any(|w| w[0] != w[1]),
            "the bright window travels"
        );
    }

    /// One file in each state, and a sixth that a tool is working on now.
    fn states_thread() -> Thread {
        let codex = act(
            "tool.completed",
            6,
            json!({"toolCallId": "c1", "status": "completed", "itemType": "file_change",
                   "data": {"item": {"changes": [{"path": "/w/p/added.rs", "kind": "add"},
                                                 {"path": "/w/p/changed.rs", "kind": {"type": "update"}}]}}}),
        );
        thread(
            vec![
                read("tool.completed", 2, "r1", "/w/p/read.rs", "completed"),
                edit("tool.completed", 3, "e1", "/w/p/edited.rs", "completed"),
                claude(
                    "tool.completed",
                    4,
                    "w1",
                    "Write",
                    json!({"file_path": "/w/p/written.rs"}),
                    "completed",
                ),
                edit("tool.completed", 5, "e2", "/w/p/failed.rs", "failed"),
                codex,
                read("tool.started", 7, "r2", "/w/p/working.rs", ""),
            ],
            true,
        )
    }

    #[test]
    fn writes_adds_and_failed_calls_are_told_from_plain_edits() {
        let files = touched(&states_thread());
        let state_of = |name: &str| {
            let file = files.iter().find(|f| f.path.ends_with(name)).unwrap();
            (file.state(), file.active)
        };
        assert_eq!(state_of("read.rs").0, FileState::Read);
        assert_eq!(state_of("edited.rs").0, FileState::Edit);
        assert_eq!(state_of("written.rs").0, FileState::Write, "the Write tool");
        assert_eq!(state_of("added.rs").0, FileState::Write, "an add of Codex");
        assert_eq!(
            state_of("changed.rs").0,
            FileState::Edit,
            "an update is an edit"
        );
        assert_eq!(state_of("failed.rs").0, FileState::Failed);
        assert_eq!(state_of("working.rs"), (FileState::Read, Some(Touch::Read)));
        // a later call that works clears the failure; a cancelled one is not a failure
        let mut activities = states_thread().activities;
        activities.push(
            serde_json::from_value(edit(
                "tool.completed",
                8,
                "e3",
                "/w/p/failed.rs",
                "completed",
            ))
            .unwrap(),
        );
        activities.push(
            serde_json::from_value(read("tool.completed", 9, "r3", "/w/p/read.rs", "cancelled"))
                .unwrap(),
        );
        let again = touched(&Thread {
            activities,
            ..states_thread()
        });
        let state = |name: &str| {
            again
                .iter()
                .find(|f| f.path.ends_with(name))
                .unwrap()
                .state()
        };
        assert_eq!(state("failed.rs"), FileState::Edit);
        assert_eq!(state("read.rs"), FileState::Read);
    }

    /// The colour a file's name is drawn in, by its name.
    fn name_colours(rows: &[Line<'static>], names: &[&str]) -> Vec<Option<Color>> {
        names
            .iter()
            .map(|name| {
                rows.iter()
                    .flat_map(|l| l.spans.iter())
                    .find(|s| s.content.contains(name))
                    .and_then(|s| s.style.fg)
            })
            .collect()
    }

    #[test]
    fn each_state_has_its_own_colour_in_every_theme() {
        let t = states_thread();
        let i = input(&t, &[], 30);
        for name in crate::theme::BUILTIN_NAMES {
            let theme = crate::theme::builtin(name).unwrap();
            let rows = lines(&i, 50, 30, &theme, &UNICODE);
            let got = name_colours(&rows, &["read.rs", "edited.rs", "written.rs", "failed.rs"]);
            let want = [theme.accent, theme.warning, theme.success, theme.error];
            assert_eq!(got, want.map(Some), "{name}");
            for (n, a) in want.iter().enumerate() {
                for b in &want[n + 1..] {
                    assert_ne!(a, b, "{name}: two states share a colour");
                }
            }
        }
    }

    #[test]
    fn the_working_file_is_bold_with_its_tools_colour_and_a_chevron() {
        let t = states_thread();
        let i = input(&t, &[], 30);
        let rows = lines(&i, 50, 30, &LAVENDER, &UNICODE);
        let span = rows
            .iter()
            .flat_map(|l| l.spans.iter())
            .find(|s| s.content.contains("working.rs"))
            .unwrap();
        assert!(span.style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(span.style.fg, Some(LAVENDER.accent), "a read in progress");
        assert!(
            render(&i, 50, 30)
                .iter()
                .any(|l| l.contains("○› working.rs")),
            "{:#?}",
            render(&i, 50, 30)
        );
    }

    #[test]
    fn the_states_differ_by_shape_when_there_is_no_colour() {
        let t = states_thread();
        let i = input(&t, &[], 30);
        for (sym, marks) in [
            (
                &UNICODE,
                ["○ read.rs", "● edited.rs", "+ written.rs", "✗ failed.rs"],
            ),
            (
                &ASCII,
                ["r read.rs", "e edited.rs", "+ written.rs", "x failed.rs"],
            ),
        ] {
            let mono = LAVENDER.for_level(0);
            let text = plain(&lines(&i, 50, 30, &mono, sym));
            for mark in marks {
                assert!(text.iter().any(|l| l.contains(mark)), "{mark}: {text:#?}");
            }
        }
    }

    #[test]
    fn the_legend_counts_each_state_and_gives_up_its_words_on_a_narrow_pane() {
        let t = states_thread();
        let i = input(&t, &[], 30);
        let wide = render(&i, 70, 30);
        assert_eq!(
            wide[2], " ○ 2 read │ ● 2 edited │ + 2 written │ ✗ 1 failed │ › 1 working",
            "{wide:#?}"
        );
        let wrapped = render(&i, 60, 30);
        assert_eq!(
            wrapped[3], " › 1 working",
            "an item moves down whole: {wrapped:#?}"
        );
        let narrow = render(&i, 20, 30);
        assert!(narrow.iter().any(|l| l == " ○2 ●2 +2 ✗1 ›1"), "{narrow:#?}");
        let medium = render(&i, 36, 30);
        assert!(
            medium.iter().any(|l| l.contains("+ 2 written")),
            "{medium:#?}"
        );
        for w in [8, 12, 20, 28, 36] {
            for line in render(&i, w, 30) {
                assert!(width(&line) <= w, "{w}: {line:?}");
            }
        }
    }

    #[test]
    fn nothing_pulses_once_every_tool_has_ended() {
        let t = thread(
            vec![
                edit("tool.started", 3, "e1", "/w/a.rs", ""),
                edit("tool.completed", 4, "e1", "/w/a.rs", "completed"),
            ],
            true,
        );
        let mut i = input(&t, &[], 30);
        i.animations = true;
        assert!(!is_live(&i), "the running turn is not a tool");
        let busy = busy_thread();
        let mut i = input(&busy, &[], 30);
        assert!(!is_live(&i), "animations are off");
        i.animations = true;
        assert!(is_live(&i));
        i.loading = true;
        assert!(!is_live(&i));
        let idle = thread(vec![edit("tool.started", 3, "e1", "/w/a.rs", "")], false);
        let mut i = input(&idle, &[], 30);
        i.animations = true;
        assert!(!is_live(&i), "an idle session repaints nothing");
    }

    #[test]
    fn the_panel_fits_every_size_and_both_symbol_sets() {
        let t = busy_thread();
        let mut crowded = t.activities.clone();
        for n in 0..60 {
            crowded.push(
                serde_json::from_value(read(
                    "tool.completed",
                    10,
                    &format!("x{n}"),
                    &format!("/w/proj/모듈{n}/아주아주긴디렉터리이름/파일_{n}.rs"),
                    "completed",
                ))
                .unwrap(),
            );
        }
        let many = Thread {
            activities: crowded,
            ..t.clone()
        };
        for thread in [&t, &many] {
            for (w, h) in [(8, 3), (20, 6), (33, 5), (36, 24), (50, 10), (72, 40)] {
                for (th, sym) in [(&LAVENDER, &UNICODE), (&LAVENDER, &ASCII)] {
                    let mut i = input(thread, &[], 30);
                    i.animations = true;
                    i.tick = 3;
                    let rows = lines(&i, w, h, th, sym);
                    assert!(rows.len() <= h, "{w}x{h}: {} rows", rows.len());
                    for line in plain(&rows) {
                        assert!(width(&line) <= w, "{w}x{h}: {line:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_long_list_scrolls_with_the_wheel_and_says_how_much_lies_beyond() {
        let mut activities = Vec::new();
        for n in 0..40 {
            activities.push(read(
                "tool.completed",
                2,
                &format!("c{n}"),
                &format!("/w/f{n:02}.rs"),
                "completed",
            ));
        }
        let t = thread(activities, false);
        let scroll = std::cell::Cell::new(0);
        let mut i = input(&t, &[], 30);
        i.scroll = Some(&scroll);
        let top = render(&i, 40, 12);
        assert!(top.iter().any(|l| l.contains("lines below")), "{top:#?}");
        scroll.set(100);
        let bottom = render(&i, 40, 12);
        assert!(bottom.iter().any(|l| l.contains("lines above")));
        assert!(bottom.iter().any(|l| l.contains("f39.rs")));
        assert_ne!(top, bottom);
    }

    #[test]
    fn the_empty_loading_and_offline_states_are_words_not_blanks() {
        let none = thread(vec![], false);
        let text = render(&input(&none, &[], 30), 40, 20);
        assert!(text.iter().any(|l| l.contains("No files yet")), "{text:#?}");
        let mut i = input(&none, &[], 30);
        i.loading = true;
        assert!(
            render(&i, 40, 20)
                .iter()
                .any(|l| l.contains("Loading files"))
        );
        i.loading = false;
        i.online = false;
        let text = render(&i, 40, 20);
        assert!(text.iter().any(|l| l.contains("Disconnected")));
        assert!(!text.iter().any(|l| l.contains("No files yet")));
    }
}
