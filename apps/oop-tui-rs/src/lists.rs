//! `/projects` and `/threads`: the two pickers of the TypeScript terminal (`showProjects`,
//! `showThreads`, `handlePickerKey` and `app/projects.ts`, `threadList.ts`, `listSearch.ts`) as
//! full-body screens. Letters are search (every typed word has to match, best match first), the
//! arrows move, Enter opens, Esc undoes the search and then steps back, and Ctrl+P pins or unpins
//! the thread under the pointer.

use crate::app::{Active, App};
use crate::notes::Tone;
use crate::panels_common::{fill, s};
use crate::screen::Screen;
use crate::sidebar::{is_crew_sub_thread, sort_pinned};
use crate::state::{ProjectShell, ThreadShell};
use crate::text::{iso_now, parse_iso_ms, sanitize, truncate, width};
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

// ---- search --------------------------------------------------------------------------------

/// Longest search, in characters.
pub const SEARCH_LIMIT: usize = 60;

/// The search text after `typed` was added: one line, no leading space, no doubled spaces, cut to
/// the limit.
pub fn append_to_search(query: &str, typed: &str) -> String {
    let joined = format!("{query}{}", sanitize(typed));
    let mut out = String::new();
    let mut pending_space = false;
    for ch in joined.trim_start().chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            // A run of spaces becomes one.
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    if pending_space {
        out.push(' ');
    }
    out.chars().take(SEARCH_LIMIT).collect()
}

/// The search text after Backspace: one character less, or none at all with Ctrl or Alt held.
pub fn erase_from_search(query: &str, whole_word: bool) -> String {
    if whole_word {
        return String::new();
    }
    let mut chars: Vec<char> = query.chars().collect();
    chars.pop();
    chars.into_iter().collect()
}

/// Hangul letters composed: macOS file names come decomposed (NFD, jamo apart), a terminal types
/// them composed (NFC), and the two never match as they are. Only Hangul is composed.
fn compose_hangul(text: &str) -> String {
    const BASE: u32 = 0xAC00;
    let mut out: Vec<char> = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        if let Some(&last) = out.last() {
            let last_code = last as u32;
            let merged =
                if (0x1100..=0x1112).contains(&last_code) && (0x1161..=0x1175).contains(&code) {
                    Some(BASE + ((last_code - 0x1100) * 21 + (code - 0x1161)) * 28)
                } else if (BASE..BASE + 11172).contains(&last_code)
                    && (last_code - BASE).is_multiple_of(28)
                    && (0x11A8..=0x11C2).contains(&code)
                {
                    Some(last_code + (code - 0x11A7))
                } else {
                    None
                };
            if let Some(merged) = merged.and_then(char::from_u32) {
                out.pop();
                out.push(merged);
                continue;
            }
        }
        out.push(ch);
    }
    out.into_iter().collect()
}

/// Trimmed, lower case and composed.
fn composed(text: &str) -> String {
    compose_hangul(text).trim().to_lowercase()
}

/// A text as a search field: lower case, one line.
pub fn search_field(text: &str) -> String {
    composed(
        &sanitize(text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn length_penalty(value: &[char], query: &[char]) -> i64 {
    (value.len() as i64 - query.len() as i64).clamp(0, 64)
}

fn score_subsequence(value: &[char], query: &[char]) -> Option<i64> {
    let mut at = 0;
    let (mut first, mut previous): (Option<usize>, Option<usize>) = (None, None);
    let mut gaps = 0i64;
    for (index, ch) in value.iter().enumerate() {
        if query.get(at) != Some(ch) {
            continue;
        }
        first.get_or_insert(index);
        if let Some(p) = previous {
            gaps += (index - p - 1) as i64;
        }
        previous = Some(index);
        at += 1;
        if at == query.len() {
            let first = first.unwrap_or(0) as i64;
            let span = index as i64 - first + 1 - query.len() as i64;
            let length = (value.len() as i64 - query.len() as i64).min(64);
            return Some(first * 2 + gaps * 3 + span + length);
        }
    }
    None
}

/// `scoreQueryMatch` of `@t3tools/shared/searchRanking` with the tiers the pickers use: exact,
/// prefix, after a boundary (` `, `-`, `_`, `/`), anywhere, and (for three letters or more) the
/// letters in order. Both texts are already composed and lower case.
fn score_token(value: &str, query: &str, base: i64) -> Option<i64> {
    if value.is_empty() || query.is_empty() {
        return None;
    }
    if value == query {
        return Some(base);
    }
    let value_chars: Vec<char> = value.chars().collect();
    let query_chars: Vec<char> = query.chars().collect();
    let penalty = length_penalty(&value_chars, &query_chars);
    if value.starts_with(query) {
        return Some(base + 2 + penalty);
    }
    let boundary = [" ", "-", "_", "/"]
        .iter()
        .filter_map(|marker| {
            value
                .find(&format!("{marker}{query}"))
                .map(|at| at + marker.len())
        })
        .min();
    if let Some(at) = boundary {
        let index = value[..at].chars().count() as i64;
        return Some(base + 4 + index * 2 + penalty);
    }
    if let Some(at) = value.find(query) {
        let index = value[..at].chars().count() as i64;
        return Some(base + 6 + index * 2 + penalty);
    }
    if query_chars.len() >= 3 {
        return score_subsequence(&value_chars, &query_chars).map(|score| base + 100 + score);
    }
    None
}

/// How well the typed words match an item's fields (already searchable, best field first), lower
/// is better; `None` when a word matches no field. Every word has to match some field, and a word
/// that matches an earlier field counts for more.
pub fn score_fields(fields: &[String], query: &str) -> Option<i64> {
    let query = composed(query);
    let mut total = 0;
    for token in query.split_whitespace() {
        let best = fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| score_token(field, token, index as i64 * 10))
            .min()?;
        total += best;
    }
    Some(total)
}

/// The items that match, exact and prefix matches first; ties keep the list's own order.
pub fn filter_ranked<T>(
    items: Vec<T>,
    query: &str,
    fields_of: impl Fn(&T) -> Vec<String>,
) -> Vec<T> {
    if composed(query).is_empty() {
        return items;
    }
    let mut scored: Vec<(i64, usize, T)> = items
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            score_fields(&fields_of(&item), query).map(|s| (s, index, item))
        })
        .collect();
    scored.sort_by_key(|(score, index, _)| (*score, *index));
    scored.into_iter().map(|(_, _, item)| item).collect()
}

// ---- pin order keys ------------------------------------------------------------------------

const DIGITS: &[u8] = b"abcdefghijklmnopqrstuvwxyz";

fn valid_pin_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_lowercase()) && !key.ends_with('a')
}

fn digit_of(byte: Option<&u8>) -> usize {
    byte.and_then(|b| DIGITS.iter().position(|d| d == b))
        .unwrap_or(0)
}

/// Midpoint of two digit strings read as fractions in (0, 1); "" is the open bound on either side.
fn pin_midpoint(a: &str, b: &str) -> String {
    let (a_bytes, b_bytes) = (a.as_bytes(), b.as_bytes());
    if !b.is_empty() {
        // Past the longest common prefix ("a" pads the shorter side).
        let mut n = 0;
        while b_bytes.get(n).is_some() && a_bytes.get(n).copied().unwrap_or(b'a') == b_bytes[n] {
            n += 1;
        }
        if n > 0 {
            let rest_a = a.get(n..).unwrap_or("");
            return format!("{}{}", &b[..n], pin_midpoint(rest_a, &b[n..]));
        }
    }
    let digit_a = if a.is_empty() {
        0
    } else {
        digit_of(a_bytes.first())
    };
    let digit_b = if b.is_empty() {
        DIGITS.len()
    } else {
        digit_of(b_bytes.first())
    };
    if digit_b - digit_a > 1 {
        return (DIGITS[(digit_a + digit_b).div_ceil(2)] as char).to_string();
    }
    if b.len() > 1 {
        return (b_bytes[0] as char).to_string();
    }
    format!(
        "{}{}",
        DIGITS[digit_a] as char,
        pin_midpoint(a.get(1..).unwrap_or(""), "")
    )
}

