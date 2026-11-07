//! `/theme`, `/update`, `/threads` (`/t`) and `/projects` (`/p`), and the update check made once at
//! start. The lists are in `lists.rs`, the release lookup in `update.rs`, the theme files in
//! `theme.rs`, and the key-preserving write of `settings.json` in `settings_write.rs`.

use crate::app::{App, Modal, Msg, Pick};
use crate::notes::Tone;
use crate::panels_common::{fill, s};
use crate::update::{self, LatestRelease, Urls};
use crate::{lists, settings_write, theme};
use serde_json::json;
use std::path::PathBuf;

/// What these commands keep between runs.
#[derive(Default)]
pub struct State {
    /// The theme in use, by name.
    pub theme_name: String,
    /// The terminal's colour level the theme is folded to.
    pub level: u8,
    /// Another config directory (tests); the real one when `None`.
    pub config_dir: Option<PathBuf>,
    pub urls: Urls,
    pub looking_up: bool,
    /// The newest release as of the last lookup.
    pub latest: Option<LatestRelease>,
    /// Look the newest release up once when the server connects (`main` turns it on).
    pub startup_check: bool,
    started: bool,
    shown: bool,
}

fn config_dir(app: &App) -> PathBuf {
    app.misc
        .config_dir
        .clone()
        .unwrap_or_else(crate::server::config_dir)
}

fn checking() -> &'static str {
    s("Checking for updates…", "업데이트 확인 중…")
}

// ---- /theme --------------------------------------------------------------------------------

/// `/theme` opens the list of themes; `/theme <name>` switches to one now and saves the choice.
pub fn theme(app: &mut App, argument: &str) {
    match argument.split_whitespace().next() {
        None => {
            let names = theme::list_names(&config_dir(app));
            let current = app.misc.theme_name.clone();
            let items = names
                .iter()
                .map(|name| {
                    if *name == current {
                        format!("{name} · {}", s("current", "현재"))
                    } else {
                        name.clone()
                    }
                })
                .collect();
            app.modal = Some(Modal::Pick(Pick {
                id: "theme",
                title: s("Pick a theme", "테마 선택").to_string(),
                cursor: names.iter().position(|n| *n == current).unwrap_or(0),
                items,
                data: names,
                typed: None,
            }));
        }
        Some(name) => apply_theme(app, name, &|key| std::env::var(key).ok()),
    }
}

pub fn theme_picked(app: &mut App, pick: &Pick, index: usize) {
    if let Some(name) = pick.data.get(index) {
        apply_theme(app, name, &|key| std::env::var(key).ok());
    }
}

/// `/usage`: shows or hides the provider usage panel (no argument toggles) and keeps the choice.
pub fn set_usage(app: &mut App, on: Option<bool>) {
    let on = on.unwrap_or(!app.settings.usage);
    app.settings.usage = on;
    let saved =
        settings_write::write_setting(&config_dir(app).join("settings.json"), "usage", json!(on));
    let said = crate::i18n::tr(if on {
        "notice.usageOn"
    } else {
        "notice.usageOff"
    });
    app.notice = Some(match saved {
        Ok(()) => said.to_string(),
        Err(error) => format!("{said} ({error})"),
    });
}

/// Failing, or saving with a caveat, is said as a notice; a plain success is the record in the
/// conversation (`applyTheme`).
fn apply_theme(app: &mut App, name: &str, env: &dyn Fn(&str) -> Option<String>) {
    let dir = config_dir(app);
    let loaded = match theme::load(name, &dir) {
        Ok(loaded) => loaded,
        Err(error) => {
            app.notice = Some(fill(
                s(
                    "{error} — run /theme to see the list.",
                    "{error} — /theme 로 목록을 확인하세요.",
                ),
                &[("error", error)],
            ));
            return;
        }
    };
    app.theme = loaded.theme.for_level(app.misc.level);
    app.misc.theme_name = name.to_string();
    let mut notes = loaded.warnings;
    match settings_write::write_setting(&dir.join("settings.json"), "theme", json!(name)) {
        Err(error) => notes.push(error),
        Ok(()) => {
            app.settings.theme = Some(name.to_string());
            if env("OOP_THEME").is_some_and(|v| theme::is_safe_name(v.trim())) {
                notes.push(
                    s(
                        "OOP_THEME takes priority, so this will not apply next time",
                        "OOP_THEME 이 우선하므로 다음 실행에는 적용되지 않습니다",
                    )
                    .to_string(),
                );
            }
        }
    }
    if !notes.is_empty() {
        app.notice = Some(fill(
            s("Theme: {name} ({notes})", "테마: {name} ({notes})"),
            &[("name", name.to_string()), ("notes", notes.join("; "))],
        ));
    }
    app.note(Tone::Done, s("Theme", "테마"), vec![name.to_string()]);
}

