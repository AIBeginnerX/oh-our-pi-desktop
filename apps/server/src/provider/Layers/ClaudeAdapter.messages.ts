// @effect-diagnostics nodeBuiltinImport:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type TaskRunHandles,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { claudeSignedOutMessage } from "../Drivers/ClaudeHome.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  type ClaudeSessionContext,
  PROVIDER,
  type ToolInFlight,
  rememberPendingTaskModel,
} from "./ClaudeAdapter.state.ts";
import {
  extractContentBlockText,
  extractExitPlanModePlan,
  nativeProviderRefs,
  resultOutcome,
  streamKindFromDeltaType,
  toolInputFingerprint,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
} from "./ClaudeAdapter.sdkMessages.ts";
import {
  agentIdForParentToolUse,
  applyClaudeTaskToolResult,
  asCanonicalTurnId,
  classifyToolItemType,
  extractPlanStepsFromTodoInput,
  isTodoTool,
  parseWorkflowProgress,
  readClaudeToolUseResult,
  sanitizeSessionUrl,
  summarizeToolRequest,
  titleForTool,
  trimmedString,
  workflowAgentStatus,
} from "./ClaudeAdapter.tasks.ts";
import { asRuntimeItemId, normalizeClaudeActiveTokenUsage } from "./ClaudeAdapter.results.ts";
import type { ClaudeRuntimeEmitters } from "./ClaudeAdapter.runtime.ts";

export interface makeClaudeMessageHandlersDeps {
  readonly path: Path.Path;
  readonly claudeEnvironment: NodeJS.ProcessEnv;
  readonly nowIso: Effect.Effect<string>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly backfillAssistantTextBlocksFromSnapshot: ClaudeRuntimeEmitters["backfillAssistantTextBlocksFromSnapshot"];
  readonly backfillThinkingFromSnapshot: ClaudeRuntimeEmitters["backfillThinkingFromSnapshot"];
  readonly completeAssistantTextBlock: ClaudeRuntimeEmitters["completeAssistantTextBlock"];
  readonly completeTurn: ClaudeRuntimeEmitters["completeTurn"];
  readonly emitClaudeTaskPlanUpdated: ClaudeRuntimeEmitters["emitClaudeTaskPlanUpdated"];
  readonly emitProposedPlanCompleted: ClaudeRuntimeEmitters["emitProposedPlanCompleted"];
  readonly emitReasoningSummaryDelta: ClaudeRuntimeEmitters["emitReasoningSummaryDelta"];
  readonly emitRuntimeError: ClaudeRuntimeEmitters["emitRuntimeError"];
  readonly emitThreadTokenUsage: ClaudeRuntimeEmitters["emitThreadTokenUsage"];
  readonly ensureAssistantTextBlock: ClaudeRuntimeEmitters["ensureAssistantTextBlock"];
  readonly updateResumeCursor: ClaudeRuntimeEmitters["updateResumeCursor"];
}

