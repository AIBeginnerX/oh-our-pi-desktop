/**
 * A thread's work as graphs for the workflow board: each provider workflow with its phases as
 * columns, and each turn's tool calls with overlapping calls sharing a column. `actorFlows` draws
 * the same work as the agents doing it (the main agent, its crew, the subagents it launched).
 * Built from the activities and subagent roster a client already holds for the thread; nothing
 * new is fetched.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  crewEvidence,
  crewTurnUsage,
  type CrewEvidenceTask,
  type CrewTaskUsage,
} from "./crewBoard.ts";
import type {
  AgentPanelModel,
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "./state/subagentRuntime.ts";
import {
  connectColumns,
  isSettledState,
  type ToolCategory,
  type ToolCount,
  type WorkflowActorRole,
  type WorkflowDoing,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeInfo,
  type WorkflowNodeState,
} from "./workflowGraph.ts";

const MAX_TURN_STEPS = 60;
const TEXT_LIMIT = 240;
const TARGET_LIMIT = 40;

/** Id prefix of the node that stands for the agent thinking between steps of a running turn. */
export const THINKING_NODE_PREFIX = "thinking:";

/** Id prefix of the node that stands for the thread's own agent in an agent flow. */
export const MAIN_NODE_PREFIX = "main:";

/** Verbs for tool kinds that carry no tool name (ACP `kind`, canonical `itemType`). */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  execute: "Run",
  command_execution: "Run",
  read: "Read",
  edit: "Edit",
  file_change: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  web_search: "Search",
  fetch: "Fetch",
  think: "Think",
  mcp_tool_call: "MCP",
  collab_agent_tool_call: "Agent",
};
const GENERIC_TOOL_TITLES = new Set(["tool", "tool call", "ran command"]);

/** Tool categories by ACP `kind` and canonical `itemType`; null steps are not tool work. */
const CATEGORY_BY_KIND: Readonly<Record<string, ToolCategory | null>> = {
  execute: "run",
  command_execution: "run",
  read: "read",
  edit: "edit",
  file_change: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  web_search: "web",
  fetch: "web",
  think: null,
  mcp_tool_call: "other",
  collab_agent_tool_call: null,
};
/** Tool categories by lower-cased tool name, including the verbs of `TOOL_VERBS`. */
const CATEGORY_BY_TOOL: Readonly<Record<string, ToolCategory | null>> = {
  read: "read",
  notebookread: "read",
  view: "read",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  delete: "edit",
  move: "edit",
  bash: "run",
  bashoutput: "run",
  killshell: "run",
  shell: "run",
  exec_command: "run",
  run: "run",
  grep: "search",
  glob: "search",
  ls: "search",
  search: "search",
  toolsearch: "search",
  websearch: "web",
  webfetch: "web",
  fetch: "web",
  mcp: "other",
  task: null,
  agent: null,
  think: null,
  todowrite: null,
  exitplanmode: null,
  enterplanmode: null,
  askuserquestion: null,
};
const TOOL_CATEGORY_ORDER: ReadonlyArray<ToolCategory> = [
  "read",
  "run",
  "edit",
  "search",
  "web",
  "other",
];

/**
 * What a tool call counts as. Null for calls that are not tool work a person would count: the
 * ones that launch agents (those become agents on their own), crew plumbing, and planning.
 */
export function toolCategory(
  name: string,
  kind?: unknown,
  itemType?: unknown,
): ToolCategory | null {
  const tool = name.toLowerCase().replace(/^mcp__.*__/, "");
  if (tool.startsWith("crew_")) return null;
  if (Object.hasOwn(CATEGORY_BY_TOOL, tool)) return CATEGORY_BY_TOOL[tool] ?? null;
  for (const key of [kind, itemType]) {
    if (typeof key === "string" && Object.hasOwn(CATEGORY_BY_KIND, key)) {
      return CATEGORY_BY_KIND[key] ?? null;
    }
  }
  return "other";
}

/** Tool calls per category, in a fixed order, leaving out categories nothing used. */
export function toolCounts(categories: Iterable<ToolCategory | null | undefined>): ToolCount[] {
  const counts = new Map<ToolCategory, number>();
  for (const category of categories) {
    if (category !== null && category !== undefined) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return TOOL_CATEGORY_ORDER.flatMap((category) => {
    const count = counts.get(category);
    return count === undefined ? [] : [{ category, count }];
  });
}

function optional<K extends string, V>(key: K, value: V | undefined | null): Partial<Record<K, V>> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, V>);
}

function text(value: unknown, limit = TEXT_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, limit);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function subagentNodeState(status: RuntimeSubagentStatus): WorkflowNodeState {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "blocked";
    case "idle":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
  }
}

