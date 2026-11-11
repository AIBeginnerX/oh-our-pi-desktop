import { ThreadId, EventId, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { aggregateThreadUsage } from "./threadUsageSummary.ts";
import type { OwnedTurnUsageObservationV1 } from "./ownedUsage.schema.ts";
import { createOverrideRateTable } from "./usagePricing.ts";
const threadId = ThreadId.make("thread");
const rates = createOverrideRateTable({
  model: {
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 20,
    cacheReadCostPerMillionTokens: 1,
    cacheWriteCostPerMillionTokens: 15,
  },
});
function entry(model = "model", costUsd?: number, cachedInputTokens?: number) {
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
  return { model, observation };
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
  it("uses reported costs only when every turn reports them", () => {
    expect(summarize([entry("model", 2), entry("model", 3)]).totals.cost).toEqual({
      kind: "reported",
      usd: 5,
    });
  });
  it("mixes reported costs with estimates for unreported turns", () => {
    const cost = summarize([entry("model", 2), entry("model", undefined, 300)]).totals.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind !== "unknown") expect(cost.usd).toBeCloseTo(2.0103);
  });
  it("counts a reported turn as priced even without a rate", () => {
    const cost = summarize([entry("missing", 5), entry("model")]).totals.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind !== "unknown") expect(cost.usd).toBeCloseTo(5.013);
  });
  it("estimates the whole group with separate cache rates", () => {
    const cost = summarize([entry("model", undefined, 300)]).totals.cost;
    expect(cost.kind).toBe("estimated");
    if (cost.kind !== "unknown") expect(cost.usd).toBeCloseTo(0.0103);
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
});
