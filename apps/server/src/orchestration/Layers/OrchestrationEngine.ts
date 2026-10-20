import type {
  ComposerContextRecord,
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  OrchestrationCommand,
  PROJECT_SKILL_CONTEXT_KIND,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  SelectedCheckReceipt,
  TASK_RESULT_ACTIVITY_KIND,
  taskResultRecordId,
  TaskResultRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectMemorySendLedger,
  layer as ProjectMemorySendLedgerLayer,
} from "../../persistence/ProjectMemorySendLedger.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { RestartContinuations, type ContinuationSettlement } from "../../restartContinuations.ts";
import {
  ProjectSkillMutationFence,
  layer as ProjectSkillMutationFenceLayer,
} from "../../skills/ProjectSkillMutationFence.ts";
import {
  ProjectSkillSendGate,
  PROJECT_SKILL_SEND_REJECTION_DETAIL,
} from "../../skills/ProjectSkillSendGate.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandStateUnavailableError,
  OrchestrationRestartRecoveryHeldError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
  TASK_RESULT_WRITE_REJECT_DETAIL,
  type TaskResultWriteGuard,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);
const isOrchestrationCommandStateUnavailableError = Schema.is(
  OrchestrationCommandStateUnavailableError,
);
const isOrchestrationRestartRecoveryHeldError = Schema.is(OrchestrationRestartRecoveryHeldError);

const decodeTaskResultRecord = Schema.decodeUnknownOption(TaskResultRecord);
const decodeSelectedCheckReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  settlement: ContinuationSettlement | undefined;
  preparationCancel: { preparationSequence: number; controlSequence: number } | undefined;
  taskResultWrite: TaskResultWriteGuard | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

const hasManagedSkillRecord = (records: ReadonlyArray<ComposerContextRecord>): boolean =>
  records.some((record) => record.kind === PROJECT_SKILL_CONTEXT_KIND);

const threadProjectId = (
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): ProjectId | undefined => readModel.threads.find((entry) => entry.id === threadId)?.projectId;

/** Mirrors ProjectSkills receipt writer prefix; not a cryptographic auth check. */
const SELECTED_CHECK_RECEIPT_COMMAND_PREFIX = "server:selected-checks:";

const mergeSkillLifecycleMutationProjects = (
  ...groups: ReadonlyArray<ReadonlyArray<ProjectId> | null>
): ReadonlyArray<ProjectId> | null => {
  const merged = new Set<ProjectId>();
  for (const group of groups) {
    if (group === null) continue;
    for (const projectId of group) merged.add(projectId);
  }
  return merged.size === 0 ? null : [...merged];
};

type SkillLifecyclePlannedEvent = Omit<OrchestrationEvent, "sequence">;

const threadIdFromSkillInputBoundaryEvent = (
  event: SkillLifecyclePlannedEvent,
): ThreadId | undefined => {
  switch (event.type) {
    case "thread.message-sent": {
      const payload = (event as Extract<OrchestrationEvent, { type: "thread.message-sent" }>)
        .payload;
      return payload.role === "user" ? payload.threadId : undefined;
    }
    case "thread.turn-start-requested":
      return (event as Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>).payload
        .threadId;
    case "thread.user-input-response-requested":
      return (
        event as Extract<OrchestrationEvent, { type: "thread.user-input-response-requested" }>
      ).payload.threadId;
    case "thread.approval-response-requested":
      return (event as Extract<OrchestrationEvent, { type: "thread.approval-response-requested" }>)
        .payload.threadId;
    case "thread.checkpoint-revert-requested":
      return (event as Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>)
        .payload.threadId;
    default:
      return undefined;
  }
};

const isAuthenticatedServerSelectedCheckActivity = (
  event: SkillLifecyclePlannedEvent,
  command: OrchestrationCommand,
): boolean => {
  if (event.type !== "thread.activity-appended") return false;
  if (command.type !== "thread.activity.append") return false;
  if (!String(command.commandId).startsWith(SELECTED_CHECK_RECEIPT_COMMAND_PREFIX)) {
    return false;
  }
  const payload = (event as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>)
    .payload;
  return (
    payload.activity.kind === SELECTED_CHECK_RECEIPT_KIND && payload.threadId === command.threadId
  );
};

const resolveSkillLifecycleMutationProjectsFromEvents = (
  command: OrchestrationCommand,
  eventBases: ReadonlyArray<SkillLifecyclePlannedEvent>,
  readModel: OrchestrationReadModel,
): ReadonlyArray<ProjectId> | null => {
  const projectIds = new Set<ProjectId>();
  for (const event of eventBases) {
    const threadId = threadIdFromSkillInputBoundaryEvent(event);
    if (threadId !== undefined) {
      const projectId = threadProjectId(readModel, threadId);
      if (projectId !== undefined) projectIds.add(projectId);
      continue;
    }
    if (isAuthenticatedServerSelectedCheckActivity(event, command)) {
      const payload = (event as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>)
        .payload;
      const projectId = threadProjectId(readModel, payload.threadId);
      if (projectId !== undefined) projectIds.add(projectId);
    }
  }
  return projectIds.size === 0 ? null : [...projectIds];
};

