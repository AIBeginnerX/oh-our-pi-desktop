import { describe, expect, it } from "vite-plus/test";

import { HELP_TEXT, parseArgs } from "./cli.ts";
import { SECRET } from "./testing/providerFixtures.ts";

describe("parseArgs", () => {
  it("runs the interactive client with no arguments", () => {
    expect(parseArgs([])).toEqual({
      kind: "run",
      continueLast: false,
      server: null,
      home: null,
      runtimeMode: null,
      prompt: null,
    });
  });

  it("reads --continue, --server, --home and --mode in both spellings", () => {
    expect(
      parseArgs(["-c", "--server", "http://127.0.0.1:3773", "--home=/iso", "--mode", "auto"]),
    ).toEqual({
      kind: "run",
      continueLast: true,
      server: "http://127.0.0.1:3773",
      home: "/iso",
      runtimeMode: "auto",
      prompt: null,
    });
  });

  describe("a message to start with", () => {
    const prompt = (argv: ReadonlyArray<string>) => {
      const result = parseArgs(argv);
      return result.kind === "run" ? result.prompt : result;
    };

    it("takes one quoted argument, or several words, as the message", () => {
      expect(prompt(["버그를 고쳐줘"])).toBe("버그를 고쳐줘");
      expect(prompt(["fix", "the", "login", "bug"])).toBe("fix the login bug");
      expect(prompt(["  hello world  "])).toBe("hello world");
    });

    it("goes with --continue, --mode and the server flags in any order", () => {
      expect(parseArgs(["-c", "--mode", "auto", "다시 해줘"])).toMatchObject({
        kind: "run",
        continueLast: true,
        runtimeMode: "auto",
        prompt: "다시 해줘",
      });
      expect(parseArgs(["이어서 해줘", "--continue", "--home", "/iso"])).toMatchObject({
        kind: "run",
        continueLast: true,
        home: "/iso",
        prompt: "이어서 해줘",
      });
    });

    it("keeps the words of a command a command", () => {
      for (const argv of [["stop"], ["doctor"], ["update"], ["pair", "abc"], ["config"]]) {
        expect(parseArgs(argv).kind).not.toBe("run");
      }
    });

    it("sends a lone word that is not a command only after --, since it may be a typo", () => {
      expect(parseArgs(["stpo"])).toMatchObject({ kind: "error" });
      expect(prompt(["--", "stpo"])).toBe("stpo");
      expect(prompt(["--", "stop"])).toBe("stop");
      expect(prompt(["안녕"])).toBe("안녕");
    });

    it("reads everything after -- as the message, dashes included", () => {
      expect(prompt(["--", "-v", "means", "what?"])).toBe("-v means what?");
      expect(prompt(["-c", "--", "--mode", "x"])).toBe("--mode x");
    });

    it("keeps a command a command when -- comes after its name", () => {
      expect(parseArgs(["stop", "--"])).toMatchObject({ kind: "stop" });
      expect(parseArgs(["doctor", "--"])).toMatchObject({ kind: "doctor" });
      expect(parseArgs(["pair", "abc", "--"])).toMatchObject({ kind: "pair", target: "abc" });
      // Words after -- stay arguments of the command, dashes included.
      expect(parseArgs(["config", "set", "--", "theme", "oop"])).toMatchObject({
        kind: "config",
        config: { action: "set", key: "theme", value: "oop" },
      });
      expect(parseArgs(["stop", "--", "now"])).toMatchObject({ kind: "error" });
    });

    it("still refuses an option it does not know before the message", () => {
      expect(parseArgs(["--wat", "hello there"])).toMatchObject({ kind: "error" });
      expect(parseArgs(["-5도 표현"])).toMatchObject({ kind: "error" });
    });

    it("refuses an empty message and provider flags on a message", () => {
      expect(parseArgs([""])).toMatchObject({ kind: "error" });
      expect(parseArgs(["--", "  "])).toMatchObject({ kind: "error" });
      expect(parseArgs(["--yes", "hello there"])).toMatchObject({ kind: "error" });
    });

    it("is in the help text", () => {
      expect(HELP_TEXT).toContain('oop "프롬프트"');
      expect(HELP_TEXT).toContain("oop -- stop");
    });
  });

  it("parses `pair` with a link or token and carries the server override", () => {
    expect(parseArgs(["pair", "http://127.0.0.1:3773/pair#token=abc"])).toMatchObject({
      kind: "pair",
      target: "http://127.0.0.1:3773/pair#token=abc",
    });
    expect(parseArgs(["pair", "abc123", "--server", "http://x:1"])).toMatchObject({
      kind: "pair",
      target: "abc123",
      server: "http://x:1",
    });
  });

  it("parses `stop` and refuses anything after it", () => {
    expect(parseArgs(["stop"])).toEqual({ kind: "stop", home: null });
    expect(parseArgs(["--home", "/x", "stop"])).toEqual({ kind: "stop", home: "/x" });
    expect(parseArgs(["stop", "extra"])).toEqual({
      kind: "error",
      message: "사용법: oop stop",
    });
  });

  it("parses `doctor` and refuses anything after it", () => {
    expect(parseArgs(["doctor"])).toEqual({ kind: "doctor", home: null });
    expect(parseArgs(["--home", "/x", "doctor"])).toEqual({ kind: "doctor", home: "/x" });
    expect(parseArgs(["doctor", "extra"])).toEqual({
      kind: "error",
      message: "사용법: oop doctor",
    });
  });

  it("parses `update`, with the server flags the other commands take, and nothing else", () => {
    expect(parseArgs(["update"])).toEqual({ kind: "update", server: null, home: null });
    expect(parseArgs(["--home", "/x", "update", "--server", "http://x:1"])).toEqual({
      kind: "update",
      server: "http://x:1",
      home: "/x",
    });
    expect(parseArgs(["update", "extra"])).toEqual({
      kind: "error",
      message: "사용법: oop update",
    });
    // It installs nothing, so it takes neither of the flags a command that does would.
    for (const flag of ["-y", "--yes", "--dry-run"]) {
      expect(parseArgs(["update", flag])).toMatchObject({ kind: "error" });
    }
  });

  it("parses `config` in its four forms", () => {
    expect(parseArgs(["config"])).toEqual({ kind: "config", config: { action: "list" } });
    expect(parseArgs(["config", "path"])).toEqual({ kind: "config", config: { action: "path" } });
    expect(parseArgs(["config", "get", "theme"])).toEqual({
      kind: "config",
      config: { action: "get", key: "theme" },
    });
    expect(parseArgs(["config", "set", "theme", "aurora"])).toEqual({
      kind: "config",
      config: { action: "set", key: "theme", value: "aurora" },
    });
  });

  it("answers a malformed `config` with its usage, in Korean", () => {
    for (const argv of [
      ["config", "get"],
      ["config", "set", "theme"],
      ["config", "set", "theme", "a", "b"],
      ["config", "path", "x"],
      ["config", "delete", "theme"],
    ]) {
      const result = parseArgs(argv);
      expect(result.kind, argv.join(" ")).toBe("error");
      expect(result.kind === "error" && result.message.includes("oop config")).toBe(true);
    }
  });

  it("answers help and version before anything else", () => {
    expect(parseArgs(["--continue", "-h"]).kind).toBe("help");
    expect(parseArgs(["-v"]).kind).toBe("version");
    expect(HELP_TEXT).toContain("oop pair");
    expect(HELP_TEXT).toContain("oop config set");
    expect(HELP_TEXT).toContain("oop update");
    for (const command of ["/theme", "/stats", "/update", "/help"])
      expect(HELP_TEXT).toContain(command);
  });

  it("explains mistakes in Korean", () => {
    for (const argv of [["--mode", "yolo"], ["--server"], ["--wat"], ["pair"], ["deploy"]]) {
      const result = parseArgs(argv);
      expect(result.kind).toBe("error");
      expect(result.kind === "error" && /[가-힣]/u.test(result.message)).toBe(true);
    }
  });

  it("does not swallow the next flag as a value", () => {
    expect(parseArgs(["--server", "--continue"]).kind).toBe("error");
  });

  describe("provider", () => {
    it("parses list, add and remove, with the server flags the other commands take", () => {
      expect(parseArgs(["provider"])).toEqual({
        kind: "provider",
        request: { kind: "list" },
        server: null,
        home: null,
      });
      expect(
        parseArgs(["provider", "list", "--server", "http://x:1", "--home", "/iso"]),
      ).toMatchObject({
        kind: "provider",
        request: { kind: "list" },
        server: "http://x:1",
        home: "/iso",
      });
      expect(
        parseArgs([
          "provider",
          "add",
          "zai",
          "--id",
          "opencode_zai",
          "--name",
          "내 Z.AI",
          "--set",
          "apiKey=@ZAI_KEY",
          "--env",
          "LOG=1",
          "--secret",
          "TOKEN_X=-",
          "-y",
          "--dry-run",
        ]),
      ).toMatchObject({
        kind: "provider",
        request: {
          kind: "add",
          target: { kind: "preset", preset: "zai" },
          options: {
            id: "opencode_zai",
            name: "내 Z.AI",
            sets: [{ key: "apiKey", value: "@ZAI_KEY" }],
            env: [{ name: "LOG", value: "1" }],
            secrets: [{ name: "TOKEN_X", ref: { kind: "stdin" } }],
            yes: true,
            dryRun: true,
          },
        },
      });
      expect(parseArgs(["provider", "remove", "work", "--yes", "--dry-run"])).toMatchObject({
        kind: "provider",
        request: { kind: "remove", id: "work", yes: true, dryRun: true },
      });
    });

    it("runs add with no kind as the interactive form", () => {
      expect(parseArgs(["provider", "add"])).toMatchObject({
        request: { kind: "add", target: null },
      });
    });

    it("answers a mistake with an error in Korean, and never repeats a secret typed by mistake", () => {
      const leaked = "test-value-1234";
      for (const argv of [
        ["provider", "frob"],
        ["provider", "list", "extra"],
        ["provider", "remove"],
        ["provider", "add", "nope"],
        ["provider", "add", "--id", "x"],
        ["provider", "add", "codex", "--id"],
        ["provider", "add", "codex", "--set", "novalue"],
        ["provider", "add", "opencode", "--secret", `TOKEN_X=${leaked}`],
      ]) {
        const result = parseArgs(argv);
        expect(result.kind).toBe("error");
        expect(result.kind === "error" && /[가-힣]/u.test(result.message)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(leaked);
      }
    });

    it("keeps its flags to itself", () => {
      for (const argv of [
        ["--id", "x"],
        ["-y"],
        ["--dry-run"],
        ["doctor", "--yes"],
        ["update", "--set", "a=b"],
      ]) {
        const result = parseArgs(argv);
        expect(result.kind).toBe("error");
        expect(result.kind === "error" && result.message).toContain("알 수 없는 옵션");
      }
    });

    it("does not print the value of a mistyped option, nor a long word where a command belongs", () => {
      for (const argv of [
        ["provider", "add", "zai", `--api-key=${SECRET}`],
        [`--api-key=${SECRET}`],
        ["provider", "add", SECRET],
        ["provider", SECRET],
        [SECRET],
      ]) {
        const result = parseArgs(argv);
        expect(result.kind).toBe("error");
        expect(result.kind === "error" && result.message).not.toContain("1234");
        expect(result.kind === "error" && result.message).not.toContain(SECRET);
      }
      const result = parseArgs(["provider", "add", "zai", `--api-key=${SECRET}`]);
      expect(result.kind === "error" && result.message).toContain("알 수 없는 옵션: --api-key");
    });

    it("does not swallow the next flag as a value", () => {
      expect(parseArgs(["provider", "add", "codex", "--id", "--dry-run"]).kind).toBe("error");
    });

    it("is in the help text with its flags", () => {
      for (const word of [
        "oop provider add",
        "oop provider remove",
        "--dry-run",
        "--secret",
        "-y, --yes",
      ]) {
        expect(HELP_TEXT).toContain(word);
      }
    });
  });
});