// ---- /update -------------------------------------------------------------------------------

/// The version the update is measured from: the app's when the server told it, else this terminal's.
fn app_version(app: &App) -> Option<String> {
    let version = app.config["environment"]["serverVersion"].as_str()?.trim();
    update::is_release_version(version).then(|| version.to_string())
}

fn in_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// `/update`: looks the newest release up again and lists what the releases after this one brought.
pub fn update(app: &mut App) {
    app.notice = Some(checking().to_string());
    if app.misc.looking_up {
        return;
    }
    app.misc.looking_up = true;
    let urls = app.misc.urls.clone();
    let cache = update::cache_path(&config_dir(app));
    let tx = app.sender();
    tokio::spawn(async move {
        let info = update::lookup(
            &urls,
            Some(&cache),
            lists::now_ms(),
            true,
            update::FETCH_TIMEOUT,
        )
        .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app: &mut App| {
            finish_update(app, info);
        })));
    });
}

fn finish_update(app: &mut App, info: Option<LatestRelease>) {
    app.misc.looking_up = false;
    if app.notice.as_deref() == Some(checking()) {
        app.notice = None;
    }
    match info {
        None => app.say(
            Tone::Error,
            s(
                "Could not check for updates. Check your network connection.",
                "업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요.",
            ),
        ),
        Some(info) => {
            app.misc.shown = true;
            let body = update_note(app, &info);
            app.misc.latest = Some(info);
            app.note(Tone::Info, s("Update", "업데이트"), body);
        }
    }
}

/// The mark in front of a highlight.
fn highlight_mark(app: &App) -> &'static str {
    if app.settings.ascii { "-" } else { "·" }
}

/// The body of the `/update` note: the verdict, each newer release with its highlights, how to
/// update, and the reinstall line when the terminal app is older than the app.
fn update_note(app: &App, info: &LatestRelease) -> Vec<String> {
    let terminal = app.version.clone();
    let app_version = app_version(app);
    let current = app_version.clone().unwrap_or_else(|| terminal.clone());
    let report = update::report_now(&current, info);
    let mut body = Vec::new();
    if report.newer {
        body.push(fill(
            s(
                "Update available: {current} → {latest}",
                "업데이트 있음: {current} → {latest}",
            ),
            &[
                ("current", current.clone()),
                ("latest", report.latest.clone()),
            ],
        ));
        let (shown, omitted) = update::listed(&report);
        for release in shown {
            body.push(update::release_title(release));
            for highlight in release.highlights.iter().take(update::LISTED_HIGHLIGHTS) {
                body.push(format!("  {} {highlight}", highlight_mark(app)));
            }
        }
        if omitted > 0 {
            body.push(fill(
                s("and {count} more release(s)", "외 {count}개 릴리스"),
                &[("count", omitted.to_string())],
            ));
        }
        body.push(String::new());
        body.push(update::update_how_to(
            update::runs_from_terminal_install(in_env),
            cfg!(windows),
        ));
    } else {
        body.push(fill(
            s(
                "You are up to date ({current}).",
                "이미 최신입니다 ({current}).",
            ),
            &[("current", current)],
        ));
    }
    push_behind(&mut body, &terminal, app_version.as_deref());
    body
}

fn push_behind(body: &mut Vec<String>, terminal: &str, app: Option<&str>) {
    if let Some(app) = app.filter(|app| update::terminal_is_behind(terminal, Some(app))) {
        body.push(String::new());
        body.push(update::terminal_behind_text(
            terminal,
            app,
            update::runs_in_desktop_app(in_env),
            update::runs_from_terminal_install(in_env),
        ));
    }
}

