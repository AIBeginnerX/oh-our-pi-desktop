/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { OrchestrationDispatchError } from "../Errors.ts";

/** Failures that can surface while `start` subscribes and runs startup recovery. */
export type ProviderCommandReactorStartError =
  | OrchestrationDispatchError
  | SqlError
  | PlatformError.PlatformError;

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   * It subscribes before returning. Event handling waits for server activation.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   *
   * Startup recovery and per-write echo guards may fail during subscription.
   * Ordinary startup-recovery failures are reported via existing bounded
   * handling/warnings; the public error union preserves typed dispatch, SQL,
   * and platform components when interrupt-bearing mixed Causes propagate.
   */
  readonly start: () => Effect.Effect<void, ProviderCommandReactorStartError, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("t3/orchestration/Services/ProviderCommandReactor") {}
