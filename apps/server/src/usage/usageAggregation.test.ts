import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
      fastMultiplier: 1,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    fast: false,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("requires exact bounds for hourly aggregation", () => {
    expect(
      () =>
        new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          resolution: "hour",
          rates,
        }),
    ).toThrow("requires exact time bounds");
  });

  it("keeps only the first record for a repeated dedupe key", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.duplicatesDropped).toBe(0);
    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("keeps daily payloads collapsed when hourly resolution is not requested", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-08-07T04:05:13.944Z") }),
      record({ timestampMs: Date.parse("2026-08-07T05:05:13.944Z") }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.hourStart).toBeUndefined();
    expect(result.buckets[0]?.records).toBe(2);
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("always reports unvalued cached tokens, including zero when every record has a rate", () => {
    const bucket = aggregate([record()]).buckets[0];

    // 1000 * (1e-5 - 1e-6)
    expect(bucket?.cacheSavingsUsd).toBeCloseTo(0.009, 9);
    expect(bucket?.unvaluedCachedInputTokens).toBe(0);
  });

  it("counts cached tokens with no rate as unvalued once, with or without a reported cost", () => {
    for (const reportedCostUsd of [null, 1.25]) {
      const result = aggregate([
        record({ model: "kimi-k3", reportedCostUsd, dedupeKey: "msg_1:" }),
        record({ model: "kimi-k3", reportedCostUsd, dedupeKey: "msg_1:" }),
      ]);

      expect(result.buckets[0]?.cacheSavingsUsd).toBe(0);
      expect(result.buckets[0]?.unvaluedCachedInputTokens).toBe(1000);
      expect(result.buckets[0]?.costUsd).toBe(reportedCostUsd ?? 0);
    }
  });

  it("values savings only from rated records in a mixed bucket", () => {
    const result = aggregate([
      record({ model: "kimi-k3", rateModel: "claude-fable-5" }),
      record({ model: "kimi-k3", totals: { ...record().totals, cachedInputTokens: 400 } }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.cacheSavingsUsd).toBeCloseTo(0.009, 9);
    expect(result.buckets[0]?.unvaluedCachedInputTokens).toBe(400);
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
  });

  it("treats a rate without a cache-read discount as zero savings, not unvalued", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates: new Map([
        [
          "flat-model",
          {
            inputCostPerToken: 1e-5,
            outputCostPerToken: 5e-5,
            cacheReadCostPerToken: 1e-5,
            cacheCreationCostPerToken: 1e-5,
            fastMultiplier: 1,
          },
        ],
      ]),
    });
    aggregator.add(record({ model: "flat-model" }));

    const bucket = aggregator.finish().buckets[0];
    expect(bucket?.cacheSavingsUsd).toBe(0);
    expect(bucket?.unvaluedCachedInputTokens).toBe(0);
  });

  it("counts records whose provider reported each cache figure, zero included", () => {
    const bucket = aggregate([
      record({ cacheReport: { read: true, write: false } }),
      record({ dedupeKey: "msg_2:", cacheReport: { read: false, write: false } }),
    ]).buckets[0];

    expect(bucket?.records).toBe(2);
    expect(bucket?.cacheReadReportedRecords).toBe(1);
    expect(bucket?.cacheWriteReportedRecords).toBe(0);
  });

  it("omits both coverage fields when any record predates reporting", () => {
    const bucket = aggregate([
      record(),
      record({ dedupeKey: "msg_2:", cacheReport: { read: true, write: false } }),
    ]).buckets[0];

    expect(bucket?.records).toBe(2);
    expect(bucket?.cacheReadReportedRecords).toBeUndefined();
    expect(bucket?.cacheWriteReportedRecords).toBeUndefined();

    // Coverage detail is all that is lost; the usage itself is unchanged.
    const known = aggregate([
      record({ cacheReport: { read: false, write: false } }),
      record({ dedupeKey: "msg_2:", cacheReport: { read: true, write: false } }),
    ]).buckets[0];
    expect(bucket?.totals).toEqual(known?.totals);
    expect(bucket?.costUsd).toBe(known?.costUsd);
  });

  it("decides coverage per bucket, so old history does not hide new records", () => {
    const [day1, day2] = aggregate([
      record({ timestampMs: Date.parse("2026-08-01T10:00:00Z") }),
      record({
        timestampMs: Date.parse("2026-08-02T10:00:00Z"),
        cacheReport: { read: true, write: true },
      }),
    ]).buckets;

    expect(day1?.day).toBe("2026-08-01");
    expect(day1?.cacheReadReportedRecords).toBeUndefined();
    expect(day1?.cacheWriteReportedRecords).toBeUndefined();
    expect(day2?.day).toBe("2026-08-02");
    expect(day2?.cacheReadReportedRecords).toBe(1);
    expect(day2?.cacheWriteReportedRecords).toBe(1);
  });

  it("does not count coverage from dropped duplicates or out-of-window records", () => {
    const bucket = aggregate([
      record({ dedupeKey: "msg_1:", cacheReport: { read: true, write: true } }),
      // Dropped before they can poison the bucket's coverage: their lack of
      // cacheReport must not stop the fields from being emitted.
      record({ dedupeKey: "msg_1:" }),
      record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }),
    ]).buckets[0];

    expect(bucket?.records).toBe(1);
    expect(bucket?.cacheReadReportedRecords).toBe(1);
    expect(bucket?.cacheWriteReportedRecords).toBe(1);
  });

  it("tracks coverage independently from savings valuation", () => {
    const bucket = aggregate([
      record({ model: "kimi-k3", cacheReport: { read: true, write: true } }),
    ]).buckets[0];

    expect(bucket?.unvaluedCachedInputTokens).toBe(1000);
    expect(bucket?.cacheReadReportedRecords).toBe(1);
    expect(bucket?.cacheWriteReportedRecords).toBe(1);
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record contributed", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(false);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });
});
