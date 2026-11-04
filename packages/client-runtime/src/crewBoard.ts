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

/** How many of a flow's crew tasks have no final report yet, which is what Stop all would reach. */
export const runningCrewTaskCount = (
  nodes: ReadonlyArray<{
    readonly info: { readonly crew?: { readonly outcome?: string | undefined } | undefined };
  }>,
) =>
  nodes.filter((node) => node.info.crew !== undefined && node.info.crew.outcome === undefined)
    .length;

/** A crew task's TODO items by how far they got; what is none of these is pending. */
export interface CrewTodoCounts {
  readonly total: number;
  readonly verified: number;
  readonly claimed: number;
  readonly failed: number;
  readonly blocked: number;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/** The counts a task activity's payload carries; undefined without a positive `todoTotal`. */
export function crewTodoCounts(
  payload: Readonly<Record<string, unknown>>,
): CrewTodoCounts | undefined {
  const total = count(payload.todoTotal);
  if (total === undefined || total === 0) return undefined;
  return {
    total,
    verified: count(payload.todoVerified) ?? 0,
    claimed: count(payload.todoClaimed) ?? 0,
    failed: count(payload.todoFailed) ?? 0,
    blocked: count(payload.todoBlocked) ?? 0,
  };
}

/**
 * Items counted as finished: verified or claimed, never more than the total. Fills the lighter
 * part of a two-tone bar; the percent counts only `crewTodosProven`.
 */
export const crewTodosFinished = (todos: CrewTodoCounts) =>
  Math.min(todos.verified + todos.claimed, todos.total);

/** Items the server proved, never more than the total. A member's own claim is not proof. */
export const crewTodosProven = (todos: CrewTodoCounts) => Math.min(todos.verified, todos.total);

/** Whether the server could verify a finished task, as its `task.completed` activity says. */
export type CrewProofVerdict = "verified" | "not-verified" | "inconclusive";

/** The task-level proof a payload carries; undefined from an older server, which proves nothing. */
export const crewProofOf = (value: unknown): CrewProofVerdict | undefined =>
  value === "verified" || value === "not-verified" || value === "inconclusive" ? value : undefined;

/** Proven items as a whole percent, rounded down, so 100 means every item is proven. */
export const crewPercent = (done: number, total: number) =>
  total <= 0 ? 0 : Math.floor((Math.min(done, total) * 100) / total);

export interface CrewOverall {
  /** Proven items. */
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/**
 * How far a lead turn's crew got, by items: every task's proven items over all its items, a
 * task without a list counting as one item that is done when it completed and its proof is
 * "verified" or absent. An auditor never gets a proof (its verdict stands in), and an older
 * server sends none, so counting only "verified" would hold an approved crew short of 100%.
 * "not-verified" and "inconclusive" stay not done.
 * Undefined when no task has a list, because then there is nothing finer than tasks to count.
 */
export function crewOverall(
  tasks: ReadonlyArray<{
    readonly todos?: CrewTodoCounts | undefined;
    readonly outcome?: string | undefined;
    readonly proof?: CrewProofVerdict | undefined;
  }>,
): CrewOverall | undefined {
  if (!tasks.some((task) => task.todos !== undefined)) return undefined;
  let done = 0;
  let total = 0;
  for (const task of tasks) {
    done += task.todos
      ? crewTodosProven(task.todos)
      : task.outcome === "completed" && (task.proof === "verified" || task.proof === undefined)
        ? 1
        : 0;
    total += task.todos?.total ?? 1;
  }
  return { done, total, percent: crewPercent(done, total) };
}
