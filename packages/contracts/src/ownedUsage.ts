import * as Schema from "effect/Schema";
import { EventId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Adapter-reported complete usage summed over deduplicated single
 * observations inside one bucket. Cache dimensions only accumulate over turns
 * that actually reported them (`reportedTurns`); absence never contributes a
 * zero. This is "what complete adapter receipts in this scope claimed", not a
 * verified thread total.
 */
export const OwnedCompleteUsageSubtotalV1 = Schema.Struct({
  completeTurns: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: Schema.Struct({
    sum: NonNegativeInt,
    reportedTurns: NonNegativeInt,
  }),
  cacheCreationTokens: Schema.Struct({
    sum: NonNegativeInt,
    reportedTurns: NonNegativeInt,
  }),
  reasoningTokens: Schema.Struct({
    sum: NonNegativeInt,
    reportedTurns: NonNegativeInt,
  }),
});
export type OwnedCompleteUsageSubtotalV1 = typeof OwnedCompleteUsageSubtotalV1.Type;

/**
 * Scope of one numeric bucket: driver + instance + positively established
 * native conversation. `nativeConversationId: null` appears only for
 * `OWNED_LIVE_TURN_IDENTITY_DRIVERS`, whose turns are identified by their
 * server-generated turn ids. All buckets sit inside the current thread
 * incarnation; the incarnation itself is not a dimension. There is
 * deliberately no grand total across buckets — their relationship (one
 * conversation seen through two instances, for example) is unknown.
 */
export const OwnedUsageBucketScopeV1 = Schema.Struct({
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  nativeConversationId: Schema.NullOr(TrimmedNonEmptyString),
});
export type OwnedUsageBucketScopeV1 = typeof OwnedUsageBucketScopeV1.Type;

/** A bucket of reported-complete numbers plus the observations behind it. */
export const OwnedMainUsageBucketV1 = Schema.Struct({
  scope: OwnedUsageBucketScopeV1,
  reportedCompleteSubtotal: OwnedCompleteUsageSubtotalV1,
});
export type OwnedMainUsageBucketV1 = typeof OwnedMainUsageBucketV1.Type;

/** Selected-check attempt id as written on receipts (max 64 chars). */
const OwnedResultAttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * Turn-coverage counts for one result window or trailing tail. Counts only —
 * no bucket sums, no cross-result totals.
 */
export const OwnedResultCoverageV1 = Schema.Struct({
  complete: NonNegativeInt,
  partial: NonNegativeInt,
  unavailable: NonNegativeInt,
  ambiguous: NonNegativeInt,
  conflictTainted: NonNegativeInt,
  unscoped: NonNegativeInt,
  unrecorded: NonNegativeInt,
  /** Usage observations retained after their work segment without attribution. */
  lateUnattributed: NonNegativeInt,
});
export type OwnedResultCoverageV1 = typeof OwnedResultCoverageV1.Type;

/**
 * Report-level barrier coverage for receipts/windows that cannot become a
 * numeric result row (no fabricated `attemptId`).
 */
export const OwnedResultBarrierCoverageV1 = Schema.Struct({
  malformedReceipts: NonNegativeInt,
  invalidWindows: NonNegativeInt,
});
export type OwnedResultBarrierCoverageV1 = typeof OwnedResultBarrierCoverageV1.Type;

/** Strict sequence bounds for a trustworthy work segment between results. */
export const OwnedResultUsageSegmentV1 = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  toSequenceExclusive: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (segment) =>
      segment.fromSequenceExclusive < segment.toSequenceExclusive ||
      "segment bounds must be strictly increasing",
  ),
);
export type OwnedResultUsageSegmentV1 = typeof OwnedResultUsageSegmentV1.Type;

/**
 * Weak elapsed hint from recorded event timestamps only — not active execution
 * time or verified server wall-clock duration.
 */
export const OwnedResultRecordedSpanV1 = Schema.Struct({
  recordedSpanMs: Schema.NullOr(NonNegativeInt),
  timeBasis: Schema.Literal("recorded-event-timestamps"),
});
export type OwnedResultRecordedSpanV1 = typeof OwnedResultRecordedSpanV1.Type;

