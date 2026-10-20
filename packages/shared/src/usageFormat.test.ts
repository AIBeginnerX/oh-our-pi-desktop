// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import type { ProviderTotals } from "./usageMerge.ts";
import {
  cacheReportStatus,
  describeApiCost,
  describeCacheReporting,
  describeCacheSavings,
  describeProviderLine,
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatPercent,
  formatRelativeHourShort,
  makeWindow,
} from "./usageFormat.ts";

/** Synthetic cache-report coverage: records reported, known-unreported, legacy-unknown. */
const coverage = (reported: number, unreported: number, unknown: number) => ({
  reportedRecords: reported,
  unreportedRecords: unreported,
  unknownRecords: unknown,
});

describe("describeCacheSavings", () => {
  const describeSavings = (
    cachedInputTokens: number,
    gaps: { unvalued?: number; unattributed?: number; savingsUsd?: number } = {},
    reporting?: { read?: ReturnType<typeof coverage>; write?: ReturnType<typeof coverage> },
  ) =>
    describeCacheSavings({
      cachedInputTokens,
      costQuality: {
        providerReportedShare: 0,
        modelPricedShare: 1,
        unpricedShare: 0,
        cacheSavingsUsd: gaps.savingsUsd ?? 1.5,
        unvaluedCachedInputTokens: gaps.unvalued ?? 0,
        unattributedCachedInputTokens: gaps.unattributed ?? 0,
      },
      ...(reporting === undefined
        ? {}
        : {
            cacheReporting: {
              read: reporting.read ?? coverage(0, 0, 0),
              write: reporting.write ?? coverage(0, 0, 0),
            },
          }),
    });

  it("never presents no cached input as a dollar figure", () => {
    expect(describeSavings(0, { savingsUsd: 0 })).toEqual({
      status: "noCachedInput",
      value: "—",
      detail: "No cached input reported",
    });
  });

  it("reports a genuine zero as complete when every cached token was valued", () => {
    expect(describeSavings(1000, { savingsUsd: 0 })).toEqual({
      status: "complete",
      value: "$0.00",
      detail: "API-equivalent estimate, not billed",
    });
  });

  it("reports unknown when no cached token was valued", () => {
    const noRates = describeSavings(1000, { unvalued: 1000, savingsUsd: 0 });
    expect(noRates).toMatchObject({ status: "unknown", value: "Unknown" });
    expect(noRates.detail).toContain("rates");
    expect(noRates.detail).not.toContain("Older environments");

    const legacy = describeSavings(1000, { unattributed: 1000, savingsUsd: 0 });
    expect(legacy).toMatchObject({ status: "unknown", value: "Unknown" });
    expect(legacy.detail).toContain("Older environments");
    expect(legacy.detail).not.toContain("rates");

    const mixed = describeSavings(1000, { unvalued: 400, unattributed: 600, savingsUsd: 0 });
    expect(mixed).toMatchObject({ status: "unknown", value: "Unknown" });
    expect(mixed.detail).toContain("rates");
    expect(mixed.detail).toContain("Older environments");
  });

  it("labels a figure that leaves cached tokens out as a partial estimate", () => {
    const noRates = describeSavings(1000, { unvalued: 250 });
    expect(noRates).toMatchObject({ status: "partial", value: "$1.50" });
    expect(noRates.detail).toContain("Partial estimate");
    expect(noRates.detail).toContain("250 cached tokens have no rates");

    const legacy = describeSavings(1000, { unattributed: 100 });
    expect(legacy).toMatchObject({ status: "partial", value: "$1.50" });
    expect(legacy.detail).toContain("coverage unknown for 100 cached tokens");

    const mixed = describeSavings(1000, { unvalued: 250, unattributed: 100 });
    expect(mixed.status).toBe("partial");
    expect(mixed.detail).toContain("250 cached tokens have no rates");
    expect(mixed.detail).toContain("coverage unknown for 100 cached tokens");
  });

  it("shows negative savings from price overrides without lower-bound wording", () => {
    for (const coverage of [{}, { unvalued: 250 }]) {
      const negative = describeSavings(1000, { ...coverage, savingsUsd: -2 });
      expect(negative.value).toBe("-$2.00");
      expect(negative.detail).not.toMatch(/at least/i);
    }
    expect(describeSavings(1000, { savingsUsd: -2 }).status).toBe("complete");
  });

  it("never claims coverage beyond the cached input it was given", () => {
    for (const gaps of [{ unvalued: 1500 }, { unvalued: 600, unattributed: 600 }]) {
      expect(describeSavings(1000, gaps)).toMatchObject({
        status: "unknown",
        value: "Unknown",
      });
    }
  });

  it("keeps the no-cached-input result when read coverage is full", () => {
    expect(describeSavings(0, { savingsUsd: 0 }, { read: coverage(2, 0, 0) })).toEqual({
      status: "noCachedInput",
      value: "—",
      detail: "No cached input reported",
    });
  });

  it("never presents unknown read coverage as a zero figure", () => {
    const legacy = describeSavings(0, { savingsUsd: 0 }, { read: coverage(0, 0, 4) });
    expect(legacy).toEqual({
      status: "unknown",
      value: "Unknown",
      detail: "Cache coverage unknown for older usage history",
    });
    expect(legacy.value).not.toBe("$0.00");
    expect(legacy.value).not.toBe("—");

    const unreported = describeSavings(0, { savingsUsd: 0 }, { read: coverage(0, 3, 0) });
    expect(unreported).toEqual({
      status: "unknown",
      value: "Unknown",
      detail: "Cache reads not reported",
    });
  });

  it("downgrades a complete estimate when reads are only partially covered", () => {
    expect(describeSavings(1000, {}, { read: coverage(1, 1, 1) })).toEqual({
      status: "partial",
      value: "$1.50",
      detail: "Partial estimate: 2 records didn't report cache reads",
    });
  });

  it("threads a read coverage gap into an already partial estimate", () => {
    const mixed = describeSavings(1000, { unvalued: 250 }, { read: coverage(1, 2, 0) });
    expect(mixed.status).toBe("partial");
    expect(mixed.value).toBe("$1.50");
    expect(mixed.detail).toContain("250 cached tokens have no rates");
    expect(mixed.detail).toContain("2 records didn't report cache reads");
  });

  it("treats present full coverage like a legacy caller", () => {
    expect(describeSavings(1000, {}, { read: coverage(4, 0, 0) })).toEqual({
      status: "complete",
      value: "$1.50",
      detail: "API-equivalent estimate, not billed",
    });
  });

  it("mentions a reporting gap alongside price reasons when nothing was valued", () => {
    const noRates = describeSavings(
      1000,
      { unvalued: 1000, savingsUsd: 0 },
      { read: coverage(1, 2, 0) },
    );
    expect(noRates).toMatchObject({ status: "unknown", value: "Unknown" });
    expect(noRates.detail).toContain("No known rates for the cached models");
    expect(noRates.detail).toContain("2 records didn't report cache reads");
  });
});

