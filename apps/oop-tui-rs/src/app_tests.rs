use super::*;
use crate::thread::Role;
use ratatui::crossterm::event::{KeyEventState, MouseEvent};
use tokio::sync::mpsc::unbounded_channel;

pub fn key_with(code: KeyCode, modifiers: KeyModifiers) -> Msg {
    Msg::Term(Event::Key(KeyEvent {
        code,
        modifiers,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    }))
}

pub fn key(code: KeyCode) -> Msg {
    key_with(code, KeyModifiers::NONE)
}

fn type_text(app: &mut App, text: &str) {
    for ch in text.chars() {
        app.handle(key(KeyCode::Char(ch)));
    }
}

pub fn no_last_model(app: &mut App) {
    app.last_model_path = std::env::temp_dir().join(format!(
        "oop-rs-none-{}/last-model.json",
        std::process::id()
    ));
}

pub fn app_with_project() -> App {
    let (tx, _rx) = unbounded_channel();
    let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
    no_last_model(&mut app);
    app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
        "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
        "threads": [{"id": "t1", "projectId": "p1", "title": "안녕 스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
    app
}

fn config() -> Value {
    json!({"threadSnapshotPagination": true, "providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true,
        "models": [
          {"slug": "gpt-5", "name": "GPT-5", "isDefault": true, "capabilities": {"optionDescriptors": [{"id": "reasoningEffort", "type": "select", "options": [{"id": "low", "label": "Low"}, {"id": "high", "label": "High", "isDefault": true}]}]}},
          {"slug": "gpt-5-mini", "name": "GPT-5 mini"}]}]})
}

fn ids(app: &App) -> Vec<String> {
    app.rows()
        .into_iter()
        .map(|r| match r {
            Row::AddFolder => "add".into(),
            Row::Item(Nav::New { .. }) => "new".into(),
            Row::Item(Nav::Thread(t)) => t.id,
            Row::Item(other) => format!("{other:?}"),
        })
        .collect()
}

fn thread_event(app: &mut App, sequence: u64, kind: &str, payload: Value) {
    app.handle(Msg::Thread {
        id: "t1".into(),
        item: json!({"kind": "event", "event": {"sequence": sequence, "type": kind, "occurredAt": "2026-01-01T00:00:00.000Z", "payload": payload}}),
    });
}

/// An app with thread t1 open, loaded with a finished conversation.
fn open_thread() -> App {
    let mut app = app_with_project();
    app.link = LinkStatus::Online;
    app.config = config();
    app.handle(key(KeyCode::Tab));
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    app.handle(Msg::Thread {
        id: "t1".into(),
        item: json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 5, "page": {"hasMore": true, "beforeCursor": "c1"}, "thread": {
            "id": "t1", "title": "안녕 스레드", "runtimeMode": "approval-required", "interactionMode": "default",
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"}, "messages": [
            {"id": "u1", "role": "user", "text": "hi", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}}),
    });
    app
}

#[tokio::test]
async fn the_working_folder_project_opens_a_draft_and_lists_its_threads() {
    let app = app_with_project();
    assert_eq!(app.active, Active::Draft("p1".into()));
    assert_eq!(app.focus, Focus::Composer);
    assert_eq!(ids(&app), vec!["new", "t1"]);
}

#[tokio::test]
async fn a_folder_that_is_not_a_project_offers_to_add_it() {
    let (tx, _rx) = unbounded_channel();
    let mut app = App::new("0.0.0", "/tmp/oop-rs/elsewhere", "/tmp", tx);
    app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1, "projects": [], "threads": []}})));
    assert_eq!(ids(&app), vec!["add", "new"]);
    assert_eq!(app.active, Active::None);
    app.handle(key(KeyCode::Tab));
    app.focus = Focus::List;
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.log[0]["type"], "project.create");
}

#[tokio::test]
async fn sending_without_a_provider_says_so_instead_of_dispatching() {
    let mut app = app_with_project();
    type_text(&mut app, "hello");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.notice.as_deref(), Some(tr("notice.noProvider")));
    assert_eq!(
        app.input.text(),
        "hello",
        "the text stays so it can be sent after fixing the cause"
    );
    assert!(app.log.is_empty());
}

#[tokio::test]
async fn the_first_message_starts_a_thread_on_the_default_model_and_is_remembered() {
    let mut app = app_with_project();
    app.config = config();
    type_text(&mut app, "build it");
    app.handle(key(KeyCode::Enter));
    let command = &app.log[0];
    assert_eq!(command["type"], "thread.turn.start");
    assert_eq!(
        command["modelSelection"],
        json!({"instanceId": "codex", "model": "gpt-5"})
    );
    assert_eq!(command["bootstrap"]["createThread"]["projectId"], "p1");
    assert!(app.input.is_empty());
    app.handle(key(KeyCode::Up));
    assert_eq!(app.input.text(), "build it", "Up recalls what was sent");
}

