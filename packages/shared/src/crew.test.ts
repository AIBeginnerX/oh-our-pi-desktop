import type { CrewSettings, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewFallbackChain,
  crewModelOptions,
  crewModelTier,
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
  threads: {},
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
      threadId: null,
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("gpt-5.4");
    expect([...crew.pinned]).toEqual(["worker"]);
  });

  it("layers a thread's override over the defaults", () => {
    const crew = resolveCrew({
      settings: settings({
        threads: { "thread-1": { enabled: false, preset: "budget" } } as never,
      }),
      threadId: "thread-1",
      providers,
      brain,
    });
    expect([crew.enabled, crew.preset]).toEqual([false, "budget"]);
  });

  it("lets a thread set a role back to Auto even when the defaults pin it", () => {
    const crew = resolveCrew({
      settings: settings({
        pinned: { worker: { instanceId: "codex", model: "gpt-5.4" } as never },
        threads: { "thread-1": { pinned: { worker: null } } } as never,
      }),
      threadId: "thread-1",
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("claude-haiku-5");
    expect(crew.pinned.has("worker")).toBe(false);
  });

  it("falls back to the preset when a pinned model is no longer available", () => {
    const crew = resolveCrew({
      settings: settings({
        pinned: { worker: { instanceId: "cursor", model: "composer-2" } as never },
      }),
      threadId: null,
      providers,
      brain,
    });
    expect(crew.roles.worker?.selection.model).toBe("claude-haiku-5");
    expect(crew.pinned.size).toBe(0);
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
