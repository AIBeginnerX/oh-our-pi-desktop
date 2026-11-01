import type { OrchestrationThread } from "@t3tools/contracts";
import {
  agentFlow,
  type AgentFlowEntry,
  type AgentFlowState,
} from "@t3tools/client-runtime/agent-flow";
import {
  formatSubagentModelLabel,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { subagentNodeState } from "@t3tools/client-runtime/thread-flow";
import type { ToolCount, WorkflowNodeState } from "@t3tools/client-runtime/workflow-graph";

import {
  boardSummary,
  evidenceWord,
  formatCost,
  formatTokenCount,
  phaseWord,
} from "../render/crewBoard.ts";
import { formatElapsed } from "../render/spinner.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { visibleWidth } from "../text/width.ts";
import { t } from "../i18n/index.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";
import type { CrewBoard, CrewTask, CrewTaskPhase, WaitingCrewThread } from "./crewBoard.ts";
import {
  activeTurnOf,
  agentModelOf,
  DOING_WORDS,
  flat,
  packFacts,
  paintFor,
  panelHead,
  STATE_WORDS,
  toolWord,
  windowOf,
} from "./workflowPanel.ts";

// ---- what is read -----------------------------------------------------------------------------

/** Who waits for the user: an approval or an answer. */
type Waiting = "approval" | "input";

/**
 * What the panel reads about the thread on screen. The crew board and the waiting crew threads are
 * the ones the controller already derives for `/crew` and the status bar; they are passed in, not
 * read again from the activities.
 */
export interface AgentsSource {
  readonly thread: OrchestrationThread;
  /** The lead's model as the composer shows it. */
  readonly leadModel: string | null;
  readonly board: CrewBoard | null;
  readonly waiting: ReadonlyArray<WaitingCrewThread>;
  /** The lead's own thread waits for an approval or an answer. */
  readonly leadWaiting: Waiting | null;
}

// ---- what is derived --------------------------------------------------------------------------

/** From `start` to `end`, or to now while `end` is null. */
interface Span {
  readonly start: number;
  readonly end: number | null;
}

/** One agent of the panel: the lead, a crew task, a subagent, a workflow, or a workflow's member. */
export interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly mark: WorkflowNodeState;
  readonly state: string;
  readonly waiting: Waiting | null;
  readonly task: string | null;
  readonly model: string | null;
  readonly span: Span | null;
  /** Tokens, cost, tool calls, evidence: what is known now and does not move with the clock. */
  readonly facts: ReadonlyArray<string>;
  readonly note: { readonly text: string; readonly tone: "dim" | "error" } | null;
  /** Still working or waiting, so its time runs. */
  readonly live: boolean;
}

interface LaneItem {
  readonly id: string;
  readonly mark: WorkflowNodeState;
  readonly title: string;
  readonly detail: string | null;
  readonly state: string;
  readonly live: boolean;
}

interface PhaseData {
  readonly title: string;
  readonly running: boolean;
  readonly done: boolean;
  /** What the phase says about itself, e.g. `1 active · 2 done`. */
  readonly summary: string;
  readonly members: ReadonlyArray<AgentRow>;
}

interface GroupData {
  readonly id: string;
  readonly name: string;
  readonly mark: WorkflowNodeState;
  readonly live: boolean;
  readonly total: number;
  readonly settled: number;
  readonly failed: number;
  readonly tokens: number;
  readonly span: Span | null;
  readonly phases: ReadonlyArray<PhaseData>;
  readonly loose: ReadonlyArray<AgentRow>;
}

export interface AgentsView {
  /** The thread is open but its contents have not arrived: nothing is known, not even that it is empty. */
  readonly loading: boolean;
  /** Nothing to show yet: no agent, and nothing the lead has done. */
  readonly empty: boolean;
  /** The lead first, then the others, working ones first. */
  readonly rows: ReadonlyArray<AgentRow>;
  /** Settled agents left out of `rows` to keep the list short. */
  readonly folded: number;
  readonly lane: ReadonlyArray<LaneItem>;
  readonly groups: ReadonlyArray<GroupData>;
  readonly groupsFolded: number;
  readonly counts: {
    readonly working: number;
    readonly idle: number;
    readonly done: number;
    readonly failed: number;
    readonly stopped: number;
    readonly tokens: number;
  };
  /** The crew board's one line for the lead's newest turn that used it. */
  readonly board: string | null;
  /** Something is working, so the clock matters. */
  readonly live: boolean;
}

