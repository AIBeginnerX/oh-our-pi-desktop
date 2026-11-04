import {
  ChatAttachment,
  OrchestrationMessageContext,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationProposedPlanId,
  OrchestrationThreadSearchSource,
  ProjectScript,
  ProjectIconOverride,
  TurnId,
  CrewThreadOverride,
  ModelSelection,
  ProjectId,
  ThreadLinkedPullRequest,
  ThreadTitleState,
  ThreadId,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadPullRequest } from "../../persistence/ProjectionThreadPullRequests.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
// Keep detail reads consistent with the in-memory projector's retained
// activity window. Applying the limit in SQL avoids decoding an unbounded
// payload_json set before the projector can enforce that invariant.
export const THREAD_DETAIL_ACTIVITY_LIMIT = 500;
// SQLite trim defaults to spaces. Match the whitespace removed by String.trim.
export const MESSAGE_TRIM_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
export const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    autoPull: Schema.Number,
    projectIcon: Schema.NullOr(Schema.fromJsonString(ProjectIconOverride)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);
export const ProjectionTurnStartMessageDbRowSchema = ProjectionThreadMessageDbRowSchema.mapFields(
  Struct.assign({ hasOtherUserMessages: Schema.Number }),
);
export const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
export const ProjectionThreadPullRequestDbRowSchema = ProjectionThreadPullRequest.mapFields(
  Struct.assign({
    snapshot: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestSnapshot)),
    stack: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestStack)),
  }),
);
export const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    titleState: Schema.NullOr(Schema.fromJsonString(ThreadTitleState)),
    linkedPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
    branchPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
    crew: Schema.NullOr(Schema.fromJsonString(CrewThreadOverride)),
  }),
);
export const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
export const ProjectionThreadActivityIdRowSchema = Schema.Struct({
  activityId: ProjectionThreadActivity.fields.activityId,
});
export const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
export const ProjectionThreadRuntimeContextDbRowSchema = Schema.Struct({
  titleState: Schema.NullOr(Schema.fromJsonString(ThreadTitleState)),
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  session: Schema.NullOr(ProjectionThreadSessionDbRowSchema),
});
export const ProjectionCheckpointDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
export const ProjectionStateDbRowSchema = ProjectionState;
export const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
export const EventReplayStatsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  toSequenceInclusive: NonNegativeInt,
});
export const EventReplayStatsRowSchema = Schema.Struct({
  eventCount: Schema.Number,
  payloadBytes: Schema.Number,
});
export const ActiveThreadRowsRequest = Schema.Struct({ unsettledOnly: Schema.Boolean });
export const ProjectionThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});
export const ProjectionThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
export const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
export const ProjectionImportedAgentSessionSourcesRowSchema = Schema.Struct({
  threadId: ThreadId,
  runtimePayload: Schema.Unknown,
});
export const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
export const TurnStartMessageLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export const ThreadActivityKindsLookupInput = Schema.Struct({
  threadId: ThreadId,
  activityKinds: Schema.Array(Schema.String),
});
export const ThreadActivityIdsLookupInput = Schema.Struct({
  activityIds: Schema.Array(ProjectionThreadActivity.fields.activityId),
});
// Windowed reads order turns by the stable keyset (anchor, turn key), where
// anchor is requested_at and turn key is
// COALESCE(turn_id, ''). Both are event-derived, so cursors survive the
// revert projector's row-id rewrite and full projection rebuilds.
export const ThreadTurnWindowLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Exclusive keyset upper bound. Sentinels "~"/"" mean unbounded ("~" sorts
  // after every ISO timestamp).
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
  userTurnLimit: Schema.Number,
  maxRawTurns: Schema.Number,
});
export const ProjectionTurnWindowRowSchema = Schema.Struct({
  // The turn's timeline anchor, used to bound rows that have no turn linkage
  // (user messages and turnless activities) to the same page window.
  anchorAt: Schema.String,
  turnKey: Schema.String,
});
export const ThreadTurnRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Turn-linked rows are bounded by the keyset range [min, before) over
  // (anchor, turn key); turnless rows by the matching [minAnchorAt,
  // beforeAnchorAt) time range. Unbounded ends use sentinels: "" for the
  // lower bound, "~" (sorts after ISO dates) for the upper bound.
  minAnchorAt: Schema.String,
  minTurnKey: Schema.String,
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
});
export const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
export const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
export const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
export const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});
