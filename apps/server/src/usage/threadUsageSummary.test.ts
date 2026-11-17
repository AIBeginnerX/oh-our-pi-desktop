import { ThreadId, EventId, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { aggregateThreadUsage, chainStepCostsUsd } from "./threadUsageSummary.ts";
import type { OwnedTurnUsageObservationV1 } from "./ownedUsage.schema.ts";
import { createOverrideRateTable } from "./usagePricing.ts";
const threadId = ThreadId.make("thread");
const childId = ThreadId.make("child");
const rates = createOverrideRateTable({
  model: {
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 20,
    cacheReadCostPerMillionTokens: 1,
    cacheWriteCostPerMillionTokens: 15,
  },
});
function entry(
  model = "model",
  costUsd?: number,
  cachedInputTokens?: number,
  extras: { at?: string; threadId?: ThreadId; turnId?: string | null } = {},
) {
  const observation: OwnedTurnUsageObservationV1 = {
    v: 1,
    scope: "main-turn",
    terminal: "completed",
    source: {
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: null,
      turnId: null,
      runtimeEventId: EventId.make("event"),
      nativeConversationId: null,
    },
    usage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 1000,
      outputTokens: 100,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      cacheCreationTokens: 200,
    },
    ...(costUsd === undefined ? {} : { costUsd }),
  };
  return {
    threadId: extras.threadId ?? threadId,
    turnId: extras.turnId ?? null,
    createdAt: extras.at ?? "2026-01-01T00:00:00.000Z",
    model,
    observation,
  };
}
const summarize = (entries: ReturnType<typeof entry>[]) =>
  aggregateThreadUsage(threadId, entries, rates, new Map());
