import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EventId, ThreadId } from "./baseSchemas.ts";
import {
  OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
  OwnedCompleteUsageSubtotalV1,
  OwnedMainUsageBucketV1,
  OwnedResultUsageOutcome,
  OwnedResultUsageReadError,
  OwnedResultUsageV1,
  OwnedUsageBucketScopeV1,
} from "./ownedUsage.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const threadId = ThreadId.make("thread-1");
const eventId = EventId.make("evt-final-1");

const emptySubtotal = {
  completeTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: { sum: 0, reportedTurns: 0 },
  cacheCreationTokens: { sum: 0, reportedTurns: 0 },
  reasoningTokens: { sum: 0, reportedTurns: 0 },
};

const emptyCoverage = {
  complete: 0,
  partial: 0,
  unavailable: 0,
  ambiguous: 0,
  conflictTainted: 0,
  unscoped: 0,
  unrecorded: 0,
  lateUnattributed: 0,
};

const measuredBucket = Schema.decodeUnknownSync(OwnedMainUsageBucketV1)({
  scope: Schema.decodeUnknownSync(OwnedUsageBucketScopeV1)({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("inst-1"),
    nativeConversationId: null,
  }),
  reportedCompleteSubtotal: Schema.decodeUnknownSync(OwnedCompleteUsageSubtotalV1)(emptySubtotal),
});

const measuredUsage = {
  status: "measured" as const,
  coverage: emptyCoverage,
  buckets: [measuredBucket],
  childFrames: 0,
  legacyChildFrames: 0,
};

const validResultRow = {
  attemptId: "attempt-1",
  revision: 2,
  finalEventId: eventId,
  finalSequence: 120,
  anchorSequence: 40,
  segment: { fromSequenceExclusive: 30, toSequenceExclusive: 40 },
  inputs: 1,
  otherAttempts: 0,
  recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
  checksMs: 15_000,
  usage: measuredUsage,
  billedCost: "unknown" as const,
  parentChildOverlap: "unknown" as const,
};

const validOkOutcome = {
  status: "ok" as const,
  threadId,
  readThroughSequence: 200,
  incarnationSequence: 10,
  barriers: { malformedReceipts: 0, invalidWindows: 0 },
  results: [validResultRow],
  trailing: { inputs: 0, otherAttempts: 0, coverage: emptyCoverage },
};

