import { type ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import type { OwnedTurnUsageObservationV1 } from "./ownedUsage.schema.ts";
import { lookupRate, type RateTable } from "./usagePricing.ts";

type Entry = { readonly model: string; readonly observation: OwnedTurnUsageObservationV1 };
export function aggregateThreadUsage(
  threadId: ThreadId,
  entries: ReadonlyArray<Entry>,
  rates: RateTable,
  overrides: RateTable,
): ThreadUsageSummary {
  const summarize = (items: ReadonlyArray<Entry>): ThreadUsageSummary["totals"] => {
    let inputTokens = 0,
      outputTokens = 0,
      cacheInput = 0,
      reportedUsd = 0,
      pricedUsd = 0;
    let allReported = items.length > 0,
      allPriced = items.length > 0;
    const cachedInputTokens = { sum: 0, reportedTurns: 0 };
    const cacheCreationTokens = { sum: 0, reportedTurns: 0 };
    for (const { model, observation: o } of items) {
      const u = o.usage;
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
      if (u.cachedInputTokens !== undefined && u.inputTokens !== undefined) {
        cachedInputTokens.sum += u.cachedInputTokens;
        cachedInputTokens.reportedTurns++;
        cacheInput += u.inputTokens ?? 0;
      }
      if (u.cacheCreationTokens !== undefined) {
        cacheCreationTokens.sum += u.cacheCreationTokens;
        cacheCreationTokens.reportedTurns++;
      }
      // Per turn, the provider-reported cost wins; only turns without one are
      // priced from the rate table. A reported turn is priced even when no
      // rate exists for its model.
      const reportedCostUsd =
        o.costUsd !== undefined && Number.isFinite(o.costUsd) && o.costUsd >= 0 ? o.costUsd : null;
      if (reportedCostUsd !== null) {
        reportedUsd += reportedCostUsd;
        pricedUsd += reportedCostUsd;
      } else {
        allReported = false;
        const rate = overrides.get(model.trim()) ?? lookupRate(rates, model);
        if (rate === null || u.inputTokens === undefined || u.outputTokens === undefined)
          allPriced = false;
        else
          pricedUsd +=
            Math.max(0, u.inputTokens - (u.cachedInputTokens ?? 0) - (u.cacheCreationTokens ?? 0)) *
              rate.inputCostPerToken +
            (u.cachedInputTokens ?? 0) * rate.cacheReadCostPerToken +
            (u.cacheCreationTokens ?? 0) * rate.cacheCreationCostPerToken +
            u.outputTokens * rate.outputCostPerToken;
      }
    }
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      turns: items.length,
      cacheRate:
        cachedInputTokens.reportedTurns > 0 && cacheInput > 0
          ? cachedInputTokens.sum / cacheInput
          : null,
      cost: allReported
        ? { kind: "reported", usd: reportedUsd }
        : allPriced
          ? { kind: "estimated", usd: pricedUsd }
          : { kind: "unknown" },
    };
  };
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.model, entry.observation.source.driver]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return {
    threadId,
    status: "ok",
    totals: summarize(entries),
    models: [...groups.values()].map((items) => ({
      model: items[0]!.model,
      driver: items[0]!.observation.source.driver,
      ...summarize(items),
    })),
  };
}
