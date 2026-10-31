import { describe, expect, it } from "vite-plus/test";

import type { ModelChoice } from "./commands.ts";
import { filterModels, scoreModelChoice } from "./modelSearch.ts";

const choice = (
  model: string,
  name: string,
  over: { shortName?: string; subProvider?: string; driver?: string; providerName?: string } = {},
): ModelChoice => ({
  instanceId: "inst",
  model,
  label: `${over.providerName ?? "Codex"} / ${name}`,
  search: {
    name,
    ...(over.shortName ? { shortName: over.shortName } : {}),
    ...(over.subProvider ? { subProvider: over.subProvider } : {}),
    driver: over.driver ?? "codex",
    providerName: over.providerName ?? "Codex",
  },
});

const models = [
  choice("gpt-5-mini", "GPT-5 mini"),
  choice("gpt-5", "GPT-5"),
  choice("opus", "Claude Opus", { driver: "claudeAgent", providerName: "Claude" }),
  choice("sonnet", "Claude Sonnet", {
    shortName: "Sonnet",
    driver: "claudeAgent",
    providerName: "Claude",
  }),
  choice("glm", "GLM 4", { subProvider: "Zhipu", driver: "opencode", providerName: "OpenCode" }),
];

const slugs = (list: ReadonlyArray<ModelChoice>) => list.map((entry) => entry.model);

describe("filterModels", () => {
  it("returns every model, in order, for no words", () => {
    expect(filterModels(models, "")).toBe(models);
    expect(slugs(filterModels(models, "   "))).toEqual(slugs(models));
  });

  it("puts an exact name before a longer one that only starts with it", () => {
    expect(slugs(filterModels(models, "gpt-5"))).toEqual(["gpt-5", "gpt-5-mini"]);
  });

  it("needs every word to match some field", () => {
    expect(slugs(filterModels(models, "claude opus"))).toEqual(["opus"]);
    expect(slugs(filterModels(models, "claude nothing"))).toEqual([]);
  });

  it("looks in the sub-provider, the driver and the provider name too", () => {
    expect(slugs(filterModels(models, "zhipu"))).toEqual(["glm"]);
    expect(slugs(filterModels(models, "opencode"))).toEqual(["glm"]);
    expect(slugs(filterModels(models, "claudeagent"))).toEqual(["opus", "sonnet"]);
  });

  it("ignores case and keeps the list's own order among equal matches", () => {
    expect(slugs(filterModels(models, "CLAUDE"))).toEqual(["opus", "sonnet"]);
  });

  it("matches a Korean word typed in a model name", () => {
    const korean = [choice("a", "추론 모델"), choice("b", "빠른 모델")];
    expect(slugs(filterModels(korean, "빠른"))).toEqual(["b"]);
    expect(slugs(filterModels(korean, "모델"))).toEqual(["a", "b"]);
  });

  it("reads a model the server does not list from its label", () => {
    const bare: ModelChoice = { instanceId: "x", model: "old", label: "Legacy / Old one" };
    expect(slugs(filterModels([bare], "legacy"))).toEqual(["old"]);
    expect(scoreModelChoice(bare, "zzz")).toBeNull();
  });
});
