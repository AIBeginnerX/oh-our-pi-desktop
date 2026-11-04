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
import { type ClaudeScopedLimitNames, claudeRateLimitEventToUpdate } from "./claudeUsageLimits.ts";
import {
  classifyTaskAgentKind,
  EventId,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";
import { type ClaudeSessionContext, PROVIDER } from "./ClaudeAdapter.state.ts";
import {
  describeUnknownSdkMessage,
  nativeProviderRefs,
  sdkMessageType,
  sdkNativeMethod,
} from "./ClaudeAdapter.sdkMessages.ts";
import {
  CLAUDE_TASK_PATCH_STATUS,
  asCanonicalTurnId,
  normalizeTaskUsage,
  parseWorkflowProgress,
  taskLinkageFor,
  trimmedString,
} from "./ClaudeAdapter.tasks.ts";
import {
  compactBoundaryTokenUsageSnapshot,
  describeClaudeUsageLimit,
  normalizeClaudeTaskProgressTokenUsage,
} from "./ClaudeAdapter.results.ts";
import type { ClaudeRuntimeEmitters } from "./ClaudeAdapter.runtime.ts";
import type { ClaudeMessageHandlers } from "./ClaudeAdapter.messages.ts";

export interface makeClaudeSystemHandlersDeps {
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly logNativeSdkMessage: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly scopedLimitNames: Ref.Ref<ClaudeScopedLimitNames> | undefined;
  readonly emitRuntimeError: ClaudeRuntimeEmitters["emitRuntimeError"];
  readonly emitRuntimeWarning: ClaudeRuntimeEmitters["emitRuntimeWarning"];
  readonly emitThreadTokenUsage: ClaudeRuntimeEmitters["emitThreadTokenUsage"];
  readonly ensureThreadId: ClaudeRuntimeEmitters["ensureThreadId"];
  readonly emitWorkflowMemberProgress: ClaudeMessageHandlers["emitWorkflowMemberProgress"];
  readonly handleAssistantMessage: ClaudeMessageHandlers["handleAssistantMessage"];
  readonly handleResultMessage: ClaudeMessageHandlers["handleResultMessage"];
  readonly handleStreamEvent: ClaudeMessageHandlers["handleStreamEvent"];
  readonly handleUserMessage: ClaudeMessageHandlers["handleUserMessage"];
}

export const makeClaudeSystemHandlers = (deps: makeClaudeSystemHandlersDeps) => {
  const {
    makeEventStamp,
    offerRuntimeEvent,
    logNativeSdkMessage,
    scopedLimitNames,
    emitRuntimeError,
    emitRuntimeWarning,
    emitThreadTokenUsage,
    ensureThreadId,
    emitWorkflowMemberProgress,
    handleAssistantMessage,
    handleResultMessage,
    handleStreamEvent,
    handleUserMessage,
  } = deps;

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    // Undeclared-but-real subtypes (absent from the SDK's union, so they can't
    // be switch cases): consumed intentionally without emitting, otherwise
    // they fall through to the unknown-subtype warning and surface as spurious
    // error rows in client work logs. `vcs_state_changed`
    // ({kind: commit|push|rebase}) and `code_change_published`
    // ({provider, url, repo}) are informational CLI notices; the work log
    // already shows the underlying git/gh tool calls.
    switch (message.subtype as string) {
      case "vcs_state_changed":
      case "code_change_published":
        return;
    }

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary": {
        if (context.turnState) {
          context.turnState.latestAssistantUsage = undefined;
          context.turnState.compactedSinceLatestAssistantUsage = true;
        }
        const compactedUsage = compactBoundaryTokenUsageSnapshot(
          message as unknown as Record<string, unknown>,
          context.lastKnownContextWindow,
          context.lastKnownTotalProcessedTokens,
        );
        yield* emitThreadTokenUsage(context, compactedUsage, {
          rawMethod: "claude/system/compact_boundary",
          rawPayload: message,
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            ...(compactedUsage?.lastUsedTokens !== undefined
              ? { beforeTokens: compactedUsage.lastUsedTokens }
              : {}),
            ...(compactedUsage?.usedTokens !== undefined
              ? { afterTokens: compactedUsage.usedTokens }
              : {}),
            detail: message,
          },
        });
        return;
      }
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        // A task launched by a tool that itself ran inside a subagent (the
        // in-flight tool carries agentId from parent_tool_use_id) is
        // agent-internal: a subagent's background shell, not parent work.
        const launchingTool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (tool) => tool.itemId === message.tool_use_id,
            )
          : undefined;
        const owningAgentId = launchingTool?.agentId;
        if (
          context.turnState &&
          classifyTaskAgentKind({
            taskType: message.task_type,
            ...(owningAgentId ? { agentId: owningAgentId } : {}),
          }) === "agent"
        ) {
          context.turnState.hasSubagents = true;
          // A foreground agent blocks its spawning tool call, so only a background
          // one can outlive the lead's reply.
          if (!owningAgentId && message.is_backgrounded === true) {
            context.turnState.backgroundAgentTaskIds.add(message.task_id);
          }
        }
        // Model/effort: the Agent tool's input carries explicit overrides;
        // absent ones inherit the session's selection (SDK behavior).
        // Subagent assistant snapshots refine model with the authoritative API
        // id: one that already arrived is buffered and outranks the seed here,
        // later ones refine the record in place. AgentInput.effort may be a
        // named level or an integer.
        const launchInput = launchingTool?.input;
        const toolUseId = message.tool_use_id;
        const bufferedModel = toolUseId ? context.pendingTaskModels.get(toolUseId) : undefined;
        if (toolUseId) {
          context.pendingTaskModels.delete(toolUseId);
        }
        const model =
          bufferedModel ??
          trimmedString(launchInput?.model) ??
          trimmedString(context.session.model ?? undefined);
        const rawLaunchEffort = launchInput?.effort;
        const effort =
          trimmedString(rawLaunchEffort) ??
          (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort)
            ? String(rawLaunchEffort)
            : context.currentEffort);
        // Remember the agent identity so every later task.* payload for this
        // taskId is self-describing (identity must survive activity retention).
        context.taskAgents.set(message.task_id, {
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          description: message.description,
          subagentType: message.subagent_type,
          taskType: message.task_type,
          workflowName: message.workflow_name,
          skipTranscript: message.skip_transcript === true,
          runHandles: context.taskAgents.get(message.task_id)?.runHandles,
          owningAgentId,
          model,
          effort,
        });
        context.liveTaskIds.add(message.task_id);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
            ...(owningAgentId ? { agentId: owningAgentId } : {}),
            ...(message.description ? { title: message.description } : {}),
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_progress",
            rawPayload: message,
          },
        );
        const linkage = taskLinkageFor(context.taskAgents, message.task_id);
        const typedUsage = normalizeTaskUsage(message.usage);
        // Phases ride on the coordinator's ONE progress row per tick. A
        // separate phases-only row shared the stable ingestion activity id
        // with this full row, and the thinner upsert overwrote usage and
        // progress text (review finding).
        const workflowPhases = parseWorkflowProgress(
          (message as unknown as Record<string, unknown>).workflow_progress,
        )?.phases;
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(workflowPhases && workflowPhases.length > 0 ? { phases: workflowPhases } : {}),
            ...linkage,
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
          },
        });
        yield* emitWorkflowMemberProgress(context, base, message);
        return;
      }
      case "task_updated": {
        // Status patch (killed/paused/backgrounded/end_time/error) — main
        // previously dropped this on the floor, losing all transitions.
        const patch = message.patch;
        const status =
          patch.status !== undefined ? CLAUDE_TASK_PATCH_STATUS[patch.status] : undefined;
        if (status === "completed" || status === "failed" || status === "cancelled") {
          context.liveTaskIds.delete(message.task_id);
        }
        // A foreground agent the user or the CLI moved to the background.
        const movedAgent = context.taskAgents.get(message.task_id);
        if (
          patch.is_backgrounded === true &&
          context.turnState &&
          movedAgent &&
          !movedAgent.owningAgentId &&
          context.liveTaskIds.has(message.task_id) &&
          classifyTaskAgentKind({ taskType: movedAgent.taskType }) === "agent"
        ) {
          context.turnState.backgroundAgentTaskIds.add(message.task_id);
        }
        const endedAt =
          typeof patch.end_time === "number" && Number.isFinite(patch.end_time)
            ? DateTime.formatIso(DateTime.makeUnsafe(patch.end_time))
            : undefined;
        yield* offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(status ? { status } : {}),
            ...(patch.description ? { description: patch.description } : {}),
            ...(patch.error ? { error: patch.error } : {}),
            ...(endedAt ? { endedAt } : {}),
            ...(patch.is_backgrounded !== undefined
              ? { isBackgrounded: patch.is_backgrounded }
              : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        return;
      }
      case "task_notification": {
        context.liveTaskIds.delete(message.task_id);
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_notification",
            rawPayload: message,
          },
        );
        const typedUsage = normalizeTaskUsage(message.usage);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.output_file ? { outputFile: message.output_file } : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "thinking_tokens":
        return;
      case "api_retry":
        // Transport-level retry heartbeat. Surfacing each attempt as a
        // warning row spammed the work log (10 rows during a 502 storm);
        // the terminal result/error path reports the actual failure. Keep
        // the session visibly alive instead.
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: `api_retry:${message.attempt}/${message.max_retries}`,
          },
        });
        return;
      case "session_state_changed":
        // Authoritative turn-over signal from the CLI.
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state:
              message.state === "running"
                ? "running"
                : message.state === "requires_action"
                  ? "waiting"
                  : "ready",
            reason: `session_state:${message.state}`,
          },
        });
        return;
      case "notification":
        // User-facing CLI notification (e.g. context-limit warnings). Only
        // high-priority ones warrant a work-log row.
        if (message.priority === "high" || message.priority === "immediate") {
          yield* emitRuntimeWarning(context, message.text, message);
        }
        return;
      case "model_refusal_fallback":
        // A safety fallback switched the model mid-session (e.g. Fable 5
        // retried on Opus 4.8 after a flagged request). The CLI ships the
        // user-facing notice in `content`; surface it like high-priority
        // notifications so the rest of the session isn't silently served
        // by a different model.
        yield* emitRuntimeWarning(context, message.content, message);
        return;
      // Inner protocol/UX details with no T3 surface today — consumed
      // deliberately so they don't masquerade as unknown-subtype warnings.
      // `control_request_progress` is a liveness heartbeat for an
      // in-flight control request. `worker_shutting_down` is a Remote
      // Control worker notice; the session close path reports the outcome.
      case "local_command_output":
      case "plugin_install":
      case "commands_changed":
      case "memory_recall":
      case "elicitation_complete":
      case "control_request_progress":
      case "worker_shutting_down":
        return;
      case "background_tasks_changed": {
        // The full set of live background tasks. An agent missing from it has
        // ended even if its task_notification was lost, so it stops holding
        // the turn. The turn still ends only at a result: this level arrives
        // before the bookends, and the SDK's continuation must join the turn.
        // The task_* events stay the source of per-agent data. The SDK warns
        // against pairing the level with them; it only ever removes ids here,
        // so a mistimed level can at worst end the hold early.
        const turn = context.turnState;
        if (turn) {
          const live = new Set(message.tasks.map((task) => task.task_id));
          for (const taskId of turn.backgroundAgentTaskIds) {
            if (!live.has(taskId)) turn.backgroundAgentTaskIds.delete(taskId);
          }
        }
        return;
      }
      case "informational":
        // Transcript-level CLI notes. Only warnings (e.g. a Stop hook that
        // refused continuation) warrant a work-log row; info/notice/
        // suggestion levels are CLI chrome.
        if (message.level === "warning") {
          yield* emitRuntimeWarning(context, message.content, message);
        }
        return;
      case "model_refusal_no_fallback":
        // The API refused the request and no fallback model was available.
        // The terminal result reports the failed turn; this row carries the
        // refusal explanation the result's error list lacks.
        yield* emitRuntimeWarning(
          context,
          message.api_refusal_explanation?.trim() || message.content,
          message,
        );
        return;
      case "permission_denied":
        yield* offerRuntimeEvent({
          ...base,
          type: "tool.denied",
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        });
        return;
      case "mirror_error":
        yield* emitRuntimeError(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );
        return;
      default: {
        // Exhaustiveness guard: every subtype in the SDK's typed union is
        // handled above, so `message` narrows to never here — a new SDK
        // release adding a subtype fails this typecheck instead of silently
        // warning at runtime. The runtime fallback still catches undeclared
        // wire-only subtypes (like vcs_state_changed).
        message satisfies never;
        const unknownMessage = message as never as { subtype: string };
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${unknownMessage.subtype}'`, message),
          message,
        );
        return;
      }
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { taskId: RuntimeTaskId.make(message.task_id) } : {}),
          ...(message.parent_tool_use_id !== null
            ? { parentToolUseId: message.parent_tool_use_id }
            : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      const rateLimitInfo = message.rate_limit_info;
      if (!rateLimitInfo) return;
      const names = scopedLimitNames
        ? yield* Ref.get(scopedLimitNames)
        : { overageIncluded: undefined };
      const limits = claudeRateLimitEventToUpdate(rateLimitInfo, names);
      if (limits) {
        yield* offerRuntimeEvent({
          ...base,
          type: "account.rate-limits.updated",
          payload: { limits },
        });
      }
      // A rejected window parks the turn inside the SDK: no further messages
      // arrive and no result lands, so without a row the thread just spins.
      // Warnings (allowed_warning) still have headroom and stay quiet, an
      // account spending provisioned overage keeps running despite the reject,
      // and between turns there is no turn to report as paused.
      const overageAllowed =
        rateLimitInfo.overageStatus === "allowed" ||
        rateLimitInfo.overageStatus === "allowed_warning" ||
        rateLimitInfo.isUsingOverage === true ||
        rateLimitInfo.overageInUse === true;
      const blocked = rateLimitInfo.status === "rejected" && !overageAllowed;
      const limitType = rateLimitInfo.rateLimitType ?? "unknown";
      const limitKey = `${limitType}:${rateLimitInfo.resetsAt ?? "unknown"}`;
      if (context.turnState) {
        // Current blocking evidence is independent of whether its warning has
        // already been shown. A recovery can omit or advance the reset time;
        // its window type remains stable without clearing another window.
        if (blocked) context.turnState.rejectedRateLimitTypes.add(limitType);
        else if (
          rateLimitInfo.status === "allowed" ||
          rateLimitInfo.status === "allowed_warning" ||
          overageAllowed
        ) {
          context.turnState.rejectedRateLimitTypes.delete(limitType);
        }
      }
      if (blocked && context.turnState !== undefined) {
        // Tracked per turn as a set of limit identities, not as the rendered
        // row: a parked window re-fires while the remaining wait shrinks, and a
        // turn can park on more than one window, so a single slot would let an
        // interleaved repeat through. A new turn — including a synthetic one —
        // starts a fresh set and announces its pause again.
        const turnId = context.turnState.turnId;
        if (context.announcedUsageLimits?.turnId !== turnId) {
          context.announcedUsageLimits = { turnId, keys: new Set() };
        }
        if (!context.announcedUsageLimits.keys.has(limitKey)) {
          context.announcedUsageLimits.keys.add(limitKey);
          const notice = describeClaudeUsageLimit(
            rateLimitInfo,
            Date.parse(stamp.createdAt),
            names,
          );
          yield* emitRuntimeWarning(context, notice, rateLimitInfo);
        }
      }
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    // Wire-only command bookkeeping has no user-facing T3 lifecycle.
    if (sdkMessageType(message) === "command_lifecycle") {
      return;
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      // Composer prompt suggestions have no T3 surface; consumed deliberately.
      // `conversation_reset` announces a CLI-side conversation id swap
      // (e.g. /clear); T3 keeps its own thread identity and resume cursor.
      case "prompt_suggestion":
      case "conversation_reset":
        return;
      default: {
        // Exhaustiveness guard (see handleSystemMessage): new SDK top-level
        // message types fail typecheck here instead of warning at runtime.
        message satisfies never;
        const unknownMessage = message as never as { type: string };
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${unknownMessage.type}'`, message),
          message,
        );
        return;
      }
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      context.query,
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Claude runtime stream failed.",
          cause,
        }),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        handleSdkMessage(context, message).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Failed to process Claude runtime event.",
                cause,
              }),
          ),
        ),
      ),
    );

  return {
    handleSystemMessage,
    handleSdkTelemetryMessage,
    handleSdkMessage,
    runSdkStream,
  };
};

export type ClaudeSystemHandlers = ReturnType<typeof makeClaudeSystemHandlers>;
