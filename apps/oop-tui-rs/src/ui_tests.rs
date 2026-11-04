use super::*;
use crate::app::Msg;
use crate::theme;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
};
use serde_json::{Value, json};
use tokio::sync::mpsc::unbounded_channel;

fn screen(app: &App, w: u16, h: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal.draw(|f| draw(f, app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    // A wide character fills two cells; the second holds no symbol of its own, so skip it.
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

fn press(app: &mut App, code: KeyCode) {
    app.handle(Msg::Term(Event::Key(KeyEvent {
        code,
        modifiers: KeyModifiers::NONE,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    })));
}

fn open_conversation() -> App {
    let (tx, _rx) = unbounded_channel();
    let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
    app.last_model_path = std::env::temp_dir().join("oop-rs-ui-none/last-model.json");
    app.handle(Msg::Shell(json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
        "projects": [{"id": "p", "title": "demo", "workspaceRoot": "/Users/x/demo"}],
        "threads": [{"id": "t", "projectId": "p", "title": "안녕 스레드", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}})));
    app.handle(Msg::Link(LinkStatus::Online));
    app.active = Active::Thread("t".into());
    app.conv = crate::state::Conversation::new("t");
    load(
        &mut app,
        json!([
        {"id": "u", "role": "user", "text": "안녕하세요 반갑습니다", "streaming": false, "createdAt": "2026-01-01T00:00:01.000Z"},
        {"id": "a", "role": "assistant", "text": "Hello there, 세계!", "streaming": false, "createdAt": "2026-01-01T00:00:02.000Z"}]),
    );
    app
}

/// The conversation with both side columns closed, so the header has the whole width.
fn header_only() -> App {
    let mut app = open_conversation();
    app.settings.sidebar = false;
    app.side_open = false;
    app
}

fn load(app: &mut App, messages: Value) {
    app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 2, "thread": {"title": "안녕 스레드",
        "modelSelection": {"instanceId": "codex", "model": "gpt"}, "messages": messages}}}));
}

/// The text of `row` from column `x` on.
fn from_column(row: &str, x: usize) -> String {
    row.chars().skip(x).collect()
}

#[test]
fn the_header_sits_in_the_middle_column_between_the_list_and_the_panel() {
    let mut app = open_conversation();
    app.side_open = true;
    app.settings.pet = false;
    let rows = screen(&app, 140, 40);
    // 140 columns: the list is 35 wide, the panel 46, and the middle column the rest.
    let (list_w, side_w) = (35, 46);
    assert!(
        !rows[0].chars().take(list_w).any(|c| c == '▄'),
        "{}",
        rows[0]
    );
    assert!(
        from_column(&rows[0], list_w).starts_with(WORDMARK[0]),
        "{}",
        rows[0]
    );
    assert!(from_column(&rows[3], list_w).starts_with(WORDMARK[3]));
    assert!(rows[0].contains("OOP Terminal v9.9.9"), "{}", rows[0]);
    assert!(rows[2].contains("codex/gpt"), "{}", rows[2]);
    assert!(
        from_column(&rows[7], list_w).starts_with(tr("header.tip")),
        "{}",
        rows[7]
    );
    assert!(from_column(&rows[8], list_w).starts_with('─'));
    // the list runs the full height on the left, from the first row
    assert!(
        rows[0].starts_with(&format!(" {}", tr("list.projects"))),
        "{}",
        rows[0]
    );
    assert!(rows[1].contains(tr("list.new")), "{:?}", &rows[..4]);
    assert!(
        rows.iter()
            .any(|r| r.starts_with("▸") && r.contains("안녕 스레드")),
        "{rows:#?}"
    );
    // neither side column holds a piece of the header: the rule ends at the panel's edge
    let rule: String = from_column(&rows[8], list_w)
        .chars()
        .take_while(|c| *c == '─')
        .collect();
    assert_eq!(
        rule.chars().count(),
        140 - list_w - side_w - 1,
        "{}",
        rows[8]
    );
    // the status line is one row across all three
    assert!(width(rows[39].trim_end()) > 0 && !rows[38].is_empty());
}

#[test]
fn the_header_uses_the_lavender_gradient_and_no_magenta() {
    let app = header_only();
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(1, 0)].fg, app.theme.gradient[0]);
    assert_eq!(buffer[(1, 1)].fg, app.theme.gradient[1]);
    let magenta = buffer.content().iter().any(|c| {
        matches!(
            c.fg,
            ratatui::style::Color::Magenta | ratatui::style::Color::LightMagenta
        )
    });
    assert!(!magenta);
}

#[test]
fn user_text_is_right_aligned_and_assistant_text_is_left() {
    let mut app = open_conversation();
    app.side_open = false;
    let rows = screen(&app, 140, 40);
    let user = rows
        .iter()
        .find(|r| r.contains("안녕하세요 반갑습니다"))
        .expect("user line");
    let assistant = rows
        .iter()
        .find(|r| r.contains("Hello there"))
        .expect("assistant line");
    let user_end = width(user.trim_end());
    assert!(
        user_end >= 138 && user.trim_end().ends_with('│'),
        "user plate ends at the right edge: {user_end} cells"
    );
    let left = width(&user[..user.find("안녕하세요").unwrap()]);
    assert!(
        left > 70,
        "user text starts in the right half: column {left}"
    );
    let col = width(&assistant[..assistant.find("●").unwrap()]);
    assert!(
        (35..40).contains(&col),
        "assistant text starts at the pane's left edge: column {col}"
    );
}

#[test]
fn user_text_has_its_own_colour() {
    let app = open_conversation();
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    let cell = (0..40u16)
        .flat_map(|y| (0..140u16).map(move |x| (x, y)))
        .find(|(x, y)| buffer[(*x, *y)].symbol() == "반")
        .expect("cell");
    assert_eq!(buffer[cell].fg, app.theme.user_fg);
    assert_eq!(buffer[cell].bg, app.theme.user_bg);
}

/// The cell of the first `symbol` on a drawn screen.
fn find_cell(app: &App, symbol: &str) -> ratatui::buffer::Cell {
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, app)).unwrap();
    let buffer = terminal.backend().buffer();
    (0..40u16)
        .flat_map(|y| (0..140u16).map(move |x| (x, y)))
        .map(|at| buffer[at].clone())
        .find(|cell| cell.symbol() == symbol)
        .unwrap_or_else(|| panic!("{symbol} is not on the screen"))
}

#[test]
fn the_user_box_and_the_composer_follow_a_theme_change_at_once() {
    let mut app = open_conversation();
    app.input.set("Zebra");
    // Drawn once, so the conversation is cached in the first theme.
    let before = find_cell(&app, "반");
    assert_eq!(before.fg, app.theme.user_fg);
    assert_eq!(find_cell(&app, "Z").fg, app.theme.user_fg);
    for name in ["oop-light", "aurora", "sunset", "colorblind"] {
        app.theme = theme::builtin(name).unwrap();
        let after = find_cell(&app, "반");
        assert_eq!(
            (after.fg, after.bg),
            (app.theme.user_fg, app.theme.user_bg),
            "{name}: the message is redrawn in the new theme"
        );
        assert_ne!(after.fg, before.fg, "{name}");
        assert_eq!(
            find_cell(&app, "Z").fg,
            app.theme.user_fg,
            "{name}: composer"
        );
    }
    // And at 256 colours the folded theme is what shows.
    app.theme = theme::builtin("sunset").unwrap().for_level(2);
    assert_eq!(find_cell(&app, "반").fg, app.theme.user_fg);
    assert!(matches!(
        find_cell(&app, "반").fg,
        ratatui::style::Color::Indexed(_)
    ));
}

#[test]
fn replies_render_markdown_with_code_plates() {
    let mut app = open_conversation();
    load(
        &mut app,
        json!([{"id": "a", "role": "assistant", "streaming": false, "createdAt": "2026-01-01T00:00:02.000Z",
        "text": "## Plan\n- **one** thing\n```rust\nfn main() {}\n```"}]),
    );
    let rows = screen(&app, 140, 40);
    assert!(
        rows.iter().any(|r| r.contains("Plan")) && rows.iter().any(|r| r.contains("• one thing"))
    );
    let code_row = rows
        .iter()
        .position(|r| r.contains("fn main() {}"))
        .expect("code row");
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    let row = &rows[code_row];
    let x = width(&row[..row.find("fn").unwrap()]) as u16;
    assert_eq!(buffer[(x, code_row as u16)].bg, app.theme.code_bg);
    assert_eq!(buffer[(x, code_row as u16)].fg, app.theme.keyword);
}

