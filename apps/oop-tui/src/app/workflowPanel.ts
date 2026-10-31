import type { OrchestrationThread } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  actorFlows,
  MAIN_NODE_PREFIX,
  THINKING_NODE_PREFIX,
} from "@t3tools/client-runtime/thread-flow";
import {
  boundFlows,
  focusWorkflowGraphId,
  isSettledState,
  nodeElapsedMs,
  workflowCounts,
  workflowWaves,
  type ToolCount,
  type WorkflowActorRole,
  type WorkflowCounts,
  type WorkflowDoing,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";

import { formatCost, formatTokenCount, roleName } from "../render/crewBoard.ts";
import { formatElapsed } from "../render/spinner.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { truncateStyled, wrapStyled, wrapWithPrefix } from "../text/wrap.ts";

// ---- what `/dag-workflow` can be told ---------------------------------------------------------

export type FlowAction =
  | { readonly kind: "toggle" | "on" | "off" | "live" | "next" | "prev" }
  | { readonly kind: "pick"; readonly number: number };

export const WORKFLOW_USAGE = "/dag-workflow [on|off|번호|next|prev|live]";

/** The two things the side panel can show; each has a command that opens, switches to, and closes it. */
export type PanelView = "workflow" | "agents";

export const PANEL_COMMAND: Readonly<Record<PanelView, string>> = {
  workflow: "/dag-workflow",
  agents: "/dag-agents",
};

export const PANEL_TITLE: Readonly<Record<PanelView, string>> = {
  workflow: "Workflow",
  agents: "Agents",
};

/** Reads the words after `/dag-workflow`; null when they are not something it takes. */
export const parseFlowAction = (args: ReadonlyArray<string>): FlowAction | null => {
  const word = args[0]?.toLowerCase();
  if (word === undefined) return { kind: "toggle" };
  if (args.length > 1) return null;
  if (word === "on" || word === "off" || word === "live" || word === "next" || word === "prev") {
    return { kind: word };
  }
  return /^\d{1,4}$/u.test(word) ? { kind: "pick", number: Number(word) } : null;
};

// ---- the flows of a thread ---------------------------------------------------------------------

/**
 * The thread's work as the desktop app's workflow panel draws it: one flow per turn (the main agent
 * and what it handed to the crew and to subagents) and each provider workflow, newest first.
 */
/**
 * The desktop app's test for "the provider session is alive" (`derivePhase !== "disconnected"`).
 * The link to the server is not part of it: members keep their state through a network drop, and
 * a session that ended leaves no member working.
 */
export const sessionIsLive = (session: OrchestrationThread["session"]): boolean =>
  session !== null &&
  session.status !== "stopped" &&
  session.status !== "interrupted" &&
  session.status !== "error";

/** The agent roster of a thread, folded from its activities. */
export const agentModelOf = (thread: OrchestrationThread) =>
  deriveAgentPanelModel({
    agents: foldSubagentActivities(thread.activities, {
      sessionLive: sessionIsLive(thread.session),
    }),
  });

/** The turn still running and when it began; both null once it is over, so nothing in it looks busy. */
export const activeTurnOf = (
  thread: OrchestrationThread,
): { readonly turnId: string | null; readonly startedAt: string | null } => {
  const { latestTurn, session } = thread;
  // The same test the desktop app uses for "this turn is over".
  const settled =
    latestTurn?.startedAt != null &&
    latestTurn.completedAt != null &&
    (session === null || session.status !== "running");
  return settled
    ? { turnId: null, startedAt: null }
    : {
        turnId: latestTurn?.turnId ?? null,
        startedAt: latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null,
      };
};

export const deriveFlows = (
  thread: OrchestrationThread,
  leadModel: string | null,
): WorkflowGraph[] => {
  const active = activeTurnOf(thread);
  return actorFlows({
    activities: thread.activities,
    agents: agentModelOf(thread),
    activeTurnId: active.turnId,
    activeTurnStartedAt: active.startedAt,
    leadModel,
  });
};

// ---- words -------------------------------------------------------------------------------------

export const flat = (value: string): string =>
  sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

const ROLE_WORDS: Readonly<Record<WorkflowActorRole, string>> = {
  main: "메인 에이전트",
  worker: roleName("worker"),
  expert: roleName("expert"),
  auditor: roleName("auditor"),
  crew: "Crew 멤버",
  subagent: "서브에이전트",
  workflow: "워크플로",
};

export const STATE_WORDS: Readonly<Record<WorkflowNodeState, string>> = {
  pending: "시작 전",
  blocked: "대기 중",
  running: "작업 중",
  paused: "일시 중지",
  completed: "완료",
  failed: "실패",
  cancelled: "중단됨",
  skipped: "건너뜀",
};

/** Where a node stands; a crew task that stopped partway says how. */
const stateWord = (node: Pick<WorkflowNode, "state" | "info">): string => {
  if (node.state === "failed") {
    const outcome = node.info.crew?.outcome;
    if (outcome === "blocked") return "차단됨";
    if (outcome === "partial") return "일부 완료";
  }
  return STATE_WORDS[node.state];
};

export const DOING_WORDS: Readonly<Record<WorkflowDoing, string>> = {
  read: "파일 읽는 중…",
  edit: "파일 수정 중…",
  run: "명령 실행 중…",
  search: "검색 중…",
  web: "웹 검색 중…",
  other: "도구 사용 중…",
  thinking: "생각하는 중…",
  waiting: "팀 작업을 기다리는 중…",
};

export const toolWord = ({ category, count }: ToolCount): string => {
  switch (category) {
    case "read":
      return `파일 ${count}개 읽음`;
    case "edit":
      return `파일 ${count}개 수정`;
    case "run":
      return `명령 ${count}번 실행`;
    case "search":
      return `검색 ${count}번`;
    case "web":
      return `웹 검색 ${count}번`;
    case "other":
      return `기타 도구 ${count}번`;
  }
};

const countsWord = (counts: WorkflowCounts): string =>
  [
    counts.completed > 0 ? `완료 ${counts.completed}` : null,
    counts.failed > 0 ? `실패 ${counts.failed}` : null,
    counts.stopped > 0 ? `중단 ${counts.stopped}` : null,
    counts.running > 0 ? `진행 ${counts.running}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const flowName = (flow: WorkflowGraph): string => {
  if (flow.turnIndex === undefined) return flat(flow.name);
  return flow.kind === "crew" ? `턴 ${flow.turnIndex} · Crew` : `턴 ${flow.turnIndex}`;
};

/** Column titles the shared code builds in English; a workflow's own phase titles pass through. */
const waveTitle = (title: string | undefined, index: number): string => {
  if (title === undefined || title === "") return `웨이브 ${index + 1}`;
  if (title === "Main agent") return ROLE_WORDS.main;
  if (title === "Delegated work") return "위임된 작업";
  if (title === "Review") return "검토";
  if (title === "Next") return "다음";
  const numbered = /^(Step|Wave) (\d+)$/u.exec(title);
  if (numbered !== null) return `${numbered[1] === "Step" ? "단계" : "웨이브"} ${numbered[2]}`;
  return flat(title);
};

const nodeName = (node: WorkflowNode): string => {
  if (node.id.startsWith(THINKING_NODE_PREFIX)) return "생각하는 중";
  const { actor } = node.info;
  if (actor === undefined) return flat(node.label);
  return [ROLE_WORDS[actor.role], actor.task === undefined ? "" : flat(actor.task)]
    .filter((part) => part !== "")
    .join(" · ");
};

/** A flow's own members: its agents or steps, without the main agent or the thinking frontier. */
const membersOf = (flow: WorkflowGraph): WorkflowNode[] =>
  flow.nodes.filter(
    (node) => !node.id.startsWith(THINKING_NODE_PREFIX) && !node.id.startsWith(MAIN_NODE_PREFIX),
  );

// ---- drawing -----------------------------------------------------------------------------------

export interface PanelInput {
  /** The thread's flows, newest first; null when no thread is open. */
  readonly flows: ReadonlyArray<WorkflowGraph> | null;
  /** The flow the user picked; null follows the live one. */
  readonly pinnedId: string | null;
  readonly now: number;
  /** False while the server cannot be reached: what is drawn is the last that arrived. */
  readonly online: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly style: Style;
  readonly symbols: Symbols;
}

export interface Block {
  readonly lines: string[];
  /** Index of the line the panel should keep in view when it has to scroll. */
  readonly focus: number;
}

/** The marks of the ASCII preset are drawn in the plain tone of their state, the rest likewise. */
export const paintFor = (style: Style, state: WorkflowNodeState) => {
  const { theme } = style;
  switch (state) {
    case "completed":
      return theme.success;
    case "failed":
      return theme.error;
    case "running":
      return theme.accent;
    case "blocked":
    case "paused":
      return theme.warning;
    default:
      return theme.dim;
  }
};

const progressBar = (counts: WorkflowCounts, width: number, style: Style, symbols: Symbols) => {
  const { theme } = style;
  const cells = (count: number) => Math.round((count / Math.max(1, counts.total)) * width);
  const done = cells(counts.completed);
  const failed = Math.min(width - done, cells(counts.failed));
  const stopped = Math.min(width - done - failed, cells(counts.stopped));
  const rest = width - done - failed - stopped;
  const { full, empty } = symbols.progress;
  return (
    theme.success(full.repeat(done)) +
    theme.error(full.repeat(failed)) +
    theme.dim(full.repeat(stopped)) +
    theme.dim(empty.repeat(rest))
  );
};

const nodeBlock = (
  node: WorkflowNode,
  upstream: ReadonlyArray<WorkflowNode>,
  input: PanelInput,
  room: number,
): string[] => {
  const { style, symbols, now } = input;
  const { theme } = style;
  const { info } = node;
  const mark = paintFor(style, node.state)(symbols.flow[node.state]);
  const lines = wrapWithPrefix(theme.text(nodeName(node)), room, `  ${mark} `, "    ");
  const indent = "    ";
  const facts: string[] = [stateWord(node)];
  const model = formatSubagentModelLabel(info.model ?? null, null);
  if (model !== null && model !== "") facts.push(flat(model));
  const elapsed = nodeElapsedMs(info, now);
  if (elapsed !== undefined) facts.push(formatElapsed(elapsed));
  if (info.tokens !== undefined) facts.push(`${formatTokenCount(info.tokens)} 토큰`);
  if (info.costUsd !== undefined) facts.push(formatCost(info.costUsd));
  lines.push(...wrapWithPrefix(theme.dim(facts.join(" · ")), room, indent, indent));
  const { actor } = info;
  const work: string[] = [];
  if (actor?.delegated !== undefined) work.push(`Crew 에 작업 ${actor.delegated}개 위임`);
  for (const tool of actor?.tools ?? []) work.push(toolWord(tool));
  if (work.length > 0)
    lines.push(...wrapWithPrefix(theme.dim(work.join(" · ")), room, indent, indent));
  const now_ =
    node.state === "running"
      ? actor?.doing !== undefined
        ? DOING_WORDS[actor.doing]
        : info.progress === undefined
          ? ""
          : flat(info.progress)
      : "";
  if (now_ !== "") lines.push(...wrapWithPrefix(theme.dim(`지금: ${now_}`), room, indent, indent));
  if (upstream.length > 0) {
    const names = upstream.slice(0, 3).map(nodeName);
    const more = upstream.length > 3 ? ` 외 ${upstream.length - 3}` : "";
    lines.push(
      ...wrapWithPrefix(theme.dim(`선행: ${names.join(", ")}${more}`), room, indent, indent),
    );
  }
  if (info.error !== undefined) {
    lines.push(...wrapWithPrefix(theme.error(`오류: ${flat(info.error)}`), room, indent, indent));
  }
  return lines;
};

/** The waves of a flow as text: a heading, then each step with its state, time, work, and what it waits for. */
const waveBlock = (flow: WorkflowGraph, input: PanelInput, room: number): Block => {
  const { theme } = input.style;
  const waves = workflowWaves(flow.nodes, flow.edges);
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const upstream = new Map<string, WorkflowNode[]>();
  for (const edge of flow.edges) {
    const from = byId.get(edge.from);
    if (from !== undefined) upstream.set(edge.to, [...(upstream.get(edge.to) ?? []), from]);
  }
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of flow.nodes) {
    const wave = waves.get(node.id) ?? 0;
    columns.set(wave, [...(columns.get(wave) ?? []), node]);
  }
  const order = [...columns.keys()].sort((a, b) => a - b);
  const open = order.find((wave) =>
    (columns.get(wave) ?? []).some((node) => !isSettledState(node.state)),
  );
  const current = open ?? order[order.length - 1];
  const lines: string[] = [];
  let focus = 0;
  order.forEach((wave, position) => {
    const nodes = columns.get(wave) ?? [];
    const settled = nodes.filter((node) => isSettledState(node.state)).length;
    if (wave === current) focus = lines.length;
    const heading = `${position + 1}. ${waveTitle(flow.waveTitles[wave], wave)}`;
    const paint = wave === current ? theme.accent.bold : theme.text.bold;
    lines.push(`${paint(heading)} ${theme.dim(`${settled}/${nodes.length}`)}`);
    for (const node of nodes)
      lines.push(...nodeBlock(node, upstream.get(node.id) ?? [], input, room));
  });
  return { lines, focus };
};

/**
 * The body that does not fit is shown from just above the wave in progress, with a row at either
 * end saying how many lines lie beyond.
 */
export const windowOf = (block: Block, rows: number, dim: (text: string) => string): string[] => {
  if (block.lines.length <= rows) return block.lines;
  if (rows < 3) return block.lines.slice(block.focus, block.focus + rows);
  const start = Math.min(Math.max(0, block.focus - 1), block.lines.length - rows);
  const end = start + rows;
  const shown = block.lines.slice(start, end);
  if (start > 0) shown[0] = dim(`↑ 위에 ${start}줄`);
  if (end < block.lines.length)
    shown[shown.length - 1] = dim(`↓ 아래에 ${block.lines.length - end}줄`);
  return shown;
};

/**
 * What every view of the side panel starts with: the title with how to close it, a rule, and the
 * way to say a sentence or the link's state inside the margin.
 */
export const panelHead = (
  view: PanelView,
  input: Pick<PanelInput, "columns" | "style" | "symbols">,
) => {
  const { style, symbols, columns } = input;
  const { theme } = style;
  const room = Math.max(8, columns - 2);
  const margin = (text: string) => ` ${text}`;
  const out: string[] = [
    margin(
      truncateStyled(
        `${theme.accent.bold(PANEL_TITLE[view])}${theme.dim(`  ${PANEL_COMMAND[view]} 로 닫기`)}`,
        room,
      ),
    ),
    margin(theme.dim(symbols.rule.repeat(room))),
  ];
  return {
    room,
    margin,
    out,
    say: (text: string) => out.push(...wrapStyled(theme.dim(text), room).map(margin)),
    /** While the server cannot be reached what is drawn is the last that arrived; the panel says so. */
    offline: () =>
      out.push(margin(truncateStyled(theme.warning("연결 끊김 · 마지막으로 받은 내용"), room))),
  };
};

/** The workflow panel as lines for a column `columns` wide and `rows` tall. */
export const renderFlowPanel = (input: PanelInput): string[] => {
  const { style, symbols, rows } = input;
  const { theme } = style;
  const { room, margin, out, say, offline } = panelHead("workflow", input);
  const { flows } = input;
  if (flows === null) {
    say("스레드를 열면 그 스레드의 작업 흐름이 여기에 보입니다.");
    return out.slice(0, rows);
  }
  if (!input.online) offline();
  if (flows.length === 0) {
    say("에이전트가 도구를 쓰거나 서브에이전트·workflow 를 시작하면 단계가 여기에 나타납니다.");
    return out.slice(0, rows);
  }

  const focusedId = focusWorkflowGraphId(flows, input.pinnedId);
  const flow = flows.find((candidate) => candidate.id === focusedId) ?? flows[0];
  if (flow === undefined) return out.slice(0, rows);

  if (flows.length > 1) {
    const { visible, earlier } = boundFlows(flows, focusedId, Math.max(1, Math.min(4, rows - 10)));
    out.push(
      margin(truncateStyled(theme.dim(`흐름 ${flows.length}개 · /dag-workflow <번호>`), room)),
    );
    for (const chip of visible) {
      const picked = chip.id === focusedId;
      const counts = workflowCounts(membersOf(chip));
      const mark = paintFor(style, chip.status)(symbols.flow[chip.status]);
      const text = `${picked ? theme.accent(symbols.prompt) : " "} ${flows.indexOf(chip) + 1} ${mark} ${(picked ? theme.text.bold : theme.text)(flowName(chip))}${
        counts.total === 0 ? "" : theme.dim(` ${counts.completed}/${counts.total}`)
      }`;
      out.push(margin(truncateStyled(text, room)));
    }
    if (earlier.length > 0) out.push(margin(theme.dim(`이전 ${earlier.length}개 (번호로 고르기)`)));
  }

  const counts = workflowCounts(membersOf(flow));
  const mark = paintFor(style, flow.status)(symbols.flow[flow.status]);
  const kind = flow.kind === "workflow" ? theme.dim(" · 워크플로") : "";
  out.push(
    margin(
      truncateStyled(
        `${mark} ${theme.text.bold(flowName(flow))}  ${theme.dim(STATE_WORDS[flow.status])}${kind}`,
        room,
      ),
    ),
  );
  if (counts.total > 0) {
    out.push(margin(truncateStyled(theme.dim(countsWord(counts)), room)));
    const barWidth = Math.max(4, Math.min(24, room - 8));
    out.push(
      margin(
        `${progressBar(counts, barWidth, style, symbols)} ${theme.dim(`${counts.completed + counts.failed + counts.stopped}/${counts.total}`)}`,
      ),
    );
  }
  out.push("");
  const body = waveBlock(flow, input, room - 1);
  const shown = windowOf(
    { lines: body.lines.map(margin), focus: body.focus },
    Math.max(0, rows - out.length),
    theme.dim,
  );
  return [...out, ...shown].slice(0, rows);
};

// ---- the panel's state in the controller ------------------------------------------------------

/**
 * What the controller keeps for the workflow panel: the flow the user picked, and the work of
 * reading the thread into flows and flows into lines, which is redone only when the thread, the
 * size, or (while something runs) the second changes.
 */
export class WorkflowPanel {
  private pinned: string | null = null;
  private flowMemo: {
    readonly activities: unknown;
    readonly session: unknown;
    readonly latestTurn: unknown;
    readonly leadModel: string | null;
    readonly flows: WorkflowGraph[];
  } | null = null;
  private lineMemo: {
    readonly input: PanelInput;
    /** The theme as it was drawn: the style object is the same one after `/theme`, so copy what is compared. */
    readonly themeName: string;
    readonly themeLevel: unknown;
    readonly bucket: number;
    readonly lines: string[];
  } | null = null;

  /** A different thread: nothing picked in the last one carries over. */
  reset(): void {
    this.pinned = null;
    this.flowMemo = null;
    this.lineMemo = null;
  }

  pinnedId(): string | null {
    return this.pinned;
  }

  flows(thread: OrchestrationThread | null, leadModel: string | null) {
    if (thread === null) return null;
    const memo = this.flowMemo;
    if (
      memo !== null &&
      memo.activities === thread.activities &&
      memo.session === thread.session &&
      memo.latestTurn === thread.latestTurn &&
      memo.leadModel === leadModel
    ) {
      return memo.flows;
    }
    const flows = deriveFlows(thread, leadModel);
    this.flowMemo = {
      activities: thread.activities,
      session: thread.session,
      latestTurn: thread.latestTurn,
      leadModel,
      flows,
    };
    return flows;
  }

  /** Applies a pick, `next`, `prev` or `live`; says why when it cannot. */
  choose(flows: ReadonlyArray<WorkflowGraph> | null, action: FlowAction): string | null {
    if (action.kind === "live") {
      this.pinned = null;
      return null;
    }
    if (action.kind !== "pick" && action.kind !== "next" && action.kind !== "prev") return null;
    if (flows === null || flows.length === 0) return "고를 흐름이 없습니다.";
    let index: number;
    if (action.kind === "pick") {
      if (action.number < 1 || action.number > flows.length) {
        return `흐름 번호는 1~${flows.length} 입니다.`;
      }
      index = action.number - 1;
    } else {
      const now = flows.findIndex((flow) => flow.id === focusWorkflowGraphId(flows, this.pinned));
      const step = action.kind === "next" ? 1 : -1;
      index = (Math.max(0, now) + step + flows.length) % flows.length;
    }
    const picked = flows[index];
    if (picked === undefined) return null;
    // Picking the flow that is being followed anyway keeps following it.
    this.pinned = picked.id === focusWorkflowGraphId(flows, null) ? null : picked.id;
    return null;
  }

  lines(input: Omit<PanelInput, "pinnedId">): string[] {
    const full: PanelInput = { ...input, pinnedId: this.pinned };
    // Elapsed times move once a second, and only while a step is running.
    const running = input.flows?.some((flow) =>
      flow.nodes.some((node) => node.state === "running"),
    );
    const bucket = running === true ? Math.floor(input.now / 1000) : 0;
    const memo = this.lineMemo;
    if (
      memo !== null &&
      memo.bucket === bucket &&
      memo.input.flows === full.flows &&
      memo.input.pinnedId === full.pinnedId &&
      memo.input.online === full.online &&
      memo.input.columns === full.columns &&
      memo.input.rows === full.rows &&
      memo.input.symbols === full.symbols &&
      memo.themeName === full.style.theme.name &&
      memo.themeLevel === full.style.theme.level
    ) {
      return memo.lines;
    }
    const lines = renderFlowPanel(full);
    this.lineMemo = {
      input: full,
      themeName: full.style.theme.name,
      themeLevel: full.style.theme.level,
      bucket,
      lines,
    };
    return lines;
  }
}
