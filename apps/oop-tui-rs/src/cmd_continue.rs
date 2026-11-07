//! `/continue`: a new thread in the same project and on the same model, starting from the short
//! handoff note the server builds from this one (`orchestration.getThreadHandoffSeed`, the note the
//! web app's "Continue in new thread" uses). The note lands in the message box as a draft to edit;
//! nothing is sent. The status line offers the command once the context window is nearly full of a
//! provider that cannot compact it itself.

use crate::app::{App, Msg};
use crate::panels_common::{flat, s};
use crate::savvy_panel::context_percent;
use serde_json::{Value, json};

const SEED_RPC: &str = "orchestration.getThreadHandoffSeed";

/// The fill, in percent, at which a provider that does not compact is offered a fresh start.
const SUGGEST_AT_PERCENT: u8 = 70;

/// Drivers whose sessions compact their own context. The same rule is
/// `shouldSuggestContextHandoff` in `apps/web/src/lib/contextHandoff.ts`.
const COMPACTING_DRIVERS: [&str; 2] = ["claudeAgent", "codex"];

pub fn handoff_suggested(percent: Option<u8>, driver: Option<&str>) -> bool {
    percent.is_some_and(|p| p >= SUGGEST_AT_PERCENT)
        && !driver.is_some_and(|d| COMPACTING_DRIVERS.contains(&d))
}

/// The status-line hint for the thread on screen, when it applies.
pub fn hint(app: &App) -> Option<&'static str> {
    let id = app.thread_id()?;
    if !(app.conv.loaded && app.conv.thread_id == id) {
        return None;
    }
    let thread = &app.conv.thread;
    let instance = thread.model_selection["instanceId"].as_str()?;
    let driver = app.config["providers"]
        .as_array()
        .and_then(|providers| providers.iter().find(|p| p["instanceId"] == instance))
        .and_then(|p| p["driver"].as_str());
    handoff_suggested(context_percent(thread), driver).then(|| {
        s(
            "Context is nearly full · /continue starts a new thread from a short summary",
            "컨텍스트가 거의 찼습니다 · /continue 로 요약에서 새 스레드를 시작하세요",
        )
    })
}

pub fn run(app: &mut App) {
    let Some(id) = app
        .thread_id()
        .filter(|id| app.conv.loaded && app.conv.thread_id == *id)
    else {
        app.notice = Some(
            s(
                "Open a thread that has started first.",
                "시작된 스레드를 먼저 여세요.",
            )
            .into(),
        );
        return;
    };
    let Some(rpc) = app.rpc.clone() else {
        app.notice = Some(
            s(
                "You can continue once the server is connected.",
                "서버와 연결된 뒤에 이어갈 수 있습니다.",
            )
            .into(),
        );
        return;
    };
    let project = app.conv.thread.project_id.clone();
    let model = app.conv.thread.model_selection.clone();
    app.notice = Some(s("Preparing the summary…", "요약을 준비하는 중…").into());
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(SEED_RPC, json!({"threadId": id})).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            opened(app, &id, &project, model, result)
        })));
    });
}

fn opened(app: &mut App, from: &str, project: &str, model: Value, result: Result<Value, String>) {
    // The user may have moved on while the server was working.
    if app.thread_id().as_deref() != Some(from) {
        return;
    }
    app.notice = None;
    let seed = match result {
        Ok(answer) => answer["seed"].as_str().map(str::to_string),
        Err(reason) => {
            app.notice = Some(format!(
                "{} {}",
                s(
                    "Could not prepare the summary:",
                    "요약을 만들지 못했습니다:"
                ),
                flat(&reason)
            ));
            return;
        }
    };
    let Some(seed) = seed.filter(|_| !project.is_empty()) else {
        return;
    };
    app.start_draft(project);
    if !model.is_null() {
        app.model_override = Some(model);
    }
    // A note already waiting in that project's draft stays, below the summary.
    let waiting = app.input.text();
    app.input.set(&if waiting.trim().is_empty() {
        seed
    } else {
        format!("{seed}\n\n{waiting}")
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};

    #[test]
    fn the_hint_starts_at_seventy_percent_and_skips_compacting_providers() {
        for driver in [Some("cursor"), Some("grok"), Some("opencode"), None] {
            assert!(!handoff_suggested(Some(69), driver));
            assert!(handoff_suggested(Some(70), driver));
            assert!(handoff_suggested(Some(100), driver));
        }
        assert!(!handoff_suggested(Some(95), Some("claudeAgent")));
        assert!(!handoff_suggested(Some(95), Some("codex")));
        assert!(!handoff_suggested(None, Some("cursor")));
    }

    #[test]
    fn the_command_is_listed_and_dispatched() {
        let found: Vec<_> = crate::slash::matches(crate::slash::COMMANDS, "continue")
            .iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(found, ["continue"]);
        assert_eq!(
            crate::slash::matches(crate::slash::COMMANDS, "cont")[0].name,
            "continue"
        );
        // a name nothing runs is still refused, so a hit here means `cmd::run` knows it
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        assert!(crate::cmd::run(&mut app, "continue", ""));
        assert!(app.notice.is_some(), "no thread is open to continue");
    }

    #[tokio::test]
    async fn the_server_note_becomes_an_unsent_draft_on_the_same_model() {
        let (port, seen) = serve(|tag, payload| {
            (tag == SEED_RPC).then(|| {
                assert_eq!(payload["threadId"], "t1");
                Ok(json!({"seed": "Continuing from thread \"x\"\n\nGoal: g"}))
            })
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId": "p1"})), false).await;
        run(&mut app);
        next(&mut app, &mut rx).await;
        assert!(app.thread_id().is_none(), "a draft, not the old thread");
        assert!(app.input.text().starts_with("Continuing from thread"));
        assert_eq!(
            app.model_override.as_ref().unwrap()["model"],
            "gpt-5",
            "same model"
        );
        assert!(app.notice.is_none());
        let sent: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(t, _)| t.clone())
            .collect();
        assert!(
            !sent.iter().any(|t| t.contains("dispatchCommand")),
            "{sent:?}"
        );
    }
}
