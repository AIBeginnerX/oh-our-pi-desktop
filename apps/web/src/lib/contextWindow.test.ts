import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  shapeContextBreakdown,
} from "./contextWindow";

describe("shapeContextBreakdown", () => {
  it("totals used rows and keeps deferred rows outside the window", () => {
    const result = shapeContextBreakdown(
      [
        { name: "Messages", tokens: 50, kind: "used" },
        { name: "Free space", tokens: 40, kind: "free" },
        { name: "Buffer", tokens: 10, kind: "buffer" },
        { name: "Deferred tools", tokens: 200, kind: "deferred" },
        { name: "Negative", tokens: -1, kind: "used" },
        { name: "NaN", tokens: NaN, kind: "used" },
      ],
      100,
    );

    expect(result.usedTokens).toBe(50);
    expect(result.usedShare).toBe(50);
    expect(result.rows.used.map((row) => row.name)).toEqual(["Messages"]);
    expect(result.rows.free[0]?.share).toBe(40);
    expect(result.rows.buffer[0]?.share).toBe(10);
    expect(result.rows.deferred[0]?.share).toBeNull();
  });

  it.each([undefined, 0])("preserves token counts with max %s", (maxTokens) => {
    const result = shapeContextBreakdown(
      [{ name: "Messages", tokens: 50, kind: "used" }],
      maxTokens,
    );
    expect(result.usedTokens).toBe(50);
    expect(result.usedShare).toBeNull();
    expect(result.rows.used[0]?.share).toBeNull();
  });
});

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});