#[test]
fn a_small_terminal_folds_the_header_to_one_line_and_hides_the_list() {
    let app = open_conversation();
    let rows = screen(&app, 50, 20);
    assert!(rows[0].contains("OOP v9.9.9") && !rows[0].contains("██  ██"));
    assert!(!rows.iter().any(|r| r.contains(tr("list.new"))));
}

#[test]
fn settings_choose_the_header_and_the_symbols() {
    let mut app = open_conversation();
    app.configure(
        Settings {
            banner: false,
            sidebar: false,
            ascii: true,
            ..Settings::default()
        },
        vec![],
    );
    let rows = screen(&app, 140, 40);
    assert!(rows[0].contains("OOP v9.9.9") && !rows.iter().any(|r| r.contains('█')));
    assert!(
        !rows.iter().any(|r| r.contains(tr("list.new"))),
        "the list is off"
    );
    assert!(
        rows.iter().any(|r| r.contains("* Hello there")),
        "ascii bullet"
    );
    app.configure(
        Settings {
            status_line: "minimal".into(),
            ..Settings::default()
        },
        vec![],
    );
    assert!(
        !screen(&app, 140, 40)[0].contains("codex"),
        "minimal drops the model"
    );
}

#[test]
fn wide_characters_never_overflow_a_narrow_pane() {
    let app = open_conversation();
    for line in app.transcript(12).lines.iter() {
        let cells: usize = line.spans.iter().map(|s| width(&s.content)).sum();
        assert!(cells <= 12, "{cells} cells: {line:?}");
    }
}

#[test]
fn a_note_shows_even_when_no_thread_is_open() {
    let (tx, _rx) = unbounded_channel();
    let mut app = App::new("9.9.9", "/Users/x/demo", "/Users/x", tx);
    app.say(
        crate::notes::Tone::Warning,
        "the update feed did not answer",
    );
    let rows = screen(&app, 120, 30);
    assert!(
        rows.iter()
            .any(|r| r.contains("the update feed did not answer"))
    );
    assert!(rows.iter().any(|r| r.contains(tr("conv.pick"))));
}

#[test]
fn a_failed_session_shows_its_error_in_the_conversation() {
    let mut app = open_conversation();
    app.conv.apply(
        &json!({"kind": "event", "event": {"sequence": 3, "type": "thread.session-set",
        "payload": {"session": {"status": "error", "lastError": "Provider is not signed in"}}}}),
    );
    let rows = screen(&app, 140, 40);
    assert!(
        rows.iter()
            .any(|r| r.contains("✗  Provider is not signed in"))
    );
    assert!(rows[4].contains(tr("state.error")), "{:#?}", &rows[..6]);
}

#[test]
fn the_error_is_said_once_when_the_activity_already_says_it() {
    let mut app = open_conversation();
    let long = "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine.";
    app.conv.apply(
        &json!({"kind": "event", "event": {"sequence": 3, "type": "thread.session-set",
        "payload": {"session": {"status": "error", "lastError": long}}}}),
    );
    app.conv.apply(&json!({"kind": "event", "event": {"sequence": 4, "type": "thread.activity-appended", "payload": {"activity": {
        "id": "e", "tone": "error", "kind": "runtime.error", "summary": "Runtime error", "createdAt": "2026-01-01T00:00:03.000Z",
        "payload": {"message": "Claude could not authenticate. For subscription login, run `claude auth login` on this env..."}}}}}));
    let rows = screen(&app, 140, 40);
    let says = rows
        .iter()
        .filter(|r| r.contains("Claude could not"))
        .count();
    assert_eq!(says, 1, "{rows:#?}");
}

#[test]
fn user_text_sits_in_a_rounded_box_and_the_header_names_no_server() {
    let mut app = open_conversation();
    app.server = Some("127.0.0.1:4873".into());
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains('╭') && r.contains('╮')));
    assert!(rows.iter().any(|r| r.contains("│ 안녕하세요 반갑습니다")));
    assert!(rows.iter().any(|r| r.contains('╰') && r.contains('╯')));
    assert!(
        !rows
            .iter()
            .any(|r| r.contains("127.0.0.1") || r.contains("4873")),
        "no address on the screen"
    );
    app.settings.ascii = true;
    app.sym = crate::theme::Symbols::pick(true);
    // another pane width, so the conversation is built again with the new symbols
    let rows = screen(&app, 150, 40);
    assert!(rows.iter().any(|r| r.contains("+--")), "{rows:#?}");
    assert!(rows.iter().any(|r| r.contains("| 안녕하세요")));
}

/// A server config with one provider, signed in the way `auth` says.
fn with_provider(app: &mut App, auth: Value) {
    app.config = json!({"settings": {"crew": {"enabled": false}}, "providers": [
        {"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
         "installed": true, "status": "ready", "auth": auth,
         "models": [{"slug": "gpt", "name": "GPT", "isDefault": true}]}]});
}

fn width_of(row: &str) -> usize {
    width(row)
}

#[test]
fn the_box_names_provider_model_auth_folder_and_crew_one_to_a_row() {
    let mut app = header_only();
    with_provider(
        &mut app,
        json!({"status": "authenticated", "type": "chatgpt", "email": "me@example.com",
            "label": "ChatGPT Plus Subscription"}),
    );
    let rows = screen(&app, 140, 40);
    assert!(rows[0].contains("OOP Terminal v9.9.9") && rows[0].contains(crate::i18n::TAGLINE));
    for (row, label, value) in [
        (1, "header.provider", "Codex"),
        (2, "header.model", "codex/gpt"),
        (3, "header.auth", "Subscription"),
        (4, "header.folder", "~/demo"),
        (5, "header.crew", tr("header.crewOff")),
    ] {
        let at = rows[row].find(tr(label)).unwrap_or(usize::MAX);
        assert!(at < usize::MAX, "{label} in {}", rows[row]);
        assert!(rows[row][at..].contains(value), "{value} in {}", rows[row]);
    }
    assert!(rows[3].contains("ChatGPT Plus Subscription"));
    // a public screen: the account's e-mail is never drawn
    assert!(!rows.iter().any(|r| r.contains("me@example.com")));
    // the state and the mode moved under the wordmark; no thread title, no address
    assert!(rows[4].starts_with("● ") && rows[5].starts_with(tr("mode.full-access")));
    assert!(!rows[..9].iter().any(|r| r.contains("안녕 스레드")));
    assert!(rows[0].contains('╭') && rows[6].contains('╰'));
}

#[test]
fn auth_comes_from_the_providers_own_record_and_is_never_guessed() {
    let mut app = open_conversation();
    let kind = |app: &mut App, auth: Value| {
        with_provider(app, auth);
        app.auth_kind()
    };
    use crate::app::AuthKind::*;
    assert_eq!(
        kind(
            &mut app,
            json!({"status": "authenticated", "type": "apiKey", "label": "Claude API Key"})
        ),
        ApiKey
    );
    assert_eq!(
        kind(
            &mut app,
            json!({"status": "authenticated", "type": "max", "label": "Claude Max Subscription"})
        ),
        Subscription(Some("Claude Max Subscription".into()))
    );
    assert_eq!(
        kind(
            &mut app,
            json!({"status": "authenticated", "type": "chatgpt"})
        ),
        Subscription(None)
    );
    assert_eq!(
        kind(
            &mut app,
            json!({"status": "authenticated", "type": "bedrock", "label": "Amazon Bedrock"})
        ),
        Other("Amazon Bedrock".into())
    );
    assert_eq!(
        kind(&mut app, json!({"status": "unauthenticated"})),
        SignedOut
    );
    // the server does not say: stated as unknown, not as one of the two
    assert_eq!(kind(&mut app, json!({"status": "unknown"})), Unknown);
    assert_eq!(kind(&mut app, json!({"status": "authenticated"})), Unknown);
    // no provider record for the model on screen
    app.config = json!({"providers": []});
    assert_eq!(app.auth_kind(), Unknown);
    let rows = screen(&app, 140, 40);
    assert!(rows[3].contains(tr("auth.unknown")), "{}", rows[3]);
}

