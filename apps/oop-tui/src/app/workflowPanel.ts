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

import { t } from "../i18n/index.ts";
import { evidenceWord, formatCost, formatTokenCount, roleName } from "../render/crewBoard.ts";
import { formatElapsed } from "../render/spinner.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { padEndVisible, truncateStyled, wrapStyled } from "../text/wrap.ts";

// ---- what `/dag-workflow` can be told ---------------------------------------------------------

export type FlowAction =
  | { readonly kind: "toggle" | "on" | "off" | "live" | "next" | "prev" }
  | { readonly kind: "pick"; readonly number: number };

export const WORKFLOW_USAGE = "/dag-workflow [on|off|N|next|prev|live]";

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
  get main() {
    return t("providers.wf.role.main");
  },
  get worker() {
    return roleName("worker");
  },
  get expert() {
    return roleName("expert");
  },
  get auditor() {
    return roleName("auditor");
  },
  get crew() {
    return t("providers.wf.role.crew");
  },
  get subagent() {
    return t("providers.wf.role.subagent");
  },
  get workflow() {
    return t("providers.wf.role.workflow");
  },
};

export const STATE_WORDS: Readonly<Record<WorkflowNodeState, string>> = {
  get pending() {
    return t("providers.wf.state.pending");
  },
  get blocked() {
    return t("providers.wf.state.blocked");
  },
  get running() {
    return t("providers.wf.state.running");
  },
  get paused() {
    return t("providers.wf.state.paused");
  },
  get completed() {
    return t("providers.wf.state.completed");
  },
  get failed() {
    return t("providers.wf.state.failed");
  },
  get cancelled() {
    return t("providers.wf.state.cancelled");
  },
  get skipped() {
    return t("providers.wf.state.skipped");
  },
};

/** Where a node stands; a crew task that stopped partway says how. */
const stateWord = (node: Pick<WorkflowNode, "state" | "info">): string => {
  if (node.state === "failed") {
    const outcome = node.info.crew?.outcome;
    if (outcome === "blocked") return t("providers.wf.blocked");
    if (outcome === "partial") return t("providers.wf.partial");
  }
  return STATE_WORDS[node.state];
};

export const DOING_WORDS: Readonly<Record<WorkflowDoing, string>> = {
  get read() {
    return t("providers.wf.doing.read");
  },
  get edit() {
    return t("providers.wf.doing.edit");
  },
  get run() {
    return t("providers.wf.doing.run");
  },
  get search() {
    return t("providers.wf.doing.search");
  },
  get web() {
    return t("providers.wf.doing.web");
  },
  get other() {
    return t("providers.wf.doing.other");
  },
  get thinking() {
    return t("providers.wf.doing.thinking");
  },
  get waiting() {
    return t("providers.wf.doing.waiting");
  },
};

export const toolWord = ({ category, count }: ToolCount): string => {
  switch (category) {
    case "read":
      return t("providers.wf.tool.read", { count });
    case "edit":
      return t("providers.wf.tool.edit", { count });
    case "run":
      return t("providers.wf.tool.run", { count });
    case "search":
      return t("providers.wf.tool.search", { count });
    case "web":
      return t("providers.wf.tool.web", { count });
    case "other":
      return t("providers.wf.tool.other", { count });
  }
};

