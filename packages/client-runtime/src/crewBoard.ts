/**
 * What the crew board says about a crew task's result and its cost. Pure: derived from the task
 * activities the lead thread already holds.
 */

/**
 * How far a finished task's result can be trusted. There is no "done": a report is only a claim
 * until a test run or an approving audit backs it.
 */
export type CrewEvidence = "reported" | "tested" | "audited";

export interface CrewEvidenceTask {
  readonly id: string;
  readonly role: string;
  /** The task.completed status; absent while the task runs. */
  readonly outcome?: string | undefined;
  /** The crew thread ended on a passing test run, or its report said its verification passed. */
  readonly tested?: boolean | undefined;
  readonly completedAt?: string | undefined;
  /** The auditor's verdict, on audit tasks. */
  readonly verdict?: string | undefined;
}

/**
 * Evidence for each worker or expert task of one lead turn that completed or finished part of its
 * work. A task is audited when the latest audit that finished after it approved, tested when its
 * own run passed tests, reported otherwise. Failed, blocked, and stopped tasks, and ones still
 * running, get none.
 */
export function crewEvidence(
  tasks: ReadonlyArray<CrewEvidenceTask>,
): ReadonlyMap<string, CrewEvidence> {
  const audits = tasks
    .filter(
      (task) =>
        task.role === "auditor" && task.outcome === "completed" && task.completedAt !== undefined,
    )
    // `.filter()` returned a fresh array, and Hermes has no `toSorted`.
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  const evidence = new Map<string, CrewEvidence>();
  for (const task of tasks) {
    if (task.role === "auditor" || task.completedAt === undefined) continue;
    if (task.outcome !== "completed" && task.outcome !== "partial") continue;
    const completedAt = task.completedAt;
    const latestAudit = audits.findLast((audit) => (audit.completedAt ?? "") > completedAt);
    evidence.set(
      task.id,
      latestAudit?.verdict === "approve" ? "audited" : task.tested === true ? "tested" : "reported",
    );
  }
  return evidence;
}

export interface CrewTaskUsage {
  readonly tokens: number;
  /** Only when the provider reported a cost; never estimated. */
  readonly costUsd?: number | undefined;
}

export interface CrewTurnUsage {
  readonly tokens: number;
  /** The reported costs added up; absent when no task reported one. */
  readonly costUsd?: number;
  /** Some task used tokens without a reported cost, so `costUsd` is a floor. */
  readonly unpriced: boolean;
}

/** The crew total of one lead turn, or null when no task has usage. */
export function crewTurnUsage(
  usages: ReadonlyArray<CrewTaskUsage | undefined>,
): CrewTurnUsage | null {
  const used = usages.filter((usage) => usage !== undefined);
  if (used.length === 0) return null;
  const priced = used.flatMap((usage) => usage.costUsd ?? []);
  return {
    tokens: used.reduce((total, usage) => total + usage.tokens, 0),
    ...(priced.length > 0 ? { costUsd: priced.reduce((total, cost) => total + cost, 0) } : {}),
    unpriced: priced.length < used.length,
  };
}

export interface CrewTaskActions {
  /** The task has no final report yet and its thread is known. */
  readonly stop: boolean;
  readonly open: boolean;
  /** A worker or expert task that ended without finishing; an audit runs again with the next change. */
  readonly retry: boolean;
}

const RETRYABLE_OUTCOMES: ReadonlySet<string> = new Set([
  "failed",
  "stopped",
  "blocked",
  "partial",
]);

/** Which of Stop, Open, and Retry a crew task offers. */
export function crewTaskActions(task: {
  readonly role: string;
  readonly threadId?: string | undefined;
  readonly outcome?: string | undefined;
}): CrewTaskActions {
  return {
    stop: task.outcome === undefined && task.threadId !== undefined,
    open: task.threadId !== undefined,
    retry:
      task.role !== "auditor" && task.outcome !== undefined && RETRYABLE_OUTCOMES.has(task.outcome),
  };
}
