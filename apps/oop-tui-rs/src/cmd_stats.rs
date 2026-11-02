//! `/stats` (a screen of tool-call statistics) and `/tasks` (the thread's task list under the
//! conversation). Ports `handleStatsKey`, `runTasksCommand` and `onSplitClosed` of the TypeScript
//! controller; the numbers and the rows are in `stats_view.rs` and `tasks_pane.rs`.

use crate::app::{Active, App};
use crate::panels_common::{Ctx, fill, s};
use crate::screen::Screen;
use crate::stats_view::{self, Input};
use crate::thread::Activity;
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::widgets::{Clear, Paragraph};
use std::cell::{Cell, RefCell};

/// The activities of the thread on screen; none for a draft or a thread still being read.
fn activities_of(app: &App) -> &[Activity] {
    match &app.active {
        Active::Thread(id) if app.conv.thread_id == *id && app.conv.loaded => {
            &app.conv.thread.activities
        }
        _ => &[],
    }
}

/// The `/stats` screen: which tab is up and which tool is picked on the tool tab, by name.
struct StatsScreen {
    tab: usize,
    selected: RefCell<Option<String>>,
    /// Wheel notches not yet applied: the tool list is known only when drawing.
    wheel: Cell<i32>,
}

impl StatsScreen {
    fn step(&self, activities: &[Activity], by: i32) {
        let names = stats_view::tool_names(activities);
        if names.is_empty() {
            return;
        }
        let current = self.selected.borrow().clone();
        let at = names
            .iter()
            .position(|name| Some(name) == current.as_ref())
            .unwrap_or(0) as i64;
        let next = (at + i64::from(by)).clamp(0, names.len() as i64 - 1) as usize;
        *self.selected.borrow_mut() = names.get(next).cloned();
    }
}

impl Screen for StatsScreen {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App) {
        let activities = activities_of(app);
        let pending = self.wheel.take();
        if pending != 0 && self.tab == 2 {
            self.step(activities, pending);
        }
        let ctx = Ctx::new(&app.theme, &app.sym, app.tick, app.settings.animations);
        let selected = self.selected.borrow();
        let lines = stats_view::render(
            &Input {
                activities,
                has_older: app.conv.has_more && matches!(app.active, Active::Thread(_)),
                tab: self.tab,
                selected: selected.as_deref(),
                width: usize::from(area.width),
                rows: usize::from(area.height),
            },
            &ctx,
        );
        frame.render_widget(Clear, area);
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool {
        let activities = activities_of(app);
        match key.code {
            KeyCode::Esc => return true,
            KeyCode::Char('q') if !key.modifiers.contains(KeyModifiers::CONTROL) => return true,
            KeyCode::Char(c @ '1'..='3') => self.tab = usize::from(c as u8 - b'1'),
            KeyCode::Left => self.tab = self.tab.saturating_sub(1),
            KeyCode::Right => self.tab = (self.tab + 1).min(2),
            KeyCode::Up => self.step(activities, -1),
            KeyCode::Down => self.step(activities, 1),
            _ => {}
        }
        false
    }

    fn wheel(&mut self, up: bool) {
        self.wheel.set(self.wheel.get() + if up { -1 } else { 1 });
    }

    fn hint(&self) -> String {
        stats_view::hint().to_string()
    }
}

/// `/stats`: opens the screen on the overview.
pub fn stats(app: &mut App) {
    app.screen = Some(Box::new(StatsScreen {
        tab: 0,
        selected: RefCell::new(None),
        wheel: Cell::new(0),
    }));
}

/// `/tasks [on|off]`: shows or hides the thread's task list under the conversation.
pub fn tasks(app: &mut App, argument: &str) {
    let words: Vec<String> = argument.split_whitespace().map(str::to_lowercase).collect();
    let word = words.first().map(String::as_str);
    if words.len() > 1 || word.is_some_and(|w| w != "on" && w != "off") {
        app.notice = Some(s("Usage: /tasks [on|off]", "사용법: /tasks [on|off]").to_string());
        return;
    }
    let wanted = word.map_or(!app.tasks_on, |w| w == "on");
    if wanted == app.tasks_on {
        app.notice = Some(
            if wanted {
                s(
                    "The task list is already open.",
                    "작업 목록이 이미 열려 있습니다.",
                )
            } else {
                s(
                    "The task list is not open.",
                    "작업 목록이 열려 있지 않습니다.",
                )
            }
            .to_string(),
        );
        return;
    }
    if wanted {
        let (columns, rows) = app.term_size.get();
        if let Some(why) = crate::tasks_pane::unavailable(columns, rows) {
            app.notice = Some(why);
            return;
        }
    }
    app.tasks_on = wanted;
}

