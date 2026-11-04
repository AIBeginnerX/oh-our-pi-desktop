//! What the message box does beyond typing: the command list that opens above it for a message that
//! starts with `/`, the mouse (click to place the cursor, drag and double click to select), the
//! selection's keys, and copy, cut and paste through the system clipboard. The text itself, its
//! cursor and its selection live in `input.rs`; this is the App-side glue and the drawing, kept
//! here so `app.rs` and `ui.rs` only carry a hook each.
//!
//! The clipboard is never touched from here: a copy is queued as the same `CopyJob` the conversation's
//! drag-to-copy uses, and a paste is a request the main loop answers with `Msg::Clip` (see
//! `main.rs`). A test hands the app the answer.

use crate::app::{App, Focus};
use crate::clipboard::{self, Why};
use crate::input::Move;
use crate::panels_common::s;
use crate::slash::{self, Command};
use crate::text::{sanitize, truncate, width};
use crate::theme::Theme;
use ratatui::Frame;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use std::cell::Cell;
use std::time::{Duration, Instant};

/// Most rows the command list takes.
const LIST_ROWS: usize = 8;
/// Two presses on one cell within this are a double click.
const DOUBLE_CLICK: Duration = Duration::from_millis(500);

/// Where the box's text was drawn last, so a pointer can be turned into a place in the text.
#[derive(Clone, Copy, Default, Debug)]
pub struct Geo {
    /// The box inside its border.
    pub inner: Rect,
    /// Cells a row of text may take (the width the input was cut to).
    pub room: usize,
    /// The first row of the message that is on screen.
    pub first: usize,
}

#[derive(Default)]
struct Slash {
    selected: usize,
    /// The first row of the list that is on screen.
    top: Cell<usize>,
    /// The rows of the list as last drawn (inside its border).
    rows: Cell<Rect>,
    /// The word the list was last built for, to start from the top when it changes.
    seen: Option<String>,
    /// Esc closed the list for this word; typing another word opens it again.
    dismissed: Option<String>,
}

#[derive(Default)]
pub struct State {
    slash: Slash,
    geo: Cell<Geo>,
    /// Where the press began while a drag that began in the box is under way.
    drag_from: Option<usize>,
    last_click: Option<(Instant, u16, u16)>,
    /// The tools that read the clipboard; none over SSH.
    read_tools: Vec<clipboard::Tool>,
    paste_wanted: bool,
}

impl State {
    pub fn new(read_tools: Vec<clipboard::Tool>) -> State {
        State {
            read_tools,
            ..State::default()
        }
    }

    /// A press at `(x, y)` at `now`: 2 when it is the second of a double click, else 1.
    fn click(&mut self, now: Instant, x: u16, y: u16) -> u8 {
        let double = self.last_click.is_some_and(|(at, px, py)| {
            (px, py) == (x, y) && now.duration_since(at) <= DOUBLE_CLICK
        });
        self.last_click = if double { None } else { Some((now, x, y)) };
        if double { 2 } else { 1 }
    }
}

/// The colours of selected text: the theme's brand on its ground, reversed where there is no colour.
pub fn selected_style(t: &Theme) -> Style {
    if t.fills_user() {
        Style::new().bg(t.brand).fg(t.user_bg)
    } else {
        Style::new().add_modifier(Modifier::REVERSED)
    }
}

/// The box is where typing goes: no panel, list or screen has taken its place.
fn active(app: &App) -> bool {
    app.focus == Focus::Composer
        && app.modal.is_none()
        && app.screen.is_none()
        && app.approval().is_none()
        && app.pending_input().is_none()
}

// --- the command list ---------------------------------------------------------------------

/// The commands the list shows now; empty when it is closed.
fn items(app: &App) -> Vec<&'static Command> {
    if !active(app) {
        return Vec::new();
    }
    match app.input.slash_query() {
        Some(word) if app.composer.slash.dismissed.as_ref() != Some(&word) => {
            slash::matches(slash::COMMANDS, &word)
        }
        _ => Vec::new(),
    }
}

pub fn list_open(app: &App) -> bool {
    !items(app).is_empty()
}

/// Keeps the list's highlight honest after every event: a new word starts it from the top.
pub fn sync(app: &mut App) {
    let word = if active(app) {
        app.input.slash_query()
    } else {
        None
    };
    let slash = &mut app.composer.slash;
    if slash.seen != word {
        slash.selected = 0;
        slash.top.set(0);
        if slash.dismissed != word {
            slash.dismissed = None;
        }
        slash.seen = word;
    }
}

fn highlighted(app: &App) -> Option<&'static Command> {
    let items = items(app);
    items
        .get(
            app.composer
                .slash
                .selected
                .min(items.len().saturating_sub(1)),
        )
        .copied()
}