describe("thread usage aggregation", () => {
  it("groups supplied main and child model selections", () => {
    const result = summarize([entry(), entry("child"), entry()]);
    expect(result.models.map((r) => [r.model, r.turns])).toEqual([
      ["model", 2],
      ["child", 1],
    ]);
  });
  it("prices each turn as the step of the provider's running total", () => {
    // Claude repeats the session's whole spend in every report; the turn's own
    // cost is the step from the previous report, and the steps sum to the
    // final total, not to the sum of reports.
    const cost = summarize([
      entry("model", 2, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("model", 5, undefined, { at: "2026-01-01T00:01:00.000Z" }),
      entry("model", 6, undefined, { at: "2026-01-01T00:02:00.000Z" }),
    ]).totals.cost;
    expect(cost).toEqual({ kind: "reported", usd: 6 });
  });
  it("prices a kept turn as its own chain step, not the running total its report repeats", () => {
    // Filtering to the turn before stepping would read its 5-report as a
    // fresh chain and bill the whole session to one turn.
    const cost = aggregateThreadUsage(
      threadId,
      [
        entry("model", 2, undefined, { at: "2026-01-01T00:00:00.000Z", turnId: "turn-1" }),
        entry("model", 5, undefined, { at: "2026-01-01T00:01:00.000Z", turnId: "turn-2" }),
      ],
      rates,
      new Map(),
      (kept) => kept.turnId === "turn-2",
    ).totals.cost;
    expect(cost).toEqual({ kind: "reported", usd: 3 });
  });
  it("splits a running total across the models its turns ran with", () => {
    const result = summarize([
      entry("opus", 2, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("sonnet", 5, undefined, { at: "2026-01-01T00:01:00.000Z" }),
      entry("opus", 6, undefined, { at: "2026-01-01T00:02:00.000Z" }),
    ]);
    expect(result.models.map((r) => [r.model, r.cost])).toEqual([
      ["opus", { kind: "reported", usd: 3 }],
      ["sonnet", { kind: "reported", usd: 3 }],
    ]);
    expect(result.totals.cost).toEqual({ kind: "reported", usd: 6 });
  });
  it("restarts the chain when the running total drops to a fresh session", () => {
    const cost = summarize([
      entry("model", 10, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("model", 3, undefined, { at: "2026-01-01T00:01:00.000Z" }),
      entry("model", 4, undefined, { at: "2026-01-01T00:02:00.000Z" }),
    ]).totals.cost;
    expect(cost).toEqual({ kind: "reported", usd: 14 });
  });
  it("keeps running totals of separate threads in separate chains", () => {
    // Parent and child threads run their own sessions; interleaved reports
    // must not step on each other.
    const cost = summarize([
      entry("model", 10, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("model", 2, undefined, { at: "2026-01-01T00:01:00.000Z", threadId: childId }),
      entry("model", 12, undefined, { at: "2026-01-01T00:02:00.000Z" }),
    ]).totals.cost;
    expect(cost).toEqual({ kind: "reported", usd: 14 });
  });
  it("treats an unreported turn inside a reporting chain as covered by the next step", () => {
    // An aborted turn reports no cost; the provider bills its spend inside the
    // next report's step, so it contributes nothing instead of an estimate.
    const cost = summarize([
      entry("model", 2, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("model", undefined, 300, { at: "2026-01-01T00:01:00.000Z" }),
      entry("model", 5, undefined, { at: "2026-01-01T00:02:00.000Z" }),
    ]).totals.cost;
    expect(cost).toEqual({ kind: "reported", usd: 5 });
  });
  it("mixes estimates in only when a chain never reports", () => {
    const cost = summarize([entry("model", undefined, 300)]).totals.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind !== "unknown") expect(cost.usd).toBeCloseTo(0.0103);
  });
  it("counts a reported turn as priced even without a rate", () => {
    expect(summarize([entry("missing", 5)]).totals.cost).toEqual({ kind: "reported", usd: 5 });
  });
  it("keeps unknown pricing unknown", () => {
    expect(summarize([entry("missing")]).totals.cost).toEqual({ kind: "unknown" });
  });
  it("uses override prices", () => {
    expect(
      aggregateThreadUsage(threadId, [entry("custom")], new Map(), rates).totals.cost.kind,
    ).toBe("unknown");
    expect(aggregateThreadUsage(threadId, [entry()], new Map(), rates).totals.cost.kind).toBe(
      "estimated",
    );
  });
  it("excludes unreported cache turns from the rate denominator", () => {
    const result = summarize([entry("model", undefined, 300), entry()]);
    expect(result.totals.cacheRate).toBe(0.3);
    expect(result.totals.cachedInputTokens.reportedTurns).toBe(1);
    expect(summarize([entry()]).totals.cacheRate).toBeNull();
  });

  const chainKey = `${threadId}|claudeAgent|`;
  const chain = (costUsd: number | undefined, at: string) => ({
    chainKey,
    createdAt: at,
    costUsd,
  });

  it("leaves a trailing unreported turn uncovered when no later report arrives", () => {
    expect(
      chainStepCostsUsd([
        chain(2, "2026-01-01T00:00:00.000Z"),
        chain(undefined, "2026-01-01T00:01:00.000Z"),
      ]),
    ).toEqual([2, null]);
    const cost = summarize([
      entry("model", 2, undefined, { at: "2026-01-01T00:00:00.000Z" }),
      entry("model", undefined, undefined, { at: "2026-01-01T00:01:00.000Z" }),
    ]).totals.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind === "estimated") expect(cost.usd).toBeCloseTo(2 + 0.0085);
  });

  it("covers a leading unreported turn at zero when the next report continues the session", () => {
    expect(
      chainStepCostsUsd([
        chain(undefined, "2026-01-01T00:00:00.000Z"),
        chain(1.5, "2026-01-01T00:01:00.000Z"),
      ]),
    ).toEqual([0, 1.5]);
  });

  it("leaves an unreported turn uncovered when a later report restarts the session", () => {
    expect(
      chainStepCostsUsd([
        chain(1, "2026-01-01T00:00:00.000Z"),
        chain(undefined, "2026-01-01T00:01:00.000Z"),
        chain(0.4, "2026-01-01T00:02:00.000Z"),
      ]),
    ).toEqual([1, null, 0.4]);
  });
});