describe("cacheReportStatus", () => {
  it("counts every record accounted for as full, including no records", () => {
    expect(cacheReportStatus(coverage(0, 0, 0))).toBe("full");
    expect(cacheReportStatus(coverage(5, 0, 0))).toBe("full");
  });

  it("separates legacy records from records known not to report", () => {
    expect(cacheReportStatus(coverage(0, 0, 4))).toBe("unknown");
    expect(cacheReportStatus(coverage(0, 2, 0))).toBe("unknown");
  });

  it("calls a mix with at least one reported record partial", () => {
    expect(cacheReportStatus(coverage(3, 1, 1))).toBe("partial");
    expect(cacheReportStatus(coverage(1, 0, 9))).toBe("partial");
  });
});

describe("describeCacheReporting", () => {
  const describeReporting = (
    cachedInputTokens: number,
    read: ReturnType<typeof coverage>,
    overrides: {
      uncachedInputTokens?: number;
      cacheCreationTokens?: number;
      write?: ReturnType<typeof coverage>;
    } = {},
  ) =>
    describeCacheReporting({
      cachedInputTokens,
      uncachedInputTokens: overrides.uncachedInputTokens ?? 0,
      cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
      cacheReporting: {
        read,
        write: overrides.write ?? coverage(0, 0, 0),
      },
    });

  it("shows the share of observed input only when read coverage is full", () => {
    expect(describeReporting(600, coverage(2, 0, 0), { uncachedInputTokens: 400 }).read).toEqual({
      status: "full",
      value: "600",
      detail: "60.0% of observed input",
    });
    expect(describeReporting(0, coverage(0, 0, 0)).read).toEqual({
      status: "full",
      value: "0",
      detail: "0.0% of observed input",
    });
  });

  it("hides the share behind coverage wording when records did not report", () => {
    const mixed = describeReporting(700, coverage(1, 1, 1), { uncachedInputTokens: 300 });
    expect(mixed.read).toEqual({
      status: "partial",
      value: "700",
      detail: "2 records didn't report cache reads",
    });
    expect(mixed.read.detail).not.toContain("%");

    expect(describeReporting(0, coverage(0, 3, 0)).read).toEqual({
      status: "unknown",
      value: "Unknown",
      detail: "Cache reads not reported",
    });
    expect(describeReporting(0, coverage(0, 0, 7)).read).toEqual({
      status: "unknown",
      value: "Unknown",
      detail: "Cache coverage unknown for older usage history",
    });
  });

  it("still shows cached tokens when coverage is unknown but tokens exist", () => {
    expect(describeReporting(500, coverage(0, 0, 2)).read).toEqual({
      status: "unknown",
      value: "500",
      detail: "Cache coverage unknown for older usage history",
    });
  });

  it("words cache writes by their own coverage", () => {
    expect(describeReporting(0, coverage(2, 0, 0), { cacheCreationTokens: 1500 }).write).toEqual({
      status: "full",
      value: "1.50K",
      detail: "1.50K cache writes",
    });
    expect(
      describeReporting(0, coverage(2, 0, 0), {
        cacheCreationTokens: 1500,
        write: coverage(1, 1, 0),
      }).write,
    ).toEqual({ status: "partial", value: "1.50K", detail: "1.50K cache writes (partial)" });
    expect(
      describeReporting(0, coverage(2, 0, 0), {
        cacheCreationTokens: 1500,
        write: coverage(0, 0, 2),
      }).write,
    ).toEqual({
      status: "unknown",
      value: "1.50K",
      detail: "1.50K cache writes (coverage unknown)",
    });
    expect(describeReporting(0, coverage(2, 0, 0), { write: coverage(0, 0, 2) }).write).toEqual({
      status: "unknown",
      value: "Unknown",
      detail: "Cache writes not reported",
    });
  });
});

