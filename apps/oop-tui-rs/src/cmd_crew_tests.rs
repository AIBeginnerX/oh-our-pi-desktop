use super::*;
use crate::notes::Note;
use crate::panels_common::scenes;
use crate::server_settings::{UPDATE_SETTINGS, fake};
use crate::state::{Conversation, ThreadShell};
use ratatui::Terminal;
use ratatui::backend::TestBackend;

fn english() {
    crate::i18n::init(Some("en"));
}

fn model(slug: &str, name: &str, default: bool) -> Value {
    json!({"slug": slug, "name": name, "isDefault": default})
}

fn providers() -> Value {
    json!([
        {"instanceId": "claude", "driver": "claudeAgent", "displayName": "Claude", "enabled": true,
         "installed": true, "status": "ready", "auth": {"status": "authenticated"},
         "models": [model("claude-haiku-5-5", "Haiku 5.5", false), model("claude-sonnet-5-5", "Sonnet 5.5", true),
                    model("claude-opus-5-5", "Opus 5.5", false)]},
        {"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
         "installed": true, "status": "ready", "auth": {"status": "authenticated"},
         "models": [model("gpt-5", "GPT-5", true), model("gpt-5-mini", "GPT-5 mini", false)]},
        {"instanceId": "grok", "driver": "grok", "displayName": "Grok", "enabled": true,
         "installed": true, "status": "ready", "auth": {"status": "authenticated"},
         "models": [model("grok-4", "Grok 4", true)]}
    ])
}

fn app_with(crew: Value) -> App {
    english();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut app = App::new("0.0.0", "/tmp/oop-rs/work/demo", "/tmp", tx);
    app.config = json!({"settings": {"crew": crew}, "providers": providers()});
    app
}

/// The thread `lead`, on Claude, loaded, with the given activities.
fn on_lead(app: &mut App, activities: Vec<Value>, running: bool) {
    let mut thread = scenes::thread(activities, running);
    thread.model_selection = json!({"instanceId": "claude", "model": "claude-sonnet-5-5"});
    app.active = Active::Thread("lead".into());
    app.conv = Conversation::new("lead");
    app.conv.loaded = true;
    app.conv.thread = thread;
    app.shell.threads = vec![
        serde_json::from_value(json!({"id": "lead", "projectId": "p1", "title": "Lead"})).unwrap(),
    ];
}

/// What the server's thread stream tells: the crew the thread `lead` has of its own.
fn set_lead_crew(app: &mut App, crew: Option<Value>) {
    app.shell
        .threads
        .iter_mut()
        .find(|t| t.id == "lead")
        .unwrap()
        .crew = crew;
}

