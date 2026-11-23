import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationEvent,
  PROJECT_SKILL_CONTEXT_KIND,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  ProjectMemoryId,
  type OrchestrationSession,
  type ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  normalizeProjectMemoryReferenceLabels,
  projectComposerContextForProvider,
  resolveProjectMemoryReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  MEMORY_SEND_HOLD_DETAIL,
  MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
  type MemorySendHoldReason,
  ProjectMemorySendGate,
} from "../../memory/ProjectMemorySendGate.ts";
import { PROJECT_SKILL_SEND_REJECTION_DETAIL } from "../../skills/ProjectSkillSendGate.ts";
import {
  ProjectSkillTrialDelivery,
  type ProjectSkillTrialDeliveryEntered,
} from "../../skills/ProjectSkillTrialDelivery.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import type {
  ProviderAdmissionObservation,
  ProviderSubmissionRoutePreview,
} from "../../provider/Services/ProviderAdapter.ts";
import {
  ProviderService,
  type ProviderSkillTrialHandoff,
  type ProviderSkillTrialRoute,
} from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle } from "../threadTitles.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { ProviderCapacity } from "../../provider/Services/ProviderCapacity.ts";
import { makeThreadTitleOperations } from "./ProviderCommandReactor.titles.ts";
import {
  makeProviderFailureReporting,
  formatFailureDetail,
  MemoryHoldFailure,
  sameSubmissionObservation,
  type ProviderIntentEvent,
  interruptOnly,
  type MemorySessionRestore,
  toNonEmptyProviderInput,
  isCompactCommandMessage,
  turnStartKeyForEvent,
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL,
} from "./ProviderCommandReactor.helpers.ts";
import { makeProviderSessionOperations } from "./ProviderCommandReactor.session.ts";
import {
  makeProviderLifecycleOperations,
  type InFlightSend,
  type QueuedTurnStart,
} from "./ProviderCommandReactor.lifecycle.ts";
import { makeProviderResponseOperations } from "./ProviderCommandReactor.responses.ts";