/// How many releases the start notice spells out; the rest are counted and left to `/update`.
const START_RELEASES: usize = 3;

/// The start notice: only when there is something to do (a newer release, or a terminal app older
/// than the app). Empty otherwise.
fn startup_note(app: &App, info: &LatestRelease) -> Vec<String> {
    let terminal = app.version.clone();
    let app_version = app_version(app);
    let current = app_version.clone().unwrap_or_else(|| terminal.clone());
    let report = update::report_now(&current, info);
    let mut body = Vec::new();
    if report.newer {
        body.push(fill(
            s(
                "Update available: {current} → {latest}",
                "업데이트 있음: {current} → {latest}",
            ),
            &[("current", current), ("latest", report.latest.clone())],
        ));
        body.push(update::update_how_to(
            update::runs_from_terminal_install(in_env),
            cfg!(windows),
        ));
        for release in report.releases.iter().take(START_RELEASES) {
            body.push(update::release_title(release));
            for highlight in release.highlights.iter().take(update::LISTED_HIGHLIGHTS) {
                body.push(format!("  {} {highlight}", highlight_mark(app)));
            }
        }
        let omitted = report.releases.len().saturating_sub(START_RELEASES);
        if omitted > 0 {
            body.push(fill(
                s(
                    "+{count} more releases — /update",
                    "외 {count}개 릴리스 — /update",
                ),
                &[("count", omitted.to_string())],
            ));
        }
    }
    push_behind(&mut body, &terminal, app_version.as_deref());
    body
}

/// The server connected: the newest release is looked up once (from the cache while it is fresh),
/// and said if there is something to do. It never holds anything up.
pub fn on_connected(app: &mut App) {
    if !app.misc.startup_check || app.misc.started {
        return;
    }
    app.misc.started = true;
    let urls = app.misc.urls.clone();
    let cache = update::cache_path(&config_dir(app));
    let tx = app.sender();
    tokio::spawn(async move {
        let info = update::lookup(
            &urls,
            Some(&cache),
            lists::now_ms(),
            false,
            update::FETCH_TIMEOUT,
        )
        .await;
        let _ = tx.send(Msg::Ext(Box::new(move |app: &mut App| {
            if let Some(info) = info {
                app.misc.latest = Some(info);
                show_startup(app);
            }
        })));
    });
}

/// The projects are known: a notice waiting for them is shown now (opening a thread clears notes).
pub fn after_shell(app: &mut App) {
    show_startup(app);
}

fn show_startup(app: &mut App) {
    if app.misc.shown || !app.shell.loaded {
        return;
    }
    let Some(info) = app.misc.latest.clone() else {
        return;
    };
    app.misc.shown = true;
    let body = startup_note(app, &info);
    if !body.is_empty() {
        app.note(Tone::Info, s("Update", "업데이트"), body);
    }
}

// ---- /threads, /projects -------------------------------------------------------------------

/// `/threads` (`/t`): the threads of the project in use; the project list when there is none.
pub fn threads(app: &mut App) {
    match lists::current_project(app) {
        Some(project) => lists::open_threads(app, &project),
        None => lists::open_projects(app),
    }
}

