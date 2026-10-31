import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { hostPlatform } from "../host.ts";
import {
  inspectServer,
  type LocalAccessDeps,
  mintLocalPairingToken,
  originPort,
  parsePairingToken,
  parseServerScript,
  sessionIsValid,
  startDesktopApp,
  waitUntilFound,
  windowsPowerShell,
  windowsTaskkill,
} from "./localAccess.ts";

const DESKTOP_COMMAND =
  "/Applications/OOP.app/Contents/MacOS/OOP --require /Applications/OOP.app/Contents/Resources/app.asar/apps/desktop/dist-electron/compileCache.cjs /Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3";
const SCRIPT = "/Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";
const WINDOWS_RESOURCES = "C:\\Users\\me\\AppData\\Local\\Programs\\OOP\\resources";
const WINDOWS_EXECUTABLE = "C:\\Users\\me\\AppData\\Local\\Programs\\OOP\\OOP.exe";
// The packaged Windows app keeps the server in its own server.asar, next to app.asar (see
// DesktopEnvironment.ts, serverRoot).
const WINDOWS_SCRIPT = `${WINDOWS_RESOURCES}\\server.asar\\apps\\server\\dist\\bin.mjs`;
const WINDOWS_COMMAND = `"${WINDOWS_EXECUTABLE}" --require "${WINDOWS_RESOURCES}\\app.asar\\apps\\desktop\\dist-electron\\compileCache.cjs" "${WINDOWS_SCRIPT}" --bootstrap-fd 3`;

describe("parseServerScript", () => {
  it("finds the script in the desktop app's command line", () => {
    expect(parseServerScript(DESKTOP_COMMAND)).toBe(SCRIPT);
  });

  it("keeps spaces inside a path", () => {
    expect(parseServerScript("/My Apps/OOP --x /My Apps/OOP/apps/server/dist/bin.mjs --y 1")).toBe(
      "/My Apps/OOP/apps/server/dist/bin.mjs",
    );
  });

  it("finds a server run from source", () => {
    expect(parseServerScript("node /repo/apps/server/src/bin.ts serve --port 1")).toBe(
      "/repo/apps/server/src/bin.ts",
    );
  });

  it("gives up on anything else", () => {
    expect(parseServerScript("node /repo/other/bin.mjs")).toBeNull();
    expect(parseServerScript("node C:\\repo\\other\\bin.mjs")).toBeNull();
  });

  it("finds the script in a quoted Windows command line", () => {
    expect(parseServerScript(WINDOWS_COMMAND)).toBe(WINDOWS_SCRIPT);
  });

  it("keeps spaces inside a quoted Windows path", () => {
    const script = "C:\\Program Files\\My OOP\\resources\\server.asar\\apps\\server\\dist\\bin.mjs";
    expect(parseServerScript(`"C:\\Program Files\\My OOP\\OOP.exe" "${script}" --x 1`)).toBe(
      script,
    );
  });

  it("finds an unquoted Windows path, which holds no spaces", () => {
    const command = `C:\\OOP\\OOP.exe --require C:\\OOP\\compileCache.cjs C:\\OOP\\apps\\server\\dist\\bin.mjs --bootstrap-fd 3`;
    expect(parseServerScript(command)).toBe("C:\\OOP\\apps\\server\\dist\\bin.mjs");
    expect(parseServerScript("node.exe C:\\repo\\apps\\server\\src\\bin.ts serve")).toBe(
      "C:\\repo\\apps\\server\\src\\bin.ts",
    );
  });
});

describe("parsePairingToken", () => {
  it("reads the token line and nothing else", () => {
    const output = "Pairing with Mac.\n\nPairing URL: http://x/pair#token=aaa\nToken: abc123\n";
    expect(parsePairingToken(output)).toBe("abc123");
    expect(parsePairingToken("no token here")).toBeNull();
  });
});

describe("originPort", () => {
  it("is the written port, else the scheme's default", () => {
    expect(originPort("http://127.0.0.1:3773")).toBe(3773);
    expect(originPort("http://127.0.0.1")).toBe(80);
    expect(originPort("http://127.0.0.1:80")).toBe(80);
    expect(originPort("https://localhost")).toBe(443);
    expect(originPort("https://localhost:443/")).toBe(443);
    expect(originPort("https://localhost:8443")).toBe(8443);
  });
});

