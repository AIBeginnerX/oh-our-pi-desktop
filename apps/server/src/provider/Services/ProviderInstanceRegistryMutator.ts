/**
 * ProviderInstanceRegistryMutator — internal handle used by the hydration
 * layer to reconcile the live registry with a fresh
 * `ProviderInstanceConfigMap`.
 *
 * Kept separate from the public `ProviderInstanceRegistry` service tag so
 * downstream consumers (drivers, reactors, `ProviderService`) can only read
 * from the registry. Only the hydration layer — which watches
 * `ServerSettingsService.streamChanges` and applies diffs — imports this
 * tag.
 *
 * The mutator exposes a single entry point, `reconcile(configMap)`, which:
 *
 *   1. Diffs the incoming map against the live one keyed by instance id.
 *   2. Retires every removed or replaced id in the authoritative entries
 *      map FIRST — synchronous readers stop resolving those ids before
 *      any teardown is awaited — then closes the per-instance `Scope` of
 *      each retired entry (tearing down adapter processes, refresh
 *      fibres, temp files) BEFORE creating the replacement — `reconcile`
 *      guarantees "at most one live instance per id" at all times.
 *   3. Opens a fresh child `Scope` for every added or replaced entry, runs
 *      the driver's `create`, and stores the resulting `ProviderInstance`
 *      plus its scope.
 *   4. Publishes a `void` tick on the registry's `streamChanges` PubSub
 *      for each visible state change — once when retirements become
 *      visible (before teardown is awaited) and again at the end when the
 *      rebuilt entries / unavailable maps commit. A consumer re-pulling
 *      mid-batch can observe the intermediate retired state, so both
 *      ticks are emitted rather than coalesced into one.
 *
 * `reconcile` is idempotent: calling it with an unchanged config map is a
 * no-op (no scope churn, no pubsub emission).
 *
 * @module provider/Services/ProviderInstanceRegistryMutator
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * Bring the live registry in line with the supplied config map. See
   * module docs for the add / remove / replace semantics.
   *
   * The effect never fails: individual driver `create` failures are
   * captured as "unavailable" shadow snapshots inside the registry, the
   * same way boot-time failures are handled by
   * `makeProviderInstanceRegistry`. This keeps settings-watcher loops from
   * erroring out on a single bad entry.
   */
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/Services/ProviderInstanceRegistryMutator") {}
