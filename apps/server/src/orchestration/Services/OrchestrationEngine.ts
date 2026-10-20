/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationAggregateReplayStats } from "../../persistence/Services/OrchestrationEventStore.ts";
import type { ContinuationSettlement } from "../../restartContinuations.ts";

export interface OrchestrationThreadReplayRange {
  readonly threadId: ThreadId;
  readonly fromSequenceExclusive: number;
  readonly toSequenceInclusive: number;
}

/**
 * Server-internal only; never on the wire. Selects the guarded task-result
 * write path for one `thread.activity.append` command. The engine re-reads
 * durable state inside the dispatch transaction and appends only while this
 * tuple still matches it; a mismatch is rejected, not applied.
 */
export interface TaskResultWriteGuard {
  /**
   * Sequence of this thread's latest `thread.created` event the caller
   * measured under; a newer create or any delete invalidates the write.
   */
  readonly threadIncarnation: number;
  /**
   * The record revision the caller last saw; `null` asserts the durable
   * task-result record row is absent.
   */
  readonly expectedRevision: number | null;
  /**
   * Required for a write that stores acceptance; forbidden otherwise. Binds
   * the write to the exact durable receipt row and engine head the caller
   * judged.
   */
  readonly accept?: {
    /**
     * Sequence of the durable `selected-check-receipt` row the measurement
     * read; a fresher receipt on the fixed row invalidates the write.
     */
    readonly checkReceiptSequence: number;
    /**
     * The `latestSequence` the caller saw before measuring; a turn-start or
     * checkpoint-revert request committed after it refuses the write.
     */
    readonly observedThroughSequence: number;
  };
}

/**
 * The one fixed wording a refused task-result write is reported with, so
 * services can map it without importing the implementation layer.
 */
export const TASK_RESULT_WRITE_REJECT_DETAIL =
  "task-result write rejected; the judged state is no longer current";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read a wider global range. Thread subscriptions use readThreadEvents.
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read only this thread's events through a captured authoritative head. */
  readonly readThreadEvents: (
    input: OrchestrationThreadReplayRange & { readonly limit?: number },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Measure a bounded thread replay without decoding its event bodies. */
  readonly getThreadReplayStats: (
    input: OrchestrationThreadReplayRange & { readonly maxEvents: number },
  ) => Effect.Effect<OrchestrationAggregateReplayStats, OrchestrationEventStoreError>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @param options - Optional client origin (surface/app version) stamped into
   *   the metadata of every event the command produces.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: {
      readonly origin?: OrchestrationClientOrigin;
      /** Server-internal only. Never set from client requests. */
      readonly continuationSettlement?: ContinuationSettlement;
      /**
       * Server-internal only. Lets the provider command reactor write a
       * canceled preparation's terminal session while the exact "starting"
       * session-set it cites is still the thread's latest session write and
       * the stop/interrupt control event that triggered it is still the
       * newest owner claim for that thread. Any mismatch or stale anchor is
       * permanently refused. Never part of the wire contract.
       */
      readonly preparationCancel?: {
        readonly preparationSequence: number;
        readonly controlSequence: number;
      };
      /**
       * Server-internal only. Selects the guarded task-result write path;
       * never part of the wire contract. Mutually exclusive with
       * continuationSettlement and preparationCancel.
       */
      readonly taskResultWrite?: TaskResultWriteGuard;
    },
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Acquire a domain-event subscription before starting a consumer.
   * The subscription is ready when this effect returns and closes with the scope.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
