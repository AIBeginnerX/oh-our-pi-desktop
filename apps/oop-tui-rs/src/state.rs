//! What the screen shows, folded from the server's two streams. Only the fields the slice reads are
//! named; everything else the server sends is ignored, so a new field in the contracts never
//! breaks this client. A field the slice depends on changing shape does, which the tests below
//! pin against payloads captured from the real server.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

pub use crate::thread::{LatestTurn, Session};
use crate::thread::{Outcome, Thread};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadShell {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub settled_override: Option<String>,
    pub settled_at: Option<String>,
    pub unsettled_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub snoozed_at: Option<String>,
    pub pinned_at: Option<String>,
    pub pin_order_key: Option<String>,
    pub active_order_key: Option<String>,
    pub parent_thread_id: Option<String>,
    pub latest_user_message_at: Option<String>,
    pub latest_turn: Option<LatestTurn>,
    pub session: Option<Session>,
    pub background_liveness: Option<String>,
    pub has_pending_approvals: bool,
    pub has_pending_user_input: bool,
    pub worktree_path: Option<String>,
    /// The crew the thread has of its own; `None` when it runs the default crew.
    pub crew: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectShell {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
    pub updated_at: String,
    pub default_model_selection: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ShellSnapshot {
    snapshot_sequence: u64,
    projects: Vec<ProjectShell>,
    threads: Vec<ThreadShell>,
}

/// The projects and threads list, kept current by the shell stream.
#[derive(Debug, Default)]
pub struct Shell {
    pub loaded: bool,
    pub sequence: u64,
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
}

impl Shell {
    pub fn apply(&mut self, item: &Value) {
        match item["kind"].as_str() {
            Some("snapshot") => {
                if let Ok(snap) = serde_json::from_value::<ShellSnapshot>(item["snapshot"].clone())
                {
                    self.loaded = true;
                    self.sequence = snap.snapshot_sequence;
                    self.projects = snap.projects;
                    self.threads = snap.threads;
                }
            }
            Some("project-upserted") => {
                if let Ok(project) = serde_json::from_value::<ProjectShell>(item["project"].clone())
                {
                    upsert(&mut self.projects, project, |p| &p.id);
                }
            }
            Some("project-removed") => {
                let id = item["projectId"].as_str().unwrap_or_default();
                self.projects.retain(|p| p.id != id);
            }
            Some("thread-upserted") => {
                if let Ok(thread) = serde_json::from_value::<ThreadShell>(item["thread"].clone()) {
                    upsert(&mut self.threads, thread, |t| &t.id);
                }
            }
            Some("thread-removed") => {
                let id = item["threadId"].as_str().unwrap_or_default();
                self.threads.retain(|t| t.id != id);
            }
            _ => return,
        }
        if let Some(sequence) = item["sequence"].as_u64() {
            self.sequence = self.sequence.max(sequence);
        }
    }
}

fn upsert<T>(list: &mut Vec<T>, item: T, id: impl Fn(&T) -> &String) {
    match list.iter().position(|existing| id(existing) == id(&item)) {
        Some(at) => list[at] = item,
        None => list.push(item),
    }
}

/// An approval the agent waits for.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub request_id: String,
    pub kind: String,
    pub detail: String,
    /// `(decision, label)` the provider offers; empty means the standard four.
    pub options: Vec<(String, String)>,
}

/// One question of a user-input request.
#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<(String, String)>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingInput {
    pub request_id: String,
    pub questions: Vec<Question>,
}

/// Messages held before the oldest pages read by scrolling up are let go (see `Conversation::trim`).
pub const HELD_MESSAGES: usize = 200;

/// What one page of older turns added, and the cursor that reads it again.
#[derive(Debug, Default, Clone)]
struct Page {
    cursor: String,
    messages: HashSet<String>,
    activities: HashSet<String>,
    checkpoints: HashSet<String>,
}

/// The open thread, folded from its stream: a snapshot, then events (deduplicated by sequence).
#[derive(Debug, Default)]
pub struct Conversation {
    pub thread_id: String,
    pub loaded: bool,
    pub synchronized: bool,
    pub deleted: bool,
    pub sequence: Option<u64>,
    pub thread: Thread,
    /// The server holds turns older than the window that was loaded.
    pub has_more: bool,
    pub older_cursor: Option<String>,
    pub loading_older: bool,
    /// Counts changes, so a cache of rendered lines knows when it is stale.
    pub revision: u64,
    /// The older pages read since the snapshot, newest first, so the oldest can be let go.
    pages: Vec<Page>,
}