/** What a thread that is open but has sent nothing to read yet shows. */
export const EMPTY_AGENTS_VIEW: AgentsView = {
  loading: false,
  empty: true,
  rows: [],
  folded: 0,
  lane: [],
  groups: [],
  groupsFolded: 0,
  counts: { working: 0, idle: 0, done: 0, failed: 0, stopped: 0, tokens: 0 },
  board: null,
  live: false,
};

/** What a thread that is open but not yet received shows. */
export const LOADING_AGENTS_VIEW: AgentsView = { ...EMPTY_AGENTS_VIEW, loading: true };

/** Settled agents listed before the rest are folded; agents still working always show. */
const ROSTER_LIMIT = 6;
const GROUP_LIMIT = 5;

const NODE_OF_FLOW: Readonly<Record<AgentFlowState, WorkflowNodeState>> = {
  working: "running",
  thinking: "running",
  waiting: "blocked",
  done: "completed",
  failed: "failed",
  stopped: "cancelled",
};

const PHASE_MARK: Readonly<Record<CrewTaskPhase, WorkflowNodeState>> = {
  running: "running",
  completed: "completed",
  partial: "failed",
  blocked: "failed",
  failed: "failed",
  stopped: "cancelled",
};

const epoch = (iso: string | null): number | null => {
  const value = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

const spanOf = (start: string | null, end: string | null, live: boolean): Span | null => {
  const from = epoch(start);
  if (from === null) return null;
  const to = epoch(end);
  return to !== null ? { start: from, end: to } : live ? { start: from, end: null } : null;
};

const isLiveStatus = (status: RuntimeSubagent["status"]): boolean =>
  status === "pending" || status === "running" || status === "waiting";

const isSettledStatus = (status: RuntimeSubagent["status"]): boolean =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

const workflowIsLive = (group: AgentPanelWorkflowGroup): boolean => {
  const { status } = group.workflow;
  return !isSettledStatus(status);
};

const membersOf = (group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> => [
  ...group.phases.flatMap((phase) => phase.members),
  ...group.unphasedMembers,
];

/** The model and effort as the desktop labels them, cleaned like every other string from the server. */
const modelLabelOf = (agent: RuntimeSubagent): string | null => {
  const label = formatSubagentModelLabel(agent.model, agent.effort);
  const clean = label === null ? "" : flat(label);
  return clean === "" ? null : clean;
};

const stateWordOf = (agent: RuntimeSubagent, mark: WorkflowNodeState): string =>
  agent.status === "idle" ? t("providers.agents.idle") : STATE_WORDS[mark];

/**
 * What an agent that is not the lead says it is doing: the live line leads with the work in
 * progress, a settled one with how it ended, as the desktop app's agent row does.
 */
const noteOf = (agent: RuntimeSubagent): AgentRow["note"] => {
  const last =
    agent.lastToolName === null
      ? null
      : t("providers.agents.tool", { name: flat(agent.lastToolName) });
  const pick = (value: string | null) =>
    value === null || flat(value) === "" ? null : flat(value);
  if (isLiveStatus(agent.status)) {
    const text = pick(agent.progress) ?? last ?? pick(agent.result) ?? pick(agent.error);
    return text === null ? null : { text: t("providers.wf.now", { text }), tone: "dim" };
  }
  const error = pick(agent.error);
  if (error !== null) return { text: t("providers.wf.error", { text: error }), tone: "error" };
  const result = pick(agent.result);
  if (result !== null) return { text: t("providers.agents.result", { text: result }), tone: "dim" };
  const text = pick(agent.progress) ?? last;
  return text === null ? null : { text: t("providers.agents.last", { text }), tone: "dim" };
};

const toolsText = (tools: ReadonlyArray<ToolCount> | undefined): string =>
  (tools ?? []).map(toolWord).join(" · ");

/**
 * A crew row falls back to the board's tokens when the agent reports no usage, so the row can show
 * tokens the header's total does not add: the total is `model.totalTokens`, agents' own usage only,
 * as on the desktop. The rows may therefore add up to more than the total, never less.
 */
const factsOf = (agent: RuntimeSubagent, task: CrewTask | undefined): ReadonlyArray<string> => {
  const tokens = agent.usage?.totalTokens ?? task?.tokens ?? null;
  const toolUses = agent.usage?.toolUses;
  return [
    tokens === null ? null : t("providers.wf.tokens", { count: formatTokenCount(tokens) }),
    task?.costUsd == null ? null : formatCost(task.costUsd),
    toolUses === undefined ? null : t("providers.agents.toolUses", { count: toolUses }),
    agent.activationCount > 1 ? t("providers.agents.runs", { count: agent.activationCount }) : null,
    task?.evidence == null
      ? null
      : t("providers.agents.evidence", { text: evidenceWord(task.evidence) }),
  ].filter((part): part is string => part !== null);
};

/** A workflow's member, or any subagent, as a row. */
const rowOfAgent = (
  agent: RuntimeSubagent,
  options: { readonly name: string; readonly task: string | null },
  task: CrewTask | undefined,
  waiting: Waiting | null,
): AgentRow => {
  // A pending agent is counted as working by the header and drawn as working in the lane; its row
  // says the same instead of "not started".
  const sub = agent.status === "pending" ? "running" : subagentNodeState(agent.status);
  const mark = task !== undefined ? PHASE_MARK[task.phase] : sub;
  // A crew task the board has settled with its turn is over, whatever the session still says.
  const live = task !== undefined ? task.phase === "running" : isLiveStatus(agent.status);
  return {
    id: agent.id,
    name: options.name,
    // A crew task that stopped partway says how; others say where the agent stands.
    mark: waiting === null ? mark : "blocked",
    state: task !== undefined ? phaseWord(task) : stateWordOf(agent, sub),
    waiting,
    task: options.task,
    model: modelLabelOf(agent),
    span: spanOf(agent.startedAt ?? agent.firstSeenAt, agent.completedAt, live),
    facts: factsOf(agent, task),
    note: noteOf(agent),
    live,
  };
};

// Compared by value: the name is the agent's role, which can be any word, `constructor` and `toString` included.
const nameOfKind = (name: string): string | undefined =>
  name === "Subagent"
    ? t("providers.wf.role.subagent")
    : name === "Workflow"
      ? t("providers.wf.role.workflow")
      : undefined;

const withRole = (agent: RuntimeSubagent): string => {
  const title = flat(agent.title);
  const role = agent.role === null ? "" : flat(agent.role);
  return role === "" || role.toLowerCase() === title.toLowerCase() ? title : `${title} [${role}]`;
};

const leadRow = (entry: AgentFlowEntry, source: AgentsSource): AgentRow => {
  const working = entry.state === "working" || entry.state === "thinking";
  const doing = [entry.doing === undefined ? "" : DOING_WORDS[entry.doing], toolsText(entry.tools)]
    .filter((part) => part !== "")
    .join(" · ");
  const text = working
    ? doing === ""
      ? null
      : t("providers.wf.now", { text: doing })
    : doing === ""
      ? t("providers.agents.awaiting")
      : t("providers.agents.turnDone", { text: doing });
  const waiting = source.leadWaiting;
  return {
    id: entry.id,
    name: "Lead",
    mark: waiting === null ? NODE_OF_FLOW[entry.state] : "blocked",
    state: working
      ? entry.state === "thinking"
        ? t("providers.wf.thinking")
        : STATE_WORDS.running
      : STATE_WORDS.completed,
    waiting,
    task: null,
    model: source.leadModel === null ? null : flat(source.leadModel),
    // The lead has no end of its own; its clock is the running turn.
    span: working ? spanOf(entry.startedAt, null, true) : null,
    facts: [],
    note: text === null ? null : { text, tone: "dim" },
    live: working,
  };
};

/**
 * The newest turn's work in the order it happened. An agent's step says who it is and where it
 * stands in the words the list above uses; a run of the lead's own work says what it did.
 */
const laneOf = (flow: ReturnType<typeof agentFlow>, rows: ReadonlyArray<AgentRow>): LaneItem[] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return flow.boxes.map((box) => {
    const mark = NODE_OF_FLOW[box.state];
    const live = box.state === "working" || box.state === "thinking";
    if (box.tools === undefined && box.doing === undefined) {
      const row = byId.get(box.agentId);
      const title = flat(box.title);
      return {
        id: box.id,
        mark: row?.mark ?? mark,
        title:
          row === undefined ? title : [row.name, title].filter((part) => part !== "").join(" · "),
        detail: null,
        state: row?.state ?? STATE_WORDS[mark],
        live: row?.live ?? live,
      };
    }
    const where = box.doing === undefined ? "" : DOING_WORDS[box.doing];
    const tools = toolsText(box.tools);
    return {
      id: box.id,
      mark,
      title: where || tools || t("providers.wf.role.main"),
      detail: where !== "" && tools !== "" ? tools : null,
      state: STATE_WORDS[mark],
      live,
    };
  });
};

const phaseSummary = (phase: AgentPanelWorkflowGroup["phases"][number]): string => {
  if (phase.state === "pending" && phase.members.length === 0) return STATE_WORDS.pending;
  const failed = phase.members.filter((member) => member.status === "failed").length;
  return [
    phase.state === "done" ? null : t("providers.wf.counts.running", { count: phase.activeCount }),
    t("providers.wf.counts.completed", { count: phase.settledCount - failed }),
    failed > 0 ? t("providers.wf.counts.failed", { count: failed }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
};

const groupOf = (group: AgentPanelWorkflowGroup): GroupData => {
  const members = membersOf(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const row = (member: RuntimeSubagent) =>
    rowOfAgent(member, { name: withRole(member), task: null }, undefined, null);
  const live = workflowIsLive(group);
  // The coordinator's usage may already add its members up: count it only when there are none.
  const tokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  return {
    id: group.workflow.id,
    name: flat(group.workflow.workflowName ?? group.workflow.title),
    mark: failed > 0 ? "failed" : subagentNodeState(group.workflow.status),
    live,
    total: members.length,
    settled: members.filter((member) => isSettledStatus(member.status)).length,
    failed,
    tokens,
    span: spanOf(group.workflow.startedAt, group.workflow.completedAt, false),
    phases: live
      ? group.phases.map((phase) => ({
          title: flat(phase.title),
          running: phase.state === "running",
          done: phase.state === "done",
          summary: phaseSummary(phase),
          members: phase.members.map(row),
        }))
      : [],
    loose: live ? group.unphasedMembers.map(row) : [],
  };
};

/**
 * How the agents ended, so a failure never hides inside a total. A crew task the board has settled
 * is counted by how the board says it ended (a `partial` or `blocked` one is a failure, not a
 * success), whatever the roster still says and whether or not its row is shown; its agent is left
 * out of the roster's own counts, so it is counted once.
 */
const countsOf = (
  model: AgentPanelModel,
  boardSettled: ReadonlyArray<CrewTask>,
): AgentsView["counts"] => {
  // A workflow with members is a container for them, as in the model's own counts.
  const agents = [
    ...model.workflows.flatMap((group) => {
      const members = membersOf(group);
      return members.length > 0 ? members : [group.workflow];
    }),
    ...model.directAgents,
  ];
  const byBoard = new Set(boardSettled.map((task) => task.taskId as string));
  const own = agents.filter((agent) => !byBoard.has(agent.id));
  const overlap = agents.filter((agent) => byBoard.has(agent.id));
  const count = (...statuses: ReadonlyArray<RuntimeSubagent["status"]>) =>
    own.filter((agent) => statuses.includes(agent.status)).length;
  const ended = (...phases: ReadonlyArray<CrewTaskPhase>) =>
    boardSettled.filter((task) => phases.includes(task.phase)).length;
  return {
    // The model counted the overlapping agents as working or idle; the board has them ended.
    working: Math.max(
      0,
      model.runningCount +
        model.waitingCount -
        overlap.filter((a) => isLiveStatus(a.status)).length,
    ),
    idle: Math.max(0, model.idleCount - overlap.filter((a) => a.status === "idle").length),
    done: count("completed") + ended("completed"),
    failed: count("failed") + ended("partial", "blocked", "failed"),
    stopped: count("cancelled", "interrupted") + ended("stopped"),
    // The desktop's total, agents' own usage only; see `factsOf` for why the rows can show more.
    tokens: model.totalTokens,
  };
};

/** The newest `limit` items in their original order, plus any that is still live. */
const newestOrLive = <T>(items: ReadonlyArray<T>, limit: number, live: (item: T) => boolean): T[] =>
  items.filter((item, index) => index >= items.length - limit || live(item));

/**
 * The Agents panel as the desktop app builds it: `agentFlow` for the lead and the agents of the
 * newest turn and the order of their work, the subagent roster for each agent's usage and what it
 * does now, and the workflows with their phases. Where the crew board already says more about a
 * crew task (how it ended, its cost, the evidence for its result), that is what is shown.
 */
export const deriveAgentsView = (source: AgentsSource): AgentsView => {
  const { thread } = source;
  const model = agentModelOf(thread);
  const active = activeTurnOf(thread);
  const flow = agentFlow({
    activities: thread.activities,
    agents: model,
    activeTurnId: active.turnId,
    activeTurnStartedAt: active.startedAt,
    lead: { model: source.leadModel, instanceId: null },
  });
  const agents = new Map(
    [...model.workflows.map((group) => group.workflow), ...model.directAgents].map((agent) => [
      agent.id,
      agent,
    ]),
  );
  const tasks = new Map((source.board?.tasks ?? []).map((task) => [task.taskId, task]));
  const waitingBy = new Map(source.waiting.map((entry) => [entry.thread.id as string, entry.kind]));

  const [lead, ...others] = flow.agents;
  const waitingOf = (entry: AgentFlowEntry): Waiting | null => {
    const task = entry.kind === "crew" ? tasks.get(entry.id) : undefined;
    return task?.threadId == null ? null : (waitingBy.get(task.threadId) ?? null);
  };
  // An agent that waits for the user is never folded away, however far down the roster it is.
  const kept = others.filter(
    (entry, index) =>
      index < ROSTER_LIMIT ||
      entry.state === "working" ||
      entry.state === "thinking" ||
      entry.state === "waiting" ||
      waitingOf(entry) !== null,
  );
  const rows: AgentRow[] = lead === undefined ? [] : [leadRow(lead, source)];
  const listed: AgentRow[] = [];
  for (const entry of kept) {
    const agent = agents.get(entry.id);
    if (agent === undefined) continue;
    const task = entry.kind === "crew" ? tasks.get(entry.id) : undefined;
    const label = nameOfKind(entry.name) ?? flat(entry.name);
    const title = flat(entry.task ?? "");
    listed.push(
      rowOfAgent(
        agent,
        {
          name: label,
          task: title === "" || title.toLowerCase() === label.toLowerCase() ? null : title,
        },
        task,
        waitingOf(entry),
      ),
    );
  }
  // Those waiting for the user come right after the lead, so a list too long for the panel still
  // starts with the ones that need an answer.
  rows.push(...listed.filter((row) => row.waiting !== null));
  rows.push(...listed.filter((row) => row.waiting === null));

  // A workflow without members is only its coordinator, which the list above already shows.
  const withMembers = model.workflows.filter((group) => membersOf(group).length > 0);
  const shown = newestOrLive(withMembers, GROUP_LIMIT, workflowIsLive);
  return {
    loading: false,
    empty: !model.hasAgents && !(flow.boxes.length > 0 || flow.agents.length > 1),
    rows,
    folded: others.length - kept.length,
    lane: laneOf(flow, rows),
    groups: shown.map(groupOf),
    groupsFolded: withMembers.length - shown.length,
    counts: countsOf(
      model,
      [...tasks.values()].filter((task) => task.phase !== "running"),
    ),
    board: source.board === null ? null : boardSummary(source.board),
    live: rows.some((row) => row.live) || shown.some(workflowIsLive),
  };
};

// ---- drawing -----------------------------------------------------------------------------------

export interface AgentsPanelInput {
  /** What the thread says; null when no thread is open. */
  readonly view: AgentsView | null;
  readonly now: number;
  /** False while the server cannot be reached: what is drawn is the last that arrived. */
  readonly online: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly style: Style;
  readonly symbols: Symbols;
  /** The key that flips between the Workflow and Agents tabs, named in the tab bar; none left out. */
  readonly switchKey?: string;
}

const elapsedOf = (span: Span | null, now: number): string | null =>
  span === null ? null : formatElapsed(Math.max(0, (span.end ?? now) - span.start));

/** One agent: who and how it stands, what it was asked, what it costs and takes, what it does now. */
const rowBlock = (
  row: AgentRow,
  input: AgentsPanelInput,
  room: number,
  depth: number,
): string[] => {
  const { style, symbols, now } = input;
  const { theme } = style;
  const lead = "  ".repeat(depth);
  const first = `${lead}  ${paintFor(style, row.mark)(symbols.flow[row.mark])} `;
  const rest = `${lead}    `;
  const ask =
    row.waiting === null
      ? ""
      : `  ${theme.warning(
          row.waiting === "approval"
            ? t("providers.crewScreen.waitApproval")
            : t("providers.crewScreen.waitInput"),
        )}`;
  const lines = [
    truncateStyled(`${first}${theme.text.bold(row.name)}  ${theme.dim(row.state)}${ask}`, room),
  ];
  if (row.task !== null) lines.push(truncateStyled(`${rest}${theme.text(row.task)}`, room));
  const metrics = [row.model, elapsedOf(row.span, now), ...row.facts].filter(
    (part): part is string => part !== null,
  );
  for (const line of packFacts(metrics, room - visibleWidth(rest))) {
    lines.push(truncateStyled(`${rest}${theme.dim(line)}`, room));
  }
  if (row.note !== null) {
    const paint = row.note.tone === "error" ? theme.error : theme.dim;
    lines.push(truncateStyled(`${rest}${paint(row.note.text)}`, room));
  }
  return lines;
};

/**
 * One agent of the roster as the desktop's card: a bar down the left in the colour of its state,
 * the name and model with the state word at the right, what it was asked, and its time and usage.
 */
const rosterCard = (row: AgentRow, input: AgentsPanelInput, room: number): string[] => {
  const { style, symbols, now } = input;
  const { theme } = style;
  const tone = paintFor(style, row.mark);
  const state =
    row.waiting === null
      ? theme.dim(row.state)
      : theme.warning(
          row.waiting === "approval"
            ? t("providers.crewScreen.waitApproval")
            : t("providers.crewScreen.waitInput"),
        );
  const inner = Math.max(4, room - 2);
  const head = `${tone(symbols.flow[row.mark])} ${theme.text.bold(row.name)}${
    row.model === null ? "" : `  ${theme.dim(row.model)}`
  }`;
  const left = truncateStyled(head, Math.max(2, inner - visibleWidth(state) - 1));
  const lines = [
    `${left}${" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(state)))}${state}`,
  ];
  if (row.task !== null) lines.push(truncateStyled(theme.text(row.task), inner));
  const metrics = [elapsedOf(row.span, now), ...row.facts].filter(
    (part): part is string => part !== null,
  );
  for (const line of packFacts(metrics, inner)) lines.push(truncateStyled(theme.dim(line), inner));
  if (row.note !== null) {
    const paint = row.note.tone === "error" ? theme.error : theme.dim;
    lines.push(truncateStyled(paint(row.note.text), inner));
  }
  const { rail } = symbols;
  return lines.map((line, index) => {
    const bar =
      lines.length === 1
        ? rail.bar
        : index === 0
          ? rail.start
          : index === lines.length - 1
            ? rail.end
            : rail.bar;
    return `${tone(bar)} ${line}`;
  });
};

/**
 * The turn's work as a chain of small cards, each joined to the one before by a connector that is
 * lit while the step it leads into is live, as the desktop's flow lane draws it.
 */
const laneBlock = (items: ReadonlyArray<LaneItem>, input: AgentsPanelInput, room: number) => {
  const { style, symbols } = input;
  const { theme } = style;
  const { rail } = symbols;
  const inner = Math.max(4, room - 2);
  return items.flatMap((item, index) => {
    const tone = paintFor(style, item.mark);
    const detail = [item.detail, item.state]
      .filter((part) => part !== null && part !== "")
      .join(" · ");
    const first = truncateStyled(
      `${tone(symbols.flow[item.mark])} ${(item.live ? theme.text.bold : theme.text)(item.title)}`,
      inner,
    );
    const link = index === 0 ? [] : [(item.live ? theme.accent : theme.dim)(symbols.link.line)];
    return [
      ...link,
      `${tone(rail.start)} ${first}`,
      `${tone(rail.end)} ${truncateStyled(theme.dim(detail), inner)}`,
    ];
  });
};

/** The run's shape at a glance, as the desktop's phase rail: a chip for each phase, joined by chevrons. */
const phaseRail = (group: GroupData, input: AgentsPanelInput, room: number): string[] => {
  const { style, symbols } = input;
  const { theme } = style;
  const chips = group.phases.map((phase) => {
    const paint = phase.running ? theme.accent : phase.done ? theme.success : theme.dim;
    const marks =
      phase.members.length === 0
        ? theme.dim("-")
        : phase.members
            .map((member) => paintFor(style, member.mark)(symbols.flow[member.mark]))
            .join("");
    return `${paint(`${phase.done ? `${symbols.check} ` : ""}${phase.title}`)} ${marks}`;
  });
  const lines: string[] = [];
  let line = "";
  for (const chip of chips) {
    const joined = line === "" ? chip : `${line} ${theme.dim(symbols.link.next)} ${chip}`;
    if (line !== "" && visibleWidth(joined) > room) {
      lines.push(line);
      line = chip;
    } else {
      line = joined;
    }
  }
  return line === "" ? lines : [...lines, line].map((text) => truncateStyled(text, room));
};

const groupBlock = (group: GroupData, input: AgentsPanelInput, room: number): string[] => {
  const { style, symbols, now } = input;
  const { theme } = style;
  const mark = paintFor(style, group.mark)(symbols.flow[group.mark]);
  const failed =
    group.failed > 0
      ? theme.error(` · ${t("providers.wf.counts.failed", { count: group.failed })}`)
      : "";
  if (!group.live) {
    const elapsed = elapsedOf(group.span, now);
    const facts = [
      t("providers.agents.agentCount", { count: group.total }),
      t("providers.wf.tokens", { count: formatTokenCount(group.tokens) }),
      elapsed,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    return [
      truncateStyled(`  ${mark} ${theme.text(group.name)}  ${theme.dim(facts)}${failed}`, room),
    ];
  }
  const lines = [
    truncateStyled(
      `  ${mark} ${theme.text.bold(group.name)}  ${theme.dim(t("providers.agents.settled", { settled: group.settled, total: group.total }))}${failed}`,
      room,
    ),
    ...phaseRail(group, input, room - 4).map((line) => `    ${line}`),
  ];
  for (const phase of group.phases) {
    const marks = phase.running
      ? ""
      : ` ${phase.members.map((member) => paintFor(style, member.mark)(symbols.flow[member.mark])).join("")}`;
    const paint = phase.running ? theme.accent : theme.dim;
    lines.push(
      truncateStyled(
        `    ${paint(t("providers.wf.step", { index: phase.title }))}  ${theme.dim(phase.summary)}${marks}`,
        room,
      ),
    );
    if (phase.running)
      for (const member of phase.members) lines.push(...rowBlock(member, input, room, 2));
  }
  for (const member of group.loose) lines.push(...rowBlock(member, input, room, 2));
  return lines;
};

/** The Agents panel as lines for a column `columns` wide and `rows` tall. */
export const renderAgentsPanel = (input: AgentsPanelInput): string[] => {
  const { style, symbols, rows, view } = input;
  const { theme } = style;
  const { room, margin, out, say, empty, offline } = panelHead("agents", input);
  if (view === null) {
    say(t("providers.agents.openThread"));
    return out.slice(0, rows);
  }
  if (!input.online) offline();
  if (view.loading || view.empty) {
    // What an empty thread will show is not promised while the link is down, nor before it is read.
    if (view.loading) {
      say(input.online ? t("providers.agents.loading") : t("providers.agents.loadingOffline"));
    } else if (input.online) {
      empty(t("providers.agents.emptyTitle"), t("providers.agents.empty"));
    }
    return out.slice(0, rows);
  }

  const { counts } = view;
  const working =
    counts.working > 0
      ? theme.accent(
          `${symbols.bullet} ${t("providers.agents.sumWorking", { count: counts.working })}`,
        )
      : null;
  const summary = [
    working,
    counts.idle > 0 ? theme.dim(t("providers.agents.sumIdle", { count: counts.idle })) : null,
    counts.done > 0 ? theme.dim(t("providers.wf.counts.completed", { count: counts.done })) : null,
    counts.failed > 0
      ? theme.error(t("providers.wf.counts.failed", { count: counts.failed }))
      : null,
    counts.stopped > 0
      ? theme.dim(t("providers.wf.counts.stopped", { count: counts.stopped }))
      : null,
    counts.tokens > 0
      ? theme.dim(t("providers.agents.sumTokens", { count: formatTokenCount(counts.tokens) }))
      : null,
  ].filter((part): part is string => part !== null);
  // The desktop pins its totals under the list; here they are the last rows of the panel.
  const footer: string[] = [];
  if (summary.length > 0) {
    footer.push(...wrapStyled(summary.join(theme.dim(" · ")), room).slice(0, 2));
  }
  if (view.board !== null) footer.unshift(truncateStyled(theme.dim(`Crew ${view.board}`), room));
  const pinned =
    footer.length === 0 || rows < 12
      ? []
      : [theme.dim(symbols.rule.repeat(room)), ...footer].map(margin);
  out.push("");

  const body: string[] = [];
  // Scrolling keeps in view the first row that waits for the user, else the first that works.
  let focus = -1;
  let focusWaiting = false;
  const heading = (text: string) => body.push(theme.dim(text));
  heading(t("providers.agents.headingAgents"));
  for (const row of view.rows) {
    if (row.waiting !== null && !focusWaiting) {
      focus = body.length;
      focusWaiting = true;
    } else if (focus < 0 && row.live) {
      focus = body.length;
    }
    body.push(...rosterCard(row, input, room - 1));
  }
  if (view.folded > 0) body.push(theme.dim(t("providers.agents.folded", { count: view.folded })));
  body.push("");
  heading(t("providers.agents.headingFlow"));
  if (view.lane.length === 0) body.push(theme.dim(t("providers.agents.noLane")));
  else body.push(...laneBlock(view.lane, input, room - 1));
  if (view.groups.length > 0) {
    body.push("");
    heading(t("providers.wf.role.workflow"));
    for (const group of view.groups) body.push(...groupBlock(group, input, room - 1));
    if (view.groupsFolded > 0)
      body.push(theme.dim(t("providers.agents.folded", { count: view.groupsFolded })));
  }
  const available = Math.max(0, rows - out.length - pinned.length);
  const shown = windowOf(
    { lines: body.map(margin), focus: Math.max(0, focus) },
    available,
    theme.dim,
  );
  while (pinned.length > 0 && shown.length < available) shown.push("");
  return [...out, ...shown, ...pinned].slice(0, rows);
};

// ---- the panel's state in the controller ------------------------------------------------------

/** The same threads wait for the same thing: the panel reads the ids and kinds, so a new list of them is no change. */
const sameWaiting = (a: ReadonlyArray<WaitingCrewThread>, b: ReadonlyArray<WaitingCrewThread>) =>
  a === b ||
  (a.length === b.length &&
    a.every(
      (entry, index) => entry.kind === b[index]?.kind && entry.thread.id === b[index]?.thread.id,
    ));

/**
 * What the controller keeps for the Agents view: the thread read into rows, redone only when what
 * it is read from changes, and those rows drawn into lines, redone only when the size, the theme,
 * or (while something works) the second changes.
 */
export class AgentsPanel {
  private viewMemo: {
    readonly activities: unknown;
    readonly session: unknown;
    readonly latestTurn: unknown;
    readonly leadModel: string | null;
    readonly board: CrewBoard | null;
    readonly waiting: ReadonlyArray<WaitingCrewThread>;
    readonly leadWaiting: Waiting | null;
    readonly view: AgentsView;
  } | null = null;
  private lineMemo: {
    readonly input: AgentsPanelInput;
    /** The theme as it was drawn: the style object is the same one after `/theme`, so copy what is compared. */
    readonly themeName: string;
    readonly themeLevel: unknown;
    readonly bucket: number;
    readonly lines: string[];
  } | null = null;

  /** A different thread: nothing read from the last one carries over. */
  reset(): void {
    this.viewMemo = null;
    this.lineMemo = null;
  }

  read(source: AgentsSource): AgentsView {
    const { thread } = source;
    const memo = this.viewMemo;
    if (
      memo !== null &&
      memo.activities === thread.activities &&
      memo.session === thread.session &&
      memo.latestTurn === thread.latestTurn &&
      memo.leadModel === source.leadModel &&
      memo.board === source.board &&
      sameWaiting(memo.waiting, source.waiting) &&
      memo.leadWaiting === source.leadWaiting
    ) {
      return memo.view;
    }
    const view = deriveAgentsView(source);
    this.viewMemo = {
      activities: thread.activities,
      session: thread.session,
      latestTurn: thread.latestTurn,
      leadModel: source.leadModel,
      board: source.board,
      waiting: source.waiting,
      leadWaiting: source.leadWaiting,
      view,
    };
    return view;
  }

  lines(input: AgentsPanelInput): string[] {
    // Elapsed times move once a second, and only while an agent works.
    const bucket = input.view?.live === true ? Math.floor(input.now / 1000) : 0;
    const memo = this.lineMemo;
    if (
      memo !== null &&
      memo.bucket === bucket &&
      memo.input.view === input.view &&
      memo.input.online === input.online &&
      memo.input.columns === input.columns &&
      memo.input.rows === input.rows &&
      memo.input.symbols === input.symbols &&
      memo.input.switchKey === input.switchKey &&
      memo.themeName === input.style.theme.name &&
      memo.themeLevel === input.style.theme.level
    ) {
      return memo.lines;
    }
    const lines = renderAgentsPanel(input);
    this.lineMemo = {
      input,
      themeName: input.style.theme.name,
      themeLevel: input.style.theme.level,
      bucket,
      lines,
    };
    return lines;
  }
}