/// The server stores the last `thread.crew.set` the app sent, and the stream says so.
fn server_stores_the_crew(app: &mut App) -> Value {
    let sent = app.log.last().expect("a command was sent").clone();
    assert_eq!(sent["type"], "thread.crew.set", "{sent}");
    let crew = (!sent["crew"].is_null()).then(|| sent["crew"].clone());
    set_lead_crew(app, crew);
    sent["crew"].clone()
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn letter(ch: char) -> KeyEvent {
    key(KeyCode::Char(ch))
}

#[test]
fn presets_and_roles_are_named_by_value_alias_or_label() {
    english();
    assert_eq!(parse_preset("speed"), Some("speed"));
    assert_eq!(parse_preset(" FAST "), Some("speed"));
    assert_eq!(parse_preset("cheap"), Some("budget"));
    assert_eq!(parse_preset("pick"), Some("recommended"));
    assert_eq!(parse_preset("OOP pick"), Some("recommended"));
    assert_eq!(parse_preset(""), None);
    assert_eq!(parse_preset("nope"), None);
    assert_eq!(parse_role("Expert"), Some(1));
    assert_eq!(parse_role("boss"), None);
    assert_eq!(preset_words(), "recommended|speed|quality|budget");
}

#[test]
fn a_change_gives_the_thread_a_complete_crew_and_keeps_the_rest_of_it() {
    let current = json!({"preset": "speed",
        "pinned": {"expert": {"instanceId": "claude", "model": "claude-opus-5-5"}}});
    let next = apply_change(
        Some(&current),
        &Change {
            enabled: Some(true),
            pins: vec![
                ("worker", None),
                (
                    "auditor",
                    Some(json!({"instanceId": "codex", "model": "gpt-5"})),
                ),
            ],
            ..Default::default()
        },
    );
    assert_eq!(next["enabled"], true);
    assert_eq!(next["preset"], "speed", "the crew keeps its own preset");
    assert_eq!(
        next["pinned"]["worker"],
        Value::Null,
        "a null pin means Auto over the default's pin"
    );
    assert_eq!(next["pinned"]["expert"]["model"], "claude-opus-5-5");
    assert_eq!(next["pinned"]["auditor"]["model"], "gpt-5");
    // the first change of a thread that had none starts from nothing
    let first = apply_change(
        None,
        &Change {
            enabled: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(first, json!({"enabled": true, "pinned": {}}));
}

#[test]
fn make_default_copies_what_the_thread_runs_with_and_only_hand_picked_models() {
    let config = json!({"settings": {"crew": {"enabled": false, "preset": "recommended", "pinned": {}}},
        "providers": providers()});
    let own = json!({"enabled": true, "preset": "quality",
        "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}}});
    let resolved = crew::resolve(&config, Some(&own), Some(("claude", "claude-sonnet-5-5")));
    let next = as_default(&config["settings"]["crew"], &resolved);
    assert_eq!(next["enabled"], true);
    assert_eq!(next["preset"], "quality");
    assert_eq!(
        next["pinned"],
        json!({"worker": {"instanceId": "codex", "model": "gpt-5-mini"}})
    );
}

#[test]
fn the_model_list_puts_auto_first_and_ranks_the_models_that_match() {
    let app = app_with(json!({"enabled": true}));
    let ctx = context(&app, 0);
    let all = pick_items(&ctx, 0, "");
    assert!(matches!(all[0], PickItem::Auto { .. }));
    assert_eq!(all.len(), 1 + 6);
    assert!(
        all[0].note().starts_with("Recommended: "),
        "{}",
        all[0].note()
    );
    let hits = pick_items(&ctx, 0, "mini");
    assert_eq!(
        hits.len(),
        1,
        "Auto is ruled out by the words, one model fits: {hits:?}"
    );
    assert_eq!(hits[0].label(), "Codex / GPT-5 mini");
    let by_provider = pick_items(&ctx, 0, "claude opus");
    assert_eq!(
        by_provider[0].label(),
        "Claude / Opus 5.5",
        "every word must match, in any field"
    );
    assert!(pick_items(&ctx, 0, "zzzz").is_empty());
    assert!(matches!(
        pick_items(&ctx, 0, "auto")[0],
        PickItem::Auto { .. }
    ));
    assert!(all.iter().any(|i| i.note().contains("default")));
}

#[test]
fn the_status_of_the_thread_model_explains_why_the_crew_cannot_start() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, vec![], false);
    assert!(context(&app, 0).problem.is_none());
    app.conv.thread.model_selection = json!({"instanceId": "grok", "model": "grok-4"});
    let problem = context(&app, 0).problem.expect("grok cannot lead");
    assert!(problem.contains("Grok"), "{problem}");
    app.conv.thread.model_selection = json!({"instanceId": "gone", "model": "x"});
    assert_eq!(
        context(&app, 0).problem.as_deref(),
        Some(text("providers.crew.unknownModel"))
    );
}

fn pressed(shown: &View, ctx: &Context, code: KeyEvent) -> KeyResult {
    crew_key(shown, ctx, code)
}

#[test]
fn the_main_screen_lists_settings_then_tasks_and_keys_move_the_pointer() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(
        &mut app,
        vec![
            scenes::crew(
                "task.started",
                6,
                "w1",
                "worker",
                json!({"title": "fix it"}),
            ),
            scenes::crew(
                "task.completed",
                20,
                "w1",
                "worker",
                json!({"status": "completed"}),
            ),
        ],
        false,
    );
    let ctx = context(&app, scenes::ms(100));
    let rows = main_rows(&ctx);
    assert_eq!(
        rows,
        [
            Row::Toggle,
            Row::Preset,
            Row::Role(0),
            Row::Role(1),
            Row::Role(2),
            Row::Task(0)
        ],
        "no Auto-all row while nothing is pinned; no make-default or reset row while the thread runs the default"
    );
    set_lead_crew(&mut app, Some(json!({"pinned": {}})));
    let own = main_rows(&context(&app, scenes::ms(100)));
    assert_eq!(
        &own[5..7],
        [Row::Default, Row::Reset],
        "a thread with a crew of its own can make it the default or give it up"
    );
    let view = open_view(&ctx);
    assert_eq!(view.selected(), 0);
    let down = pressed(&view, &ctx, key(KeyCode::Down));
    assert_eq!(down.view.unwrap().selected(), 1);
    let digit = pressed(&view, &ctx, letter('6'));
    assert_eq!(digit.view.unwrap().selected(), 5);
    let beyond = pressed(&view, &ctx, letter('7'));
    assert_eq!(
        beyond.view.unwrap().selected(),
        0,
        "a digit past the last row does nothing"
    );
    assert!(
        pressed(&view, &ctx, key(KeyCode::Esc)).view.is_none(),
        "Esc closes the main screen"
    );
    assert!(pressed(&view, &ctx, letter('q')).view.is_none());
    let up = pressed(&view, &ctx, key(KeyCode::Up));
    assert_eq!(
        up.view.unwrap().selected(),
        0,
        "the pointer stays inside the list"
    );
}

#[test]
fn enter_on_a_setting_asks_for_its_change_and_on_a_list_opens_it() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, vec![], false);
    set_lead_crew(&mut app, Some(json!({"pinned": {}})));
    let ctx = context(&app, 0);
    let at = |row: Row| {
        let selected = main_rows(&ctx).iter().position(|r| *r == row).unwrap();
        main_view_at(&ctx, selected)
    };
    assert_eq!(
        pressed(&at(Row::Toggle), &ctx, key(KeyCode::Enter)).effect,
        Effect::Toggle
    );
    assert_eq!(
        pressed(&at(Row::Default), &ctx, key(KeyCode::Enter)).effect,
        Effect::Default
    );
    assert_eq!(
        pressed(&at(Row::Reset), &ctx, key(KeyCode::Enter)).effect,
        Effect::Reset
    );
    let preset = pressed(&at(Row::Preset), &ctx, key(KeyCode::Enter))
        .view
        .unwrap();
    assert_eq!(preset, View::Preset { selected: 0 });
    let chosen = pressed(&View::Preset { selected: 2 }, &ctx, key(KeyCode::Enter));
    assert_eq!(chosen.effect, Effect::Preset("quality"));
    assert!(
        matches!(chosen.view, Some(View::Main { .. })),
        "back to the main screen"
    );
    let model = pressed(&at(Row::Role(1)), &ctx, key(KeyCode::Enter))
        .view
        .unwrap();
    assert_eq!(
        model,
        View::Model {
            role: 1,
            selected: 0,
            query: String::new()
        },
        "Auto is the current choice"
    );
}

