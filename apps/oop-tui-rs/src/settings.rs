//! `settings.json` and `last-model.json` in the config directory, same folder, same keys and same
//! rules as before the TypeScript terminal was removed: a missing file is the defaults, an unusable
//! file is the defaults plus one warning and is never rewritten, an unacceptable value is skipped
//! with a warning, and unknown keys are ignored. `settings_write.rs` writes one key; `last-model.json`
//! is written atomically here.

use crate::panels_common::{fill, s};
use crate::server::config_dir;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The keys of `settings.json`, in the order `oop config` lists them.
pub const SETTING_KEYS: [&str; 10] = [
    "theme",
    "symbols",
    "animations",
    "banner",
    "statusLine",
    "notify",
    "sidebar",
    "workflow",
    "pet",
    "language",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// `None` until set; the theme then is the default.
    pub theme: Option<String>,
    /// `auto | unicode | ascii`.
    pub symbols: String,
    /// Whether the symbols are the ASCII preset: `symbols` is `ascii`, or `auto` with a terminal
    /// that is not UTF-8 (see `resolve_env`, which decides it from the environment).
    pub ascii: bool,
    pub animations: bool,
    pub banner: bool,
    /// `auto | full | compact | minimal`, read for the header height.
    pub status_line: String,
    /// Ring the terminal bell when a turn finishes or waits for an approval or an answer.
    pub notify: bool,
    /// `en | ko`; `None` is English.
    pub language: Option<String>,
    pub sidebar: bool,
    /// The right-hand panel (workflow and agents) opens with the first conversation.
    pub workflow: bool,
    /// The pet in the pinned header.
    pub pet: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: None,
            symbols: "auto".into(),
            ascii: false,
            animations: true,
            banner: true,
            status_line: "auto".into(),
            notify: true,
            language: None,
            sidebar: true,
            workflow: true,
            pet: true,
        }
    }
}

pub fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn last_model_path() -> PathBuf {
    config_dir().join("last-model.json")
}

/// The file as an object: a missing file is an empty one; anything else unusable is `Err(reason)`.
fn read_object(path: &Path) -> Result<serde_json::Map<String, Value>, &'static str> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err(s("cannot be read", "읽을 수 없음")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(s("not an object", "객체가 아님")),
        Err(_) => Err(s("not JSON", "JSON이 아님")),
    }
}

/// What reading the file gave: the settings it sets (the defaults for the rest), a warning for
/// each thing that was ignored, and whether the file as a whole is unusable.
pub struct SettingsFile {
    pub settings: Settings,
    pub warnings: Vec<String>,
    pub damaged: bool,
}

/// Reads settings.json. Never fails and never writes: a damaged file means defaults and one warning.
pub fn read_file(path: &Path) -> SettingsFile {
    let mut settings = Settings::default();
    let mut warnings = Vec::new();
    let object = match read_object(path) {
        Ok(object) => object,
        Err(reason) => {
            warnings.push(fill(
                s(
                    "Ignoring the settings file and starting with defaults ({reason}): {file}",
                    "설정 파일을 쓰지 않고 기본값으로 시작합니다 ({reason}): {file}",
                ),
                &[
                    ("reason", reason.to_string()),
                    ("file", path.display().to_string()),
                ],
            ));
            return SettingsFile {
                settings,
                warnings,
                damaged: true,
            };
        }
    };
    let mut bad = |key: &str, expected: &str| {
        warnings.push(fill(
            s(
                "Ignored an invalid value for {key} in settings.json ({expected}).",
                "settings.json 의 {key} 값이 올바르지 않아 무시했습니다 ({expected}).",
            ),
            &[("key", key.to_string()), ("expected", expected.to_string())],
        ))
    };
    let mut flag = |key: &'static str, slot: &mut bool| match object.get(key) {
        None => {}
        Some(Value::Bool(value)) => *slot = *value,
        Some(_) => bad(key, "true | false"),
    };
    flag("animations", &mut settings.animations);
    flag("banner", &mut settings.banner);
    flag("notify", &mut settings.notify);
    flag("sidebar", &mut settings.sidebar);
    flag("workflow", &mut settings.workflow);
    flag("pet", &mut settings.pet);
    match object.get("theme") {
        None => {}
        Some(Value::String(name)) if safe_name(name) => {
            settings.theme = Some(name.clone());
        }
        Some(_) => bad("theme", s("a theme name", "테마 이름")),
    }
    match object.get("symbols").map(|v| v.as_str()) {
        None => {}
        Some(Some(value @ ("auto" | "unicode" | "ascii"))) => {
            settings.symbols = value.to_string();
            settings.ascii = value == "ascii";
        }
        Some(_) => bad("symbols", "auto | unicode | ascii"),
    }
    match object.get("statusLine").map(|v| v.as_str()) {
        None => {}
        Some(Some(value @ ("auto" | "full" | "compact" | "minimal"))) => {
            settings.status_line = value.to_string();
        }
        Some(_) => bad("statusLine", "auto | full | compact | minimal"),
    }
    match object.get("language").map(|v| v.as_str()) {
        None => {}
        Some(Some(value @ ("en" | "ko"))) => {
            settings.language = Some(value.to_string());
        }
        Some(_) => bad("language", "en | ko"),
    }
    SettingsFile {
        settings,
        warnings,
        damaged: false,
    }
}

