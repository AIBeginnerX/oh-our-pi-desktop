//! The latest work of a thread: what the right-hand panes (Workflow, Agents, Savvy, Files) show.
//! One piece of work is one user turn: the latest message the user wrote and everything it set
//! going, including the follow-up turns the crew sends the lead (audit fixes, late reports), which
//! carry a `<oop_crew_follow_up>` marker and are not new requests. Older work is left out of the
//! panes' input; the conversation, `/replay`, `/stats` and the server's data are untouched.
//!
//! Which activities belong to the latest work:
//! - its start is the time of the user's latest message; with none loaded (an empty thread or a
//!   draft, or a page of history that stops short of it) nothing is older, so everything counts;
//! - an activity with a turn id belongs when its *turn* began at or after that start, so an auditor
//!   that reports on an earlier turn after the user has written again stays with the earlier work;
//! - an activity without one belongs when it happened at or after the start;
//! - a task (crew task, subagent, workflow member) is decided as a whole by the activity that
//!   started it, with one exception: a task begun in earlier work that is still running stays
//!   until it ends. Running is what the panes would show: a subagent or workflow member whose
//!   provider session is alive, a crew task whose lead turn is still the active one (the crew
//!   board reads a crew task of a turn that is over as stopped, so that one is old work);
//! - the context-window report is not work but the state of the conversation, so it always stays.
//!
//! The user's time is the client's and the activities' the server's; with a skewed clock on a
//! remote server the edge can move by that much.

use crate::flow::AgentStatus;
use crate::savvy_panel::lead_cost_in;
use crate::text::parse_iso_ms;
use crate::thread::{Activity, Role, Thread};
use std::collections::{HashMap, HashSet};

/// The marker OOP puts on the lead messages it sends itself (`crewLogic.ts`, `FOLLOW_UP_MARKER`).
const FOLLOW_UP_MARKER: &str = "<oop_crew_follow_up ";

/// Kinds that carry a `taskId` and are decided per task.
const TASK_KINDS: [&str; 5] = [
    "task.started",
    "task.progress",
    "task.updated",
    "task.completed",
    "tool.progress",
];

/// A thread cut down to its latest work, and what cannot be read off the cut thread.
pub struct LatestWork {
    /// Only the fields the panes read (id, project, title, session, latest turn, activities).
    pub thread: Thread,
    /// What the lead's session cost during this work: the growth of the running totals Claude
    /// reported, measured from the total the work began with (see `lead_cost_in`).
    pub lead_cost: Option<f64>,
}

/// `a` is before `b`: by time when both read as one, else by text (stamps of one format sort so).
fn earlier(a: &str, b: &str) -> bool {
    match (parse_iso_ms(a), parse_iso_ms(b)) {
        (Some(a), Some(b)) => a < b,
        _ => a < b,
    }
}

/// The start of the latest work: when the user's latest own message was written.
fn start_of(thread: &Thread) -> Option<&str> {
    thread
        .messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User && !m.text.contains(FOLLOW_UP_MARKER))
        .map(|m| m.created_at.as_str())
}

fn task_id(activity: &Activity) -> Option<&str> {
    TASK_KINDS
        .contains(&activity.kind.as_str())
        .then(|| activity.payload["taskId"].as_str())
        .flatten()
}

/// The activity says its task is over.
fn ends_task(activity: &Activity) -> bool {
    match activity.kind.as_str() {
        "task.completed" => true,
        "task.updated" | "task.progress" => {
            activity.payload["status"].as_str().is_some_and(|status| {
                AgentStatus::parse(status).is_some_and(AgentStatus::terminal)
                    || matches!(status, "partial" | "blocked" | "stopped")
            })
        }
        _ => false,
    }
}

/// Which activities of a thread are of its latest work.
struct Scope<'a> {
    start: Option<&'a str>,
    /// When each turn first showed up (an activity or a message of it).
    turn_began: HashMap<&'a str, &'a str>,
    /// Tasks that began in earlier work and are still going.
    carried: HashSet<&'a str>,
    /// Tasks that began in the latest work.
    own: HashSet<&'a str>,
}