#[tokio::test]
async fn the_composer_edits_wide_characters_and_several_lines() {
    let mut app = app_with_project();
    type_text(&mut app, "안녕x");
    app.handle(key(KeyCode::Left));
    app.handle(key(KeyCode::Backspace));
    assert_eq!(app.input.text(), "안x");
    app.handle(key(KeyCode::End));
    app.handle(key_with(KeyCode::Char('j'), KeyModifiers::CONTROL));
    type_text(&mut app, "둘째");
    app.handle(key_with(KeyCode::Enter, KeyModifiers::ALT));
    assert_eq!(app.input.text(), "안x\n둘째\n");
    app.handle(Msg::Term(Event::Paste("a\r\nb".into())));
    assert_eq!(app.input.text(), "안x\n둘째\na\nb");
}

#[tokio::test]
async fn tab_moves_between_list_and_composer_and_enter_opens_a_thread() {
    let mut app = app_with_project();
    app.handle(key(KeyCode::Tab));
    assert_eq!(app.focus, Focus::List);
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.active, Active::Thread("t1".into()));
    assert_eq!(app.focus, Focus::Composer);
}

#[tokio::test]
async fn slash_exit_quits_and_unknown_commands_keep_the_text() {
    let mut app = app_with_project();
    type_text(&mut app, "/foo");
    app.handle(key(KeyCode::Enter));
    assert!(!app.quit && app.notice.is_some());
    assert_eq!(app.input.text(), "/foo");
    app.input.take(false);
    type_text(&mut app, "/exit");
    app.handle(key(KeyCode::Enter));
    assert!(app.quit);
}

/// 0.0.142 answered `/provider` with "set OOP_TS_ENTRY" when the terminal was started without the
/// TypeScript terminal (OOP Terminal.app starts `oop-rs` directly). Typed and sent with Enter, it
/// must now become a request for the main loop whatever the environment says, with no notice, the
/// composer emptied, and the session's server and home carried along.
#[tokio::test]
async fn typing_slash_provider_queues_the_request_without_any_typescript_entry() {
    use crate::provider_args::ProviderRequest;
    let mut app = app_with_project();
    app.provider_server = Some("http://127.0.0.1:3873".into());
    app.provider_home = Some("/tmp/oop-home".into());
    for (typed, wanted) in [
        ("/provider", ProviderRequest::List),
        ("/provider list", ProviderRequest::List),
    ] {
        type_text(&mut app, typed);
        app.handle(key(KeyCode::Enter));
        assert!(app.notice.is_none(), "{typed}: {:?}", app.notice);
        assert!(app.input.text().is_empty(), "{typed} stays in the composer");
        let (request, server, home) =
            crate::cmd_provider::take_request(&mut app).expect("a request is pending");
        assert_eq!(request, wanted, "{typed}");
        assert_eq!(server.as_deref(), Some("http://127.0.0.1:3873"));
        assert_eq!(home.as_deref(), Some("/tmp/oop-home"));
    }
    type_text(&mut app, "/provider remove demo --dry-run");
    app.handle(key(KeyCode::Enter));
    assert!(matches!(
        crate::cmd_provider::take_request(&mut app),
        Some((ProviderRequest::Remove { id: Some(id), .. }, _, _)) if id == "demo"
    ));
    type_text(&mut app, "/provider add");
    app.handle(key(KeyCode::Enter));
    assert!(matches!(
        crate::cmd_provider::take_request(&mut app),
        Some((ProviderRequest::Add { target: None, .. }, _, _))
    ));
}

#[tokio::test]
async fn a_path_is_a_message_not_a_command() {
    let mut app = app_with_project();
    app.config = config();
    type_text(&mut app, "/Users/x/file.rs is broken");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.log[0]["type"], "thread.turn.start");
}

fn run_state(app: &mut App, sequence: u64, status: &str) {
    thread_event(
        app,
        sequence,
        "thread.session-set",
        json!({"session": {"status": status, "activeTurnId": "turn-9", "updatedAt": "x"}}),
    );
}

#[tokio::test]
async fn the_bell_rings_when_a_turn_ends_unless_the_user_stopped_it_or_notify_is_off() {
    let mut app = open_thread();
    run_state(&mut app, 6, "running");
    assert!(!app.bell_pending, "a turn starting is not a call");
    run_state(&mut app, 7, "ready");
    assert!(app.bell_pending);

    app.bell_pending = false;
    run_state(&mut app, 8, "running");
    app.handle(key(KeyCode::Esc));
    run_state(&mut app, 9, "ready");
    assert!(!app.bell_pending, "the user stopped this turn");

    run_state(&mut app, 10, "running");
    app.settings.notify = false;
    run_state(&mut app, 11, "ready");
    assert!(!app.bell_pending, "notify is off");
}