/// The `language` setting, read without producing any text: the language must be fixed before the
/// first string is looked up, and reading a damaged file produces a (translated) warning.
pub fn startup_language(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&text) else {
        return None;
    };
    object
        .get("language")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "en" | "ko"))
        .map(str::to_string)
}

/// `read_file` for the callers that need no more than the values and the warnings.
pub fn read_settings(path: &Path) -> (Settings, Vec<String>) {
    let file = read_file(path);
    (file.settings, file.warnings)
}

/// Whether `auto` symbols mean the ASCII preset: Windows only has the Unicode ones under Windows
/// Terminal (`WT_SESSION`); elsewhere the first of `LC_ALL`, `LC_CTYPE`, `LANG` that is set must
/// name a UTF-8 locale.
pub fn auto_symbols_are_ascii(env: &impl Fn(&str) -> Option<String>, windows: bool) -> bool {
    if windows {
        return env("WT_SESSION").is_none_or(|v| v.is_empty());
    }
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|name| env(name).filter(|v| !v.is_empty()));
    !locale.is_some_and(|value| {
        let lower = value.to_ascii_lowercase();
        lower.contains("utf-8") || lower.contains("utf8")
    })
}

/// `OOP_THEME`, `OOP_ANIMATIONS` (0 or 1) and `OOP_SYMBOLS` beat the file; anything unusable is
/// not an override. Settles `ascii` from the final `symbols`. Returns the keys that came from
/// the environment, for `oop config`.
pub fn resolve_env(
    settings: &mut Settings,
    env: &impl Fn(&str) -> Option<String>,
    windows: bool,
) -> Vec<&'static str> {
    let mut from_env = Vec::new();
    if let Some(theme) = env("OOP_THEME")
        .map(|v| v.trim().to_string())
        .filter(|v| safe_name(v))
    {
        settings.theme = Some(theme);
        from_env.push("theme");
    }
    match env("OOP_ANIMATIONS").as_deref().map(str::trim) {
        Some("0") => {
            settings.animations = false;
            from_env.push("animations");
        }
        Some("1") => {
            settings.animations = true;
            from_env.push("animations");
        }
        _ => {}
    }
    if let Some(symbols) = env("OOP_SYMBOLS")
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| matches!(v.as_str(), "auto" | "unicode" | "ascii"))
    {
        settings.symbols = symbols;
        from_env.push("symbols");
    }
    settings.ascii = match settings.symbols.as_str() {
        "ascii" => true,
        "unicode" => false,
        _ => auto_symbols_are_ascii(env, windows),
    };
    from_env
}

/// A theme name becomes a file name in the TypeScript terminal; refuse what could leave a folder.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

