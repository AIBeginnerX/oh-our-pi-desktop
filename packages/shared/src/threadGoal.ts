import {
  PROVIDER_DIFF_CHECKPOINT_REF_PREFIX,
  type OrchestrationThreadActivity,
  type ThreadGoal,
} from "@t3tools/contracts";

/** Activity kinds the server appends as a thread goal advances; payloads carry `goalId`. */
export const THREAD_GOAL_ACTIVITY = {
  continued: "goal.continued",
  met: "goal.met",
  blocked: "goal.blocked",
  exhausted: "goal.exhausted",
} as const;

export type ThreadGoalStatus = "working" | "met" | "blocked" | "exhausted";

export interface ThreadGoalProgress {
  readonly status: ThreadGoalStatus;
  /** Automatic continuations OOP has sent for this goal. */
  readonly continues: number;
  readonly blockedReason?: string;
  /** Turns whose end OOP already acted on, so one turn is never handled twice. */
  readonly handledTurnIds: ReadonlySet<string>;
}

export type ThreadGoalVerdict =
  | { readonly kind: "met" }
  | { readonly kind: "blocked"; readonly reason: string };

const GOAL_COMPLETE = /^GOAL COMPLETE\.?$/i;
const GOAL_BLOCKED = /^GOAL BLOCKED\s*(?:[:\-–—]\s*(.*))?$/i;

/**
 * The agent's verdict from the end of its reply. The marker must be a line of its own among the
 * last few lines, ignoring Markdown emphasis, so a reply that only mentions it does not count.
 */
export function threadGoalVerdict(reply: string): ThreadGoalVerdict | null {
  const lines = [...reply.trimEnd().split(/\r?\n/).slice(-5)].reverse();
  for (const raw of lines) {
    const line = raw.trim().replace(/^[>*_`#\s-]+|[*_`\s]+$/g, "");
    if (GOAL_COMPLETE.test(line)) return { kind: "met" };
    const blocked = GOAL_BLOCKED.exec(line);
    if (blocked) return { kind: "blocked", reason: blocked[1]?.trim() || "No reason given" };
  }
  return null;
}

/** Progress of `goal` from the activities the server appended for it. */
export function threadGoalProgress(
  goal: Pick<ThreadGoal, "id">,
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): ThreadGoalProgress {
  let status: ThreadGoalStatus = "working";
  let continues = 0;
  let blockedReason: string | undefined;
  const handledTurnIds = new Set<string>();
  for (const activity of activities) {
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const { goalId, turnId, reason } = payload as Record<string, unknown>;
    if (goalId !== goal.id) continue;
    if (typeof turnId === "string") handledTurnIds.add(turnId);
    switch (activity.kind) {
      case THREAD_GOAL_ACTIVITY.continued:
        continues += 1;
        break;
      case THREAD_GOAL_ACTIVITY.met:
        status = "met";
        break;
      case THREAD_GOAL_ACTIVITY.blocked:
        status = "blocked";
        blockedReason = typeof reason === "string" ? reason : undefined;
        break;
      case THREAD_GOAL_ACTIVITY.exhausted:
        status = "exhausted";
        break;
    }
  }
  return {
    status,
    continues,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    handledTurnIds,
  };
}

/** The crew records a turn it left unaudited, so a goal waiting on that audit stops waiting. */
export const CREW_AUDIT_SKIPPED_ACTIVITY = "crew.audit-skipped";

/** Crew and diff-capture activity kinds the goal reads from the lead thread. */
export const THREAD_GOAL_CREW_ACTIVITY_KINDS = [
  "task.started",
  "task.completed",
  "crew.follow-up",
  "checkpoint.capture.failed",
  CREW_AUDIT_SKIPPED_ACTIVITY,
] as const;

/**
 * - `clear`: the goal may judge the turn now.
 * - `wait`: the turn's diff or its audit is still on its way.
 * - `crew-pending`: a Crew follow-up turn is queued and continues the thread itself.
 * - `needs-changes`: the latest audit since the goal was set still asks for changes.
 */
export type ThreadGoalCrewGate = "clear" | "wait" | "crew-pending" | "needs-changes";

/**
 * Whether the goal may judge the lead's `turnId` yet. With audits on, a turn that changed files is
 * judged only after its audit, so `GOAL COMPLETE` never outruns a "needs changes" verdict, and a
 * goal continuation never races a Crew follow-up for the same request.
 *
 * Every wait has an end the server records: a diff either lands or leaves
 * `checkpoint.capture.failed`, and an audit that fails or cannot start still ends with a
 * `task.completed` without a verdict, which does not hold the goal. A turn the crew left unaudited
 * says so with `crew.audit-skipped`. Work in flight when the server stopped never ends, so a turn
 * from before the restart waits for nothing.
 *
 * An audit of any turn that is still running also holds the goal: a later turn that changed nothing
 * would otherwise be judged on an older verdict that the running audit is about to replace.
 */