function graphStatus(
  nodes: ReadonlyArray<WorkflowNode>,
  own?: WorkflowNodeState,
): WorkflowNodeState {
  if (own !== undefined && own !== "pending") return own;
  if (nodes.some((node) => node.state === "running")) return "running";
  if (nodes.some((node) => node.state === "blocked")) return "blocked";
  if (nodes.length > 0 && nodes.every((node) => isSettledState(node.state))) {
    if (nodes.some((node) => node.state === "failed")) return "failed";
    if (nodes.some((node) => node.state === "cancelled")) return "cancelled";
    return "completed";
  }
  return own ?? "pending";
}

function agentInfo(agent: RuntimeSubagent): WorkflowNodeInfo {
  return {
    actor: { role: "subagent", ...optional("task", text(agent.title)) },
    ...optional("subtitle", [agent.role, agent.model].filter(Boolean).join(" · ") || undefined),
    ...optional("model", agent.model),
    ...optional("progress", text(agent.progress)),
    ...optional(
      "description",
      text(agent.lastToolName ? `Last tool: ${agent.lastToolName}` : null),
    ),
    ...optional("startedAt", agent.startedAt),
    ...optional("completedAt", agent.completedAt),
    ...optional("tokens", agent.usage?.totalTokens),
    ...optional("toolUses", agent.usage?.toolUses),
    ...optional("error", text(agent.error)),
  };
}

/** One graph per provider workflow: its phases are the columns, its agents the cards. */
export function workflowGraphs(model: AgentPanelModel): WorkflowGraph[] {
  return model.workflows.map(({ workflow, phases, unphasedMembers }) => {
    const columns = phases.filter((phase) => phase.members.length > 0);
    const waveTitles = columns.map((phase) => phase.title);
    if (unphasedMembers.length > 0) {
      columns.push({
        index: Number.MAX_SAFE_INTEGER,
        title: "Other",
        members: unphasedMembers,
        state: "pending",
        activeCount: 0,
        settledCount: 0,
      });
      waveTitles.push("Other");
    }
    const nodes: WorkflowNode[] = columns.flatMap((phase, wave) =>
      phase.members.map((agent) => ({
        id: agent.id,
        label: agent.title,
        state: subagentNodeState(agent.status),
        wave,
        info: agentInfo(agent),
      })),
    );
    const edges: WorkflowEdge[] = [];
    for (let index = 1; index < columns.length; index += 1) {
      edges.push(
        ...connectColumns(
          (columns[index - 1]?.members ?? []).map((agent) => agent.id),
          (columns[index]?.members ?? []).map((agent) => agent.id),
        ),
      );
    }
    return {
      id: `workflow:${workflow.id}`,
      kind: "workflow",
      name: workflow.workflowName ?? workflow.title,
      status: graphStatus(nodes, subagentNodeState(workflow.status)),
      startedAt: workflow.startedAt ?? workflow.firstSeenAt,
      updatedAt: workflow.updatedAt,
      waveTitles,
      nodes,
      edges,
    };
  });
}

/** A crew task as the lead's task activities describe it. */
type CrewStep = ToolStep & {
  role: string;
  title?: string;
  threadId?: string;
  /** The task.completed status; absent while the task runs. */
  outcome?: string | undefined;
  tested?: boolean;
  verdict?: string | undefined;
  usage?: CrewTaskUsage | undefined;
};

interface ToolStep {
  readonly id: string;
  readonly turnId: string;
  /** What the step does ("Run", "Read", a tool name) and what it works on. */
  name: string;
  target?: string;
  category: ToolCategory | null;
  /** Set once the step is known to have launched a subagent or a workflow. */
  launch?: "agent" | "workflow";
  launchTitle?: string;
  /** Set once a launched agent or workflow names the step. */
  fixedLabel?: boolean;
  label: string;
  state: WorkflowNodeState;
  description?: string;
  startedAt: string;
  completedAt?: string;
  subtitle?: string;
  model?: string;
  progress?: string;
  tokens?: number;
  error?: string;
}

function toolName(
  payload: Readonly<Record<string, unknown>>,
  data: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const named = text(data?.toolName, 80);
  if (named !== undefined) return named;
  for (const key of [data?.kind, payload.itemType]) {
    if (typeof key === "string" && Object.hasOwn(TOOL_VERBS, key)) return TOOL_VERBS[key];
  }
  const title = text(payload.title, 80);
  return title !== undefined && !GENERIC_TOOL_TITLES.has(title.toLowerCase()) ? title : undefined;
}

/**
 * A short "what" for a step: the command or file it works on. Reads the projected activity
 * payload, which keeps `data.command` and `data.files` but not the raw tool input.
 */
function toolTarget(
  data: Readonly<Record<string, unknown>> | undefined,
  detail: string | undefined,
  name: string,
): string | undefined {
  const files = Array.isArray(data?.files) ? data.files : [];
  const known = text(data?.command) ?? text(record(files[0])?.path);
  // A detail that carries raw tool input ("Read: {...}") says nothing readable.
  const fallback = detail !== undefined && !detail.includes("{") ? detail : undefined;
  const raw = known ?? fallback;
  if (raw === undefined) return undefined;
  // An ACP title such as "Read notes.md" repeats the step's own verb; a command never does.
  const unprefixed =
    known === undefined && raw.toLowerCase().startsWith(`${name.toLowerCase()} `)
      ? raw.slice(name.length + 1)
      : raw;
  const flat = unprefixed.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  const short =
    !flat.includes(" ") && flat.includes("/") ? (flat.split("/").findLast(Boolean) ?? flat) : flat;
  return short.length > TARGET_LIMIT ? `${short.slice(0, TARGET_LIMIT - 1)}…` : short;
}

