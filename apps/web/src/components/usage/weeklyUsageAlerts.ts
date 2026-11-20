import {
  collectLimitAccounts,
  type LimitPresentations,
  type LimitPoolMember,
} from "@t3tools/shared/usageLimits";

type WeeklyUsageAlert = LimitPoolMember & { readonly key: string };

export function selectWeeklyUsageAlerts(presentations: LimitPresentations) {
  const alerts: WeeklyUsageAlert[] = [];
  const rearmed = new Set<string>();
  for (const account of collectLimitAccounts(presentations)) {
    const email = account.email?.trim().toLowerCase();
    const accountIdentity = email ? [account.driver, email] : account.key;
    for (const window of account.limits.windows) {
      if (window.kind !== "weekly" || typeof window.usedPercent !== "number") continue;
      // Rounding keeps nearby reset times in one period, so each period warns once.
      const resetHour = Math.round(Date.parse(window.resetsAt ?? "") / 3_600_000);
      const period = Number.isFinite(resetHour) ? resetHour : null;
      if (window.usedPercent < 99) {
        // Without a reset time, usage dropping is the only sign that a new period began.
        if (period === null) rearmed.add(JSON.stringify([accountIdentity, window.id]));
        continue;
      }
      alerts.push({ key: JSON.stringify([accountIdentity, window.id, period]), account, window });
    }
  }
  return { alerts, rearmed };
}

export function planWeeklyUsageAlerts(
  stored: ReadonlySet<string>,
  { alerts, rearmed }: ReturnType<typeof selectWeeklyUsageAlerts>,
) {
  const retained = new Set<string>();
  for (const key of stored) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts.length !== 3) continue;
    const [identity, windowId, resetHour] = parts;
    if (
      !(
        typeof identity === "string" ||
        (Array.isArray(identity) &&
          identity.length === 2 &&
          identity.every((part) => typeof part === "string"))
      ) ||
      typeof windowId !== "string" ||
      (resetHour !== null && !Number.isFinite(resetHour))
    ) {
      continue;
    }
    if (resetHour !== null || !rearmed.has(JSON.stringify([identity, windowId]))) retained.add(key);
  }
  return { pending: alerts.filter(({ key }) => !retained.has(key)), retained };
}

/** Keeps at most 100 remembered keys, oldest out first, but never one that is still warning. */
export function capWeeklyUsageAlertKeys(keys: Set<string>, active: ReadonlySet<string>) {
  for (const key of keys) {
    if (keys.size <= 100) break;
    if (!active.has(key)) keys.delete(key);
  }
}
