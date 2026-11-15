import { describe, expect, it } from "vite-plus/test";

import { crewThreadUsage } from "./crewUsage.ts";

const observation = (
  eventId: string,
  usage: Record<string, unknown>,
  costUsd?: number,
  terminal = "completed",
  extras: { createdAt?: string; instanceId?: string } = {},
) => ({
  kind: "owned-usage",
  ...(extras.createdAt === undefined ? {} : { createdAt: extras.createdAt }),
  payload: {
    v: 1,
    scope: "main-turn",
    source: {
      driver: "claudeAgent",
      instanceId: extras.instanceId ?? "claudeAgent",
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
        observation("e1", { ...complete, cachedInputTokens: 300 }, 0.25, "completed", {
          instanceId: "session-a",
        }),
        observation("e2", complete, 0.5, "completed", { instanceId: "session-b" }),
        { kind: "tool.completed", payload: { itemType: "command_execution" } },
      ]),
    ).toEqual({ inputTokens: 2000, outputTokens: 400, cachedInputTokens: 300, costUsd: 0.75 });
  });

  it("totals session running totals as the chain's final step, not their sum", () => {
    expect(
      crewThreadUsage([
        observation("e1", complete, 0.5, "completed", { createdAt: "2026-01-01T00:00:00.000Z" }),
        observation("e2", complete, 1.2, "completed", { createdAt: "2026-01-01T00:01:00.000Z" }),
        observation("e3", complete, 2.0, "completed", { createdAt: "2026-01-01T00:02:00.000Z" }),
      ]),
    ).toEqual({ inputTokens: 3000, outputTokens: 600, costUsd: 2.0 });
  });

  it("prices an unreported turn as zero once its chain reported", () => {
    expect(
      crewThreadUsage([
        observation("e1", complete, 0.4, "completed", { createdAt: "2026-01-01T00:00:00.000Z" }),
        observation("e2", complete, undefined, "completed", {
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
        observation("e3", complete, 1.0, "completed", { createdAt: "2026-01-01T00:02:00.000Z" }),
      ]),
    ).toEqual({ inputTokens: 3000, outputTokens: 600, costUsd: 1.0 });
  });

  it("omits cost when a chain never reports one", () => {
    expect(
      crewThreadUsage([
        observation("e1", complete, undefined, "completed", {
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        observation("e2", complete, undefined, "completed", {
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
      ]),
    ).toEqual({ inputTokens: 2000, outputTokens: 400 });
  });

  it("leaves the cost out when a chain never reported one", () => {
    expect(
      crewThreadUsage([
        observation("e1", complete, 0.25, "completed", { instanceId: "session-a" }),
        observation("e2", complete, undefined, "completed", { instanceId: "session-b" }),
      ]),
    ).toEqual({ inputTokens: 2000, outputTokens: 400 });
  });

  it("omits cost when a trailing turn was never covered by a report", () => {
    expect(
      crewThreadUsage([
        observation("e1", complete, 0.5, "completed", { createdAt: "2026-01-01T00:00:00.000Z" }),
        observation("e2", complete, undefined, "completed", {
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
      ]),
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