function toolState(status: unknown): WorkflowNodeState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "declined":
      return "failed";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "running";
  }
}

function taskState(kind: string, status: unknown): WorkflowNodeState | undefined {
  if (kind === "task.completed" || (kind === "task.updated" && status !== undefined)) {
    // A crew report that stopped partway (partial, blocked) did not finish its task.
    return status === "completed"
      ? "completed"
      : status === "failed" || status === "partial" || status === "blocked"
        ? "failed"
        : "cancelled";
  }
  return kind === "task.started" || kind === "task.progress" ? "running" : undefined;
}

/**
 * Columns for one turn: a step that starts while every step in the current column is still
 * open runs in parallel with them; otherwise it starts the next column.
 */
function turnColumns(
  steps: ReadonlyArray<{
    readonly id: string;
    readonly startedAt: string;
    readonly completedAt?: string | undefined;
  }>,
): string[][] {
  const columns: string[][] = [];
  let columnEnd = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    const start = Date.parse(step.startedAt);
    const end =
      step.completedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(step.completedAt);
    const current = columns.at(-1);
    if (current !== undefined && start < columnEnd) {
      current.push(step.id);
      columnEnd = Math.min(columnEnd, end);
    } else {
      columns.push([step.id]);
      columnEnd = end;
    }
  }
  return columns;
}

/**
 * The steps a turn graph draws: every step that has not settled, then the newest settled ones up
 * to the cap. A long-running call that started early must stay visible however busy the turn got.
 */
function visibleSteps(sorted: ReadonlyArray<ToolStep>): ToolStep[] {
  if (sorted.length <= MAX_TURN_STEPS) return [...sorted];
  const keep = new Set(sorted.filter((step) => !isSettledState(step.state)).slice(-MAX_TURN_STEPS));
  for (let index = sorted.length - 1; index >= 0 && keep.size < MAX_TURN_STEPS; index -= 1) {
    keep.add(sorted[index]!);
  }
  return sorted.filter((step) => keep.has(step));
}

interface TurnSteps {
  readonly turnId: string;
  /** Every tool call the turn made, oldest first. */
  readonly steps: ToolStep[];
}

