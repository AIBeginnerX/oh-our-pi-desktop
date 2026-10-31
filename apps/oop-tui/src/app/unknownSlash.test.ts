import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unknownSlash } from "./unknownSlash.ts";

const provider = (over: Record<string, unknown> = {}) =>
  ({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    models: [],
    slashCommands: [{ name: "compact" }],
    skills: [],
    ...over,
  }) as unknown as ServerProvider;

const typo = "--set apiKey=EXAMPLE";

describe("unknownSlash", () => {
  describe("a word nothing answers to", () => {
    it("is held, with the nearest command named", () => {
      expect(unknownSlash(`/providers add zai ${typo}`, provider())).toEqual({
        kind: "unknown",
        word: "providers",
        nearest: "provider",
      });
      expect(unknownSlash("/zzz", provider())).toMatchObject({ kind: "unknown", nearest: null });
    });

    it("is sent when it is the provider's own command or user-invocable skill", () => {
      const own = provider({
        slashCommands: [{ name: "compact" }],
        skills: [
          { name: "deploy", path: "/s/deploy", enabled: true },
          { name: "hidden", path: "/s/hidden", enabled: true, userInvocable: false },
        ],
      });
      expect(unknownSlash("/compact", own)).toBeNull();
      expect(unknownSlash("/DEPLOY now", own)).toBeNull();
      expect(unknownSlash("/hidden", own)).not.toBeNull();
    });

    it("counts a command that only one working folder has", () => {
      const withFolder = provider({
        workspaceSnapshots: [{ cwd: "/work/app", slashCommands: [{ name: "ship" }], skills: [] }],
      });
      expect(unknownSlash("/ship it", withFolder)).toBeNull();
    });

    it("is sent when typed with a space in front, or when it is not a command word at all", () => {
      expect(unknownSlash(" /providers add", provider())).toBeNull();
      expect(unknownSlash("/", provider())).toBeNull();
      expect(unknownSlash("/ 안녕", provider())).toBeNull();
      expect(unknownSlash("안녕 /providers", provider())).toBeNull();
    });
  });

  describe("before the provider is known", () => {
    it("holds only a typo of one of our commands", () => {
      expect(unknownSlash(`/providers add zai ${typo}`, null)).toMatchObject({
        kind: "unknown",
        nearest: "provider",
      });
      expect(unknownSlash("/moel full", null)).toMatchObject({ nearest: "model" });
      expect(unknownSlash("/zzz", null)).toBeNull();
      expect(unknownSlash("/compact", null)).toBeNull();
    });
  });

  describe("arguments after a command that takes none", () => {
    it("holds them, aliases included, and names the command an alias runs", () => {
      expect(unknownSlash(`/p add zai ${typo}`, provider())).toEqual({
        kind: "arguments",
        word: "p",
        nearest: null,
        command: "projects",
      });
      expect(unknownSlash("/q 이게 뭐야?", provider())).toMatchObject({
        kind: "arguments",
        command: "exit",
      });
      expect(unknownSlash("/threads 지난주 것", provider())).toMatchObject({ kind: "arguments" });
      expect(unknownSlash(`/p add zai ${typo}`, null)).toMatchObject({ kind: "arguments" });
    });

    it("lets the provider have a word it answers to as well, and /plan with a task", () => {
      expect(
        unknownSlash("/new feature", provider({ slashCommands: [{ name: "new" }] })),
      ).toBeNull();
      expect(unknownSlash("/plan the migration", provider())).toBeNull();
    });

    it("does not hold a command that takes an argument, or a bare command", () => {
      expect(unknownSlash("/mode 전체 접근", provider())).toBeNull();
      expect(unknownSlash("/theme a b c", provider())).toBeNull();
      expect(unknownSlash("/goal 테스트를 모두 통과시키기", provider())).toBeNull();
      expect(unknownSlash("/exit", provider())).toBeNull();
    });
  });

  describe("a slash inside the word", () => {
    it("holds `/provider/add ...`, whose first piece is one of our commands", () => {
      expect(unknownSlash(`/provider/add zai ${typo}`, provider())).toEqual({
        kind: "unknown",
        word: "provider/add",
        nearest: "provider",
      });
      expect(unknownSlash(`/provider/add zai ${typo}`, null)).not.toBeNull();
    });

    it("sends a path", () => {
      for (const path of ["/Users/foo 봐줘", "/tmp/a.txt", "/var/log/syslog", "/p/src/x.ts"]) {
        expect(unknownSlash(path, provider()), path).toBeNull();
      }
    });
  });

  describe("a folder at the top of a computer", () => {
    it("is a question about a path, not a command", () => {
      for (const text of [
        "/tmp 안에 뭐 있어?",
        "/Users",
        "/etc",
        "/usr 용량",
        "/var",
        "/opt",
        "/home",
        "/Volumes",
        "/bin",
        "/private",
        "/mnt",
      ]) {
        expect(unknownSlash(text, provider()), text).toBeNull();
      }
    });

    it("holds a typo of /dag-agents and names it, and lets the command and its words through", () => {
      expect(unknownSlash("/dag-agent", provider())).toEqual({
        kind: "unknown",
        word: "dag-agent",
        nearest: "dag-agents",
      });
      expect(unknownSlash("/dag-agnts", provider())).toMatchObject({ nearest: "dag-agents" });
      for (const text of ["/dag-agents", "/dag-agents on", "/dag-agents live", "/dag-agents 2"]) {
        expect(unknownSlash(text, provider()), text).toBeNull();
      }
      // Without the provider's list only a typo of ours is certain.
      expect(unknownSlash("/dag-agent", null)).toMatchObject({ nearest: "dag-agents" });
    });

    it("does not make the name a free pass for a command with arguments", () => {
      expect(unknownSlash("/tmpp add", provider())).not.toBeNull();
    });
  });
});
