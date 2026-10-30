import { CrewRole, MessageId, ThreadId, ThreadTurnStartCommand, TurnId } from "@t3tools/contracts";
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
  attempts: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      threadId: Schema.optional(ThreadId),
      messageId: Schema.optional(MessageId),
      error: Schema.optional(Schema.String),
    }),
  ),
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
