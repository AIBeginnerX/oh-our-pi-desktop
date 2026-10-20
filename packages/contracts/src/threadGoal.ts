import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A goal the user set for a thread. While it is active, OOP tells the agent the goal and
 * continues the thread automatically after each completed turn until the agent reports the
 * goal complete or blocked, or `maxContinues` automatic turns have run.
 */
export const ThreadGoal = Schema.Struct({
  /** New for every goal set, so progress from an earlier goal never counts toward this one. */
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  maxContinues: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  active: Schema.Boolean,
  setAt: IsoDateTime,
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoals = Schema.Record(ThreadId, ThreadGoal);
export type ThreadGoals = typeof ThreadGoals.Type;

export const DEFAULT_THREAD_GOAL_MAX_CONTINUES = 5;