#[cfg(unix)]
#[tokio::test]
async fn ctrl_z_asks_to_stop_the_process_and_types_nothing() {
    let mut app = open_thread();
    app.handle(key_with(KeyCode::Char('z'), KeyModifiers::CONTROL));
    assert!(app.suspend_requested);
    assert_eq!(app.input.text(), "");
}

#[tokio::test]
async fn esc_stops_a_running_turn_and_enter_queues_until_it_ends() {
    let mut app = open_thread();
    thread_event(
        &mut app,
        6,
        "thread.session-set",
        json!({"session": {"status": "running", "activeTurnId": "turn-9", "updatedAt": "x"}}),
    );
    assert!(app.conv.busy());
    app.handle(key(KeyCode::Esc));
    assert_eq!(app.log.last().unwrap()["type"], "thread.turn.interrupt");
    assert_eq!(app.log.last().unwrap()["turnId"], "turn-9");
    assert_eq!(app.focus, Focus::Composer);

    type_text(&mut app, "next one");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.queue.len(), 1);
    assert_eq!(app.log.len(), 1, "nothing is sent while the turn runs");
    thread_event(
        &mut app,
        7,
        "thread.session-set",
        json!({"session": {"status": "ready", "updatedAt": "y"}}),
    );
    assert!(app.queue.is_empty());
    let sent = app.log.last().unwrap();
    assert_eq!(
        (sent["type"].as_str(), sent["message"]["text"].as_str()),
        (Some("thread.turn.start"), Some("next one"))
    );
    assert_eq!(
        sent["runtimeMode"], "approval-required",
        "an open thread keeps its own mode"
    );
}

#[tokio::test]
async fn an_approval_takes_the_keys_and_answers_once() {
    let mut app = open_thread();
    thread_event(
        &mut app,
        6,
        "thread.activity-appended",
        json!({"activity": {"id": "a", "tone": "approval", "kind": "approval.requested", "summary": "s",
        "payload": {"requestId": "r1", "requestKind": "command", "detail": "rm -rf build"}, "createdAt": "2026-01-01T00:00:02.000Z"}}),
    );
    assert_eq!(app.state_key(), "state.waiting");
    type_text(&mut app, "x");
    assert!(
        app.input.is_empty(),
        "typing does not leak into the composer"
    );
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    let command = app.log.last().unwrap();
    assert_eq!(command["type"], "thread.approval.respond");
    assert_eq!(
        (command["requestId"].as_str(), command["decision"].as_str()),
        (Some("r1"), Some("acceptForSession"))
    );
    // No server in this test: the answer cannot go out, so the panel stays for a retry.
    assert_eq!(app.notice.as_deref(), Some(tr("notice.offline")));
    assert!(app.approval().is_some());
    // Once an answer is on its way the panel is gone, so a second Enter cannot repeat it.
    app.answered.insert("r1".into());
    assert!(app.approval().is_none());
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.log.len(), 1, "a second Enter does not answer again");
}

#[tokio::test]
async fn a_question_collects_its_answers_and_sends_them_together() {
    let mut app = open_thread();
    thread_event(
        &mut app,
        6,
        "thread.activity-appended",
        json!({"activity": {"id": "q", "tone": "info", "kind": "user-input.requested", "summary": "s",
        "payload": {"requestId": "r2", "questions": [
            {"id": "color", "header": "C", "question": "Which?", "options": [{"label": "red", "description": ""}, {"label": "blue", "description": ""}]},
            {"id": "tags", "header": "T", "question": "Tags?", "multiSelect": true, "options": [{"label": "a", "description": ""}, {"label": "b", "description": ""}]}]},
        "createdAt": "2026-01-01T00:00:02.000Z"}}),
    );
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    assert!(app.log.is_empty(), "the second question is still open");
    app.handle(key(KeyCode::Char(' ')));
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Char(' ')));
    app.handle(key(KeyCode::Enter));
    let command = app.log.last().unwrap();
    assert_eq!(command["type"], "thread.user-input.respond");
    assert_eq!(
        command["answers"],
        json!({"color": "blue", "tags": ["a", "b"]})
    );
}