/** Project ids whose orchestration writes invalidate project-skill lifecycle fences. */
const resolveSkillLifecycleMutationProjectsFromCommand = (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): ReadonlyArray<ProjectId> | null => {
  switch (command.type) {
    case "project.meta.update":
      return command.scripts !== undefined || command.workspaceRoot !== undefined
        ? [command.projectId]
        : null;
    case "project.delete":
      return [command.projectId];
    case "thread.create":
      return [command.projectId];
    case "thread.delete": {
      const projectId = threadProjectId(readModel, command.threadId);
      return projectId === undefined ? null : [projectId];
    }
    case "thread.meta.update":
      return command.modelSelection !== undefined || command.worktreePath !== undefined
        ? (() => {
            const projectId = threadProjectId(readModel, command.threadId);
            return projectId === undefined ? null : [projectId];
          })()
        : null;
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set": {
      const projectId = threadProjectId(readModel, command.threadId);
      return projectId === undefined ? null : [projectId];
    }
    default:
      return null;
  }
};

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const threadActivityRepository = yield* ProjectionThreadActivityRepository;
  const threadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const threadSessionRepository = yield* ProjectionThreadSessionRepository;
  const memorySendLedger = yield* ProjectMemorySendLedger;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const continuations = yield* RestartContinuations;
  const crypto = yield* Crypto.Crypto;
  const skillSendGate = yield* ProjectSkillSendGate;
  const skillMutationFence = yield* ProjectSkillMutationFence;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);
  // Set when committed events may be missing from commandReadModel; while set,
  // every envelope must finish a catch-up before it may decide.
  let gap = false;
  // The highest resultSequence seen on an ahead accepted receipt. Uncertainty
  // cannot clear and no command may decide while the installed checkpoint
  // stays below it, even when the store read comes back empty.
  let outstandingReceiptFloor = 0;
  // Events already folded into commandReadModel whose PubSub delivery was cut
  // short by a postcommit failure. Drained ahead of store reads so subscribers
  // keep global sequence order.
  const unpublishedCommitted: OrchestrationEvent[] = [];

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  // Each entry leaves the queue only after its publish completes, so a failure
  // or interruption mid-drain leaves the unpublished suffix queued for the
  // next attempt instead of dropping it.
  const publishUnpublishedCommitted = Effect.gen(function* () {
    while (unpublishedCommitted.length > 0) {
      const event = unpublishedCommitted[0];
      if (event === undefined) break;
      yield* PubSub.publish(eventPubSub, event);
      unpublishedCommitted.shift();
    }
  });

  // Observation only: record what each installed event means for the thread's
  // current continuation token. Nothing is retired here; release is judged
  // once per envelope before persistence.
  const observeCommittedEvents = (events: ReadonlyArray<OrchestrationEvent>): void => {
    for (const event of events) {
      switch (event.type) {
        case "thread.session-set": {
          const token = continuations.current(event.payload.threadId);
          if (token === undefined) break;
          const session = event.payload.session;
          if (session.status === "running" && session.activeTurnId !== null) {
            token.seen.add(session.activeTurnId);
          }
          break;
        }
        case "thread.session-stop-requested":
        case "thread.turn-interrupt-requested": {
          const token = continuations.current(event.payload.threadId);
          if (token !== undefined) token.canceled = true;
          break;
        }
        case "thread.deleted": {
          const token = continuations.current(event.payload.threadId);
          if (token !== undefined) token.deleted = true;
          break;
        }
      }
    }
  };

  // Committed events cut short by a failed dispatch are durable and must reach
  // subscribers, so they are drained before the store read. The candidate is
  // installed only when the whole read/fold succeeds, keeping the checkpoint
  // contiguous; gap clears only here, never on a partial fold.
  const catchUpCommandReadModel = Effect.gen(function* () {
    yield* publishUnpublishedCommitted;
    const persistedEvents = yield* Stream.runCollect(
      eventStore.readFromSequence(commandReadModel.snapshotSequence, Number.MAX_SAFE_INTEGER),
    );
    const candidate = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);
    commandReadModel = candidate;
    observeCommittedEvents(persistedEvents);
    unpublishedCommitted.push(...persistedEvents);
    if (candidate.snapshotSequence >= outstandingReceiptFloor) {
      outstandingReceiptFloor = 0;
    }
    gap = outstandingReceiptFloor > 0;
    yield* publishUnpublishedCommitted;
  });

  // A turn-start failure report is judged against this thread's committed
  // events from the failed request onward. One extra row tells a full scan
  // from a truncated one, and a truncated scan is never trusted. The head is
  // the caught-up command read model's; the single worker is the only writer,
  // so nothing can commit between this read and the decision.
  const TURN_START_FAIL_SCAN_LIMIT = 1000;
  const readTurnStartFailScan = (threadId: ThreadId, requestSequence: number) =>
    requestSequence < 1
      ? Effect.succeed({ events: [], complete: false })
      : Stream.runCollect(
          eventStore.readAggregateRange({
            aggregateKind: "thread",
            aggregateId: threadId,
            fromSequenceExclusive: requestSequence - 1,
            toSequenceInclusive: commandReadModel.snapshotSequence,
            limit: TURN_START_FAIL_SCAN_LIMIT + 1,
          }),
        ).pipe(
          Effect.map((events) => ({
            events,
            complete: events.length <= TURN_START_FAIL_SCAN_LIMIT,
          })),
        );

  // A continuation settlement is judged against this thread's committed
  // events from its preparation session-set onward. One extra row tells a
  // full scan from a truncated one, and a truncated scan is never trusted.
  const CONTINUATION_SETTLEMENT_SCAN_LIMIT = 1000;
  // The thread's generation moved past the prepared session when any of these
  // landed after the preparation, even if a later session-set happens to
  // carry identical values.
  const CONTINUATION_SETTLEMENT_SUPERSEDING_TYPES: ReadonlySet<OrchestrationEvent["type"]> =
    new Set([
      "thread.session-set",
      "thread.session-stop-requested",
      "thread.turn-interrupt-requested",
      "thread.deleted",
      "thread.created",
      "thread.turn-start-requested",
      "thread.runtime-mode-set",
      "thread.checkpoint-revert-requested",
    ]);
  // One fixed wording for every settlement refusal: the caller only learns
  // that the cleanup was refused, never which precondition failed.
  const CONTINUATION_SETTLEMENT_REJECT_DETAIL =
    "continuation settlement rejected; the prepared thread state is no longer current";
  // A preparation-cancel dispatch is judged against this thread's committed
  // events from the earlier of its preparation and control anchors. One extra
  // row tells a full scan from a truncated one, and a truncated scan is
  // never trusted.
  const PREPARATION_CANCEL_SCAN_LIMIT = 1000;
  const PREPARATION_CANCEL_REJECT_DETAIL =
    "preparation cancellation rejected; the prepared thread state is no longer current";
  // A guarded task-result write is a server-internal record write: it must
  // arrive under this command-id prefix, never as a client command.
  const TASK_RESULT_COMMAND_PREFIX = "server:task-result:";

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    let processingStartedAtMs = 0;
    let provenanceClassificationInterrupted = false;
    let skillGateInterrupted = false;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const catchUpOrStateUnavailable = Effect.gen(function* () {
      yield* catchUpCommandReadModel.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationCommandStateUnavailableError({
              commandType: envelope.command.type,
              cause,
            }),
        ),
      );
      if (commandReadModel.snapshotSequence < outstandingReceiptFloor) {
        return yield* new OrchestrationCommandStateUnavailableError({
          commandType: envelope.command.type,
        });
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        if (gap) {
          yield* catchUpOrStateUnavailable;
        }

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            if (existingReceipt.value.resultSequence > commandReadModel.snapshotSequence) {
              // A receipt ahead of the checkpoint is not proof of applied
              // state; an empty or short stream cannot acknowledge it. The
              // target is retained until committed evidence reaches it, so
              // later envelopes cannot decide past it either.
              outstandingReceiptFloor = Math.max(
                outstandingReceiptFloor,
                existingReceipt.value.resultSequence,
              );
              gap = true;
              yield* catchUpOrStateUnavailable;
            }
            if (envelope.settlement !== undefined) {
              const replaySettlement = envelope.settlement;
              const settlementEvidence = replaySettlement.token.evidence;
              // A replayed settlement retires its exact token only after the
              // accepted receipt's own event proves to be this cleanup's
              // session-set. Anything less is unclear state, so the caller
              // gets a retryable error instead of a false success.
              if (
                envelope.command.type !== "thread.session.set" ||
                envelope.command.threadId !== replaySettlement.token.threadId ||
                settlementEvidence?.kind !== "held" ||
                settlementEvidence.commandId !== envelope.command.commandId
              ) {
                return yield* new OrchestrationCommandStateUnavailableError({
                  commandType: envelope.command.type,
                });
              }
              const settlementEvents = yield* Stream.runCollect(
                eventStore.readAggregateRange({
                  aggregateKind: "thread",
                  aggregateId: replaySettlement.token.threadId,
                  fromSequenceExclusive: existingReceipt.value.resultSequence - 1,
                  toSequenceInclusive: existingReceipt.value.resultSequence,
                  limit: 1,
                }),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationCommandStateUnavailableError({
                      commandType: envelope.command.type,
                      cause,
                    }),
                ),
              );
              const settlementEvent = settlementEvents[0];
              if (
                settlementEvent === undefined ||
                settlementEvent.sequence !== existingReceipt.value.resultSequence ||
                settlementEvent.aggregateKind !== "thread" ||
                settlementEvent.aggregateId !== replaySettlement.token.threadId ||
                settlementEvent.type !== "thread.session-set" ||
                settlementEvent.commandId !== envelope.command.commandId ||
                settlementEvent.payload.threadId !== replaySettlement.token.threadId
              ) {
                return yield* new OrchestrationCommandStateUnavailableError({
                  commandType: envelope.command.type,
                });
              }
              const persistedSession = settlementEvent.payload.session;
              const requestedSession = envelope.command.session;
              // The stored session must be this cleanup's error payload bound
              // to the token, field by field — a session-set that merely
              // shares the command id proves nothing.
              if (
                persistedSession.threadId !== replaySettlement.token.threadId ||
                persistedSession.providerInstanceId !== replaySettlement.token.providerInstanceId ||
                persistedSession.status !== "error" ||
                persistedSession.activeTurnId !== null ||
                persistedSession.threadId !== requestedSession.threadId ||
                persistedSession.status !== requestedSession.status ||
                persistedSession.providerName !== requestedSession.providerName ||
                persistedSession.providerInstanceId !== requestedSession.providerInstanceId ||
                persistedSession.runtimeMode !== requestedSession.runtimeMode ||
                persistedSession.activeTurnId !== requestedSession.activeTurnId ||
                persistedSession.lastError !== requestedSession.lastError ||
                persistedSession.updatedAt !== requestedSession.updatedAt
              ) {
                return yield* new OrchestrationCommandStateUnavailableError({
                  commandType: envelope.command.type,
                });
              }
              continuations.retire(replaySettlement.token);
            }
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        // A settlement dispatch is a server-internal cleanup: its presence
        // alone selects this path, and it may write only while the exact held
        // token still owns a thread whose committed history still matches the
        // preparation it cites. Any mismatch is a permanent refusal.
        const settlement = envelope.settlement;
        const settlementReject = () =>
          new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: CONTINUATION_SETTLEMENT_REJECT_DETAIL,
          });
        const settlementTokenHeld = (): boolean => {
          if (settlement === undefined) return false;
          const evidence = settlement.token.evidence;
          return (
            continuations.current(settlement.token.threadId) === settlement.token &&
            continuations.isLive(settlement.token) &&
            evidence?.kind === "held" &&
            evidence.commandId === envelope.command.commandId
          );
        };
        if (settlement !== undefined) {
          if (
            envelope.command.type !== "thread.session.set" ||
            envelope.command.threadId !== settlement.token.threadId ||
            envelope.command.session.threadId !== settlement.token.threadId ||
            // The token is the ownership identity: both sessions must bind to
            // its instance, not merely agree with each other.
            envelope.command.session.providerInstanceId !== settlement.token.providerInstanceId ||
            envelope.command.session.status !== "error" ||
            envelope.command.session.activeTurnId !== null ||
            !Number.isInteger(settlement.preparationSequence) ||
            settlement.preparationSequence < 1 ||
            !settlementTokenHeld()
          ) {
            return yield* settlementReject();
          }
          const settlementScanEvents = yield* Stream.runCollect(
            eventStore.readAggregateRange({
              aggregateKind: "thread",
              aggregateId: settlement.token.threadId,
              fromSequenceExclusive: settlement.preparationSequence - 1,
              toSequenceInclusive: commandReadModel.snapshotSequence,
              limit: CONTINUATION_SETTLEMENT_SCAN_LIMIT + 1,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationCommandStateUnavailableError({
                  commandType: envelope.command.type,
                  cause,
                }),
            ),
          );
          const settlementAnchor = settlementScanEvents[0];
          if (
            settlementScanEvents.length > CONTINUATION_SETTLEMENT_SCAN_LIMIT ||
            settlementAnchor === undefined ||
            settlementAnchor.sequence !== settlement.preparationSequence ||
            settlementAnchor.commandId !== settlement.preparationCommandId ||
            settlementAnchor.type !== "thread.session-set" ||
            settlementAnchor.payload.threadId !== settlement.token.threadId ||
            settlementAnchor.payload.session.threadId !== settlement.token.threadId ||
            settlementAnchor.payload.session.status !== "starting" ||
            settlementAnchor.payload.session.activeTurnId !== null ||
            settlementAnchor.payload.session.providerInstanceId !==
              settlement.token.providerInstanceId ||
            // The cleanup carries the prepared session's identity forward;
            // only status, the caller-selected lastError, and updatedAt may
            // differ from it.
            envelope.command.session.providerName !==
              settlementAnchor.payload.session.providerName ||
            envelope.command.session.runtimeMode !== settlementAnchor.payload.session.runtimeMode ||
            settlementScanEvents
              .slice(1)
              .some((event) => CONTINUATION_SETTLEMENT_SUPERSEDING_TYPES.has(event.type)) ||
            // The scan is asynchronous: a revoke or successor reserve may
            // have landed while it ran.
            !settlementTokenHeld()
          ) {
            return yield* settlementReject();
          }
        }

        // A preparation-cancel dispatch is a server-internal cleanup: its
        // presence alone selects this path, and it may write a canceled
        // preparation's terminal session only while the exact "starting"
        // session-set it cites is still the thread's latest session write and
        // the stop/interrupt control event that triggered it is still the
        // newest owner claim for that thread. Any mismatch is a permanent
        // refusal, never a fallback write.
        const preparationCancel = envelope.preparationCancel;
        if (preparationCancel !== undefined) {
          const preparationCancelReject = () =>
            new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: PREPARATION_CANCEL_REJECT_DETAIL,
            });
          if (
            envelope.settlement !== undefined ||
            envelope.command.type !== "thread.session.set" ||
            envelope.command.threadId !== envelope.command.session.threadId ||
            (envelope.command.session.status !== "stopped" &&
              envelope.command.session.status !== "error") ||
            envelope.command.session.activeTurnId !== null ||
            !Number.isSafeInteger(preparationCancel.preparationSequence) ||
            preparationCancel.preparationSequence < 1 ||
            !Number.isSafeInteger(preparationCancel.controlSequence) ||
            preparationCancel.controlSequence < 1
          ) {
            return yield* preparationCancelReject();
          }
          const preparationCancelScanEvents = yield* Stream.runCollect(
            eventStore.readAggregateRange({
              aggregateKind: "thread",
              aggregateId: envelope.command.threadId,
              fromSequenceExclusive:
                Math.min(preparationCancel.preparationSequence, preparationCancel.controlSequence) -
                1,
              toSequenceInclusive: commandReadModel.snapshotSequence,
              limit: PREPARATION_CANCEL_SCAN_LIMIT + 1,
            }),
          ).pipe(
            Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError> =>
              // A cancelled preparation's read can carry a mixed cause (read
              // failure + interrupt). mapError would drop the interrupt reason
              // and report a bogus state-unavailable rejection, so propagate
              // interrupt-bearing and non-failure causes intact; only a plain
              // store failure becomes StateUnavailable.
              Cause.hasInterrupts(cause) || !Cause.hasFails(cause)
                ? Effect.failCause(cause)
                : Effect.fail(
                    new OrchestrationCommandStateUnavailableError({
                      commandType: envelope.command.type,
                      cause,
                    }),
                  ),
            ),
          );
          const preparationAnchor = preparationCancelScanEvents.find(
            (event) => event.sequence === preparationCancel.preparationSequence,
          );
          const preparationControl = preparationCancelScanEvents.find(
            (event) => event.sequence === preparationCancel.controlSequence,
          );
          if (
            preparationCancelScanEvents.length > PREPARATION_CANCEL_SCAN_LIMIT ||
            preparationAnchor === undefined ||
            preparationControl === undefined ||
            preparationAnchor.aggregateKind !== "thread" ||
            preparationAnchor.aggregateId !== envelope.command.threadId ||
            preparationAnchor.type !== "thread.session-set" ||
            preparationAnchor.payload.threadId !== envelope.command.threadId ||
            preparationAnchor.payload.session.threadId !== envelope.command.threadId ||
            preparationAnchor.payload.session.status !== "starting" ||
            preparationAnchor.payload.session.activeTurnId !== null ||
            envelope.command.session.providerName !==
              preparationAnchor.payload.session.providerName ||
            envelope.command.session.providerInstanceId !==
              preparationAnchor.payload.session.providerInstanceId ||
            envelope.command.session.runtimeMode !==
              preparationAnchor.payload.session.runtimeMode ||
            preparationControl.aggregateKind !== "thread" ||
            preparationControl.aggregateId !== envelope.command.threadId ||
            (preparationControl.type !== "thread.session-stop-requested" &&
              preparationControl.type !== "thread.turn-interrupt-requested") ||
            preparationControl.payload.threadId !== envelope.command.threadId ||
            preparationCancelScanEvents.some(
              (scanEvent) =>
                scanEvent.sequence > preparationCancel.preparationSequence &&
                scanEvent.type === "thread.session-set",
            ) ||
            preparationCancelScanEvents.some(
              (scanEvent) =>
                scanEvent.type === "thread.created" || scanEvent.type === "thread.deleted",
            ) ||
            preparationCancelScanEvents.some(
              (scanEvent) =>
                scanEvent.sequence > preparationCancel.controlSequence &&
                scanEvent.type === "thread.turn-start-requested",
            )
          ) {
            return yield* preparationCancelReject();
          }
        }

        // A guarded task-result write is a server-internal record write: the
        // option alone selects this path. A task-result append without the
        // guard, and the guard on any other command, are both refusals — the
        // path can never be assumed or reached by accident.
        const taskResultWrite = envelope.taskResultWrite;
        const taskResultWriteReject = () =>
          new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: TASK_RESULT_WRITE_REJECT_DETAIL,
          });
        const isTaskResultAppend =
          envelope.command.type === "thread.activity.append" &&
          envelope.command.activity.kind === TASK_RESULT_ACTIVITY_KIND;
        if (isTaskResultAppend !== (taskResultWrite !== undefined)) {
          return yield* taskResultWriteReject();
        }
        if (taskResultWrite !== undefined && envelope.command.type === "thread.activity.append") {
          const taskResultPayloadOption = decodeTaskResultRecord(envelope.command.activity.payload);
          if (
            Option.isNone(taskResultPayloadOption) ||
            envelope.command.activity.id !== taskResultRecordId(envelope.command.threadId) ||
            !envelope.command.commandId.startsWith(TASK_RESULT_COMMAND_PREFIX) ||
            envelope.settlement !== undefined ||
            envelope.preparationCancel !== undefined ||
            !Number.isSafeInteger(taskResultWrite.threadIncarnation) ||
            taskResultWrite.threadIncarnation < 1 ||
            !(
              taskResultWrite.expectedRevision === null ||
              (Number.isSafeInteger(taskResultWrite.expectedRevision) &&
                taskResultWrite.expectedRevision >= 0)
            ) ||
            (taskResultWrite.accept !== undefined &&
              (!Number.isSafeInteger(taskResultWrite.accept.checkReceiptSequence) ||
                taskResultWrite.accept.checkReceiptSequence < 0 ||
                !Number.isSafeInteger(taskResultWrite.accept.observedThroughSequence) ||
                taskResultWrite.accept.observedThroughSequence < 0))
          ) {
            return yield* taskResultWriteReject();
          }
          const taskResultPayload = taskResultPayloadOption.value;
          // The payload and the guard must name the same thread, incarnation,
          // and next revision, and an acceptance may only write through the
          // accept path it was judged under — a non-null acceptance with no
          // accept guard, and a guard with a null acceptance, both refuse.
          if (
            taskResultPayload.threadId !== envelope.command.threadId ||
            taskResultPayload.threadIncarnation !== taskResultWrite.threadIncarnation ||
            taskResultPayload.revision !==
              (taskResultWrite.expectedRevision === null
                ? 0
                : taskResultWrite.expectedRevision + 1) ||
            (taskResultPayload.acceptance !== null && taskResultWrite.accept === undefined) ||
            (taskResultPayload.acceptance === null && taskResultWrite.accept !== undefined) ||
            (taskResultPayload.acceptance !== null &&
              taskResultWrite.accept !== undefined &&
              taskResultPayload.acceptance.checkReceiptSequence !==
                taskResultWrite.accept.checkReceiptSequence)
          ) {
            return yield* taskResultWriteReject();
          }
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} changed before automatic settlement`,
          });
        }

        // The decider compares the lookup inputs. Only recreation needs an
        // event check, since it can reset a thread to the same field values.
        if (
          envelope.command.type === "thread.pull-request.sync" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
            type: "thread.created",
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} was recreated before pull request discovery`,
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          threadBackgroundLiveness.getThreadBackgroundLiveness(envelope.command.threadId) !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} has live background work`,
          });
        }

        // New and moved projects do not carry a resolved identity in the event-derived
        // command model. Legacy PR edits need it to identify the link they replace.
        if (
          envelope.command.type === "thread.meta.update" &&
          envelope.command.linkedPullRequest !== undefined
        ) {
          const threadId = envelope.command.threadId;
          const thread = commandReadModel.threads.find((thread) => thread.id === threadId);
          if (thread !== undefined) {
            const project = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId);
            if (Option.isSome(project)) {
              commandReadModel = {
                ...commandReadModel,
                projects: commandReadModel.projects.map((entry) =>
                  entry.id === thread.projectId
                    ? { ...entry, repositoryIdentity: project.value.repositoryIdentity }
                    : entry,
                ),
              };
            }
          }
        }

        // Command snapshots omit activities at startup and cap them while running.
        // Read this request's durable state before deciding how to send the answer.
        const userInputActivity =
          envelope.command.type === "thread.user-input.respond" ||
          envelope.command.type === "thread.user-input.dismiss"
            ? yield* projectionSnapshotQuery.getUserInputActivity(envelope.command)
            : Option.none();
        const turnStartFailScan =
          envelope.command.type === "thread.turn.start.fail"
            ? yield* readTurnStartFailScan(
                envelope.command.threadId,
                envelope.command.requestSequence,
              )
            : undefined;
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
          ...(Option.isSome(userInputActivity)
            ? { userInputActivity: userInputActivity.value }
            : {}),
          ...(turnStartFailScan !== undefined ? { turnStartFailScan } : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        // Release requires a live token, a returned turn ID seen in committed
        // running events, and a matching current provider instance. This matches
        // historical evidence; it does not establish event provenance. Otherwise
        // commands stay held without a receipt so the same command ID can retry.
        for (const planned of eventBases) {
          const heldThreadId =
            planned.type === "thread.turn-start-requested" ||
            planned.type === "thread.runtime-mode-set" ||
            planned.type === "thread.checkpoint-revert-requested" ||
            planned.type === "thread.created"
              ? planned.payload.threadId
              : undefined;
          if (heldThreadId === undefined) continue;
          const token = continuations.current(heldThreadId);
          if (token === undefined) continue;
          const heldThread = commandReadModel.threads.find((entry) => entry.id === heldThreadId);
          if (
            continuations.isLive(token) &&
            token.evidence?.kind === "returned" &&
            token.seen.has(token.evidence.turnId) &&
            heldThread !== undefined &&
            heldThread.deletedAt === null &&
            heldThread.session?.providerInstanceId === token.providerInstanceId
          ) {
            continuations.retire(token);
            continue;
          }
          return yield* new OrchestrationRestartRecoveryHeldError({
            commandType: envelope.command.type,
            threadId: heldThreadId,
            detail:
              !continuations.isLive(token) ||
              token.evidence?.kind === "unverified" ||
              token.evidence?.kind === "revoked"
                ? "Restart recovery could not be verified. Continue in a new thread. Restarting the server will re-check this thread."
                : "This thread is still resuming. Retry when recovery finishes, or stop it and continue in a new thread.",
          });
        }
        // A decided batch invalidates memory provenance when it writes away
        // the rows the admission read depends on: the live project row, the
        // live thread row and its project association, or the originating
        // user message. Selection is by decided event, never command
        // spelling — a forced project delete arrives as a tombstone batch,
        // and a recreated thread resets the association and drops the
        // message history even though the id survives. The fence wraps the
        // outer transaction itself, so it releases after the real COMMIT or
        // ROLLBACK, never at an inner savepoint.
        let invalidatesMemoryProvenance = eventBases.some(
          (event) =>
            event.type === "project.deleted" ||
            event.type === "thread.deleted" ||
            event.type === "thread.reverted" ||
            (event.type === "thread.created" &&
              commandReadModel.threads.some((entry) => entry.id === event.payload.threadId)),
        );
        // Message upserts key on the global message id, so a decided
        // thread.message-sent can move an existing user row to another
        // thread or rewrite it away from the user role. Only that
        // membership change invalidates provenance — a fresh id or a
        // same-thread user row does not. The durable row, never the
        // capped command read model, decides; a failed read is unclear
        // state rather than "not invalidating", and interrupt-bearing
        // causes pass through untouched.
        if (!invalidatesMemoryProvenance) {
          for (const event of eventBases) {
            if (event.type !== "thread.message-sent") continue;
            const movesUserMessage = yield* threadMessageRepository
              .getByMessageId({ messageId: event.payload.messageId })
              .pipe(
                Effect.map((existing) =>
                  Option.exists(
                    existing,
                    (row) =>
                      row.role === "user" &&
                      (row.threadId !== event.payload.threadId || event.payload.role !== "user"),
                  ),
                ),
                Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError> => {
                  // An interrupt-bearing classification failure is surfaced
                  // to the caller intact — the delivery branch below must
                  // recognize this read specifically, since an ordinary
                  // command carries no guard flag.
                  provenanceClassificationInterrupted ||= Cause.hasInterrupts(cause);
                  return Cause.hasInterrupts(cause) || !Cause.hasFails(cause)
                    ? Effect.failCause(cause)
                    : Effect.fail(
                        new OrchestrationCommandStateUnavailableError({
                          commandType: envelope.command.type,
                          cause,
                        }),
                      );
                }),
              );
            if (movesUserMessage) {
              invalidatesMemoryProvenance = true;
              break;
            }
          }
        }
        const commitTransaction = sql.withTransaction(
          Effect.gen(function* () {
            // The decider's UUID draw yields asynchronously, and acquiring
            // the transaction can suspend too: the held token may have died
            // or been replaced since the scan. This is the last
            // mutable-state decision before the first append.
            if (settlement !== undefined && !settlementTokenHeld()) {
              return yield* settlementReject();
            }

            // A guarded task-result write re-reads its judged state here —
            // inside this transaction, ahead of the first append — and only
            // the transaction's own commits can follow. A durable-read
            // failure is unclear state, never a durable rejection: plain
            // store failures become retryable StateUnavailable while
            // interrupt-bearing causes propagate intact. Only a real
            // mismatch is a permanent refusal, and it appends nothing.
            if (
              taskResultWrite !== undefined &&
              envelope.command.type === "thread.activity.append"
            ) {
              const command = envelope.command;
              const taskResultRead = <A, E extends OrchestrationDispatchError>(
                read: Effect.Effect<A, E>,
              ): Effect.Effect<A, OrchestrationDispatchError> =>
                read.pipe(
                  Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError> =>
                    Cause.hasInterrupts(cause) || !Cause.hasFails(cause)
                      ? Effect.failCause(cause)
                      : Effect.fail(
                          new OrchestrationCommandStateUnavailableError({
                            commandType: envelope.command.type,
                            cause,
                          }),
                        ),
                  ),
                );

              // The claimed incarnation must resolve to this thread's own
              // `thread.created` at that exact sequence, and still be the
              // newest create/delete boundary on the log.
              const incarnationEvents = yield* taskResultRead(
                Stream.runCollect(
                  eventStore.readAggregateRange({
                    aggregateKind: "thread",
                    aggregateId: command.threadId,
                    fromSequenceExclusive: taskResultWrite.threadIncarnation - 1,
                    toSequenceInclusive: taskResultWrite.threadIncarnation,
                    limit: 1,
                  }),
                ),
              );
              const incarnationEvent = incarnationEvents[0];
              const threadReincarnated = yield* taskResultRead(
                Effect.zipWith(
                  eventStore.hasEventAfter({
                    aggregateKind: "thread",
                    aggregateId: command.threadId,
                    type: "thread.created",
                    sequenceExclusive: taskResultWrite.threadIncarnation,
                  }),
                  eventStore.hasEventAfter({
                    aggregateKind: "thread",
                    aggregateId: command.threadId,
                    type: "thread.deleted",
                    sequenceExclusive: taskResultWrite.threadIncarnation,
                  }),
                  (createdAfter, deletedAfter) => createdAfter || deletedAfter,
                ),
              );
              if (
                incarnationEvent === undefined ||
                incarnationEvent.sequence !== taskResultWrite.threadIncarnation ||
                incarnationEvent.aggregateKind !== "thread" ||
                incarnationEvent.aggregateId !== command.threadId ||
                incarnationEvent.type !== "thread.created" ||
                incarnationEvent.payload.threadId !== command.threadId ||
                threadReincarnated
              ) {
                return yield* taskResultWriteReject();
              }

              // The durable record row must decode to the record the guard
              // claims — a malformed row is not an absent one.
              const storedRows = yield* taskResultRead(
                threadActivityRepository.listByThreadId({
                  threadId: command.threadId,
                  activityKinds: [TASK_RESULT_ACTIVITY_KIND],
                }),
              );
              const storedRow = storedRows.find(
                (row) => row.activityId === taskResultRecordId(command.threadId),
              );
              const storedRecord =
                storedRow === undefined
                  ? null
                  : Option.getOrNull(decodeTaskResultRecord(storedRow.payload));
              const stored =
                storedRecord === null || storedRecord.threadId !== command.threadId
                  ? null
                  : storedRecord;
              if (
                taskResultWrite.expectedRevision === null
                  ? storedRow !== undefined
                  : stored === null ||
                    stored.revision !== taskResultWrite.expectedRevision ||
                    stored.threadIncarnation !== taskResultWrite.threadIncarnation
              ) {
                return yield* taskResultWriteReject();
              }

              // Re-decode the incoming payload; the shape check above
              // already proved it and the guard agree on thread,
              // incarnation, next revision, and the acceptance flag.
              const taskResultPayload = Option.getOrNull(
                decodeTaskResultRecord(command.activity.payload),
              );
              const incomingAcceptance = taskResultPayload?.acceptance ?? null;
              if (taskResultPayload === null || taskResultPayload.threadId !== command.threadId) {
                return yield* taskResultWriteReject();
              }
              if (incomingAcceptance === null) {
                // An acceptance-free write keeps exactly two shapes: a
                // requirements revision (first set is version 1, each
                // later set is stored version + 1) or a withdraw that
                // preserves the stored requirements unchanged.
                const isRequirementsRevision =
                  taskResultPayload.requirements !== null &&
                  taskResultPayload.requirements.version ===
                    (stored?.requirements?.version ?? 0) + 1;
                const isWithdraw =
                  stored !== null &&
                  Equal.equals(taskResultPayload.requirements, stored.requirements);
                if (!isRequirementsRevision && !isWithdraw) {
                  return yield* taskResultWriteReject();
                }
              } else {
                // An acceptance never revises requirements: it preserves
                // them verbatim and names their stored version.
                if (
                  stored === null ||
                  stored.requirements === null ||
                  !Equal.equals(taskResultPayload.requirements, stored.requirements) ||
                  incomingAcceptance.requirementsVersion !== stored.requirements.version
                ) {
                  return yield* taskResultWriteReject();
                }

                const accept = taskResultWrite.accept;
                if (
                  accept === undefined ||
                  accept.observedThroughSequence < taskResultWrite.threadIncarnation ||
                  accept.observedThroughSequence > commandReadModel.snapshotSequence
                ) {
                  return yield* taskResultWriteReject();
                }

                // The judged receipt must still be the durable fixed row's
                // exact contents: same thread, same sequence, completed,
                // bound to this incarnation's anchor.
                const receiptRows = yield* taskResultRead(
                  threadActivityRepository.listByThreadId({
                    threadId: command.threadId,
                    activityKinds: [SELECTED_CHECK_RECEIPT_KIND],
                  }),
                );
                const receiptRow = receiptRows.find(
                  (row) => row.activityId === selectedCheckReceiptId(command.threadId),
                );
                const receipt =
                  receiptRow === undefined
                    ? null
                    : Option.getOrNull(decodeSelectedCheckReceipt(receiptRow.payload));
                const receiptAnchor = receipt?.threadAnchorSequence ?? receiptRow?.sequence;
                if (
                  receiptRow === undefined ||
                  receipt === null ||
                  receipt.threadId !== command.threadId ||
                  receiptRow.sequence !== accept.checkReceiptSequence ||
                  receiptAnchor === undefined ||
                  receiptAnchor < taskResultWrite.threadIncarnation ||
                  receipt.phase !== "completed" ||
                  receipt.attemptId !== incomingAcceptance.checkAttemptId
                ) {
                  return yield* taskResultWriteReject();
                }

                // No work may have engaged since the caller measured: no
                // committed turn-start or checkpoint-revert request after
                // its observed head, and no live turn or session. Turn and
                // session projection rows are written in the committing
                // transaction, so a durable pending placeholder, running
                // row, or engaged session is the exact "work is engaged"
                // signal — including states the capped command snapshot has
                // not surfaced.
                const threadReengaged = yield* taskResultRead(
                  Effect.zipWith(
                    eventStore.hasEventAfter({
                      aggregateKind: "thread",
                      aggregateId: command.threadId,
                      type: "thread.turn-start-requested",
                      sequenceExclusive: accept.observedThroughSequence,
                    }),
                    eventStore.hasEventAfter({
                      aggregateKind: "thread",
                      aggregateId: command.threadId,
                      type: "thread.checkpoint-revert-requested",
                      sequenceExclusive: accept.observedThroughSequence,
                    }),
                    (turnRequested, revertRequested) => turnRequested || revertRequested,
                  ),
                );
                const engagedTurnRows = yield* taskResultRead(
                  projectionTurnRepository.listByThreadId({
                    threadId: command.threadId,
                  }),
                );
                const engagedSession = yield* taskResultRead(
                  threadSessionRepository.getByThreadId({
                    threadId: command.threadId,
                  }),
                );
                if (
                  threadReengaged ||
                  engagedTurnRows.some(
                    (row) => row.state === "pending" || row.state === "running",
                  ) ||
                  (Option.isSome(engagedSession) &&
                    (engagedSession.value.status === "starting" ||
                      engagedSession.value.status === "running" ||
                      engagedSession.value.activeTurnId !== null))
                ) {
                  return yield* taskResultWriteReject();
                }
              }
            }

            // The skill send gate is the authoritative admission point for
            // managed `project-skill` context records — inside this
            // transaction, ahead of the first append. A genuinely new user
            // message is authorized on its planned durable text and context,
            // never the command's, and only that event's records are
            // restamped with the canonical admission. A same-id reuse plans
            // no message event: the incoming records alone would look
            // ordinary to the gate, so the stored message is inspected too —
            // managed on either side refuses without restamping or
            // substitute-authorizing the reused input.
            let gatedEventBases = eventBases;
            if (
              envelope.command.type === "thread.message.user.append" &&
              hasManagedSkillRecord(envelope.command.message.context?.records ?? [])
            ) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported,
              });
            } else if (envelope.command.type === "thread.turn.start") {
              const command = envelope.command;
              const plannedUserMessage = gatedEventBases.find(
                (
                  event,
                ): event is Extract<
                  (typeof eventBases)[number],
                  { readonly type: "thread.message-sent" }
                > =>
                  event.type === "thread.message-sent" &&
                  event.payload.messageId === command.message.messageId &&
                  event.payload.role === "user",
              );
              if (plannedUserMessage !== undefined) {
                const decision = yield* skillSendGate
                  .authorizeInTransaction({
                    threadId: command.threadId,
                    messageId: command.message.messageId,
                    text: plannedUserMessage.payload.text,
                    records: plannedUserMessage.payload.context?.records ?? [],
                    bootstrap: command.bootstrap !== undefined,
                  })
                  .pipe(
                    Effect.catchCause((cause) => {
                      // The gate forwards interrupts only; keep the cause
                      // intact to the caller rather than squashing it into a
                      // rejection receipt for a send that was never decided.
                      skillGateInterrupted ||= Cause.hasInterrupts(cause);
                      return Effect.failCause(cause);
                    }),
                  );
                if (decision._tag === "Rejected") {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: PROJECT_SKILL_SEND_REJECTION_DETAIL[decision.reason],
                  });
                }
                if (decision._tag === "Admitted") {
                  gatedEventBases = gatedEventBases.map((event) =>
                    event === plannedUserMessage
                      ? {
                          ...plannedUserMessage,
                          payload: {
                            ...plannedUserMessage.payload,
                            context: { version: 1, records: decision.records },
                          },
                        }
                      : event,
                  );
                }
              } else {
                const reusedInput = yield* threadMessageRepository
                  .getByMessageId({ messageId: command.message.messageId })
                  .pipe(
                    Effect.catchCause((cause): Effect.Effect<never, OrchestrationDispatchError> => {
                      skillGateInterrupted ||= Cause.hasInterrupts(cause);
                      return Cause.hasInterrupts(cause) || !Cause.hasFails(cause)
                        ? Effect.failCause(cause)
                        : Effect.fail(
                            new OrchestrationCommandStateUnavailableError({
                              commandType: command.type,
                              cause,
                            }),
                          );
                    }),
                  );
                if (
                  Option.exists(reusedInput, (row) =>
                    hasManagedSkillRecord(row.context?.records ?? []),
                  ) ||
                  hasManagedSkillRecord(command.message.context?.records ?? [])
                ) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported,
                  });
                }
              }
            }

            const committedEvents: OrchestrationEvent[] = [];
            const attachmentCleanups: Effect.Effect<void>[] = [];
            let nextCommandReadModel = commandReadModel;

            for (const nextEvent of gatedEventBases) {
              const savedEvent = yield* eventStore.append(nextEvent);
              nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
              const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
              attachmentCleanups.push(cleanup);
              committedEvents.push(savedEvent);
            }

            const lastSavedEvent = committedEvents.at(-1) ?? null;
            if (lastSavedEvent === null) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Command produced no events.",
              });
            }

            yield* commandReceiptRepository.upsert({
              commandId: envelope.command.commandId,
              aggregateKind: lastSavedEvent.aggregateKind,
              aggregateId: lastSavedEvent.aggregateId,
              acceptedAt: lastSavedEvent.occurredAt,
              resultSequence: lastSavedEvent.sequence,
              status: "accepted",
              error: null,
            });

            return {
              committedEvents,
              attachmentCleanups,
              lastSequence: lastSavedEvent.sequence,
              nextCommandReadModel,
            } as const;
          }),
        );
        const skillLifecycleProjectIds = mergeSkillLifecycleMutationProjects(
          resolveSkillLifecycleMutationProjectsFromCommand(envelope.command, commandReadModel),
          resolveSkillLifecycleMutationProjectsFromEvents(
            envelope.command,
            eventBases,
            commandReadModel,
          ),
        );
        const commitAndPublishAuthority = Effect.gen(function* () {
          const committedCommand = yield* (
            invalidatesMemoryProvenance
              ? memorySendLedger.withMemoryMutation(commitTransaction)
              : commitTransaction
          ).pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

          commandReadModel = committedCommand.nextCommandReadModel;
          observeCommittedEvents(committedCommand.committedEvents);
          // A committed settlement releases its exact held token; retire only
          // removes the identical current object, so a successor is untouched.
          if (envelope.settlement !== undefined) {
            continuations.retire(envelope.settlement.token);
          }
          unpublishedCommitted.push(...committedCommand.committedEvents);
          for (const cleanup of committedCommand.attachmentCleanups) {
            yield* cleanup;
          }
          while (unpublishedCommitted.length > 0) {
            const event = unpublishedCommitted[0];
            if (event === undefined) break;
            yield* PubSub.publish(eventPubSub, event);
            unpublishedCommitted.shift();
            if (event === committedCommand.committedEvents[0]) {
              yield* Metric.update(
                Metric.withAttributes(
                  orchestrationCommandAckDuration,
                  metricAttributes({
                    ...baseMetricAttributes,
                    ackEventType: event.type,
                  }),
                ),
                Duration.millis(
                  Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs),
                ),
              );
            }
          }
          return { sequence: committedCommand.lastSequence };
        });

        return yield* skillLifecycleProjectIds === null
          ? commitAndPublishAuthority
          : skillMutationFence.withProjectMutation(
              skillLifecycleProjectIds,
              commitAndPublishAuthority,
            );
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          // A preparation-cancel, guarded task-result, or provenance
          // classification dispatch interrupted mid-read must surface the
          // original cause — squashing would erase the interrupt reason, and
          // a rejection receipt would be wrong for a command that was never
          // decided. The reactor settles on the next control event.
          if (
            (envelope.preparationCancel !== undefined ||
              envelope.taskResultWrite !== undefined ||
              provenanceClassificationInterrupted ||
              skillGateInterrupted) &&
            Cause.hasInterrupts(exit.cause)
          ) {
            yield* Deferred.failCause(envelope.result, exit.cause);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error) &&
            !isOrchestrationCommandStateUnavailableError(error) &&
            !isOrchestrationRestartRecoveryHeldError(error)
          ) {
            yield* catchUpCommandReadModel.pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  gap = true;
                  yield* Effect.logWarning(
                    "failed to reconcile orchestration read model after dispatch failure",
                  ).pipe(
                    Effect.annotateLogs({
                      commandId: envelope.command.commandId,
                      snapshotSequence: commandReadModel.snapshotSequence,
                    }),
                  );
                }),
              ),
            );

            if (isOrchestrationCommandRejection(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.ignore);
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: "thread", aggregateId: threadId });

  const getThreadReplayStats: OrchestrationEngineShape["getThreadReplayStats"] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: "thread",
      aggregateId: threadId,
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        settlement: options?.continuationSettlement,
        preparationCancel: options?.preparationCancel,
        taskResultWrite: options?.taskResultWrite,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

// The task-result guard reads durable activity, turn, and session rows through
// these repositories on the engine's own SqlClient, so a guard read inside a
// dispatch transaction joins that transaction instead of racing a stale view.
// The message repository stays an external requirement — the projection
// pipeline re-exports it through Layer.provideMerge, so every composite that
// provides the pipeline resolves it while tests can still decorate it.
// ProjectMemorySendLedgerLayer is the same module value the server composes
// for the send gate and memory service, so one build memoizes one ledger
// instance — the mutation fence the engine applies is the counter the gate
// reads, on the same shared SqlClient.
export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadSessionRepositoryLive),
  Layer.provide(ProjectMemorySendLedgerLayer),
  Layer.provideMerge(ProjectSkillMutationFenceLayer),
);
