/**
 * Conditional disclosure for usage totals whose Codex attribution is uncertain.
 *
 * Fork and subagent records reach the merged summary through copied-history
 * suppression heuristics, so their contribution to displayed totals cannot be
 * established exactly. This module only reports that risk for the totals the
 * user is looking at; it never adjusts numbers or claims to detect forks.
 *
 * @module usageAttribution
 */
import type { MergedUsage } from "./usageMerge.ts";

export const CODEX_CHILD_USAGE_NOTICE =
  "If these totals include Codex forks or subagents, their usage may be overcounted or undercounted.";

/**
 * The notice when the merged totals the page renders include Codex records,
 * `null` otherwise. Positive records are required because a sessions-only
 * provider entry can exist with zero records; unpriced Codex records still
 * warn because they count in tokens while contributing nothing to cost.
 */
export function codexChildUsageNotice(merged: Pick<MergedUsage, "providers">): string | null {
  return merged.providers.some((provider) => provider.provider === "codex" && provider.records > 0)
    ? CODEX_CHILD_USAGE_NOTICE
    : null;
}
