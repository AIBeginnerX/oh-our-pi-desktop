import type { TurnTokenUsage } from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

const isPromptResponse = (value: Record<string, unknown>): boolean =>
  typeof value.stopReason === "string";

/** The ACP prompt response an adapter stored on its turn record: bare or under `result`. */
function responseOf(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  if (isPromptResponse(item)) return item;
  return isRecord(item.result) && isPromptResponse(item.result) ? item.result : undefined;
}

interface PromptTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  /** The agent reported both cache buckets, so the totals are the whole prompt. */
  readonly cacheSplit: boolean;
}

/**
 * One ACP prompt's unstable `PromptResponse.usage`: `inputTokens` excludes the
 * cache buckets, which are nullable. An agent that reports nothing omits the
 * field, and that stays undefined here rather than becoming zeros.
 */
function promptTokenUsageFromAcpUsage(usage: unknown): PromptTokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const acpInput = finiteNonNegativeInteger(usage.inputTokens);
  const outputTokens = finiteNonNegativeInteger(usage.outputTokens);
  if (acpInput === undefined && outputTokens === undefined) return undefined;
  const cachedRead = finiteNonNegativeInteger(usage.cachedReadTokens);
  const cachedWrite = finiteNonNegativeInteger(usage.cachedWriteTokens);
  const thoughtTokens = finiteNonNegativeInteger(usage.thoughtTokens);
  return {
    // OOP counts cache reads and writes in input; ACP keeps them separate.
    ...(acpInput !== undefined
      ? { inputTokens: acpInput + (cachedRead ?? 0) + (cachedWrite ?? 0) }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedRead !== undefined ? { cachedInputTokens: cachedRead } : {}),
    ...(cachedWrite !== undefined ? { cacheCreationTokens: cachedWrite } : {}),
    ...(thoughtTokens !== undefined && outputTokens !== undefined
      ? { reasoningTokens: Math.min(thoughtTokens, outputTokens) }
      : {}),
    cacheSplit: cachedRead !== undefined && cachedWrite !== undefined,
  };
}

export interface AcpTurnTokenUsageOptions {
  readonly hasSubagents: boolean;
  /** False for cancelled and failed turns: their totals may be cut short. */
  readonly completed: boolean;
}

/**
 * The `TurnTokenUsage` for one OOP turn from the ACP prompt responses that
 * merged into it — a steer supersedes the in-flight prompt, so one OOP turn can
 * resolve several ACP prompt turns. Their usage sums, and any prompt that
 * resolved without a report keeps the merged total a known lower bound
 * (`partial`). Returns undefined when no prompt reported usage, so the adapter
 * omits `tokenUsage` and ingestion records no `owned-usage` activity. The
 * result rides the single `turn.completed` event; streaming updates never
 * carry usage.
 */
export function acpTurnTokenUsageFromPromptResponses(
  responses: ReadonlyArray<unknown>,
  options: AcpTurnTokenUsageOptions,
): TurnTokenUsage | undefined {
  let reportedPrompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCachedInput = false;
  let sawCacheCreation = false;
  let sawReasoning = false;
  let everyPromptComplete = true;
  for (const item of responses) {
    const response = responseOf(item);
    if (response === undefined) continue;
    const part = promptTokenUsageFromAcpUsage(response.usage);
    if (part === undefined) {
      everyPromptComplete = false;
      continue;
    }
    reportedPrompts += 1;
    if (part.inputTokens !== undefined) {
      inputTokens += part.inputTokens;
      sawInput = true;
    }
    if (part.outputTokens !== undefined) {
      outputTokens += part.outputTokens;
      sawOutput = true;
    }
    if (part.cachedInputTokens !== undefined) {
      cachedInputTokens += part.cachedInputTokens;
      sawCachedInput = true;
    }
    if (part.cacheCreationTokens !== undefined) {
      cacheCreationTokens += part.cacheCreationTokens;
      sawCacheCreation = true;
    }
    if (part.reasoningTokens !== undefined) {
      reasoningTokens += part.reasoningTokens;
      sawReasoning = true;
    }
    if (!part.cacheSplit || part.inputTokens === undefined || part.outputTokens === undefined) {
      everyPromptComplete = false;
    }
  }
  if (reportedPrompts === 0) return undefined;
  const scope = {
    usageScope: "main_agent",
    hasSubagents: options.hasSubagents,
  } as const;
  if (options.completed && everyPromptComplete) {
    return {
      ...scope,
      usageStatus: "complete",
      inputTokens,
      outputTokens,
      ...(sawCachedInput ? { cachedInputTokens } : {}),
      ...(sawCacheCreation ? { cacheCreationTokens } : {}),
      ...(sawReasoning ? { reasoningTokens } : {}),
    };
  }
  return {
    ...scope,
    usageStatus: "partial",
    ...(sawInput ? { inputTokens } : {}),
    ...(sawOutput ? { outputTokens } : {}),
    ...(sawCachedInput ? { cachedInputTokens } : {}),
    ...(sawCacheCreation ? { cacheCreationTokens } : {}),
    ...(sawReasoning ? { reasoningTokens } : {}),
  };
}
