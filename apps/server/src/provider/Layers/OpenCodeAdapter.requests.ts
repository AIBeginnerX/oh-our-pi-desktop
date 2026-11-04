import {
  type EventId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeItemId,
  type RuntimeRequestId,
  ThreadId,
  type TurnTokenUsage,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";
import {
  type OpenCodeAskedRequestEvent,
  type OpenCodeIdleReconciliation,
  type OpenCodePendingRequestRecovery,
  type OpenCodePromptAdmission,
  type OpenCodeRequestRelationRetry,
  type OpenCodeRoutedRequestEvent,
  type OpenCodeSessionContext,
  type OpenCodeTerminalRequestEvent,
  type OpenCodeTextPartState,
  PROVIDER,
  decodeOpenCodeSessionStatusMap,
  isOpenCodeNotFound,
  takeOpenCodeTurnTokenUsage,
} from "./OpenCodeAdapter.state.ts";
import {
  type EventBaseInput,
  abortOpenCodeSessionForTeardown,
  applyProviderSessionUpdate,
  failPendingOpenCodeCancellation,
  isoFromEpochMs,
  mapPermissionDecision,
  mapPermissionToRequestType,
  mergeOpenCodeAssistantText,
  normalizeQuestionRequest,
  nowIso,
  resolveTextStreamKind,
  updateProviderSession,
} from "./OpenCodeAdapter.helpers.ts";

export interface OpenCodeEventBase {
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly requestId?: RuntimeRequestId;
  readonly raw?: { readonly source: "opencode.sdk.event"; readonly payload: unknown };
}

export interface makeOpenCodeRequestHandlersDeps {
  readonly sessions: Map<ThreadId, OpenCodeSessionContext>;
  readonly deleteContextIfCurrent: (context: OpenCodeSessionContext) => void;
  readonly buildEventBase: (
    input: EventBaseInput,
  ) => Effect.Effect<OpenCodeEventBase, ProviderAdapterRequestError>;
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly emitUnsafe: (event: ProviderRuntimeEvent) => void;
}

export const makeOpenCodeRequestHandlers = (deps: makeOpenCodeRequestHandlersDeps) => {
  const { sessions, deleteContextIfCurrent, buildEventBase, emit, emitUnsafe } = deps;

  const cancelIdleReconciliation = Effect.fn("cancelIdleReconciliation")(function* (
    context: OpenCodeSessionContext,
  ) {
    const pending = context.pendingIdleReconciliation;
    context.pendingIdleReconciliation = undefined;
    if (pending?.fiber) {
      yield* Fiber.interrupt(pending.fiber);
    }
  });

  const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    promptGeneration: number,
    raw: unknown,
  ) {
    const updatedAt = yield* nowIso;
    const stopped = yield* Ref.get(context.stopped);
    if (
      stopped ||
      context.activeTurnId !== turnId ||
      context.promptGeneration !== promptGeneration ||
      context.cancellation?.turnId === turnId
    ) {
      return;
    }
    const pendingIdleReconciliation = context.pendingIdleReconciliation;
    if (
      pendingIdleReconciliation?.turnId === turnId &&
      pendingIdleReconciliation.promptGeneration === promptGeneration
    ) {
      context.pendingIdleReconciliation = undefined;
    }
    const tokenUsage = takeOpenCodeTurnTokenUsage(context, true);
    context.activeTurnId = undefined;
    context.activeAgent = undefined;
    context.activeVariant = undefined;
    context.interruptedTurnId = undefined;
    context.awaitingBusyAfterInterruption = false;
    context.reconcileIdleStatus = false;
    for (const requestId of context.autoRepliedRequestIds) {
      context.emittedTerminalRequestIds.add(requestId);
    }
    context.autoRepliedRequestIds.clear();
    applyProviderSessionUpdate(
      context,
      { status: "ready" },
      { clearActiveTurnId: true },
      updatedAt,
    );
    if (pendingIdleReconciliation?.fiber) {
      yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
    }
    yield* schedulePendingRequestRecovery(context);
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId,
        raw,
      })),
      type: "turn.completed",
      payload: {
        state: "completed",
        tokenUsage,
      },
    });
  });

  const scheduleIdleReconciliation = Effect.fn("scheduleIdleReconciliation")(function* (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    raw: unknown,
  ) {
    const existing = context.pendingIdleReconciliation;
    if (existing?.turnId === turnId && existing.promptGeneration === context.promptGeneration) {
      existing.raw = raw;
      existing.dirty = true;
      return;
    }
    yield* cancelIdleReconciliation(context);

    const pending: OpenCodeIdleReconciliation = {
      turnId,
      promptGeneration: context.promptGeneration,
      raw,
      warned: false,
      dirty: false,
    };
    context.pendingIdleReconciliation = pending;
    const reconcile = Effect.gen(function* () {
      let retryCount = 0;
      while (context.pendingIdleReconciliation === pending) {
        if (
          context.activeTurnId !== turnId ||
          context.awaitingBusyAfterInterruption ||
          context.promptGeneration !== pending.promptGeneration
        ) {
          context.pendingIdleReconciliation = undefined;
          return;
        }
        const result = yield* runOpenCodeSdk("session.status", (signal) =>
          context.client.session.status(undefined, { signal }),
        ).pipe(
          Effect.timeout("1 second"),
          Effect.retry({ times: 1 }),
          Effect.match({
            onFailure: (cause) => ({ type: "unknown" as const, cause }),
            onSuccess: (response) => {
              const data = Option.getOrUndefined(decodeOpenCodeSessionStatusMap(response.data));
              if (data === undefined) {
                return { type: "unknown" as const, cause: undefined };
              }
              const status = data[context.openCodeSessionId];
              if (status === undefined || status.type === "idle") {
                return { type: "idle" as const };
              }
              if (status.type === "busy" || status.type === "retry") {
                return { type: "busy" as const };
              }
              return { type: "unknown" as const, cause: undefined };
            },
          }),
        );

        if (
          context.pendingIdleReconciliation !== pending ||
          context.activeTurnId !== turnId ||
          context.promptGeneration !== pending.promptGeneration
        ) {
          return;
        }
        if (result.type === "idle") {
          context.pendingIdleReconciliation = undefined;
          yield* completeOpenCodeTurn(context, turnId, pending.promptGeneration, pending.raw);
          return;
        }
        if (result.type === "busy") {
          if (pending.dirty) {
            pending.dirty = false;
            continue;
          }
          context.pendingIdleReconciliation = undefined;
          return;
        }
        if (!pending.warned) {
          pending.warned = true;
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
            type: "runtime.warning",
            payload: {
              message: "OpenCode turn completion is waiting for session status.",
              detail:
                result.cause === undefined
                  ? "session.status returned missing or invalid status data."
                  : openCodeRuntimeErrorDetail(result.cause),
            },
          });
        }
        const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
        retryCount += 1;
        yield* Effect.sleep(`${delayMs} millis`);
      }
    }).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          if (context.pendingIdleReconciliation === pending) {
            context.pendingIdleReconciliation = undefined;
          }
        }),
      ),
    );
    pending.fiber = yield* reconcile.pipe(Effect.forkIn(context.sessionScope));
  });

  const failPromptAdmissionRecovery = Effect.fn("failPromptAdmissionRecovery")(function* (
    context: OpenCodeSessionContext,
    promptAdmission: OpenCodePromptAdmission,
  ) {
    if (
      context.promptAdmission !== promptAdmission ||
      context.activeTurnId !== promptAdmission.turnId ||
      context.promptGeneration !== promptAdmission.generation
    ) {
      return;
    }
    const detail =
      "OpenCode accepted the prompt, but OOP could not confirm its message or session status.";
    const abortExit = yield* Effect.exit(
      runOpenCodeSdk("session.abort", (signal) =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
      ).pipe(Effect.timeout("1 second")),
    );
    if (Exit.isFailure(abortExit)) {
      yield* emitUnexpectedExit(
        context,
        `${detail} The cleanup abort also failed: ${openCodeRuntimeErrorDetail(Cause.squash(abortExit.cause))}`,
      );
      deleteContextIfCurrent(context);
      return;
    }
    const tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
    context.promptAdmission = undefined;
    context.activeTurnId = undefined;
    context.activeAgent = undefined;
    context.activeVariant = undefined;
    context.awaitingBusyAfterInterruption = false;
    context.reconcileIdleStatus = false;
    yield* updateProviderSession(
      context,
      { status: "error", lastError: detail },
      { clearActiveTurnId: true },
    );
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: promptAdmission.turnId,
        raw: promptAdmission.recoveryRaw,
      })),
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: detail,
        tokenUsage,
      },
    });
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: promptAdmission.turnId,
        raw: promptAdmission.recoveryRaw,
      })),
      type: "runtime.error",
      payload: {
        message: detail,
        class: "transport_error",
      },
    });
  });

  const schedulePromptAdmissionRecovery = Effect.fn("schedulePromptAdmissionRecovery")(function* (
    context: OpenCodeSessionContext,
    raw: unknown,
  ) {
    const promptAdmission = context.promptAdmission;
    if (!promptAdmission || promptAdmission.cancelled) {
      return;
    }
    if (raw !== undefined) {
      promptAdmission.recoveryRaw = raw;
    }
    if (promptAdmission.recoveryFiber) {
      return;
    }
    const recover = Effect.gen(function* () {
      if (!promptAdmission.requiresMessageReceipt) {
        yield* Deferred.await(promptAdmission.acceptance);
      }
      for (
        let retryCount = 0;
        retryCount < 5 || (promptAdmission.requiresMessageReceipt && !promptAdmission.accepted);
        retryCount += 1
      ) {
        if (
          context.promptAdmission !== promptAdmission ||
          context.activeTurnId !== promptAdmission.turnId ||
          context.promptGeneration !== promptAdmission.generation ||
          promptAdmission.cancelled ||
          (yield* Ref.get(context.stopped))
        ) {
          return;
        }

        if (!promptAdmission.messageObserved) {
          const response = yield* runOpenCodeSdk("session.message", (signal) =>
            context.client.session.message(
              {
                sessionID: context.openCodeSessionId,
                messageID: promptAdmission.messageId,
              },
              { signal },
            ),
          ).pipe(Effect.timeout("1 second"), Effect.option);
          const stopped = yield* Ref.get(context.stopped);
          if (
            stopped ||
            sessions.get(context.session.threadId) !== context ||
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled
          ) {
            return;
          }
          const message = Option.isSome(response) ? response.value.data : undefined;
          if (message?.info.id === promptAdmission.messageId && message.info.role === "user") {
            promptAdmission.messageObserved = true;
            yield* Deferred.succeed(promptAdmission.messageReceipt, undefined);
            context.messageRoleById.set(promptAdmission.messageId, "user");
            context.textPartsByMessageId.delete(promptAdmission.messageId);
          }
        }

        // Native command responses wait for generation. Recover their receipt
        // first, then let sendTurn acknowledge admission before reconciling idle.
        if (promptAdmission.requiresMessageReceipt && !promptAdmission.accepted) {
          if (!promptAdmission.messageObserved) {
            yield* Effect.sleep(`${Math.min(250 * 2 ** retryCount, 2_000)} millis`);
            continue;
          }
          retryCount = 0;
        }
        yield* Deferred.await(promptAdmission.acceptance);

        const statusResponse = yield* runOpenCodeSdk("session.status", (signal) =>
          context.client.session.status(undefined, { signal }),
        ).pipe(Effect.timeout("1 second"), Effect.option);
        const stopped = yield* Ref.get(context.stopped);
        if (
          stopped ||
          sessions.get(context.session.threadId) !== context ||
          context.promptAdmission !== promptAdmission ||
          context.activeTurnId !== promptAdmission.turnId ||
          context.promptGeneration !== promptAdmission.generation ||
          promptAdmission.cancelled
        ) {
          return;
        }
        const statusData = Option.isSome(statusResponse)
          ? Option.getOrUndefined(decodeOpenCodeSessionStatusMap(statusResponse.value.data))
          : undefined;
        const status = statusData?.[context.openCodeSessionId];
        const isIdle = statusData !== undefined && (status === undefined || status.type === "idle");
        const isBusy = status?.type === "busy" || status?.type === "retry";
        if (isBusy) {
          promptAdmission.busyObserved = true;
          promptAdmission.idleStatusConfirmations = 0;
          context.awaitingBusyAfterInterruption = false;
          context.promptAdmission = undefined;
          return;
        }

        const idle = promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
        if (
          isIdle &&
          idle !== undefined &&
          (promptAdmission.messageObserved || promptAdmission.busyObserved)
        ) {
          context.promptAdmission = undefined;
          context.awaitingBusyAfterInterruption = false;
          yield* scheduleIdleReconciliation(context, promptAdmission.turnId, idle.raw);
          return;
        }
        if (isIdle && promptAdmission.messageObserved) {
          promptAdmission.idleStatusConfirmations += 1;
          if (promptAdmission.idleStatusConfirmations >= 2) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* completeOpenCodeTurn(
              context,
              promptAdmission.turnId,
              promptAdmission.generation,
              {
                type: "session.status.recovered",
                status: statusData,
              },
            );
            return;
          }
        } else if (!isIdle) {
          promptAdmission.idleStatusConfirmations = 0;
        }
        if (
          isIdle &&
          promptAdmission.messageObserved &&
          promptAdmission.recoveryRaw !== undefined
        ) {
          context.promptAdmission = undefined;
          context.awaitingBusyAfterInterruption = false;
          yield* scheduleIdleReconciliation(
            context,
            promptAdmission.turnId,
            promptAdmission.recoveryRaw,
          );
          return;
        }

        const delayMs = Math.min(250 * 2 ** retryCount, 2_000);
        yield* Effect.sleep(`${delayMs} millis`);
      }
      yield* failPromptAdmissionRecovery(context, promptAdmission);
    }).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          delete promptAdmission.recoveryFiber;
        }),
      ),
    );
    promptAdmission.recoveryFiber = yield* recover.pipe(Effect.forkIn(context.sessionScope));
  });

  const interruptOpenCodeTurn = Effect.fn("interruptOpenCodeTurn")(function* (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    raw?: unknown,
  ) {
    if (context.interruptedTurnId === turnId) {
      return;
    }
    yield* cancelIdleReconciliation(context);
    context.interruptedTurnId = turnId;
    context.reconcileIdleStatus = true;
    context.awaitingBusyAfterInterruption = false;
    const cancellation = context.cancellation?.turnId === turnId ? context.cancellation : undefined;
    if (cancellation) {
      context.cancellation = undefined;
    }
    let tokenUsage: TurnTokenUsage = {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
    };
    if (context.activeTurnId === turnId) {
      tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      yield* updateProviderSession(
        context,
        { status: "ready" },
        { clearActiveTurnId: true, clearLastError: true },
      );
    }
    yield* clearPendingOpenCodeRequests(context, { type: "session.abort" });
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId,
        raw,
      })),
      type: "turn.aborted",
      payload: {
        reason: "Interrupted by user.",
        tokenUsage,
      },
    });
    if (cancellation) {
      yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
    }
  });

  const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
    context: OpenCodeSessionContext,
    message: string,
  ) {
    // Atomic one-shot: two fibers can race here (the event-pump on stream
    // failure and the server-exit watcher). `getAndSet` flips the flag in
    // a single step so the loser observes `true` and returns; a plain
    // `Ref.get` would let both racers slip past and emit duplicates.
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return;
    }
    yield* Deferred.fail(
      context.firstConnection,
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "event.subscribe",
        detail: "OpenCode session exited before the event stream connected.",
      }),
    ).pipe(Effect.ignore);
    yield* failPendingOpenCodeCancellation(context, "OpenCode session exited during cancellation.");
    context.promptAdmission = undefined;
    const turnId = context.activeTurnId;
    deleteContextIfCurrent(context);
    // Emit lifecycle events BEFORE tearing down the scope. Both call sites
    // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
    // closing that scope triggers the fiber-interrupt finalizer, so any
    // subsequent yield point would unwind and silently drop these emits.
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId,
      })),
      type: "runtime.error",
      payload: {
        message,
        class: "transport_error",
      },
    }).pipe(Effect.ignore);
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId,
      })),
      type: "session.exited",
      payload: {
        reason: message,
        recoverable: false,
        exitKind: "error",
      },
    }).pipe(Effect.ignore);
    // Inline the teardown that `stopOpenCodeContext` would do; we can't
    // delegate to it because our `getAndSet` above already flipped the
    // one-shot guard, so the call would no-op.
    yield* abortOpenCodeSessionForTeardown(context);
    yield* Scope.close(context.sessionScope, Exit.void);
  });

  /** Emit content.delta and item.completed events for an assistant text part. */
  const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
    context: OpenCodeSessionContext,
    part: OpenCodeTextPartState,
    turnId: TurnId | undefined,
    raw: unknown,
  ) {
    if (part.text === undefined) {
      return;
    }
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(part.emittedText, part.text);
    part.emittedText = latestText;
    part.text = latestText;
    if (deltaToEmit.length > 0) {
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt: part.time !== undefined ? isoFromEpochMs(part.time.start) : undefined,
          raw,
        })),
        type: "content.delta",
        payload: {
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit,
        },
      });
    }

    if (part.type === "text" && part.time?.end !== undefined && !part.completed) {
      part.completed = true;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt: isoFromEpochMs(part.time.end),
          raw,
        })),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(latestText.length > 0 ? { detail: latestText } : {}),
        },
      });
    }
  });

  // Records a child session of this thread. A child seen during a live turn
  // means that turn used subagents, whether the relation came from a
  // `session.created` event or a later ancestry lookup after reconnect.
  const addRelatedOpenCodeSession = (context: OpenCodeSessionContext, sessionId: string) => {
    context.relatedSessionIds.add(sessionId);
    if (context.activeTurnId && context.turnTokenUsage) {
      context.turnTokenUsage.hasSubagents = true;
    }
  };

  const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
    context: OpenCodeSessionContext,
    candidateSessionId: string,
  ) {
    if (context.relatedSessionIds.has(candidateSessionId)) {
      return true;
    }

    const seen = new Set<string>();
    const getSession = (sessionID: string) =>
      runOpenCodeSdk("session.get", (signal) =>
        context.client.session.get({ sessionID }, { signal }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new OpenCodeRuntimeError({
                operation: "session.get",
                detail: "OpenCode session ancestry lookup did not complete within 10 seconds.",
              }),
            ),
        }),
        Effect.catchIf(
          (cause) => isOpenCodeNotFound(cause),
          () => Effect.undefined,
        ),
      );
    let sessionId: string | undefined = candidateSessionId;
    for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
      if (context.relatedSessionIds.has(sessionId)) {
        addRelatedOpenCodeSession(context, candidateSessionId);
        return true;
      }
      if (seen.has(sessionId)) {
        return false;
      }
      seen.add(sessionId);
      const currentSessionId: string = sessionId;
      const response = yield* getSession(currentSessionId);
      if (response === undefined) {
        return false;
      }
      if (!response.data) {
        return yield* new OpenCodeRuntimeError({
          operation: "session.get",
          detail: `OpenCode session.get returned no session payload for '${currentSessionId}'.`,
        });
      }
      sessionId = response.data.parentID;
    }
    return false;
  });

  const openPermissionRequest = Effect.fn("openPermissionRequest")(function* (
    context: OpenCodeSessionContext,
    request: PermissionRequest,
    raw: unknown,
  ) {
    const base = yield* buildEventBase({
      threadId: context.session.threadId,
      turnId: context.activeTurnId,
      requestId: request.id,
      raw,
    });
    const stopped = yield* Ref.get(context.stopped);
    if (
      stopped ||
      context.emittedTerminalRequestIds.has(request.id) ||
      context.pendingPermissions.has(request.id)
    ) {
      return;
    }
    const patterns = request.patterns.filter((pattern) => pattern !== "*");
    const detail =
      request.permission === "bash" && patterns.length > 0
        ? patterns.join("\n")
        : [request.permission.replaceAll("_", " "), ...patterns].join("\n");
    context.autoRepliedRequestIds.delete(request.id);
    context.pendingPermissions.set(request.id, request);
    emitUnsafe({
      ...base,
      type: "request.opened",
      payload: {
        requestType: mapPermissionToRequestType(request.permission),
        detail,
        args: request.metadata,
        options: [
          { decision: "accept", label: "Allow once" },
          {
            decision: "acceptForSession",
            label: "Allow for workspace",
            warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
          },
          { decision: "decline", label: "Deny" },
        ],
      },
    });
  });

  // Full access means the user already granted everything, but two upstream
  // paths never consult the session ruleset we send: doom-loop detection
  // (evaluated against the agent ruleset only) and subagent sessions (which
  // keep only deny and external-directory rules). Answer those asks here.
  //
  // Reply "once", not "always": OpenCode stores "always" grants per
  // directory, so on a shared external server an "always" from a full-access
  // thread would silently widen what a supervised thread on the same
  // directory is allowed to do.
  const autoReplyFullAccess = Effect.fn("autoReplyFullAccess")(function* (
    context: OpenCodeSessionContext,
    request: PermissionRequest,
    raw: unknown,
  ) {
    const replied = yield* runOpenCodeSdk("permission.reply", (signal) =>
      context.client.permission.reply({ requestID: request.id, reply: "once" }, { signal }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!replied) {
      // Fall back to the dialog. The id stays resolved so a recovered copy
      // of this ask cannot reopen after the user answers;
      // `pendingPermissions` gates re-asks while the dialog is open.
      yield* openPermissionRequest(context, request, raw);
    }
  });

  const emitPendingOpenCodeRequest = Effect.fn("emitPendingOpenCodeRequest")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeAskedRequestEvent,
    raw: unknown,
  ) {
    if (context.resolvedRequestIds.has(event.properties.id)) {
      return;
    }
    if (context.activeTurnId === undefined && context.reconcileIdleStatus) {
      context.resolvedRequestIds.add(event.properties.id);
      return;
    }
    if (event.type === "permission.asked") {
      const request = event.properties;
      if (context.pendingPermissions.has(request.id)) {
        return;
      }
      if (context.session.runtimeMode === "full-access") {
        // Reply outside the event pump so a slow HTTP response cannot hide
        // progress, terminal replies, or the acknowledgment for Stop.
        context.resolvedRequestIds.add(request.id);
        context.autoRepliedRequestIds.add(request.id);
        yield* autoReplyFullAccess(context, request, raw).pipe(Effect.forkIn(context.sessionScope));
        return;
      }
      yield* openPermissionRequest(context, request, raw);
      return;
    }

    const request = event.properties;
    if (context.pendingQuestions.has(request.id)) {
      return;
    }
    const base = yield* buildEventBase({
      threadId: context.session.threadId,
      turnId: context.activeTurnId,
      requestId: request.id,
      raw,
    });
    const stopped = yield* Ref.get(context.stopped);
    if (stopped || context.resolvedRequestIds.has(request.id)) {
      return;
    }
    context.pendingQuestions.set(request.id, request);
    emitUnsafe({
      ...base,
      type: "user-input.requested",
      payload: { questions: normalizeQuestionRequest(request) },
    });
  });

  const resolvePendingOpenCodeRequest = Effect.fn("resolvePendingOpenCodeRequest")(function* (
    context: OpenCodeSessionContext,
    requestId: string,
  ) {
    context.resolvedRequestIds.add(requestId);
    const retry = context.requestRelationRetries.get(requestId);
    context.requestRelationRetries.delete(requestId);
    if (retry?.fiber) {
      yield* Fiber.interrupt(retry.fiber);
    }
  });

  const emitTerminalOpenCodeRequest = Effect.fn("emitTerminalOpenCodeRequest")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeTerminalRequestEvent,
    raw: unknown = event,
  ) {
    const requestId = event.properties.requestID;
    if (context.emittedTerminalRequestIds.has(requestId)) {
      return;
    }
    if (context.autoRepliedRequestIds.delete(requestId)) {
      context.emittedTerminalRequestIds.add(requestId);
      return;
    }
    const base = yield* buildEventBase({
      threadId: context.session.threadId,
      turnId: context.activeTurnId,
      requestId,
      raw,
    });
    if (context.emittedTerminalRequestIds.has(requestId)) return;
    context.emittedTerminalRequestIds.add(requestId);
    if (event.type === "permission.replied") {
      const request = context.pendingPermissions.get(requestId);
      context.pendingPermissions.delete(requestId);
      emitUnsafe({
        ...base,
        type: "request.resolved",
        payload: {
          requestType: request ? mapPermissionToRequestType(request.permission) : "unknown",
          decision: mapPermissionDecision(event.properties.reply),
        },
      });
      return;
    }

    const request = context.pendingQuestions.get(requestId);
    context.pendingQuestions.delete(requestId);
    const answers =
      event.type === "question.replied" && request
        ? Object.fromEntries(
            request.questions.map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          )
        : {};
    emitUnsafe({
      ...base,
      type: "user-input.resolved",
      payload: { answers },
    });
  });

  const closePendingOpenCodeRequests = Effect.fn("closePendingOpenCodeRequests")(function* (
    context: OpenCodeSessionContext,
    permissions: ReadonlyArray<PermissionRequest>,
    questions: ReadonlyArray<QuestionRequest>,
    raw: unknown,
  ) {
    for (const request of permissions) {
      if (!context.pendingPermissions.has(request.id)) continue;
      yield* resolvePendingOpenCodeRequest(context, request.id);
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        requestId: request.id,
        raw,
      });
      if (context.emittedTerminalRequestIds.has(request.id)) continue;
      context.pendingPermissions.delete(request.id);
      context.emittedTerminalRequestIds.add(request.id);
      emitUnsafe({
        ...base,
        type: "request.resolved",
        payload: { requestType: mapPermissionToRequestType(request.permission) },
      });
    }
    for (const request of questions) {
      if (!context.pendingQuestions.has(request.id)) continue;
      yield* resolvePendingOpenCodeRequest(context, request.id);
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        requestId: request.id,
        raw,
      });
      if (context.emittedTerminalRequestIds.has(request.id)) continue;
      context.pendingQuestions.delete(request.id);
      context.emittedTerminalRequestIds.add(request.id);
      emitUnsafe({ ...base, type: "user-input.resolved", payload: { answers: {} } });
    }
  });

  const clearPendingOpenCodeRequests = Effect.fn("clearPendingOpenCodeRequests")(function* (
    context: OpenCodeSessionContext,
    raw: unknown,
  ) {
    context.pendingRequestRecovery = undefined;
    for (const requestId of context.requestRelationRetries.keys()) {
      yield* resolvePendingOpenCodeRequest(context, requestId);
    }
    for (const requestId of context.autoRepliedRequestIds) {
      context.emittedTerminalRequestIds.add(requestId);
    }
    context.autoRepliedRequestIds.clear();
    yield* closePendingOpenCodeRequests(
      context,
      [...context.pendingPermissions.values()],
      [...context.pendingQuestions.values()],
      raw,
    );
  });

  const scheduleRequestRelationRetry = Effect.fn("scheduleRequestRelationRetry")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeRoutedRequestEvent,
    raw: unknown = event,
  ) {
    const isAskedEvent = event.type === "permission.asked" || event.type === "question.asked";
    const requestId = isAskedEvent ? event.properties.id : event.properties.requestID;
    if (context.requestRelationRetries.has(requestId)) {
      return;
    }
    if (isAskedEvent && context.resolvedRequestIds.has(requestId)) {
      return;
    }
    const retry: OpenCodeRequestRelationRetry = { warned: false };
    context.requestRelationRetries.set(requestId, retry);
    const run = Effect.gen(function* () {
      let retryCount = 0;
      while (context.requestRelationRetries.get(requestId) === retry) {
        const relation = yield* isRelatedOpenCodeSession(context, event.properties.sessionID).pipe(
          Effect.match({
            onFailure: (cause) => ({ type: "unknown" as const, cause }),
            onSuccess: (related) => ({ type: "known" as const, related }),
          }),
        );
        if (context.requestRelationRetries.get(requestId) !== retry) {
          return;
        }
        if (relation.type === "known") {
          context.requestRelationRetries.delete(requestId);
          if (relation.related) {
            if (isAskedEvent) {
              yield* emitPendingOpenCodeRequest(context, event, raw);
            } else {
              yield* emitTerminalOpenCodeRequest(context, event);
            }
          }
          return;
        }
        if (!retry.warned) {
          retry.warned = true;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              requestId,
            })),
            type: "runtime.warning",
            payload: {
              message: "OpenCode request routing is waiting for session ancestry.",
              detail: openCodeRuntimeErrorDetail(relation.cause),
            },
          });
        }
        const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
        retryCount += 1;
        if (!isAskedEvent && retryCount >= 5) {
          return;
        }
        yield* Effect.sleep(`${delayMs} millis`);
      }
    }).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          if (context.requestRelationRetries.get(requestId) === retry) {
            context.requestRelationRetries.delete(requestId);
          }
        }),
      ),
    );
    retry.fiber = yield* run.pipe(Effect.forkIn(context.sessionScope));
  });

  const schedulePendingRequestRecovery = Effect.fn("schedulePendingRequestRecovery")(function* (
    context: OpenCodeSessionContext,
  ) {
    if (context.pendingRequestRecovery) {
      context.pendingRequestRecovery.rerun = true;
      return;
    }
    const recovery: OpenCodePendingRequestRecovery = { warned: false, rerun: false };
    context.pendingRequestRecovery = recovery;
    const run = Effect.gen(function* () {
      let retryCount = 0;
      while (context.pendingRequestRecovery === recovery) {
        // Only requests pending before the snapshot can be closed by it.
        const priorPermissions = [...context.pendingPermissions.values()];
        const priorQuestions = [...context.pendingQuestions.values()];
        const responses = yield* Effect.all(
          {
            permissions: runOpenCodeSdk("permission.list", (signal) =>
              context.client.permission.list(undefined, { signal }),
            ),
            questions: runOpenCodeSdk("question.list", (signal) =>
              context.client.question.list(undefined, { signal }),
            ),
          },
          { concurrency: 2 },
        ).pipe(
          Effect.timeout("10 seconds"),
          Effect.match({
            onFailure: (cause) => ({ type: "failure" as const, cause }),
            onSuccess: (value) => ({ type: "success" as const, value }),
          }),
        );
        if (context.pendingRequestRecovery !== recovery) {
          return;
        }
        if (responses.type === "failure") {
          if (!recovery.warned) {
            recovery.warned = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode pending request recovery failed and will retry.",
                detail: openCodeRuntimeErrorDetail(responses.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
          continue;
        }
        const permissions = responses.value.permissions.data;
        const questions = responses.value.questions.data;
        if (permissions === undefined || questions === undefined) {
          if (!recovery.warned) {
            recovery.warned = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode pending request recovery returned no data and will retry.",
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
          continue;
        }
        const permissionIds = new Set(permissions.map((request) => request.id));
        const questionIds = new Set(questions.map((request) => request.id));
        yield* closePendingOpenCodeRequests(
          context,
          priorPermissions.filter((request) => !permissionIds.has(request.id)),
          priorQuestions.filter((request) => !questionIds.has(request.id)),
          { type: "pending-requests.recovered" },
        );
        yield* Effect.forEach(
          permissions,
          (request) =>
            scheduleRequestRelationRetry(
              context,
              { id: `recovered:${request.id}`, type: "permission.asked", properties: request },
              { type: "permission.asked", properties: request, recovered: true },
            ),
          { discard: true },
        );
        yield* Effect.forEach(
          questions,
          (request) =>
            scheduleRequestRelationRetry(
              context,
              { id: `recovered:${request.id}`, type: "question.asked", properties: request },
              { type: "question.asked", properties: request, recovered: true },
            ),
          { discard: true },
        );
        if (recovery.rerun) {
          recovery.rerun = false;
          recovery.warned = false;
          continue;
        }
        context.pendingRequestRecovery = undefined;
        return;
      }
    }).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          if (context.pendingRequestRecovery === recovery) {
            context.pendingRequestRecovery = undefined;
          }
        }),
      ),
    );
    yield* run.pipe(Effect.forkIn(context.sessionScope));
  });

  return {
    cancelIdleReconciliation,
    completeOpenCodeTurn,
    scheduleIdleReconciliation,
    failPromptAdmissionRecovery,
    schedulePromptAdmissionRecovery,
    interruptOpenCodeTurn,
    emitUnexpectedExit,
    emitAssistantTextDelta,
    addRelatedOpenCodeSession,
    isRelatedOpenCodeSession,
    openPermissionRequest,
    autoReplyFullAccess,
    emitPendingOpenCodeRequest,
    resolvePendingOpenCodeRequest,
    emitTerminalOpenCodeRequest,
    closePendingOpenCodeRequests,
    clearPendingOpenCodeRequests,
    scheduleRequestRelationRetry,
    schedulePendingRequestRecovery,
  };
};

export type OpenCodeRequestHandlers = ReturnType<typeof makeOpenCodeRequestHandlers>;