#[tokio::test]
async fn model_mode_and_effort_pickers_change_the_next_turn() {
    let mut app = open_thread();
    let path =
        std::env::temp_dir().join(format!("oop-rs-app-{}/last-model.json", std::process::id()));
    app.last_model_path = path.clone();
    type_text(&mut app, "/model mini");
    app.handle(key(KeyCode::Enter));
    assert_eq!(
        app.model_display(),
        "codex/gpt-5-mini",
        "one match is picked outright"
    );
    assert_eq!(
        settings::read_last_model(&path).unwrap()["model"],
        "gpt-5-mini"
    );
    type_text(&mut app, "/model");
    app.handle(key(KeyCode::Enter));
    assert!(matches!(app.modal, Some(Modal::Models { .. })));
    app.handle(key(KeyCode::Esc));
    type_text(&mut app, "/mode full");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.log.last().unwrap()["runtimeMode"], "full-access");
    app.handle(key(KeyCode::Char('x')));
    app.input.take(false);
    app.model_override = None;
    type_text(&mut app, "/effort low");
    app.handle(key(KeyCode::Enter));
    type_text(&mut app, "go");
    app.handle(key(KeyCode::Enter));
    let sent = app.log.last().unwrap();
    assert_eq!(
        sent["modelSelection"]["options"],
        json!([{"id": "reasoningEffort", "value": "low"}])
    );
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(path.parent().unwrap());
}