describe("describeApiCost", () => {
  it("presents an empty window as nothing rather than a valued zero", () => {
    const empty = describeApiCost({ costUsd: 0, records: 0, unpricedShare: 0 });
    expect(empty).toEqual({
      status: "none",
      value: "—",
      detail: "No usage records in this window",
    });
    expect(describeApiCost(undefined)).toEqual(empty);
  });

  it("presents an all-unpriced window as unknown rather than $0.00", () => {
    const unknown = describeApiCost({ costUsd: 0, records: 5, unpricedShare: 1 });
    expect(unknown.status).toBe("unknown");
    expect(unknown.value).toBe("Unpriced");
    expect(unknown.value).not.toContain("$");
    expect(unknown.detail).toContain("No known rates");
  });

  it("keeps a genuinely priced zero as a complete $0.00", () => {
    expect(describeApiCost({ costUsd: 0, records: 3, unpricedShare: 0 })).toEqual({
      status: "complete",
      value: "$0.00",
      detail: "API-equivalent estimate, not billed",
    });
  });

  it("keeps a partially priced zero under its partial label", () => {
    const partial = describeApiCost({ costUsd: 0, records: 2, unpricedShare: 0.5 });
    expect(partial.status).toBe("partial");
    expect(partial.value).toBe("$0.00");
    expect(partial.detail).toContain("excludes 50.0% unpriced records");
  });

  it("labels a partially priced subtotal with its excluded share", () => {
    const partial = describeApiCost({ costUsd: 75, records: 10, unpricedShare: 0.5 });
    expect(partial.status).toBe("partial");
    expect(partial.value).toBe("$75.00");
    expect(partial.detail).toContain("50.0%");
  });

  it("labels a fully priced figure as an estimate, not a bill", () => {
    const complete = describeApiCost({ costUsd: 75, records: 10, unpricedShare: 0 });
    expect(complete.status).toBe("complete");
    expect(complete.detail).toContain("not billed");
  });

  it("never claims actual billing in any detail", () => {
    const results = [
      describeApiCost(undefined),
      describeApiCost({ costUsd: 0, records: 5, unpricedShare: 1 }),
      describeApiCost({ costUsd: 0, records: 5, unpricedShare: 0.5 }),
      describeApiCost({ costUsd: 75, records: 10, unpricedShare: 0 }),
    ];
    for (const result of results) {
      expect(result.detail).not.toMatch(/actual|spent|billed spend/i);
    }
  });
});

