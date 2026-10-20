import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isModelCostUnknown, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";
import { describeApiCost, describeMergedApiCost } from "./usageFormat.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const encodeSummary = Schema.encodeSync(UsageSummary);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("counts a Cursor account once across servers while retaining each server's other providers", () => {
    const account = {
      provider: "cursor" as const,
      hostId: "cursor.com",
      homePath: "cursor-account:account-hash",
      volumeId: "account-hash",
    };
    const merged = mergeUsage(
      [
        environment(
          "mac",
          summary([bucket({ provider: "cursor", sourcePath: account.homePath })], [account]),
        ),
        environment(
          "linux",
          summary(
            [
              bucket({ provider: "cursor", sourcePath: account.homePath }),
              bucket({ provider: "opencode", sourcePath: "/opencode" }),
            ],
            [account, { provider: "opencode", hostId: "linux", homePath: "/opencode" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(
      merged.providers.map((provider) => [provider.provider, provider.costUsd]).sort(),
    ).toEqual([
      ["cursor", 10],
      ["opencode", 10],
    ]);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("counts a shared transcript directory once", () => {
    // Two worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("counts overlapping provider roots once while keeping each environment's unique root", () => {
    const source = (homePath: string) => ({
      provider: "opencode" as const,
      hostId: "host",
      homePath,
    });
    const usage = (sourcePath: string, costUsd: number) =>
      bucket({ provider: "opencode", sourcePath, costUsd });
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([usage("/shared", 10), usage("/a", 2)], [source("/shared"), source("/a")]),
        ),
        environment(
          "env-b",
          summary([usage("/shared", 10), usage("/b", 3)], [source("/shared"), source("/b")]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.costUsd).toBe(15);
    expect(merged.sessions).toBe(3);
  });

  it("uses the newest scan when environments share the same transcript directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const environments = [
      environment("env-a", summary([bucket({ costUsd: 4, records: 2 })], [source])),
      environment("env-b", {
        ...summary([bucket()], [source]),
        readAt: "2026-08-07T01:00:00.000Z",
      }),
    ];

    for (const ordered of [environments, environments.toReversed()]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.records).toBe(5);
      expect(merged.sessions).toBe(1);
      expect(merged.contributingEnvironments).toEqual(["env-b"]);
      expect(merged.duplicateSources).toEqual(["env-a: /home/theo/.claude"]);
    }
  });

  it("prefers a complete scan over a newer partial scan of the same directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const incomplete = summary([bucket({ costUsd: 4, records: 2 })], [source]);
    const partial = environment("new", {
      ...incomplete,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: incomplete.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });
    const complete = environment("old", summary([bucket()], [source]));

    for (const ordered of [
      [partial, complete],
      [complete, partial],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.contributingEnvironments).toEqual(["old"]);
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }
    expect(mergeUsage([partial], USAGE_CONTRACT_VERSION).costUsd).toBe(4);
  });

  it("keeps new cells from a later partial scan without recounting older cells", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment(
      "old",
      summary([bucket()], [source], USAGE_MERGE_COMPATIBLE_SINCE),
    );
    const partialSummary = summary(
      [
        bucket({ sourcePath: source.homePath, costUsd: 4, records: 2 }),
        bucket({
          day: "2026-08-08" as UsageDay,
          sourcePath: source.homePath,
          costUsd: 3,
          records: 1,
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-08T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    for (const ordered of [
      [complete, partial],
      [partial, complete],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.records).toBe(6);
      expect(merged.sessions).toBe(2);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
      expect(merged.contributingEnvironments).toEqual(
        ordered.map(({ environmentId }) => environmentId),
      );
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }
  });

  it("retains a complete cell when a larger partial cell may have skipped old records", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment("old", summary([bucket()], [source]));
    const partialSummary = summary(
      [
        bucket({
          costUsd: 4,
          records: 6,
          totals: {
            uncachedInputTokens: 80,
            cachedInputTokens: 500,
            cacheCreationTokens: 10,
            outputTokens: 30,
            reasoningTokens: 0,
          },
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    const merged = mergeUsage([complete, partial], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.contributingEnvironments).toEqual(["old"]);
  });

  it("identifies an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-b",
        direction: "serverBehind",
        contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1,
      },
    ]);
  });

  it("identifies an environment reporting a newer contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(0);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("keeps known usage when newer providers and bucket variants cannot be decoded", () => {
    const known = summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const decoded = decodeSummary({
      ...known,
      buckets: [
        ...known.buckets,
        { ...bucket(), provider: "future-provider", costUsd: 100 },
        { ...bucket(), costSource: "future-pricing", costUsd: 200 },
      ],
      sources: [
        ...known.sources,
        {
          ...known.sources[0],
          fingerprint: {
            ...known.sources[0]?.fingerprint,
            provider: "future-provider",
          },
        },
      ],
    });
    expect(decoded).toEqual(known);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("normalizes model names during decoding before grouping usage", () => {
    const decoded = decodeSummary(
      summary(
        [
          bucket({ provider: "codex", model: " gpt-5 " }),
          bucket({ provider: "codex", model: "gpt-5" }),
        ],
        [{ provider: "codex", hostId: "mac", homePath: "/a" }],
      ),
    );

    expect(decoded.buckets.map((entry) => entry.model)).toEqual(["gpt-5", "gpt-5"]);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]).toMatchObject({ model: "gpt-5", costUsd: 20, totalTokens: 2320 });
  });

  it("keeps all supported providers when encoding a response", () => {
    const current = summary(
      [bucket(), bucket({ provider: "grok" })],
      [
        { provider: "claude", hostId: "mac", homePath: "/a" },
        { provider: "grok", hostId: "mac", homePath: "/b" },
      ],
    );
    expect(encodeSummary(current)).toEqual(current);
    expect(decodeSummary(encodeSummary(current))).toEqual(current);
  });

  it("still rejects a malformed summary envelope", () => {
    expect(() => decodeSummary({ ...summary([], []), buckets: null })).toThrow();
  });

  it("excludes a future incompatible contract even when its buckets still decode", () => {
    const decoded = decodeSummary(
      summary(
        [bucket()],
        [{ provider: "claude", hostId: "mac", homePath: "/a" }],
        USAGE_CONTRACT_VERSION + 1,
      ),
    );
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("attributes cached input without a coverage field by how its bucket was priced", () => {
    const quality = (...buckets: readonly UsageBucket[]) =>
      mergeUsage(
        [
          environment(
            "env-a",
            summary(buckets, [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
          ),
        ],
        USAGE_CONTRACT_VERSION,
      ).costQuality;

    // Savings were valued from a rate or a reported cost, so coverage is unknown.
    expect(quality(bucket())).toMatchObject({
      cacheSavingsUsd: 2,
      unvaluedCachedInputTokens: 0,
      unattributedCachedInputTokens: 1000,
    });
    expect(quality(bucket({ costSource: "providerReported" }))).toMatchObject({
      unvaluedCachedInputTokens: 0,
      unattributedCachedInputTokens: 1000,
    });
    // An unpriced bucket failed the rate lookup, so none of its savings were valued.
    expect(quality(bucket({ costSource: "unpriced", unpricedRecords: 5 }))).toMatchObject({
      unvaluedCachedInputTokens: 1000,
      unattributedCachedInputTokens: 0,
    });
    expect(
      quality(
        bucket({ unvaluedCachedInputTokens: 0 }),
        bucket({ day: "2026-08-08" as UsageDay, unvaluedCachedInputTokens: 300 }),
        bucket({ day: "2026-08-09" as UsageDay }),
      ),
    ).toMatchObject({ unvaluedCachedInputTokens: 300, unattributedCachedInputTokens: 1000 });
  });

  it("counts a shared transcript directory's unvalued cached input once", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket({ unvaluedCachedInputTokens: 300 })], [shared])),
        environment("env-b", summary([bucket({ unvaluedCachedInputTokens: 300 })], [shared])),
        environment("env-c", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costQuality.unvaluedCachedInputTokens).toBe(300);
    expect(merged.costQuality.unattributedCachedInputTokens).toBe(0);
    expect(merged.cachedInputTokens).toBe(1000);
  });

  it("adds only a supplemental cell's unvalued cached input from a later partial scan", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment(
      "old",
      summary([bucket({ unvaluedCachedInputTokens: 100 })], [source]),
    );
    const partialSummary = summary(
      [
        bucket({ sourcePath: source.homePath, unvaluedCachedInputTokens: 40 }),
        bucket({
          day: "2026-08-08" as UsageDay,
          sourcePath: source.homePath,
          unvaluedCachedInputTokens: 7,
        }),
      ],
      [source],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-08T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    for (const ordered of [
      [complete, partial],
      [partial, complete],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.cachedInputTokens).toBe(2000);
      expect(merged.costQuality.unvaluedCachedInputTokens).toBe(107);
      expect(merged.costQuality.unattributedCachedInputTokens).toBe(0);
    }
  });

  it("ignores cached input coverage from an environment excluded by contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ unvaluedCachedInputTokens: 50 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ unvaluedCachedInputTokens: 500 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
        environment(
          "env-c",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "win", homePath: "/c" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.cachedInputTokens).toBe(1000);
    expect(merged.costQuality.unvaluedCachedInputTokens).toBe(50);
    expect(merged.costQuality.unattributedCachedInputTokens).toBe(0);
  });

  it("decodes a bucket from an older server that omits unvalued cached input", () => {
    const decoded = decodeSummary(
      summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
    );

    expect(decoded.buckets).toHaveLength(1);
    expect(decoded.buckets[0]?.unvaluedCachedInputTokens).toBeUndefined();
  });

  it("decodes a bucket carrying a field this build does not know", () => {
    // Stands in for an older client receiving a newer server's additive field.
    const known = summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const decoded = decodeSummary({
      ...known,
      buckets: [{ ...bucket(), futureCoverageTokens: 7 }],
    });

    expect(decoded.buckets).toHaveLength(1);
    expect(decoded.buckets[0]).toMatchObject(bucket());
  });

  it("round-trips unvalued cached input, including zero", () => {
    const current = summary(
      [
        bucket({ unvaluedCachedInputTokens: 0 }),
        bucket({ day: "2026-08-08" as UsageDay, unvaluedCachedInputTokens: 300 }),
      ],
      [{ provider: "claude", hostId: "mac", homePath: "/a" }],
    );

    const decoded = decodeSummary(encodeSummary(current));
    expect(decoded).toEqual(current);
    expect(decoded.buckets.map((entry) => entry.unvaluedCachedInputTokens)).toEqual([0, 300]);
  });

  it("round-trips cache coverage counts, including omission", () => {
    const current = summary(
      [
        bucket({ cacheReadReportedRecords: 5, cacheWriteReportedRecords: 3 }),
        bucket({ day: "2026-08-08" as UsageDay }),
      ],
      [{ provider: "claude", hostId: "mac", homePath: "/a" }],
    );

    const decoded = decodeSummary(encodeSummary(current));
    expect(decoded).toEqual(current);
    expect(decoded.buckets[0]?.cacheReadReportedRecords).toBe(5);
    expect(decoded.buckets[0]?.cacheWriteReportedRecords).toBe(3);
    expect(decoded.buckets[1]?.cacheReadReportedRecords).toBeUndefined();
  });

  it("splits records into reported, unreported and unknown coverage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ cacheReadReportedRecords: 5, cacheWriteReportedRecords: 5 }),
              bucket({
                day: "2026-08-08" as UsageDay,
                cacheReadReportedRecords: 1,
                cacheWriteReportedRecords: 0,
              }),
              // A bucket without the fields predates coverage reporting.
              bucket({ day: "2026-08-09" as UsageDay }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.records).toBe(15);
    expect(merged.cacheReporting).toEqual({
      read: { reportedRecords: 6, unreportedRecords: 4, unknownRecords: 5 },
      write: { reportedRecords: 5, unreportedRecords: 5, unknownRecords: 5 },
    });
  });

  it("treats a coverage count above the bucket size as fully reported", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ cacheReadReportedRecords: 99 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.cacheReporting.read).toEqual({
      reportedRecords: 5,
      unreportedRecords: 0,
      unknownRecords: 0,
    });
  });

  it("counts a shared transcript directory's coverage once", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket({ cacheReadReportedRecords: 5 })], [shared])),
        environment("env-b", summary([bucket({ cacheReadReportedRecords: 5 })], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.records).toBe(5);
    expect(merged.cacheReporting.read).toEqual({
      reportedRecords: 5,
      unreportedRecords: 0,
      unknownRecords: 0,
    });
  });

  it("ignores coverage from an environment excluded by contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ cacheReadReportedRecords: 5 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ cacheReadReportedRecords: 5 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.cacheReporting.read).toEqual({
      reportedRecords: 5,
      unreportedRecords: 0,
      unknownRecords: 0,
    });
  });

  it("marks a model with no known rates as unpriced rather than free", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.find((model) => model.model === "unknown-model")?.unpricedRecords).toBe(5);
    expect(merged.models.filter(isModelCostUnknown).map((model) => model.model)).toEqual([
      "unknown-model",
    ]);
  });

  it("values each provider's coverage independently in a mixed window", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 40 }),
              bucket({
                provider: "grok",
                model: "grok-1",
                costUsd: 35,
                records: 3,
                unpricedRecords: 1,
              }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "grok", hostId: "mac", homePath: "/a/.grok" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    const byProvider = new Map(merged.providers.map((provider) => [provider.provider, provider]));
    expect(byProvider.get("claude")?.unpricedShare).toBe(0);
    expect(byProvider.get("grok")?.unpricedShare).toBeCloseTo(1 / 3, 5);
    expect(byProvider.get("codex")?.unpricedShare).toBe(1);
    expect(describeApiCost(byProvider.get("claude")).status).toBe("complete");
    expect(describeApiCost(byProvider.get("grok")).status).toBe("partial");
    expect(describeApiCost(byProvider.get("codex"))).toMatchObject({
      status: "unknown",
      value: "Unpriced",
    });
    expect(describeMergedApiCost(merged).status).toBe("partial");
  });

  it("presents an all-unpriced window as unknown while keeping its numeric totals", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(describeMergedApiCost(merged)).toMatchObject({
      status: "unknown",
      value: "Unpriced",
    });
    // The valuation label changes nothing about the measured totals.
    expect(merged.costUsd).toBe(0);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.records).toBe(5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(2);
    expect(merged.costQuality.unvaluedCachedInputTokens).toBe(1000);
    expect(merged.providers[0]?.unpricedShare).toBe(1);
  });

  it("weights provider coverage by records, not tokens or bucket share", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              // One unpriced record carries nearly all the tokens.
              bucket({
                costUsd: 0,
                costSource: "unpriced",
                records: 1,
                unpricedRecords: 1,
                totals: {
                  uncachedInputTokens: 0,
                  cachedInputTokens: 9000,
                  cacheCreationTokens: 0,
                  outputTokens: 900,
                  reasoningTokens: 0,
                },
              }),
              bucket({
                day: "2026-08-08" as UsageDay,
                costUsd: 9,
                records: 9,
                unpricedRecords: 0,
                totals: {
                  uncachedInputTokens: 90,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 10,
                  reasoningTokens: 0,
                },
              }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // 1 unpriced of 10 records is 10%; token share (~99%) or the mean of the
    // two bucket shares (50%) would both be wrong.
    expect(merged.providers[0]?.unpricedShare).toBeCloseTo(0.1, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.1, 5);
    expect(describeMergedApiCost(merged).status).toBe("partial");
  });

  it("keeps coverage unchanged when a duplicate source is dropped", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment(
          "env-b",
          summary([bucket({ costUsd: 0, costSource: "unpriced", unpricedRecords: 5 })], [shared]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's unpriced records never entered the merge.
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.records).toBe(5);
    expect(merged.costQuality.unpricedShare).toBe(0);
    expect(merged.providers[0]?.unpricedShare).toBe(0);
    expect(describeMergedApiCost(merged).status).toBe("complete");
  });

  it("orders models by cost descending", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ provider: "claude", model: "lower-cost", costUsd: 4 }),
              bucket({ provider: "codex", model: "higher-cost", costUsd: 9 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.map((model) => model.model)).toEqual(["higher-cost", "lower-cost"]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
    expect(merged.hourly).toHaveLength(0);
    expect(merged.costQuality.unvaluedCachedInputTokens).toBe(0);
    expect(merged.costQuality.unattributedCachedInputTokens).toBe(0);
  });

  it("omits providers with no sessions or usage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 0,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toEqual([]);
  });

  it("derives hourly totals without losing the daily rollup", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ hourStart: "2026-08-07T09:37:00.000Z", costUsd: 3 }),
              bucket({ hourStart: "2026-08-07T10:37:00.000Z", costUsd: 7 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hourly.map((hour) => [hour.hourStart, hour.costUsd])).toEqual([
      ["2026-08-07T09:37:00.000Z", 3],
      ["2026-08-07T10:37:00.000Z", 7],
    ]);
    expect(merged.daily).toHaveLength(1);
    expect(merged.daily[0]?.costUsd).toBe(10);
  });
});
