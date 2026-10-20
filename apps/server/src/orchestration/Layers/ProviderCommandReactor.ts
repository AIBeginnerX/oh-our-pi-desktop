import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  PROJECT_SKILL_CONTEXT_KIND,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  type ProjectId,
  ProjectMemoryId,
  type OrchestrationSession,
  type ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  normalizeProjectMemoryReferenceLabels,
  projectComposerContextForProvider,
  resolveProjectMemoryReferences,
} from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
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
import {
  MEMORY_ECHO_WITHHELD_ERROR,
  lookupMemoryEchoThreadState,
  memoryEchoThreadShouldWithhold,
} from "../memoryEcho.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveCrew } from "@t3tools/shared/crew";
import {
  THREAD_GOAL_ACTIVITY,
  threadGoalNote,
  threadGoalProgress,
} from "@t3tools/shared/threadGoal";
import {
  CREW_BRAIN_DRIVERS,
  claudeSubagentModel,
  crewBrief,
  isCrewThreadTitle,
} from "../../crew/crewLogic.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

/**
 * Reactor-internal marker: a project-memory hold that surfaced inside the
 * compaction fork. Carries the fixed user-facing detail only — never a cause —
 * so the compaction failure path can give it the bounded cleanup (activity +
 * queue/map teardown) without session restoration or session error writes.
 */
class MemoryHoldFailure extends Schema.TaggedError<MemoryHoldFailure>()("MemoryHoldFailure", {
  detail: Schema.String,
}) {}

/**
 * Two publish-step observations of one send must agree on every scalar and
 * every captured block to count as the same observation; any disagreement
 * drops the capture permanently rather than settling partial evidence.
 */
const sameSubmissionObservation = (
  a: ProviderAdmissionObservation & ProviderSkillTrialRoute,
  b: ProviderAdmissionObservation & ProviderSkillTrialRoute,
): boolean => {
  const aCandidate = a.submissionCandidate;
  const bCandidate = b.submissionCandidate;
  return (
    a.sessionGeneration === b.sessionGeneration &&
    a.nativeSessionId === b.nativeSessionId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.driverKind === b.driverKind &&
    (aCandidate === undefined
      ? bCandidate === undefined
      : bCandidate !== undefined &&
        aCandidate.routeConfigSha256 === bCandidate.routeConfigSha256 &&
        aCandidate.textBlocks.length === bCandidate.textBlocks.length &&
        aCandidate.textBlocks.every((text, index) => text === bCandidate.textBlocks[index]))
  );
};

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

/**
 * Keeps only a cause's interrupts. Rethrowing it preserves interrupt semantics
 * while dropping failure and defect reasons that may carry private content.
 * Call it only once `Cause.hasInterrupts(cause)` holds, so the result is never empty.
 */
const interruptOnly = (cause: Cause.Cause<unknown>) =>
  Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason));

/**
 * A memory-failure report's claim on the session its failing ensure left
 * "starting": that ensure's last session-set sequence (null when it wrote none)
 * and the status to restore. Without it the report is activity-only.
 */
