/**
 * Pure rules for the opt-in no-activity alert: a running thread that has gone
 * quiet for the chosen number of minutes without waiting on the user. Silence
 * is measured from the thread shell's `updatedAt`, which the server keeps
 * fresh (within roughly thirty seconds) while a turn is active.
 */

/** How often the client checks for silence. Matches the server's throttled
    push cadence for quiet threads, so an alert lands within about half a
    minute of the threshold. */
export const NO_ACTIVITY_ALERT_CHECK_MS = 30_000;

/** The part of the thread shell the silence check reads. */
export interface NoActivityAlertThread {
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestTurn: { readonly state: string; readonly turnId?: string | null } | null;
}

/** A running turn that is not waiting on the user. Also the gate for running
    the check at all: with no candidate there is nothing that can alert. */
export function isNoActivityAlertCandidate(thread: NoActivityAlertThread): boolean {
  return (
    thread.latestTurn?.state === "running" &&
    thread.archivedAt === null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput
  );
}

/** One alert per silence: any new activity changes the key, so it re-arms. */
export function noActivityAlertKey(thread: NoActivityAlertThread): string {
  return `${thread.latestTurn?.turnId ?? ""}:${thread.updatedAt}`;
}

/**
 * The threads whose running turn has now been silent for `minutes`, given the
 * keys already alerted. Fires once per silence: fired keys land in `alerted`,
 * keys of threads that no longer qualify are dropped so the set cannot grow,
 * and a new silence (a new key) alerts again. `minutes` null (off) reads and
 * changes nothing.
 */
export function noActivityAlerts<T extends NoActivityAlertThread>(
  threads: readonly T[],
  nowMs: number,
  minutes: number | null,
  alerted: Set<string>,
): T[] {
  if (minutes === null) return [];
  const candidates = threads.filter(isNoActivityAlertCandidate);
  const liveKeys = new Set(candidates.map(noActivityAlertKey));
  for (const key of alerted) {
    if (!liveKeys.has(key)) alerted.delete(key);
  }
  const thresholdMs = minutes * 60_000;
  const due: T[] = [];
  for (const thread of candidates) {
    const key = noActivityAlertKey(thread);
    if (alerted.has(key)) continue;
    const updatedAt = Date.parse(thread.updatedAt);
    // No timestamp to measure silence from: skip rather than guess.
    if (Number.isNaN(updatedAt)) continue;
    if (nowMs - updatedAt >= thresholdMs) {
      alerted.add(key);
      due.push(thread);
    }
  }
  return due;
}
