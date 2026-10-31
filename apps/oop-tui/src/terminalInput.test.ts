import { describe, expect, it } from "vite-plus/test";

import { resolveTerminalInput } from "./terminalInput.ts";

const stdin = { name: "stdin" } as unknown as NodeJS.ReadStream;
const consoleInput = { name: "console" } as unknown as NodeJS.ReadStream;

const host = (overrides: Partial<Parameters<typeof resolveTerminalInput>[0]>) => ({
  platform: "win32",
  electron: "44.9.3",
  stdinKind: "other" as const,
  openConsoleInput: () => consoleInput,
  ...overrides,
});

describe("resolveTerminalInput", () => {
  it("opens the console when Electron on Windows was given no input", () => {
    expect(resolveTerminalInput(host({}), stdin)).toBe(consoleInput);
  });

  it("keeps stdin on system Node, on other systems, and when stdin is a terminal", () => {
    const refuse = () => {
      throw new Error("must not open the console");
    };
    for (const change of [
      { electron: undefined },
      { platform: "darwin" },
      { stdinKind: "terminal" as const },
      // Input piped or redirected into the process is what it is meant to read.
      { stdinKind: "redirected" as const },
    ]) {
      expect(resolveTerminalInput(host({ ...change, openConsoleInput: refuse }), stdin)).toBe(
        stdin,
      );
    }
  });

  it("opens the console when fd 0 is neither a terminal nor redirected, or could not be examined", () => {
    expect(resolveTerminalInput(host({ stdinKind: "other" }), stdin)).toBe(consoleInput);
  });

  it("falls back to stdin when there is no console to open", () => {
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(resolveTerminalInput(host({ openConsoleInput: missing }), stdin)).toBe(stdin);
  });
});
