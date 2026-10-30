import { describe, expect, it } from "vite-plus/test";

import { crewThreadUsage } from "./crewUsage.ts";

const observation = (
  eventId: string,
  usage: Record<string, unknown>,
  costUsd?: number,
  terminal = "completed",
) => ({
  kind: "owned-usage",
  payload: {
    v: 1,
    scope: "main-turn",
    source: {
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      turnId: "turn-1",
      runtimeEventId: eventId,
      nativeConversationId: null,
    },
    terminal,
    usage: { usageScope: "main_agent", hasSubagents: false, ...usage },
    ...(costUsd === undefined ? {} : { costUsd }),
  },
});
const complete = { usageStatus: "complete", inputTokens: 1000, outputTokens: 200 };

describe("crewThreadUsage", () => {
  it("is null when the thread recorded no usage", () => {
    expect(crewThreadUsage([])).toBeNull();
    expect(crewThreadUsage([{ kind: "tool.completed", payload: {} }])).toBeNull();
  });

  it("sums tokens and the reported cost", () => {
    expect(
      crewThreadUsage([
        observation("e1", { ...complete, cachedInputTokens: 300 }, 0.25),
        observation("e2", complete, 0.5),
        { kind: "tool.completed", payload: { itemType: "command_execution" } },
      ]),
    ).toEqual({ inputTokens: 2000, outputTokens: 400, cachedInputTokens: 300, costUsd: 0.75 });
  });

  it("leaves the cost out when a counted turn reported none", () => {
    expect(
      crewThreadUsage([observation("e1", complete, 0.25), observation("e2", complete)]),
    ).toEqual({ inputTokens: 2000, outputTokens: 400 });
  });

  it("counts a partial observation's known tokens and skips malformed rows", () => {
    expect(
      crewThreadUsage([
        observation("e1", { usageStatus: "partial", outputTokens: 50 }),
        { kind: "owned-usage", payload: { v: 2 } },
      ]),
    ).toEqual({ inputTokens: 0, outputTokens: 50 });
  });
});
