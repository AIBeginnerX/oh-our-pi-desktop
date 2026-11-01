import type {
  OwnedMainUsageBucketV1,
  OwnedResultCoverageV1,
  OwnedResultUnmeasurableReason,
  OwnedResultUsageTrailingV1,
  OwnedResultUsageV1,
} from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { t } from "../../i18n";
import type { ResultUsageDisclosureState } from "../../state/resultUsage";

/**
 * Fixed copy for the passed-record usage disclosure (U-OWN-2 web
 * slice). Honest labels only: recorded snapshot of this thread on this
 * server, recorded timestamp spans are not execution time, cost is unknown,
 * child frames are excluded with unknown overlap, and nothing is ever summed
 * across buckets or results.
 *
 * The exported constants are English catalog keys; the display layer passes them through `t`.
 * The line formatters translate themselves, in the language chosen right now.
 */

export const RESULT_USAGE_HEADLINE = "This thread · values recorded by this server";
export const RESULT_USAGE_SCOPE_NOTE =
  "The scope differs from the provider account usage on the Usage screen.";
export const RESULT_USAGE_SNAPSHOT_NOTE =
  "Based on records up to the moment this panel was opened.";

/** Fixed copy for every non-row disclosure state; never zero as a stand-in. */
export const RESULT_USAGE_STATE_COPY: Record<
  Exclude<ResultUsageDisclosureState["phase"], "row" | "hidden">,
  string
> = {
  loading: "Reading usage records…",
  unsupported: "This server version does not support per-result usage.",
  "read-failed": "Couldn't read the usage records.",
  "row-missing": "Couldn't get usage for this record. Refresh.",
  "missing-create": "The thread creation record can't be found, so usage can't be read.",
  "too-large": "The thread history is too large to read usage.",
};

const UNMEASURABLE_COPY: Record<OwnedResultUnmeasurableReason, string> = {
  "activity-during-attempt":
    "Usage can't be split because there was other activity during this attempt.",
  "turn-active-at-attempt":
    "Usage can't be split because other work was in progress when this attempt started.",
  "revision-conflict":
    "Usage can't be finalized because differing contents remain for the same record.",
  "invalid-receipt-or-window":
    "Usage can't be split because the record is damaged or its window can't be determined.",
  "unresolved-ownership-or-history":
    "Usage can't be finalized because the owner or history can't be determined.",
};

/** Days/hours/minutes/seconds from a nonnegative millisecond value. */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t("{hours}h {minutes}m", { hours, minutes });
  if (minutes > 0) return t("{minutes}m {seconds}s", { minutes, seconds });
  return t("{seconds}s", { seconds });
}

/**
 * Cache dimensions report "k of n turns reported"; zero reporting turns means
 * the dimension was never reported, which is not zero usage. An explicit 0
 * sum with reporting turns counts as reported.
 */
function formatCachePart(
  label: string,
  cache: { readonly sum: number; readonly reportedTurns: number },
  completeTurns: number,
): string {
  if (cache.reportedTurns === 0) return t("{label} not reported", { label });
  return t("{label} {sum} ({reported}/{turns} turns reported)", {
    label,
    sum: cache.sum,
    reported: cache.reportedTurns,
    turns: completeTurns,
  });
}

/**
 * Cached share of observed input (cached + uncached). Recorded input includes
 * cache writes, which are not part of "observed input", so they are taken out.
 * Null unless every complete turn reported its cache reads (and any cache
 * writes were reported for all turns or none) and observed input is above
 * zero: an unreported dimension is not a 0% rate.
 */
function cacheHitRate(subtotal: OwnedMainUsageBucketV1["reportedCompleteSubtotal"]): number | null {
  const { completeTurns, inputTokens, cachedInputTokens, cacheCreationTokens } = subtotal;
  if (completeTurns === 0 || cachedInputTokens.reportedTurns !== completeTurns) return null;
  if (
    cacheCreationTokens.reportedTurns !== 0 &&
    cacheCreationTokens.reportedTurns !== completeTurns
  )
    return null;
  const observedInput = inputTokens - cacheCreationTokens.sum;
  if (observedInput <= 0) return null;
  return cachedInputTokens.sum / observedInput;
}

