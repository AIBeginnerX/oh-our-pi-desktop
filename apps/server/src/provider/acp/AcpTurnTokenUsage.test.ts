import { describe, expect, it } from "vite-plus/test";

import { acpTurnTokenUsageFromPromptResponses } from "./AcpTurnTokenUsage.ts";

const fullUsage = {
  inputTokens: 100,
  outputTokens: 40,
  totalTokens: 150,
  cachedReadTokens: 30,
  cachedWriteTokens: 10,
  thoughtTokens: 12,
};

describe("acpTurnTokenUsageFromPromptResponses", () => {
  it("maps a full report to complete usage with cache counted into input", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [
        {
          prompt: [{ type: "text", text: "hello" }],
          result: { stopReason: "end_turn", usage: fullUsage },
        },
      ],
      { hasSubagents: false, completed: true },
    );

    expect(usage).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 140,
      outputTokens: 40,
      cachedInputTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 12,
    });
  });

  it("keeps a report without a cache split partial and leaves the cache fields absent", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [{ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } }],
      { hasSubagents: true, completed: true },
    );

    expect(usage).toEqual({
      usageStatus: "partial",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 100,
      outputTokens: 40,
    });
  });

  it("emits nothing when the agent reported no usage", () => {
    const noUsage = acpTurnTokenUsageFromPromptResponses(
      [
        { prompt: [{ type: "text", text: "hello" }], result: { stopReason: "end_turn" } },
        { prompt: [], result: { stopReason: "cancelled", usage: null } },
        { prompt: [], result: { stopReason: "cancelled", usage: {} } },
        { something: "else" },
      ],
      { hasSubagents: false, completed: true },
    );
    expect(noUsage).toBeUndefined();
    expect(
      acpTurnTokenUsageFromPromptResponses([], { hasSubagents: false, completed: true }),
    ).toBeUndefined();
  });

  it("merges the prompts of one steer-merged turn into a single complete usage", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [
        {
          prompt: [{ type: "text", text: "run" }],
          result: { stopReason: "cancelled", usage: fullUsage },
        },
        {
          prompt: [{ type: "text", text: "continue" }],
          result: { stopReason: "end_turn", usage: fullUsage },
        },
      ],
      { hasSubagents: false, completed: true },
    );

    expect(usage).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 280,
      outputTokens: 80,
      cachedInputTokens: 60,
      cacheCreationTokens: 20,
      reasoningTokens: 24,
    });
  });

  it("downgrades to partial when one prompt of the turn resolved without usage", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [
        { prompt: [{ type: "text", text: "run" }], result: { stopReason: "cancelled" } },
        { prompt: [], result: { stopReason: "end_turn", usage: fullUsage } },
      ],
      { hasSubagents: false, completed: true },
    );

    expect(usage).toEqual({
      usageStatus: "partial",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 140,
      outputTokens: 40,
      cachedInputTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 12,
    });
  });

  it("never reports complete for a cancelled turn, whose totals may be cut short", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [{ stopReason: "cancelled", usage: fullUsage }],
      { hasSubagents: false, completed: false },
    );

    expect(usage?.usageStatus).toBe("partial");
    expect(usage).toMatchObject({ inputTokens: 140, outputTokens: 40 });
  });

  it("clamps reasoning tokens to the output total and treats null cache buckets as absent", () => {
    const usage = acpTurnTokenUsageFromPromptResponses(
      [
        {
          stopReason: "end_turn",
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            cachedReadTokens: null,
            cachedWriteTokens: null,
            thoughtTokens: 90,
          },
        },
      ],
      { hasSubagents: false, completed: true },
    );

    expect(usage).toEqual({
      usageStatus: "partial",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 40,
    });
  });
});
