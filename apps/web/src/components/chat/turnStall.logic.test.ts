import { describe, expect, it } from "vite-plus/test";

import {
  TURN_STALL_MS,
  deriveTurnStallDueAt,
  hasRunningTool,
  lastTurnActivityAt,
} from "./turnStall.logic";

const T0 = "2026-10-15T00:00:00.000Z";
const T0_MS = Date.parse(T0);
const minutes = (count: number) => new Date(T0_MS + count * 60_000).toISOString();

const running = (overrides: Partial<Parameters<typeof deriveTurnStallDueAt>[0]> = {}) =>
  deriveTurnStallDueAt({
    enabled: true,
    runningTurnId: "turn-1",
    waitingOnUser: false,
    backgroundWorkLive: false,
    workLogEntries: [],
    activities: [],
    messages: [],
    turnStartedAt: T0,
    sessionUpdatedAt: null,
    ...overrides,
  });

describe("deriveTurnStallDueAt", () => {
  it("is ten minutes after the turn's last sign of life", () => {
    expect(TURN_STALL_MS).toBe(10 * 60 * 1000);
    expect(running()).toBe(T0_MS + TURN_STALL_MS);
    expect(running({ activities: [{ createdAt: minutes(3) }, { createdAt: minutes(4) }] })).toBe(
      T0_MS + 14 * 60_000,
    );
  });

  it("moves later with every new activity, message update, or session update", () => {
    expect(running({ messages: [{ updatedAt: minutes(6) }] })).toBe(T0_MS + 16 * 60_000);
    expect(running({ sessionUpdatedAt: minutes(7) })).toBe(T0_MS + 17 * 60_000);
  });

  it("does nothing, and reads nothing, while the setting is off", () => {
    const trap = new Proxy([], {
      get() {
        throw new Error("read while the setting is off");
      },
    });
    expect(
      running({ enabled: false, workLogEntries: trap, activities: trap, messages: trap }),
    ).toBeNull();
  });

  describe("never warns when", () => {
    it("no turn is running", () => {
      expect(running({ runningTurnId: null })).toBeNull();
    });

    it("an approval or user input is pending", () => {
      expect(running({ waitingOnUser: true })).toBeNull();
    });

    it("background subagents or work are live", () => {
      expect(running({ backgroundWorkLive: true })).toBeNull();
    });

    it("a tool call of the running turn is in progress", () => {
      expect(
        running({
          workLogEntries: [{ turnId: "turn-1", toolLifecycleStatus: "inProgress" }],
        }),
      ).toBeNull();
    });

    it("there is no timestamp to measure from", () => {
      expect(running({ turnStartedAt: null })).toBeNull();
    });
  });

  it("still warns when only an earlier turn left a tool in progress", () => {
    expect(
      running({
        workLogEntries: [
          { turnId: "turn-0", toolLifecycleStatus: "inProgress" },
          { turnId: "turn-1", toolLifecycleStatus: "completed" },
        ],
      }),
    ).toBe(T0_MS + TURN_STALL_MS);
  });
});

describe("hasRunningTool", () => {
  it("sees an in-progress tool anywhere in the running turn's entries", () => {
    expect(
      hasRunningTool(
        [
          { turnId: "turn-0", toolLifecycleStatus: "inProgress" },
          { turnId: "turn-1", toolLifecycleStatus: "inProgress" },
          { turnId: "turn-1", toolLifecycleStatus: "completed" },
          { turnId: null },
        ],
        "turn-1",
      ),
    ).toBe(true);
  });

  it("ignores entries of earlier turns and a log with no tools", () => {
    expect(hasRunningTool([], "turn-1")).toBe(false);
    expect(
      hasRunningTool([{ turnId: "turn-0", toolLifecycleStatus: "inProgress" }], "turn-1"),
    ).toBe(false);
  });
});

describe("lastTurnActivityAt", () => {
  it("ignores unparsable times and returns null when none parse", () => {
    expect(
      lastTurnActivityAt({
        turnStartedAt: "not a time",
        sessionUpdatedAt: null,
        activities: [],
        messages: [],
      }),
    ).toBeNull();
  });
});
