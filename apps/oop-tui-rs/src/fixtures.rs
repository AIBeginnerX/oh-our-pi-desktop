//! The golden JSON in `fixtures/` is written by `scripts/export-fixtures.mjs` through the real
//! TypeScript schemas. These tests feed every file to the Rust side, so a type the server gains, or a
//! field it renames, fails here and not in a session. Command builders are pinned in `commands.rs`.

use crate::settings::{read_last_model, read_settings};
use crate::state::{Conversation, Shell, effort_control, first_usable_model, usable_models};
use crate::thread::{Outcome, Thread};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn dir(sub: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(sub)
}

fn json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn files(sub: &str) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir(sub))
        .unwrap_or_else(|e| panic!("{sub}: {e}"))
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "json")
                && !p.file_name().unwrap().to_string_lossy().starts_with('_')
        })
        .collect();
    found.sort();
    found
}

#[test]
fn every_event_type_the_server_knows_has_a_fixture() {
    let types: Vec<String> =
        serde_json::from_value(json(&dir("events").join("_types.json"))).unwrap();
    assert!(types.len() >= 33, "{} types", types.len());
    for ty in &types {
        assert!(
            dir("events").join(format!("{ty}.json")).exists(),
            "no fixture for {ty}"
        );
    }
}

#[test]
fn no_event_fixture_is_an_unhandled_type() {
    let mut paths = files("events");
    paths.extend(files("events/variants"));
    assert!(paths.len() > 40);
    for path in paths {
        let event = json(&path);
        let mut thread = Thread::default();
        let outcome = thread.apply_event(&event);
        assert_ne!(
            outcome,
            Outcome::Unknown,
            "{path:?}: type {} has no reducer arm",
            event["type"]
        );
    }
}

#[test]
fn a_conversation_takes_every_event_fixture_without_losing_its_place() {
    for path in files("events") {
        let event = json(&path);
        let mut conversation = Conversation::new("thread-1");
        conversation.apply(&serde_json::json!({"kind": "event", "event": event}));
        assert!(conversation.revision > 0, "{path:?}");
    }
}

#[test]
fn shell_items_parse() {
    let mut shell = Shell::default();
    shell.apply(&json(&dir("shell").join("snapshot.json")));
    assert!(shell.loaded && shell.sequence == 9);
    assert_eq!(shell.projects.len(), 2);
    assert!(!shell.threads.is_empty());
    let (before, project) = (shell.threads.len(), shell.projects[0].id.clone());
    shell.apply(&json(&dir("shell").join("thread-upserted.json")));
    assert_eq!(shell.sequence, 14);
    assert_eq!(
        shell.threads.iter().filter(|t| t.id == "thread-1").count(),
        1
    );
    shell.apply(&json(&dir("shell").join("thread-removed.json")));
    assert!(shell.threads.len() < before.max(2));
    assert!(shell.threads.iter().all(|t| t.id != "thread-1"));
    shell.apply(&json(&dir("shell").join("project-upserted.json")));
    shell.apply(&json(&dir("shell").join("project-removed.json")));
    assert!(
        shell.projects.iter().all(|p| p.id != "project-1"),
        "{project}"
    );
    shell.apply(&json(&dir("shell").join("synchronized.json")));
}

#[test]
fn thread_snapshots_parse_and_a_window_pages_back() {
    let mut full = Conversation::new("thread-1");
    full.apply(&json(&dir("thread").join("snapshot.json")));
    assert!(full.thread.messages.len() >= 2 && !full.has_more);
    assert_eq!(full.thread.runtime_mode, "full-access");

    let mut window = Conversation::new("thread-1");
    window.apply(&json(&dir("thread").join("snapshot-windowed.json")));
    assert!(window.has_more);
    assert_eq!(window.older_cursor.as_deref(), Some("cursor-1"));
    let shown = window.thread.messages.len();
    window.apply_older(&json(&dir("thread").join("snapshot-older-page.json"))["snapshot"]);
    assert!(
        window.thread.messages.len() > shown,
        "older messages were merged in"
    );
    assert!(!window.loading_older);

    let mut synced = Conversation::new("thread-1");
    synced.apply(&json(&dir("thread").join("synchronized.json")));
    assert!(synced.synchronized);
}

#[test]
fn the_server_config_lists_models_and_an_effort_choice() {
    let config = json(&dir("config").join("server-config.json"));
    let models = usable_models(&config);
    assert!(!models.is_empty(), "the config has a usable model");
    assert!(first_usable_model(&config).is_some());
    let first = &models[0];
    let selection = serde_json::json!({"instanceId": first.instance_id, "model": first.slug});
    // Not every model has an effort option; when it does, the choices are never empty.
    if let Some(control) = effort_control(&config, &selection) {
        assert!(!control.choices.is_empty());
    }
}

#[test]
fn settings_and_the_remembered_model_read_from_their_fixtures() {
    let (settings, warnings) = read_settings(&dir("config").join("settings.json"));
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(settings.language.as_deref(), Some("ko"));
    assert!(settings.sidebar && settings.banner && settings.animations);
    assert_eq!(settings.theme.as_deref(), Some("lavender"));

    let (settings, warnings) = read_settings(&dir("config").join("settings-invalid.json"));
    assert!(warnings.len() >= 4, "{warnings:?}");
    assert!(
        settings.theme.is_none() && settings.language.is_none(),
        "bad values fall back"
    );

    let model = read_last_model(&dir("config").join("last-model.json")).expect("a selection");
    assert_eq!(model["instanceId"], "codex");
}

#[test]
fn a_mode_event_after_the_snapshot_changes_the_conversation() {
    let mut conversation = Conversation::new("thread-1");
    conversation.apply(&json(&dir("thread").join("snapshot.json")));
    assert_eq!(conversation.thread.runtime_mode, "full-access");
    let mut event = json(&dir("events").join("thread.runtime-mode-set.json"));
    event["sequence"] = serde_json::json!(conversation.sequence.unwrap_or(0) + 1);
    let wanted = event["payload"]["runtimeMode"]
        .as_str()
        .unwrap()
        .to_string();
    conversation.apply(&serde_json::json!({"kind": "event", "event": event}));
    assert_eq!(conversation.thread.runtime_mode, wanted);
}
