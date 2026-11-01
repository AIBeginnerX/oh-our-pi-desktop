//! `settings.json` and `last-model.json` in the config directory, shared with the TypeScript
//! terminal (same folder, same keys, same rules): a missing file is the defaults, an unusable file
//! is the defaults plus one warning and is never rewritten, an unacceptable value is skipped with a
//! warning, and unknown keys are ignored. Only `last-model.json` is ever written (atomically, like
//! the TypeScript terminal does); settings are read-only here.

use crate::server::config_dir;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// `None` until set; the theme then is the default.
    pub theme: Option<String>,
    pub ascii: bool,
    pub animations: bool,
    pub banner: bool,
    /// `auto | full | compact | minimal`, read for the header height.
    pub status_line: String,
    /// `en | ko`; `None` lets the locale decide.
    pub language: Option<String>,
    pub sidebar: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: None,
            ascii: false,
            animations: true,
            banner: true,
            status_line: "auto".into(),
            language: None,
            sidebar: true,
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
        Err(_) => return Err("it cannot be read"),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err("it is not a JSON object"),
        Err(_) => Err("it is not valid JSON"),
    }
}

/// Never fails and never writes. The warnings are shown once at start.
pub fn read_settings(path: &Path) -> (Settings, Vec<String>) {
    let mut settings = Settings::default();
    let mut warnings = Vec::new();
    let object = match read_object(path) {
        Ok(object) => object,
        Err(reason) => {
            warnings.push(format!(
                "{} is damaged ({reason}); using the defaults and leaving it alone",
                path.display()
            ));
            return (settings, warnings);
        }
    };
    let mut bad = |key: &str, expected: &str| {
        warnings.push(format!(
            "settings.json: \"{key}\" is ignored; expected {expected}"
        ))
    };
    let mut flag = |key: &str, slot: &mut bool| match object.get(key) {
        None => {}
        Some(Value::Bool(value)) => *slot = *value,
        Some(_) => bad(key, "true | false"),
    };
    flag("animations", &mut settings.animations);
    flag("banner", &mut settings.banner);
    flag("sidebar", &mut settings.sidebar);
    match object.get("theme") {
        None => {}
        Some(Value::String(name)) if safe_name(name) => settings.theme = Some(name.clone()),
        Some(_) => bad("theme", "a theme name"),
    }
    match object.get("symbols").map(|v| v.as_str()) {
        None => {}
        Some(Some("auto" | "unicode")) => {}
        Some(Some("ascii")) => settings.ascii = true,
        Some(_) => bad("symbols", "auto | unicode | ascii"),
    }
    match object.get("statusLine").map(|v| v.as_str()) {
        None => {}
        Some(Some(value @ ("auto" | "full" | "compact" | "minimal"))) => {
            settings.status_line = value.to_string()
        }
        Some(_) => bad("statusLine", "auto | full | compact | minimal"),
    }
    match object.get("language").map(|v| v.as_str()) {
        None => {}
        Some(Some(value @ ("en" | "ko"))) => settings.language = Some(value.to_string()),
        Some(_) => bad("language", "en | ko"),
    }
    (settings, warnings)
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
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let Some(directory) = path.parent() else {
        return;
    };
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
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
        assert!(warnings[0].contains("damaged"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        cleanup(&path);
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
