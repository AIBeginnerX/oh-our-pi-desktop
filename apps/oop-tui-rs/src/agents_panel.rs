//! The Agents panel: the lead and every agent it runs as cards, the newest turn's work as a lane of
//! small steps, the workflows with their phases, the crew's roles, and the totals pinned under the
//! list. A port of apps/oop-tui/src/app/agentsPanel.ts (`deriveAgentsView`, `renderAgentsPanel`) as
//! a pure function from the read model to lines. Left out: the "open a thread" note (the caller
//! owns it), the view memo and line memo (`AgentsPanel`
//! class; a pure function has nothing to cache), and the tab-bar switch key hint.

use crate::flow::{
    AgentFlow, AgentStatus, CrewBoard, CrewPhase, CrewRoleModel, CrewTask, FlowAgent, FlowInput,
    FlowState, Group, NodeState, PanelModel, Role, Subagent, ToolCount, Waiting, agent_flow,
    agent_model, crew_board, model_label, waiting_crew,
};
use crate::panels_common::*;
use crate::text::parse_iso_ms;
use crate::theme::{Symbols, Theme};
use ratatui::text::Line;
use std::collections::HashMap;

/// Settled agents listed before the rest are folded; agents still working always show.
const ROSTER_LIMIT: usize = 6;
const GROUP_LIMIT: usize = 5;

/// The agents panel as lines for a pane `width` x `height` cells.
pub fn lines(
    input: &FlowInput,
    width: usize,
    height: usize,
    th: &Theme,
    sym: &Symbols,
) -> Vec<Line<'static>> {
    let ctx = Ctx::new(th, sym, input.tick, input.animations);
    let room = width.saturating_sub(2).max(8);
    let mut out = head(&ctx, View::Agents, room);
    if !input.online {
        out.push(margin(clip(
            vec![sp(
                s(
                    "Disconnected · showing what arrived last",
                    "연결 끊김 · 마지막으로 받은 내용",
                ),
                ctx.warning(),
            )],
            room,
        )));
    }
    if input.loading {
        out.extend(say(
            &ctx,
            if input.online {
                s("Loading agents…", "에이전트를 불러오는 중…")
            } else {
                s(
                    "Agents load once you are connected.",
                    "연결되면 이 스레드의 에이전트를 불러옵니다.",
                )
            },
            room,
        ));
        return finish(&ctx, out, width, height);
    }
    let model = derive(input);
    if model.empty {
        if !input.online {
            return finish(&ctx, out, width, height);
        }
        out.extend(empty_state(
            &ctx,
            s("No agents yet", "에이전트가 아직 없습니다"),
            s(
                "Once this thread runs, its agents, subagents and workflows appear here with their state, what they are doing and token use.",
                "이 스레드가 실행되면 에이전트와 서브에이전트·workflow 가 상태, 하는 일, 토큰 사용량과 함께 여기에 나타납니다.",
            ),
            room,
        ));
        return finish(&ctx, out, width, height);
    }

    // The desktop pins its totals under the list; here they are the last rows of the panel.
    let mut footer: Vec<Row> = Vec::new();
    let c = &model.counts;
    let mut pieces: Vec<(String, ratatui::style::Style)> = Vec::new();
    if c.working > 0 {
        let text = fill(
            s("{count} working", "작업 중 {count}"),
            &[("count", c.working.to_string())],
        );
        pieces.push((format!("{} {text}", ctx.g.bullet), ctx.accent()));
    }
    if c.idle > 0 {
        let text = fill(
            s("{count} idle", "유휴 {count}"),
            &[("count", c.idle.to_string())],
        );
        pieces.push((text, ctx.dim()));
    }
    for (kind, n, style) in [
        ("completed", c.done, ctx.dim()),
        ("failed", c.failed, ctx.error()),
        ("stopped", c.stopped, ctx.dim()),
    ] {
        if n > 0 {
            pieces.push((count_word(kind, n), style));
        }
    }
    if c.tokens > 0 {
        let text = fill(
            s("{count} tokens total", "합계 {count} 토큰"),
            &[("count", format_tokens(c.tokens))],
        );
        pieces.push((text, ctx.dim()));
    }
    footer.extend(pack_pieces(&ctx, pieces, room).into_iter().take(2));
    if let Some(board) = &model.board {
        footer.insert(0, clip(vec![sp(format!("Crew {board}"), ctx.dim())], room));
    }
    let pinned: Vec<Row> = if footer.is_empty() || height < 12 {
        Vec::new()
    } else {
        std::iter::once(vec![sp(ctx.g.rule.repeat(room), ctx.dim())])
            .chain(footer)
            .map(margin)
            .collect()
    };
    out.push(vec![]);

    let mut body: Vec<Row> = Vec::new();
    // Scrolling keeps in view the first row that waits for the user, else the first that works.
    let mut focus: Option<usize> = None;
    let mut focus_waiting = false;
    let heading = |text: &str| vec![sp(text.to_string(), ctx.dim())];
    if let Some(crew) = &model.crew {
        // Who the crew would hand work to, and on which model: the roles are the desktop's.
        body.push(heading(s("Crew", "크루")));
        let words: Vec<String> = crew.iter().map(|r| r.role.to_lowercase()).collect();
        let wide = words.iter().map(|w| w.chars().count()).max().unwrap_or(0);
        for (word, CrewRoleModel { model, .. }) in words.iter().zip(crew) {
            let shown = match model {
                Some(name) => sp(flat(name), ctx.text()),
                None => sp(s("no model", "모델 없음"), ctx.dim()),
            };
            body.push(clip(
                vec![
                    sp(format!("  {word:<wide$}"), ctx.muted()),
                    sp("  ", ctx.text()),
                    shown,
                ],
                room - 1,
            ));
        }
        body.push(vec![]);
    }
    body.push(heading(s("Agents", "에이전트")));
    for row in &model.rows {
        if row.waiting.is_some() && !focus_waiting {
            focus = Some(body.len());
            focus_waiting = true;
        } else if focus.is_none() && row.live {
            focus = Some(body.len());
        }
        body.extend(roster_card(&ctx, row, input.now_ms, room - 1));
    }
    if model.folded > 0 {
        body.push(vec![sp(folded_word(model.folded), ctx.dim())]);
    }
    body.push(vec![]);
    body.push(heading(s("Flow · this turn", "흐름 · 이번 턴")));
    if model.lane.is_empty() {
        body.push(vec![sp(
            s(
                "  Nothing has run this turn yet.",
                "  이번 턴에는 아직 작업이 없습니다.",
            ),
            ctx.dim(),
        )]);
    } else {
        body.extend(lane_block(&ctx, &model.lane, room - 1));
    }
    if !model.groups.is_empty() {
        body.push(vec![]);
        body.push(heading(role_word(Role::Workflow)));
        for group in &model.groups {
            body.extend(group_block(&ctx, group, input.now_ms, room - 1));
        }
        if model.groups_folded > 0 {
            body.push(vec![sp(folded_word(model.groups_folded), ctx.dim())]);
        }
    }
    let available = height.saturating_sub(out.len() + pinned.len());
    let body: Vec<Row> = body.into_iter().map(margin).collect();
    let mut shown = window_scrolled(&ctx, body, focus.unwrap_or(0), available, input.scroll);
    while !pinned.is_empty() && shown.len() < available {
        shown.push(vec![]);
    }
    out.extend(shown);
    out.extend(pinned);
    finish(&ctx, out, width, height)
}