impl Conversation {
    pub fn new(thread_id: &str) -> Self {
        Conversation {
            thread_id: thread_id.to_string(),
            ..Default::default()
        }
    }

    pub fn session(&self) -> Option<&Session> {
        self.thread.session.as_ref()
    }

    /// True while the agent is working on a turn.
    pub fn busy(&self) -> bool {
        self.thread.session_running() || self.thread.messages.iter().any(|m| m.streaming)
    }

    pub fn apply(&mut self, item: &Value) {
        match item["kind"].as_str() {
            // The flag nothing reads does not change the picture; a snapshot replaces the thread.
            Some("synchronized") => self.synchronized = true,
            Some("snapshot") => {
                self.apply_snapshot(&item["snapshot"]);
                self.revision += 1;
            }
            // Only what the reducer changed (Updated or Deleted) invalidates the rendered lines.
            Some("event") if self.apply_event(&item["event"]) => self.revision += 1,
            _ => {}
        }
    }

    fn apply_snapshot(&mut self, snapshot: &Value) {
        let Ok(thread) = serde_json::from_value::<Thread>(snapshot["thread"].clone()) else {
            return;
        };
        self.thread = thread;
        self.pages.clear();
        self.loaded = true;
        self.deleted = false;
        self.sequence = snapshot["snapshotSequence"].as_u64();
        self.has_more = snapshot["page"]["hasMore"].as_bool() == Some(true);
        self.older_cursor = snapshot["page"]["beforeCursor"]
            .as_str()
            .map(str::to_string);
        self.loading_older = false;
    }

    /// Folds one stream event in; true when the reducer changed what the thread shows (Updated or
    /// Deleted), so the caller knows to bump the revision the transcript cache is keyed on.
    fn apply_event(&mut self, event: &Value) -> bool {
        let sequence = event["sequence"].as_u64();
        if let (Some(have), Some(new)) = (self.sequence, sequence)
            && new <= have
        {
            return false;
        }
        let outcome = self.thread.apply_event(event);
        if outcome == Outcome::Deleted {
            self.deleted = true;
        }
        if sequence.is_some() {
            self.sequence = sequence;
        }
        matches!(outcome, Outcome::Updated | Outcome::Deleted)
    }

    /// A page of older turns, read over HTTP, goes in front of what is held.
    pub fn apply_older(&mut self, snapshot: &Value) {
        if let Ok(page) = serde_json::from_value::<Thread>(snapshot["thread"].clone()) {
            let held = |ids: HashSet<&str>, new: Vec<&str>| -> HashSet<String> {
                new.into_iter()
                    .filter(|id| !ids.contains(id))
                    .map(str::to_string)
                    .collect()
            };
            let t = &self.thread;
            let added = Page {
                cursor: self.older_cursor.clone().unwrap_or_default(),
                messages: held(
                    t.messages.iter().map(|m| m.id.as_str()).collect(),
                    page.messages.iter().map(|m| m.id.as_str()).collect(),
                ),
                activities: held(
                    t.activities.iter().map(|a| a.id.as_str()).collect(),
                    page.activities.iter().map(|a| a.id.as_str()).collect(),
                ),
                checkpoints: held(
                    t.checkpoints.iter().map(|c| c.turn_id.as_str()).collect(),
                    page.checkpoints
                        .iter()
                        .map(|c| c.turn_id.as_str())
                        .collect(),
                ),
            };
            self.thread.merge_older(page);
            if !added.cursor.is_empty() {
                self.pages.push(added);
            }
        }
        self.has_more = snapshot["page"]["hasMore"].as_bool() == Some(true);
        self.older_cursor = snapshot["page"]["beforeCursor"]
            .as_str()
            .map(str::to_string);
        self.loading_older = false;
        self.revision += 1;
    }

