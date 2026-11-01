import { describe, expect, it } from "vite-plus/test";

import { decideStop, isQueuedBehindBackgroundAgents } from "./stopBackgroundAgents.logic";

describe("decideStop", () => {
  it("stops immediately with no live background agent", () => {
    expect(decideStop(0)).toEqual({ kind: "immediate" });
  });

  it("asks first when one or more background agents are live", () => {
    expect(decideStop(1)).toEqual({ kind: "confirm", agentCount: 1 });
    expect(decideStop(3)).toEqual({ kind: "confirm", agentCount: 3 });
  });
});

describe("isQueuedBehindBackgroundAgents", () => {
  it("is true only while the thread runs with live agents", () => {
    expect(isQueuedBehindBackgroundAgents({ running: true, liveAgentCount: 2 })).toBe(true);
    expect(isQueuedBehindBackgroundAgents({ running: true, liveAgentCount: 0 })).toBe(false);
    expect(isQueuedBehindBackgroundAgents({ running: false, liveAgentCount: 2 })).toBe(false);
  });
});