const countsWord = (counts: WorkflowCounts): string =>
  [
    counts.completed > 0 ? t("providers.wf.counts.completed", { count: counts.completed }) : null,
    counts.failed > 0 ? t("providers.wf.counts.failed", { count: counts.failed }) : null,
    counts.stopped > 0 ? t("providers.wf.counts.stopped", { count: counts.stopped }) : null,
    counts.running > 0 ? t("providers.wf.counts.running", { count: counts.running }) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const flowName = (flow: WorkflowGraph): string => {
  if (flow.turnIndex === undefined) return flat(flow.name);
  const turn = t("providers.wf.turn", { index: flow.turnIndex });
  return flow.kind === "crew" ? `${turn} · Crew` : turn;
};

/** Column titles the shared code builds in English; a workflow's own phase titles pass through. */
const waveTitle = (title: string | undefined, index: number): string => {
  if (title === undefined || title === "") return t("providers.wf.wave", { index: index + 1 });
  if (title === "Main agent") return ROLE_WORDS.main;
  if (title === "Delegated work") return t("providers.wf.delegated");
  if (title === "Review") return t("providers.wf.review");
  if (title === "Next") return t("providers.wf.next");
  const numbered = /^(Step|Wave) (\d+)$/u.exec(title);
  if (numbered !== null)
    return t(numbered[1] === "Step" ? "providers.wf.step" : "providers.wf.wave", {
      index: numbered[2] ?? "",
    });
  return flat(title);
};

const nodeName = (node: WorkflowNode): string => {
  if (node.id.startsWith(THINKING_NODE_PREFIX)) return t("providers.wf.thinking");
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
  /** The key that flips between the Workflow and Agents tabs, named in the tab bar; none left out. */
  readonly switchKey?: string;
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

/** The facts in as few lines of `width` as they fit, none split across two. */
export const packFacts = (facts: ReadonlyArray<string>, width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const fact of facts) {
    const joined = line === "" ? fact : `${line} · ${fact}`;
    if (line !== "" && visibleWidth(joined) > width) {
      lines.push(line);
      line = fact;
    } else {
      line = joined;
    }
  }
  return line === "" ? lines : [...lines, line];
};

/** The words on top of a card: the agent's role, or the step's own label. */
const cardTitle = (node: WorkflowNode): string => {
  if (node.id.startsWith(THINKING_NODE_PREFIX)) return t("providers.wf.thinking");
  const { actor } = node.info;
  return actor === undefined ? flat(node.label) : ROLE_WORDS[actor.role];
};

/** What a card says the step does or did: the agent's task, the main agent's work, or the step's note. */
const cardBody = (node: WorkflowNode): string => {
  const { info } = node;
  const { actor } = info;
  if (actor === undefined) return flat(info.subtitle ?? info.description ?? "");
  if (actor.role === "main") {
    const work: string[] = [];
    if (actor.delegated !== undefined)
      work.push(t("providers.wf.delegatedToCrew", { count: actor.delegated }));
    for (const tool of actor.tools ?? []) work.push(toolWord(tool));
    return work.join(" · ");
  }
  return flat(actor.task ?? info.progress ?? "");
};

/** The desktop board's rule: a card is dim until its step has begun. */
const hasBegun = (node: WorkflowNode): boolean =>
  node.state === "running" ||
  node.state === "completed" ||
  node.state === "failed" ||
  node.state === "paused" ||
  node.info.startedAt !== undefined;

/**
 * One step as the desktop board's card: a frame (accent while it runs, red once it failed), the
 * state mark and the role or label with the evidence at the right, the model, what it does, and a
 * status line in the colour of its state with the time, tokens and cost.
 */
const cardBlock = (
  node: WorkflowNode,
  upstream: ReadonlyArray<WorkflowNode>,
  input: PanelInput,
  width: number,
): string[] => {
  const { style, symbols, now } = input;
  const { theme } = style;
  const { info } = node;
  const { actor } = info;
  const inner = Math.max(4, width - 4);
  const tone = paintFor(style, node.state);
  const frame =
    node.state === "running" ? theme.accent : node.state === "failed" ? theme.error : theme.dim;
  const rows: string[] = [];

  const evidence = info.evidence === undefined ? "" : ` [${evidenceWord(info.evidence)}]`;
  const title = truncateStyled(
    `${tone(symbols.flow[node.state])} ${(hasBegun(node) ? theme.text : theme.dim).bold(cardTitle(node))}`,
    Math.max(2, inner - visibleWidth(evidence)),
  );
  rows.push(title + (evidence === "" ? "" : theme.dim(evidence)));

  const model = formatSubagentModelLabel(info.model ?? null, null);
  if (model !== null && model !== "") rows.push(theme.dim(flat(model)));

  const body = cardBody(node);
  if (body !== "") {
    const paint = actor === undefined ? theme.dim : theme.text;
    const wrapped = wrapStyled(paint(body), inner);
    // An agent's task gets two lines, as on the desktop; a step's note one.
    const room = actor === undefined ? 1 : 2;
    const shown = wrapped.slice(0, room);
    const last = shown[room - 1];
    if (wrapped.length > room && last !== undefined)
      shown[room - 1] = truncateStyled(`${last}…`, inner);
    rows.push(...shown);
  }

  const doing =
    node.state === "running" && actor?.doing !== undefined ? DOING_WORDS[actor.doing] : null;
  const facts: string[] = [doing ?? stateWord(node)];
  const elapsed = nodeElapsedMs(info, now);
  if (elapsed !== undefined) facts.push(formatElapsed(elapsed));
  if (info.tokens !== undefined)
    facts.push(t("providers.wf.tokens", { count: formatTokenCount(info.tokens) }));
  if (info.costUsd !== undefined) facts.push(formatCost(info.costUsd));
  for (const line of packFacts(facts, inner)) rows.push(tone(line));

  if (actor === undefined && node.state === "running" && info.progress !== undefined)
    rows.push(theme.dim(flat(info.progress)));
  if (upstream.length > 0) {
    const names = upstream.slice(0, 3).map(nodeName);
    const more =
      upstream.length > 3 ? t("providers.wf.andMore", { count: upstream.length - 3 }) : "";
    rows.push(
      ...wrapStyled(
        theme.dim(t("providers.wf.upstream", { names: names.join(", "), more })),
        inner,
      ),
    );
  }
  if (info.error !== undefined)
    rows.push(
      ...wrapStyled(theme.error(t("providers.wf.error", { text: flat(info.error) })), inner),
    );

  const { box } = symbols;
  return [
    frame(`${box.topLeft}${box.horizontal.repeat(width - 2)}${box.topRight}`),
    ...rows.map(
      (row) =>
        `${frame(box.vertical)} ${padEndVisible(truncateStyled(row, inner), inner)} ${frame(box.vertical)}`,
    ),
    frame(`${box.bottomLeft}${box.horizontal.repeat(width - 2)}${box.bottomRight}`),
  ];
};

/** How the link into a wave looks: the desktop's edge tones, a live one over a failed one over a finished one. */
const linkTone = (
  from: ReadonlyArray<WorkflowNode>,
  to: ReadonlyArray<WorkflowNode>,
  edges: WorkflowGraph["edges"],
): "active" | "failed" | "done" | "idle" => {
  const source = new Map(from.map((node) => [node.id, node]));
  const target = new Map(to.map((node) => [node.id, node]));
  const tones = new Set(
    edges.flatMap((edge) => {
      const a = source.get(edge.from);
      const b = target.get(edge.to);
      if (a === undefined || b === undefined) return [];
      if (b.state === "running") return ["active" as const];
      if (a.state === "failed") return ["failed" as const];
      return [a.state === "completed" ? ("done" as const) : ("idle" as const)];
    }),
  );
  for (const tone of ["active", "failed", "done"] as const) if (tones.has(tone)) return tone;
  return "idle";
};

/** The two rows between waves: a line and an arrowhead, solid when taken or live, dashed otherwise. */
const connector = (tone: ReturnType<typeof linkTone>, input: PanelInput): string[] => {
  const { theme } = input.style;
  const { link } = input.symbols;
  const paint =
    tone === "active"
      ? theme.accent
      : tone === "done"
        ? theme.success
        : tone === "failed"
          ? theme.error
          : theme.dim;
  const line = tone === "idle" || tone === "failed" ? link.dashed : link.line;
  return [`  ${paint(line)}`, `  ${paint(link.arrow)}`];
};

/**
 * The flow as the desktop board draws it, waves from top to bottom: a heading with the counts,
 * a card for each step, and a connector between one wave and the next in the colour of its edges.
 */
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
    const previous = position === 0 ? undefined : columns.get(order[position - 1] ?? -1);
    if (previous !== undefined)
      lines.push(...connector(linkTone(previous, nodes, flow.edges), input));
    if (wave === current) focus = lines.length;
    // A single column needs no heading, as on the desktop board.
    if (order.length > 1) {
      const settled = nodes.filter((node) => isSettledState(node.state)).length;
      const failed = nodes.filter((node) => node.state === "failed").length;
      const running = nodes.filter((node) => node.state === "running").length;
      const heading = `${position + 1}. ${waveTitle(flow.waveTitles[wave], wave)}`;
      const paint = wave === current ? theme.accent.bold : theme.text.bold;
      const extra = [
        nodes.length > 1 ? theme.dim(t("providers.wf.parallel", { count: nodes.length })) : null,
        failed > 0 ? theme.error(t("providers.wf.counts.failed", { count: failed })) : null,
        running > 0 ? theme.accent(t("providers.wf.counts.running", { count: running })) : null,
      ].filter((part): part is string => part !== null);
      lines.push(
        truncateStyled(
          [`${paint(heading)} ${theme.dim(`${settled}/${nodes.length}`)}`, ...extra].join(
            theme.dim(" · "),
          ),
          room,
        ),
      );
    }
    for (const node of nodes)
      lines.push(...cardBlock(node, upstream.get(node.id) ?? [], input, room));
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
  if (start > 0) shown[0] = dim(t("providers.wf.above", { count: start }));
  if (end < block.lines.length)
    shown[shown.length - 1] = dim(t("providers.wf.below", { count: block.lines.length - end }));
  return shown;
};

