/**
 * Owned-usage reader and reducer.
 *
 * Reads one thread's usage observations out of retained orchestration event
 * history (never the projection, which folds same-id activities) and reduces
 * them into the `OwnedThreadUsageOutcome` report defined in
 * `ownedUsage.schema.ts`. Read policy (see the review bindings):
 *
 * - The global head is captured once with a small owned SQL
 *   `COALESCE(MAX(sequence), 0)` read and then fixed for both the bounded
 *   stats check and the aggregate replay; the store has no head getter and
 *   scanning unbounded history to discover one is forbidden.
 * - History is only counted after the last `thread.created` in the captured
 *   range. Earlier records count once under `priorIncarnation`; the report's
 *   `invalid`, `legacyChildFrames`, buckets, children, and inventory are
 *   current-incarnation only.
 * - Source delivery conflicts are detected before turn grouping (same
 *   driver/instance/runtimeEventId, compared as the entire observation), and a
 *   conflict taints every scoped logical turn its alternatives claim: tainted
 *   turns contribute nothing to any subtotal even when a separate clean
 *   delivery exists, and stay inspectable under conflicts/ambiguity.
 * - Numeric sums exist only inside source-scoped buckets; there is no grand
 *   main total and no main+child sum (`parentChildOverlap: "unknown"`).
 * - Schema failures count retained records as `invalid`; raw payloads never
 *   appear in errors.
 *
 * @module ownedUsage
 */
import {
  type EventId,
  type OrchestrationEvent,
  RuntimeTaskUsage,
  type ThreadId,
  TrimmedNonEmptyString,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  OWNED_LIVE_TURN_IDENTITY_DRIVERS,
  OWNED_USAGE_ACTIVITY_KIND,
  type OwnedAmbiguousTurnV1,
  type OwnedChildUsageFrameV1,
  type OwnedPartialTurnV1,
  type OwnedThreadUsageOutcome,
  type OwnedTurnObservationAlternativeV1,
  OwnedTurnUsageObservationV1,
  type OwnedUsageBucketScopeV1,
  type OwnedUsageConflictV1,
  type OwnedUsageObservationRefV1,
  OwnedUsageSourceV1,
} from "./ownedUsage.schema.ts";

/** Aggregate replay bound shared by the stats check and the range read. */
export const OWNED_USAGE_MAX_EVENTS = 50_000;

/**
 * Store-level read failure, kept strictly internal to this module's callers:
 * the CLI renders only the fixed `message` and never serializes this error or
 * walks its `cause`, so driver-level detail and stored payload content never
 * reach stdout, JSON output, or persisted diagnostics.
 */
export class OwnedUsageStoreError extends Schema.TaggedError<OwnedUsageStoreError>()(
  "OwnedUsageStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Owned usage could not be read from the local database (${this.operation}).`;
  }
}

/** One decoded main-turn usage observation and its retained position. */
export type MainObservation = {
  readonly observation: OwnedTurnUsageObservationV1;
  readonly ref: OwnedUsageObservationRefV1;
};

/** One decoded, source-stamped child usage frame and its retained position. */
export type ChildFrame = {
  readonly source: OwnedUsageSourceV1;
  readonly usage: RuntimeTaskUsage;
  readonly taskId: string;
  readonly sequence: number;
  readonly eventId: EventId;
};

const decodeObservation = Schema.decodeUnknownOption(OwnedTurnUsageObservationV1);
const decodeUsageSource = Schema.decodeUnknownOption(OwnedUsageSourceV1);
const decodeTaskUsage = Schema.decodeUnknownOption(RuntimeTaskUsage);
const decodeTaskId = Schema.decodeUnknownOption(TrimmedNonEmptyString);

