//! `/goal`: set, show, clear a thread's goal, or change how many times the thread continues by
//! itself. Ported from `runGoalCommand`, `showGoal`, `saveGoal`, `clearGoal` of the former
//! TypeScript terminal and its goal module. The goal lives in the server's settings
//! (`threadGoals`, keyed by thread id); the server itself starts the continuing turns, judges them
//! and records `goal.*` activities, so this client only writes the goal and shows how it is going.

use crate::app::{Active, App};
use crate::crew_text::{text, text_with};
use crate::i18n::tr;
use crate::input::Input;
use crate::notes::Tone;
use crate::panels_common::flat;
use crate::screen::Screen;
use crate::server_settings::{self, Patched};
use crate::text::{iso_now, new_id, parse_iso_ms, sanitize};
use crate::thread::Thread;
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use serde_json::{Map, Value, json};

/// `GOAL_MAX_CONTINUES_RANGE`.
pub const MAX_RANGE: (u64, u64) = (1, 20);
/// `DEFAULT_THREAD_GOAL_MAX_CONTINUES`.
pub const DEFAULT_MAX: u64 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GoalState {
    Working,
    Met,
    Blocked,
    Stopped,
}

#[derive(Clone, PartialEq, Debug)]
pub struct GoalView {
    pub state: GoalState,
    /// Automatic continuations seen for this goal.
    pub continues: usize,
    /// The thread was loaded in a window that starts after the goal was set, so continuations from
    /// before it are not counted: `continues` is then "at least".
    pub partial: bool,
    pub reason: Option<String>,
}

pub fn state_word(state: GoalState) -> &'static str {
    text(match state {
        GoalState::Working => "session.goal.working",
        GoalState::Met => "session.goal.met",
        GoalState::Blocked => "session.goal.blocked",
        GoalState::Stopped => "session.goal.stopped",
    })
}

/// The goal as it is saved: new id (so earlier progress never counts), active, set now.
pub fn make_goal(words: &str, max: Option<u64>, id: &str, now: &str) -> Value {
    json!({
        "id": id, "text": words.trim(), "maxContinues": max.unwrap_or(DEFAULT_MAX),
        "active": true, "setAt": now,
    })
}

/// `goals` with this thread's goal set; every other thread's stays as it is.
pub fn goals_with(goals: &Value, thread_id: &str, goal: Value) -> Value {
    let mut all: Map<String, Value> = goals.as_object().cloned().unwrap_or_default();
    all.insert(thread_id.to_string(), goal);
    Value::Object(all)
}

/// `goals` without this thread's goal: stopping a goal removes its key.
pub fn goals_without(goals: &Value, thread_id: &str) -> Value {
    let mut all: Map<String, Value> = goals.as_object().cloned().unwrap_or_default();
    all.remove(thread_id);
    Value::Object(all)
}

/// The count in `/goal max <n>`: a whole number from 1 to 20, else `None`.
pub fn parse_max(word: &str) -> Option<u64> {
    if word.is_empty() || !word.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: u64 = word.parse().ok()?;
    (MAX_RANGE.0..=MAX_RANGE.1)
        .contains(&value)
        .then_some(value)
}

/// The earliest time the loaded part of the thread says anything about, in epoch milliseconds.
fn earliest_loaded(thread: &Thread) -> i64 {
    thread
        .messages
        .iter()
        .map(|m| &m.created_at)
        .chain(thread.activities.iter().map(|a| &a.created_at))
        .filter_map(|at| parse_iso_ms(at))
        .min()
        .unwrap_or(i64::MAX)
}