fn project_event(app: &mut App, id: &str, root: &str) {
    app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2,
        "projects": [
            {"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"},
            {"id": id, "title": id, "workspaceRoot": root}],
        "threads": [{"id": "t1", "projectId": "p1", "title": "안녕 스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
}

/// The text of the open folder list's rows, or none.
fn folder_rows(app: &App) -> Vec<String> {
    match &app.modal {
        Some(Modal::Pick(pick)) if pick.id == crate::folder::ID => pick.items.clone(),
        _ => Vec::new(),
    }
}

#[tokio::test]
async fn a_half_typed_message_stays_with_its_thread_through_every_switch() {
    let mut app = app_with_project();
    app.config = config();
    assert_eq!(app.active, Active::Draft("p1".into()));
    // The draft of the working folder holds a long paste and a typed word.
    app.input.paste(&"line\n".repeat(30));
    type_text(&mut app, "idea");
    let draft_text = app.input.text();
    app.open_thread("t1");
    assert!(
        app.input.is_empty(),
        "another thread does not inherit the box"
    );
    type_text(&mut app, "for t1");
    app.input.mv(crate::input::Move::Left, true);
    assert_eq!(app.input.selected_text().as_deref(), Some("1"));
    // Back to the draft: its own text, chip and all, the cursor at its end.
    app.start_draft("p1");
    assert_eq!(app.input.text(), draft_text);
    assert!(app.input.text().starts_with("line\n"));
    assert!(!app.input.has_selection());
    // And to t1 again: the text, the cursor and the selection are as they were left.
    app.open_thread("t1");
    assert_eq!(app.input.text(), "for t1");
    assert_eq!(app.input.selected_text().as_deref(), Some("1"));
    assert_eq!(app.input.cursor(), 5);
    // Sending clears only the thread it was sent in.
    app.start_draft("p1");
    app.input.take(false);
    type_text(&mut app, "send me");
    app.handle(key(KeyCode::Enter));
    assert!(app.input.is_empty());
    app.open_thread("t1");
    assert_eq!(app.input.text(), "for t1", "t1 keeps its own draft");
    app.start_draft("p1");
    assert!(
        app.input.is_empty(),
        "the draft was sent, nothing is left to return to"
    );
    // Switching away from an emptied box leaves no draft behind.
    app.open_thread("t1");
    app.input.take(false);
    app.start_draft("p1");
    app.open_thread("t1");
    assert!(app.input.is_empty());
}

#[tokio::test]
async fn side_pane_state_follows_thread_and_never_carries_its_data() {
    let mut app = open_thread();
    app.conv.thread.activities.push(
        serde_json::from_value(json!({
            "id": "a1", "tone": "info", "kind": "tool.completed", "summary": "Read",
            "payload": {"toolCallId": "r1", "status": "completed", "data": {"toolName": "Read"}},
            "turnId": "x1", "createdAt": "2026-01-01T00:00:02.000Z",
        }))
        .unwrap(),
    );
    assert!(!side::flow_ids(&app).0.is_empty(), "t1 has a flow to pick");
    app.side_view = Side::Files;
    app.pinned_flow = Some("flow-a".into());
    app.panel_scroll.set(7);

    // Another thread: its own pin and scroll, none of t1's flows, the view that is up.
    app.open_thread("t2");
    assert!(
        side::flow_ids(&app).0.is_empty(),
        "nothing of t1 carries over"
    );
    assert_eq!(
        (
            app.side_view,
            app.pinned_flow.clone(),
            app.panel_scroll.get()
        ),
        (Side::Files, None, 0)
    );
    app.side_view = Side::Savvy;
    app.panel_scroll.set(3);

    // A draft is a place of its own too.
    app.start_draft("p1");
    assert_eq!((app.pinned_flow.clone(), app.panel_scroll.get()), (None, 0));
    app.side_view = Side::Agents;

    app.open_thread("t1");
    assert_eq!(
        (
            app.side_view,
            app.pinned_flow.clone(),
            app.panel_scroll.get()
        ),
        (Side::Files, Some("flow-a".to_string()), 7),
        "t1 comes back as it was left"
    );
    app.open_thread("t2");
    assert_eq!(
        (
            app.side_view,
            app.pinned_flow.clone(),
            app.panel_scroll.get()
        ),
        (Side::Savvy, None, 3)
    );
    app.start_draft("p1");
    assert_eq!(app.side_view, Side::Agents);

    // A deleted thread takes its setting with it.
    app.open_thread("t2");
    app.panel_scroll.set(9);
    app.handle(Msg::Thread {
        id: "t2".into(),
        item: json!({"kind": "event", "event": {"sequence": 9, "type": "thread.deleted", "occurredAt": "2026-01-01T00:00:00.000Z", "payload": {}}}),
    });
    assert_eq!(app.active, Active::None);
    app.open_thread("t2");
    assert_eq!(app.panel_scroll.get(), 0);
}

#[tokio::test]
async fn the_draft_follows_a_server_driven_switch_a_close_and_a_delete() {
    let mut app = open_thread();
    assert_eq!(app.active, Active::Thread("t1".into()));
    type_text(&mut app, "keep me");
    // A thread that cannot be opened (`ThreadEnd` before it loaded) lets the box go, and it
    // comes back with the thread.
    app.switch_to(Active::None);
    assert!(app.input.is_empty());
    app.open_thread("t1");
    assert_eq!(app.input.text(), "keep me");
    // A deleted thread takes its draft with it.
    app.handle(Msg::Thread {
        id: "t1".into(),
        item: json!({"kind": "event", "event": {"sequence": 9, "type": "thread.deleted", "occurredAt": "2026-01-01T00:00:00.000Z", "payload": {}}}),
    });
    assert_eq!(app.active, Active::None);
    assert!(app.input.is_empty());
    app.open_thread("t1");
    assert!(
        app.input.is_empty(),
        "nothing is left of the deleted thread's draft"
    );
    // What is typed before any thread is open follows into the first one that opens.
    app.active = Active::None;
    type_text(&mut app, "/help");
    app.open_thread("t1");
    assert_eq!(app.input.text(), "/help");
}

#[tokio::test]
async fn typing_after_a_send_carries_over_when_the_draft_becomes_its_thread() {
    let mut app = app_with_project();
    app.config = config();
    type_text(&mut app, "go");
    app.handle(key(KeyCode::Enter));
    type_text(&mut app, "next");
    app.handle(Msg::Dispatched {
        result: Ok(()),
        open: Some("new-thread".into()),
        answered: None,
        sent: None,
    });
    assert_eq!(app.active, Active::Thread("new-thread".into()));
    assert_eq!(app.input.text(), "next");
    app.start_draft("p1");
    assert!(app.input.is_empty());
}

#[tokio::test]
async fn every_way_to_a_new_thread_asks_for_the_folder_first() {
    let mut app = open_thread();
    project_event(&mut app, "p2", "/tmp/oop-rs/work/other");
    assert_eq!(app.active, Active::Thread("t1".into()));
    // The row of the list.
    app.handle(key(KeyCode::Tab));
    app.handle(key(KeyCode::Up));
    app.handle(key(KeyCode::Enter));
    let rows = folder_rows(&app);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!(rows[0].starts_with("demo") && rows[0].contains(s("current", "현재")));
    assert!(rows[1].starts_with("p2") && !rows[1].contains(s("current", "현재")));
    assert_eq!(
        app.active,
        Active::Thread("t1".into()),
        "nothing started yet"
    );
    // Esc leaves everything as it was.
    let (before_active, before_selected) = (app.active.clone(), app.selected);
    app.handle(key(KeyCode::Esc));
    assert!(app.modal.is_none());
    assert_eq!(
        (app.active.clone(), app.selected),
        (before_active, before_selected)
    );
    assert!(app.log.is_empty());
    // The key `n` in the list, with a thread under the pointer, leads with that thread's project.
    app.focus = Focus::List;
    app.selected = ids(&app).iter().position(|i| i == "t1").unwrap();
    app.handle(key(KeyCode::Char('n')));
    assert!(folder_rows(&app)[0].starts_with("demo"));
    app.handle(key(KeyCode::Esc));
    // The slash command.
    app.focus = Focus::Composer;
    type_text(&mut app, "/new");
    app.handle(key(KeyCode::Enter));
    assert!(!folder_rows(&app).is_empty());
    assert_eq!(app.active, Active::Thread("t1".into()));
    // Choosing a project starts the draft in it, with that folder as its working folder.
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    assert!(app.modal.is_none());
    assert_eq!(app.active, Active::Draft("p2".into()));
    assert_eq!(app.workdir(), "/tmp/oop-rs/work/other");
    assert_eq!(app.focus, Focus::Composer);
}

#[tokio::test]
async fn with_one_project_enter_is_instant_and_another_folder_can_be_typed() {
    let mut app = open_thread();
    app.handle(key(KeyCode::Tab));
    app.handle(key(KeyCode::Up));
    app.handle(key(KeyCode::Enter));
    assert_eq!(
        folder_rows(&app).len(),
        2,
        "the project and the way to another folder"
    );
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.active, Active::Draft("p1".into()));
    // Enter on "another folder" with no path typed waits; a typed one adds the project.
    app.new_thread();
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Enter));
    assert!(app.modal.is_some(), "still open, there is no path yet");
    let dir = std::env::temp_dir().join(format!("oop-rs-folder-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    type_text(&mut app, &dir.to_string_lossy());
    assert!(folder_rows(&app)[1].contains(dir.to_string_lossy().as_ref()));
    app.handle(key(KeyCode::Enter));
    assert!(app.modal.is_none());
    let create = app.log.last().expect("the server is asked to add it");
    assert_eq!(create["type"], "project.create");
    assert_eq!(create["workspaceRoot"], json!(dir.to_string_lossy()));
    // Once the project shows up in the list, the draft opens in it.
    let id = app.adding.clone().unwrap();
    project_event(&mut app, &id, &dir.to_string_lossy());
    assert_eq!(app.active, Active::Draft(id));
    // A path that is no folder is said, and nothing is created.
    app.new_thread();
    app.handle(key(KeyCode::Down));
    type_text(&mut app, "/no/such/folder/here");
    let sent = app.log.len();
    app.handle(key(KeyCode::Enter));
    assert!(
        app.notice
            .as_deref()
            .unwrap()
            .contains("/no/such/folder/here")
    );
    assert_eq!(app.log.len(), sent);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn plan_mode_is_sent_with_the_next_turn_of_a_draft() {
    let mut app = app_with_project();
    app.config = config();
    type_text(&mut app, "/plan");
    app.handle(key(KeyCode::Enter));
    type_text(&mut app, "design it");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.log[0]["interactionMode"], "plan");
}

#[tokio::test]
async fn scrolling_up_to_the_top_asks_for_older_turns_once() {
    let mut app = open_thread();
    app.scroll_max.set(5);
    app.scroll_up(3);
    assert_eq!(app.scroll.get(), 3);
    assert!(!app.conv.loading_older);
    // No server is connected in this test, so the request is only recorded as not possible.
    app.origin = Some("http://127.0.0.1:1".into());
    app.bearer = Some("b".into());
    app.scroll_up(3);
    assert!(app.conv.loading_older, "the top was reached");
    app.scroll_up(3);
    app.handle(Msg::Older {
        id: "t1".into(),
        result: Ok(json!({"snapshotSequence": 4, "page": {"hasMore": false, "beforeCursor": null}, "thread": {"messages": [
            {"id": "u0", "role": "user", "text": "earlier", "streaming": false, "createdAt": "2026-01-01T00:00:00.000Z"}]}})),
    });
    assert_eq!(app.conv.thread.messages[0].id, "u0");
    assert!(!app.conv.has_more && !app.conv.loading_older);
    app.handle(Msg::Term(Event::Mouse(MouseEvent {
        kind: MouseEventKind::ScrollDown,
        column: 0,
        row: 0,
        modifiers: KeyModifiers::NONE,
    })));
    assert_eq!(app.scroll.get(), 6, "the wheel moves three lines");
}

#[tokio::test]
async fn the_list_skips_headers_and_toggles_shelves() {
    let mut app = app_with_project();
    app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 2, "thread": {"id": "t2", "projectId": "p1", "title": "old", "settledOverride": "settled", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
    app.handle(key(KeyCode::Tab));
    app.handle(key(KeyCode::Down));
    app.handle(key(KeyCode::Down));
    assert!(matches!(
        app.rows()[app.selected],
        Row::Item(Nav::Shelf { .. })
    ));
    app.handle(key(KeyCode::Enter));
    assert!(app.view.settled_open);
    assert!(ids(&app).contains(&"t2".to_string()));
}

/// The whole path of a streamed reply with a fake server standing in for the provider: the
/// server sends a thread snapshot and then deltas, each only after the previous chunk is
/// acknowledged (as the real one does). The assistant text must grow chunk by chunk and the
/// final screen must show it, with the user's message right-aligned above it.
#[tokio::test]
async fn a_streamed_reply_grows_on_screen_chunk_by_chunk() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let chunk = |id: &Value, item: Value| {
            Message::text(json!({"_tag": "Chunk", "requestId": id, "values": [item]}).to_string())
        };
        let message = |seq: u64, text: &str, streaming: bool| {
            json!({"kind": "event", "event": {"sequence": seq, "type": "thread.message-sent", "payload": {
                "messageId": "a1", "role": "assistant", "text": text, "streaming": streaming, "createdAt": "2026-01-01T00:00:02.000Z"}}})
        };
        let mut queue = vec![
            message(4, "안", true),
            message(5, "녕", true),
            message(6, "하세요", true),
            message(7, "안녕하세요", false),
        ];
        queue.reverse();
        let mut thread_request = Value::Null;
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let m: Value = serde_json::from_str(text.as_str()).unwrap();
            match m["_tag"].as_str() {
                Some("Request") if m["tag"] == SHELL_RPC => {
                    let snapshot = json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
                        "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs/work/demo"}],
                        "threads": [{"id": "t1", "projectId": "p1", "title": "stream", "updatedAt": "z"}]}});
                    ws.send(chunk(&m["id"], snapshot)).await.unwrap();
                }
                Some("Request") if m["tag"] == THREAD_RPC => {
                    thread_request = m["id"].clone();
                    let snapshot = json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 3, "thread": {"title": "stream",
                        "messages": [{"id": "u1", "role": "user", "text": "안녕?", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"}]}}});
                    ws.send(chunk(&thread_request, snapshot)).await.unwrap();
                }
                Some("Ack") if m["requestId"] == thread_request => {
                    if let Some(next) = queue.pop() {
                        ws.send(chunk(&thread_request, next)).await.unwrap();
                    }
                }
                _ => {}
            }
        }
    });

    let (tx, mut rx) = unbounded_channel();
    let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
    no_last_model(&mut app);
    let rpc = Rpc::connect(&format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    app.handle(Msg::Connected {
        rpc,
        config: json!({}),
        server: "fake".into(),
        origin: String::new(),
        bearer: String::new(),
        label: String::new(),
        remote: None,
    });
    let mut next = async |app: &mut App| {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("a message in time")
            .unwrap();
        app.handle(msg);
    };
    while !app.shell.loaded {
        next(&mut app).await;
    }
    // Tab to the list, down to the thread, Enter: open it.
    for code in [KeyCode::Tab, KeyCode::Down, KeyCode::Enter] {
        app.handle(key(code));
    }
    let mut seen = Vec::new();
    loop {
        next(&mut app).await;
        if let Some(m) = app.conv.thread.messages.last()
            && m.role == Role::Assistant
        {
            if seen.last() != Some(&m.text) {
                seen.push(m.text.clone());
            }
            if !m.streaming && m.text == "안녕하세요" {
                break;
            }
        }
    }
    assert_eq!(
        seen,
        vec!["안", "안녕", "안녕하세요"],
        "the reply grew a chunk at a time, then settled"
    );
    assert!(!app.conv.busy());
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| crate::ui::draw(f, &app)).unwrap();
    // A wide character's second cell is blank in the buffer, so compare without spaces.
    let text: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();
    let text = text.replace(' ', "");
    assert!(text.contains("안녕하세요") && text.contains("안녕?"));
}

