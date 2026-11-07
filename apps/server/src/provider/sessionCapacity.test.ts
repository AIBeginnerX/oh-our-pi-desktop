import { describe, expect, it } from "vite-plus/test";

import { liveSessionBudget, pressureVictims, reapBlock } from "./sessionCapacity.ts";

const GIB = 1024 ** 3;

describe("liveSessionBudget", () => {
  it("scales with memory and clamps to [4, 32]", () => {
    expect(liveSessionBudget(8 * GIB)).toBe(4);
    expect(liveSessionBudget(16 * GIB)).toBe(17);
    expect(liveSessionBudget(32 * GIB)).toBe(32);
    expect(liveSessionBudget(64 * GIB)).toBe(32);
    expect(liveSessionBudget(2 * GIB)).toBe(4);
  });
});

describe("reapBlock", () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  const old = "2026-01-01T00:00:00.000Z";
  const base = { lastSeenAt: old, now, minIdleMs: 120_000 };

  it("allows a quiet session and blocks the rest", () => {
    expect(reapBlock(base).block).toBeNull();
    expect(reapBlock({ ...base, lastSeenAt: "nope" }).block).toBe("invalid-last-seen");
    expect(reapBlock({ ...base, lastSeenAt: "2026-01-01T00:59:00.000Z" }).block).toBe("too-fresh");
    expect(reapBlock({ ...base, sessionUpdatedAt: "2026-01-01T00:59:30.000Z" }).block).toBe(
      "too-fresh",
    );
    expect(reapBlock({ ...base, activeTurnId: "turn-1" }).block).toBe("active-turn");
    expect(reapBlock({ ...base, backgroundLiveness: "working" }).block).toBe("background-work");
  });
});

describe("pressureVictims", () => {
  const sessions = [
    { id: "a", idleMs: 5 },
    { id: "b", idleMs: 30 },
    { id: "c", idleMs: 10 },
  ];

  it("stops nothing under budget", () => {
    expect(pressureVictims(sessions, 3, 4)).toEqual([]);
  });

  it("stops the longest idle first, only as many as one more needs", () => {
    expect(pressureVictims(sessions, 4, 4).map((s) => s.id)).toEqual(["b"]);
    expect(pressureVictims(sessions, 5, 4).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("stops no more than there are candidates", () => {
    expect(pressureVictims(sessions, 20, 4)).toHaveLength(3);
  });
});
