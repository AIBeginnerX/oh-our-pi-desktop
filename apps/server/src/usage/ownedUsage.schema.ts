/**
 * Owned-usage shared contracts.
 *
 * Pure schemas for usage the T3 server itself observed from provider runs and
 * preserved in its own orchestration event store ("owned usage"). One owner for
 * both sides of the wire: the ingestion stamp (R1) builds these shapes into
 * retained activities, and the reader/reducer (`ownedUsage.ts`) decodes them
 * back out of retained event history. No server services, no import cycles —
 * this file only reuses existing `@t3tools/contracts` schemas
 * (`TurnTokenUsage`, `RuntimeTaskUsage`) as-is.
 *
 * Ingress contract (what R1 must record):
 * 1. Main-turn observations — when a provider runtime `turn.completed` /
 *    `turn.aborted` event carries `tokenUsage`, append one
 *    `thread.activity-appended` activity with:
 *      - `kind` = `OWNED_USAGE_ACTIVITY_KIND` ("owned-usage")
 *      - `id` = `owned-usage:${threadId}:${runtimeEventId}` (unique per source
 *        delivery, so projection folds cannot hide a redelivery in history)
 *      - `turnId` = the runtime event's turn id, or null when the terminal
 *        carried none (a null turn is a valid unscoped case, never rejected)
 *      - `payload` = `OwnedTurnUsageObservationV1`
 * 2. Child (subagent) frames — existing `task.progress` / `task.completed`
 *    activities that carry `typedUsage` additionally carry
 *    `usageSource: OwnedUsageSourceV1` (driver/instance/runtimeEventId/phase).
 *    Rows without the stamp remain legacy: the reader counts them but cannot
 *    attribute them.
 *
 * Trust boundary: these schemas describe server-observed reports from provider
 * adapters, not independently verified billing. Numbers are sums of accepted
 * adapter reports within the declared scope only.
 *
 * Reader contract (`ownedUsage.ts`): `readOwnedThreadUsage(threadId)` returns
 * an `OwnedThreadUsageOutcome` — `reduceOwnedThreadUsage` is the pure reducer
 * over retained events, so tests can drive it without a database.
 *
 * @module ownedUsage.schema
 */
import {
  EventId,
  NonNegativeInt,
  OwnedUsageBucketScopeV1,
  OwnedMainUsageBucketV1,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskUsage,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Activity kind carrying a `OwnedTurnUsageObservationV1` payload. The
 * contracts-side constant for `SERVER_RECORD_ACTIVITY_KINDS` (R1) must equal
 * this exact string; the reader dispatches on it.
 *
 * Parent integration note (one line, until R1 terminals): once
 * `@t3tools/contracts` exports the constant, replace this literal with that
 * import — this lane does not edit contracts.
 */
export {
  OWNED_USAGE_ACTIVITY_KIND,
  OwnedCompleteUsageSubtotalV1,
  OwnedUsageBucketScopeV1,
  OwnedMainUsageBucketV1,
} from "@t3tools/contracts";

/** Which ingestion row stamped a child usage frame. */
export const OwnedUsagePhase = Schema.Literals(["progress", "completed"]);
export type OwnedUsagePhase = typeof OwnedUsagePhase.Type;

/**
 * Provenance stamp R1 adds to `task.progress` / `task.completed` activities
 * whose payload carries `typedUsage`. `runtimeEventId` is the provider runtime
 * event id, so a redelivery of the same source event is recognizable and
 * counted once. Rows without this stamp are legacy and are only counted.
 */
export const OwnedUsageSourceV1 = Schema.Struct({
  v: Schema.Literal(1),
  driver: ProviderDriverKind,
  instanceId: Schema.NullOr(ProviderInstanceId),
  runtimeEventId: EventId,
  phase: OwnedUsagePhase,
});
export type OwnedUsageSourceV1 = typeof OwnedUsageSourceV1.Type;

/**
 * Drivers whose live main-turn identity is a server-adapter-generated turn id
 * (Claude/OpenCode adapters mint the turn UUID at acceptance), so a turn
 * observation scopes cleanly by driver + instance without a native session id.
 * Any other driver must carry a positively established
 * `nativeConversationId` to enter a bucket; without one its observation is
 * unscoped — never grouped into a shared null-conversation bucket.
 */
export const OWNED_LIVE_TURN_IDENTITY_DRIVERS = ["claudeAgent", "opencode"] as const;

/**
 * How a main turn ended: the runtime turn state, or "aborted" for
 * `turn.aborted` terminals (which carry no runtime state).
 */
export const OwnedTurnTerminal = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "aborted",
]);
export type OwnedTurnTerminal = typeof OwnedTurnTerminal.Type;

