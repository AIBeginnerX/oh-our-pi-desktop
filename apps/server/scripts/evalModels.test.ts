import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import { resolveEvalModel } from "./evalModels.ts";

const thought = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Thought",
      type: "select" as const,
      options: ["low", "high", "max"].map((id) => ({ id, label: id })),
    },
  ],
};
const model = (slug: string, capabilities: ServerProviderModel["capabilities"] = thought) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities,
});

// Shapes from the real ZCode and MiniMax Code ACP model lists.
const zcode = [
  "builtin:zai-coding-plan\\GLM-5.3-Flash",
  "builtin:zai-coding-plan\\GLM-5.3",
  "f6df1c53-ac67-4cf8-8af5-e188280666e5\\MiniMax-M3",
  "airoute\\zai/glm-6",
  "builtin:zai-coding-plan\\GLM-5",
].map((slug) => model(slug));
const minimax = [
  "m:minimax:MiniMax-M3.1-Flash:v:thinking",
  "m:minimax:MiniMax-M3:v:",
  "m:minimax:MiniMax-M3:v:thinking",
  "m:minimax:MiniMax-M2.7:v:thinking",
  "m:custom_provider%3Aopencodex:minimax%2FMiniMax-M4:v:thinking",
].map((slug) => model(slug, null));

it("picks ZCode's newest built-in GLM flagship at max thought", () => {
  for (const requested of ["latest", "builtin:zai-coding-plan\\GLM-5"]) {
    assert.deepStrictEqual(resolveEvalModel("zcode", zcode, requested), {
      model: "builtin:zai-coding-plan\\GLM-5.3",
      options: [{ id: "reasoningEffort", value: "max" }],
    });
  }
});

it("picks MiniMax's newest native flagship in its thinking variant", () => {
  assert.deepStrictEqual(resolveEvalModel("minimax", minimax, "latest"), {
    model: "m:minimax:MiniMax-M3:v:thinking",
  });
});

it("leaves other providers unchanged", () => {
  assert.deepStrictEqual(resolveEvalModel("claudeAgent", [], "old"), { model: "old" });
});

it("refuses a ZCode model without a reasoning option instead of measuring defaults", () => {
  assert.throws(() =>
    resolveEvalModel("zcode", [model("builtin:zai-coding-plan\\GLM-5.3", null)], "latest"),
  );
});

it("uses lighter models only when no flagship exists", () => {
  assert.strictEqual(
    resolveEvalModel("minimax", [minimax[0]!], "latest").model,
    "m:minimax:MiniMax-M3.1-Flash:v:thinking",
  );
});