/// Something works, so the clock matters.
pub fn is_live(input: &FlowInput) -> bool {
    !input.loading && derive(input).live
}

fn folded_word(count: usize) -> String {
    fill(
        s("  {count} earlier hidden", "  이전 {count}개 생략"),
        &[("count", count.to_string())],
    )
}

// ---- what is derived ----------------------------------------------------------------------------

/// From `start` to `end`, or to now while `end` is `None`.
struct Clock {
    start: i64,
    end: Option<i64>,
}

/// One agent of the panel: the lead, a crew task, a subagent, a workflow, or a workflow's member.
struct AgentRow {
    id: String,
    name: String,
    mark: NodeState,
    state: String,
    waiting: Option<Waiting>,
    task: Option<String>,
    model: Option<String>,
    clock: Option<Clock>,
    /// Tokens, cost, tool calls, evidence: what is known now and does not move with the clock.
    facts: Vec<String>,
    /// What the agent says it does; true when it is an error.
    note: Option<(String, bool)>,
    /// Still working or waiting, so its time runs.
    live: bool,
}

struct LaneItem {
    mark: NodeState,
    title: String,
    detail: Option<String>,
    state: String,
    live: bool,
}

struct PhaseData {
    title: String,
    running: bool,
    done: bool,
    /// What the phase says about itself, e.g. `1 running · 2 done`.
    summary: String,
    members: Vec<AgentRow>,
}

struct GroupData {
    name: String,
    mark: NodeState,
    live: bool,
    total: usize,
    settled: usize,
    failed: usize,
    tokens: u64,
    clock: Option<Clock>,
    phases: Vec<PhaseData>,
    loose: Vec<AgentRow>,
}

#[derive(Default)]
struct Counts {
    working: usize,
    idle: usize,
    done: usize,
    failed: usize,
    stopped: usize,
    tokens: u64,
}

struct AgentsModel {
    /// Nothing to show yet: no agent, and nothing the lead has done.
    empty: bool,
    /// The lead first, then the others; those waiting for the user right after the lead.
    rows: Vec<AgentRow>,
    /// Settled agents left out of `rows` to keep the list short.
    folded: usize,
    lane: Vec<LaneItem>,
    groups: Vec<GroupData>,
    groups_folded: usize,
    counts: Counts,
    /// The crew board's one line for the lead's newest turn that used it.
    board: Option<String>,
    crew: Option<Vec<CrewRoleModel>>,
    live: bool,
}

fn node_of_flow(state: FlowState) -> NodeState {
    match state {
        FlowState::Working | FlowState::Thinking => NodeState::Running,
        FlowState::Waiting => NodeState::Blocked,
        FlowState::Done => NodeState::Completed,
        FlowState::Failed => NodeState::Failed,
        FlowState::Stopped => NodeState::Cancelled,
    }
}

fn phase_mark(phase: CrewPhase) -> NodeState {
    match phase {
        CrewPhase::Running => NodeState::Running,
        CrewPhase::Completed => NodeState::Completed,
        CrewPhase::Partial | CrewPhase::Blocked | CrewPhase::Failed => NodeState::Failed,
        CrewPhase::Stopped => NodeState::Cancelled,
    }
}

fn clock_of(start: Option<&str>, end: Option<&str>, live: bool) -> Option<Clock> {
    let from = start.and_then(parse_iso_ms)?;
    match end.and_then(parse_iso_ms) {
        Some(to) => Some(Clock {
            start: from,
            end: Some(to),
        }),
        None => live.then_some(Clock {
            start: from,
            end: None,
        }),
    }
}

fn workflow_is_live(group: &Group) -> bool {
    !group.workflow.status.terminal()
}

fn model_of(agent: &Subagent) -> Option<String> {
    let label = agent
        .model
        .as_deref()
        .map(|m| flat(&model_label(m, agent.effort.as_deref())));
    label.filter(|l| !l.is_empty())
}

