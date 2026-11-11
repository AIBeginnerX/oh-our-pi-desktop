import type { ThreadUsageSummary } from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { t } from "../../i18n";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow";

export const THREAD_USAGE_NOTE =
  "Estimates use API list prices, not your subscription bill. Cache rate includes cache writes.";

export function formatThreadUsageFooter(
  summary: ThreadUsageSummary | null,
  context: ContextWindowSnapshot | null,
): string {
  const parts: string[] = [];
  if (summary?.status === "ok") {
    if (summary.totals.cacheRate !== null)
      parts.push(t("Cache {rate}", { rate: formatPercent(summary.totals.cacheRate) }));
  }
  if (context) {
    const usage =
      formatContextWindowTokens(context.usedTokens) +
      (context.maxTokens === null
        ? ""
        : ` / ${formatContextWindowTokens(context.maxTokens ?? null)}`) +
      (context.usedPercentage === null ? "" : ` (${Math.round(context.usedPercentage)}%)`);
    parts.push(t("Context {usage}", { usage }));
  }
  if (summary?.status === "ok") {
    for (const row of summary.models)
      parts.push(
        `${row.model} ${row.cost.kind === "unknown" ? t("Cost unknown") : `${row.cost.kind === "estimated" ? "≈" : ""}$${row.cost.usd.toFixed(2)}`}`,
      );
  }
  return parts.join(" · ");
}

export function formatCrewAuditFooter(audit: { model?: string }, translate: typeof t = t): string {
  return audit.model
    ? translate("Auditor is reviewing this answer · {model}", { model: audit.model })
    : translate("Auditor is reviewing this answer");
}
