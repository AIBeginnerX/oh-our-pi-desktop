import * as NodeChildProcess from "node:child_process";

import { OSC52_MAX_BASE64, osc52Sequence } from "./osc52.ts";

/** A program that reads the text from its standard input and puts it on the system clipboard. */
export interface ClipboardTool {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** `clip.exe` reads the console's code page unless the input is UTF-16 with a byte order mark. */
  readonly encoding: "utf8" | "utf16le";
}

export interface ClipboardPlan {
  /** Whether OSC 52 is written, and whether tmux needs it wrapped to pass it on. */
  readonly osc52: { readonly tmux: boolean };
  /** Tried in order until one works; none over SSH, where they would fill the remote machine's clipboard. */
  readonly tools: ReadonlyArray<ClipboardTool>;
}

const isRemote = (env: NodeJS.ProcessEnv): boolean =>
  [env.SSH_CONNECTION, env.SSH_TTY, env.SSH_CLIENT].some(
    (value) => value !== undefined && value !== "",
  );

const set = (value: string | undefined): boolean => value !== undefined && value !== "";

const CLIP: ClipboardTool = { command: "clip.exe", args: [], encoding: "utf16le" };
const XCLIP: ClipboardTool = {
  command: "xclip",
  args: ["-selection", "clipboard"],
  encoding: "utf8",
};
const XSEL: ClipboardTool = { command: "xsel", args: ["--clipboard", "--input"], encoding: "utf8" };
const WL_COPY: ClipboardTool = { command: "wl-copy", args: [], encoding: "utf8" };

/**
 * Where a copy goes in this environment. OSC 52 always. The platform's tool only for a session on
 * the computer itself (no SSH_CONNECTION, SSH_TTY or SSH_CLIENT): pbcopy on macOS; wl-copy, xclip
 * and xsel on Linux, the one for the running display server first; clip.exe on Windows and in WSL.
 */
export const planClipboard = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClipboardPlan => {
  const osc52 = { tmux: set(env.TMUX) };
  if (isRemote(env)) return { osc52, tools: [] };
  if (platform === "darwin") {
    return { osc52, tools: [{ command: "pbcopy", args: [], encoding: "utf8" }] };
  }
  if (platform === "win32") return { osc52, tools: [CLIP] };
  const x11First = !set(env.WAYLAND_DISPLAY) && set(env.DISPLAY);
  const linux = x11First ? [XCLIP, XSEL, WL_COPY] : [WL_COPY, XCLIP, XSEL];
  return { osc52, tools: set(env.WSL_DISTRO_NAME) ? [...linux, CLIP] : linux };
};

export type ToolResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" | "failed" | "timeout" };

/** Runs a tool with no shell and `input` on its standard input. It never rejects and never throws. */
export type RunTool = (tool: ClipboardTool, input: Buffer) => Promise<ToolResult>;

export const TOOL_TIMEOUT_MS = 3000;

export const runTool: RunTool = (tool, input) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    try {
      // No shell: the command and arguments are fixed and the text only ever travels on stdin.
      const child = NodeChildProcess.spawn(tool.command, [...tool.args], {
        stdio: ["pipe", "ignore", "ignore"],
        shell: false,
        windowsHide: true,
      });
      timer = setTimeout(() => {
        child.kill();
        settle({ ok: false, reason: "timeout" });
      }, TOOL_TIMEOUT_MS);
      child.once("error", (cause) =>
        settle({
          ok: false,
          reason: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed",
        }),
      );
      child.once("close", (code) =>
        settle(code === 0 ? { ok: true } : { ok: false, reason: "failed" }),
      );
      // A tool that exits before it has read everything breaks the pipe; that is its exit code's to say.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    } catch {
      settle({ ok: false, reason: "failed" });
    }
  });

export interface ClipboardOutcome {
  /** Characters (code points) copied. */
  readonly chars: number;
  /** OSC 52: written, too long to send, or not written because the terminal could not take it. */
  readonly osc52: "sent" | "tooLarge" | "failed";
  /** The tool that was tried last, with how it went; null when none is used (SSH) or exists here. */
  readonly tool:
    | { readonly name: string; readonly ok: true }
    | {
        readonly name: string;
        readonly ok: false;
        readonly reason: "missing" | "failed" | "timeout";
      }
    | null;
}

/** Whether the text is now on a clipboard as far as can be told: a tool took it, or OSC 52 was sent. */
export const copied = (outcome: ClipboardOutcome): boolean =>
  outcome.tool?.ok === true || outcome.osc52 === "sent";

const encode = (text: string, encoding: ClipboardTool["encoding"]): Buffer =>
  encoding === "utf16le"
    ? Buffer.from(`﻿${text.replace(/\n/gu, "\r\n")}`, "utf16le")
    : Buffer.from(text, "utf8");

/**
 * A function that puts text on the clipboard, by OSC 52 and, for a session on this computer, by the
 * platform's tool. A failure in either is reported in the outcome and never thrown, so a copy can
 * never take the screen down. Call it only for a copy the user asked for.
 */
export const createClipboard = (deps: {
  readonly write: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly run?: RunTool;
}): ((text: string) => Promise<ClipboardOutcome>) => {
  const plan = planClipboard(deps.env, deps.platform);
  const run = deps.run ?? runTool;
  return async (text) => {
    const chars = Array.from(text).length;
    let osc52: ClipboardOutcome["osc52"] = "failed";
    const sequence = osc52Sequence(text, { tmux: plan.osc52.tmux, maxBase64: OSC52_MAX_BASE64 });
    if (sequence === null) {
      osc52 = "tooLarge";
    } else {
      try {
        deps.write(sequence);
        osc52 = "sent";
      } catch {
        osc52 = "failed";
      }
    }
    let tool: ClipboardOutcome["tool"] = null;
    for (const candidate of plan.tools) {
      const result = await run(candidate, encode(text, candidate.encoding)).catch(
        (): ToolResult => ({ ok: false, reason: "failed" }),
      );
      // A tool that is not installed is passed over; the last real failure is what gets reported.
      if (result.ok) {
        tool = { name: candidate.command, ok: true };
        break;
      }
      if (result.reason !== "missing" || tool === null) {
        tool = { name: candidate.command, ok: false, reason: result.reason };
      }
    }
    return { chars, osc52, tool };
  };
};
