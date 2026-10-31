import type { ServerProvider, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stringWidth } from "../text/width.ts";
import { CommandRejectedError } from "../link/transport.ts";
import { makeProject, makeSnapshot, makeThreadShell } from "../testing/fixtures.ts";
import {
  configWith,
  savedPreset,
  SECRET,
  serverProvider,
  settingsWith,
  entryOf,
} from "../testing/providerFixtures.ts";
import { collectFlags, resolveProviderRequest } from "./providerArgs.ts";
import { listTable, runProviderCommand, type ProviderCommandDeps } from "./providerCommand.ts";
import { providerRows } from "./providerPlan.ts";
import { newDraft, parseTarget, withId, withValue, type AddDraft } from "./providerSpec.ts";

const request = (...argv: string[]) => {
  const collected = collectFlags(argv);
  if (!collected.ok) throw new Error(collected.message);
  const parsed = resolveProviderRequest(collected.value.positional, collected.value.flags, "cli");
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};

const setup = (
  options: {
    interactive?: boolean;
    stdinIsTerminal?: boolean;
    env?: Record<string, string | undefined>;
    stdin?: string;
    answers?: Array<string | null>;
    wizardDraft?: AddDraft | null;
    waitError?: string | null;
    refreshFails?: boolean;
  } = {},
) => {
  let settings: ServerSettings = settingsWith({
    codex: { driver: "codex", enabled: true },
    opencode_zai: savedPreset,
    codex_work: { driver: "codex" },
  });
  const out: string[] = [];
  const err: string[] = [];
  const sent: ServerSettingsPatch[] = [];
  const asked: string[] = [];
  const refreshed: Array<{ instanceId?: string } | undefined> = [];
  const wizardStarts: Array<AddDraft | null> = [];
  let failure: Error | null = null;
  const shell = makeSnapshot(
    [makeProject()],
    [makeThreadShell({ id: "a", modelSelection: { instanceId: "opencode_zai", model: "m" } })],
  );
  let stdinReads = 0;
  const deps: ProviderCommandDeps = {
    link: {
      get config() {
        return configWith(settings, [
          serverProvider("codex", { models: [] }),
          serverProvider("opencode_zai", { status: "error", message: "로그인 필요" }),
          serverProvider("codex_work", { enabled: false, status: "disabled" }),
        ]);
      },
      shell,
      getSettings: async () => settings,
      updateSettings: async (patch) => {
        if (failure) throw failure;
        sent.push(patch);
        settings = { ...settings, ...patch } as ServerSettings;
        return settings;
      },
      refreshProviders: async (input) => {
        refreshed.push(input);
        if (options.refreshFails) throw new Error("no");
        return [
          serverProvider(input?.instanceId ?? "x", { status: "ready" }),
        ] as unknown as ReadonlyArray<ServerProvider>;
      },
    },
    waitReady: async () => options.waitError ?? null,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    env: options.env ?? {},
    interactive: options.interactive ?? false,
    stdinIsTerminal: options.stdinIsTerminal ?? false,
    readStdin: async () => {
      stdinReads += 1;
      return options.stdin ?? "";
    },
    ask: async (question) => {
      asked.push(question);
      return options.answers?.shift() ?? null;
    },
    wizard: async (start) => {
      wizardStarts.push(start);
      return options.wizardDraft === undefined ? start : options.wizardDraft;
    },
    columns: 80,
  };
  const everything = () => [...out, ...err, ...asked].join("\n");
  return {
    deps,
    out,
    err,
    sent,
    asked,
    refreshed,
    wizardStarts,
    everything,
    stdinReads: () => stdinReads,
    failWith: (error: Error) => void (failure = error),
    settings: () => settings,
    run: (...argv: string[]) => runProviderCommand(request(...argv), deps),
  };
};

describe("oop provider list", () => {
  it("prints a table with the state of each instance", async () => {
    const t = setup();
    expect(await t.run("list")).toBe(0);
    const text = t.out.join("\n");
    expect(t.out[0]).toMatch(/^ID\s+이름\s+종류\s+사용\s+상태\s+모델/u);
    expect(text).toContain("준비됨");
    expect(text).toContain("오류");
    expect(text).toContain("로그인 필요");
    expect(text).toContain("꺼짐");
    expect(t.out.find((line) => line.startsWith("codex "))).toContain("기본");
  });

  it("lines the columns up even with Korean names", () => {
    const rows = providerRows(
      configWith(settingsWith({}), [
        serverProvider("a", { displayName: "한글 이름" }),
        serverProvider("bbbb"),
      ]),
      null,
    );
    const lines = listTable(rows);
    const starts = lines.map((line) => {
      const at = line.indexOf("준비됨") === -1 ? line.indexOf("상태") : line.indexOf("준비됨");
      return stringWidth(line.slice(0, at));
    });
    expect(new Set(starts).size).toBe(1);
  });

  it("says so when the server cannot be reached", async () => {
    const t = setup({ waitError: "서버에 연결하지 못했습니다." });
    expect(await t.run("list")).toBe(1);
    expect(t.err).toEqual(["error: 서버에 연결하지 못했습니다."]);
  });
});

