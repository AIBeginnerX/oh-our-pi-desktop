/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
  activityKinds: Schema.optional(Schema.Array(Schema.String)),
  limit: Schema.optional(NonNegativeInt),
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const GetLatestProjectionThreadTaskActivityInput = Schema.Struct({
  threadId: ThreadId,
  taskId: Schema.String,
});
export type GetLatestProjectionThreadTaskActivityInput =
  typeof GetLatestProjectionThreadTaskActivityInput.Type;

export const ListToolUpdatedCandidatesInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  /** When set, only updates carrying this tool call id are returned. */
  toolCallId: Schema.NullOr(Schema.String),
});
export type ListToolUpdatedCandidatesInput = typeof ListToolUpdatedCandidatesInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable). A limit selects the newest matching rows.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * List activity rows used to derive pending user-input state.
   *
   * Filters in SQLite so unrelated payloads do not enter server memory.
   */
  readonly listUserInputLifecycleByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Read the latest task-start or task-progress activity with a usable title.
   */
  readonly getLatestTaskActivity: (
    input: GetLatestProjectionThreadTaskActivityInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * List `tool.updated` rows of one turn that may belong to a tool call.
   *
   * Narrows by tool call id in SQLite when one is given; the caller applies
   * the exact matching rule.
   */
  readonly listToolUpdatedCandidates: (
    input: ListToolUpdatedCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by activity id.
   */
  readonly deleteByActivityIds: (input: {
    readonly threadId: ThreadId;
    readonly activityIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("t3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
