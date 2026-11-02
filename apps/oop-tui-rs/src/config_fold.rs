//! Keeps the server config current: a port of `applyServerConfigProjection`
//! (packages/client-runtime/src/state/serverConfigProjection.ts). The server pushes a snapshot
//! first and then small events on `subscribeServerConfig`; each one replaces one part of the
//! config (settings, provider statuses, keybindings, published themes, usage-limit sources), so
//! what was read at connect (the crew line, the model lists, the goals) follows changes made
//! here or by another client during the session.

use serde_json::Value;

/// The stream that carries the events.
pub const CONFIG_STREAM: &str = "subscribeServerConfig";

/// Applies one event to `config`. Only a snapshot is taken while there is no config yet, as in the
/// TypeScript (`Option.map` over nothing). Returns whether the config changed.
pub fn fold(config: &mut Value, event: &Value) -> bool {
    let kind = event["type"].as_str().unwrap_or_default();
    if kind == "snapshot" {
        let mut next = event["config"].clone();
        if !next.is_object() {
            return false;
        }
        // Published themes and usage-limit sources are not in a wire snapshot: keep what is known
        // while the server says it publishes them (a downgrade clears them).
        let capabilities = next["environment"]["capabilities"].clone();
        for (flag, key) in [
            ("environmentThemes", "environmentThemes"),
            ("usageLimitSources", "usageLimitSources"),
        ] {
            if capabilities[flag].as_bool() == Some(true)
                && next.get(key).is_none()
                && let Some(known) = config.get(key).filter(|v| !v.is_null())
            {
                next[key] = known.clone();
            }
        }
        *config = next;
        return true;
    }
    if !config.is_object() {
        return false;
    }
    let payload = &event["payload"];
    match kind {
        "keybindingsUpdated" => {
            config["keybindings"] = payload["keybindings"].clone();
            config["issues"] = payload["issues"].clone();
        }
        "providerStatuses" => config["providers"] = payload["providers"].clone(),
        "settingsUpdated" => config["settings"] = payload["settings"].clone(),
        "environmentThemesUpdated" => {
            set_or_remove(config, "environmentThemes", &payload["themes"])
        }
        "usageLimitSourcesUpdated" => {
            set_or_remove(config, "usageLimitSources", &payload["sources"])
        }
        _ => return false,
    }
    true
}

/// A published set; empty once the machine publishes none.
fn set_or_remove(config: &mut Value, key: &str, list: &Value) {
    match list.as_array() {
        Some(items) if !items.is_empty() => config[key] = list.clone(),
        _ => {
            if let Some(object) = config.as_object_mut() {
                object.remove(key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_snapshot_replaces_the_config_and_keeps_published_sets_the_server_still_offers() {
        let mut config = json!({"environmentThemes": [{"id": "a"}], "providers": []});
        let snapshot = json!({"type": "snapshot", "config": {
            "environment": {"capabilities": {"environmentThemes": true}}, "providers": [1]}});
        assert!(fold(&mut config, &snapshot));
        assert_eq!(config["providers"], json!([1]));
        assert_eq!(config["environmentThemes"], json!([{"id": "a"}]));
        // a server that no longer offers themes clears them
        let legacy = json!({"type": "snapshot", "config": {"environment": {"capabilities": {}}}});
        fold(&mut config, &legacy);
        assert!(config.get("environmentThemes").is_none());
    }

    #[test]
    fn events_replace_one_part_each() {
        let mut config =
            json!({"settings": {"crew": {"enabled": false}}, "providers": [], "keybindings": []});
        let event = json!({"version": 1, "type": "settingsUpdated",
            "payload": {"settings": {"crew": {"enabled": true}}}});
        assert!(fold(&mut config, &event));
        assert_eq!(config["settings"]["crew"]["enabled"], json!(true));
        fold(
            &mut config,
            &json!({"type": "providerStatuses", "payload": {"providers": [{"instanceId": "x"}]}}),
        );
        assert_eq!(config["providers"][0]["instanceId"], "x");
        fold(
            &mut config,
            &json!({"type": "keybindingsUpdated", "payload": {"keybindings": [1], "issues": []}}),
        );
        assert_eq!(config["keybindings"], json!([1]));
        fold(
            &mut config,
            &json!({"type": "environmentThemesUpdated", "payload": {"themes": [{"id": "t"}]}}),
        );
        assert_eq!(config["environmentThemes"][0]["id"], "t");
        fold(
            &mut config,
            &json!({"type": "environmentThemesUpdated", "payload": {"themes": []}}),
        );
        assert!(config.get("environmentThemes").is_none());
        assert!(!fold(&mut config, &json!({"type": "somethingNew"})));
    }

    #[test]
    fn nothing_but_a_snapshot_is_taken_before_there_is_a_config() {
        let mut config = Value::Null;
        let event = json!({"type": "settingsUpdated", "payload": {"settings": {}}});
        assert!(!fold(&mut config, &event));
        assert!(config.is_null());
        assert!(fold(
            &mut config,
            &json!({"type": "snapshot", "config": {"a": 1}})
        ));
        assert_eq!(config["a"], 1);
    }
}