describe("oop provider add", () => {
  it("adds with -y, reads the key from the environment, and prints neither", async () => {
    const t = setup({ env: { ZAI_KEY: SECRET } });
    const code = await t.run(
      "add",
      "zai",
      "--id",
      "opencode_zai2",
      "--set",
      "apiKey=@ZAI_KEY",
      "-y",
    );
    expect(code).toBe(0);
    expect(t.sent).toHaveLength(1);
    const sent = t.sent[0]?.providerInstances ?? {};
    expect(Object.keys(sent)).toEqual(["codex", "opencode_zai", "codex_work", "opencode_zai2"]);
    expect(JSON.stringify(entryOf(sent, "opencode_zai2"))).toContain(SECRET);
    expect(t.everything()).not.toContain(SECRET);
    expect(t.out.join("\n")).toContain("추가했습니다: opencode_zai2 (Z.AI)");
    expect(t.out.join("\n")).toContain("상태: 준비됨");
    expect(t.refreshed).toEqual([{ instanceId: "opencode_zai2" }]);
  });

  it("reads the key from standard input", async () => {
    const t = setup({ stdin: `${SECRET}\n` });
    expect(await t.run("add", "zai", "--id", "opencode_zai2", "--set", "apiKey=-", "-y")).toBe(0);
    expect(JSON.stringify(t.sent[0])).toContain(SECRET);
    expect(t.everything()).not.toContain(SECRET);
  });

  it("does not wait on a terminal for a key named as `-`: it says how to pass one", async () => {
    const t = setup({ interactive: true, stdinIsTerminal: true });
    expect(await t.run("add", "zai", "--id", "opencode_zai2", "--set", "apiKey=-")).toBe(2);
    expect(t.stdinReads()).toBe(0);
    expect(t.err.join("\n")).toContain("파이프");
    expect(t.err.join("\n")).toContain("--set apiKey=@");
    expect(t.asked).toEqual([]);
    expect(t.wizardStarts).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("asks no question once standard input has been used up, and wants -y instead", async () => {
    const t = setup({ interactive: true, stdin: `${SECRET}\n` });
    expect(await t.run("add", "zai", "--id", "opencode_zai2", "--set", "apiKey=-")).toBe(1);
    expect(t.err.join("\n")).toContain("-y");
    expect(t.asked).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.everything()).not.toContain(SECRET);
  });

  it("keeps other instances' secrets markers in what it sends", async () => {
    const t = setup();
    await t.run("add", "codex", "--id", "codex_new", "-y");
    const sent = t.sent[0]?.providerInstances ?? {};
    expect(entryOf(sent, "opencode_zai")?.environment?.[0]).toMatchObject({
      valueRedacted: true,
      value: "",
    });
  });

  it("prints --dry-run with every secret hidden, and sends nothing", async () => {
    const t = setup({ env: { ZAI_KEY: SECRET } });
    const code = await t.run(
      "add",
      "zai",
      "--id",
      "opencode_zai2",
      "--set",
      "apiKey=@ZAI_KEY",
      "--dry-run",
    );
    expect(code).toBe(0);
    expect(t.sent).toEqual([]);
    expect(t.everything()).not.toContain(SECRET);
    expect(t.out.join("\n")).toContain("****");
    expect(t.out.join("\n")).toContain("opencode_zai2");
  });

  it("refuses when the key is missing and nobody can be asked", async () => {
    const t = setup();
    expect(await t.run("add", "zai", "--id", "opencode_zai2", "-y")).toBe(1);
    expect(t.err.join()).toContain("API 키");
    expect(t.sent).toEqual([]);
  });

  it("refuses an id that is taken or is a built-in name", async () => {
    const t = setup();
    expect(await t.run("add", "codex", "--id", "codex_work", "-y")).toBe(1);
    expect(t.err.join()).toContain("이미 있는");
    expect(await t.run("add", "codex", "--id", "codex", "-y")).toBe(1);
    expect(t.err.join()).toContain("기본 인스턴스");
    expect(t.sent).toEqual([]);
  });

  it("needs a confirmation: refuses in a script without -y, asks on a terminal", async () => {
    const script = setup();
    expect(await script.run("add", "codex", "--id", "codex_new")).toBe(1);
    expect(script.err.join()).toContain("-y");
    expect(script.sent).toEqual([]);

    const yes = setup({ interactive: true, answers: ["y"] });
    expect(await yes.run("add", "codex", "--id", "codex_new")).toBe(0);
    expect(yes.asked).toEqual(["추가할까요? [y/N] "]);
    expect(yes.sent).toHaveLength(1);

    for (const answer of ["", "n", "yes please", null]) {
      const no = setup({ interactive: true, answers: [answer] });
      expect(await no.run("add", "codex", "--id", "codex_new")).toBe(1);
      expect(no.err.join()).toContain("취소했습니다");
      expect(no.sent).toEqual([]);
    }
  });

  it("opens the screens for what is missing on a terminal, and does not ask twice", async () => {
    const draft = {
      ...withId(newDraft(parseTarget("zai")!), "opencode_zai2"),
      values: withValue(
        parseTarget("zai")!,
        { service: "api", model: "glm-5.3" },
        "apiKey",
        SECRET,
      ),
    };
    const t = setup({ interactive: true, wizardDraft: draft });
    expect(await t.run("add", "zai", "--id", "opencode_zai2")).toBe(0);
    expect(t.wizardStarts).toHaveLength(1);
    expect(t.wizardStarts[0]?.id).toBe("opencode_zai2");
    expect(t.asked).toEqual([]);
    expect(t.everything()).not.toContain(SECRET);
    expect(t.sent).toHaveLength(1);
  });

  it("starts the screens at the list of kinds with no kind, and needs a terminal for it", async () => {
    const t = setup({ interactive: true, wizardDraft: null });
    expect(await t.run("add")).toBe(1);
    expect(t.wizardStarts).toEqual([null]);
    expect(t.err.join()).toContain("취소했습니다");
    const script = setup();
    expect(await script.run("add")).toBe(2);
    expect(script.wizardStarts).toEqual([]);
  });

  it("reports a refusal from the server without the secret, and says when it may not have arrived", async () => {
    const refused = setup({ env: { ZAI_KEY: SECRET } });
    refused.failWith(new CommandRejectedError(`bad ${SECRET}`));
    expect(
      await refused.run("add", "zai", "--id", "opencode_zai2", "--set", "apiKey=@ZAI_KEY", "-y"),
    ).toBe(1);
    expect(refused.err.join()).toContain("추가하지 못했습니다");
    expect(refused.everything()).not.toContain(SECRET);
    expect(refused.err.join()).not.toContain("확실하지");

    const lost = setup();
    lost.failWith(new Error("socket closed"));
    expect(await lost.run("add", "codex", "--id", "codex_new", "-y")).toBe(1);
    expect(lost.err.join()).toContain("확실하지");
  });

  it("succeeds even when the refresh fails", async () => {
    const t = setup({ refreshFails: true });
    expect(await t.run("add", "codex", "--id", "codex_new", "-y")).toBe(0);
    expect(t.err.join()).toContain("상태를 새로 읽지 못했습니다");
  });

  it("reports the bad arguments the options hold", async () => {
    const t = setup();
    expect(await t.run("add", "codex", "--id", "x", "--set", "nope=1", "-y")).toBe(1);
    expect(t.err.join()).toContain("binaryPath");
  });
});

describe("oop provider remove", () => {
  it("prints the plan first, asks for yes, and removes only that instance", async () => {
    const t = setup({ interactive: true, answers: ["yes"] });
    expect(await t.run("remove", "opencode_zai")).toBe(0);
    const text = t.out.join("\n");
    expect(text.indexOf("삭제: opencode_zai")).toBeLessThan(text.indexOf("삭제했습니다"));
    expect(text).toContain("스레드 1개");
    expect(text).toContain("비밀값 1개");
    expect(t.asked).toEqual(["삭제하려면 yes 를 입력하세요: "]);
    expect(Object.keys(t.sent[0]?.providerInstances ?? {})).toEqual(["codex", "codex_work"]);
    expect(t.refreshed).toEqual([undefined]);
  });

  it("cancels on anything but yes, leaving settings alone", async () => {
    for (const answer of ["", "y", "no", null]) {
      const t = setup({ interactive: true, answers: [answer] });
      expect(await t.run("remove", "codex_work")).toBe(1);
      expect(t.err.join()).toContain("취소했습니다");
      expect(t.sent).toEqual([]);
    }
  });

  it("skips the question with -y, and refuses in a script without it", async () => {
    const yes = setup();
    expect(await yes.run("remove", "codex_work", "-y")).toBe(0);
    expect(yes.asked).toEqual([]);
    const script = setup();
    expect(await script.run("remove", "codex_work")).toBe(1);
    expect(script.err.join()).toContain("-y");
    expect(script.sent).toEqual([]);
  });

  it("prints the plan for --dry-run and removes nothing", async () => {
    const t = setup();
    expect(await t.run("remove", "opencode_zai", "--dry-run")).toBe(0);
    expect(t.sent).toEqual([]);
    expect(t.out.join("\n")).toContain("삭제하지 않았습니다");
  });

  it("explains why the built-in instance stays, and reports an id that is not there", async () => {
    const t = setup();
    expect(await t.run("remove", "codex", "-y")).toBe(1);
    expect(t.err.join()).toContain("기본 인스턴스");
    expect(await t.run("remove", "ghost", "-y")).toBe(1);
    expect(t.err.join()).toContain("없습니다");
    expect(t.sent).toEqual([]);
  });

  it("reports a refusal from the server", async () => {
    const t = setup();
    t.failWith(new CommandRejectedError("거부됨"));
    expect(await t.run("remove", "codex_work", "-y")).toBe(1);
    expect(t.err.join()).toContain("삭제하지 못했습니다: 거부됨");
  });
});