/// How the goal is going, from the activities the server appended for it
/// (`threadGoalProgress` in packages/shared/src/threadGoal.ts, `goalViewOf` in goal.ts).
pub fn view_of(goal: &Value, thread: &Thread, has_older: bool) -> GoalView {
    #[derive(PartialEq)]
    enum Progress {
        Working,
        Met,
        Blocked,
        Exhausted,
    }
    let mut status = Progress::Working;
    let (mut continues, mut reason) = (0usize, None);
    for activity in &thread.activities {
        let payload = &activity.payload;
        if !payload.is_object() || payload["goalId"] != goal["id"] || goal["id"].is_null() {
            continue;
        }
        match activity.kind.as_str() {
            "goal.continued" => continues += 1,
            "goal.met" => status = Progress::Met,
            "goal.blocked" => {
                status = Progress::Blocked;
                reason = payload["reason"].as_str().map(str::to_string);
            }
            "goal.exhausted" => status = Progress::Exhausted,
            _ => {}
        }
    }
    let set_at = goal["setAt"].as_str().and_then(parse_iso_ms).unwrap_or(0);
    let partial = has_older && earliest_loaded(thread) > set_at;
    let state = if goal["active"].as_bool() == Some(false) {
        GoalState::Stopped
    } else {
        match status {
            Progress::Working => GoalState::Working,
            Progress::Met => GoalState::Met,
            Progress::Blocked => GoalState::Blocked,
            Progress::Exhausted => GoalState::Stopped,
        }
    };
    GoalView {
        state,
        continues,
        partial,
        reason: if state == GoalState::Blocked {
            reason
        } else {
            None
        },
    }
}

/// The few words the status line keeps: `Goal 2/5`, `Goal 2+/5`, `Goal met`. No view is a thread
/// that is not loaded yet, whose progress is not known, so the count is a `?`.
pub fn bar_text(goal: &Value, view: Option<&GoalView>) -> String {
    let max = goal["maxContinues"].as_u64().unwrap_or(DEFAULT_MAX);
    match view {
        None => text_with("session.goal.barUnknown", &[("max", max.to_string())]),
        Some(view) if view.state == GoalState::Working => text_with(
            "session.goal.barCount",
            &[
                ("n", view.continues.to_string()),
                ("plus", if view.partial { "+" } else { "" }.into()),
                ("max", max.to_string()),
            ],
        ),
        Some(view) => text_with(
            "session.goal.barState",
            &[("state", state_word(view.state).to_string())],
        ),
    }
}

// ---- the goal of the thread on screen ---------------------------------------------------------

/// The id the goal of the screen is stored under: the open thread's, or the one a draft will have.
fn goal_key(app: &App) -> Option<String> {
    match &app.active {
        Active::Thread(id) => Some(id.clone()),
        Active::Draft(_) => app.draft_id.clone(),
        Active::None => None,
    }
}

pub fn goal_of(app: &App) -> Option<Value> {
    let goal = &app.config["settings"]["threadGoals"][goal_key(app)?];
    goal.is_object().then(|| goal.clone())
}

/// A draft has run nothing; a thread not loaded yet has no answer rather than a count of zero.
fn view_on_screen(app: &App, goal: &Value) -> Option<GoalView> {
    match &app.active {
        Active::Draft(_) => Some(GoalView {
            state: GoalState::Working,
            continues: 0,
            partial: false,
            reason: None,
        }),
        Active::Thread(id) if app.conv.loaded && app.conv.thread_id == *id => {
            Some(view_of(goal, &app.conv.thread, app.conv.has_more))
        }
        _ => None,
    }
}

/// The status line's goal segment, when the screen's thread has a goal.
pub fn goal_bar(app: &App) -> Option<String> {
    let goal = goal_of(app)?;
    Some(bar_text(&goal, view_on_screen(app, &goal).as_ref()))
}

/// The goal is active and the server would start another turn by itself when this one ends.
fn continues_by_itself(app: &App) -> bool {
    let Some(goal) = goal_of(app).filter(|g| g["active"].as_bool() != Some(false)) else {
        return false;
    };
    view_on_screen(app, &goal).is_none_or(|view| view.state == GoalState::Working)
}

