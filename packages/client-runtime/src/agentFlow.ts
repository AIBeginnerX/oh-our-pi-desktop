/**
 * The Agents panel's flow: every agent working in a thread (the lead, its crew, provider
 * subagents, and workflows) with a short English summary, and the latest turn's work as boxes in
 * the order it happened. Built from the activities and subagent roster the client already holds.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import type { AgentPanelModel, RuntimeSubagent } from "./state/subagentRuntime.ts";
import { THINKING_NODE_PREFIX, leadFlowSummary, threadFlows } from "./threadFlow.ts";
import type { WorkflowGraph, WorkflowNode } from "./workflowGraph.ts";

export type AgentFlowState = "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

export interface AgentFlowEntry {
  readonly id: string;
  readonly kind: "lead" | "crew" | "subagent" | "workflow";
  /** "Lead", the crew role, or the subagent type. */
  readonly name: string;
  readonly model: string | null;
  /** The provider instance that runs it; clients color the agent by its accent. */
  readonly instanceId: string | null;
  readonly state: AgentFlowState;
  /** The task it was given, as the lead named it. */
  readonly task: string | null;
  /** A one-line English summary of its work, built from what it did. */
  readonly summary: string;
  readonly startedAt: string | null;
  /** When it settled; null while it runs. Clients tick elapsed time from these. */
  readonly completedAt: string | null;
}

export interface AgentFlowBox {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly detail: string | null;
  readonly state: AgentFlowState;
  readonly startedAt: string;
}

export interface AgentFlow {
  readonly agents: ReadonlyArray<AgentFlowEntry>;
  readonly boxes: ReadonlyArray<AgentFlowBox>;
}