impl<'a> Scope<'a> {
    fn of(thread: &'a Thread) -> Scope<'a> {
        let start = start_of(thread);
        let mut turn_began: HashMap<&str, &str> = HashMap::new();
        let stamps = thread
            .activities
            .iter()
            .map(|a| (a.turn_id.as_deref(), a.created_at.as_str()))
            .chain(
                thread
                    .messages
                    .iter()
                    .map(|m| (m.turn_id.as_deref(), m.created_at.as_str())),
            );
        for (turn, at) in stamps {
            let Some(turn) = turn else { continue };
            let slot = turn_began.entry(turn).or_insert(at);
            if earlier(at, slot) {
                *slot = at;
            }
        }
        let mut scope = Scope {
            start,
            turn_began,
            carried: HashSet::new(),
            own: HashSet::new(),
        };
        if start.is_none() {
            return scope;
        }
        // A task is decided by its first activity; it is carried when that one is old and no
        // activity of it has ended it.
        let mut first: HashMap<&str, &Activity> = HashMap::new();
        let mut ended: HashSet<&str> = HashSet::new();
        for activity in &thread.activities {
            let Some(id) = task_id(activity) else {
                continue;
            };
            let slot = first.entry(id).or_insert(activity);
            if earlier(&activity.created_at, &slot.created_at) {
                *slot = activity;
            }
            if ends_task(activity) {
                ended.insert(id);
            }
        }
        let alive = crate::flow::session_live(thread);
        let active = thread
            .session
            .as_ref()
            .filter(|s| s.status == "running")
            .and_then(|s| s.active_turn_id.as_deref());
        for (id, activity) in first {
            if scope.in_work(activity) {
                scope.own.insert(id);
                continue;
            }
            let crew = activity.payload["crewRole"].is_string();
            let running = alive
                && !ended.contains(id)
                && (!crew || (active.is_some() && active == activity.turn_id.as_deref()));
            if running {
                scope.carried.insert(id);
            }
        }
        scope
    }

    /// The activity is of the latest work by when it happened (or its turn began).
    fn in_work(&self, activity: &Activity) -> bool {
        let Some(start) = self.start else { return true };
        let began = activity
            .turn_id
            .as_deref()
            .and_then(|turn| self.turn_began.get(turn).copied())
            .unwrap_or(&activity.created_at);
        !earlier(began, start)
    }

    fn keeps(&self, activity: &Activity) -> bool {
        if self.start.is_none() || activity.kind == "context-window.updated" {
            return true;
        }
        match task_id(activity) {
            Some(id) => self.own.contains(id) || self.carried.contains(id),
            None => self.in_work(activity),
        }
    }
}

/// The thread as the panes see it right after a request went out and before its message came
/// back: no work of it exists yet, so only the conversation's own state (the context window)
/// stays.
pub fn fresh_work(thread: &Thread) -> LatestWork {
    LatestWork {
        lead_cost: None,
        thread: Thread {
            id: thread.id.clone(),
            project_id: thread.project_id.clone(),
            title: thread.title.clone(),
            session: thread.session.clone(),
            activities: thread
                .activities
                .iter()
                .filter(|a| a.kind == "context-window.updated")
                .cloned()
                .collect(),
            ..Thread::default()
        },
    }
}

/// The thread as the panes see it: only its latest work (see the module notes).
pub fn latest_work(thread: &Thread) -> LatestWork {
    let scope = Scope::of(thread);
    LatestWork {
        lead_cost: lead_cost_in(thread, |a| scope.keeps(a)),
        thread: Thread {
            id: thread.id.clone(),
            project_id: thread.project_id.clone(),
            title: thread.title.clone(),
            latest_turn: thread.latest_turn.clone(),
            session: thread.session.clone(),
            activities: thread
                .activities
                .iter()
                .filter(|a| scope.keeps(a))
                .cloned()
                .collect(),
            ..Thread::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::scenes::ts;
    use serde_json::{Value, json};

    fn thread(messages: Vec<Value>, activities: Vec<Value>, session: &str) -> Thread {
        thread_in(messages, activities, session, None)
    }

    fn thread_in(
        messages: Vec<Value>,
        activities: Vec<Value>,
        session: &str,
        active_turn: Option<&str>,
    ) -> Thread {
        serde_json::from_value(json!({
            "id": "lead", "projectId": "p1", "title": "Lead",
            "messages": messages, "activities": activities,
            "session": {"status": session, "activeTurnId": active_turn},
        }))
        .expect("thread")
    }

    fn user(sec: i64, text: &str) -> Value {
        json!({"id": format!("u{sec}"), "role": "user", "text": text, "createdAt": ts(sec)})
    }

    fn act(sec: i64, turn: &str, kind: &str, payload: Value) -> Value {
        json!({
            "id": format!("a{sec}"), "tone": "info", "kind": kind, "summary": kind,
            "payload": payload, "turnId": turn, "createdAt": ts(sec),
        })
    }

    fn task(sec: i64, turn: &str, kind: &str, id: &str, status: Value) -> Value {
        act(
            sec,
            turn,
            kind,
            json!({"taskId": id, "crewRole": "worker", "status": status}),
        )
    }

    fn ids(work: &LatestWork) -> Vec<String> {
        work.thread
            .activities
            .iter()
            .map(|a| a.id.clone())
            .collect()
    }

    fn follow_up(sec: i64) -> Value {
        user(
            sec,
            "<oop_crew_follow_up round=\"1\" fixes=\"1\">\nfix it\n</oop_crew_follow_up>",
        )
    }

    #[test]
    fn latest_work_scope_keeps_everything_without_a_user_message() {
        // An empty thread, a draft, or a page of history that stops short of the user's message.
        let t = thread(
            vec![],
            vec![act(5, "t1", "tool.updated", json!({"toolCallId": "x"}))],
            "ready",
        );
        assert_eq!(ids(&latest_work(&t)), ["a5"]);
        assert!(latest_work(&Thread::default()).thread.activities.is_empty());
    }

    #[test]
    fn latest_work_scope_drops_earlier_turns_and_keeps_the_context_report() {
        let t = thread(
            vec![user(0, "first"), user(20, "second")],
            vec![
                act(2, "t1", "tool.updated", json!({"toolCallId": "x"})),
                act(
                    3,
                    "t1",
                    "context-window.updated",
                    json!({"usedTokens": 5, "maxTokens": 10}),
                ),
                act(22, "t2", "tool.updated", json!({"toolCallId": "y"})),
            ],
            "ready",
        );
        assert_eq!(ids(&latest_work(&t)), ["a3", "a22"]);
    }

    #[test]
    fn latest_work_scope_spans_the_follow_up_turns_of_one_message() {
        // The lead's turn t1, then OOP's own follow-up turn t2: one piece of work.
        let t = thread(
            vec![user(0, "old"), user(10, "do it"), follow_up(30)],
            vec![
                act(1, "t0", "tool.updated", json!({"toolCallId": "o"})),
                act(12, "t1", "tool.updated", json!({"toolCallId": "a"})),
                act(32, "t2", "tool.updated", json!({"toolCallId": "b"})),
            ],
            "ready",
        );
        assert_eq!(ids(&latest_work(&t)), ["a12", "a32"]);
    }

    #[test]
    fn latest_work_scope_leaves_a_late_report_on_earlier_work_there() {
        // The auditor of turn t1 reports after the user has written again: it is t1's.
        let t = thread(
            vec![user(0, "first"), user(20, "second")],
            vec![
                act(2, "t1", "tool.updated", json!({"toolCallId": "x"})),
                act(25, "t1", "crew.audit-skipped", json!({"changedFiles": []})),
                act(26, "t2", "tool.updated", json!({"toolCallId": "y"})),
            ],
            "ready",
        );
        assert_eq!(ids(&latest_work(&t)), ["a26"]);
    }

    #[test]
    fn latest_work_scope_keeps_a_running_task_of_earlier_work_until_it_ends() {
        // A subagent (no crew role) begun before the user wrote again, still going.
        let sub = |sec: i64, kind: &str, id: &str, status: Value| {
            act(sec, "t1", kind, json!({"taskId": id, "status": status}))
        };
        let messages = vec![user(0, "first"), user(20, "second")];
        let mut activities = vec![
            sub(2, "task.started", "slow", Value::Null),
            sub(3, "task.started", "quick", Value::Null),
            sub(4, "task.completed", "quick", json!("completed")),
            act(22, "t2", "tool.updated", json!({"toolCallId": "y"})),
        ];
        let t = thread(messages.clone(), activities.clone(), "running");
        assert_eq!(ids(&latest_work(&t)), ["a2", "a22"]);
        // A session that is gone runs nothing, so nothing is carried.
        let t = thread(messages.clone(), activities.clone(), "stopped");
        assert_eq!(ids(&latest_work(&t)), ["a22"]);
        // Once it ends it is of the earlier work like the rest, and so is its closing report.
        activities.push(sub(30, "task.completed", "slow", json!("completed")));
        let t = thread(messages, activities, "running");
        assert_eq!(ids(&latest_work(&t)), ["a22"]);
    }

    #[test]
    fn latest_work_scope_keeps_a_crew_task_only_while_its_turn_is_the_active_one() {
        let crew = |sec: i64| task(sec, "t1", "task.started", "worker-1", Value::Null);
        let messages = vec![user(0, "first"), user(20, "second")];
        // Written from elsewhere while the lead's turn t1 still runs: the crew board shows its
        // task running, so it stays.
        let t = thread_in(messages.clone(), vec![crew(2)], "running", Some("t1"));
        assert_eq!(ids(&latest_work(&t)), ["a2"]);
        // The lead has moved on to t2: the board reads the task of t1 as stopped, which is old work.
        let t = thread_in(messages, vec![crew(2)], "running", Some("t2"));
        assert!(ids(&latest_work(&t)).is_empty());
    }

    #[test]
    fn latest_work_scope_counts_the_cost_from_the_total_the_work_began_with() {
        let usage = |sec: i64, turn: &str, cost: f64| {
            act(
                sec,
                turn,
                "owned-usage",
                json!({
                    "scope": "main-turn", "costUsd": cost,
                    "source": {"driver": "claudeAgent", "instanceId": "i", "runtimeEventId": format!("e{sec}")},
                }),
            )
        };
        let t = thread(
            vec![user(0, "first"), user(20, "second")],
            vec![
                usage(2, "t1", 1.0),
                usage(22, "t2", 1.5),
                usage(24, "t2", 2.25),
            ],
            "ready",
        );
        let work = latest_work(&t);
        assert_eq!(work.lead_cost, Some(1.25), "2.25 now, 1.0 before this work");
        assert_eq!(crate::savvy_panel::lead_cost(&t), Some(2.25));
        // No report in the latest work: no cost, not the old one.
        let quiet = thread(
            vec![user(0, "first"), user(20, "second")],
            vec![usage(2, "t1", 1.0)],
            "ready",
        );
        assert_eq!(latest_work(&quiet).lead_cost, None);
    }
}
