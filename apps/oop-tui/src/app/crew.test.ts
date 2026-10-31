import type { CrewSettings, ServerConfig } from "@t3tools/contracts";
import { resolveCrew } from "@t3tools/shared/crew";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCrewChange,
  crewAsDefault,
  crewBrainProblem,
  crewEnabledFor,
  crewPickItems,
  parseCrewPreset,
  parseCrewRole,
  roleModelText,
} from "./crew.ts";

const provider = (instanceId: string, driver: string, models: ReadonlyArray<[string, string]>) => ({
  instanceId,
  driver,
  displayName: driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : "Other",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: models.map(([slug, name], index) => ({
    slug,
    name,
    isCustom: false,
    isDefault: index === 0,
    capabilities: null,
  })),
});

const providers = [
  provider("codex", "codex", [
    ["gpt-5", "GPT-5"],
    ["gpt-5-mini", "GPT-5 mini"],
  ]),
  provider("claudeAgent", "claudeAgent", [
    ["claude-opus-4", "Opus 4"],
    ["claude-haiku-4", "Haiku 4"],
  ]),
  provider("opencode", "opencode", [["o-1", "Open One"]]),
] as unknown as ServerConfig["providers"];

const config = { providers } as unknown as ServerConfig;

const base = (over: Partial<CrewSettings> = {}): CrewSettings => ({
  enabled: false,
  preset: "recommended",
  pinned: {},
  threads: {},
  ...over,
});

type Pin = NonNullable<CrewSettings["pinned"]["worker"]>;
const haiku = { instanceId: "claudeAgent", model: "claude-haiku-4" } as unknown as Pin;
const opus = { instanceId: "claudeAgent", model: "claude-opus-4" } as unknown as Pin;

describe("applyCrewChange", () => {
  it("turns the crew on for one thread without touching the defaults or other threads", () => {
    const settings = base({
      preset: "speed",
      pinned: { worker: haiku },
      threads: { other: { enabled: true, preset: "quality" } },
    } as Partial<CrewSettings>);
    const next = applyCrewChange(settings, "t1", { enabled: true });
    expect(next.enabled).toBe(false);
    expect(next.preset).toBe("speed");
    expect(next.pinned).toEqual({ worker: haiku });
    expect(next.threads).toEqual({
      other: { enabled: true, preset: "quality" },
      t1: { enabled: true, pinned: {} },
    });
  });

  it("keeps what the thread's own override already says", () => {
    const settings = base({
      threads: { t1: { preset: "budget", pinned: { auditor: opus } } },
    } as Partial<CrewSettings>);
    const next = applyCrewChange(settings, "t1", { enabled: true });
    expect(next.threads).toEqual({
      t1: { enabled: true, preset: "budget", pinned: { auditor: opus } },
    });
  });

  it("pins a role in the thread, and puts a role back on Auto with null even if the defaults pin it", () => {
    const settings = base({ pinned: { worker: haiku } });
    const pinned = applyCrewChange(settings, "t1", { pins: { expert: opus } });
    expect(pinned.threads).toEqual({ t1: { pinned: { expert: opus } } });
    const auto = applyCrewChange(pinned, "t1", { pins: { worker: null } });
    expect(auto.threads).toEqual({ t1: { pinned: { expert: opus, worker: null } } });
    expect(auto.pinned).toEqual({ worker: haiku });
    const resolved = resolveCrew({ settings: auto, threadId: "t1", providers, brain: null });
    expect(resolved.pinned.has("worker")).toBe(false);
    expect(resolved.pinned.has("expert")).toBe(true);
  });

  it("changes the defaults when there is no thread, and removes a pin that goes back to Auto", () => {
    const settings = base({ pinned: { worker: haiku, auditor: opus } });
    const next = applyCrewChange(settings, null, {
      enabled: true,
      preset: "quality",
      pins: { worker: null, expert: haiku },
    });
    expect(next).toEqual({
      enabled: true,
      preset: "quality",
      pinned: { auditor: opus, expert: haiku },
      threads: {},
    });
  });
});

describe("crewAsDefault", () => {
  it("copies what the thread runs with, pinned roles only, and leaves the overrides alone", () => {
    const settings = base({
      threads: { t1: { enabled: true, preset: "quality", pinned: { worker: haiku } } },
    } as Partial<CrewSettings>);
    const crew = resolveCrew({ settings, threadId: "t1", providers, brain: null });
    const next = crewAsDefault(settings, crew);
    expect(next.enabled).toBe(true);
    expect(next.preset).toBe("quality");
    expect(next.pinned).toEqual({ worker: haiku });
    expect(next.threads).toEqual(settings.threads);
  });
});

describe("crewEnabledFor", () => {
  it("reads the thread's override first, then the defaults", () => {
    const settings = base({
      enabled: true,
      threads: { t1: { enabled: false } },
    } as Partial<CrewSettings>);
    expect(crewEnabledFor(settings, "t1")).toBe(false);
    expect(crewEnabledFor(settings, "t2")).toBe(true);
    expect(crewEnabledFor(settings, null)).toBe(true);
  });
});

describe("crewBrainProblem", () => {
  it("accepts the providers that get the crew tools and explains the others", () => {
    expect(crewBrainProblem(config, { instanceId: "codex" })).toBeNull();
    expect(crewBrainProblem(config, { instanceId: "claudeAgent" })).toBeNull();
    expect(crewBrainProblem(config, { instanceId: "opencode" })).toContain(
      "brain 이 될 수 없습니다",
    );
    expect(crewBrainProblem(config, { instanceId: "gone" })).toContain("서버 목록에 없는");
    expect(crewBrainProblem(config, null)).toContain("모델이 없습니다");
  });
});

describe("parsing", () => {
  it("reads roles and presets by value, alias or Korean label", () => {
    expect(parseCrewRole(" Worker ")).toBe("worker");
    expect(parseCrewRole("boss")).toBeNull();
    expect(parseCrewPreset("speed")).toBe("speed");
    expect(parseCrewPreset("cheap")).toBe("budget");
    expect(parseCrewPreset("품질")).toBe("quality");
    expect(parseCrewPreset("")).toBeNull();
    expect(parseCrewPreset("slow")).toBeNull();
  });
});

describe("crewPickItems", () => {
  const items = (query: string) => crewPickItems(providers, null, query);

  it("offers Auto first and then every model the crew can run", () => {
    const all = items("");
    expect(all[0]).toMatchObject({ kind: "auto" });
    expect(all.filter((item) => item.kind === "model")).toHaveLength(5);
  });

  it("narrows by the typed words and drops Auto when they rule it out", () => {
    const found = items("haiku");
    expect(found.map((item) => item.kind)).toEqual(["model"]);
    expect(found[0]).toMatchObject({ kind: "model", selection: haiku });
    expect(items("auto")[0]).toMatchObject({ kind: "auto" });
  });
});

describe("roleModelText", () => {
  it("says Auto for an unpinned role and names the model of a pinned one", () => {
    const settings = base({ pinned: { worker: haiku } });
    const crew = resolveCrew({ settings, threadId: null, providers, brain: null });
    expect(roleModelText(crew, "worker")).toBe("Haiku 4");
    expect(roleModelText(crew, "expert")).toMatch(/^Auto · /u);
  });
});
