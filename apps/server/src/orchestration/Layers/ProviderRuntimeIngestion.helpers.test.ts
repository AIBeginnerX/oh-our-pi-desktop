import type { TurnTokenUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROMPT_CACHE_REWRITE_SHARE_THRESHOLD,
  promptCacheWriteShare,
} from "./ProviderRuntimeIngestion.helpers.ts";

const completeUsage = (
  fields: { readonly inputTokens: number } & Partial<
    Pick<TurnTokenUsage, "cacheCreationTokens" | "cachedInputTokens">
  >,
): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: fields.inputTokens,
  outputTokens: 10,
  hasSubagents: false,
  ...(fields.cacheCreationTokens === undefined
    ? {}
    : { cacheCreationTokens: fields.cacheCreationTokens }),
  ...(fields.cachedInputTokens === undefined
    ? {}
    : { cachedInputTokens: fields.cachedInputTokens }),
});

describe("promptCacheWriteShare", () => {
  it("reports no share when the provider omitted the cache write count", () => {
    expect(promptCacheWriteShare(completeUsage({ inputTokens: 1_000 }))).toBeNull();
  });

  it("reports no share when the provider omitted the input total", () => {
    const usage = {
      usageScope: "main_agent",
      usageStatus: "partial",
      outputTokens: 10,
      hasSubagents: false,
      cacheCreationTokens: 40,
    } satisfies TurnTokenUsage;
    expect(promptCacheWriteShare(usage)).toBeNull();
  });

  it("reports no share when the turn reported no input tokens", () => {
    expect(
      promptCacheWriteShare(completeUsage({ inputTokens: 0, cacheCreationTokens: 0 })),
    ).toBeNull();
  });

  it("divides cache writes by the input total", () => {
    expect(
      promptCacheWriteShare(completeUsage({ inputTokens: 2_000, cacheCreationTokens: 500 })),
    ).toBe(0.25);
  });

  it("counts a cache read as input, so a cached turn stays below the rewrite threshold", () => {
    const share = promptCacheWriteShare(
      completeUsage({ inputTokens: 20_000, cacheCreationTokens: 100, cachedInputTokens: 19_900 }),
    );
    expect(share).toBeCloseTo(0.005);
    expect(share).not.toBeNull();
    expect(share! < PROMPT_CACHE_REWRITE_SHARE_THRESHOLD).toBe(true);
  });

  it("flags a share exactly at the rewrite threshold", () => {
    const usage = completeUsage({ inputTokens: 1_000, cacheCreationTokens: 50 });
    const share = promptCacheWriteShare(usage);
    expect(share).toBe(PROMPT_CACHE_REWRITE_SHARE_THRESHOLD);
    expect(share! >= PROMPT_CACHE_REWRITE_SHARE_THRESHOLD).toBe(true);
  });

  it("leaves a share just below the rewrite threshold unflagged", () => {
    const share = promptCacheWriteShare(
      completeUsage({ inputTokens: 1_000, cacheCreationTokens: 49 }),
    );
    expect(share).toBe(0.049);
    expect(share! >= PROMPT_CACHE_REWRITE_SHARE_THRESHOLD).toBe(false);
  });
});
