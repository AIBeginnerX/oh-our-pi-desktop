// @effect-diagnostics nodeBuiltinImport:off
import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type CanonicalItemType,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  isInterruptedResult,
  resultErrorsText,
  terminalResultError,
  toMessage,
} from "./ClaudeAdapter.results.ts";
import {
  type ClaudeSessionContext,
  type ClaudeTextStreamKind,
  type ClaudeToolResultStreamKind,
  PROVIDER,
  encodeJsonStringForDiagnostics,
} from "./ClaudeAdapter.state.ts";
import { decodeUnknownJsonStringExit } from "./ClaudeAdapter.history.ts";

/**
 * The CLI reports repeated 529 overload failures as a success-subtype result
 * with api_error_status 529 and an empty error list; the status code is the
 * only structured failure signal.
 */
export function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

/** Derives turn status and its error from the same provider result. */
export function resultOutcome(
  result: SDKResultMessage,
  failureHint?: string,
): {
  status: ProviderRuntimeTurnStatus;
  errorMessage: string | undefined;
} {
  // A success result flagged is_error only fails when the turn already
  // reported its cause (expired login, rejected usage window).
  const successTaggedFailure = result.subtype === "success" && result.is_error === true;
  const structuredError = isOverloadedResult(result)
    ? "Claude API is overloaded (529). Try again shortly."
    : (terminalResultError(result.terminal_reason, failureHint) ??
      (successTaggedFailure ? failureHint : undefined));
  // CLI diagnostic entries must not become the error banner. Success results
  // carry no typed error list, but a success-tagged failure may still list one.
  const listedErrors: ReadonlyArray<unknown> =
    "errors" in result && Array.isArray(result.errors) ? result.errors : [];
  const listedError =
    result.subtype === "success" && !successTaggedFailure
      ? undefined
      : listedErrors.find(
          (error): error is string =>
            typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
        );
  const errorMessage = listedError || structuredError;
  if (structuredError !== undefined) return { status: "failed", errorMessage };
  if (result.subtype === "success") return { status: "completed", errorMessage };
  if (isInterruptedResult(result)) return { status: "interrupted", errorMessage };
  return {
    status: resultErrorsText(result).includes("cancel") ? "cancelled" : "failed",
    errorMessage,
  };
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  // Claude never returns the raw chain of thought. A thinking delta is the
  // API-side summary (or a progress-update sentence) when display is
  // summarized; map it onto the summary stream so it shares the Codex/Grok
  // reasoning-summary path rather than looking like a raw trace we do not have.
  return deltaType.includes("thinking") ? "reasoning_summary_text" : "assistant_text";
}

export function shouldRequestClaudeThinkingSummaries(input: {
  readonly thinking: boolean | undefined;
  readonly thinkingDisplay: string | null | undefined;
}): boolean {
  return input.thinking !== false && input.thinkingDisplay !== "omitted";
}

export function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

export function extractAssistantContentBlocks(
  message: SDKMessage,
  blockType: "text" | "thinking",
  field: "text" | "thinking",
): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
    const value = field === "thinking" ? candidate.thinking : candidate.text;
    if (candidate.type === blockType && typeof value === "string" && value.length > 0) {
      fragments.push(value);
    }
  }

  return fragments;
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  return extractAssistantContentBlocks(message, "text", "text");
}

export function extractAssistantThinkingBlocks(message: SDKMessage): Array<string> {
  return extractAssistantContentBlocks(message, "thinking", "thinking");
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(result)) {
    return undefined;
  }
  const parsed = result.value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `${method} failed`,
    cause,
  });
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

// Discriminator/identity keys carry no human-readable content; everything else
// on an unmodeled SDK message is potentially worth surfacing in the work log.
export const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parent_uuid",
  "session_id",
  "parent_tool_use_id",
  "request_id",
]);

// Pull the salient scalar content out of a message the adapter doesn't model
// yet, so the work-log row shows what actually arrived (e.g. a notification's
// text) instead of an opaque "unhandled subtype" placeholder. Nested structures
// are left to the full payload retained in the event's `detail`.
export function previewUnknownSdkContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join(" · ");
  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined;
}

export function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);
  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}
