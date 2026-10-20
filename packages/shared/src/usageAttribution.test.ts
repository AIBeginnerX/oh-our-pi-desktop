import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CODEX_CHILD_USAGE_NOTICE, codexChildUsageNotice } from "./usageAttribution.ts";
import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

// One source and at most one bucket per environment, with explicit paths and
// read times so ownership decisions come from the real merge, not the fixture.
function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "codex",
    model: "gpt-5.6-sol",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "unpriced",
    records: 5,
    unpricedRecords: 5,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  source: { provider: UsageProviderKind; hostId: string; homePath: string },
  options: {
    bucket?: UsageBucket;
    contractVersion?: number;
    readAt?: string;
  } = {},
): UsageSummary {
  return {
    contractVersion: options.contractVersion ?? USAGE_CONTRACT_VERSION,
    readAt: options.readAt ?? "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets: options.bucket === undefined ? [] : [options.bucket],
    sources: [
      {
        fingerprint: {
          hostId: source.hostId,
          provider: source.provider,
          resolvedHomePath: source.homePath,
          volumeId: `vol-${source.hostId}`,
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("codexChildUsageNotice", () => {
  it("uses the approved notice text verbatim", () => {
    expect(CODEX_CHILD_USAGE_NOTICE).toBe(
      "If these totals include Codex forks or subagents, their usage may be overcounted or undercounted.",
    );
  });

  it("is null for empty merged input", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.providers).toEqual([]);
    expect(codexChildUsageNotice(merged)).toBeNull();
  });

  it("is null when only Claude records contributed", () => {
    const claudeHome = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/mac/.claude",
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(claudeHome, {
            bucket: bucket({
              provider: "claude",
              sourcePath: claudeHome.homePath,
              costUsd: 10,
              costSource: "modelPriced",
              unpricedRecords: 0,
            }),
          }),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["claude"]);
    expect(codexChildUsageNotice(merged)).toBeNull();
  });

  it("warns for unpriced Codex records on an older compatible contract", () => {
    const codexHome = { provider: "codex" as const, hostId: "mac", homePath: "/home/mac/.codex" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(codexHome, {
            bucket: bucket({ sourcePath: codexHome.homePath }),
            contractVersion: USAGE_CONTRACT_VERSION - 1,
          }),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.contractMismatches).toEqual([]);
    expect(merged.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      records: 5,
      costUsd: 0,
      unpricedShare: 1,
    });
    expect(codexChildUsageNotice(merged)).toBe(CODEX_CHILD_USAGE_NOTICE);
  });

  it("stays null when a newer scan owns the fingerprint without buckets", () => {
    // The newer summary claims the physical directory, so the older bucket is
    // a duplicate: a sessions-only Codex entry survives with zero records.
    const codexHome = { provider: "codex" as const, hostId: "mac", homePath: "/home/mac/.codex" };
    const merged = mergeUsage(
      [
        environment("newer", summary(codexHome, { readAt: "2026-08-07T01:00:00.000Z" })),
        environment(
          "older",
          summary(codexHome, { bucket: bucket({ sourcePath: codexHome.homePath }) }),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      records: 0,
      sessions: 1,
    });
    expect(merged.records).toBe(0);
    expect(codexChildUsageNotice(merged)).toBeNull();
  });

  it("warns when the same-fingerprint scan with the Codex bucket wins ownership", () => {
    const codexHome = { provider: "codex" as const, hostId: "mac", homePath: "/home/mac/.codex" };
    const merged = mergeUsage(
      [
        environment(
          "bucket-owner",
          summary(codexHome, {
            bucket: bucket({ sourcePath: codexHome.homePath }),
            readAt: "2026-08-07T01:00:00.000Z",
          }),
        ),
        environment("bucket-loser", summary(codexHome)),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      records: 5,
      totalTokens: 1160,
      costUsd: 0,
    });
    expect(codexChildUsageNotice(merged)).toBe(CODEX_CHILD_USAGE_NOTICE);
  });

  it("is null for an incompatible-contract Codex-only summary", () => {
    const codexHome = { provider: "codex" as const, hostId: "mac", homePath: "/home/mac/.codex" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(codexHome, {
            bucket: bucket({ sourcePath: codexHome.homePath }),
            contractVersion: USAGE_CONTRACT_VERSION + 1,
          }),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.providers).toEqual([]);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
    expect(codexChildUsageNotice(merged)).toBeNull();
  });
});