/**
 * What every view of the side panel starts with: the desktop's tab bar (Workflow and Agents, the
 * one shown lit and underlined) with how to switch and close, and the ways to say a sentence, an
 * empty state or the link's state inside the margin.
 */
export const panelHead = (
  view: PanelView,
  input: Pick<PanelInput, "columns" | "style" | "symbols" | "switchKey">,
) => {
  const { style, symbols, columns } = input;
  const { theme } = style;
  const room = Math.max(8, columns - 2);
  const margin = (text: string) => ` ${text}`;
  const tabs: PanelView[] = ["workflow", "agents"];
  const gap = ` ${symbols.separator} `;
  const widths = tabs.map((tab) => visibleWidth(PANEL_TITLE[tab]));
  const bar = tabs
    .map((tab) => (tab === view ? theme.accent.bold : theme.dim)(PANEL_TITLE[tab]))
    .join(theme.dim(gap));
  // The longest hint that fits under the tabs.
  const close = t("providers.wf.closeWith", { command: PANEL_COMMAND[view] });
  const switchHint =
    input.switchKey === undefined ? null : t("providers.wf.switchWith", { key: input.switchKey });
  const hints = [switchHint === null ? null : `${switchHint} · ${close}`, close, switchHint].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const hint = hints.find((candidate) => visibleWidth(candidate) <= room) ?? close;
  const { full } = symbols.progress;
  const before = view === "workflow" ? 0 : (widths[0] ?? 0) + visibleWidth(gap);
  const lit = widths[tabs.indexOf(view)] ?? 0;
  const out: string[] = [
    margin(truncateStyled(bar, room)),
    margin(
      theme.dim(symbols.rule.repeat(before)) +
        theme.accent(full.repeat(lit)) +
        theme.dim(symbols.rule.repeat(Math.max(0, room - before - lit))),
    ),
    margin(truncateStyled(theme.dim(hint), room)),
  ];
  const say = (text: string) => out.push(...wrapStyled(theme.dim(text), room).map(margin));
  return {
    room,
    margin,
    out,
    say,
    /** The desktop's empty state: a mark, a title and a few words, centred in the panel. */
    empty: (title: string, text: string) => {
      const centred = (line: string) =>
        margin(" ".repeat(Math.max(0, Math.floor((room - visibleWidth(line)) / 2))) + line);
      out.push("", centred(theme.dim(symbols.brand)), centred(theme.text.bold(title)));
      for (const line of wrapStyled(theme.dim(text), Math.min(room - 4, 34)))
        out.push(centred(line));
    },
    /** While the server cannot be reached what is drawn is the last that arrived; the panel says so. */
    offline: () => out.push(margin(truncateStyled(theme.warning(t("providers.wf.offline")), room))),
  };
};