/** Canonical key for identity tuples and payload comparison: sorted keys, arrays ordered. */
export const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  if (Predicate.isObject(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

const mainDeliveryKey = (observation: OwnedTurnUsageObservationV1): string =>
  stableKey([
    observation.source.driver,
    observation.source.instanceId,
    observation.source.runtimeEventId,
  ]);

const childDeliveryKey = (frame: ChildFrame): string =>
  stableKey([frame.source.driver, frame.source.instanceId, frame.source.runtimeEventId]);

/** The complete decoded claim a child frame makes: source stamp, task, usage. */
const childClaimKey = (frame: ChildFrame): string =>
  stableKey({ source: frame.source, taskId: frame.taskId, usage: frame.usage });

export const zeroSubtotal = () => ({
  completeTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: { sum: 0, reportedTurns: 0 },
  cacheCreationTokens: { sum: 0, reportedTurns: 0 },
  reasoningTokens: { sum: 0, reportedTurns: 0 },
});

/**
 * The positively scoped claim one observation makes, or null when the
 * observation is unscoped (missing instance/turn, or a driver without an
 * established native conversation). Shared by bucketing and conflict tainting
 * so both apply the exact same scoping rule.
 */
export const scopedClaim = (
  observation: OwnedTurnUsageObservationV1,
): { scope: OwnedUsageBucketScopeV1; scopeKey: string; turnId: TurnId } | null => {
  const { driver, instanceId, turnId, nativeConversationId } = observation.source;
  if (instanceId === null || turnId === null) {
    return null;
  }
  const liveTurnIdentity = (OWNED_LIVE_TURN_IDENTITY_DRIVERS as readonly string[]).includes(driver);
  if (!liveTurnIdentity && nativeConversationId === null) {
    return null;
  }
  const scope: OwnedUsageBucketScopeV1 = { driver, instanceId, nativeConversationId };
  return { scope, scopeKey: stableKey([driver, instanceId, nativeConversationId]), turnId };
};

const toAlternative = (main: MainObservation): OwnedTurnObservationAlternativeV1 => ({
  runtimeEventId: main.observation.source.runtimeEventId,
  terminal: main.observation.terminal,
  usage: main.observation.usage,
  observation: main.ref,
});

type ScanMode = "current" | "prior";

export type Scan = {
  readonly mains: ReadonlyArray<MainObservation>;
  readonly childFrames: ReadonlyArray<ChildFrame>;
  /**
   * Distinct [driver, instanceId, activeTurnId] inventory tuples from
   * session-set events, mapped to the tuple's first retained sequence so
   * windowed readers can place each inventory entry once.
   */
  readonly turnInventory: ReadonlyMap<string, number>;
  /** Prior mode only: one entry per retained pre-incarnation usage record. */
  readonly priorDeliveries: ReadonlyArray<string>;
  /** Current mode only. */
  readonly invalid: number;
  /** Current mode only: retained sequences of the records counted in `invalid`. */
  readonly invalidSequences: ReadonlyArray<number>;
  /** Current mode only. */
  readonly legacyChildFrames: number;
  /** Current mode only: retained sequences of the rows counted in `legacyChildFrames`. */
  readonly legacyChildFrameSequences: ReadonlyArray<number>;
};

export const scanEvents = (events: ReadonlyArray<OrchestrationEvent>, mode: ScanMode): Scan => {
  const prior = mode === "prior";
  const mains: Array<MainObservation> = [];
  const childFrames: Array<ChildFrame> = [];
  const turnInventory = new Map<string, number>();
  const priorDeliveries = new Set<string>();
  const invalidSequences: Array<number> = [];
  const legacyChildFrameSequences: Array<number> = [];
  let invalid = 0;
  let legacyChildFrames = 0;

  const scanActivity = (kind: string, payload: unknown, sequence: number, eventId: EventId) => {
    if (kind === OWNED_USAGE_ACTIVITY_KIND) {
      const decoded = decodeObservation(payload);
      if (Option.isNone(decoded)) {
        // Undecodable rows keep one opaque coverage entry in whichever
        // incarnation they were retained in; current invalid never mixes
        // with prior coverage.
        if (prior) {
          priorDeliveries.add(stableKey(["undecodable", sequence, eventId]));
        } else {
          invalid += 1;
          invalidSequences.push(sequence);
        }
        return;
      }
      if (prior) {
        priorDeliveries.add(mainDeliveryKey(decoded.value));
      } else {
        mains.push({ observation: decoded.value, ref: { sequence, eventId } });
      }
      return;
    }
    if (kind !== "task.progress" && kind !== "task.completed") {
      return;
    }
    if (!Predicate.isObject(payload) || payload.typedUsage === undefined) {
      return;
    }
    if (payload.usageSource === undefined) {
      // A usage row without the source stamp cannot be attributed at all.
      if (prior) {
        priorDeliveries.add(stableKey(["legacy-child", sequence, eventId]));
      } else {
        legacyChildFrames += 1;
        legacyChildFrameSequences.push(sequence);
      }
      return;
    }
    const usage = decodeTaskUsage(payload.typedUsage);
    const source = decodeUsageSource(payload.usageSource);
    const taskId = decodeTaskId(payload.taskId);
    if (Option.isNone(usage) || Option.isNone(source) || Option.isNone(taskId)) {
      if (prior) {
        priorDeliveries.add(stableKey(["undecodable", sequence, eventId]));
      } else {
        invalid += 1;
        invalidSequences.push(sequence);
      }
      return;
    }
    const frame: ChildFrame = {
      source: source.value,
      usage: usage.value,
      taskId: taskId.value,
      sequence,
      eventId,
    };
    if (prior) {
      priorDeliveries.add(childDeliveryKey(frame));
    } else {
      childFrames.push(frame);
    }
  };

  for (const event of events) {
    if (
      event.type === "thread.session-set" &&
      event.payload.session.providerName !== null &&
      event.payload.session.activeTurnId !== null
    ) {
      if (!prior) {
        const key = stableKey([
          event.payload.session.providerName,
          event.payload.session.providerInstanceId ?? null,
          event.payload.session.activeTurnId,
        ]);
        const seen = turnInventory.get(key);
        if (seen === undefined || event.sequence < seen) {
          turnInventory.set(key, event.sequence);
        }
      }
      continue;
    }
    if (event.type === "thread.activity-appended") {
      scanActivity(
        event.payload.activity.kind,
        event.payload.activity.payload,
        event.sequence,
        event.eventId,
      );
    }
  }
  return {
    mains,
    childFrames,
    turnInventory,
    priorDeliveries: [...priorDeliveries],
    invalid,
    invalidSequences,
    legacyChildFrames,
    legacyChildFrameSequences,
  };
};

/**
 * One source delivery's retained child frames with its fold verdict: an
 * identical redelivery (`folded`) keeps its first frame only; differing
 * payloads under one delivery keep every retained frame. Exported as the
 * single definition of "the same delivery" shared with the result-window
 * reducer, which attributes the surviving frames by position.
 */
export const foldChildDeliveries = (
  childFrames: ReadonlyArray<ChildFrame>,
): ReadonlyMap<string, { readonly group: ReadonlyArray<ChildFrame>; readonly folded: boolean }> => {
  const byDelivery = new Map<string, Array<ChildFrame>>();
  for (const frame of childFrames) {
    const key = childDeliveryKey(frame);
    const group = byDelivery.get(key);
    if (group === undefined) {
      byDelivery.set(key, [frame]);
    } else {
      group.push(frame);
    }
  }
  const folds = new Map<
    string,
    { readonly group: ReadonlyArray<ChildFrame>; readonly folded: boolean }
  >();
  for (const [key, group] of byDelivery) {
    const payloadKeys = new Set(group.map(childClaimKey));
    folds.set(key, { group, folded: payloadKeys.size === 1 });
  }
  return folds;
};

/**
 * The resolved source-delivery/turn view of one incarnation's main
 * observations. This is the single source both reducers read: the
 * whole-history report and the per-result windowing must never reimplement
 * delivery identity, conflict detection, scope claiming or receipt
 * bookkeeping separately.
 */
export type OwnedUsageMainsReconciliation = {
  /** Deliveries seen with differing payloads; none contributes a number. */
  readonly conflicts: ReadonlyArray<OwnedUsageConflictV1>;
  /** Identical redeliveries folded to one observation each. */
  readonly clean: ReadonlyArray<MainObservation>;
  readonly duplicateDeliveryCount: number;
  /** Scoped turns claimed by at least one conflict alternative. */
  readonly taintedTurns: ReadonlyMap<
    string,
    {
      readonly scope: OwnedUsageBucketScopeV1;
      readonly turnId: TurnId;
      readonly alternatives: ReadonlyArray<OwnedTurnObservationAlternativeV1>;
    }
  >;
  /** Scoped turns with at least one clean claim, keyed by [scopeKey, turnId]. */
  readonly scopedTurns: ReadonlyMap<
    string,
    {
      readonly scope: OwnedUsageBucketScopeV1;
      readonly scopeKey: string;
      readonly turnId: TurnId;
      readonly claims: Array<MainObservation>;
    }
  >;
  /** Clean observations that could not claim a scope. */
  readonly unscoped: number;
  readonly unscopedObservations: ReadonlyArray<MainObservation>;
  /** Source-qualified turn keys ([driver, instanceId, turnId]) holding a clean receipt. */
  readonly receipts: ReadonlySet<string>;
};

/**
 * Single-source source-delivery reconciliation over decoded main-turn
 * observations: identical redeliveries fold to one observation, differing
 * payloads under one delivery become conflicts kept out of every numeric
 * path, and every scoped logical turn a conflict claims is tainted — even
 * one a separate clean delivery also names. Clean claims then group by
 * positively scoped (scope, turn); missing instance/turn/conversation stays
 * unscoped. Shared so the whole-history report and the per-result
 * derivation cannot disagree about which observations are usable.
 */
export const reconcileOwnedUsageMains = (
  mains: ReadonlyArray<MainObservation>,
): OwnedUsageMainsReconciliation => {
  // Source deliveries first: identical redelivery counts once, differing
  // payloads become conflicts kept out of every numeric path.
  const mainsByDelivery = new Map<string, Array<MainObservation>>();
  for (const main of mains) {
    const group = mainsByDelivery.get(mainDeliveryKey(main.observation));
    if (group === undefined) {
      mainsByDelivery.set(mainDeliveryKey(main.observation), [main]);
    } else {
      group.push(main);
    }
  }
  const conflicts: Array<OwnedUsageConflictV1> = [];
  const clean: Array<MainObservation> = [];
  let duplicateDeliveryCount = 0;
  for (const group of mainsByDelivery.values()) {
    const first = group[0]!;
    const payloadKeys = new Map<string, MainObservation>();
    for (const main of group) {
      payloadKeys.set(stableKey(main.observation), main);
    }
    if (payloadKeys.size === 1) {
      duplicateDeliveryCount += group.length - 1;
      clean.push(first);
      continue;
    }
    conflicts.push({
      delivery: {
        driver: first.observation.source.driver,
        instanceId: first.observation.source.instanceId,
        runtimeEventId: first.observation.source.runtimeEventId,
      },
      alternatives: group.map((main) => ({
        observation: main.observation,
        observationRef: main.ref,
      })),
    });
  }

  // A conflict taints every scoped logical turn its alternatives claim: even
  // if a separate clean delivery later reports the same turn, that turn can
  // contribute no number. Each claimed target is tainted individually, so a
  // payload that changed its turn or conversation poisons both destinations.
  const taintedTurns = new Map<
    string,
    {
      scope: OwnedUsageBucketScopeV1;
      turnId: TurnId;
      alternatives: Array<OwnedTurnObservationAlternativeV1>;
    }
  >();
  for (const conflict of conflicts) {
    for (const alternative of conflict.alternatives) {
      const claim = scopedClaim(alternative.observation);
      if (claim === null) {
        continue;
      }
      const key = stableKey([claim.scopeKey, claim.turnId]);
      let tainted = taintedTurns.get(key);
      if (tainted === undefined) {
        tainted = { scope: claim.scope, turnId: claim.turnId, alternatives: [] };
        taintedTurns.set(key, tainted);
      }
      tainted.alternatives.push({
        runtimeEventId: alternative.observation.source.runtimeEventId,
        terminal: alternative.observation.terminal,
        usage: alternative.observation.usage,
        observation: alternative.observationRef,
      });
    }
  }

  // Group remaining clean observations by the exact same claim rule:
  // current incarnation + driver + instance + positively established
  // native conversation where required.
  const scopedTurns = new Map<
    string,
    {
      scope: OwnedUsageBucketScopeV1;
      scopeKey: string;
      turnId: TurnId;
      claims: Array<MainObservation>;
    }
  >();
  const unscopedObservations: Array<MainObservation> = [];
  const receipts = new Set<string>();
  let unscoped = 0;
  for (const main of clean) {
    const claim = scopedClaim(main.observation);
    if (claim === null) {
      unscoped += 1;
      unscopedObservations.push(main);
      continue;
    }
    const key = stableKey([claim.scopeKey, claim.turnId]);
    let turn = scopedTurns.get(key);
    if (turn === undefined) {
      turn = { scope: claim.scope, scopeKey: claim.scopeKey, turnId: claim.turnId, claims: [] };
      scopedTurns.set(key, turn);
    }
    turn.claims.push(main);
    receipts.add(stableKey([main.observation.source.driver, claim.scope.instanceId, claim.turnId]));
  }

  return {
    conflicts,
    clean,
    duplicateDeliveryCount,
    taintedTurns,
    scopedTurns,
    unscoped,
    unscopedObservations,
    receipts,
  };
};

/**
 * Pure reducer over retained thread events (sequence-ordered). Splits the last
 * `thread.created` incarnation from prior history, resolves source delivery
 * conflicts before grouping, taints the logical turns those conflicts claim,
 * and produces scoped buckets without a grand total. Exposed for tests;
 * `readOwnedThreadUsage` and `OwnedUsageReader` are the wired entry points.
 */
export const reduceOwnedThreadUsage = (input: {
  readonly threadId: ThreadId;
  readonly head: number;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}): OwnedThreadUsageOutcome => {
  const { threadId, head, events } = input;
  const incarnation = events.findLast((event) => event.type === "thread.created");
  if (incarnation === undefined) {
    const outcome: OwnedThreadUsageOutcome = {
      status: "missing-create",
      threadId,
      readThroughSequence: head,
    };
    return outcome;
  }

  const current = scanEvents(
    events.filter((event) => event.sequence > incarnation.sequence),
    "current",
  );
  const prior = scanEvents(
    events.filter((event) => event.sequence <= incarnation.sequence),
    "prior",
  );

  // Delivery identity, conflict detection, scope claiming and receipt
  // bookkeeping come from the shared reconciliation so the per-result
  // reducer in ownedResultUsage.ts sees the exact same resolved view.
  const reconciled = reconcileOwnedUsageMains(current.mains);
  const { conflicts, duplicateDeliveryCount, taintedTurns, unscoped, receipts } = reconciled;
  const buckets = new Map<
    string,
    {
      scope: OwnedUsageBucketScopeV1;
      subtotal: ReturnType<typeof zeroSubtotal>;
      turns: Map<TurnId, Array<MainObservation>>;
    }
  >();
  for (const turnGroup of reconciled.scopedTurns.values()) {
    let bucket = buckets.get(turnGroup.scopeKey);
    if (bucket === undefined) {
      bucket = {
        scope: turnGroup.scope,
        subtotal: zeroSubtotal(),
        turns: new Map(),
      };
      buckets.set(turnGroup.scopeKey, bucket);
    }
    bucket.turns.set(turnGroup.turnId, turnGroup.claims);
  }

  let complete = 0;
  let partial = 0;
  let unavailable = 0;
  const partialTurns: Array<OwnedPartialTurnV1> = [];
  const ambiguousTurns: Array<OwnedAmbiguousTurnV1> = [];
  for (const bucket of buckets.values()) {
    const scopeKey = stableKey([
      bucket.scope.driver,
      bucket.scope.instanceId,
      bucket.scope.nativeConversationId,
    ]);
    for (const [turnId, group] of bucket.turns) {
      const tainted = taintedTurns.get(stableKey([scopeKey, turnId]));
      if (tainted !== undefined) {
        // Conflicted turn: no number, all observations stay inspectable —
        // the clean deliveries next to the conflicting variants.
        ambiguousTurns.push({
          scope: bucket.scope,
          turnId,
          alternatives: [...group.map(toAlternative), ...tainted.alternatives],
        });
        continue;
      }
      if (group.length > 1) {
        ambiguousTurns.push({
          scope: bucket.scope,
          turnId,
          alternatives: group.map(toAlternative),
        });
        continue;
      }
      const single = group[0]!;
      const usage = single.observation.usage;
      if (usage.usageStatus === "complete") {
        complete += 1;
        bucket.subtotal.completeTurns += 1;
        bucket.subtotal.inputTokens += usage.inputTokens;
        bucket.subtotal.outputTokens += usage.outputTokens;
        if (usage.cachedInputTokens !== undefined) {
          bucket.subtotal.cachedInputTokens.sum += usage.cachedInputTokens;
          bucket.subtotal.cachedInputTokens.reportedTurns += 1;
        }
        if (usage.cacheCreationTokens !== undefined) {
          bucket.subtotal.cacheCreationTokens.sum += usage.cacheCreationTokens;
          bucket.subtotal.cacheCreationTokens.reportedTurns += 1;
        }
        if (usage.reasoningTokens !== undefined) {
          bucket.subtotal.reasoningTokens.sum += usage.reasoningTokens;
          bucket.subtotal.reasoningTokens.reportedTurns += 1;
        }
      } else if (usage.usageStatus === "partial") {
        partial += 1;
        partialTurns.push({
          scope: bucket.scope,
          turnId,
          usage,
          observation: single.ref,
        });
      } else {
        unavailable += 1;
      }
    }
  }
  const ambiguous = ambiguousTurns.length;

  // Observed session inventory without a qualifying receipt, matched on the
  // source scope the session-set actually carries (driver + instance + turn).
  let unrecorded = 0;
  for (const tuple of current.turnInventory.keys()) {
    if (!receipts.has(tuple)) {
      unrecorded += 1;
    }
  }

  // Children: compare the complete decoded claim (source stamp with its
  // phase, claimed taskId, usage) per delivery before task grouping — a
  // redelivery that changed only its phase or owner is a changed payload,
  // never a fold. Surviving frames group by claimed task identity with
  // lifetime unknown: no authoritative latest value, no child sum.
  const childrenByTask = new Map<
    string,
    {
      driver: OwnedUsageSourceV1["driver"];
      instanceId: OwnedUsageSourceV1["instanceId"];
      taskId: string;
      frames: Array<ChildFrame>;
      duplicateDeliveryCount: number;
      changedPayloadDeliveryCount: number;
    }
  >();
  for (const { group, folded } of foldChildDeliveries(current.childFrames).values()) {
    for (const frame of folded ? [group[0]!] : group) {
      const taskKey = stableKey([frame.source.driver, frame.source.instanceId, frame.taskId]);
      let child = childrenByTask.get(taskKey);
      if (child === undefined) {
        child = {
          driver: frame.source.driver,
          instanceId: frame.source.instanceId,
          taskId: frame.taskId,
          frames: [],
          duplicateDeliveryCount: 0,
          changedPayloadDeliveryCount: 0,
        };
        childrenByTask.set(taskKey, child);
      }
      child.frames.push(frame);
      // Folded deliveries keep one frame and charge the excess once; changed
      // deliveries charge each retained frame so no variant is hidden.
      if (folded) {
        child.duplicateDeliveryCount += group.length - 1;
      } else {
        child.changedPayloadDeliveryCount += 1;
      }
    }
  }
  const children = [...childrenByTask.values()].map((child) => {
    const frames = child.frames.toSorted((left, right) => left.sequence - right.sequence);
    const nonMonotonic = frames.some(
      (frame, index) => index > 0 && frame.usage.totalTokens < frames[index - 1]!.usage.totalTokens,
    );
    return {
      driver: child.driver,
      instanceId: child.instanceId,
      taskId: child.taskId,
      lifetime: "unknown" as const,
      frames: frames.map((frame): OwnedChildUsageFrameV1 => ({
        sequence: frame.sequence,
        eventId: frame.eventId,
        runtimeEventId: frame.source.runtimeEventId,
        phase: frame.source.phase,
        usage: frame.usage,
      })),
      duplicateDeliveryCount: child.duplicateDeliveryCount,
      changedPayloadDeliveryCount: child.changedPayloadDeliveryCount,
      nonMonotonic,
    };
  });

  const outcome: OwnedThreadUsageOutcome = {
    status: "ok",
    report: {
      v: 1,
      threadId,
      readThroughSequence: head,
      incarnationSequence: incarnation.sequence,
      main: {
        complete,
        partial,
        unavailable,
        conflict: conflicts.length,
        ambiguous,
        unscoped,
        unrecorded,
        invalid: current.invalid,
        priorIncarnation: prior.priorDeliveries.length,
        duplicateDeliveryCount,
        buckets: [...buckets.values()].map((bucket) => ({
          scope: bucket.scope,
          reportedCompleteSubtotal: bucket.subtotal,
        })),
        partialTurns,
        ambiguousTurns,
        conflicts,
      },
      children,
      legacyChildFrames: current.legacyChildFrames,
      parentChildOverlap: "unknown",
    },
  };
  return outcome;
};

const captureHead = Effect.fn("ownedUsage.captureHead")(function* (sql: SqlClient.SqlClient) {
  const rows =
    yield* sql`SELECT COALESCE(MAX(sequence), 0) AS "head" FROM orchestration_events`.pipe(
      Effect.mapError((cause) => new OwnedUsageStoreError({ operation: "capture head", cause })),
    );
  const head = rows[0]?.head;
  if (typeof head !== "number" || !Number.isInteger(head) || head < 0) {
    return yield* new OwnedUsageStoreError({ operation: "decode head", cause: rows[0] });
  }
  return head;
});

/**
 * One captured-head bounded read of a thread aggregate's retained events:
 * the head captured once, the stats check that bounds the replay, then the
 * replay itself. Shared between the owned-usage readers so every report is
 * derived from the same bound — `too-large` and `missing-create` short
 * circuit before any event collection.
 */
export type OwnedThreadEventWindow =
  | {
      readonly status: "ok";
      readonly head: number;
      readonly events: ReadonlyArray<OrchestrationEvent>;
    }
  | {
      readonly status: "too-large";
      readonly head: number;
      readonly eventCount: number;
      readonly payloadBytes: number;
    }
  | { readonly status: "missing-create"; readonly head: number };

export const readOwnedThreadEventWindow = (
  sql: SqlClient.SqlClient,
  store: OrchestrationEventStore["Service"],
  threadId: ThreadId,
  options?: { readonly maxEvents?: number },
): Effect.Effect<OwnedThreadEventWindow, OwnedUsageStoreError | OrchestrationEventStoreError> =>
  Effect.gen(function* () {
    const head = yield* captureHead(sql);
    const maxEvents = Math.max(1, Math.floor(options?.maxEvents ?? OWNED_USAGE_MAX_EVENTS));
    const replayRange = {
      aggregateKind: "thread" as const,
      aggregateId: threadId,
      fromSequenceExclusive: 0,
      toSequenceInclusive: head,
    };
    const stats = yield* store.getAggregateReplayStats({ ...replayRange, maxEvents });
    if (stats.eventCount > maxEvents) {
      return {
        status: "too-large" as const,
        head,
        eventCount: stats.eventCount,
        payloadBytes: stats.payloadBytes,
      };
    }
    if (!stats.hasCreateEvent) {
      return { status: "missing-create" as const, head };
    }
    const events = Array.from(
      yield* Stream.runCollect(store.readAggregateRange({ ...replayRange, limit: maxEvents })),
    );
    return { status: "ok" as const, head, events };
  });

const readWithStore = (
  sql: SqlClient.SqlClient,
  store: OrchestrationEventStore["Service"],
  threadId: ThreadId,
  options?: { readonly maxEvents?: number },
): Effect.Effect<OwnedThreadUsageOutcome, OwnedUsageStoreError | OrchestrationEventStoreError> =>
  Effect.gen(function* () {
    const window = yield* readOwnedThreadEventWindow(sql, store, threadId, options);
    if (window.status === "too-large") {
      const outcome: OwnedThreadUsageOutcome = {
        status: "too-large",
        threadId,
        readThroughSequence: window.head,
        eventCount: window.eventCount,
        payloadBytes: window.payloadBytes,
      };
      return outcome;
    }
    if (window.status === "missing-create") {
      const outcome: OwnedThreadUsageOutcome = {
        status: "missing-create",
        threadId,
        readThroughSequence: window.head,
      };
      return outcome;
    }
    return reduceOwnedThreadUsage({ threadId, head: window.head, events: window.events });
  });

/**
 * Read one thread's owned usage report through the real event store. Requires
 * `OrchestrationEventStore` and the `SqlClient` that store runs on — the
 * combination the CLI assembles over one read-only connection; tests can
 * provide both over a memory or temp-file client. `options.maxEvents`
 * overrides `OWNED_USAGE_MAX_EVENTS` for tests.
 */
export const readOwnedThreadUsage = Effect.fn("ownedUsage.readOwnedThreadUsage")(function* (
  threadId: ThreadId,
  options?: { readonly maxEvents?: number },
): Effect.fn.Return<
  OwnedThreadUsageOutcome,
  OwnedUsageStoreError | OrchestrationEventStoreError,
  OrchestrationEventStore | SqlClient.SqlClient
> {
  const store = yield* OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  return yield* readWithStore(sql, store, threadId, options);
});

/**
 * OwnedUsageReader - CLI-facing seam for the owned-usage read.
 *
 * Exists to keep the raw `SqlClient` (needed only for the captured head) out
 * of consumers' requirements: the CLI wires `OwnedUsageReaderLive` over one
 * read-only client shared with the event store and depends on this service
 * alone.
 */
export class OwnedUsageReader extends Context.Service<
  OwnedUsageReader,
  {
    readonly read: (
      threadId: ThreadId,
      options?: { readonly maxEvents?: number },
    ) => Effect.Effect<
      OwnedThreadUsageOutcome,
      OwnedUsageStoreError | OrchestrationEventStoreError
    >;
  }
>()("t3/usage/OwnedUsageReader") {}

export const OwnedUsageReaderLive = Layer.effect(
  OwnedUsageReader,
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    return OwnedUsageReader.of({
      read: (threadId, options) => readWithStore(sql, store, threadId, options),
    });
  }),
);
