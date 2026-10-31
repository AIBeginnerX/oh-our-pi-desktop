import type { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeProject, makeSession, makeSnapshot, makeThreadShell } from "../testing/fixtures.ts";
import {
  configWith,
  savedPreset,
  SECRET,
  serverProvider,
  settingsWith,
  entryOf,
} from "../testing/providerFixtures.ts";
import {
  addPatch,
  planLines,
  planRemove,
  previewPayload,
  providerRows,
  removePatch,
  takenIds,
  tryBuild,
} from "./providerPlan.ts";
import { buildInstance, newDraft, parseTarget, withId, withValue } from "./providerSpec.ts";

const codexDefault = { driver: "codex", enabled: true };
const settings = () =>
  settingsWith({ codex: codexDefault, opencode_zai: savedPreset, codex_work: { driver: "codex" } });

const thread = (id: string, instanceId: string, over: Record<string, unknown> = {}) =>
  makeThreadShell({
    id,
    title: `제목 ${id}`,
    modelSelection: { instanceId, model: "m" },
    ...over,
  });

const shellWith = (...threads: ReturnType<typeof makeThreadShell>[]): OrchestrationShellSnapshot =>
  makeSnapshot([makeProject()], threads);

describe("the provider rows", () => {
  it("say what the server says: state, model count and message, with sanitized text", () => {
    const config = configWith(settings(), [
      serverProvider("codex"),
      serverProvider("codex_work", { status: "warning", message: "느림\u001b[31m\n둘째 줄" }),
      serverProvider("opencode_zai", { status: "error", models: [] }),
      serverProvider("off", { enabled: false, status: "disabled" }),
      serverProvider("gone", { installed: false }),
      serverProvider("shadow", { availability: "unavailable" }),
    ]);
    const rows = providerRows(config, settings());
    expect(rows.map((row) => [row.id, row.status, row.models])).toEqual([
      ["codex", "준비됨", 1],
      ["codex_work", "경고", 1],
      ["opencode_zai", "오류", 0],
      ["off", "꺼짐", 1],
      ["gone", "미설치", 1],
      ["shadow", "사용 불가", 1],
    ]);
    expect(rows[1]?.message).not.toContain("\u001b");
    expect(rows[1]?.message).not.toContain("\n");
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[1]?.isDefault).toBe(false);
  });

  it("add an instance only the settings know, and work with no server report at all", () => {
    const rows = providerRows(null, settings());
    expect(rows.map((row) => row.id)).toEqual(["codex", "opencode_zai", "codex_work"]);
    expect(rows.every((row) => row.models === null)).toBe(true);
    expect(providerRows(null, null)).toEqual([]);
  });

  it("collect every id in use", () => {
    const config = configWith(settings(), [serverProvider("claudeAgent")]);
    expect([...takenIds(config, settings())].toSorted()).toEqual([
      "claudeAgent",
      "codex",
      "codex_work",
      "opencode_zai",
    ]);
  });
});

describe("the add patch", () => {
  const draft = withId(newDraft(parseTarget("codex")!), "codex_new");

  it("adds the instance and passes every other one on exactly as the server sent it", () => {
    const current = settings();
    const patch = addPatch(current, "codex_new", buildInstance(draft));
    expect(Object.keys(patch ?? {})).toEqual(["providerInstances"]);
    const sent = patch?.providerInstances ?? {};
    expect(Object.keys(sent)).toEqual(["codex", "opencode_zai", "codex_work", "codex_new"]);
    // The other instances are the very objects, so a secret's marker is not lost.
    expect(entryOf(sent, "opencode_zai")).toBe(entryOf(current.providerInstances, "opencode_zai"));
    expect(entryOf(sent, "opencode_zai")?.environment?.[0]).toEqual({
      name: "OOP_ZAI_API_KEY",
      value: "",
      sensitive: true,
      valueRedacted: true,
    });
  });

  it("does nothing when the id is taken", () => {
    expect(addPatch(settings(), "codex_work", buildInstance(draft))).toBeNull();
  });

  it("is built from the settings it is given, so a newer record is not undone", () => {
    const newer = settingsWith({
      ...settings().providerInstances,
      added_elsewhere: { driver: "grok" },
    });
    const sent = addPatch(newer, "codex_new", buildInstance(draft))?.providerInstances ?? {};
    expect(Object.keys(sent)).toContain("added_elsewhere");
  });
});

describe("the remove patch", () => {
  it("drops only the one instance and keeps the rest untouched", () => {
    const current = settings();
    const sent = removePatch(current, "codex_work")?.providerInstances ?? {};
    expect(Object.keys(sent)).toEqual(["codex", "opencode_zai"]);
    expect(entryOf(sent, "opencode_zai")).toBe(entryOf(current.providerInstances, "opencode_zai"));
  });

  it("does nothing when it is not there, whatever the id looks like", () => {
    expect(removePatch(settings(), "nope")).toBeNull();
    expect(removePatch(settings(), "bad id!")).toBeNull();
    expect(removePatch(settings(), "constructor")).toBeNull();
  });
});