/** The workflow panel as lines for a column `columns` wide and `rows` tall. */
export const renderFlowPanel = (input: PanelInput): string[] => {
  const { style, symbols, rows } = input;
  const { theme } = style;
  const { room, margin, out, say, empty, offline } = panelHead("workflow", input);
  const { flows } = input;
  if (flows === null) {
    say(t("providers.wf.openThread"));
    return out.slice(0, rows);
  }
  if (!input.online) offline();
  if (flows.length === 0) {
    empty(t("providers.wf.emptyTitle"), t("providers.wf.empty"));
    return out.slice(0, rows);
  }

  const focusedId = focusWorkflowGraphId(flows, input.pinnedId);
  const flow = flows.find((candidate) => candidate.id === focusedId) ?? flows[0];
  if (flow === undefined) return out.slice(0, rows);

  if (flows.length > 1) {
    const { visible, earlier } = boundFlows(flows, focusedId, Math.max(1, Math.min(4, rows - 10)));
    out.push(
      margin(truncateStyled(theme.dim(t("providers.wf.flowCount", { count: flows.length })), room)),
    );
    for (const chip of visible) {
      const picked = chip.id === focusedId;
      const counts = workflowCounts(membersOf(chip));
      const mark = paintFor(style, chip.status)(symbols.flow[chip.status]);
      const text = `${picked ? theme.accent(symbols.prompt) : " "} ${flows.indexOf(chip) + 1} ${mark} ${(picked ? theme.text.bold : theme.text)(flowName(chip))}${
        counts.total === 0 ? "" : theme.dim(` ${counts.completed}/${counts.total}`)
      }${counts.failed === 0 ? "" : theme.error(` ${t("providers.wf.counts.failed", { count: counts.failed })}`)}`;
      out.push(margin(truncateStyled(text, room)));
    }
    if (earlier.length > 0)
      out.push(margin(theme.dim(t("providers.wf.earlier", { count: earlier.length }))));
  }

  const counts = workflowCounts(membersOf(flow));
  const mark = paintFor(style, flow.status)(symbols.flow[flow.status]);
  const kind = flow.kind === "workflow" ? theme.dim(` · ${t("providers.wf.role.workflow")}`) : "";
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
    if (flows === null || flows.length === 0) return t("providers.wf.noFlows");
    let index: number;
    if (action.kind === "pick") {
      if (action.number < 1 || action.number > flows.length) {
        return t("providers.wf.flowRange", { max: flows.length });
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
      memo.input.switchKey === full.switchKey &&
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
