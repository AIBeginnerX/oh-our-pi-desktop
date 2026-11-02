//! Every command oop-rs sends through `orchestration.dispatchCommand`, as pure builders. The shape
//! of each is pinned by `fixtures/commands/*.json`, which `scripts/export-fixtures.mjs` writes
//! through the real contract schemas; the tests at the bottom build each fixture's `args` and
//! compare with its `command`. A field the server's schema renames fails there, not in a session.

use crate::text::{iso_now, new_id};
use serde_json::{Value, json};

/// The two fields every command carries; a parameter so the tests can fix them.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub command_id: String,
    pub created_at: String,
}

impl Ctx {
    pub fn fresh() -> Ctx {
        Ctx {
            command_id: new_id(),
            created_at: iso_now(),
        }
    }
}

pub fn project_create(ctx: &Ctx, project_id: &str, title: &str, workspace_root: &str) -> Value {
    json!({
        "type": "project.create", "commandId": ctx.command_id, "projectId": project_id,
        "title": title, "workspaceRoot": workspace_root, "createdAt": ctx.created_at,
    })
}

/// Where a first message creates its thread.
pub struct Bootstrap<'a> {
    pub project_id: &'a str,
}

pub struct Turn<'a> {
    pub thread_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    /// The model for this turn; a new thread needs one, an existing thread keeps its own unless
    /// the user picked another (`/model`, `/effort`).
    pub model: Option<&'a Value>,
    pub runtime_mode: &'a str,
    pub interaction_mode: &'a str,
    pub bootstrap: Option<Bootstrap<'a>>,
}

/// The first line of a message, cut to 60 characters: the title a new thread starts with.
pub fn title_seed(text: &str) -> String {
    text.chars().take(60).collect()
}

pub fn turn_start(ctx: &Ctx, turn: &Turn) -> Value {
    let mut command = json!({
        "type": "thread.turn.start", "commandId": ctx.command_id, "threadId": turn.thread_id,
        "message": {"messageId": turn.message_id, "role": "user", "text": turn.text, "attachments": []},
    });
    if let Some(model) = turn.model {
        command["modelSelection"] = model.clone();
    }
    if turn.bootstrap.is_some() {
        command["titleSeed"] = json!(title_seed(turn.text));
    }
    command["runtimeMode"] = json!(turn.runtime_mode);
    command["interactionMode"] = json!(turn.interaction_mode);
    if let Some(Bootstrap { project_id }) = &turn.bootstrap {
        command["bootstrap"] = json!({"createThread": {
            "projectId": project_id, "title": title_seed(turn.text),
            "modelSelection": turn.model, "runtimeMode": turn.runtime_mode,
            "interactionMode": turn.interaction_mode, "branch": null, "worktreePath": null,
            "createdAt": ctx.created_at,
        }});
    }
    command["createdAt"] = json!(ctx.created_at);
    command
}

/// A turn that builds a proposed plan (`/implement`): an ordinary turn start that also names the
/// plan, so the server marks it built.
pub fn turn_start_from_plan(ctx: &Ctx, turn: &Turn, plan_thread_id: &str, plan_id: &str) -> Value {
    let mut command = turn_start(ctx, turn);
    command["sourceProposedPlan"] = json!({"threadId": plan_thread_id, "planId": plan_id});
    command
}

/// Rewinds the thread to the state after `turn_count` turns. With `restore_files` the folder goes
/// back to that checkpoint too; without it only the conversation does.
pub fn revert(ctx: &Ctx, thread_id: &str, turn_count: u64, restore_files: bool) -> Value {
    json!({
        "type": if restore_files { "thread.checkpoint.revert" } else { "thread.conversation.revert" },
        "commandId": ctx.command_id, "threadId": thread_id, "turnCount": turn_count,
        "createdAt": ctx.created_at,
    })
}

