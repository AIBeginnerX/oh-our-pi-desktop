import {
  DEFAULT_THREAD_GOAL_MAX_CONTINUES,
  type OrchestrationThread,
  type ThreadGoal,
  type ThreadGoals,
  type ThreadId,
} from "@t3tools/contracts";
import { threadGoalProgress } from "@t3tools/shared/threadGoal";
import { t } from "../i18n/index.ts";

export const GOAL_MAX_CONTINUES_RANGE = { min: 1, max: 20 } as const;

export type GoalState = "working" | "met" | "blocked" | "stopped";

export interface GoalView {
  readonly state: GoalState;
  /** Automatic continuations seen for this goal. */
  readonly continues: number;
  /**
   * The thread was loaded in a window that starts after the goal was set, so continuations from
   * before it are not counted: `continues` is then "at least".
   */
  readonly partial: boolean;
  readonly reason?: string;
}

export const goalStateWord = (state: GoalState): string => {
  switch (state) {
    case "working":
      return t("session.goal.working");
    case "met":
      return t("session.goal.met");
    case "blocked":
      return t("session.goal.blocked");
    case "stopped":
      return t("session.goal.stopped");
  }
};

/** The goal as it is saved: new id (so earlier progress never counts), active, set now. */
export const makeGoal = (input: {
  readonly text: string;
  readonly maxContinues?: number;
  readonly id: string;
  readonly now: Date;
}): ThreadGoal => ({
  id: input.id,
  text: input.text.trim(),
  maxContinues: input.maxContinues ?? DEFAULT_THREAD_GOAL_MAX_CONTINUES,
  active: true,
  setAt: input.now.toISOString(),
});

/** `goals` with this thread's goal set; every other thread's stays as it is. */
export const goalsWith = (
  goals: ThreadGoals,
  threadId: ThreadId,
  goal: ThreadGoal,
): ThreadGoals => ({
  ...goals,
  [threadId]: goal,
});

/** `goals` without this thread's goal: stopping a goal removes its key. */
export const goalsWithout = (goals: ThreadGoals, threadId: ThreadId): ThreadGoals => {
  const { [threadId]: _removed, ...rest } = goals;
  return rest;
};

/** The count in `/goal max <n>`: a whole number from 1 to 20, else null. */
export const parseGoalMax = (word: string): number | null => {
  if (!/^\d+$/u.test(word)) return null;
  const value = Number(word);
  return value >= GOAL_MAX_CONTINUES_RANGE.min && value <= GOAL_MAX_CONTINUES_RANGE.max
    ? value
    : null;
};

/** The earliest time the loaded part of the thread says anything about, as epoch milliseconds. */
const earliestLoaded = (thread: OrchestrationThread): number => {
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of [...thread.messages, ...thread.activities]) {
    const at = Date.parse(entry.createdAt);
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return earliest;
};

/**
 * How the goal is going, from the activities the server appended for it. A finished verdict is
 * recent, so the loaded window always has it; only the count of continuations can be short when
 * the window starts after the goal was set.
 */
export const goalViewOf = (
  goal: ThreadGoal,
  thread: OrchestrationThread,
  hasOlder: boolean,
): GoalView => {
  const progress = threadGoalProgress(goal, thread.activities);
  const partial = hasOlder && earliestLoaded(thread) > Date.parse(goal.setAt);
  const state: GoalState = !goal.active
    ? "stopped"
    : progress.status === "exhausted"
      ? "stopped"
      : progress.status;
  return {
    state,
    continues: progress.continues,
    partial,
    ...(progress.blockedReason === undefined ? {} : { reason: progress.blockedReason }),
  };
};

/**
 * The few words the status bar keeps: `Goal 2/5`, `Goal 2+/5`, `Goal met`. A null view is a thread
 * that is not loaded yet, whose progress is not known, so the count is a `?`.
 */
export const goalBarText = (goal: ThreadGoal, view: GoalView | null): string => {
  if (view === null) return t("session.goal.barUnknown", { max: goal.maxContinues });
  if (view.state === "working") {
    return t("session.goal.barCount", {
      n: view.continues,
      plus: view.partial ? "+" : "",
      max: goal.maxContinues,
    });
  }
  return t("session.goal.barState", { state: goalStateWord(view.state) });
};
