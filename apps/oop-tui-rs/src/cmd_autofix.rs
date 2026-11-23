//! `/autofix` reads or changes the active thread's auto-fix setting.

use crate::app::{Active, App};
use crate::notes::Tone;
use crate::server_settings;
use crate::text::iso_now;
use serde_json::{Value, json};

const FIELD: &str = "threadPullRequestAutoFix";

fn enabled(settings: &Value, thread_id: &str) -> bool {
    settings[FIELD][thread_id]["enabled"].as_bool() == Some(true)
}

fn setting_patch(thread_id: &str, enabled: bool, set_at: &str) -> Value {
    json!({FIELD: {thread_id: {"enabled": enabled, "setAt": set_at}}})
}

fn status(is_enabled: bool) -> &'static str {
    if is_enabled {
        crate::i18n::tr("notice.autoFixOn")
    } else {
        crate::i18n::tr("notice.autoFixOff")
    }
}

pub fn run(app: &mut App, argument: &str) {
    let Active::Thread(thread_id) = &app.active else {
        app.notice = Some(crate::i18n::tr("notice.autoFixThread").into());
        return;
    };
    let requested = match argument.trim() {
        "" => {
            app.say(
                Tone::Info,
                status(enabled(&app.config["settings"], thread_id)),
            );
            return;
        }
        "on" => true,
        "off" => false,
        _ => {
            app.say(Tone::Info, "/autofix [on|off]");
            return;
        }
    };
    let id = thread_id.clone();
    let key = id.clone();
    server_settings::patch(
        app,
        move |current| {
            (enabled(current, &id) != requested).then(|| setting_patch(&id, requested, &iso_now()))
        },
        move |app, result| {
            if app.active != Active::Thread(key.clone()) {
                return;
            }
            match result {
                Ok(patched) => app.say(Tone::Done, status(enabled(&patched.after, &key))),
                Err(error) => app.say(Tone::Error, &error),
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autofix_defaults_off_and_emits_a_scoped_settings_patch() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/config/thread-pr-auto-fix-patch.json"
        ))
        .unwrap();
        let set_at = fixture[FIELD]["thread-1"]["setAt"].as_str().unwrap();
        assert_eq!(setting_patch("thread-1", true, set_at), fixture);
        assert!(!enabled(&json!({}), "thread-1"));
        assert!(enabled(&fixture, "thread-1"));
        assert!(!enabled(&fixture, "another-thread"));
        assert!(!enabled(
            &setting_patch("thread-1", false, set_at),
            "thread-1"
        ));
    }
}
