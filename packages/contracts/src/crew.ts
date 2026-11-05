import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CrewFallbackRoles, CrewPinnedRoles, CrewPreset } from "./orchestration.ts";

/**
 * OOP Crew: the thread's own model is the brain; it hands work to these roles through OOP's
 * crew tools, and the auditor reviews turns that changed files.
 */
export const CrewRole = Schema.Literals(["worker", "expert", "auditor"]);
export type CrewRole = typeof CrewRole.Type;

export const CREW_ROLES: ReadonlyArray<CrewRole> = ["worker", "expert", "auditor"];

/**
 * The default crew, which every thread without a crew of its own runs with. A thread's own crew
 * is `CrewThreadOverride` on the thread (`thread.crew.set`), not part of the settings.
 */
export const CrewSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  preset: CrewPreset.pipe(Schema.withDecodingDefault(Effect.succeed("recommended" as const))),
  pinned: CrewPinnedRoles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  fallbacks: CrewFallbackRoles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type CrewSettings = typeof CrewSettings.Type;

export const DEFAULT_CREW_SETTINGS: CrewSettings = {
  enabled: false,
  preset: "recommended",
  pinned: {},
  fallbacks: {},
};

/** Runs a crew task that ended without finishing again, as a new task on the same lead thread. */
export const CrewRetryTaskInput = Schema.Struct({
  leadThreadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type CrewRetryTaskInput = typeof CrewRetryTaskInput.Type;

export const CrewRetryTaskResult = Schema.Struct({ taskId: TrimmedNonEmptyString });
export type CrewRetryTaskResult = typeof CrewRetryTaskResult.Type;

export class CrewRetryTaskError extends Schema.TaggedError<CrewRetryTaskError>()(
  "CrewRetryTaskError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Stops the crew tasks of a lead thread that are still running: one task, or all of them when no
 * `taskId` is given. Only tasks started from that lead are ever touched.
 */
export const CrewStopTasksInput = Schema.Struct({
  leadThreadId: ThreadId,
  taskId: Schema.optional(TrimmedNonEmptyString),
});
export type CrewStopTasksInput = typeof CrewStopTasksInput.Type;

/**
 * The tasks that ended stopped; a task that finished before the stop landed is not listed.
 * `stopping` names the tasks that were interrupted but had not ended when the server stopped
 * waiting for them; they still end on their own. Older servers do not send it.
 */
export const CrewStopTasksResult = Schema.Struct({
  stopped: Schema.Array(TrimmedNonEmptyString),
  stopping: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type CrewStopTasksResult = typeof CrewStopTasksResult.Type;

export class CrewStopTasksError extends Schema.TaggedError<CrewStopTasksError>()(
  "CrewStopTasksError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The lead thread's activity the server appends once every task a stop reached has ended, so a
 * client or test can wait on the whole stop instead of on a timer.
 */
export const CREW_STOPPED_ACTIVITY = "crew.stopped";

/** Appended instead of `crew.stopped` when some tasks had not ended when the server stopped waiting. */
export const CREW_STOPPING_ACTIVITY = "crew.stopping";

/**
 * Where one item of a crew task's TODO list stands. The server owns the list: `verified` means a
 * server-run check passed, `claimed` means the member said it was done and nothing could prove it.
 */
export const CrewTodoStatus = Schema.Literals([
  "pending",
  "verified",
  "claimed",
  "failed",
  "blocked",
]);
export type CrewTodoStatus = typeof CrewTodoStatus.Type;

export const CrewTodoProgressItem = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: CrewTodoStatus,
});
export type CrewTodoProgressItem = typeof CrewTodoProgressItem.Type;

/**
 * What the lead thread's `task.progress` and `task.completed` activities of a crew task carry
 * when it has a TODO list, in addition to their usual fields. Clients show the counts as they
 * are; pending is `todoTotal` minus the other four.
 */
export const CrewTodoProgress = Schema.Struct({
  todos: Schema.Array(CrewTodoProgressItem),
  todoTotal: NonNegativeInt,
  todoVerified: NonNegativeInt,
  todoClaimed: NonNegativeInt,
  todoFailed: NonNegativeInt,
  todoBlocked: NonNegativeInt,
  /** Files changed outside the task's writeScope; present only when there are some. */
  outOfScope: Schema.optional(
    Schema.Struct({
      /** A bounded sample of the paths. */
      files: Schema.Array(Schema.String),
      /** How many more there were beyond `files`. */
      more: NonNegativeInt,
      /** The task shares its workspace, so the changes may be another agent's. */
      shared: Schema.Boolean,
    }),
  ),
});
export type CrewTodoProgress = typeof CrewTodoProgress.Type;

/**
 * The longest `why` the lead may give `crew_delegate` or `crew_stop`. The server puts it in the
 * `task.started` payload (`why`) and in the `crew.stopped` / `crew.stopping` payload (`why`) so a
 * decision log can show why the lead chose what it did.
 */
export const CREW_WHY_MAX_LENGTH = 300;

/**
 * Whether OOP itself could verify a finished crew task, carried as `proof` on the lead thread's
 * `task.completed` activity of a worker or expert task (an auditor's activity has `verdict`
 * instead). Only `verified` means the work is proven; `inconclusive` means nothing proved it.
 * Clients read this value and never recompute it.
 */
export const CrewProof = Schema.Literals(["verified", "not-verified", "inconclusive"]);
export type CrewProof = typeof CrewProof.Type;

/**
 * The `task.progress` activity of a crew task's TODO list always has this id, so each update
 * replaces the last one instead of adding another row.
 */
export const crewTaskProgressActivityId = (taskId: string) => `task-progress:crew:${taskId}`;
