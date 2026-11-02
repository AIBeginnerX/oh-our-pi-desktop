//! Writing one key of `settings.json` the way the TypeScript terminal's `writeSetting` does: every
//! other key of the file is kept (the ones this build does not know too), a damaged file is left
//! exactly as it is, a settings file that is a symlink stays one (the target is replaced), an
//! existing file keeps its permissions, and the new content replaces the old atomically.
//! Keys are written in alphabetical order, not the order the file had.

use crate::panels_common::{fill, s};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The file as an object: a missing file is an empty one; anything else unusable is a refusal that
/// says why.
fn read_object(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err(s("cannot be read", "읽을 수 없음").into()),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(s("not an object", "객체가 아님").into()),
        Err(_) => Err(s("not JSON", "JSON이 아님").into()),
    }
}

/// Where a write really lands: the target of a symlink, even a dangling one.
fn target_of(file: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(file) {
        return real;
    }
    match std::fs::read_link(file) {
        Ok(link) => file.parent().map_or(link.clone(), |dir| dir.join(&link)),
        Err(_) => file.to_path_buf(),
    }
}

/// Sets `key` and keeps the rest. `Err` is one line fit for the notice.
pub fn write_setting(file: &Path, key: &str, value: Value) -> Result<(), String> {
    let mut object = read_object(file).map_err(|reason| {
        fill(
            s(
                "The settings file is damaged, so it was left untouched ({reason}): {file}",
                "설정 파일이 손상되어 건드리지 않았습니다 ({reason}): {file}",
            ),
            &[("reason", reason), ("file", file.display().to_string())],
        )
    })?;
    object.insert(key.to_string(), value);
    let target = target_of(file);
    let saved = save(&target, &object);
    saved.map_err(|e| {
        fill(
            s(
                "Could not save the setting: {message}",
                "설정을 저장하지 못했습니다: {message}",
            ),
            &[("message", e.to_string())],
        )
    })
}

fn save(target: &Path, object: &serde_json::Map<String, Value>) -> std::io::Result<()> {
    use std::io::Write;
    let directory = target.parent().unwrap_or(Path::new("."));
    create_directory(directory)?;
    let temporary = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let existing = std::fs::metadata(target).ok();
    let write = || -> std::io::Result<()> {
        let mut out = open_new(&temporary)?;
        let text = serde_json::to_string_pretty(object).map_err(std::io::Error::other)?;
        out.write_all(format!("{text}\n").as_bytes())?;
        drop(out);
        // An existing file keeps the permissions it had (the umask cut the new one's).
        if let Some(meta) = &existing {
            std::fs::set_permissions(&temporary, meta.permissions())?;
        }
        std::fs::rename(&temporary, target)
    };
    let result = write();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn create_directory(directory: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
}

#[cfg(not(unix))]
fn create_directory(directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)
}

#[cfg(unix)]
fn open_new(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_new(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oop-rs-write-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_key_is_set_and_the_others_stay() {
        let d = dir("keep");
        let file = d.join("settings.json");
        std::fs::write(&file, r#"{"banner": false, "future": {"x": 1}}"#).unwrap();
        write_setting(&file, "theme", json!("aurora")).unwrap();
        let now: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            now,
            json!({"banner": false, "future": {"x": 1}, "theme": "aurora"})
        );
        assert!(
            std::fs::read_dir(&d).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_damaged_file_is_left_alone_and_a_missing_one_is_made() {
        let d = dir("damaged");
        let file = d.join("sub").join("settings.json");
        write_setting(&file, "theme", json!("sunset")).unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("sunset"));
        std::fs::write(&file, "{nope").unwrap();
        let error = write_setting(&file, "theme", json!("oop")).unwrap_err();
        assert!(
            error.contains("damaged") || error.contains("손상"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{nope");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn modes_and_symlinks_are_kept() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let d = dir("modes");
        let real = d.join("dotfiles.json");
        std::fs::write(&real, "{}").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = d.join("settings.json");
        symlink(&real, &link).unwrap();
        write_setting(&link, "theme", json!("aurora")).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert!(std::fs::read_to_string(&real).unwrap().contains("aurora"));
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o7777,
            0o640
        );
        let fresh = d.join("new.json");
        write_setting(&fresh, "theme", json!("oop")).unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        std::fs::remove_dir_all(d).unwrap();
    }
}