/** The tool calls of every turn, oldest turn first, folded from the thread's activities. */
function collectToolSteps(activities: ReadonlyArray<OrchestrationThreadActivity>): TurnSteps[] {
  const steps = new Map<string, ToolStep>();
  const stepByToolUse = new Map<string, ToolStep>();
  const taskOwner = new Map<string, ToolStep>();

  for (const activity of activities) {
    const payload = record(activity.payload);
    if (payload === undefined) continue;
    if (activity.kind.startsWith("tool.") && activity.turnId !== null) {
      const id = text(payload.toolCallId, 200);
      if (id === undefined) continue;
      const data = record(payload.data);
      const name = toolName(payload, data);
      const existing = steps.get(id);
      const step: ToolStep = existing ?? {
        id,
        turnId: activity.turnId,
        name: name ?? text(payload.title, 80) ?? "Tool",
        category: null,
        label: "",
        state: "running",
        startedAt: activity.createdAt,
      };
      if (existing === undefined) {
        steps.set(id, step);
        stepByToolUse.set(id, step);
      }
      if (name !== undefined) step.name = name;
      // A later update that names nothing must not erase what an earlier one made clear.
      const category = toolCategory(step.name, data?.kind, payload.itemType);
      if (existing === undefined || category !== "other") step.category = category;
      step.state = toolState(payload.status);
      const detail = text(payload.detail);
      if (detail !== undefined) step.description = detail;
      const target = toolTarget(data, detail, step.name);
      if (target !== undefined) step.target = target;
      if (!step.fixedLabel) {
        step.label = step.target === undefined ? step.name : `${step.name} · ${step.target}`;
      }
      if (activity.kind === "tool.completed" || step.state !== "running") {
        step.completedAt = activity.createdAt;
      }
      continue;
    }
    if (!activity.kind.startsWith("task.")) continue;
    const taskId = text(payload.taskId, 200);
    const toolUseId = text(payload.toolUseId, 200);
    const step =
      (taskId === undefined ? undefined : taskOwner.get(taskId)) ??
      (toolUseId === undefined ? undefined : stepByToolUse.get(toolUseId));
    if (step === undefined) continue;
    if (taskId !== undefined) taskOwner.set(taskId, step);
    const title = text(payload.title, 80);
    const workflowName = text(payload.workflowName, 80);
    // A crew task is drawn as a crew member; only other launches become agents of their own.
    const crewMember = text(payload.crewRole, 20) !== undefined;
    if (payload.taskType === "local_workflow") {
      step.label = `Workflow · ${workflowName ?? title ?? step.name}`;
      step.fixedLabel = true;
      step.category = null;
      if (!crewMember) {
        step.launch = "workflow";
        const launchTitle = workflowName ?? title;
        if (launchTitle !== undefined) step.launchTitle = launchTitle;
      }
    } else if (title !== undefined && payload.agentKind === "agent") {
      step.label = `Agent · ${title}`;
      step.fixedLabel = true;
      step.category = null;
      if (!crewMember) {
        step.launch = "agent";
        step.launchTitle = title;
      }
    }
    const model = text(payload.model, 80);
    if (model !== undefined) {
      step.model = model;
      step.subtitle = [text(payload.effort, 20), model].filter(Boolean).join(" · ");
    }
    const progress = text(payload.summary) ?? text(payload.lastToolName, 80);
    if (progress !== undefined) step.progress = progress;
    const usage = record(payload.usage);
    const tokens = usage?.totalTokens ?? usage?.total_tokens;
    if (typeof tokens === "number") step.tokens = tokens;
    const state = taskState(activity.kind, payload.status);
    if (state !== undefined) {
      step.state = state;
      if (state !== "running") step.completedAt = activity.createdAt;
      else delete step.completedAt;
    }
    const error = state === "failed" ? (text(payload.summary) ?? text(payload.detail)) : undefined;
    if (error !== undefined) step.error = error;
  }

  const byTurn = new Map<string, ToolStep[]>();
  for (const step of steps.values())
    byTurn.set(step.turnId, [...(byTurn.get(step.turnId) ?? []), step]);
  return [...byTurn.entries()]
    .map(([turnId, turnSteps]) => ({
      turnId,
      steps: turnSteps.sort(
        (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
      ),
    }))
    .sort((a, b) => (a.steps[0]?.startedAt ?? "").localeCompare(b.steps[0]?.startedAt ?? ""));
}

function stepInfo(step: ToolStep): WorkflowNodeInfo {
  return {
    ...optional("subtitle", step.subtitle),
    ...optional("model", step.model),
    ...optional("description", step.description),
    ...optional("progress", step.progress),
    startedAt: step.startedAt,
    ...optional("completedAt", step.completedAt),
    ...optional("tokens", step.tokens),
    ...optional("error", step.error),
  };
}

function turnGraphOf({ turnId, steps: allSteps }: TurnSteps, index: number): WorkflowGraph {
  const total = allSteps.length;
  const turnSteps = visibleSteps(allSteps);
  const columns = turnColumns(turnSteps);
  const waveById = new Map(columns.flatMap((column, wave) => column.map((id) => [id, wave])));
  const nodes: WorkflowNode[] = turnSteps.map((step) => ({
    id: step.id,
    label: step.label,
    state: step.state,
    wave: waveById.get(step.id) ?? 0,
    info: {
      ...stepInfo(step),
      ...(step.category === null ? {} : { toolCategory: step.category }),
    },
  }));
  const edges: WorkflowEdge[] = [];
  for (let wave = 1; wave < columns.length; wave += 1) {
    edges.push(...connectColumns(columns[wave - 1] ?? [], columns[wave] ?? []));
  }
  const last = turnSteps.at(-1);
  return {
    id: `turn:${turnId}`,
    kind: "turn",
    turnId,
    name: `Turn ${index + 1} · ${total} step${total === 1 ? "" : "s"}${
      total > turnSteps.length ? ` · ${total - turnSteps.length} older hidden` : ""
    }`,
    turnIndex: index + 1,
    stepCount: total,
    tools: toolCounts(allSteps.map((step) => step.category)),
    status: graphStatus(nodes),
    startedAt: turnSteps[0]?.startedAt ?? "",
    updatedAt: last?.completedAt ?? last?.startedAt ?? "",
    waveTitles: columns.map((_, wave) => `Step ${wave + 1}`),
    nodes,
    edges,
  };
}

/** One graph per turn that called tools, oldest turn first. */
export function turnGraphs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkflowGraph[] {
  return collectToolSteps(activities).map(turnGraphOf);
}

/** A crew report that stopped partway (partial, blocked) did not finish its task. */
function crewTaskState(status: unknown): WorkflowNodeState {
  return status === "partial" || status === "blocked" ? "failed" : toolState(status);
}

/** The usage a crew task's completion carries: tokens always, a cost only when it was reported. */
function crewUsage(value: unknown): CrewTaskUsage | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  const { inputTokens, outputTokens, costUsd } = usage;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return {
    tokens: inputTokens + outputTokens,
    ...(typeof costUsd === "number" ? { costUsd } : {}),
  };
}

const CREW_LABEL: Record<string, string> = {
  worker: "Worker",
  expert: "Expert",
  auditor: "Auditor",
};

