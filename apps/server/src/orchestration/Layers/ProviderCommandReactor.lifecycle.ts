import type { MessageId, OrchestrationSession, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { PROVIDER_STOPPED_START_DETAIL } from "../../crew/crewLogic.ts";
import {
  type ProviderIntentEvent,
  DEFAULT_RUNTIME_MODE,
  formatFailureDetail,
  type makeProviderFailureReporting,
} from "./ProviderCommandReactor.helpers.ts";
import type { makeProviderSessionOperations } from "./ProviderCommandReactor.session.ts";

export type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;

// Ordinary turn sends, compaction phases, and session-only preparations
// forked by processTurnStartRequested and processDomainEvent, tracked per
// thread so Stop and Interrupt can signal and join them before calling the
// provider. The guarantee begins only once those tracked children have
// actually terminated — Engine acknowledgement alone does not quiesce
// in-flight work, and an uninterruptible child section delays the join. A
// fiber observer drops each entry on exit, so completed work never lingers
// in the map. Session-only entries carry no message and are excluded from
// per-message reports.
export type InFlightSend = {
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

export const makeProviderLifecycleOperations = ({
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
}: {
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly providerService: ProviderService["Service"];
  readonly providerDiagnosticText: ReturnType<
    typeof makeProviderFailureReporting
  >["providerDiagnosticText"];
  readonly providerDiagnosticTextPair: ReturnType<
    typeof makeProviderFailureReporting
  >["providerDiagnosticTextPair"];
  readonly serverCommandId: ReturnType<typeof makeProviderFailureReporting>["serverCommandId"];
  readonly appendProviderFailureActivity: ReturnType<
    typeof makeProviderFailureReporting
  >["appendProviderFailureActivity"];
  readonly resolveThreadShell: ReturnType<
    typeof makeProviderSessionOperations
  >["resolveThreadShell"];
  readonly setThreadSession: ReturnType<typeof makeProviderSessionOperations>["setThreadSession"];
  readonly compactingThreadIds: Set<ThreadId>;
  readonly stoppingThreadIds: Set<ThreadId>;
  readonly turnsAfterCompaction: Map<ThreadId, Array<QueuedTurnStart>>;
  readonly inFlightSends: Map<ThreadId, Set<InFlightSend>>;
}) => {
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

  const STOPPED_BEFORE_SEND_DETAIL = PROVIDER_STOPPED_START_DETAIL.beforeSend;
  const STOPPED_DURING_SEND_DETAIL = PROVIDER_STOPPED_START_DETAIL.duringSend;
  const STOPPED_BEFORE_COMPACTION_DETAIL = PROVIDER_STOPPED_START_DETAIL.beforeCompaction;
  const STOPPED_DURING_COMPACTION_DETAIL = PROVIDER_STOPPED_START_DETAIL.duringCompaction;

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
        tone: "info",
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

  return {
    detachTurnsAfterCompaction,
    reportCanceledQueuedTurns,
    cancelTurnsAfterCompaction,
    restoreCompaction,
    processTurnInterruptRequested,
    processSessionStopRequested,
  };
};
