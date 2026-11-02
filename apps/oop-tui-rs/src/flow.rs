//! The thread read model as the Workflow and Agents panels see it: a port of
//! packages/client-runtime/src/{workflowGraph,agentFlow,threadFlow,crewBoard}.ts and
//! state/subagentRuntime.ts, folded from the thread's `task.*` / `tool.*` activities (the lead's
//! own thread carries the crew's tasks, the provider's subagents and workflows). Pure: the caller
//! passes the clock. Omitted from the TS: the per-turn tool-step graphs (`steps`, drawn by no
//! panel), run handles, recent-activity rings, and the node fields only a non-agent step shows.

use crate::state::ThreadShell;
use crate::text::parse_iso_ms;
use crate::thread::{Activity, Thread};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, PartialEq)]
pub struct CrewRoleModel {
    /// `worker`, `expert` or `auditor`.
    pub role: &'static str,
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waiting {
    Approval,
    Input,
}

#[derive(Clone)]
pub struct FlowInput<'a> {
    pub thread: &'a Thread,
    /// All shell threads; the crew threads that wait for the user are picked out here.
    pub children: &'a [ThreadShell],
    pub lead_model: Option<String>,
    pub crew: Option<&'a [CrewRoleModel]>,
    pub lead_waiting: Option<Waiting>,
    /// The thread is open but has not been received yet.
    pub loading: bool,
    pub now_ms: i64,
    /// 250 ms animation tick; picks the spinner glyph of a running mark.
    pub tick: usize,
    pub animations: bool,
    /// The flow the user picked with `/dag-workflow N`; `None` follows the live one.
    pub pinned: Option<String>,
    /// False while the server cannot be reached: what is drawn is the last that arrived.
    pub online: bool,
    /// How far the user has wheeled the panel's body from where it would sit; the drawing clamps
    /// it (and writes the clamped value back), so the wheel never runs past either end.
    pub scroll: Option<&'a std::cell::Cell<i32>>,
}

// ---- small readers over the activity payloads ---------------------------------------------------

const TEXT_LIMIT: usize = 240;

/// A trimmed, non-empty string cut to `limit` characters; `None` for anything else.
fn clip(text: &str, limit: usize) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(limit).collect())
}

fn txt(value: &Value, limit: usize) -> Option<String> {
    clip(value.as_str()?, limit)
}

fn any_txt(value: &Value) -> Option<String> {
    txt(value, usize::MAX)
}

fn count(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as u64)
}

/// `Date.parse` of an ISO stamp: NaN when it is not one.
fn ms(stamp: &str) -> f64 {
    parse_iso_ms(stamp).map_or(f64::NAN, |v| v as f64)
}

fn bounded(value: String) -> String {
    if value.chars().count() <= 180 {
        value
    } else {
        format!("{}…", value.chars().take(179).collect::<String>())
    }
}

// ---- the states ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeState {
    Pending,
    Blocked,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl NodeState {
    pub fn settled(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// What a tool call did, in the order the panels list them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Cat {
    Read,
    Run,
    Edit,
    Search,
    Web,
    Other,
}

pub type ToolCount = (Cat, u32);

/// What the lead is doing right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Doing {
    Tool(Cat),
    Thinking,
    Waiting,
}

fn tool_counts(categories: impl IntoIterator<Item = Option<Cat>>) -> Vec<ToolCount> {
    let mut counts: BTreeMap<Cat, u32> = BTreeMap::new();
    for category in categories.into_iter().flatten() {
        *counts.entry(category).or_default() += 1;
    }
    counts.into_iter().collect()
}

/// What a tool call counts as; `None` for calls that are not tool work (they launch agents, are
/// crew plumbing, or planning).
fn tool_category(name: &str, kind: &Value, item_type: &Value) -> Option<Cat> {
    let mut tool = name.to_lowercase();
    if tool.starts_with("mcp__")
        && let Some(at) = tool.rfind("__").filter(|at| *at >= 5)
    {
        tool = tool[at + 2..].to_string();
    }
    if tool.starts_with("crew_") {
        return None;
    }
    let by_tool = match tool.as_str() {
        "read" | "notebookread" | "view" => Some(Some(Cat::Read)),
        "edit" | "write" | "multiedit" | "notebookedit" | "apply_patch" | "delete" | "move" => {
            Some(Some(Cat::Edit))
        }
        "bash" | "bashoutput" | "killshell" | "shell" | "exec_command" | "run" => {
            Some(Some(Cat::Run))
        }
        "grep" | "glob" | "ls" | "search" | "toolsearch" => Some(Some(Cat::Search)),
        "websearch" | "webfetch" | "fetch" => Some(Some(Cat::Web)),
        "mcp" => Some(Some(Cat::Other)),
        "task" | "agent" | "think" | "todowrite" | "exitplanmode" | "enterplanmode"
        | "askuserquestion" => Some(None),
        _ => None,
    };
    if let Some(found) = by_tool {
        return found;
    }
    for key in [kind, item_type].iter().filter_map(|v| v.as_str()) {
        let by_kind = match key {
            "execute" | "command_execution" => Some(Some(Cat::Run)),
            "read" => Some(Some(Cat::Read)),
            "edit" | "file_change" | "delete" | "move" => Some(Some(Cat::Edit)),
            "search" => Some(Some(Cat::Search)),
            "web_search" | "fetch" => Some(Some(Cat::Web)),
            "mcp_tool_call" => Some(Some(Cat::Other)),
            "think" | "collab_agent_tool_call" => Some(None),
            _ => None,
        };
        if let Some(found) = by_kind {
            return found;
        }
    }
    Some(Cat::Other)
}

fn tool_name(payload: &Value) -> Option<String> {
    let data = &payload["data"];
    if let Some(named) = txt(&data["toolName"], 80) {
        return Some(named);
    }
    for key in [&data["kind"], &payload["itemType"]]
        .iter()
        .filter_map(|v| v.as_str())
    {
        let verb = match key {
            "execute" | "command_execution" => "Run",
            "read" => "Read",
            "edit" | "file_change" => "Edit",
            "delete" => "Delete",
            "move" => "Move",
            "search" | "web_search" => "Search",
            "fetch" => "Fetch",
            "think" => "Think",
            "mcp_tool_call" => "MCP",
            "collab_agent_tool_call" => "Agent",
            _ => continue,
        };
        return Some(verb.to_string());
    }
    txt(&payload["title"], 80).filter(|t| {
        !matches!(
            t.to_lowercase().as_str(),
            "tool" | "tool call" | "ran command"
        )
    })
}

fn tool_state(status: &Value) -> NodeState {
    match status.as_str() {
        Some("completed") => NodeState::Completed,
        Some("failed" | "error" | "declined") => NodeState::Failed,
        Some("cancelled" | "stopped") => NodeState::Cancelled,
        _ => NodeState::Running,
    }
}

/// The state a `task.*` activity gives its step, if it says one.
fn task_state(kind: &str, status: &Value) -> Option<NodeState> {
    let status = status.as_str();
    if kind == "task.completed" || (kind == "task.updated" && status.is_some()) {
        return Some(match status {
            Some("completed") => NodeState::Completed,
            Some("failed" | "partial" | "blocked") => NodeState::Failed,
            _ => NodeState::Cancelled,
        });
    }
    matches!(kind, "task.started" | "task.progress").then_some(NodeState::Running)
}

