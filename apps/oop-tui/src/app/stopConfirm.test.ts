import { describe, expect, it } from "vite-plus/test";

import { nextStopStep, STOP_CONFIRM_WINDOW_MS } from "./stopConfirm.ts";

describe("nextStopStep", () => {
  it("stops at once with no live background agent", () => {
    expect(nextStopStep({ liveAgentCount: 0, warnedAt: null, now: 1000 })).toEqual({
      kind: "stop",
    });
  });

  it("warns on the first press when agents are live", () => {
    expect(nextStopStep({ liveAgentCount: 2, warnedAt: null, now: 1000 })).toEqual({
      kind: "warn",
      agentCount: 2,
    });
  });

  it("stops on a second press inside the window", () => {
    expect(nextStopStep({ liveAgentCount: 2, warnedAt: 1000, now: 1000 + 1 })).toEqual({
      kind: "stop",
    });
    expect(
      nextStopStep({ liveAgentCount: 2, warnedAt: 1000, now: 1000 + STOP_CONFIRM_WINDOW_MS - 1 }),
    ).toEqual({ kind: "stop" });
  });

  it("warns again once the window has passed", () => {
    expect(
      nextStopStep({ liveAgentCount: 1, warnedAt: 1000, now: 1000 + STOP_CONFIRM_WINDOW_MS }),
    ).toEqual({ kind: "warn", agentCount: 1 });
  });
});
