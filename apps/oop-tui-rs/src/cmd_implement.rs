//! `/implement`: what the desktop app's Implement button sends. The plan goes as the message
//! `PLEASE IMPLEMENT THIS PLAN:` and the plan, in the plain mode, naming the plan as its source so
//! the server marks it built. The thread leaves plan mode first, as the app's does. Ported from
//! `implementPlan` of apps/oop-tui/src/app/controller.ts.

use crate::app::{App, DISPATCH_RPC, Msg};
use crate::commands::{self, Ctx, Turn};
use crate::panels_common::s;
use crate::text::new_id;
use crate::thread::{Plan, Thread};

/// The plan the thread would build: the one of its latest turn, else the newest of all.
pub fn latest_plan(thread: &Thread) -> Option<&Plan> {
    let newest = |plans: Vec<&'_ Plan>| -> Option<usize> {
        (0..plans.len()).max_by(|&a, &b| {
            (plans[a].updated_at.as_str(), plans[a].id.as_str())
                .cmp(&(plans[b].updated_at.as_str(), plans[b].id.as_str()))
        })
    };
    let all: Vec<&Plan> = thread.proposed_plans.iter().collect();
    if let Some(turn) = thread.latest_turn.as_ref().map(|t| t.turn_id.as_str())
        && !turn.is_empty()
    {
        let matching: Vec<&Plan> = all
            .iter()
            .copied()
            .filter(|p| p.turn_id.as_deref() == Some(turn))
            .collect();
        if let Some(at) = newest(matching.clone()) {
            return Some(matching[at]);
        }
    }
    newest(all.clone()).map(|at| all[at])
}

/// The message `/implement` sends for a plan.
pub fn implementation_prompt(plan_markdown: &str) -> String {
    format!("PLEASE IMPLEMENT THIS PLAN:\n{}", plan_markdown.trim())
}

pub fn run(app: &mut App) {
    let Some(id) = app.thread_id() else {
        app.notice = Some(no_plan().into());
        return;
    };
    let thread_loaded = app.conv.loaded && app.conv.thread_id == id;
    let latest = thread_loaded
        .then(|| latest_plan(&app.conv.thread))
        .flatten();
    let Some(plan) = latest.filter(|p| p.implemented_at.is_none()) else {
        app.notice = Some(
            if latest.is_some() {
                s(
                    "That plan is already implemented. Send a message to do it again.",
                    "이미 구현한 계획입니다. 다시 하려면 메시지를 보내세요.",
                )
            } else {
                no_plan()
            }
            .into(),
        );
        return;
    };
    let (plan_id, markdown) = (plan.id.clone(), plan.plan_markdown.clone());
    let refusal = if app.approval().is_some() || app.pending_input().is_some() {
        Some(s(
            "Answer the pending approval or question first.",
            "대기 중인 승인이나 질문에 먼저 답하세요.",
        ))
    } else if app
        .thread_shell(&id)
        .is_some_and(crate::sidebar::is_crew_sub_thread)
    {
        Some(s(
            "This is a crew task thread. Implement the plan in the lead: /crew back",
            "crew 작업 스레드입니다. 계획은 lead 에서 구현하세요: /crew back",
        ))
    } else if app.conv.busy() {
        Some(s(
            "You cannot send while work is running. Press Esc to interrupt.",
            "작업 중에는 보낼 수 없습니다. Esc로 중단하세요.",
        ))
    } else if crate::cmd_history::undo_active(app) {
        Some(s(
            "Undo is in progress. You can send once it finishes.",
            "되돌리는 중입니다. 끝난 뒤에 보낼 수 있습니다.",
        ))
    } else if app.rpc.is_none() {
        Some(s(
            "You can send once the server is connected.",
            "서버와 연결된 뒤에 보낼 수 있습니다.",
        ))
    } else if app.awaiting.is_some() {
        Some(s(
            "Waiting for the work from the message you just sent to start. Try again in a moment.",
            "방금 보낸 메시지의 작업이 시작되기를 기다리는 중입니다. 잠시 뒤에 다시 시도하세요.",
        ))
    } else {
        None
    };
    if let Some(refusal) = refusal {
        app.notice = Some(refusal.into());
        return;
    }
    let Some(rpc) = app.rpc.clone() else { return };

    // A turn start does not change the mode of a thread that exists, so a thread in plan mode (or
    // with a pick of it on its way) is set to the plain mode first, in the same order the server
    // will see them.
    let ctx = Ctx::fresh();
    let was_plan =
        app.interaction_mode() != "default" || app.conv.thread.interaction_mode != "default";
    let set_mode = was_plan.then(|| commands::interaction_mode_set(&Ctx::fresh(), &id, "default"));
    let before = app.interaction_intent.replace("default".into());
    let message_id = new_id();
    let runtime_mode = app.runtime_mode();
    let command = commands::turn_start_from_plan(
        &ctx,
        &Turn {
            thread_id: &id,
            message_id: &message_id,
            text: &implementation_prompt(&markdown),
            model: app.model_override.as_ref(),
            runtime_mode: &runtime_mode,
            interaction_mode: "default",
            bootstrap: None,
        },
        &id,
        &plan_id,
    );
    #[cfg(test)]
    {
        if let Some(set) = &set_mode {
            app.log.push(set.clone());
        }
        app.log.push(command.clone());
    }
    app.notice = None;
    app.scroll.set(0);
    app.awaiting = Some(app.tick);
    let tx = app.sender();
    tokio::spawn(async move {
        let mut result = Ok(());
        if let Some(set) = set_mode {
            result = rpc.call(DISPATCH_RPC, set).await.map(|_| ());
        }
        if result.is_ok() {
            result = rpc.call(DISPATCH_RPC, command).await.map(|_| ());
        }
        let msg = match result {
            Ok(()) => Msg::Dispatched {
                result: Ok(()),
                open: None,
                answered: None,
            },
            // The mode the screen showed is back, since the turn does not run under the other.
            Err(reason) => Msg::Ext(Box::new(move |app| {
                if app.interaction_intent.as_deref() == Some("default") {
                    app.interaction_intent = before;
                }
                app.awaiting = None;
                app.notice = Some(reason);
            })),
        };
        let _ = tx.send(msg);
    });
}

