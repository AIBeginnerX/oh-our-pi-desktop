//! The right-hand panel: the Workflow, Agents, Savvy or Files view of the thread on screen, drawn by
//! `workflow_panel` / `agents_panel` / `savvy_panel` / `files_panel` (each starts with its own tab bar). This builds their input
//! from the app and says whether the view is moving, so the clock redraws it only then.

use crate::agents_panel;
use crate::app::{Active, App, LinkStatus, Side};
use crate::files_panel;
use crate::flow::{CrewRoleModel, FlowInput, Waiting, model_label};
use crate::panels_common::View;
use crate::panels_common::{fill, s};
use crate::savvy_panel;
use crate::text::{iso_now, parse_iso_ms};
use crate::workflow_panel;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::{Block, Borders, Paragraph};

impl Side {
    pub fn view(self) -> View {
        match self {
            Side::Workflow => View::Workflow,
            Side::Agents => View::Agents,
            Side::Savvy => View::Savvy,
            Side::Files => View::Files,
        }
    }

    pub fn of(view: View) -> Side {
        match view {
            View::Workflow => Side::Workflow,
            View::Agents => Side::Agents,
            View::Savvy => Side::Savvy,
            View::Files => Side::Files,
        }
    }

    /// The tab after this one, round to the first.
    pub fn next(self) -> Side {
        let all = View::ALL;
        let at = all.iter().position(|v| *v == self.view()).unwrap_or(0);
        Side::of(all[(at + 1) % all.len()])
    }

    pub fn name(self) -> &'static str {
        self.view().title()
    }

    /// The slash command that shows (and, again, hides) this view.
    pub fn command(self) -> &'static str {
        match self {
            Side::Workflow => "/dag-workflow",
            Side::Agents => "/panel off",
            Side::Savvy => "/savvy",
            Side::Files => "/files",
        }
    }
}

/// Runs `f` on the panel input of the thread on screen: its latest work, nothing older.
fn with_input<R>(app: &App, f: impl FnOnce(&FlowInput) -> R) -> R {
    let current = app.current_model();
    let brain = current
        .as_ref()
        .and_then(|m| Some((m["instanceId"].as_str()?, m["model"].as_str()?)));
    let crew: Option<Vec<CrewRoleModel>> = crate::crew::roles_of(
        &app.config,
        app.own_crew().as_ref(),
        brain,
        app.active != Active::None,
    );
    let lead_model = current
        .as_ref()
        .and_then(|m| m["model"].as_str())
        .map(|model| model_label(model, app.effort_display().as_deref()));
    let lead_waiting = if app.approval().is_some() {
        Some(Waiting::Approval)
    } else if app.pending_input().is_some() {
        Some(Waiting::Input)
    } else {
        None
    };
    let pending = app.request_pending();
    let work = if pending {
        crate::work_scope::fresh_work(&app.conv.thread)
    } else {
        crate::work_scope::latest_work(&app.conv.thread)
    };
    let input = FlowInput {
        thread: &work.thread,
        lead_cost: work.lead_cost,
        children: &app.shell.threads,
        lead_model,
        crew: crew.as_deref(),
        lead_waiting,
        loading: matches!(app.active, Active::Thread(_)) && !app.conv.loaded,
        pending,
        now_ms: parse_iso_ms(&iso_now()).unwrap_or(0),
        tick: app.tick,
        animations: app.settings.animations,
        pinned: app.pinned_flow.clone(),
        online: app.link == LinkStatus::Online,
        scroll: Some(&app.panel_scroll),
    };
    f(&input)
}

// ---- `/dag-workflow`, `/savvy` and `/files` ----------------------------------------------------------

/// What the words after `/dag-workflow` ask for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlowAction {
    Toggle,
    On,
    Off,
    Live,
    Next,
    Prev,
    Pick(usize),
}