export function formatResultUsageBucketLine(bucket: OwnedMainUsageBucketV1): string {
  const scope = bucket.scope;
  const subtotal = bucket.reportedCompleteSubtotal;
  const conversation =
    scope.nativeConversationId === null
      ? t("conversation unknown")
      : t("conversation {id}", { id: scope.nativeConversationId });
  const hitRate = cacheHitRate(subtotal);
  return [
    `${scope.driver} · ${scope.instanceId} · ${conversation}`,
    t("Input {count}", { count: subtotal.inputTokens }),
    t("Output {count}", { count: subtotal.outputTokens }),
    formatCachePart(t("Cache input"), subtotal.cachedInputTokens, subtotal.completeTurns),
    ...(hitRate === null ? [] : [t("Cache hit rate {rate}", { rate: formatPercent(hitRate) })]),
    formatCachePart(t("Cache creation"), subtotal.cacheCreationTokens, subtotal.completeTurns),
    formatCachePart(t("Reasoning"), subtotal.reasoningTokens, subtotal.completeTurns),
    t("Complete turns {count}", { count: subtotal.completeTurns }),
  ].join(" · ");
}

function formatCoverageCounts(coverage: OwnedResultCoverageV1): string {
  return [
    t("Complete {count}", { count: coverage.complete }),
    t("Partial {count}", { count: coverage.partial }),
    t("Unavailable {count}", { count: coverage.unavailable }),
    t("Ambiguous {count}", { count: coverage.ambiguous }),
    t("Tainted {count}", { count: coverage.conflictTainted }),
    t("Out of scope {count}", { count: coverage.unscoped }),
    t("Unrecorded {count}", { count: coverage.unrecorded }),
    t("Late observations (excluded) {count}", { count: coverage.lateUnattributed }),
  ].join(" · ");
}

export function formatResultUsageCoverageLine(coverage: OwnedResultCoverageV1): string {
  return t("Turn coverage · {counts}", { counts: formatCoverageCounts(coverage) });
}

/** Counts only, shown when anything after the last result was observed. */
export function formatResultUsageTrailingLine(trailing: OwnedResultUsageTrailingV1): string | null {
  const coverage = trailing.coverage;
  const hasCoverage =
    coverage.complete > 0 ||
    coverage.partial > 0 ||
    coverage.unavailable > 0 ||
    coverage.ambiguous > 0 ||
    coverage.conflictTainted > 0 ||
    coverage.unscoped > 0 ||
    coverage.unrecorded > 0 ||
    coverage.lateUnattributed > 0;
  if (trailing.inputs === 0 && trailing.otherAttempts === 0 && !hasCoverage) return null;
  return t("After the last result · {inputs} inputs · {others} other attempts · {counts}", {
    inputs: trailing.inputs,
    others: trailing.otherAttempts,
    counts: formatCoverageCounts(coverage),
  });
}

/**
 * All lines for one exact result row. `checksMs` covers only the recorded
 * runner interval; `recordedSpanMs` is the difference of recorded event
 * timestamps and is labeled as such — null stays "not measured", never zero.
 */
export function formatResultUsageRowLines(row: OwnedResultUsageV1): ReadonlyArray<string> {
  const lines: string[] = [
    t("{inputs} inputs · {others} other attempts", {
      inputs: row.inputs,
      others: row.otherAttempts,
    }),
    row.checksMs === null
      ? t("Check run time: not measured")
      : t("Check run time: {duration}", { duration: formatDurationMs(row.checksMs) }),
    row.recordedSpan.recordedSpanMs === null
      ? t("Recorded time gap: not measured")
      : t(
          "Recorded time gap: {duration} (difference of recorded timestamps, not actual run time)",
          {
            duration: formatDurationMs(row.recordedSpan.recordedSpanMs),
          },
        ),
  ];
  if (row.usage.status === "measured") {
    lines.push(formatResultUsageCoverageLine(row.usage.coverage));
    for (const bucket of row.usage.buckets) lines.push(formatResultUsageBucketLine(bucket));
    lines.push(
      t("Sub-tasks {count} frames · not included (overlap unknown)", {
        count: row.usage.childFrames,
      }) +
        (row.usage.legacyChildFrames > 0
          ? t(" · legacy {count} frames", { count: row.usage.legacyChildFrames })
          : ""),
    );
    lines.push(t("Cost: unknown (no billing record)"));
  } else {
    lines.push(
      t("Usage can't be determined · {reason}", { reason: t(UNMEASURABLE_COPY[row.usage.reason]) }),
    );
  }
  return lines;
}
