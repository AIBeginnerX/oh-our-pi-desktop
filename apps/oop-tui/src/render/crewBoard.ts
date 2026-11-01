import { CREW_ROLE_LABEL } from "@t3tools/shared/crew";

import type { CrewBoard, CrewTask } from "../app/crewBoard.ts";
import { t, type MessageKey } from "../i18n/index.ts";
import { formatElapsed } from "./spinner.ts";

/** Words for the crew board; every function returns plain text, which the caller paints. */

const PHASE_KEY = {
  running: "render.crew.phase.running",
  completed: "render.crew.phase.completed",
  partial: "render.crew.phase.partial",
  blocked: "render.crew.phase.blocked",
  failed: "render.crew.phase.failed",
  stopped: "render.crew.phase.stopped",
} as const satisfies Record<string, MessageKey>;

const EVIDENCE_KEY = {
  reported: "render.crew.evidence.reported",
  tested: "render.crew.evidence.tested",
  audited: "render.crew.evidence.audited",
} as const satisfies Record<string, MessageKey>;

/** How far a finished task's result can be trusted, in words. */
export const evidenceWord = (evidence: keyof typeof EVIDENCE_KEY): string =>
  t(EVIDENCE_KEY[evidence]);

/** The word for the `status` a crew task activity carries; null for one this does not know. */
export const crewStatusWord = (status: unknown): string | null =>
  typeof status === "string" && Object.hasOwn(PHASE_KEY, status)
    ? t(PHASE_KEY[status as keyof typeof PHASE_KEY])
    : null;

/** What the crew says when it leaves an audit out: the change was small and its tests passed. */
export const auditSkippedText = (changedFiles: unknown): string =>
  t("render.crew.auditSkipped", {
    files:
      typeof changedFiles === "number"
        ? t("render.crew.auditSkippedFiles", { count: changedFiles })
        : "",
  });

/** What the crew says when it hands a result to the lead as a new turn. */
export const followUpText = (reason: unknown): string =>
  reason === "audit" ? t("render.crew.followUpAudit") : t("render.crew.followUp");

export const roleName = (role: string): string =>
  (CREW_ROLE_LABEL as Record<string, string | undefined>)[role] ?? role;

export const phaseWord = (task: CrewTask): string =>
  task.phase === "stopped" && task.unreported
    ? t("render.crew.stoppedUnreported")
    : t(PHASE_KEY[task.phase]);

export const formatTokenCount = (count: number): string =>
  count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/u, "")}k`;

export const formatCost = (usd: number): string =>
  usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;

/** How long the task has run (still running) or ran (settled); null when its start is unknown. */
export const taskElapsed = (task: CrewTask, now: number): string | null => {
  if (task.startedAt === null) return null;
  const end = task.phase === "running" ? now : task.completedAt;
  return end === null ? null : formatElapsed(Math.max(0, end - task.startedAt));
};

/** Tokens, and the cost when the provider reported one. */
export const taskUsage = (task: CrewTask): string | null => {
  if (task.tokens === null) return null;
  const tokens = t("render.crew.tokens", { count: formatTokenCount(task.tokens) });
  return task.costUsd === null ? tokens : `${tokens} · ${formatCost(task.costUsd)}`;
};

/** `Worker 진행 중` for a board row; the task's own name comes after it. */
export const taskHeadline = (task: CrewTask): string =>
  `${roleName(task.role)}  ${phaseWord(task)}${task.title === null ? "" : ` · ${task.title}`}`;

/** The dim part of a board row: model, time, usage. */
export const taskNote = (task: CrewTask, now: number): string =>
  [task.model, taskElapsed(task, now), taskUsage(task)]
    .filter((part): part is string => part !== null)
    .join(" · ");

/** The lines of one task's detail screen, each a `name  value` pair; wrapping is left to the caller. */
export const taskDetail = (
  task: CrewTask,
  now: number,
  waiting: "approval" | "input" | null,
): ReadonlyArray<readonly [string, string]> => {
  const rows: Array<readonly [string, string]> = [
    [t("render.crew.field.task"), task.title ?? t("render.crew.untitled")],
    [t("render.crew.field.role"), roleName(task.role)],
    [
      t("render.crew.field.status"),
      `${phaseWord(task)}${waiting === null ? "" : waiting === "approval" ? t("render.crew.waitApproval") : t("render.crew.waitInput")}`,
    ],
  ];
  if (task.model !== null) rows.push([t("render.crew.field.model"), task.model]);
  const elapsed = taskElapsed(task, now);
  if (elapsed !== null) rows.push([t("render.crew.field.elapsed"), elapsed]);
  const usage = taskUsage(task);
  if (usage !== null) rows.push([t("render.crew.field.usage"), usage]);
  if (task.evidence !== null)
    rows.push([t("render.crew.field.evidence"), evidenceWord(task.evidence)]);
  if (task.summary !== null) rows.push([t("render.crew.field.summary"), task.summary]);
  return rows;
};

/** One line over the whole board: how many tasks, in what state, and what they used. */
export const boardSummary = (board: CrewBoard): string => {
  const parts = [
    t("render.crew.boardCount", {
      turn: board.current ? t("render.crew.thisTurn") : t("render.crew.prevTurn"),
      count: board.tasks.length,
    }),
    board.running > 0 ? t("render.crew.running", { count: board.running }) : null,
    board.settled > 0 ? t("render.crew.settled", { count: board.settled }) : null,
  ];
  if (board.usage !== null) {
    parts.push(
      `${t("render.crew.tokens", { count: formatTokenCount(board.usage.tokens) })}${board.usage.costUsd === null ? "" : ` · ${formatCost(board.usage.costUsd)}`}`,
    );
  }
  return parts.filter((part): part is string => part !== null).join(" · ");
};

/**
 * What the status bar says about the crew: nothing when it is off and idle, `crew` when it is on,
 * `crew 2/3` (tasks that ended out of all of them) while a task runs, and a request that waits for
 * the user is named, since the thread on screen shows no sign of it.
 */
export const crewBarText = (input: {
  readonly on: boolean;
  readonly board: CrewBoard | null;
  readonly waiting: number;
}): string | null => {
  if (input.waiting > 0) return t("render.crew.barWaiting", { count: input.waiting });
  const running = input.board !== null && input.board.running > 0;
  if (running && input.board !== null)
    return `crew ${input.board.settled}/${input.board.tasks.length}`;
  return input.on ? "crew" : null;
};
