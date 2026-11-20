import { assert, it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { claudeUsageStopReason } from "./evalUsageGuard.ts";

const limits = (usedPercent: number, modelFamilies?: string[]): ServerProviderUsageLimits => ({
  checkedAt: "2026-11-17T00:00:00.000Z",
  windows: [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent,
      ...(modelFamilies === undefined ? {} : { modelFamilies }),
    },
  ],
});
it("fails closed when the Claude provider, limits, availability or windows are missing", () => {
  assert.isString(claudeUsageStopReason(undefined, ["opus"]));
  assert.isString(claudeUsageStopReason(null, ["opus"]));
  assert.isString(
    claudeUsageStopReason({ ...limits(0), unavailable: { reason: "probeFailed" } }, ["opus"]),
  );
  assert.isString(claudeUsageStopReason({ ...limits(0), windows: [] }, ["opus"]));
});
it("stops account-wide windows at 80%, including for other providers", () => {
  assert.isNull(claudeUsageStopReason(limits(79.9), ["codex:gpt"]));
  assert.strictEqual(claudeUsageStopReason(limits(80), ["codex:gpt"]), "Claude Weekly: 20% left");
  assert.strictEqual(claudeUsageStopReason(limits(100), ["opus"]), "Claude Weekly: 0% left");
});
it("matches model family words case-insensitively and ignores unrelated or empty families", () => {
  assert.isString(claudeUsageStopReason(limits(90, ["OpUs"]), ["claudeAgent:claude-opus-5-5"]));
  assert.isNull(claudeUsageStopReason(limits(90, ["opus"]), ["claude-superopus"]));
  assert.isNull(claudeUsageStopReason(limits(90, ["Sonnet"]), ["claude-opus-5-5"]));
  assert.isNull(claudeUsageStopReason(limits(90, []), ["opus"]));
  assert.isString(
    claudeUsageStopReason(
      { ...limits(0), windows: [...limits(0).windows, ...limits(85).windows] },
      ["opus"],
    ),
  );
});
it("counts every model window when the run can drive any model", () => {
  const crewLimits: ServerProviderUsageLimits = {
    ...limits(10),
    windows: [
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 10 },
      {
        id: "sonnet",
        kind: "weekly",
        label: "Sonnet",
        usedPercent: 90,
        modelFamilies: ["Sonnet"],
      },
    ],
  };
  assert.isNull(claudeUsageStopReason(crewLimits, ["claude-opus-5-5"]));
  assert.strictEqual(claudeUsageStopReason(crewLimits, "any"), "Claude Sonnet: 10% left");
});
it("never applies a tool-only window, even when the run can drive any model", () => {
  assert.isNull(claudeUsageStopReason(limits(95, []), ["claude-opus-5-5"]));
  assert.isNull(claudeUsageStopReason(limits(95, []), "any"));
});

it("supports a custom 50 percent stop threshold", () => {
  assert.isNull(claudeUsageStopReason(limits(49.9), "any", 50));
  assert.strictEqual(claudeUsageStopReason(limits(50), "any", 50), "Claude Weekly: 50% left");
  assert.isString(claudeUsageStopReason(limits(60, ["opus"]), ["opus"], 50));
  assert.isNull(claudeUsageStopReason(limits(60, ["sonnet"]), ["opus"], 50));
  assert.isNull(claudeUsageStopReason(limits(60, []), "any", 50));
});