#[test]
fn the_model_list_filters_as_letters_are_typed_and_esc_clears_before_it_goes_back() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, vec![], false);
    let ctx = context(&app, 0);
    let mut view = View::Model {
        role: 0,
        selected: 0,
        query: String::new(),
    };
    for ch in "mini".chars() {
        view = pressed(&view, &ctx, letter(ch)).view.unwrap();
    }
    assert_eq!(
        view,
        View::Model {
            role: 0,
            selected: 0,
            query: "mini".into()
        },
        "'q' and digits are letters here too"
    );
    let pick = pressed(&view, &ctx, key(KeyCode::Enter));
    match pick.effect {
        Effect::Pin {
            role: 0,
            pick: PickItem::Model { option, .. },
        } => assert_eq!(option.model, "gpt-5-mini"),
        other => panic!("{other:?}"),
    }
    let backspace = pressed(&view, &ctx, key(KeyCode::Backspace)).view.unwrap();
    assert!(matches!(&backspace, View::Model { query, .. } if query == "min"));
    let cleared = pressed(&view, &ctx, key(KeyCode::Esc)).view.unwrap();
    assert!(matches!(&cleared, View::Model { query, .. } if query.is_empty()));
    assert!(matches!(
        pressed(&cleared, &ctx, key(KeyCode::Esc)).view,
        Some(View::Main { .. })
    ));
    // no match: Enter says so and stays
    let none = View::Model {
        role: 0,
        selected: 0,
        query: "zzzz".into(),
    };
    let result = pressed(&none, &ctx, key(KeyCode::Enter));
    assert_eq!(result.effect, Effect::None);
    assert_eq!(
        result.notice.as_deref(),
        Some(text("providers.crewScreen.noMatch"))
    );
    let ctrl_u = KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL);
    assert!(
        matches!(&pressed(&view, &ctx, ctrl_u).view, Some(View::Model { query, .. }) if query.is_empty())
    );
    assert_eq!(
        append_to_search("a ", "  b"),
        "a b",
        "doubled spaces and leading space go"
    );
    assert_eq!(append_to_search("", " "), "");
}

fn running_board() -> Vec<Value> {
    vec![
        scenes::crew(
            "task.started",
            6,
            "w1",
            "worker",
            json!({"title": "fix the parser"}),
        ),
        scenes::crew(
            "task.started",
            7,
            "e1",
            "expert",
            json!({"title": "hard part"}),
        ),
        scenes::crew(
            "task.completed",
            30,
            "e1",
            "expert",
            json!({"status": "failed"}),
        ),
    ]
}

#[test]
fn a_task_offers_open_stop_and_retry_as_it_stands() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, running_board(), true);
    let ctx = context(&app, scenes::ms(40));
    let board = ctx.board.as_ref().expect("a board");
    let (running, failed) = (&board.tasks[0], &board.tasks[1]);
    assert_eq!(
        task_items(running, false),
        [TaskItem::Open, TaskItem::Stop, TaskItem::Back]
    );
    assert_eq!(
        task_items(failed, false),
        [TaskItem::Open, TaskItem::Retry, TaskItem::Back]
    );
    assert_eq!(
        task_items(failed, true),
        [TaskItem::Confirm, TaskItem::Cancel]
    );
    // an auditor is not retried, a task with no thread cannot be opened or stopped
    let mut auditor = failed.clone();
    auditor.role = "auditor".into();
    auditor.actions.retry = false;
    assert_eq!(
        task_items(&auditor, false),
        [TaskItem::Open, TaskItem::Back]
    );
    assert!(running.actions.stop && running.actions.open && !running.actions.retry);
    assert!(failed.actions.retry && !failed.actions.stop);
}

#[test]
fn stopping_a_task_asks_first_and_then_names_the_task() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, running_board(), true);
    let ctx = context(&app, scenes::ms(40));
    let task_row = main_rows(&ctx)
        .iter()
        .position(|r| *r == Row::Task(0))
        .unwrap();
    let task = pressed(&main_view_at(&ctx, task_row), &ctx, key(KeyCode::Enter))
        .view
        .unwrap();
    assert_eq!(
        task,
        View::Task {
            task_id: "w1".into(),
            selected: 0,
            confirm_stop: false
        }
    );
    let ask = pressed(
        &View::Task {
            task_id: "w1".into(),
            selected: 1,
            confirm_stop: false,
        },
        &ctx,
        key(KeyCode::Enter),
    );
    assert_eq!(
        ask.effect,
        Effect::None,
        "nothing is stopped before it is confirmed"
    );
    let asked = ask.view.unwrap();
    assert_eq!(
        asked,
        View::Task {
            task_id: "w1".into(),
            selected: 1,
            confirm_stop: true
        },
        "the pointer starts on Cancel"
    );
    let cancel = pressed(&asked, &ctx, key(KeyCode::Enter));
    assert_eq!(cancel.effect, Effect::None);
    let confirm = pressed(
        &View::Task {
            task_id: "w1".into(),
            selected: 0,
            confirm_stop: true,
        },
        &ctx,
        key(KeyCode::Enter),
    );
    assert_eq!(
        confirm.effect,
        Effect::Stop(TaskRef {
            task_id: "w1".into(),
            role: "worker".into(),
            thread_id: Some("th-w1".into())
        })
    );
    let esc = pressed(&asked, &ctx, key(KeyCode::Esc)).view.unwrap();
    assert!(
        matches!(
            esc,
            View::Task {
                confirm_stop: false,
                ..
            }
        ),
        "Esc only leaves the question"
    );
    let retry = pressed(
        &View::Task {
            task_id: "e1".into(),
            selected: 1,
            confirm_stop: false,
        },
        &ctx,
        key(KeyCode::Enter),
    );
    assert!(matches!(retry.effect, Effect::Retry(TaskRef { ref task_id, .. }) if task_id == "e1"));
    let open = pressed(
        &View::Task {
            task_id: "e1".into(),
            selected: 0,
            confirm_stop: false,
        },
        &ctx,
        key(KeyCode::Enter),
    );
    assert_eq!(open.effect, Effect::Open("th-e1".into()));
    assert!(open.view.is_none(), "opening a thread closes the screen");
}