export function threadGoalCrewGate(input: {
  readonly turnId: string;
  /** Crew is on for the thread and staffs an auditor, so changed turns get audited. */
  readonly auditsTurns: boolean;
  /** The workspace is a git repository, so the turn's diff gets captured. */
  readonly diffExpected: boolean;
  /**
   * The turn ended before this server started. Its diff capture, audit, and Crew follow-up lived in
   * the old server's memory.
   */
  readonly turnPredatesServer: boolean;
  /** When the goal was set; earlier audits do not count. */
  readonly since: string;
  /** When this server started; audits started before it never end, so they hold nothing. */
  readonly liveSince: string | null;
  readonly checkpoints: ReadonlyArray<{
    readonly turnId: string;
    readonly checkpointRef: string;
    readonly files: ReadonlyArray<unknown>;
  }>;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "turnId" | "payload" | "createdAt">
  >;
}): ThreadGoalCrewGate {
  const since = Date.parse(input.since);
  let followUpQueued = false;
  let captureFailed = false;
  let auditSkipped = false;
  let latestAuditAt = Number.NEGATIVE_INFINITY;
  let changesAsked = false;
  const liveSince =
    input.liveSince === null ? Number.NEGATIVE_INFINITY : Date.parse(input.liveSince);
  const started = new Set<string>();
  const ended = new Set<string>();
  // Audits of any turn: those started since this server, and every one that ended.
  const running = new Set<string>();
  const finished = new Set<string>();
  for (const activity of input.activities) {
    const ofTurn = activity.turnId === input.turnId;
    if (ofTurn && activity.kind === "crew.follow-up") followUpQueued = true;
    if (ofTurn && activity.kind === "checkpoint.capture.failed") captureFailed = true;
    if (ofTurn && activity.kind === CREW_AUDIT_SKIPPED_ACTIVITY) auditSkipped = true;
    const payload = activity.payload as {
      readonly crewRole?: unknown;
      readonly taskId?: unknown;
      readonly verdict?: unknown;
    } | null;
    if (payload?.crewRole !== "auditor" || typeof payload.taskId !== "string") continue;
    const at = Date.parse(activity.createdAt);
    if (activity.kind === "task.started") {
      if (ofTurn) started.add(payload.taskId);
      // Even an audit started before the goal holds it: its verdict lands after `since`.
      if (at >= liveSince) running.add(payload.taskId);
    }
    if (activity.kind !== "task.completed") continue;
    finished.add(payload.taskId);
    if (ofTurn) ended.add(payload.taskId);
    if (at >= since && at >= latestAuditAt) {
      latestAuditAt = at;
      changesAsked = payload.verdict === "needs-changes";
    }
  }
  const live = !input.turnPredatesServer;
  if (live && followUpQueued) return "crew-pending";
  if (!input.auditsTurns) return "clear";
  if ([...running].some((taskId) => !finished.has(taskId))) return "wait";
  if (live) {
    // A provider-reported diff leaves a placeholder until git captures the turn.
    const checkpoint = input.checkpoints.find(
      (entry) =>
        entry.turnId === input.turnId &&
        !entry.checkpointRef.startsWith(PROVIDER_DIFF_CHECKPOINT_REF_PREFIX),
    );
    if (checkpoint === undefined) {
      if (input.diffExpected && !captureFailed) return "wait";
    } else if (
      checkpoint.files.length > 0 &&
      !auditSkipped &&
      (ended.size === 0 || [...started].some((taskId) => !ended.has(taskId)))
    ) {
      return "wait";
    }
  }
  return changesAsked ? "needs-changes" : "clear";
}

/** Told to the agent with the user's turns while the goal is open. */
export function threadGoalNote(goal: Pick<ThreadGoal, "text">): string {
  return [
    "<thread_goal>",
    `The user set this goal for the thread: ${goal.text}`,
    "Keep working until it is fully done and verified, running the relevant tests or checks. OOP continues the thread automatically while the goal is open.",
    "When it is done and verified, end your final reply with a line that says exactly: GOAL COMPLETE",
    "If you cannot continue without the user, end it with: GOAL BLOCKED: <what you need>",
    "</thread_goal>",
  ].join("\n");
}

/** The user message OOP sends for an automatic continuation. */
export function threadGoalContinuePrompt(
  goal: Pick<ThreadGoal, "text" | "maxContinues">,
  attempt: number,
): string {
  return [
    `Continue working toward the thread goal (automatic continuation ${attempt} of ${goal.maxContinues}): ${goal.text}`,
    "Pick up where you left off. When it is done and verified, end with GOAL COMPLETE on its own line; if you need the user, end with GOAL BLOCKED: <what you need>.",
  ].join("\n");
}