/// A key that sorts strictly between two neighbours (`None` is the top / bottom of the block);
/// `None` when a key in use is corrupt or out of order (`pinOrderKeyBetween`).
pub fn pin_order_key_between(before: Option<&str>, after: Option<&str>) -> Option<String> {
    let (a, b) = (before.unwrap_or(""), after.unwrap_or(""));
    if (!a.is_empty() && !valid_pin_key(a)) || (!b.is_empty() && !valid_pin_key(b)) {
        return None;
    }
    if !b.is_empty() && a >= b {
        return None;
    }
    Some(pin_midpoint(a, b))
}

/// The order key a new pin takes: ahead of every key in use, so the thread lands at the top of the
/// pinned block. `None` when no key can be made; the server then pins it keyless.
pub fn top_pin_order_key(threads: &[ThreadShell]) -> Option<String> {
    let first = threads
        .iter()
        .filter(|t| t.pinned_at.is_some())
        .filter_map(|t| t.pin_order_key.as_deref())
        .min();
    pin_order_key_between(None, first)
}

// ---- what the lists show -------------------------------------------------------------------

pub fn is_pinned(thread: &ThreadShell) -> bool {
    thread.pinned_at.is_some()
}

pub fn is_thread_running(thread: &ThreadShell) -> bool {
    matches!(
        thread.session.as_ref().map(|s| s.status.as_str()),
        Some("running" | "starting")
    ) || thread
        .latest_turn
        .as_ref()
        .is_some_and(|t| t.state == "running")
}

/// Relative time for list rows; the date itself after a month.
pub fn relative_time(iso: &str, now_ms: i64) -> String {
    let Some(then) = parse_iso_ms(iso) else {
        return String::new();
    };
    let seconds = ((now_ms - then) as f64 / 1000.0).round().max(0.0) as i64;
    if seconds < 45 {
        return s("just now", "방금").to_string();
    }
    let minutes = (seconds as f64 / 60.0).round() as i64;
    if minutes < 60 {
        return fill(s("{n}m ago", "{n}분 전"), &[("n", minutes.to_string())]);
    }
    let hours = (minutes as f64 / 60.0).round() as i64;
    if hours < 24 {
        return fill(s("{n}h ago", "{n}시간 전"), &[("n", hours.to_string())]);
    }
    let days = (hours as f64 / 24.0).round() as i64;
    if days < 30 {
        return fill(s("{n}d ago", "{n}일 전"), &[("n", days.to_string())]);
    }
    iso.chars().take(10).collect()
}

pub fn now_ms() -> i64 {
    parse_iso_ms(&iso_now()).unwrap_or(0)
}

fn normalize_directory(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    let trimmed = replaced.trim_end_matches('/');
    let normalized = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    }
}

fn canonical(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .map_or_else(|_| path.to_string(), |p| p.to_string_lossy().into_owned())
}

/// The project whose workspace contains `directory`; the deepest root wins when projects nest.
/// Both sides are real paths, so `/tmp/app` and `/private/tmp/app` agree on macOS.
pub fn project_for_directory<'a>(
    projects: &'a [ProjectShell],
    directory: &str,
    canonical: impl Fn(&str) -> String,
) -> Option<&'a ProjectShell> {
    let target = normalize_directory(&canonical(directory));
    let mut best: Option<(&ProjectShell, usize)> = None;
    for project in projects {
        let root = normalize_directory(&canonical(&project.workspace_root));
        let prefix = if root == "/" {
            "/".to_string()
        } else {
            format!("{root}/")
        };
        let contains = target == root || target.starts_with(&prefix);
        if contains && best.is_none_or(|(_, length)| root.len() > length) {
            best = Some((project, root.len()));
        }
    }
    best.map(|(project, _)| project)
}

/// Most recently touched first, by the newest thread that is not archived.
pub fn sorted_projects<'a>(
    projects: &'a [ProjectShell],
    threads: &[ThreadShell],
) -> Vec<&'a ProjectShell> {
    let mut latest: HashMap<&str, &str> = HashMap::new();
    for thread in threads.iter().filter(|t| t.archived_at.is_none()) {
        let entry = latest.entry(thread.project_id.as_str()).or_insert("");
        if *entry < thread.updated_at.as_str() {
            *entry = thread.updated_at.as_str();
        }
    }
    let touched = |p: &ProjectShell| -> String {
        latest
            .get(p.id.as_str())
            .map_or_else(|| p.updated_at.clone(), |t| (*t).to_string())
    };
    let mut sorted: Vec<&ProjectShell> = projects.iter().collect();
    sorted.sort_by_key(|p| std::cmp::Reverse(touched(p)));
    sorted
}

/// The projects whose title or folder matches the typed words.
pub fn filter_projects<'a>(projects: Vec<&'a ProjectShell>, query: &str) -> Vec<&'a ProjectShell> {
    filter_ranked(projects, query, |p| {
        vec![search_field(&p.title), search_field(&p.workspace_root)]
    })
}

/// The threads a project lists, as the desktop sidebar groups them: a crew thread leaves the list
/// and is counted under the thread that started it, unless it waits for an approval or an answer,
/// which is never hidden. Crew threads whose lead is gone are left out.
pub struct Listed<'a> {
    /// Crew threads that wait for the user first, then the rest, newest first.
    pub rows: Vec<&'a ThreadShell>,
    pub folded: HashMap<&'a str, usize>,
    pub waiting: HashSet<&'a str>,
}

pub fn listed_threads<'a>(threads: &'a [ThreadShell], project_id: &str) -> Listed<'a> {
    let mut of_project: Vec<&ThreadShell> = threads
        .iter()
        .filter(|t| t.project_id == project_id && t.archived_at.is_none())
        .collect();
    of_project.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let present: HashSet<&str> = of_project.iter().map(|t| t.id.as_str()).collect();
    let (mut rows, mut waiting) = (Vec::new(), Vec::new());
    let mut folded: HashMap<&str, usize> = HashMap::new();
    for thread in of_project {
        if !is_crew_sub_thread(thread) {
            rows.push(thread);
        } else if thread.has_pending_approvals || thread.has_pending_user_input {
            waiting.push(thread);
        } else if let Some(parent) = thread.parent_thread_id.as_deref()
            && present.contains(parent)
        {
            *folded.entry(parent).or_insert(0) += 1;
        }
    }
    let waiting_ids = waiting.iter().map(|t| t.id.as_str()).collect();
    waiting.extend(rows);
    Listed {
        rows: waiting,
        folded,
        waiting: waiting_ids,
    }
}

/// How a thread is named on its row: a crew thread that waits for the user is shown as its task.
fn row_label(thread: &ThreadShell, listed: &Listed) -> String {
    if listed.waiting.contains(thread.id.as_str()) {
        format!(
            "crew {}",
            thread.title.strip_prefix("Crew ").unwrap_or(&thread.title)
        )
    } else {
        thread.title.clone()
    }
}

/// The threads `/threads` lists for a project, narrowed by the typed words: crew threads that wait
/// for the user, pinned threads in the desktop app's pinned order, then the rest newest first. With
/// words typed, the best title match comes first and a tie keeps that order.
pub fn thread_rows<'a>(
    threads: &'a [ThreadShell],
    project_id: &str,
    query: &str,
) -> (Vec<&'a ThreadShell>, Listed<'a>) {
    let listed = listed_threads(threads, project_id);
    let waiting: Vec<&ThreadShell> = listed
        .rows
        .iter()
        .copied()
        .filter(|t| listed.waiting.contains(t.id.as_str()))
        .collect();
    let others: Vec<&ThreadShell> = listed
        .rows
        .iter()
        .copied()
        .filter(|t| !listed.waiting.contains(t.id.as_str()))
        .collect();
    let mut pinned: Vec<&ThreadShell> = others.iter().copied().filter(|t| is_pinned(t)).collect();
    sort_pinned(&mut pinned);
    let ordered: Vec<&ThreadShell> = waiting
        .into_iter()
        .chain(pinned)
        .chain(others.into_iter().filter(|t| !is_pinned(t)))
        .collect();
    let rows = filter_ranked(ordered, query, |t| {
        vec![search_field(&row_label(t, &listed))]
    });
    (rows, listed)
}

