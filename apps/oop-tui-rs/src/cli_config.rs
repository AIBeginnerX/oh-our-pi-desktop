//! `oop config [get <key> | set <key> <value> | path]`: shows and changes `settings.json`.
//! Every line goes through [`Io`], so a test reads what the command printed.

use crate::cli_text::{t, tf};
use crate::settings::{self, SETTING_KEYS, Settings};
use crate::{settings_write, theme};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigAction {
    List,
    Path,
    Get(String),
    Set(String, String),
}

/// What the command reads and says. `env` is the process environment (or a test's).
pub struct Io<'a> {
    pub config_dir: PathBuf,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub windows: bool,
    pub out: &'a mut dyn FnMut(&str),
    pub err: &'a mut dyn FnMut(&str),
}

fn expected(key: &str) -> String {
    match key {
        "theme" => t("settings.expected.theme").to_string(),
        "symbols" => "auto | unicode | ascii".into(),
        "statusLine" => "auto | full | compact | minimal".into(),
        "language" => "en | ko".into(),
        _ => "true | false".into(),
    }
}

/// The effective value as the command prints it; `None` is "(default)".
fn show(key: &str, settings: &Settings) -> String {
    let flag = |on: bool| on.to_string();
    match key {
        "theme" => settings
            .theme
            .clone()
            .unwrap_or_else(|| t("settings.default").to_string()),
        "symbols" => settings.symbols.clone(),
        "animations" => flag(settings.animations),
        "banner" => flag(settings.banner),
        "statusLine" => settings.status_line.clone(),
        "notify" => flag(settings.notify),
        "sidebar" => flag(settings.sidebar),
        "workflow" => flag(settings.workflow),
        "pet" => flag(settings.pet),
        "usage" => flag(settings.usage),
        _ => settings
            .language
            .clone()
            .unwrap_or_else(|| t("settings.default").to_string()),
    }
}

fn is_boolean(key: &str) -> bool {
    matches!(
        key,
        "animations" | "banner" | "notify" | "sidebar" | "workflow" | "pet" | "usage"
    )
}

/// The value as JSON when `raw` is acceptable for `key`.
fn validate(key: &str, raw: &str) -> Option<Value> {
    if is_boolean(key) {
        return match raw.to_lowercase().as_str() {
            "true" | "on" | "1" => Some(json!(true)),
            "false" | "off" | "0" => Some(json!(false)),
            _ => None,
        };
    }
    let accepted = match key {
        "theme" => theme::is_safe_name(raw),
        "symbols" => matches!(raw, "auto" | "unicode" | "ascii"),
        "statusLine" => matches!(raw, "auto" | "full" | "compact" | "minimal"),
        _ => matches!(raw, "en" | "ko"),
    };
    accepted.then(|| json!(raw))
}

