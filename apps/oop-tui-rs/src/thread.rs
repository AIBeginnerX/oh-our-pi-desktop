//! The open thread's state and the reducer that folds the server's events into it: a port of
//! `applyThreadDetailEvent` in packages/client-runtime/src/state/threadReducer.ts. Every event type
//! the contracts define has its own arm (the 33 in `fixtures/events/_types.json`); a type this build
//! does not know is `Outcome::Unknown`, which the tests treat as a failure for the types it should
//! know and the app treats as "ignore" for types a newer server adds.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Updated,
    Deleted,
    /// A known event that does not change what this thread shows.
    Unchanged,
    /// A type this build has no arm for.
    Unknown,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub status: String,
    pub active_turn_id: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Role {
    User,
    Assistant,
    Reasoning,
    #[default]
    System,
}

impl<'de> Deserialize<'de> for Role {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Ok(match text.as_str() {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            "reasoning" => Role::Reasoning,
            _ => Role::System,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub turn_id: Option<String>,
    pub streaming: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Activity {
    pub id: String,
    pub tone: String,
    pub kind: String,
    pub summary: String,
    pub payload: Value,
    pub turn_id: Option<String>,
    pub sequence: Option<u64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Plan {
    pub id: String,
    pub turn_id: Option<String>,
    pub plan_markdown: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Checkpoint {
    pub turn_id: String,
    pub checkpoint_turn_count: Option<u64>,
    pub status: String,
    pub assistant_message_id: Option<String>,
    pub completed_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LatestTurn {
    pub turn_id: String,
    pub state: String,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub assistant_message_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub model_selection: Value,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub latest_turn: Option<LatestTurn>,
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
    pub auto_settle_disabled_at: Option<String>,
    pub pull_requests: Vec<Value>,
    pub messages: Vec<Message>,
    pub proposed_plans: Vec<Plan>,
    pub activities: Vec<Activity>,
    pub checkpoints: Vec<Checkpoint>,
    pub session: Option<Session>,
}

/// Activity kinds the server stamps with the event sequence (`SERVER_RECORD_ACTIVITY_KINDS`).
const SERVER_RECORD_KINDS: [&str; 4] = [
    "release-verification",
    "selected-check-receipt",
    "owned-usage",
    "task-result",
];
const RESTART_CONTINUATION_PREFIX: &str = "server:restart-continuation:";

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn optional_text(value: &Value) -> Option<Option<String>> {
    match value {
        Value::Null => Some(None),
        Value::String(s) => Some(Some(s.clone())),
        _ => None,
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// Same host, repository and number: the identity of a linked pull request.
fn same_pr(a: &Value, b: &Value) -> bool {
    ["host", "repository", "number"]
        .iter()
        .all(|k| a[*k] == b[*k])
}

fn settled_turn_state(status: &str) -> Option<&'static str> {
    match status {
        "idle" | "ready" => Some("completed"),
        "error" => Some("error"),
        "interrupted" | "stopped" => Some("interrupted"),
        _ => None,
    }
}

fn checkpoint_turn_state(status: &str) -> &'static str {
    if status == "error" {
        "error"
    } else {
        "completed"
    }
}

impl Thread {
    /// True when the session runs a turn.
    pub fn session_running(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| matches!(s.status.as_str(), "starting" | "running"))
    }

    pub fn apply_event(&mut self, event: &Value) -> Outcome {
        let payload = &event["payload"];
        let occurred = text(&event["occurredAt"]).unwrap_or_default();
        let updated = |this: &mut Thread, at: &Value| {
            if let Some(at) = at.as_str() {
                this.updated_at = at.to_string();
            }
        };
        match event["type"].as_str().unwrap_or_default() {
            // Project events never change a thread.
            "project.created" | "project.meta-updated" | "project.deleted" => Outcome::Unchanged,

            "thread.created" => {
                *self = Thread {
                    id: text(&payload["threadId"]).unwrap_or_default(),
                    project_id: text(&payload["projectId"]).unwrap_or_default(),
                    title: text(&payload["title"]).unwrap_or_default(),
                    model_selection: payload["modelSelection"].clone(),
                    runtime_mode: text(&payload["runtimeMode"])
                        .unwrap_or_else(|| "full-access".into()),
                    interaction_mode: text(&payload["interactionMode"])
                        .unwrap_or_else(|| "default".into()),
                    branch: text(&payload["branch"]),
                    worktree_path: text(&payload["worktreePath"]),
                    created_at: text(&payload["createdAt"]).unwrap_or_default(),
                    updated_at: text(&payload["updatedAt"]).unwrap_or_default(),
                    ..Thread::default()
                };
                Outcome::Updated
            }
            "thread.deleted" => Outcome::Deleted,
            "thread.archived" => {
                self.archived_at = text(&payload["archivedAt"]);
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.unarchived" => {
                self.archived_at = None;
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.settled" => {
                self.settled_override = Some("settled".into());
                self.settled_at = text(&payload["settledAt"]);
                self.unsettled_at = None;
                self.active_order_key = None;
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.unsettled" => {
                // A thread already pinned active keeps its re-entry stamp: the activity reset that
                // clears the pin must not reorder the list.
                if self.settled_override.as_deref() != Some("active") {
                    self.unsettled_at = text(&payload["updatedAt"]);
                }
                self.settled_override = (payload["reason"] == "user").then(|| "active".to_string());
                self.settled_at = None;
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.snoozed" => {
                self.snoozed_until = text(&payload["snoozedUntil"]);
                self.snoozed_at = text(&payload["snoozedAt"]);
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.unsnoozed" => {
                self.snoozed_until = None;
                self.snoozed_at = None;
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.pinned" => {
                self.pinned_at = text(&payload["pinnedAt"]);
                if let Some(key) = text(&payload["pinOrderKey"]) {
                    self.pin_order_key = Some(key);
                }
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.unpinned" => {
                self.pinned_at = None;
                self.pin_order_key = None;
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.pin-reordered" => {
                self.pin_order_key = text(&payload["orderKey"]);
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.auto-settle-set" => {
                self.auto_settle_disabled_at = text(&payload["autoSettleDisabledAt"]);
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.meta-updated" => {
                if let Some(title) = text(&payload["title"]) {
                    self.title = title;
                }
                if !payload["modelSelection"].is_null() {
                    self.model_selection = payload["modelSelection"].clone();
                }
                if let Some(branch) = optional_text(&payload["branch"]) {
                    self.branch = branch;
                }
                if let Some(path) = optional_text(&payload["worktreePath"]) {
                    self.worktree_path = path;
                }
                if let Some(key) = optional_text(&payload["activeOrderKey"]) {
                    self.active_order_key = key;
                }
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.pull-request-linked" => {
                let link = payload["link"].clone();
                self.pull_requests
                    .retain(|existing| !same_pr(existing, &link));
                self.pull_requests.push(link);
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.pull-request-unlinked" => {
                self.pull_requests
                    .retain(|existing| !same_pr(existing, payload));
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.pull-request-synced" => {
                if !self.pull_requests.iter().any(|e| same_pr(e, payload)) {
                    return Outcome::Unchanged;
                }
                for existing in self
                    .pull_requests
                    .iter_mut()
                    .filter(|e| same_pr(e, payload))
                {
                    existing["snapshot"] = payload["snapshot"].clone();
                    existing["stack"] = payload["stack"].clone();
                }
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.runtime-mode-set" => {
                if let Some(mode) = text(&payload["runtimeMode"]) {
                    self.runtime_mode = mode;
                }
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }
            "thread.interaction-mode-set" => {
                self.interaction_mode =
                    text(&payload["interactionMode"]).unwrap_or_else(|| "default".into());
                updated(self, &payload["updatedAt"]);
                Outcome::Updated
            }

            // --- turn lifecycle -------------------------------------------------------------
            "thread.turn-start-requested" => {
                if !payload["modelSelection"].is_null() {
                    self.model_selection = payload["modelSelection"].clone();
                }
                self.runtime_mode =
                    text(&payload["runtimeMode"]).unwrap_or_else(|| "full-access".into());
                self.interaction_mode =
                    text(&payload["interactionMode"]).unwrap_or_else(|| "default".into());
                self.updated_at = occurred;
                Outcome::Updated
            }
            "thread.turn-interrupt-requested" => {
                let Some(turn_id) = text(&payload["turnId"]) else {
                    return Outcome::Unchanged;
                };
                let created = text(&payload["createdAt"]).unwrap_or_default();
                match &mut self.latest_turn {
                    Some(turn) if turn.turn_id == turn_id => {
                        turn.state = "interrupted".into();
                        turn.started_at.get_or_insert_with(|| created.clone());
                        turn.completed_at.get_or_insert(created);
                        self.updated_at = occurred;
                        Outcome::Updated
                    }
                    _ => Outcome::Unchanged,
                }
            }

            // --- messages -------------------------------------------------------------------
            "thread.message-sent" => {
                self.apply_message_sent(payload);
                self.updated_at = occurred;
                Outcome::Updated
            }

            // --- session --------------------------------------------------------------------
            "thread.session-set" => {
                let Some(new_session) = parse::<Session>(&payload["session"]) else {
                    return Outcome::Unchanged;
                };
                let restart = new_session.status == "starting"
                    && new_session.active_turn_id.is_none()
                    && event["commandId"]
                        .as_str()
                        .is_some_and(|c| c.starts_with(RESTART_CONTINUATION_PREFIX));
                let settled = if restart {
                    Some("interrupted")
                } else {
                    settled_turn_state(&new_session.status)
                };
                if new_session.status == "running"
                    && let Some(active) = new_session.active_turn_id.clone()
                {
                    let same = self.latest_turn.as_ref().filter(|t| t.turn_id == active);
                    self.latest_turn = Some(LatestTurn {
                        turn_id: active,
                        state: "running".into(),
                        requested_at: same.map_or_else(
                            || new_session.updated_at.clone(),
                            |t| t.requested_at.clone(),
                        ),
                        started_at: Some(
                            same.and_then(|t| t.started_at.clone())
                                .unwrap_or_else(|| new_session.updated_at.clone()),
                        ),
                        completed_at: None,
                        assistant_message_id: same.and_then(|t| t.assistant_message_id.clone()),
                    });
                } else if let (Some(turn), Some(state)) = (&mut self.latest_turn, settled)
                    && turn.state == "running"
                {
                    turn.state = state.into();
                    turn.completed_at = Some(new_session.updated_at.clone());
                }
                self.session = Some(new_session);
                self.updated_at = occurred;
                Outcome::Updated
            }
            "thread.session-stop-requested" => match &mut self.session {
                None => Outcome::Unchanged,
                Some(session) => {
                    session.status = "stopped".into();
                    session.active_turn_id = None;
                    session.updated_at = text(&payload["createdAt"]).unwrap_or_default();
                    self.updated_at = occurred;
                    Outcome::Updated
                }
            },

            // --- plans, checkpoints, revert ------------------------------------------------
            "thread.proposed-plan-upserted" => {
                let Some(plan) = parse::<Plan>(&payload["proposedPlan"]) else {
                    return Outcome::Unchanged;
                };
                self.proposed_plans.retain(|p| p.id != plan.id);
                self.proposed_plans.push(plan);
                self.proposed_plans.sort_by(|a, b| {
                    (a.created_at.as_str(), a.id.as_str())
                        .cmp(&(b.created_at.as_str(), b.id.as_str()))
                });
                self.updated_at = occurred;
                Outcome::Updated
            }
            "thread.turn-diff-completed" => {
                let Some(checkpoint) = parse::<Checkpoint>(payload) else {
                    return Outcome::Unchanged;
                };
                if let Some(existing) = self
                    .checkpoints
                    .iter()
                    .find(|c| c.turn_id == checkpoint.turn_id)
                    && existing.status != "missing"
                    && checkpoint.status == "missing"
                {
                    return Outcome::Unchanged;
                }
                self.checkpoints.retain(|c| c.turn_id != checkpoint.turn_id);
                let still_running = self.session.as_ref().is_some_and(|s| {
                    s.status == "running"
                        && s.active_turn_id.as_deref() == Some(&checkpoint.turn_id)
                });
                if !still_running
                    && self
                        .latest_turn
                        .as_ref()
                        .is_none_or(|t| t.turn_id == checkpoint.turn_id)
                {
                    let previous = self.latest_turn.take();
                    let state = match previous.as_ref().map(|t| t.state.as_str()) {
                        Some(kept @ ("interrupted" | "error")) => kept.to_string(),
                        _ => checkpoint_turn_state(&checkpoint.status).to_string(),
                    };
                    self.latest_turn = Some(LatestTurn {
                        turn_id: checkpoint.turn_id.clone(),
                        state,
                        requested_at: previous.as_ref().map_or_else(
                            || checkpoint.completed_at.clone(),
                            |t| t.requested_at.clone(),
                        ),
                        started_at: Some(
                            previous
                                .and_then(|t| t.started_at)
                                .unwrap_or_else(|| checkpoint.completed_at.clone()),
                        ),
                        completed_at: Some(checkpoint.completed_at.clone()),
                        assistant_message_id: checkpoint.assistant_message_id.clone(),
                    });
                }
                self.checkpoints.push(checkpoint);
                self.checkpoints
                    .sort_by_key(|c| c.checkpoint_turn_count.unwrap_or(u64::MAX));
                self.updated_at = occurred;
                Outcome::Updated
            }
            "thread.reverted" => {
                let turn_count = payload["turnCount"].as_u64().unwrap_or(0);
                self.checkpoints
                    .retain(|c| c.checkpoint_turn_count.is_some_and(|n| n <= turn_count));
                self.checkpoints
                    .sort_by_key(|c| c.checkpoint_turn_count.unwrap_or(u64::MAX));
                let retained: Vec<String> =
                    self.checkpoints.iter().map(|c| c.turn_id.clone()).collect();
                self.retain_messages_after_revert(&retained, turn_count);
                self.proposed_plans
                    .retain(|p| p.turn_id.as_ref().is_none_or(|t| retained.contains(t)));
                self.activities
                    .retain(|a| a.turn_id.as_ref().is_none_or(|t| retained.contains(t)));
                self.latest_turn = self.checkpoints.last().map(|c| LatestTurn {
                    turn_id: c.turn_id.clone(),
                    state: checkpoint_turn_state(&c.status).into(),
                    requested_at: c.completed_at.clone(),
                    started_at: Some(c.completed_at.clone()),
                    completed_at: Some(c.completed_at.clone()),
                    assistant_message_id: c.assistant_message_id.clone(),
                });
                self.updated_at = occurred;
                Outcome::Updated
            }

            // --- activities ----------------------------------------------------------------
            "thread.activity-appended" => {
                let Some(mut activity) = parse::<Activity>(&payload["activity"]) else {
                    return Outcome::Unchanged;
                };
                let server_record = SERVER_RECORD_KINDS.contains(&activity.kind.as_str());
                if server_record {
                    let sequence = event["sequence"].as_u64();
                    if let (Some(previous), Some(now)) = (
                        self.activities
                            .iter()
                            .find(|a| a.id == activity.id)
                            .and_then(|a| a.sequence),
                        sequence,
                    ) && previous > now
                    {
                        return Outcome::Unchanged;
                    }
                    activity.sequence = sequence;
                }
                let supersedes = resolvable_context_window(&activity);
                self.activities.retain(|existing| {
                    existing.id != activity.id
                        && !(supersedes
                            && existing.turn_id == activity.turn_id
                            && resolvable_context_window(existing))
                });
                self.activities.push(activity);
                self.activities.sort_by(|a, b| {
                    (
                        a.sequence.unwrap_or(u64::MAX),
                        a.created_at.as_str(),
                        a.id.as_str(),
                    )
                        .cmp(&(
                            b.sequence.unwrap_or(u64::MAX),
                            b.created_at.as_str(),
                            b.id.as_str(),
                        ))
                });
                self.updated_at = occurred;
                Outcome::Updated
            }

            // The server records these; what they cause arrives as activities and session events.
            "thread.approval-response-requested"
            | "thread.user-input-response-requested"
            | "thread.checkpoint-revert-requested" => Outcome::Unchanged,

            _ => Outcome::Unknown,
        }
    }

    fn apply_message_sent(&mut self, payload: &Value) {
        let Some(incoming) = parse::<Message>(&{
            let mut value = payload.clone();
            value["id"] = payload["messageId"].clone();
            value
        }) else {
            return;
        };
        match self.messages.iter_mut().find(|m| m.id == incoming.id) {
            Some(entry) => {
                if incoming.streaming {
                    entry.text.push_str(&incoming.text);
                } else if !incoming.text.is_empty() {
                    entry.text = incoming.text.clone();
                }
                entry.streaming = incoming.streaming;
                if incoming.turn_id.is_some() {
                    entry.turn_id = incoming.turn_id.clone();
                }
                if !incoming.streaming {
                    entry.updated_at = incoming.updated_at.clone();
                }
            }
            None => self.messages.push(incoming.clone()),
        }
        let Some(turn_id) = incoming
            .turn_id
            .clone()
            .filter(|_| incoming.role == Role::Assistant)
        else {
            return;
        };
        let running = self.session.as_ref().is_some_and(|s| {
            s.status == "running" && s.active_turn_id.as_deref() == Some(&turn_id)
        });
        let settles = !incoming.streaming && !running;
        let current = self.latest_turn.clone();
        if current.as_ref().is_none_or(|t| t.turn_id == turn_id) {
            let same = current.as_ref().filter(|t| t.turn_id == turn_id);
            let state = if settles {
                match current.as_ref().map(|t| t.state.as_str()) {
                    Some("interrupted") => "interrupted",
                    Some("error") => "error",
                    _ => "completed",
                }
            } else {
                "running"
            };
            self.latest_turn = Some(LatestTurn {
                turn_id: turn_id.clone(),
                state: state.into(),
                requested_at: same
                    .map_or_else(|| incoming.created_at.clone(), |t| t.requested_at.clone()),
                started_at: Some(
                    same.and_then(|t| t.started_at.clone())
                        .unwrap_or_else(|| incoming.created_at.clone()),
                ),
                completed_at: if settles {
                    Some(incoming.updated_at.clone())
                } else {
                    same.and_then(|t| t.completed_at.clone())
                },
                assistant_message_id: Some(incoming.id.clone()),
            });
        }
        for checkpoint in self.checkpoints.iter_mut().filter(|c| {
            c.turn_id == turn_id && c.assistant_message_id.as_deref() != Some(&incoming.id)
        }) {
            checkpoint.assistant_message_id = Some(incoming.id.clone());
        }
    }

    /// `retainMessagesAfterRevert`: keep system and imported messages and those of retained turns,
    /// then top up each role with the earliest turn-less or retained-turn messages up to the count.
    fn retain_messages_after_revert(&mut self, retained_turns: &[String], turn_count: u64) {
        use std::collections::HashSet;
        let imported = |m: &Message| m.id.starts_with("import:");
        let mut keep: HashSet<String> = HashSet::new();
        for m in &self.messages {
            let retained = m
                .turn_id
                .as_ref()
                .is_some_and(|t| retained_turns.contains(t));
            if m.role == Role::System || imported(m) || retained {
                keep.insert(m.id.clone());
            }
        }
        for role in [Role::User, Role::Assistant] {
            let retained = self
                .messages
                .iter()
                .filter(|m| m.role == role && !imported(m) && keep.contains(&m.id))
                .count() as u64;
            let missing = turn_count.saturating_sub(retained) as usize;
            let mut fallback: Vec<&Message> = self
                .messages
                .iter()
                .filter(|m| {
                    m.role == role
                        && !keep.contains(&m.id)
                        && m.turn_id
                            .as_ref()
                            .is_none_or(|t| retained_turns.contains(t))
                })
                .collect();
            fallback.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
            let ids: Vec<String> = fallback
                .into_iter()
                .take(missing)
                .map(|m| m.id.clone())
                .collect();
            keep.extend(ids);
        }
        self.messages.retain(|m| keep.contains(&m.id));
    }

    /// Puts a page of older turns in front of what is held. Duplicates (by id) are skipped, the
    /// page's plans are ignored (the opening snapshot has them all), and order is restored.
    pub fn merge_older(&mut self, page: Thread) -> usize {
        let before = self.messages.len() + self.activities.len();
        let have: std::collections::HashSet<String> =
            self.messages.iter().map(|m| m.id.clone()).collect();
        let mut messages: Vec<Message> = page
            .messages
            .into_iter()
            .filter(|m| !have.contains(&m.id))
            .collect();
        messages.append(&mut self.messages);
        self.messages = messages;
        let have: std::collections::HashSet<String> =
            self.activities.iter().map(|a| a.id.clone()).collect();
        let mut activities: Vec<Activity> = page
            .activities
            .into_iter()
            .filter(|a| !have.contains(&a.id))
            .collect();
        activities.append(&mut self.activities);
        self.activities = activities;
        let have: std::collections::HashSet<String> =
            self.checkpoints.iter().map(|c| c.turn_id.clone()).collect();
        let mut checkpoints: Vec<Checkpoint> = page
            .checkpoints
            .into_iter()
            .filter(|c| !have.contains(&c.turn_id))
            .collect();
        checkpoints.append(&mut self.checkpoints);
        self.checkpoints = checkpoints;
        self.messages.len() + self.activities.len() - before
    }
}

/// A context-window update with a usable token count: a newer one replaces older ones of its turn.
fn resolvable_context_window(activity: &Activity) -> bool {
    activity.kind == "context-window.updated"
        && activity.payload["usedTokens"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(sequence: u64, kind: &str, payload: Value) -> Value {
        json!({"sequence": sequence, "type": kind, "occurredAt": "2026-01-01T00:00:00.000Z", "commandId": null, "payload": payload})
    }

    fn sent(id: &str, text: &str, streaming: bool, turn: &str) -> Value {
        event(
            1,
            "thread.message-sent",
            json!({"messageId": id, "role": "assistant", "text": text, "streaming": streaming, "turnId": turn, "createdAt": "c", "updatedAt": "u"}),
        )
    }

    #[test]
    fn streamed_deltas_append_and_the_final_text_replaces_and_the_turn_settles() {
        let mut t = Thread::default();
        t.apply_event(&sent("a", "안", true, "t1"));
        t.apply_event(&sent("a", "녕", true, "t1"));
        assert_eq!(t.messages[0].text, "안녕");
        assert_eq!(t.latest_turn.as_ref().unwrap().state, "running");
        t.apply_event(&sent("a", "안녕하세요", false, "t1"));
        assert_eq!(t.messages[0].text, "안녕하세요");
        assert_eq!(t.latest_turn.as_ref().unwrap().state, "completed");
    }

    #[test]
    fn a_completed_message_keeps_the_turn_running_while_the_session_runs_it() {
        let mut t = Thread::default();
        t.apply_event(&event(
            1,
            "thread.session-set",
            json!({"session": {"status": "running", "activeTurnId": "t1", "updatedAt": "s"}}),
        ));
        t.apply_event(&sent("a", "commentary", false, "t1"));
        assert_eq!(t.latest_turn.as_ref().unwrap().state, "running");
        t.apply_event(&event(
            2,
            "thread.session-set",
            json!({"session": {"status": "ready", "activeTurnId": null, "updatedAt": "s2"}}),
        ));
        let turn = t.latest_turn.as_ref().unwrap();
        assert_eq!(
            (turn.state.as_str(), turn.completed_at.as_deref()),
            ("completed", Some("s2"))
        );
    }

    #[test]
    fn interrupt_stop_and_revert() {
        let mut t = Thread::default();
        t.apply_event(&event(
            1,
            "thread.session-set",
            json!({"session": {"status": "running", "activeTurnId": "t1", "updatedAt": "s"}}),
        ));
        t.apply_event(&event(
            2,
            "thread.turn-interrupt-requested",
            json!({"turnId": "t1", "createdAt": "i"}),
        ));
        assert_eq!(t.latest_turn.as_ref().unwrap().state, "interrupted");
        t.apply_event(&event(
            3,
            "thread.session-stop-requested",
            json!({"createdAt": "x"}),
        ));
        assert_eq!(t.session.as_ref().unwrap().status, "stopped");

        t.messages = vec![
            Message {
                id: "u1".into(),
                role: Role::User,
                turn_id: None,
                created_at: "1".into(),
                ..Default::default()
            },
            Message {
                id: "a1".into(),
                role: Role::Assistant,
                turn_id: Some("t1".into()),
                ..Default::default()
            },
            Message {
                id: "u2".into(),
                role: Role::User,
                turn_id: None,
                created_at: "2".into(),
                ..Default::default()
            },
            Message {
                id: "a2".into(),
                role: Role::Assistant,
                turn_id: Some("t2".into()),
                ..Default::default()
            },
        ];
        t.checkpoints = vec![Checkpoint {
            turn_id: "t1".into(),
            checkpoint_turn_count: Some(1),
            status: "ready".into(),
            ..Default::default()
        }];
        t.apply_event(&event(4, "thread.reverted", json!({"turnCount": 1})));
        let ids: Vec<&str> = t.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["u1", "a1"]);
    }

    #[test]
    fn activities_sort_and_a_new_context_window_update_replaces_the_old_one() {
        let mut t = Thread::default();
        let ctx = |id: &str, used: u64| {
            event(
                1,
                "thread.activity-appended",
                json!({"activity": {"id": id, "tone": "info", "kind": "context-window.updated", "summary": "s", "payload": {"usedTokens": used}, "turnId": "t1", "createdAt": id}}),
            )
        };
        t.apply_event(&ctx("a", 10));
        t.apply_event(&ctx("b", 20));
        assert_eq!(t.activities.len(), 1);
        assert_eq!(t.activities[0].id, "b");
    }

    #[test]
    fn meta_pin_and_pull_request_events() {
        let mut t = Thread::default();
        t.apply_event(&event(
            1,
            "thread.meta-updated",
            json!({"title": "new", "updatedAt": "u"}),
        ));
        assert_eq!(t.title, "new");
        t.apply_event(&event(
            2,
            "thread.pinned",
            json!({"pinnedAt": "p", "pinOrderKey": "a0", "updatedAt": "u"}),
        ));
        assert_eq!(t.pin_order_key.as_deref(), Some("a0"));
        t.apply_event(&event(3, "thread.unpinned", json!({"updatedAt": "u"})));
        assert!(t.pinned_at.is_none() && t.pin_order_key.is_none());
        let key = json!({"host": "h", "repository": "r", "number": 1});
        t.apply_event(&event(4, "thread.pull-request-linked", json!({"link": {"host": "h", "repository": "r", "number": 1, "url": "u"}, "updatedAt": "u"})));
        assert_eq!(t.pull_requests.len(), 1);
        t.apply_event(&event(5, "thread.pull-request-unlinked", json!({"host": key["host"], "repository": key["repository"], "number": 1, "updatedAt": "u"})));
        assert!(t.pull_requests.is_empty());
    }

    #[test]
    fn an_unknown_type_is_reported_and_known_no_op_types_are_not() {
        let mut t = Thread::default();
        assert_eq!(
            t.apply_event(&event(1, "thread.from-the-future", json!({}))),
            Outcome::Unknown
        );
        assert_eq!(
            t.apply_event(&event(2, "thread.approval-response-requested", json!({}))),
            Outcome::Unchanged
        );
        assert_eq!(
            t.apply_event(&event(3, "thread.deleted", json!({}))),
            Outcome::Deleted
        );
    }

    #[test]
    fn older_pages_go_in_front_without_duplicates() {
        let mut t = Thread::default();
        t.messages.push(Message {
            id: "new".into(),
            ..Default::default()
        });
        let page = Thread {
            messages: vec![
                Message {
                    id: "old".into(),
                    ..Default::default()
                },
                Message {
                    id: "new".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(t.merge_older(page), 1);
        let ids: Vec<&str> = t.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["old", "new"]);
    }
}