fn tools_text(tools: &[ToolCount]) -> String {
    tools
        .iter()
        .map(|tool| tool_word(*tool))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn now_text(text: &str) -> String {
    fill(
        s("Now: {text}", "지금: {text}"),
        &[("text", text.to_string())],
    )
}

/// What an agent that is not the lead says it is doing: the live line leads with the work in
/// progress, a settled one with how it ended, as the desktop app's agent row does.
fn note_of(agent: &Subagent) -> Option<(String, bool)> {
    let pick = |value: &Option<String>| Some(flat(value.as_deref()?)).filter(|v| !v.is_empty());
    let last = agent
        .last_tool_name
        .as_deref()
        .map(|name| fill(s("tool {name}", "도구 {name}"), &[("name", flat(name))]));
    if agent.status.active() {
        let text = pick(&agent.progress)
            .or(last)
            .or_else(|| pick(&agent.result))
            .or_else(|| pick(&agent.error))?;
        return Some((now_text(&text), false));
    }
    if let Some(error) = pick(&agent.error) {
        return Some((
            fill(s("Error: {text}", "오류: {text}"), &[("text", error)]),
            true,
        ));
    }
    if let Some(result) = pick(&agent.result) {
        return Some((
            fill(s("Result: {text}", "결과: {text}"), &[("text", result)]),
            false,
        ));
    }
    let text = pick(&agent.progress).or(last)?;
    Some((
        fill(s("Last: {text}", "마지막: {text}"), &[("text", text)]),
        false,
    ))
}

/// A crew row falls back to the board's tokens when the agent reports no usage, so the row can show
/// tokens the header's total does not add: the total is the agents' own usage only, as on the
/// desktop. The rows may therefore add up to more than the total, never less.
fn facts_of(agent: &Subagent, task: Option<&CrewTask>) -> Vec<String> {
    let mut facts = Vec::new();
    if let Some(tokens) = agent
        .usage
        .map(|u| u.total_tokens)
        .or(task.and_then(|t| t.tokens))
    {
        facts.push(tokens_word(tokens));
    }
    if let Some(cost) = task.and_then(|t| t.cost) {
        facts.push(format_cost(cost));
    }
    if let Some(uses) = agent.usage.and_then(|u| u.tool_uses) {
        facts.push(fill(
            s("{count} tool calls", "도구 {count}회"),
            &[("count", uses.to_string())],
        ));
    }
    if agent.activation_count > 1 {
        facts.push(fill(
            s("{count} runs", "실행 {count}회"),
            &[("count", agent.activation_count.to_string())],
        ));
    }
    if let Some(evidence) = task.and_then(|t| t.evidence) {
        facts.push(fill(
            s("Evidence: {text}", "근거: {text}"),
            &[("text", evidence_word(evidence).to_string())],
        ));
    }
    facts
}

/// A subagent, a crew task or a workflow's member as a row.
fn row_of_agent(
    agent: &Subagent,
    name: String,
    asked: Option<String>,
    task: Option<&CrewTask>,
    waiting: Option<Waiting>,
) -> AgentRow {
    // A pending agent is counted as working by the header and drawn as working in the lane; its row
    // says the same instead of "not started".
    let sub = if agent.status == AgentStatus::Pending {
        NodeState::Running
    } else {
        agent.status.node_state()
    };
    let mark = task.map_or(sub, |t| phase_mark(t.phase));
    // A crew task the board has settled with its turn is over, whatever the session still says.
    let live = task.map_or(agent.status.active(), |t| t.phase == CrewPhase::Running);
    let state = match task {
        Some(t) => phase_word(t),
        None if agent.status == AgentStatus::Idle => s("Idle · can resume", "유휴 · 재개 가능"),
        None => state_word(sub),
    };
    AgentRow {
        id: agent.id.clone(),
        name,
        mark: if waiting.is_none() {
            mark
        } else {
            NodeState::Blocked
        },
        state: state.to_string(),
        waiting,
        task: asked,
        model: model_of(agent),
        clock: clock_of(
            Some(agent.started_at.as_deref().unwrap_or(&agent.first_seen_at)),
            agent.completed_at.as_deref(),
            live,
        ),
        facts: facts_of(agent, task),
        note: note_of(agent),
        live,
    }
}

fn with_role(agent: &Subagent) -> String {
    let title = flat(&agent.title);
    let role = agent.role.as_deref().map(flat).unwrap_or_default();
    if role.is_empty() || role.to_lowercase() == title.to_lowercase() {
        title
    } else {
        format!("{title} [{role}]")
    }
}

fn lead_row(entry: &FlowAgent, input: &FlowInput) -> AgentRow {
    let working = matches!(entry.state, FlowState::Working | FlowState::Thinking);
    let doing = [
        entry
            .doing
            .map(|d| doing_word(d).to_string())
            .unwrap_or_default(),
        tools_text(&entry.tools),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let text = match (working, doing.is_empty()) {
        (true, true) => None,
        (true, false) => Some(now_text(&doing)),
        (false, true) => {
            Some(s("Waiting for your next request", "다음 요청을 기다립니다").to_string())
        }
        (false, false) => Some(fill(
            s("Turn finished · {text}", "턴을 마침 · {text}"),
            &[("text", doing)],
        )),
    };
    let state = if !working {
        state_word(NodeState::Completed)
    } else if entry.state == FlowState::Thinking {
        s("Thinking", "생각하는 중")
    } else {
        state_word(NodeState::Running)
    };
    AgentRow {
        id: entry.id.clone(),
        name: "Lead".to_string(),
        mark: if input.lead_waiting.is_none() {
            node_of_flow(entry.state)
        } else {
            NodeState::Blocked
        },
        state: state.to_string(),
        waiting: input.lead_waiting,
        task: None,
        model: input.lead_model.as_deref().map(flat),
        // The lead has no end of its own; its clock is the running turn.
        clock: if working {
            clock_of(entry.started_at.as_deref(), None, true)
        } else {
            None
        },
        facts: Vec::new(),
        note: text.map(|t| (t, false)),
        live: working,
    }
}

/// The newest turn's work in the order it happened. An agent's step says who it is and where it
/// stands in the words the list above uses; a run of the lead's own work says what it did.
fn lane_of(flow: &AgentFlow, rows: &[AgentRow]) -> Vec<LaneItem> {
    let by_id: HashMap<&str, &AgentRow> = rows.iter().map(|r| (r.id.as_str(), r)).collect();
    flow.boxes
        .iter()
        .map(|item| {
            let mark = node_of_flow(item.state);
            let live = matches!(item.state, FlowState::Working | FlowState::Thinking);
            let Some((tools, doing)) = &item.lead else {
                let row = by_id.get(item.agent_id.as_str());
                let title = flat(&item.title);
                return LaneItem {
                    mark: row.map_or(mark, |r| r.mark),
                    title: match row {
                        Some(r) => [r.name.clone(), title]
                            .into_iter()
                            .filter(|p| !p.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                        None => title,
                    },
                    detail: None,
                    state: row.map_or_else(|| state_word(mark).to_string(), |r| r.state.clone()),
                    live: row.map_or(live, |r| r.live),
                };
            };
            let where_ = doing.map(|d| doing_word(d).to_string()).unwrap_or_default();
            let tools = tools_text(tools);
            LaneItem {
                mark,
                title: if !where_.is_empty() {
                    where_.clone()
                } else if !tools.is_empty() {
                    tools.clone()
                } else {
                    role_word(Role::Main).to_string()
                },
                detail: (!where_.is_empty() && !tools.is_empty()).then_some(tools),
                state: state_word(mark).to_string(),
                live,
            }
        })
        .collect()
}

fn phase_summary(phase: &crate::flow::Phase) -> String {
    use crate::flow::PhaseState;
    if phase.state == PhaseState::Pending && phase.members.is_empty() {
        return state_word(NodeState::Pending).to_string();
    }
    let failed = phase
        .members
        .iter()
        .filter(|m| m.status == AgentStatus::Failed)
        .count();
    let mut parts = Vec::new();
    if phase.state != PhaseState::Done {
        parts.push(count_word("running", phase.active_count));
    }
    parts.push(count_word("completed", phase.settled_count - failed));
    if failed > 0 {
        parts.push(count_word("failed", failed));
    }
    parts.join(" · ")
}

fn group_of(group: &Group) -> GroupData {
    use crate::flow::PhaseState;
    let members = group.members();
    let failed = members
        .iter()
        .filter(|m| m.status == AgentStatus::Failed)
        .count();
    let row = |member: &Subagent| row_of_agent(member, with_role(member), None, None, None);
    let live = workflow_is_live(group);
    // The coordinator's usage may already add its members up: count it only when there are none.
    let tokens = if members.is_empty() {
        group.workflow.usage.map_or(0, |u| u.total_tokens)
    } else {
        members
            .iter()
            .map(|m| m.usage.map_or(0, |u| u.total_tokens))
            .sum()
    };
    let flat_name = flat(
        group
            .workflow
            .workflow_name
            .as_deref()
            .unwrap_or(&group.workflow.title),
    );
    GroupData {
        name: flat_name,
        mark: if failed > 0 {
            NodeState::Failed
        } else {
            group.workflow.status.node_state()
        },
        live,
        total: members.len(),
        settled: members.iter().filter(|m| m.status.terminal()).count(),
        failed,
        tokens,
        clock: clock_of(
            group.workflow.started_at.as_deref(),
            group.workflow.completed_at.as_deref(),
            false,
        ),
        phases: if live {
            group
                .phases
                .iter()
                .map(|phase| PhaseData {
                    title: flat(&phase.title),
                    running: phase.state == PhaseState::Running,
                    done: phase.state == PhaseState::Done,
                    summary: phase_summary(phase),
                    members: phase.members.iter().map(row).collect(),
                })
                .collect()
        } else {
            Vec::new()
        },
        loose: if live {
            group.unphased.iter().map(row).collect()
        } else {
            Vec::new()
        },
    }
}

/// How the agents ended, so a failure never hides inside a total. A crew task the board has settled
/// is counted by how the board says it ended (a `partial` or `blocked` one is a failure, not a
/// success), whatever the roster still says and whether or not its row is shown; its agent is left
/// out of the roster's own counts, so it is counted once.
fn counts_of(model: &PanelModel, settled: &[&CrewTask]) -> Counts {
    // A workflow with members is a container for them, as in the model's own counts.
    let agents: Vec<&Subagent> = model
        .workflows
        .iter()
        .flat_map(|group| {
            let members = group.members();
            if members.is_empty() {
                vec![&group.workflow]
            } else {
                members
            }
        })
        .chain(model.direct.iter())
        .collect();
    let by_board = |agent: &&Subagent| settled.iter().any(|t| t.task_id == agent.id);
    let own = agents.iter().filter(|a| !by_board(a));
    let overlap: Vec<&&Subagent> = agents.iter().filter(|a| by_board(a)).collect();
    let count =
        |statuses: &[AgentStatus]| own.clone().filter(|a| statuses.contains(&a.status)).count();
    let ended = |phases: &[CrewPhase]| settled.iter().filter(|t| phases.contains(&t.phase)).count();
    Counts {
        // The model counted the overlapping agents as working or idle; the board has them ended.
        working: (model.running + model.waiting)
            .saturating_sub(overlap.iter().filter(|a| a.status.active()).count()),
        idle: model.idle.saturating_sub(
            overlap
                .iter()
                .filter(|a| a.status == AgentStatus::Idle)
                .count(),
        ),
        done: count(&[AgentStatus::Completed]) + ended(&[CrewPhase::Completed]),
        failed: count(&[AgentStatus::Failed])
            + ended(&[CrewPhase::Partial, CrewPhase::Blocked, CrewPhase::Failed]),
        stopped: count(&[AgentStatus::Cancelled, AgentStatus::Interrupted])
            + ended(&[CrewPhase::Stopped]),
        tokens: model.total_tokens,
    }
}

/// The Agents panel as the desktop app builds it: the agent flow for the lead and the agents of the
/// newest turn and the order of their work, the subagent roster for each agent's usage and what it
/// does now, and the workflows with their phases. Where the crew board already says more about a
/// crew task (how it ended, its cost, the evidence for its result), that is what is shown.
fn derive(input: &FlowInput) -> AgentsModel {
    let thread = input.thread;
    let model = agent_model(thread);
    let flow = agent_flow(thread, &model);
    let agents: HashMap<&str, &Subagent> = model
        .workflows
        .iter()
        .map(|g| &g.workflow)
        .chain(&model.direct)
        .map(|a| (a.id.as_str(), a))
        .collect();
    let running = thread
        .session
        .as_ref()
        .is_some_and(|s| s.status == "running");
    let board: Option<CrewBoard> = crew_board(thread, running);
    let tasks: HashMap<&str, &CrewTask> = board
        .iter()
        .flat_map(|b| b.tasks.iter())
        .map(|t| (t.task_id.as_str(), t))
        .collect();
    let waiting_by = waiting_crew(input.children, thread);

    let (lead, others) = flow
        .agents
        .split_first()
        .map_or((None, &[][..]), |(l, o)| (Some(l), o));
    let task_of = |entry: &FlowAgent| {
        entry
            .crew
            .then(|| tasks.get(entry.id.as_str()).copied())
            .flatten()
    };
    let waiting_of = |entry: &FlowAgent| {
        task_of(entry)
            .and_then(|t| t.thread_id.as_deref())
            .and_then(|id| waiting_by.get(id).copied())
    };
    // An agent that waits for the user is never folded away, however far down the roster it is.
    let kept: Vec<&FlowAgent> = others
        .iter()
        .enumerate()
        .filter(|(index, entry)| {
            *index < ROSTER_LIMIT
                || matches!(
                    entry.state,
                    FlowState::Working | FlowState::Thinking | FlowState::Waiting
                )
                || waiting_of(entry).is_some()
        })
        .map(|(_, entry)| entry)
        .collect();
    let mut listed: Vec<AgentRow> = Vec::new();
    for entry in &kept {
        let Some(agent) = agents.get(entry.id.as_str()) else {
            continue;
        };
        let label = match entry.name.as_str() {
            "Subagent" => role_word(Role::Subagent).to_string(),
            "Workflow" => role_word(Role::Workflow).to_string(),
            other => flat(other),
        };
        let title = flat(entry.task.as_deref().unwrap_or(""));
        let asked =
            (!title.is_empty() && title.to_lowercase() != label.to_lowercase()).then_some(title);
        listed.push(row_of_agent(
            agent,
            label,
            asked,
            task_of(entry),
            waiting_of(entry),
        ));
    }
    // Those waiting for the user come right after the lead, so a list too long for the panel still
    // starts with the ones that need an answer.
    let (asking, quiet): (Vec<AgentRow>, Vec<AgentRow>) =
        listed.into_iter().partition(|row| row.waiting.is_some());
    let rows: Vec<AgentRow> = lead
        .map(|l| lead_row(l, input))
        .into_iter()
        .chain(asking)
        .chain(quiet)
        .collect();

    // A workflow without members is only its coordinator, which the list above already shows.
    let with_members: Vec<&Group> = model
        .workflows
        .iter()
        .filter(|g| !g.members().is_empty())
        .collect();
    let count = with_members.len();
    let shown: Vec<&Group> = with_members
        .iter()
        .enumerate()
        .filter(|(index, group)| *index + GROUP_LIMIT >= count || workflow_is_live(group))
        .map(|(_, group)| *group)
        .collect();
    let settled: Vec<&CrewTask> = tasks
        .values()
        .copied()
        .filter(|t| t.phase != CrewPhase::Running)
        .collect();
    let live = rows.iter().any(|r| r.live) || shown.iter().any(|g| workflow_is_live(g));
    AgentsModel {
        empty: !model.has_agents && !(!flow.boxes.is_empty() || flow.agents.len() > 1),
        folded: others.len() - kept.len(),
        lane: lane_of(&flow, &rows),
        groups: shown.iter().map(|g| group_of(g)).collect(),
        groups_folded: count - shown.len(),
        counts: counts_of(&model, &settled),
        board: board.as_ref().map(board_summary),
        crew: input.crew.map(<[CrewRoleModel]>::to_vec),
        live,
        rows,
    }
}

// ---- drawing ------------------------------------------------------------------------------------

fn elapsed_of(clock: &Option<Clock>, now_ms: i64) -> Option<String> {
    clock
        .as_ref()
        .map(|c| format_elapsed((c.end.unwrap_or(now_ms) - c.start).max(0)))
}

/// One agent of a workflow: who and how it stands, what it was asked, what it costs and takes,
/// what it does now.
fn row_block(ctx: &Ctx, row: &AgentRow, now_ms: i64, room: usize, depth: usize) -> Vec<Row> {
    let lead = "  ".repeat(depth);
    let rest = format!("{lead}    ");
    let mut head: Row = vec![
        sp(format!("{lead}  "), ctx.text()),
        sp(ctx.mark(row.mark), ctx.tone(row.mark)),
        sp(" ", ctx.text()),
        sp(row.name.clone(), ctx.bold()),
        sp(format!("  {}", row.state), ctx.dim()),
    ];
    if let Some(waiting) = row.waiting {
        head.push(sp(format!("  {}", wait_word(waiting)), ctx.warning()));
    }
    let mut lines = vec![clip(head, room)];
    let indented =
        |style, text: String| clip(vec![sp(rest.clone(), ctx.text()), sp(text, style)], room);
    if let Some(task) = &row.task {
        lines.push(indented(ctx.text(), task.clone()));
    }
    let metrics: Vec<String> = row
        .model
        .iter()
        .cloned()
        .chain(elapsed_of(&row.clock, now_ms))
        .chain(row.facts.iter().cloned())
        .collect();
    for line in pack_facts(&metrics, room.saturating_sub(rest.len())) {
        lines.push(indented(ctx.dim(), line));
    }
    if let Some((text, error)) = &row.note {
        lines.push(indented(
            if *error { ctx.error() } else { ctx.dim() },
            text.clone(),
        ));
    }
    lines
}

/// One agent of the roster as the desktop's card: a bar down the left in the colour of its state,
/// the name and model with the state word at the right, what it was asked, and its time and usage.
fn roster_card(ctx: &Ctx, row: &AgentRow, now_ms: i64, room: usize) -> Vec<Row> {
    let tone = ctx.tone(row.mark);
    let (state, state_style) = match row.waiting {
        Some(waiting) => (wait_word(waiting).to_string(), ctx.warning()),
        None => (row.state.clone(), ctx.dim()),
    };
    let inner = room.saturating_sub(2).max(4);
    let mut head: Row = vec![
        sp(ctx.mark(row.mark), tone),
        sp(" ", ctx.text()),
        sp(row.name.clone(), ctx.bold()),
    ];
    if let Some(model) = &row.model {
        head.push(sp(format!("  {model}"), ctx.dim()));
    }
    let state_width = crate::text::width(&state);
    let mut first = clip(head, inner.saturating_sub(state_width + 1).max(2));
    let gap = inner.saturating_sub(row_width(&first) + state_width).max(1);
    first.push(sp(" ".repeat(gap), ctx.text()));
    first.push(sp(state, state_style));
    let mut lines = vec![first];
    if let Some(task) = &row.task {
        lines.push(clip(vec![sp(task.clone(), ctx.text())], inner));
    }
    let metrics: Vec<String> = elapsed_of(&row.clock, now_ms)
        .into_iter()
        .chain(row.facts.iter().cloned())
        .collect();
    for line in pack_facts(&metrics, inner) {
        lines.push(clip(vec![sp(line, ctx.dim())], inner));
    }
    if let Some((text, error)) = &row.note {
        lines.push(clip(
            vec![sp(
                text.clone(),
                if *error { ctx.error() } else { ctx.dim() },
            )],
            inner,
        ));
    }
    let [start, bar, end] = ctx.g.rail;
    let last = lines.len() - 1;
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            let glyph = if last == 0 || (index != 0 && index != last) {
                bar
            } else if index == 0 {
                start
            } else {
                end
            };
            let mut out = vec![sp(glyph, tone), sp(" ", ctx.text())];
            out.extend(line);
            out
        })
        .collect()
}

/// The turn's work as a chain of small cards, each joined to the one before by a connector that is
/// lit while the step it leads into is live, as the desktop's flow lane draws it.
fn lane_block(ctx: &Ctx, items: &[LaneItem], room: usize) -> Vec<Row> {
    let inner = room.saturating_sub(2).max(4);
    let [start, _, end] = ctx.g.rail;
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let tone = ctx.tone(item.mark);
        let detail = [item.detail.clone().unwrap_or_default(), item.state.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        if index > 0 {
            out.push(vec![sp(
                ctx.g.link[0],
                if item.live { ctx.accent() } else { ctx.dim() },
            )]);
        }
        let title_style = if item.live { ctx.bold() } else { ctx.text() };
        let first = clip(
            vec![
                sp(ctx.mark(item.mark), tone),
                sp(" ", ctx.text()),
                sp(item.title.clone(), title_style),
            ],
            inner,
        );
        let mut top = vec![sp(start, tone), sp(" ", ctx.text())];
        top.extend(first);
        out.push(top);
        out.push(vec![
            sp(end, tone),
            sp(" ", ctx.text()),
            sp(crate::text::truncate(&detail, inner), ctx.dim()),
        ]);
    }
    out
}

/// The run's shape at a glance, as the desktop's phase rail: a chip for each phase, joined by
/// chevrons.
fn phase_rail(ctx: &Ctx, group: &GroupData, room: usize) -> Vec<Row> {
    let chips: Vec<Row> = group
        .phases
        .iter()
        .map(|phase| {
            let style = if phase.running {
                ctx.accent()
            } else if phase.done {
                ctx.success()
            } else {
                ctx.dim()
            };
            let mut chip: Row = vec![sp(
                format!(
                    "{}{}",
                    if phase.done {
                        format!("{} ", ctx.g.check)
                    } else {
                        String::new()
                    },
                    phase.title
                ),
                style,
            )];
            chip.push(sp(" ", ctx.text()));
            if phase.members.is_empty() {
                chip.push(sp("-", ctx.dim()));
            }
            chip.extend(
                phase
                    .members
                    .iter()
                    .map(|m| sp(ctx.mark(m.mark), ctx.tone(m.mark))),
            );
            chip
        })
        .collect();
    let mut lines: Vec<Row> = Vec::new();
    let mut line: Row = Vec::new();
    for chip in chips {
        let mut joined = line.clone();
        if !joined.is_empty() {
            joined.push(sp(format!(" {} ", ctx.g.link[3]), ctx.dim()));
        }
        joined.extend(chip.clone());
        if !line.is_empty() && row_width(&joined) > room {
            lines.push(std::mem::replace(&mut line, chip));
        } else {
            line = joined;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines.into_iter().map(|l| clip(l, room)).collect()
}

fn group_block(ctx: &Ctx, group: &GroupData, now_ms: i64, room: usize) -> Vec<Row> {
    let mark = sp(ctx.mark(group.mark), ctx.tone(group.mark));
    let failed: Option<ratatui::text::Span<'static>> = (group.failed > 0).then(|| {
        sp(
            format!(" · {}", count_word("failed", group.failed)),
            ctx.error(),
        )
    });
    if !group.live {
        let facts = [
            Some(fill(
                s("{count} agents", "에이전트 {count}개"),
                &[("count", group.total.to_string())],
            )),
            Some(tokens_word(group.tokens)),
            elapsed_of(&group.clock, now_ms),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let mut row = vec![
            sp("  ", ctx.text()),
            mark,
            sp(" ", ctx.text()),
            sp(group.name.clone(), ctx.text()),
            sp(format!("  {facts}"), ctx.dim()),
        ];
        row.extend(failed);
        return vec![clip(row, room)];
    }
    let settled = fill(
        s("{settled}/{total} done", "{settled}/{total} 완료"),
        &[
            ("settled", group.settled.to_string()),
            ("total", group.total.to_string()),
        ],
    );
    let mut head = vec![
        sp("  ", ctx.text()),
        mark,
        sp(" ", ctx.text()),
        sp(group.name.clone(), ctx.bold()),
        sp(format!("  {settled}"), ctx.dim()),
    ];
    head.extend(failed);
    let mut lines = vec![clip(head, room)];
    lines.extend(
        phase_rail(ctx, group, room.saturating_sub(4))
            .into_iter()
            .map(|l| {
                let mut row = vec![sp("    ", ctx.text())];
                row.extend(l);
                row
            }),
    );
    for phase in &group.phases {
        let mut row = vec![
            sp("    ", ctx.text()),
            sp(
                fill(
                    s("Step {index}", "단계 {index}"),
                    &[("index", phase.title.clone())],
                ),
                if phase.running {
                    ctx.accent()
                } else {
                    ctx.dim()
                },
            ),
            sp(format!("  {}", phase.summary), ctx.dim()),
        ];
        if !phase.running {
            row.push(sp(" ", ctx.text()));
            row.extend(
                phase
                    .members
                    .iter()
                    .map(|m| sp(ctx.mark(m.mark), ctx.tone(m.mark))),
            );
        }
        lines.push(clip(row, room));
        if phase.running {
            for member in &phase.members {
                lines.extend(row_block(ctx, member, now_ms, room, 2));
            }
        }
    }
    for member in &group.loose {
        lines.extend(row_block(ctx, member, now_ms, room, 2));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panels_common::scenes::{self, act, input};
    use crate::theme::{ASCII, LAVENDER, UNICODE};
    use crate::thread::Thread;
    use serde_json::json;

    fn render(input: &FlowInput, width: usize, height: usize) -> Vec<String> {
        plain(&lines(input, width, height, &LAVENDER, &UNICODE))
    }

    fn has(text: &[String], needle: &str) -> bool {
        text.iter().any(|line| line.contains(needle))
    }

    fn at(text: &[String], needle: &str) -> usize {
        text.iter()
            .position(|line| line.contains(needle))
            .expect(needle)
    }

    #[test]
    fn the_lead_alone_shows_what_it_does() {
        let thread = scenes::lead_only();
        let text = render(&input(&thread, &[], 30), 60, 40);
        assert!(has(&text, "Lead  claude-opus-5"));
        assert!(has(&text, "Working"));
        assert!(has(&text, "Now: Running commands… · 2 files read"));
        assert!(has(&text, "Flow · this turn"));
        assert!(has(&text, "Running commands…"));
        assert!(!has(&text, "Worker"));
    }

    #[test]
    fn two_parallel_crew_tasks_are_cards_with_a_board_line() {
        let thread = scenes::parallel();
        let crew = [
            CrewRoleModel {
                role: "worker",
                model: Some("sonnet-5".to_string()),
            },
            CrewRoleModel {
                role: "auditor",
                model: None,
            },
        ];
        let mut view = input(&thread, &[], 45);
        view.crew = Some(&crew);
        let text = render(&view, 60, 60);
        assert!(has(&text, "Worker  sonnet-5"));
        assert!(has(&text, "Expert  sonnet-5"));
        assert!(has(&text, "In progress"));
        assert!(has(&text, "Build the parser"));
        assert!(has(&text, "Now: Writing tests"));
        assert!(has(&text, "Worker · Build the parser"));
        assert!(has(&text, "Crew This turn · Tasks 2 · 2 running"));
        assert!(has(&text, "● 2 working"));
        // The crew's roles come first, one per line, with a word where the model is missing.
        assert!(has(&text, "worker   sonnet-5"));
        assert!(has(&text, "auditor  no model"));
        let heading = |name: &str| text.iter().position(|l| l == name).expect(name);
        assert!(heading(" Crew") < heading(" Agents"));
    }

    #[test]
    fn a_failed_task_is_counted_and_explained() {
        let thread = scenes::failed();
        let view = input(&thread, &[], 45);
        let lines = lines(&view, 60, 60, &LAVENDER, &UNICODE);
        let text = plain(&lines);
        assert!(has(&text, "Error: cargo build failed"));
        assert!(has(&text, "1 failed"));
        assert!(has(&text, "1.2k tokens"));
        assert!(has(&text, "● 1 working · 1 failed"));
        let mark = lines
            .iter()
            .flat_map(|l| l.spans.iter())
            .find(|s| s.content.contains('✗'))
            .expect("failed mark");
        assert_eq!(mark.style.fg, Some(LAVENDER.error));
    }

    #[test]
    fn a_finished_workflow_folds_into_one_line() {
        let thread = scenes::workflow(true);
        let text = render(&input(&thread, &[], 60), 60, 60);
        assert!(has(&text, "Release check  4 agents · 4.8k tokens · 38s"));
        assert!(!has(&text, "Step "));
        assert!(has(&text, "4 done · 4.8k tokens total"));
        assert!(!has(&text, "working"));
    }

    #[test]
    fn a_running_workflow_draws_its_phase_rail_and_live_members() {
        let thread = scenes::workflow(false);
        let text = render(&input(&thread, &[], 45), 60, 80);
        assert!(has(&text, "Release check  2/4 done"));
        assert!(has(&text, "✓ Collect ✓✓ › Verify ◐◐"));
        assert!(has(&text, "Step Collect  2 done ✓✓"));
        assert!(has(&text, "Step Verify  2 running · 0 done"));
        assert!(has(&text, "Agent 2 [Reviewer]"));
        assert!(has(&text, "● 2 working · 2 done"));
    }

    #[test]
    fn those_waiting_for_the_user_come_right_after_the_lead() {
        let thread = scenes::parallel();
        let shells = [scenes::shell(
            "th-w1",
            "Crew Worker · Build the parser",
            true,
        )];
        let mut view = input(&thread, &shells, 45);
        let text = render(&view, 60, 60);
        assert!(at(&text, "Worker") < at(&text, "Expert"));
        assert!(has(&text, "waiting for approval"));
        view.lead_waiting = Some(Waiting::Input);
        let text = render(&view, 60, 60);
        assert!(at(&text, "Lead") < at(&text, "Worker"));
        assert!(has(&text, "waiting for answer"));
        let lead = at(&text, "Lead");
        assert!(text[lead].ends_with("waiting for answer"));
    }

    #[test]
    fn settled_agents_beyond_the_sixth_are_folded() {
        let mut activities = Vec::new();
        for n in 0..8 {
            let id = format!("s{n}");
            let payload = json!({"taskId": id, "agentKind": "agent", "title": format!("Job {n}")});
            activities.push(act("task.started", 2 + n, payload.clone()));
            let mut done = payload;
            done["status"] = json!("completed");
            activities.push(act("task.completed", 12 + n, done));
        }
        let thread = scenes::thread(activities, false);
        let view = input(&thread, &[], 60);
        let text = render(&view, 60, 80);
        assert!(has(&text, "2 earlier hidden"));
        assert!(has(&text, "8 done"));
        assert!(!is_live(&view));
    }

    #[test]
    fn empty_and_loading_threads_say_so() {
        let empty = Thread::default();
        let text = render(&input(&empty, &[], 0), 60, 20);
        assert!(has(&text, "No agents yet"));
        assert!(has(&text, "Once this thread runs"));
        let mut waiting = input(&empty, &[], 0);
        waiting.loading = true;
        let text = render(&waiting, 60, 20);
        assert!(has(&text, "Loading agents…"));
        assert!(!has(&text, "No agents yet"));
        assert!(!is_live(&waiting));
    }

    #[test]
    fn the_clock_runs_only_while_something_works() {
        let running = scenes::parallel();
        assert!(is_live(&input(&running, &[], 45)));
        let done = scenes::workflow(true);
        assert!(!is_live(&input(&done, &[], 60)));
        assert!(has(&render(&input(&running, &[], 45), 60, 60), "39s"));
        assert!(has(&render(&input(&running, &[], 105), 60, 60), "1m 39s"));
    }

    #[test]
    fn nothing_is_wider_than_the_pane_in_either_symbol_set() {
        let threads = [
            scenes::lead_only(),
            scenes::parallel(),
            scenes::failed(),
            scenes::workflow(true),
            scenes::workflow(false),
            scenes::korean(),
            Thread::default(),
        ];
        let shells = [scenes::shell("th-w1", "Crew Worker · 구문 분석기", true)];
        let crew = [CrewRoleModel {
            role: "worker",
            model: Some("모델".to_string()),
        }];
        for thread in &threads {
            for (width, height) in [(12, 6), (20, 10), (33, 25), (60, 20), (100, 60)] {
                for sym in [&UNICODE, &ASCII] {
                    let mut view = input(thread, &shells, 45);
                    view.crew = Some(&crew);
                    view.lead_waiting = Some(Waiting::Approval);
                    let lines = lines(&view, width, height, &LAVENDER, sym);
                    assert!(lines.len() <= height);
                    for line in &lines {
                        let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                        assert!(
                            crate::text::width(&text) <= width,
                            "{width}x{height}: {text:?}"
                        );
                        if sym.rule == "-" {
                            let marks = "─━│┆╭╮╰╯▼›┌└◆○◌◐◒◓◑‖✓✗■●·…↑↓";
                            assert!(!text.chars().any(|c| marks.contains(c)), "{text:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn snapshot_60x20() {
        let thread = scenes::parallel();
        let shells = [scenes::shell(
            "th-w1",
            "Crew Worker · Build the parser",
            true,
        )];
        let text = render(&input(&thread, &shells, 45), 60, 20);
        let expected = [
            " Workflow │ Agents",
            " ───────────━━━━━━─────────────────────────────────────────",
            "",
            "↑ 3 lines above",
            " ┌ ◌ Worker  sonnet-5                 waiting for approval",
            " │ Build the parser",
            " │ 39s",
            " └ Now: Writing tests",
            " ┌ ◐ Expert  sonnet-5                          In progress",
            " │ Review the grammar",
            " └ 39s",
            " ",
            " Flow · this turn",
            " ┌ ✓ 2 files read",
            " └ Done",
            " │",
            "↓ 4 lines below",
            " ──────────────────────────────────────────────────────────",
            " Crew This turn · Tasks 2 · 2 running",
            " ● 2 working",
        ];
        assert_eq!(text, expected);
    }
}