#[test]
fn a_pointer_follows_its_row_when_rows_come_and_go() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, running_board(), true);
    let ctx = context(&app, scenes::ms(40));
    let on_task = main_view_at(
        &ctx,
        main_rows(&ctx)
            .iter()
            .position(|r| *r == Row::Role(1))
            .unwrap(),
    );
    // A model gets pinned: an "Auto for all" row appears above the roles' end; the pointer stays on the expert.
    app.config["settings"]["crew"]["pinned"] =
        json!({"worker": {"instanceId": "codex", "model": "gpt-5"}});
    let after = context(&app, scenes::ms(40));
    assert!(main_rows(&after).contains(&Row::AutoAll));
    let settled = settle(&on_task, &after);
    assert_eq!(
        row_id(&after, main_rows(&after)[settled.selected()]),
        "role:expert"
    );
}

#[test]
fn a_crew_thread_that_waits_for_the_user_starts_the_pointer_and_is_listed_first() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, running_board(), true);
    app.shell
        .threads
        .push(scenes::shell("th-w1", "Crew Worker · fix the parser", true));
    app.shell.threads.push(scenes::shell(
        "th-old",
        "Crew Expert · an earlier thing",
        false,
    ));
    let ctx = context(&app, scenes::ms(40));
    assert_eq!(ctx.waiting.len(), 1);
    let rows = main_rows(&ctx);
    assert!(
        !rows.iter().any(|r| matches!(r, Row::Thread(_))),
        "it is on the board already: shown as a task row"
    );
    let view = open_view(&ctx);
    let task = ctx
        .board
        .as_ref()
        .unwrap()
        .tasks
        .iter()
        .position(|t| t.task_id == "w1")
        .unwrap();
    assert_eq!(
        rows[view.selected()],
        Row::Task(task),
        "the pointer starts on the request that waits"
    );
    // A waiting thread that is on no board is a row of its own, at the top.
    app.shell
        .threads
        .push(scenes::shell("th-x", "Crew Auditor · a review", true));
    let ctx = context(&app, scenes::ms(40));
    let rows = main_rows(&ctx);
    assert!(matches!(rows[0], Row::Thread(_)));
    let open = pressed(&open_view(&ctx), &ctx, key(KeyCode::Enter));
    assert_eq!(open.effect, Effect::Open("th-x".into()));
    assert_eq!(
        waiting_text(&ctx.waiting.iter().map(|w| w.kind).collect::<Vec<_>>()).as_deref(),
        Some("2 crew tasks are waiting for approval — /crew")
    );
}