    /// Lets the oldest pages read by scrolling up go while more than `HELD_MESSAGES` are held,
    /// and points the cursor back at them, so scrolling up reads them again. The snapshot's own
    /// window stays: it has no cursor to be read back with. True when something was dropped.
    pub fn trim(&mut self) -> bool {
        let mut dropped = false;
        while self.thread.messages.len() > HELD_MESSAGES
            && let Some(page) = self.pages.pop()
        {
            let t = &mut self.thread;
            t.messages.retain(|m| !page.messages.contains(&m.id));
            t.activities.retain(|a| !page.activities.contains(&a.id));
            t.checkpoints
                .retain(|c| !page.checkpoints.contains(&c.turn_id));
            self.older_cursor = Some(page.cursor);
            self.has_more = true;
            dropped = true;
        }
        if dropped {
            self.revision += 1;
        }
        dropped
    }

    /// Approvals asked for and not yet answered, oldest first.
    pub fn pending_approvals(&self) -> Vec<PendingApproval> {
        let mut pending: Vec<PendingApproval> = Vec::new();
        for activity in &self.thread.activities {
            let id = activity.payload["requestId"].as_str().unwrap_or_default();
            match activity.kind.as_str() {
                "approval.requested" if !id.is_empty() => {
                    pending.retain(|p| p.request_id != id);
                    let options = activity.payload["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|o| {
                            Some((
                                o["decision"].as_str()?.to_string(),
                                o["label"].as_str()?.to_string(),
                            ))
                        })
                        .collect();
                    pending.push(PendingApproval {
                        request_id: id.to_string(),
                        kind: activity.payload["requestKind"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        detail: activity.payload["detail"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        options,
                    });
                }
                "approval.resolved" => pending.retain(|p| p.request_id != id),
                _ => {}
            }
        }
        pending
    }

    /// Questions the agent waits for an answer to (native-callback requests only; a
    /// `responseMode: "message"` question is answered by an ordinary message).
    pub fn pending_inputs(&self) -> Vec<PendingInput> {
        let mut pending: Vec<PendingInput> = Vec::new();
        for activity in &self.thread.activities {
            let id = activity.payload["requestId"].as_str().unwrap_or_default();
            match activity.kind.as_str() {
                "user-input.requested"
                    if !id.is_empty() && activity.payload["responseMode"] != "message" =>
                {
                    pending.retain(|p| p.request_id != id);
                    let questions = activity.payload["questions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|q| {
                            Some(Question {
                                id: q["id"].as_str()?.to_string(),
                                header: q["header"].as_str().unwrap_or_default().to_string(),
                                question: q["question"].as_str().unwrap_or_default().to_string(),
                                options: q["options"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|o| {
                                        Some((
                                            o["label"].as_str()?.to_string(),
                                            o["description"]
                                                .as_str()
                                                .unwrap_or_default()
                                                .to_string(),
                                        ))
                                    })
                                    .collect(),
                                multi_select: q["multiSelect"].as_bool() == Some(true),
                            })
                        })
                        .collect();
                    pending.push(PendingInput {
                        request_id: id.to_string(),
                        questions,
                    });
                }
                "user-input.resolved" => pending.retain(|p| p.request_id != id),
                _ => {}
            }
        }
        pending
    }
}

/// `instanceId/model` for display.
pub fn model_name(selection: &Value) -> String {
    match (
        selection["instanceId"]
            .as_str()
            .or(selection["provider"].as_str()),
        selection["model"].as_str(),
    ) {
        (Some(instance), Some(model)) => format!("{instance}/{model}"),
        (None, Some(model)) => model.to_string(),
        _ => String::new(),
    }
}

/// A model a new thread can start on.
#[derive(Debug, Clone)]
pub struct Choice {
    pub instance_id: String,
    pub model: String,
}

/// The first provider that is enabled, installed and not unavailable, with its default model.
pub fn first_usable_model(config: &Value) -> Option<Choice> {
    config["providers"].as_array()?.iter().find_map(|provider| {
        let usable = provider["enabled"].as_bool() == Some(true)
            && provider["installed"].as_bool() == Some(true)
            && provider["availability"].as_str() != Some("unavailable");
        if !usable {
            return None;
        }
        let models = provider["models"].as_array()?;
        let model = models
            .iter()
            .find(|m| m["isDefault"].as_bool() == Some(true))
            .or(models.first())?;
        Some(Choice {
            instance_id: provider["instanceId"].as_str()?.to_string(),
            model: model["slug"].as_str()?.to_string(),
        })
    })
}

