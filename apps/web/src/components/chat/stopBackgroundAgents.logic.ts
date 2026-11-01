/**
 * Stop on a Claude lead that finished its reply while background agents run is a hard session
 * boundary: the agents end with it. So Stop asks first when any are live, and stays immediate
 * otherwise. `liveAgentCount` is the Agents surface's running + waiting count; crew tasks run in
 * their own threads and never enter it.
 */
export type StopDecision =
  | { readonly kind: "immediate" }
  | { readonly kind: "confirm"; readonly agentCount: number };

export function decideStop(liveAgentCount: number): StopDecision {
  return liveAgentCount > 0
    ? { kind: "confirm", agentCount: liveAgentCount }
    : { kind: "immediate" };
}

/** Shown on the composer while a queued message waits for background agents. */
export function isQueuedBehindBackgroundAgents(input: {
  readonly running: boolean;
  readonly liveAgentCount: number;
}): boolean {
  return input.running && input.liveAgentCount > 0;
}