/// `/projects` (`/p`).
pub fn projects(app: &mut App) {
    lists::open_projects(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{Active, Modal};
    use crate::notes::Note;
    use crate::update::testserver::serve;
    use ratatui::crossterm::event::{
        Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers,
    };
    use serde_json::{Value, json};
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    fn key(code: KeyCode) -> Msg {
        Msg::Term(Event::Key(KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }))
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-misc-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn app_in(config: &std::path::Path, version: &str) -> (App, UnboundedReceiver<Msg>) {
        let (tx, rx) = unbounded_channel();
        let mut app = App::new(version, "/tmp/oop-rs-misc/work", "/tmp", tx);
        app.misc.config_dir = Some(config.to_path_buf());
        app.misc.theme_name = "oop".into();
        app.misc.level = 3;
        (app, rx)
    }

    fn settings_of(config: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(config.join("settings.json")).unwrap())
            .unwrap()
    }

    fn texts(app: &App) -> Vec<String> {
        app.notes
            .iter()
            .flat_map(|n| match n {
                Note::Text { title, body, .. } => {
                    std::iter::once(title.clone()).chain(body.clone()).collect()
                }
                Note::Rows { .. } => Vec::new(),
            })
            .collect()
    }

    // ---- /theme

    #[tokio::test]
    async fn theme_opens_the_list_with_the_current_one_marked() {
        let config = dir("list");
        std::fs::create_dir_all(config.join("themes")).unwrap();
        std::fs::write(config.join("themes/mine.json"), "{}").unwrap();
        let (mut app, _rx) = app_in(&config, "0.0.1");
        app.misc.theme_name = "aurora".into();
        crate::cmd::run(&mut app, "theme", "");
        let Some(Modal::Pick(pick)) = &app.modal else {
            panic!("no list")
        };
        assert_eq!(pick.id, "theme");
        assert_eq!(
            pick.data,
            [
                "oop",
                "oop-light",
                "aurora",
                "sunset",
                "colorblind",
                "ansi",
                "mine"
            ]
        );
        assert_eq!(pick.cursor, 2);
        assert!(pick.items[2].starts_with("aurora ·") && pick.items[0] == "oop");
        assert_eq!(pick.title, s("Pick a theme", "테마 선택"));
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn picking_a_theme_switches_it_now_saves_it_and_keeps_the_other_settings() {
        let config = dir("pick");
        std::fs::write(
            config.join("settings.json"),
            r#"{"animations": false, "unknown": [1, 2]}"#,
        )
        .unwrap();
        let (mut app, _rx) = app_in(&config, "0.0.1");
        crate::cmd::run(&mut app, "theme", "");
        for _ in 0..3 {
            app.handle(key(KeyCode::Down));
        }
        app.handle(key(KeyCode::Enter));
        assert!(app.modal.is_none());
        assert_eq!(app.theme.brand, theme::builtin("sunset").unwrap().brand);
        assert_eq!(app.misc.theme_name, "sunset");
        assert_eq!(app.settings.theme.as_deref(), Some("sunset"));
        assert_eq!(
            settings_of(&config),
            json!({"animations": false, "unknown": [1, 2], "theme": "sunset"})
        );
        // A plain success is the record in the conversation, not a notice.
        assert_eq!(app.notice, None);
        assert_eq!(texts(&app), [s("Theme", "테마"), "sunset"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn a_theme_named_on_the_command_line_is_the_same_as_one_picked() {
        let config = dir("named");
        let (mut app, _rx) = app_in(&config, "0.0.1");
        crate::cmd::run(&mut app, "theme", "aurora extra words");
        assert_eq!(
            app.misc.theme_name, "aurora",
            "the first word names the theme"
        );
        assert_eq!(settings_of(&config), json!({"theme": "aurora"}));
        // The colour level of the terminal still folds the theme.
        app.misc.level = 2;
        crate::cmd::run(&mut app, "theme", "oop");
        assert!(matches!(app.theme.brand, ratatui::style::Color::Indexed(_)));
        app.misc.level = 0;
        crate::cmd::run(&mut app, "theme", "oop-light");
        assert_eq!(app.theme.brand, ratatui::style::Color::Reset);
        assert_eq!(settings_of(&config)["theme"], "oop-light");
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn an_unknown_theme_changes_nothing_and_says_so() {
        let config = dir("unknown");
        let (mut app, _rx) = app_in(&config, "0.0.1");
        let before = app.theme.brand;
        crate::cmd::run(&mut app, "theme", "nope");
        let notice = app.notice.clone().unwrap();
        assert!(
            notice.contains("nope") && notice.contains("/theme"),
            "{notice}"
        );
        assert_eq!(
            (app.theme.brand, app.misc.theme_name.as_str()),
            (before, "oop")
        );
        assert!(!config.join("settings.json").exists());
        assert!(app.notes.is_empty());
        crate::cmd::run(&mut app, "theme", "../escape");
        assert!(app.notice.as_deref().unwrap().contains("escape"));
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn a_custom_theme_with_faults_still_applies_and_the_faults_are_the_notice() {
        let config = dir("custom");
        std::fs::create_dir_all(config.join("themes")).unwrap();
        std::fs::write(
            config.join("themes/mine.json"),
            r##"{"base": "aurora", "overrides": {"brand": "#010203", "bogus": 1}}"##,
        )
        .unwrap();
        let (mut app, _rx) = app_in(&config, "0.0.1");
        crate::cmd::run(&mut app, "theme", "mine");
        assert_eq!(app.theme.brand, ratatui::style::Color::Rgb(1, 2, 3));
        let notice = app.notice.clone().unwrap();
        assert!(
            notice.contains("mine") && notice.contains("bogus"),
            "{notice}"
        );
        assert_eq!(settings_of(&config)["theme"], "mine");
        assert_eq!(texts(&app), [s("Theme", "테마"), "mine"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn a_damaged_settings_file_is_left_alone_and_the_theme_still_changes() {
        let config = dir("damaged");
        std::fs::write(config.join("settings.json"), "{broken").unwrap();
        let (mut app, _rx) = app_in(&config, "0.0.1");
        crate::cmd::run(&mut app, "theme", "sunset");
        assert_eq!(app.theme.brand, theme::builtin("sunset").unwrap().brand);
        assert_eq!(
            std::fs::read_to_string(config.join("settings.json")).unwrap(),
            "{broken"
        );
        let notice = app.notice.clone().unwrap();
        assert!(
            notice.contains("sunset") && notice.contains("settings.json"),
            "{notice}"
        );
        assert_eq!(
            app.settings.theme, None,
            "what was not saved is not claimed"
        );
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn the_environment_variable_that_wins_next_time_is_mentioned() {
        let config = dir("env");
        let (mut app, _rx) = app_in(&config, "0.0.1");
        let env = |k: &str| (k == "OOP_THEME").then(|| " ansi ".to_string());
        apply_theme(&mut app, "aurora", &env);
        let notice = app.notice.clone().unwrap();
        assert!(
            notice.contains("OOP_THEME") && notice.contains("aurora"),
            "{notice}"
        );
        assert_eq!(settings_of(&config)["theme"], "aurora");
        app.notice = None;
        apply_theme(&mut app, "sunset", &|_| None);
        assert_eq!(app.notice, None);
        let unsafe_env = |k: &str| (k == "OOP_THEME").then(|| "../x".to_string());
        apply_theme(&mut app, "sunset", &unsafe_env);
        assert_eq!(
            app.notice, None,
            "a value the terminal would not accept does not win"
        );
        std::fs::remove_dir_all(config).unwrap();
    }

    // ---- /update

    const NOTES: &str = r#"{"versions": [
        {"version": "0.0.9", "date": "2026-03-04", "highlights": [{"en": "nine one", "ko": "아홉 하나"}, {"en": "nine two"}]},
        {"version": "0.0.8", "date": "2026-03-01", "highlights": [{"en": "eight", "ko": "여덟"}]},
        {"version": "0.0.3", "date": "2026-01-01", "highlights": [{"en": "three", "ko": "셋"}]}]}"#;

    async fn release_server(
        latest: &'static str,
    ) -> (Urls, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let feed = Box::leak(format!(r#"{{"version": "{latest}"}}"#).into_boxed_str());
        let (origin, hits) = serve(vec![
            ("/feed", 302, Some("/feed2".into()), ""),
            ("/feed2", 200, None, feed),
            ("/notes", 200, None, NOTES),
        ])
        .await;
        (
            Urls {
                feed: format!("{origin}/feed"),
                notes: format!("{origin}/notes"),
            },
            hits,
        )
    }

    async fn next_ext(app: &mut App, rx: &mut UnboundedReceiver<Msg>) {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("the lookup answered")
            .unwrap();
        assert!(matches!(msg, Msg::Ext(_)));
        app.handle(msg);
    }

    #[tokio::test]
    async fn update_lists_the_releases_after_this_one_and_how_to_get_them() {
        let config = dir("update");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        app.misc.urls = release_server("0.0.9").await.0;
        crate::cmd::run(&mut app, "update", "");
        assert_eq!(app.notice.as_deref(), Some(checking()));
        assert!(app.misc.looking_up);
        next_ext(&mut app, &mut rx).await;
        assert!(!app.misc.looking_up);
        assert_eq!(app.notice, None, "the checking notice is taken down");
        let body = texts(&app);
        assert_eq!(body[0], s("Update", "업데이트"));
        assert!(
            body[1].contains("0.0.1") && body[1].contains("0.0.9"),
            "{body:?}"
        );
        let at = |text: &str| {
            body.iter()
                .position(|l| l.contains(text))
                .unwrap_or_else(|| panic!("{text}: {body:?}"))
        };
        // Newest first, each with its highlights under it; the old release is not listed.
        assert!(at("0.0.9 (2026-03-04)") < at("0.0.8 (2026-03-01)"));
        assert!(body[at("0.0.9 (2026-03-04)") + 1].starts_with("  · "));
        assert!(body.iter().any(|l| l.contains(s("nine two", "nine two"))));
        assert!(at("0.0.8 (2026-03-01)") < at("0.0.3 (2026-01-01)"));
        let how = update::update_how_to(update::runs_from_terminal_install(in_env), cfg!(windows));
        assert_eq!(
            body.last().unwrap(),
            &how,
            "how to update comes last: {body:?}"
        );
        assert_eq!(app.misc.latest.as_ref().unwrap().latest, "0.0.9");
        // The answer is cached for the next start.
        assert!(update::cache_path(&config).exists());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn update_measures_from_the_apps_version_when_the_server_has_told_it() {
        let config = dir("update-app");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        app.config = json!({"environment": {"serverVersion": " 0.0.8 "}});
        app.settings.ascii = true;
        app.misc.urls = release_server("0.0.9").await.0;
        crate::cmd::run(&mut app, "update", "");
        next_ext(&mut app, &mut rx).await;
        let body = texts(&app);
        assert!(
            body[1].contains("0.0.8") && body[1].contains("0.0.9"),
            "{body:?}"
        );
        assert!(
            body.iter().all(|l| !l.contains("0.0.8 (")),
            "this release is already installed: {body:?}"
        );
        assert!(
            body.iter()
                .any(|l| l == "  - nine one" || l == "  - 아홉 하나"),
            "ASCII mark: {body:?}"
        );
        // The terminal app (0.0.1) is older than the app (0.0.8): the reinstall line.
        let last = body.last().unwrap();
        assert!(last.contains("0.0.1") && last.contains("0.0.8"), "{body:?}");
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn update_says_so_when_there_is_nothing_newer() {
        let config = dir("update-current");
        let (mut app, mut rx) = app_in(&config, "0.0.9");
        app.misc.urls = release_server("0.0.9").await.0;
        crate::cmd::run(&mut app, "update", "");
        next_ext(&mut app, &mut rx).await;
        let body = texts(&app);
        assert_eq!(body.len(), 2, "{body:?}");
        assert!(body[1].contains("0.0.9"));
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn update_that_cannot_reach_the_release_says_so_as_an_error() {
        let config = dir("update-fail");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        app.misc.urls = Urls {
            feed: "http://127.0.0.1:9/feed".into(),
            notes: "http://127.0.0.1:9/notes".into(),
        };
        crate::cmd::run(&mut app, "update", "");
        next_ext(&mut app, &mut rx).await;
        assert_eq!(app.notice, None);
        assert!(!app.misc.looking_up, "another try is allowed");
        match app.notes.last().unwrap() {
            Note::Text { tone, body, .. } => {
                assert_eq!(*tone, Tone::Error);
                assert_eq!(
                    body[0],
                    s(
                        "Could not check for updates. Check your network connection.",
                        "업데이트를 확인하지 못했습니다. 네트워크 연결을 확인하세요."
                    )
                );
            }
            other => panic!("{other:?}"),
        }
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn a_second_update_while_one_is_running_does_not_start_another() {
        let config = dir("update-twice");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        let (urls, hits) = release_server("0.0.9").await;
        app.misc.urls = urls;
        crate::cmd::run(&mut app, "update", "");
        crate::cmd::run(&mut app, "update", "");
        next_ext(&mut app, &mut rx).await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv())
                .await
                .is_err()
        );
        // The feed (with its redirect) and the notes: three requests, once.
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(app.notes.len(), 1);
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn the_start_notice_names_the_newest_releases_and_counts_the_rest() {
        let note = |id: &str| update::ReleaseNote {
            version: format!("0.1.{id}"),
            date: String::new(),
            highlights: vec![update::Highlight {
                en: format!("h{id}"),
                ko: None,
            }],
        };
        let info = LatestRelease {
            latest: "0.1.6".into(),
            releases: (1..=6).rev().map(|n| note(&n.to_string())).collect(),
        };
        let (tx, _rx) = unbounded_channel();
        let app = App::new("0.1.0", "/tmp", "/tmp", tx);
        let body = startup_note(&app, &info);
        assert!(body[0].contains("0.1.0") && body[0].contains("0.1.6"));
        assert_eq!(
            body[1],
            update::update_how_to(update::runs_from_terminal_install(in_env), cfg!(windows))
        );
        let titles: Vec<&String> = body.iter().filter(|l| l.starts_with("0.1.")).collect();
        assert_eq!(titles, ["0.1.6", "0.1.5", "0.1.4"]);
        assert!(
            body.last().unwrap().contains("/update") && body.last().unwrap().contains('3'),
            "{body:?}"
        );
        // Nothing to say when this is the newest.
        let (tx, _rx) = unbounded_channel();
        let current = App::new("0.1.6", "/tmp", "/tmp", tx);
        assert!(startup_note(&current, &info).is_empty());
    }

    // ---- the check at start

    fn snapshot() -> Msg {
        Msg::Shell(
            json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 1,
            "projects": [{"id": "p1", "title": "demo", "workspaceRoot": "/tmp/oop-rs-misc/work"}], "threads": []}}),
        )
    }

    #[tokio::test]
    async fn the_start_check_waits_for_the_projects_and_says_a_newer_release_once() {
        let config = dir("startup");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        app.misc.startup_check = true;
        app.misc.urls = release_server("0.0.9").await.0;
        on_connected(&mut app);
        on_connected(&mut app);
        next_ext(&mut app, &mut rx).await;
        assert!(app.notes.is_empty(), "the projects are not known yet");
        assert!(app.misc.latest.is_some());
        app.handle(snapshot());
        let body = texts(&app);
        // The first project of the folder opened a draft, which clears notes; the notice comes after.
        assert_eq!(app.active, Active::Draft("p1".into()));
        assert_eq!(body[0], s("Update", "업데이트"), "{body:?}");
        assert!(body[1].contains("0.0.9"));
        assert!(update::cache_path(&config).exists());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
                .await
                .is_err(),
            "looked up once"
        );
        app.notes.clear();
        app.handle(snapshot());
        assert!(app.notes.is_empty(), "said once");
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn the_start_check_says_nothing_when_up_to_date_and_is_off_unless_asked_for() {
        let config = dir("startup-quiet");
        let (mut app, mut rx) = app_in(&config, "0.0.9");
        app.handle(snapshot());
        app.misc.urls = release_server("0.0.9").await.0;
        on_connected(&mut app);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv())
                .await
                .is_err(),
            "off by default"
        );
        assert!(!app.misc.started);
        app.misc.startup_check = true;
        on_connected(&mut app);
        next_ext(&mut app, &mut rx).await;
        assert!(app.notes.is_empty());
        assert!(app.misc.latest.is_some());
        std::fs::remove_dir_all(config).unwrap();
    }

    #[tokio::test]
    async fn the_start_check_that_fails_says_nothing() {
        let config = dir("startup-fail");
        let (mut app, mut rx) = app_in(&config, "0.0.1");
        app.misc.startup_check = true;
        app.misc.urls = Urls {
            feed: "http://127.0.0.1:9/feed".into(),
            notes: "http://127.0.0.1:9/notes".into(),
        };
        app.handle(snapshot());
        on_connected(&mut app);
        next_ext(&mut app, &mut rx).await;
        assert!(app.notes.is_empty() && app.notice.is_none() && app.misc.latest.is_none());
        std::fs::remove_dir_all(config).unwrap();
    }
}