fn rows_of(app: &App, w: u16, h: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal
        .draw(|f| app.screen.as_ref().unwrap().draw(f, f.area(), app))
        .unwrap();
    let buffer = terminal.backend().buffer().clone();
    (0..h)
        .map(|y| {
            (0..w)
                .map(|x| buffer[(x, y)].symbol().to_string())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

#[test]
fn the_screen_draws_the_settings_and_the_board() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, running_board(), true);
    run(&mut app, "");
    let rows = rows_of(&app, 100, 24).join("\n");
    for wanted in [
        "Crew  on",
        "this thread only",
        "Preset  OOP pick",
        "Worker  Auto · Haiku 5.5",
        "Expert  Auto · Opus 5.5",
        "Auditor  Auto · Opus 5.5",
        "Worker  In progress · fix the parser",
        "Expert  Failed · hard part",
    ] {
        assert!(rows.contains(wanted), "{wanted:?} in\n{rows}");
    }
    assert!(
        rows.contains("1  Crew") && rows.contains("This turn"),
        "{rows}"
    );
    assert!(
        !rows.contains("Use as new chat default") && !rows.contains("Use the default crew"),
        "the thread runs the default crew: nothing to make default or to reset\n{rows}"
    );
    set_lead_crew(&mut app, Some(json!({"pinned": {}})));
    run(&mut app, "");
    let own = rows_of(&app, 100, 24).join("\n");
    for wanted in [
        "this thread (own crew)",
        "Use as new chat default",
        "Use the default crew",
    ] {
        assert!(own.contains(wanted), "{wanted:?} in\n{own}");
    }
    assert_eq!(
        app.screen.as_ref().unwrap().hint(),
        text("providers.crewScreen.hintMain")
    );
}

#[test]
fn the_task_screen_shows_the_detail_and_a_long_summary_is_cut() {
    let mut app = app_with(json!({"enabled": true}));
    let long = "word ".repeat(200);
    on_lead(
        &mut app,
        vec![
            scenes::crew(
                "task.started",
                6,
                "w1",
                "worker",
                json!({"title": "fix the parser"}),
            ),
            scenes::crew(
                "task.completed",
                26,
                "w1",
                "worker",
                json!({"status": "completed", "summary": long}),
            ),
        ],
        false,
    );
    app.screen = Some(Box::new(CrewScreen {
        view: View::Task {
            task_id: "w1".into(),
            selected: 0,
            confirm_stop: false,
        },
    }));
    let rows = rows_of(&app, 44, 30);
    let shown = rows.join("\n");
    for wanted in [
        "Worker task",
        "Task      fix the parser",
        "Status    Done",
        "Elapsed   20s",
        "Open sub-thread",
        "Back to board",
    ] {
        assert!(shown.contains(wanted), "{wanted:?} in\n{shown}");
    }
    assert!(shown.contains('…'), "the summary is cut: {shown}");
    assert!(!shown.contains("Retry"), "a finished task is not retried");
}

#[test]
fn a_finished_task_says_whether_the_server_could_verify_it() {
    let mut app = app_with(json!({"enabled": true}));
    let done = |id: &str, role: &str, extra: Value| {
        let mut payload = json!({"status": "completed"});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        scenes::crew("task.completed", 20, id, role, payload)
    };
    on_lead(
        &mut app,
        vec![
            scenes::crew("task.started", 6, "w1", "worker", json!({"title": "a"})),
            scenes::crew("task.started", 6, "w2", "worker", json!({"title": "b"})),
            scenes::crew("task.started", 6, "w3", "worker", json!({"title": "c"})),
            done("w1", "worker", json!({"proof": "verified"})),
            done("w2", "worker", json!({"proof": "inconclusive"})),
            // An older server says nothing, which must read as nothing, never as verified.
            done("w3", "worker", json!({})),
        ],
        false,
    );
    let ctx = context(&app, scenes::ms(100));
    let board = ctx.board.as_ref().expect("a board");
    let note = |id: &str| task_note(board.tasks.iter().find(|t| t.task_id == id).unwrap(), 0);
    assert!(note("w1").starts_with("verified"), "{}", note("w1"));
    assert!(note("w2").starts_with("unproven"), "{}", note("w2"));
    assert!(!note("w3").contains("verified") && !note("w3").contains("unproven"));
    let detail = task_detail(&board.tasks[1], 0, None);
    assert!(detail.contains(&("Proof".to_string(), "unproven".to_string())));
}

fn log_activities() -> Vec<Value> {
    let mut switched = scenes::crew(
        "task.progress",
        8,
        "w1",
        "worker",
        json!({"summary": "Haiku failed (rate limit)", "model": "Sonnet"}),
    );
    switched["summary"] = json!("Worker switched to Sonnet: fix it");
    let mut first = vec![
        scenes::crew(
            "task.started",
            6,
            "w1",
            "worker",
            json!({"title": "fix it", "model": "Haiku", "why": "=cheap and mechanical"}),
        ),
        // A checklist row is not a decision.
        scenes::crew("task.progress", 7, "w1", "worker", json!({"todoTotal": 3})),
        switched,
        scenes::crew(
            "task.completed",
            20,
            "w1",
            "worker",
            json!({"status": "completed", "proof": "inconclusive", "todoTotal": 3, "todoVerified": 2}),
        ),
        scenes::crew(
            "task.completed",
            22,
            "a1",
            "auditor",
            json!({"status": "completed", "verdict": "needs-changes"}),
        ),
        scenes::crew(
            "crew.follow-up",
            23,
            "-",
            "worker",
            json!({"reason": "audit"}),
        ),
        scenes::crew(
            "crew.stopped",
            30,
            "-",
            "worker",
            json!({"taskIds": ["w2", "w3"], "reason": "Stopped on request."}),
        ),
    ];
    // An older server's task: no why, no proof.
    first.push(scenes::crew(
        "task.completed",
        40,
        "w9",
        "worker",
        json!({"status": "completed"}),
    ));
    first
}

#[test]
fn the_decision_log_has_one_row_per_decision_in_time_order() {
    let rows = decision_log(&{
        let mut app = app_with(json!({"enabled": true}));
        on_lead(&mut app, log_activities(), false);
        app.conv.thread.activities.clone()
    });
    let phases: Vec<&str> = rows.iter().map(|r| r.phase.as_str()).collect();
    assert_eq!(
        phases,
        [
            "delegate:worker",
            "fallback",
            "result:worker",
            "audit",
            "follow-up",
            "stop",
            "result:worker"
        ]
    );
    assert_eq!(rows[0].decision, "handed to Haiku: fix it");
    assert_eq!(rows[0].why, "=cheap and mechanical");
    assert_eq!(rows[0].evidence, "task:w1 thread:th-w1");
    assert_eq!(rows[1].why, "Haiku failed (rate limit)");
    assert_eq!(
        (rows[2].evidence.as_str(), rows[2].result.as_str()),
        ("task:w1 todos 2/3", "INCONCLUSIVE")
    );
    assert_eq!(rows[3].result, "needs-changes");
    assert_eq!(rows[4].why, "audit");
    assert_eq!(
        (
            rows[5].decision.as_str(),
            rows[5].why.as_str(),
            rows[5].evidence.as_str()
        ),
        ("stopped 2 tasks", "Stopped on request.", "tasks:w2,w3")
    );
    // An older server never proved anything, and the log never says it did.
    assert_eq!(rows[6].result, "UNKNOWN");
}

#[test]
fn the_decision_log_leaves_out_a_provider_native_task_without_a_crew_role() {
    let rows = decision_log(&{
        let mut app = app_with(json!({"enabled": true}));
        on_lead(
            &mut app,
            vec![
                // The plan's own step: the provider emits task.started without a crewRole.
                scenes::act(
                    "task.started",
                    6,
                    json!({"taskId": "plan-1", "taskType": "plan", "title": "read the repo"}),
                ),
                scenes::act(
                    "task.completed",
                    8,
                    json!({"taskId": "plan-1", "taskType": "plan", "status": "completed"}),
                ),
                // A crew task still counts, and a stop stays, because a stop is the lead's.
                scenes::crew("task.started", 10, "w1", "worker", json!({})),
                scenes::crew(
                    "crew.stopped",
                    12,
                    "-",
                    "worker",
                    json!({"taskIds": ["w1"], "reason": "Stopped on request."}),
                ),
            ],
            false,
        );
        app.conv.thread.activities.clone()
    });
    let phases: Vec<&str> = rows.iter().map(|r| r.phase.as_str()).collect();
    assert_eq!(phases, ["delegate:worker", "stop"]);
    assert_eq!(rows[1].decision, "stopped 1 task");
}

#[test]
fn a_tsv_cell_stays_on_one_line_and_defuses_a_formula() {
    assert_eq!(tsv_cell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
    for lead in ["+", "-", "@"] {
        assert_eq!(tsv_cell(&format!("{lead}1")), format!("'{lead}1"));
    }
    assert_eq!(tsv_cell("a\tb\r\nc\u{2028}d\u{7}e"), "a b c d e");
    assert_eq!(tsv_cell("\t=1+1"), "'=1+1");
    assert_eq!(tsv_cell(&"x".repeat(900)).chars().count(), CELL_LIMIT);
    let rows = [LogRow {
        ts: "t".into(),
        phase: "p\tq".into(),
        decision: "d".into(),
        why: "-2+3\nsecond".into(),
        evidence: "e".into(),
        result: "r".into(),
    }];
    let tsv = decision_log_tsv(&rows);
    let lines: Vec<&str> = tsv.lines().collect();
    assert_eq!(lines[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
    assert_eq!(lines[1], "t\tp q\td\t'-2+3 second\te\tr");
    assert_eq!(lines.len(), 2);
}

#[test]
fn crew_log_writes_the_newest_rows_into_the_conversation_and_queues_the_whole_tsv() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, log_activities(), false);
    run(&mut app, "log");
    let shown = notes(&app);
    assert!(shown.contains("the last 7 of 7 rows"), "{shown}");
    assert!(shown.contains("fallback · switched to Sonnet"), "{shown}");
    assert!(
        shown.contains("result:worker · worker finished · INCONCLUSIVE"),
        "{shown}"
    );
    // The clipboard is only queued: the main loop carries it out, so a test never touches it.
    let job = app.take_copy().expect("a copy is queued");
    let lines: Vec<&str> = job.text.lines().collect();
    assert_eq!(lines.len(), 8);
    assert!(
        lines[1].contains("\t'=cheap and mechanical\t"),
        "{}",
        lines[1]
    );
    assert!(app.take_copy().is_none());
}

#[test]
fn crew_log_on_a_thread_without_decisions_says_so_and_copies_nothing() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, vec![], false);
    run(&mut app, "log");
    assert_eq!(app.notice.as_deref(), Some(text("session.c.crewLogEmpty")));
    assert!(app.take_copy().is_none());
    assert!(app.notes.is_empty());
}