/// The terminal changed size: a task list that no longer fits is closed with the reason, as the
/// TypeScript terminal's split region does (`onSplitClosed`).
pub fn on_resize(app: &mut App, columns: u16, rows: u16) {
    app.term_size.set((columns, rows));
    if app.tasks_on
        && let Some(why) = crate::tasks_pane::unavailable(columns, rows)
    {
        app.tasks_on = false;
        app.notice = Some(fill(
            s(
                "Task list closed: {reason}",
                "작업 목록을 닫았습니다: {reason}",
            ),
            &[("reason", why)],
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{LinkStatus, Msg};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{Event, KeyEventKind, KeyEventState};
    use serde_json::json;
    use tokio::sync::mpsc::unbounded_channel;

    fn press(app: &mut App, code: KeyCode) {
        app.handle(Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })));
    }

    fn type_line(app: &mut App, text: &str) {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
        press(app, KeyCode::Enter);
    }

    /// An app with thread t1 open and loaded with tool activity and a task list.
    fn app() -> App {
        crate::i18n::init(Some("en"));
        let (tx, _rx) = unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
        app.link = LinkStatus::Online;
        app.active = Active::Thread("t1".into());
        app.conv = crate::state::Conversation::new("t1");
        let tool = |id: &str, title: &str, status: &str| {
            json!({"id": id, "tone": "tool", "kind": "tool.completed", "summary": title,
                "payload": {"title": title, "status": status}, "turnId": "u1",
                "sequence": 1, "createdAt": "2026-01-01T09:00:00.000Z"})
        };
        app.handle(Msg::Thread {
            id: "t1".into(),
            item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 5, "page": {"hasMore": true, "beforeCursor": "c"}, "thread": {
                "id": "t1", "title": "T", "runtimeMode": "full-access", "interactionMode": "default",
                "latestTurn": {"turnId": "u1", "state": "running", "requestedAt": "2026-01-01T09:00:00.000Z"},
                "activities": [
                    tool("a", "Read", "completed"), tool("b", "Read", "completed"), tool("c", "Bash", "failed"),
                    {"id": "p", "tone": "info", "kind": "turn.plan.updated", "summary": "plan", "turnId": "u1",
                     "sequence": 2, "createdAt": "2026-01-01T09:01:00.000Z",
                     "payload": {"plan": [{"step": "read", "status": "completed"}, {"step": "write", "status": "inProgress"}]}}
                ], "messages": []}}}),
        });
        app
    }

    fn screen_text(app: &App, columns: u16, rows: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(columns, rows)).unwrap();
        terminal.draw(|frame| crate::ui::draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..rows)
            .map(|y| {
                (0..columns)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect()
    }

    #[tokio::test]
    async fn stats_opens_a_screen_that_takes_the_keys_until_q() {
        let mut app = app();
        app.focus = crate::app::Focus::Composer;
        type_line(&mut app, "/stats");
        assert!(app.screen.is_some());
        assert_eq!(
            app.input.text(),
            "",
            "the command was taken from the composer"
        );
        let rows = screen_text(&app, 100, 30);
        assert!(
            rows.iter()
                .any(|r| r.contains("[1] Overview") && r.contains("q:close")),
            "{rows:?}"
        );
        assert!(
            rows.iter().any(|r| r.contains("Calls 3")
                && r.contains("Failure rate 33%")
                && r.contains("Recent activity only")),
            "{rows:?}"
        );
        press(&mut app, KeyCode::Char('3'));
        let rows = screen_text(&app, 100, 30);
        assert!(rows.iter().any(|r| r.contains("▶ Read (2)")), "{rows:?}");
        press(&mut app, KeyCode::Down);
        let rows = screen_text(&app, 100, 30);
        assert!(
            rows.iter().any(|r| r.contains("▶ Bash (1)"))
                && rows.iter().any(|r| r.contains("Last failure")),
            "{rows:?}"
        );
        // the arrows past the ends stay on the last tool; Left/Right move the tabs
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Left);
        assert!(
            screen_text(&app, 100, 30)
                .iter()
                .any(|r| r.contains("Busiest hours"))
        );
        press(&mut app, KeyCode::Right);
        assert!(app.screen.is_some());
        // a letter other than q goes nowhere, not into the composer
        press(&mut app, KeyCode::Char('x'));
        assert_eq!(app.input.text(), "");
        press(&mut app, KeyCode::Char('q'));
        assert!(app.screen.is_none());
        type_line(&mut app, "/stats");
        press(&mut app, KeyCode::Esc);
        assert!(app.screen.is_none());
    }

    #[tokio::test]
    async fn the_wheel_moves_the_pick_on_the_tool_tab() {
        let mut app = app();
        stats(&mut app);
        press(&mut app, KeyCode::Char('3'));
        app.screen.as_mut().unwrap().wheel(false);
        let rows = screen_text(&app, 100, 30);
        assert!(rows.iter().any(|r| r.contains("▶ Bash (1)")), "{rows:?}");
        app.screen.as_mut().unwrap().wheel(true);
        let rows = screen_text(&app, 100, 30);
        assert!(rows.iter().any(|r| r.contains("▶ Read (2)")), "{rows:?}");
    }

    #[tokio::test]
    async fn tasks_toggles_the_list_and_says_why_it_cannot() {
        let mut app = app();
        app.focus = crate::app::Focus::Composer;
        // the size is learned from the first drawing
        let rows = screen_text(&app, 100, 30);
        assert!(!rows.iter().any(|r| r.contains("Tasks 1/2")));
        type_line(&mut app, "/tasks on extra");
        assert_eq!(app.notice.as_deref(), Some("Usage: /tasks [on|off]"));
        type_line(&mut app, "/tasks off");
        assert_eq!(app.notice.as_deref(), Some("The task list is not open."));
        app.input.take(true);
        type_line(&mut app, "/tasks");
        assert!(app.tasks_on);
        let rows = screen_text(&app, 100, 30);
        assert!(rows.iter().any(|r| r.contains("Tasks 1/2")), "{rows:?}");
        assert!(
            rows.iter().any(|r| r.contains("☑ read")) && rows.iter().any(|r| r.contains("◐ write")),
            "{rows:?}"
        );
        // it sits under the conversation, above the composer
        let tasks_at = rows.iter().position(|r| r.contains("Tasks 1/2")).unwrap();
        let composer_at = rows.iter().position(|r| r.contains("Message")).unwrap();
        assert!(tasks_at < composer_at);
        type_line(&mut app, "/tasks on");
        assert_eq!(
            app.notice.as_deref(),
            Some("The task list is already open.")
        );
        type_line(&mut app, "/tasks off");
        assert!(!app.tasks_on);
    }

    #[tokio::test]
    async fn a_terminal_too_small_refuses_the_list_and_closes_an_open_one() {
        let mut app = app();
        app.focus = crate::app::Focus::Composer;
        screen_text(&app, 100, 12);
        type_line(&mut app, "/tasks on");
        assert!(!app.tasks_on);
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .contains("shorter than 16 rows"),
            "{:?}",
            app.notice
        );
        screen_text(&app, 100, 30);
        app.input.take(true);
        type_line(&mut app, "/tasks on");
        assert!(app.tasks_on);
        app.handle(Msg::Term(Event::Resize(30, 30)));
        assert!(!app.tasks_on);
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .starts_with("Task list closed: Terminal is narrower than 40 columns"),
            "{:?}",
            app.notice
        );
    }

    #[tokio::test]
    async fn without_a_loaded_thread_the_list_says_loading_or_empty() {
        let mut app = app();
        app.conv = crate::state::Conversation::new("t1");
        assert_eq!(
            crate::tasks_pane::content_of(&app),
            crate::tasks_pane::Content::Loading
        );
        app.active = Active::Draft("p1".into());
        assert_eq!(
            crate::tasks_pane::content_of(&app),
            crate::tasks_pane::Content::Empty
        );
    }
}