// ---- the subagent roster (state/subagentRuntime.ts) ---------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Pending,
    Running,
    Waiting,
    Idle,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl AgentStatus {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "idle" => Self::Idle,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }

    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }

    /// Pending, running or waiting: the user may still need to care.
    pub fn active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Waiting)
    }

    pub fn node_state(self) -> NodeState {
        match self {
            Self::Pending => NodeState::Pending,
            Self::Running => NodeState::Running,
            Self::Waiting => NodeState::Blocked,
            Self::Idle => NodeState::Paused,
            Self::Completed => NodeState::Completed,
            Self::Failed => NodeState::Failed,
            Self::Cancelled | Self::Interrupted => NodeState::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentKind {
    Subagent,
    Workflow,
    WorkflowAgent,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub total_tokens: u64,
    pub tool_uses: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Subagent {
    pub id: String,
    pub kind: SubagentKind,
    pub title: String,
    pub role: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub status: AgentStatus,
    pub activation_count: u32,
    pub usage: Option<Usage>,
    pub progress: Option<String>,
    pub last_tool_name: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub parent_agent_id: Option<String>,
    pub agent_index: Option<u64>,
    pub phase_index: Option<u64>,
    pub phase_title: Option<String>,
    pub attempt: Option<u64>,
    pub workflow_name: Option<String>,
    pub phases: Vec<(u64, String)>,
    pub first_seen_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

fn background(payload: &Value) -> bool {
    payload["agentKind"].as_str() != Some("agent")
}

fn as_usage(value: &Value) -> Option<Usage> {
    Some(Usage {
        total_tokens: count(&value["totalTokens"])?,
        tool_uses: count(&value["toolUses"]),
    })
}

/// Field-wise maximum: cumulative totals never shrink under a late or duplicate frame.
fn merge_usage(current: Option<Usage>, incoming: Option<Usage>) -> Option<Usage> {
    match (current, incoming) {
        (Some(a), Some(b)) => Some(Usage {
            total_tokens: a.total_tokens.max(b.total_tokens),
            tool_uses: a.tool_uses.max(b.tool_uses),
        }),
        (a, b) => a.or(b),
    }
}

fn kind_of(payload: &Value, id: &str) -> SubagentKind {
    if payload["taskType"].as_str() == Some("local_workflow") {
        SubagentKind::Workflow
    } else if !payload["parentAgentId"].is_null() || id.contains(":wf:") {
        SubagentKind::WorkflowAgent
    } else {
        SubagentKind::Subagent
    }
}

fn fill_metadata(agent: &mut Subagent, payload: &Value) {
    if let Some(title) = any_txt(&payload["title"]) {
        agent.title = title;
    }
    for (key, slot) in [
        ("role", &mut agent.role),
        ("model", &mut agent.model),
        ("effort", &mut agent.effort),
        ("workflowName", &mut agent.workflow_name),
        ("phaseTitle", &mut agent.phase_title),
    ] {
        if let Some(value) = any_txt(&payload[key]) {
            *slot = Some(value);
        }
    }
    if let Some(parent) = any_txt(&payload["parentAgentId"]) {
        agent.parent_agent_id = Some(parent);
        if agent.kind == SubagentKind::Subagent {
            agent.kind = SubagentKind::WorkflowAgent;
        }
    }
    if payload["taskType"].as_str() == Some("local_workflow") {
        agent.kind = SubagentKind::Workflow;
    }
    if let Some(index) = count(&payload["agentIndex"]) {
        agent.agent_index = Some(index);
    }
    if let Some(index) = count(&payload["phaseIndex"]) {
        agent.phase_index = Some(index);
    }
    if let Some(attempt) = count(&payload["attempt"]) {
        // A new attempt on a workflow slot is a reactivation: the last attempt's ending goes.
        if agent.attempt.is_some_and(|previous| attempt > previous) {
            agent.result = None;
            agent.error = None;
            agent.completed_at = None;
        }
        agent.attempt = Some(attempt);
    }
    if let Some(list) = payload["phases"].as_array() {
        let mut phases: Vec<(u64, String)> = list
            .iter()
            .filter_map(|entry| Some((count(&entry["index"])?, any_txt(&entry["title"])?)))
            .collect();
        if !phases.is_empty() {
            phases.sort_by_key(|(index, _)| *index);
            agent.phases = phases;
        }
    }
}

fn apply_status(agent: &mut Subagent, status: AgentStatus, at: &str) {
    let was_terminal = agent.status.terminal();
    let is_terminal = status.terminal();
    if was_terminal && is_terminal {
        return;
    }
    if (was_terminal || agent.status == AgentStatus::Idle)
        && matches!(status, AgentStatus::Running | AgentStatus::Pending)
    {
        agent.activation_count += 1;
        agent.result = None;
        agent.error = None;
        agent.completed_at = None;
        if status == AgentStatus::Running {
            agent.started_at = Some(at.to_string());
        }
    }
    if status == AgentStatus::Running && agent.started_at.is_none() {
        agent.started_at = Some(at.to_string());
    }
    if is_terminal && agent.completed_at.is_none() {
        agent.completed_at = Some(at.to_string());
    }
    agent.status = status;
}

/// Completion can create an agent (its start may have aged out of retention).
fn get_or_create(
    agents: &mut Vec<Subagent>,
    index: &mut HashMap<String, usize>,
    id: &str,
    payload: &Value,
    at: &str,
) -> usize {
    if let Some(&at_index) = index.get(id) {
        return at_index;
    }
    agents.push(Subagent {
        id: id.to_string(),
        kind: kind_of(payload, id),
        title: any_txt(&payload["title"])
            .or_else(|| any_txt(&payload["detail"]))
            .unwrap_or_else(|| id.to_string()),
        role: any_txt(&payload["role"]),
        model: any_txt(&payload["model"]),
        effort: any_txt(&payload["effort"]),
        status: AgentStatus::Pending,
        activation_count: 0,
        usage: None,
        progress: None,
        last_tool_name: None,
        result: None,
        error: None,
        parent_agent_id: any_txt(&payload["parentAgentId"]),
        agent_index: count(&payload["agentIndex"]),
        phase_index: count(&payload["phaseIndex"]),
        phase_title: any_txt(&payload["phaseTitle"]),
        attempt: count(&payload["attempt"]),
        workflow_name: any_txt(&payload["workflowName"]),
        phases: Vec::new(),
        first_seen_at: at.to_string(),
        started_at: None,
        completed_at: None,
        updated_at: at.to_string(),
    });
    index.insert(id.to_string(), agents.len() - 1);
    agents.len() - 1
}

/// Folds the thread's activities into the subagent roster. Tolerant: a malformed row is skipped.
/// With the session gone nothing can still run, so live agents read as interrupted.
pub fn fold_subagents(activities: &[Activity], session_live: bool) -> Vec<Subagent> {
    let mut agents: Vec<Subagent> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for activity in activities {
        let payload = &activity.payload;
        let at = activity.created_at.as_str();
        let kind = activity.kind.as_str();
        if !payload.is_object()
            || !matches!(
                kind,
                "task.started"
                    | "task.progress"
                    | "task.updated"
                    | "task.completed"
                    | "tool.progress"
            )
        {
            continue;
        }
        let Some(task_id) = any_txt(&payload["taskId"]) else {
            continue;
        };
        if kind == "tool.progress" {
            // The agent's heartbeat: what it is doing right now.
            if let Some(&at_index) = index.get(&task_id) {
                let agent = &mut agents[at_index];
                if let Some(tool) = any_txt(&payload["toolName"]) {
                    agent.last_tool_name = Some(tool);
                }
                agent.updated_at = at.to_string();
            }
            continue;
        }
        // Only real agents join the roster; shells and monitors are background work. Membership
        // is sticky per task id: later rows inherit the first row's classification.
        let existed = index.contains_key(&task_id);
        if background(payload) && (kind == "task.started" || !existed) {
            continue;
        }
        let at_index = get_or_create(&mut agents, &mut index, &task_id, payload, at);
        let agent = &mut agents[at_index];
        fill_metadata(agent, payload);
        match kind {
            "task.started" => {
                // A late start after a terminal state only fills metadata.
                if agent.activation_count == 0 && !agent.status.terminal() {
                    agent.activation_count = 1;
                    agent.started_at.get_or_insert_with(|| at.to_string());
                    agent.status = AgentStatus::Running;
                } else if agent.status == AgentStatus::Idle {
                    apply_status(agent, AgentStatus::Running, at);
                }
                if let Some(detail) = any_txt(&payload["detail"])
                    && agent.title == agent.id
                {
                    agent.title = detail;
                }
            }
            "task.progress" => {
                if agent.activation_count == 0 {
                    agent.activation_count = 1;
                }
                if let Some(status) = payload["status"].as_str().and_then(AgentStatus::parse) {
                    apply_status(agent, status, at);
                } else if (payload["usageSnapshot"].as_bool() != Some(true) || !existed)
                    && !agent.status.terminal()
                    && agent.status != AgentStatus::Idle
                {
                    apply_status(agent, AgentStatus::Running, at);
                }
                if let Some(summary) = any_txt(&payload["summary"]) {
                    agent.progress = Some(bounded(summary));
                }
                if let Some(tool) = any_txt(&payload["lastToolName"]) {
                    agent.last_tool_name = Some(tool);
                }
                if let Some(error) = any_txt(&payload["error"]) {
                    agent.error = Some(bounded(error));
                }
                agent.usage = merge_usage(agent.usage, as_usage(&payload["typedUsage"]));
            }
            "task.updated" => {
                if let Some(detail) = any_txt(&payload["detail"]) {
                    agent.progress = Some(bounded(detail));
                }
                if agent.activation_count == 0 {
                    agent.activation_count = 1;
                }
                let was_terminal = agent.status.terminal();
                if let Some(status) = payload["status"].as_str().and_then(AgentStatus::parse) {
                    apply_status(agent, status, at);
                }
                if let Some(error) = any_txt(&payload["error"]) {
                    agent.error = Some(bounded(error));
                }
                // The provider's end time beats the ingestion time for the settling transition.
                if let Some(ended) = any_txt(&payload["endedAt"])
                    && !was_terminal
                    && agent.status.terminal()
                {
                    agent.completed_at = Some(ended);
                }
            }
            _ => {
                if agent.activation_count == 0 {
                    agent.activation_count = 1;
                }
                let summary = any_txt(&payload["summary"]).or_else(|| any_txt(&payload["detail"]));
                if agent.status.terminal() {
                    // Frozen, but the completion still enriches what the update lacked.
                    if let Some(summary) = summary {
                        let slot = if agent.status == AgentStatus::Failed {
                            &mut agent.error
                        } else {
                            &mut agent.result
                        };
                        slot.get_or_insert_with(|| bounded(summary));
                    }
                    agent.usage = merge_usage(agent.usage, as_usage(&payload["typedUsage"]));
                    continue;
                }
                let status = match payload["status"].as_str() {
                    Some("failed") => AgentStatus::Failed,
                    Some("stopped") => AgentStatus::Interrupted,
                    _ => AgentStatus::Completed,
                };
                apply_status(agent, status, at);
                if let Some(summary) = summary {
                    if status == AgentStatus::Failed {
                        agent.error.get_or_insert_with(|| bounded(summary));
                    } else {
                        agent.result = Some(bounded(summary));
                    }
                }
                agent.usage = merge_usage(agent.usage, as_usage(&payload["typedUsage"]));
            }
        }
        agent.updated_at = at.to_string();
    }

    // A settled workflow leaves none of its members in flight.
    let settled: Vec<(String, AgentStatus, Option<String>, String)> = agents
        .iter()
        .filter(|a| a.kind == SubagentKind::Workflow && a.status.terminal())
        .map(|a| {
            (
                a.id.clone(),
                a.status,
                a.completed_at.clone(),
                a.updated_at.clone(),
            )
        })
        .collect();
    for (id, status, completed_at, updated_at) in settled {
        for member in agents
            .iter_mut()
            .filter(|m| m.parent_agent_id.as_deref() == Some(&id))
        {
            if member.status.terminal() || member.status == AgentStatus::Idle {
                continue;
            }
            member.status = if status == AgentStatus::Completed {
                AgentStatus::Completed
            } else {
                AgentStatus::Interrupted
            };
            if member.completed_at.is_none() {
                member.completed_at = completed_at.clone().or_else(|| Some(updated_at.clone()));
            }
            member.updated_at = updated_at.clone();
        }
    }
    if !session_live {
        for agent in agents.iter_mut().filter(|a| a.status.active()) {
            agent.status = AgentStatus::Interrupted;
            if agent.completed_at.is_none() {
                agent.completed_at = Some(agent.updated_at.clone());
            }
        }
    }
    if agents.len() > 100 {
        let rank = |a: &Subagent| {
            if a.status.active() {
                0
            } else if a.status == AgentStatus::Idle {
                1
            } else {
                2
            }
        };
        agents.sort_by(|a, b| {
            rank(a)
                .cmp(&rank(b))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        agents.truncate(100);
    }
    agents
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhaseState {
    Pending,
    Running,
    Done,
}

#[derive(Clone, Debug)]
pub struct Phase {
    pub title: String,
    pub members: Vec<Subagent>,
    pub state: PhaseState,
    pub active_count: usize,
    pub settled_count: usize,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub workflow: Subagent,
    pub phases: Vec<Phase>,
    /// Members with no resolvable phase.
    pub unphased: Vec<Subagent>,
}

impl Group {
    pub fn members(&self) -> Vec<&Subagent> {
        self.phases
            .iter()
            .flat_map(|phase| phase.members.iter())
            .chain(self.unphased.iter())
            .collect()
    }
}

#[derive(Clone, Debug, Default)]
pub struct PanelModel {
    pub workflows: Vec<Group>,
    pub direct: Vec<Subagent>,
    pub running: usize,
    pub waiting: usize,
    pub idle: usize,
    pub total_tokens: u64,
    pub has_agents: bool,
}

fn by_order(a: &Subagent, b: &Subagent) -> std::cmp::Ordering {
    a.first_seen_at
        .cmp(&b.first_seen_at)
        .then_with(|| a.id.cmp(&b.id))
}

/// The roster split into workflows (with their phases and members), direct agents, and counts.
pub fn panel_model(roster: &[Subagent]) -> PanelModel {
    if roster.is_empty() {
        return PanelModel::default();
    }
    let mut workflows: Vec<&Subagent> = roster
        .iter()
        .filter(|a| a.kind == SubagentKind::Workflow)
        .collect();
    workflows.sort_by(|a, b| by_order(a, b));
    let mut members: HashMap<&str, Vec<&Subagent>> = HashMap::new();
    let mut direct: Vec<Subagent> = Vec::new();
    for agent in roster.iter().filter(|a| a.kind != SubagentKind::Workflow) {
        match agent.parent_agent_id.as_deref() {
            Some(parent) if workflows.iter().any(|w| w.id == parent) => {
                members.entry(parent).or_default().push(agent);
            }
            // Orphaned members (the coordinator aged out) fall back to the direct list.
            _ => direct.push(agent.clone()),
        }
    }
    let groups: Vec<Group> = workflows
        .iter()
        .map(|workflow| {
            let mine = members
                .get(workflow.id.as_str())
                .cloned()
                .unwrap_or_default();
            let known: Vec<(u64, String)> = if workflow.phases.is_empty() {
                let mut derived: BTreeMap<u64, String> = BTreeMap::new();
                for member in &mine {
                    if let Some(index) = member.phase_index {
                        derived.entry(index).or_insert_with(|| {
                            member
                                .phase_title
                                .clone()
                                .unwrap_or_else(|| format!("Phase {}", index + 1))
                        });
                    }
                }
                derived.into_iter().collect()
            } else {
                workflow.phases.clone()
            };
            let by_index = |mut list: Vec<Subagent>| {
                list.sort_by_key(|m| m.agent_index.unwrap_or(0));
                list
            };
            let phases = known
                .iter()
                .map(|(index, title)| {
                    let list = by_index(
                        mine.iter()
                            .filter(|m| m.phase_index == Some(*index))
                            .map(|m| (*m).clone())
                            .collect(),
                    );
                    // An idle member has not finished the phase either.
                    let active_count = list
                        .iter()
                        .filter(|m| m.status.active() || m.status == AgentStatus::Idle)
                        .count();
                    let settled_count = list.iter().filter(|m| m.status.terminal()).count();
                    let state = if list.is_empty() {
                        PhaseState::Pending
                    } else if active_count > 0 {
                        PhaseState::Running
                    } else if settled_count == list.len() {
                        PhaseState::Done
                    } else {
                        PhaseState::Pending
                    };
                    Phase {
                        title: title.clone(),
                        members: list,
                        state,
                        active_count,
                        settled_count,
                    }
                })
                .collect();
            let unphased = by_index(
                mine.iter()
                    .filter(|m| {
                        m.phase_index
                            .is_none_or(|index| !known.iter().any(|(k, _)| *k == index))
                    })
                    .map(|m| (*m).clone())
                    .collect(),
            );
            Group {
                workflow: (*workflow).clone(),
                phases,
                unphased,
            }
        })
        .collect();
    let mut model = PanelModel {
        workflows: groups,
        has_agents: true,
        ..PanelModel::default()
    };
    direct.sort_by(by_order);
    model.direct = direct;
    for agent in roster {
        // A coordinator with members is a container for them, not work of its own.
        if agent.kind == SubagentKind::Workflow
            && members
                .get(agent.id.as_str())
                .is_some_and(|m| !m.is_empty())
        {
            continue;
        }
        match agent.status {
            AgentStatus::Running | AgentStatus::Pending => model.running += 1,
            AgentStatus::Waiting => model.waiting += 1,
            AgentStatus::Idle => model.idle += 1,
            _ => {}
        }
        model.total_tokens += agent.usage.map_or(0, |u| u.total_tokens);
    }
    model
}

/// `claude-sonnet-5[1m]` -> `sonnet-5[1m]`; effort appends as ` · high`.
pub fn model_label(model: &str, effort: Option<&str>) -> String {
    let mut compact = model.strip_prefix("claude-").unwrap_or(model).to_string();
    if let Some(at) = compact.rfind('-')
        && compact.len() - at == 9
        && compact[at + 1..].bytes().all(|b| b.is_ascii_digit())
    {
        compact.truncate(at);
    }
    if let Some(stripped) = compact.strip_suffix("-latest") {
        compact = stripped.to_string();
    }
    match effort {
        Some(effort) => format!("{compact} · {effort}"),
        None => compact,
    }
}

/// The desktop's test for "the provider session is alive".
pub fn session_live(thread: &Thread) -> bool {
    thread
        .session
        .as_ref()
        .is_some_and(|s| !matches!(s.status.as_str(), "stopped" | "interrupted" | "error"))
}

/// The turn still running and when it began; both `None` once it is over.
pub fn active_turn(thread: &Thread) -> (Option<String>, Option<String>) {
    let Some(turn) = thread.latest_turn.as_ref() else {
        return (None, None);
    };
    let running = thread
        .session
        .as_ref()
        .is_some_and(|s| s.status == "running");
    if turn.started_at.is_some() && turn.completed_at.is_some() && !running {
        return (None, None);
    }
    (
        Some(turn.turn_id.clone()),
        turn.started_at
            .clone()
            .or_else(|| Some(turn.requested_at.clone())),
    )
}

pub fn agent_model(thread: &Thread) -> PanelModel {
    panel_model(&fold_subagents(&thread.activities, session_live(thread)))
}

// ---- the tool steps and crew tasks of the lead's turns (threadFlow.ts) --------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Launch {
    Agent,
    Workflow,
}

struct ToolStep {
    id: String,
    name: String,
    category: Option<Cat>,
    launch: Option<Launch>,
    launch_title: Option<String>,
    state: NodeState,
    started_at: String,
    completed_at: Option<String>,
    model: Option<String>,
    progress: Option<String>,
    tokens: Option<u64>,
    error: Option<String>,
}

struct TurnSteps {
    turn_id: String,
    /// Every tool call the turn made, oldest first.
    steps: Vec<ToolStep>,
}

fn collect_tool_steps(activities: &[Activity]) -> Vec<TurnSteps> {
    let mut steps: Vec<(String, ToolStep)> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut task_owner: HashMap<String, usize> = HashMap::new();
    for activity in activities {
        let payload = &activity.payload;
        if !payload.is_object() {
            continue;
        }
        if activity.kind.starts_with("tool.")
            && let Some(turn_id) = activity.turn_id.as_ref()
        {
            let Some(id) = txt(&payload["toolCallId"], 200) else {
                continue;
            };
            let name = tool_name(payload);
            let existed = by_id.contains_key(&id);
            if !existed {
                steps.push((
                    turn_id.clone(),
                    ToolStep {
                        id: id.clone(),
                        name: name
                            .clone()
                            .or_else(|| txt(&payload["title"], 80))
                            .unwrap_or_else(|| "Tool".to_string()),
                        category: None,
                        launch: None,
                        launch_title: None,
                        state: NodeState::Running,
                        started_at: activity.created_at.clone(),
                        completed_at: None,
                        model: None,
                        progress: None,
                        tokens: None,
                        error: None,
                    },
                ));
                by_id.insert(id.clone(), steps.len() - 1);
            }
            let at = by_id[&id];
            let step = &mut steps[at].1;
            if let Some(name) = name {
                step.name = name;
            }
            // A later update that names nothing must not erase what an earlier one made clear.
            let category =
                tool_category(&step.name, &payload["data"]["kind"], &payload["itemType"]);
            if !existed || category != Some(Cat::Other) {
                step.category = category;
            }
            step.state = tool_state(&payload["status"]);
            if activity.kind == "tool.completed" || step.state != NodeState::Running {
                step.completed_at = Some(activity.created_at.clone());
            }
            continue;
        }
        if !activity.kind.starts_with("task.") {
            continue;
        }
        let task_id = txt(&payload["taskId"], 200);
        let tool_use_id = txt(&payload["toolUseId"], 200);
        let Some(at) = task_id
            .as_ref()
            .and_then(|id| task_owner.get(id))
            .or_else(|| tool_use_id.as_ref().and_then(|id| by_id.get(id)))
            .copied()
        else {
            continue;
        };
        if let Some(task_id) = task_id {
            task_owner.insert(task_id, at);
        }
        let step = &mut steps[at].1;
        let title = txt(&payload["title"], 80);
        // A crew task is drawn as a crew member; only other launches become agents of their own.
        let crew_member = txt(&payload["crewRole"], 20).is_some();
        if payload["taskType"].as_str() == Some("local_workflow") {
            step.category = None;
            if !crew_member {
                step.launch = Some(Launch::Workflow);
                if let Some(launch_title) = txt(&payload["workflowName"], 80).or(title) {
                    step.launch_title = Some(launch_title);
                }
            }
        } else if title.is_some() && payload["agentKind"].as_str() == Some("agent") {
            step.category = None;
            if !crew_member {
                step.launch = Some(Launch::Agent);
                step.launch_title = title;
            }
        }
        if let Some(model) = txt(&payload["model"], 80) {
            step.model = Some(model);
        }
        if let Some(progress) =
            txt(&payload["summary"], TEXT_LIMIT).or_else(|| txt(&payload["lastToolName"], 80))
        {
            step.progress = Some(progress);
        }
        let usage = &payload["usage"];
        if let Some(tokens) = count(&usage["totalTokens"]).or_else(|| count(&usage["total_tokens"]))
        {
            step.tokens = Some(tokens);
        }
        if let Some(state) = task_state(&activity.kind, &payload["status"]) {
            step.state = state;
            step.completed_at = (state != NodeState::Running).then(|| activity.created_at.clone());
            if state == NodeState::Failed {
                step.error = txt(&payload["summary"], TEXT_LIMIT)
                    .or_else(|| txt(&payload["detail"], TEXT_LIMIT));
            }
        }
    }
    let mut turns: Vec<TurnSteps> = Vec::new();
    for (turn_id, step) in steps {
        match turns.iter_mut().find(|t| t.turn_id == turn_id) {
            Some(turn) => turn.steps.push(step),
            None => turns.push(TurnSteps {
                turn_id,
                steps: vec![step],
            }),
        }
    }
    for turn in &mut turns {
        turn.steps.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.id.cmp(&b.id))
        });
    }
    turns.sort_by(|a, b| a.steps[0].started_at.cmp(&b.steps[0].started_at));
    turns
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    Reported,
    Tested,
    Audited,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct CrewUsage {
    tokens: u64,
    /// Only when the provider reported a cost; never estimated.
    cost: Option<f64>,
}

struct CrewStep {
    id: String,
    role: String,
    title: Option<String>,
    state: NodeState,
    started_at: String,
    completed_at: Option<String>,
    model: Option<String>,
    progress: Option<String>,
    thread_id: Option<String>,
    /// The `task.completed` status; absent while the task runs.
    outcome: Option<String>,
    tested: bool,
    verdict: Option<String>,
    usage: Option<CrewUsage>,
}

/// The crew tasks of every lead turn, folded from the lead's task activities.
fn collect_crew_tasks(activities: &[Activity]) -> Vec<(String, Vec<CrewStep>)> {
    let mut tasks: Vec<(String, CrewStep)> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for activity in activities {
        let payload = &activity.payload;
        if !activity.kind.starts_with("task.") {
            continue;
        }
        let (Some(role), Some(task_id)) =
            (txt(&payload["crewRole"], 20), txt(&payload["taskId"], 200))
        else {
            continue;
        };
        let at = *by_id.entry(task_id.clone()).or_insert_with(|| {
            tasks.push((
                activity
                    .turn_id
                    .clone()
                    .unwrap_or_else(|| "untracked".to_string()),
                CrewStep {
                    id: task_id.clone(),
                    role,
                    title: txt(&payload["title"], 80),
                    state: NodeState::Running,
                    started_at: activity.created_at.clone(),
                    completed_at: None,
                    model: None,
                    progress: None,
                    thread_id: None,
                    outcome: None,
                    tested: false,
                    verdict: None,
                    usage: None,
                },
            ));
            tasks.len() - 1
        });
        let task = &mut tasks[at].1;
        if let Some(model) = txt(&payload["model"], 80) {
            task.model = Some(model);
        }
        if let Some(summary) = txt(&payload["summary"], TEXT_LIMIT) {
            task.progress = Some(summary);
        }
        // Each attempt of a task runs in its own thread; the latest one is the one to open.
        if let Some(thread_id) = txt(&payload["threadId"], 200) {
            task.thread_id = Some(thread_id);
        }
        if activity.kind == "task.completed" {
            // A crew report that stopped partway (partial, blocked) did not finish its task.
            task.state = match payload["status"].as_str() {
                Some("partial" | "blocked") => NodeState::Failed,
                _ => tool_state(&payload["status"]),
            };
            task.completed_at = Some(activity.created_at.clone());
            task.outcome = txt(&payload["status"], 20);
            task.tested = payload["tested"].as_bool() == Some(true);
            task.verdict = txt(&payload["verdict"], 20);
            let usage = &payload["usage"];
            task.usage = match (count(&usage["inputTokens"]), count(&usage["outputTokens"])) {
                (Some(input), Some(output)) => Some(CrewUsage {
                    tokens: input + output,
                    cost: usage["costUsd"].as_f64(),
                }),
                _ => None,
            };
        }
    }
    let mut turns: Vec<(String, Vec<CrewStep>)> = Vec::new();
    for (turn_id, task) in tasks {
        match turns.iter_mut().find(|(id, _)| *id == turn_id) {
            Some((_, list)) => list.push(task),
            None => turns.push((turn_id, vec![task])),
        }
    }
    turns
}

/// How far each finished worker or expert task can be trusted: audited when the latest audit that
/// finished after it approved, tested when its own run passed tests, reported otherwise.
fn crew_evidence(tasks: &[CrewStep]) -> HashMap<String, Evidence> {
    let mut audits: Vec<&CrewStep> = tasks
        .iter()
        .filter(|t| {
            t.role == "auditor"
                && t.outcome.as_deref() == Some("completed")
                && t.completed_at.is_some()
        })
        .collect();
    audits.sort_by(|a, b| a.completed_at.cmp(&b.completed_at));
    let mut evidence = HashMap::new();
    for task in tasks {
        let Some(completed) = task
            .completed_at
            .as_ref()
            .filter(|_| task.role != "auditor")
        else {
            continue;
        };
        if !matches!(task.outcome.as_deref(), Some("completed" | "partial")) {
            continue;
        }
        let audited = audits
            .iter()
            .rev()
            .find(|a| a.completed_at.as_ref() > Some(completed))
            .is_some_and(|a| a.verdict.as_deref() == Some("approve"));
        evidence.insert(
            task.id.clone(),
            if audited {
                Evidence::Audited
            } else if task.tested {
                Evidence::Tested
            } else {
                Evidence::Reported
            },
        );
    }
    evidence
}

/// The crew total of one lead turn, or `None` when no task has usage.
fn crew_turn_usage(tasks: &[CrewStep]) -> Option<CrewUsage> {
    let used: Vec<CrewUsage> = tasks.iter().filter_map(|t| t.usage).collect();
    if used.is_empty() {
        return None;
    }
    let costs: Vec<f64> = used.iter().filter_map(|u| u.cost).collect();
    Some(CrewUsage {
        tokens: used.iter().map(|u| u.tokens).sum(),
        cost: (!costs.is_empty()).then(|| costs.iter().sum()),
    })
}

/// One lead turn's crew, oldest task first, with who was delegated to and who audited.
struct CrewTurn {
    delegated: Vec<CrewStep>,
    audits: Vec<CrewStep>,
    usage: Option<CrewUsage>,
    evidence: HashMap<String, Evidence>,
    any: bool,
}

fn crew_turn(mut tasks: Vec<CrewStep>) -> CrewTurn {
    tasks.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let evidence = crew_evidence(&tasks);
    let usage = crew_turn_usage(&tasks);
    let any = !tasks.is_empty();
    let (audits, delegated) = tasks.into_iter().partition(|t| t.role == "auditor");
    CrewTurn {
        delegated,
        audits,
        usage,
        evidence,
        any,
    }
}

// ---- the graphs (workflowGraph.ts, threadFlow.ts) -----------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Main,
    Worker,
    Expert,
    Auditor,
    Crew,
    Subagent,
    Workflow,
}

/// What the main agent has done and is doing; only on the main node.
#[derive(Clone, Debug, Default)]
pub struct MainWork {
    pub tools: Vec<ToolCount>,
    pub doing: Option<Doing>,
    pub delegated: Option<usize>,
}

/// One agent of a flow. Every node of a flow is an agent, so every node has a role.
#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub state: NodeState,
    pub wave: usize,
    pub role: Role,
    pub task: Option<String>,
    pub main: Option<MainWork>,
    pub model: Option<String>,
    pub progress: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub tokens: Option<u64>,
    pub cost: Option<f64>,
    pub evidence: Option<Evidence>,
    /// On a crew task: the `task.completed` status.
    pub outcome: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphKind {
    Workflow,
    Turn,
    Crew,
}

#[derive(Clone, Debug)]
pub struct Graph {
    /// Stable across updates (`turn:<turn id>`, `workflow:<id>`): what `/dag-workflow N` pins.
    pub id: String,
    pub kind: GraphKind,
    pub name: String,
    /// Which turn this is, counting from 1.
    pub turn_index: Option<usize>,
    pub status: NodeState,
    pub started_at: String,
    pub updated_at: String,
    /// Column titles by wave index, as the shared TS code words them.
    pub wave_titles: Vec<String>,
    pub nodes: Vec<Node>,
    pub edges: Vec<(String, String)>,
}

impl Node {
    fn blank(id: &str, state: NodeState, wave: usize, role: Role) -> Node {
        Node {
            id: id.to_string(),
            state,
            wave,
            role,
            task: None,
            main: None,
            model: None,
            progress: None,
            started_at: None,
            completed_at: None,
            tokens: None,
            cost: None,
            evidence: None,
            outcome: None,
            error: None,
        }
    }
}

/// Edges from one column to the next. Fan-out and fan-in connect fully; two wide columns pair up.
fn connect_columns(from: &[String], to: &[String]) -> Vec<(String, String)> {
    let mut edges: Vec<(String, String)> = Vec::new();
    if from.is_empty() || to.is_empty() {
        return edges;
    }
    let mut add = |a: &String, b: &String| {
        if !edges.iter().any(|(x, y)| x == a && y == b) {
            edges.push((a.clone(), b.clone()));
        }
    };
    if from.len() == 1 || to.len() == 1 || from.len() * to.len() <= 12 {
        for a in from {
            for b in to {
                add(a, b);
            }
        }
    } else {
        for (i, a) in from.iter().enumerate() {
            add(a, &to[i * to.len() / from.len()]);
        }
        for (i, b) in to.iter().enumerate() {
            add(&from[i * from.len() / to.len()], b);
        }
    }
    edges
}

fn graph_status(nodes: &[Node], own: Option<NodeState>) -> NodeState {
    if let Some(own) = own.filter(|s| *s != NodeState::Pending) {
        return own;
    }
    let any = |state| nodes.iter().any(|n| n.state == state);
    if any(NodeState::Running) {
        return NodeState::Running;
    }
    if any(NodeState::Blocked) {
        return NodeState::Blocked;
    }
    if !nodes.is_empty() && nodes.iter().all(|n| n.state.settled()) {
        return if any(NodeState::Failed) {
            NodeState::Failed
        } else if any(NodeState::Cancelled) {
            NodeState::Cancelled
        } else {
            NodeState::Completed
        };
    }
    own.unwrap_or(NodeState::Pending)
}

fn min_or_nan(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// Columns for one turn: a step that starts while every step of the current column is still open
/// runs in parallel with them; otherwise it starts the next column.
fn turn_columns(steps: &[(String, String, Option<String>)]) -> Vec<Vec<String>> {
    let mut columns: Vec<Vec<String>> = Vec::new();
    let mut column_end = f64::NEG_INFINITY;
    for (id, started, completed) in steps {
        let start = ms(started);
        let end = completed.as_deref().map_or(f64::INFINITY, ms);
        match columns.last_mut() {
            Some(current) if start < column_end => {
                current.push(id.clone());
                column_end = min_or_nan(column_end, end);
            }
            _ => {
                columns.push(vec![id.clone()]);
                column_end = end;
            }
        }
    }
    columns
}

fn subagent_node(agent: &Subagent, wave: usize) -> Node {
    Node {
        task: clip(&agent.title, TEXT_LIMIT),
        model: agent.model.clone(),
        progress: agent.progress.as_deref().and_then(|p| clip(p, TEXT_LIMIT)),
        started_at: agent.started_at.clone(),
        completed_at: agent.completed_at.clone(),
        tokens: agent.usage.map(|u| u.total_tokens),
        error: agent.error.as_deref().and_then(|e| clip(e, TEXT_LIMIT)),
        ..Node::blank(&agent.id, agent.status.node_state(), wave, Role::Subagent)
    }
}

/// One graph per provider workflow: its phases are the columns, its agents the cards.
fn workflow_graphs(model: &PanelModel) -> Vec<Graph> {
    model
        .workflows
        .iter()
        .map(|group| {
            let mut columns: Vec<(String, &[Subagent])> = group
                .phases
                .iter()
                .filter(|p| !p.members.is_empty())
                .map(|p| (p.title.clone(), p.members.as_slice()))
                .collect();
            if !group.unphased.is_empty() {
                columns.push(("Other".to_string(), group.unphased.as_slice()));
            }
            let nodes: Vec<Node> = columns
                .iter()
                .enumerate()
                .flat_map(|(wave, (_, members))| {
                    members.iter().map(move |m| subagent_node(m, wave))
                })
                .collect();
            let mut edges = Vec::new();
            for pair in columns.windows(2) {
                let ids =
                    |members: &[Subagent]| members.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
                edges.extend(connect_columns(&ids(pair[0].1), &ids(pair[1].1)));
            }
            let workflow = &group.workflow;
            Graph {
                id: format!("workflow:{}", group.workflow.id),
                kind: GraphKind::Workflow,
                name: workflow
                    .workflow_name
                    .clone()
                    .unwrap_or_else(|| workflow.title.clone()),
                turn_index: None,
                status: graph_status(&nodes, Some(workflow.status.node_state())),
                started_at: workflow
                    .started_at
                    .clone()
                    .unwrap_or_else(|| workflow.first_seen_at.clone()),
                updated_at: workflow.updated_at.clone(),
                wave_titles: columns.into_iter().map(|(title, _)| title).collect(),
                nodes,
                edges,
            }
        })
        .collect()
}

fn crew_node(task: &CrewStep, evidence: &HashMap<String, Evidence>) -> Node {
    let role = match task.role.as_str() {
        "worker" => Role::Worker,
        "expert" => Role::Expert,
        "auditor" => Role::Auditor,
        _ => Role::Crew,
    };
    Node {
        task: task.title.clone(),
        model: task.model.clone(),
        progress: task.progress.clone(),
        started_at: Some(task.started_at.clone()),
        completed_at: task.completed_at.clone(),
        tokens: task.usage.map(|u| u.tokens),
        cost: task.usage.and_then(|u| u.cost),
        evidence: evidence.get(&task.id).copied(),
        outcome: task.outcome.clone(),
        ..Node::blank(&task.id, task.state, 0, role)
    }
}

/// A subagent or workflow a tool call launched, as a node of its own.
fn launch_node(step: &ToolStep) -> Node {
    Node {
        task: step.launch_title.clone(),
        model: step.model.clone(),
        progress: step.progress.clone(),
        started_at: Some(step.started_at.clone()),
        completed_at: step.completed_at.clone(),
        tokens: step.tokens,
        error: step.error.clone(),
        ..Node::blank(
            &step.id,
            step.state,
            0,
            if step.launch == Some(Launch::Workflow) {
                Role::Workflow
            } else {
                Role::Subagent
            },
        )
    }
}

/// A turn drawn as agents: the main agent, then the crew and subagents it handed work to.
fn turn_graph(
    turn_id: &str,
    steps: &[ToolStep],
    tasks: Vec<CrewStep>,
    live: bool,
    lead_model: Option<&str>,
    active_started: Option<&str>,
) -> Graph {
    let crew = crew_turn(tasks);
    let updated_at = steps
        .iter()
        .flat_map(|s| [Some(&s.started_at), s.completed_at.as_ref()])
        .chain(
            crew.delegated
                .iter()
                .chain(&crew.audits)
                .flat_map(|t| [Some(&t.started_at), t.completed_at.as_ref()]),
        )
        .flatten()
        .filter(|s| !s.is_empty())
        .max()
        .cloned()
        .or_else(|| active_started.map(str::to_string))
        .unwrap_or_default();
    let mut firsts: Vec<&str> = [
        steps.first().map(|s| s.started_at.as_str()),
        crew.delegated
            .iter()
            .chain(&crew.audits)
            .map(|t| t.started_at.as_str())
            .min(),
        active_started,
    ]
    .into_iter()
    .flatten()
    .filter(|t| !t.is_empty())
    .collect();
    firsts.sort_unstable();
    let started_at = firsts.first().map(|s| s.to_string()).unwrap_or_default();

    // A turn that has ended leaves nothing running: a task with no final report reads as stopped.
    let settle = |mut node: Node| {
        if !live && node.state == NodeState::Running {
            node.state = NodeState::Cancelled;
            node.completed_at.get_or_insert_with(|| updated_at.clone());
        }
        node
    };
    let mut delegates: Vec<Node> = crew
        .delegated
        .iter()
        .map(|t| crew_node(t, &crew.evidence))
        .chain(steps.iter().filter(|s| s.launch.is_some()).map(launch_node))
        .map(&settle)
        .collect();
    delegates.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let columns = turn_columns(
        &delegates
            .iter()
            .map(|n| {
                (
                    n.id.clone(),
                    n.started_at.clone().unwrap_or_default(),
                    n.completed_at.clone(),
                )
            })
            .collect::<Vec<_>>(),
    );
    let audits: Vec<Node> = crew
        .audits
        .iter()
        .map(|t| {
            let mut node = settle(crew_node(t, &crew.evidence));
            node.wave = columns.len() + 1;
            node
        })
        .collect();
    let running_tool = steps
        .iter()
        .rev()
        .find(|s| s.state == NodeState::Running && s.category.is_some());
    let child_running = delegates
        .iter()
        .chain(&audits)
        .any(|n| n.state == NodeState::Running);
    let doing = live.then(|| match running_tool.and_then(|s| s.category) {
        Some(category) => Doing::Tool(category),
        None if child_running => Doing::Waiting,
        None => Doing::Thinking,
    });
    let main_id = format!("main:{turn_id}");
    let mut main = Node::blank(
        &main_id,
        if live {
            NodeState::Running
        } else {
            NodeState::Completed
        },
        0,
        Role::Main,
    );
    main.main = Some(MainWork {
        tools: tool_counts(steps.iter().map(|s| s.category)),
        doing,
        delegated: (!crew.delegated.is_empty()).then_some(crew.delegated.len()),
    });
    main.model = lead_model.map(str::to_string);
    main.started_at = Some(started_at.clone());
    main.completed_at = (!live).then(|| updated_at.clone());
    main.tokens = crew.usage.map(|u| u.tokens);
    main.cost = crew.usage.and_then(|u| u.cost);

    let mut chain: Vec<Vec<String>> = vec![vec![main_id]];
    chain.extend(columns.iter().cloned());
    chain.push(audits.iter().map(|n| n.id.clone()).collect());
    chain.retain(|column| !column.is_empty());
    let edges = chain
        .windows(2)
        .flat_map(|pair| connect_columns(&pair[0], &pair[1]))
        .collect();

    let mut wave_titles = vec!["Main agent".to_string()];
    wave_titles.extend(columns.iter().map(|_| "Delegated work".to_string()));
    if !audits.is_empty() {
        wave_titles.push("Review".to_string());
    }
    let mut nodes = vec![main];
    for (wave, column) in columns.iter().enumerate() {
        for id in column {
            if let Some(node) = delegates.iter().find(|n| n.id == *id) {
                nodes.push(Node {
                    wave: wave + 1,
                    ..node.clone()
                });
            }
        }
    }
    nodes.extend(audits.iter().cloned());
    let children: Vec<Node> = nodes[1..].to_vec();
    Graph {
        id: format!("turn:{turn_id}"),
        kind: if crew.any {
            GraphKind::Crew
        } else {
            GraphKind::Turn
        },
        name: "Turn".to_string(),
        turn_index: None,
        status: if live {
            NodeState::Running
        } else if children.is_empty() {
            NodeState::Completed
        } else {
            graph_status(&children, None)
        },
        started_at,
        updated_at,
        wave_titles,
        nodes,
        edges,
    }
}

/// Every flow of the thread as the agents doing the work, newest first: one turn is one flow (the
/// main agent, the crew it delegated to, the subagents and workflows it launched) and each
/// provider workflow is a flow of its own.
pub fn flows(thread: &Thread, lead_model: Option<&str>) -> Vec<Graph> {
    let (active_id, active_started) = active_turn(thread);
    let turns = collect_tool_steps(&thread.activities);
    let mut tasks_by_turn = collect_crew_tasks(&thread.activities);
    let mut turn_ids: Vec<String> = turns.iter().map(|t| t.turn_id.clone()).collect();
    for (turn_id, _) in &tasks_by_turn {
        if !turn_ids.contains(turn_id) {
            turn_ids.push(turn_id.clone());
        }
    }
    if let (Some(id), Some(_)) = (&active_id, &active_started)
        && !turn_ids.contains(id)
    {
        turn_ids.push(id.clone());
    }
    let mut built: Vec<Graph> = turn_ids
        .iter()
        .map(|turn_id| {
            let steps: &[ToolStep] = turns
                .iter()
                .find(|t| t.turn_id == *turn_id)
                .map_or(&[][..], |t| t.steps.as_slice());
            let tasks = tasks_by_turn
                .iter()
                .position(|(id, _)| id == turn_id)
                .map(|at| tasks_by_turn.remove(at).1)
                .unwrap_or_default();
            let live = active_id.as_deref() == Some(turn_id.as_str());
            turn_graph(
                turn_id,
                steps,
                tasks,
                live,
                lead_model,
                if live {
                    active_started.as_deref()
                } else {
                    None
                },
            )
        })
        .collect();
    built.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    for (index, graph) in built.iter_mut().enumerate() {
        graph.turn_index = Some(index + 1);
        graph.name = format!("Turn {}", index + 1);
    }
    built.extend(workflow_graphs(&agent_model(thread)));
    built.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    built
}

/// The graph to show: the one the user picked if it is still there, else the live one.
pub fn focus_pinned(graphs: &[Graph], pinned: Option<&str>) -> Option<usize> {
    pinned
        .and_then(|id| graphs.iter().position(|g| g.id == id))
        .or_else(|| focus_graph(graphs))
}

/// The graph to follow: the newest still moving, else the newest.
pub fn focus_graph(graphs: &[Graph]) -> Option<usize> {
    let mut newest: Vec<usize> = (0..graphs.len()).collect();
    newest.sort_by(|&a, &b| {
        graphs[b]
            .updated_at
            .cmp(&graphs[a].updated_at)
            .then_with(|| graphs[b].started_at.cmp(&graphs[a].started_at))
    });
    newest
        .iter()
        .copied()
        .find(|&i| graphs[i].status == NodeState::Running)
        .or_else(|| {
            newest.iter().copied().find(|&i| {
                matches!(
                    graphs[i].status,
                    NodeState::Running
                        | NodeState::Blocked
                        | NodeState::Paused
                        | NodeState::Pending
                )
            })
        })
        .or_else(|| newest.first().copied())
}

/// How long a node has run (still running) or ran; `None` when its start is unknown.
pub fn node_elapsed_ms(node: &Node, now_ms: i64) -> Option<i64> {
    let start = ms(node.started_at.as_deref()?);
    let end = node.completed_at.as_deref().map_or(now_ms as f64, ms);
    (start.is_finite() && end.is_finite() && end >= start).then_some((end - start) as i64)
}

// ---- the crew board (crewBoard.ts) --------------------------------------------------------------

/// How a crew task stands. `Stopped` also covers a task whose turn ended without any report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrewPhase {
    Running,
    Completed,
    Partial,
    Blocked,
    Failed,
    Stopped,
}

/// Which of Open, Stop and Retry a crew task offers (`crewTaskActions` in
/// packages/client-runtime/src/crewBoard.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CrewTaskActions {
    /// The task has no final report yet and its thread is known.
    pub stop: bool,
    pub open: bool,
    /// A worker or expert task that ended without finishing; an audit runs again with the next change.
    pub retry: bool,
}

#[derive(Clone, Debug)]
pub struct CrewTask {
    pub task_id: String,
    /// `worker`, `expert` or `auditor`.
    pub role: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub phase: CrewPhase,
    /// Its turn ended while it was still marked as running.
    pub unreported: bool,
    pub thread_id: Option<String>,
    pub summary: Option<String>,
    /// Epoch milliseconds; `None` when the activity carried no usable time.
    pub started_ms: Option<i64>,
    pub completed_ms: Option<i64>,
    pub tokens: Option<u64>,
    pub cost: Option<f64>,
    pub evidence: Option<Evidence>,
    pub actions: CrewTaskActions,
    started_at: f64,
}

/// Something the crew did about a turn that is not a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrewNoteKind {
    AuditSkipped,
    FollowUp,
}

#[derive(Clone, Debug)]
pub struct CrewNote {
    pub kind: CrewNoteKind,
    /// `changedFiles` of an audit left out, or the reason of a follow-up.
    pub detail: Value,
}

#[derive(Clone, Debug)]
pub struct CrewBoard {
    /// The board is the lead's running or newest turn, not an earlier one.
    pub current: bool,
    pub tasks: Vec<CrewTask>,
    pub notes: Vec<CrewNote>,
    pub running: usize,
    /// Tasks that are no longer running, whatever they ended as.
    pub settled: usize,
    pub usage: Option<(u64, Option<f64>)>,
}

/// The crew board of the lead's newest turn that used the crew; `None` when it never did.
/// `running` says the lead's turn is still going: once it ends a task with no report reads stopped.
pub fn crew_board(thread: &Thread, running: bool) -> Option<CrewBoard> {
    let latest = thread.latest_turn.as_ref();
    let active = running
        .then(|| {
            thread
                .session
                .as_ref()
                .and_then(|s| s.active_turn_id.clone())
                .or_else(|| {
                    latest
                        .filter(|t| t.state == "running")
                        .map(|t| t.turn_id.clone())
                })
        })
        .flatten();
    let mut newest: Option<(String, Vec<CrewStep>)> = None;
    for (turn_id, mut tasks) in collect_crew_tasks(&thread.activities) {
        tasks.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        if newest
            .as_ref()
            .is_none_or(|(_, best)| tasks[0].started_at > best[0].started_at)
        {
            newest = Some((turn_id, tasks));
        }
    }
    let (turn_id, tasks) = newest?;
    let live = active.as_deref() == Some(turn_id.as_str());
    let crew = crew_turn(tasks);
    let to_task = |step: &CrewStep| {
        let state = if !live && step.state == NodeState::Running {
            NodeState::Cancelled
        } else {
            step.state
        };
        let phase = match step.outcome.as_deref() {
            None if state == NodeState::Running => CrewPhase::Running,
            Some("completed") => CrewPhase::Completed,
            Some("partial") => CrewPhase::Partial,
            Some("blocked") => CrewPhase::Blocked,
            Some("failed") => CrewPhase::Failed,
            _ => CrewPhase::Stopped,
        };
        let first_line = |text: &Option<String>| {
            text.as_deref()
                .and_then(|t| t.lines().map(str::trim).find(|l| !l.is_empty()))
                .map(str::to_string)
        };
        let outcome = step.outcome.as_deref();
        CrewTask {
            task_id: step.id.clone(),
            role: step.role.clone(),
            title: first_line(&step.title),
            model: first_line(&step.model),
            phase,
            unreported: step.outcome.is_none() && state != NodeState::Running,
            thread_id: step.thread_id.clone(),
            summary: first_line(&step.progress),
            started_ms: parse_iso_ms(&step.started_at),
            completed_ms: step.completed_at.as_deref().and_then(parse_iso_ms),
            actions: CrewTaskActions {
                stop: outcome.is_none() && step.thread_id.is_some(),
                open: step.thread_id.is_some(),
                retry: step.role != "auditor"
                    && matches!(outcome, Some("failed" | "stopped" | "blocked" | "partial")),
            },
            tokens: step.usage.map(|u| u.tokens),
            cost: step.usage.and_then(|u| u.cost),
            evidence: crew.evidence.get(&step.id).copied(),
            started_at: parse_iso_ms(&step.started_at).map_or(0.0, |v| v as f64),
        }
    };
    let mut board_tasks: Vec<CrewTask> = crew
        .delegated
        .iter()
        .chain(&crew.audits)
        .map(to_task)
        .collect();
    board_tasks.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
    let running_count = board_tasks
        .iter()
        .filter(|t| t.phase == CrewPhase::Running)
        .count();
    let notes = thread
        .activities
        .iter()
        .filter(|a| a.turn_id.as_deref() == Some(turn_id.as_str()))
        .filter_map(|a| match a.kind.as_str() {
            "crew.audit-skipped" => Some(CrewNote {
                kind: CrewNoteKind::AuditSkipped,
                detail: a.payload["changedFiles"].clone(),
            }),
            "crew.follow-up" => Some(CrewNote {
                kind: CrewNoteKind::FollowUp,
                detail: a.payload["reason"].clone(),
            }),
            _ => None,
        })
        .collect();
    Some(CrewBoard {
        notes,
        current: Some(turn_id.as_str()) == active.as_deref().or(latest.map(|t| t.turn_id.as_str())),
        running: running_count,
        settled: board_tasks.len() - running_count,
        tasks: board_tasks,
        usage: crew.usage.map(|u| (u.tokens, u.cost)),
    })
}

// ---- the agents of the Agents panel (agentFlow.ts) ----------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowState {
    Working,
    Thinking,
    Waiting,
    Done,
    Failed,
    Stopped,
}

