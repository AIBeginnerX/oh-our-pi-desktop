import {
  AgentSessionImportSource,
  OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { legacyLinkedPullRequestOf } from "@t3tools/shared/threadPullRequests";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "../threadDetailCursor.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionProjectDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadPullRequestDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionStateDbRowSchema,
} from "./ProjectionSnapshotQuery.schemas.ts";
import { makeProjectionListStatements } from "./ProjectionSnapshotQuery.listStatements.ts";
import { makeProjectionThreadStatements } from "./ProjectionSnapshotQuery.threadStatements.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionEventReplayStats,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionThreadDetailQuery,
  type ProjectionThreadPullRequests,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeImportedTranscriptsPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      importedTranscripts: Schema.Array(Schema.Unknown),
    }),
  ),
);
const decodeAgentSessionImportSource = Schema.decodeUnknownOption(AgentSessionImportSource);
// Snapshot payloads are decoded and projected in small sequential batches so
// one client read does not retain the raw payloads for the full activity window.
const THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE = 25;

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapTitleRegeneration(row: Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>) {
  return row.titleRegenerationRequestId != null && row.titleRegenerationStartedAt != null
    ? {
        requestId: row.titleRegenerationRequestId,
        startedAt: row.titleRegenerationStartedAt,
      }
    : null;
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull === 1,
    faviconPath: row.faviconPath ?? null,
    projectIcon: row.projectIcon ?? null,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPullRequestRow(
  row: Schema.Schema.Type<typeof ProjectionThreadPullRequestDbRowSchema>,
): ThreadPullRequestLink {
  return {
    host: row.host,
    repository: row.repository,
    number: row.number,
    url: row.url,
    source: row.source,
    linkedAt: row.linkedAt,
    snapshot: row.snapshot,
    stack: row.stack,
  };
}

function groupPullRequestRowsByThread(
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadPullRequestDbRowSchema>>,
): Map<string, Array<ThreadPullRequestLink>> {
  const byThread = new Map<string, Array<ThreadPullRequestLink>>();
  for (const row of rows) {
    const links = byThread.get(row.threadId) ?? [];
    links.push(mapPullRequestRow(row));
    byThread.set(row.threadId, links);
  }
  return byThread;
}

/**
 * The link array plus the legacy single-link field derived from it, so clients
 * from before `pullRequests` keep seeing the thread's current pull request.
 */
function mapThreadPullRequests(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ProjectId,
  identity?: OrchestrationProject["repositoryIdentity"],
): Pick<OrchestrationThread, "pullRequests" | "linkedPullRequest"> {
  const linkedPullRequest = legacyLinkedPullRequestOf(pullRequests, projectId, identity);
  return {
    pullRequests,
    ...(linkedPullRequest === null ? {} : { linkedPullRequest }),
  };
}

function mapThreadActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const {
    listProjectRows,
    listThreadRows,
    listActiveThreadRows,
    listDeletedWorktreeRows,
    listArchivedThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadPullRequestRows,
    listActiveThreadPullRequestRows,
    listActiveThreadPullRequestSyncRows,
    listArchivedThreadPullRequestRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listActiveThreadSessionRows,
    listArchivedThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listActiveLatestTurnRows,
    listArchivedLatestTurnRows,
    listProjectionStateRows,
    readProjectionCounts,
    readEventReplayStats,
    searchActiveThreadRows,
    getActiveProjectRowByWorkspaceRoot,
    getActiveProjectRowById,
    getFirstActiveThreadIdByProject,
  } = makeProjectionListStatements(sql);
  const {
    listImportedAgentSessionSourceRows,
    getThreadCheckpointContextThreadRow,
    getActiveThreadRowById,
    getThreadRuntimeContextRow,
    getTurnStartMessageRow,
    listThreadMessageRowsByThread,
    listThreadProposedPlanRowsByThread,
    listThreadPullRequestRowsByThread,
    listThreadActivityRowsByThread,
    getUserInputActivityRow,
    listActivityRowsByKind,
    listThreadActivityIdsByThread,
    listThreadActivityRowsByIds,
    listThreadActivityRowsByThreadAndKinds,
    getThreadSessionRowByThread,
    getLatestTurnRowByThread,
    listCheckpointRowsByThread,
    getThreadEventWatermarkRow,
    listTurnWindowRows,
    listThreadMessageRowsByThreadWindow,
    listPinnedThreadActivityRowsByThread,
    listPinnedThreadActivityIdsByThread,
    listThreadActivityRowsByThreadWindow,
    listThreadActivityIdsByThreadWindow,
    getFullThreadDiffContextRow,
  } = makeProjectionThreadStatements(sql);
  const getDeletedWorktreeThreads: ProjectionSnapshotQueryShape["getDeletedWorktreeThreads"] = () =>
    listDeletedWorktreeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getDeletedWorktreeThreads:query",
          "ProjectionSnapshotQuery.getDeletedWorktreeThreads:decodeRows",
        ),
      ),
    );

  const getUserInputActivity: ProjectionSnapshotQueryShape["getUserInputActivity"] = (input) =>
    getUserInputActivityRow(input).pipe(
      Effect.map(Option.map(mapThreadActivityRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getUserInputActivity:query",
          "ProjectionSnapshotQuery.getUserInputActivity:decodeRow",
        ),
      ),
    );

  const listActivitiesByKind: ProjectionSnapshotQueryShape["listActivitiesByKind"] = (kind) =>
    listActivityRowsByKind({ kind }).pipe(
      Effect.map((rows) => rows.map(mapThreadActivityRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listActivitiesByKind:query",
          "ProjectionSnapshotQuery.listActivitiesByKind:decodeRow",
        ),
      ),
    );

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            pullRequestRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  ...(row.context !== null ? { context: row.context } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                defaultThreadEnvMode: row.defaultThreadEnvMode,
                autoPull: row.autoPull === 1,
                faviconPath: row.faviconPath ?? null,
                projectIcon: row.projectIcon ?? null,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                ...mapThreadPullRequests(
                  pullRequestsByThread.get(row.threadId) ?? [],
                  row.projectId,
                  repositoryIdentities.get(row.projectId),
                ),
                branchPullRequest: row.branchPullRequest,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                unsettledAt: row.unsettledAt,
                snoozedUntil: row.snoozedUntil,
                snoozedAt: row.snoozedAt,
                pinnedAt: row.pinnedAt,
                pinOrderKey: row.pinOrderKey ?? null,
                activeOrderKey: row.activeOrderKey ?? null,
                autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                parentThreadId: row.parentThreadId ?? null,
                crew: row.crew ?? null,
                titleRegeneration: mapTitleRegeneration(row),
                titleState: row.titleState,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            pullRequestRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const linkedThreadIds = new Set(pullRequestRows.map((row) => row.threadId));
              const linkedProjectIds = new Set(
                threadRows
                  .filter((row) => linkedThreadIds.has(row.threadId))
                  .map((row) => row.projectId),
              );
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => linkedProjectIds.has(row.projectId)),
              );
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                  defaultModelSelection: row.defaultModelSelection,
                  defaultThreadEnvMode: row.defaultThreadEnvMode,
                  autoPull: row.autoPull === 1,
                  faviconPath: row.faviconPath ?? null,
                  projectIcon: row.projectIcon ?? null,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  ...mapThreadPullRequests(
                    pullRequestsByThread.get(row.threadId) ?? [],
                    row.projectId,
                    repositoryIdentities.get(row.projectId),
                  ),
                  branchPullRequest: row.branchPullRequest,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  activeOrderKey: row.activeOrderKey ?? null,
                  autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                  parentThreadId: row.parentThreadId ?? null,
                  crew: row.crew ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  titleState: row.titleState,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = (options) => {
    const unsettledOnly = options?.unsettledOnly === true;
    return sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveThreadPullRequestRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows({ unsettledOnly }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([projectRows, threadRows, sessionRows, pullRequestRows, latestTurnRows, stateRows]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);

              // Built from schema-decoded rows, so no second decode here. The HTTP
              // and RPC layers encode it against OrchestrationShellSnapshot on the
              // way out, like the per-item shells from getThreadShellById.
              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        title: row.title,
                        modelSelection: row.modelSelection,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        branchPullRequest: row.branchPullRequest,
                        ...mapThreadPullRequests(
                          pullRequestsByThread.get(row.threadId) ?? [],
                          row.projectId,
                          repositoryIdentities.get(row.projectId),
                        ),
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        unsettledAt: row.unsettledAt,
                        snoozedUntil: row.snoozedUntil,
                        snoozedAt: row.snoozedAt,
                        pinnedAt: row.pinnedAt,
                        pinOrderKey: row.pinOrderKey ?? null,
                        activeOrderKey: row.activeOrderKey ?? null,
                        autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                        parentThreadId: row.parentThreadId ?? null,
                        crew: row.crew ?? null,
                        titleRegeneration: mapTitleRegeneration(row),
                        titleState: row.titleState,
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                          row.threadId,
                        ),
                        planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationShellSnapshot;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );
  };

  const listThreadsWithPullRequests: ProjectionSnapshotQueryShape["listThreadsWithPullRequests"] =
    () =>
      listActiveThreadPullRequestSyncRows(undefined).pipe(
        Effect.map((rows) => {
          const threads = new Map<
            ThreadId,
            ProjectionThreadPullRequests & { readonly pullRequests: Array<ThreadPullRequestLink> }
          >();
          for (const row of rows) {
            const thread = threads.get(row.threadId) ?? {
              id: row.threadId,
              projectId: row.projectId,
              settledOverride: row.settledOverride,
              settledAt: row.settledAt,
              pullRequests: [],
            };
            thread.pullRequests.push(mapPullRequestRow(row));
            threads.set(row.threadId, thread);
          }
          return [...threads.values()];
        }),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listThreadsWithPullRequests:query",
            "ProjectionSnapshotQuery.listThreadsWithPullRequests:decodeRows",
          ),
        ),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedThreadPullRequestRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadPullRequests:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadPullRequests:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([projectRows, threadRows, sessionRows, pullRequestRows, latestTurnRows, stateRows]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const pullRequestsByThread = groupPullRequestRowsByThread(pullRequestRows);
              const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null && activeProjectIds.has(row.projectId)
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: threadRows.map((row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  branchPullRequest: row.branchPullRequest,
                  ...mapThreadPullRequests(
                    pullRequestsByThread.get(row.threadId) ?? [],
                    row.projectId,
                    repositoryIdentities.get(row.projectId),
                  ),
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  activeOrderKey: row.activeOrderKey ?? null,
                  autoSettleDisabledAt: row.autoSettleDisabledAt ?? null,
                  parentThreadId: row.parentThreadId ?? null,
                  crew: row.crew ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  titleState: row.titleState,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                    row.threadId,
                  ),
                  planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                })),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationShellSnapshot;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map((row): ProjectionSnapshotCounts => ({
        projectCount: row.projectCount,
        threadCount: row.threadCount,
      })),
    );

  const getEventReplayStats: ProjectionSnapshotQueryShape["getEventReplayStats"] = (input) =>
    readEventReplayStats(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getEventReplayStats:query",
          "ProjectionSnapshotQuery.getEventReplayStats:decodeRow",
        ),
      ),
      Effect.map((row): ProjectionEventReplayStats => ({
        eventCount: row.eventCount,
        payloadBytes: row.payloadBytes,
      })),
    );

  const searchThreads: ProjectionSnapshotQueryShape["searchThreads"] = Effect.fn(
    "ProjectionSnapshotQuery.searchThreads",
  )(function* (input) {
    const escapedQuery = escapeLikePattern(input.query);
    const rows = yield* searchActiveThreadRows({
      pattern: `%${escapedQuery}%`,
      limit: input.limit ?? 50,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreads:query",
          "ProjectionSnapshotQuery.searchThreads:decodeRows",
        ),
      ),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query),
        messageCreatedAt: row.messageCreatedAt,
      })),
    };
  });

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    defaultThreadEnvMode: option.value.defaultThreadEnvMode,
                    autoPull: option.value.autoPull === 1,
                    faviconPath: option.value.faviconPath ?? null,
                    projectIcon: option.value.projectIcon ?? null,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShells: ProjectionSnapshotQueryShape["getProjectShells"] = (projectIds) => {
    if (projectIds?.length === 0) return Effect.succeed([]);
    return listProjectRows({ activeOnly: true, projectIds }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShells:query",
          "ProjectionSnapshotQuery.getProjectShells:decodeRows",
        ),
      ),
      Effect.flatMap((projects) =>
        resolveRepositoryIdentitiesForProjects(projects).pipe(
          Effect.map((identities) =>
            projects.map((row) => mapProjectShellRow(row, identities.get(row.projectId) ?? null)),
          ),
        ),
      ),
    );
  };

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getImportedAgentSessionSources: ProjectionSnapshotQueryShape["getImportedAgentSessionSources"] =
    Effect.fn("ProjectionSnapshotQuery.getImportedAgentSessionSources")(function* (projectId) {
      const rows = yield* listImportedAgentSessionSourceRows({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getImportedAgentSessionSources:query",
            "ProjectionSnapshotQuery.getImportedAgentSessionSources:decodeRows",
          ),
        ),
      );
      return rows.flatMap((row) => {
        const payload = decodeImportedTranscriptsPayload(row.runtimePayload);
        if (Option.isNone(payload)) return [];
        return payload.value.importedTranscripts.flatMap((entry) => {
          const source = decodeAgentSessionImportSource(entry);
          if (
            Option.isNone(source) ||
            row.threadId !==
              `import:${source.value.providerInstanceId}:${source.value.providerSessionId}`
          ) {
            return [];
          }
          return [{ threadId: row.threadId, source: source.value }];
        });
      });
    });

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map((row): OrchestrationCheckpointSummary => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow, pullRequestRows] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
        listThreadPullRequestRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:listPullRequests:query",
              "ProjectionSnapshotQuery.getThreadShellById:listPullRequests:decodeRows",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...mapThreadPullRequests(
          pullRequestRows.map(mapPullRequestRow),
          threadRow.value.projectId,
          pullRequestRows.length === 0
            ? null
            : Option.getOrNull(yield* getProjectShellById(threadRow.value.projectId))
                ?.repositoryIdentity,
        ),
        branchPullRequest: threadRow.value.branchPullRequest,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        activeOrderKey: threadRow.value.activeOrderKey ?? null,
        autoSettleDisabledAt: threadRow.value.autoSettleDisabledAt ?? null,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        crew: threadRow.value.crew ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        titleState: threadRow.value.titleState,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
          threadRow.value.threadId,
        ),
        planProgress: threadPlanProgress.getThreadPlanProgress(threadRow.value.threadId),
      } satisfies OrchestrationThreadShell);
    });

  const getThreadRuntimeContext: ProjectionSnapshotQueryShape["getThreadRuntimeContext"] =
    Effect.fn("ProjectionSnapshotQuery.getThreadRuntimeContext")(function* (threadId) {
      const context = yield* getThreadRuntimeContextRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadRuntimeContext:query",
            "ProjectionSnapshotQuery.getThreadRuntimeContext:decodeRow",
          ),
        ),
      );
      return Option.map(context, (row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        titleState: row.titleState,
        session: row.session === null ? null : mapSessionRow(row.session),
      }));
    });

  const getTurnStartMessage: ProjectionSnapshotQueryShape["getTurnStartMessage"] = Effect.fn(
    "ProjectionSnapshotQuery.getTurnStartMessage",
  )(function* (input) {
    const message = yield* getTurnStartMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getTurnStartMessage:query",
          "ProjectionSnapshotQuery.getTurnStartMessage:decodeRow",
        ),
      ),
    );
    return Option.map(message, (row) => ({
      message: {
        id: row.messageId,
        role: row.role,
        text: row.text,
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
      },
      hasOtherUserMessages: row.hasOtherUserMessages === 1,
    }));
  });

  // Contiguous turn range bounding a windowed detail read; undefined loads the
  // full thread. Resolved from a window request inside the snapshot
  // transaction (see getThreadDetailSnapshot).
  interface ThreadDetailBounds {
    readonly minAnchorAt: string;
    readonly minTurnKey: string;
    readonly beforeAnchorAt: string;
    readonly beforeTurnKey: string;
  }

  type ThreadDetailActivityRead =
    | {
        readonly mode: "raw";
        readonly query?: ProjectionThreadDetailQuery;
      }
    | {
        readonly mode: "client";
      };

  const listProjectedThreadActivities = Effect.fn(
    "ProjectionSnapshotQuery.listProjectedThreadActivities",
  )(function* (threadId: ThreadId, bounds: ThreadDetailBounds | undefined) {
    const [activityIdRows, pinnedActivityIdRows] = yield* Effect.all([
      (bounds === undefined
        ? listThreadActivityIdsByThread({ threadId })
        : listThreadActivityIdsByThreadWindow({ threadId, ...bounds })
      ).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:decodeRows",
          ),
        ),
      ),
      listPinnedThreadActivityIdsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivityIds:decodeRows",
          ),
        ),
      ),
    ]);
    const activityIds = [
      ...new Set([...activityIdRows, ...pinnedActivityIdRows].map(({ activityId }) => activityId)),
    ];
    const activities: OrchestrationThreadActivity[] = [];

    for (
      let offset = 0;
      offset < activityIds.length;
      offset += THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE
    ) {
      const batchIds = activityIds.slice(
        offset,
        offset + THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE,
      );
      const batchRows = yield* listThreadActivityRowsByIds({ activityIds: batchIds }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:decodeRows",
          ),
        ),
      );
      for (const row of batchRows) {
        activities.push(projectActivityPayload(mapThreadActivityRow(row)));
      }
    }

    return activities.toSorted(
      (left, right) =>
        (left.sequence ?? -1) - (right.sequence ?? -1) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  });

  const getThreadDetailByIdBounded = (
    threadId: ThreadId,
    bounds: ThreadDetailBounds | undefined,
    activityRead: ThreadDetailActivityRead = { mode: "raw" },
  ) =>
    Effect.gen(function* () {
      const activitiesEffect =
        activityRead.mode === "client"
          ? listProjectedThreadActivities(threadId, bounds)
          : Effect.all([
              (activityRead.query?.activityKinds === undefined
                ? bounds === undefined
                  ? listThreadActivityRowsByThread({ threadId })
                  : listThreadActivityRowsByThreadWindow({ threadId, ...bounds })
                : activityRead.query.activityKinds.length === 0
                  ? Effect.succeed([])
                  : listThreadActivityRowsByThreadAndKinds({
                      threadId,
                      activityKinds: activityRead.query.activityKinds,
                    })
              ).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
                    "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
                  ),
                ),
              ),
              activityRead.query?.activityKinds === undefined
                ? listPinnedThreadActivityRowsByThread({ threadId }).pipe(
                    Effect.mapError(
                      toPersistenceSqlOrDecodeError(
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:query",
                        "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:decodeRows",
                      ),
                    ),
                  )
                : Effect.succeed([]),
            ]).pipe(
              Effect.map(([activityRows, pinnedActivityRows]) =>
                [
                  ...new Map(
                    [...activityRows, ...pinnedActivityRows].map(
                      (row) => [row.activityId, row] as const,
                    ),
                  ).values(),
                ]
                  .toSorted(
                    (left, right) =>
                      (left.sequence ?? -1) - (right.sequence ?? -1) ||
                      left.createdAt.localeCompare(right.createdAt) ||
                      left.activityId.localeCompare(right.activityId),
                  )
                  .map(mapThreadActivityRow),
              ),
            );

      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        pullRequestRows,
        activities,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadMessageRowsByThread({ threadId })
          : listThreadMessageRowsByThreadWindow({ threadId, ...bounds })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadPullRequestRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPullRequests:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPullRequests:decodeRows",
            ),
          ),
        ),
        activitiesEffect,
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...mapThreadPullRequests(
          pullRequestRows.map(mapPullRequestRow),
          threadRow.value.projectId,
          pullRequestRows.length === 0
            ? null
            : Option.getOrNull(yield* getProjectShellById(threadRow.value.projectId))
                ?.repositoryIdentity,
        ),
        branchPullRequest: threadRow.value.branchPullRequest,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        activeOrderKey: threadRow.value.activeOrderKey ?? null,
        autoSettleDisabledAt: threadRow.value.autoSettleDisabledAt ?? null,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        crew: threadRow.value.crew ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        titleState: threadRow.value.titleState,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            Object.assign(message, { attachments: row.attachments });
          }
          if (row.context !== null) {
            Object.assign(message, { context: row.context });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities,
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (
    threadId,
    query,
  ) =>
    getThreadDetailByIdBounded(threadId, undefined, {
      mode: "raw",
      ...(query === undefined ? {} : { query }),
    });

  // Bounds pathological fan-out: one user turn that spawned hundreds of
  // subagent turns still pages in bounded chunks, at the cost of splitting the
  // fan-out group across pages (the cursor continues the same group). Also
  // structurally bounds the window scan via the candidates CTE's LIMIT.
  const THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE = 150;
  // Sentinels for unbounded keyset ends; "~" sorts after any ISO timestamp.
  const ANCHOR_UNBOUNDED = "~";

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
    window,
  ) =>
    // Read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events. Window resolution runs inside the same
    // transaction so the page boundary is consistent with the returned rows.
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (window?.turnLimit === undefined) {
            const thread = yield* getThreadDetailByIdBounded(threadId, undefined, {
              mode: "client",
            });
            if (Option.isNone(thread)) {
              return Option.none<OrchestrationThreadDetailSnapshot>();
            }
            const { snapshotSequence } = yield* getSnapshotSequence();
            return Option.some({ snapshotSequence, thread: thread.value });
          }

          // A malformed or foreign-thread cursor falls back to the first page
          // rather than failing: the client's stale cursor after a revert or
          // reconnect should degrade to "reload recent history", not error.
          const decodedCursor =
            window.beforeCursor === undefined
              ? null
              : decodeThreadDetailPageCursor(window.beforeCursor);
          const cursor = decodedCursor?.threadId === threadId ? decodedCursor : null;

          const windowRows = yield* listTurnWindowRows({
            threadId,
            beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
            beforeTurnKey: cursor?.beforeTurnId ?? "",
            userTurnLimit: window.turnLimit,
            maxRawTurns: THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:decodeRows",
              ),
            ),
          );

          const oldest = windowRows[0];
          const hasMore =
            oldest !== undefined &&
            (yield* listTurnWindowRows({
              threadId,
              beforeAnchorAt: oldest.anchorAt,
              beforeTurnKey: oldest.turnKey,
              userTurnLimit: 1,
              maxRawTurns: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:decodeRows",
                ),
              ),
            )).length > 0;
          // An empty window (no turns before the cursor, or a thread with no
          // turns at all) still returns thread metadata with empty collections
          // for turn-linked rows; turnless rows are bounded to the same empty
          // range. The first page of a turnless thread stays unwindowed so
          // pre-turn content (e.g. a just-created thread) is not hidden. Once
          // paging reaches the oldest turn, include turnless messages before
          // the first turn, such as history imported from a provider session.
          const bounds: ThreadDetailBounds | undefined =
            oldest === undefined && cursor === null
              ? undefined
              : {
                  minAnchorAt: hasMore ? (oldest?.anchorAt ?? "") : "",
                  minTurnKey: hasMore ? (oldest?.turnKey ?? "") : "",
                  beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
                  beforeTurnKey: cursor?.beforeTurnId ?? "",
                };
          // Empty window behind a cursor: nothing older remains.
          const emptyBounds =
            oldest === undefined && cursor !== null
              ? { minAnchorAt: "", minTurnKey: "", beforeAnchorAt: "", beforeTurnKey: "" }
              : undefined;

          const thread = yield* getThreadDetailByIdBounded(threadId, emptyBounds ?? bounds, {
            mode: "client",
          });
          if (Option.isNone(thread)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          const { snapshotSequence } = yield* getSnapshotSequence();
          const watermarkRow = yield* getThreadEventWatermarkRow({
            threadId,
            maxSequence: snapshotSequence,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:decodeRow",
              ),
            ),
          );
          const threadSequence = Option.match(watermarkRow, {
            onNone: () => 0,
            onSome: (row) => row.threadSequence ?? 0,
          });
          return Option.some({
            snapshotSequence,
            thread: thread.value,
            page: {
              beforeCursor:
                hasMore && oldest !== undefined
                  ? encodeThreadDetailPageCursor({
                      threadId,
                      beforeAnchorAt: oldest.anchorAt,
                      beforeTurnId: oldest.turnKey,
                    })
                  : null,
              hasMore,
              snapshotSequence,
              threadSequence,
            },
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
                error,
              ),
        ),
      );

  return {
    getCommandReadModel,
    getUserInputActivity,
    listActivitiesByKind,
    getSnapshot,
    getShellSnapshot,
    listThreadsWithPullRequests,
    getArchivedShellSnapshot,
    getDeletedWorktreeThreads,
    searchThreads,
    getSnapshotSequence,
    getCounts,
    getEventReplayStats,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getProjectShells,
    getFirstActiveThreadIdByProjectId,
    getImportedAgentSessionSources,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadRuntimeContext,
    getTurnStartMessage,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