#[test]
fn the_header_degrades_in_steps_and_never_overflows_the_screen() {
    let mut app = header_only();
    app.pet_clock = Some(1_000_000);
    for ascii in [false, true] {
        app.settings.ascii = ascii;
        app.sym = crate::theme::Symbols::pick(ascii);
        for w in 40..=200u16 {
            let rows = screen(&app, w, 40);
            for (y, row) in rows.iter().enumerate() {
                assert!(width_of(row) <= usize::from(w), "{w}x{y}: {row:?}");
            }
            // with a box: nine rows, the tip under it, then the rule; without: seven
            let tip_row = rows
                .iter()
                .position(|r| r.starts_with(tr("header.tip")))
                .expect("a tip");
            assert!(tip_row == 7 || tip_row == 5, "{w}: {:#?}", &rows[..9]);
            assert!(
                rows[tip_row + 1]
                    .chars()
                    .next()
                    .is_some_and(|c| c == '─' || c == '-'),
                "{w}"
            );
            assert_eq!(tip_row == 7, w >= 42, "{w}: the box shows from 42 columns");
        }
    }
    app.settings.ascii = false;
    app.sym = crate::theme::Symbols::pick(false);
    // labels and tagline, then values alone, then no box and the facts back beside the wordmark
    let rows = screen(&app, 100, 40);
    assert!(rows[1].contains(tr("header.provider")));
    let rows = screen(&app, 56, 40);
    assert!(rows[0].contains("OOP v9.9.9 ─") && !rows[1].contains(tr("header.provider")));
    let rows = screen(&app, 40, 40);
    assert!(
        !rows[0].contains('╭') && rows[0].contains("OOP v9.9.9"),
        "{}",
        rows[0]
    );
    assert!(rows[4].contains(tr("header.folder")) && rows[2].contains("codex/gpt"));
}

#[test]
fn long_values_are_cut_and_a_folder_from_the_left() {
    assert_eq!(truncate_left("~/a/b/c", 20), "~/a/b/c");
    let cut = truncate_left("~/projects/客户/very-long-name", 12);
    assert!(
        cut.starts_with('…') && cut.ends_with("long-name") && width(&cut) <= 12,
        "{cut}"
    );
    assert_eq!(truncate_left("abc", 0), "");
    // a wide character that does not fit is dropped whole
    assert!(width(&truncate_left("가나다라마바", 8)) <= 8);

    let mut app = open_conversation();
    let long = "/Users/x/work/아주-긴-폴더-이름/그리고-더-깊은/하위/프로젝트-루트";
    app.shell.projects[0].workspace_root = long.into();
    let rows = screen(&app, 100, 40);
    let folder = rows
        .iter()
        .find(|r| r.contains(tr("header.folder")))
        .unwrap();
    assert!(
        folder.contains("…") && folder.contains("프로젝트-루트"),
        "{folder}"
    );
    assert!(!folder.contains("/Users/x/work"), "{folder}");
    // the draft of a project works in the project's folder, a worktree wins over it
    app.shell.threads[0].worktree_path = Some("/tmp/wt".into());
    app.conv.thread.worktree_path = None;
    assert_eq!(app.workdir(), "/tmp/wt");
    app.shell.threads[0].worktree_path = None;
    assert_eq!(app.workdir(), long);
    app.active = Active::None;
    assert_eq!(app.workdir(), "/Users/x/demo");
}

#[test]
fn the_header_folder_follows_the_open_thread() {
    let mut app = open_conversation();
    app.home = "/Users/x".into();
    // an empty worktree path does not hide the project's folder
    app.shell.threads[0].worktree_path = Some(String::new());
    app.conv.thread.worktree_path = Some("  ".into());
    assert_eq!(app.workdir(), app.shell.projects[0].workspace_root);
    // a thread the shell list does not hold still gets its folder from its own record
    app.shell.threads.clear();
    app.conv.thread.project_id = app.shell.projects[0].id.clone();
    assert_eq!(app.workdir(), app.shell.projects[0].workspace_root);
    app.conv.thread.worktree_path = Some("/Users/x/wt/feature".into());
    let rows = screen(&app, 100, 40);
    let folder = rows
        .iter()
        .find(|r| r.contains(tr("header.folder")))
        .unwrap();
    assert!(folder.contains("~/wt/feature"), "{folder}");
    assert_eq!(home_relative("/Users/x", "/Users/x"), "~");
    assert_eq!(home_relative("/Users/xy/a", "/Users/x"), "/Users/xy/a");
}

#[test]
fn a_blank_candidate_is_skipped_and_cwd_is_the_last_resort() {
    use crate::app::pick_folder;
    assert_eq!(pick_folder([None, Some(""), Some("/a")], "/cwd"), "/a");
    assert_eq!(pick_folder([Some("/w"), Some("/a")], "/cwd"), "/w");
    assert_eq!(pick_folder([None, Some(" ")], "/cwd"), "/cwd");
}

#[test]
fn tips_turn_every_twenty_seconds_and_repaint_only_when_the_tip_changes() {
    let mut app = header_only();
    app.settings.animations = false;
    app.settings.pet = false;
    app.pet_clock = Some(0);
    let first = screen(&app, 140, 40)[7].clone();
    assert!(first.starts_with(tr("header.tip")));
    // nothing to repaint between two tips
    app.pet_clock = Some(19_999);
    assert!(!app.on_tick());
    assert_eq!(screen(&app, 140, 40)[7], first);
    // the boundary: one repaint, a different tip, then quiet again
    app.pet_clock = Some(20_000);
    assert!(app.on_tick());
    let second = screen(&app, 140, 40)[7].clone();
    assert_ne!(second, first);
    assert!(!app.on_tick());
    // a header that is not on screen has no tip to repaint for
    app.settings.status_line = "compact".into();
    let _ = screen(&app, 140, 40);
    app.pet_clock = Some(40_000);
    assert!(!app.on_tick());
    // the tips turn over through the whole list, the one for OOP Terminal's window only there
    for in_terminal in [false, true] {
        let count = crate::i18n::tip_count(in_terminal);
        assert_eq!(count, if in_terminal { 18 } else { 17 });
        let seen: std::collections::HashSet<_> = (0..count)
            .map(|i| crate::i18n::tip(i, in_terminal))
            .collect();
        assert_eq!(seen.len(), count);
        assert!(seen.iter().all(|t| !t.is_empty()));
        assert_eq!(
            seen.iter()
                .any(|t| t.contains("Cmd+D") || t.contains("Cmd+D 로")),
            in_terminal
        );
    }
}

#[test]
fn a_rule_separates_the_conversation_from_the_input_across_the_main_column_only() {
    let app = open_conversation();
    let rows = screen(&app, 140, 40);
    let (top, composer) = rows
        .iter()
        .enumerate()
        .find(|(_, r)| r.contains(tr("composer.title").trim()))
        .map(|(y, r)| (y, r.clone()))
        .expect("composer");
    let cols = |row: &str, pick: fn(&char) -> bool| -> (usize, usize) {
        let at: Vec<usize> = row
            .chars()
            .enumerate()
            .filter(|(_, c)| pick(c))
            .map(|(i, _)| i)
            .collect();
        (at[0], *at.last().unwrap())
    };
    let (left, right) = cols(&composer, |c| *c == '┌' || *c == '┐');
    let rule = &rows[top - 1];
    let (rule_left, rule_right) = cols(rule, |c| *c == '─');
    // it starts where the main column does (after the list) and stops where it ends (before the panel)
    assert!(
        rule_left == left && rule_right >= right - 1 && rule_left > 10,
        "{rule:?}"
    );
    assert!(
        rule.chars()
            .skip(rule_left)
            .take(right - left)
            .all(|c| c == '─'),
        "{rule:?}"
    );
    // a tiny screen keeps its room for the conversation
    let rows = screen(&app, 140, 12);
    assert!(rows.iter().any(|r| r.contains(tr("composer.title").trim())));
}

#[test]
fn the_window_title_is_the_products_line_and_never_a_threads_name() {
    let mut app = open_conversation();
    assert_eq!(
        app.window_title(),
        "OOP — One desktop for every coding agent"
    );
    // while a turn runs, the brand mark leads
    load(
        &mut app,
        json!([{"id": "a", "role": "assistant", "text": "Wri", "streaming": true,
            "createdAt": "2026-01-01T00:00:02.000Z"}]),
    );
    assert_eq!(app.state_key(), "state.working");
    assert_eq!(
        app.window_title(),
        "◆ OOP — One desktop for every coding agent"
    );
    app.settings.ascii = true;
    assert!(app.window_title().starts_with("* OOP"));
    assert!(!app.window_title().contains("안녕"));
}

