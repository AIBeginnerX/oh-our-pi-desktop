import { describe, expect, it } from "vite-plus/test";

import { isQuietCommandExit } from "./quietExit.ts";

function codexFailed(command: string, exitCode: number, aggregatedOutput: string) {
  return {
    itemType: "command_execution",
    status: "failed",
    data: { item: { command, exitCode, aggregatedOutput } },
  };
}

function claudeFailed(command: string, resultContent: string | Array<Record<string, string>>) {
  return {
    itemType: "command_execution",
    status: "failed",
    data: { input: { command }, result: { content: resultContent } },
  };
}

describe("isQuietCommandExit", () => {
  it("reads a grep no-match as quiet in the Codex shape", () => {
    expect(isQuietCommandExit(codexFailed("/bin/zsh -lc 'grep pattern src/main.ts'", 1, ""))).toBe(
      true,
    );
  });

  it("reads a grep no-match as quiet in the Claude shape", () => {
    expect(isQuietCommandExit(claudeFailed("grep pattern src/main.ts", "Exit code 1\n"))).toBe(
      true,
    );
  });

  it("reads Claude text blocks starting with the exit line as quiet", () => {
    expect(
      isQuietCommandExit(
        claudeFailed("rg --files -g missing", [
          { type: "text", text: "Exit code 1\n" },
          { type: "text", text: "no output" },
        ]),
      ),
    ).toBe(true);
  });

  it("keeps a mutating command failed even with exit 1 and no output", () => {
    expect(isQuietCommandExit(codexFailed("pnpm test > log", 1, ""))).toBe(false);
  });

  it("keeps output that reports trouble failed", () => {
    expect(
      isQuietCommandExit(
        codexFailed("cat missing.txt", 1, "cat: missing.txt: No such file or directory"),
      ),
    ).toBe(false);
    expect(
      isQuietCommandExit(
        claudeFailed("git -C repo status", "Exit code 1\nfatal: not a git repository"),
      ),
    ).toBe(false);
  });

  it("keeps exit codes other than 1 failed", () => {
    expect(isQuietCommandExit(codexFailed("grep pattern src/main.ts", 2, ""))).toBe(false);
    expect(isQuietCommandExit(claudeFailed("grep pattern src/main.ts", "Exit code 2\n"))).toBe(
      false,
    );
  });

  it("judges the last command of a pipeline, so a grep piped into head stays failed", () => {
    expect(isQuietCommandExit(codexFailed("grep pattern src/main.ts | head", 1, ""))).toBe(false);
  });

  it("ignores completed commands, whose exit 0 is not this rule's business", () => {
    expect(
      isQuietCommandExit({
        itemType: "command_execution",
        status: "completed",
        data: {
          item: { command: "grep pattern src/main.ts || true", exitCode: 0, aggregatedOutput: "" },
        },
      }),
    ).toBe(false);
  });

  it("does not split a quoted `|` pattern", () => {
    expect(isQuietCommandExit(codexFailed('grep "a|b" notes.md', 1, ""))).toBe(true);
    expect(isQuietCommandExit(codexFailed("/bin/zsh -lc 'grep \"a|b\" notes.md'", 1, ""))).toBe(
      true,
    );
  });

  it("keeps a negated command failed", () => {
    expect(isQuietCommandExit(codexFailed("! grep pattern src/main.ts", 1, ""))).toBe(false);
  });

  it("keeps shapes without a stated exit code failed, like ACP records", () => {
    expect(
      isQuietCommandExit({
        itemType: "command_execution",
        status: "failed",
        data: { toolCallId: "call_1", kind: "execute", content: [{ type: "content" }] },
      }),
    ).toBe(false);
    expect(isQuietCommandExit({ itemType: "command_execution", status: "failed" })).toBe(false);
  });

  it("reads a kill -0 probe as quiet", () => {
    expect(isQuietCommandExit(codexFailed("kill -0 123", 1, ""))).toBe(true);
  });

  it("reads command -v, type, and git grep as quiet", () => {
    expect(isQuietCommandExit(codexFailed("command -v docker", 1, ""))).toBe(true);
    expect(isQuietCommandExit(codexFailed("type docker", 1, ""))).toBe(true);
    expect(isQuietCommandExit(codexFailed("git grep pattern", 1, ""))).toBe(true);
  });

  it("reads git diff as quiet only with --quiet or --exit-code", () => {
    expect(isQuietCommandExit(codexFailed("git diff --quiet", 1, ""))).toBe(true);
    expect(isQuietCommandExit(codexFailed("git diff --exit-code", 1, ""))).toBe(true);
    expect(isQuietCommandExit(codexFailed("git diff", 1, ""))).toBe(false);
  });

  it("keeps a command without a readable command string failed", () => {
    expect(
      isQuietCommandExit({
        itemType: "command_execution",
        status: "failed",
        data: { item: { exitCode: 1, aggregatedOutput: "" } },
      }),
    ).toBe(false);
  });

  it("reads the Claude raw-output shape, which states the code the same way", () => {
    const rawOutputFailed = (command: string, content: string) => ({
      itemType: "command_execution",
      status: "failed",
      data: { command, rawOutput: { content } },
    });
    expect(isQuietCommandExit(rawOutputFailed("grep pattern src/main.ts", "Exit code 1\n"))).toBe(
      true,
    );
    expect(isQuietCommandExit(rawOutputFailed("pnpm build", "Exit code 1\n"))).toBe(false);
  });

  it("keeps a zsh glob miss failed, since the command never ran", () => {
    expect(
      isQuietCommandExit(
        claudeFailed("grep -rn x src/codex*", "Exit code 1\nzsh:1: no matches found: src/codex*"),
      ),
    ).toBe(false);
  });

  it("drops leading assignments and prefixes before naming the program", () => {
    expect(isQuietCommandExit(codexFailed("CI=1 sudo grep pattern file", 1, ""))).toBe(true);
    // Only the prefix tokens go; sudo's own flags are left alone and stay failed.
    expect(isQuietCommandExit(codexFailed("CI=1 sudo -u root grep pattern file", 1, ""))).toBe(
      false,
    );
  });
});
