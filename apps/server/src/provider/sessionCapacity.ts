/**
 * Pure math for how many provider CLI processes one machine can keep alive.
 *
 * Each provider CLI is roughly 550 MB resident, and the desktop app and server need a few GB more.
 * Crew starts a separate session per delegated task, so ten busy threads can otherwise reach
 * dozens of processes.
 */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Memory kept for the OS, the desktop app and the server. */
const RESERVED_BYTES = 6 * GIB;
/** One live provider session, rounded up from the measured ~550 MB. */
const BYTES_PER_SESSION = 600 * MIB;
const MIN_BUDGET = 4;
const MAX_BUDGET = 32;

/** A session must have been quiet this long before pressure may stop it. */
export const PRESSURE_MIN_IDLE_MS = 2 * 60 * 1000;

/** How many live provider sessions fit: 16 GB gives 17, clamped to [4, 32]. */
export const liveSessionBudget = (totalMemBytes: number): number =>
  Math.min(
    MAX_BUDGET,
    Math.max(MIN_BUDGET, Math.floor((totalMemBytes - RESERVED_BYTES) / BYTES_PER_SESSION)),
  );

export type ReapBlock = "invalid-last-seen" | "too-fresh" | "active-turn" | "background-work";

/**
 * Why a live session must not be stopped now, or null when it may be. `idleMs` counts from the
 * later of the binding's last use and the thread session's last update, so a long turn gets a full
 * idle window after it settles.
 */
export const reapBlock = (input: {
  readonly lastSeenAt: string;
  readonly sessionUpdatedAt?: string | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly backgroundLiveness?: string | null | undefined;
  readonly now: number;
  readonly minIdleMs: number;
}): { readonly block: ReapBlock | null; readonly idleMs: number } => {
  const lastSeenMs = Date.parse(input.lastSeenAt);
  if (Number.isNaN(lastSeenMs)) return { block: "invalid-last-seen", idleMs: 0 };
  const sessionMs = Date.parse(input.sessionUpdatedAt ?? input.lastSeenAt);
  const idleMs = input.now - Math.max(lastSeenMs, sessionMs);
  if (idleMs < input.minIdleMs) return { block: "too-fresh", idleMs };
  // The turn can settle while background work runs on inside the provider process.
  if (input.activeTurnId != null) return { block: "active-turn", idleMs };
  if (input.backgroundLiveness != null) return { block: "background-work", idleMs };
  return { block: null, idleMs };
};

/**
 * The sessions to stop so that one more fits: the longest idle first, only as many as needed.
 * `candidates` are already known to be safe to stop.
 */
export const pressureVictims = <T extends { readonly idleMs: number }>(
  candidates: ReadonlyArray<T>,
  live: number,
  budget: number,
): ReadonlyArray<T> =>
  live < budget
    ? []
    : candidates.toSorted((a, b) => b.idleMs - a.idleMs).slice(0, live - budget + 1);