export const makeClaudeMessageHandlers = (deps: makeClaudeMessageHandlersDeps) => {
  const {
    path,
    claudeEnvironment,
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    backfillAssistantTextBlocksFromSnapshot,
    backfillThinkingFromSnapshot,
    completeAssistantTextBlock,
    completeTurn,
    emitClaudeTaskPlanUpdated,
    emitProposedPlanCompleted,
    emitReasoningSummaryDelta,
    emitRuntimeError,
    emitThreadTokenUsage,
    ensureAssistantTextBlock,
    updateResumeCursor,
  } = deps;

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    // Subagent-owned stream traffic (parent_tool_use_id set) must not write
    // into the parent transcript: with forwardSubagentText off the SDK still
    // forwards subagent tool_use/tool_result blocks and their wrapping
    // text/thinking deltas, and emitting them interleaved N subagents'
    // narration into the chat (live-test finding). Their results reach the
    // UI via the task.* lifecycle; their tool blocks are attributed and
    // re-homed by the quiet-timeline filter.
    const streamParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (streamParentToolUseId !== null && streamParentToolUseId !== undefined) {
      // Drop only the subagent's narration (text/thinking); tool_use blocks
      // and their input_json_delta frames must flow so attributed tool items
      // keep their inputs (review finding: dropping deltas emptied inputs).
      const dropStart =
        event.type === "content_block_start" &&
        event.content_block.type !== "tool_use" &&
        event.content_block.type !== "server_tool_use" &&
        event.content_block.type !== "mcp_tool_use";
      const dropDelta =
        event.type === "content_block_delta" &&
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta");
      if (dropStart || dropDelta) {
        return;
      }
    }

    if (event.type === "message_start" && context.turnState && !streamParentToolUseId) {
      context.turnState.emittedThinkingText = false;
    }

    if (event.type === "message_delta") {
      if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
        return;
      }

      const snapshot = normalizeClaudeActiveTokenUsage(
        event.usage,
        context.lastKnownContextWindow,
        context.lastKnownTotalProcessedTokens,
      );
      yield* emitThreadTokenUsage(context, snapshot, {
        rawMethod: "claude/stream_event/message_delta",
        rawPayload: message,
      });
      return;
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        if (streamKind === "reasoning_summary_text") {
          yield* emitReasoningSummaryDelta(context, {
            delta: deltaText,
            contentIndex: event.index,
            rawMethod: "claude/stream_event/content_block_delta",
            rawPayload: message,
          });
          return;
        }
        const assistantBlockEntry = yield* ensureAssistantTextBlock(context, event.index);
        if (assistantBlockEntry?.block) {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const itemType = parsedInput
          ? classifyToolItemType(tool.toolName, parsedInput)
          : tool.itemType;
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          itemType,
          title: titleForTool(itemType),
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            ...(nextTool.agentId ? { agentId: nextTool.agentId } : {}),
            ...(nextTool.parentToolUseId ? { parentToolUseId: nextTool.parentToolUseId } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // Emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName)) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            });
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemType = classifyToolItemType(toolName, toolInput);
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      // Attribute tools that ran inside a subagent to their owning agent so
      // clients can re-home them out of the main timeline (quiet-timeline
      // guarantee): the SDK forwards subagent tool_use blocks tagged with the
      // spawning Task tool's id as parent_tool_use_id.
      const parentToolUseId =
        (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
      const owningAgentId = agentIdForParentToolUse(context.taskAgents, parentToolUseId);

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        ...(owningAgentId ? { agentId: owningAgentId } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolUseResult = readClaudeToolUseResult(message);
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      // The Workflow tool's result carries the run handles (runId, scriptPath,
      // transcriptDir, sessionUrl). Attach them to the workflow's task agent so
      // the next task.* payload advertises them to clients.
      if (!toolResult.isError && tool.toolName.toLowerCase() === "workflow" && toolUseResult) {
        const workflowTaskId = trimmedString(toolUseResult.taskId);
        if (workflowTaskId) {
          const runHandles: TaskRunHandles = {
            ...(trimmedString(toolUseResult.runId)
              ? { runId: trimmedString(toolUseResult.runId) }
              : {}),
            ...(trimmedString(toolUseResult.scriptPath)
              ? { scriptPath: trimmedString(toolUseResult.scriptPath) }
              : {}),
            ...(trimmedString(toolUseResult.transcriptDir)
              ? { transcriptDir: trimmedString(toolUseResult.transcriptDir) }
              : {}),
            ...(sanitizeSessionUrl(toolUseResult.sessionUrl)
              ? { sessionUrl: sanitizeSessionUrl(toolUseResult.sessionUrl) }
              : {}),
          };
          const existing = context.taskAgents.get(workflowTaskId);
          context.taskAgents.set(workflowTaskId, {
            taskId: workflowTaskId,
            toolUseId: existing?.toolUseId ?? tool.itemId,
            description: existing?.description,
            subagentType: existing?.subagentType,
            taskType: existing?.taskType ?? "local_workflow",
            workflowName: existing?.workflowName,
            skipTranscript: existing?.skipTranscript ?? false,
            runHandles,
            owningAgentId: existing?.owningAgentId,
            model: existing?.model,
            effort: existing?.effort,
          });
        }
      }

      if (
        !toolResult.isError &&
        applyClaudeTaskToolResult(context.claudeTasks, tool, toolUseResult)
      ) {
        yield* emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: "claude/user",
          rawPayload: message,
        });
      }

      context.inFlightTools.delete(index);
    }
  });

  // The CLI can deliver a tool's input only in the assistant snapshot, with no
  // input_json_delta frames, so the item would read "Bash: {}" until the tool finished.
  // Publish the input from the snapshot when no delta already did.
  const updateToolInputFromSnapshot = Effect.fn("updateToolInputFromSnapshot")(function* (
    context: ClaudeSessionContext,
    toolUseId: string,
    input: unknown,
    message: SDKMessage,
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const parsedInput = input as Record<string, unknown>;
    if (Object.keys(parsedInput).length === 0) return;
    const entry = Array.from(context.inFlightTools.entries()).find(
      ([, tool]) => tool.itemId === toolUseId,
    );
    if (!entry) return;
    const [index, tool] = entry;
    const fingerprint = toolInputFingerprint(parsedInput);
    if (!fingerprint || tool.lastEmittedInputFingerprint === fingerprint) return;

    const itemType = classifyToolItemType(tool.toolName, parsedInput);
    const detail = summarizeToolRequest(tool.toolName, parsedInput) ?? tool.detail;
    const nextTool: ToolInFlight = {
      ...tool,
      itemType,
      title: titleForTool(itemType),
      input: parsedInput,
      lastEmittedInputFingerprint: fingerprint,
      ...(detail ? { detail } : {}),
    };
    context.inFlightTools.set(index, nextTool);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      itemId: asRuntimeItemId(nextTool.itemId),
      payload: {
        itemType: nextTool.itemType,
        status: "inProgress",
        title: nextTool.title,
        ...(nextTool.detail ? { detail: nextTool.detail } : {}),
        ...(nextTool.agentId ? { agentId: nextTool.agentId } : {}),
        ...(nextTool.parentToolUseId ? { parentToolUseId: nextTool.parentToolUseId } : {}),
        data: { toolName: nextTool.toolName, input: nextTool.input },
      },
      providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
      raw: { source: "claude.sdk.message", method: "claude/assistant", payload: message },
    });
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Subagent-owned assistant snapshots (parent_tool_use_id set) are the
    // subagent's own conversation, not the parent's. Emitting them created
    // interleaved "Agent N done"-adjacent leak messages and spawned synthetic
    // turns per subagent completion (which also reset the Working timer).
    const assistantParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (assistantParentToolUseId !== null && assistantParentToolUseId !== undefined) {
      // The snapshot's message.model is the authoritative API model the
      // subagent actually ran on — refine the seeded launch-time value.
      const owningTaskId = agentIdForParentToolUse(context.taskAgents, assistantParentToolUseId);
      const snapshotModel = trimmedString(message.message.model);
      const owningAgent = owningTaskId ? context.taskAgents.get(owningTaskId) : undefined;
      if (snapshotModel) {
        if (owningAgent) {
          owningAgent.model = snapshotModel;
        } else {
          // The snapshot beat its task_started (or its tool_use_id was never
          // recorded): hold the model until the task registers.
          rememberPendingTaskModel(
            context.pendingTaskModels,
            assistantParentToolUseId,
            snapshotModel,
          );
        }
      }
      context.lastAssistantUuid = message.uuid;
      yield* updateResumeCursor(context);
      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* randomUUIDv4);
      const startedAt = yield* nowIso;
      context.turnStartMessageIds.push(message.uuid);
      context.turnState = {
        turnId,
        startedAt,
        synthetic: true,
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        latestAssistantUsage: undefined,
        compactedSinceLatestAssistantUsage: false,
        hasSubagents: false,
        backgroundAgentTaskIds: new Set(),
        heldResults: [],
        nextSyntheticAssistantBlockIndex: -1,
        authenticationFailureMessage: undefined,
        rejectedRateLimitTypes: new Set(),
        latestAssistantRateLimited: false,
        emittedThinkingText: false,
        thinkingSnapshotIds: new Set(),
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      yield* updateResumeCursor(context);
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type === "tool_use" && typeof toolUse.id === "string") {
          yield* updateToolInputFromSnapshot(context, toolUse.id, toolUse.input, message);
        }
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      // Limited retries may only carry an assistant error, without a new window
      // event. Later parent responses replace this evidence if the turn recovers.
      context.turnState.latestAssistantRateLimited = message.error === "rate_limit";
      // The CLI can report authentication failure before ending the turn as a
      // generic API error, so retain that evidence for the result fallback.
      if (message.error === "authentication_failed") {
        context.turnState.authenticationFailureMessage = claudeSignedOutMessage({
          configDir: claudeEnvironment.CLAUDE_CONFIG_DIR,
          cwd: path.resolve(context.session.cwd ?? "."),
        });
      }
      if (
        normalizeClaudeActiveTokenUsage(
          message.message.usage,
          context.lastKnownContextWindow,
          context.lastKnownTotalProcessedTokens,
        )
      ) {
        context.turnState.latestAssistantUsage = message.message.usage;
        context.turnState.compactedSinceLatestAssistantUsage = false;
      }
      yield* backfillThinkingFromSnapshot(context, message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const turn = context.turnState;
    const failureHint =
      turn?.authenticationFailureMessage ??
      (turn && (turn.rejectedRateLimitTypes.size > 0 || turn.latestAssistantRateLimited)
        ? "Claude usage limit reached. Send the message again once the limit resets."
        : undefined);
    const { status, errorMessage } = resultOutcome(message, failureHint);

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.", undefined, {
        target: turn,
      });
    }

    // The lead ended its reply while agents it started still run. A foreground
    // agent always ends first, so these run in the background, and the SDK
    // resumes the turn when they report. Completing it here would end the turn
    // with their work still out: checkpoints, audits, goals, and the client
    // would judge a turn that has not done its work yet.
    const runningAgents =
      turn === undefined
        ? []
        : Array.from(turn.backgroundAgentTaskIds).filter((taskId) =>
            context.liveTaskIds.has(taskId),
          );
    if (status === "completed" && runningAgents.length > 0 && turn !== undefined) {
      turn.heldResults.push(message);
      yield* Effect.logInfo("claude.turn.result-held-for-background-agents", {
        threadId: context.session.threadId,
        turnId: turn.turnId,
        runningAgents: runningAgents.length,
      });
      return;
    }

    // The turn this result arrived for, even if it is gone or replaced by the time
    // runtime.error is out: a newer turn is never completed with it.
    yield* completeTurn(context, status, errorMessage, message, { target: turn });
  });

  /**
   * Synthesizes per-member task.progress rows from the coordinator's
   * workflow_progress array. Member identity is the stable slot
   * `<coordinatorTaskId>:wf:<index>` (never the per-attempt agent id, which
   * changes on retry and would split one member into duplicate rows).
   * timelineBypass keeps these out of the parent chat; the Agents surface and
   * workflow card consume them.
   */
  const emitWorkflowMemberProgress = Effect.fn("emitWorkflowMemberProgress")(function* (
    context: ClaudeSessionContext,
    base: Omit<ProviderRuntimeEvent, "type" | "payload">,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>,
  ) {
    const progress = parseWorkflowProgress(
      (message as unknown as Record<string, unknown>).workflow_progress,
    );
    if (!progress) {
      return;
    }
    const coordinatorId = message.task_id;
    for (const entry of progress.agents) {
      const memberTaskId = `${coordinatorId}:wf:${entry.index}`;
      const status = workflowAgentStatus(entry);
      // Material-transition filter: the wire repeats every member each tick.
      // Emit only when something the client renders actually changed, so a
      // 100-agent fleet costs ~1 event per changed member instead of 100
      // per tick (review finding: unbounded event amplification).
      const fingerprint = [
        status,
        entry.label ?? "",
        entry.model ?? "",
        entry.lastToolName ?? "",
        entry.error ?? "",
        entry.tokens ?? "",
        entry.toolCalls ?? "",
        entry.phaseIndex ?? "",
        entry.phaseTitle ?? "",
        entry.attempt ?? "",
      ].join("\u001f");
      if (context.workflowMemberFingerprints.get(memberTaskId) === fingerprint) {
        continue;
      }
      context.workflowMemberFingerprints.set(memberTaskId, fingerprint);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...base,
        eventId: stamp.eventId,
        createdAt: stamp.createdAt,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(memberTaskId),
          description: entry.label ?? `agent ${entry.index}`,
          status,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.label ? { title: entry.label } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.lastToolName ? { lastToolName: entry.lastToolName } : {}),
          ...(entry.tokens !== undefined
            ? {
                typedUsage: {
                  totalTokens: entry.tokens,
                  ...(entry.toolCalls !== undefined ? { toolUses: entry.toolCalls } : {}),
                },
              }
            : {}),
          parentAgentId: coordinatorId,
          agentIndex: entry.index,
          ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
          ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
          ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
          timelineBypass: true,
        },
      });
    }
  });

  return {
    handleStreamEvent,
    handleUserMessage,
    updateToolInputFromSnapshot,
    handleAssistantMessage,
    handleResultMessage,
    emitWorkflowMemberProgress,
  };
};

export type ClaudeMessageHandlers = ReturnType<typeof makeClaudeMessageHandlers>;