#[test]
fn the_new_header_follows_the_symbol_set_and_no_colour() {
    let mut app = header_only();
    app.settings.ascii = true;
    app.sym = crate::theme::Symbols::pick(true);
    app.theme = app.theme.for_level(0);
    let rows = screen(&app, 120, 40);
    assert!(
        rows[0].contains("+- OOP Terminal v9.9.9") && rows[6].contains("+-"),
        "{rows:#?}"
    );
    assert!(rows[1].contains("| Provider") || rows[1].contains('|'));
    assert!(rows[8].starts_with("---"));
    assert!(rows[..9].iter().all(|r| !r.contains(['╭', '│', '─'])));
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    assert!(
        buffer
            .content()
            .iter()
            .all(|c| matches!(c.fg, ratatui::style::Color::Reset))
    );
}

#[test]
fn the_box_stays_with_no_colour() {
    let mut app = open_conversation();
    app.theme = app.theme.for_level(0);
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains('╭')) && rows.iter().any(|r| r.contains('╰')));
}

#[test]
fn mocha_stands_in_the_header_and_the_mini_one_in_the_short_header() {
    let mut app = header_only();
    app.pet_clock = Some(1_000_000);
    let blocks = |row: &str| row.contains(['▀', '▄', '█']);
    // Five rows: the wordmark's four and the state row, whose text stops before her.
    let rows = screen(&app, 140, 40);
    assert!(
        blocks(&rows[4]) && rows[4].contains(tr("state.idle")),
        "{:#?}",
        &rows[..6]
    );
    assert!(!blocks(&rows[5]) && !blocks(&rows[6]), "{:#?}", &rows[..7]);
    for row in &rows[..5] {
        assert!(row.trim_end().ends_with(['▀', '▄', '█']) || blocks(&row[row.len() - 24..]));
    }
    let rows = screen(&app, 90, 20);
    assert!(
        rows[0].contains("OOP v9.9.9") && blocks(&rows[0]),
        "{}",
        rows[0]
    );
    // no room for her five rows beside the box: her one-line form stands on the first row
    let rows = screen(&app, 60, 40);
    assert!(blocks(&rows[0]) && !blocks(&rows[4]), "{:#?}", &rows[..5]);
    app.settings.pet = false;
    let rows = screen(&app, 140, 40);
    assert!(!blocks(&rows[4]), "{:#?}", &rows[..5]);
}

/// The column the pet's body reaches furthest right on the header's third row, per clock value.
fn pet_reach(app: &mut App, columns: u16, clocks: impl Iterator<Item = i64>) -> Vec<usize> {
    clocks
        .map(|now| {
            app.pet_clock = Some(now);
            let rows = screen(app, columns, 40);
            assert!(
                rows[..5].iter().all(|r| width(r) <= usize::from(columns)),
                "{rows:#?}"
            );
            rows[2]
                .chars()
                .enumerate()
                .filter(|(_, c)| ['▀', '▄', '█'].contains(c))
                .map(|(i, _)| i)
                .max()
                .unwrap_or(0)
        })
        .collect()
}

/// The cell furthest right on the header's rule that is not rule, within the middle column:
/// where the one-line pet stands when she walks the rule, per clock value.
fn rule_reach(app: &mut App, columns: u16, clocks: impl Iterator<Item = i64>) -> Vec<usize> {
    let (_, _, middle) = split_columns(app, Rect::new(0, 0, columns, 40));
    clocks
        .map(|now| {
            app.pet_clock = Some(now);
            let rows = screen(app, columns, 40);
            assert!(
                rows[..9].iter().all(|r| width(r) <= usize::from(columns)),
                "{rows:#?}"
            );
            let tip = rows
                .iter()
                .position(|r| r.contains(tr("header.tip")))
                .unwrap();
            rows[tip + 1]
                .chars()
                .enumerate()
                .filter(|(i, c)| {
                    (usize::from(middle.x)..usize::from(middle.right())).contains(i)
                        && !['─', ' '].contains(c)
                })
                .map(|(i, _)| i)
                .max()
                .unwrap_or(0)
        })
        .collect()
}

/// How far the pet's picture travels over `clocks`: beside the box when the header's column
/// leaves her her whole walk there, else along the rule.
fn pet_travel(app: &mut App, columns: u16, clocks: impl Iterator<Item = i64>) -> usize {
    let (_, _, middle) = split_columns(app, Rect::new(0, 0, columns, 40));
    let beside =
        usize::from(middle.width) >= BOX_X + BOX_FULL_MIN + pet::PET_TRACK_WIDTH + pet::ROAM_MAX;
    let reach = if beside {
        pet_reach(app, columns, clocks)
    } else {
        rule_reach(app, columns, clocks)
    };
    reach.iter().max().unwrap() - reach.iter().min().unwrap()
}

#[test]
fn a_working_pet_paces_the_room_the_header_gives_her_and_an_idle_one_stays_put() {
    let clocks = || (0..60).map(|k| k * 250);
    let mut panes = open_conversation();
    let mut only = header_only();
    // Quiet: whatever the width, the picture does not travel.
    for columns in [200, 140, 120, 100, 80] {
        for app in [&mut panes, &mut only] {
            let idle = pet_travel(app, columns, clocks());
            assert!(idle <= 1, "{columns}: {idle}");
        }
    }
    for app in [&mut panes, &mut only] {
        load(
            app,
            json!([{"id": "a", "role": "assistant", "text": "Wri", "streaming": true,
                "createdAt": "2026-01-01T00:00:02.000Z"}]),
        );
        assert_eq!(app.state_key(), "state.working");
    }
    // Working, panes closed: she walks `ROAM_MAX` cells, beside the box where it leaves her
    // the room and along the rule where it does not. She is never drawn past the screen's
    // edge (checked in the helpers).
    for columns in [200, 140, 120, 100, 85, 84, 80, 73, 72, 60, 40] {
        let travelled = pet_travel(&mut only, columns, clocks());
        assert!(
            travelled + 1 >= pet::ROAM_MAX && travelled <= pet::ROAM_MAX + 1,
            "{columns}: panes closed, travelled {travelled}"
        );
    }
    // Working, both side columns open (the default): the header's column is narrow, and she
    // still walks visibly, and no less with more room.
    let mut least = 0;
    for columns in [120, 130, 140, 160, 180, 200] {
        let travelled = pet_travel(&mut panes, columns, clocks());
        assert!(
            travelled >= 8 && travelled + 1 >= least,
            "{columns}: panes open, travelled {travelled}"
        );
        least = travelled;
    }
    // With animations off she stands still, on the rule and beside the box alike.
    panes.settings.animations = false;
    only.settings.animations = false;
    for columns in [140, 200] {
        let still = pet_travel(&mut panes, columns, (0..20).map(|k| k * 250));
        assert!(still <= 1, "{columns}: {still}");
    }
    let still = pet_travel(&mut only, 140, (0..20).map(|k| k * 250));
    assert!(still <= 1, "{still}");
}

#[test]
fn a_click_on_a_row_of_the_folder_list_picks_it_and_one_beside_it_does_not() {
    use ratatui::crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let mut app = open_conversation();
    app.handle(Msg::Shell(
        json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 3,
        "projects": [
            {"id": "p", "title": "demo", "workspaceRoot": "/Users/x/demo"},
            {"id": "p2", "title": "other", "workspaceRoot": "/Users/x/other"}],
        "threads": []}}),
    ));
    let click = |app: &mut App, column: u16, row: u16| {
        app.handle(Msg::Term(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })));
    };
    app.new_thread();
    let rows = screen(&app, 140, 40);
    let (rect, hits) = app.modal_hits.borrow().clone();
    assert_eq!(hits.len(), 3, "{rows:#?}");
    let at = |i: usize| hits.iter().find(|(_, index)| *index == i).unwrap().0;
    assert!(rows[usize::from(at(1))].contains("other"), "{rows:#?}");
    // A click outside the list is not an answer.
    click(&mut app, 0, 0);
    assert!(app.modal.is_some());
    assert_eq!(app.active, Active::Thread("t".into()));
    // A click on "other" starts the draft there.
    click(&mut app, rect.x + 3, at(1));
    assert!(app.modal.is_none());
    assert_eq!(app.active, Active::Draft("p2".into()));
}

