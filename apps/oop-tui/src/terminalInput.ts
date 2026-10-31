import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import { hostPlatform } from "./host.ts";

const CONSOLE_INPUT = "\\\\.\\CONIN$";

/** What fd 0 is: a terminal, a pipe or a file that was redirected to it, or anything else (including unknown). */
export type StdinKind = "terminal" | "redirected" | "other";

interface HostConsole {
  readonly platform: string;
  readonly electron: string | undefined;
  readonly stdinKind: StdinKind;
  /** Opens the console's own input; throws when the process has no console. */
  readonly openConsoleInput: () => NodeJS.ReadStream | NodeTty.ReadStream;
}

/**
 * The stream keys arrive on. The Windows launcher runs the app's Electron as Node, and Electron is
 * a GUI program: it inherits the console's output but not its input, so `process.stdin` ends at
 * once and has no raw mode. Opening the console's input directly gives a real terminal stream.
 * Input that was piped or redirected into the process is left on `process.stdin`: it is what the
 * caller meant to read, and the console would hide it.
 */
export const resolveTerminalInput = (
  host: HostConsole,
  stdin: NodeJS.ReadStream,
): NodeJS.ReadStream | NodeTty.ReadStream => {
  if (host.platform !== "win32" || host.electron === undefined || host.stdinKind !== "other")
    return stdin;
  try {
    return host.openConsoleInput();
  } catch {
    return stdin;
  }
};

const currentStdinKind = (): StdinKind => {
  if (process.stdin.isTTY === true) return "terminal";
  try {
    const stats = NodeFS.fstatSync(0);
    // Compared by mode bits: on Windows `isFIFO()` is false even for a pipe. A console and `< NUL`
    // look the same to Electron there, a character device, so `< NUL` still opens the console.
    const isPipe = (stats.mode & 0o170000) === 0o010000;
    return isPipe || stats.isFile() ? "redirected" : "other";
  } catch {
    return "other";
  }
};

let cached: NodeJS.ReadStream | NodeTty.ReadStream | null = null;

/** `process.stdin`, except where {@link resolveTerminalInput} has to open the console itself. */
export const terminalInput = (): NodeJS.ReadStream | NodeTty.ReadStream => {
  cached ??= resolveTerminalInput(
    {
      platform: hostPlatform(),
      electron: process.versions.electron,
      stdinKind: currentStdinKind(),
      openConsoleInput: () => new NodeTty.ReadStream(NodeFS.openSync(CONSOLE_INPUT, "r+")),
    },
    process.stdin,
  );
  return cached;
};
