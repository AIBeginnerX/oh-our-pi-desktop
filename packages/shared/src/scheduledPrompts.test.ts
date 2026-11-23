// @effect-diagnostics globalDate:off
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { nextScheduledPromptAt, scheduledPromptOccurrence } from "./scheduledPrompts.ts";

describe("daily scheduled prompt time", () => {
  // The DST cases below prove nothing in a zone without DST, so the zone is fixed.
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/New_York";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("uses the configured minute and advances a full local date at the exact time", () => {
    const target = new Date(2026, 11, 31, 9, 45).getTime();
    expect(nextScheduledPromptAt(target - 1, 9, 45)).toBe(target);
    const next = nextScheduledPromptAt(target, 9, 45);
    expect(next).toBe(new Date(2027, 0, 1, 9, 45).getTime());
    expect(scheduledPromptOccurrence(next)).toBe("2027-01-01T09:45");
  });

  it("keeps the local wall time across spring and autumn DST boundaries", () => {
    // In New York these are 23 and 25 hour days, respectively.
    for (const [month, day, hours] of [
      [2, 7, 23],
      [9, 31, 25],
    ] as const) {
      const before = new Date(2026, month, day, 12, 30).getTime();
      const after = nextScheduledPromptAt(before, 12, 30);
      expect(after - before).toBe(hours * 60 * 60 * 1000);
      expect(scheduledPromptOccurrence(after).slice(-5)).toBe("12:30");
    }
  });

  it("uses the first repeated time and shifts forward through a missing local time", () => {
    for (const [month, day, hour] of [
      [2, 8, 2],
      [10, 1, 1],
    ] as const) {
      const before = new Date(2026, month, day, 0).getTime();
      const target = new Date(2026, month, day, hour, 30).getTime();
      expect(nextScheduledPromptAt(before, hour, 30)).toBe(target);
      expect(nextScheduledPromptAt(target, hour, 30)).toBe(
        new Date(2026, month, day + 1, hour, 30).getTime(),
      );
    }
  });
});
