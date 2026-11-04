import {
  CrewProof,
  CrewRole,
  CrewTodoStatus,
  MessageId,
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { CrewMemberReport } from "./crewLogic.ts";

const CrewReport = Schema.Struct({
  taskId: Schema.String,
  role: Schema.NullOr(CrewRole),
  status: Schema.Literals([
    "starting",
    "running",
    "completed",
    "failed",
    "interrupted",
    "partial",
    "blocked",
  ]),
  result: Schema.NullOr(Schema.String),
  report: Schema.optional(CrewMemberReport),
  proof: Schema.optional(Schema.Struct({ verdict: CrewProof, reason: Schema.String })),
});

/** The TODO list the server keeps for a task; it outlives the task's threads and a restart. */
const CrewTodoRecovery = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  check: Schema.optional(
    Schema.Struct({
      command: Schema.optional(Schema.String),
      files: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  status: CrewTodoStatus,
  note: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

export const CrewTaskRecoveryState = Schema.Struct({
  version: Schema.Literals([1]),
  taskId: Schema.String,
  leadThreadId: ThreadId,
  leadTurnId: Schema.NullOr(TurnId),
  role: CrewRole,
  subject: Schema.String,
  writeScope: Schema.optional(Schema.Array(Schema.String)),
  /** The task's own worktree, when it ran isolated; a restart before its report merges it back. */
  worktree: Schema.optional(
    Schema.Struct({
      repoRoot: Schema.String,
      path: Schema.String,
      base: Schema.String,
      cwd: Schema.String,
    }),
  ),
  /** The worktree is a candidate: a restart keeps its patch and never merges it. */
  candidate: Schema.optional(Schema.Boolean),
  /** Absent for a task without a TODO list. */
  todos: Schema.optional(Schema.Array(CrewTodoRecovery)),
  /** Ids of items the lead added that the member has not been told about yet. */
  queued: Schema.optional(Schema.Array(Schema.String)),
  /** Where file checks compare from: the workspace tree when the task started (null: unreadable). */
  todoBase: Schema.optional(
    Schema.Struct({ cwd: Schema.String, tree: Schema.NullOr(Schema.String) }),
  ),
  /** Changes outside writeScope seen by the latest check. */
  outOfScope: Schema.optional(
    Schema.Struct({
      files: Schema.Array(Schema.String),
      more: Schema.Number,
      shared: Schema.Boolean,
    }),
  ),
  attempts: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      threadId: Schema.optional(ThreadId),
      messageId: Schema.optional(MessageId),
      error: Schema.optional(Schema.String),
    }),
  ),
  /** Why the task was stopped while it ran; a restart finishes the stop instead of resuming it. */
  stopped: Schema.optional(Schema.String),
  report: Schema.NullOr(CrewReport),
  collected: Schema.Boolean,
  ended: Schema.Boolean,
  auditState: Schema.Literals(["none", "pending", "delivered", "skipped"]),
});

export const CrewTaskRecoveryJson = Schema.fromJsonString(CrewTaskRecoveryState);

export const CrewFollowUpRecoveryJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literals([1]),
    taskIds: Schema.Array(Schema.String),
    auditTaskIds: Schema.Array(Schema.String),
    command: ThreadTurnStartCommand,
  }),
);