function crewActorRole(role: string): WorkflowActorRole {
  return role === "worker" || role === "expert" || role === "auditor" ? role : "crew";
}

/** The crew tasks of every lead turn, folded from the lead's task activities. */
function collectCrewTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<[string, CrewStep[]]> {
  const tasks = new Map<string, CrewStep>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = record(activity.payload);
    const role = text(payload?.crewRole, 20);
    const taskId = text(payload?.taskId, 200);
    if (payload === undefined || role === undefined || taskId === undefined) continue;
    const existing = tasks.get(taskId);
    const title = text(payload.title, 80);
    const task = existing ?? {
      id: taskId,
      turnId: activity.turnId ?? "untracked",
      role,
      category: null,
      name: CREW_LABEL[role] ?? role,
      label: `${CREW_LABEL[role] ?? role} · ${title ?? "task"}`,
      ...optional("title", title),
      state: "running" as WorkflowNodeState,
      startedAt: activity.createdAt,
    };
    if (existing === undefined) tasks.set(taskId, task);
    const model = text(payload.model, 80);
    if (model !== undefined) {
      task.model = model;
      task.subtitle = model;
    }
    const summary = text(payload.summary);
    if (summary !== undefined) task.progress = summary;
    // Each attempt of a task runs in its own thread; the latest one is the one to open or stop.
    const threadId = text(payload.threadId, 200);
    if (threadId !== undefined) task.threadId = threadId;
    if (activity.kind === "task.completed") {
      task.state = crewTaskState(payload.status);
      task.completedAt = activity.createdAt;
      task.outcome = text(payload.status, 20);
      task.tested = payload.tested === true;
      task.verdict = text(payload.verdict, 20);
      task.usage = crewUsage(payload.usage);
    }
  }

  const byTurn = new Map<string, CrewStep[]>();
  for (const task of tasks.values())
    byTurn.set(task.turnId, [...(byTurn.get(task.turnId) ?? []), task]);
  return [...byTurn.entries()];
}

/** One lead turn's crew: who was delegated to, who audited, what it cost, and how to draw each. */
function crewTurn(turnTasks: ReadonlyArray<CrewStep>) {
  const sorted = [...turnTasks].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const evidence = crewEvidence(
    sorted.map((task): CrewEvidenceTask => ({
      id: task.id,
      role: task.role,
      outcome: task.outcome,
      tested: task.tested,
      completedAt: task.completedAt,
      verdict: task.verdict,
    })),
  );
  const toNode = (task: CrewStep, wave: number): WorkflowNode => ({
    id: task.id,
    label: task.label,
    state: task.state,
    wave,
    info: {
      actor: { role: crewActorRole(task.role), ...optional("task", task.title) },
      ...optional("subtitle", task.subtitle),
      ...optional("model", task.model),
      ...optional("progress", task.progress),
      startedAt: task.startedAt,
      ...optional("completedAt", task.completedAt),
      ...optional("tokens", task.usage?.tokens),
      ...optional("costUsd", task.usage?.costUsd),
      ...optional("evidence", evidence.get(task.id)),
      crew: {
        taskId: task.id,
        role: task.role,
        ...optional("threadId", task.threadId),
        ...optional("outcome", task.outcome),
      },
    },
  });
  return {
    sorted,
    delegated: sorted.filter((task) => task.role !== "auditor"),
    audits: sorted.filter((task) => task.role === "auditor"),
    usage: crewTurnUsage(sorted.map((task) => task.usage)),
    toNode,
  };
}

/**
 * One graph per lead turn that used OOP Crew: the brain fans work out to workers and experts
 * (overlapping tasks share a column) and the auditor reviews last.
 */
export function crewGraphs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkflowGraph[] {
  return collectCrewTasks(activities).map(([turnId, turnTasks]) => {
    const { sorted, delegated, audits, usage, toNode } = crewTurn(turnTasks);
    const columns = turnColumns(delegated);
    const brainId = `brain:${turnId}`;
    const working = delegated.some((task) => task.state === "running");
    const brain: WorkflowNode = {
      id: brainId,
      label: "Brain · lead",
      state: working || delegated.length === 0 ? "running" : "completed",
      wave: 0,
      info: {
        subtitle: "Plans and hands out the work",
        startedAt: sorted[0]?.startedAt ?? "",
        ...optional("tokens", usage?.tokens),
        ...optional("costUsd", usage?.costUsd),
        ...(usage?.unpriced === true ? { unpriced: true } : {}),
      },
    };
    const nodes: WorkflowNode[] = [
      brain,
      ...columns.flatMap((column, index) =>
        column.flatMap((id) => {
          const task = delegated.find((candidate) => candidate.id === id);
          return task === undefined ? [] : [toNode(task, index + 1)];
        }),
      ),
      ...audits.map((task) => toNode(task, columns.length + 1)),
    ];
    const chain = [[brainId], ...columns, audits.map((task) => task.id)].filter(
      (column) => column.length > 0,
    );
    const edges: WorkflowEdge[] = [];
    for (let index = 1; index < chain.length; index += 1) {
      edges.push(...connectColumns(chain[index - 1] ?? [], chain[index] ?? []));
    }
    const last = sorted.at(-1);
    return {
      id: `crew:${turnId}`,
      kind: "crew",
      turnId,
      name: `Crew · ${sorted.length} task${sorted.length === 1 ? "" : "s"}`,
      status: graphStatus(nodes.slice(1)),
      startedAt: sorted[0]?.startedAt ?? "",
      updatedAt: last?.completedAt ?? last?.startedAt ?? "",
      waveTitles: [
        "Brain",
        ...columns.map((column) =>
          column.length > 1 ? `Crew · ${column.length} parallel` : "Crew",
        ),
        ...(audits.length > 0 ? ["Audit"] : []),
      ],
      nodes,
      edges,
    };
  });
}