fn step(app: &mut App, forward: bool, wrap: bool) {
    let len = items(app).len();
    let slash = &mut app.composer.slash;
    let now = slash.selected.min(len.saturating_sub(1));
    slash.selected = match (forward, wrap) {
        (true, true) => (now + 1) % len.max(1),
        (true, false) => (now + 1).min(len.saturating_sub(1)),
        (false, true) => (now + len.max(1) - 1) % len.max(1),
        (false, false) => now.saturating_sub(1),
    };
}

/// Enter or a click on a command: it runs, unless it cannot do without an argument, and then
/// its name is completed for the argument to be typed. Tab only completes.
fn accept(app: &mut App, run: bool) {
    let Some(command) = highlighted(app) else {
        return;
    };
    let (text, send) = accepted(command, run);
    app.input.set(&text);
    if send {
        app.submit();
    }
}

/// What Enter (`run`) or Tab does with a command: the text to leave in the box, and whether to send it.
fn accepted(command: &Command, run: bool) -> (String, bool) {
    if run && !command.required {
        (format!("/{}", command.name), true)
    } else {
        (command.completion(), false)
    }
}

// --- keys ---------------------------------------------------------------------------------

/// Copies the box's selection to the clipboard; false when nothing is selected.
fn copy(app: &mut App) -> bool {
    let Some(text) = app.input.selected_text() else {
        return false;
    };
    app.copy_text(text);
    true
}

/// Ctrl-C: with a selection in the box it copies, otherwise it is the quit key as ever.
pub fn ctrl_c(app: &mut App) {
    if !(active(app) && copy(app)) {
        app.quit = true;
    }
}

/// Keys that belong to the box's list, selection and clipboard. True when one was taken; the rest
/// (typing, plain cursor keys, Enter, Esc) are `app.rs`'s as before.
pub fn key(app: &mut App, key: KeyEvent) -> bool {
    let mods = key.modifiers;
    let ctrl = mods.contains(KeyModifiers::CONTROL);
    let sup = mods.contains(KeyModifiers::SUPER);
    let alt = mods.contains(KeyModifiers::ALT);
    let shift = mods.contains(KeyModifiers::SHIFT);
    if (ctrl || sup)
        && !alt
        && let KeyCode::Char(c) = key.code
    {
        match c.to_ascii_lowercase() {
            // Cmd-C with nothing selected is the terminal's to use; Ctrl-C is handled before this.
            'c' if sup => {
                copy(app);
                return true;
            }
            'x' => {
                if copy(app) {
                    app.input.delete_selection();
                }
                return true;
            }
            'v' => {
                app.composer.paste_wanted = true;
                return true;
            }
            'a' => {
                app.input.select_all();
                return true;
            }
            _ => {}
        }
    }
    if list_open(app) && !ctrl && !sup {
        match key.code {
            KeyCode::Up if !shift => {
                step(app, false, true);
                return true;
            }
            KeyCode::Down if !shift => {
                step(app, true, true);
                return true;
            }
            KeyCode::Tab => {
                accept(app, false);
                return true;
            }
            KeyCode::Enter if !alt && !shift => {
                accept(app, true);
                return true;
            }
            KeyCode::Esc => {
                app.composer.slash.dismissed = app.input.slash_query();
                return true;
            }
            _ => {}
        }
    }
    if shift && !ctrl && !alt {
        let to = match key.code {
            KeyCode::Left => Move::Left,
            KeyCode::Right => Move::Right,
            KeyCode::Home => Move::Home,
            KeyCode::End => Move::End,
            KeyCode::Up => Move::Up,
            KeyCode::Down => Move::Down,
            _ => return false,
        };
        app.input.mv(to, true);
        return true;
    }
    false
}

/// The main loop is asked to read the clipboard once: the tools to read it with.
pub fn take_paste_request(app: &mut App) -> Option<Vec<clipboard::Tool>> {
    std::mem::take(&mut app.composer.paste_wanted).then(|| app.composer.read_tools.clone())
}

/// The clipboard was read: its text goes in as a paste, over the selection.
pub fn pasted(app: &mut App, result: Result<String, Why>) {
    match result {
        Ok(text) => app.on_paste(&text),
        Err(Why::Missing) => {
            app.notice = Some(
                s(
                    "No clipboard tool here: paste with your terminal's own paste (Cmd/Ctrl-Shift-V).",
                    "여기에는 클립보드 도구가 없습니다. 터미널의 붙여넣기(Cmd/Ctrl-Shift-V)를 쓰세요.",
                )
                .to_string(),
            );
        }
        Err(_) => {
            app.notice = Some(
                s(
                    "Could not read the clipboard.",
                    "클립보드를 읽지 못했습니다.",
                )
                .to_string(),
            );
        }
    }
}

// --- the mouse ----------------------------------------------------------------------------

fn inside(r: Rect, x: u16, y: u16) -> bool {
    x >= r.x && x < r.right() && y >= r.y && y < r.bottom()
}