/// Reads the words after the command; `None` when they are not something it takes.
pub fn parse_flow_action(word: &str) -> Option<FlowAction> {
    let word = word.trim().to_lowercase();
    Some(match word.as_str() {
        "" => FlowAction::Toggle,
        "on" => FlowAction::On,
        "off" => FlowAction::Off,
        "live" => FlowAction::Live,
        "next" => FlowAction::Next,
        "prev" => FlowAction::Prev,
        digits if digits.len() <= 4 && digits.chars().all(|c| c.is_ascii_digit()) => {
            FlowAction::Pick(digits.parse().ok()?)
        }
        _ => return None,
    })
}

/// What happens to the layout when a view's command is run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PanelMove {
    Open,
    Switch,
    Close,
    Nothing,
}

/// Each command shows its own view. Closed, the panel opens; with the other view up it switches
/// without closing; the same command again closes it, and so does `off`. `off` for the view that
/// is not shown has nothing to turn off. `/dag-workflow` is the panel's own switch: bare or with
/// `off` it closes the panel whatever view is up.
pub fn plan_panel_move(view: Side, action: FlowAction, shown: Option<Side>) -> PanelMove {
    let is_switch = view == Side::Workflow && shown.is_some();
    if action == FlowAction::Off {
        return if shown == Some(view) || is_switch {
            PanelMove::Close
        } else {
            PanelMove::Nothing
        };
    }
    if action == FlowAction::Toggle && is_switch {
        return PanelMove::Close;
    }
    if shown == Some(view) {
        return if action == FlowAction::Toggle {
            PanelMove::Close
        } else {
            PanelMove::Nothing
        };
    }
    if shown.is_none() {
        PanelMove::Open
    } else {
        PanelMove::Switch
    }
}

/// Applies a pick, `next`, `prev` or `live` to the pinned flow; `Err` says why it cannot.
/// `ids` are the thread's flows, newest first.
pub fn choose_flow(
    ids: &[String],
    live: Option<usize>,
    pinned: &mut Option<String>,
    action: FlowAction,
) -> Result<(), String> {
    if action == FlowAction::Live {
        *pinned = None;
        return Ok(());
    }
    if !matches!(
        action,
        FlowAction::Pick(_) | FlowAction::Next | FlowAction::Prev
    ) {
        return Ok(());
    }
    if ids.is_empty() {
        return Err(s("There is no flow to pick.", "고를 흐름이 없습니다.").into());
    }
    let index = match action {
        FlowAction::Pick(number) => {
            if number < 1 || number > ids.len() {
                return Err(fill(
                    s(
                        "The flow number is 1 to {max}.",
                        "흐름 번호는 1~{max} 입니다.",
                    ),
                    &[("max", ids.len().to_string())],
                ));
            }
            number - 1
        }
        _ => {
            let now = pinned
                .as_deref()
                .and_then(|id| ids.iter().position(|i| i == id))
                .or(live)
                .unwrap_or(0);
            let count = ids.len();
            if action == FlowAction::Next {
                (now + 1) % count
            } else {
                (now + count - 1) % count
            }
        }
    };
    // Picking the flow that is being followed anyway keeps following it.
    *pinned = if Some(index) == live {
        None
    } else {
        Some(ids[index].clone())
    };
    Ok(())
}

/// The ids of the thread's flows (newest first) and which one the live focus is.
pub fn flow_ids(app: &App) -> (Vec<String>, Option<usize>) {
    with_input(app, |input| {
        let graphs = crate::flow::flows(input.thread, input.lead_model.as_deref());
        let live = crate::flow::focus_graph(&graphs);
        (graphs.into_iter().map(|g| g.id).collect(), live)
    })
}

/// Something in the view moves with the clock (a running agent), so it is redrawn on the tick.
pub fn is_live(app: &App) -> bool {
    if !app.side_shown() {
        return false;
    }
    with_input(app, |input| match app.side_view {
        Side::Workflow => workflow_panel::is_live(input),
        Side::Agents => agents_panel::is_live(input),
        Side::Savvy => savvy_panel::is_live(input),
        Side::Files => files_panel::is_live(input),
    })
}