/**
 * A running turn whose agent is between steps: a "Thinking" node after the last column, so the
 * board keeps flowing while the model works out its next call. It goes as soon as a step runs
 * and never appears once the turn ends.
 */
function withThinkingFrontier(graph: WorkflowGraph): WorkflowGraph {
  if (graph.turnId === undefined || graph.nodes.some((node) => node.state === "running")) {
    return graph;
  }
  const lastWave = graph.nodes.reduce((wave, node) => Math.max(wave, node.wave ?? 0), -1);
  const id = `${THINKING_NODE_PREFIX}${graph.turnId}`;
  const previous = graph.nodes
    .filter((node) => (node.wave ?? 0) === lastWave)
    .map((node) => node.id);
  return {
    ...graph,
    status: "running",
    nodes: [
      ...graph.nodes,
      {
        id,
        label: "Thinking",
        state: "running",
        wave: lastWave + 1,
        info: { ...optional("startedAt", graph.updatedAt || undefined) },
      },
    ],
    edges: [...graph.edges, ...connectColumns(previous, [id])],
    waveTitles: [...graph.waveTitles, "Next"],
  };
}

/**
 * Lines a turn or crew graph up with whether its turn is still running. The brain works exactly
 * while its turn runs. Once a turn ends nothing in it is still working: a tool step whose
 * completion never arrived and a crew task with no final report both read as stopped, never as
 * done, until a report arrives. A running turn with no step running gets a thinking frontier.
 */
export function settleWithTurn(graph: WorkflowGraph, activeTurnId: string | null): WorkflowGraph {
  const settled = settleNodesWithTurn(graph, activeTurnId);
  return settled.kind === "turn" && settled.turnId !== undefined && settled.turnId === activeTurnId
    ? withThinkingFrontier(settled)
    : settled;
}

function settleNodesWithTurn(graph: WorkflowGraph, activeTurnId: string | null): WorkflowGraph {
  if (graph.turnId === undefined) return graph;
  const live = graph.turnId === activeTurnId;
  let changed = false;
  const nodes = graph.nodes.map((node): WorkflowNode => {
    const isBrain = graph.kind === "crew" && node.id.startsWith("brain:");
    const state: WorkflowNodeState = isBrain
      ? live
        ? "running"
        : "completed"
      : !live && node.state === "running"
        ? "cancelled"
        : node.state;
    const unconfirmed = graph.kind === "turn" && state !== node.state;
    if (state === node.state && (state === "running" || node.info.completedAt !== undefined)) {
      return node;
    }
    changed = true;
    const { completedAt: _completedAt, ...info } = node.info;
    return {
      ...node,
      state,
      info:
        state === "running"
          ? info
          : {
              ...info,
              ...(unconfirmed && info.progress === undefined
                ? { progress: "Turn ended before this step reported completion" }
                : {}),
              completedAt: node.info.completedAt ?? graph.updatedAt,
            },
    };
  });
  if (!changed) return graph;
  return {
    ...graph,
    nodes,
    status: graphStatus(
      graph.kind === "crew" ? nodes.filter((node) => !node.id.startsWith("brain:")) : nodes,
    ),
  };
}

/**
 * Every flow in a thread, newest first. Pass `activeTurnId` (null when no turn runs) so finished
 * turns never look busy; leave it out to read the activities alone.
 */