#[test]
fn the_crew_line_follows_the_roles_and_is_absent_with_the_crew_off() {
    let mut app = header_only();
    let provider = json!({"instanceId": "codex", "driver": "codex", "displayName": "Codex", "enabled": true,
        "installed": true, "status": "ready", "auth": {"status": "authenticated"},
        "models": [{"slug": "gpt", "name": "GPT", "isDefault": true}]});
    app.config = json!({"settings": {"crew": {"enabled": true}}, "providers": [provider]});
    let rows = screen(&app, 140, 40);
    let crew = rows
        .iter()
        .find(|r| r.contains(tr("header.crew")))
        .expect("crew line");
    assert!(crew.contains("worker") && crew.contains("expert") && crew.contains("auditor"));
    // narrower: letters instead of words
    let rows = screen(&app, 60, 40);
    assert!(
        rows.iter()
            .any(|r| r.contains(tr("header.crew")) && r.contains("w GPT")),
        "{rows:#?}"
    );
    // the crew off is said plainly, not left out
    app.config = json!({"settings": {"crew": {"enabled": false}}, "providers": []});
    let rows = screen(&app, 140, 40);
    assert!(
        rows.iter()
            .any(|r| r.contains(tr("header.crew")) && r.contains(tr("header.crewOff"))),
        "{rows:#?}"
    );
    assert!(!rows.iter().any(|r| r.contains("worker")));
}

#[test]
fn the_panel_opens_on_the_right_and_gives_way_to_the_list_on_a_medium_screen() {
    let mut app = open_conversation();
    let rows = screen(&app, 140, 40);
    assert!(
        rows.iter()
            .any(|r| r.contains("Workflow") && r.contains("Agents"))
    );
    assert!(
        rows.iter().any(|r| r.contains(tr("list.projects"))),
        "the list stays"
    );
    // 100 columns: one side slot
    let rows = screen(&app, 100, 40);
    assert!(rows.iter().any(|r| r.contains("Workflow")));
    assert!(!rows.iter().any(|r| r.contains(tr("list.projects"))));
    press(&mut app, KeyCode::Tab);
    let rows = screen(&app, 100, 40);
    assert!(rows.iter().any(|r| r.contains(tr("list.projects"))));
    assert!(!rows.iter().any(|r| r.contains("Workflow")));
}

fn mouse(app: &mut App, kind: ratatui::crossterm::event::MouseEventKind, x: u16, y: u16) {
    app.handle(Msg::Term(Event::Mouse(
        ratatui::crossterm::event::MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        },
    )));
}

/// The screen cell of the first glyph of `needle` in the drawn rows.
fn cell_of(rows: &[String], needle: &str) -> (u16, u16) {
    let y = rows.iter().position(|r| r.contains(needle)).expect("row");
    let x = width(&rows[y][..rows[y].find(needle).unwrap()]);
    (x as u16, y as u16)
}

#[test]
fn dragging_over_boxed_text_copies_the_text_without_the_border() {
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    let mut app = open_conversation();
    app.side_open = false;
    let rows = screen(&app, 140, 40);
    let (x, y) = cell_of(&rows, "안녕하세요");
    let (end_x, _) = cell_of(&rows, "반갑습니다");
    // from the box's left border to its right border: the border is not text
    let left = x - 2;
    let right = end_x + 12 + 2;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), left, y);
    mouse(&mut app, MouseEventKind::Drag(MouseButton::Left), right, y);
    assert!(
        app.take_copy().is_none(),
        "nothing is copied while the button is down"
    );
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), right, y);
    let job = app.take_copy().expect("a copy on release");
    assert_eq!(job.text, "안녕하세요 반갑습니다");
    assert!(
        job.osc52
            .as_deref()
            .is_some_and(|s| s.starts_with("\u{1b}]52;c;") || s.starts_with("\u{1b}Ptmux;"))
    );
    // the selected cells are drawn reversed, the border is not
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    assert!(buffer[(x, y)].modifier.contains(Modifier::REVERSED));
    assert!(!buffer[(left, y)].modifier.contains(Modifier::REVERSED));
    // a key press puts the highlight away
    press(&mut app, KeyCode::Char('x'));
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|f| draw(f, &app)).unwrap();
    assert!(
        !terminal.backend().buffer()[(x, y)]
            .modifier
            .contains(Modifier::REVERSED)
    );
}

#[test]
fn a_click_copies_nothing_and_a_click_on_a_list_row_opens_it() {
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    let mut app = open_conversation();
    let rows = screen(&app, 140, 40);
    let (x, y) = cell_of(&rows, "안녕하세요");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), x, y);
    assert!(app.take_copy().is_none());
    // the list row of the thread (not the conversation)
    let (lx, ly) = cell_of(&rows, "안녕 스레드");
    app.active = Active::None;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), lx, ly);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), lx, ly);
    assert_eq!(app.active, Active::Thread("t".into()));
}

#[test]
fn wrapped_text_is_copied_as_the_line_that_was_typed() {
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    let mut app = open_conversation();
    app.side_open = false;
    load(
        &mut app,
        json!([{"id": "u", "role": "user", "text": "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma", "streaming": false,
        "createdAt": "2026-01-01T00:00:01.000Z"}]),
    );
    let rows = screen(&app, 70, 30);
    let (x, y) = cell_of(&rows, "alpha");
    let last = rows.iter().rposition(|r| r.contains("sigma")).unwrap() as u16;
    let (ex, _) = cell_of(&rows[..], "sigma");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
    mouse(
        &mut app,
        MouseEventKind::Drag(MouseButton::Left),
        ex + 4,
        last,
    );
    mouse(
        &mut app,
        MouseEventKind::Up(MouseButton::Left),
        ex + 4,
        last,
    );
    let job = app.take_copy().expect("copy");
    assert_eq!(
        job.text,
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma"
    );
}

#[test]
fn slash_commands_drive_the_panel_the_pet_the_list_and_the_mouse() {
    let mut app = open_conversation();
    let run = |app: &mut App, text: &str| {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
        press(app, KeyCode::Enter);
    };
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains("Workflow")));
    run(&mut app, "/dag-workflow");
    let rows = screen(&app, 140, 40);
    assert!(
        !rows.iter().any(|r| r.contains("Workflow  ")) || !app.side_open,
        "closed"
    );
    assert!(!app.side_open);
    run(&mut app, "/dag-agents");
    assert!(app.side_open && app.side_view == crate::app::Side::Agents);
    run(&mut app, "/dag-workflow");
    assert!(app.side_open && app.side_view == crate::app::Side::Workflow);
    run(&mut app, "/dag-workflow off");
    assert!(!app.side_open);
    run(&mut app, "/pet off");
    assert!(!app.settings.pet);
    run(&mut app, "/pet");
    assert!(app.settings.pet);
    run(&mut app, "/mouse off");
    assert!(!app.mouse);
    run(&mut app, "/mouse");
    assert!(app.mouse);
    run(&mut app, "/sidebar off");
    assert!(!app.settings.sidebar);
    run(&mut app, "/sidebar on");
    run(&mut app, "/new");
    // A new thread asks for its folder first.
    assert!(matches!(app.modal, Some(crate::app::Modal::Pick(_))));
    press(&mut app, KeyCode::Enter);
    assert!(matches!(app.active, Active::Draft(_)));
    run(&mut app, "/bogus");
    assert_eq!(app.notice.as_deref(), Some(tr("notice.unknownCommand")));
}

#[test]
fn shift_tab_flips_the_panel_and_tab_still_takes_the_list() {
    use crate::app::Side;
    let mut app = open_conversation();
    screen(&app, 140, 40);
    assert_eq!(app.side_view, crate::app::Side::Workflow);
    for want in [Side::Agents, Side::Savvy, Side::Files, Side::Workflow] {
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.side_view, want);
    }
    press(&mut app, KeyCode::Tab);
    assert_eq!(app.focus, Focus::List);
    // with the list off, Tab flips the panel as well
    app.focus = Focus::Composer;
    app.settings.sidebar = false;
    screen(&app, 140, 40);
    press(&mut app, KeyCode::Tab);
    assert_eq!(app.side_view, Side::Agents);
}

#[test]
fn an_approval_replaces_the_composer_with_its_choices() {
    let mut app = open_conversation();
    app.conv.apply(&json!({"kind": "event", "event": {"sequence": 3, "type": "thread.activity-appended", "payload": {"activity": {
        "id": "a", "tone": "approval", "kind": "approval.requested", "summary": "s", "createdAt": "2026-01-01T00:00:03.000Z",
        "payload": {"requestId": "r", "requestKind": "command", "detail": "rm -rf build"}}}}}));
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains(tr("panel.approval"))));
    assert!(rows.iter().any(|r| r.contains("rm -rf build")));
    assert!(
        rows.iter()
            .any(|r| r.contains("1. ") && r.contains(tr("approval.accept")))
    );
    assert!(rows.last().unwrap().contains("1-4"));
    press(&mut app, KeyCode::Down);
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains("❯ 2.")));
}