describe("OwnedResultUsageOutcome", () => {
  const decodeOutcome = Schema.decodeUnknownExit(OwnedResultUsageOutcome);
  const decodeRow = Schema.decodeUnknownExit(OwnedResultUsageV1);

  it("accepts a measured ok outcome with full row identity", () => {
    const decoded = decodeOutcome(validOkOutcome);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded) && decoded.value.status === "ok") {
      expect(decoded.value.results[0]?.attemptId).toBe("attempt-1");
      expect(decoded.value.results[0]?.recordedSpan.recordedSpanMs).toBeNull();
    }
  });

  it("accepts ok with barrier counts only when identity is not representable as a row", () => {
    const decoded = decodeOutcome({
      ...validOkOutcome,
      barriers: { malformedReceipts: 2, invalidWindows: 0 },
      results: [],
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded) && decoded.value.status === "ok") {
      expect(decoded.value.results).toEqual([]);
      expect(decoded.value.barriers.malformedReceipts).toBe(2);
    }
  });

  it("accepts missing-create and too-large without inventing usage numbers", () => {
    expect(
      Exit.isSuccess(
        decodeOutcome({
          status: "missing-create",
          threadId,
          readThroughSequence: 0,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeOutcome({
          status: "too-large",
          threadId,
          readThroughSequence: 50,
          eventCount: 100_001,
          payloadBytes: 9_999,
        }),
      ),
    ).toBe(true);
  });

  it("rejects malformed shapes and rows without required identity", () => {
    expect(Exit.isSuccess(decodeOutcome({ status: "ok", threadId }))).toBe(false);
    expect(
      Exit.isSuccess(
        decodeRow({
          ...validResultRow,
          usage: {
            status: "measured",
            coverage: emptyCoverage,
            buckets: [],
            childFrames: -1,
            legacyChildFrames: 0,
          },
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeRow({
          attemptId: null,
          revision: null,
          finalEventId: null,
          finalSequence: null,
          anchorSequence: null,
          segment: null,
          inputs: 0,
          otherAttempts: 0,
          recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
          checksMs: null,
          usage: { status: "unmeasurable", reason: "invalid-receipt-or-window" },
          billedCost: "unknown",
          parentChildOverlap: "unknown",
        }),
      ),
    ).toBe(false);
  });

  it("allows null checksMs and recordedSpanMs for invalid-window unmeasurable rows", () => {
    const decoded = decodeRow({
      ...validResultRow,
      anchorSequence: null,
      segment: null,
      checksMs: null,
      recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
      usage: {
        status: "unmeasurable",
        reason: "invalid-receipt-or-window",
      },
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("rejects non-null time fields for revision-conflict and invalid-receipt-or-window", () => {
    for (const reason of ["revision-conflict", "invalid-receipt-or-window"] as const) {
      expect(
        Exit.isSuccess(
          decodeRow({
            ...validResultRow,
            anchorSequence: null,
            segment: null,
            checksMs: 1,
            recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
            usage: { status: "unmeasurable", reason },
          }),
        ),
      ).toBe(false);
      expect(
        Exit.isSuccess(
          decodeRow({
            ...validResultRow,
            anchorSequence: null,
            segment: null,
            checksMs: null,
            recordedSpan: { recordedSpanMs: 1, timeBasis: "recorded-event-timestamps" },
            usage: { status: "unmeasurable", reason },
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects inconsistent window bounds on the wire", () => {
    expect(
      Exit.isSuccess(
        decodeRow({
          ...validResultRow,
          segment: { fromSequenceExclusive: 50, toSequenceExclusive: 40 },
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeRow({
          ...validResultRow,
          anchorSequence: 41,
          segment: { fromSequenceExclusive: 30, toSequenceExclusive: 40 },
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeOutcome({
          ...validOkOutcome,
          results: [{ ...validResultRow, finalSequence: 5 }],
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeOutcome({
          ...validOkOutcome,
          readThroughSequence: 100,
          results: [{ ...validResultRow, finalSequence: 120 }],
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeRow({
          ...validResultRow,
          anchorSequence: null,
          segment: { fromSequenceExclusive: 30, toSequenceExclusive: 999 },
          usage: { status: "unmeasurable", reason: "invalid-receipt-or-window" },
          checksMs: null,
        }),
      ),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeOutcome({
          ...validOkOutcome,
          results: [
            validResultRow,
            {
              ...validResultRow,
              attemptId: "attempt-2",
              finalEventId: EventId.make("evt-final-2"),
              finalSequence: 20,
              anchorSequence: null,
              segment: null,
              usage: {
                status: "unmeasurable",
                reason: "invalid-receipt-or-window",
              },
              checksMs: null,
              recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
            },
            {
              ...validResultRow,
              attemptId: "attempt-3",
              finalEventId: EventId.make("evt-final-3"),
              finalSequence: 180,
              anchorSequence: 80,
              segment: { fromSequenceExclusive: 30, toSequenceExclusive: 80 },
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("owned usage bucket schemas (baseline)", () => {
  it("keeps moved bucket semantics decodable", () => {
    const scope = Schema.decodeUnknownSync(OwnedUsageBucketScopeV1)({
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("i"),
      nativeConversationId: null,
    });
    const subtotal = Schema.decodeUnknownSync(OwnedCompleteUsageSubtotalV1)(emptySubtotal);
    const bucket = Schema.decodeUnknownSync(OwnedMainUsageBucketV1)({
      scope,
      reportedCompleteSubtotal: subtotal,
    });
    expect(bucket.reportedCompleteSubtotal.cachedInputTokens.reportedTurns).toBe(0);
  });
});

describe("OwnedResultUsageReadError", () => {
  it("exposes only closed reason and fixed detail on the wire", () => {
    const err = new OwnedResultUsageReadError({
      reason: "scanFailed",
      detail: OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
    });
    expect(err._tag).toBe("OwnedResultUsageReadError");
    expect(err.reason).toBe("scanFailed");
    expect(err.message).toContain(OWNED_RESULT_USAGE_READ_ERROR_DETAIL);
    expect(Object.hasOwn(err, "cause")).toBe(false);
    const encoded = Schema.encodeSync(OwnedResultUsageReadError)(err);
    expect(encoded).toEqual({
      _tag: "OwnedResultUsageReadError",
      reason: "scanFailed",
      detail: OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
    });
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(OwnedResultUsageReadError)({
          _tag: "OwnedResultUsageReadError",
          reason: "scanFailed",
          detail: "leaked internal database text",
        }),
      ),
    ).toBe(false);
  });
});