export function threadFlows(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agents: AgentPanelModel;
  readonly activeTurnId?: string | null;
  /** When the running turn started; lets a turn that has called no tool yet show its agent. */
  readonly activeTurnStartedAt?: string | null;
}): WorkflowGraph[] {
  const flows = [
    ...crewGraphs(input.activities),
    ...workflowGraphs(input.agents),
    ...turnGraphs(input.activities),
  ];
  const activeTurnId = input.activeTurnId;
  const startedAt = input.activeTurnStartedAt;
  if (
    typeof activeTurnId === "string" &&
    typeof startedAt === "string" &&
    !flows.some((flow) => flow.kind === "turn" && flow.turnId === activeTurnId)
  ) {
    flows.push({
      id: `turn:${activeTurnId}`,
      kind: "turn",
      turnId: activeTurnId,
      name: "Current turn",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      waveTitles: [],
      nodes: [],
      edges: [],
    });
  }
  return (
    activeTurnId === undefined ? flows : flows.map((flow) => settleWithTurn(flow, activeTurnId))
  ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function latest(times: ReadonlyArray<string | undefined>): string {
  return times.reduce<string>(
    (newest, time) => (time !== undefined && time > newest ? time : newest),
    "",
  );
}

interface TurnInput {
  readonly turnId: string;
  readonly steps: ReadonlyArray<ToolStep>;
  readonly tasks: ReadonlyArray<CrewStep>;
  /** Whether the lead's turn still runs; nothing in a finished turn is still working. */
  readonly live: boolean;
  readonly leadModel: string | null;
  /** When a running turn began, which may be before its first tool call. */
  readonly startedAt: string | undefined;
  /** The turn's tool calls as a step graph, kept behind the agent view for a closer look. */
  readonly stepGraph: WorkflowGraph | undefined;
}

/** A subagent or workflow a tool call launched, as a node of its own. */
function launchNode(step: ToolStep): WorkflowNode {
  return {
    id: step.id,
    label: step.label,
    state: step.state,
    wave: 0,
    info: {
      actor: {
        role: step.launch === "workflow" ? "workflow" : "subagent",
        ...optional("task", step.launchTitle),
      },
      ...stepInfo(step),
    },
  };
}

/** A turn drawn as agents: the main agent, then the crew and subagents it handed work to. */
function agentFlowOfTurn(input: TurnInput): WorkflowGraph {
  const { turnId, steps, live } = input;
  const crew = crewTurn(input.tasks);
  const updatedAt =
    latest([
      ...steps.flatMap((step) => [step.startedAt, step.completedAt]),
      ...crew.sorted.flatMap((task) => [task.startedAt, task.completedAt]),
    ]) ||
    input.startedAt ||
    "";
  const startedAt =
    [steps[0]?.startedAt, crew.sorted[0]?.startedAt, input.startedAt]
      .filter((time): time is string => time !== undefined && time !== "")
      .sort()[0] ?? "";

  // A turn that has ended leaves nothing running: a task with no final report reads as stopped.
  const settle = (node: WorkflowNode): WorkflowNode =>
    live || node.state !== "running"
      ? node
      : {
          ...node,
          state: "cancelled",
          info: { ...node.info, completedAt: node.info.completedAt ?? updatedAt },
        };
  const delegates = [
    ...crew.delegated.map((task) => crew.toNode(task, 0)),
    ...steps.filter((step) => step.launch !== undefined).map(launchNode),
  ]
    .map(settle)
    .sort(
      (a, b) =>
        (a.info.startedAt ?? "").localeCompare(b.info.startedAt ?? "") || a.id.localeCompare(b.id),
    );
  const delegateById = new Map(delegates.map((node) => [node.id, node]));
  const columns = turnColumns(
    delegates.map((node) => ({
      id: node.id,
      startedAt: node.info.startedAt ?? "",
      completedAt: node.info.completedAt,
    })),
  );
  const audits = crew.audits.map((task) => settle(crew.toNode(task, columns.length + 1)));
  const children = [...delegates, ...audits];

  let runningTool: ToolStep | undefined;
  for (const step of steps) {
    if (step.state === "running" && step.category !== null) runningTool = step;
  }
  const doing: WorkflowDoing | undefined = live
    ? (runningTool?.category ??
      (children.some((child) => child.state === "running") ? "waiting" : "thinking"))
    : undefined;
  const mainId = `${MAIN_NODE_PREFIX}${turnId}`;
  const main: WorkflowNode = {
    id: mainId,
    label: "Main agent",
    state: live ? "running" : "completed",
    wave: 0,
    info: {
      actor: {
        role: "main",
        tools: toolCounts(steps.map((step) => step.category)),
        ...optional("doing", doing),
        ...(crew.delegated.length > 0 ? { delegated: crew.delegated.length } : {}),
      },
      ...optional("model", input.leadModel),
      startedAt,
      ...(live ? {} : { completedAt: updatedAt }),
      ...optional("tokens", crew.usage?.tokens),
      ...optional("costUsd", crew.usage?.costUsd),
      ...(crew.usage?.unpriced === true ? { unpriced: true } : {}),
    },
  };
  const nodes: WorkflowNode[] = [
    main,
    ...columns.flatMap((column, index) =>
      column.flatMap((id) => {
        const node = delegateById.get(id);
        return node === undefined ? [] : [{ ...node, wave: index + 1 }];
      }),
    ),
    ...audits,
  ];
  const chain = [[mainId], ...columns, audits.map((node) => node.id)].filter(
    (column) => column.length > 0,
  );
  const edges: WorkflowEdge[] = [];
  for (let index = 1; index < chain.length; index += 1) {
    edges.push(...connectColumns(chain[index - 1] ?? [], chain[index] ?? []));
  }
  return {
    id: `turn:${turnId}`,
    kind: crew.sorted.length > 0 ? "crew" : "turn",
    turnId,
    name: "Turn",
    status: live ? "running" : children.length === 0 ? "completed" : graphStatus(children),
    startedAt,
    updatedAt,
    waveTitles: [
      "Main agent",
      ...columns.map(() => "Delegated work"),
      ...(audits.length > 0 ? ["Review"] : []),
    ],
    nodes,
    edges,
    ...(input.stepGraph === undefined ? {} : { steps: input.stepGraph }),
  };
}

/**
 * Every flow in a thread as the agents doing the work, newest first. One turn is one flow: the
 * main agent, the crew it delegated to, and the subagents and workflows it launched, each a node.
 * The turn's tool calls stay available as `steps`. Provider workflows are flows of their own.
 */
export function actorFlows(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agents: AgentPanelModel;
  /** The running turn, or null when the thread is idle. */
  readonly activeTurnId: string | null;
  /** When the running turn started; lets a turn that has called no tool yet show its agent. */
  readonly activeTurnStartedAt?: string | null;
  /** The main agent's model, as the composer selected it. */
  readonly leadModel?: string | null;
}): WorkflowGraph[] {
  const { activeTurnId } = input;
  const turns = collectToolSteps(input.activities);
  const rawTurns = new Map(turns.map((turn, index) => [turn.turnId, turnGraphOf(turn, index)]));
  const stepsByTurn = new Map(turns.map((turn) => [turn.turnId, turn.steps]));
  const tasksByTurn = new Map(collectCrewTasks(input.activities));
  const turnIds = new Set([...stepsByTurn.keys(), ...tasksByTurn.keys()]);
  if (typeof activeTurnId === "string" && typeof input.activeTurnStartedAt === "string") {
    turnIds.add(activeTurnId);
  }
  const built = [...turnIds]
    .map((turnId) => {
      const raw = rawTurns.get(turnId);
      return agentFlowOfTurn({
        turnId,
        steps: stepsByTurn.get(turnId) ?? [],
        tasks: tasksByTurn.get(turnId) ?? [],
        live: turnId === activeTurnId,
        leadModel: input.leadModel ?? null,
        startedAt: turnId === activeTurnId ? (input.activeTurnStartedAt ?? undefined) : undefined,
        stepGraph: raw === undefined ? undefined : settleWithTurn(raw, activeTurnId),
      });
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((flow, index): WorkflowGraph => ({
      ...flow,
      name: `Turn ${index + 1}`,
      turnIndex: index + 1,
    }));
  return [...built, ...workflowGraphs(input.agents)].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

const LEAD_TRAIL = 6;

export interface LeadFlowStep {
  readonly id: string;
  readonly label: string;
  readonly state: WorkflowNodeState;
  /** What kind of work the step is; absent for steps that launch agents. */
  readonly category?: ToolCategory;
}

/** What the thread's own agent is doing in its latest turn, for the Agents panel's lead row. */
export interface LeadFlowSummary {
  readonly turnId: string;
  /** working: a step runs; thinking: the turn runs between steps; done: the turn ended. */
  readonly state: "working" | "thinking" | "done";
  /** Tool steps the turn has taken so far. */
  readonly steps: number;
  /** Every tool call the turn made so far, by category. */
  readonly tools: ReadonlyArray<ToolCount>;
  readonly current: LeadFlowStep | null;
  /** The last few steps in order, ending with the current one while the turn runs. */
  readonly recent: ReadonlyArray<LeadFlowStep>;
}

/** Reads the newest turn flow from `threadFlows` output; null before the thread has a turn. */
export function leadFlowSummary(flows: ReadonlyArray<WorkflowGraph>): LeadFlowSummary | null {
  const turn = flows
    .filter((flow) => flow.kind === "turn" && flow.turnId !== undefined)
    .reduce<WorkflowGraph | undefined>(
      (newest, flow) => (newest === undefined || flow.startedAt > newest.startedAt ? flow : newest),
      undefined,
    );
  if (turn?.turnId === undefined) return null;
  const ordered = [...turn.nodes].sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0));
  const step = (node: WorkflowNode): LeadFlowStep => ({
    id: node.id,
    label: node.label,
    state: node.state,
    ...optional("category", node.info.toolCategory),
  });
  const thinking = ordered.find((node) => node.id.startsWith(THINKING_NODE_PREFIX));
  const running = ordered.find((node) => node !== thinking && node.state === "running");
  const current = running ?? thinking;
  return {
    turnId: turn.turnId,
    state: running !== undefined ? "working" : thinking !== undefined ? "thinking" : "done",
    steps: ordered.length - (thinking === undefined ? 0 : 1),
    tools: turn.tools ?? [],
    current: current === undefined ? null : step(current),
    recent: ordered.slice(-LEAD_TRAIL).map(step),
  };
}