#[tokio::test]
async fn a_picked_mode_shows_at_once_and_yields_to_the_server_value() {
    let mut app = open_thread();
    assert_eq!(app.runtime_mode(), "approval-required");
    app.set_runtime_mode("auto");
    assert_eq!(
        app.runtime_mode(),
        "auto",
        "shown before the server echoes it"
    );
    assert_eq!(app.log.last().unwrap()["type"], "thread.runtime-mode.set");
    thread_event(
        &mut app,
        9,
        "thread.runtime-mode-set",
        json!({"runtimeMode": "auto", "updatedAt": "2026-01-01T00:00:09.000Z"}),
    );
    assert!(app.runtime_intent.is_none(), "the server caught up");
    assert_eq!(app.runtime_mode(), "auto");
    app.set_interaction_mode("plan");
    assert_eq!(app.interaction_mode(), "plan");
}

#[tokio::test]
async fn the_panel_commands_pick_flows_and_say_why_not() {
    crate::i18n::init(Some("en"));
    let mut app = open_thread();
    app.side_open = false;
    type_text(&mut app, "/dag-workflow x");
    app.handle(key(KeyCode::Enter));
    assert_eq!(
        app.notice.as_deref(),
        Some("Usage: /dag-workflow [on|off|N|next|prev|live]")
    );
    app.input.take(true);
    type_text(&mut app, "/dag-workflow 2");
    app.handle(key(KeyCode::Enter));
    assert_eq!(app.notice.as_deref(), Some("There is no flow to pick."));
    assert!(!app.side_open, "a refused pick opens nothing");
    app.input.take(true);
    type_text(&mut app, "/dag-workflow live");
    app.handle(key(KeyCode::Enter));
    assert!(app.side_open && app.side_view == Side::Workflow);
    type_text(&mut app, "/savvy 1");
    app.handle(key(KeyCode::Enter));
    assert!(
        app.notice
            .as_deref()
            .is_some_and(|n| n.starts_with("The Savvy panel shows the current turn")),
        "{:?}",
        app.notice
    );
    app.input.take(true);
    type_text(&mut app, "/savvy");
    app.handle(key(KeyCode::Enter));
    assert!(
        app.side_open && app.side_view == Side::Savvy,
        "switches without closing"
    );
    app.input.take(true);
    type_text(&mut app, "/dag-workflow off");
    app.handle(key(KeyCode::Enter));
    assert!(
        !app.side_open,
        "/dag-workflow turns the panel off whatever view is up"
    );
}

