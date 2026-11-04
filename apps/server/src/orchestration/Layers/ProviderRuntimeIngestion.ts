import {
  CommandId,
  MessageId,
  OrchestrationProposedPlanId,
  CheckpointRef,
  PROVIDER_DIFF_CHECKPOINT_REF_PREFIX,
  EventId,
  isToolLifecycleItemType,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProjectId,
  type ProviderRuntimeEvent,
  type ResponseStreamingMode,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { makeMemoryEchoGuard } from "../memoryEcho.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { canReplaceThreadTitle } from "../threadTitles.ts";
export {
  splitBufferedAssistantText,
  runtimeEventToActivities,
} from "./ProviderRuntimeIngestion.helpers.ts";
import {
  providerTurnKey,
  segmentStateKey,
  providerTaskKey,
  findTaskTitleInActivities,
  type AssistantSegmentState,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
  TURN_MESSAGE_IDS_BY_TURN_TTL,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
  TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
  TASK_DESCRIPTION_BY_TASK_TTL,
  MAX_BUFFERED_ASSISTANT_CHARS,
  MIN_ASSISTANT_DELIVERY_INTERVAL_MS,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  ASSISTANT_WRITE_FAULT,
  type AssistantFaultContext,
  type AssistantWriteFault,
  type TurnStartRequestedDomainEvent,
  type ProviderDiffEvent,
  type RuntimeIngestionInput,
  toTurnId,
  sameId,
  hasCheckpointForTurn,
  maxCheckpointTurnCount,
  normalizeProposedPlanMarkdown,
  hasRenderableAssistantText,
  splitBufferedAssistantText,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  assistantSegmentBaseKeyFromEvent,
  type MessageStreamRole,
  messageStreamRoleOf,
  assistantSegmentMessageId,
  reasoningSegmentBaseKeyFromEvent,
  compactedTokenCountsFromActivities,
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  sessionStatusAllowsActiveTurn,
  runtimeEventToActivities,
} from "./ProviderRuntimeIngestion.helpers.ts";

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlans = yield* ProjectionThreadProposedPlanRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const memoryEchoGuard = yield* makeMemoryEchoGuard;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  // Epoch millis of the last early delivery per message, for pacing.
  const lastAssistantDeliveryAtByMessageId = yield* Cache.make<MessageId, number>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(0),
  });

  // When a thinking block opened, so "Thought for ..." measures the model's
  // time and not the moment buffered text happened to be flushed.
  const reasoningStartedAtByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  // Codex splits a reasoning trace into indexed parts, summary and raw alike.
  // The index is the only signal that one part ended and the next began, so the
  // blank line that keeps them readable has to be inserted here.
  const reasoningPartIndexByMessageId = yield* Cache.make<MessageId, number>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(-1),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadRuntimeContext = Effect.fn("resolveThreadRuntimeContext")(function* (
    threadId: ThreadId,
  ) {
    return yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const getThreadMessageById = Effect.fn("getThreadMessageById")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const message = yield* projectionThreadMessages.getByMessageId({ messageId });
    return Option.filter(message, (entry) => entry.threadId === threadId).pipe(
      Option.getOrUndefined,
    );
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) => Cache.getOption(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
    role: MessageStreamRole = "assistant",
  ) => Cache.set(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role), state);

  const clearAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) => Cache.invalidate(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role));

  const getActiveAssistantMessageIdForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) =>
    getAssistantSegmentStateForTurn(threadId, turnId, role).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
    role?: MessageStreamRole;
  }) => {
    const role = input.role ?? "assistant";
    return getAssistantSegmentStateForTurn(input.threadId, input.turnId, role).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0, role),
            }),
            onSome: (state) => {
              // Reasoning never resets the index on a new base key: one item can
              // stream a summary and a raw trace, and summary -> raw -> summary
              // would otherwise reuse the id of the first, finished block.
              const reuseIndex = state.baseKey === input.baseKey || role === "reasoning";
              const segmentIndex = reuseIndex ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex, role);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: reuseIndex ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState, role);
          return nextState.activeMessageId!;
        }),
      ),
    );
  };

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  /**
   * Unlike assistant text, reasoning has no reliable per-block item id on every
   * provider, so a turn's blocks can share a base key. Switching base key (a new
   * reasoning item, or summary vs raw) closes the open block instead of
   * appending to it.
   */
  const getOrCreateReasoningMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    baseKey: string;
    createdAt: string;
    turnId: TurnId;
  }) =>
    Effect.gen(function* () {
      const state = yield* getAssistantSegmentStateForTurn(
        input.threadId,
        input.turnId,
        "reasoning",
      );
      const activeMessageId = Option.flatMap(state, (entry) =>
        entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
      );
      if (Option.isSome(activeMessageId)) {
        if (Option.getOrUndefined(state)?.baseKey === input.baseKey) {
          return activeMessageId.value;
        }
        yield* finalizeActiveSegmentForTurn({
          event: input.event,
          faultContext: input.faultContext,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: "reasoning-complete-on-new-block",
          finalDeltaCommandTag: "reasoning-delta-finalize-on-new-block",
          hasProjectedMessage: false,
          role: "reasoning",
        });
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: input.baseKey,
        role: "reasoning",
      });
    });

  const resolveResponseStreamingMode = (projectId: ProjectId) =>
    Effect.map(
      serverSettingsService.getSettings,
      (settings) => resolveProjectSettings(settings, projectId).settings.responseStreamingMode,
    );

  // `mode` is "turn" or "paragraph"; token mode never buffers.
  const appendBufferedAssistantText = (
    messageId: MessageId,
    delta: string,
    mode: Exclude<ResponseStreamingMode, "token">,
    atMillis: number,
  ) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });

          // Paragraph mode delivers finished paragraphs and closed code blocks
          // early so the user sees progress without token-by-token repaints.
          // Turn mode holds everything until the turn finishes or pauses.
          const { ready, rest } =
            mode === "paragraph"
              ? splitBufferedAssistantText(nextText)
              : { ready: "", rest: nextText };
          const lastDeliveredAt = Option.getOrUndefined(
            yield* Cache.getOption(lastAssistantDeliveryAtByMessageId, messageId),
          );
          const paced =
            lastDeliveredAt === undefined ||
            atMillis - lastDeliveredAt >= MIN_ASSISTANT_DELIVERY_INTERVAL_MS;
          if (
            paced &&
            hasRenderableAssistantText(ready) &&
            rest.length <= MAX_BUFFERED_ASSISTANT_CHARS
          ) {
            if (rest.length > 0) {
              yield* Cache.set(bufferedAssistantTextByMessageId, messageId, rest);
            } else {
              yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
            }
            yield* Cache.set(lastAssistantDeliveryAtByMessageId, messageId, atMillis);
            return ready;
          }

          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.andThen(Cache.invalidate(lastAssistantDeliveryAtByMessageId, messageId)),
    );

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId).pipe(
      Effect.andThen(Cache.invalidate(reasoningPartIndexByMessageId, messageId)),
      Effect.andThen(Cache.invalidate(reasoningStartedAtByMessageId, messageId)),
    );

  const reasoningStartedAt = (messageId: MessageId, fallback: string) =>
    Cache.getOption(reasoningStartedAtByMessageId, messageId).pipe(
      Effect.map((started) => Option.getOrElse(started, () => fallback) || fallback),
    );

  // The Claude turn per thread whose assistant text may have been lost. Plain map, no TTL: a
  // record ends only when a different turn starts or the session exits, never at the faulted
  // turn's own terminal, so a duplicate of that terminal cannot settle the turn as completed.
  const faultByThread = new Map<ThreadId, AssistantWriteFault>();

  const markAssistantWriteFault = <E>(
    event: ProviderRuntimeEvent,
    faultContext: AssistantFaultContext,
    turnId: TurnId,
    cause: Cause.Cause<E>,
  ) =>
    Effect.gen(function* () {
      // The turn is the one that was active when the event entered, or none was active but Claude
      // is still streaming it: the session was set `starting` for a message steered into it, or
      // this fault is already recorded and its terminal not yet written. Any other active turn
      // makes the event stale; its failure is not a live answer's, so it propagates as before.
      const fault = faultByThread.get(event.threadId);
      const isLiveTurn =
        faultContext.activeTurnId === turnId ||
        (faultContext.activeTurnId === null &&
          (faultContext.sessionStatus === "starting" ||
            (fault?.turnId === turnId && !fault.terminalSeen)));
      // Once its terminal was written, late text cannot relabel a newer pending request.
      if ((fault?.turnId === turnId && fault.terminalSeen) || !isLiveTurn) {
        return yield* Effect.failCause(cause);
      }

      // Kept as is when the same fault reappears, so a seen terminal is not forgotten.
      if (fault?.turnId !== turnId) {
        faultByThread.set(event.threadId, { turnId, terminalSeen: false });
      }
      // The warning the outer handler would have logged had this failure not been swallowed.
      yield* Effect.logWarning("provider runtime ingestion failed to process event", {
        source: "runtime",
        eventId: event.eventId,
        eventType: event.type,
        threadId: event.threadId,
        turnId,
        cause: Cause.pretty(cause),
      });
      if (faultContext.sessionStatus === "error") {
        return;
      }
      // Best effort. If this write fails too, the record still keeps the turn from being settled
      // as completed. The captured active turn is kept, so the turn can still be stopped and its
      // own terminal is still accepted.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.set",
          commandId: yield* providerCommandId(event, "assistant-write-fault-session-set"),
          threadId: event.threadId,
          session: {
            threadId: event.threadId,
            status: "error",
            providerName: event.provider,
            ...(event.providerInstanceId !== undefined
              ? { providerInstanceId: event.providerInstanceId }
              : {}),
            runtimeMode: faultContext.runtimeMode,
            activeTurnId: faultContext.activeTurnId,
            lastError: ASSISTANT_WRITE_FAULT,
            updatedAt: event.createdAt,
          },
          createdAt: event.createdAt,
        })
        .pipe(
          Effect.catchCauseIf(
            (writeCause) => !Cause.hasInterrupts(writeCause),
            (writeCause) =>
              Effect.logWarning("provider runtime ingestion could not mark the turn failed", {
                eventId: event.eventId,
                threadId: event.threadId,
                turnId,
                cause: Cause.pretty(writeCause),
              }),
          ),
        );
    });

  /**
   * Dispatches a command that may carry assistant text and says whether it was written. When a
   * Claude assistant text delta of a live turn fails to be written, the answer may be incomplete:
   * the turn is marked as failed at once and the failure is swallowed (false) so the rest of the
   * event, including the terminal, still runs. Interrupts propagate. `faultContext` is null for
   * other providers and for dispatches made after the event's own lifecycle write; with reasoning
   * text, a missing turn and the `complete` command, the failure propagates as before.
   */
  const dispatchAssistantText = (
    event: ProviderRuntimeEvent,
    faultContext: AssistantFaultContext | null,
    command: OrchestrationCommand,
  ) => {
    const dispatch = orchestrationEngine.dispatch(command).pipe(Effect.as(true));
    if (
      faultContext === null ||
      command.type !== "thread.message.assistant.delta" ||
      command.turnId === undefined
    ) {
      return dispatch;
    }
    const turnId = command.turnId;
    return dispatch.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          markAssistantWriteFault(event, faultContext, turnId, cause).pipe(Effect.as(false)),
      ),
    );
  };

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      const isReasoning = messageStreamRoleOf(input.messageId) === "reasoning";
      return yield* dispatchAssistantText(input.event, input.faultContext, {
        type: isReasoning ? "thread.message.reasoning.delta" : "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: isReasoning
          ? yield* reasoningStartedAt(input.messageId, input.createdAt)
          : input.createdAt,
      });
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            faultContext: input.faultContext,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      const isReasoning = messageStreamRoleOf(input.messageId) === "reasoning";

      // A swallowed delta failure leaves nothing to complete unless the message already exists.
      const textWritten =
        hasRenderableText &&
        (yield* dispatchAssistantText(input.event, input.faultContext, {
          type: isReasoning ? "thread.message.reasoning.delta" : "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: isReasoning
            ? yield* reasoningStartedAt(input.messageId, input.createdAt)
            : input.createdAt,
        }));

      if (input.hasProjectedMessage || textWritten) {
        yield* orchestrationEngine.dispatch({
          type: isReasoning
            ? "thread.message.reasoning.complete"
            : "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
    role?: MessageStreamRole;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const role = input.role ?? "assistant";
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
        role,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      // A block whose deltas already reached the projection must still be
      // completed, or it stays flagged as streaming forever.
      const alreadyProjected =
        input.hasProjectedMessage ||
        (input.flushedMessageIds?.has(activeMessageId.value) ?? false) ||
        (role === "reasoning"
          ? (yield* getThreadMessageById(input.threadId, activeMessageId.value)) !== undefined
          : false);

      yield* finalizeAssistantMessage({
        event: input.event,
        faultContext: input.faultContext,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage: alreadyProjected,
        ...(input.fallbackText !== undefined ? { fallbackText: input.fallbackText } : {}),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      // The segment index is deliberately preserved: reasoning blocks in one
      // turn can share a base key, so resetting it would reopen a closed block.
      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId, role);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(
          input.threadId,
          input.turnId,
          { ...state.value, activeMessageId: null },
          role,
        );
      }
    });

  // Finalizes whatever the turn still holds open, assistant text and reasoning alike. It clears
  // the turn's ids when done, so a later pass over a finalized turn finds nothing to do.
  const finalizeAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    faultContext: AssistantFaultContext | null;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      // Persist assistant text before any projection read or completion marker can fail. The
      // terminal's later pass must not first attempt buffered text after the lifecycle settled.
      if (input.faultContext !== null) {
        yield* Effect.forEach(
          assistantMessageIds,
          (messageId) =>
            messageStreamRoleOf(messageId) === "reasoning"
              ? Effect.void
              : flushBufferedAssistantMessage({
                  event: input.event,
                  faultContext: input.faultContext,
                  threadId: input.threadId,
                  messageId,
                  turnId: input.turnId,
                  createdAt: input.createdAt,
                  commandTag: "assistant-delta-finalize-fallback",
                }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
      }
      yield* Effect.forEach(
        assistantMessageIds,
        (assistantMessageId) =>
          getThreadMessageById(input.threadId, assistantMessageId).pipe(
            Effect.flatMap((existingMessage) =>
              finalizeAssistantMessage({
                event: input.event,
                faultContext: input.faultContext,
                threadId: input.threadId,
                messageId: assistantMessageId,
                turnId: input.turnId,
                createdAt: input.createdAt,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: existingMessage !== undefined,
              }),
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* clearAssistantMessageIdsForTurn(input.threadId, input.turnId);
    });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = Option.getOrUndefined(
      yield* Cache.getOption(bufferedProposedPlanById, input.planId),
    );
    const planMarkdown =
      normalizeProposedPlanMarkdown(bufferedPlan?.text) ??
      normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    if (!planMarkdown) return yield* clearBufferedProposedPlan(input.planId);

    const existingPlan = Option.getOrUndefined(
      yield* projectionThreadProposedPlans.getByPlanId({
        threadId: input.threadId,
        planId: OrchestrationProposedPlanId.make(input.planId),
      }),
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        createdAt: existingPlan?.createdAt ?? (bufferedPlan?.createdAt || input.updatedAt),
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      faultByThread.delete(threadId);
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadRuntimeContext(sourceThreadId);
      const sourcePlan = Option.getOrUndefined(
        yield* projectionThreadProposedPlans.getByPlanId({
          threadId: sourceThreadId,
          planId: sourcePlanId,
        }),
      );
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThreadId,
        proposedPlan: {
          id: sourcePlan.planId,
          turnId: sourcePlan.turnId,
          planMarkdown: sourcePlan.planMarkdown,
          createdAt: sourcePlan.createdAt,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (input: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (
        input.type === "content.delta" &&
        input.payload.streamKind !== "assistant_text" &&
        input.payload.streamKind !== "reasoning_text" &&
        input.payload.streamKind !== "reasoning_summary_text"
      ) {
        return;
      }

      const event = yield* memoryEchoGuard(input);

      const thread = yield* resolveThreadRuntimeContext(event.threadId);
      if (!thread) return;

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const claude = event.provider === "claudeAgent";
      const faultContext: AssistantFaultContext | null = claude
        ? {
            activeTurnId,
            sessionStatus: thread.session?.status ?? null,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
          }
        : null;
      const isTerminalTurn = event.type === "turn.completed" || event.type === "turn.aborted";
      const isCompactedThreadState =
        event.type === "thread.state.changed" && event.payload.state === "compacted";
      const pendingTurnStart =
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        isTerminalTurn ||
        isCompactedThreadState
          ? yield* projectionTurnRepository.getPendingTurnStartByThreadId({
              threadId: thread.id,
            })
          : Option.none();
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      // A Claude turn ends only at its own named terminal, and a turn whose assistant text may
      // have been lost stays failed until a different turn starts. So for Claude, session events
      // that do not name the turn they end (whatever turn id they happen to carry) may not end or
      // relabel the active turn, and the faulted turn's start, or a terminal after its first, is
      // dropped. Suppression writes nothing: an error or stopped write would also delete a
      // pending next-turn start. These rules hold with the strict guard off too.
      const fault = faultByThread.get(thread.id);
      const faultTurn = fault?.turnId;
      const hasPendingStartRow = Option.isSome(pendingTurnStart);
      const endsSession =
        event.type === "session.state.changed" &&
        (event.payload.state === "error" || event.payload.state === "stopped");
      const suppressClaudeLifecycle =
        claude &&
        ((event.type === "turn.started" && sameId(faultTurn, eventTurnId)) ||
          (isTerminalTurn && fault?.terminalSeen === true && sameId(faultTurn, eventTurnId)) ||
          ((event.type === "session.state.changed" ||
            event.type === "session.started" ||
            event.type === "thread.started") &&
            !endsSession &&
            // Never while the faulted turn is active, nor after it until a new turn is pending.
            (sameId(faultTurn, activeTurnId) ||
              (faultTurn !== undefined && activeTurnId === null && !hasPendingStartRow) ||
              (activeTurnId !== null &&
                event.type === "session.state.changed" &&
                event.payload.state === "ready"))));

      // Non-Claude providers also emit ready while a turn is still running —
      // startup handshakes, Codex's Windows sandbox setup success. That ready
      // does not end the turn, so with a turn active and no start row pending,
      // only the session write is skipped: the active turn stays in place for
      // its real terminal. Checked before the guard bypass below so it also
      // holds with the strict guard off.
      const suppressNonClaudeReadyLifecycle =
        !claude &&
        event.type === "session.state.changed" &&
        event.payload.state === "ready" &&
        activeTurnId !== null &&
        !hasPendingStartRow;

      // The faulted turn's first terminal is always applied, even with no turn active (the session
      // was set `starting` for a steered message, which would otherwise stay stuck) and even for an
      // abort, which the guard below would reject then.
      const isFirstFaultedTerminal =
        claude &&
        isTerminalTurn &&
        fault?.terminalSeen === false &&
        sameId(faultTurn, eventTurnId) &&
        (activeTurnId === null || sameId(activeTurnId, eventTurnId));

      const shouldApplyThreadLifecycle = (() => {
        if (suppressClaudeLifecycle || suppressNonClaudeReadyLifecycle) {
          return false;
        }
        if (isFirstFaultedTerminal) {
          return true;
        }
        // A terminal for another turn must not settle the active turn, even in legacy mode.
        if (isTerminalTurn && conflictsWithActiveTurn) {
          return false;
        }
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // A named completion can recover a lost turn.started event.
            // An abort needs an active turn so a delayed stop cannot replace
            // a ready session or clear a newer pending start.
            return event.type === "turn.completed" && eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      // The lifecycle write below settles the turn, so a Claude terminal finalizes its assistant
      // text first: a failed write is then found, and the turn marked failed, before anything
      // could complete it. A failure here must not keep the turn from settling, as it did not
      // when this ran after the write; the pass further down retries what is left.
      if (claude && isTerminalTurn && eventTurnId !== undefined && shouldApplyThreadLifecycle) {
        yield* finalizeAssistantMessagesForTurn({
          event,
          faultContext,
          threadId: thread.id,
          turnId: eventTurnId,
          createdAt: now,
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logWarning("provider runtime ingestion failed to finalize assistant text", {
                eventId: event.eventId,
                eventType: event.type,
                cause: Cause.pretty(cause),
              }),
          ),
        );
      }

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        isTerminalTurn
      ) {
        // Read after the finalization above, which is where a fault is found.
        const completesFaultedTurn =
          event.type === "turn.completed" &&
          sameId(faultByThread.get(thread.id)?.turnId, eventTurnId);
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.aborted":
              return "interrupted";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed" ||
                completesFaultedTurn
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : isTerminalTurn || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : completesFaultedTurn
                ? ASSISTANT_WRITE_FAULT
                : status === "ready" || status === "interrupted"
                  ? null
                  : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
          // Only after the write succeeded: if it failed, a later duplicate terminal may still
          // settle the turn. An accepted start is never the faulted turn's (rejected above), so a
          // new turn has begun.
          if (event.type === "turn.started") {
            faultByThread.delete(thread.id);
          } else if (isTerminalTurn) {
            const written = faultByThread.get(thread.id);
            if (written !== undefined && sameId(written.turnId, eventTurnId)) {
              written.terminalSeen = true;
            }
          }
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const reasoningDelta =
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text")
          ? {
              streamKind: event.payload.streamKind,
              delta: event.payload.delta,
              summaryIndex: event.payload.summaryIndex,
              contentIndex: event.payload.contentIndex,
            }
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      const reasoningTurnId = toTurnId(event.turnId);
      // Every close path for a thinking block is keyed by turn. Without one the
      // block could never be completed, and a row stuck mid-thought is worse
      // than no row at all.
      if (reasoningDelta && reasoningDelta.delta.length > 0 && reasoningTurnId) {
        const turnId = reasoningTurnId;
        const reasoningMessageId = yield* getOrCreateReasoningMessageId({
          threadId: thread.id,
          event,
          faultContext,
          baseKey: reasoningSegmentBaseKeyFromEvent(event, reasoningDelta.streamKind),
          createdAt: now,
          turnId,
        });
        yield* rememberAssistantMessageId(thread.id, turnId, reasoningMessageId);

        if (
          Option.getOrElse(
            yield* Cache.getOption(reasoningStartedAtByMessageId, reasoningMessageId),
            () => "",
          ) === ""
        ) {
          yield* Cache.set(reasoningStartedAtByMessageId, reasoningMessageId, now);
        }

        let delta = reasoningDelta.delta;
        const partIndex = reasoningDelta.summaryIndex ?? reasoningDelta.contentIndex;
        if (partIndex !== undefined) {
          const lastIndex = Option.getOrElse(
            yield* Cache.getOption(reasoningPartIndexByMessageId, reasoningMessageId),
            () => -1,
          );
          if (lastIndex >= 0 && lastIndex !== partIndex) {
            delta = `\n\n${delta}`;
          }
          yield* Cache.set(reasoningPartIndexByMessageId, reasoningMessageId, partIndex);
        }

        // Reasoning is never delivered token by token, even when the project
        // asks for it: the block is collapsed by default, so a command, an
        // event-store write and a fan-out per token would buy nothing. Traces
        // are longer than the answers they precede.
        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        const reasoningMode = streamingMode === "token" ? "paragraph" : streamingMode;
        const spillChunk = yield* appendBufferedAssistantText(
          reasoningMessageId,
          delta,
          reasoningMode,
          yield* Clock.currentTimeMillis,
        );
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.reasoning.delta",
            commandId: yield* providerCommandId(event, "reasoning-delta-buffer-spill"),
            threadId: thread.id,
            messageId: reasoningMessageId,
            delta: spillChunk,
            turnId,
            createdAt: yield* reasoningStartedAt(reasoningMessageId, now),
          });
        }
      }

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        // Visible text ends the thinking block that preceded it, so the next
        // block does not swallow this answer.
        if (turnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            faultContext,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-assistant-text",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-assistant-text",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        if (streamingMode !== "token") {
          // Pace on the server clock. OpenCode stamps every delta of a part
          // with the part's start time, so the event time cannot measure gaps.
          const spillChunk = yield* appendBufferedAssistantText(
            assistantMessageId,
            assistantDelta,
            streamingMode,
            yield* Clock.currentTimeMillis,
          );
          if (spillChunk.length > 0) {
            yield* dispatchAssistantText(event, faultContext, {
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* dispatchAssistantText(event, faultContext, {
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" ||
        (event.type === "user-input.requested" && event.payload.responseMode !== "message")
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const hasProjectedMessage = yield* projectionThreadMessages.hasAssistantMessageForTurn({
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          streamingOnly: true,
        });
        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        const flushedMessageIds =
          streamingMode !== "token"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                faultContext,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveSegmentForTurn({
          event,
          faultContext,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag: "reasoning-complete-on-pause",
          finalDeltaCommandTag: "reasoning-delta-finalize-on-pause",
          hasProjectedMessage: false,
          role: "reasoning",
          flushedMessageIds,
        });
        yield* finalizeActiveSegmentForTurn({
          event,
          faultContext,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage,
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      // Tool work ends the thinking block that led to it. Without this a
      // provider that reuses one reasoning stream across a turn (Claude has no
      // per-block id) would append post-tool thinking to a block that already
      // sits above the tool row.
      if (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) {
        const toolTurnId = toTurnId(event.turnId);
        if (toolTurnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            faultContext,
            threadId: thread.id,
            turnId: toolTurnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-tool-start",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-tool-start",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
      }

      if (event.type === "item.completed" && event.payload.itemType === "reasoning") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const activeReasoningMessageId = yield* getActiveAssistantMessageIdForTurn(
            thread.id,
            turnId,
            "reasoning",
          );
          // The item detail is a whole-block snapshot, so it may only stand in
          // for deltas that never arrived. Appending it to a streamed block
          // would print the reasoning twice.
          const existingReasoningMessage = Option.isSome(activeReasoningMessageId)
            ? yield* getThreadMessageById(thread.id, activeReasoningMessageId.value)
            : undefined;
          const fallbackText =
            event.payload.detail !== undefined &&
            event.payload.detail.trim().length > 0 &&
            (existingReasoningMessage === undefined || existingReasoningMessage.text.length === 0)
              ? event.payload.detail
              : undefined;

          if (Option.isNone(activeReasoningMessageId)) {
            // Segment state outlives a closed block, so its presence means this
            // turn already streamed a trace and the snapshot would duplicate it.
            const turnAlreadyStreamedReasoning = Option.isSome(
              yield* getAssistantSegmentStateForTurn(thread.id, turnId, "reasoning"),
            );
            // A provider can report a whole block at once without streaming it.
            // The id is derived from the item rather than the segment counter so
            // a repeated completion rewrites that row instead of adding a copy.
            if (fallbackText !== undefined && !turnAlreadyStreamedReasoning) {
              const snapshotMessageId = assistantSegmentMessageId(
                `snapshot:${event.itemId ?? event.eventId}`,
                0,
                "reasoning",
              );
              const existingSnapshot = yield* getThreadMessageById(thread.id, snapshotMessageId);
              if (existingSnapshot === undefined) {
                yield* orchestrationEngine.dispatch({
                  type: "thread.message.reasoning.delta",
                  commandId: yield* providerCommandId(event, "reasoning-delta-snapshot"),
                  threadId: thread.id,
                  messageId: snapshotMessageId,
                  delta: fallbackText,
                  turnId,
                  createdAt: now,
                });
                yield* orchestrationEngine.dispatch({
                  type: "thread.message.reasoning.complete",
                  commandId: yield* providerCommandId(event, "reasoning-complete-snapshot"),
                  threadId: thread.id,
                  messageId: snapshotMessageId,
                  turnId,
                  createdAt: now,
                });
              }
            }
          } else {
            yield* finalizeActiveSegmentForTurn({
              event,
              faultContext,
              threadId: thread.id,
              turnId,
              createdAt: now,
              commandTag: "reasoning-complete",
              finalDeltaCommandTag: "reasoning-delta-finalize",
              hasProjectedMessage: existingReasoningMessage !== undefined,
              role: "reasoning",
              ...(fallbackText !== undefined ? { fallbackText } : {}),
            });
          }
        }
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            faultContext,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-assistant-completion",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-assistant-completion",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const [existingAssistantMessage, hasAssistantMessagesForTurn] = yield* Effect.all([
          getThreadMessageById(thread.id, assistantMessageId),
          turnId === undefined
            ? Effect.succeed(false)
            : projectionThreadMessages.hasAssistantMessageForTurn({
                threadId: thread.id,
                turnId,
                streamingOnly: false,
              }),
        ]);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            faultContext,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (isTerminalTurn) {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const userInputActivities =
            yield* projectionThreadActivityRepository.listUserInputLifecycleByThreadId({
              threadId: thread.id,
            });
          const pendingRequestIds = new Set<string>();
          for (const activity of userInputActivities) {
            const payload =
              typeof activity.payload === "object" && activity.payload !== null
                ? (activity.payload as Record<string, unknown>)
                : null;
            const requestId = payload?.requestId;
            if (typeof requestId !== "string") continue;
            if (
              activity.kind === "user-input.requested" &&
              activity.turnId === turnId &&
              payload?.responseMode !== "message"
            ) {
              pendingRequestIds.add(requestId);
            } else if (activity.kind === "user-input.resolved") {
              pendingRequestIds.delete(requestId);
            }
          }
          // A terminal turn cannot accept native callback answers. Message-mode
          // questions may outlive that turn and still accept a later user message.
          for (const requestId of pendingRequestIds) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: yield* providerCommandId(event, "terminal-user-input-resolved"),
              threadId: thread.id,
              activity: {
                id: EventId.make(`${event.eventId}:user-input-resolved:${requestId}`),
                createdAt: now,
                tone: "info",
                kind: "user-input.resolved",
                summary: "User input dismissed",
                payload: { requestId },
                turnId,
              },
              createdAt: now,
            });
          }
          // No fault context: for Claude this pass only retries what the earlier one left, after the
          // lifecycle write settled the turn, or finalizes a stale terminal's turn. Neither is a
          // live turn's answer.
          yield* finalizeAssistantMessagesForTurn({
            event,
            faultContext: null,
            threadId: thread.id,
            turnId,
            createdAt: now,
          });
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId, "reasoning");

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        if (thread.titleState?.source !== "manual" && canReplaceThreadTitle(thread.title)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.title.generate.complete",
            commandId: yield* providerCommandId(event, "thread-meta-update"),
            threadId: thread.id,
            title: event.payload.name,
            expectedTitle: thread.title,
            expectedVersion: thread.titleState?.version ?? null,
            needsRefinement: false,
          });
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (isTerminalTurn && shouldApplyThreadLifecycle) {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const taskActivity = yield* projectionThreadActivityRepository.getLatestTaskActivity({
            threadId: thread.id,
            taskId: event.payload.taskId,
          });
          taskTitle = findTaskTitleInActivities(
            Option.match(taskActivity, {
              onNone: () => undefined,
              onSome: (activity) => [activity],
            }),
            event.payload.taskId,
          );
        }
      }

      let activityEvent = event;
      if (
        isCompactedThreadState &&
        event.requestId === undefined &&
        Option.isSome(pendingTurnStart) &&
        thread.session?.status === "starting" &&
        activeTurnId === null &&
        sameId(thread.session.providerName, event.provider) &&
        sameId(thread.session.providerInstanceId, event.providerInstanceId) &&
        DateTime.isGreaterThanOrEqualTo(
          DateTime.makeUnsafe(event.createdAt),
          DateTime.makeUnsafe(pendingTurnStart.value.requestedAt),
        )
      ) {
        const pendingMessage = yield* getThreadMessageById(
          thread.id,
          pendingTurnStart.value.messageId,
        );
        if (
          pendingMessage?.role === "user" &&
          (pendingMessage.attachments?.length ?? 0) === 0 &&
          pendingMessage.text.trim().toLowerCase() === "/compact"
        ) {
          activityEvent = {
            ...event,
            requestId: RuntimeRequestId.make(String(pendingTurnStart.value.messageId)),
          };
        }
      }
      if (
        activityEvent.type === "thread.state.changed" &&
        activityEvent.payload.state === "compacted" &&
        (activityEvent.payload.beforeTokens === undefined ||
          activityEvent.payload.afterTokens === undefined)
      ) {
        const activities = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: thread.id,
          activityKinds: ["context-window.updated", "context-compaction"],
          // Preserve the previous thread-detail read's context-history bound.
          limit: 500,
        });
        const tokenCounts = compactedTokenCountsFromActivities(activities);
        if (tokenCounts) {
          activityEvent = {
            ...activityEvent,
            payload: {
              ...activityEvent.payload,
              beforeTokens: activityEvent.payload.beforeTokens ?? tokenCounts.beforeTokens,
              afterTokens: activityEvent.payload.afterTokens ?? tokenCounts.afterTokens,
            },
          };
        }
      }

      const activities = runtimeEventToActivities(activityEvent, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  // Records a mid-turn placeholder checkpoint for a provider diff. Runs on the
  // lifecycle worker, after repository detection, so the running-turn check
  // and the dispatch are ordered with the turn's terminal events: a diff that
  // resolved after turn.completed must not rewrite the settled turn's state or
  // move the latest-turn pointer back.
  const recordProviderDiff = Effect.fn("recordProviderDiff")(function* (event: ProviderDiffEvent) {
    const thread = yield* resolveThreadRuntimeContext(event.threadId);
    const turnId = toTurnId(event.turnId);
    if (!thread || !turnId) return;
    const turn = yield* projectionTurnRepository.getByTurnId({ threadId: thread.id, turnId });
    if (Option.isNone(turn) || turn.value.state !== "running") return;
    const checkpointContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(thread.id)
      .pipe(Effect.map(Option.getOrUndefined));
    // Skip if a checkpoint already exists for this turn. A real
    // (non-placeholder) capture from CheckpointReactor should not
    // be clobbered, and dispatching a duplicate placeholder for the
    // same turnId would produce an unstable checkpointTurnCount.
    if (!checkpointContext || hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) return;
    const now = event.createdAt;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
      threadId: thread.id,
      turnId,
      completedAt: now,
      checkpointRef: CheckpointRef.make(`${PROVIDER_DIFF_CHECKPOINT_REF_PREFIX}${event.eventId}`),
      status: "missing",
      files: [],
      assistantMessageId: MessageId.make(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      ),
      checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
      createdAt: now,
    });
  });

  const processInput = (input: RuntimeIngestionInput) => {
    switch (input.source) {
      case "runtime":
        return processRuntimeEvent(input.event);
      case "domain":
        return processDomainEvent(input.event);
      case "diff":
        return recordProviderDiff(input.event);
    }
  };

  const logIngestionFailure =
    (source: string, event: { readonly eventId: string; readonly type: string }) =>
    <E, R>(effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("provider runtime ingestion failed to process event", {
              source,
              eventId: event.eventId,
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
        ),
      );

  const worker = yield* makeDrainableWorker((input: RuntimeIngestionInput) =>
    processInput(input).pipe(logIngestionFailure(input.source, input.event)),
  );

  // Repository detection for a diff goes through VCS subprocesses, which can
  // stall behind slow or hung git. It runs on its own worker so a stuck diff
  // never delays the lifecycle worker; confirmed diffs are handed back to it.
  const detectProviderDiffRepository = Effect.fn("detectProviderDiffRepository")(function* (
    event: ProviderDiffEvent,
  ) {
    if (!toTurnId(event.turnId)) return;
    const checkpointContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(event.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const workspaceCwd = checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot;
    if (!workspaceCwd || !(yield* checkpointStore.isGitRepository(workspaceCwd))) return;
    yield* worker.enqueue({ source: "diff", event });
  });
  const diffWorker = yield* makeDrainableWorker((event: ProviderDiffEvent) =>
    detectProviderDiffRepository(event).pipe(logIngestionFailure("diff", event)),
  );

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) =>
          event.type === "turn.diff.updated"
            ? diffWorker.enqueue(event)
            : worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    // The diff worker feeds the lifecycle worker, so drain it first.
    drain: diffWorker.drain.pipe(Effect.andThen(worker.drain)),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