/// Why a mode cannot be changed under a running turn: a goal that goes on by itself starts its own
/// turns from the mode stored on the thread, so a held pick would promise too much. `what_key` is
/// `session.c.whatPermission` or `session.c.whatWorkMode`.
pub fn mode_refusal(app: &App, what_key: &str) -> Option<String> {
    if !app.conv.busy() || !continues_by_itself(app) {
        return None;
    }
    Some(text_with(
        "session.c.goalHoldsMode",
        &[("what", text(what_key).to_string())],
    ))
}

/// A draft that was given a goal and then left unused: the goal goes with it, so it does not
/// stay in the settings for a thread that never existed.
pub fn drop_draft_goal(app: &mut App) {
    if !matches!(app.active, Active::Draft(_)) {
        return;
    }
    let Some(id) = app.draft_id.take() else {
        return;
    };
    if app.config["settings"]["threadGoals"][&id].is_null() {
        return;
    }
    server_settings::patch(
        app,
        move |current| {
            (!current["threadGoals"][&id].is_null())
                .then(|| json!({"threadGoals": goals_without(&current["threadGoals"], &id)}))
        },
        |_, _| {},
    );
}

// ---- the command ------------------------------------------------------------------------------

/// A step of the user's choice, left on the screen as a finished step.
fn record(app: &mut App, label: &str, value: &str) {
    app.note(Tone::Done, label, vec![value.to_string()]);
}

fn settings_failed(app: &mut App, failure_key: &str, message: &str) {
    let line = format!("{}: {message}", text(failure_key));
    app.say(Tone::Error, &line);
}

pub fn run(app: &mut App, argument: &str) {
    if matches!(app.active, Active::None) {
        app.notice = Some(tr("notice.pickFirst").into());
        return;
    }
    if crate::cmd_crew::crew_sub(app).is_some() {
        app.notice = Some(text("session.c.crewNoGoal").into());
        return;
    }
    let args: Vec<&str> = argument.split_whitespace().collect();
    if argument.is_empty() {
        show(app);
        return;
    }
    let first = args[0].to_lowercase();
    if first == "clear" && args.len() == 1 {
        clear(app);
        return;
    }
    if first == "max" && args.len() <= 2 {
        match args.get(1).and_then(|word| parse_max(word)) {
            Some(count) => save(app, None, Some(count)),
            None => {
                app.notice = Some(text_with(
                    "session.c.goalMaxUsage",
                    &[
                        ("min", MAX_RANGE.0.to_string()),
                        ("max", MAX_RANGE.1.to_string()),
                    ],
                ))
            }
        }
        return;
    }
    save(app, Some(argument.to_string()), None);
}

/// The goal as a note; with no goal, the question that asks for one.
fn show(app: &mut App) {
    let Some(goal) = goal_of(app) else {
        app.screen = Some(Box::new(GoalPrompt::default()));
        return;
    };
    let view = view_on_screen(app, &goal);
    let max = goal["maxContinues"].as_u64().unwrap_or(DEFAULT_MAX);
    let status = match &view {
        None => text("session.c.goalLoading").to_string(),
        Some(view) => text_with(
            "session.c.goalStatus",
            &[
                ("state", state_word(view.state).to_string()),
                ("continues", view.continues.to_string()),
                ("plus", if view.partial { "+" } else { "" }.into()),
                ("max", max.to_string()),
            ],
        ),
    };
    let mut body = vec![
        flat(goal["text"].as_str().unwrap_or_default()),
        String::new(),
        format!("{}  {status}", text("session.c.goalStatusLabel")),
    ];
    if let Some(reason) = view.as_ref().and_then(|v| v.reason.as_deref()) {
        body.push(format!(
            "{}  {}",
            text("session.c.goalReasonLabel"),
            flat(reason)
        ));
    }
    if view.as_ref().is_some_and(|v| v.partial) {
        body.push(text("session.c.goalPartial").to_string());
    }
    body.push(String::new());
    body.push(text("session.c.goalHelp").to_string());
    app.note(Tone::Info, text("session.c.goal"), body);
}

