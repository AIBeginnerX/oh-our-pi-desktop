// @effect-diagnostics nodeBuiltinImport:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import {
  type AssistantTextBlockState,
  type ClaudeSessionContext,
  type ClaudeTurnState,
  PROVIDER,
} from "./ClaudeAdapter.state.ts";
import {
  exitPlanCaptureKey,
  extractAssistantTextBlocks,
  extractAssistantThinkingBlocks,
  nativeProviderRefs,
} from "./ClaudeAdapter.sdkMessages.ts";
import { asCanonicalTurnId, planStepsFromClaudeTasks } from "./ClaudeAdapter.tasks.ts";
import {
  asRuntimeItemId,
  claudeTotalProcessedTokens,
  claudeUsageInputTokens,
  claudeUsageOutputTokens,
  hasDurableClaudeSessionId,
  lastClaudeUsageIteration,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeActiveTokenUsage,
  normalizeClaudeTurnTokenUsage,
  withHeldResultUsage,
} from "./ClaudeAdapter.results.ts";

export interface makeClaudeRuntimeEmittersDeps {
  readonly nowIso: Effect.Effect<string>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
  readonly nextSessionGeneration: () => number;
}

export const makeClaudeRuntimeEmitters = (deps: makeClaudeRuntimeEmittersDeps) => {
  const {
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    runtimeEventQueue,
    nextSessionGeneration,
  } = deps;

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [] })),
    };
  });

  const resumeCursorOf = (context: ClaudeSessionContext) => ({
    threadId: context.session.threadId,
    ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
    ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
    turnCount: context.turnStartMessageIds.length,
    turnStartMessageIds: [...context.turnStartMessageIds],
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    if (!context.session.threadId) return;

    // Read before the copy: whatever another fiber wrote while the clock was
    // read must survive.
    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      resumeCursor: resumeCursorOf(context),
      updatedAt,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* randomUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const emitReasoningSummaryDelta = Effect.fn("emitReasoningSummaryDelta")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly delta: string;
      readonly contentIndex?: number;
      readonly rawMethod: string;
      readonly rawPayload: SDKMessage;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || input.delta.length === 0) {
      return;
    }
    turnState.emittedThinkingText = true;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "content.delta",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        streamKind: "reasoning_summary_text",
        delta: input.delta,
        ...(input.contentIndex !== undefined ? { contentIndex: input.contentIndex } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const backfillThinkingFromSnapshot = Effect.fn("backfillThinkingFromSnapshot")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const turnState = context.turnState;
    if (!turnState || message.type !== "assistant") {
      return;
    }
    const snapshotId = message.uuid;
    const alreadyEmitted =
      turnState.emittedThinkingText || turnState.thinkingSnapshotIds.has(snapshotId);
    turnState.thinkingSnapshotIds.add(snapshotId);
    turnState.emittedThinkingText = false;
    if (alreadyEmitted) {
      return;
    }

    for (const [index, delta] of extractAssistantThinkingBlocks(message).entries()) {
      yield* emitReasoningSummaryDelta(context, {
        delta,
        contentIndex: index,
        rawMethod: "claude/assistant/thinking",
        rawPayload: message,
      });
    }
    turnState.emittedThinkingText = false;
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    if (context.resumeSessionId !== nextThreadId) {
      context.resumeSessionId = nextThreadId;
      // A durable id change invalidates any earlier admission observation.
      context.generation = nextSessionGeneration();
    }
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
    options?: { readonly target: ClaudeTurnState | undefined },
  ) {
    if (cause !== undefined) {
      void cause;
    }
    // Omitted options look up the live turn; a given target, even undefined, is the
    // turn the caller already saw, so the error stays on it if another turn started.
    const turnState = options === undefined ? context.turnState : options.target;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitThreadTokenUsage = Effect.fn("emitThreadTokenUsage")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
      /** Report thread-level usage without borrowing whichever turn is live now. */
      readonly untargeted?: boolean;
    },
  ) {
    if (!usage) {
      return;
    }

    context.lastKnownTokenUsage = usage;
    context.lastKnownTotalProcessedTokens =
      usage.totalProcessedTokens ?? context.lastKnownTotalProcessedTokens;

    const turnState = options?.untargeted ? undefined : context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: turnState.turnId } : {}),
      payload: {
        usage,
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options.rawPayload,
            },
          }
        : {}),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitClaudeTaskPlanUpdated = Effect.fn("emitClaudeTaskPlanUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolUseId: string;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const plan = planStepsFromClaudeTasks(context.claudeTasks);
    if (plan.length === 0) {
      return;
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        explanation: "Claude Tasks",
        plan,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  /**
   * The thread usage a result reports, from the given turn's latest assistant
   * usage. Also records the result's context window and total processed tokens.
   * Takes the turn explicitly so a result joining a completion is computed from
   * the turn it belongs to, never from whatever turn is live later.
   */
  const resultUsageSnapshot = (
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState | undefined,
    result: SDKResultMessage | undefined,
  ): ThreadTokenUsageSnapshot | undefined => {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const accumulatedTotalProcessedTokens = claudeTotalProcessedTokens(result?.usage);
    if (accumulatedTotalProcessedTokens !== undefined) {
      context.lastKnownTotalProcessedTokens = accumulatedTotalProcessedTokens;
    }

    // Avoid getContextUsage because its token-count fallback can make extra model requests.
    const resultUsageRecord =
      result?.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
        ? (result.usage as Record<string, unknown>)
        : undefined;
    const hasResultUsageIteration =
      resultUsageRecord !== undefined && lastClaudeUsageIteration(resultUsageRecord) !== undefined;
    const resultHasActiveUsage =
      resultUsageRecord !== undefined &&
      (hasResultUsageIteration ||
        claudeUsageInputTokens(resultUsageRecord) + claudeUsageOutputTokens(resultUsageRecord) > 0);
    const resultTotalOnly =
      resultUsageRecord !== undefined &&
      !resultHasActiveUsage &&
      claudeTotalProcessedTokens(resultUsageRecord) !== undefined;
    const resultIterationSnapshot = resultUsageRecord
      ? normalizeClaudeActiveTokenUsage(
          resultUsageRecord,
          maxTokens,
          accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
        )
      : undefined;
    const latestAssistantSnapshot = normalizeClaudeActiveTokenUsage(
      turnState?.latestAssistantUsage,
      maxTokens,
      accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
    );
    const lastGoodUsage = context.lastKnownTokenUsage;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      latestAssistantSnapshot ??
      (turnState?.compactedSinceLatestAssistantUsage
        ? undefined
        : resultTotalOnly && lastGoodUsage
          ? {
              ...lastGoodUsage,
              ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
                ? { maxTokens }
                : {}),
              ...(typeof accumulatedTotalProcessedTokens === "number" &&
              Number.isFinite(accumulatedTotalProcessedTokens) &&
              accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
                ? {
                    totalProcessedTokens: accumulatedTotalProcessedTokens,
                  }
                : {}),
            }
          : resultIterationSnapshot) ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : undefined);

    return usageSnapshot;
  };

  const finishTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage: string | undefined,
    result: SDKResultMessage | undefined,
    // The turn this completion is for, decided by the caller and never read from
    // the context here: a turn that started meanwhile must not be completed.
    turnState: ClaudeTurnState | undefined,
  ) {
    const usageSnapshot = resultUsageSnapshot(context, turnState, result);

    if (!turnState) {
      yield* emitThreadTokenUsage(context, usageSnapshot, {
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
        untargeted: true,
      });

      // A result with no local turn is never a turn this adapter started:
      // real turns get turnState in sendTurn, and assistant messages that
      // arrive outside a turn auto-start a synthetic one. What lands here is
      // the resume handshake (system/init + result(num_turns: 0)), a late
      // result for a turn already completed locally (steer auto-close,
      // stream teardown), or a stream failure with no turn in flight. The
      // untargeted turn.completed this branch used to emit carried no turnId,
      // so ingestion could not attribute it — and whenever the projection had
      // no active turn (a pending turn start included) it flipped the session
      // lifecycle for a turn that never existed. Keep the usage emission,
      // drop the lifecycle event, and leave a tripwire so the upstream
      // trigger stays measurable in the field.
      yield* Effect.logInfo("claude.turn.result-without-active-turn", {
        threadId: context.session.threadId,
        status,
        numTurns: result?.num_turns,
        hasUsage: result?.usage !== undefined,
        ...(errorMessage ? { errorMessage } : {}),
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    // A takeover after an aborted attempt must not list the turn twice.
    if (context.turns.at(-1)?.id !== turnState.turnId) {
      context.turns.push({ id: turnState.turnId });
    }

    yield* emitThreadTokenUsage(context, usageSnapshot, {
      rawMethod: "claude/result",
      rawPayload: result ?? { status },
    });

    const stamp = yield* makeEventStamp();
    const updatedAt = yield* nowIso;
    // The completion, the clearing of the turn and the session state are one
    // synchronous step: this turn is published once or not at all, and a turn
    // that is no longer the live one is never ended or overwritten.
    const published = yield* Effect.sync(() => {
      if (context.turnState !== turnState) {
        return false;
      }
      // The lifecycle state is the owner's; a result that joined before this
      // step supplies the metadata the owner has no result for.
      const payloadResult = withHeldResultUsage(
        turnState.heldResults,
        result ?? turnState.joinedResult,
      );
      Queue.offerUnsafe(runtimeEventQueue, {
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state: status,
          ...(payloadResult?.stop_reason !== undefined
            ? { stopReason: payloadResult.stop_reason }
            : {}),
          ...(payloadResult?.usage ? { usage: payloadResult.usage } : {}),
          ...(payloadResult?.modelUsage ? { modelUsage: payloadResult.modelUsage } : {}),
          ...(typeof payloadResult?.total_cost_usd === "number"
            ? { totalCostUsd: payloadResult.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
          tokenUsage: normalizeClaudeTurnTokenUsage(payloadResult, turnState.hasSubagents, status),
        },
        providerRefs: nativeProviderRefs(context),
      });
      context.turnState = undefined;
      // A stopped session stays closed: Stop writes `closed` after its own take-over.
      context.session = {
        ...context.session,
        ...(context.stopped ? {} : { status: "ready" as const }),
        activeTurnId: undefined,
        updatedAt,
        ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
      };
      // Last: settling resumes its waiters inline, so they must see the whole commit.
      if (context.interruptedTurnSettled) {
        Deferred.doneUnsafe(context.interruptedTurnSettled, Effect.void);
      }
      return true;
    });
    if (published) {
      yield* updateResumeCursor(context);
    }
  });

  /**
   * Gives each turn one completing owner. The turn is the one the caller passes
   * as the target, or else whatever is live when the call runs, captured once
   * and kept across every wait. The owner marks the
   * session as completing, so a send admitted from then until the last step
   * waits for the end instead of steering into a turn that is over, and
   * publishes the turn in one step. A second completion of the same turn joins
   * the owner: it waits for the owner's attempt to end, then looks again, and
   * publishes the turn itself only if the owner was interrupted or failed
   * before doing so. A result given to the owner, or that joins before the owner
   * publishes, is kept on the turn and rides on the one turn.completed (its
   * usage, stop reason, model usage and cost) whichever fiber publishes it, and
   * its thread usage is reported once after the wait, from the captured turn
   * and without a turn id. A completion whose turn was already published does
   * nothing, or, for a result, emits only that thread usage.
   *
   * Taking the mark and registering the finalizer that settles it are
   * uninterruptible together, so no interrupt can leave the mark set with
   * nothing to clear it. The completion and a join's wait run in the caller's
   * interruptibility: interruptible for the stream and Stop, so neither is held
   * up, uninterruptible when the caller made it so.
   */
  const completeTurn = (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
    options?: { readonly target: ClaudeTurnState | undefined },
  ): ReturnType<typeof finishTurn> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        // Omitted options look up the live turn. A given target, even undefined, is
        // the turn the caller already saw: undefined means there was none.
        const turn = options === undefined ? context.turnState : options.target;
        const attempt = (): ReturnType<typeof finishTurn> =>
          Effect.suspend(() => {
            if (turn === undefined) {
              return restore(finishTurn(context, status, errorMessage, result, undefined));
            }
            if (context.turnState !== turn) {
              // No longer live: published by another fiber, possibly with this result's
              // metadata, or replaced by a newer turn. The result's thread usage is still
              // reported, from this turn and never the live one.
              return result === undefined
                ? Effect.void
                : restore(
                    Effect.suspend(() =>
                      emitThreadTokenUsage(context, resultUsageSnapshot(context, turn, result), {
                        rawMethod: "claude/result",
                        rawPayload: result,
                        untargeted: true,
                      }),
                    ),
                  );
            }
            const running = context.completing;
            if (running !== undefined) {
              if (result !== undefined) {
                turn.joinedResult ??= result;
              }
              return restore(Deferred.await(running)).pipe(Effect.flatMap(() => attempt()));
            }
            const completing = Deferred.makeUnsafe<void>();
            context.completing = completing;
            // Kept on the turn, so a takeover that has no result of its own (Stop
            // after an interrupted owner) still publishes this result's metadata.
            if (result !== undefined) {
              turn.joinedResult ??= result;
            }
            return restore(finishTurn(context, status, errorMessage, result, turn)).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  if (context.completing === completing) {
                    context.completing = undefined;
                  }
                  return Deferred.succeed(completing, undefined);
                }),
              ),
            );
          });
        return attempt();
      }),
    );

  return {
    snapshotThread,
    resumeCursorOf,
    updateResumeCursor,
    ensureAssistantTextBlock,
    createSyntheticAssistantTextBlock,
    completeAssistantTextBlock,
    backfillAssistantTextBlocksFromSnapshot,
    emitReasoningSummaryDelta,
    backfillThinkingFromSnapshot,
    ensureThreadId,
    emitRuntimeError,
    emitRuntimeWarning,
    emitThreadTokenUsage,
    emitProposedPlanCompleted,
    emitClaudeTaskPlanUpdated,
    resultUsageSnapshot,
    finishTurn,
    completeTurn,
  };
};

export type ClaudeRuntimeEmitters = ReturnType<typeof makeClaudeRuntimeEmitters>;