#[test]
fn scrolling_back_shows_older_lines_and_says_how_to_return() {
    let mut app = open_conversation();
    let messages: Vec<Value> = (0..60)
        .map(|i| json!({"id": format!("m{i}"), "role": if i % 2 == 0 { "user" } else { "assistant" }, "text": format!("line number {i}"), "streaming": false, "createdAt": format!("2026-01-01T00:{:02}:00.000Z", i % 60)}))
        .collect();
    load(&mut app, Value::Array(messages));
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains("line number 59")));
    assert!(
        !rows
            .iter()
            .any(|r| r.contains("line number 0 ") || r.ends_with("line number 0"))
    );
    app.scroll_up(40);
    let rows = screen(&app, 140, 40);
    assert!(
        !rows.iter().any(|r| r.contains("line number 59")),
        "scrolled away from the end"
    );
    assert!(rows.iter().any(|r| r.contains(tr("conv.jump"))));
    app.scroll_down(1000);
    assert!(
        screen(&app, 140, 40)
            .iter()
            .any(|r| r.contains("line number 59")),
        "back at the end it follows again"
    );
}

#[test]
fn new_lines_do_not_move_what_the_reader_scrolled_to() {
    let mut app = open_conversation();
    let many = |n: usize| -> Value {
        Value::Array((0..n).map(|i| json!({"id": format!("m{i}"), "role": "assistant", "text": format!("row {i}"), "streaming": false, "createdAt": format!("2026-01-01T00:00:{:02}.000Z", i % 60)})).collect())
    };
    load(&mut app, many(50));
    screen(&app, 140, 40);
    app.scroll_up(10);
    let before = screen(&app, 140, 40);
    let target = before.iter().find(|r| r.contains("row ")).cloned().unwrap();
    app.conv.apply(&json!({"kind": "event", "event": {"sequence": 9, "type": "thread.message-sent", "payload": {
        "messageId": "new", "role": "assistant", "text": "fresh", "streaming": false, "createdAt": "2026-01-01T00:59:00.000Z"}}}));
    let after = screen(&app, 140, 40);
    assert!(
        after.contains(&target),
        "the same rows stay on screen while the reader is scrolled up"
    );
}

#[test]
fn the_list_groups_by_the_desktop_sections() {
    let mut app = open_conversation();
    app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 2, "thread": {"id": "p1", "projectId": "p", "title": "pinned one", "pinnedAt": "2026-01-01T00:00:00.000Z", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
    app.handle(Msg::Shell(json!({"kind": "thread-upserted", "sequence": 3, "thread": {"id": "s1", "projectId": "p", "title": "settled one", "settledOverride": "settled", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}})));
    let rows = screen(&app, 140, 40);
    // The header and the list share words ("Threads", the title), so look inside the list column.
    let list: Vec<&str> = rows
        .iter()
        .map(|r| r.split('│').next().unwrap_or(""))
        .collect();
    let at = |needle: &str| {
        list.iter()
            .rposition(|r| r.contains(needle))
            .unwrap_or_else(|| panic!("{needle} in {list:#?}"))
    };
    assert!(
        at(tr("list.pinned")) < at("pinned one")
            && at("pinned one") < at(tr("list.active"))
            && at(tr("list.active")) < at("안녕 스레드")
    );
    assert!(at("안녕 스레드") < at(tr("list.settled")));
    assert!(
        !rows.iter().any(|r| r.contains("settled one")),
        "shelves start closed"
    );
}

#[test]
fn the_model_picker_opens_over_the_conversation() {
    let mut app = open_conversation();
    app.config = json!({"providers": [{"instanceId": "codex", "displayName": "Codex", "enabled": true, "installed": true, "models": [{"slug": "gpt-5", "name": "GPT-5"}, {"slug": "mini", "name": "Mini"}]}]});
    app.modal = Some(Modal::Models {
        filter: String::new(),
        cursor: 1,
    });
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains(tr("picker.model"))));
    assert!(
        rows.iter().any(|r| r.contains("❯ Codex  Mini")),
        "{rows:#?}"
    );
}

use crate::settings::Settings;

// ---- the Savvy and Files views, and the bar on the composer ----

/// The open conversation with a turn running: `activities` are the thread's.
fn running_turn(activities: Value) -> App {
    let mut app = open_conversation();
    app.settings.pet = false;
    app.conv.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 3, "thread": {
        "title": "t", "modelSelection": {"instanceId": "codex", "model": "gpt"},
        "latestTurn": {"turnId": "t1", "state": "running", "requestedAt": "2026-01-01T00:00:01.000Z", "startedAt": "2026-01-01T00:00:02.000Z"},
        "session": {"status": "running", "activeTurnId": "t1"},
        "activities": activities}}}));
    app
}

fn plan_activity(done: usize, total: usize) -> Value {
    let steps: Vec<Value> = (0..total)
        .map(|i| json!({"step": format!("s{i}"), "status": if i < done { "completed" } else { "pending" }}))
        .collect();
    json!({"id": "p1", "tone": "info", "kind": "turn.plan.updated", "summary": "plan", "turnId": "t1",
        "createdAt": "2026-01-01T00:00:03.000Z", "payload": {"plan": steps}})
}

#[test]
fn savvy_and_files_open_switch_and_close_like_the_other_views() {
    use crate::app::Side;
    let mut app = open_conversation();
    let run = |app: &mut App, text: &str| {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
        press(app, KeyCode::Enter);
    };
    screen(&app, 140, 40);
    run(&mut app, "/savvy");
    assert!(app.side_open && app.side_view == Side::Savvy);
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains("Progress")), "{rows:#?}");
    run(&mut app, "/files");
    assert!(
        app.side_open && app.side_view == Side::Files,
        "switches without closing"
    );
    let rows = screen(&app, 140, 40);
    assert!(rows.iter().any(|r| r.contains("No files yet")));
    run(&mut app, "/files");
    assert!(!app.side_open, "the same command again closes it");
    run(&mut app, "/savvy on");
    assert!(app.side_open && app.side_view == Side::Savvy);
    run(&mut app, "/files off");
    assert!(
        app.side_open,
        "off for the view that is not shown closes nothing"
    );
    run(&mut app, "/savvy off");
    assert!(!app.side_open);
    run(&mut app, "/savvy 2");
    assert!(
        app.notice
            .as_deref()
            .is_some_and(|n| n.contains("Savvy panel")),
        "{:?}",
        app.notice
    );
    assert!(!app.side_open);
    run(&mut app, "/files bogus");
    assert_eq!(app.notice.as_deref(), Some("Usage: /files [on|off]"));
}

#[test]
fn a_click_on_a_tab_shows_that_view_and_a_click_below_does_nothing_to_the_panel() {
    use crate::app::Side;
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    let mut app = open_conversation();
    let rows = screen(&app, 140, 40);
    let side = app.side_rect.get();
    assert!(side.width > 0);
    let (x, y) = cell_of(&rows, "Savvy");
    assert_eq!(y, side.y, "the tab bar is the panel's first row");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x + 1, y);
    assert_eq!(app.side_view, Side::Savvy);
    let rows = screen(&app, 140, 40);
    let (x, y) = cell_of(&rows, "Files");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
    assert_eq!(app.side_view, Side::Files);
    let rows = screen(&app, 140, 40);
    let (x, y) = cell_of(&rows, "Workflow");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x + 7, y);
    assert_eq!(app.side_view, Side::Workflow);
    // the gap between two titles and the rows below the bar are no tab
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x + 9, y);
    mouse(
        &mut app,
        MouseEventKind::Down(MouseButton::Left),
        x + 1,
        y + 3,
    );
    assert_eq!(app.side_view, Side::Workflow);
    // the way out still works from every view
    for view in [Side::Savvy, Side::Files] {
        app.side_view = view;
        app.side_open = true;
        for ch in "/dag-workflow off".chars() {
            press(&mut app, KeyCode::Char(ch));
        }
        press(&mut app, KeyCode::Enter);
        assert!(app.side_open, "off for another view closes nothing");
        app.input.take(true);
        for ch in format!("{} off", view.command()).chars() {
            press(&mut app, KeyCode::Char(ch));
        }
        press(&mut app, KeyCode::Enter);
        assert!(!app.side_open, "{view:?}");
    }
}