/// Stops the running turn; without a turn id the server stops whichever is running.
pub fn turn_interrupt(ctx: &Ctx, thread_id: &str, turn_id: Option<&str>) -> Value {
    let mut command = json!({"type": "thread.turn.interrupt", "commandId": ctx.command_id, "threadId": thread_id});
    if let Some(turn_id) = turn_id {
        command["turnId"] = json!(turn_id);
    }
    command["createdAt"] = json!(ctx.created_at);
    command
}

pub fn approval_respond(ctx: &Ctx, thread_id: &str, request_id: &str, decision: &str) -> Value {
    json!({
        "type": "thread.approval.respond", "commandId": ctx.command_id, "threadId": thread_id,
        "requestId": request_id, "decision": decision, "createdAt": ctx.created_at,
    })
}

/// `answers` maps a question id to one answer, or to a list for a multi-select question.
pub fn user_input_respond(ctx: &Ctx, thread_id: &str, request_id: &str, answers: &Value) -> Value {
    json!({
        "type": "thread.user-input.respond", "commandId": ctx.command_id, "threadId": thread_id,
        "requestId": request_id, "answers": answers, "createdAt": ctx.created_at,
    })
}

pub fn runtime_mode_set(ctx: &Ctx, thread_id: &str, runtime_mode: &str) -> Value {
    json!({
        "type": "thread.runtime-mode.set", "commandId": ctx.command_id, "threadId": thread_id,
        "runtimeMode": runtime_mode, "createdAt": ctx.created_at,
    })
}

pub fn interaction_mode_set(ctx: &Ctx, thread_id: &str, interaction_mode: &str) -> Value {
    json!({
        "type": "thread.interaction-mode.set", "commandId": ctx.command_id, "threadId": thread_id,
        "interactionMode": interaction_mode, "createdAt": ctx.created_at,
    })
}

/// The runtime modes `/mode` offers: `(value, label, words accepted besides the value)`.
pub const RUNTIME_MODES: [(&str, &str, &[&str]); 4] = [
    ("approval-required", "Approval required", &["approval"]),
    ("auto-accept-edits", "Auto-accept edits", &["edits"]),
    ("auto", "Auto", &[]),
    ("full-access", "Full access", &["full"]),
];