#[test]
fn a_task_that_has_left_the_board_says_so() {
    let mut app = app_with(json!({"enabled": true}));
    on_lead(&mut app, vec![], false);
    app.screen = Some(Box::new(CrewScreen {
        view: View::Task {
            task_id: "gone".into(),
            selected: 0,
            confirm_stop: false,
        },
    }));
    assert!(
        rows_of(&app, 80, 12)
            .join("\n")
            .contains(text("providers.crewScreen.taskGone"))
    );
}

fn notes(app: &App) -> String {
    app.notes
        .iter()
        .map(|n| match n {
            Note::Text { title, body, .. } => format!("{title} {}", body.join(" ")),
            Note::Rows { .. } => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn connected_on_lead() -> (fake::Fake, App, tokio::sync::mpsc::UnboundedReceiver<Msg>) {
    english();
    let fake = fake::start_with(
        json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}}}),
        providers(),
    )
    .await;
    let (mut app, rx) = fake::connected(&fake).await;
    on_lead(&mut app, vec![], false);
    (fake, app, rx)
}

fn stored(fake: &fake::Fake) -> Value {
    fake.settings.lock().unwrap()["crew"].clone()
}

#[tokio::test]
async fn crew_on_gives_this_thread_its_own_crew_and_leaves_the_settings_alone() {
    let (fake, mut app, _rx) = connected_on_lead().await;
    run(&mut app, "on");
    let crew = server_stores_the_crew(&mut app);
    assert_eq!(crew, json!({"enabled": true, "pinned": {}}));
    assert_eq!(app.log.last().unwrap()["threadId"], "lead");
    assert!(notes(&app).contains("Crew on"), "{}", notes(&app));
    assert!(
        fake.called(UPDATE_SETTINGS).is_empty(),
        "the default crew is not written"
    );
    assert_eq!(stored(&fake)["enabled"], false, "the default stays off");
    let sent = app.log.len();
    run(&mut app, "on");
    assert!(
        app.notice.as_deref().is_some_and(|n| n.contains("already")),
        "{:?}",
        app.notice
    );
    assert_eq!(app.log.len(), sent, "nothing is sent for what already is");
}

#[tokio::test]
async fn crew_off_preset_reset_and_default_go_where_they_belong() {
    let (fake, mut app, mut rx) = connected_on_lead().await;
    run(&mut app, "preset fast");
    assert_eq!(
        server_stores_the_crew(&mut app),
        json!({"preset": "speed", "pinned": {}})
    );
    assert!(notes(&app).contains("Crew preset Speed"), "{}", notes(&app));
    run(&mut app, "preset nope");
    assert!(
        app.notice
            .as_deref()
            .unwrap()
            .contains("recommended|speed|quality|budget")
    );
    // The crew on this thread, then "default": new threads get what this thread runs with.
    run(&mut app, "on");
    assert_eq!(
        server_stores_the_crew(&mut app),
        json!({"enabled": true, "preset": "speed", "pinned": {}}),
        "the second change keeps the first"
    );
    run(&mut app, "default");
    fake::pump(&mut app, &mut rx, |a| {
        a.config["settings"]["crew"]["enabled"] == true
    })
    .await;
    let crew = stored(&fake);
    assert_eq!(
        (crew["enabled"].clone(), crew["preset"].clone()),
        (json!(true), json!("speed"))
    );
    assert!(crew.get("threads").is_none(), "no per-thread settings");
    assert_eq!(
        fake.called(UPDATE_SETTINGS).len(),
        1,
        "only 'default' wrote"
    );
    // Giving the thread's crew up: it runs the default again.
    run(&mut app, "reset");
    assert!(server_stores_the_crew(&mut app).is_null());
    assert!(app.own_crew().is_none());
    run(&mut app, "reset");
    assert_eq!(
        app.notice.as_deref(),
        Some(text("session.c.crewDefaultAlready"))
    );
    run(&mut app, "off");
    assert_eq!(
        server_stores_the_crew(&mut app),
        json!({"enabled": false, "pinned": {}})
    );
    assert_eq!(fake.called(UPDATE_SETTINGS).len(), 1);
}