/// The settings file under `config_dir`.
pub fn settings_file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Runs the command and returns the exit code: 0 done, 1 the file could not be saved, 2 a wrong key
/// or value.
pub fn run(action: &ConfigAction, io: &mut Io) -> i32 {
    let file = settings_file(&io.config_dir);
    if *action == ConfigAction::Path {
        (io.out)(&file.display().to_string());
        return 0;
    }
    let read = settings::read_file(&file);
    for warning in &read.warnings {
        (io.err)(warning);
    }
    let mut effective = read.settings;
    let from_env = settings::resolve_env(&mut effective, &io.env, io.windows);
    let origin = |key: &str| {
        if from_env.contains(&key) {
            t("settings.fromEnv")
        } else {
            ""
        }
    };
    let (key, raw) = match action {
        ConfigAction::List => {
            for key in SETTING_KEYS {
                (io.out)(&format!("{key} = {}{}", show(key, &effective), origin(key)));
            }
            return 0;
        }
        ConfigAction::Get(key) | ConfigAction::Set(key, _)
            if !SETTING_KEYS.contains(&key.as_str()) =>
        {
            (io.err)(&tf(
                "settings.err.unknownKey",
                &[("key", key.clone()), ("keys", SETTING_KEYS.join(", "))],
            ));
            return 2;
        }
        ConfigAction::Get(key) => {
            (io.out)(&format!("{}{}", show(key, &effective), origin(key)));
            return 0;
        }
        ConfigAction::Set(key, raw) => (key.as_str(), raw.as_str()),
        ConfigAction::Path => unreachable!("answered above"),
    };
    let Some(value) = validate(key, raw) else {
        (io.err)(&tf(
            "settings.err.badValue",
            &[("key", key.to_string()), ("expected", expected(key))],
        ));
        return 2;
    };
    if key == "theme" {
        let names = theme::list_names(&io.config_dir);
        if !names.iter().any(|name| name == raw) {
            (io.err)(&tf(
                "settings.err.unknownTheme",
                &[("value", raw.to_string()), ("themes", names.join(", "))],
            ));
            return 2;
        }
    }
    if let Err(error) = settings_write::write_setting(&file, key, value.clone()) {
        (io.err)(&error);
        return 1;
    }
    let shown = match &value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    (io.out)(&format!("{key} = {shown}"));
    if from_env.contains(&key) {
        (io.err)(t("settings.warn.envWins"));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Run {
        code: i32,
        out: Vec<String>,
        err: Vec<String>,
    }

    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("oop-rs-config-{}-{name}", crate::text::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_in(
        dir: &Path,
        action: ConfigAction,
        env: &'static [(&'static str, &'static str)],
    ) -> Run {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let lookup = move |key: &str| {
            env.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        };
        let code = run(
            &action,
            &mut Io {
                config_dir: dir.to_path_buf(),
                env: &lookup,
                windows: false,
                out: &mut |line| out.push(line.to_string()),
                err: &mut |line| err.push(line.to_string()),
            },
        );
        Run { code, out, err }
    }

    fn set(key: &str, value: &str) -> ConfigAction {
        ConfigAction::Set(key.into(), value.into())
    }

    #[test]
    fn sets_and_gets_booleans_in_the_words_people_type() {
        let home = dir("booleans");
        assert_eq!(run_in(&home, set("pet", "off"), &[]).out, ["pet = false"]);
        assert_eq!(
            run_in(&home, set("workflow", "ON"), &[]).out,
            ["workflow = true"]
        );
        assert_eq!(
            run_in(&home, set("notify", "0"), &[]).out,
            ["notify = false"]
        );
        assert_eq!(
            run_in(&home, ConfigAction::Get("pet".into()), &[]).out,
            ["false"]
        );
        let wrong = run_in(&home, set("pet", "maybe"), &[]);
        assert_eq!(wrong.code, 2);
        assert_eq!(wrong.err, ["pet only accepts true | false."]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn prints_the_settings_file_path() {
        let home = dir("path");
        let ran = run_in(&home, ConfigAction::Path, &[]);
        assert_eq!(ran.code, 0);
        assert_eq!(ran.out, [home.join("settings.json").display().to_string()]);
        assert!(ran.err.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn lists_every_setting_with_its_value_and_where_an_override_came_from() {
        let home = dir("list");
        std::fs::write(home.join("settings.json"), r#"{"banner": false}"#).unwrap();
        let ran = run_in(&home, ConfigAction::List, &[("OOP_ANIMATIONS", "0")]);
        assert_eq!(ran.code, 0);
        assert_eq!(
            ran.out,
            [
                "theme = (default)",
                "symbols = auto",
                "animations = false (environment variable)",
                "banner = false",
                "statusLine = auto",
                "notify = true",
                "sidebar = true",
                "workflow = true",
                "pet = true",
                "usage = true",
                "language = (default)",
            ]
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn gets_one_value_and_says_when_the_environment_decides_it() {
        let home = dir("get");
        std::fs::write(home.join("settings.json"), r#"{"theme": "aurora"}"#).unwrap();
        assert_eq!(
            run_in(&home, ConfigAction::Get("theme".into()), &[]).out,
            ["aurora"]
        );
        assert_eq!(
            run_in(
                &home,
                ConfigAction::Get("theme".into()),
                &[("OOP_THEME", "sunset")]
            )
            .out,
            ["sunset (environment variable)"]
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_unknown_key_is_refused_with_the_list_of_keys() {
        let home = dir("unknown");
        for action in [ConfigAction::Get("colour".into()), set("colour", "x")] {
            let ran = run_in(&home, action, &[]);
            assert_eq!(ran.code, 2);
            assert_eq!(
                ran.err,
                [
                    "Unknown setting: colour (theme, symbols, animations, banner, statusLine, notify, sidebar, workflow, pet, usage, language)"
                ]
            );
        }
        assert!(!home.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_value_out_of_range_is_refused_and_nothing_is_written() {
        let home = dir("range");
        let ran = run_in(&home, set("language", "fr"), &[]);
        assert_eq!(
            (ran.code, ran.err),
            (2, vec!["language only accepts en | ko.".to_string()])
        );
        let ran = run_in(&home, set("symbols", "fancy"), &[]);
        assert_eq!(ran.err, ["symbols only accepts auto | unicode | ascii."]);
        assert!(!home.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_theme_must_exist_and_a_set_value_is_kept_with_the_other_keys() {
        let home = dir("theme");
        let ran = run_in(&home, set("theme", "nope"), &[]);
        assert_eq!(ran.code, 2);
        assert!(
            ran.err[0].starts_with("Unknown theme: nope ("),
            "{:?}",
            ran.err
        );
        assert!(
            ran.err[0].contains("oop"),
            "the list names the built-in themes"
        );
        std::fs::write(home.join("settings.json"), r#"{"future": 1}"#).unwrap();
        let ran = run_in(&home, set("theme", "ansi"), &[]);
        assert_eq!((ran.code, ran.out), (0, vec!["theme = ansi".to_string()]));
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(saved, json!({"future": 1, "theme": "ansi"}));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_set_that_the_environment_overrides_says_so_on_stderr() {
        let home = dir("env-wins");
        let ran = run_in(&home, set("animations", "off"), &[("OOP_ANIMATIONS", "1")]);
        assert_eq!(ran.code, 0);
        assert_eq!(ran.out, ["animations = false"]);
        assert_eq!(
            ran.err,
            ["An environment variable takes priority, so this value does not apply right now."]
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_damaged_file_is_left_exactly_as_it_is_and_a_set_fails() {
        let home = dir("damaged");
        std::fs::write(home.join("settings.json"), "{ not json").unwrap();
        let ran = run_in(&home, set("pet", "off"), &[]);
        assert_eq!(ran.code, 1);
        assert_eq!(
            ran.err.len(),
            2,
            "the warning, then the refusal: {:?}",
            ran.err
        );
        assert!(ran.err[1].starts_with("The settings file is damaged"));
        assert_eq!(
            std::fs::read_to_string(home.join("settings.json")).unwrap(),
            "{ not json"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