export const LEAD_AGENT_ID = "lead";
const MAX_BOXES = 12;
const CREW_NAMES: Readonly<Record<string, string>> = {
  worker: "Worker",
  expert: "Expert",
  auditor: "Auditor",
};

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function agentState(status: RuntimeSubagent["status"]): AgentFlowState {
  switch (status) {
    case "pending":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

const STATE_WORDS: Record<AgentFlowState, string> = {
  working: "working",
  thinking: "thinking",
  waiting: "waiting",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
};

/** Crew role and instance per task id, from the crew's own activities. */
function crewTasks(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const tasks = new Map<string, { role: string; instanceId: string | null }>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = record(activity.payload);
    const taskId = text(payload?.taskId);
    const role = text(payload?.crewRole);
    if (taskId === undefined || role === undefined) continue;
    const instanceId = text(payload?.providerInstanceId) ?? tasks.get(taskId)?.instanceId ?? null;
    tasks.set(taskId, { role, instanceId });
  }
  return tasks;
}

/** "Run 5 · Read 3 · Edit 1": what the lead did most, from its step labels. */
function verbCounts(nodes: ReadonlyArray<WorkflowNode>): string | undefined {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const verb = node.label.split(" · ")[0]?.trim();
    if (verb) counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.length === 0 ? undefined : top.map(([verb, n]) => `${verb} ${n}`).join(" · ");
}

function newestTurn(flows: ReadonlyArray<WorkflowGraph>): WorkflowGraph | undefined {
  return flows
    .filter((flow) => flow.kind === "turn")
    .reduce<WorkflowGraph | undefined>(
      (newest, flow) => (newest === undefined || flow.startedAt > newest.startedAt ? flow : newest),
      undefined,
    );
}

export function agentFlow(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agents: AgentPanelModel;
  readonly activeTurnId: string | null;
  readonly activeTurnStartedAt: string | null;
  readonly lead: { readonly model: string | null; readonly instanceId: string | null };
}): AgentFlow {
  const flows = threadFlows({
    activities: input.activities,
    agents: input.agents,
    activeTurnId: input.activeTurnId,
    activeTurnStartedAt: input.activeTurnStartedAt,
  });
  const lead = leadFlowSummary(flows);
  const turn = newestTurn(flows);
  const steps = (turn?.nodes ?? []).filter((node) => !node.id.startsWith(THINKING_NODE_PREFIX));
  const crew = crewTasks(input.activities);

  const leadState: AgentFlowState = lead === null ? "done" : lead.state;
  const verbs = verbCounts(steps);
  const leadSummary =
    lead === null
      ? "Ready for the next request"
      : lead.state === "thinking"
        ? `Working out the next step · ${lead.steps} steps so far`
        : lead.state === "working"
          ? `${lead.current?.label ?? "Working"} · step ${lead.steps}`
          : `Finished the turn · ${lead.steps} step${lead.steps === 1 ? "" : "s"}${verbs ? ` · ${verbs}` : ""}`;

  const subagents: RuntimeSubagent[] = [
    ...input.agents.workflows.map((group) => group.workflow),
    ...input.agents.directAgents,
  ];
  const others = subagents.map((agent): AgentFlowEntry => {
    const crewTask = crew.get(agent.id);
    const kind = crewTask ? "crew" : agent.kind === "workflow" ? "workflow" : "subagent";
    const name = crewTask
      ? (CREW_NAMES[crewTask.role] ?? crewTask.role)
      : kind === "workflow"
        ? "Workflow"
        : (agent.role ?? "Subagent");
    const state = agentState(agent.status);
    const facts = [
      `${name} ${STATE_WORDS[state]}`,
      state === "working" && agent.lastToolName ? `last tool ${agent.lastToolName}` : undefined,
      agent.usage ? `${Math.round(agent.usage.totalTokens / 1000)}k tokens` : undefined,
    ].filter(Boolean);
    return {
      id: agent.id,
      kind,
      name,
      model: agent.model,
      instanceId: crewTask?.instanceId ?? input.lead.instanceId,
      state,
      task: agent.title || agent.workflowName,
      summary: facts.join(" · "),
      startedAt: agent.startedAt ?? agent.firstSeenAt,
      completedAt: agent.completedAt,
    };
  });
  const order: Record<AgentFlowState, number> = {
    working: 0,
    thinking: 0,
    waiting: 1,
    failed: 2,
    stopped: 3,
    done: 4,
  };
  others.sort(
    (a, b) =>
      order[a.state] - order[b.state] || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );
  const agents: AgentFlowEntry[] = [
    {
      id: LEAD_AGENT_ID,
      kind: "lead",
      name: "Lead",
      model: input.lead.model,
      instanceId: input.lead.instanceId,
      state: leadState,
      task: null,
      summary: leadSummary,
      startedAt: turn?.startedAt ?? null,
      completedAt: null,
    },
    ...others,
  ];

  // The latest turn's work, in order: runs of lead steps broken by each agent it started.
  const turnStart = turn?.startedAt ?? "";
  const launched = others
    .filter((agent) => agent.startedAt !== null && agent.startedAt >= turnStart)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const boxes: AgentFlowBox[] = [];
  let run: WorkflowNode[] = [];
  const flushRun = () => {
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) return;
    const running = run.some((node) => node.state === "running");
    boxes.push({
      id: `lead:${first.id}`,
      agentId: LEAD_AGENT_ID,
      title: last.label,
      detail: run.length === 1 ? null : `${run.length} steps`,
      state: running ? "working" : run.some((node) => node.state === "failed") ? "failed" : "done",
      startedAt: first.info.startedAt ?? turnStart,
    });
    run = [];
  };
  const sortedSteps = [...steps].sort((a, b) =>
    (a.info.startedAt ?? "").localeCompare(b.info.startedAt ?? ""),
  );
  let next = 0;
  for (const step of sortedSteps) {
    const at = step.info.startedAt ?? "";
    while (next < launched.length && (launched[next]?.startedAt ?? "") <= at) {
      flushRun();
      const agent = launched[next];
      if (agent) boxes.push(agentBox(agent));
      next += 1;
    }
    run.push(step);
  }
  flushRun();
  for (; next < launched.length; next += 1) {
    const agent = launched[next];
    if (agent) boxes.push(agentBox(agent));
  }
  if (leadState === "thinking") {
    boxes.push({
      id: `lead:thinking:${turn?.turnId ?? "turn"}`,
      agentId: LEAD_AGENT_ID,
      title: "Working out the next step",
      detail: null,
      state: "thinking",
      startedAt: turn?.updatedAt ?? turnStart,
    });
  }
  return { agents, boxes: boxes.slice(-MAX_BOXES) };
}

function agentBox(agent: AgentFlowEntry): AgentFlowBox {
  return {
    id: `agent:${agent.id}`,
    agentId: agent.id,
    title: agent.task ?? agent.name,
    detail: [agent.name, agent.model].filter(Boolean).join(" · ") || null,
    state: agent.state,
    startedAt: agent.startedAt ?? "",
  };
}
