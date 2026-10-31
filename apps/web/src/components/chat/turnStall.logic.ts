/** How long a running turn may stay silent before the passive "quiet for a while" notice shows. */
export const TURN_STALL_MS = 10 * 60 * 1000;

// Activities and messages arrive in order, so the newest are at the end; a short tail keeps the
// per-event cost constant while tolerating a slightly out-of-order pair.
const ACTIVITY_TAIL = 8;
const MESSAGE_TAIL = 4;

function newest(times: ReadonlyArray<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const time of times) {
    const parsed = time === null || time === undefined ? Number.NaN : Date.parse(time);
    if (!Number.isNaN(parsed) && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/**
 * When the turn last showed life: its start, the session's last update, or the newest recorded
 * activity or message update. Provider events that are not recorded (raw deltas) are not seen, so
 * this can only run early, never late; the notice is passive either way.
 */
export function lastTurnActivityAt(input: {
  readonly turnStartedAt: string | null;
  readonly sessionUpdatedAt: string | null;
  readonly activities: ReadonlyArray<{ readonly createdAt: string }>;
  readonly messages: ReadonlyArray<{ readonly updatedAt: string }>;
}): number | null {
  return newest([
    input.turnStartedAt,
    input.sessionUpdatedAt,
    ...input.activities.slice(-ACTIVITY_TAIL).map((activity) => activity.createdAt),
    ...input.messages.slice(-MESSAGE_TAIL).map((message) => message.updatedAt),
  ]);
}

/**
 * Whether a tool call of the running turn is still in progress. A long build or test run is
 * legitimate quiet. The turn's entries are the contiguous tail of the work log.
 */
export function hasRunningTool(
  entries: ReadonlyArray<{
    readonly turnId?: string | null;
    readonly toolLifecycleStatus?: string;
  }>,
  runningTurnId: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.turnId !== runningTurnId) {
      if (entry.turnId === null || entry.turnId === undefined) continue;
      return false;
    }
    if (entry.toolLifecycleStatus === "inProgress") return true;
  }
  return false;
}

/**
 * The time (epoch ms) at which the running turn counts as quiet, or null while the setting is off,
 * nothing is running, or something legitimate is being waited on: a pending approval or user
 * input, a running tool, or live background work. Off returns before reading anything else.
 */
export function deriveTurnStallDueAt(input: {
  readonly enabled: boolean;
  readonly runningTurnId: string | null;
  readonly waitingOnUser: boolean;
  readonly backgroundWorkLive: boolean;
  readonly workLogEntries: Parameters<typeof hasRunningTool>[0];
  readonly activities: Parameters<typeof lastTurnActivityAt>[0]["activities"];
  readonly messages: Parameters<typeof lastTurnActivityAt>[0]["messages"];
  readonly turnStartedAt: string | null;
  readonly sessionUpdatedAt: string | null;
}): number | null {
  if (
    !input.enabled ||
    input.runningTurnId === null ||
    input.waitingOnUser ||
    input.backgroundWorkLive ||
    hasRunningTool(input.workLogEntries, input.runningTurnId)
  ) {
    return null;
  }
  const lastActivityAt = lastTurnActivityAt(input);
  return lastActivityAt === null ? null : lastActivityAt + TURN_STALL_MS;
}
