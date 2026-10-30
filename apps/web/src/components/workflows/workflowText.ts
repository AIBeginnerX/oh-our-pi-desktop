/**
 * Plain-language text for the work flow panels. The client-runtime flows stay language-neutral
 * (roles, tool categories, counts); this is where they become words a person reads.
 */
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  ToolCategory,
  ToolCount,
  WorkflowActorRole,
  WorkflowCounts,
  WorkflowDoing,
  WorkflowGraph,
  WorkflowNode,
} from "@t3tools/client-runtime/workflow-graph";

import type { TranslationValues } from "~/i18n";

export type Translate = (text: string, values?: TranslationValues) => string;

const ROLE_NAMES: Readonly<Record<WorkflowActorRole, string>> = {
  main: "Main agent",
  worker: "Worker",
  expert: "Expert",
  auditor: "Auditor",
  crew: "Crew member",
  subagent: "Subagent",
  workflow: "Workflow",
};

export function roleText(role: WorkflowActorRole, t: Translate): string {
  return t(ROLE_NAMES[role]);
}

/** "claude-opus-5-5-20260101" reads as "opus-5-5". */
export function modelText(model: string | undefined): string | undefined {
  return formatSubagentModelLabel(model ?? null, null) ?? undefined;
}

/** One category of tool work with its count: "Read 8 files", "Ran a command". */
function toolCountText({ category, count }: ToolCount, t: Translate): string {
  const once = count === 1;
  switch (category) {
    case "read":
      return once ? t("Read 1 file") : t("Read {count} files", { count });
    case "edit":
      return once ? t("Edited 1 file") : t("Edited {count} files", { count });
    case "run":
      return once ? t("Ran 1 command") : t("Ran {count} commands", { count });
    case "search":
      return once ? t("Searched once") : t("Searched {count} times", { count });
    case "web":
      return once ? t("Searched the web once") : t("Searched the web {count} times", { count });
    case "other":
      return once ? t("Used 1 other tool") : t("Used {count} other tools", { count });
  }
}

/** "Read 8 files · Ran 3 commands · Edited 2 files"; empty when nothing was used. */
export function toolSummaryText(tools: ReadonlyArray<ToolCount>, t: Translate): string {
  return tools.map((tool) => toolCountText(tool, t)).join(" · ");
}

const DOING_TEXT: Readonly<Record<ToolCategory | "thinking" | "waiting", string>> = {
  read: "Reading files…",
  edit: "Editing files…",
  run: "Running a command…",
  search: "Searching…",
  web: "Searching the web…",
  other: "Using a tool…",
  thinking: "Thinking…",
  waiting: "Waiting for the team…",
};

export function doingText(doing: WorkflowDoing, t: Translate): string {
  return t(DOING_TEXT[doing]);
}

/** Where a node stands, in plain words; a crew task that stopped partway says how. */
export function stateText(node: Pick<WorkflowNode, "state" | "info">, t: Translate): string {
  switch (node.state) {
    case "running":
      return t("Working");
    case "completed":
      return t("Done");
    case "failed":
      return node.info.crew?.outcome === "blocked"
        ? t("Blocked")
        : node.info.crew?.outcome === "partial"
          ? t("Partial")
          : t("Failed");
    case "cancelled":
      return t("Stopped");
    case "blocked":
      return t("Waiting");
    case "paused":
      return t("Paused");
    case "pending":
      return t("Not started");
    case "skipped":
      return t("Skipped");
  }
}

export interface NodeText {
  readonly title: string;
  readonly model: string | undefined;
  /** What the node does or did: the task, or the main agent's work by category. */
  readonly body: string | undefined;
  /** The state line; a running main agent says what it is doing now. */
  readonly status: string;
}

/** A node's card text. Agent nodes read as who, with which model, doing what; steps as before. */
export function nodeText(node: WorkflowNode, t: Translate): NodeText {
  const { actor } = node.info;
  if (actor === undefined) {
    return {
      title: node.label,
      model: undefined,
      body: node.info.subtitle ?? node.info.description,
      status: stateText(node, t),
    };
  }
  const delegated =
    actor.delegated === undefined
      ? ""
      : actor.delegated === 1
        ? t("Handed 1 task to the crew")
        : t("Handed {count} tasks to the crew", { count: actor.delegated });
  const tools = [delegated, actor.tools === undefined ? "" : toolSummaryText(actor.tools, t)]
    .filter(Boolean)
    .join(" · ");
  return {
    title: roleText(actor.role, t),
    model: modelText(node.info.model),
    body: actor.role === "main" ? tools || undefined : (actor.task ?? node.info.progress),
    status:
      node.state === "running" && actor.doing !== undefined
        ? doingText(actor.doing, t)
        : stateText(node, t),
  };
}

/** The name a flow goes by: its turn number, or the workflow's own name. */
export function flowName(flow: WorkflowGraph, t: Translate): string {
  if (flow.turnIndex === undefined) return flow.name;
  return flow.kind === "crew"
    ? t("Turn {number} · Crew", { number: flow.turnIndex })
    : t("Turn {number}", { number: flow.turnIndex });
}

/** Column titles the client-runtime builds in English; a workflow's own phase titles pass through. */
export function waveTitleText(title: string, t: Translate): string {
  const numbered = /^(Step|Wave) (\d+)$/.exec(title);
  if (numbered?.[1] === "Step") return t("Step {number}", { number: numbered[2] ?? "" });
  if (numbered?.[1] === "Wave") return t("Wave {number}", { number: numbered[2] ?? "" });
  return t(title);
}

/** "3 done · 1 failed · 1 running", leaving out what is zero. */
export function countsText(
  counts: Pick<WorkflowCounts, "completed" | "failed" | "stopped" | "running">,
  t: Translate,
): string {
  return [
    counts.completed > 0 ? t("{count} done", { count: counts.completed }) : null,
    counts.failed > 0 ? t("{count} failed", { count: counts.failed }) : null,
    counts.stopped > 0 ? t("{count} stopped", { count: counts.stopped }) : null,
    counts.running > 0 ? t("{count} running", { count: counts.running }) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** What a node is called in a sentence: "Worker · Fix the tests", or the step's own label. */
export function nodeName(node: WorkflowNode, t: Translate): string {
  const { actor } = node.info;
  return actor === undefined
    ? node.label
    : [roleText(actor.role, t), actor.task].filter(Boolean).join(" · ");
}