fn flow_state(status: AgentStatus) -> FlowState {
    match status {
        AgentStatus::Pending | AgentStatus::Running => FlowState::Working,
        AgentStatus::Waiting => FlowState::Waiting,
        AgentStatus::Idle | AgentStatus::Completed => FlowState::Done,
        AgentStatus::Failed => FlowState::Failed,
        AgentStatus::Cancelled | AgentStatus::Interrupted => FlowState::Stopped,
    }
}

#[derive(Clone, Debug)]
pub struct FlowAgent {
    pub id: String,
    pub crew: bool,
    /// `Lead`, the crew role, `Workflow`, or the subagent's role (`Subagent` without one).
    pub name: String,
    pub state: FlowState,
    pub task: Option<String>,
    pub started_at: Option<String>,
    /// On the lead: its tool calls this turn by category, and what it does right now.
    pub tools: Vec<ToolCount>,
    pub doing: Option<Doing>,
}

/// One step of the latest turn's work: a run of the lead's own work, or an agent it started.
#[derive(Clone, Debug)]
pub struct FlowBox {
    pub agent_id: String,
    pub title: String,
    pub state: FlowState,
    /// On a run of the lead's own work: what it did by category and what it does right now.
    pub lead: Option<(Vec<ToolCount>, Option<Doing>)>,
}