/// Saves the goal over the settings read just now. Every save is a new goal (a new id), so the
/// progress of an earlier one never counts for it. `words` `None` keeps the current words and
/// changes only how many times the thread continues. The thread need not exist yet: a goal can be
/// set on a new thread before its first message.
pub fn save(app: &mut App, words: Option<String>, max: Option<u64>) {
    let key = match goal_key(app) {
        Some(key) => key,
        None => {
            let id = new_id();
            app.draft_id = Some(id.clone());
            id
        }
    };
    let (id, now) = (new_id(), iso_now());
    let active = app.active.clone();
    let thread = key.clone();
    server_settings::patch(
        app,
        move |current| {
            let previous = &current["threadGoals"][&thread];
            let words = words
                .or_else(|| previous["text"].as_str().map(str::to_string))
                .filter(|w| !w.trim().is_empty())?;
            let max = max.or_else(|| previous["maxContinues"].as_u64());
            let goal = make_goal(&words, max, &id, &now);
            Some(json!({"threadGoals": goals_with(&current["threadGoals"], &thread, goal)}))
        },
        move |app, result| {
            if app.active != active {
                return;
            }
            match result {
                Err(message) => settings_failed(app, "session.c.goalSaveFailed", &message),
                Ok(Patched { changed: false, .. }) => {
                    app.notice = Some(text("session.c.noGoalSet").into())
                }
                Ok(Patched { after, .. }) => {
                    let goal = &after["threadGoals"][&key];
                    let line = text_with(
                        "session.c.goalRecorded",
                        &[
                            ("text", flat(goal["text"].as_str().unwrap_or_default())),
                            (
                                "max",
                                goal["maxContinues"]
                                    .as_u64()
                                    .unwrap_or(DEFAULT_MAX)
                                    .to_string(),
                            ),
                        ],
                    );
                    record(app, text("session.c.goal"), &line);
                }
            }
        },
    );
}

/// Stops the goal. What it said is shown, with the command that sets it again.
fn clear(app: &mut App) {
    let Some(key) = goal_key(app) else {
        app.notice = Some(text("session.c.noGoal").into());
        return;
    };
    let active = app.active.clone();
    let thread = key.clone();
    server_settings::patch(
        app,
        move |current| {
            (!current["threadGoals"][&thread].is_null())
                .then(|| json!({"threadGoals": goals_without(&current["threadGoals"], &thread)}))
        },
        move |app, result| {
            if app.active != active {
                return;
            }
            match result {
                Err(message) => settings_failed(app, "session.c.goalClearFailed", &message),
                Ok(Patched { changed: false, .. }) => {
                    app.notice = Some(text("session.c.noGoal").into())
                }
                Ok(Patched { before, .. }) => {
                    let cleared = &before["threadGoals"][&key];
                    if !cleared.is_object() {
                        return;
                    }
                    let words = flat(cleared["text"].as_str().unwrap_or_default());
                    let mut body = vec![
                        words.clone(),
                        text_with(
                            "session.c.toRestore",
                            &[("command", format!("/goal {words}"))],
                        ),
                    ];
                    let max = cleared["maxContinues"].as_u64().unwrap_or(DEFAULT_MAX);
                    if max != DEFAULT_MAX {
                        body.push(format!("/goal max {max}"));
                    }
                    app.note(Tone::Done, text("session.c.goalCleared"), body);
                }
            }
        },
    );
}

// ---- the question `/goal` asks when there is no goal -------------------------------------------

/// A one-question text field: Enter saves, Shift-Enter / Ctrl-J start a new line, Esc cancels.
#[derive(Default)]
pub struct GoalPrompt {
    input: Input,
}