/// Rows to show for a list of `count` items when only `size` fit, keeping `selected` visible.
pub fn window_around(selected: usize, count: usize, size: usize) -> (usize, usize) {
    let visible = size.min(count);
    let start = selected.saturating_sub(visible / 2).min(count - visible);
    (start, start + visible)
}

// ---- the screens ---------------------------------------------------------------------------

/// One row: what is said first and what is said dim after it.
struct Item {
    label: String,
    note: String,
}

fn project_of_active(app: &App) -> Option<String> {
    match &app.active {
        Active::Draft(project) => Some(project.clone()),
        Active::Thread(id) => app
            .shell
            .threads
            .iter()
            .find(|t| &t.id == id)
            .map(|t| t.project_id.clone()),
        Active::None => None,
    }
}

/// The project of the open conversation, else the working folder's, else the last one used.
pub fn current_project(app: &App) -> Option<String> {
    project_of_active(app).or_else(|| app.draft_project_id())
}

pub fn open_projects(app: &mut App) {
    app.screen = Some(Box::new(ProjectsScreen::new(app)));
}

pub fn open_threads(app: &mut App, project_id: &str) {
    app.screen = Some(Box::new(ThreadsScreen::new(project_id)));
}

/// The pointer after a key; shared by both screens.
fn move_pointer(selected: &Cell<usize>, count: usize, key: KeyCode) -> bool {
    let last = count.saturating_sub(1);
    let at = selected.get().min(last);
    let next = match key {
        KeyCode::Up => at.saturating_sub(1),
        KeyCode::Down => (at + 1).min(last),
        KeyCode::PageUp => at.saturating_sub(5),
        KeyCode::PageDown => (at + 5).min(last),
        KeyCode::Home => 0,
        KeyCode::End => last,
        _ => return false,
    };
    selected.set(next);
    true
}

/// The typed letters and their editing keys; true when the key was one of them.
fn edit_search(query: &mut String, selected: &Cell<usize>, key: &KeyEvent) -> bool {
    let plain = !key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
    match key.code {
        KeyCode::Char(c) if plain => {
            *query = append_to_search(query, &c.to_string());
        }
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => query.clear(),
        KeyCode::Backspace => {
            let whole = key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
            *query = erase_from_search(query, whole);
        }
        _ => return false,
    }
    selected.set(0);
    true
}

fn search_line(app: &App, query: &str) -> Line<'static> {
    let t = &app.theme;
    if query.is_empty() {
        Line::from(Span::styled(
            s("Search: type to filter", "검색: 글자를 치면 걸러집니다"),
            t.dim_style(),
        ))
    } else {
        Line::from(vec![
            Span::styled(format!("{} ", s("Search:", "검색:")), t.dim_style()),
            Span::raw(sanitize(query)),
        ])
    }
}

/// What a list screen shows.
struct View<'a> {
    title: &'a str,
    query: &'a str,
    items: &'a [Item],
    selected: usize,
    /// Said instead of rows when there are none.
    empty: &'a str,
}

/// Title, search line, the rows around the pointer, or the empty message.
fn draw_list(frame: &mut Frame, area: Rect, app: &App, view: &View) {
    let t = &app.theme;
    let mut lines = vec![
        Line::from(Span::styled(
            sanitize(view.title),
            Style::new().fg(t.brand).add_modifier(Modifier::BOLD),
        )),
        search_line(app, view.query),
        Line::default(),
    ];
    if view.items.is_empty() {
        lines.push(Line::from(Span::styled(
            sanitize(view.empty),
            t.dim_style(),
        )));
    }
    let room = usize::from(area.height).saturating_sub(lines.len());
    let (start, end) = window_around(view.selected, view.items.len(), room);
    let columns = usize::from(area.width).saturating_sub(2);
    for (index, item) in view.items.iter().enumerate().take(end).skip(start) {
        let on = index == view.selected;
        let mark = if on { app.sym.prompt } else { " " };
        let style = if on {
            Style::new().fg(t.brand).add_modifier(Modifier::BOLD)
        } else {
            Style::new()
        };
        let label = sanitize(&item.label).replace('\n', " ");
        let note = sanitize(&item.note).replace('\n', " ");
        let mut spans = vec![Span::styled(mark.to_string(), style), Span::raw(" ")];
        if note.is_empty() {
            spans.push(Span::styled(truncate(&label, columns), style));
        } else {
            // The label keeps its room; the note takes what is left.
            let label_cells = width(&label).min(columns.saturating_sub(8).max(columns / 2));
            let label = truncate(&label, label_cells);
            let used = width(&label);
            spans.push(Span::styled(label, style));
            let left = columns.saturating_sub(used + 2);
            if left > 0 {
                spans.push(Span::styled(
                    format!("  {}", truncate(&note, left)),
                    t.dim_style(),
                ));
            }
        }
        lines.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

// ---- /projects -----------------------------------------------------------------------------

pub struct ProjectsScreen {
    selected: Cell<usize>,
    query: String,
}

impl ProjectsScreen {
    pub fn new(app: &App) -> ProjectsScreen {
        // The pointer starts on the project of the working folder; the row that adds this folder
        // leads the list when it is in no project, so a position by project moves down one.
        let projects = sorted_projects(&app.shell.projects, &app.shell.threads);
        let matched = project_for_directory(&app.shell.projects, &app.cwd, canonical)
            .and_then(|m| projects.iter().position(|p| p.id == m.id));
        let selected = matched.map_or(0, |at| at + usize::from(Self::can_add_folder(app, "")));
        ProjectsScreen {
            selected: Cell::new(selected),
            query: String::new(),
        }
    }

    /// Whether the list offers "Add this folder": the folder is in no project, and no words are typed.
    fn can_add_folder(app: &App, query: &str) -> bool {
        app.shell.loaded
            && query.is_empty()
            && project_for_directory(&app.shell.projects, &app.cwd, canonical).is_none()
    }

    fn visible<'a>(&self, app: &'a App) -> Vec<&'a ProjectShell> {
        filter_projects(
            sorted_projects(&app.shell.projects, &app.shell.threads),
            &self.query,
        )
    }

    fn items(&self, app: &App) -> Vec<Item> {
        let lead = Self::can_add_folder(app, &self.query).then(|| Item {
            label: fill(
                s("Add this folder ({folder})", "이 폴더 추가 ({folder})"),
                &[("folder", app.cwd.clone())],
            ),
            note: String::new(),
        });
        lead.into_iter()
            .chain(self.visible(app).into_iter().map(|p| Item {
                label: p.title.clone(),
                note: p.workspace_root.clone(),
            }))
            .collect()
    }
}