#[test]
fn the_composer_carries_the_bar_while_a_turn_runs_and_not_when_idle() {
    let idle = open_conversation();
    let rows = screen(&idle, 100, 30);
    let border = rows
        .iter()
        .position(|r| r.contains(tr("composer.title")))
        .expect("composer");
    assert!(!rows[border].contains("/"), "{:?}", rows[border]);
    assert!(!rows[border].contains("no total"));

    let app = running_turn(json!([plan_activity(2, 5)]));
    let rows = screen(&app, 100, 30);
    let border = rows
        .iter()
        .position(|r| r.contains(tr("composer.title")))
        .expect("composer");
    assert!(rows[border].contains("2/5"), "{:?}", rows[border]);
    assert!(
        rows[border].contains('━') || rows[border].contains('='),
        "{:?}",
        rows[border]
    );
    assert!(
        rows[border].contains(tr("composer.title")),
        "the title is not covered"
    );
    assert_eq!(width(&rows[border]), 100, "the border keeps its length");

    let app = running_turn(json!([]));
    let rows = screen(&app, 100, 30);
    let border = rows
        .iter()
        .position(|r| r.contains(tr("composer.title")))
        .expect("composer");
    assert!(rows[border].contains("no total"), "{:?}", rows[border]);
    assert!(!rows[border].contains('%'));
}

#[test]
fn the_bar_fits_narrow_screens_and_leaves_the_title_alone() {
    let app = running_turn(json!([plan_activity(7, 12)]));
    for columns in [20u16, 29, 30, 40, 60, 80, 120] {
        let rows = screen(&app, columns, 24);
        for row in &rows {
            assert!(width(row) <= usize::from(columns));
        }
        if let Some(border) = rows.iter().find(|r| r.contains(tr("composer.title"))) {
            assert!(
                border.contains(tr("composer.title")),
                "{columns}: {border:?}"
            );
        }
    }
}

#[test]
fn the_wheel_scrolls_the_files_view_like_the_other_panels() {
    use crate::app::Side;
    use ratatui::crossterm::event::MouseEventKind;
    let reads: Vec<Value> = (0..60)
        .map(|i| {
            json!({"id": format!("r{i}"), "tone": "tool", "kind": "tool.completed", "summary": "Read",
            "turnId": "t1", "createdAt": "2026-01-01T00:00:04.000Z",
            "payload": {"toolCallId": format!("c{i}"), "itemType": "dynamic_tool_call", "data": {"toolName": "Read"},
            "detail": format!("Read: {{\"file_path\":\"/Users/x/demo/src/file{i:02}.rs\"}}")}})
        })
        .collect();
    let mut app = running_turn(Value::Array(reads));
    app.side_open = true;
    app.side_view = Side::Files;
    let before = screen(&app, 140, 30);
    let side = app.side_rect.get();
    mouse(&mut app, MouseEventKind::ScrollDown, side.x + 5, side.y + 6);
    assert!(app.panel_scroll.get() > 0);
    let after = screen(&app, 140, 30);
    assert_ne!(before, after, "the tree moved");
}

#[test]
fn nothing_repaints_for_the_new_views_while_idle_and_the_clock_runs_when_work_does() {
    use crate::app::Side;
    let mut app = open_conversation();
    app.settings.animations = true;
    app.settings.pet = false;
    app.pet_clock = Some(0);
    for view in [Side::Savvy, Side::Files] {
        app.side_open = true;
        app.side_view = view;
        screen(&app, 140, 40);
        assert!(!app.on_tick(), "{view:?} idle");
    }
    let mut busy = running_turn(
        json!([{"id": "e1", "tone": "tool", "kind": "tool.started", "summary": "Edit",
        "turnId": "t1", "createdAt": "2026-01-01T00:00:04.000Z",
        "payload": {"toolCallId": "c1", "itemType": "file_change", "data": {"toolName": "Edit"}, "detail": "Edit: {\"file_path\":\"/Users/x/demo/a.rs\"}"}}]),
    );
    busy.settings.animations = true;
    busy.pet_clock = Some(0);
    busy.side_open = true;
    busy.side_view = Side::Files;
    let rows = screen(&busy, 140, 40);
    assert!(rows.iter().any(|r| r.contains("●› a.rs")), "{rows:#?}");
    assert!(crate::side::is_live(&busy), "the file's tool runs");
    busy.settings.animations = false;
    assert!(!crate::side::is_live(&busy), "animations off: no pulse");
}

// ---- the three columns ----

fn chord(app: &mut App, code: KeyCode, modifiers: KeyModifiers) {
    app.handle(Msg::Term(Event::Key(KeyEvent {
        code,
        modifiers,
        kind: KeyEventKind::Press,
        state: KeyEventState::NONE,
    })));
}

/// Types a slash command into the message box and sends it.
fn run_slash(app: &mut App, text: &str) {
    app.focus = Focus::Composer;
    for ch in text.chars() {
        press(app, KeyCode::Char(ch));
    }
    press(app, KeyCode::Enter);
}

fn ctrl(app: &mut App, c: char) {
    chord(app, KeyCode::Char(c), KeyModifiers::CONTROL);
}

/// The columns for a terminal `w` x `h`, the way `draw` splits it above the status line.
fn columns(app: &App, w: u16, h: u16) -> (Option<Rect>, Option<Rect>, Rect) {
    app.width.set(w);
    split_columns(app, Rect::new(0, 0, w, h - 1))
}

fn open_panes(app: &mut App) {
    app.settings.sidebar = true;
    app.side_open = true;
}

#[test]
fn the_middle_takes_the_width_of_each_closed_side_column() {
    let mut app = open_conversation();
    for w in [120u16, 140, 200] {
        open_panes(&mut app);
        let (list, side, middle) = columns(&app, w, 40);
        let (list, side) = (list.expect("list"), side.expect("panel"));
        // the three tile the rows: no gap, no overlap, full height above the status line
        assert_eq!((list.x, list.y, list.height), (0, 0, 39), "{w}");
        assert_eq!(middle.x, list.right(), "{w}");
        assert_eq!(side.x, middle.right(), "{w}");
        assert_eq!(side.right(), w, "{w}");
        assert!(middle.height == 39 && side.height == 39, "{w}");

        app.settings.sidebar = false;
        let (none, side2, wider) = columns(&app, w, 40);
        assert!(none.is_none() && side2 == Some(side), "{w}");
        assert_eq!(
            (wider.x, wider.width),
            (0, middle.width + list.width),
            "{w}"
        );

        app.side_open = false;
        let (none, no_side, all) = columns(&app, w, 40);
        assert!(none.is_none() && no_side.is_none(), "{w}");
        assert_eq!(
            all,
            Rect::new(0, 0, w, 39),
            "both closed: the middle is the screen"
        );

        app.settings.sidebar = true;
        let (back, none, middle2) = columns(&app, w, 40);
        assert_eq!(back, Some(list), "the list comes back where it was");
        assert!(none.is_none());
        assert_eq!(middle2.width, w - list.width, "{w}");

        app.side_open = true;
        assert_eq!(
            columns(&app, w, 40),
            (Some(list), Some(side), middle),
            "{w}"
        );
    }
}