/// The place in the message under a pointer. With `clamp` a pointer above or below the box counts
/// as its first or last row on screen (a drag that leaves the box).
fn index_under(app: &App, x: u16, y: u16, clamp: bool) -> Option<usize> {
    let g = app.composer.geo.get();
    if g.inner.width == 0 || g.inner.height == 0 {
        return None;
    }
    if !clamp && !inside(g.inner, x, y) {
        return None;
    }
    let line = i32::from(y) - i32::from(g.inner.y);
    let row = (g.first as i32 + line.clamp(-1, i32::from(g.inner.height) - 1)).max(0) as usize;
    // The two cells before the text hold the prompt.
    let col = usize::from(x.saturating_sub(g.inner.x)).saturating_sub(2);
    Some(app.input.index_at(g.room, row, col.min(g.room)))
}

/// Mouse events for the box and its list. True when one was taken; the rest belong to the
/// conversation and the thread list. `now` is the time of the event.
pub fn mouse(app: &mut App, m: MouseEvent, now: Instant) -> bool {
    let list = app.composer.slash.rows.get();
    let list_up = list_open(app);
    match m.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            if list_up && inside(list, m.column, m.row) =>
        {
            step(app, m.kind == MouseEventKind::ScrollDown, false);
            true
        }
        MouseEventKind::Down(MouseButton::Left) => {
            app.composer.drag_from = None;
            if list_up && inside(list, m.column, m.row) {
                let at = app.composer.slash.top.get() + usize::from(m.row - list.y);
                if at < items(app).len() {
                    app.composer.slash.selected = at;
                    accept(app, true);
                }
                return true;
            }
            let at = if active(app) {
                index_under(app, m.column, m.row, false)
            } else {
                None
            };
            let Some(at) = at else {
                return false;
            };
            app.selection.clear();
            app.focus = Focus::Composer;
            if app.composer.click(now, m.column, m.row) == 2 {
                app.input.select_word_at(at);
            } else {
                app.input.place(at);
                app.composer.drag_from = Some(at);
            }
            true
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            let Some(from) = app.composer.drag_from else {
                return false;
            };
            if let Some(at) = index_under(app, m.column, m.row, true) {
                app.input.extend_to(from, at);
            }
            true
        }
        MouseEventKind::Up(MouseButton::Left) => app.composer.drag_from.take().is_some(),
        _ => false,
    }
}

// --- drawing ------------------------------------------------------------------------------

