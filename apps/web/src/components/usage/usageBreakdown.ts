import type { ModelTotals } from "@t3tools/shared/usageMerge";

export type BreakdownSort = {
  readonly key: "cost" | "tokens" | "name";
  readonly direction: "asc" | "desc";
};

/** Cost leads, except on the Tokens tab, where the page already ranks by volume. */
export function defaultBreakdownSort(metric: "cost" | "tokens" | "limits"): BreakdownSort {
  return { key: metric === "tokens" ? "tokens" : "cost", direction: "desc" };
}

/** Clicking the sorted column flips it; a new column starts at its natural direction. */
export function nextBreakdownSort(
  current: BreakdownSort,
  key: BreakdownSort["key"],
): BreakdownSort {
  if (current.key === key) {
    return { key, direction: current.direction === "desc" ? "asc" : "desc" };
  }
  return { key, direction: key === "name" ? "asc" : "desc" };
}

/**
 * Orders models by the chosen column. Cost and tokens break ties with each
 * other, so models with an unknown cost (stored as 0) sink below priced ones
 * and keep a stable order by volume.
 */
export function sortModels(models: readonly ModelTotals[], sort: BreakdownSort) {
  const sign = sort.direction === "asc" ? 1 : -1;
  return models.toSorted((left, right) => {
    const byName =
      left.model.localeCompare(right.model) || left.provider.localeCompare(right.provider);
    if (sort.key === "name") return sign * byName;
    const byCost = left.costUsd - right.costUsd;
    const byTokens = left.totalTokens - right.totalTokens;
    const primary = sort.key === "cost" ? byCost || byTokens : byTokens || byCost;
    return sign * primary || byName;
  });
}