fn no_plan() -> &'static str {
    s(
        "There is no plan to implement. Turn on plan mode with /plan and make a request to get one.",
        "구현할 계획이 없습니다. /plan 으로 계획 모드를 켜고 요청하면 계획이 나옵니다.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd_history::testkit::{connected, next, serve, two_turns};
    use serde_json::json;

    fn plan(id: &str, turn: &str, updated: &str, implemented: bool) -> serde_json::Value {
        json!({"id": id, "turnId": turn, "planMarkdown": format!("  # {id}\n\nstep  \n"),
            "implementedAt": if implemented { json!("2026-01-02T00:00:00.000Z") } else { json!(null) },
            "implementationThreadId": null, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": updated})
    }

    fn with_plans(plans: serde_json::Value, mode: &str) -> serde_json::Value {
        two_turns(json!({"proposedPlans": plans, "interactionMode": mode}))
    }

    #[tokio::test]
    async fn the_plan_is_the_latest_turns_else_the_newest() {
        let (port, _) = serve(|_, _| None).await;
        let thread = with_plans(
            json!([
                plan("p-a", "turn-2", "2026-01-01T00:00:05.000Z", false),
                plan("p-b", "turn-2", "2026-01-01T00:00:06.000Z", false),
                plan("p-c", "turn-1", "2026-01-01T00:00:09.000Z", false)
            ]),
            "plan",
        );
        let (app, _rx) = connected(port, thread, false).await;
        assert_eq!(latest_plan(&app.conv.thread).unwrap().id, "p-b");
        let (port, _) = serve(|_, _| None).await;
        let thread = with_plans(
            json!([
                plan("p-a", "turn-1", "2026-01-01T00:00:05.000Z", false),
                plan("p-c", "turn-1", "2026-01-01T00:00:05.000Z", false)
            ]),
            "plan",
        );
        let (app, _rx) = connected(port, thread, false).await;
        assert_eq!(
            latest_plan(&app.conv.thread).unwrap().id,
            "p-c",
            "ties go by id"
        );
        assert_eq!(
            implementation_prompt("  # Plan\n\nstep \n"),
            "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\nstep"
        );
    }

    #[tokio::test]
    async fn a_plan_in_plan_mode_leaves_it_and_starts_the_turn_from_the_plan() {
        let (port, seen) =
            serve(|tag, _| (tag == DISPATCH_RPC).then(|| Ok(json!({"sequence": 9})))).await;
        let thread = with_plans(
            json!([plan("p1", "turn-2", "2026-01-01T00:00:06.000Z", false)]),
            "plan",
        );
        let (mut app, mut rx) = connected(port, thread, false).await;
        run(&mut app);
        assert_eq!(app.log.len(), 2, "{:?}", app.notice);
        assert_eq!(app.log[0]["type"], "thread.interaction-mode.set");
        assert_eq!(app.log[0]["interactionMode"], "default");
        let start = &app.log[1];
        assert_eq!(start["type"], "thread.turn.start");
        assert_eq!(
            start["message"]["text"],
            "PLEASE IMPLEMENT THIS PLAN:\n# p1\n\nstep"
        );
        assert_eq!(start["interactionMode"], "default");
        assert_eq!(
            start["sourceProposedPlan"],
            json!({"threadId": "t1", "planId": "p1"})
        );
        assert_eq!(app.interaction_mode(), "default");
        assert!(app.awaiting.is_some());
        next(&mut app, &mut rx).await;
        let seen = seen.lock().unwrap();
        let sent: Vec<&str> = seen
            .iter()
            .filter(|(tag, _)| tag == DISPATCH_RPC)
            .map(|(_, p)| p["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            sent,
            ["thread.interaction-mode.set", "thread.turn.start"],
            "in this order"
        );
    }

    #[tokio::test]
    async fn a_thread_already_in_the_plain_mode_only_starts_the_turn() {
        let (port, _) = serve(|tag, _| (tag == DISPATCH_RPC).then(|| Ok(json!({})))).await;
        let thread = with_plans(
            json!([plan("p1", "turn-2", "2026-01-01T00:00:06.000Z", false)]),
            "default",
        );
        let (mut app, _rx) = connected(port, thread, false).await;
        run(&mut app);
        assert_eq!(app.log.len(), 1);
        assert_eq!(app.log[0]["type"], "thread.turn.start");
    }

    #[tokio::test]
    async fn a_failed_mode_change_stops_the_turn_and_restores_the_screen() {
        let (port, seen) =
            serve(|tag, _| (tag == DISPATCH_RPC).then(|| Err("no way".to_string()))).await;
        let thread = with_plans(
            json!([plan("p1", "turn-2", "2026-01-01T00:00:06.000Z", false)]),
            "plan",
        );
        let (mut app, mut rx) = connected(port, thread, false).await;
        run(&mut app);
        next(&mut app, &mut rx).await;
        assert_eq!(app.notice.as_deref(), Some("no way"));
        assert!(app.awaiting.is_none());
        assert_eq!(app.interaction_mode(), "plan");
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|(t, _)| t == DISPATCH_RPC)
                .count(),
            1,
            "the turn was never sent"
        );
    }

    #[tokio::test]
    async fn every_refusal_says_why_and_sends_nothing() {
        let (port, _) = serve(|_, _| None).await;
        let thread = with_plans(
            json!([plan("p1", "turn-2", "2026-01-01T00:00:06.000Z", false)]),
            "plan",
        );
        let (mut app, _rx) = connected(port, thread, false).await;
        let said = |app: &App| app.notice.clone().unwrap_or_default();

        app.conv.thread.session.as_mut().unwrap().status = "running".into();
        run(&mut app);
        assert_eq!(
            said(&app),
            s(
                "You cannot send while work is running. Press Esc to interrupt.",
                "작업 중에는 보낼 수 없습니다. Esc로 중단하세요."
            )
        );
        app.conv.thread.session.as_mut().unwrap().status = "ready".into();

        app.awaiting = Some(0);
        run(&mut app);
        assert!(said(&app).contains(s("Waiting for the work", "방금 보낸 메시지")));
        app.awaiting = None;

        let rpc = app.rpc.take();
        run(&mut app);
        assert!(said(&app).contains(s("once the server is connected", "연결된 뒤에")));
        app.rpc = rpc;

        app.shell.threads[0].parent_thread_id = Some("lead".into());
        run(&mut app);
        assert!(said(&app).contains("/crew back"));
        app.shell.threads[0].parent_thread_id = None;

        assert!(app.log.is_empty());
    }

    #[tokio::test]
    async fn no_plan_and_a_built_plan_are_told_apart() {
        let (port, _) = serve(|_, _| None).await;
        let (mut app, _rx) = connected(port, with_plans(json!([]), "default"), false).await;
        run(&mut app);
        assert!(app.notice.as_deref().unwrap().contains("/plan"));
        let (port, _) = serve(|_, _| None).await;
        let thread = with_plans(
            json!([plan("p1", "turn-2", "2026-01-01T00:00:06.000Z", true)]),
            "default",
        );
        let (mut built, _rx) = connected(port, thread, false).await;
        run(&mut built);
        assert_eq!(
            built.notice.as_deref(),
            Some(s(
                "That plan is already implemented. Send a message to do it again.",
                "이미 구현한 계획입니다. 다시 하려면 메시지를 보내세요."
            ))
        );
        assert!(built.log.is_empty());
    }
}
