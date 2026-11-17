import { type ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import type { OwnedTurnUsageObservationV1 } from "./ownedUsage.schema.ts";
import { lookupRate, type RateTable } from "./usagePricing.ts";

type Entry = {
  readonly threadId: ThreadId;
  /** The observation activity's `turn_id`; null when the activity named no turn. */
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly model: string;
  readonly observation: OwnedTurnUsageObservationV1;
};

/** A cost the provider itself reported: finite and never negative. */
const reportedCostUsd = (costUsd: number | undefined): number | null =>
  costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;

export type ChainStepCostEntry = {
  readonly chainKey: string;
  readonly createdAt: string;
  readonly costUsd: number | undefined;
};

/**
 * Claude reports `costUsd` as the session's running total, not the turn's own
 * cost: the value at turn N repeats every earlier turn's spend (a 60-turn
 * thread's reports summed to ~40x its real cost). Within one
 * thread+driver+instance chain a running total only moves forward, so each
 * turn's cost is the step from the previous report, and the steps sum to the
 * provider's final total. A report below its predecessor is a fresh session
 * restarting the chain at its own value. Unreported turns stay pending until a
 * later first or continuing report covers them at zero; a restart or end of
 * chain leaves them uncovered (null) so callers can estimate from rates.
 */
export function chainStepCostsUsd(
  entries: ReadonlyArray<ChainStepCostEntry>,
): ReadonlyArray<number | null> {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  // ISO timestamps compare lexicographically; Array#sort is stable, so rows
  // delivered in created_at order keep it.
  indexed.sort((a, b) =>
    a.entry.createdAt < b.entry.createdAt ? -1 : a.entry.createdAt > b.entry.createdAt ? 1 : 0,
  );
  const out: Array<number | null> = Array.from({ length: entries.length });
  const prevReport = new Map<string, number>();
  const pending = new Map<string, number[]>();
  for (const { entry, index } of indexed) {
    const reported = reportedCostUsd(entry.costUsd);
    if (reported === null) {
      const list = pending.get(entry.chainKey) ?? [];
      list.push(index);
      pending.set(entry.chainKey, list);
      continue;
    }
    const prev = prevReport.get(entry.chainKey);
    const pend = pending.get(entry.chainKey) ?? [];
    if (prev === undefined || reported >= prev) {
      for (const i of pend) out[i] = 0;
    } else {
      for (const i of pend) out[i] = null;
    }
    pending.set(entry.chainKey, []);
    prevReport.set(entry.chainKey, reported);
    out[index] = prev === undefined || reported < prev ? reported : reported - prev;
  }
  for (const indices of pending.values()) {
    for (const i of indices) out[i] = null;
  }
  return out;
}

/**
 * Sums tokens and computes cost for a thread family's usage observations.
 * `keep` narrows what the summary counts; the Claude running-total chains are
 * always stepped over every entry first, so a kept turn's cost is its own
 * step of the chain, never its provider's running total.
 */
export function aggregateThreadUsage(
  threadId: ThreadId,
  entries: ReadonlyArray<Entry>,
  rates: RateTable,
  overrides: RateTable,
  keep?: (entry: Entry) => boolean,
): ThreadUsageSummary {
  const stepCosts = chainStepCostsUsd(
    entries.map((entry) => ({
      chainKey: `${entry.threadId}|${entry.observation.source.driver}|${
        entry.observation.source.instanceId ?? ""
      }`,
      createdAt: entry.createdAt,
      costUsd: entry.observation.costUsd,
    })),
  );
  const turnCost = new Map<Entry, number | null>();
  entries.forEach((entry, index) => turnCost.set(entry, stepCosts[index] ?? null));
  const counted = keep === undefined ? entries : entries.filter(keep);

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
    for (const item of items) {
      const { model, observation: o } = item;
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
      // The turn's own cost: the step of the provider's running total, or a
      // rate-table estimate for turns whose chain never reported one.
      const turnCostUsd = turnCost.get(item) ?? null;
      if (turnCostUsd !== null) {
        reportedUsd += turnCostUsd;
        pricedUsd += turnCostUsd;
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
  for (const entry of counted) {
    const key = JSON.stringify([entry.model, entry.observation.source.driver]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return {
    threadId,
    status: "ok",
    totals: summarize(counted),
    models: [...groups.values()].map((items) => ({
      model: items[0]!.model,
      driver: items[0]!.observation.source.driver,
      ...summarize(items),
    })),
  };
}
