// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
/**
 * Display formatting for the usage page.
 *
 * @module usageFormat
 */
import { UsageDay, type UsageResolution, type UsageSummaryInput } from "@t3tools/contracts";

import type {
  CacheReportCoverage,
  MergedUsage,
  ProviderTotals,
  UsageContractMismatch,
} from "./usageMerge.ts";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/**
 * Compacts a token count to three significant figures with a unit suffix, so
 * columns of numbers line up at a glance (`19.9B`, `76.7M`, `804K`).
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

/**
 * Whether the merged records' providers reported each cache figure. A share of
 * observed input is only presentable when every record is accounted for.
 */
export type CacheReportStatus = "full" | "partial" | "unknown";

/**
 * Classifies cache-reporting coverage. Records whose reporting no one could
 * know (older environments, or history saved by an older scan cache) and
 * records known not to report keep the figure from being complete; with no
 * reported record at all the figure is unknown.
 */
export function cacheReportStatus(coverage: CacheReportCoverage): CacheReportStatus {
  if (coverage.unreportedRecords === 0 && coverage.unknownRecords === 0) return "full";
  return coverage.reportedRecords === 0 ? "unknown" : "partial";
}

/** Why cache reads are not fully presented. Only meaningful for non-full coverage. */
function cacheReadGapDetail(coverage: CacheReportCoverage): string {
  if (coverage.reportedRecords === 0) {
    return coverage.unreportedRecords === 0
      ? "Cache coverage unknown for older usage history"
      : "Cache reads not reported";
  }
  return `${formatCount(coverage.unreportedRecords + coverage.unknownRecords)} records didn't report cache reads`;
}

/**
 * The "Cached input" and cache-writes presentations with per-figure coverage.
 * A percentage share of observed input is shown only when read coverage is
 * full; otherwise the cell says what did not report instead of a share.
 */
export function describeCacheReporting(
  merged: Pick<
    MergedUsage,
    "cachedInputTokens" | "uncachedInputTokens" | "cacheCreationTokens" | "cacheReporting"
  >,
): {
  readonly read: {
    readonly status: CacheReportStatus;
    readonly value: string;
    readonly detail: string;
  };
  readonly write: {
    readonly status: CacheReportStatus;
    readonly value: string;
    readonly detail: string;
  };
} {
  const { cachedInputTokens, uncachedInputTokens, cacheCreationTokens, cacheReporting } = merged;
  const readStatus = cacheReportStatus(cacheReporting.read);
  const writeStatus = cacheReportStatus(cacheReporting.write);
  const observedInput = cachedInputTokens + uncachedInputTokens;
  return {
    read: {
      status: readStatus,
      value:
        readStatus === "unknown" && cachedInputTokens === 0
          ? "Unknown"
          : formatTokens(cachedInputTokens),
      detail:
        readStatus === "full"
          ? `${formatPercent(observedInput === 0 ? 0 : cachedInputTokens / observedInput)} of observed input`
          : cacheReadGapDetail(cacheReporting.read),
    },
    write: {
      status: writeStatus,
      value:
        writeStatus === "unknown" && cacheCreationTokens === 0
          ? "Unknown"
          : formatTokens(cacheCreationTokens),
      detail:
        writeStatus === "full"
          ? `${formatTokens(cacheCreationTokens)} cache writes`
          : writeStatus === "partial"
            ? `${formatTokens(cacheCreationTokens)} cache writes (partial)`
            : cacheCreationTokens === 0
              ? "Cache writes not reported"
              : `${formatTokens(cacheCreationTokens)} cache writes (coverage unknown)`,
    },
  };
}

/**
 * The "Cache savings" cell. Savings only value cached input whose model had a
 * rate, so a figure that leaves cached tokens out is labelled partial, and one
 * that values none of them is unknown rather than `$0.00`. Savings are also
 * only complete when providers reported the cache reads themselves, so a
 * coverage gap downgrades the same way. Overrides can make savings negative,
 * so a partial figure is never worded as a lower bound.
 */