describe("what an add would send", () => {
  const preset = {
    ...withId(newDraft(parseTarget("zai")!), "opencode_zai2"),
    values: { service: "api", model: "glm-5.3", apiKey: SECRET },
    env: [{ name: "EXTRA", value: `${SECRET}-env`, sensitive: true }],
  };
  const gemini = {
    ...withId(newDraft(parseTarget("antigravity")!), "antigravity_key"),
    values: withValue(parseTarget("antigravity")!, {}, "apiKey", SECRET),
  };

  it("hides every secret in the preview, in the environment and in plain config fields", () => {
    for (const draft of [preset, gemini]) {
      const built = tryBuild(draft);
      if (!built.ok) throw new Error(built.message);
      const preview = previewPayload(draft, built.instance);
      expect(preview).not.toContain(SECRET);
      expect(preview).toContain("****");
      expect(preview).toContain(draft.id);
    }
    // The API key really is in the instance, so the preview is hiding something.
    expect(JSON.stringify(buildInstance(gemini))).toContain(SECRET);
  });

  it("reports a failing builder without echoing a secret", () => {
    const bad = { ...preset, values: { service: "api", model: `a/${SECRET}`, apiKey: SECRET } };
    const built = tryBuild(bad);
    expect(built.ok).toBe(false);
    expect(JSON.stringify(built)).not.toContain(SECRET);
  });
});

describe("planning a removal", () => {
  it("refuses a built-in instance and says why", () => {
    const check = planRemove({ id: "codex", settings: settings(), shell: null });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("기본 인스턴스");
      expect(check.reason).toContain("Codex");
    }
  });

  it("refuses an id that is not there, or is not a plain id", () => {
    for (const id of ["nope", "bad id\u001b[0m", "constructor"]) {
      const check = planRemove({ id, settings: settings(), shell: null });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).not.toContain("\u001b");
    }
  });

  it("counts what depends on the instance, and counts the secrets it holds", () => {
    const withPins = settingsWith(settings().providerInstances, {
      crew: {
        enabled: true,
        preset: "recommended",
        pinned: {
          explore: { instanceId: "opencode_zai", model: "m" },
          plan: { instanceId: "codex", model: "m" },
        },
        threads: { t1: { pinned: { explore: { instanceId: "opencode_zai", model: "m" } } } },
      },
      textGenerationModelSelection: { instanceId: "opencode_zai", model: "m" },
    });
    const shell = makeSnapshot(
      [makeProject()],
      [
        thread("a", "opencode_zai"),
        thread("b", "opencode_zai", { session: makeSession("running") }),
        thread("c", "opencode_zai"),
        thread("d", "opencode_zai"),
        thread("e", "codex"),
      ],
    );
    const withProject = {
      ...shell,
      projects: [
        {
          ...shell.projects[0]!,
          defaultModelSelection: { instanceId: "opencode_zai", model: "m" },
        },
      ],
    } as unknown as OrchestrationShellSnapshot;
    const check = planRemove({ id: "opencode_zai", settings: withPins, shell: withProject });
    if (!check.ok) throw new Error(check.reason);
    expect(check.plan).toMatchObject({
      secrets: 1,
      crewPins: 2,
      textGeneration: true,
      projects: 1,
      threadsKnown: true,
      threads: { total: 4, running: 1 },
    });
    expect(check.plan.threads.titles).toHaveLength(3);
    const lines = planLines(check.plan).join("\n");
    expect(lines).toContain("스레드 4개 (실행 중 1개)");
    expect(lines).toContain("… 외 1개");
    expect(lines).toContain("비밀값 1개");
    expect(lines).toContain("자동으로 바뀌지 않습니다");
  });

  it("says the form is wrong, without repeating it, for an id that cannot be one", () => {
    const missing = planRemove({ id: "nothere", settings: settings(), shell: null });
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.reason).toContain("'nothere' 라는 Provider 가 없습니다");
    const odd = planRemove({ id: `${SECRET}.x y`, settings: settings(), shell: null });
    expect(odd).toMatchObject({ ok: false });
    expect(!odd.ok && odd.reason).toContain("형식이 잘못됐습니다");
    expect(!odd.ok && odd.reason).not.toContain(SECRET);
  });

  it("says plainly when nothing depends on it, and when the thread list is not known yet", () => {
    const none = planRemove({ id: "codex_work", settings: settings(), shell: shellWith() });
    if (!none.ok) throw new Error(none.reason);
    expect(planLines(none.plan).join("\n")).toContain("쓰는 스레드는 없습니다");
    expect(planLines(none.plan).join("\n")).not.toContain("자동으로");
    const unknown = planRemove({ id: "codex_work", settings: settings(), shell: null });
    if (!unknown.ok) throw new Error(unknown.reason);
    expect(unknown.plan.threadsKnown).toBe(false);
    expect(planLines(unknown.plan).join("\n")).toContain("알 수 없습니다");
  });

  it("cleans a title taken from the server", () => {
    const shell = shellWith(
      thread("a", "codex_work", { title: "나쁜\u001b]0;x\u0007 제목\n둘째" }),
    );
    const check = planRemove({ id: "codex_work", settings: settings(), shell });
    if (!check.ok) throw new Error(check.reason);
    expect(check.plan.threads.titles[0]).not.toMatch(/\p{Cc}/u);
  });
});