impl Screen for GoalPrompt {
    fn draw(&self, frame: &mut Frame, area: Rect, app: &App) {
        let t = &app.theme;
        let width = area.width.min(72).max(24.min(area.width));
        let (rows, (cursor_x, cursor_y)) = self.input.layout(usize::from(width.saturating_sub(4)));
        let shown = rows.len().min(6) as u16;
        let height = (shown + 2).min(area.height);
        let rect = Rect::new(
            area.x + area.width.saturating_sub(width) / 2,
            area.y + area.height.saturating_sub(height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, rect);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::new().fg(t.brand))
            .title(format!(" {} ", text("session.c.goalPromptTitle")));
        let inner = block.inner(rect);
        frame.render_widget(block, rect);
        let lines: Vec<Line> = if self.input.text().is_empty() {
            vec![Line::from(Span::styled(
                text("session.c.goalPlaceholder"),
                t.dim_style().add_modifier(Modifier::ITALIC),
            ))]
        } else {
            // Keep the cursor's row in view.
            let skip = cursor_y.saturating_sub(usize::from(inner.height).saturating_sub(1));
            rows.into_iter()
                .skip(skip)
                .map(|row| Line::from(sanitize(&row)))
                .collect()
        };
        frame.render_widget(Paragraph::new(lines), inner);
        let visible_y = cursor_y.min(usize::from(inner.height).saturating_sub(1)) as u16;
        frame.set_cursor_position(Position::new(
            (inner.x + cursor_x as u16).min(inner.right().saturating_sub(1)),
            inner.y + visible_y,
        ));
    }