export function describeCacheSavings(
  merged: Pick<MergedUsage, "cachedInputTokens" | "costQuality"> & {
    readonly cacheReporting?: MergedUsage["cacheReporting"];
  },
): {
  readonly status: "noCachedInput" | "unknown" | "partial" | "complete";
  readonly value: string;
  readonly detail: string;
} {
  const { cachedInputTokens, costQuality } = merged;
  const unvalued = costQuality.unvaluedCachedInputTokens;
  const unattributed = costQuality.unattributedCachedInputTokens;

  // Callers without cacheReporting predate cache coverage; treat reads as full
  // so their results stay exactly as they were.
  const readCoverage = merged.cacheReporting?.read;
  const readGap =
    readCoverage !== undefined && cacheReportStatus(readCoverage) !== "full"
      ? cacheReadGapDetail(readCoverage)
      : undefined;

  if (cachedInputTokens <= 0) {
    if (readGap === undefined) {
      return { status: "noCachedInput", value: "—", detail: "No cached input reported" };
    }
    return { status: "unknown", value: "Unknown", detail: readGap };
  }
  if (unvalued + unattributed >= cachedInputTokens) {
    // Coverage above the cached total is impossible; treat it as nothing valued.
    const reasons = [
      ...(unvalued > 0 ? ["No known rates for the cached models"] : []),
      ...(unattributed > 0 ? ["Older environments don't report savings coverage"] : []),
      ...(readGap !== undefined ? [readGap] : []),
    ];
    return { status: "unknown", value: "Unknown", detail: reasons.join(". ") };
  }
  const value = formatUsd(costQuality.cacheSavingsUsd);
  if (unvalued + unattributed > 0 || readGap !== undefined) {
    const gaps = [
      ...(unvalued > 0 ? [`${formatTokens(unvalued)} cached tokens have no rates`] : []),
      ...(unattributed > 0
        ? [`coverage unknown for ${formatTokens(unattributed)} cached tokens`]
        : []),
      ...(readGap !== undefined ? [readGap] : []),
    ];
    return { status: "partial", value, detail: `Partial estimate: ${gaps.join("; ")}` };
  }
  return { status: "complete", value, detail: "API-equivalent estimate, not billed" };
}

/**
 * Dollar figures on the usage page are API-equivalent estimates, so an empty
 * window, a genuinely priced zero, and usage nobody could value must not
 * collapse into the same "$0.00". Status branches on records and coverage
 * only, never on token volume or the dollar amount itself, so a partial
 * figure is never a lower bound: overrides can push the priced part negative.
 */
export function describeApiCost(
  totals:
    | {
        readonly costUsd: number;
        readonly records: number;
        readonly unpricedShare: number;
      }
    | undefined,
): {
  readonly status: "none" | "unknown" | "partial" | "complete";
  readonly value: string;
  readonly detail: string;
} {
  if (totals === undefined || totals.records === 0) {
    return { status: "none", value: "—", detail: "No usage records in this window" };
  }
  if (totals.unpricedShare >= 1) {
    return {
      status: "unknown",
      value: "Unpriced",
      detail: "No known rates; API-equivalent cost unknown",
    };
  }
  if (totals.unpricedShare > 0) {
    return {
      status: "partial",
      value: formatUsd(totals.costUsd),
      detail: `Partial API estimate: excludes ${formatPercent(totals.unpricedShare)} unpriced records`,
    };
  }
  return {
    status: "complete",
    value: formatUsd(totals.costUsd),
    detail: "API-equivalent estimate, not billed",
  };
}

/** API-cost presentation for the merged window figure. */
export function describeMergedApiCost(
  merged: Pick<MergedUsage, "costUsd" | "records" | "costQuality">,
): ReturnType<typeof describeApiCost> {
  return describeApiCost({
    costUsd: merged.costUsd,
    records: merged.records,
    unpricedShare: merged.costQuality.unpricedShare,
  });
}

/**
 * The secondary line under a provider figure: the metric share plus the
 * valuation of the dollar figure beside it. An unknown or absent valuation
 * gets an explanation rather than a share that would read as a measured zero,
 * and cost shares are named against the priced subtotal whenever the window's
 * coverage is partial.
 */