export const OwnedResultUnmeasurableReason = Schema.Literals([
  "activity-during-attempt",
  "turn-active-at-attempt",
  "revision-conflict",
  "invalid-receipt-or-window",
  "unresolved-ownership-or-history",
]);
export type OwnedResultUnmeasurableReason = typeof OwnedResultUnmeasurableReason.Type;

export const OwnedResultUsageMeasuredV1 = Schema.Struct({
  status: Schema.Literal("measured"),
  coverage: OwnedResultCoverageV1,
  buckets: Schema.Array(OwnedMainUsageBucketV1),
  childFrames: NonNegativeInt,
  legacyChildFrames: NonNegativeInt,
});
export type OwnedResultUsageMeasuredV1 = typeof OwnedResultUsageMeasuredV1.Type;

export const OwnedResultUsageUnmeasurableV1 = Schema.Struct({
  status: Schema.Literal("unmeasurable"),
  reason: OwnedResultUnmeasurableReason,
});
export type OwnedResultUsageUnmeasurableV1 = typeof OwnedResultUsageUnmeasurableV1.Type;

export const OwnedResultUsageBodyV1 = Schema.Union([
  OwnedResultUsageMeasuredV1,
  OwnedResultUsageUnmeasurableV1,
]);
export type OwnedResultUsageBodyV1 = typeof OwnedResultUsageBodyV1.Type;

const ownedResultConflictOrInvalidWindowReasons = new Set([
  "revision-conflict",
  "invalid-receipt-or-window",
]);

const ownedResultRowWireConsistencyFilter = Schema.makeFilter(
  (row: {
    attemptId: string;
    revision: number;
    finalEventId: string;
    finalSequence: number;
    anchorSequence: number | null;
    segment: OwnedResultUsageSegmentV1 | null;
    recordedSpan: OwnedResultRecordedSpanV1;
    checksMs: number | null;
    usage: OwnedResultUsageBodyV1;
  }) => {
    if (
      row.usage.status === "unmeasurable" &&
      ownedResultConflictOrInvalidWindowReasons.has(row.usage.reason)
    ) {
      if (row.checksMs !== null) {
        return "checksMs must be absent for conflicted or invalid-window rows";
      }
      if (row.recordedSpan.recordedSpanMs !== null) {
        return "recordedSpanMs must be absent for conflicted or invalid-window rows";
      }
    }

    if (row.anchorSequence !== null && row.anchorSequence > row.finalSequence) {
      return "anchor must not follow the final receipt write";
    }

    if (row.segment !== null) {
      if (row.anchorSequence === null) {
        return "segment requires anchorSequence";
      }
      if (row.segment.toSequenceExclusive !== row.anchorSequence) {
        return "segment upper bound must equal anchorSequence";
      }
    }

    if (row.usage.status === "measured") {
      if (row.anchorSequence === null || row.segment === null) {
        return "measured rows require anchorSequence and segment";
      }
    }

    return true;
  },
);

/**
 * One selected-check-pass result row. Malformed receipts without decodable
 * identity belong in `barriers` only. `anchorSequence` / `segment` may be
 * omitted for a known-identity invalid boundary.
 */
export const OwnedResultUsageV1 = Schema.Struct({
  attemptId: OwnedResultAttemptId,
  revision: NonNegativeInt,
  finalEventId: EventId,
  finalSequence: NonNegativeInt,
  anchorSequence: Schema.NullOr(NonNegativeInt),
  segment: Schema.NullOr(OwnedResultUsageSegmentV1),
  inputs: NonNegativeInt,
  otherAttempts: NonNegativeInt,
  recordedSpan: OwnedResultRecordedSpanV1,
  checksMs: Schema.NullOr(NonNegativeInt),
  usage: OwnedResultUsageBodyV1,
  billedCost: Schema.Literal("unknown"),
  parentChildOverlap: Schema.Literal("unknown"),
}).check(ownedResultRowWireConsistencyFilter);
export type OwnedResultUsageV1 = typeof OwnedResultUsageV1.Type;

