import {
  EventId,
  type OpenCodeSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  loadOpenCodeCommands,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "../opencodeRuntime.ts";
import { scopedOpenCodeModelIssue, type OpenCodeProviderScope } from "../openCodeProviderScope.ts";
import {
  OPENCODE_RESUME_VERSION,
  type OpenCodeCancellation,
  type OpenCodePromptAdmission,
  type OpenCodeSessionContext,
  type OpenCodeStepUsage,
  type OpenCodeSubscribedEvent,
  type OpenCodeTurnSnapshot,
  PROVIDER,
  accumulateOpenCodeStepUsage,
  isOpenCodeAbortError,
  isOpenCodeChildRequestEvent,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeTurnTokenUsageAccumulator,
  openCodeEventSessionId,
  openCodeEventSessionTitle,
  parseOpenCodeResume,
  takeOpenCodeTurnTokenUsage,
  trimText,
} from "./OpenCodeAdapter.state.ts";
import {
  type EventBaseInput,
  abortOpenCodeDescendants,
  appendOpenCodeAssistantTextDelta,
  applyProviderSessionUpdate,
  closeStartingOpenCodeContext,
  detailFromToolPart,
  ensureSessionContext,
  messageRoleForPart,
  nowIso,
  resolveTextStreamKind,
  retainOpenCodeTextPart,
  sessionErrorMessage,
  stopOpenCodeContext,
  toProcessError,
  toRequestError,
  toToolLifecycleItemType,
  toolStateCreatedAt,
  updateProviderSession,
} from "./OpenCodeAdapter.helpers.ts";
import { makeOpenCodeRequestHandlers } from "./OpenCodeAdapter.requests.ts";

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerScope?: OpenCodeProviderScope;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const deleteContextIfCurrent = (context: OpenCodeSessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };
    const awaitOpenCodeContextReady = Effect.fn("awaitOpenCodeContextReady")(function* (
      context: OpenCodeSessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(sessions, context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    let messageIdEpochMillis = -1;
    let messageIdCounter = 0;
    // T3 supplies the message ID to match prompt admission events. Keep OpenCode's sortable native shape so equal-time messages retain their upstream order.
    const makeOpenCodeMessageId = Effect.fn("makeOpenCodeMessageId")(function* () {
      const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
      if (epochMillis !== messageIdEpochMillis) {
        messageIdEpochMillis = epochMillis;
        messageIdCounter = 0;
      }
      messageIdCounter += 1;
      const encodedTime = BigInt.asUintN(
        48,
        BigInt(epochMillis) * 0x1000n + BigInt(messageIdCounter),
      )
        .toString(16)
        .padStart(12, "0");
      const randomBytes = yield* crypto.randomBytes(14).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "crypto/randomBytes",
              detail: "Failed to generate an OpenCode message identifier.",
              cause,
            }),
        ),
      );
      const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const random = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
      return `msg_${encodedTime}${random}`;
    });
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    // Synchronous publish for callers that must not yield between a state
    // check and the enqueue, e.g. reopening an approval only if its terminal
    // event has not landed yet.
    const emitUnsafe = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(runtimeEvents, event);
    };
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.ignoreCause);

    const {
      cancelIdleReconciliation,
      completeOpenCodeTurn,
      scheduleIdleReconciliation,
      schedulePromptAdmissionRecovery,
      interruptOpenCodeTurn,
      emitUnexpectedExit,
      emitAssistantTextDelta,
      addRelatedOpenCodeSession,
      emitPendingOpenCodeRequest,
      resolvePendingOpenCodeRequest,
      emitTerminalOpenCodeRequest,
      clearPendingOpenCodeRequests,
      scheduleRequestRelationRetry,
      schedulePendingRequestRecovery,
    } = makeOpenCodeRequestHandlers({
      sessions,
      deleteContextIfCurrent,
      buildEventBase,
      emit,
      emitUnsafe,
    });
    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (event.type === "server.connected") {
        if (
          (yield* Ref.get(context.stopped)) ||
          sessions.get(context.session.threadId) !== context
        ) {
          return;
        }
        const isFirstConnection = !(yield* Deferred.isDone(context.firstConnection));
        if (isFirstConnection) {
          const updatedAt = yield* nowIso;
          if (
            (yield* Ref.get(context.stopped)) ||
            sessions.get(context.session.threadId) !== context
          ) {
            return;
          }
          applyProviderSessionUpdate(context, { status: "ready" }, undefined, updatedAt);
          if (!(yield* Deferred.succeed(context.firstConnection, undefined))) {
            return;
          }
        }
        yield* schedulePendingRequestRecovery(context);
        if (!isFirstConnection) {
          if (context.turnTokenUsage) {
            context.turnTokenUsage.complete = false;
          }
          yield* schedulePromptAdmissionRecovery(context, event);
          if (context.activeTurnId !== undefined && context.promptAdmission === undefined) {
            yield* scheduleIdleReconciliation(context, context.activeTurnId, event);
          }
        }
        return;
      }
      const terminalRequestId =
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
          ? event.properties.requestID
          : undefined;
      if (terminalRequestId !== undefined) {
        yield* resolvePendingOpenCodeRequest(context, terminalRequestId);
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const session = event.properties.info;
        if (session.parentID && context.relatedSessionIds.has(session.parentID)) {
          addRelatedOpenCodeSession(context, session.id);
        }
      } else if (event.type === "session.deleted") {
        context.relatedSessionIds.delete(event.properties.info.id);
      }

      const payloadSessionId = openCodeEventSessionId(event);
      const isParentEvent = payloadSessionId === context.openCodeSessionId;
      let isKnownPendingTerminalEvent = false;
      if (
        payloadSessionId !== undefined &&
        !context.relatedSessionIds.has(payloadSessionId) &&
        isOpenCodeChildRequestEvent(event)
      ) {
        if (event.type === "permission.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (event.type === "question.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (
          event.type === "permission.replied" ||
          event.type === "question.replied" ||
          event.type === "question.rejected"
        ) {
          const requestId = event.properties.requestID;
          isKnownPendingTerminalEvent =
            context.pendingPermissions.has(requestId) || context.pendingQuestions.has(requestId);
          if (!isKnownPendingTerminalEvent) {
            yield* scheduleRequestRelationRetry(context, event);
            return;
          }
        }
      }
      const isChildRequestEvent =
        payloadSessionId !== undefined &&
        isOpenCodeChildRequestEvent(event) &&
        (context.relatedSessionIds.has(payloadSessionId) || isKnownPendingTerminalEvent);
      if (!isParentEvent && !isChildRequestEvent) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          ...(!isParentEvent && payloadSessionId ? { childSessionId: payloadSessionId } : {}),
          payload: event,
        },
      });

      const suppressInterruptedParentOutput =
        isParentEvent &&
        ((context.activeTurnId === undefined &&
          (context.interruptedTurnId !== undefined || context.reconcileIdleStatus)) ||
          context.awaitingBusyAfterInterruption) &&
        (event.type === "message.part.delta" ||
          event.type === "message.part.updated" ||
          event.type === "todo.updated" ||
          (event.type === "message.updated" && event.properties.info.role === "assistant"));
      if (suppressInterruptedParentOutput) {
        return;
      }

      switch (event.type) {
        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }
        case "session.compacted": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: event,
            },
          });
          break;
        }

        case "message.updated": {
          const promptAdmission = context.promptAdmission;
          if (
            event.properties.info.role === "user" &&
            promptAdmission?.messageId === event.properties.info.id
          ) {
            promptAdmission.messageObserved = true;
            yield* Deferred.succeed(promptAdmission.messageReceipt, undefined);
            if (promptAdmission.accepted) {
              const idle = promptAdmission.idleDuringAdmission;
              context.awaitingBusyAfterInterruption = false;
              context.promptAdmission = undefined;
              if (promptAdmission.recoveryFiber) {
                yield* Fiber.interrupt(promptAdmission.recoveryFiber);
              }
              if (idle) {
                yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
              }
            }
          }
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "user") {
            context.textPartsByMessageId.delete(event.properties.info.id);
          }
          if (event.properties.info.role === "assistant") {
            const usage = context.turnTokenUsage;
            const parentMessageId =
              typeof event.properties.info.parentID === "string" &&
              event.properties.info.parentID.trim().length > 0
                ? event.properties.info.parentID
                : undefined;
            const observedOwnership =
              parentMessageId === undefined
                ? "unknown"
                : usage?.promptMessageIds.has(parentMessageId)
                  ? "owned"
                  : "other";
            const priorOwnership = usage?.assistantOwnershipByMessageId.get(
              event.properties.info.id,
            );
            const ownership =
              priorOwnership === undefined || priorOwnership === "unknown"
                ? observedOwnership
                : priorOwnership;
            if (usage) {
              usage.assistantOwnershipByMessageId.set(event.properties.info.id, ownership);
              if (ownership !== "unknown") {
                const steps = usage.unresolvedStepsByMessageId.get(event.properties.info.id);
                if (ownership === "owned" && steps) {
                  for (const step of steps.values()) {
                    accumulateOpenCodeStepUsage(usage, step);
                  }
                }
                usage.unresolvedStepsByMessageId.delete(event.properties.info.id);
              }
            }
            for (const part of context.textPartsByMessageId
              .get(event.properties.info.id)
              ?.values() ?? []) {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          context.textPartsByMessageId.delete(event.properties.messageID);
          break;
        }

        case "message.part.removed": {
          const parts = context.textPartsByMessageId.get(event.properties.messageID);
          parts?.delete(event.properties.partID);
          if (parts?.size === 0) {
            context.textPartsByMessageId.delete(event.properties.messageID);
          }
          break;
        }

        case "message.part.delta": {
          const existingPart = context.textPartsByMessageId
            .get(event.properties.messageID)
            ?.get(event.properties.partID);
          if (existingPart?.text === undefined || event.properties.field !== "text") {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText = existingPart.emittedText ?? existingPart.text;
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          existingPart.emittedText = nextText;
          existingPart.text = nextText;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          const messageRole = messageRoleForPart(context, part);

          if (turnId && part.type === "step-finish" && context.turnTokenUsage) {
            const usage = context.turnTokenUsage;
            const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
            if (ownership === "owned") {
              accumulateOpenCodeStepUsage(usage, part);
            } else if (
              ownership === "unknown" ||
              (ownership === undefined &&
                context.messageRoleById.get(part.messageID) !== "assistant")
            ) {
              const steps =
                usage.unresolvedStepsByMessageId.get(part.messageID) ??
                new Map<string, OpenCodeStepUsage>();
              steps.set(part.id, { id: part.id, tokens: part.tokens });
              usage.unresolvedStepsByMessageId.set(part.messageID, steps);
            }
          }

          if ((part.type === "text" || part.type === "reasoning") && messageRole !== "user") {
            const state = retainOpenCodeTextPart(context, part);
            if (messageRole === "assistant") {
              yield* emitAssistantTextDelta(context, state, turnId, event);
            }
          } else {
            const previous = context.textPartsByMessageId.get(part.messageID)?.get(part.id);
            if (previous) {
              // A non-text PATCH removes the current snapshot. Keep emitted text
              // so a later text PATCH still emits only the changed suffix.
              previous.text = undefined;
            }
          }

          if (part.type === "tool") {
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" || part.state.status === "completed"
                ? (part.state.title ?? part.tool)
                : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
                ...(typeof part.state.input.command === "string"
                  ? { command: part.state.input.command }
                  : {}),
                ...(itemType === "file_change" ? { input: part.state.input } : {}),
                ...(part.state.status === "completed" &&
                (itemType === "command_execution" || itemType === "mcp_tool_call")
                  ? { result: part.state.output }
                  : {}),
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "permission.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "question.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "question.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "question.rejected": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "todo.updated": {
          if (turnId === undefined) break;
          const base = yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            raw: event,
          });
          // Session-wide task updates must not reopen progress after a turn ends.
          if (context.activeTurnId !== turnId) break;
          emitUnsafe({
            ...base,
            type: "turn.plan.updated",
            payload: {
              plan: event.properties.todos
                .filter((todo) => todo.status !== "cancelled")
                .map((todo) => ({
                  step: trimText(todo.content) ?? "Task",
                  status:
                    todo.status === "completed"
                      ? "completed"
                      : todo.status === "in_progress"
                        ? "inProgress"
                        : "pending",
                })),
            },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
            if (turnId === undefined) {
              break;
            }
            yield* cancelIdleReconciliation(context);
            context.awaitingBusyAfterInterruption = false;
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.busyObserved = true;
              yield* schedulePromptAdmissionRecovery(context, event);
            }
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: `OpenCode retry ${event.properties.status.attempt}: ${event.properties.status.message}`,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            if (context.cancellation?.turnId === turnId) {
              context.cancellation.deferredIdleEvent = event;
              break;
            }
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.idleDuringAdmission = { turnId, raw: event };
              context.promptAdmission.idleObservedAfterMessage =
                context.promptAdmission.messageObserved;
              yield* schedulePromptAdmissionRecovery(context, event);
              break;
            }
            if (context.awaitingBusyAfterInterruption) {
              break;
            }
            if (context.reconcileIdleStatus) {
              yield* scheduleIdleReconciliation(context, turnId, event);
              break;
            }
            yield* completeOpenCodeTurn(context, turnId, context.promptGeneration, event);
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const cancellation = context.cancellation;
          if (isOpenCodeAbortError(event.properties.error)) {
            if (cancellation !== undefined && cancellation.turnId === undefined) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (context.interruptedTurnId !== undefined || context.reconcileIdleStatus) {
              break;
            }
          }
          yield* cancelIdleReconciliation(context);
          const terminalCancellation =
            activeTurnId !== undefined && cancellation?.turnId === activeTurnId
              ? cancellation
              : undefined;
          if (terminalCancellation) {
            terminalCancellation.turnSettled = true;
            terminalCancellation.acknowledged = true;
          }
          const tokenUsage = activeTurnId ? takeOpenCodeTurnTokenUsage(context, false) : undefined;
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          context.reconcileIdleStatus = false;
          yield* schedulePendingRequestRecovery(context);
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
                tokenUsage,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          if (terminalCancellation) {
            yield* Deferred.succeed(terminalCancellation.acknowledgment, undefined).pipe(
              Effect.ignore,
            );
          }
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      // @effect-diagnostics-next-line abortControllerInEffect:off - aborted by a scope finalizer to cancel the SDK's event.subscribe fetch
      const eventsAbortController = new AbortController();
      let lastStreamError: unknown;
      let warnedAboutDisconnect = false;
      const streamErrors = yield* Queue.unbounded<unknown>();
      yield* Scope.addFinalizer(context.sessionScope, Queue.shutdown(streamErrors));
      yield* Stream.fromQueue(streamErrors).pipe(
        Stream.runForEach((cause) =>
          Effect.gen(function* () {
            if (warnedAboutDisconnect) return;
            warnedAboutDisconnect = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode connection lost. Reconnecting.",
                detail: openCodeRuntimeErrorDetail(cause),
              },
            });
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
            onSseError: (cause) => {
              lastStreamError = cause;
              Queue.offerUnsafe(streamErrors, cause);
            },
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(
            Stream.runForEach((event) => {
              if (event.type === "server.connected") lastStreamError = undefined;
              if (event.type === "server.connected") warnedAboutDisconnect = false;
              return handleSubscribedEvent(context, event);
            }),
          ),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            yield* emitUnexpectedExit(
              context,
              Exit.isFailure(exit)
                ? openCodeRuntimeErrorDetail(Cause.squash(exit.cause))
                : lastStreamError !== undefined
                  ? `OpenCode event stream disconnected: ${openCodeRuntimeErrorDetail(lastStreamError)}`
                  : "OpenCode event stream ended unexpectedly. Send another message to reconnect.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
      // Scope finalizers run in reverse order. Abort the pending read before
      // interrupting the pump, whose iterator.return() waits for that read.
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const requestedProviderId = parseOpenCodeModelSlug(input.modelSelection?.model)?.providerID;
        const startIssue = scopedOpenCodeModelIssue(
          options?.providerScope,
          requestedProviderId ?? options?.providerScope?.providerId ?? "",
          serverUrl,
        );
        if (startIssue) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: startIssue,
          });
        }
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitOpenCodeContextReady(existing)).session;
          }
          yield* stopOpenCodeContext(existing);
          deleteContextIfCurrent(existing);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                directory,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                environment: McpProviderSession.withAgentDeviceEnvironment(
                  options?.environment ?? process.env,
                  mcpSession,
                ),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: "t3-code",
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: {
                        Authorization: mcpSession.authorizationHeader,
                      },
                      oauth: false,
                    },
                  }),
                );
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    ...(input.title ? { title: input.title } : {}),
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          relatedSessionIds: new Set([started.openCodeSession.id]),
          resolvedRequestIds: new Set(),
          autoRepliedRequestIds: new Set(),
          emittedTerminalRequestIds: new Set(),
          requestRelationRetries: new Map(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          textPartsByMessageId: new Map(),
          messageRoleById: new Map(),
          turnTokenUsage: undefined,
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          cancellation: undefined,
          interruptedTurnId: undefined,
          reconcileIdleStatus: false,
          awaitingBusyAfterInterruption: false,
          pendingIdleReconciliation: undefined,
          pendingRequestRecovery: undefined,
          promptGeneration: 0,
          promptAdmission: undefined,
          commandFibers: new Set(),
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another start published first. A newly created remote session
          // belongs to this loser; a resumed session is shared upstream state.
          yield* closeStartingOpenCodeContext(context, started.created);
          return (yield* awaitOpenCodeContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);
        const cleanupStartingContext = closeStartingOpenCodeContext(context, started.created).pipe(
          Effect.ensuring(Effect.sync(() => deleteContextIfCurrent(context))),
        );
        const connectionExit = yield* Effect.gen(function* () {
          yield* startEventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: "OpenCode event stream did not connect within 10 seconds.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* awaitOpenCodeContextReady(context);
        if (!started.created) {
          yield* schedulePendingRequestRecovery(context);
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }
      const sendIssue = scopedOpenCodeModelIssue(
        options?.providerScope,
        parsedModel.providerID,
        openCodeSettings.serverUrl,
      );
      if (sendIssue) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: sendIssue,
        });
      }

      const text = input.input?.trim();
      const commandMatch = text?.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
      const nativeCommand = commandMatch
        ? (yield* loadOpenCodeCommands(context.client).pipe(
            Effect.timeout("10 seconds"),
            Effect.orElseSucceed(() => []),
          )).find((command) => command.name === commandMatch[1])
        : undefined;
      // OpenCode ingests images, text, and PDFs natively; formats its model
      // paths reject ride only as the prompt's file path line.
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          const freshTurnId = TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          const messageId = yield* makeOpenCodeMessageId();
          const pendingCancellation = context.cancellation;
          if (pendingCancellation) {
            const cancellationResult = yield* Deferred.await(pendingCancellation.completion).pipe(
              Effect.result,
            );
            if ((yield* Ref.get(context.stopped)) || sessions.get(input.threadId) !== context) {
              return yield* Effect.interrupt;
            }
            if (cancellationResult._tag === "Failure") {
              return yield* cancellationResult.failure;
            }
          }
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          // A sendTurn while a turn is active is a steer. OpenCode queues the
          // prompt into the running session, so the active turn id is reused.
          const steeringTurnId = context.activeTurnId;
          const turnId = steeringTurnId ?? freshTurnId;
          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
          const pendingIdleReconciliation = context.pendingIdleReconciliation;
          const priorAwaitingBusy = context.awaitingBusyAfterInterruption;
          const priorIdleCandidate = pendingIdleReconciliation
            ? {
                turnId: pendingIdleReconciliation.turnId,
                raw: pendingIdleReconciliation.raw,
              }
            : undefined;
          context.pendingIdleReconciliation = undefined;
          const promptGeneration = context.promptGeneration + 1;
          const promptAdmission: OpenCodePromptAdmission = {
            generation: promptGeneration,
            turnId,
            messageId,
            requiresMessageReceipt: nativeCommand !== undefined,
            priorAwaitingBusy,
            priorIdle: priorIdleCandidate,
            idleDuringAdmission: undefined,
            idleObservedAfterMessage: false,
            messageObserved: false,
            busyObserved: false,
            idleStatusConfirmations: 0,
            accepted: false,
            cancelled: false,
            acceptance: Deferred.makeUnsafe<void>(),
            messageReceipt: Deferred.makeUnsafe<void>(),
            submissionSettled: Deferred.makeUnsafe<void>(),
            recoveryRaw: undefined,
          };
          context.promptGeneration = promptGeneration;
          context.promptAdmission = promptAdmission;

          context.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            context.turnTokenUsage = makeOpenCodeTurnTokenUsageAccumulator();
          }
          context.turnTokenUsage?.promptMessageIds.add(messageId);
          context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
          context.activeVariant = variant;
          if (steeringTurnId === undefined) {
            context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
          }
          if (pendingIdleReconciliation?.fiber) {
            yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
          }
          yield* updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );

          if (steeringTurnId === undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: {
                model: modelSelection?.model ?? context.session.model,
              },
            });
          }

          if (promptAdmission.cancelled || (yield* Ref.get(context.stopped))) {
            yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
              Effect.ignore,
            );
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            return yield* Effect.interrupt;
          }

          let promptTimedOut = false;
          const submissionMethod = nativeCommand ? "session.command" : "session.promptAsync";
          // Native commands expand provider-owned templates. Their API does not
          // accept the per-turn system addendum supported by ordinary prompts.
          const submission = nativeCommand
            ? Effect.raceFirst(
                runOpenCodeSdk("session.command", (signal) =>
                  context.client.session.command(
                    {
                      sessionID: context.openCodeSessionId,
                      messageID: messageId,
                      command: nativeCommand.name,
                      arguments: commandMatch?.[2] ?? "",
                      model: `${parsedModel.providerID}/${parsedModel.modelID}`,
                      ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                      ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                      parts: fileParts,
                    },
                    { signal },
                  ),
                ).pipe(Effect.asVoid),
                // A command response waits for generation. Only bound admission;
                // the user-message receipt proves OpenCode accepted the command.
                Deferred.await(promptAdmission.messageReceipt).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.andThen(Effect.never),
                ),
              )
            : runOpenCodeSdk("session.promptAsync", (signal) =>
                context.client.session.promptAsync(
                  {
                    sessionID: context.openCodeSessionId,
                    messageID: messageId,
                    model: parsedModel,
                    ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                    ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                    // OpenCode appends this after its own agent/provider prompts.
                    system: buildRuntimeInstructions({
                      harness: "OpenCode",
                      model: `${parsedModel.providerID}/${parsedModel.modelID}`,
                    }),
                    parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
                  },
                  { signal },
                ),
              ).pipe(Effect.timeout("10 seconds"), Effect.asVoid);
          const promptEffect = submission.pipe(
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) => {
                promptTimedOut = true;
                return Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: submissionMethod,
                    detail: "OpenCode prompt submission did not complete within 10 seconds.",
                    cause,
                  }),
                );
              },
            }),
            Effect.tapError(() => {
              promptAdmission.requiresMessageReceipt = false;
              return nativeCommand && promptAdmission.recoveryFiber
                ? Fiber.interrupt(promptAdmission.recoveryFiber)
                : Effect.void;
            }),
            Effect.tapError((requestError) => {
              if (
                nativeCommand &&
                (promptAdmission.cancelled || context.cancellation?.turnId === turnId)
              ) {
                return Effect.void;
              }
              if (
                nativeCommand &&
                promptAdmission.accepted &&
                context.activeTurnId === turnId &&
                (steeringTurnId !== undefined ||
                  context.promptGeneration !== promptAdmission.generation)
              ) {
                return Effect.gen(function* () {
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                    type: "runtime.warning",
                    payload: {
                      message: `OpenCode /${nativeCommand.name} failed after it was accepted.`,
                      detail: requestError.detail,
                    },
                  });
                });
              }
              return (nativeCommand
                ? context.promptGeneration !== promptAdmission.generation
                : context.promptAdmission !== promptAdmission) || context.activeTurnId !== turnId
                ? Effect.void
                : Effect.gen(function* () {
                    if (!promptTimedOut) {
                      if (steeringTurnId !== undefined) {
                        context.promptAdmission = undefined;
                        context.awaitingBusyAfterInterruption = promptAdmission.priorAwaitingBusy;
                        const idle =
                          promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
                        if (idle) {
                          yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
                        }
                        return;
                      }
                      const tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
                      context.promptAdmission = undefined;
                      context.activeTurnId = undefined;
                      context.activeAgent = undefined;
                      context.activeVariant = undefined;
                      yield* updateProviderSession(
                        context,
                        {
                          status: "ready",
                          model: modelSelection?.model ?? context.session.model,
                          lastError: requestError.detail,
                        },
                        { clearActiveTurnId: true },
                      );
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "turn.aborted",
                        payload: {
                          reason: requestError.detail,
                          tokenUsage,
                        },
                      });
                      return;
                    }
                    const cleanupExit = yield* Effect.exit(
                      runOpenCodeSdk("session.abort", (signal) =>
                        context.client.session.abort(
                          { sessionID: context.openCodeSessionId },
                          { signal },
                        ),
                      ).pipe(Effect.timeout("1 second")),
                    );
                    if (Exit.isFailure(cleanupExit)) {
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "runtime.warning",
                        payload: {
                          message:
                            "OpenCode prompt submission failed and its cleanup abort did not complete.",
                          detail: openCodeRuntimeErrorDetail(Cause.squash(cleanupExit.cause)),
                        },
                      });
                      yield* schedulePromptAdmissionRecovery(context, {
                        requestError,
                        cleanupError: Cause.squash(cleanupExit.cause),
                      });
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
                      {
                        status: "ready",
                        model: modelSelection?.model ?? context.session.model,
                        lastError: requestError.detail,
                      },
                      { clearActiveTurnId: true },
                    );
                    yield* emit({
                      ...(yield* buildEventBase({
                        threadId: input.threadId,
                        turnId,
                      })),
                      type: "turn.aborted",
                      payload: {
                        reason: requestError.detail,
                        tokenUsage,
                      },
                    });
                  });
            }),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
                  Effect.ignore,
                );
                if (Exit.isFailure(exit)) {
                  yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(
                    Effect.ignore,
                  );
                }
              }),
            ),
            Effect.asVoid,
          );
          const promptFiber = yield* promptEffect.pipe(Effect.forkIn(context.sessionScope));
          promptAdmission.promptFiber = promptFiber;
          if (nativeCommand) {
            context.commandFibers.add(promptFiber);
            promptFiber.addObserver(() => context.commandFibers.delete(promptFiber));
            yield* schedulePromptAdmissionRecovery(context, undefined);
          }
          const promptExit = yield* Effect.exit(
            nativeCommand
              ? Effect.raceFirst(
                  Fiber.join(promptFiber),
                  Deferred.await(promptAdmission.messageReceipt),
                )
              : Fiber.join(promptFiber),
          );
          if (!nativeCommand) delete promptAdmission.promptFiber;

          const intentionallyCancelled =
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped)) ||
            sessions.get(input.threadId) !== context;
          if (Exit.isFailure(promptExit) && !intentionallyCancelled) {
            return yield* Effect.failCause(promptExit.cause);
          }
          const cancelled =
            intentionallyCancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation;
          if (cancelled) {
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }
          promptAdmission.accepted = true;
          yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(Effect.ignore);
          if (
            context.promptAdmission === promptAdmission &&
            context.activeTurnId === turnId &&
            context.promptGeneration === promptAdmission.generation &&
            promptAdmission.messageObserved
          ) {
            context.awaitingBusyAfterInterruption = false;
            const idle = promptAdmission.idleDuringAdmission;
            if (idle && !promptAdmission.idleObservedAfterMessage) {
              yield* schedulePromptAdmissionRecovery(context, idle.raw);
            } else {
              context.promptAdmission = undefined;
            }
            if (idle && promptAdmission.idleObservedAfterMessage) {
              yield* scheduleIdleReconciliation(context, turnId, idle.raw);
            }
          } else {
            yield* schedulePromptAdmissionRecovery(context, promptAdmission.recoveryRaw);
          }

          const stopped = yield* Ref.get(context.stopped);
          const finalCancellation = context.cancellation;
          if (
            stopped ||
            sessions.get(input.threadId) !== context ||
            promptAdmission.cancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            finalCancellation?.turnId === turnId
          ) {
            if (finalCancellation?.turnId === turnId) {
              yield* Deferred.await(finalCancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }

          return {
            threadId: input.threadId,
            turnId,
            // Re-surface the durable cursor on every turn so the persisted binding
            // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }).pipe(
          // stopSession waits on submissionSettled; an interrupted sendTurn
          // must not leave it pending.
          Effect.ensuring(
            Effect.suspend(() => {
              const admission = context.promptAdmission;
              return admission
                ? Deferred.succeed(admission.submissionSettled, undefined).pipe(Effect.ignore)
                : Effect.void;
            }),
          ),
        ),
      );
    });

    const compactThread = Effect.fn("compactThread")(function* (
      threadId: ThreadId,
      requestedModelSelection?: ProviderSendTurnInput["modelSelection"],
    ) {
      const context = yield* ensureSessionContext(sessions, threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        requestedModelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: `OpenCode model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: "OpenCode compaction requires an active 'provider/model' selection.",
        });
      }
      const compactIssue = scopedOpenCodeModelIssue(
        options?.providerScope,
        parsedModel.providerID,
        openCodeSettings.serverUrl,
      );
      if (compactIssue) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: compactIssue,
        });
      }
      yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (sessions.get(threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          if (context.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "compactThread",
              issue: "OpenCode cannot compact while a turn is running.",
            });
          }
          yield* runOpenCodeSdk("session.summarize", (signal) =>
            context.client.session.summarize(
              {
                sessionID: context.openCodeSessionId,
                ...parsedModel,
                auto: false,
              },
              { signal },
            ),
          ).pipe(
            Effect.timeout("10 minutes"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.summarize",
                    detail: "OpenCode session compaction did not complete within 10 minutes.",
                    cause,
                  }),
                ),
            }),
            Effect.asVoid,
          );
        }),
      );
    });
    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        yield* cancelIdleReconciliation(context);
        if (interruptedTurnId && context.interruptedTurnId === interruptedTurnId) {
          return;
        }
        const existingCancellation = context.cancellation;
        if (existingCancellation !== undefined) {
          return yield* Deferred.await(existingCancellation.completion);
        }
        const cancellation: OpenCodeCancellation = {
          turnId: interruptedTurnId,
          acknowledgment: Deferred.makeUnsafe<void>(),
          completion: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
        };
        context.cancellation = cancellation;
        const promptAdmission = context.promptAdmission;
        if (promptAdmission !== undefined && promptAdmission.turnId === interruptedTurnId) {
          promptAdmission.cancelled = true;
          if (promptAdmission.promptFiber) {
            yield* Fiber.interrupt(promptAdmission.promptFiber);
          }
          yield* Deferred.await(promptAdmission.submissionSettled);
        }

        yield* Effect.forEach([...context.commandFibers], Fiber.interrupt, { discard: true });

        const parentAbortOutcome = yield* Effect.raceFirst(
          runOpenCodeSdk("session.abort", (signal) =>
            context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
          ).pipe(
            Effect.asVoid,
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode session abort did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Effect.raceFirst(
            Deferred.await(cancellation.acknowledgment).pipe(
              Effect.map(() => ({ source: "acknowledgment" as const })),
            ),
            Deferred.await(cancellation.completion).pipe(
              Effect.exit,
              Effect.map((exit) => ({ source: "completion" as const, exit })),
            ),
          ),
        );
        if (parentAbortOutcome.source === "completion") {
          return Exit.isFailure(parentAbortOutcome.exit)
            ? yield* Effect.failCause(parentAbortOutcome.exit.cause)
            : undefined;
        }
        const parentAbortExit =
          parentAbortOutcome.source === "request" ? parentAbortOutcome.exit : Exit.void;

        const descendantAbortOutcome = yield* Effect.raceFirst(
          abortOpenCodeDescendants(context).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode child session cleanup did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Deferred.await(cancellation.completion).pipe(
            Effect.exit,
            Effect.map((exit) => ({ source: "completion" as const, exit })),
          ),
        );
        if (descendantAbortOutcome.source === "completion") {
          return Exit.isFailure(descendantAbortOutcome.exit)
            ? yield* Effect.failCause(descendantAbortOutcome.exit.cause)
            : undefined;
        }

        const parentAbortFailed = Exit.isFailure(parentAbortExit) && !cancellation.acknowledged;
        const failedExit = parentAbortFailed
          ? parentAbortExit
          : Exit.isFailure(descendantAbortOutcome.exit)
            ? descendantAbortOutcome.exit
            : undefined;
        if (failedExit !== undefined && Exit.isFailure(failedExit)) {
          if (context.cancellation === cancellation) {
            context.cancellation = undefined;
            if (
              parentAbortFailed &&
              cancellation.turnId !== undefined &&
              cancellation.deferredIdleEvent
            ) {
              yield* scheduleIdleReconciliation(
                context,
                cancellation.turnId,
                cancellation.deferredIdleEvent,
              );
            }
          }
          yield* Deferred.done(cancellation.completion, failedExit).pipe(Effect.ignore);
          return yield* Effect.failCause(failedExit.cause);
        }

        if (context.cancellation === cancellation) {
          if (cancellation.turnSettled) {
            context.cancellation = undefined;
          } else if (cancellation.turnId !== undefined) {
            yield* interruptOpenCodeTurn(context, cancellation.turnId);
          } else {
            context.cancellation = undefined;
            context.reconcileIdleStatus = true;
            yield* clearPendingOpenCodeRequests(context, { type: "session.abort" });
          }
        }
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingPermissions.get(requestId);
      if (!request) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail:
            context.pendingRequestRecovery || context.requestRelationRetries.has(requestId)
              ? "OpenCode is still loading this permission request. Try again."
              : `Unknown pending permission request: ${requestId}`,
        });
      }

      const reply = toOpenCodePermissionReply(decision);
      yield* runOpenCodeSdk("permission.reply", (signal) =>
        context.client.permission.reply(
          {
            requestID: requestId,
            reply,
          },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "permission.reply",
                detail: "OpenCode permission reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolvePendingOpenCodeRequest(context, requestId);
      yield* emitTerminalOpenCodeRequest(
        context,
        {
          id: `reply:${requestId}`,
          type: "permission.replied",
          properties: { sessionID: request.sessionID, requestID: requestId, reply },
        },
        { type: "permission.reply", requestID: requestId, reply },
      );
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail:
            context.pendingRequestRecovery || context.requestRelationRetries.has(requestId)
              ? "OpenCode is still loading this question. Try again."
              : `Unknown pending user-input request: ${requestId}`,
        });
      }

      const questionAnswers = toOpenCodeQuestionAnswers(request, answers);
      yield* runOpenCodeSdk("question.reply", (signal) =>
        context.client.question.reply(
          {
            requestID: requestId,
            answers: questionAnswers,
          },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "question.reply",
                detail: "OpenCode question reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolvePendingOpenCodeRequest(context, requestId);
      yield* emitTerminalOpenCodeRequest(
        context,
        {
          id: `reply:${requestId}`,
          type: "question.replied",
          properties: {
            sessionID: request.sessionID,
            requestID: requestId,
            answers: questionAnswers,
          },
        },
        { type: "question.reply", requestID: requestId },
      );
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const session = yield* runOpenCodeSdk("session.get", () =>
          context.client.session.get({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.id === session.data?.revert?.messageID) break;
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const snapshot = yield* readThread(threadId);
        const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
        const target = snapshot.turns[targetIndex];
        if (target) {
          const messages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({ sessionID: context.openCodeSessionId }),
          ).pipe(Effect.mapError(toRequestError));
          const entries = messages.data ?? [];
          const targetMessageIndex = entries.findIndex((entry) => entry.info.id === target.id);
          if (targetMessageIndex < 0) {
            return yield* toRequestError(
              new OpenCodeRuntimeError({
                operation: "session.fork",
                detail: "The OpenCode rewind boundary is no longer available.",
              }),
            );
          }
          const firstRemovedMessage =
            entries
              .slice(0, targetMessageIndex + 1)
              .findLast((entry) => entry.info.role === "user") ?? entries[targetMessageIndex]!;
          // Native revert also rewrites workspace files. Fork only the retained
          // conversation so T3 alone decides whether filesystem changes survive.
          const fork = yield* runOpenCodeSdk("session.fork", () =>
            context.client.session.fork({
              sessionID: context.openCodeSessionId,
              messageID: firstRemovedMessage.info.id,
              directory: context.directory,
            }),
          ).pipe(Effect.mapError(toRequestError));
          if (!fork.data) {
            return yield* toRequestError(
              new OpenCodeRuntimeError({
                operation: "session.fork",
                detail: "OpenCode session.fork returned no session payload.",
              }),
            );
          }
          const forkedSessionId = fork.data.id;
          const forkMessages = yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({ sessionID: forkedSessionId }),
          ).pipe(Effect.mapError(toRequestError));
          if (forkMessages.data?.length !== entries.indexOf(firstRemovedMessage)) {
            return yield* toRequestError(
              new OpenCodeRuntimeError({
                operation: "session.fork",
                detail: "OpenCode did not preserve the requested rewind boundary.",
              }),
            );
          }
          yield* runOpenCodeSdk("session.update", () =>
            context.client.session.update({
              sessionID: forkedSessionId,
              permission: buildOpenCodePermissionRules(context.session.runtimeMode),
            }),
          ).pipe(Effect.mapError(toRequestError));
          yield* clearPendingOpenCodeRequests(context, { type: "session.fork" });
          context.openCodeSessionId = forkedSessionId;
          context.relatedSessionIds.clear();
          context.relatedSessionIds.add(forkedSessionId);
          context.messageRoleById.clear();
          context.textPartsByMessageId.clear();
          context.turnTokenUsage = undefined;
          context.activeTurnId = undefined;
          context.interruptedTurnId = undefined;
          context.reconcileIdleStatus = false;
          context.awaitingBusyAfterInterruption = false;
          context.pendingIdleReconciliation = undefined;
          context.session = {
            ...context.session,
            resumeCursor: { schemaVersion: OPENCODE_RESUME_VERSION, sessionId: forkedSessionId },
            updatedAt: yield* nowIso,
          };
          yield* emit({
            ...(yield* buildEventBase({ threadId })),
            type: "thread.started",
            payload: { providerThreadId: forkedSessionId },
          });
          return {
            threadId,
            turns: forkMessages.data
              .filter((entry) => entry.info.role === "assistant")
              .map((entry) => ({
                id: TurnId.make(entry.info.id),
                items: [entry.info, ...entry.parts],
              })),
          };
        }

        return snapshot;
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
