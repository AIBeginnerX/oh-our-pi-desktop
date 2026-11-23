import type { ThreadUsageSummary } from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { t } from "../../i18n";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow";

export const THREAD_USAGE_NOTE =
  "Estimates use API list prices, not your subscription bill. Cache rate includes cache writes.";

export function shortModelName(model: string): string {
  return (model.split(/[\\/]/).at(-1) ?? model)
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "")
    .replace(/-(\d{1,2})-(\d{1,2})(\[[^\]]*\])?$/, "-$1.$2$3");
}

export function formatThreadUsageFooter(
  summary: ThreadUsageSummary | null,
  context: ContextWindowSnapshot | null,
): string {
  const parts: string[] = [];
  const models = summary?.status === "ok" ? summary.models : [];
  const request = summary?.status === "ok" && summary.scope === "turn";
  if (request && summary.requestAggregated === true) parts.push(t("This request"));
  const formatContext = (value: { usedTokens: number; maxTokens: number | null }) =>
    `ctx ${formatContextWindowTokens(value.usedTokens)}${value.maxTokens === null ? "" : `/${formatContextWindowTokens(value.maxTokens)}`}`;
  // The thread's latest context may predate the request, so it never stands in for one.
  if (!request && !models.some((row) => row.context !== undefined) && context) {
    parts.push(
      formatContext({ usedTokens: context.usedTokens, maxTokens: context.maxTokens ?? null }),
    );
  }
  for (const row of models) {
    const ctx = row.context ? [formatContext(row.context)] : [];
    // A crew model with no usage measured still shows the context it reported.
    if (row.turns === 0) {
      parts.push([shortModelName(row.model), t("Usage not reported"), ...ctx].join(" "));
      continue;
    }
    const cost =
      row.cost.kind === "unknown"
        ? t("Cost unknown")
        : `${row.cost.kind === "estimated" ? "≈" : ""}$${row.cost.usd.toFixed(2)}`;
    parts.push(
      [
        shortModelName(row.model),
        cost,
        ...(row.cacheRate === null
          ? []
          : [t("cache {rate}", { rate: formatPercent(row.cacheRate, 0) })]),
        ...ctx,
      ].join(" "),
    );
  }
  return parts.join(" · ");
}

export function formatCrewAuditFooter(audit: { model?: string }, translate: typeof t = t): string {
  return audit.model
    ? translate("Auditor is reviewing this answer · {model}", { model: audit.model })
    : translate("Auditor is reviewing this answer");
}
