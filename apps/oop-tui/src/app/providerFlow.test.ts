import type { ServerConfig, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CommandRejectedError } from "../link/transport.ts";
import { makeStyle } from "../render/style.ts";
import { UNICODE_SYMBOLS } from "../render/symbols.ts";
import { stripAnsi } from "../text/width.ts";
import { makeProject, makeSnapshot, makeThreadShell } from "../testing/fixtures.ts";
import {
  configWith,
  key,
  paste,
  savedPreset,
  SECRET,
  serverProvider,
  settingsWith,
  text,
  entryOf,
} from "../testing/providerFixtures.ts";
import { ProviderFlow } from "./providerFlow.ts";
import { createSettingsPatcher } from "./settingsPatch.ts";

const enter = key("enter");
const escape = key("escape");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = (
  options: {
    online?: boolean;
    noConfig?: boolean;
    refreshFails?: boolean;
    instances?: Record<string, unknown>;
  } = {},
) => {
  let settings: ServerSettings = settingsWith(
    options.instances ?? {
      codex: { driver: "codex", enabled: true },
      opencode_zai: savedPreset,
      codex_work: { driver: "codex" },
    },
  );
  const sent: ServerSettingsPatch[] = [];
  const said: string[] = [];
  const recorded: string[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const refreshed: Array<{ instanceId?: string } | undefined> = [];
  /** What the link's copy of the settings holds, when it lags behind the server. */
  let configSettings: ServerSettings | null = null;
  let online = options.online ?? true;
  let failure: Error | null = null;
  let gate: Promise<void> | null = null;
  let changes = 0;
  const link = {
    getSettings: async () => settings,
    updateSettings: async (patch: ServerSettingsPatch) => {
      if (gate) await gate;
      if (failure) throw failure;
      sent.push(patch);
      settings = { ...settings, ...patch } as ServerSettings;
      return settings;
    },
  };
  const shell = makeSnapshot(
    [makeProject()],
    [makeThreadShell({ id: "a", modelSelection: { instanceId: "opencode_zai", model: "m" } })],
  );
  const flow = new ProviderFlow({
    config: () =>
      options.noConfig
        ? null
        : (() => {
            const seen = configSettings ?? settings;
            return configWith(
              seen,
              Object.keys(seen.providerInstances).map((id) => serverProvider(id)),
            ) as ServerConfig;
          })(),
    shell: () => shell,
    online: () => online,
    patch: createSettingsPatcher(link),
    refresh: async (input) => {
      refreshed.push(input);
      if (options.refreshFails) throw new Error("refresh failed");
      return [];
    },
    rail: () => ({ style: makeStyle(false), symbols: UNICODE_SYMBOLS }),
    width: () => 60,
    say: (lines) => void said.push(...lines.map(stripAnsi)),
    record: (label, value) => void recorded.push(`${label} ${value}`),
    error: (message) => void errors.push(message),
    notify: (message) => void notices.push(message),
    changed: () => void (changes += 1),
  });
  const press = (...events: Parameters<ProviderFlow["key"]>[0][]) =>
    events.forEach((e) => flow.key(e));
  const typeText = (value: string) => press(text(value));
  const frame = () =>
    flow
      .frame({
        columns: 61,
        rows: 24,
        style: makeStyle(false),
        symbols: UNICODE_SYMBOLS,
        banner: null,
        tone: "warning",
      })
      .lines.map(stripAnsi)
      .join("\n");
  return {
    flow,
    sent,
    said,
    recorded,
    errors,
    notices,
    refreshed,
    press,
    typeText,
    frame,
    settings: () => settings,
    setSettings: (next: ServerSettings) => void (settings = next),
    freezeConfig: () => void (configSettings = settings),
    setOnline: (value: boolean) => void (online = value),
    failWith: (error: Error | null) => void (failure = error),
    holdUpdates: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => void (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
    changes: () => changes,
    everything: () => [...said, ...recorded, ...errors, ...notices, frame()].join("\n"),
  };
};

/** Opens the Z.AI preset form, types the key, and goes to the review. */
const toReview = (t: ReturnType<typeof setup>, id = "opencode_zai2") => {
  t.flow.run(`add zai --id ${id}`);
  t.press(enter);
  t.press(text(SECRET));
  t.press(enter);
  // The form's pointer starts on the key; the last row goes on.
  t.press(...Array.from({ length: 6 }, () => key("down")), enter);
};

describe("/provider list", () => {
  it("writes the instances into the scrollback, and opens no screen", () => {
    const t = setup();
    t.flow.run("");
    t.flow.run("list");
    expect(t.flow.isOpen()).toBe(false);
    const note = t.said.join("\n");
    expect(note).toContain("codex");
    expect(note).toContain("opencode_zai");
    expect(note).toContain("준비됨");
    expect(note).toContain("모델 1");
    expect(note).toContain("기본");
  });

  it("needs a server to talk to", () => {
    const t = setup({ noConfig: true });
    t.flow.run("list");
    t.flow.run("add");
    expect(t.notices).toEqual([
      "서버에 연결된 뒤에 쓸 수 있습니다.",
      "서버에 연결된 뒤에 쓸 수 있습니다.",
    ]);
    expect(t.flow.isOpen()).toBe(false);
  });

  it("says what is wrong with the arguments, as a notice", () => {
    const t = setup();
    t.flow.run("frob");
    t.flow.run("add nope");
    expect(t.notices).toHaveLength(2);
    expect(t.flow.isOpen()).toBe(false);
  });
});

describe("/provider add", () => {
  it("opens the list of kinds with no arguments", () => {
    const t = setup();
    t.flow.run("add");
    expect(t.flow.isOpen()).toBe(true);
    expect(t.frame()).toContain("추가할 Provider");
  });

  it("adds an instance: patches the record, keeps the others, refreshes that instance, records it", async () => {
    const t = setup();
    const before = t.settings().providerInstances;
    toReview(t);
    expect(t.frame()).toContain("추가할까요?");
    t.press(enter);
    await flush();
    expect(t.sent).toHaveLength(1);
    const sent = t.sent[0]?.providerInstances ?? {};
    expect(Object.keys(sent)).toEqual(["codex", "opencode_zai", "codex_work", "opencode_zai2"]);
    expect(entryOf(sent, "opencode_zai")).toBe(entryOf(before, "opencode_zai"));
    expect(JSON.stringify(entryOf(sent, "opencode_zai2"))).toContain(SECRET);
    expect(t.flow.isOpen()).toBe(false);
    expect(t.recorded).toEqual(["Provider opencode_zai2 추가됨 (Z.AI)"]);
    expect(t.refreshed).toEqual([{ instanceId: "opencode_zai2" }]);
    expect(t.said.join("\n")).toContain("OpenCode 1.14.19");
  });

  it("never lets the secret reach the screen, the scrollback or the notices", async () => {
    const t = setup();
    t.flow.run("add zai --id opencode_zai2");
    t.press(enter, text(SECRET.slice(0, 5)), paste(SECRET.slice(5)));
    expect(t.frame()).not.toContain(SECRET);
    t.press(enter, ...Array.from({ length: 6 }, () => key("down")), enter);
    expect(t.everything()).not.toContain(SECRET);
    t.press(enter);
    await flush();
    expect(t.everything()).not.toContain(SECRET);
  });

  it("goes to the review at once for a command that has everything", () => {
    const t = setup();
    t.flow.run("add codex --id codex_new --name Fresh");
    expect(t.frame()).toContain("추가할까요?");
    expect(t.frame()).toContain("codex_new");
  });

  it("prints a --dry-run without adding, and without the secret", () => {
    const t = setup();
    t.flow.run("add codex --id codex_new --dry-run");
    expect(t.flow.isOpen()).toBe(false);
    expect(t.said.join("\n")).toContain("providerInstances");
    expect(t.said.join("\n")).toContain("codex_new");
    expect(t.sent).toEqual([]);
  });

  it("does not take a secret on the line, and says to type it in", () => {
    const t = setup();
    t.flow.run(`add zai --id x --set apiKey=${SECRET}`);
    expect(t.notices.join()).toContain("입력 화면");
    expect(t.everything()).not.toContain(SECRET);
    expect(t.flow.isOpen()).toBe(false);
  });

  it("keeps the screen open with the reason, redacted, when the server refuses", async () => {
    const t = setup();
    t.failWith(new CommandRejectedError(`bad key ${SECRET}`));
    toReview(t);
    t.press(enter);
    await flush();
    expect(t.flow.isOpen()).toBe(true);
    expect(t.flow.message()).toContain("추가 실패");
    expect(t.flow.message()).toContain("****");
    expect(t.flow.message()).not.toContain(SECRET);
    expect(t.flow.message()).not.toContain("확실하지");
    expect(t.refreshed).toEqual([]);
    expect(t.recorded).toEqual([]);
    // The next key clears the banner, and the user may try again.
    t.failWith(null);
    t.press(enter);
    await flush();
    expect(t.flow.isOpen()).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it("says a failure that may not have reached the server is uncertain", async () => {
    const t = setup();
    t.failWith(new Error("socket closed"));
    toReview(t);
    t.press(enter);
    await flush();
    expect(t.flow.message()).toContain("확실하지");
  });

  it("does not send while the link is down, and keeps the screen", async () => {
    const t = setup({ online: false });
    toReview(t);
    t.press(enter);
    await flush();
    expect(t.sent).toEqual([]);
    expect(t.flow.isOpen()).toBe(true);
    expect(t.flow.message()).toContain("연결이 끊겨");
    t.setOnline(true);
    t.press(enter);
    await flush();
    expect(t.sent).toHaveLength(1);
  });

  it("builds the patch from the newest settings, so an instance added elsewhere is kept", async () => {
    const t = setup();
    toReview(t);
    t.setSettings(
      settingsWith({ ...t.settings().providerInstances, added_elsewhere: { driver: "grok" } }),
    );
    t.press(enter);
    await flush();
    expect(Object.keys(t.sent[0]?.providerInstances ?? {})).toContain("added_elsewhere");
  });

  it("notices when the id was taken elsewhere meanwhile, and sends nothing", async () => {
    const t = setup();
    toReview(t);
    // The link's copy has not heard of it yet, so only the patch itself can notice.
    t.freezeConfig();
    t.setSettings(
      settingsWith({ ...t.settings().providerInstances, opencode_zai2: { driver: "grok" } }),
    );
    t.press(enter);
    await flush();
    expect(t.sent).toEqual([]);
    expect(t.flow.message()).toContain("다른 곳에서");
    expect(t.flow.isOpen()).toBe(true);

    // Where the link's copy already shows it, the review itself sends the user back to the form.
    const known = setup();
    toReview(known);
    known.setSettings(
      settingsWith({ ...known.settings().providerInstances, opencode_zai2: { driver: "grok" } }),
    );
    known.press(enter);
    await flush();
    expect(known.sent).toEqual([]);
    expect(known.flow.message()).toContain("이미 있는");
  });

  it("ignores keys while the change is on its way, then closes", async () => {
    const t = setup();
    toReview(t);
    const release = t.holdUpdates();
    t.press(enter);
    await flush();
    expect(t.flow.message()).toContain("추가하는 중");
    t.press(escape, key("down"), enter);
    expect(t.flow.isOpen()).toBe(true);
    release();
    await flush();
    expect(t.flow.isOpen()).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it("still reports the add when the refresh fails", async () => {
    const t = setup({ refreshFails: true });
    toReview(t);
    t.press(enter);
    await flush();
    expect(t.recorded).toHaveLength(1);
    expect(t.said.join("\n")).toContain("상태를 새로 읽지 못했습니다");
  });

  it("closes without sending on Esc, and leaves nothing open after close()", () => {
    const t = setup();
    t.flow.run("add");
    t.press(escape);
    expect(t.flow.isOpen()).toBe(false);
    t.flow.run("add");
    t.flow.close();
    expect(t.flow.isOpen()).toBe(false);
    expect(t.sent).toEqual([]);
  });
});

describe("/provider remove", () => {
  it("shows the plan and removes on yes, keeping every other instance as it was", async () => {
    const t = setup();
    const before = t.settings().providerInstances;
    t.flow.run("remove opencode_zai");
    const screen = t.frame();
    expect(screen).toContain("스레드 1개");
    expect(screen).toContain("비밀값 1개");
    t.typeText("yes");
    t.press(enter);
    await flush();
    const sent = t.sent[0]?.providerInstances ?? {};
    expect(Object.keys(sent)).toEqual(["codex", "codex_work"]);
    expect(entryOf(sent, "codex")).toBe(entryOf(before, "codex"));
    expect(t.flow.isOpen()).toBe(false);
    expect(t.recorded).toEqual(["Provider opencode_zai 삭제됨"]);
    // Providers are read again, for all of them: the removed one has nothing to name.
    expect(t.refreshed).toEqual([undefined]);
    expect(t.said.join("\n")).toContain("/model");
  });

  it("does nothing without yes, and nothing on Esc", async () => {
    const t = setup();
    t.flow.run("remove codex_work");
    t.press(enter);
    expect(t.flow.message()).toContain("yes");
    t.typeText("no");
    t.press(enter);
    t.press(escape);
    await flush();
    expect(t.flow.isOpen()).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it("explains why the built-in instance stays, and opens nothing", () => {
    const t = setup();
    t.flow.run("remove codex");
    expect(t.flow.isOpen()).toBe(false);
    expect(t.errors.join()).toContain("기본 인스턴스");
    t.flow.run("remove ghost");
    expect(t.errors.join()).toContain("없습니다");
  });

  it("lists what can be removed when no id is given", () => {
    const t = setup();
    t.flow.run("remove");
    expect(t.frame()).toContain("삭제할 Provider");
    expect(t.frame()).toContain("codex_work");
    t.press(enter);
    expect(t.frame()).toContain("yes");
  });

  it("says there is nothing to remove when only built-in instances exist", () => {
    const t = setup({ instances: { codex: { driver: "codex" } } });
    t.flow.run("remove");
    expect(t.flow.isOpen()).toBe(false);
    expect(t.notices.join()).toContain("지울 수 있는 Provider 가 없습니다");
  });

  it("prints the plan for --dry-run and removes nothing", () => {
    const t = setup();
    t.flow.run("remove opencode_zai --dry-run");
    expect(t.flow.isOpen()).toBe(false);
    expect(t.said.join("\n")).toContain("삭제하지 않음");
    expect(t.said.join("\n")).toContain("스레드 1개");
    expect(t.sent).toEqual([]);
  });

  it("is told it is already gone when someone else removed it first", async () => {
    const t = setup();
    t.flow.run("remove codex_work");
    t.setSettings(settingsWith({ codex: { driver: "codex" } }));
    t.typeText("yes");
    t.press(enter);
    await flush();
    expect(t.sent).toEqual([]);
    expect(t.notices.join()).toContain("이미 없습니다");
    expect(t.flow.isOpen()).toBe(false);
  });

  it("keeps the screen and the reason when the server refuses, and when the link is down", async () => {
    const t = setup();
    t.flow.run("remove codex_work");
    t.failWith(new CommandRejectedError("거부됨"));
    t.typeText("yes");
    t.press(enter);
    await flush();
    expect(t.flow.isOpen()).toBe(true);
    expect(t.flow.message()).toContain("삭제 실패: 거부됨");
    t.setOnline(false);
    t.press(enter);
    await flush();
    expect(t.flow.message()).toContain("연결이 끊겨");
    expect(t.sent).toEqual([]);
  });
});

describe("while it is open", () => {
  it("reports itself open so the controller keeps every key for it", () => {
    const t = setup();
    t.flow.run("add");
    expect(t.flow.isOpen()).toBe(true);
    t.press(text("x"), key("up"));
    expect(t.flow.isOpen()).toBe(true);
  });

  it("holds no warning once a key has been pressed", () => {
    const t = setup();
    t.flow.run("remove codex_work");
    t.press(enter);
    expect(t.flow.message()).not.toBeNull();
    t.typeText("y");
    expect(t.flow.message()).toBeNull();
  });
});
