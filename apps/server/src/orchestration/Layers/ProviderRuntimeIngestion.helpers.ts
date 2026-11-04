import {
  ApprovalRequestId,
  MessageId,
  type OrchestrationEvent,
  classifyTaskAgentKind,
  EventId,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  OWNED_USAGE_ACTIVITY_KIND,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Predicate from "effect/Predicate";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import {
  type OwnedTurnUsageObservationV1,
  type OwnedUsageSourceV1,
} from "../../usage/ownedUsage.schema.ts";

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
// Suffixed, not prefixed: `clearTurnStateForSession` sweeps by thread prefix.
export const segmentStateKey = (threadId: ThreadId, turnId: TurnId, role: MessageStreamRole) =>
  role === "reasoning"
    ? `${providerTurnKey(threadId, turnId)}:reasoning`
    : providerTurnKey(threadId, turnId);
export const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
export function findTaskTitleInActivities(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

export interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
export const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
export const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
// Paragraphs that finish within this window after a delivery stay buffered
// and land together on the next one. Keeps fast models from repainting the
// message several times a second while still showing the first paragraph
// as soon as it is done.
export const MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400;
export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";
export const ASSISTANT_WRITE_FAULT =
  "Part of the assistant's response could not be saved, so the answer shown may be incomplete.";

/**
 * Session facts captured when a Claude event enters ingestion (null for other providers). A failed
 * assistant text write is judged against these and never against a later read, so a lifecycle
 * write made by the same event cannot change the verdict.
 */
export interface AssistantFaultContext {
  readonly activeTurnId: TurnId | null;
  readonly sessionStatus: OrchestrationSession["status"] | null;
  readonly runtimeMode: OrchestrationSession["runtimeMode"];
}

/** A Claude turn whose assistant text may have been lost, and whether its terminal was written. */
export interface AssistantWriteFault {
  readonly turnId: TurnId;
  terminalSeen: boolean;
}

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type ProviderDiffEvent = Extract<ProviderRuntimeEvent, { type: "turn.diff.updated" }>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      /** A diff whose workspace the diff worker confirmed is a Git repository. */
      source: "diff";
      event: ProviderDiffEvent;
    };

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

export function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
export const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
export const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
export const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
export const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
export const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

export function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

/**
 * Reasoning shares the assistant segmenting, buffering and finalization
 * machinery; only the message id namespace differs. The prefix is what tells a
 * buffered segment apart when it is flushed or finalized long after the delta
 * that opened it, so the role never has to be threaded through those paths.
 */
export type MessageStreamRole = "assistant" | "reasoning";

export const REASONING_MESSAGE_ID_PREFIX = "reasoning:";

export function messageStreamRoleOf(messageId: MessageId): MessageStreamRole {
  return messageId.startsWith(REASONING_MESSAGE_ID_PREFIX) ? "reasoning" : "assistant";
}

export function assistantSegmentMessageId(
  baseKey: string,
  segmentIndex: number,
  role: MessageStreamRole = "assistant",
): MessageId {
  const prefix = role === "reasoning" ? REASONING_MESSAGE_ID_PREFIX : "assistant:";
  return MessageId.make(
    segmentIndex === 0 ? `${prefix}${baseKey}` : `${prefix}${baseKey}:segment:${segmentIndex}`,
  );
}

/** A provider may stream a reasoning summary and the raw chain of thought over
 *  the same item. They are different texts, so they get different segments. */
export function reasoningSegmentBaseKeyFromEvent(
  event: ProviderRuntimeEvent,
  streamKind: "reasoning_text" | "reasoning_summary_text",
): string {
  const stream = streamKind === "reasoning_summary_text" ? "summary" : "raw";
  return `${stream}:${assistantSegmentBaseKeyFromEvent(event)}`;
}

export function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens < 0) {
    return undefined;
  }
  return event.payload.usage;
}

export function compactedTokenCountsFromActivities(
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload" | "sequence" | "createdAt">
  >,
): { readonly beforeTokens: number; readonly afterTokens: number } | undefined {
  const lastCompactionIndex = activities.findLastIndex(
    (activity) => activity.kind === "context-compaction",
  );
  const lastCompaction = activities[lastCompactionIndex];
  const activitiesSinceLastCompaction = activities.slice(lastCompactionIndex + 1);
  const usedTokens = activitiesSinceLastCompaction.flatMap((activity) => {
    if (activity.kind !== "context-window.updated") return [];
    if (lastCompaction !== undefined) {
      const isAfterLastCompaction =
        activity.sequence !== undefined && lastCompaction.sequence !== undefined
          ? activity.sequence > lastCompaction.sequence
          : activity.createdAt > lastCompaction.createdAt;
      if (!isAfterLastCompaction) return [];
    }
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    return Predicate.isNumber(payload?.usedTokens) && payload.usedTokens >= 0
      ? [payload.usedTokens]
      : [];
  });
  const beforeTokens = usedTokens.at(-2);
  const afterTokens = usedTokens.at(-1);
  if (beforeTokens === undefined || afterTokens === undefined || afterTokens >= beforeTokens) {
    return undefined;
  }
  return { beforeTokens, afterTokens };
}