describe("windowsPowerShell", () => {
  it("is an absolute path under SystemRoot, so no program in the current folder can stand in", () => {
    expect(windowsPowerShell("D:\\WINNT")).toBe(
      "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShell("")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe("windowsTaskkill", () => {
  it("is an absolute path under SystemRoot, so no program in the current folder can stand in", () => {
    expect(windowsTaskkill("D:\\WINNT")).toBe("D:\\WINNT\\System32\\taskkill.exe");
    expect(windowsTaskkill("")).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

const SS_LINE = (pid: number, port = 3773) =>
  `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("OOP",pid=${pid},fd=20))\n`;

const windowsJson = (executable: string, command: string) =>
  `${JSON.stringify({ executable, command })}\n`;

describe("mintLocalPairingToken", () => {
  const input = {
    pid: 42,
    origin: "http://127.0.0.1:3773",
    home: "/home/.oop-desktop",
    label: "oop (mac)",
  };
  const deps = (overrides: Partial<LocalAccessDeps> = {}) => {
    const calls: Array<{
      file: string;
      args: ReadonlyArray<string>;
      env: Readonly<Record<string, string>> | undefined;
    }> = [];
    return {
      calls,
      deps: {
        platform: "darwin",
        uid: 501,
        readLink: async () => "/proc/exe",
        run: async (file, args, env) => {
          calls.push({ file, args, env });
          if (file === "lsof") return "42\n";
          if (file === "ss") return SS_LINE(42);
          if (file === windowsPowerShell()) return windowsJson(WINDOWS_EXECUTABLE, WINDOWS_COMMAND);
          if (args[0] === "-o" && args[1] === "uid=") return "  501\n";
          if (args[0] === "-o" && args[1] === "comm=") {
            return "/Applications/OOP.app/Contents/MacOS/OOP\n";
          }
          if (args[0] === "-o") return `${DESKTOP_COMMAND}\n`;
          return "Token: abc123\n";
        },
        ...overrides,
      } satisfies LocalAccessDeps,
    };
  };

  it("runs the server's own program as Node and returns the token", async () => {
    const { calls, deps: fake } = deps();
    expect(await mintLocalPairingToken(input, fake)).toBe("abc123");
    expect(calls.at(-1)).toEqual({
      file: "/Applications/OOP.app/Contents/MacOS/OOP",
      args: [
        SCRIPT,
        "pair",
        "--base-dir",
        "/home/.oop-desktop",
        "--label",
        "oop (mac)",
        "--ttl",
        "1m",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("reads the executable from /proc on Linux", async () => {
    const { calls, deps: fake } = deps({ platform: "linux", readLink: async () => "/opt/OOP" });
    expect(await mintLocalPairingToken(input, fake)).toBe("abc123");
    expect(calls.at(-1)?.file).toBe("/opt/OOP");
  });

  it("asks the Windows process list for the program and runs it as Node", async () => {
    const { calls, deps: fake } = deps({ platform: "win32" });
    expect(await mintLocalPairingToken(input, fake)).toBe("abc123");
    expect(calls.map((call) => call.file)).toEqual([windowsPowerShell(), WINDOWS_EXECUTABLE]);
    expect(calls.at(-1)?.args[0]).toBe(WINDOWS_SCRIPT);
    expect(calls.at(-1)?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("does not run the program of another user's process", async () => {
    const { calls, deps: fake } = deps({ uid: 502 });
    expect(await mintLocalPairingToken(input, fake)).toBeNull();
    expect(calls.map((call) => call.file)).toEqual(["ps"]);
  });

  it("does not run the program of a pid that no longer serves that port", async () => {
    const { calls, deps: real } = deps();
    const fake = {
      ...real,
      run: async (...args: Parameters<LocalAccessDeps["run"]>) => {
        if (args[0] === "lsof") throw new Error("lsof failed");
        return real.run(...args);
      },
    };
    expect(await mintLocalPairingToken(input, fake)).toBeNull();
    expect(calls.some((call) => call.args.includes("pair"))).toBe(false);
  });

  it("gives null when the program fails", async () => {
    const { deps: fake } = deps({
      run: async () => {
        throw new Error("failed");
      },
    });
    expect(await mintLocalPairingToken(input, fake)).toBeNull();
  });
});

describe("inspectServer", () => {
  const posix = (platform: "darwin" | "linux", ss: string): LocalAccessDeps => ({
    platform,
    uid: 501,
    readLink: async () => "/opt/OOP",
    run: async (file, args) => {
      if (file === "lsof") return "42\n";
      if (file === "ss") return ss;
      if (args[1] === "uid=") return "501\n";
      if (args[1] === "comm=") return "/Applications/OOP\n";
      return "/Applications/OOP --x\n";
    },
  });
  const windows = (run: LocalAccessDeps["run"]): LocalAccessDeps => ({
    platform: "win32",
    uid: -1,
    readLink: async () => "",
    run,
  });

  it("accepts a pid that listens on the port, from ss on Linux", async () => {
    expect(await inspectServer(42, 3773, posix("linux", SS_LINE(42)))).toEqual({
      executable: "/opt/OOP",
      command: "/Applications/OOP --x",
    });
    const several = `LISTEN 0 4096 [::1]:3773 [::]:* users:(("a",pid=7,fd=3),("b",pid=42,fd=4))\n`;
    expect(await inspectServer(42, 3773, posix("linux", several))).not.toBeNull();
  });

  it("refuses when ss shows another pid or another port on Linux", async () => {
    expect(await inspectServer(42, 3773, posix("linux", SS_LINE(43)))).toBeNull();
    expect(await inspectServer(42, 3773, posix("linux", SS_LINE(42, 13773)))).toBeNull();
    expect(await inspectServer(42, 3773, posix("linux", SS_LINE(142)))).toBeNull();
    expect(await inspectServer(42, 3773, posix("linux", ""))).toBeNull();
  });

  it("uses ps and lsof on macOS", async () => {
    expect(await inspectServer(42, 3773, posix("darwin", ""))).toEqual({
      executable: "/Applications/OOP",
      command: "/Applications/OOP --x",
    });
  });

  it("only passes checked integers to PowerShell", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const files: string[] = [];
    const fake = windows(async (file, args) => {
      files.push(file);
      calls.push(args);
      return windowsJson(WINDOWS_EXECUTABLE, WINDOWS_COMMAND);
    });
    for (const [pid, port] of [
      [0, 3773],
      [-4, 3773],
      [1.5, 3773],
      [Number.NaN, 3773],
      [42, 0],
      [42, 70_000],
      [42, 3773.5],
    ] as const) {
      expect(await inspectServer(pid, port, fake)).toBeNull();
    }
    expect(calls).toEqual([]);

    expect(await inspectServer(42, 3773, fake)).toEqual({
      executable: WINDOWS_EXECUTABLE,
      command: WINDOWS_COMMAND,
    });
    expect(files).toEqual([windowsPowerShell()]);
    expect(calls[0]?.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(calls[0]?.[3]).toContain("$serverPid = 42; $serverPort = 3773;");
  });

  it("refuses on Windows when the script fails or prints something else", async () => {
    const failing = windows(async () => {
      throw new Error("exit 1");
    });
    expect(await inspectServer(42, 3773, failing)).toBeNull();
    expect(
      await inspectServer(
        42,
        3773,
        windows(async () => "not json"),
      ),
    ).toBeNull();
    expect(
      await inspectServer(
        42,
        3773,
        windows(async () => "null"),
      ),
    ).toBeNull();
    expect(
      await inspectServer(
        42,
        3773,
        windows(async () => "{}"),
      ),
    ).toBeNull();
  });

  it("reads JSON that starts with a byte order mark", async () => {
    const fake = windows(async () => `\uFEFF${windowsJson(WINDOWS_EXECUTABLE, WINDOWS_COMMAND)}`);
    expect((await inspectServer(42, 3773, fake))?.executable).toBe(WINDOWS_EXECUTABLE);
  });
});

// The real check against this computer's own tools: macOS runs ps and lsof, Linux ps and ss, and
// Windows runs the fixed PowerShell script. This process listens on a temporary port and must be
// recognised there, and only there.
const hasProgram = (name: string, probe: string) =>
  NodeChildProcess.spawnSync(name, [probe], { stdio: "ignore", timeout: 5_000 }).error ===
  undefined;
const platform = hostPlatform();
const canInspect =
  platform === "win32" ||
  (hasProgram("ps", "-V") &&
    (platform === "darwin" ? hasProgram("lsof", "-v") : hasProgram("ss", "-V")));

describe.runIf(canInspect)("inspectServer on this computer", () => {
  const listener = NodeNet.createServer();
  let port = 0;
  let unusedPort = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as NodeNet.AddressInfo).port;
    const spare = NodeNet.createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    unusedPort = (spare.address() as NodeNet.AddressInfo).port;
    await new Promise((resolve) => spare.close(resolve));
  });
  afterAll(() => new Promise((resolve) => listener.close(resolve)));

  it("recognises this process on the port it listens on", async () => {
    const found = await inspectServer(process.pid, port);
    expect(found).not.toBeNull();
    expect(NodePath.basename(found?.executable ?? "").toLowerCase()).toBe(
      NodePath.basename(process.execPath).toLowerCase(),
    );
    expect(found?.command).not.toBe("");
  });

  it("refuses a port nothing of ours listens on", async () => {
    expect(await inspectServer(process.pid, unusedPort)).toBeNull();
  });

  it("refuses another pid on our port", async () => {
    expect(await inspectServer(process.ppid, port)).toBeNull();
  });
});

// A skipped system test proves nothing, so Windows, where nothing needs to be installed for it,
// must never skip.
it.runIf(platform === "win32")("does not skip the system checks on Windows", () => {
  expect(canInspect).toBe(true);
});

// Windows only: the executable PowerShell reports must be the path on disk, exactly, with spaces
// and Hangul in it, because it is the program that is later run.
describe.runIf(platform === "win32")("inspectServer on Windows", () => {
  it("reports an executable whose folder has spaces and Hangul exactly", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-inspect-")),
    );
    const folder = NodePath.join(root, "한글 폴더");
    const executable = NodePath.join(folder, NodePath.basename(process.execPath));
    await NodeFSP.mkdir(folder);
    await NodeFSP.copyFile(process.execPath, executable);
    const child = NodeChildProcess.spawn(
      executable,
      [
        "-e",
        'require("node:net").createServer().listen(0, "127.0.0.1", function () { console.log(this.address().port); }); setInterval(() => {}, 1e6);',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      if (pid === undefined) throw new Error("the child did not start");
      const port = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });
      const found = await inspectServer(pid, port);
      expect(found?.executable).toBe(executable);
    } finally {
      if (pid !== undefined) process.kill(pid);
      await exited;
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("sessionIsValid", () => {
  const respond = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("trusts a session the server recognises", async () => {
    expect(
      await sessionIsValid("http://127.0.0.1:1", "t", respond(200, { authenticated: true })),
    ).toBe(true);
  });

  it("rejects what the server does not recognise", async () => {
    expect(await sessionIsValid("http://127.0.0.1:1", "t", respond(401))).toBe(false);
    expect(
      await sessionIsValid("http://127.0.0.1:1", "t", respond(200, { authenticated: false })),
    ).toBe(false);
  });

  it("does not blame the token for a server it could not reach", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await sessionIsValid("http://127.0.0.1:1", "t", failing)).toBe(true);
  });
});

describe("startDesktopApp", () => {
  const fakeDeps = (
    platform: NodeJS.Platform,
    run: LocalAccessDeps["run"] = async () => "",
  ): LocalAccessDeps => ({ platform, uid: 501, readLink: async () => "", run });

  it("opens the app behind the terminal on macOS", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const deps = fakeDeps("darwin", async (_file, args) => {
      calls.push(args);
      return "";
    });
    expect(await startDesktopApp(deps)).toBe(true);
    expect(calls).toEqual([["-g", "-a", "OOP"]]);
  });

  it("starts the per-user install under LOCALAPPDATA on Windows", async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string> }> = [];
    const deps = fakeDeps("win32", async (file, args) => {
      calls.push({ file, args });
      return "";
    });
    expect(await startDesktopApp(deps)).toBe(true);
    expect(calls[0]?.file).toBe(windowsPowerShell());
    expect(NodePath.win32.isAbsolute(calls[0]?.file ?? "")).toBe(true);
    expect(calls[0]?.args[3]).toContain("Programs\\OOP\\OOP.exe");
    // The variable oop.cmd sets must not reach the app and the terminals under it.
    const script = calls[0]?.args[3] ?? "";
    const clear = script.indexOf("Remove-Item Env:NoDefaultCurrentDirectoryInExePath");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(script.indexOf("Start-Process"));
  });

  it("has no app to start on Linux", async () => {
    expect(await startDesktopApp(fakeDeps("linux"))).toBe(false);
  });

  it("says so when the app is not installed", async () => {
    const missing = async () => {
      throw new Error("no app");
    };
    expect(await startDesktopApp(fakeDeps("darwin", missing))).toBe(false);
    expect(await startDesktopApp(fakeDeps("win32", missing))).toBe(false);
  });
});

describe("waitUntilFound", () => {
  it("stops as soon as the server shows up", async () => {
    let attempts = 0;
    const result = await waitUntilFound(
      async () => {
        attempts += 1;
        return { kind: attempts === 3 ? "found" : "missing" };
      },
      async () => {},
    );
    expect(result.kind).toBe("found");
    expect(attempts).toBe(3);
  });

  it("waits as long as it is told to", async () => {
    let attempts = 0;
    const result = await waitUntilFound(
      async () => {
        attempts += 1;
        return { kind: attempts === 46 ? "found" : "missing" };
      },
      async () => {},
      45_000,
    );
    expect(result.kind).toBe("found");
    expect(attempts).toBe(46);
  });

  it("gives up with the last answer", async () => {
    let attempts = 0;
    const result = await waitUntilFound(
      async () => {
        attempts += 1;
        return { kind: "missing" };
      },
      async () => {},
    );
    expect(result.kind).toBe("missing");
    expect(attempts).toBe(31);
  });
});