#[tokio::test]
async fn the_wheel_over_the_panel_moves_the_panel_and_elsewhere_the_conversation() {
    let mut app = open_thread();
    app.side_open = true;
    app.side_rect.set(Rect::new(100, 5, 40, 20));
    let wheel = |column: u16, kind: MouseEventKind| {
        Msg::Term(Event::Mouse(MouseEvent {
            kind,
            column,
            row: 10,
            modifiers: KeyModifiers::NONE,
        }))
    };
    app.handle(wheel(110, MouseEventKind::ScrollDown));
    assert_eq!(app.panel_scroll.get(), WHEEL_LINES as i32);
    app.handle(wheel(110, MouseEventKind::ScrollUp));
    app.handle(wheel(110, MouseEventKind::ScrollUp));
    assert_eq!(app.panel_scroll.get(), -(WHEEL_LINES as i32));
    assert_eq!(app.scroll.get(), 0, "the conversation did not move");
    app.handle(wheel(20, MouseEventKind::ScrollUp));
    assert_eq!(
        app.scroll.get(),
        WHEEL_LINES,
        "left of the panel it is the conversation's"
    );
    assert_eq!(app.panel_scroll.get(), -(WHEEL_LINES as i32));
}

#[tokio::test]
async fn going_back_to_a_recent_thread_keeps_what_was_folded_for_it() {
    let mut app = open_thread();
    assert_eq!(app.conv.thread.messages.len(), 1);
    app.start_draft("p1");
    assert!(app.conv.thread_id.is_empty());
    assert_eq!(app.recent.len(), 1);
    app.open_thread("t1");
    // No second window to read: the thread is as it was, and resumes after its last sequence.
    assert_eq!(app.conv.thread.messages.len(), 1);
    assert_eq!(app.conv.sequence, Some(5));
    assert_eq!(app.conv.older_cursor.as_deref(), Some("c1"));
    assert!(app.recent.is_empty());
}