/**
 * One main-turn usage observation as recorded by ingestion. `usage` is the
 * adapter's `TurnTokenUsage` verbatim — missing optional fields stay missing
 * and are excluded from reported coverage rather than read as zero.
 */
export const OwnedTurnUsageObservationV1 = Schema.Struct({
  v: Schema.Literal(1),
  scope: Schema.Literal("main-turn"),
  source: Schema.Struct({
    driver: ProviderDriverKind,
    instanceId: Schema.NullOr(ProviderInstanceId),
    /** Null when the terminal event named no turn: kept as unscoped. */
    turnId: Schema.NullOr(TurnId),
    runtimeEventId: EventId,
    /**
     * Positively established provider conversation id (today only Codex via
     * `turn/completed`). Null means "not established", not "no conversation".
     */
    nativeConversationId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  terminal: OwnedTurnTerminal,
  usage: TurnTokenUsage,
});
export type OwnedTurnUsageObservationV1 = typeof OwnedTurnUsageObservationV1.Type;

/** Where in the orchestration event history an observation was found. */
export const OwnedUsageObservationRefV1 = Schema.Struct({
  /** Orchestration event sequence (the observation's store position). */
  sequence: NonNegativeInt,
  /** Orchestration event id. */
  eventId: EventId,
});
export type OwnedUsageObservationRefV1 = typeof OwnedUsageObservationRefV1.Type;

/** A partial turn kept outside every complete subtotal. */
export const OwnedPartialTurnV1 = Schema.Struct({
  scope: OwnedUsageBucketScopeV1,
  turnId: TurnId,
  usage: TurnTokenUsage,
  observation: OwnedUsageObservationRefV1,
});
export type OwnedPartialTurnV1 = typeof OwnedPartialTurnV1.Type;

/** One accepted observation inside an ambiguous or conflicting turn. */
export const OwnedTurnObservationAlternativeV1 = Schema.Struct({
  runtimeEventId: EventId,
  terminal: OwnedTurnTerminal,
  usage: TurnTokenUsage,
  observation: OwnedUsageObservationRefV1,
});
export type OwnedTurnObservationAlternativeV1 = typeof OwnedTurnObservationAlternativeV1.Type;

/**
 * A scoped turn observed through two or distinct source deliveries
 * (different `runtimeEventId`s). Alternatives are preserved verbatim and
 * never merged or summed; a late "unavailable" does not erase an earlier
 * observation.
 */
export const OwnedAmbiguousTurnV1 = Schema.Struct({
  scope: OwnedUsageBucketScopeV1,
  turnId: TurnId,
  alternatives: Schema.Array(OwnedTurnObservationAlternativeV1),
});
export type OwnedAmbiguousTurnV1 = typeof OwnedAmbiguousTurnV1.Type;

/**
 * The scoped source delivery identity of one observation: driver + instance +
 * provider runtime event id within the current incarnation. Repeated
 * deliveries of one runtime event are detected here, before turn grouping, so
 * a payload that changes its turnId or conversation cannot evade conflict
 * detection by moving to another group.
 */
export const OwnedUsageDeliveryV1 = Schema.Struct({
  driver: ProviderDriverKind,
  instanceId: Schema.NullOr(ProviderInstanceId),
  runtimeEventId: EventId,
});
export type OwnedUsageDeliveryV1 = typeof OwnedUsageDeliveryV1.Type;

/**
 * One source delivery seen with differing payloads (compared as the entire
 * observation, including claimed owner/turn/conversation/terminal/usage).
 * Every retained variant is listed; none is summed.
 */
export const OwnedUsageConflictV1 = Schema.Struct({
  delivery: OwnedUsageDeliveryV1,
  alternatives: Schema.Array(
    Schema.Struct({
      observation: OwnedTurnUsageObservationV1,
      observationRef: OwnedUsageObservationRefV1,
    }),
  ),
});
export type OwnedUsageConflictV1 = typeof OwnedUsageConflictV1.Type;

/** One retained child usage frame with its store position. */
export const OwnedChildUsageFrameV1 = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  runtimeEventId: EventId,
  phase: OwnedUsagePhase,
  usage: RuntimeTaskUsage,
});
export type OwnedChildUsageFrameV1 = typeof OwnedChildUsageFrameV1.Type;

/**
 * Child (subagent) usage observations grouped by claimed
 * driver/instance/taskId. The claimed key can span runtime/session lifetimes
 * and `usageSource` carries no lifetime identity, so the group is explicitly
 * `lifetime: "unknown"`: frames are source-stamped, sequence-ordered
 * observations, not a resolved child. There is deliberately no authoritative
 * `latest` value and no summed child usage. `nonMonotonic` is a statement
 * about this ambiguous sequence only (some frame's totalTokens is lower than
 * an earlier frame's); `duplicateDeliveryCount` folds identical redeliveries,
 * `changedPayloadDeliveryCount` counts retained frames from a delivery whose
 * phase or usage differed.
 */
