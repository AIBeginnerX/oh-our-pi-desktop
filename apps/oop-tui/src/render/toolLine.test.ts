import { describe, expect, it } from "vite-plus/test";

import { makeActivity } from "../testing/fixtures.ts";
import { shellCommand, toolFailed, toolTitle } from "./toolLine.ts";

describe("shellCommand", () => {
  it("shows the command a provider wrapped in a login shell", () => {
    expect(shellCommand("/bin/zsh -lc ls")).toBe("ls");
    expect(shellCommand("/bin/zsh -lc 'pnpm test --run'")).toBe("pnpm test --run");
    expect(shellCommand('bash -c "git status"')).toBe("git status");
    expect(shellCommand(`/bin/zsh -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
  });

  it("copes with a detail the server cut short", () => {
    expect(shellCommand("/bin/zsh -lc 'for p in /a /b")).toBe("for p in /a /b");
  });

  it("leaves anything else alone", () => {
    expect(shellCommand("src/hello.ts")).toBe("src/hello.ts");
    expect(shellCommand("sh script.sh")).toBe("sh script.sh");
  });
});

describe("toolTitle and toolFailed", () => {
  const activity = (over: Record<string, unknown>) =>
    makeActivity({ id: "a", kind: "tool.completed", ...over });

  it("name a tool by its title, and by its summary when it has none", () => {
    expect(toolTitle(activity({ summary: "S", payload: { title: "T", toolName: "N" } }))).toBe("T");
    expect(toolTitle(activity({ summary: "S", payload: { toolName: "N" } }))).toBe("S");
  });

  it("cleans a name the server sent of control sequences and extra lines", () => {
    expect(toolTitle(activity({ payload: { title: "ls\u001b[2J\n두 번째" } }))).toBe("ls");
  });

  it("count a refused tool and a failed or declined one as failures, and nothing else", () => {
    expect(toolFailed(activity({ kind: "tool.denied" }))).toBe(true);
    expect(toolFailed(activity({ payload: { status: "failed" } }))).toBe(true);
    expect(toolFailed(activity({ payload: { status: "declined" } }))).toBe(true);
    expect(toolFailed(activity({ payload: { status: "completed" } }))).toBe(false);
    expect(toolFailed(activity({ tone: "error" }))).toBe(false);
  });
});