export function describeProviderLine(
  provider: ProviderTotals | undefined,
  merged: Pick<MergedUsage, "costUsd" | "records" | "costQuality">,
  metric: "cost" | "tokens",
): string {
  const cost = describeApiCost(provider);
  const tokens = `${formatTokens(provider?.totalTokens ?? 0)} tokens`;
  if (metric === "tokens") {
    const share = `${formatPercent(provider?.tokenShare ?? 0)} of tokens`;
    return cost.status === "complete"
      ? `${share} · ${formatUsd(provider?.costUsd ?? 0)} · ${cost.detail}`
      : `${share} · ${cost.value} · ${cost.detail}`;
  }
  if (cost.status === "unknown") return `no known rates · ${tokens}`;
  if (cost.status === "none") return cost.detail;
  const share =
    merged.costUsd === 0
      ? "—"
      : `${formatPercent(provider?.costShare ?? 0)} ${
          describeMergedApiCost(merged).status === "partial" ? "of priced subtotal" : "of cost"
        }`;
  return cost.status === "partial"
    ? `${share} · ${tokens} · ${cost.detail}`
    : `${share} · ${tokens}`;
}

export function formatUsageContractMismatch(
  environmentLabel: string,
  mismatch: Pick<UsageContractMismatch, "direction">,
): string {
  return mismatch.direction === "serverBehind"
    ? `${environmentLabel} runs an older server version and is excluded from totals.`
    : `This client is older than the server on ${environmentLabel}; its usage is excluded from totals.`;
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const HOUR_MS = 60 * 60 * 1000;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  if (options.timeZone === undefined) return new Intl.DateTimeFormat(locale, options);
  const key = JSON.stringify([locale, options]);
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateTimeFormatters.size >= 16) dateTimeFormatters.clear();
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** Every fixed-duration bucket start in an hourly rolling window. */
export function enumerateHourStarts(sinceTime: string, untilTime: string): readonly string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;

  for (let cursor = start; cursor < end; cursor += HOUR_MS) {
    starts.push(new Date(cursor).toISOString());
  }
  return starts;
}

/**
 * A rolling bucket start rendered in the viewer's requested time zone.
 *
 * Repeated wall-clock hours during a fall-back transition include their short
 * zone name so the two distinct buckets remain distinguishable.
 */
export function formatHourShort(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const hourFormat = dateTimeFormatter("en-US", {
    ...options,
    hour: "numeric",
  });
  const wallHourFormat = dateTimeFormatter("en-CA", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );

  if (!isRepeatedHour) return hourFormat.format(instant);
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "numeric",
    timeZoneName: "short",
  }).format(instant);
}

/** `2026-08-11T14:37:00Z` to `Aug 11, 2 PM` in the requested zone. */
export function formatDateTimeShort(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}

/** An hourly tooltip label relative to the rolling window's end date. */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone);
  }

  const dayFormat = dateTimeFormatter("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const instantDay = Date.parse(`${dayFormat.format(instant)}T00:00:00Z`);
  const referenceDay = Date.parse(`${dayFormat.format(reference)}T00:00:00Z`);
  const calendarDaysAgo = Math.round((referenceDay - instantDay) / (24 * HOUR_MS));
  const hour = formatHourShort(hourStart, timeZone);

  if (calendarDaysAgo === 0) return `${hour} today`;
  if (calendarDaysAgo === 1) return `${hour} yesterday`;
  return formatDateTimeShort(hourStart, timeZone);
}

/**
 * The window the page requests, expressed in the viewer's own time zone so days
 * line up with what they actually experienced.
 */
export function makeWindow(
  days: number,
  now = new Date(),
  resolution: UsageResolution = "day",
): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than crash the page.
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const untilDay = format.format(now);
  if (resolution === "hour") {
    // Minute-aligned bounds keep labels readable while still representing an
    // exact rolling 24-hour duration. Fixed-duration buckets remain correct
    // across offset changes and daylight-saving transitions.
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const sinceTimeMs = untilTimeMs - 24 * HOUR_MS;
    const sinceTime = new Date(sinceTimeMs);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: UsageDay.make(format.format(sinceTime)),
      untilDay: UsageDay.make(format.format(untilTime)),
      timeZone,
      resolution,
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  // Subtracting fixed milliseconds from `now` lands on the wrong calendar day
  // around a DST transition. The window start is pure calendar arithmetic on
  // the local end day, done in UTC where days are uniform.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution,
  };
}