#[derive(Clone, Debug)]
pub struct AgentFlow {
    /// The lead first, then the others, working ones first.
    pub agents: Vec<FlowAgent>,
    pub boxes: Vec<FlowBox>,
}

/// The lead's latest turn, read the way `threadFlows` draws its tool steps.
struct TurnFlow {
    started_at: String,
    steps: Vec<(String, Option<Cat>, NodeState)>,
    tools: Vec<ToolCount>,
    /// The turn runs but no step does: the model works out its next call.
    thinking: bool,
}

/// The steps a turn graph draws, by index: every step that has not settled, then the newest
/// settled ones, 60 at most.
fn visible_steps(steps: &[ToolStep]) -> Vec<usize> {
    const MAX: usize = 60;
    if steps.len() <= MAX {
        return (0..steps.len()).collect();
    }
    let open: Vec<usize> = (0..steps.len())
        .filter(|&i| !steps[i].state.settled())
        .collect();
    let mut keep: std::collections::BTreeSet<usize> = open[open.len().saturating_sub(MAX)..]
        .iter()
        .copied()
        .collect();
    let mut index = steps.len();
    while index > 0 && keep.len() < MAX {
        index -= 1;
        keep.insert(index);
    }
    keep.into_iter().collect()
}

fn newest_turn_flow(
    activities: &[Activity],
    active_id: Option<&str>,
    active_started: Option<&str>,
) -> Option<TurnFlow> {
    let mut flows: Vec<(String, TurnFlow)> = collect_tool_steps(activities)
        .into_iter()
        .map(|turn| {
            let live = active_id == Some(turn.turn_id.as_str());
            let tools = tool_counts(turn.steps.iter().map(|s| s.category));
            let visible = visible_steps(&turn.steps);
            let steps: Vec<(String, Option<Cat>, NodeState)> = visible
                .iter()
                .map(|&i| {
                    let s = &turn.steps[i];
                    let state = if !live && s.state == NodeState::Running {
                        NodeState::Cancelled
                    } else {
                        s.state
                    };
                    (s.started_at.clone(), s.category, state)
                })
                .collect();
            let thinking = live && !steps.iter().any(|s| s.2 == NodeState::Running);
            (
                turn.turn_id,
                TurnFlow {
                    started_at: turn.steps[visible[0]].started_at.clone(),
                    steps,
                    tools,
                    thinking,
                },
            )
        })
        .collect();
    if let (Some(id), Some(started)) = (active_id, active_started)
        && !flows.iter().any(|(turn_id, _)| turn_id == id)
    {
        flows.push((
            id.to_string(),
            TurnFlow {
                started_at: started.to_string(),
                steps: Vec::new(),
                tools: Vec::new(),
                thinking: true,
            },
        ));
    }
    let mut newest: Option<TurnFlow> = None;
    for (_, flow) in flows {
        if newest
            .as_ref()
            .is_none_or(|n| flow.started_at > n.started_at)
        {
            newest = Some(flow);
        }
    }
    newest
}

