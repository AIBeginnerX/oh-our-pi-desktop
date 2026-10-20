import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { zcodeQuotaToWindows } from "./zcodeUsageLimits.ts";

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

describe("zcodeQuotaToWindows", () => {
  it("maps a Z.ai coding plan response to 5-hour, weekly, and monthly MCP windows", () => {
    expect(
      zcodeQuotaToWindows({
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 33,
              nextResetTime: 1792398266968,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              usage: 1000,
              currentValue: 250,
              remaining: 750,
              percentage: 25,
              nextResetTime: 1792938650998,
            },
          ],
        },
      }),
    ).toEqual([
      { id: "token_5h", kind: "session", label: "5-hour", windowDurationMins: 300, usedPercent: 0 },
      {
        id: "token_week",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10080,
        usedPercent: 33,
        resetsAt: iso(1792398266968),
      },
      {
        id: "mcp",
        kind: "monthly",
        label: "MCP tools · Monthly",
        usedPercent: 25,
        resetsAt: iso(1792938650998),
      },
    ]);
  });

  it("reports nothing for failed or empty responses", () => {
    expect(zcodeQuotaToWindows({ success: false, code: 1001, msg: "auth failed" })).toBeNull();
    expect(
      zcodeQuotaToWindows({ success: true, data: { limits: [{ type: "TOKENS_LIMIT" }] } }),
    ).toBeNull();
  });
});
