import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { defaultBreakdownSort, nextBreakdownSort, sortModels } from "./usageBreakdown";

const model = (name: string, totalTokens: number, costUsd: number): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  records: 1,
  unpricedRecords: 0,
  costShare: 0,
});

const names = (models: readonly ModelTotals[]) => models.map((item) => item.model);

describe("sortModels", () => {
  const models = [
    model("lower-cost", 100, 1),
    model("more-tokens", 200, 2),
    model("higher-cost", 100, 3),
  ];

  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    expect(names(sortModels(models, { key: "tokens", direction: "desc" }))).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(names(models)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });

  it("sorts by cost and by name in either direction", () => {
    expect(names(sortModels(models, { key: "cost", direction: "desc" }))).toEqual([
      "higher-cost",
      "more-tokens",
      "lower-cost",
    ]);
    expect(names(sortModels(models, { key: "cost", direction: "asc" }))).toEqual([
      "lower-cost",
      "more-tokens",
      "higher-cost",
    ]);
    expect(names(sortModels(models, { key: "name", direction: "asc" }))).toEqual([
      "higher-cost",
      "lower-cost",
      "more-tokens",
    ]);
  });

  it("sinks unknown-cost models by cost and orders them by tokens", () => {
    const unknown = [model("small", 10, 0), model("priced", 5, 4), model("big", 90, 0)];
    expect(names(sortModels(unknown, { key: "cost", direction: "desc" }))).toEqual([
      "priced",
      "big",
      "small",
    ]);
  });
});

describe("breakdown sort choice", () => {
  it("defaults to the metric on screen", () => {
    expect(defaultBreakdownSort("tokens")).toEqual({ key: "tokens", direction: "desc" });
    expect(defaultBreakdownSort("cost")).toEqual({ key: "cost", direction: "desc" });
  });

  it("flips the active column and starts a new one at its natural direction", () => {
    const cost = { key: "cost", direction: "desc" } as const;
    expect(nextBreakdownSort(cost, "cost")).toEqual({ key: "cost", direction: "asc" });
    expect(nextBreakdownSort(cost, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextBreakdownSort(cost, "tokens")).toEqual({ key: "tokens", direction: "desc" });
  });
});