pub fn draw(frame: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::new().fg(app.theme.border));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width < 8 || inner.height < 2 {
        return;
    }
    let lines = with_input(app, |input| {
        let (w, h) = (usize::from(inner.width), usize::from(inner.height));
        match app.side_view {
            Side::Workflow => workflow_panel::lines(input, w, h, &app.theme, &app.sym),
            Side::Agents => agents_panel::lines(input, w, h, &app.theme, &app.sym),
            Side::Savvy => savvy_panel::lines(input, w, h, &app.theme, &app.sym),
            Side::Files => files_panel::lines(input, w, h, &app.theme, &app.sym),
        }
    });
    frame.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("f{i}")).collect()
    }

    fn pane_text(app: &App, side: Side) -> String {
        crate::i18n::init(Some("en"));
        with_input(app, |input| {
            let (th, sym) = (&app.theme, &app.sym);
            let rows = match side {
                Side::Workflow => workflow_panel::lines(input, 48, 60, th, sym),
                Side::Agents => agents_panel::lines(input, 48, 60, th, sym),
                Side::Savvy => savvy_panel::lines(input, 48, 60, th, sym),
                Side::Files => files_panel::lines(input, 48, 60, th, sym),
            };
            crate::panels_common::plain(&rows).join("\n")
        })
    }

    fn app_with(thread: serde_json::Value) -> App {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
        app.link = LinkStatus::Online;
        app.active = Active::Thread("lead".into());
        app.conv = crate::state::Conversation::new("lead");
        app.conv.loaded = true;
        app.conv.thread = serde_json::from_value(thread).expect("thread");
        app
    }

    fn at(sec: i64) -> String {
        crate::panels_common::scenes::ts(sec)
    }

    fn tool_read(sec: i64, turn: &str, id: &str, path: &str) -> serde_json::Value {
        let detail = format!("Read: {{\"file_path\":\"{path}\"}}");
        serde_json::json!({
            "id": format!("a{sec}"), "tone": "info", "kind": "tool.completed", "summary": "Read",
            "payload": {"toolCallId": id, "status": "completed", "itemType": "dynamic_tool_call",
                        "detail": detail, "data": {"toolName": "Read"}},
            "turnId": turn, "createdAt": at(sec),
        })
    }

    fn crew_task(
        sec: i64,
        turn: &str,
        kind: &str,
        id: &str,
        title: &str,
        extra: serde_json::Value,
    ) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "taskId": id, "crewRole": "worker", "agentKind": "agent", "title": title,
            "threadId": format!("th-{id}"), "model": format!("model-{id}"),
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            payload[key] = value.clone();
        }
        serde_json::json!({
            "id": format!("a{sec}"), "tone": "info", "kind": kind, "summary": kind,
            "payload": payload, "turnId": turn, "createdAt": at(sec),
        })
    }

    fn user_message(sec: i64, text: &str) -> serde_json::Value {
        serde_json::json!({"id": format!("u{sec}"), "role": "user", "text": text, "createdAt": at(sec)})
    }

    /// Two pieces of work in one thread: the old one finished, the new one is running.
    fn two_works() -> serde_json::Value {
        serde_json::json!({
            "id": "lead", "projectId": "p1", "title": "Lead",
            "messages": [user_message(0, "first"), user_message(20, "second")],
            "activities": [
                tool_read(2, "t1", "r-old", "/p/old_file.rs"),
                crew_task(3, "t1", "task.started", "oldjob", "Old job title", serde_json::json!({})),
                crew_task(5, "t1", "task.completed", "oldjob", "Old job title", serde_json::json!({"status": "completed"})),
                tool_read(22, "t2", "r-new", "/p/new_file.rs"),
                crew_task(23, "t2", "task.started", "newjob", "New job title", serde_json::json!({})),
            ],
            "latestTurn": {"turnId": "t2", "state": "running", "requestedAt": at(20), "startedAt": at(21)},
            "session": {"status": "running", "activeTurnId": "t2"},
        })
    }

    #[test]
    fn panes_show_only_latest_work_in_all_four_views() {
        let app = app_with(two_works());
        let all = [Side::Workflow, Side::Agents, Side::Savvy, Side::Files];
        let text: Vec<String> = all.iter().map(|side| pane_text(&app, *side)).collect();
        assert!(text[0].contains("New job title"), "{}", text[0]);
        assert!(text[1].contains("New job title"), "{}", text[1]);
        assert!(text[2].contains("model-newjob"), "{}", text[2]);
        assert!(text[3].contains("new_file.rs"), "{}", text[3]);
        // The overall bar counts the one task of this work, not the finished one before it.
        let work = crate::work_scope::latest_work(&app.conv.thread);
        assert_eq!(
            savvy_panel::progress_of(&work.thread),
            Some(savvy_panel::Progress::Steps {
                done: 0,
                total: 1,
                basis: savvy_panel::Basis::Crew
            })
        );
        for (side, text) in all.iter().zip(&text) {
            assert!(!text.contains("Old job title"), "{side:?}: {text}");
            assert!(!text.contains("model-oldjob"), "{side:?}: {text}");
            assert!(!text.contains("old_file.rs"), "{side:?}: {text}");
        }
    }

    #[test]
    fn panes_show_only_latest_work_when_the_new_message_has_nothing_yet() {
        let mut thread = two_works();
        thread["messages"]
            .as_array_mut()
            .unwrap()
            .push(user_message(40, "third"));
        // The new message has started no turn: the old turn is over.
        thread["latestTurn"] = serde_json::json!({"turnId": "t2", "state": "completed",
            "requestedAt": at(20), "startedAt": at(21), "completedAt": at(30)});
        thread["session"] = serde_json::json!({"status": "ready"});
        let app = app_with(thread);
        let empty = [
            (Side::Workflow, "No work to draw yet"),
            (Side::Agents, "No agents yet"),
            (Side::Files, "No files yet"),
        ];
        for (side, words) in empty {
            let text = pane_text(&app, side);
            assert!(text.contains(words), "{side:?}: {text}");
        }
        let savvy = pane_text(&app, Side::Savvy);
        for gone in ["model-newjob", "model-oldjob", "Done"] {
            assert!(!savvy.contains(gone), "{gone}: {savvy}");
        }
    }

    #[test]
    fn a_new_request_starts_a_fresh_bar_until_its_message_returns() {
        let mut thread = two_works();
        thread["latestTurn"] = serde_json::json!({"turnId": "t2", "state": "completed",
            "requestedAt": at(20), "startedAt": at(21), "completedAt": at(30)});
        thread["session"] = serde_json::json!({"status": "ready"});
        let mut app = app_with(thread);
        assert!(!app.request_pending());
        assert!(pane_text(&app, Side::Savvy).contains("model-newjob"));
        app.sent = Some(("m-new".into(), 0));
        assert!(app.request_pending());
        let fresh = pane_text(&app, Side::Savvy);
        assert!(
            fresh.contains("no total") && !fresh.contains("model-newjob"),
            "{fresh}"
        );
        assert!(!fresh.contains("Idle · nothing"), "{fresh}");
        app.conv.thread.messages.push(
            serde_json::from_value(serde_json::json!({
                "id": "m-new", "role": "user", "text": "next", "createdAt": at(40)
            }))
            .unwrap(),
        );
        assert!(!app.request_pending(), "the message came back");
        assert!(!pane_text(&app, Side::Savvy).contains("model-newjob"));
    }

    fn done_work() -> serde_json::Value {
        let mut t = two_works();
        t["activities"].as_array_mut().unwrap().push(crew_task(
            30,
            "t2",
            "task.completed",
            "newjob",
            "New job title",
            serde_json::json!({"status": "completed"}),
        ));
        t["latestTurn"] = serde_json::json!({"turnId": "t2", "state": "completed",
            "requestedAt": at(20), "startedAt": at(21), "completedAt": at(35)});
        t["session"] = serde_json::json!({"status": "ready"});
        t
    }

    #[test]
    fn a_late_echo_does_not_bring_the_previous_full_bar_back() {
        let mut app = app_with(done_work());
        app.settings.animations = true;
        assert!(
            pane_text(&app, Side::Savvy).contains("1/1"),
            "idle end state"
        );
        app.sent = Some(("m-new".into(), 0));
        assert!(!pane_text(&app, Side::Savvy).contains("1/1"));
        // a reconnect: a minute of ticks and still no echo
        for _ in 0..240 {
            app.on_tick();
        }
        assert!(app.request_pending());
        let after = pane_text(&app, Side::Savvy);
        assert!(
            !after.contains("1/1") && after.contains("no total"),
            "{after}"
        );
    }

    #[tokio::test]
    async fn only_the_send_that_failed_gives_up_its_fresh_start() {
        let mut app = app_with(done_work());
        app.sent = Some(("m-new".into(), 0));
        let failed = |sent: Option<&str>| crate::app::Msg::Dispatched {
            result: Err("no".into()),
            open: None,
            answered: Some("r1".into()),
            sent: sent.map(str::to_string),
        };
        app.handle(failed(None));
        assert!(app.sent.is_some(), "an approval reply failing leaves it");
        app.handle(failed(Some("other")));
        assert!(app.sent.is_some());
        app.handle(failed(Some("m-new")));
        assert!(app.sent.is_none());
    }

    #[test]
    fn a_crew_follow_up_turn_keeps_the_full_bar() {
        let mut t = done_work();
        // the crew's follow-up turn (audit fixes, a late report), now over
        t["messages"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
            "id": "fu", "role": "user", "createdAt": at(40),
            "text": "<oop_crew_follow_up round=\"1\" fixes=\"1\">\nfix\n</oop_crew_follow_up>"}));
        t["latestTurn"] = serde_json::json!({"turnId": "t3", "state": "completed",
            "requestedAt": at(40), "startedAt": at(41), "completedAt": at(50)});
        let app = app_with(t);
        let work = crate::work_scope::latest_work(&app.conv.thread);
        assert_eq!(
            savvy_panel::progress_of(&work.thread),
            Some(savvy_panel::Progress::Steps {
                done: 1,
                total: 1,
                basis: savvy_panel::Basis::Crew
            })
        );
        assert!(!pane_text(&app, Side::Savvy).contains("Idle · nothing"));
    }

    #[test]
    fn the_composer_bar_stops_glowing_while_the_user_is_asked() {
        use ratatui::{Terminal, backend::TestBackend, layout::Rect};
        let mut thread = two_works();
        thread["activities"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "p", "tone": "info", "kind": "turn.plan.updated", "summary": "p",
            "payload": {"plan": [{"step": "a", "status": "completed"}, {"step": "b", "status": "inProgress"},
                                  {"step": "c", "status": "pending"}]},
            "turnId": "t2", "createdAt": at(24),
        }));
        let mut app = app_with(thread);
        app.settings.animations = true;
        let frame = |app: &mut App, tick: usize| {
            app.tick = tick;
            let mut term = Terminal::new(TestBackend::new(80, 3)).unwrap();
            term.draw(|f| savvy_panel::draw_input_bar(f, Rect::new(0, 0, 80, 3), app))
                .unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|c| (c.symbol().to_string(), c.fg))
                .collect::<Vec<_>>()
        };
        assert_ne!(
            frame(&mut app, 0),
            frame(&mut app, 4),
            "it glows while work runs"
        );
        app.conv.thread.activities.push(
            serde_json::from_value(serde_json::json!({
                "id": "ap", "tone": "approval", "kind": "approval.requested", "summary": "s",
                "payload": {"requestId": "r1", "requestKind": "command", "detail": "ls"},
                "turnId": "t2", "createdAt": at(25),
            }))
            .unwrap(),
        );
        assert!(app.approval().is_some());
        assert_eq!(frame(&mut app, 0), frame(&mut app, 4), "waiting: still");
    }

    #[test]
    fn panes_show_only_latest_work_for_a_subagent_still_running_from_before() {
        let mut thread = two_works();
        // A provider subagent begun in the old work and still going when the new message arrives.
        thread["activities"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "a4", "tone": "info", "kind": "task.started", "summary": "task.started",
                "payload": {"taskId": "helper", "agentKind": "agent", "title": "Old helper title"},
                "turnId": "t1", "createdAt": at(4),
            }));
        let app = app_with(thread);
        let agents = pane_text(&app, Side::Agents);
        assert!(agents.contains("Old helper title"), "{agents}");
        assert!(agents.contains("New job title"), "{agents}");
        assert!(!agents.contains("Old job title"), "{agents}");
        let files = pane_text(&app, Side::Files);
        assert!(!files.contains("old_file.rs"), "{files}");
    }

    #[test]
    fn the_words_after_the_command_are_read() {
        assert_eq!(parse_flow_action(""), Some(FlowAction::Toggle));
        assert_eq!(parse_flow_action(" OFF "), Some(FlowAction::Off));
        assert_eq!(parse_flow_action("12"), Some(FlowAction::Pick(12)));
        assert_eq!(parse_flow_action("next"), Some(FlowAction::Next));
        assert_eq!(parse_flow_action("live"), Some(FlowAction::Live));
        assert_eq!(parse_flow_action("12345"), None);
        assert_eq!(parse_flow_action("next 2"), None);
        assert_eq!(parse_flow_action("-1"), None);
    }

    #[test]
    fn each_command_opens_switches_or_closes() {
        use FlowAction::*;
        use PanelMove::*;
        let (w, a, v) = (Side::Workflow, Side::Agents, Side::Savvy);
        assert_eq!(plan_panel_move(w, Toggle, None), Open);
        assert_eq!(plan_panel_move(w, Toggle, Some(w)), Close);
        // `/dag-workflow` turns the panel off whatever view is up; `on` still switches to it.
        assert_eq!(plan_panel_move(w, Toggle, Some(a)), Close);
        assert_eq!(plan_panel_move(w, Off, Some(a)), Close);
        assert_eq!(plan_panel_move(w, On, Some(a)), Switch);
        assert_eq!(plan_panel_move(w, Off, Some(w)), Close);
        assert_eq!(plan_panel_move(w, Pick(2), Some(w)), Nothing);
        assert_eq!(plan_panel_move(w, Pick(2), Some(a)), Switch);
        // The other views keep their own commands: they switch, and `off` is only theirs.
        assert_eq!(plan_panel_move(v, Toggle, Some(w)), Switch);
        assert_eq!(plan_panel_move(v, Off, Some(w)), Nothing);
        assert_eq!(plan_panel_move(v, Toggle, Some(v)), Close);
    }

    #[test]
    fn picking_walks_the_flows_and_following_the_live_one_unpins() {
        let list = ids(3);
        let mut pinned = None;
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Pick(2)).is_ok());
        assert_eq!(pinned.as_deref(), Some("f2"));
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Next).is_ok());
        assert_eq!(pinned.as_deref(), Some("f3"));
        // past the last it wraps to the first, which is the live one: following again
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Next).is_ok());
        assert_eq!(pinned, None);
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Prev).is_ok());
        assert_eq!(pinned.as_deref(), Some("f3"));
        assert!(choose_flow(&list, Some(0), &mut pinned, FlowAction::Live).is_ok());
        assert_eq!(pinned, None);
    }

    #[test]
    fn a_pick_out_of_range_or_with_no_flows_says_why() {
        crate::i18n::init(Some("en"));
        let mut pinned = Some("f1".to_string());
        let error = choose_flow(&ids(2), None, &mut pinned, FlowAction::Pick(3)).unwrap_err();
        assert_eq!(error, "The flow number is 1 to 2.");
        let error = choose_flow(&[], None, &mut pinned, FlowAction::Next).unwrap_err();
        assert_eq!(error, "There is no flow to pick.");
        assert_eq!(
            pinned.as_deref(),
            Some("f1"),
            "a refused pick changes nothing"
        );
    }
}