/// Every model a thread can run on, in provider order: `(instance id, provider name, slug, name)`.
pub fn usable_models(config: &Value) -> Vec<ModelChoice> {
    let mut out = Vec::new();
    for provider in config["providers"].as_array().into_iter().flatten() {
        let usable = provider["enabled"].as_bool() == Some(true)
            && provider["installed"].as_bool() == Some(true)
            && provider["availability"].as_str() != Some("unavailable");
        let Some(instance) = provider["instanceId"].as_str().filter(|_| usable) else {
            continue;
        };
        for model in provider["models"].as_array().into_iter().flatten() {
            let Some(slug) = model["slug"].as_str() else {
                continue;
            };
            out.push(ModelChoice {
                instance_id: instance.to_string(),
                provider: provider["displayName"]
                    .as_str()
                    .unwrap_or(instance)
                    .to_string(),
                slug: slug.to_string(),
                name: model["name"].as_str().unwrap_or(slug).to_string(),
            });
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct ModelChoice {
    pub instance_id: String,
    pub provider: String,
    pub slug: String,
    pub name: String,
}

/// The reasoning-effort control a model offers: its first `select` option descriptor.
#[derive(Debug, Clone, PartialEq)]
pub struct EffortControl {
    pub descriptor_id: String,
    /// `(value, label)`.
    pub choices: Vec<(String, String)>,
    /// The value in force when the selection names none: the descriptor's own, else the default.
    pub default: Option<String>,
}

pub fn effort_control(config: &Value, selection: &Value) -> Option<EffortControl> {
    let provider = config["providers"]
        .as_array()?
        .iter()
        .find(|p| p["instanceId"] == selection["instanceId"])?;
    let wanted = selection["model"].as_str()?;
    let model = provider["models"].as_array()?.iter().find(|m| {
        m["slug"].as_str() == Some(wanted)
            || m["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(wanted)))
    })?;
    let descriptor = model["capabilities"]["optionDescriptors"]
        .as_array()?
        .iter()
        .find(|d| d["type"] == "select")?;
    let options = descriptor["options"].as_array()?;
    if options.is_empty() {
        return None;
    }
    Some(EffortControl {
        descriptor_id: descriptor["id"].as_str()?.to_string(),
        choices: options
            .iter()
            .filter_map(|o| {
                let id = o["id"].as_str()?;
                Some((
                    id.to_string(),
                    o["label"].as_str().unwrap_or(id).to_string(),
                ))
            })
            .collect(),
        default: descriptor["currentValue"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                options
                    .iter()
                    .find(|o| o["isDefault"] == true)
                    .and_then(|o| o["id"].as_str())
                    .map(str::to_string)
            }),
    })
}

/// The selection with one option set (replacing the same option if it is there).
pub fn with_option(selection: &Value, id: &str, value: &str) -> Value {
    let mut out = selection.clone();
    let mut options: Vec<Value> = selection["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|o| o["id"] != id)
        .cloned()
        .collect();
    options.push(serde_json::json!({"id": id, "value": value}));
    out["options"] = Value::Array(options);
    out
}

/// The effort a selection runs with, for the status line: its own option, else the default.
pub fn effort_of(config: &Value, selection: &Value) -> Option<String> {
    let control = effort_control(config, selection)?;
    selection["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|o| o["id"].as_str() == Some(control.descriptor_id.as_str()))
        .and_then(|o| o["value"].as_str().map(str::to_string))
        .or(control.default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A snapshot or older page of `count` messages named `{prefix}0..`, whose next cursor is `next`.
    fn page(prefix: &str, count: usize, next: Option<&str>) -> Value {
        let messages: Vec<Value> = (0..count)
            .map(|i| json!({"id": format!("{prefix}{i}"), "role": "user", "text": "x", "createdAt": "2026-01-01T00:00:00.000Z"}))
            .collect();
        json!({"snapshotSequence": 1, "page": {"hasMore": next.is_some(), "beforeCursor": next},
            "thread": {"messages": messages, "activities": [], "checkpoints": []}})
    }

    #[test]
    fn old_pages_are_let_go_oldest_first_and_read_again_from_their_cursor() {
        let mut conv = Conversation::new("t");
        conv.apply(&json!({"kind": "snapshot", "snapshot": page("s", 150, Some("c1"))}));
        // Within the budget nothing goes, whatever was read.
        conv.apply_older(&page("p1", 40, Some("c2")));
        assert!(!conv.trim());
        assert_eq!(conv.thread.messages.len(), 190);
        conv.apply_older(&page("p2", 40, Some("c3")));
        conv.apply_older(&page("p3", 40, None));
        assert_eq!(conv.thread.messages.len(), 270);
        assert!(!conv.has_more);
        // Over it: pages go from the oldest until the budget holds, the snapshot's window stays.
        assert!(conv.trim());
        assert_eq!(conv.thread.messages.len(), 190);
        assert!(conv.thread.messages.iter().any(|m| m.id == "p10"));
        assert!(!conv.thread.messages.iter().any(|m| m.id.starts_with("p2")));
        // Scrolling up asks for the page that was dropped, and gets it back in front.
        assert!(conv.has_more);
        assert_eq!(conv.older_cursor.as_deref(), Some("c2"));
        conv.apply_older(&page("p2", 40, Some("c3")));
        assert_eq!(conv.thread.messages.len(), 230);
        assert_eq!(conv.thread.messages[0].id, "p20");
        assert_eq!(conv.older_cursor.as_deref(), Some("c3"));
        // A new snapshot forgets the pages: there is nothing left to give back.
        conv.apply(&json!({"kind": "snapshot", "snapshot": page("s", 250, None)}));
        assert!(!conv.trim());
        assert_eq!(conv.thread.messages.len(), 250);
    }

    fn event(sequence: u64, kind: &str, payload: Value) -> Value {
        json!({"kind": "event", "event": {"sequence": sequence, "type": kind, "occurredAt": "o", "payload": payload}})
    }

    #[test]
    fn only_events_that_change_the_thread_bump_the_revision() {
        let mut conv = Conversation::new("t");
        conv.apply(&json!({"kind": "snapshot", "snapshot": page("s", 1, None)}));
        let after_snapshot = conv.revision;
        assert!(after_snapshot > 0);
        // A known event that changes nothing keeps the rendered-lines cache valid.
        conv.apply(&event(
            2,
            "project.created",
            json!({"project": {"id": "p"}}),
        ));
        assert_eq!(conv.revision, after_snapshot);
        // So does an event this build has no arm for, and a replayed one.
        conv.apply(&event(3, "thread.event-from-a-newer-server", json!({})));
        conv.apply(&event(2, "thread.pinned", json!({"pinnedAt": "x"})));
        assert_eq!(conv.revision, after_snapshot);
        // A changed one invalidates it again.
        conv.apply(&event(4, "thread.pinned", json!({"pinnedAt": "x"})));
        assert_eq!(conv.revision, after_snapshot + 1);
    }

    fn delta(sequence: u64, id: &str, text: &str, streaming: bool) -> Value {
        event(
            sequence,
            "thread.message-sent",
            json!({"messageId": id, "role": "assistant", "text": text, "streaming": streaming, "turnId": "t", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}),
        )
    }

    #[test]
    fn streamed_deltas_append_and_a_replayed_event_changes_nothing() {
        let mut c = Conversation::new("t");
        c.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 5, "thread": {"title": "T", "messages": [
            {"id": "u1", "role": "user", "text": "hi", "streaming": false, "createdAt": "2026-01-01T00:00:00.000Z"}]}}}));
        c.apply(&delta(6, "a1", "안", true));
        c.apply(&delta(7, "a1", "녕", true));
        assert!(c.busy());
        c.apply(&delta(8, "a1", "안녕하세요", false));
        assert!(!c.busy());
        assert_eq!(c.thread.messages[1].text, "안녕하세요");
        c.apply(&delta(7, "a1", "녕", true));
        assert_eq!(c.thread.messages.len(), 2);
        assert_eq!(c.thread.messages[1].text, "안녕하세요");
    }

    #[test]
    fn approvals_and_questions_are_pending_until_resolved() {
        let mut c = Conversation::new("t");
        let activity = |seq, id: &str, kind: &str, payload: Value| {
            event(
                seq,
                "thread.activity-appended",
                json!({"activity": {"id": id, "tone": "info", "kind": kind, "summary": "s", "payload": payload, "turnId": "t", "createdAt": id}}),
            )
        };
        c.apply(&activity(
            1,
            "a",
            "approval.requested",
            json!({"requestId": "r1", "requestKind": "command", "detail": "ls"}),
        ));
        c.apply(&activity(2, "b", "user-input.requested", json!({"requestId": "r2", "questions": [{"id": "q", "header": "H", "question": "Which?", "options": [{"label": "x", "description": "d"}]}]})));
        c.apply(&activity(
            3,
            "c",
            "user-input.requested",
            json!({"requestId": "r3", "responseMode": "message", "questions": []}),
        ));
        assert_eq!(c.pending_approvals().len(), 1);
        assert_eq!(
            c.pending_inputs().len(),
            1,
            "a message-mode question is answered by a message"
        );
        assert_eq!(c.pending_inputs()[0].questions[0].options[0].0, "x");
        c.apply(&activity(
            4,
            "d",
            "approval.resolved",
            json!({"requestId": "r1"}),
        ));
        c.apply(&activity(
            5,
            "e",
            "user-input.resolved",
            json!({"requestId": "r2"}),
        ));
        assert!(c.pending_approvals().is_empty() && c.pending_inputs().is_empty());
    }

    #[test]
    fn shell_snapshot_and_events_fold() {
        let mut s = Shell::default();
        s.apply(&json!({"kind": "snapshot", "snapshot": {"snapshotSequence": 3, "projects": [{"id": "p", "title": "demo", "workspaceRoot": "/w"}], "threads": []}}));
        s.apply(&json!({"kind": "thread-upserted", "sequence": 4, "thread": {"id": "t", "projectId": "p", "title": "hello", "updatedAt": "z"}}));
        assert_eq!((s.projects.len(), s.threads.len(), s.sequence), (1, 1, 4));
        s.apply(&json!({"kind": "thread-removed", "sequence": 5, "threadId": "t"}));
        assert!(s.threads.is_empty());
    }

    #[test]
    fn a_threads_own_crew_comes_with_the_shell_and_null_means_the_default() {
        let mut s = Shell::default();
        let thread = |id: &str, crew: Value| json!({"kind": "thread-upserted", "thread": {"id": id, "projectId": "p", "title": id, "crew": crew}});
        s.apply(&thread("a", json!({"enabled": true, "pinned": {}})));
        s.apply(&thread("b", Value::Null));
        s.apply(&json!({"kind": "thread-upserted", "thread": {"id": "c", "projectId": "p", "title": "c"}}));
        let crew = |id: &str| s.threads.iter().find(|t| t.id == id).unwrap().crew.clone();
        assert_eq!(crew("a"), Some(json!({"enabled": true, "pinned": {}})));
        assert_eq!((crew("b"), crew("c")), (None, None));
    }

    #[test]
    fn effort_comes_from_the_models_first_select_descriptor() {
        let config = json!({"providers": [{"instanceId": "codex", "models": [{"slug": "gpt", "aliases": ["g"], "capabilities": {"optionDescriptors": [
            {"id": "fast", "type": "boolean"},
            {"id": "reasoningEffort", "type": "select", "options": [{"id": "low", "label": "Low"}, {"id": "high", "label": "High", "isDefault": true}]}]}}]}]});
        let selection = json!({"instanceId": "codex", "model": "g"});
        let control = effort_control(&config, &selection).unwrap();
        assert_eq!(control.descriptor_id, "reasoningEffort");
        assert_eq!(control.choices.len(), 2);
        assert_eq!(effort_of(&config, &selection).as_deref(), Some("high"));
        let low = with_option(
            &with_option(&selection, "reasoningEffort", "high"),
            "reasoningEffort",
            "low",
        );
        assert_eq!(
            low["options"],
            json!([{"id": "reasoningEffort", "value": "low"}])
        );
        assert_eq!(effort_of(&config, &low).as_deref(), Some("low"));
        assert!(effort_control(&config, &json!({"instanceId": "codex", "model": "zzz"})).is_none());
    }

    #[test]
    fn picks_the_first_usable_provider_default_model() {
        let config = json!({"providers": [
            {"instanceId": "off", "enabled": false, "installed": true, "models": [{"slug": "a"}]},
            {"instanceId": "codex", "enabled": true, "installed": true, "models": [{"slug": "x"}, {"slug": "y", "isDefault": true}]}]});
        let choice = first_usable_model(&config).unwrap();
        assert_eq!(
            (choice.instance_id.as_str(), choice.model.as_str()),
            ("codex", "y")
        );
        assert!(first_usable_model(&json!({"providers": []})).is_none());
        assert_eq!(usable_models(&config).len(), 2);
    }
}