export const OwnedChildUsageGroupV1 = Schema.Struct({
  driver: ProviderDriverKind,
  instanceId: Schema.NullOr(ProviderInstanceId),
  taskId: TrimmedNonEmptyString,
  lifetime: Schema.Literal("unknown"),
  frames: Schema.Array(OwnedChildUsageFrameV1),
  duplicateDeliveryCount: NonNegativeInt,
  changedPayloadDeliveryCount: NonNegativeInt,
  nonMonotonic: Schema.Boolean,
});
export type OwnedChildUsageGroupV1 = typeof OwnedChildUsageGroupV1.Type;

/**
 * Main-turn accounting for the current incarnation. Counts are coverage, not
 * totals: `complete`/`partial`/`unavailable`/`ambiguous` count scoped turn
 * groups; `conflict` counts source deliveries with differing payloads;
 * `unscoped` counts observations that could not be bucketed (missing turn id,
 * missing instance id, or a driver without an established native
 * conversation); `unrecorded` counts session-set active-turn inventory entries
 * without a qualifying receipt in the matching source scope (an observed
 * inventory, not proof every turn was seen); `invalid` counts current-
 * incarnation usage-bearing records whose payload failed schema decode
 * (earlier-incarnation failures count once each under `priorIncarnation`);
 * `duplicateDeliveryCount`
 * folds identical source redeliveries. Numeric sums exist only inside
 * `buckets` — there is no grand main total.
 */
export const OwnedMainUsageSummaryV1 = Schema.Struct({
  complete: NonNegativeInt,
  partial: NonNegativeInt,
  unavailable: NonNegativeInt,
  conflict: NonNegativeInt,
  ambiguous: NonNegativeInt,
  unscoped: NonNegativeInt,
  unrecorded: NonNegativeInt,
  invalid: NonNegativeInt,
  /**
   * Delivery-unique usage records retained before the last creation in the
   * read range. Rows without decodable identity (legacy or undecodable) count
   * once each, so earlier coverage stays visible without entering any current
   * counter.
   */
  priorIncarnation: NonNegativeInt,
  duplicateDeliveryCount: NonNegativeInt,
  buckets: Schema.Array(OwnedMainUsageBucketV1),
  partialTurns: Schema.Array(OwnedPartialTurnV1),
  ambiguousTurns: Schema.Array(OwnedAmbiguousTurnV1),
  conflicts: Schema.Array(OwnedUsageConflictV1),
});
export type OwnedMainUsageSummaryV1 = typeof OwnedMainUsageSummaryV1.Type;

/**
 * Report for a readable thread history. `incarnationSequence` is the last
 * `thread.created` in the read range; everything counted here follows it.
 * `parentChildOverlap` is honestly unknown: main-turn and child usage are
 * distinct populations whose disjointness is not established, so no
 * main+child sum exists anywhere in this report.
 */
export const OwnedThreadUsageReportV1 = Schema.Struct({
  v: Schema.Literal(1),
  threadId: ThreadId,
  /** Global event head captured before reading; later appends are excluded. */
  readThroughSequence: NonNegativeInt,
  incarnationSequence: NonNegativeInt,
  main: OwnedMainUsageSummaryV1,
  children: Schema.Array(OwnedChildUsageGroupV1),
  /**
   * Child usage rows without a `usageSource` stamp in the current incarnation;
   * counted, not attributed. Earlier-incarnation rows count under
   * `priorIncarnation` instead.
   */
  legacyChildFrames: NonNegativeInt,
  parentChildOverlap: Schema.Literal("unknown"),
});
export type OwnedThreadUsageReportV1 = typeof OwnedThreadUsageReportV1.Type;

/**
 * Result of reading one thread's owned usage. A discriminated union on
 * purpose: "no thread creation in history" and "history too large to read"
 * carry no numeric result at all — no-data is not zero usage.
 */
export const OwnedThreadUsageOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    report: OwnedThreadUsageReportV1,
  }),
  Schema.Struct({
    status: Schema.Literal("missing-create"),
    threadId: ThreadId,
    readThroughSequence: NonNegativeInt,
  }),
  Schema.Struct({
    status: Schema.Literal("too-large"),
    threadId: ThreadId,
    readThroughSequence: NonNegativeInt,
    /** Event count seen by the bounded stats read (at most maxEvents + 1). */
    eventCount: NonNegativeInt,
    payloadBytes: NonNegativeInt,
  }),
]);
export type OwnedThreadUsageOutcome = typeof OwnedThreadUsageOutcome.Type;
