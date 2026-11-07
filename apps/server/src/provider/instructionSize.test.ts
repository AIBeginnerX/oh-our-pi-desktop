import { describe, expect, it } from "vite-plus/test";
import { crewBrief } from "../crew/crewLogic.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

/**
 * The instruction text OOP sends with every session is paid for in every turn
 * of every thread, so it must not grow silently. Each limit is the measured
 * UTF-8 size of a representative input plus about 5% headroom.
 *
 * To raise a limit on purpose: confirm the added text is worth its per-turn
 * cost, read the measured size from the failure message, and set the constant
 * to that size plus about 5% in this file, in the same change that adds the text.
 */
const RUNTIME_INSTRUCTIONS_MAX_BYTES = 3219;
const CODEX_DEFAULT_MODE_INSTRUCTIONS_MAX_BYTES = 1015;
const CODEX_PLAN_MODE_INSTRUCTIONS_MAX_BYTES = 9660;
const CODEX_TOOL_CONTEXT_MAX_BYTES = 2054;
const CREW_BRIEF_MAX_BYTES = 3882;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const expectWithinLimit = (name: string, text: string, maxBytes: number, constant: string) => {
  const bytes = utf8Bytes(text);
  expect(
    bytes,
    `${name} is ${bytes} UTF-8 bytes, over the ${maxBytes} byte limit. This text is sent every ` +
      `session. If the growth is intended, raise ${constant} in instructionSize.test.ts to about ` +
      `${Math.ceil(bytes * 1.05)} (the new size plus 5%); otherwise shorten the text.`,
  ).toBeLessThanOrEqual(maxBytes);
};

describe("instruction text size", () => {
  it("keeps the shared runtime instructions within their limit", () => {
    const text = buildRuntimeInstructions({
      harness: "Codex",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      reasoningEffort: "high",
      projectMemory: true,
    });
    expectWithinLimit(
      "buildRuntimeInstructions",
      text,
      RUNTIME_INSTRUCTIONS_MAX_BYTES,
      "RUNTIME_INSTRUCTIONS_MAX_BYTES",
    );
  });

  it("keeps the Codex default mode developer instructions within their limit", () => {
    expectWithinLimit(
      "buildCodexDeveloperInstructions(default)",
      buildCodexDeveloperInstructions("default"),
      CODEX_DEFAULT_MODE_INSTRUCTIONS_MAX_BYTES,
      "CODEX_DEFAULT_MODE_INSTRUCTIONS_MAX_BYTES",
    );
  });

  it("keeps the Codex plan mode developer instructions within their limit", () => {
    expectWithinLimit(
      "buildCodexDeveloperInstructions(plan)",
      buildCodexDeveloperInstructions("plan"),
      CODEX_PLAN_MODE_INSTRUCTIONS_MAX_BYTES,
      "CODEX_PLAN_MODE_INSTRUCTIONS_MAX_BYTES",
    );
  });

  it("keeps the Codex browser and device tool context within its limit", () => {
    // The runtime entry of the additional context is the shared runtime instructions, pinned above.
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.4", modelName: "GPT-5.4", reasoningEffort: "high" },
      { browser: true, device: true },
    );
    expectWithinLimit(
      "buildCodexAdditionalContext (t3_code_tools)",
      context.t3_code_tools!.value,
      CODEX_TOOL_CONTEXT_MAX_BYTES,
      "CODEX_TOOL_CONTEXT_MAX_BYTES",
    );
  });

  it("keeps the crew brief, fast path and delegated roles included, within its limit", () => {
    const brief = crewBrief({
      worker: { label: "Haiku", providerLabel: "Claude", native: "haiku" },
      expert: { label: "GPT-6.1 Sol", providerLabel: "Codex" },
      auditor: { label: "Opus", providerLabel: "Claude" },
    });
    expect(brief).not.toBeNull();
    expectWithinLimit("crewBrief", brief!, CREW_BRIEF_MAX_BYTES, "CREW_BRIEF_MAX_BYTES");
  });
});