/// The text of the box inside its border: the prompt, the rows that end at the cursor's, a chip in
/// the accent colour, the selection in the selection colours, and the cursor.
pub fn draw_input(frame: &mut Frame, inner: Rect, app: &App) {
    let t = &app.theme;
    let room = usize::from(inner.width).saturating_sub(3).max(2);
    let (rows, (col, row)) = app.input.rows(room);
    let visible = usize::from(inner.height).max(1);
    // Show the rows that end at the cursor's, so the cursor is always on screen.
    let first = (row + 1).saturating_sub(visible);
    app.composer.geo.set(Geo { inner, room, first });
    let selection = app.input.selection();
    let base = Style::new().fg(t.user_fg);
    let chip = if t.fills_user() {
        Style::new().fg(t.accent).bg(t.code_bg)
    } else {
        Style::new().add_modifier(Modifier::BOLD)
    };
    let lines: Vec<Line> = rows
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .map(|(i, r)| {
            let lead = if i == 0 {
                format!("{} ", app.sym.prompt)
            } else {
                "  ".into()
            };
            let mut spans = vec![Span::styled(lead, Style::new().fg(t.brand))];
            for (k, cell) in r.cells.iter().enumerate() {
                let picked =
                    selection.is_some_and(|(from, to)| (from..to).contains(&(r.start + k)));
                let style = match (picked, cell.chip) {
                    (true, _) => selected_style(t),
                    (false, true) => chip,
                    (false, false) => base,
                };
                spans.push(Span::styled(sanitize(&cell.text), style));
            }
            Line::from(spans)
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
    if app.focus == Focus::Composer && app.modal.is_none() {
        frame.set_cursor_position(Position::new(
            inner.x + 2 + col as u16,
            inner.y + (row - first) as u16,
        ));
    }
}

/// The command list, over the bottom of the conversation, right above the box at `bottom`.
/// `above` is the conversation, which bounds how tall it can be.
pub fn draw_list(frame: &mut Frame, above: Rect, bottom: Rect, app: &App) {
    let slash = &app.composer.slash;
    slash.rows.set(Rect::default());
    let items = items(app);
    let room = usize::from(bottom.y.saturating_sub(above.y)).saturating_sub(2);
    let shown = items.len().min(LIST_ROWS).min(room);
    if shown == 0 {
        return;
    }
    let t = &app.theme;
    let selected = slash.selected.min(items.len() - 1);
    let mut top = slash.top.get().min(items.len() - shown);
    if selected < top {
        top = selected;
    } else if selected >= top + shown {
        top = selected + 1 - shown;
    }
    slash.top.set(top);
    let area = Rect::new(
        bottom.x,
        bottom.y - (shown as u16 + 2),
        bottom.width,
        shown as u16 + 2,
    );
    let title = if items.len() > shown {
        format!(
            "{}{}/{} ",
            s(" Commands ", " 명령 "),
            selected + 1,
            items.len()
        )
    } else {
        s(" Commands ", " 명령 ").to_string()
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(t.brand))
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(Clear, area);
    frame.render_widget(block, area);
    slash.rows.set(inner);
    let usage_cells = items.iter().map(|c| width(&c.usage())).max().unwrap_or(0);
    let name_cells = usage_cells.min(usize::from(inner.width) / 2);
    let lines: Vec<Line> = items
        .iter()
        .enumerate()
        .skip(top)
        .take(shown)
        .map(|(i, c)| {
            let usage = truncate(&c.usage(), name_cells);
            let gap = " ".repeat(name_cells - width(&usage) + 2);
            let text = truncate(
                c.description(),
                usize::from(inner.width).saturating_sub(name_cells + 3),
            );
            if i == selected {
                let row = format!(" {usage}{gap}{text}");
                let fill = " ".repeat(usize::from(inner.width).saturating_sub(width(&row)));
                Line::styled(format!("{row}{fill}"), selected_style(t))
            } else {
                Line::from(vec![
                    Span::styled(format!(" {usage}"), Style::new().fg(t.brand)),
                    Span::raw(gap),
                    Span::styled(text, t.dim_style()),
                ])
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Msg;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{Event, KeyEventKind, KeyEventState};
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    const CTRL: KeyModifiers = KeyModifiers::CONTROL;
    const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
    const CMD: KeyModifiers = KeyModifiers::SUPER;

    fn app() -> App {
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        app.last_model_path = std::env::temp_dir().join("oop-rs-composer-none/last-model.json");
        app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
            "threads": [{"id": "t1", "projectId": "p1", "title": "t", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
        app.config = json!({"threadSnapshotPagination": true, "providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true,
            "models": [{"slug": "gpt-5", "name": "GPT-5", "isDefault": true}]}]});
        app.side_open = false;
        app.focus = Focus::Composer;
        app
    }

    fn press(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
        app.handle(Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })));
    }

    fn key(app: &mut App, code: KeyCode) {
        press(app, code, KeyModifiers::NONE);
    }

    fn type_text(app: &mut App, text: &str) {
        text.chars().for_each(|c| key(app, KeyCode::Char(c)));
    }

    fn mouse(app: &mut App, kind: MouseEventKind, x: u16, y: u16, at: Instant) {
        app.on_mouse_at(
            MouseEvent {
                kind,
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            },
            at,
        );
    }

    fn draw_to(app: &App, w: u16, h: u16) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| crate::ui::draw(f, app)).unwrap();
        terminal
    }

    fn screen(app: &App, w: u16, h: u16) -> Vec<String> {
        let terminal = draw_to(app, w, h);
        let buffer = terminal.backend().buffer();
        (0..h)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < w {
                    let symbol = buffer[(x, y)].symbol();
                    row.push_str(symbol);
                    x += u16::try_from(width(symbol).max(1)).unwrap_or(1);
                }
                row
            })
            .collect()
    }

    fn row_of(rows: &[String], needle: &str) -> usize {
        rows.iter()
            .position(|r| r.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} is not on screen:\n{}", rows.join("\n")))
    }

    fn long(lines: usize) -> String {
        (1..=lines)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // --- the command list ---

    #[test]
    fn a_slash_opens_the_list_above_the_box_and_typing_filters_it() {
        let mut app = app();
        type_text(&mut app, "/");
        let rows = screen(&app, 100, 30);
        let (title, composer) = (row_of(&rows, "Commands"), row_of(&rows, " Message "));
        assert!(title < composer);
        assert!(
            rows[composer - 1].contains('└'),
            "the list ends right above the box"
        );
        assert!(
            rows[title + 1].contains("/model [name]")
                && rows[title + 1].contains("Choose the model")
        );
        assert!(
            rows[title].contains(&format!("1/{}", slash::COMMANDS.len())),
            "a long list says where it is: {}",
            rows[title]
        );
        type_text(&mut app, "mo");
        let rows = screen(&app, 100, 30);
        let list = rows[row_of(&rows, "Commands")..row_of(&rows, " Message ")].join("\n");
        for shown in ["/model", "/mode", "/mouse"] {
            assert!(list.contains(shown), "{shown} in {list}");
        }
        assert!(!list.contains("/theme") && !list.contains("1/"));
    }

    #[test]
    fn the_list_is_clipped_and_scrolls_with_the_highlight() {
        let mut app = app();
        type_text(&mut app, "/");
        for _ in 0..9 {
            key(&mut app, KeyCode::Down);
        }
        let rows = screen(&app, 100, 30);
        let title = row_of(&rows, "Commands");
        assert!(rows[title].contains(&format!("10/{}", slash::COMMANDS.len())));
        let last = row_of(&rows, " Message ") - 2;
        assert!(rows[last].contains("/dag-workflow"), "{}", rows[last]);
        assert!(
            !rows[title..=last].iter().any(|r| r.contains("/model")),
            "the first rows scrolled away"
        );
        // wrapping round, and a short screen leaves the list what room there is
        for _ in 9..slash::COMMANDS.len() {
            key(&mut app, KeyCode::Down);
        }
        assert_eq!(highlighted(&app).unwrap().name, "model");
        key(&mut app, KeyCode::Up);
        assert_eq!(highlighted(&app).unwrap().name, "exit");
        for h in [6, 9, 12] {
            let rows = screen(&app, 80, h);
            assert_eq!(rows.len(), usize::from(h));
        }
    }

    #[test]
    fn tab_completes_and_enter_runs_and_esc_closes_without_clearing() {
        let mut app = app();
        type_text(&mut app, "/mod");
        key(&mut app, KeyCode::Down);
        assert_eq!(highlighted(&app).unwrap().name, "mode");
        key(&mut app, KeyCode::Tab);
        assert_eq!(
            app.input.text(),
            "/mode ",
            "a command with an argument completes with a space"
        );
        assert!(!list_open(&app), "the list is for the command word only");
        app.input.set("/exi");
        key(&mut app, KeyCode::Tab);
        assert_eq!(app.input.text(), "/exit");
        // Esc closes it and keeps the text; the same word does not reopen it
        app.input.set("/he");
        assert!(list_open(&app));
        key(&mut app, KeyCode::Esc);
        assert!(!list_open(&app));
        assert_eq!(app.input.text(), "/he");
        assert!(app.focus == Focus::Composer, "Esc only closed the list");
        // another word opens it again
        type_text(&mut app, "l");
        assert!(list_open(&app));
        key(&mut app, KeyCode::Enter);
        assert_eq!(app.notice.as_deref(), Some(crate::i18n::tr("notice.help")));
        assert!(app.input.is_empty(), "Enter ran the highlighted command");
    }

    #[test]
    fn enter_on_a_word_that_is_no_command_still_says_so_and_a_typed_alias_runs() {
        let mut app = app();
        type_text(&mut app, "/zzz");
        assert!(!list_open(&app));
        key(&mut app, KeyCode::Enter);
        assert_eq!(app.input.text(), "/zzz");
        assert_eq!(
            app.notice.as_deref(),
            Some(crate::i18n::tr("notice.unknownCommand"))
        );
        app.input.take(false);
        type_text(&mut app, "/t");
        assert_eq!(
            highlighted(&app).unwrap().name,
            "threads",
            "the alias `t` leads the list"
        );
    }

    #[test]
    fn a_command_that_needs_an_argument_is_completed_not_run() {
        let needs = Command {
            required: true,
            ..slash::COMMANDS[0]
        };
        assert_eq!(accepted(&needs, true), ("/model ".to_string(), false));
        assert_eq!(accepted(&needs, false), ("/model ".to_string(), false));
        assert_eq!(
            accepted(&slash::COMMANDS[0], true),
            ("/model".to_string(), true)
        );
        assert_eq!(
            accepted(&slash::COMMANDS[0], false),
            ("/model ".to_string(), false)
        );
    }

    #[test]
    fn up_and_down_walk_the_history_while_the_list_is_closed() {
        let mut app = app();
        app.input.set("earlier message");
        app.input.take(true);
        key(&mut app, KeyCode::Up);
        assert_eq!(
            app.input.text(),
            "earlier message",
            "no list: history, as before"
        );
        key(&mut app, KeyCode::Down);
        type_text(&mut app, "/");
        key(&mut app, KeyCode::Up);
        assert_eq!(
            app.input.text(),
            "/",
            "with the list open Up moves the highlight"
        );
        key(&mut app, KeyCode::Esc);
        key(&mut app, KeyCode::Up);
        assert_eq!(
            app.input.text(),
            "earlier message",
            "closed with Esc: history again"
        );
    }

    #[test]
    fn a_click_on_a_command_runs_it_and_the_wheel_moves_the_highlight() {
        let mut app = app();
        type_text(&mut app, "/");
        screen(&app, 100, 30);
        let rows = app.composer.slash.rows.get();
        mouse(
            &mut app,
            MouseEventKind::ScrollDown,
            rows.x + 3,
            rows.y,
            Instant::now(),
        );
        assert_eq!(highlighted(&app).unwrap().name, "mode");
        type_text(&mut app, "he");
        screen(&app, 100, 30);
        let rows = app.composer.slash.rows.get();
        let down = MouseEventKind::Down(MouseButton::Left);
        mouse(&mut app, down, rows.x + 3, rows.y, Instant::now());
        assert_eq!(app.notice.as_deref(), Some(crate::i18n::tr("notice.help")));
        assert!(app.input.is_empty());
    }

    // --- the mouse in the box ---

    /// The screen cell of column `col` of the box's first row.
    fn cell(app: &App, col: u16, row: u16) -> (u16, u16) {
        let g = app.composer.geo.get();
        (g.inner.x + 2 + col, g.inner.y + row)
    }

    #[test]
    fn a_click_puts_the_cursor_on_that_cell_with_wide_characters() {
        let mut app = app();
        type_text(&mut app, "안녕x");
        screen(&app, 100, 30);
        let (down, up) = (
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        );
        let now = Instant::now();
        // columns: 안 = 0..2, 녕 = 2..4, x = 4
        for (col, inserted) in [
            (2, "안Z녕x"),
            (3, "안녕Zx"),
            (4, "안녕Zx"),
            (0, "Z안녕x"),
            (9, "안녕xZ"),
        ] {
            app.input.set("안녕x");
            let (x, y) = cell(&app, col, 0);
            mouse(&mut app, down, x, y, now);
            mouse(&mut app, up, x, y, now);
            key(&mut app, KeyCode::Char('Z'));
            let expected = if col == 4 { "안녕Zx" } else { inserted };
            assert_eq!(app.input.text(), expected, "click on column {col}");
        }
    }

    #[test]
    fn a_click_finds_the_cell_on_a_wrapped_row() {
        let mut app = app();
        screen(&app, 60, 30);
        let room = app.composer.geo.get().room;
        let text: String = ('a'..='z').cycle().take(room * 2 + 3).collect();
        app.input.set(&text);
        screen(&app, 60, 30);
        let g = app.composer.geo.get();
        let rows = app.input.layout(room).0.len();
        assert_eq!(rows, 3);
        // the third row is on the bottom line of the box when it is not taller
        let line = (rows - 1 - g.first) as u16;
        let (x, y) = cell(&app, 1, line);
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            x,
            y,
            Instant::now(),
        );
        key(&mut app, KeyCode::Char('#'));
        let expected = format!("{}#{}", &text[..room * 2 + 1], &text[room * 2 + 1..]);
        assert_eq!(app.input.text(), expected);
    }

    #[test]
    fn dragging_selects_in_the_theme_colours_and_typing_replaces() {
        let mut app = app();
        type_text(&mut app, "hello world");
        screen(&app, 100, 30);
        let now = Instant::now();
        let (x0, y) = cell(&app, 0, 0);
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            x0,
            y,
            now,
        );
        mouse(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left),
            x0 + 5,
            y,
            now,
        );
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            x0 + 5,
            y,
            now,
        );
        assert_eq!(app.input.selected_text().as_deref(), Some("hello"));
        assert!(
            app.take_copy().is_none(),
            "the box does not auto-copy a drag"
        );
        let terminal = draw_to(&app, 100, 30);
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(x0 + 1, y)].bg, app.theme.brand);
        assert_eq!(buffer[(x0 + 1, y)].fg, app.theme.user_bg);
        assert_ne!(
            buffer[(x0 + 6, y)].bg,
            app.theme.brand,
            "the rest is not selected"
        );
        type_text(&mut app, "J");
        assert_eq!(app.input.text(), "J world");
    }

    #[test]
    fn a_drag_that_leaves_the_box_still_selects_to_its_edge() {
        let mut app = app();
        app.input.set("one\ntwo\nthree");
        screen(&app, 100, 30);
        let now = Instant::now();
        let (x, y) = cell(&app, 1, 0);
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y, now);
        mouse(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left),
            x + 30,
            y + 10,
            now,
        );
        assert_eq!(app.input.selected_text().as_deref(), Some("ne\ntwo\nthree"));
    }

    #[test]
    fn a_double_click_selects_a_word_and_a_slow_second_click_does_not() {
        let mut app = app();
        type_text(&mut app, "say foo_bar now");
        screen(&app, 100, 30);
        let (x, y) = cell(&app, 6, 0);
        let (down, up) = (
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        );
        let t0 = Instant::now();
        mouse(&mut app, down, x, y, t0);
        mouse(&mut app, up, x, y, t0);
        assert_eq!(app.input.selected_text(), None);
        mouse(&mut app, down, x, y, t0 + Duration::from_millis(200));
        mouse(&mut app, up, x, y, t0 + Duration::from_millis(210));
        assert_eq!(app.input.selected_text().as_deref(), Some("foo_bar"));
        // a third press starts over
        mouse(&mut app, down, x, y, t0 + Duration::from_millis(300));
        assert_eq!(app.input.selected_text(), None);
        mouse(&mut app, down, x, y, t0 + Duration::from_millis(2000));
        assert_eq!(
            app.input.selected_text(),
            None,
            "too slow to be a double click"
        );
    }

    #[test]
    fn a_press_outside_the_box_is_left_to_the_conversation() {
        let mut app = app();
        type_text(&mut app, "abc");
        screen(&app, 100, 30);
        let g = app.composer.geo.get();
        let down = MouseEventKind::Down(MouseButton::Left);
        app.input.mv(Move::Left, true);
        mouse(
            &mut app,
            down,
            g.inner.x + 3,
            g.inner.y.saturating_sub(5),
            Instant::now(),
        );
        assert!(app.input.selected_text().is_some(), "untouched");
        assert!(!mouse_taken(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left)
        ));
        assert!(!mouse_taken(
            &mut app,
            MouseEventKind::Up(MouseButton::Left)
        ));
    }

    fn mouse_taken(app: &mut App, kind: MouseEventKind) -> bool {
        let m = MouseEvent {
            kind,
            column: 3,
            row: 3,
            modifiers: KeyModifiers::NONE,
        };
        super::mouse(app, m, Instant::now())
    }

    // --- the keyboard ---

    #[test]
    fn shift_with_the_arrows_home_and_end_and_ctrl_a_select() {
        let mut app = app();
        app.mouse = false; // nothing here needs the mouse
        type_text(&mut app, "hello world");
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Left, SHIFT);
        assert_eq!(app.input.selected_text().as_deref(), Some("ld"));
        press(&mut app, KeyCode::Home, SHIFT);
        assert_eq!(app.input.selected_text().as_deref(), Some("hello world"));
        key(&mut app, KeyCode::Right);
        assert_eq!(app.input.selected_text(), None);
        assert_eq!(app.input.text(), "hello world");
        key(&mut app, KeyCode::Home);
        press(&mut app, KeyCode::End, SHIFT);
        assert_eq!(app.input.selected_text().as_deref(), Some("hello world"));
        key(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Char('a'), CTRL);
        assert_eq!(app.input.selected_text().as_deref(), Some("hello world"));
        key(&mut app, KeyCode::Backspace);
        assert!(app.input.is_empty());
        type_text(&mut app, "ab");
        press(&mut app, KeyCode::Char('a'), CTRL);
        key(&mut app, KeyCode::Delete);
        assert!(app.input.is_empty());
        assert!(!app.quit);
    }

    #[test]
    fn shift_enter_still_breaks_the_line_and_plain_enter_sends() {
        let mut app = app();
        type_text(&mut app, "a");
        press(&mut app, KeyCode::Enter, SHIFT);
        type_text(&mut app, "b");
        assert_eq!(app.input.text(), "a\nb");
        key(&mut app, KeyCode::Enter);
        assert!(app.input.is_empty());
        assert_eq!(app.log[0]["message"]["text"], "a\nb");
    }

    // --- the clipboard (never the real one) ---

    #[test]
    fn ctrl_c_copies_a_selection_and_quits_without_one() {
        let mut app = app();
        type_text(&mut app, "copy me");
        press(&mut app, KeyCode::Char('c'), CTRL);
        assert!(app.quit, "no selection: Ctrl-C is the quit key as it was");
        assert!(app.take_copy().is_none());
        app.quit = false;
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Char('c'), CTRL);
        assert!(!app.quit);
        let job = app.take_copy().expect("queued for the main loop");
        assert_eq!(job.text, "me");
        assert!(job.osc52.is_some());
        assert_eq!(app.input.text(), "copy me", "copying leaves the text");
        assert_eq!(app.input.selected_text().as_deref(), Some("me"));
    }

    #[test]
    fn ctrl_x_cuts_and_ctrl_v_asks_for_the_clipboard_and_replaces_the_selection() {
        let mut app = app();
        type_text(&mut app, "one two");
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Left, SHIFT);
        press(&mut app, KeyCode::Char('x'), CTRL);
        assert_eq!(app.take_copy().unwrap().text, "two");
        assert_eq!(app.input.text(), "one ");
        press(&mut app, KeyCode::Char('x'), CTRL);
        assert!(app.take_copy().is_none(), "nothing selected, nothing cut");
        // nothing is read until Ctrl-V, and then by the main loop, which answers with a message
        assert!(take_paste_request(&mut app).is_none());
        press(&mut app, KeyCode::Char('a'), CTRL);
        press(&mut app, KeyCode::Char('v'), CTRL);
        assert!(take_paste_request(&mut app).is_some());
        assert!(
            take_paste_request(&mut app).is_none(),
            "one request per press"
        );
        app.handle(Msg::Clip(Ok("from the clipboard".into())));
        assert_eq!(app.input.text(), "from the clipboard");
        app.handle(Msg::Clip(Err(Why::Missing)));
        assert!(app.notice.as_deref().unwrap().contains("clipboard"));
        assert_eq!(app.input.text(), "from the clipboard");
    }

    #[test]
    fn cmd_c_x_and_v_where_the_terminal_reports_super_do_the_same() {
        let mut app = app();
        type_text(&mut app, "abc def");
        press(&mut app, KeyCode::Char('a'), CMD);
        press(&mut app, KeyCode::Char('c'), CMD);
        assert_eq!(app.take_copy().unwrap().text, "abc def");
        assert!(!app.quit);
        press(&mut app, KeyCode::Char('x'), CMD);
        assert_eq!(app.take_copy().unwrap().text, "abc def");
        assert!(app.input.is_empty());
        press(&mut app, KeyCode::Char('v'), CMD);
        assert!(take_paste_request(&mut app).is_some());
        press(&mut app, KeyCode::Char('z'), CMD);
        assert!(app.input.is_empty(), "an unknown Cmd chord types nothing");
        press(&mut app, KeyCode::Char('c'), CMD);
        assert!(
            app.take_copy().is_none() && !app.quit,
            "Cmd-C with nothing selected does nothing"
        );
    }

    #[test]
    fn a_paste_from_the_terminal_replaces_the_selection_too() {
        let mut app = app();
        type_text(&mut app, "hello world");
        press(&mut app, KeyCode::Char('a'), CTRL);
        app.handle(Msg::Term(Event::Paste("bracketed".into())));
        assert_eq!(app.input.text(), "bracketed");
    }

    #[test]
    fn the_copy_keys_only_work_where_the_box_is_in_use() {
        let mut app = app();
        type_text(&mut app, "text");
        press(&mut app, KeyCode::Char('a'), CTRL);
        app.focus = Focus::List;
        press(&mut app, KeyCode::Char('c'), CTRL);
        assert!(
            app.quit,
            "with the thread list in front Ctrl-C quits as before"
        );
        assert!(app.take_copy().is_none());
    }

    // --- long pastes ---

    #[test]
    fn a_long_paste_shows_a_chip_and_is_sent_in_full_and_folded_in_the_transcript() {
        let mut app = app();
        let big = long(143);
        type_text(&mut app, "look: ");
        app.handle(Msg::Term(Event::Paste(big.clone())));
        let rows = screen(&app, 100, 30);
        let composer = row_of(&rows, "look: [Pasted 143 lines]");
        assert!(
            !rows.iter().any(|r| r.contains("line 100")),
            "the text is not in the box"
        );
        assert!(composer > 0);
        key(&mut app, KeyCode::Enter);
        assert_eq!(
            app.log[0]["message"]["text"],
            format!("look: {big}"),
            "the whole text is sent"
        );
        // history brings the chip back, not 143 lines
        key(&mut app, KeyCode::Up);
        assert!(
            screen(&app, 100, 30)
                .iter()
                .any(|r| r.contains("look: [Pasted 143 lines]"))
        );
        assert_eq!(app.input.text(), format!("look: {big}"));
        // the sent message, as the thread history gives it back
        app.active = crate::app::Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": {"title": "t",
            "modelSelection": {"instanceId": "codex", "model": "gpt"}, "messages": [
              {"id": "u", "role": "user", "text": format!("look: {big}"), "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}}));
        app.input.take(false);
        let rows = screen(&app, 100, 30);
        let folded = row_of(&rows, "… 143 lines pasted");
        assert!(
            rows[folded - 1].contains("look:"),
            "the first line stands above the count"
        );
        assert!(!rows.iter().any(|r| r.contains("line 77")));
        assert_eq!(
            app.conv.thread.messages[0].text,
            format!("look: {big}"),
            "what is stored is whole"
        );
    }

    #[test]
    fn copying_across_a_folded_message_gives_what_is_shown() {
        let mut app = app();
        app.active = crate::app::Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": {"title": "t",
            "modelSelection": {"instanceId": "codex", "model": "gpt"}, "messages": [
              {"id": "u", "role": "user", "text": long(50), "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}}));
        let rows = screen(&app, 100, 30);
        let y = row_of(&rows, "… 50 lines pasted") as u16;
        let first = row_of(&rows, "line 1") as u16;
        let x = rows[usize::from(y)]
            .find("…")
            .map(|b| width(&rows[usize::from(y)][..b]))
            .unwrap() as u16;
        let now = Instant::now();
        mouse(
            &mut app,
            MouseEventKind::Down(MouseButton::Left),
            x,
            first,
            now,
        );
        mouse(
            &mut app,
            MouseEventKind::Drag(MouseButton::Left),
            x + 30,
            y,
            now,
        );
        mouse(
            &mut app,
            MouseEventKind::Up(MouseButton::Left),
            x + 30,
            y,
            now,
        );
        assert_eq!(app.take_copy().unwrap().text, "line 1\n… 50 lines pasted");
    }
}
