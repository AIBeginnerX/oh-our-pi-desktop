/** Fill at which a thread that cannot compact itself is offered a fresh start. */
export const CONTEXT_HANDOFF_SUGGEST_PERCENTAGE = 70;

/** Drivers whose sessions compact their own context; the rest only grow. */
const NATIVELY_COMPACTING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * Whether the context meter should hint at "Continue in new thread". Providers that compact
 * natively never need it; for the others the hint appears once the window is 70% full. The same
 * rule lives in the terminal client (`handoff_suggested` in apps/oop-tui-rs/src/cmd_continue.rs).
 */
export function shouldSuggestContextHandoff(input: {
  readonly usedPercentage: number | null;
  readonly driverKind: string | null | undefined;
  readonly compactsAutomatically?: boolean | null | undefined;
}): boolean {
  if (input.usedPercentage === null || !Number.isFinite(input.usedPercentage)) return false;
  if (input.compactsAutomatically === true) return false;
  if (input.driverKind != null && NATIVELY_COMPACTING_DRIVERS.has(input.driverKind)) return false;
  return input.usedPercentage >= CONTEXT_HANDOFF_SUGGEST_PERCENTAGE;
}