impl Screen for ProjectsScreen {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App) {
        let items = self.items(app);
        let empty = if !app.shell.loaded {
            s(
                "Loading projects from the server…",
                "서버에서 프로젝트를 불러오는 중…",
            )
        } else if self.query.is_empty() {
            s("No projects yet.", "아직 프로젝트가 없습니다.")
        } else {
            s(
                "No matching projects. Press Esc to clear the search.",
                "일치하는 프로젝트가 없습니다. Esc로 검색어를 지우세요.",
            )
        };
        let selected = self.selected.get().min(items.len().saturating_sub(1));
        let view = View {
            title: s("Pick a project", "프로젝트를 고르세요"),
            query: &self.query,
            items: &items,
            selected,
            empty,
        };
        draw_list(frame, area, app, &view);
    }

    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool {
        let lead = usize::from(Self::can_add_folder(app, &self.query));
        let count = lead + self.visible(app).len();
        if edit_search(&mut self.query, &self.selected, &key)
            || move_pointer(&self.selected, count, key.code)
        {
            return false;
        }
        match key.code {
            // A search is undone before the list is left.
            KeyCode::Esc if !self.query.is_empty() => {
                self.query.clear();
                self.selected.set(0);
                false
            }
            KeyCode::Esc => true,
            KeyCode::Enter => {
                if !app.shell.loaded {
                    return false;
                }
                let at = self.selected.get().min(count.saturating_sub(1));
                if lead == 1 && at == 0 {
                    app.add_folder();
                    return true;
                }
                let id = self.visible(app).get(at - lead).map(|p| p.id.clone());
                match id {
                    Some(id) => {
                        open_threads(app, &id);
                        true
                    }
                    None => false,
                }
            }
            _ => false,
        }
    }

    fn wheel(&mut self, up: bool) {
        let at = self.selected.get();
        self.selected
            .set(if up { at.saturating_sub(1) } else { at + 1 });
    }

    fn hint(&self) -> String {
        fill(
            s(
                "↑/↓ move • Enter open • Type to search • {end}",
                "↑/↓ 이동 • Enter 열기 • 글자 입력 검색 • {end}",
            ),
            &[(
                "end",
                if self.query.is_empty() {
                    s("Esc close", "Esc 닫기")
                } else {
                    s("Esc clear search", "Esc 검색어 지우기")
                }
                .to_string(),
            )],
        )
    }
}

// ---- /threads ------------------------------------------------------------------------------

pub struct ThreadsScreen {
    project_id: String,
    selected: Cell<usize>,
    query: String,
    /// After a pin or unpin: the thread, and what the server's list is waited for to say. Shared
    /// with the background request so a refusal can let go of it.
    follow: Arc<Mutex<Option<(String, bool)>>>,
}

impl ThreadsScreen {
    pub fn new(project_id: &str) -> ThreadsScreen {
        ThreadsScreen {
            project_id: project_id.to_string(),
            selected: Cell::new(0),
            query: String::new(),
            follow: Arc::new(Mutex::new(None)),
        }
    }

    /// The "New thread" row leads the list until words are typed.
    fn lead(&self) -> usize {
        usize::from(self.query.is_empty())
    }

    /// Once the server's list shows the pin changed, the pointer moves to where the thread went.
    fn settle(&self, app: &App) {
        let Ok(mut follow) = self.follow.lock() else {
            return;
        };
        let Some((id, pinned)) = follow.clone() else {
            return;
        };
        let (rows, _) = thread_rows(&app.shell.threads, &self.project_id, &self.query);
        if let Some(at) = rows.iter().position(|t| t.id == id)
            && is_pinned(rows[at]) == pinned
        {
            *follow = None;
            self.selected.set(at + self.lead());
        }
    }