#[tokio::test]
async fn crew_model_pins_a_model_or_puts_the_role_back_on_auto() {
    let (fake, mut app, _rx) = connected_on_lead().await;
    run(&mut app, "model worker gpt-5 mini");
    assert_eq!(
        server_stores_the_crew(&mut app)["pinned"]["worker"],
        json!({"instanceId": "codex", "model": "gpt-5-mini"})
    );
    assert!(
        notes(&app).contains("Worker model Codex / GPT-5 mini"),
        "{}",
        notes(&app)
    );
    run(&mut app, "model worker auto");
    assert_eq!(
        server_stores_the_crew(&mut app)["pinned"]["worker"],
        Value::Null
    );
    assert!(fake.called(UPDATE_SETTINGS).is_empty());
    // usage and unknown words
    run(&mut app, "model");
    assert_eq!(
        app.notice.as_deref(),
        Some(text("session.c.crewModelUsage"))
    );
    run(&mut app, "model boss");
    assert!(app.notice.as_deref().unwrap().contains("boss"));
    run(&mut app, "model worker zzzz");
    assert!(app.notice.as_deref().unwrap().contains("zzzz"));
    // several matches open the narrowed list
    assert!(app.screen.is_none());
    run(&mut app, "model expert claude");
    let screen = rows_of(&app, 100, 20).join("\n");
    assert!(
        screen.contains("Claude / Opus 5.5") && screen.contains("Claude / Haiku 5.5"),
        "{screen}"
    );
    assert!(!screen.contains("Codex /"), "{screen}");
    assert!(screen.contains("Search: claude"), "{screen}");
}

#[tokio::test]
async fn on_a_conversation_not_started_the_crew_is_kept_in_the_draft_not_in_the_settings() {
    english();
    let fake = fake::start_with(
        json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}}}),
        providers(),
    )
    .await;
    let (mut app, _rx) = fake::connected(&fake).await;
    app.active = Active::Draft("p1".into());
    run(&mut app, "default");
    assert_eq!(
        app.notice.as_deref(),
        Some(text("session.c.crewDefaultAlready"))
    );
    run(&mut app, "preset budget");
    assert_eq!(
        app.draft_crew,
        Some(json!({"preset": "budget", "pinned": {}}))
    );
    assert_eq!(app.own_crew(), app.draft_crew);
    assert!(
        notes(&app).contains("Crew preset Budget"),
        "{}",
        notes(&app)
    );
    assert!(app.log.is_empty(), "nothing goes to the server yet");
    assert!(fake.called(UPDATE_SETTINGS).is_empty());
    assert_eq!(stored(&fake)["preset"], "recommended");
    // The draft's own crew can be made the default, or given up.
    run(&mut app, "reset");
    assert!(app.own_crew().is_none());
    // A new draft starts from the default, whatever the last one picked.
    run(&mut app, "on");
    app.start_draft("p1");
    assert!(app.own_crew().is_none());
}

#[tokio::test]
async fn a_failed_save_is_reported_and_nothing_is_recorded_as_done() {
    english();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
    app.config = json!({"settings": {"crew": {"enabled": false}}, "providers": providers()});
    on_lead(&mut app, vec![], false);
    run(&mut app, "on");
    assert_eq!(
        app.notice.as_deref(),
        Some(crate::i18n::tr("notice.offline"))
    );
    assert!(!notes(&app).contains("Crew on"));
}

#[tokio::test]
async fn a_settings_update_from_the_stream_refreshes_what_the_crew_line_reads() {
    english();
    let fake = fake::start_with(
        json!({"crew": {"enabled": false, "preset": "recommended", "pinned": {}, "threads": {}}}),
        providers(),
    )
    .await;
    let (mut app, mut rx) = fake::connected(&fake).await;
    on_lead(&mut app, vec![], false);
    let line = |app: &App| {
        let model = app.current_model();
        crew::roles_of(&app.config, app.own_crew().as_ref(), brain_of(&model), true)
    };
    // The stream's snapshot arrives first; the crew is off.
    fake::pump(&mut app, &mut rx, |a| {
        fake.calls
            .lock()
            .unwrap()
            .iter()
            .any(|(t, _)| t == "subscribeServerConfig")
            && a.config["providers"].is_array()
    })
    .await;
    assert!(line(&app).is_none());
    // Another client turns the crew on and pins the worker: the server announces it.
    let now = json!({"crew": {"enabled": true, "preset": "recommended", "threads": {},
        "pinned": {"worker": {"instanceId": "codex", "model": "gpt-5-mini"}}}});
    *fake.settings.lock().unwrap() = now.clone();
    fake.events
        .send(json!({"type": "settingsUpdated", "payload": {"settings": now}}))
        .unwrap();
    fake::pump(&mut app, &mut rx, |a| line(a).is_some()).await;
    let roles = line(&app).expect("the crew line has input now");
    assert_eq!(roles[0].model.as_deref(), Some("GPT-5 mini"));
    assert_eq!(roles[1].model.as_deref(), Some("Opus 5.5"));
}

#[tokio::test]
async fn my_own_change_is_sent_to_the_thread_and_shows_when_the_thread_comes_back() {
    let (_fake, mut app, _rx) = connected_on_lead().await;
    run(&mut app, "on");
    let sent = app.log.last().expect("the change was sent").clone();
    assert_eq!(sent["type"], "thread.crew.set");
    assert_eq!(sent["threadId"], "lead");
    assert_eq!(sent["crew"], json!({"enabled": true, "pinned": {}}));
    let model = app.current_model();
    assert!(
        crew::roles_of(&app.config, app.own_crew().as_ref(), brain_of(&model), true).is_none(),
        "nothing changes before the server stores it"
    );
    app.shell
        .threads
        .iter_mut()
        .find(|t| t.id == "lead")
        .unwrap()
        .crew = Some(sent["crew"].clone());
    assert!(crew::roles_of(&app.config, app.own_crew().as_ref(), brain_of(&model), true).is_some());
}