export function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): ProviderRequestKind | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permission_approval":
      return "permission";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
export function taskLinkageActivityFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

/**
 * Provenance stamp for a persisted child usage row. `runtimeEventId` carries
 * the provider runtime event that delivered the frame so a source redelivery
 * is recognizable, and driver/instance come from the accepted event itself —
 * never re-read from later session state.
 */
export function ownedUsageSource(
  event: ProviderRuntimeEvent,
  phase: OwnedUsageSourceV1["phase"],
): OwnedUsageSourceV1 {
  return {
    v: 1,
    driver: event.provider,
    instanceId: event.providerInstanceId ?? null,
    runtimeEventId: event.eventId,
    phase,
  };
}

/**
 * Positively established provider conversation id for a terminal event. Today
 * only a Codex `turn/completed` notification carries its native thread id in
 * params; every other terminal leaves it unestablished (null) rather than
 * guessing from session state that may describe a different lifetime.
 */
export function nativeConversationIdFromEvent(event: ProviderRuntimeEvent): string | null {
  if (event.provider !== "codex" || event.raw?.method !== "turn/completed") {
    return null;
  }
  const payload = event.raw.payload;
  if (!Predicate.isObject(payload)) {
    return null;
  }
  const threadId = payload.threadId;
  if (typeof threadId !== "string") {
    return null;
  }
  const trimmed = threadId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : requestKind === "mcp-elicitation"
                    ? "App access approval requested"
                    : requestKind === "permission"
                      ? "App permission approval requested"
                      : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...(event.payload.appName ? { appName: event.payload.appName } : {}),
            ...(event.payload.options ? { options: event.payload.options } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.code ? { code: event.payload.code } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.completed":
    case "turn.aborted": {
      const tokenUsage = event.payload.tokenUsage;
      if (tokenUsage === undefined) {
        return [];
      }
      const turnId = toTurnId(event.turnId) ?? null;
      const observation: OwnedTurnUsageObservationV1 = {
        v: 1,
        scope: "main-turn",
        source: {
          driver: event.provider,
          instanceId: event.providerInstanceId ?? null,
          turnId,
          runtimeEventId: event.eventId,
          nativeConversationId: nativeConversationIdFromEvent(event),
        },
        terminal: event.type === "turn.completed" ? event.payload.state : "aborted",
        usage: tokenUsage,
        // Only providers that report a cost (Claude) carry one; it is never estimated.
        ...(event.type === "turn.completed" && event.payload.totalCostUsd !== undefined
          ? { costUsd: event.payload.totalCostUsd }
          : {}),
      };
      return [
        {
          // Unique per accepted delivery so a source redelivery lands in
          // retained event history instead of folding into the first row.
          id: EventId.make(`owned-usage:${event.threadId}:${event.eventId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: OWNED_USAGE_ACTIVITY_KIND,
          summary: "Turn usage observed",
          payload: observation,
          turnId,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            ...(event.payload.responseMode ? { responseMode: event.payload.responseMode } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                  usageSource: ownedUsageSource(event, "progress"),
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
            ...(event.payload.typedUsage !== undefined
              ? { usageSource: ownedUsageSource(event, "completed") }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      const beforeTokens = event.payload.beforeTokens;
      const afterTokens = event.payload.afterTokens;
      const summary =
        beforeTokens !== undefined && afterTokens !== undefined
          ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
          : "Context compacted";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary,
          payload: {
            state: event.payload.state,
            ...(beforeTokens !== undefined ? { beforeTokens } : {}),
            ...(afterTokens !== undefined ? { afterTokens } : {}),
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // A streaming update's `data` carries the full tool output accumulated
      // so far (adapters merge state forward), and a new activity is emitted
      // per chunk, so persisting `data` verbatim writes O(N²) bytes per tool
      // call into both the event store and the projection table. No reader
      // needs it: every client path applies `projectActivityPayload`, and the
      // server-side readers only use fields it keeps. All tool lifecycle
      // activities (`started`, `updated`, `completed`) therefore persist the
      // projected form.
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
      ];
    }

    default:
      break;
  }

  return [];
}