export { providerErrorLabelFromInstanceHint } from "./ProviderCommandReactor.helpers.ts";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  // Optional so focused reactor tests need not build the capacity layer; production always has it.
  const capacity = yield* Effect.serviceOption(ProviderCapacity);
  const providerRegistry = yield* ProviderRegistry;
  const memorySendGate = yield* ProjectMemorySendGate;
  const skillTrialDelivery = yield* ProjectSkillTrialDelivery;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const sql = yield* SqlClient.SqlClient;
  const {
    providerDiagnosticText,
    providerDiagnosticTextPair,
    serverCommandId,
    serverEventId,
    appendProviderFailureActivity,
  } = makeProviderFailureReporting({ crypto, sql, orchestrationEngine });

  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const compactingThreadIds = new Set<ThreadId>();
  // Turn starts received while a thread compacts, replayed in order once its session is restored.
  const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
  // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
  // provider send finishes, which is what lets the next queued turn follow it in order.
  const resumedTurnStarts = new Map<
    CommandId,
    {
      readonly event: QueuedTurnStart;
      readonly queued: Array<QueuedTurnStart>;
      readonly sent: Deferred.Deferred<void>;
    }
  >();
  const stoppingThreadIds = new Set<ThreadId>();
  const inFlightSends = new Map<ThreadId, Set<InFlightSend>>();
  // Registration is synchronous in the same worker step that forks: a Stop
  // or Interrupt handled after this point always finds the entry. The
  // observer also runs immediately for an already-completed fiber, so no
  // entry goes stale.
  const trackInFlight = (threadId: ThreadId, entry: InFlightSend) => {
    const entries = inFlightSends.get(threadId) ?? new Set<InFlightSend>();
    entries.add(entry);
    inFlightSends.set(threadId, entries);
    entry.fiber.addObserver(() => {
      entries.delete(entry);
      if (entries.size === 0 && inFlightSends.get(threadId) === entries) {
        inFlightSends.delete(threadId);
      }
    });
  };

  // Per-thread preparation lane. Worktree recreation, the workspace lease,
  // session start/bind, and preparation recovery run one entry at a time in
  // registration order, so a successor can never open a session while the
  // predecessor's recovery is still writing. Entries are linked so an
  // interrupted waiter still releases the successors queued behind it in
  // order; an entry is removed from the map only while it is the live tail,
  // so a stale predecessor can never delete a successor's tail or release it
  // before its own turn arrives.
  type PreparationLaneEntry = {
    finished: boolean;
    released: boolean;
    readonly done: Deferred.Deferred<void>;
    previous: PreparationLaneEntry | undefined;
    next: PreparationLaneEntry | undefined;
  };
  const preparationTails = new Map<ThreadId, PreparationLaneEntry>();
  const releasePreparationEntries = (threadId: ThreadId, entry: PreparationLaneEntry) => {
    let current: PreparationLaneEntry | undefined = entry;
    while (
      current !== undefined &&
      current.finished &&
      !current.released &&
      (current.previous === undefined || current.previous.released)
    ) {
      current.released = true;
      current.previous = undefined;
      if (preparationTails.get(threadId) === current) {
        preparationTails.delete(threadId);
      }
      Deferred.doneUnsafe(current.done, Effect.void);
      current = current.next;
    }
  };
  // Registration is synchronous inside the worker step, before any lease,
  // worktree or provider work runs: a Stop or Interrupt handled after this
  // point always finds this thread's owners and waiters in `inFlightSends`.
  const enterPreparationLane = (threadId: ThreadId) => {
    const previous = preparationTails.get(threadId);
    const entry: PreparationLaneEntry = {
      finished: false,
      released: false,
      done: Deferred.makeUnsafe<void>(),
      previous,
      next: undefined,
    };
    if (previous !== undefined) {
      previous.next = entry;
    }
    preparationTails.set(threadId, entry);
    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      (previous === undefined
        ? effect
        : Deferred.await(previous.done).pipe(Effect.andThen(effect))
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.finished = true;
            releasePreparationEntries(threadId, entry);
          }),
        ),
      );
  };

  const {
    projectSettingsForThread,
    resolveProject,
    ensureThreadWorktree,
    resolveThreadShell,
    resolveThreadDetail,
    ensureSessionForThread,
    buildSendTurnRequestForThread,
    setThreadSession,
    setThreadSessionErrorOnTurnStartFailure,
  } = makeProviderSessionOperations({
    orchestrationEngine,
    projectionSnapshotQuery,
    providerService,
    capacity,
    providerRegistry,
    gitWorkflow,
    fileSystem,
    serverSettingsService,
    providerDiagnosticText,
    serverCommandId,
    threadModelSelections,
  });

  const {
    detachTurnsAfterCompaction,
    reportCanceledQueuedTurns,
    cancelTurnsAfterCompaction,
    restoreCompaction,
    processTurnInterruptRequested,
    processSessionStopRequested,
  } = makeProviderLifecycleOperations({
    orchestrationEngine,
    providerService,
    providerDiagnosticText,
    providerDiagnosticTextPair,
    serverCommandId,
    appendProviderFailureActivity,
    resolveThreadShell,
    setThreadSession,
    compactingThreadIds,
    stoppingThreadIds,
    turnsAfterCompaction,
    inFlightSends,
  });

  const { processApprovalResponseRequested, processUserInputResponseRequested } =
    makeProviderResponseOperations({
      providerService,
      providerDiagnosticText,
      appendProviderFailureActivity,
      resolveThreadShell,
    });

  const RESUME_AFTER_COMPACTION_FAILED_DETAIL =
    "The queued message could not resume after context compaction. Send this message again to continue.";
  const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    queued: Array<QueuedTurnStart>,
  ) {
    while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
      const event = queued[0]!;
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId,
        messageId: event.payload.messageId,
      });
      if (turnsAfterCompaction.get(threadId) !== queued) return;
      // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
      queued.shift();
      if (Option.isNone(turnStart)) continue;
      // Reissue the durable request after restoration clears compaction's
      // pending slot. Reusing the message id preserves a single user bubble.
      const commandId = yield* serverCommandId("after-compaction");
      const sent = yield* Deferred.make<void>();
      resumedTurnStarts.set(commandId, { event, queued, sent });
      const { messageId, ...request } = event.payload;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          ...request,
          message: {
            messageId,
            role: "user",
            text: turnStart.value.message.text,
            attachments: turnStart.value.message.attachments ?? [],
          },
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              resumedTurnStarts.delete(commandId);
              queued.unshift(event);
            }),
          ),
        );
      yield* Deferred.await(sent);
      resumedTurnStarts.delete(commandId);
    }
    if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
  });

  const {
    maybeGenerateAndRenameWorktreeBranchForFirstTurn,
    maybeGenerateThreadTitleForFirstTurn,
    maybeRefineThreadTitle,
    findPendingThreadTitles,
    clearInterruptedThreadTitleRegenerations,
    processThreadTitleRegenerationSafely,
  } = makeThreadTitleOperations({
    orchestrationEngine,
    projectionSnapshotQuery,
    providerRegistry,
    gitWorkflow,
    vcsStatusBroadcaster,
    textGeneration,
    serverSettingsService,
    providerDiagnosticText,
    projectSettingsForThread,
    serverCommandId,
    resolveProject,
    resolveThreadShell,
    resolveThreadDetail,
  });
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const { message, hasOtherUserMessages } = turnStart.value;
    // The lane serializes preparation inside a tracked child, so the
    // workspace lease must live inside that child's body — waiting for the
    // lane happens before the lease is taken, never while it is held.
    const leased = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      thread.worktreePath ? withWorkspaceLease(path.resolve(thread.worktreePath), effect) : effect;
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    // Fixed reporter for every project-memory hold/failure path, shared by
    // L0/L1/L1′/L2/L3 and the compaction hold. One engine command records the
    // failure and, only when `restore` names this ensure's last session-set and
    // the thread's history is still quiet, restores the session it left
    // "starting"; the engine drops the requestId when this message was reissued,
    // so a stale report cannot clear the new request's pending row. The request
    // is anchored at the event this reactor actually received, never at the
    // resumed queued request's original sequence. A reporting failure never
    // falls through to session-error recovery or leaks a cause: interrupts are
    // rethrown stripped of other reasons, everything else becomes one
    // cause-free warning.
    const reportMemoryFailure = (summary: string, detail: string, restore?: MemorySessionRestore) =>
      Effect.all({
        commandId: serverCommandId("memory-turn-start-failure"),
        activityId: serverEventId(),
        failedAt: Effect.map(DateTime.now, DateTime.formatIso),
      }).pipe(
        Effect.flatMap(({ commandId, activityId, failedAt }) =>
          orchestrationEngine.dispatch({
            type: "thread.turn.start.fail",
            commandId,
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            requestSequence: receivedEvent.sequence,
            sessionSequence: restore?.sessionSetSequence ?? null,
            restoreStatus: restore?.status ?? "ready",
            activityId,
            summary,
            detail,
            createdAt: event.payload.createdAt,
            failedAt,
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(interruptOnly(cause))
            : Effect.logWarning("project memory failure could not be recorded", {
                threadId: event.payload.threadId,
              }),
        ),
        Effect.asVoid,
      );
    if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
      return yield* appendTurnStartFailure(
        "Queued message was not sent",
        "The queued message was canceled before it could resume. Send it again to continue.",
      );
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const rawDetail = () => formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        rawDetail,
        createdAt: event.payload.createdAt,
      }).pipe(
        // The activity sink rechecks: no clean detail is retained across the
        // session write between the two diagnostic reports.
        Effect.flatMap(() =>
          providerDiagnosticText(event.payload.threadId, rawDetail).pipe(
            Effect.flatMap((detail) =>
              appendTurnStartFailure("Provider turn start failed", detail),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(recoveryCause)) {
              return yield* Effect.failCause(recoveryCause);
            }
            const causes = yield* providerDiagnosticTextPair(
              event.payload.threadId,
              () => Cause.pretty(recoveryCause),
              () => Cause.pretty(cause),
            );
            yield* Effect.logWarning(
              "provider command reactor failed to recover turn start failure",
              {
                eventType: event.type,
                threadId: event.payload.threadId,
                cause: causes.cause,
                originalCause: causes.originalCause,
              },
            );
          }),
        ),
      );

    const authCommandHandled = yield* Effect.gen(function* () {
      // Native account commands belong to the thread's existing provider session.
      const instanceId =
        thread.session?.providerInstanceId ??
        event.payload.modelSelection?.instanceId ??
        thread.modelSelection.instanceId;
      const handled = yield* providerAuthService.tryHandlePromptCommand({
        instanceId,
        text: message.text,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });
      if (!handled) {
        return false;
      }

      const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: instanceInfo.driverKind,
          providerInstanceId: instanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provider-sign-out"),
        threadId: thread.id,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.auth.signed-out",
          summary: "Provider signed out",
          payload: { providerInstanceId: instanceId },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return true;
    }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))));
    if (authCommandHandled) {
      return;
    }

    // L0 — persisted affected-state holds are authoritative even while the
    // driver allowlist is empty; a failed store read holds the turn too.
    const l0Hold = yield* memorySendGate.threadHold(thread.id);
    if (Option.isSome(l0Hold)) {
      yield* reportMemoryFailure("Message not sent", MEMORY_SEND_HOLD_DETAIL[l0Hold.value]);
      return;
    }

    // L1 — resolve the reserved memory identities actually referenced here.
    const memoryResolution = resolveProjectMemoryReferences({
      text: message.text,
      records: message.context?.records ?? [],
    });
    if (!memoryResolution.ok) {
      yield* reportMemoryFailure(
        "Message not sent",
        MEMORY_SEND_HOLD_DETAIL[
          memoryResolution.reason === "version-conflict" ? "version-changed" : "unavailable"
        ],
      );
      return;
    }
    const hasMemoryReferences = memoryResolution.references.length > 0;
    if (hasMemoryReferences && isCompactCommandMessage(message)) {
      yield* reportMemoryFailure("Message not sent", MEMORY_SEND_HOLD_DETAIL.unavailable);
      return;
    }
    const hasSkillTrial = (message.context?.records ?? []).some(
      (record) => record.kind === PROJECT_SKILL_CONTEXT_KIND,
    );
    // A managed trial send never shares its carrier: a memory reference, a
    // compact command, or any other mixed durable shape is held — never
    // partially delivered through another path.
    if (hasSkillTrial && (hasMemoryReferences || isCompactCommandMessage(message))) {
      yield* reportMemoryFailure(
        "Message not sent",
        PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported,
      );
      return;
    }

    // L1′ — the expected instance is a preflight rejection only. The actual
    // admitted instance is rechecked against listSessions inside the send fiber.
    let expectedMemoryDriverKind: ProviderDriverKind | undefined;
    if (hasMemoryReferences) {
      const expectedInstanceId =
        event.payload.modelSelection?.instanceId ??
        thread.session?.providerInstanceId ??
        thread.modelSelection.instanceId;
      const expectedInfo = yield* providerService
        .getInstanceInfo(expectedInstanceId)
        .pipe(Effect.option);
      if (Option.isNone(expectedInfo)) {
        yield* reportMemoryFailure("Message not sent", MEMORY_SEND_HOLD_DETAIL.unavailable);
        return;
      }
      if (!memorySendGate.driverAllowed(expectedInfo.value.driverKind)) {
        yield* reportMemoryFailure("Message not sent", MEMORY_SEND_HOLD_DETAIL["not-supported"]);
        return;
      }
      expectedMemoryDriverKind = expectedInfo.value.driverKind;
    }

    const isCompactCommand = isCompactCommandMessage(message);

    let compactionSessionEnsured = false;
    // The compaction ensure's own last session-set, for the hold report below.
    let compactionSessionSetSequence: number | null = null;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      // A memory hold takes the bounded cleanup path: one fixed failure report.
      // The session is restored only when the engine finds the thread quiet
      // since this ensure's write; any newer turn, stop or write keeps the
      // session as it is. An interrupt beside the hold is not reported — it
      // leaves with only its interrupt reasons. The outer pipeline still
      // clears the compaction map and cancels queued turns.
      const holdFailure = Cause.findErrorOption(cause);
      if (Option.isSome(holdFailure) && holdFailure.value instanceof MemoryHoldFailure) {
        if (Cause.hasInterrupts(cause)) {
          return Effect.failCause(interruptOnly(cause));
        }
        return reportMemoryFailure("Context compaction failed", holdFailure.value.detail, {
          sessionSetSequence: compactionSessionSetSequence,
          status: "ready",
        });
      }
      const rawDetail = () => formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          rawDetail,
          createdAt: event.payload.createdAt,
        }).pipe(
          // The activity sink rechecks: no clean detail is retained across the
          // session write between the two diagnostic reports.
          Effect.flatMap(() =>
            providerDiagnosticText(event.payload.threadId, rawDetail).pipe(
              Effect.flatMap((detail) =>
                appendTurnStartFailure("Context compaction failed", detail),
              ),
            ),
          ),
          Effect.asVoid,
        );
      }
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const activityExit = yield* Effect.exit(
            restore(
              providerDiagnosticText(event.payload.threadId, rawDetail).pipe(
                Effect.flatMap((detail) =>
                  appendTurnStartFailure("Context compaction failed", detail),
                ),
              ),
            ),
          );
          const cleanupExit = yield* Effect.exit(
            restoreCompaction(event.payload.threadId).pipe(
              Effect.catchCause((restoreCause) =>
                Effect.gen(function* () {
                  if (Cause.hasInterrupts(restoreCause)) {
                    return yield* Effect.failCause(restoreCause);
                  }
                  const causeText = yield* providerDiagnosticText(event.payload.threadId, () =>
                    Cause.pretty(restoreCause),
                  );
                  yield* Effect.logWarning(
                    "failed to restore provider session after compaction failure",
                    {
                      threadId: event.payload.threadId,
                      cause: causeText,
                    },
                  );
                }),
              ),
            ),
          );
          if (Exit.isFailure(activityExit) && Exit.isFailure(cleanupExit)) {
            return yield* Effect.failCause(Cause.combine(activityExit.cause, cleanupExit.cause));
          }
          if (Exit.isFailure(activityExit)) {
            return yield* Effect.failCause(activityExit.cause);
          }
          if (Exit.isFailure(cleanupExit)) {
            return yield* Effect.failCause(cleanupExit.cause);
          }
        }),
      ).pipe(Effect.asVoid);
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(recoveryCause)) {
              return yield* Effect.failCause(recoveryCause);
            }
            const causes = yield* providerDiagnosticTextPair(
              event.payload.threadId,
              () => Cause.pretty(recoveryCause),
              () => Cause.pretty(cause),
            );
            yield* Effect.logWarning(
              "provider command reactor failed to recover compaction failure",
              {
                eventType: event.type,
                threadId: event.payload.threadId,
                cause: causes.cause,
                originalCause: causes.originalCause,
              },
            );
          }),
        ),
      );
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running" ||
        [...(inFlightSends.get(event.payload.threadId) ?? [])].some(
          (entry) => entry.kind !== "compaction" && !entry.progress.providerCalled,
        )
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      const progress = {
        ensureEntered: false,
        providerCalled: false,
        interrupted: false,
        ownedSessionSetSequence: null as number | null,
        ownedSession: null as OrchestrationSession | null,
      };
      // Captured after a successful restore while this phase still holds its
      // compaction flag: the replay fiber below is handed this array only and
      // never re-reads the map to pick a queue, so it cannot replay a queue a
      // successor compaction owns.
      let capturedQueue: Array<QueuedTurnStart> | undefined;
      const phaseFiber = yield* Effect.gen(function* () {
        yield* leased(ensureThreadWorktree(thread));
        progress.ensureEntered = true;
        const ensured = yield* ensureSessionForThread(
          event.payload.threadId,
          event.payload.createdAt,
          event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
            : { pendingTurnStart: true },
        );
        compactionSessionSetSequence = ensured.sessionSetSequence;
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        // Persisted affected state is checked again here, immediately before
        // the provider call — mutations since L0 must stop the compaction.
        const compactionHold = yield* memorySendGate.threadHold(event.payload.threadId);
        if (Option.isSome(compactionHold)) {
          return yield* new MemoryHoldFailure({
            detail: MEMORY_SEND_HOLD_DETAIL[compactionHold.value],
          });
        }
        progress.providerCalled = true;
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
        yield* restoreCompaction(event.payload.threadId, true);
        capturedQueue = turnsAfterCompaction.get(event.payload.threadId);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            progress.interrupted = true;
          }),
        ),
        // The queue this phase owns is canceled even when recovery leaves with
        // an interrupt (a real Stop already detached it, so this finds it empty).
        // A finalizer cannot fail, so the cleanup keeps only its interrupts and
        // turns any other failure into a fixed warning. Recovery leaves with
        // its cause untouched — including mixed interrupt-plus-failure causes
        // from the diagnostic guard's ledger lookup, which must reach this
        // phase fiber's boundary whole — and still marks the phase interrupted
        // so Stop/Interrupt report it. The old interruptOnly reduction here was
        // identity for pure interrupts and passed non-interrupt causes through,
        // so only those mixed causes changed shape.
        Effect.catchCause((cause) =>
          recoverCompactionFailure(cause).pipe(
            Effect.ensuring(
              cancelTurnsAfterCompaction(
                event.payload.threadId,
                "Context compaction failed. Send this message again to continue.",
              ).pipe(
                Effect.catchCause((cleanupCause) =>
                  Cause.hasInterrupts(cleanupCause)
                    ? Effect.failCause(interruptOnly(cleanupCause))
                    : Effect.logWarning("failed to cancel queued turns after compaction failure", {
                        threadId: event.payload.threadId,
                      }),
                ),
              ),
            ),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            progress.interrupted = true;
          }),
        ),
        // Sole flag release, bound to this phase's own lifetime: it finishes
        // before a joining Stop/Interrupt returns, so it can never delete a
        // successor's flag.
        Effect.ensuring(clearCompacting),
        // Success-only replay: `capturedQueue` is set solely on the restored
        // path above. The replay runs in a separately scoped fiber, so
        // interrupting this phase handle afterwards cannot reach it.
        Effect.andThen(
          Effect.suspend(() => {
            const queue = capturedQueue;
            if (queue === undefined) return Effect.void;
            return resumeTurnsAfterCompaction(event.payload.threadId, queue).pipe(
              // A failed replay owns only the queue it was captured with: it
              // may detach and report that queue, but never restore the
              // session, clear the compaction flag, or cancel a successor's.
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) {
                  return Effect.failCause(cause);
                }
                if (turnsAfterCompaction.get(event.payload.threadId) !== queue) {
                  return Effect.void;
                }
                return reportCanceledQueuedTurns(
                  event.payload.threadId,
                  detachTurnsAfterCompaction(event.payload.threadId),
                  RESUME_AFTER_COMPACTION_FAILED_DETAIL,
                );
              }),
              Effect.forkScoped,
              Effect.asVoid,
            );
          }),
        ),
        Effect.forkScoped,
      );
      trackInFlight(event.payload.threadId, {
        fiber: phaseFiber,
        kind: "compaction",
        messageId: event.payload.messageId,
        progress,
      });
      return;
    }
    if (
      !resumed &&
      (compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId))
    ) {
      const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
      queued.push(event);
      turnsAfterCompaction.set(event.payload.threadId, queued);
      return;
    }

    // Progress flags for Stop/Interrupt reporting: `providerCalled` flips only
    // when the send actually executes the provider call, so an interrupted
    // send can be reported as interrupted-after-entry vs never-sent.
    // `ownedSessionSetSequence` records this preparation's own last session-set
    // so a canceled preparation can cite the exact "starting" write as its
    // cancel anchor.
    const progress = {
      ensureEntered: false,
      providerCalled: false,
      interrupted: false,
      ownedSessionSetSequence: null as number | null,
      ownedSession: null as OrchestrationSession | null,
    };
    type BuiltSendTurn = Effect.Success<ReturnType<typeof buildSendTurnRequestForThread>>;
    // `send` reads these lazily — the lane child assigns them from the prepared
    // value in its flatMap step before the send effect starts running.
    let sendTurnRequest: BuiltSendTurn["request"];
    let activeInstanceId: BuiltSendTurn["activeInstanceId"];
    let sessionSetSequence: BuiltSendTurn["sessionSetSequence"] = null;
    let commitCrewBrief: BuiltSendTurn["commitCrewBrief"] = () => {};

    // Committed-turn failures report fixed detail only — the attempt is
    // already durably committed, and neither the original cause nor a
    // reporting failure may carry memory content into logs or activities.
    // The provider may have started, so the session is restored as errored.
    const recoverCommittedSendFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterrupts(cause)) {
        return Effect.failCause(cause);
      }
      return reportMemoryFailure(
        "Provider turn start failed",
        MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
        { sessionSetSequence, status: "error" },
      );
    };
    // A hold or admission failure never reached the provider, so the session
    // this send prepared returns to ready.
    const reportSendHold = (detail: string) =>
      reportMemoryFailure("Message not sent", detail, {
        sessionSetSequence,
        status: "ready",
      });
    const send = Effect.gen(function* () {
      if (!hasMemoryReferences) {
        // L3 applies to every turn; the rest of the no-memory path is unchanged.
        const hold = yield* memorySendGate.threadHold(thread.id);
        if (Option.isSome(hold)) {
          yield* reportSendHold(MEMORY_SEND_HOLD_DETAIL[hold.value]);
          return;
        }
        if (hasSkillTrial) {
          // The claim pins the ensured session's actual instance — the
          // intended route every routing resolution must land on.
          if (activeInstanceId === undefined) {
            yield* reportSendHold(PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable);
            return;
          }
          const intendedInstanceId = activeInstanceId;
          // Classification is durable-only: the canonical managed input must
          // still resolve before any claim runs. A miss is held — never an
          // ordinary send.
          const resolvedInput = yield* skillTrialDelivery.resolveInput({
            threadId: thread.id,
            messageId: event.payload.messageId,
          });
          if (Option.isNone(resolvedInput)) {
            yield* reportSendHold(PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable);
            return;
          }
          const durableSkillMode = resolvedInput.value.mode;
          // The mask spans only the claim -> finalizer handoff: a committed
          // claim's token and routed driver are captured inside the claim's
          // own bounded section, and the settlement finalizer is installed
          // before the send can be interrupted. The use handoff's preclaim
          // assembly (awaited incarnation, plan, and route reads that claim
          // nothing) runs under `restore`, so Stop/Interrupt cancels a parked
          // lookup like any other preparation work.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              // `sent` marks only a successful sendTurn return — a refusal
              // report, an adapter failure, or an interrupt settles nothing.
              let sent = false;
              // Written at most once inside the masked claim, before any
              // interruption can expose the send.
              let claimed:
                | {
                    readonly entered: ProjectSkillTrialDeliveryEntered;
                    readonly providerInstanceId: ProviderInstanceId;
                    readonly driverKind: ProviderDriverKind;
                  }
                | undefined;
              const useSkillHandoff =
                durableSkillMode === "use"
                  ? yield* restore(
                      skillTrialDelivery
                        .useHandoff({
                          threadId: thread.id,
                          messageId: event.payload.messageId,
                          intendedProviderInstanceId: intendedInstanceId,
                          sendTurn: sendTurnRequest,
                          onEntered: (entered, routed) => {
                            claimed = {
                              entered,
                              providerInstanceId: routed.providerInstanceId,
                              driverKind: routed.driverKind,
                            };
                          },
                        })
                        .pipe(
                          Effect.map((outcome) =>
                            outcome._tag === "Handoff"
                              ? Option.some(outcome.handoff)
                              : Option.none(),
                          ),
                        ),
                    )
                  : Option.none<ProviderSkillTrialHandoff>();
              if (durableSkillMode === "use" && Option.isNone(useSkillHandoff)) {
                yield* reportSendHold(PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable);
                return;
              }
              // The send's one ephemeral publish-step observation. The
              // observer snapshots and freezes everything it keeps —
              // readonly types alone do not preserve publish-time bytes once
              // adapter buffers move on. An observer exception or a later
              // inconsistent observation drops the capture permanently, so
              // it can never produce partial evidence; nothing here is
              // persisted or logged as a body.
              let observedSubmission:
                | (ProviderAdmissionObservation & ProviderSkillTrialRoute)
                | undefined;
              let submissionInvalid = false;
              yield* restore(
                Effect.gen(function* () {
                  progress.providerCalled = true;
                  // `sent` flips inside the interruptible region itself — a
                  // successful sendTurn return is the only assignment, so the
                  // finalizer installed below observes it before any refusal,
                  // failure, or interrupt could mark the attempt settled.
                  const skillTrialHandoffConfig: ProviderSkillTrialHandoff = Option.isSome(
                    useSkillHandoff,
                  )
                    ? useSkillHandoff.value
                    : {
                        providerInstanceId: intendedInstanceId,
                        enter: (
                          routed: ProviderSkillTrialRoute & {
                            readonly routePreview?: ProviderSubmissionRoutePreview;
                          },
                        ) =>
                          Effect.uninterruptible(
                            skillTrialDelivery
                              .claim({
                                threadId: thread.id,
                                messageId: event.payload.messageId,
                              })
                              .pipe(
                                Effect.map((outcome) => {
                                  if (outcome._tag !== "Entered") {
                                    return false;
                                  }
                                  claimed = {
                                    entered: outcome,
                                    providerInstanceId: routed.providerInstanceId,
                                    driverKind: routed.driverKind,
                                  };
                                  return true;
                                }),
                              ),
                          ),
                      };
                  sent = yield* providerService
                    .sendTurn(sendTurnRequest, {
                      skillTrialHandoff: {
                        ...skillTrialHandoffConfig,
                        observeSubmission: (observed) => {
                          // Runs synchronously inside the adapter's publish
                          // step, on the same fiber as this send.
                          if (submissionInvalid) return;
                          try {
                            // An impossible session generation marks a publish
                            // the service could not even construct an
                            // observation for — drop any earlier capture
                            // rather than settle it beside an unread publish.
                            const generation = observed.sessionGeneration;
                            if (!Number.isSafeInteger(generation) || generation < 0) {
                              submissionInvalid = true;
                              observedSubmission = undefined;
                              return;
                            }
                            const candidate = observed.submissionCandidate;
                            const snapshot = Object.freeze({
                              sessionGeneration: generation,
                              nativeSessionId: observed.nativeSessionId,
                              providerInstanceId: observed.providerInstanceId,
                              driverKind: observed.driverKind,
                              ...(candidate !== undefined
                                ? {
                                    submissionCandidate: Object.freeze({
                                      textBlocks: Object.freeze(Array.from(candidate.textBlocks)),
                                      routeConfigSha256: candidate.routeConfigSha256,
                                    }),
                                  }
                                : {}),
                            });
                            if (observedSubmission === undefined) {
                              observedSubmission = snapshot;
                            } else if (!sameSubmissionObservation(observedSubmission, snapshot)) {
                              // A second observation that disagrees with the
                              // first can name neither publish.
                              submissionInvalid = true;
                              observedSubmission = undefined;
                            }
                          } catch {
                            // Any failure leaves no prior valid capture.
                            submissionInvalid = true;
                            observedSubmission = undefined;
                          }
                          skillTrialHandoffConfig.observeSubmission?.(observed);
                        },
                      },
                    })
                    .pipe(
                      Effect.as(true),
                      Effect.tap(() => Effect.sync(() => commitCrewBrief())),
                      // A handoff refusal provably never entered the adapter,
                      // so it reports like a hold — fixed detail, ready
                      // restoration — and the finalizer leaves the committed
                      // attempt unknown.
                      Effect.catchTag("ProviderSkillTrialHandoffRefusedError", () =>
                        reportSendHold(PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable).pipe(
                          Effect.as(false),
                        ),
                      ),
                    );
                }),
              ).pipe(
                Effect.onExit(() =>
                  claimed !== undefined && sent
                    ? skillTrialDelivery.settle({
                        entered: claimed.entered,
                        providerDriverKind: claimed.driverKind,
                        providerInstanceId: claimed.providerInstanceId,
                        ...(observedSubmission !== undefined
                          ? { submission: observedSubmission }
                          : {}),
                      })
                    : Effect.void,
                ),
              );
            }),
          );
          return;
        }
        progress.providerCalled = true;
        yield* providerService.sendTurn(sendTurnRequest).pipe(Effect.asVoid);
        commitCrewBrief();
        return;
      }

      // L2 — admission keys on the actual ensured session instance, never the
      // L1′ hint. A missing session, a changed driver, or a disallowed driver
      // holds before the ledger commit.
      if (activeInstanceId === undefined) {
        yield* reportSendHold(MEMORY_SEND_HOLD_DETAIL.unavailable);
        return;
      }
      // The `let` capture loses its narrowing inside the nested closures
      // below; pinning the admitted instance to a const keeps it.
      const admittedInstanceId = activeInstanceId;
      const activeInfo = yield* providerService
        .getInstanceInfo(admittedInstanceId)
        .pipe(Effect.option);
      if (
        Option.isNone(activeInfo) ||
        activeInfo.value.driverKind !== expectedMemoryDriverKind ||
        !memorySendGate.driverAllowed(activeInfo.value.driverKind)
      ) {
        yield* reportSendHold(MEMORY_SEND_HOLD_DETAIL.unavailable);
        return;
      }

      // The mask spans only the known-receipt -> finalizer handoff. Admission
      // itself stays interruptible — a withheld commit result legitimately
      // leaves a pending durable attempt — while a Committed receipt arms the
      // settlement finalizer before the provider call can be interrupted.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admission = yield* restore(
            memorySendGate.admit({
              threadId: thread.id,
              messageId: event.payload.messageId,
              projectId: thread.projectId,
              providerInstanceId: admittedInstanceId,
              items: memoryResolution.items.map((item) => ({
                memoryId: ProjectMemoryId.make(item.memoryId),
                selectedVersion: item.selectedVersion,
              })),
              now: yield* DateTime.now,
            }),
          );
          if (admission._tag === "Held") {
            yield* restore(reportSendHold(MEMORY_SEND_HOLD_DETAIL[admission.reason]));
            return;
          }
          // `sent` marks only a successful sendTurn return; any earlier exit —
          // hold, failure, or interrupt — conservatively settles the attempt
          // as external_send_unknown. The onExit is installed while still
          // masked; the post-admission work itself runs interruptible.
          let sent = false;
          // Written at most once by the handoff check before ProviderService
          // can refuse; the refusal report reads it for the fixed detail.
          let handoffHold: MemorySendHoldReason | undefined;
          yield* restore(
            Effect.gen(function* () {
              const hydratedInput = toNonEmptyProviderInput(
                projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                  hydrated: admission.memories,
                }),
              );
              // Conservatively over-reports: an over-limit turn holds without
              // calling the provider and the committed attempt stays unknown.
              if (
                hydratedInput !== undefined &&
                hydratedInput.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
              ) {
                yield* reportSendHold(MEMORY_SEND_HOLD_DETAIL["too-large"]);
                return;
              }
              // L3 — covers the gap between COMMIT and the actual send call.
              const hold = yield* memorySendGate.threadHold(thread.id);
              if (Option.isSome(hold)) {
                yield* reportSendHold(MEMORY_SEND_HOLD_DETAIL[hold.value]);
                return;
              }
              progress.providerCalled = true;
              sent = yield* providerService
                .sendTurn(
                  {
                    ...sendTurnRequest,
                    ...(hydratedInput !== undefined ? { input: hydratedInput } : {}),
                  },
                  {
                    memoryHandoff: {
                      providerInstanceId: admittedInstanceId,
                      check: memorySendGate
                        .revalidateForAdmission({
                          threadId: thread.id,
                          attemptSeq: admission.attemptSeq,
                          providerInstanceId: admittedInstanceId,
                        })
                        .pipe(
                          // `false` is a held attempt; the returned closure is
                          // valid at its store read and is re-judged
                          // synchronously at the adapter's publish point.
                          Effect.map((result) => {
                            if (result._tag === "Held") {
                              handoffHold = result.reason;
                              return false;
                            }
                            return result.stillValid;
                          }),
                        ),
                    },
                  },
                )
                .pipe(
                  Effect.as(true),
                  Effect.tap(() => Effect.sync(() => commitCrewBrief())),
                  // The turn provably never entered the adapter, so the refusal
                  // reports like a hold — fixed detail, ready restoration —
                  // and the finalizer still settles the attempt unknown.
                  Effect.catchTag("ProviderMemoryHandoffRefusedError", (refused) =>
                    reportSendHold(
                      MEMORY_SEND_HOLD_DETAIL[
                        refused.reason === "check-refused" && handoffHold !== undefined
                          ? handoffHold
                          : "unavailable"
                      ],
                    ).pipe(Effect.as(false)),
                  ),
                );
            }),
          ).pipe(
            Effect.onExit(() =>
              memorySendGate.settle(
                admission.attemptSeq,
                sent ? "provider_accepted" : "external_send_unknown",
              ),
            ),
          );
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : hasMemoryReferences
            ? recoverCommittedSendFailure(cause)
            : recoverTurnStartFailure(cause),
      ),
    );

    // The lane slot is registered synchronously, before any lease, worktree,
    // or provider work: a Stop or Interrupt handled after this point always
    // finds the tracked child, whether it is still a lane waiter or already
    // preparing.
    const lane = enterPreparationLane(thread.id);
    const sendFiber = yield* lane(
      leased(
        Effect.gen(function* () {
          yield* ensureThreadWorktree(thread);
          if (!hasOtherUserMessages && !isCompactCommand) {
            const project = yield* resolveProject(thread.projectId);
            const generationCwd =
              resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ??
              process.cwd();
            const generationInput = {
              messageText: assistantCitationsToPlainText(
                normalizeProjectMemoryReferenceLabels({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
              ),
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              ...(event.payload.titleSeed !== undefined
                ? { titleSeed: event.payload.titleSeed }
                : {}),
            };

            yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
              threadId: event.payload.threadId,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              ...generationInput,
            }).pipe(Effect.forkScoped);

            if (
              thread.titleState?.source !== "manual" &&
              canReplaceThreadTitle(thread.title, event.payload.titleSeed)
            ) {
              yield* maybeGenerateThreadTitleForFirstTurn({
                threadId: event.payload.threadId,
                cwd: generationCwd,
                expectedTitle: thread.title,
                expectedVersion: thread.titleState?.version ?? null,
                ...generationInput,
              }).pipe(Effect.forkScoped);
            }
          }
          progress.ensureEntered = true;
          return yield* buildSendTurnRequestForThread({
            threadId: event.payload.threadId,
            messageText: projectComposerContextForProvider({
              text: message.text,
              records: message.context?.records ?? [],
            }),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            interactionMode: event.payload.interactionMode,
            createdAt: event.payload.createdAt,
            // Later turns must not reuse the current title as titleSeed. Only the
            // first prompt seed should suppress a not-yet-renamed session title.
            ...(!hasOtherUserMessages && event.payload.titleSeed !== undefined
              ? { titleSeed: event.payload.titleSeed }
              : {}),
            onSessionSet: (sequence, session) => {
              // Only the "starting" write may anchor a cancel settle: a later
              // bind write is a successor the engine guard supersedes anyway.
              if (session.status === "starting") {
                progress.ownedSessionSetSequence = sequence;
                progress.ownedSession = session;
              }
            },
          });
        }),
      ).pipe(
        Effect.asSome,
        // Preparation recovery belongs to the lane: it finishes — or is
        // interrupted — before the next queued preparation may start, and an
        // interrupt-bearing cause always propagates untouched.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) {
              return yield* Effect.failCause(cause);
            }
            yield* recoverTurnStartFailure(cause);
            return Option.none<BuiltSendTurn>();
          }),
        ),
      ),
    ).pipe(
      Effect.flatMap((prepared) =>
        Option.isSome(prepared)
          ? Effect.suspend(() => {
              sendTurnRequest = prepared.value.request;
              activeInstanceId = prepared.value.activeInstanceId;
              sessionSetSequence = prepared.value.sessionSetSequence;
              commitCrewBrief = prepared.value.commitCrewBrief;
              return send;
            })
          : Effect.void,
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          progress.interrupted = true;
        }),
      ),
      Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
      Effect.forkScoped,
    );
    // Register synchronously in this same worker step: the worker processes
    // events one at a time, so a Stop or Interrupt handled after this point
    // always finds the child in the map and interrupts it before the provider.
    trackInFlight(thread.id, {
      fiber: sendFiber,
      kind: "send",
      messageId: event.payload.messageId,
      progress,
    });
    // The forked child settles `sent` on exit from here on, so drop the entry
    // the post-processing hook uses.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        if (event.payload.regenerateTitle) yield* threadTitleRegenerationWorker.enqueue(event);
        else if (event.payload.titleState?.needsRefinement)
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.session-set":
        if (event.payload.session.status === "ready")
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.runtime-mode-set": {
        // Runtime-mode session preparation shares the per-thread lane and the
        // tracked-entry set so a Stop or Interrupt can join it before any
        // provider cleanup. Its checks re-run after the lane wait: the stored
        // mode is already durable, so a compaction-owned thread defers to the
        // next eligible ensure instead of racing it.
        const progress = {
          ensureEntered: false,
          providerCalled: false,
          interrupted: false,
          ownedSessionSetSequence: null as number | null,
          ownedSession: null as OrchestrationSession | null,
        };
        const fiber = yield* enterPreparationLane(event.payload.threadId)(
          Effect.gen(function* () {
            if (
              compactingThreadIds.has(event.payload.threadId) ||
              turnsAfterCompaction.has(event.payload.threadId)
            ) {
              return;
            }
            const thread = yield* resolveThreadShell(event.payload.threadId);
            if (!thread?.session || thread.session.status === "stopped") {
              return;
            }
            const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
            const resume = ensureSessionForThread(
              event.payload.threadId,
              event.occurredAt,
              cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
            );
            progress.ensureEntered = true;
            yield* thread.worktreePath
              ? withWorkspaceLease(path.resolve(thread.worktreePath), resume)
              : resume;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                progress.interrupted = true;
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterrupts(cause)) {
                  return yield* Effect.failCause(cause);
                }
                const causeText = yield* providerDiagnosticText(event.payload.threadId, () =>
                  Cause.pretty(cause),
                );
                yield* Effect.logWarning(
                  "provider command reactor failed to prepare session for runtime mode",
                  {
                    eventType: event.type,
                    threadId: event.payload.threadId,
                    cause: causeText,
                  },
                );
              }),
            ),
            Effect.asVoid,
          ),
        ).pipe(Effect.forkScoped);
        trackInFlight(event.payload.threadId, { fiber, kind: "session", progress });
        return;
      }
      case "thread.turn-start-requested": {
        // The workspace lease lives inside the tracked preparation child now:
        // holding it here would park the worker on a lease the lane is still
        // holding, and a waiting Stop or Interrupt would queue behind it.
        yield* processTurnStartRequested(event);
        return;
      }
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        // A thread re-engaged before this event ran keeps its shells and session.
        if (Option.isNone(thread) || thread.value.settledOverride !== "settled") {
          return;
        }
        // Idle shells close so they stop holding the worktree. A terminal that
        // runs a command (a dev server, an editor) stays for the user to close.
        yield* terminalManager.closeIdle({ threadId: event.payload.threadId });
        if (thread.value.session == null || thread.value.session.status === "stopped") {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // A replay that returned before forking its send still holds its entry; settle it so
      // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
      Effect.ensuring(
        Effect.suspend(() => {
          const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
          return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) {
          return Effect.failCause(cause);
        }
        return providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
          Effect.flatMap((causeText) =>
            Effect.logWarning("provider command reactor failed to process event", {
              eventType: event.type,
              cause: causeText,
            }),
          ),
        );
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const pendingTitles = yield* findPendingThreadTitles().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find pending thread titles", {
          failureKind: Cause.hasDies(cause) ? "defect" : "failure",
          reasonCount: cause.reasons.length,
        }).pipe(Effect.as({ interruptedRegenerations: [], refinementThreadIds: [] }));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.regenerateTitle === true ||
            event.payload.titleState?.needsRefinement === true)) ||
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    // Earlier events do not replay. Clear interrupted requests by their captured
    // IDs, then schedule persisted refinements after subscribing to their events.
    const recoverTitles = clearInterruptedThreadTitleRegenerations(
      pendingTitles.interruptedRegenerations,
    ).pipe(
      Effect.andThen(
        Effect.forEach(pendingTitles.refinementThreadIds, maybeRefineThreadTitle, {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterrupts(cause)) {
            return yield* Effect.failCause(cause);
          }
          yield* Effect.logWarning(
            "provider command reactor failed to recover pending thread titles",
            {
              failureKind: Cause.hasDies(cause) ? "defect" : "failure",
              reasonCount: cause.reasons.length,
            },
          );
        }),
      ),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* recoverTitles;
    } else {
      yield* forkParked(recoverTitles);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      // Quiescent once the worker is idle and no preparation owner remains at
      // that boundary. Preparations finish — including their in-lane
      // recovery — before their provider send, so a parked send is never
      // awaited here and a resumed.sent receipt stays the send's own concern.
      while (true) {
        yield* worker.drain;
        const owners = [...preparationTails.values()];
        if (owners.length === 0) {
          break;
        }
        yield* Effect.forEach(owners, (owner) => Deferred.await(owner.done), {
          discard: true,
        });
      }
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