#[tokio::test]
async fn in_a_crew_task_thread_only_back_works_and_it_returns_to_the_lead() {
    let (fake, mut app, mut rx) = connected_on_lead().await;
    app.shell
        .threads
        .push(scenes::shell("th-w1", "Crew Worker · fix", false));
    app.active = Active::Thread("th-w1".into());
    assert!(crew_sub(&app).is_some());
    run(&mut app, "on");
    assert_eq!(app.notice.as_deref(), Some(text("session.c.crewBackOnly")));
    assert!(fake.called(UPDATE_SETTINGS).is_empty());
    run(&mut app, "back");
    assert_eq!(
        app.active,
        Active::Thread("lead".into()),
        "the lead is open again"
    );
    // The note that belongs to a task thread is not shown on the lead.
    assert!(!notes(&app).contains(text("session.c.crewTaskThread")));
    // /crew back on a lead says what it is for.
    run(&mut app, "back");
    assert_eq!(
        app.notice.as_deref(),
        Some(text("session.c.crewBackOnlyInTask"))
    );
    // A task thread whose lead is not known cannot go back.
    app.shell.threads.push(
        serde_json::from_value::<ThreadShell>(
            json!({"id": "orphan", "projectId": "p1", "title": "Crew Expert · x"}),
        )
        .unwrap(),
    );
    app.active = Active::Thread("orphan".into());
    run(&mut app, "");
    assert_eq!(app.notice.as_deref(), Some(text("session.c.leadUnknown")));
    let _ = &mut rx;
}

#[tokio::test]
async fn opening_a_crew_thread_says_what_it_is_and_an_unknown_thread_is_refused() {
    let (_fake, mut app, _rx) = connected_on_lead().await;
    app.shell
        .threads
        .push(scenes::shell("th-w1", "Crew Worker · fix", false));
    open_thread(&mut app, "th-w1");
    assert_eq!(app.active, Active::Thread("th-w1".into()));
    assert!(
        notes(&app).contains(text("session.c.crewTaskThread")),
        "{}",
        notes(&app)
    );
    open_thread(&mut app, "nowhere");
    assert_eq!(
        app.notice.as_deref(),
        Some(text("session.c.threadNotFound"))
    );
    assert_eq!(app.active, Active::Thread("th-w1".into()));
}

#[tokio::test]
async fn retry_asks_the_server_to_run_the_task_again_and_stop_interrupts_its_thread() {
    let (fake, mut app, mut rx) = connected_on_lead().await;
    on_lead(&mut app, running_board(), true);
    let task = |id: &str, role: &str| TaskRef {
        task_id: id.into(),
        role: role.into(),
        thread_id: Some(format!("th-{id}")),
    };
    retry_task(&mut app, &task("e1", "expert"));
    fake::pump(&mut app, &mut rx, |a| {
        notes(a).contains("Restarted the Expert task")
    })
    .await;
    assert_eq!(
        fake.called(RETRY_RPC),
        [json!({"leadThreadId": "lead", "taskId": "e1"})]
    );
    stop_task(&mut app, &task("w1", "worker"));
    assert!(
        notes(&app).contains("Requested to stop the Worker task"),
        "{}",
        notes(&app)
    );
    assert_eq!(
        app.log
            .last()
            .map(|c| (c["type"].clone(), c["threadId"].clone())),
        Some((json!("thread.turn.interrupt"), json!("th-w1")))
    );
}

#[tokio::test]
async fn crew_stop_asks_the_server_to_stop_all_tasks_or_one_by_id() {
    let (fake, mut app, mut rx) = connected_on_lead().await;
    // A config refresh from the server replaces the whole value, so each stop restates it.
    let serves_stop = |app: &mut App| {
        app.config["environment"]["capabilities"]["crew"] = json!({"stopTasks": true});
    };
    serves_stop(&mut app);
    run(&mut app, "stop");
    fake::pump(&mut app, &mut rx, |a| {
        notes(a).contains(text("session.c.crewStopNone"))
    })
    .await;
    serves_stop(&mut app);
    run(&mut app, "stop ALL");
    fake::pump(&mut app, &mut rx, |_| fake.called(STOP_RPC).len() == 2).await;
    serves_stop(&mut app);
    run(&mut app, "stop task-9");
    fake::pump(&mut app, &mut rx, |_| fake.called(STOP_RPC).len() == 3).await;
    assert_eq!(
        fake.called(STOP_RPC),
        [
            json!({"leadThreadId": "lead"}),
            json!({"leadThreadId": "lead"}),
            json!({"leadThreadId": "lead", "taskId": "task-9"}),
        ]
    );
    assert_eq!(stopped_count(&json!({"stopped": ["a", "b"]})), 2);
    assert_eq!(stopped_count(&Value::Null), 0);
    assert_eq!(
        stopping_count(&json!({"stopped": [], "stopping": ["a"]})),
        1
    );
    assert_eq!(stopping_count(&json!({"stopped": []})), 0);
}

#[tokio::test]
async fn crew_stop_needs_a_server_that_serves_it() {
    let (fake, mut app, _rx) = connected_on_lead().await;
    run(&mut app, "stop");
    assert!(
        notes(&app).contains(text("session.c.crewStopUnsupported")),
        "{}",
        notes(&app)
    );
    assert!(fake.called(STOP_RPC).is_empty());
}

#[tokio::test]
async fn a_screen_key_carries_out_what_it_asks_and_closes_when_it_leaves() {
    let (fake, mut app, _rx) = connected_on_lead().await;
    run(&mut app, "");
    let mut screen = app.screen.take().unwrap();
    assert!(
        !screen.key(key(KeyCode::Enter), &mut app),
        "the toggle keeps the screen open"
    );
    assert_eq!(server_stores_the_crew(&mut app)["enabled"], true);
    assert!(fake.called(UPDATE_SETTINGS).is_empty());
    assert!(
        screen.key(key(KeyCode::Esc), &mut app),
        "Esc on the main screen closes it"
    );
}