pub fn agent_flow(thread: &Thread, model: &PanelModel) -> AgentFlow {
    let (active_id, active_started) = active_turn(thread);
    let turn = newest_turn_flow(
        &thread.activities,
        active_id.as_deref(),
        active_started.as_deref(),
    );
    let mut crew_roles: HashMap<String, String> = HashMap::new();
    for activity in thread
        .activities
        .iter()
        .filter(|a| a.kind.starts_with("task."))
    {
        if let (Some(task_id), Some(role)) = (
            any_txt(&activity.payload["taskId"]),
            any_txt(&activity.payload["crewRole"]),
        ) {
            crew_roles.insert(task_id, role);
        }
    }
    // working: a step runs; thinking: the turn runs between steps; done: it ended.
    let running_step = turn
        .as_ref()
        .and_then(|t| t.steps.iter().find(|s| s.2 == NodeState::Running));
    let (lead_state, lead_doing) = match &turn {
        Some(_) if running_step.is_some() => (
            FlowState::Working,
            Some(
                running_step
                    .and_then(|s| s.1)
                    .map_or(Doing::Waiting, Doing::Tool),
            ),
        ),
        Some(t) if t.thinking => (FlowState::Thinking, Some(Doing::Thinking)),
        _ => (FlowState::Done, None),
    };

    let subagents: Vec<&Subagent> = model
        .workflows
        .iter()
        .map(|g| &g.workflow)
        .chain(&model.direct)
        .collect();
    let mut others: Vec<FlowAgent> = subagents
        .iter()
        .map(|agent| {
            let crew_role = crew_roles.get(&agent.id);
            let workflow = agent.kind == SubagentKind::Workflow;
            FlowAgent {
                id: agent.id.clone(),
                crew: crew_role.is_some(),
                name: match crew_role {
                    Some(role) => match role.as_str() {
                        "worker" => "Worker".to_string(),
                        "expert" => "Expert".to_string(),
                        "auditor" => "Auditor".to_string(),
                        other => other.to_string(),
                    },
                    None if workflow => "Workflow".to_string(),
                    None => agent.role.clone().unwrap_or_else(|| "Subagent".to_string()),
                },
                state: flow_state(agent.status),
                task: Some(agent.title.clone()),
                started_at: Some(
                    agent
                        .started_at
                        .clone()
                        .unwrap_or_else(|| agent.first_seen_at.clone()),
                ),
                tools: Vec::new(),
                doing: None,
            }
        })
        .collect();
    let order = |state: FlowState| match state {
        FlowState::Working | FlowState::Thinking => 0,
        FlowState::Waiting => 1,
        FlowState::Failed => 2,
        FlowState::Stopped => 3,
        FlowState::Done => 4,
    };
    others.sort_by(|a, b| {
        order(a.state)
            .cmp(&order(b.state))
            .then_with(|| b.started_at.cmp(&a.started_at))
    });

    // The latest turn's work, in order: runs of lead steps broken by each agent it started.
    let turn_start = turn.as_ref().map_or("", |t| t.started_at.as_str());
    let mut launched: Vec<&FlowAgent> = others
        .iter()
        .filter(|a| a.started_at.as_deref().is_some_and(|s| s >= turn_start))
        .collect();
    launched.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let agent_box = |agent: &FlowAgent| FlowBox {
        agent_id: agent.id.clone(),
        title: agent.task.clone().unwrap_or_else(|| agent.name.clone()),
        state: agent.state,
        lead: None,
    };
    let mut boxes: Vec<FlowBox> = Vec::new();
    let mut run: Vec<&(String, Option<Cat>, NodeState)> = Vec::new();
    let flush = |run: &mut Vec<&(String, Option<Cat>, NodeState)>, boxes: &mut Vec<FlowBox>| {
        if run.is_empty() {
            return;
        }
        let running = run.iter().find(|s| s.2 == NodeState::Running);
        boxes.push(FlowBox {
            agent_id: "lead".to_string(),
            title: "Main agent".to_string(),
            state: if running.is_some() {
                FlowState::Working
            } else if run.iter().any(|s| s.2 == NodeState::Failed) {
                FlowState::Failed
            } else {
                FlowState::Done
            },
            lead: Some((
                tool_counts(run.iter().map(|s| s.1)),
                running.map(|s| s.1.map_or(Doing::Waiting, Doing::Tool)),
            )),
        });
        run.clear();
    };
    let mut steps: Vec<&(String, Option<Cat>, NodeState)> = turn
        .as_ref()
        .map(|t| t.steps.iter().filter(|s| s.1.is_some()).collect())
        .unwrap_or_default();
    steps.sort_by(|a, b| a.0.cmp(&b.0));
    let mut next = 0;
    for step in steps {
        while next < launched.len()
            && launched[next].started_at.as_deref().unwrap_or("") <= step.0.as_str()
        {
            flush(&mut run, &mut boxes);
            boxes.push(agent_box(launched[next]));
            next += 1;
        }
        run.push(step);
    }
    flush(&mut run, &mut boxes);
    for agent in &launched[next..] {
        boxes.push(agent_box(agent));
    }
    if lead_state == FlowState::Thinking {
        boxes.push(FlowBox {
            agent_id: "lead".to_string(),
            title: "Working out the next step".to_string(),
            state: FlowState::Thinking,
            lead: Some((Vec::new(), Some(Doing::Thinking))),
        });
    }
    let skip = boxes.len().saturating_sub(12);
    boxes.drain(..skip);

    let mut agents = vec![FlowAgent {
        id: "lead".to_string(),
        crew: false,
        name: "Lead".to_string(),
        state: lead_state,
        task: None,
        started_at: turn.as_ref().map(|t| t.started_at.clone()),
        tools: turn.map(|t| t.tools).unwrap_or_default(),
        doing: lead_doing,
    }];
    agents.extend(others);
    AgentFlow { agents, boxes }
}

/// The crew threads of the lead that wait for the user, with what they wait for. Threads saved
/// before crew threads were linked to their lead have no parent; those in the lead's project
/// count too, since nothing else would show their request.
pub fn waiting_crew(children: &[ThreadShell], lead: &Thread) -> HashMap<String, Waiting> {
    children
        .iter()
        .filter(|t| t.archived_at.is_none() && is_crew_sub_thread(t))
        .filter(|t| t.has_pending_approvals || t.has_pending_user_input)
        .filter(|t| match &t.parent_thread_id {
            Some(parent) => *parent == lead.id,
            None => t.project_id == lead.project_id,
        })
        .map(|t| {
            let kind = if t.has_pending_approvals {
                Waiting::Approval
            } else {
                Waiting::Input
            };
            (t.id.clone(), kind)
        })
        .collect()
}

pub fn is_crew_sub_thread(thread: &ThreadShell) -> bool {
    thread.parent_thread_id.is_some()
        || ["Worker", "Expert", "Auditor"]
            .iter()
            .any(|role| thread.title.starts_with(&format!("Crew {role} · ")))
}