#[tokio::test]
async fn a_thread_the_shell_no_longer_lists_is_read_afresh() {
    let mut app = open_thread();
    app.start_draft("p1");
    app.shell.threads.clear();
    app.open_thread("t1");
    assert!(!app.conv.loaded);
    assert_eq!(app.conv.thread_id, "t1");
}

#[tokio::test]
async fn only_the_last_few_threads_are_kept() {
    let mut app = app_with_project();
    for i in 0..RECENT_THREADS + 2 {
        app.conv = Conversation::new(&format!("t{i}"));
        app.conv.loaded = true;
        app.park_conversation();
    }
    let kept: Vec<&str> = app.recent.iter().map(|c| c.thread_id.as_str()).collect();
    assert_eq!(kept, vec!["t2", "t3", "t4", "t5"]);
    // Viewing one again makes it the newest.
    app.conv = Conversation::new("t2");
    app.conv.loaded = true;
    app.park_conversation();
    assert_eq!(app.recent.last().map(|c| c.thread_id.as_str()), Some("t2"));
    assert_eq!(app.recent.len(), RECENT_THREADS);
}

#[test]
fn provider_skill_prefers_current_provider() {
    let mut app = app_with_project();
    app.config = json!({"providers": [
        {"instanceId": "claude", "skills": [{"name": "Review", "enabled": true}, {"name": "foreign", "enabled": true}]},
        {"instanceId": "codex", "skills": [{"name": "review", "enabled": true}]}
    ]});
    app.model_override = Some(json!({"instanceId": "codex", "model": "gpt"}));
    assert_eq!(app.provider_skill("review"), Some("review".into()));
    assert_eq!(app.provider_skill("foreign"), Some("foreign".into()));
    assert_eq!(app.provider_skill("unknown"), None);
}
