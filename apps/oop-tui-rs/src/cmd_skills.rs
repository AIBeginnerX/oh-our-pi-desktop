//! `/skills`: the skills OOP ships, and installing them. The list is the server's
//! (`server.listBundledSkills`, the same one Settings shows); picking a row or running
//! `/skills install <name>` writes the skill into the folders Claude Code and Codex/Cursor read
//! (`server.installBundledSkill`), after which the provider lists it and `/<name>` runs it.

use crate::app::{App, Modal, Msg, Pick};
use crate::panels_common::{flat, s};
use serde_json::{Value, json};

const LIST_RPC: &str = "server.listBundledSkills";
const INSTALL_RPC: &str = "server.installBundledSkill";
/// Where an install goes; both, so the skill works whichever provider the thread uses.
const TARGETS: [&str; 2] = ["claude", "agents"];

pub fn run(app: &mut App, argument: &str) {
    let mut words = argument.split_whitespace();
    match (words.next(), words.next(), words.next()) {
        (None, ..) => list(app),
        (Some("install"), Some(name), None) => install(app, name),
        _ => {
            app.notice = Some(
                s(
                    "Usage: /skills · /skills install <name>",
                    "사용법: /skills · /skills install <이름>",
                )
                .into(),
            )
        }
    }
}

fn connected(app: &mut App) -> Option<crate::wire::Rpc> {
    let rpc = app.rpc.clone();
    if rpc.is_none() {
        app.notice = Some(
            s(
                "Skills are available once the server is connected.",
                "서버와 연결된 뒤에 사용할 수 있습니다.",
            )
            .into(),
        );
    }
    rpc
}

fn list(app: &mut App) {
    let Some(rpc) = connected(app) else { return };
    let tx = app.sender();
    tokio::spawn(async move {
        let result = rpc.call(LIST_RPC, json!({})).await;
        let _ = tx.send(Msg::Ext(Box::new(move |app| listed(app, result))));
    });
}

fn listed(app: &mut App, result: Result<Value, String>) {
    match result {
        Ok(answer) => {
            let (items, data) = rows(&answer);
            app.modal = Some(Modal::Pick(Pick {
                id: "skills",
                title: s("OOP skills · Enter installs", "OOP 스킬 · Enter로 설치").to_string(),
                cursor: 0,
                items,
                data,
                typed: None,
            }));
        }
        Err(reason) => app.notice = Some(failed(&reason)),
    }
}

fn failed(reason: &str) -> String {
    format!(
        "{} {}",
        s(
            "Could not list the skills:",
            "스킬 목록을 가져오지 못했습니다:"
        ),
        flat(reason)
    )
}

fn status_word(status: &str) -> &'static str {
    match status {
        "installed" => s("installed", "설치됨"),
        "not-installed" => s("not installed", "미설치"),
        _ => s("different file", "다른 파일 있음"),
    }
}