    fn items(&self, app: &App) -> Vec<Item> {
        let (rows, listed) = thread_rows(&app.shell.threads, &self.project_id, &self.query);
        let now = now_ms();
        let mut items = Vec::new();
        // Words typed are looking for a thread: starting a new one is not among the matches.
        if self.lead() == 1 {
            items.push(Item {
                label: s("New thread", "새 스레드").to_string(),
                note: String::new(),
            });
        }
        for thread in rows {
            let when = relative_time(&thread.updated_at, now);
            if listed.waiting.contains(thread.id.as_str()) {
                // A crew task that waits for the user is never folded away.
                let what = if thread.has_pending_approvals {
                    s("Approval pending", "승인 대기")
                } else {
                    s("Question pending", "질문 대기")
                };
                items.push(Item {
                    label: row_label(thread, &listed),
                    note: if when.is_empty() {
                        what.to_string()
                    } else {
                        format!("{what} · {when}")
                    },
                });
                continue;
            }
            let crew = listed.folded.get(thread.id.as_str()).copied().unwrap_or(0);
            let running = if !is_thread_running(thread) {
                when
            } else if when.is_empty() {
                s("Running", "실행 중").to_string()
            } else {
                fill(s("Running · {when}", "실행 중 · {when}"), &[("when", when)])
            };
            let note: Vec<String> = [
                if is_pinned(thread) {
                    s("Pinned", "고정").to_string()
                } else {
                    String::new()
                },
                running,
                if crew > 0 {
                    fill(
                        s("{count} crew task(s)", "crew 작업 {count}"),
                        &[("count", crew.to_string())],
                    )
                } else {
                    String::new()
                },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
            items.push(Item {
                label: thread.title.clone(),
                note: note.join(" · "),
            });
        }
        items
    }

    /// Pins the thread, or unpins it when it is pinned; the list shows the server's word for it.
    fn toggle_pin(&self, app: &mut App, thread: &ThreadShell) {
        let capabilities = &app.config["environment"]["capabilities"];
        if capabilities["threadPinning"] != true {
            app.notice = Some(
                s(
                    "This server does not support pinning threads. Update the app.",
                    "이 서버는 스레드 고정을 지원하지 않습니다. 앱을 업데이트하세요.",
                )
                .to_string(),
            );
            return;
        }
        let pinning = !is_pinned(thread);
        // A server that predates arranged order would reject the key.
        let order_key = (pinning && capabilities["threadPinReorder"] == true)
            .then(|| top_pin_order_key(&app.shell.threads))
            .flatten();
        let command = pin_command(&thread.id, pinning, order_key.as_deref());
        let failure = if pinning {
            s("Could not pin the thread", "고정 실패")
        } else {
            s("Could not unpin the thread", "고정 해제 실패")
        };
        #[cfg(test)]
        app.log.push(command.clone());
        let Some(rpc) = app.rpc.clone() else {
            app.notice = Some(crate::i18n::tr("notice.offline").to_string());
            return;
        };
        if let Ok(mut follow) = self.follow.lock() {
            *follow = Some((thread.id.clone(), pinning));
        }
        let follow = self.follow.clone();
        let tx = app.sender();
        tokio::spawn(async move {
            let result = rpc.call(crate::app::DISPATCH_RPC, command).await;
            if let Err(reason) = result {
                let detail = sanitize(&reason).lines().next().unwrap_or("").to_string();
                let _ = tx.send(crate::app::Msg::Ext(Box::new(move |app: &mut App| {
                    if let Ok(mut f) = follow.lock() {
                        *f = None;
                    }
                    app.say(Tone::Error, &format!("{failure}: {detail}"));
                })));
            }
        });
    }
}

/// `thread.pin` / `thread.unpin` (the TypeScript terminal's `pinCommand` / `unpinCommand`).
pub fn pin_command(thread_id: &str, pin: bool, order_key: Option<&str>) -> serde_json::Value {
    let mut command = serde_json::json!({
        "type": if pin { "thread.pin" } else { "thread.unpin" },
        "threadId": thread_id,
        "commandId": crate::text::new_id(),
    });
    if let Some(key) = order_key.filter(|_| pin) {
        command["orderKey"] = serde_json::json!(key);
    }
    command
}

impl Screen for ThreadsScreen {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App) {
        self.settle(app);
        let items = self.items(app);
        let selected = self.selected.get().min(items.len().saturating_sub(1));
        let view = View {
            title: s("Pick a thread", "스레드를 고르세요"),
            query: &self.query,
            items: &items,
            selected,
            empty: s(
                "No matching threads. Press Esc to clear the search.",
                "일치하는 스레드가 없습니다. Esc로 검색어를 지우세요.",
            ),
        };
        draw_list(frame, area, app, &view);
    }

    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool {
        let (rows, _) = thread_rows(&app.shell.threads, &self.project_id, &self.query);
        let lead = self.lead();
        let count = lead + rows.len();
        let at = self.selected.get().min(count.saturating_sub(1));
        if key.code == KeyCode::Char('p') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if let Some(thread) = at.checked_sub(lead).and_then(|i| rows.get(i)) {
                let thread = (*thread).clone();
                self.toggle_pin(app, &thread);
            }
            return false;
        }
        if edit_search(&mut self.query, &self.selected, &key)
            || move_pointer(&self.selected, count, key.code)
        {
            return false;
        }
        match key.code {
            KeyCode::Esc if !self.query.is_empty() => {
                self.query.clear();
                self.selected.set(0);
                false
            }
            // Back to the project list.
            KeyCode::Esc => {
                open_projects(app);
                true
            }
            KeyCode::Enter => {
                if !app.shell.loaded {
                    return false;
                }
                if lead == 1 && at == 0 {
                    app.start_draft(&self.project_id);
                    return true;
                }
                match at.checked_sub(lead).and_then(|i| rows.get(i)) {
                    Some(thread) => {
                        let id = thread.id.clone();
                        app.open_thread(&id);
                        true
                    }
                    None => false,
                }
            }
            _ => false,
        }
    }

    fn wheel(&mut self, up: bool) {
        let at = self.selected.get();
        self.selected
            .set(if up { at.saturating_sub(1) } else { at + 1 });
    }

    fn hint(&self) -> String {
        fill(
            s(
                "↑/↓ move • Enter open • Type to search • Ctrl+P pin/unpin • Esc {end}",
                "↑/↓ 이동 • Enter 열기 • 글자 입력 검색 • Ctrl+P 고정/해제 • Esc {end}",
            ),
            &[(
                "end",
                if self.query.is_empty() {
                    s("project list", "프로젝트 목록")
                } else {
                    s("clear search", "검색어 지우기")
                }
                .to_string(),
            )],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Msg;
    use crate::text::width as cells;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{Event, KeyEventKind, KeyEventState};
    use serde_json::{Value, json};
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    // ---- search

    #[test]
    fn typed_words_are_kept_to_one_clean_line() {
        assert_eq!(append_to_search("", "  a  b"), "a b");
        assert_eq!(append_to_search("ab", " "), "ab ");
        assert_eq!(append_to_search("ab ", " "), "ab ");
        assert_eq!(append_to_search("ab", "\u{1b}[31mc\n d"), "ab[31mc d");
        assert_eq!(
            append_to_search("", &"x".repeat(80)).chars().count(),
            SEARCH_LIMIT
        );
        assert_eq!(erase_from_search("abc", false), "ab");
        assert_eq!(erase_from_search("abc", true), "");
        assert_eq!(erase_from_search("", false), "");
    }

    #[test]
    fn decomposed_hangul_matches_composed_hangul() {
        // 한 as a macOS file name has it: three jamo.
        let nfd = "\u{1112}\u{1161}\u{11AB}";
        assert_eq!(compose_hangul(nfd), "한");
        assert_eq!(compose_hangul("\u{1100}\u{1161}"), "가");
        assert_eq!(compose_hangul("abc 한글"), "abc 한글");
        let fields = vec![search_field(&format!("{nfd}글 설정"))];
        assert!(score_fields(&fields, "한글").is_some());
        assert!(score_fields(&[search_field("한글")], nfd).is_some());
    }

    #[test]
    fn the_tiers_of_a_match_rank_in_the_order_the_desktop_app_has() {
        let field = |text: &str| vec![search_field(text)];
        let score = |text: &str, query: &str| score_fields(&field(text), query);
        let exact = score("theme", "theme").unwrap();
        let prefix = score("themes", "theme").unwrap();
        let boundary = score("x theme", "theme").unwrap();
        let inside = score("xxthemexx", "theme").unwrap();
        let fuzzy = score("t-h-e-m-e", "theme").unwrap();
        assert!(exact < prefix && prefix < boundary && boundary < inside && inside < fuzzy);
        assert_eq!(exact, 0);
        assert_eq!(prefix, 2 + 1);
        assert_eq!(boundary, 4 + 2 * 2 + 2);
        assert_eq!(inside, 6 + 2 * 2 + 4);
        // Two letters are not matched in order; three are.
        assert_eq!(score("t-h-e", "te"), None);
        assert!(score("t-h-e", "the").is_some());
        // Every word has to match somewhere; the earlier field counts for more.
        let fields = vec![search_field("Demo"), search_field("/work/api")];
        assert!(score_fields(&fields, "demo api").is_some());
        assert_eq!(score_fields(&fields, "demo zzz"), None);
        let first = score_fields(&fields, "demo").unwrap();
        let second = score_fields(&fields, "api").unwrap();
        assert!(first < second);
        assert_eq!(score_fields(&fields, "   "), Some(0));
    }

    #[test]
    fn matches_come_best_first_and_ties_keep_the_lists_order() {
        let items = vec!["xx theme", "theme", "themes b", "themes a", "nothing"];
        let ranked = filter_ranked(items.clone(), "theme", |t| vec![search_field(t)]);
        assert_eq!(ranked, ["theme", "themes b", "themes a", "xx theme"]);
        assert_eq!(
            filter_ranked(items.clone(), "  ", |t| vec![search_field(t)]),
            items
        );
    }

    // ---- pin order keys (values are those of `pinOrderKeyBetween` in the TypeScript client)

    #[test]
    fn order_keys_between_neighbours_are_those_of_the_typescript_client() {
        let between = |a: Option<&str>, b: Option<&str>| pin_order_key_between(a, b);
        assert_eq!(between(None, None).as_deref(), Some("n"));
        assert_eq!(between(None, Some("n")).as_deref(), Some("h"));
        assert_eq!(between(Some("n"), None).as_deref(), Some("u"));
        assert_eq!(between(Some("h"), Some("i")).as_deref(), Some("hn"));
        assert_eq!(between(Some("h"), Some("hn")).as_deref(), Some("hh"));
        assert_eq!(between(Some("b"), Some("c")).as_deref(), Some("bn"));
        assert_eq!(between(Some("ab"), Some("ac")).as_deref(), Some("abn"));
        assert_eq!(between(Some("y"), None).as_deref(), Some("z"));
        assert_eq!(between(Some("z"), None).as_deref(), Some("zn"));
        assert_eq!(between(None, Some("b")).as_deref(), Some("an"));
        assert_eq!(between(Some("mz"), Some("n")).as_deref(), Some("mzn"));
        assert_eq!(between(Some("nn"), Some("nz")).as_deref(), Some("nt"));
        assert_eq!(between(Some("x"), Some("xb")).as_deref(), Some("xan"));
        // Keys in use that are corrupt or out of order make no key.
        assert_eq!(between(Some("ma"), Some("n")), None);
        assert_eq!(between(Some("B"), None), None);
        assert_eq!(between(Some("n"), Some("h")), None);
        assert_eq!(between(Some("n"), Some("n")), None);
    }

    #[test]
    fn pinning_over_and_over_keeps_the_newest_on_top() {
        let mut key = pin_order_key_between(None, None).unwrap();
        let mut seen = vec![key.clone()];
        for _ in 0..40 {
            let next = pin_order_key_between(None, Some(&key)).unwrap();
            assert!(next < key && valid_pin_key(&next), "{next} before {key}");
            seen.push(next.clone());
            key = next;
        }
        assert_eq!(seen[..4], ["n", "h", "e", "c"]);
        // Bisecting a gap never runs out.
        let (mut low, high) = ("h".to_string(), "i".to_string());
        for _ in 0..30 {
            let mid = pin_order_key_between(Some(&low), Some(&high)).unwrap();
            assert!(low < mid && mid < high);
            low = mid;
        }
    }

    fn thread(id: &str, project: &str, title: &str, updated: &str) -> ThreadShell {
        ThreadShell {
            id: id.into(),
            project_id: project.into(),
            title: title.into(),
            created_at: updated.into(),
            updated_at: updated.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_new_pin_goes_above_every_key_in_use() {
        let mut a = thread("a", "p", "A", "2026-01-01T00:00:00.000Z");
        a.pinned_at = Some("2026-01-02T00:00:00.000Z".into());
        a.pin_order_key = Some("n".into());
        let mut b = a.clone();
        b.id = "b".into();
        b.pin_order_key = Some("h".into());
        let mut unpinned = a.clone();
        unpinned.id = "u".into();
        unpinned.pinned_at = None;
        unpinned.pin_order_key = Some("c".into());
        let key = top_pin_order_key(&[a.clone(), b, unpinned]).unwrap();
        assert!(key.as_str() < "h", "{key}");
        assert_eq!(top_pin_order_key(&[]).as_deref(), Some("n"));
        assert_eq!(
            top_pin_order_key(&[thread("x", "p", "X", "")]).as_deref(),
            Some("n")
        );
        let command = pin_command("a", true, Some("hh"));
        assert_eq!(
            (command["type"].as_str(), command["orderKey"].as_str()),
            (Some("thread.pin"), Some("hh"))
        );
        let command = pin_command("a", false, Some("hh"));
        assert!(command["type"] == "thread.unpin" && command.get("orderKey").is_none());
        assert!(pin_command("a", true, None).get("orderKey").is_none());
    }

    // ---- what the lists show

    #[test]
    fn time_is_said_the_way_the_pickers_say_it() {
        let now = parse_iso_ms("2026-03-10T12:00:00.000Z").unwrap();
        let ago = |stamp: &str| relative_time(stamp, now);
        assert_eq!(ago("2026-03-10T11:59:50.000Z"), s("just now", "방금"));
        assert_eq!(ago("2026-03-10T11:59:16.000Z"), s("just now", "방금"));
        assert!(ago("2026-03-10T11:59:15.000Z").contains('1'));
        assert!(ago("2026-03-10T11:55:00.000Z").contains('5'));
        assert!(ago("2026-03-10T10:00:00.000Z").contains('2'));
        assert!(ago("2026-03-07T12:00:00.000Z").contains('3'));
        assert_eq!(ago("2026-01-29T12:00:00.000Z"), "2026-01-29");
        assert_eq!(relative_time("garbage", now), "");
        assert_eq!(
            ago("2026-03-10T12:01:30.000Z"),
            s("just now", "방금"),
            "a stamp from the future is now"
        );
    }

    #[test]
    fn the_project_of_a_folder_is_the_deepest_root_that_contains_it() {
        let root = std::env::temp_dir().join(format!("oop-rs-lists-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a"), root.join("link")).unwrap();
        let project = |id: &str, dir: &std::path::Path| ProjectShell {
            id: id.into(),
            workspace_root: dir.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let projects = vec![
            project("outer", &root.join("a")),
            project("inner", &root.join("a/b")),
        ];
        let find = |dir: &std::path::Path| {
            project_for_directory(&projects, &dir.to_string_lossy(), canonical)
                .map(|p| p.id.clone())
        };
        assert_eq!(find(&root.join("a/b/c")).as_deref(), Some("inner"));
        assert_eq!(find(&root.join("a/b")).as_deref(), Some("inner"));
        assert_eq!(find(&root.join("a")).as_deref(), Some("outer"));
        assert_eq!(find(&root), None);
        // A folder next to a root with the same beginning is not inside it.
        std::fs::create_dir_all(root.join("ab")).unwrap();
        assert_eq!(find(&root.join("ab")), None);
        #[cfg(unix)]
        assert_eq!(find(&root.join("link/b")).as_deref(), Some("inner"));
        assert!(project_for_directory(&projects, "/nowhere/else", |p| p.to_string()).is_none());
        let all = vec![project("all", std::path::Path::new("/"))];
        assert_eq!(
            project_for_directory(&all, "/x/y", |p| p.to_string()).map(|p| p.id.as_str()),
            Some("all")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_are_listed_by_their_newest_thread_that_is_not_archived() {
        let project = |id: &str, updated: &str| ProjectShell {
            id: id.into(),
            title: id.into(),
            updated_at: updated.into(),
            ..Default::default()
        };
        let projects = vec![
            project("quiet", "2026-01-05T00:00:00.000Z"),
            project("busy", "2026-01-01T00:00:00.000Z"),
            project("archived-only", "2026-01-03T00:00:00.000Z"),
        ];
        let mut gone = thread("g", "archived-only", "G", "2026-02-09T00:00:00.000Z");
        gone.archived_at = Some("2026-02-10T00:00:00.000Z".into());
        let threads = vec![thread("b", "busy", "B", "2026-02-01T00:00:00.000Z"), gone];
        let ids: Vec<&str> = sorted_projects(&projects, &threads)
            .iter()
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(ids, ["busy", "quiet", "archived-only"]);
    }

    fn crew_world() -> Vec<ThreadShell> {
        let mut pinned = thread("pinned", "p", "Pinned one", "2026-01-01T00:00:00.000Z");
        pinned.pinned_at = Some("2026-01-09T00:00:00.000Z".into());
        pinned.pin_order_key = Some("n".into());
        let mut keyless = thread("keyless", "p", "Pinned keyless", "2026-01-02T00:00:00.000Z");
        keyless.pinned_at = Some("2026-01-09T00:00:00.000Z".into());
        let mut first = thread("first", "p", "Pinned first", "2026-01-03T00:00:00.000Z");
        first.pinned_at = Some("2026-01-09T00:00:00.000Z".into());
        first.pin_order_key = Some("h".into());
        let lead = thread("lead", "p", "Plain lead", "2026-01-05T00:00:00.000Z");
        let mut folded = thread(
            "folded",
            "p",
            "Crew Worker · fix",
            "2026-01-06T00:00:00.000Z",
        );
        folded.parent_thread_id = Some("lead".into());
        let mut asking = thread(
            "asking",
            "p",
            "Crew Worker · ask",
            "2026-01-04T00:00:00.000Z",
        );
        asking.parent_thread_id = Some("lead".into());
        asking.has_pending_approvals = true;
        let mut orphan = thread(
            "orphan",
            "p",
            "Crew Expert · lost",
            "2026-01-07T00:00:00.000Z",
        );
        orphan.parent_thread_id = Some("not-there".into());
        let mut archived = thread("archived", "p", "Archived", "2026-01-08T00:00:00.000Z");
        archived.archived_at = Some("2026-01-09T00:00:00.000Z".into());
        let other = thread("other", "q", "Other project", "2026-01-08T00:00:00.000Z");
        vec![
            pinned, keyless, first, lead, folded, asking, orphan, archived, other,
        ]
    }

    #[test]
    fn crew_tasks_fold_pins_follow_their_keys_and_the_rest_is_newest_first() {
        let threads = crew_world();
        let (rows, listed) = thread_rows(&threads, "p", "");
        let ids: Vec<&str> = rows.iter().map(|t| t.id.as_str()).collect();
        // Waiting crew, pins by key then keyless, then the rest; the folded and orphaned crew
        // threads and the archived one are not rows.
        assert_eq!(ids, ["asking", "first", "pinned", "keyless", "lead"]);
        assert_eq!(listed.folded.get("lead"), Some(&1));
        assert!(listed.waiting.contains("asking"));
        assert_eq!(row_label(rows[0], &listed), "crew Worker · ask");
        assert_eq!(row_label(rows[4], &listed), "Plain lead");
        let (rows, _) = thread_rows(&threads, "p", "plain");
        assert_eq!(
            rows.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["lead"]
        );
        let (rows, _) = thread_rows(&threads, "p", "pinned");
        assert_eq!(
            rows.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["pinned", "first", "keyless"]
        );
        let (rows, _) = thread_rows(&threads, "p", "crew ask");
        assert_eq!(rows.len(), 1);
        assert!(thread_rows(&threads, "nope", "").0.is_empty());
    }

    #[test]
    fn running_threads_are_told_from_idle_ones() {
        let mut t = thread("t", "p", "T", "");
        assert!(!is_thread_running(&t));
        t.session = Some(crate::thread::Session {
            status: "running".into(),
            ..Default::default()
        });
        assert!(is_thread_running(&t));
        t.session = Some(crate::thread::Session {
            status: "ready".into(),
            ..Default::default()
        });
        assert!(!is_thread_running(&t));
        t.latest_turn = Some(crate::thread::LatestTurn {
            state: "running".into(),
            ..Default::default()
        });
        assert!(is_thread_running(&t));
    }

    #[test]
    fn a_window_keeps_the_pointer_in_view() {
        assert_eq!(window_around(0, 10, 4), (0, 4));
        assert_eq!(window_around(5, 10, 4), (3, 7));
        assert_eq!(window_around(9, 10, 4), (6, 10));
        assert_eq!(window_around(2, 3, 10), (0, 3));
        assert_eq!(window_around(0, 0, 5), (0, 0));
        assert_eq!(window_around(3, 10, 0), (3, 3));
    }

    // ---- the screens

    fn key_event(code: KeyCode, modifiers: KeyModifiers) -> Msg {
        Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }))
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle(key_event(code, KeyModifiers::NONE));
    }

    fn type_text(app: &mut App, text: &str) {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
    }

    fn draw_rows(app: &App, w: u16, h: u16) -> Vec<String> {
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
                    x += u16::try_from(cells(symbol).max(1)).unwrap_or(1);
                }
                row.trim_end().to_string()
            })
            .collect()
    }

    /// The rows of the list under its title, as drawn.
    fn list_rows(app: &App) -> Vec<String> {
        let rows = draw_rows(app, 110, 30);
        let title = rows
            .iter()
            .position(|r| {
                r.starts_with(s("Pick a project", "프로젝트를 고르세요"))
                    || r.starts_with(s("Pick a thread", "스레드를 고르세요"))
            })
            .unwrap_or_else(|| panic!("no list on screen:\n{}", rows.join("\n")));
        rows[title + 3..rows.len() - 1]
            .iter()
            .filter(|r| !r.is_empty())
            .cloned()
            .collect()
    }

    fn world(cwd: &str) -> (App, UnboundedReceiver<Msg>) {
        let (tx, rx) = unbounded_channel();
        let mut app = App::new("0.0.0", cwd, "/tmp", tx);
        app.last_model_path = std::env::temp_dir().join(format!(
            "oop-rs-lists-none-{}/last-model.json",
            std::process::id()
        ));
        let mut threads: Vec<Value> = crew_world()
            .iter()
            .map(|t| {
                json!({"id": t.id, "projectId": if t.project_id == "p" { "p1" } else { "p2" }, "title": t.title,
                    "createdAt": t.created_at, "updatedAt": t.updated_at, "archivedAt": t.archived_at,
                    "pinnedAt": t.pinned_at, "pinOrderKey": t.pin_order_key, "parentThreadId": t.parent_thread_id,
                    "hasPendingApprovals": t.has_pending_approvals})
            })
            .collect();
        threads.retain(|t| t["id"] != "orphan");
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [
                {"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs-lists/work/demo", "updatedAt": "2026-01-01T00:00:00.000Z"},
                {"id": "p2", "title": "other", "workspaceRoot": "/tmp/oop-rs-lists/other", "updatedAt": "2026-01-01T00:00:00.000Z"}],
            "threads": threads}})));
        (app, rx)
    }

    #[tokio::test]
    async fn the_project_list_starts_on_the_working_folders_project_and_opens_its_threads() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo/src");
        crate::cmd::run(&mut app, "projects", "");
        assert!(app.screen.is_some());
        let rows = list_rows(&app);
        // `other` has the newer thread (an unarchived one at 2026-01-08), `demo` is where we are.
        assert!(
            rows[0].contains("other") && rows[1].contains("demo"),
            "{rows:?}"
        );
        assert!(
            rows[1].starts_with(app.sym.prompt) && !rows[0].starts_with(app.sym.prompt),
            "{rows:?}"
        );
        assert!(rows[1].contains("/tmp/oop-rs-lists/work/demo"));
        assert!(app.screen.as_ref().unwrap().hint().contains("Enter"));
        press(&mut app, KeyCode::Enter);
        // Now the threads of `demo`: the new-thread row, then the five rows in order.
        let rows = list_rows(&app);
        assert!(app.screen.as_ref().unwrap().hint().contains("Ctrl+P"));
        assert_eq!(rows.len(), 1 + 5, "{rows:?}");
        assert!(rows[0].contains(s("New thread", "새 스레드")));
        assert!(rows[1].contains("crew Worker · ask"), "{rows:?}");
        assert!(
            rows[2].contains("Pinned first")
                && rows[3].contains("Pinned one")
                && rows[4].contains("Pinned keyless")
        );
        assert!(
            rows[5].contains("Plain lead") && rows[5].contains('1'),
            "the folded crew task is counted: {rows:?}"
        );
        assert!(rows[2].contains(s("Pinned", "고정")));
        assert!(
            rows.iter()
                .all(|r| !r.contains("Archived") && !r.contains("Other project"))
        );
    }

    #[tokio::test]
    async fn enter_on_a_thread_opens_it_and_on_the_first_row_starts_a_new_one() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        crate::cmd::run(&mut app, "threads", "");
        // The pointer is on "New thread".
        assert!(list_rows(&app)[0].starts_with(app.sym.prompt));
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Enter);
        assert!(app.screen.is_none());
        assert_eq!(app.active, Active::Thread("first".into()));
        crate::cmd::run(&mut app, "t", "");
        press(&mut app, KeyCode::Enter);
        assert!(app.screen.is_none());
        assert_eq!(app.active, Active::Draft("p1".into()));
    }

    #[tokio::test]
    async fn threads_without_an_open_conversation_use_the_last_project_or_ask_for_one() {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs-lists/nowhere", "/tmp", tx);
        crate::cmd::run(&mut app, "threads", "");
        assert!(app.screen.as_ref().unwrap().hint().contains("Enter"));
        assert!(
            !app.screen.as_ref().unwrap().hint().contains("Ctrl+P"),
            "no project: the project list"
        );
        let rows = draw_rows(&app, 100, 24);
        assert!(
            rows.iter()
                .any(|r| r.contains(s("Loading projects", "프로젝트를 불러오는"))),
            "{rows:?}"
        );
    }

    #[tokio::test]
    async fn typing_searches_escape_undoes_the_search_then_steps_back() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        crate::cmd::run(&mut app, "projects", "");
        type_text(&mut app, "oth");
        let rows = list_rows(&app);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].contains("other") && rows[0].starts_with(app.sym.prompt));
        assert!(
            draw_rows(&app, 110, 30)
                .iter()
                .any(|r| r.contains("oth") && r.contains(s("Search:", "검색:")))
        );
        type_text(&mut app, "zz");
        let rows = list_rows(&app);
        assert!(
            rows[0].contains(s("No matching projects", "일치하는 프로젝트가 없습니다")),
            "{rows:?}"
        );
        assert!(
            app.screen
                .as_ref()
                .unwrap()
                .hint()
                .contains(s("clear search", "검색어 지우기"))
        );
        // Enter on nothing does nothing.
        press(&mut app, KeyCode::Enter);
        assert!(app.screen.is_some());
        press(&mut app, KeyCode::Backspace);
        press(&mut app, KeyCode::Backspace);
        assert_eq!(list_rows(&app).len(), 1);
        app.handle(key_event(KeyCode::Backspace, KeyModifiers::CONTROL));
        assert_eq!(
            list_rows(&app).len(),
            2,
            "Ctrl+Backspace empties the search"
        );
        type_text(&mut app, "oth");
        app.handle(key_event(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert_eq!(list_rows(&app).len(), 2, "Ctrl+U empties the search");
        type_text(&mut app, "dem");
        press(&mut app, KeyCode::Esc);
        assert_eq!(
            list_rows(&app).len(),
            2,
            "the first Esc only clears the search"
        );
        press(&mut app, KeyCode::Esc);
        assert!(app.screen.is_none(), "the second leaves the list");
    }

    #[tokio::test]
    async fn escape_on_the_threads_goes_back_to_the_projects_with_the_search_undone_first() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        crate::cmd::run(&mut app, "threads", "");
        type_text(&mut app, "lead");
        let rows = list_rows(&app);
        assert_eq!(rows.len(), 1, "no new-thread row among matches: {rows:?}");
        assert!(rows[0].contains("Plain lead"));
        press(&mut app, KeyCode::Esc);
        assert_eq!(list_rows(&app).len(), 6);
        press(&mut app, KeyCode::Esc);
        assert!(app.screen.as_ref().unwrap().hint().contains("Enter"));
        assert!(!app.screen.as_ref().unwrap().hint().contains("Ctrl+P"));
        assert!(list_rows(&app).iter().any(|r| r.contains("other")));
    }

    #[tokio::test]
    async fn the_pointer_moves_by_page_and_end_and_never_leaves_the_list() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        crate::cmd::run(&mut app, "threads", "");
        let marked = |app: &App| {
            list_rows(app)
                .iter()
                .position(|r| r.starts_with(app.sym.prompt))
                .unwrap()
        };
        press(&mut app, KeyCode::End);
        assert_eq!(marked(&app), 5);
        press(&mut app, KeyCode::Down);
        assert_eq!(marked(&app), 5);
        press(&mut app, KeyCode::PageUp);
        assert_eq!(marked(&app), 0);
        press(&mut app, KeyCode::Up);
        assert_eq!(marked(&app), 0);
        press(&mut app, KeyCode::PageDown);
        assert_eq!(marked(&app), 5);
        press(&mut app, KeyCode::Home);
        assert_eq!(marked(&app), 0);
        app.screen.as_mut().unwrap().wheel(false);
        assert_eq!(marked(&app), 1);
        app.screen.as_mut().unwrap().wheel(true);
        app.screen.as_mut().unwrap().wheel(true);
        assert_eq!(marked(&app), 0);
    }

    #[tokio::test]
    async fn a_folder_that_is_in_no_project_is_offered_first_and_added_on_enter() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/elsewhere");
        crate::cmd::run(&mut app, "projects", "");
        let rows = list_rows(&app);
        assert!(
            rows[0].contains("/tmp/oop-rs-lists/elsewhere") && rows[0].starts_with(app.sym.prompt),
            "{rows:?}"
        );
        assert_eq!(rows.len(), 3);
        // Searching is looking for a project: the add row is not among the matches.
        type_text(&mut app, "demo");
        assert_eq!(list_rows(&app).len(), 1);
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Enter);
        assert!(app.screen.is_none());
        let last = app.log.last().unwrap();
        assert_eq!(last["type"], "project.create");
        assert_eq!(last["workspaceRoot"], "/tmp/oop-rs-lists/elsewhere");
    }

    fn pinning_config() -> Value {
        json!({"environment": {"capabilities": {"threadPinning": true, "threadPinReorder": true}}})
    }

    #[tokio::test]
    async fn ctrl_p_pins_with_a_key_above_the_others_and_unpins_without_one() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        app.config = pinning_config();
        crate::cmd::run(&mut app, "threads", "");
        // Row 5 is "Plain lead": not pinned.
        press(&mut app, KeyCode::End);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let command = app.log.last().unwrap().clone();
        assert_eq!(command["type"], "thread.pin");
        assert_eq!(command["threadId"], "lead");
        assert!(
            command["orderKey"].as_str().unwrap() < "h",
            "above the highest pin (h): {command}"
        );
        assert!(command["commandId"].as_str().is_some());
        // Row 2 is pinned: unpinned, with no key.
        press(&mut app, KeyCode::Home);
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Down);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let command = app.log.last().unwrap().clone();
        assert_eq!(
            (command["type"].as_str(), command["threadId"].as_str()),
            (Some("thread.unpin"), Some("first"))
        );
        assert!(command.get("orderKey").is_none());
        // The new-thread row and a server that cannot pin send nothing.
        let sent = app.log.len();
        press(&mut app, KeyCode::Home);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert_eq!(app.log.len(), sent);
        app.config = json!({"environment": {"capabilities": {}}});
        press(&mut app, KeyCode::Down);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert_eq!(app.log.len(), sent, "the server cannot pin");
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains(s("pinning", "고정"))
        );
    }

    #[tokio::test]
    async fn a_server_without_arranged_order_is_pinned_without_a_key() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        app.config = json!({"environment": {"capabilities": {"threadPinning": true}}});
        crate::cmd::run(&mut app, "threads", "");
        press(&mut app, KeyCode::End);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let command = app.log.last().unwrap();
        assert_eq!(command["type"], "thread.pin");
        assert!(command.get("orderKey").is_none());
        // With no connection the command is not lost silently.
        assert_eq!(
            app.notice.as_deref(),
            Some(crate::i18n::tr("notice.offline"))
        );
    }

    #[tokio::test]
    async fn the_pointer_follows_a_thread_to_where_the_servers_list_puts_it() {
        let (mut app, _rx) = world("/tmp/oop-rs-lists/work/demo");
        let screen = ThreadsScreen::new("p1");
        *screen.follow.lock().unwrap() = Some(("lead".into(), true));
        screen.selected.set(5);
        // Not yet: the shell still says it is not pinned.
        screen.settle(&app);
        assert_eq!(screen.selected.get(), 5);
        assert!(screen.follow.lock().unwrap().is_some());
        app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 2, "thread": {
            "id": "lead", "projectId": "p1", "title": "Plain lead", "createdAt": "2026-01-05T00:00:00.000Z",
            "updatedAt": "2026-01-05T00:00:00.000Z", "pinnedAt": "2026-01-10T00:00:00.000Z", "pinOrderKey": "c"}})));
        screen.settle(&app);
        // New-thread row, the waiting crew thread, then the pin with key c is first of the pins.
        assert_eq!(screen.selected.get(), 2);
        assert!(screen.follow.lock().unwrap().is_none());
    }

    /// A server that answers every dispatch with what the test says and tells what it was sent.
    async fn dispatch_server(
        failure: Option<&'static str>,
    ) -> (
        crate::wire::Rpc,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, received) = unbounded_channel();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let m: Value = serde_json::from_str(text.as_str()).unwrap();
                if m["_tag"] != "Request" {
                    continue;
                }
                let _ = seen.send(m["payload"].clone());
                let exit = match failure {
                    None => json!({"_tag": "Success", "value": null}),
                    Some(message) => json!({"_tag": "Failure", "cause": [{"_tag": "Fail",
                        "error": {"_tag": "OrchestrationDispatchCommandError", "message": message}}]}),
                };
                let reply = json!([{"_tag": "Exit", "requestId": m["id"], "exit": exit}]);
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
        });
        let rpc = crate::wire::Rpc::connect(&format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        (rpc, received)
    }

    #[tokio::test]
    async fn a_pin_reaches_the_server_and_a_refusal_is_said_in_the_conversation() {
        let (mut app, mut rx) = world("/tmp/oop-rs-lists/work/demo");
        app.config = pinning_config();
        let (rpc, mut received) = dispatch_server(Some("no room\nsecond line")).await;
        app.rpc = Some(rpc);
        crate::cmd::run(&mut app, "threads", "");
        press(&mut app, KeyCode::End);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let sent = received.recv().await.unwrap();
        assert_eq!(
            (sent["type"].as_str(), sent["threadId"].as_str()),
            (Some("thread.pin"), Some("lead"))
        );
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(msg, Msg::Ext(_)));
        app.handle(msg);
        match app.notes.last().unwrap() {
            crate::notes::Note::Text { tone, body, .. } => {
                assert_eq!(*tone, Tone::Error);
                assert!(
                    body[0].ends_with("no room")
                        && body[0].starts_with(s("Could not pin the thread", "고정 실패")),
                    "{body:?}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn an_accepted_pin_says_nothing_more() {
        let (mut app, mut rx) = world("/tmp/oop-rs-lists/work/demo");
        app.config = pinning_config();
        let (rpc, mut received) = dispatch_server(None).await;
        app.rpc = Some(rpc);
        crate::cmd::run(&mut app, "threads", "");
        press(&mut app, KeyCode::End);
        app.handle(key_event(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert_eq!(received.recv().await.unwrap()["type"], "thread.pin");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
                .await
                .is_err()
        );
        assert!(app.notes.is_empty());
    }
}