type MemorySessionRestore = {
  readonly sessionSetSequence: number | null;
  readonly status: "ready" | "error";
};

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
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
  /**
   * One provider diagnostic for this thread, judged against the durable
   * memory-send ledger at the moment of use: on a tainted or unavailable
   * thread the fixed withheld phrase is returned and the raw formatter never
   * runs; a clean thread keeps the raw text. No verdict is cached — every sink
   * calls this immediately before its write, so a clean judgment never
   * survives a projection fetch, a provider await, or another diagnostic
   * write. A lookup interruption, pure or mixed, fails with its original
   * cause so it reaches the enclosing worker or phase boundary untouched.
   * Ordinary lookup failures fail closed to unavailable inside the lookup;
   * they never reach this helper's failure channel.
   */
  const providerDiagnosticText = (threadId: ThreadId, raw: () => string) =>
    Effect.gen(function* () {
      const state = yield* lookupMemoryEchoThreadState(sql, threadId);
      return memoryEchoThreadShouldWithhold(state) ? MEMORY_ECHO_WITHHELD_ERROR : raw();
    });
  const providerDiagnosticTextPair = (
    threadId: ThreadId,
    primary: () => string,
    secondary: () => string,
  ) =>
    Effect.gen(function* () {
      const state = yield* lookupMemoryEchoThreadState(sql, threadId);
      const withhold = memoryEchoThreadShouldWithhold(state);
      return withhold
        ? { cause: MEMORY_ECHO_WITHHELD_ERROR, originalCause: MEMORY_ECHO_WITHHELD_ERROR }
        : { cause: primary(), originalCause: secondary() };
    });
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
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
  type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
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
  // Ordinary turn sends, compaction phases, and session-only preparations
  // forked by processTurnStartRequested and processDomainEvent, tracked per
  // thread so Stop and Interrupt can signal and join them before calling the
  // provider. The guarantee begins only once those tracked children have
  // actually terminated — Engine acknowledgement alone does not quiesce
  // in-flight work, and an uninterruptible child section delays the join. A
  // fiber observer drops each entry on exit, so completed work never lingers
  // in the map. Session-only entries carry no message and are excluded from
  // per-message reports.
  type InFlightSend = {
    readonly fiber: Fiber.Fiber<void, unknown>;
    readonly progress: {
      ensureEntered: boolean;
      providerCalled: boolean;
      interrupted: boolean;
      // The last session-set sequence this entry's own preparation wrote.
      // Only "send" entries record it — session and compaction ensure writes
      // must supersede a later preparation-cancel anchor, never anchor one.
      ownedSessionSetSequence: number | null;
      // The payload that anchor carried. A guarded settle writes against this
      // exact provider identity even while the projection still lags the
      // committed "starting" event.
      ownedSession: OrchestrationSession | null;
    };
  } & (
    | { readonly kind: "send" | "compaction"; readonly messageId: MessageId }
    | { readonly kind: "session" }
  );
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

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  // Stop/Interrupt detach the queue synchronously at handler start so send
  // cancellation can precede lookups and reports; the detached entries are
  // reported separately once the provider cancellation attempt has run.
  const detachTurnsAfterCompaction = (threadId: ThreadId) => {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    turnsAfterCompaction.delete(threadId);
    return queued;
  };

  // Best-effort, cause-free catch for stop/interrupt-path activity reports:
  // interrupt-bearing causes rethrow untouched, and every other failure or
  // defect collapses to a fixed warning carrying only thread/message identity.
  // A broken append can neither fail the caller nor leak cause content.
  const keepActivityReportBestEffort =
    (logAnnotations: { readonly threadId: ThreadId; readonly messageId?: MessageId }) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(
                "provider command reactor failed to record provider failure activity",
                logAnnotations,
              ),
        ),
        Effect.asVoid,
      );

  const reportCanceledQueuedTurns = Effect.fnUntraced(function* (
    threadId: ThreadId,
    queued: ReadonlyArray<QueuedTurnStart>,
    detail: string,
  ) {
    for (const event of queued) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        requestId: event.payload.messageId,
      }).pipe(keepActivityReportBestEffort({ threadId, messageId: event.payload.messageId }));
    }
  });

  const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    yield* reportCanceledQueuedTurns(threadId, detachTurnsAfterCompaction(threadId), detail);
  });

  const STOPPED_BEFORE_SEND_DETAIL = "Stopped before this message was sent.";
  const STOPPED_DURING_SEND_DETAIL =
    "Stopped while sending. The provider may have received this message.";
  const STOPPED_BEFORE_COMPACTION_DETAIL = "Stopped before context compaction started.";
  const STOPPED_DURING_COMPACTION_DETAIL =
    "Stopped during context compaction. The provider may still finish it.";
  const RESUME_AFTER_COMPACTION_FAILED_DETAIL =
    "The queued message could not resume after context compaction. Send this message again to continue.";
  // A canceled preparation whose provider cleanup could not be confirmed lands
  // here instead of staying "starting". The wording stays fixed and gives a
  // truthful next step: it never claims the native process is gone, and it
  // does not promise that retrying inside the same thread succeeds.
  const PREPARATION_STOP_UNVERIFIED_DETAIL =
    "The provider session could not be cleaned up after the stop. Continue in a new thread, or restart the server and check again.";
  // Reports tracked work that was actually interrupted. Fixed summary/detail
  // only — once the provider call was entered the message may have been
  // received, so that branch reports "Message interrupted", not a false
  // "not sent". Compaction entries report against the /compact message id.
  const reportInterruptedSends = Effect.fnUntraced(function* (
    threadId: ThreadId,
    inFlight: ReadonlyArray<InFlightSend>,
    createdAt: string,
  ) {
    for (const entry of inFlight) {
      if (entry.kind === "session" || !entry.progress.interrupted) continue;
      const compaction = entry.kind === "compaction";
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: compaction
          ? entry.progress.providerCalled
            ? "Context compaction interrupted"
            : "Context compaction not started"
          : entry.progress.providerCalled
            ? "Message interrupted"
            : "Message not sent",
        detail: compaction
          ? entry.progress.providerCalled
            ? STOPPED_DURING_COMPACTION_DETAIL
            : STOPPED_BEFORE_COMPACTION_DETAIL
          : entry.progress.providerCalled
            ? STOPPED_DURING_SEND_DETAIL
            : STOPPED_BEFORE_SEND_DETAIL,
        turnId: null,
        createdAt,
        requestId: entry.messageId,
      }).pipe(keepActivityReportBestEffort({ threadId, messageId: entry.messageId }));
    }
  });

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

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterProcessError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    if (isProviderWorkspaceMissingError(failReason?.error)) {
      return failReason.error.message;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    // Lazily-formatted raw detail. Judged against the memory-send ledger only
    // after the shell read, immediately before the session write.
    readonly rawDetail: () => string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    const detail = yield* providerDiagnosticText(input.threadId, input.rawDetail);
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  // The newest "starting" write owned by a captured entry, if any. Only this
  // guard-anchored write may carry the terminal status; an anchor superseded
  // by any newer session-set is refused by the engine instead.
  const ownedPreparationAnchor = (inFlight: ReadonlyArray<InFlightSend>) =>
    inFlight.reduce<{ sequence: number; session: OrchestrationSession } | null>(
      (found, entry) =>
        entry.progress.ownedSessionSetSequence !== null &&
        entry.progress.ownedSession !== null &&
        (found === null || entry.progress.ownedSessionSetSequence > found.sequence)
          ? {
              sequence: entry.progress.ownedSessionSetSequence,
              session: entry.progress.ownedSession,
            }
          : found,
      null,
    );

  // True only when every captured entry was still preparation-side: none
  // reached a provider call and no live turn owns the session, so cancellation
  // takes the non-recovering stop path rather than a recovering interrupt.
  const isPreparationOnly = (
    inFlight: ReadonlyArray<InFlightSend>,
    session: OrchestrationSession | null,
  ) =>
    inFlight.some((entry) => entry.progress.interrupted) &&
    inFlight.every((entry) => entry.kind !== "compaction" && !entry.progress.providerCalled) &&
    !(session?.status === "running" || session?.activeTurnId != null);

  // A canceled preparation's non-recovering cleanup and conditional terminal
  // write. The provider stop runs only after the tracked fibers were joined;
  // the guarded session.set lands only while the entry's own "starting" write
  // is still the thread's latest session write and the control event is still
  // the newest owner claim. An unverified cleanup is a fixed error — a
  // successful stop never claims native teardown and a failed one never
  // claims verified success.
  const settlePreparationCancel = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly controlSequence: number;
    readonly anchor: { sequence: number; session: OrchestrationSession };
    readonly now: string;
  }) {
    const stopped = yield* providerService.stopSession({ threadId: input.threadId }).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
        onSuccess: () => Effect.succeed(true),
      }),
    );
    const commandId = yield* serverCommandId("preparation-cancel");
    yield* orchestrationEngine
      .dispatch(
        {
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: {
            ...input.anchor.session,
            status: stopped ? "stopped" : "error",
            activeTurnId: null,
            lastError: stopped ? null : PREPARATION_STOP_UNVERIFIED_DETAIL,
            updatedAt: input.now,
          },
          createdAt: input.now,
        },
        {
          preparationCancel: {
            preparationSequence: input.anchor.sequence,
            controlSequence: input.controlSequence,
          },
        },
      )
      .pipe(
        // A refusal only ever means the anchor lost its claim: log fixed
        // wording and never fall back to an unconditional session.set.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(
                "provider command reactor could not settle a canceled preparation",
                { threadId: input.threadId },
              ),
        ),
      );
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    // Best effort like the rest of this recovery: a settings read failure
    // falls back to the checkout's t3.json.
    const submodules = yield* projectSettingsForThread(thread.id).pipe(
      Effect.map((settings) => settings.worktreeSubmodules),
      Effect.orElseSucceed(() => null),
    );
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(
        gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath }, { submodules }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("provider command reactor failed to recreate worktree", {
            threadId: thread.id,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      // First-turn prompt seed. A manual title that still equals this seed was
      // written by the client's auto-title, not a user rename.
      readonly titleSeed?: string;
      // Acknowledged session-set sequences this ensure wrote, reported back to
      // the owning preparation entry so a canceled preparation can cite the
      // exact write as its cancel anchor.
      readonly onSessionSet?: (sequence: number, session: OrchestrationSession) => void;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    // Sequence of the last session-set this invocation acknowledged. A failure
    // report may restore the session only against that exact write.
    let sessionSetSequence: number | null = null;
    // Dispatch and sequence capture together stay uninterruptible: an
    // acknowledged write always reaches the owner before an interrupt can
    // overtake it, so a committed anchor can never be lost.
    const setThreadSessionAndRecord = (input: Parameters<typeof setThreadSession>[0]) =>
      setThreadSession(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() => options?.onSessionSet?.(result.sequence, input.session)),
        ),
        Effect.uninterruptible,
      );
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      sessionSetSequence = (yield* setThreadSessionAndRecord({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      })).sequence;
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;
    // OpenCode skips SessionPrompt.ensureTitle when session.create already has
    // a title. Prompt seeds and "New thread" are not user titles, so omit them
    // and let the provider generate one. A real rename is source "manual" and
    // differs from the first-turn prompt seed (the web client writes that seed
    // through thread.meta.update, which also marks the title manual).
    const manualTitle = thread.titleState?.source === "manual" ? thread.title.trim() : "";
    const promptSeed = options?.titleSeed?.trim();
    const sessionTitle =
      manualTitle.length > 0 && manualTitle !== promptSeed ? thread.title : undefined;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService
        .startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(sessionTitle ? { title: sessionTitle } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        })
        .pipe(Effect.tap(() => refreshWorkspaceSnapshot));

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        return yield* setThreadSessionAndRecord({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return { sessionSetSequence };
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      sessionSetSequence = (yield* bindSessionToThread(restartedSession)).sequence;
      return { sessionSetSequence };
    }

    const startedSession = yield* startProviderSession(undefined);
    sessionSetSequence = (yield* bindSessionToThread(startedSession)).sequence;
    return { sessionSetSequence };
  });

  // A lead session keeps the crew note in its conversation, so the note is sent again only when
  // the crew changes or a new provider session starts.
  const sentCrewBriefs = new Map<ThreadId, string>();
  // The open thread goal travels the same way.
  const sentGoalNotes = new Map<ThreadId, string>();

  /** The OOP Crew note for a lead turn, or null when the crew is off or the brain cannot reach it. */
  const crewBriefFor = (thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
  }) =>
    Effect.gen(function* () {
      if (isCrewThreadTitle(thread.title)) return null;
      const settings = yield* serverSettingsService.getSettings;
      const providers = yield* providerRegistry.getProviders;
      const brainDriver = providers.find(
        (provider) => provider.instanceId === thread.modelSelection.instanceId,
      )?.driver;
      if (brainDriver === undefined || !CREW_BRAIN_DRIVERS.has(brainDriver)) return null;
      const crew = resolveCrew({
        settings: settings.crew,
        threadId: thread.id,
        providers,
        brain: thread.modelSelection,
      });
      if (!crew.enabled) return null;
      // Roles on the brain's own Claude instance run as in-process subagents (the fast path).
      const route = (option: (typeof crew.roles)["worker"]) =>
        option === null
          ? null
          : {
              label: option.label,
              providerLabel: option.providerLabel,
              native:
                brainDriver === "claudeAgent" &&
                option.selection.instanceId === thread.modelSelection.instanceId
                  ? (claudeSubagentModel(option.selection.model) ?? undefined)
                  : undefined,
            };
      return crewBrief({
        worker: route(crew.roles.worker),
        expert: route(crew.roles.expert),
        auditor: route(crew.roles.auditor),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("crew brief skipped", { cause }).pipe(Effect.as(null)),
      ),
    );

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    readonly titleSeed?: string;
    readonly onSessionSet?: (sequence: number, session: OrchestrationSession) => void;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const { sessionSetSequence } = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      ...(input.onSessionSet !== undefined ? { onSessionSet: input.onSessionSet } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const brief = yield* crewBriefFor({
      id: thread.id,
      title: thread.title,
      modelSelection: input.modelSelection ?? thread.modelSelection,
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const briefKey = brief === null ? null : `${activeSession?.createdAt ?? ""}\n${brief}`;
    const freshBrief =
      briefKey !== null && sentCrewBriefs.get(input.threadId) !== briefKey ? brief : null;
    if (briefKey === null) sentCrewBriefs.delete(input.threadId);
    else sentCrewBriefs.set(input.threadId, briefKey);
    const goal = (yield* serverSettingsService.getSettings).threadGoals[input.threadId];
    const goalOpen =
      goal !== undefined &&
      goal.active &&
      threadGoalProgress(
        goal,
        Option.match(
          yield* projectionSnapshotQuery.getThreadDetailById(input.threadId, {
            activityKinds: Object.values(THREAD_GOAL_ACTIVITY),
          }),
          { onNone: () => [], onSome: (detail) => detail.activities },
        ),
      ).status === "working";
    const goalKey = goalOpen ? `${activeSession?.createdAt ?? ""}\n${goal.id}` : null;
    const freshGoalNote =
      goalOpen && sentGoalNotes.get(input.threadId) !== goalKey ? threadGoalNote(goal) : null;
    if (goalKey === null) sentGoalNotes.delete(input.threadId);
    else sentGoalNotes.set(input.threadId, goalKey);
    const normalizedInput = toNonEmptyProviderInput(
      [freshGoalNote, freshBrief, input.messageText].filter((part) => part !== null).join("\n\n"),
    );
    const normalizedAttachments = input.attachments ?? [];
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      request: {
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      },
      // The actual session instance that admitted turns are bound to; the L1′
      // instance hint is only an early rejection, never proof of this value.
      activeInstanceId: activeSession?.providerInstanceId,
      // This ensure's own last session-set; the only write a failure report may restore.
      sessionSetSequence,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.title.generate.complete",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
          expectedTitle: input.expectedTitle,
          expectedVersion: input.expectedVersion,
          needsRefinement:
            generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          providerDiagnosticText(input.threadId, () => Cause.pretty(cause)).pipe(
            Effect.flatMap((causeText) =>
              Effect.logWarning(
                "provider command reactor failed to generate or rename thread title",
                {
                  threadId: input.threadId,
                  cwd: input.cwd,
                  cause: causeText,
                },
              ),
            ),
          ),
        ),
      );
    },
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    // Memory labels are normalized on an ephemeral copy only: assistant/system
    // rows and the persisted thread stay untouched, and no envelope is built.
    const { message, attachments } = formatThreadTitleContext(
      thread.messages.map((entry) =>
        entry.role === "user"
          ? {
              ...entry,
              text: normalizeProjectMemoryReferenceLabels({
                text: entry.text,
                records: entry.context?.records ?? [],
              }),
            }
          : entry,
      ),
    );
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return providerDiagnosticText(threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor failed to clear interrupted title regeneration",
                  {
                    threadId,
                    cause: causeText,
                  },
                ),
              ),
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning("provider command reactor failed to regenerate thread title", {
                  threadId: event.payload.threadId,
                  cause: causeText,
                }),
              ),
              Effect.as({ _tag: "Completed", title: undefined } as const),
            ),
        ),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor retrying title regeneration completion",
                  {
                    threadId: event.payload.threadId,
                    cause: causeText,
                  },
                ),
              ),
              Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)),
            ),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause)).pipe(
              Effect.flatMap((causeText) =>
                Effect.logWarning(
                  "provider command reactor failed to complete title regeneration",
                  {
                    threadId: event.payload.threadId,
                    cause: causeText,
                  },
                ),
              ),
            ),
        ),
      ),
  );
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

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const threadId = event.payload.threadId;
    // Detach the compaction queue and capture this thread's in-flight sends
    // synchronously, then signal and join them before any lookup or report —
    // a missing thread or a slow append must never let an already-forked send
    // reach the provider after the interrupt is handled.
    const queued = detachTurnsAfterCompaction(threadId);
    const inFlight = [...(inFlightSends.get(threadId) ?? [])];

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const rawDetail = () => formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return providerDiagnosticTextPair(
              event.payload.threadId,
              () => Cause.pretty(stopCause),
              () => Cause.pretty(cause),
            ).pipe(
              Effect.flatMap((causes) =>
                Effect.logWarning(
                  "provider command reactor failed to stop session after interrupt failure",
                  {
                    threadId: event.payload.threadId,
                    cause: causes.cause,
                    originalCause: causes.originalCause,
                  },
                ),
              ),
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        // Each write rechecks the ledger: no clean detail is retained across
        // the session write between the two diagnostic reports.
        const lastError = yield* providerDiagnosticText(event.payload.threadId, rawDetail);
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        const detail = yield* providerDiagnosticText(event.payload.threadId, rawDetail);
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Join every tracked send first, then run the existing provider interrupt
    // path. Queued-turn and interrupted-send reports follow as a finalizer so
    // a provider failure can never suppress them. Signal in reverse
    // registration order: interrupting a lane owner releases the lane
    // synchronously, and a queued waiter could start provider work in the gap
    // before its own interrupt lands.
    yield* Fiber.interruptAll([...inFlight].reverse().map((entry) => entry.fiber)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const thread = yield* resolveThreadShell(threadId);
          if (!thread) {
            return;
          }
          const session = thread.session;
          const ownedAnchor = ownedPreparationAnchor(inFlight);
          if (isPreparationOnly(inFlight, session)) {
            // A preparation-only interrupt never entered the provider: the
            // recovering interruptTurn path could restart the session, so it
            // settles through the non-recovering stop instead. No "No active
            // provider session" activity is left behind either.
            if (ownedAnchor !== null && session?.status === "starting") {
              yield* settlePreparationCancel({
                threadId,
                controlSequence: event.sequence,
                anchor: ownedAnchor,
                now: event.payload.createdAt,
              });
            }
          } else if (!session || session.status === "stopped") {
            yield* appendProviderFailureActivity({
              threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: "No active provider session is bound to this thread.",
              turnId: event.payload.turnId ?? null,
              createdAt: event.payload.createdAt,
            });
          } else {
            // Orchestration turn ids are not provider turn ids, so interrupt by session.
            yield* providerService
              .interruptTurn({ threadId })
              .pipe(Effect.catchCause(recoverInterruptFailure));
          }
          // A compaction phase interrupted by this handler can no longer run
          // its own restore; the handler restores here instead. The status
          // checks inside keep a recovery-written "stopped" from being
          // overwritten.
          if (inFlight.some((entry) => entry.kind === "compaction" && entry.progress.interrupted)) {
            yield* restoreCompaction(threadId, true).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning(
                      "provider command reactor failed to restore session after interrupted compaction",
                      { threadId },
                    ),
              ),
            );
          }
        }),
      ),
      Effect.onExit(() =>
        reportCanceledQueuedTurns(
          threadId,
          queued,
          "Context compaction was interrupted. Send this message again to continue.",
        ).pipe(Effect.andThen(reportInterruptedSends(threadId, inFlight, event.payload.createdAt))),
      ),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          // Only the raw branch is judged: stale-pending classification and
          // its fixed phrase stay untouched.
          (isUnknownPendingApprovalRequestError(cause)
            ? Effect.succeed(stalePendingRequestDetail("approval", event.payload.requestId))
            : providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause))
          ).pipe(
            Effect.flatMap((detail) =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.approval.respond.failed",
                summary: "Provider approval response failed",
                detail,
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              }),
            ),
          ),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId
            ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            // Only the raw branch is judged: stale-pending classification and
            // its fixed phrase stay untouched.
            (isUnknownPendingUserInputRequestError(cause)
              ? Effect.succeed(stalePendingRequestDetail("user-input", event.payload.requestId))
              : providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause))
            ).pipe(
              Effect.flatMap((detail) =>
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.user-input.respond.failed",
                  summary: "Provider user input response failed",
                  detail,
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                }),
              ),
            ),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const threadId = event.payload.threadId;
    const now = event.payload.createdAt;
    // Establish the stopping marker, detach the compaction queue, and capture
    // this thread's in-flight sends synchronously, then signal and join them
    // before any lookup or provider call — a missing thread must not bypass
    // cancelling sends the worker already forked. Signal in reverse
    // registration order: interrupting a lane owner releases the lane
    // synchronously, and a queued waiter could start provider work in the gap
    // before its own interrupt lands.
    const wasCompacting = compactingThreadIds.has(threadId);
    stoppingThreadIds.add(threadId);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(threadId));
    const queued = detachTurnsAfterCompaction(threadId);
    const inFlight = [...(inFlightSends.get(threadId) ?? [])];
    yield* Fiber.interruptAll([...inFlight].reverse().map((entry) => entry.fiber)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const thread = yield* resolveThreadShell(threadId);
          if (!thread) {
            return;
          }
          const session = thread.session;
          // A stopped/interrupted preparation settles here — joined fibers
          // first, then the non-recovering provider cleanup, then the guarded
          // terminal write the engine anchors at that entry's own "starting"
          // session-set. Any newer owner makes the engine refuse the write.
          const ownedAnchor = ownedPreparationAnchor(inFlight);
          if (isPreparationOnly(inFlight, session) && ownedAnchor !== null) {
            yield* settlePreparationCancel({
              threadId,
              controlSequence: event.sequence,
              anchor: ownedAnchor,
              now,
            });
            return;
          }
          // An interrupted compaction can hold a native session the
          // projection does not show yet — its ensure marks "starting"
          // through a dispatched command whose commit is not proven visible
          // here. Ordinary sends get their cleanup through the
          // preparation-only branch above; ask the provider only for
          // compaction before deciding there is nothing to stop, and let a
          // failed lookup degrade to the projection-only decision without
          // logging the cause.
          const providerKnowsSession = inFlight.some(
            (entry) =>
              entry.kind === "compaction" &&
              entry.progress.ensureEntered &&
              entry.progress.interrupted,
          )
            ? yield* providerService.listSessions().pipe(
                Effect.map((sessions) => sessions.some((session) => session.threadId === threadId)),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
                ),
              )
            : false;
          yield* (
            (session !== null && session.status !== "stopped") || providerKnowsSession
              ? providerService.stopSession({ threadId })
              : Effect.void
          ).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.interrupt;
                }
                return Effect.sync(() => {
                  stoppingThreadIds.delete(threadId);
                  return wasCompacting && !compactingThreadIds.has(threadId);
                }).pipe(
                  Effect.flatMap((compactionSettled) =>
                    compactionSettled ? restoreCompaction(threadId) : Effect.void,
                  ),
                  // Judged here, after the restore decision — no clean detail
                  // is retained across the restore awaits.
                  Effect.andThen(
                    providerDiagnosticText(threadId, () => formatFailureDetail(cause)).pipe(
                      Effect.flatMap((detail) =>
                        appendProviderFailureActivity({
                          threadId,
                          kind: "provider.session.stop.failed",
                          summary: "Provider session stop failed",
                          detail,
                          turnId: null,
                          createdAt: now,
                        }),
                      ),
                    ),
                  ),
                );
              },
              onSuccess: () =>
                setThreadSession({
                  threadId,
                  session: {
                    threadId,
                    status: "stopped",
                    providerName: thread.session?.providerName ?? null,
                    ...(thread.session?.providerInstanceId !== undefined
                      ? { providerInstanceId: thread.session.providerInstanceId }
                      : {}),
                    runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                    activeTurnId: null,
                    lastError: thread.session?.lastError ?? null,
                    updatedAt: now,
                  },
                  createdAt: now,
                }),
            }),
          );
        }),
      ),
      // Detached queued turns and interrupted sends are reported only after
      // the provider cancellation attempt; reporting failures stay contained.
      Effect.onExit(() =>
        reportCanceledQueuedTurns(
          threadId,
          queued,
          "The session was stopped during context compaction. Send this message again to continue.",
        ).pipe(Effect.andThen(reportInterruptedSends(threadId, inFlight, now))),
      ),
      Effect.ensuring(clearStopping),
    );
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