/// The remembered `ModelSelection` (`{instanceId, model, options?}`), or `None` when there is none
/// or it is unreadable or malformed.
pub fn read_last_model(path: &Path) -> Option<Value> {
    let selection: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let ok = selection["instanceId"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
        && selection["model"].as_str().is_some_and(|s| !s.is_empty());
    ok.then_some(selection)
}

/// Replaces the file whole; a failed save is ignored (the pick still works for this session).
pub fn write_last_model(path: &Path, selection: &Value) {
    let Some(directory) = path.parent() else {
        return;
    };
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut directories = std::fs::DirBuilder::new();
        directories.recursive(true);
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
            directories.mode(0o700);
            file.mode(0o600);
        }
        directories.create(directory)?;
        let mut out = file.open(&temporary)?;
        let text = serde_json::to_string_pretty(selection).map_err(std::io::Error::other)?;
        out.write_all(format!("{text}\n").as_bytes())?;
        std::fs::rename(&temporary, path)
    };
    if write().is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("oop-rs-settings-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("f.json")
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn a_missing_file_is_the_defaults_and_a_bad_value_is_skipped_with_a_warning() {
        let path = temp("missing");
        assert_eq!(read_settings(&path), (Settings::default(), vec![]));
        std::fs::write(
            &path,
            r#"{"banner": false, "language": "fr", "symbols": "ascii", "extra": 1}"#,
        )
        .unwrap();
        let (settings, warnings) = read_settings(&path);
        assert!(!settings.banner && settings.ascii && settings.language.is_none());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("language"));
        cleanup(&path);
    }

    #[test]
    fn a_damaged_file_is_left_alone() {
        let path = temp("damaged");
        std::fs::write(&path, "{not json").unwrap();
        let (settings, warnings) = read_settings(&path);
        assert_eq!(settings, Settings::default());
        assert_eq!(
            warnings,
            [format!(
                "Ignoring the settings file and starting with defaults (not JSON): {}",
                path.display()
            )]
        );
        let file = read_file(&path);
        assert!(file.damaged);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        cleanup(&path);
    }

    #[test]
    fn an_invalid_value_warns_in_the_words_of_the_typescript_terminal() {
        let path = temp("invalid-words");
        std::fs::write(&path, r#"{"statusLine": "wide", "notify": "yes"}"#).unwrap();
        let file = read_file(&path);
        assert!(!file.damaged);
        assert_eq!(
            file.warnings,
            [
                "Ignored an invalid value for notify in settings.json (true | false).",
                "Ignored an invalid value for statusLine in settings.json (auto | full | compact | minimal).",
            ]
        );
        assert!(file.settings.notify, "a bad value leaves the default");
        cleanup(&path);
    }

    #[test]
    fn notify_and_the_other_keys_the_file_sets_are_read() {
        let path = temp("notify");
        std::fs::write(
            &path,
            r#"{"notify": false, "pet": true, "symbols": "unicode"}"#,
        )
        .unwrap();
        let file = read_file(&path);
        assert!(!file.settings.notify);
        assert!(file.settings.pet);
        assert_eq!(file.settings.symbols, "unicode");
        cleanup(&path);
    }

    #[test]
    fn the_language_is_read_without_any_text_being_made() {
        let path = temp("language");
        assert_eq!(startup_language(&path), None);
        std::fs::write(&path, r#"{"language": "ko", "pet": 1}"#).unwrap();
        assert_eq!(startup_language(&path).as_deref(), Some("ko"));
        std::fs::write(&path, r#"{"language": "fr"}"#).unwrap();
        assert_eq!(startup_language(&path), None);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(startup_language(&path), None);
        cleanup(&path);
    }

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn the_environment_beats_the_file_and_nothing_unusable_counts() {
        let mut settings = Settings {
            animations: true,
            ..Settings::default()
        };
        let from_env = resolve_env(
            &mut settings,
            &env_of(&[
                ("OOP_THEME", " ansi "),
                ("OOP_ANIMATIONS", "0"),
                ("OOP_SYMBOLS", "ASCII"),
            ]),
            false,
        );
        assert_eq!(from_env, ["theme", "animations", "symbols"]);
        assert_eq!(settings.theme.as_deref(), Some("ansi"));
        assert!(!settings.animations && settings.ascii);

        let mut settings = Settings::default();
        let from_env = resolve_env(
            &mut settings,
            &env_of(&[
                ("OOP_THEME", "../x"),
                ("OOP_ANIMATIONS", "yes"),
                ("OOP_SYMBOLS", "fancy"),
                ("LANG", "en_US.UTF-8"),
            ]),
            false,
        );
        assert!(from_env.is_empty());
        assert!(settings.theme.is_none() && settings.animations && !settings.ascii);
    }

    #[test]
    fn auto_symbols_follow_the_locale_or_windows_terminal() {
        let ascii = |pairs: &'static [(&'static str, &'static str)], windows| {
            auto_symbols_are_ascii(&env_of(pairs), windows)
        };
        assert!(!ascii(&[("LANG", "en_US.UTF-8")], false));
        assert!(!ascii(&[("LC_ALL", "ko_KR.utf8"), ("LANG", "C")], false));
        assert!(ascii(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")], false));
        assert!(ascii(&[], false));
        assert!(!ascii(&[("WT_SESSION", "abc")], true));
        assert!(ascii(&[("LANG", "en_US.UTF-8")], true));
        // an explicit setting wins over the locale
        let mut settings = Settings {
            symbols: "unicode".into(),
            ..Settings::default()
        };
        resolve_env(&mut settings, &env_of(&[("LANG", "C")]), false);
        assert!(!settings.ascii);
        settings.symbols = "auto".into();
        resolve_env(&mut settings, &env_of(&[("LANG", "C")]), false);
        assert!(settings.ascii);
    }

    #[test]
    fn last_model_round_trips_and_rejects_junk() {
        let path = temp("last-model");
        assert!(read_last_model(&path).is_none());
        let selection = json!({"instanceId": "codex", "model": "gpt-5", "options": [{"id": "reasoningEffort", "value": "high"}]});
        write_last_model(&path, &selection);
        assert_eq!(read_last_model(&path), Some(selection));
        std::fs::write(&path, r#"{"model": "x"}"#).unwrap();
        assert!(read_last_model(&path).is_none());
        cleanup(&path);
    }
}
