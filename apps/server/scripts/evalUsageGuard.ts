import type { ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * Claude quotas guard every eval, including evals using another provider.
 *
 * `models` lists the Claude model ids the run can drive, or `"any"` when it can reach any of them
 * (a Crew run's presets and fallbacks). A window applies when it is account-wide
 * (`modelFamilies` absent) or when `"any"` or one of `models` names one of its families. A window
 * with `modelFamilies: []` limits a tool, not a model, so it never applies.
 */
export function claudeUsageStopReason(
  limits: ServerProviderUsageLimits | null | undefined,
  models: ReadonlyArray<string> | "any",
  maxUsedPercent = 80,
): string | null {
  if (limits == null) return "Claude provider or usage limits missing; remaining percent unknown";
  if (limits.unavailable !== undefined)
    return "Claude usage unavailable; remaining percent unknown";
  if (limits.windows.length === 0) return "Claude usage windows missing; remaining percent unknown";
  for (const window of limits.windows) {
    const families = window.modelFamilies;
    if (families?.length === 0) continue;
    const applies =
      families === undefined ||
      models === "any" ||
      models.some((modelId) => {
        const words = modelId.toLowerCase().split(/[^a-z0-9]+/);
        return families.some((family) => words.includes(family.toLowerCase()));
      });
    if (applies && window.usedPercent >= maxUsedPercent) {
      return `Claude ${window.label}: ${100 - window.usedPercent}% left`;
    }
  }
  return null;
}