describe("describeProviderLine", () => {
  const merged = (costUsd: number, unpricedShare: number, records = 10) => ({
    costUsd,
    records,
    costQuality: {
      providerReportedShare: 0,
      modelPricedShare: 1 - unpricedShare,
      unpricedShare,
      cacheSavingsUsd: 0,
      unvaluedCachedInputTokens: 0,
      unattributedCachedInputTokens: 0,
    },
  });
  const provider = (overrides: Partial<ProviderTotals> = {}): ProviderTotals => ({
    provider: "claude",
    costUsd: 45,
    totalTokens: 1200,
    records: 9,
    sessions: 1,
    costShare: 0.45,
    tokenShare: 0.3,
    unpricedShare: 0,
    ...overrides,
  });

  it("surfaces API-equivalent estimate qualifier on complete tokens line", () => {
    const complete = provider({ costUsd: 30, records: 10, unpricedShare: 0, costShare: 0.3 });
    const tokenLine = describeProviderLine(complete, merged(100, 0), "tokens");
    expect(tokenLine).toContain("30.0% of tokens");
    expect(tokenLine).toContain("$30.00");
    expect(tokenLine).toContain("API-equivalent estimate, not billed");
  });

  it("names cost shares against the priced subtotal when coverage is partial", () => {
    expect(describeProviderLine(provider(), merged(90, 0.4), "cost")).toBe(
      "45.0% of priced subtotal · 1.20K tokens",
    );
    expect(describeProviderLine(provider(), merged(100, 0), "cost")).toBe(
      "45.0% of cost · 1.20K tokens",
    );
  });

  it("never shows a measured-looking zero share for unknown or empty providers", () => {
    const unknown = provider({ costUsd: 0, records: 5, unpricedShare: 1, costShare: 0 });
    expect(describeProviderLine(unknown, merged(0, 1, 5), "cost")).toBe(
      "no known rates · 1.20K tokens",
    );
    const none = provider({
      costUsd: 0,
      totalTokens: 0,
      records: 0,
      unpricedShare: 0,
      costShare: 0,
    });
    expect(describeProviderLine(none, merged(50, 0), "cost")).toBe(
      "No usage records in this window",
    );
  });

  it("shows share unavailable when the priced subtotal is zero", () => {
    const line = describeProviderLine(provider({ costUsd: 0, costShare: 0 }), merged(0, 0), "cost");
    expect(line).toBe("— · 1.20K tokens");
    expect(line).not.toContain("0.0%");
  });

  it("keeps provider valuation visible in both metric modes", () => {
    const partial = provider({ costUsd: 30, records: 10, unpricedShare: 0.3, costShare: 0.3 });
    const costLine = describeProviderLine(partial, merged(100, 0.5), "cost");
    expect(costLine).toContain("of priced subtotal");
    expect(costLine).toContain("excludes 30.0% unpriced records");

    const tokenLine = describeProviderLine(partial, merged(100, 0.5), "tokens");
    expect(tokenLine).toContain("of tokens");
    expect(tokenLine).toContain("$30.00");
    expect(tokenLine).toContain("Partial API estimate");

    const unknownTokenLine = describeProviderLine(
      provider({ costUsd: 0, unpricedShare: 1 }),
      merged(0, 1),
      "tokens",
    );
    expect(unknownTokenLine).toContain("Unpriced");
    expect(unknownTokenLine).toContain("No known rates");
  });
});

describe("formatPercent", () => {
  it("distinguishes a small positive share from zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.0009)).toBe("<0.1%");
    expect(formatPercent(0.001)).toBe("0.1%");
    expect(formatPercent(0.023)).toBe("2.3%");
    expect(formatPercent(0.00004, 2)).toBe("<0.01%");
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("uses the current system zone when no zone is supplied", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("12 PM");
      vi.stubEnv("TZ", "America/New_York");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("8 AM");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
