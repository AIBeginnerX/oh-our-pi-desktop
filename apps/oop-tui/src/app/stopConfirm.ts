/**
 * Stopping a thread that still has background agents running ends them with it. The first Esc or
 * Ctrl-C then only warns, and a second one within this window stops everything. With no live
 * agent, Stop is immediate.
 */
export const STOP_CONFIRM_WINDOW_MS = 4000;

export type StopStep =
  | { readonly kind: "stop" }
  | { readonly kind: "warn"; readonly agentCount: number };

export const nextStopStep = (input: {
  readonly liveAgentCount: number;
  /** When the warning was last shown for this thread; null when none is pending. */
  readonly warnedAt: number | null;
  readonly now: number;
}): StopStep => {
  if (input.liveAgentCount <= 0) return { kind: "stop" };
  if (input.warnedAt !== null && input.now - input.warnedAt < STOP_CONFIRM_WINDOW_MS) {
    return { kind: "stop" };
  }
  return { kind: "warn", agentCount: input.liveAgentCount };
};
