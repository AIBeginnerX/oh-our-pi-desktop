import { describe, expect, it } from "vite-plus/test";

import {
  createClipboard,
  planClipboard,
  runTool,
  type RunTool,
  type ToolResult,
} from "./clipboard.ts";
import { copyNotice } from "./notice.ts";

const names = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  planClipboard(env, platform).tools.map((tool) => tool.command);

describe("planClipboard", () => {
  it("uses pbcopy on a local Mac, and OSC 52 as well", () => {
    expect(names({}, "darwin")).toEqual(["pbcopy"]);
    expect(planClipboard({}, "darwin").osc52).toEqual({ tmux: false });
  });

  it("uses OSC 52 alone over SSH, however the session is told", () => {
    for (const var_ of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) {
      const plan = planClipboard({ [var_]: "x" }, "darwin");
      expect(plan.tools, var_).toEqual([]);
    }
    expect(
      names({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22", WAYLAND_DISPLAY: "w" }, "linux"),
    ).toEqual([]);
    // An empty variable is no variable.
    expect(names({ SSH_TTY: "" }, "darwin")).toEqual(["pbcopy"]);
  });

  it("tries the tool of the running display server first on Linux", () => {
    expect(names({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, "linux")).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
    expect(names({ DISPLAY: ":0" }, "linux")).toEqual(["xclip", "xsel", "wl-copy"]);
    expect(names({}, "linux")).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("uses clip.exe on Windows and, last, in WSL", () => {
    expect(names({}, "win32")).toEqual(["clip.exe"]);
    expect(names({ WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" }, "linux").at(-1)).toBe("clip.exe");
  });

  it("wraps OSC 52 for tmux", () => {
    expect(planClipboard({ TMUX: "/tmp/tmux-1/default,1,0" }, "linux").osc52.tmux).toBe(true);
  });
});

describe("createClipboard", () => {
  const harness = (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    results: Record<string, ToolResult> = {},
  ) => {
    const written: string[] = [];
    const ran: Array<{ command: string; input: Buffer }> = [];
    const run: RunTool = async (tool, input) => {
      ran.push({ command: tool.command, input });
      return results[tool.command] ?? { ok: true };
    };
    const copy = createClipboard({ write: (text) => void written.push(text), env, platform, run });
    return { copy, written, ran };
  };

  it("writes OSC 52 and runs pbcopy with the text on stdin on a local Mac", async () => {
    const { copy, written, ran } = harness({}, "darwin");
    const outcome = await copy("가나다\nabc");
    expect(written).toEqual([`\u001b]52;c;${Buffer.from("가나다\nabc").toString("base64")}\u0007`]);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.command).toBe("pbcopy");
    expect(ran[0]?.input.toString("utf8")).toBe("가나다\nabc");
    expect(outcome).toEqual({ chars: 7, osc52: "sent", tool: { name: "pbcopy", ok: true } });
  });

  it("runs no tool over SSH", async () => {
    const { copy, ran } = harness({ SSH_CONNECTION: "x" }, "darwin");
    const outcome = await copy("hi");
    expect(ran).toEqual([]);
    expect(outcome).toEqual({ chars: 2, osc52: "sent", tool: null });
  });

  it("sends clip.exe UTF-16 with a byte order mark and Windows line ends", async () => {
    const { copy, ran } = harness({}, "win32");
    await copy("한\n글");
    const input = ran[0]?.input as Buffer;
    expect(input.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(input.subarray(2).toString("utf16le")).toBe("한\r\n글");
  });

  it("goes on to the next tool when one is not installed, and stops at the first that works", async () => {
    const { copy, ran } = harness({ WAYLAND_DISPLAY: "w" }, "linux", {
      "wl-copy": { ok: false, reason: "missing" },
    });
    const outcome = await copy("x");
    expect(ran.map((entry) => entry.command)).toEqual(["wl-copy", "xclip"]);
    expect(outcome.tool).toEqual({ name: "xclip", ok: true });
  });

  it("reports a tool that failed, and still has sent OSC 52", async () => {
    const { copy, written } = harness({}, "darwin", { pbcopy: { ok: false, reason: "failed" } });
    const outcome = await copy("x");
    expect(written).toHaveLength(1);
    expect(outcome.tool).toEqual({ name: "pbcopy", ok: false, reason: "failed" });
    expect(outcome.osc52).toBe("sent");
  });

  it("reports a missing tool when none is installed", async () => {
    const missing: ToolResult = { ok: false, reason: "missing" };
    const { copy } = harness({}, "linux", {
      "wl-copy": missing,
      xclip: missing,
      xsel: missing,
    });
    expect((await copy("x")).tool).toEqual({ name: "wl-copy", ok: false, reason: "missing" });
  });

  it("never rejects: a tool that throws, a terminal that cannot be written to", async () => {
    const copy = createClipboard({
      write: () => {
        throw new Error("EPIPE");
      },
      env: {},
      platform: "darwin",
      run: () => Promise.reject(new Error("boom")),
    });
    const outcome = await copy("x");
    expect(outcome).toEqual({
      chars: 1,
      osc52: "failed",
      tool: { name: "pbcopy", ok: false, reason: "failed" },
    });
  });

  it("does not send OSC 52 for a selection over the limit, but the tool still gets it", async () => {
    const { copy, written, ran } = harness({}, "darwin");
    const outcome = await copy("a".repeat(200_000));
    expect(written).toEqual([]);
    expect(ran[0]?.input.length).toBe(200_000);
    expect(outcome.osc52).toBe("tooLarge");
    expect(outcome.tool?.ok).toBe(true);
  });

  it("counts characters, not UTF-16 units", async () => {
    const { copy } = harness({ SSH_TTY: "x" }, "linux");
    expect((await copy("😀한")).chars).toBe(2);
  });
});

describe("runTool, with a real child process", () => {
  const node = (script: string) => ({
    command: process.execPath,
    args: ["-e", script],
    encoding: "utf8" as const,
  });

  it("passes the text on stdin, with no shell to read it", async () => {
    const result = await runTool(
      node(
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.exit(d==='$(touch x); `y` \"z\" 한글'?0:3))",
      ),
      Buffer.from('$(touch x); `y` "z" 한글'),
    );
    expect(result).toEqual({ ok: true });
  });

  it("reports a non-zero exit as a failure", async () => {
    expect(await runTool(node("process.exit(2)"), Buffer.from("x"))).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reports a program that does not exist as missing, without throwing", async () => {
    expect(
      await runTool(
        { command: "oop-no-such-clipboard-tool", args: [], encoding: "utf8" },
        Buffer.from("x"),
      ),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("survives a tool that exits without reading its input", async () => {
    const result = await runTool(node("process.exit(0)"), Buffer.from("x".repeat(1_000_000)));
    expect(result.ok === true || result.reason === "failed").toBe(true);
  });
});

describe("copyNotice", () => {
  it("says it copied when the tool took it", () => {
    expect(copyNotice({ chars: 12, osc52: "sent", tool: { name: "pbcopy", ok: true } })).toBe(
      "12자를 복사했습니다.",
    );
  });

  it("says it went through the terminal over SSH", () => {
    expect(copyNotice({ chars: 3, osc52: "sent", tool: null })).toContain("OSC 52");
  });

  it("names the tool that failed even though the terminal got the text", () => {
    const notice = copyNotice({
      chars: 3,
      osc52: "sent",
      tool: { name: "pbcopy", ok: false, reason: "failed" },
    });
    expect(notice).toContain("pbcopy");
    expect(notice).toContain("OSC 52");
  });

  it("says why when nothing took the text", () => {
    expect(
      copyNotice({
        chars: 3,
        osc52: "failed",
        tool: { name: "xclip", ok: false, reason: "missing" },
      }),
    ).toBe("복사하지 못했습니다: xclip: 찾을 수 없음.");
    expect(copyNotice({ chars: 3, osc52: "tooLarge", tool: null })).toContain("너무 큽니다");
    expect(copyNotice({ chars: 3, osc52: "failed", tool: null })).toContain("보낼 방법이 없습니다");
  });
});

describe("copyNotice in English", () => {
  it("is translated, not left in Korean", async () => {
    const { getLanguage, setLanguage } = await import("../i18n/index.ts");
    const before = getLanguage();
    setLanguage("en");
    try {
      expect(copyNotice({ chars: 12, osc52: "sent", tool: { name: "pbcopy", ok: true } })).toBe(
        "Copied 12 characters.",
      );
      expect(
        copyNotice({
          chars: 3,
          osc52: "failed",
          tool: { name: "xclip", ok: false, reason: "failed" },
        }),
      ).toBe("Could not copy: xclip: failed.");
    } finally {
      setLanguage(before);
    }
  });
});