#[test]
fn narrow_terminals_keep_the_slots_they_had() {
    let mut app = open_conversation();
    open_panes(&mut app);
    // 90..120: one side column at a time; the panel has the room unless the list has the keys
    let (list, side, middle) = columns(&app, 100, 30);
    assert!(list.is_none() && side.is_some());
    assert_eq!(middle.x, 0);
    app.focus = Focus::List;
    let (list, side, middle) = columns(&app, 100, 30);
    assert!(list.is_some() && side.is_none() && middle.x == list.unwrap().right());
    app.focus = Focus::Composer;
    // 60..90: the list alone; under 60 neither
    let (list, side, _) = columns(&app, 70, 30);
    assert!(list.is_some() && side.is_none());
    let (list, side, middle) = columns(&app, 50, 30);
    assert!(list.is_none() && side.is_none());
    assert_eq!(middle, Rect::new(0, 0, 50, 29));
    // closing the panel at 100 columns gives the slot back to the list
    app.side_open = false;
    let (list, side, _) = columns(&app, 100, 30);
    assert!(list.is_some() && side.is_none());
    // and every combination draws at every size without a row past the edge
    for sidebar in [true, false] {
        for panel in [true, false] {
            app.settings.sidebar = sidebar;
            app.side_open = panel;
            for (w, h) in [
                (20, 10),
                (40, 12),
                (59, 20),
                (60, 24),
                (89, 30),
                (90, 30),
                (119, 40),
                (120, 40),
                (200, 50),
            ] {
                for row in screen(&app, w, h) {
                    assert!(
                        width(&row) <= usize::from(w),
                        "{sidebar} {panel} {w}x{h}: {row:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_logo_and_the_dividers_stay_in_the_middle_column() {
    let mut app = open_conversation();
    open_panes(&mut app);
    let rows = screen(&app, 140, 40);
    let list = app.list_hits.borrow().0;
    let side = app.side_rect.get();
    for (y, row) in rows.iter().enumerate().take(9) {
        let chars: Vec<char> = row.chars().collect();
        let left: String = chars.iter().take(usize::from(list.right())).collect();
        let right: String = chars.iter().skip(usize::from(side.x)).collect();
        for art in WORDMARK {
            let art = art.trim();
            assert!(
                !left.contains(art) && !right.contains(art),
                "{y}: {left:?} {right:?}"
            );
        }
        assert!(
            !left.contains("OOP Terminal") && !right.contains("OOP Terminal"),
            "{y}"
        );
    }
    // the rule above the composer ends at the panel as well
    let rule = rows
        .iter()
        .rposition(|r| r.contains("────────────"))
        .unwrap();
    assert!(rule > 9, "{rule}");
    // the conversation and the composer sit between the columns
    let geo = app.geo.get().area;
    assert_eq!((geo.x, geo.right()), (list.right(), side.x));
    // with the list closed the same screen starts at column 0
    app.settings.sidebar = false;
    let rows = screen(&app, 140, 40);
    assert!(rows[0].starts_with(WORDMARK[0]), "{}", rows[0]);
    assert_eq!(app.geo.get().area.x, 0);
}

#[test]
fn the_keys_and_commands_close_and_reopen_each_side_column() {
    let mut app = open_conversation();
    open_panes(&mut app);
    app.side_view = crate::app::Side::Files;
    app.panel_scroll.set(7);
    screen(&app, 140, 40);
    let shown = |app: &App| {
        screen(app, 140, 40);
        (
            app.list_hits.borrow().0.width > 0,
            app.side_rect.get().width > 0,
        )
    };
    assert_eq!(shown(&app), (true, true));
    // Ctrl-B and F2 are the list's, Ctrl-G and F3 the panel's, and each flips only its own
    ctrl(&mut app, 'b');
    assert_eq!(shown(&app), (false, true));
    assert_eq!(app.notice.as_deref(), Some(tr("notice.listOff")));
    ctrl(&mut app, 'g');
    assert_eq!(shown(&app), (false, false));
    assert_eq!(app.notice.as_deref(), Some(tr("notice.panelOff")));
    chord(&mut app, KeyCode::F(2), KeyModifiers::NONE);
    assert_eq!(shown(&app), (true, false));
    chord(&mut app, KeyCode::F(3), KeyModifiers::NONE);
    assert_eq!(shown(&app), (true, true));
    assert_eq!(
        (app.side_view, app.panel_scroll.get()),
        (crate::app::Side::Files, 7),
        "the panel comes back as it was"
    );
    // the commands set rather than flip
    run_slash(&mut app, "/sidebar off");
    run_slash(&mut app, "/sidebar off");
    assert_eq!(shown(&app), (false, true));
    run_slash(&mut app, "/panel off");
    assert_eq!(shown(&app), (false, false));
    run_slash(&mut app, "/panel on");
    run_slash(&mut app, "/sidebar on");
    assert_eq!(shown(&app), (true, true));
    run_slash(&mut app, "/panel");
    assert_eq!(shown(&app), (true, false));
    run_slash(&mut app, "/panel sideways");
    assert_eq!(app.notice.as_deref(), Some(tr("notice.panelToggleUsage")));
    // a key that is not theirs, or that has more than Ctrl, is left alone
    chord(
        &mut app,
        KeyCode::Char('b'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    );
    chord(&mut app, KeyCode::F(2), KeyModifiers::SHIFT);
    assert_eq!(shown(&app), (true, false));
}

#[test]
fn focus_leaves_a_list_that_is_closed_and_a_click_where_it_was_does_nothing() {
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    let mut app = open_conversation();
    app.side_open = false;
    screen(&app, 140, 40);
    press(&mut app, KeyCode::Tab);
    assert_eq!(app.focus, Focus::List);
    ctrl(&mut app, 'b');
    assert_eq!(app.focus, Focus::Composer, "the keys go to the message box");
    let rows = screen(&app, 140, 40);
    assert_eq!(app.list_hits.borrow().0, Rect::default());
    assert!(!rows.iter().any(|r| r.contains(tr("list.new"))));
    // the middle column starts at 0 now: a click on its first cells is the conversation's
    let (x, _) = cell_of(&rows, "Hello there");
    assert!(
        x < 35,
        "the text moved left into the room the list had: {x}"
    );
    app.active = Active::None;
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), 3, 2);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), 3, 2);
    assert_eq!(
        app.active,
        Active::None,
        "a click is not a click on a thread"
    );
    // reopened, the list takes the click again
    ctrl(&mut app, 'b');
    let rows = screen(&app, 140, 40);
    let (lx, ly) = cell_of(&rows, "안녕 스레드");
    mouse(&mut app, MouseEventKind::Down(MouseButton::Left), lx, ly);
    mouse(&mut app, MouseEventKind::Up(MouseButton::Left), lx, ly);
    assert_eq!(app.active, Active::Thread("t".into()));
}

#[test]
fn selecting_in_the_conversation_follows_the_column_it_is_in() {
    use ratatui::crossterm::event::{MouseButton, MouseEventKind};
    for sidebar in [true, false] {
        let mut app = open_conversation();
        app.side_open = false;
        app.settings.sidebar = sidebar;
        let rows = screen(&app, 140, 40);
        let (x, y) = cell_of(&rows, "Hello there");
        mouse(&mut app, MouseEventKind::Down(MouseButton::Left), x, y);
        mouse(&mut app, MouseEventKind::Drag(MouseButton::Left), x + 4, y);
        mouse(&mut app, MouseEventKind::Up(MouseButton::Left), x + 4, y);
        let job = app.take_copy().expect("copy");
        assert_eq!(job.text, "Hello", "list open: {sidebar}");
    }
}

#[test]
fn a_screen_takes_the_whole_width_and_leaves_no_stale_click_areas() {
    let mut app = open_conversation();
    open_panes(&mut app);
    screen(&app, 140, 40);
    assert!(app.side_rect.get().width > 0);
    run_slash(&mut app, "/stats");
    assert!(app.screen.is_some());
    let rows = screen(&app, 140, 40);
    assert_eq!(app.side_rect.get(), Rect::default());
    assert_eq!(app.list_hits.borrow().0, Rect::default());
    assert!(rows[0].starts_with(WORDMARK[0]), "{}", rows[0]);
}

#[test]
fn a_closed_pane_says_how_to_open_it_on_the_status_line() {
    let mut app = open_conversation();
    open_panes(&mut app);
    let status = |app: &App| screen(app, 140, 40).pop().unwrap();
    let line = status(&app);
    assert!(
        !line.contains(tr("pane.openList")) && !line.contains(tr("pane.openPanel")),
        "{line}"
    );
    app.settings.sidebar = false;
    assert!(status(&app).contains(tr("pane.openList")));
    app.side_open = false;
    let line = status(&app);
    assert!(
        line.contains(tr("pane.openList")) && line.contains(tr("pane.openPanel")),
        "{line}"
    );
    // too narrow to spare the room: the hint gives way to the line's own words
    let narrow = screen(&app, 40, 20).pop().unwrap();
    assert!(!narrow.contains(tr("pane.openPanel")), "{narrow}");
    assert!(width(&narrow) <= 40);
}

#[test]
fn the_help_names_the_keys_and_commands() {
    assert!(tr("notice.help").contains("/panel") && tr("notice.help").contains("Ctrl-B"));
    assert!(tr("hint.composer").contains("Ctrl-B/G") && tr("hint.list").contains("Ctrl-B"));
    assert!(crate::slash::COMMANDS.iter().any(|c| c.name == "panel"));
}