/// The mode a `/mode` argument names: a value, a short word or the label; `None` when none.
pub fn parse_runtime_mode(word: &str) -> Option<&'static str> {
    let wanted: String = word.split_whitespace().collect::<String>().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    RUNTIME_MODES
        .iter()
        .find(|(value, label, aliases)| {
            *value == wanted
                || aliases.contains(&wanted.as_str())
                || label.split_whitespace().collect::<String>().to_lowercase() == wanted
        })
        .map(|(value, ..)| *value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/commands")
            .join(name);
        serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}")),
        )
        .unwrap()
    }

    fn ctx() -> Ctx {
        let constants: Value = serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/constants.json"),
            )
            .unwrap(),
        )
        .unwrap();
        Ctx {
            command_id: constants["commandId"].as_str().unwrap().into(),
            created_at: constants["now"].as_str().unwrap().into(),
        }
    }

    const THREAD: &str = "thread-1";

    fn str_of(v: &Value) -> &str {
        v.as_str().unwrap()
    }

    #[test]
    fn project_create_matches_its_fixture() {
        let f = fixture("project.create.json");
        let built = project_create(
            &ctx(),
            "project-1",
            str_of(&f["args"]["title"]),
            str_of(&f["args"]["workspaceRoot"]),
        );
        assert_eq!(built, f["command"]);
    }

    #[test]
    fn turn_start_matches_its_three_fixtures() {
        for name in [
            "turn.start.new-thread.json",
            "turn.start.existing.json",
            "turn.start.existing-with-model.json",
        ] {
            let f = fixture(name);
            let a = &f["args"];
            let new_thread = name.contains("new-thread");
            let model = (!a["model"].is_null()).then(|| a["model"].clone());
            let built = turn_start(
                &ctx(),
                &Turn {
                    thread_id: THREAD,
                    message_id: "msg-1",
                    text: str_of(&a["text"]),
                    model: model.as_ref(),
                    runtime_mode: str_of(&a["runtimeMode"]),
                    interaction_mode: str_of(&a["interactionMode"]),
                    bootstrap: new_thread.then_some(Bootstrap {
                        project_id: "project-1",
                    }),
                },
            );
            assert_eq!(built, f["command"], "{name}");
        }
    }

    #[test]
    fn implementing_a_plan_and_reverting_match_their_fixtures() {
        let f = fixture("turn.start.implement-plan.json");
        let a = &f["args"];
        let built = turn_start_from_plan(
            &ctx(),
            &Turn {
                thread_id: THREAD,
                message_id: "msg-1",
                text: str_of(&a["text"]),
                model: None,
                runtime_mode: str_of(&a["runtimeMode"]),
                interaction_mode: str_of(&a["interactionMode"]),
                bootstrap: None,
            },
            THREAD,
            str_of(&a["planId"]),
        );
        assert_eq!(built, f["command"]);
        for (name, restore) in [
            ("checkpoint.revert.json", true),
            ("conversation.revert.json", false),
        ] {
            let f = fixture(name);
            let a = &f["args"];
            assert_eq!(
                revert(&ctx(), THREAD, a["turnCount"].as_u64().unwrap(), restore),
                f["command"],
                "{name}"
            );
        }
    }

    #[test]
    fn interrupt_with_and_without_a_turn_matches() {
        let with = fixture("turn.interrupt.json");
        assert_eq!(
            turn_interrupt(&ctx(), THREAD, with["args"]["turnId"].as_str()),
            with["command"]
        );
        let without = fixture("turn.interrupt.no-turn.json");
        assert_eq!(
            turn_interrupt(&ctx(), THREAD, without["args"]["turnId"].as_str()),
            without["command"]
        );
    }

    #[test]
    fn responses_and_mode_changes_match() {
        let a = fixture("approval.respond.json");
        assert_eq!(
            approval_respond(
                &ctx(),
                THREAD,
                str_of(&a["args"]["requestId"]),
                str_of(&a["args"]["decision"])
            ),
            a["command"]
        );
        let u = fixture("user-input.respond.json");
        assert_eq!(
            user_input_respond(
                &ctx(),
                THREAD,
                str_of(&u["args"]["requestId"]),
                &u["args"]["answers"]
            ),
            u["command"]
        );
        let r = fixture("runtime-mode.set.json");
        assert_eq!(
            runtime_mode_set(&ctx(), THREAD, str_of(&r["args"]["runtimeMode"])),
            r["command"]
        );
        let i = fixture("interaction-mode.set.json");
        assert_eq!(
            interaction_mode_set(&ctx(), THREAD, str_of(&i["args"]["interactionMode"])),
            i["command"]
        );
    }

    #[test]
    fn every_command_fixture_is_covered_by_a_builder_test() {
        // `meta.update-model` is not sent: a turn start that carries `modelSelection` already
        // changes the thread's model on the server, so a separate update would be a second write.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/commands");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "approval.respond.json",
                "checkpoint.revert.json",
                "conversation.revert.json",
                "interaction-mode.set.json",
                "project.create.json",
                "runtime-mode.set.json",
                "turn.interrupt.json",
                "turn.interrupt.no-turn.json",
                "turn.start.existing-with-model.json",
                "turn.start.existing.json",
                "turn.start.implement-plan.json",
                "turn.start.new-thread.json",
                "user-input.respond.json",
            ]
        );
    }

    #[test]
    fn mode_words_resolve() {
        assert_eq!(parse_runtime_mode("full"), Some("full-access"));
        assert_eq!(parse_runtime_mode("Full access"), Some("full-access"));
        assert_eq!(
            parse_runtime_mode("auto-accept-edits"),
            Some("auto-accept-edits")
        );
        assert_eq!(parse_runtime_mode("AUTO"), Some("auto"));
        assert_eq!(parse_runtime_mode("nope"), None);
    }
}
