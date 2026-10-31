import { CREW_ROLE_LABEL } from "@t3tools/shared/crew";

import type { CrewBoard, CrewTask } from "../app/crewBoard.ts";
import { formatElapsed } from "./spinner.ts";

/** Words for the crew board; every function returns plain text, which the caller paints. */

const PHASE_WORD = {
  running: "진행 중",
  completed: "완료",
  partial: "일부 완료",
  blocked: "차단됨",
  failed: "실패",
  stopped: "중단됨",
} as const;

const EVIDENCE_WORD = {
  reported: "보고만 있음",
  tested: "테스트 통과",
  audited: "감사 승인",
} as const;

/** How far a finished task's result can be trusted, in words. */
export const evidenceWord = (evidence: keyof typeof EVIDENCE_WORD): string =>
  EVIDENCE_WORD[evidence];

/** The word for the `status` a crew task activity carries; null for one this does not know. */
export const crewStatusWord = (status: unknown): string | null =>
  typeof status === "string" && Object.hasOwn(PHASE_WORD, status)
    ? PHASE_WORD[status as keyof typeof PHASE_WORD]
    : null;

/** What the crew says when it leaves an audit out: the change was small and its tests passed. */
export const auditSkippedText = (changedFiles: unknown): string =>
  `감사 생략: 작은 변경이고 테스트가 통과했습니다${typeof changedFiles === "number" ? ` (파일 ${changedFiles}개)` : ""}`;

/** What the crew says when it hands a result to the lead as a new turn. */
export const followUpText = (reason: unknown): string =>
  reason === "audit"
    ? "감사가 수정을 요청해 lead 에게 후속 턴을 보냈습니다"
    : "crew 결과를 lead 에게 후속 턴으로 전달했습니다";

export const roleName = (role: string): string =>
  (CREW_ROLE_LABEL as Record<string, string | undefined>)[role] ?? role;

export const phaseWord = (task: CrewTask): string =>
  task.phase === "stopped" && task.unreported ? "중단됨 · 보고 없음" : PHASE_WORD[task.phase];

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
  const tokens = `${formatTokenCount(task.tokens)} 토큰`;
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
    ["작업", task.title ?? "(제목 없음)"],
    ["역할", roleName(task.role)],
    [
      "상태",
      `${phaseWord(task)}${waiting === null ? "" : waiting === "approval" ? " · 승인 대기" : " · 질문 대기"}`,
    ],
  ];
  if (task.model !== null) rows.push(["모델", task.model]);
  const elapsed = taskElapsed(task, now);
  if (elapsed !== null) rows.push(["경과", elapsed]);
  const usage = taskUsage(task);
  if (usage !== null) rows.push(["사용량", usage]);
  if (task.evidence !== null) rows.push(["근거", evidenceWord(task.evidence)]);
  if (task.summary !== null) rows.push(["요약", task.summary]);
  return rows;
};

/** One line over the whole board: how many tasks, in what state, and what they used. */
export const boardSummary = (board: CrewBoard): string => {
  const parts = [
    `${board.current ? "이번 턴" : "이전 턴"} · 작업 ${board.tasks.length}개`,
    board.running > 0 ? `진행 ${board.running}` : null,
    board.settled > 0 ? `끝남 ${board.settled}` : null,
  ];
  if (board.usage !== null) {
    parts.push(
      `${formatTokenCount(board.usage.tokens)} 토큰${board.usage.costUsd === null ? "" : ` · ${formatCost(board.usage.costUsd)}`}`,
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
  if (input.waiting > 0) return `crew 승인·질문 대기 ${input.waiting}`;
  const running = input.board !== null && input.board.running > 0;
  if (running && input.board !== null)
    return `crew ${input.board.settled}/${input.board.tasks.length}`;
  return input.on ? "crew" : null;
};
