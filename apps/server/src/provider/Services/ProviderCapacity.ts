import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderCapacityShape {
  /**
   * Called before a provider session starts. When live sessions have reached the budget, stops
   * the longest-idle ones (no active turn, idle for at least two minutes) until one more fits.
   * Never waits and never fails, so a lead's turn is never queued or refused.
   */
  readonly makeRoom: (exceptThreadId: ThreadId) => Effect.Effect<void>;
  /**
   * Crew admission: waits, first come first served, until a crew session fits under the budget,
   * for at most three minutes. After the cap it returns anyway so waiting leads cannot deadlock.
   * `onWait` runs once, when the caller starts to wait.
   */
  readonly admitCrew: (input: { readonly onWait?: Effect.Effect<void> }) => Effect.Effect<void>;
}

export class ProviderCapacity extends Context.Service<ProviderCapacity, ProviderCapacityShape>()(
  "t3/provider/Services/ProviderCapacity",
) {}