/// One row per skill, `name · claude: installed · agents: not installed`, and the names behind them.
fn rows(list: &Value) -> (Vec<String>, Vec<String>) {
    let skills = list["skills"].as_array().cloned().unwrap_or_default();
    let mut items = Vec::new();
    let mut data = Vec::new();
    for skill in &skills {
        let name = skill["name"].as_str().unwrap_or_default();
        let targets: Vec<String> = skill["targets"]
            .as_array()
            .map(|t| {
                t.iter()
                    .map(|t| {
                        format!(
                            "{}: {}",
                            t["target"].as_str().unwrap_or_default(),
                            status_word(t["status"].as_str().unwrap_or_default())
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.push(format!("{name} · {}", targets.join(" · ")));
        data.push(name.to_string());
    }
    (items, data)
}

pub fn picked(app: &mut App, pick: &Pick, index: usize) {
    if let Some(name) = pick.data.get(index) {
        install(app, name);
    }
}

fn install(app: &mut App, name: &str) {
    let Some(rpc) = connected(app) else { return };
    app.notice = Some(s("Installing…", "설치하는 중…").into());
    let name = name.to_string();
    let tx = app.sender();
    tokio::spawn(async move {
        let mut outcomes = Vec::new();
        for target in TARGETS {
            let result = rpc
                .call(INSTALL_RPC, json!({"name": name, "target": target}))
                .await;
            outcomes.push((target, result.map(|_| ())));
        }
        let _ = tx.send(Msg::Ext(Box::new(move |app| {
            app.notice = Some(summary(&name, &outcomes));
        })));
    });
}

/// `name — claude: installed · agents: <why not>`; a refusal (a different skill of that name is
/// there) is the server's own sentence and nothing was replaced.
fn summary(name: &str, outcomes: &[(&str, Result<(), String>)]) -> String {
    let parts: Vec<String> = outcomes
        .iter()
        .map(|(target, outcome)| match outcome {
            Ok(()) => format!("{target}: {}", status_word("installed")),
            Err(reason) => format!("{target}: {}", flat(reason)),
        })
        .collect();
    format!("{name} — {}", parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};

    fn list_answer(installed: bool) -> Value {
        let status = if installed {
            "installed"
        } else {
            "not-installed"
        };
        json!({"skills": [
            {"name": "paper-analysis", "description": "d", "targets": [
                {"target": "claude", "status": status}, {"target": "agents", "status": "different"}]},
            {"name": "deep-research", "description": "d", "targets": [
                {"target": "claude", "status": "not-installed"}, {"target": "agents", "status": "not-installed"}]},
        ]})
    }

    #[test]
    fn the_command_is_listed_and_dispatched() {
        assert!(crate::slash::COMMANDS.iter().any(|c| c.name == "skills"));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new("0.0.0", "/tmp", "/tmp", tx);
        assert!(crate::cmd::run(&mut app, "skills", "bogus words"));
        assert!(app.notice.as_deref().unwrap().contains("/skills install"));
        assert!(crate::cmd::run(&mut app, "skills", ""));
        assert!(app.notice.is_some(), "offline says so");
    }

    #[test]
    fn rows_name_each_target_and_keep_the_skill_behind_the_row() {
        let (items, data) = rows(&list_answer(true));
        assert_eq!(data, ["paper-analysis", "deep-research"]);
        assert!(items[0].starts_with("paper-analysis · claude: "));
        assert!(items[0].contains(" · agents: "));
        assert_ne!(items[0], items[1]);
    }

    #[test]
    fn a_refused_target_is_reported_beside_the_one_that_worked() {
        let text = summary(
            "retro",
            &[
                ("claude", Ok(())),
                (
                    "agents",
                    Err("A different skill is already installed".into()),
                ),
            ],
        );
        assert!(text.starts_with("retro — claude: "));
        assert!(text.contains("agents: A different skill"));
    }

    #[tokio::test]
    async fn the_list_opens_and_a_picked_row_installs_into_both_folders() {
        let (port, seen) = serve(|tag, payload| match tag {
            LIST_RPC => Some(Ok(list_answer(false))),
            INSTALL_RPC => {
                assert_eq!(payload["name"], "deep-research");
                Some(Ok(list_answer(true)))
            }
            _ => None,
        })
        .await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId": "p1"})), false).await;
        run(&mut app, "");
        next(&mut app, &mut rx).await;
        let Some(Modal::Pick(pick)) = app.modal.clone() else {
            panic!("the list should be open");
        };
        assert_eq!(pick.id, "skills");
        assert_eq!(pick.data.len(), 2);

        picked(&mut app, &pick, 1);
        next(&mut app, &mut rx).await;
        assert!(
            app.notice
                .as_deref()
                .unwrap()
                .starts_with("deep-research — claude: ")
        );
        let targets: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(tag, _)| tag == INSTALL_RPC)
            .map(|(_, p)| p["target"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(targets, ["claude", "agents"]);
    }

    #[tokio::test]
    async fn an_installed_provider_skill_typed_as_a_slash_goes_out_as_a_mention() {
        let (port, seen) =
            serve(|tag, _| (tag == crate::app::DISPATCH_RPC).then(|| Ok(json!({})))).await;
        let (mut app, mut rx) = connected(port, two_turns(json!({"projectId": "p1"})), false).await;
        app.config["providers"][0]["skills"] = json!([
            {"name": "paper-analysis", "enabled": true, "path": "/x"},
            {"name": "hidden", "enabled": true, "userInvocable": false, "path": "/y"},
        ]);
        app.input.set("/Paper-Analysis arxiv:1706.03762");
        app.submit();
        assert!(app.input.is_empty(), "sent, not refused");
        next(&mut app, &mut rx).await;
        let sent = seen
            .lock()
            .unwrap()
            .iter()
            .find(|(tag, _)| tag == crate::app::DISPATCH_RPC)
            .map(|(_, p)| p["message"]["text"].as_str().unwrap().to_string());
        assert_eq!(sent.as_deref(), Some("$paper-analysis arxiv:1706.03762"));

        for text in ["/hidden", "/not-installed"] {
            app.input.set(text);
            app.submit();
            assert_eq!(app.input.text(), text, "{text} is still unknown");
            assert_eq!(
                app.notice.as_deref(),
                Some(crate::i18n::tr("notice.unknownCommand"))
            );
        }
    }
}
