import type { CrewSettings, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCrewChange,
  canLeadCrew,
  crewAsDefault,
  crewFallbackChain,
  crewModelOptions,
  crewModelTier,
  modelFamily,
  recommendCrew,
  resolveCrew,
} from "./crew.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; legacy?: boolean }>,
  overrides: Record<string, unknown> = {},
): ServerProvider =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      isLegacy: model.legacy === true,
      capabilities: null,
    })),
    ...overrides,
  }) as unknown as ServerProvider;

const providers = [
  provider("claude", "claudeAgent", [{ slug: "claude-opus-5" }, { slug: "claude-haiku-5" }]),
  provider("codex", "codex", [
    { slug: "gpt-5.4" },
    { slug: "gpt-5.4-mini" },
    { slug: "gpt-4", legacy: true },
  ]),
  provider("cursor", "cursor", [{ slug: "composer-2" }], { auth: { status: "unauthenticated" } }),
];
const brain = { instanceId: "claude", model: "claude-opus-5" } as never;
const settings = (overrides: Partial<CrewSettings> = {}): CrewSettings => ({
  enabled: true,
  preset: "recommended",
  pinned: {},
  ...overrides,
});

describe("crew models", () => {
  it("ranks fast, balanced, and strongest models", () => {
    expect([
      crewModelTier("claude-haiku-5", ""),
      crewModelTier("gpt-5.4", ""),
      crewModelTier("claude-opus-5", ""),
    ]).toEqual([1, 2, 3]);
  });

  it("offers only signed-in providers and skips legacy models", () => {
    expect(crewModelOptions(providers).map((option) => option.selection.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });
});

describe("recommendCrew", () => {
  it("gives the worker a fast model from the brain's provider and the audit to another provider", () => {
    const crew = recommendCrew(crewModelOptions(providers), brain, "recommended");
    expect(crew.worker?.selection.model).toBe("claude-haiku-5");
    expect(crew.auditor?.selection.instanceId).toBe("codex");
  });

  it("keeps every role on fast models for the budget preset", () => {
    const crew = recommendCrew(crewModelOptions(providers), brain, "budget");
    expect([crew.worker?.tier, crew.expert?.tier, crew.auditor?.tier]).toEqual([1, 1, 1]);
  });
});

describe("resolveCrew", () => {
  it("lets a pinned role win over the preset and reports it as pinned", () => {
    const crew = resolveCrew({
      settings: settings({
        pinned: { worker: { instanceId: "codex", model: "gpt-5.4" } as never },
      }),
      override: null,
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("gpt-5.4");
    expect([...crew.pinned]).toEqual(["worker"]);
  });

  it("layers a thread's own crew over the defaults", () => {
    const crew = resolveCrew({
      settings: settings(),
      override: { enabled: false, preset: "budget" },
      providers,
      brain,
    });
    expect([crew.enabled, crew.preset, crew.source]).toEqual([false, "budget", "thread"]);
  });

  it("lets a thread set a role back to Auto even when the defaults pin it", () => {
    const crew = resolveCrew({
      settings: settings({
        pinned: { worker: { instanceId: "codex", model: "gpt-5.4" } as never },
      }),
      override: { pinned: { worker: null } },
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("claude-haiku-5");
    expect(crew.pinned.has("worker")).toBe(false);
  });

  it("runs the defaults for a thread without a crew of its own, and says so", () => {
    for (const override of [null, undefined]) {
      const crew = resolveCrew({ settings: settings(), override, providers, brain });
      expect([crew.enabled, crew.source]).toEqual([true, "default"]);
    }
  });

  it("keeps threads independent: one thread's crew never moves another's or the default", () => {
    const defaults = settings({ preset: "speed" });
    const resolve = (override: Parameters<typeof resolveCrew>[0]["override"]) =>
      resolveCrew({ settings: defaults, override, providers, brain });
    const before = resolve(null);
    const changed = resolve({
      enabled: false,
      preset: "quality",
      pinned: { expert: { instanceId: "codex", model: "gpt-5.4-mini" } as never },
    });
    expect(changed.roles.expert?.selection.model).toBe("gpt-5.4-mini");
    expect(changed.preset).toBe("quality");
    // another thread, still without a crew, and the defaults themselves, are as they were
    const other = resolve(null);
    expect(other.preset).toBe("speed");
    expect(other.enabled).toBe(true);
    expect(other.roles).toEqual(before.roles);
    expect(defaults).toEqual(settings({ preset: "speed" }));
  });

  it("falls back to the preset when a pinned model is no longer available", () => {
    const crew = resolveCrew({
      settings: settings({
        pinned: { worker: { instanceId: "cursor", model: "composer-2" } as never },
      }),
      override: null,
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("claude-haiku-5");
    expect(crew.pinned.size).toBe(0);
  });
});

describe("applyCrewChange", () => {
  it("starts a thread's crew from nothing and keeps what the change does not name", () => {
    const first = applyCrewChange(null, { preset: "speed" });
    expect(first).toEqual({ preset: "speed", pinned: {} });
    const codex = { instanceId: "codex", model: "gpt-5.4" } as never;
    const second = applyCrewChange(first, { pins: { worker: codex } });
    expect(second).toEqual({ preset: "speed", pinned: { worker: codex } });
    // a null pin is kept: it is how a thread says Auto against a pinned default
    expect(applyCrewChange(second, { enabled: true, pins: { worker: null } })).toEqual({
      enabled: true,
      preset: "speed",
      pinned: { worker: null },
    });
  });

  it("does not touch the crew it was given", () => {
    const current = { enabled: true, pinned: {} };
    applyCrewChange(current, { enabled: false, preset: "budget" });
    expect(current).toEqual({ enabled: true, pinned: {} });
  });
});

describe("crewAsDefault", () => {
  it("makes the thread's crew the default and keeps only hand-picked models as pins", () => {
    const codex = { instanceId: "codex", model: "gpt-5.4" } as never;
    const crew = resolveCrew({
      settings: settings({ enabled: false }),
      override: { enabled: true, preset: "quality", pinned: { worker: codex } },
      providers,
      brain,
    });
    const next = crewAsDefault(settings({ enabled: false }), crew);
    expect(next.enabled).toBe(true);
    expect(next.preset).toBe("quality");
    expect(Object.keys(next.pinned)).toEqual(["worker"]);
    expect(next.pinned.worker?.model).toBe("gpt-5.4");
  });
});

describe("crewFallbackChain", () => {
  const team = [
    provider("zai", "opencode", [{ slug: "glm-5.3-flash" }]),
    provider("claude", "claudeAgent", [{ slug: "claude-opus-5" }, { slug: "claude-haiku-5" }]),
    provider("codex", "codex", [{ slug: "gpt-5.4" }, { slug: "gpt-5.4-mini" }]),
  ];
  const options = crewModelOptions(team);
  const glm = options.find((option) => option.selection.model === "glm-5.3-flash") ?? null;
  const models = (chain: ReturnType<typeof crewFallbackChain>) =>
    chain.map((option) => option.selection.model);

  it("tries the assigned worker, then the preset default, then another fast model", () => {
    expect(
      models(
        crewFallbackChain({ options, role: "worker", assigned: glm, preset: "recommended", brain }),
      ),
    ).toEqual(["glm-5.3-flash", "claude-haiku-5", "gpt-5.4-mini"]);
  });

  it("skips providers that just failed and never hands work back to the brain model", () => {
    const chain = crewFallbackChain({
      options,
      role: "worker",
      assigned: glm,
      preset: "recommended",
      brain,
      unavailableInstances: new Set(["zai"]),
      limit: 5,
    });
    expect(models(chain)).toEqual(["claude-haiku-5", "gpt-5.4-mini", "gpt-5.4"]);
  });

  it("keeps an expert on strong models before dropping a level", () => {
    const chain = crewFallbackChain({
      options,
      role: "expert",
      assigned: null,
      preset: "quality",
      brain: { instanceId: "codex", model: "gpt-5.4" } as never,
    });
    expect(chain[0]?.selection.model).toBe("claude-opus-5");
  });
});

describe("modelFamily", () => {
  it("names the model family from the slug first and the driver last", () => {
    const family = (slug: string, driver: string) => modelFamily(slug, driver);
    // Cursor hosts models of other families: the slug wins over the driver.
    expect(family("claude-opus-5", "cursor")).toBe("claude");
    expect(family("claude-haiku-5", "claudeAgent")).toBe("claude");
    expect(family("fable-1", "opencode")).toBe("claude");
    expect(family("gpt-5.4", "cursor")).toBe("openai");
    expect(family("gpt-5.3-codex", "codex")).toBe("openai");
    expect(family("o3-mini", "opencode")).toBe("openai");
    expect(family("gemini-3-pro", "antigravity")).toBe("google");
    expect(family("grok-4", "grok")).toBe("xai");
    expect(family("composer-2", "cursor")).toBe("xai");
    expect(family("glm-5.3-flash", "opencode")).toBe("glm");
    expect(family("kimi-k3", "opencode")).toBe("kimi");
    expect(family("qwen3-coder", "opencode")).toBe("qwen");
    expect(family("deepseek-v4", "opencode")).toBe("deepseek");
    expect(family("MiniMax-M2", "opencode")).toBe("minimax");
    expect(family("mystery-1", "opencode")).toBe("opencode");
  });
});

describe("crewFallbackChain: a different family", () => {
  const team = [
    provider("zai", "opencode", [{ slug: "glm-5.3-flash" }, { slug: "glm-5.3-pro" }]),
    provider("claude", "claudeAgent", [{ slug: "claude-opus-5" }, { slug: "claude-haiku-5" }]),
    provider("codex", "codex", [{ slug: "gpt-5.4" }, { slug: "gpt-5.4-mini" }]),
  ];
  const options = crewModelOptions(team);
  const pickOf = (slug: string) =>
    options.find((option) => option.selection.model === slug) ?? null;
  const models = (chain: ReturnType<typeof crewFallbackChain>) =>
    chain.map((option) => option.selection.model);
  const base = {
    role: "worker" as const,
    preset: "recommended" as const,
    brain,
    limit: 6,
  };

  it("puts models of the avoided family last", () => {
    const glm = pickOf("glm-5.3-flash");
    const chain = crewFallbackChain({
      ...base,
      options,
      assigned: glm,
      avoidFamilies: new Set(["glm"]),
      avoidSelections: [glm!.selection],
    });
    expect(models(chain).slice(-2).sort()).toEqual(["glm-5.3-flash", "glm-5.3-pro"]);
    expect(modelFamily(chain[0]!.selection.model, chain[0]!.driver)).not.toBe("glm");
  });

  it("starts the next candidate on a family neither earlier one used", () => {
    const glm = pickOf("glm-5.3-flash");
    const haiku = pickOf("claude-haiku-5");
    const chain = crewFallbackChain({
      ...base,
      options,
      assigned: glm,
      avoidFamilies: new Set(["glm", "claude"]),
      avoidSelections: [glm!.selection, haiku!.selection],
    });
    expect(modelFamily(chain[0]!.selection.model, chain[0]!.driver)).toBe("openai");
  });

  it("falls back to another model of the same family when it is the only family", () => {
    const only = crewModelOptions([team[0]!]);
    const flash = only.find((option) => option.selection.model === "glm-5.3-flash")!;
    const chain = crewFallbackChain({
      ...base,
      options: only,
      assigned: flash,
      avoidFamilies: new Set(["glm"]),
      avoidSelections: [flash.selection],
    });
    expect(models(chain)).toEqual(["glm-5.3-pro", "glm-5.3-flash"]);
  });

  it("keeps the same model when it is the only one there is", () => {
    const only = crewModelOptions([provider("zai", "opencode", [{ slug: "glm-5.3-flash" }])]);
    const chain = crewFallbackChain({
      ...base,
      options: only,
      assigned: only[0]!,
      avoidFamilies: new Set(["glm"]),
      avoidSelections: [only[0]!.selection],
    });
    expect(models(chain)).toEqual(["glm-5.3-flash"]);
  });

  it("changes nothing without avoid options", () => {
    const glm = pickOf("glm-5.3-flash");
    expect(models(crewFallbackChain({ ...base, options, assigned: glm }))).toEqual([
      "glm-5.3-flash",
      "claude-haiku-5",
      "gpt-5.4-mini",
      "gpt-5.4",
      "glm-5.3-pro",
    ]);
  });
});

describe("canLeadCrew", () => {
  it("lets only Claude and Codex threads lead a crew", () => {
    expect(canLeadCrew("claudeAgent")).toBe(true);
    expect(canLeadCrew("codex")).toBe(true);
    for (const driver of ["cursor", "grok", "opencode", "antigravity", "minimax", "zcode", ""]) {
      expect(canLeadCrew(driver)).toBe(false);
    }
  });
});