const ownedResultOkOutcomeWireConsistencyFilter = Schema.makeFilter(
  (outcome: {
    status: "ok";
    readThroughSequence: number;
    incarnationSequence: number;
    results: ReadonlyArray<OwnedResultUsageV1>;
  }) => {
    if (outcome.incarnationSequence > outcome.readThroughSequence) {
      return "incarnationSequence must not exceed readThroughSequence";
    }

    let previousFinal: number | undefined;

    for (const row of outcome.results) {
      if (row.finalSequence <= outcome.incarnationSequence) {
        return "finalSequence must follow incarnationSequence";
      }
      if (row.finalSequence > outcome.readThroughSequence) {
        return "finalSequence must not exceed readThroughSequence";
      }
      if (previousFinal !== undefined && row.finalSequence <= previousFinal) {
        return "finalSequence must strictly increase across results";
      }
      if (row.anchorSequence !== null && row.anchorSequence <= outcome.incarnationSequence) {
        return "anchorSequence must follow incarnationSequence";
      }
      if (row.segment !== null && row.segment.fromSequenceExclusive < outcome.incarnationSequence) {
        return "segment must not start before incarnationSequence";
      }
      if (row.segment !== null && previousFinal !== undefined) {
        if (row.segment.fromSequenceExclusive < previousFinal) {
          return "segment must not overlap a prior result final write";
        }
      }

      previousFinal = row.finalSequence;
    }

    return true;
  },
);

/** Activity after the last passed result — counts only, no usage buckets. */
export const OwnedResultUsageTrailingV1 = Schema.Struct({
  inputs: NonNegativeInt,
  otherAttempts: NonNegativeInt,
  coverage: OwnedResultCoverageV1,
});
export type OwnedResultUsageTrailingV1 = typeof OwnedResultUsageTrailingV1.Type;

export const OwnedResultUsageInput = Schema.Struct({
  threadId: ThreadId,
});
export type OwnedResultUsageInput = typeof OwnedResultUsageInput.Type;

const OwnedResultUsageOkOutcome = Schema.Struct({
  status: Schema.Literal("ok"),
  threadId: ThreadId,
  readThroughSequence: NonNegativeInt,
  incarnationSequence: NonNegativeInt,
  barriers: OwnedResultBarrierCoverageV1,
  results: Schema.Array(OwnedResultUsageV1),
  trailing: OwnedResultUsageTrailingV1,
}).check(ownedResultOkOutcomeWireConsistencyFilter);

export const OwnedResultUsageOutcome = Schema.Union([
  OwnedResultUsageOkOutcome,
  Schema.Struct({
    status: Schema.Literal("missing-create"),
    threadId: ThreadId,
    readThroughSequence: NonNegativeInt,
  }),
  Schema.Struct({
    status: Schema.Literal("too-large"),
    threadId: ThreadId,
    readThroughSequence: NonNegativeInt,
    eventCount: NonNegativeInt,
    payloadBytes: NonNegativeInt,
  }),
]);
export type OwnedResultUsageOutcome = typeof OwnedResultUsageOutcome.Type;

/** Fixed client-visible detail for owned result usage read failures. */
export const OWNED_RESULT_USAGE_READ_ERROR_DETAIL = "Could not read thread history." as const;

/**
 * Bounded, client-safe failure for owned result usage reads. No `cause` or
 * extra payload — persistence failures map to the fixed detail constant.
 */
export class OwnedResultUsageReadError extends Schema.TaggedError<OwnedResultUsageReadError>()(
  "OwnedResultUsageReadError",
  {
    reason: Schema.Literals(["scanFailed"]),
    detail: Schema.Literal(OWNED_RESULT_USAGE_READ_ERROR_DETAIL),
  },
) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${OWNED_RESULT_USAGE_READ_ERROR_DETAIL}`;
  }
}