    fn key(&mut self, key: KeyEvent, app: &mut App) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Esc => return true,
            KeyCode::Enter if alt => self.input.newline(),
            KeyCode::Enter => {
                let words = self.input.text().trim().to_string();
                if words.is_empty() {
                    app.notice = Some(text("session.c.enterGoalText").into());
                    return false;
                }
                save(app, Some(words), None);
                return true;
            }
            KeyCode::Char('j') if ctrl => self.input.newline(),
            KeyCode::Char('u') if ctrl => self.input.kill_to_start(),
            KeyCode::Char('k') if ctrl => self.input.kill_to_end(),
            KeyCode::Char('w') if ctrl => self.input.kill_word(),
            KeyCode::Char('a') if ctrl => self.input.home(),
            KeyCode::Char('e') if ctrl => self.input.end(),
            KeyCode::Char('b') if ctrl => self.input.left(),
            KeyCode::Char('f') if ctrl => self.input.right(),
            KeyCode::Char(ch) if !ctrl => self.input.insert(ch),
            KeyCode::Backspace => self.input.backspace(),
            KeyCode::Delete => self.input.delete(),
            KeyCode::Left => self.input.left(),
            KeyCode::Right => self.input.right(),
            KeyCode::Home => self.input.home(),
            KeyCode::End => self.input.end(),
            _ => {}
        }
        false
    }

    fn hint(&self) -> String {
        text("session.c.goalHint").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::Note;
    use crate::server_settings::fake;
    use crate::thread::Activity;

    fn activity(kind: &str, payload: Value) -> Activity {
        Activity {
            kind: kind.into(),
            payload,
            created_at: "2026-01-01T00:10:00.000Z".into(),
            ..Default::default()
        }
    }

    fn thread_with(activities: Vec<Activity>) -> Thread {
        Thread {
            activities,
            ..Default::default()
        }
    }

    fn goal(id: &str) -> Value {
        json!({"id": id, "text": "ship it", "maxContinues": 5, "active": true, "setAt": "2026-01-01T00:00:00.000Z"})
    }

    #[test]
    fn max_takes_a_whole_number_from_one_to_twenty() {
        assert_eq!(parse_max("1"), Some(1));
        assert_eq!(parse_max("20"), Some(20));
        for bad in ["0", "21", "", "-3", "2.5", "x", "٣"] {
            assert_eq!(parse_max(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn goals_are_replaced_per_thread_and_a_new_one_is_a_new_goal() {
        let all = json!({"a": goal("g1"), "b": goal("g2")});
        let set = goals_with(&all, "a", make_goal("  new words ", Some(9), "g3", "now"));
        assert_eq!(set["a"]["text"], "new words");
        assert_eq!(set["a"]["maxContinues"], 9);
        assert_eq!(set["a"]["id"], "g3");
        assert_eq!(set["b"], goal("g2"), "another thread's goal stays");
        assert_eq!(
            make_goal("x", None, "i", "now")["maxContinues"],
            DEFAULT_MAX
        );
        let cleared = goals_without(&set, "a");
        assert!(cleared.get("a").is_none() && cleared["b"] == goal("g2"));
        assert_eq!(goals_with(&Value::Null, "a", goal("g1"))["a"]["id"], "g1");
    }

    #[test]
    fn progress_counts_only_the_activities_of_this_goal() {
        let thread = thread_with(vec![
            activity("goal.continued", json!({"goalId": "old"})),
            activity("goal.continued", json!({"goalId": "g1"})),
            activity("goal.continued", json!({"goalId": "g1"})),
        ]);
        let view = view_of(&goal("g1"), &thread, false);
        assert_eq!(
            (view.state, view.continues, view.partial),
            (GoalState::Working, 2, false)
        );
        assert_eq!(bar_text(&goal("g1"), Some(&view)), "Goal 2/5");
    }

    #[test]
    fn a_goal_ends_met_blocked_or_stopped() {
        let met = thread_with(vec![activity("goal.met", json!({"goalId": "g1"}))]);
        assert_eq!(view_of(&goal("g1"), &met, false).state, GoalState::Met);
        let blocked = thread_with(vec![activity(
            "goal.blocked",
            json!({"goalId": "g1", "reason": "needs a key"}),
        )]);
        let view = view_of(&goal("g1"), &blocked, false);
        assert_eq!(
            (view.state, view.reason.as_deref()),
            (GoalState::Blocked, Some("needs a key"))
        );
        let spent = thread_with(vec![activity("goal.exhausted", json!({"goalId": "g1"}))]);
        assert_eq!(
            view_of(&goal("g1"), &spent, false).state,
            GoalState::Stopped
        );
        let mut off = goal("g1");
        off["active"] = json!(false);
        assert_eq!(view_of(&off, &met, false).state, GoalState::Stopped);
    }

    #[test]
    fn a_window_that_starts_after_the_goal_was_set_counts_at_least() {
        let thread = thread_with(vec![activity("goal.continued", json!({"goalId": "g1"}))]);
        assert!(
            view_of(&goal("g1"), &thread, true).partial,
            "older turns are not loaded"
        );
        assert!(
            !view_of(&goal("g1"), &thread, false).partial,
            "the whole thread is loaded"
        );
        let view = view_of(&goal("g1"), &thread, true);
        assert_eq!(bar_text(&goal("g1"), Some(&view)), "Goal 1+/5");
        assert_eq!(
            bar_text(&goal("g1"), None),
            "Goal ?/5",
            "a thread not loaded yet has no count"
        );
    }

    fn texts(app: &App) -> Vec<String> {
        app.notes
            .iter()
            .map(|note| match note {
                Note::Text { title, body, .. } => format!("{title} {}", body.join(" | ")),
                Note::Rows { .. } => String::new(),
            })
            .collect()
    }

    async fn on_draft(
        fake: &fake::Fake,
    ) -> (App, tokio::sync::mpsc::UnboundedReceiver<crate::app::Msg>) {
        let (mut app, rx) = fake::connected(fake).await;
        app.active = Active::Draft("p1".into());
        (app, rx)
    }

    fn saved(app: &App) -> bool {
        goal_of(app).is_some()
    }

    #[tokio::test]
    async fn goal_text_is_saved_in_the_server_settings_and_shown_in_the_status_line() {
        let fake = fake::start(json!({"threadGoals": {"other": goal("g0")}})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "make the tests pass");
        fake::pump(&mut app, &mut rx, saved).await;
        let key = app
            .draft_id
            .clone()
            .expect("a draft gets its thread id now");
        let stored = fake.settings.lock().unwrap().clone();
        assert_eq!(stored["threadGoals"][&key]["text"], "make the tests pass");
        assert_eq!(stored["threadGoals"][&key]["maxContinues"], DEFAULT_MAX);
        assert_eq!(stored["threadGoals"][&key]["active"], true);
        assert_eq!(
            stored["threadGoals"]["other"],
            goal("g0"),
            "another thread's goal is kept"
        );
        assert_eq!(goal_bar(&app).as_deref(), Some("Goal 0/5"));
        assert!(
            texts(&app)
                .iter()
                .any(|t| t.contains("make the tests pass")),
            "{:?}",
            texts(&app)
        );
    }

    #[tokio::test]
    async fn max_changes_the_count_and_keeps_the_words_but_starts_a_new_goal() {
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "first");
        fake::pump(&mut app, &mut rx, saved).await;
        let first = goal_of(&app).unwrap();
        run(&mut app, "max 9");
        fake::pump(&mut app, &mut rx, |a| {
            goal_of(a).is_some_and(|g| g["maxContinues"] == 9)
        })
        .await;
        let second = goal_of(&app).unwrap();
        assert_eq!(second["text"], "first");
        assert_ne!(
            second["id"], first["id"],
            "earlier progress never counts for it"
        );
    }

    #[tokio::test]
    async fn two_quick_commands_do_not_overwrite_each_other() {
        let fake = fake::start(json!({"threadGoals": {"other": goal("g0")}})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "words");
        run(&mut app, "max 7");
        fake::pump(&mut app, &mut rx, |a| {
            goal_of(a).is_some_and(|g| g["maxContinues"] == 7)
        })
        .await;
        let stored = fake.settings.lock().unwrap().clone();
        let key = app.draft_id.clone().unwrap();
        assert_eq!(stored["threadGoals"][&key]["text"], "words");
        assert_eq!(stored["threadGoals"][&key]["maxContinues"], 7);
        assert_eq!(stored["threadGoals"]["other"], goal("g0"));
        assert_eq!(
            fake.called(crate::server_settings::UPDATE_SETTINGS).len(),
            2
        );
    }

    #[tokio::test]
    async fn clear_removes_the_goal_and_says_how_to_set_it_again() {
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "ship it");
        run(&mut app, "max 8");
        fake::pump(&mut app, &mut rx, |a| {
            goal_of(a).is_some_and(|g| g["maxContinues"] == 8)
        })
        .await;
        let key = app.draft_id.clone().unwrap();
        run(&mut app, "clear");
        fake::pump(&mut app, &mut rx, |a| goal_of(a).is_none()).await;
        assert!(
            fake.settings.lock().unwrap()["threadGoals"]
                .get(&key)
                .is_none()
        );
        let shown = texts(&app).join("\n");
        assert!(
            shown.contains("/goal ship it") && shown.contains("/goal max 8"),
            "{shown}"
        );
        assert_eq!(goal_bar(&app), None);
        // Nothing to clear now.
        let calls = fake.called(crate::server_settings::UPDATE_SETTINGS).len();
        run(&mut app, "clear");
        fake::pump(&mut app, &mut rx, |a| a.notice.is_some()).await;
        assert_eq!(
            fake.called(crate::server_settings::UPDATE_SETTINGS).len(),
            calls
        );
    }

    #[tokio::test]
    async fn a_bad_max_changes_nothing() {
        let fake = fake::start(json!({})).await;
        let (mut app, _rx) = on_draft(&fake).await;
        run(&mut app, "max 99");
        assert!(
            app.notice.as_deref().is_some_and(|n| n.contains("20")),
            "{:?}",
            app.notice
        );
        run(&mut app, "max");
        assert!(app.notice.is_some());
        assert!(
            app.draft_id.is_none() && fake.called(crate::server_settings::GET_SETTINGS).is_empty()
        );
    }

    #[tokio::test]
    async fn without_a_goal_the_command_asks_for_one_and_a_crew_task_is_refused() {
        let fake = fake::start(json!({})).await;
        let (mut app, _rx) = on_draft(&fake).await;
        run(&mut app, "");
        assert!(app.screen.is_some(), "a question asks for the goal");
        app.screen = None;
        app.active = Active::None;
        run(&mut app, "x");
        assert_eq!(
            app.notice.as_deref(),
            Some(crate::i18n::tr("notice.pickFirst"))
        );
        app.shell.threads.push(crate::state::ThreadShell {
            id: "sub".into(),
            title: "Crew Worker · fix".into(),
            parent_thread_id: Some("lead".into()),
            ..Default::default()
        });
        app.active = Active::Thread("sub".into());
        app.notice = None;
        run(&mut app, "x");
        assert_eq!(app.notice.as_deref(), Some(text("session.c.crewNoGoal")));
        assert!(
            fake.called(crate::server_settings::UPDATE_SETTINGS)
                .is_empty()
        );
    }

    #[tokio::test]
    async fn the_prompt_saves_what_was_typed_and_refuses_an_empty_answer() {
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        let mut prompt = GoalPrompt::default();
        let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        assert!(
            !prompt.key(enter, &mut app),
            "an empty answer keeps the question open"
        );
        assert!(app.notice.is_some());
        for ch in "do it".chars() {
            prompt.key(
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
                &mut app,
            );
        }
        assert!(prompt.key(enter, &mut app), "the question closes");
        fake::pump(&mut app, &mut rx, saved).await;
        assert_eq!(goal_of(&app).unwrap()["text"], "do it");
        assert!(
            GoalPrompt::default().key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), &mut app)
        );
    }

    #[tokio::test]
    async fn a_mode_cannot_change_under_a_goal_that_goes_on_by_itself() {
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        assert!(
            mode_refusal(&app, "session.c.whatWorkMode").is_none(),
            "no goal"
        );
        run(&mut app, "ship it");
        fake::pump(&mut app, &mut rx, saved).await;
        assert!(
            mode_refusal(&app, "session.c.whatWorkMode").is_none(),
            "nothing is running"
        );
        let key = "t1".to_string();
        app.config["settings"]["threadGoals"][&key] = goal("g1");
        app.active = Active::Thread(key.clone());
        app.conv = crate::state::Conversation::new(&key);
        app.conv.loaded = true;
        app.conv.thread.session = Some(crate::thread::Session {
            status: "running".into(),
            ..Default::default()
        });
        assert!(app.conv.busy());
        let refusal = mode_refusal(&app, "session.c.whatWorkMode").expect("held");
        assert!(
            refusal.contains(text("session.c.whatWorkMode")),
            "{refusal}"
        );
        app.conv
            .thread
            .activities
            .push(activity("goal.met", json!({"goalId": "g1"})));
        assert!(
            mode_refusal(&app, "session.c.whatWorkMode").is_none(),
            "a met goal goes on no more"
        );
    }

    #[tokio::test]
    async fn leaving_an_unused_draft_takes_its_goal_with_it() {
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "ship it");
        fake::pump(&mut app, &mut rx, saved).await;
        let key = app.draft_id.clone().unwrap();
        drop_draft_goal(&mut app);
        assert!(app.draft_id.is_none());
        fake::pump(&mut app, &mut rx, |a| {
            a.config["settings"]["threadGoals"].get(&key).is_none()
        })
        .await;
        assert!(
            fake.settings.lock().unwrap()["threadGoals"]
                .get(&key)
                .is_none()
        );
    }

    #[tokio::test]
    async fn the_status_line_shows_the_goal_at_its_right_edge() {
        use ratatui::Terminal;
        use ratatui::backend::TestBackend;
        let fake = fake::start(json!({})).await;
        let (mut app, mut rx) = on_draft(&fake).await;
        run(&mut app, "ship it");
        fake::pump(&mut app, &mut rx, saved).await;
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        terminal.draw(|f| crate::ui::draw(f, &app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let last: String = (0..100)
            .map(|x| buffer[(x, 29)].symbol().to_string())
            .collect();
        assert!(last.trim_end().ends_with("Goal 0/5"), "{last:?}");
    }
}
