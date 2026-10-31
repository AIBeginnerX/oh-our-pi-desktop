import { describe, expect, it } from "vite-plus/test";

import type { DiscoveryResult } from "../link/discovery.ts";
import { runStopCommand, terminateProcess, type StopCommandDeps } from "./stopCommand.ts";

const SERVER_COMMAND =
  "/Applications/OOP.app/Contents/MacOS/OOP /Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs serve --daemon";

const found = (over: { daemon?: true } = {}): DiscoveryResult => ({
  kind: "found",
  pid: 4242,
  origin: "http://127.0.0.1:3773",
  environmentId: "env-1",
  label: "내 Mac",
  ...over,
});

const run = async (
  discovered: DiscoveryResult,
  over: Partial<StopCommandDeps> & { endsAfter?: number } = {},
) => {
  const { endsAfter = 0, ...deps } = over;
  const out: string[] = [];
  const err: string[] = [];
  const signalled: number[] = [];
  const inspected: Array<[number, number]> = [];
  const clock = { now: 0 };
  let alive = true;
  const code = await runStopCommand({
    discover: async () => discovered,
    inspect: async (pid, port) => {
      inspected.push([pid, port]);
      return { command: SERVER_COMMAND };
    },
    terminate: (pid) => {
      signalled.push(pid);
      if (endsAfter === 0) alive = false;
    },
    isAlive: () => alive,
    sleep: async (ms) => {
      clock.now += ms;
      if (endsAfter > 0 && clock.now >= endsAfter) alive = false;
    },
    now: () => clock.now,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), signalled, inspected };
};

describe("oop stop", () => {
  it("stops the terminal's own server, after checking the process, and warns about turns", async () => {
    const result = await run(found({ daemon: true }));
    expect(result.code).toBe(0);
    expect(result.inspected).toEqual([[4242, 3773]]);
    expect(result.signalled).toEqual([4242]);
    expect(result.out).toContain("진행 중인 턴이 있으면 끊깁니다");
    expect(result.out).toContain("멈췄습니다");
  });

  it("waits until the server has gone", async () => {
    const result = await run(found({ daemon: true }), { endsAfter: 1_000 });
    expect(result.code).toBe(0);
    expect(result.out).toContain("멈췄습니다");
  });

  it("does not stop the app's server, and says whose it is", async () => {
    const result = await run(found());
    expect(result.code).toBe(1);
    expect(result.signalled).toEqual([]);
    expect(result.inspected).toEqual([]);
    expect(result.out).toContain("앱이 쓰는 서버");
  });

  it("says there is no server when there is none, and signals nothing", async () => {
    for (const kind of ["missing", "stale"] as const) {
      const result = await run({ kind, detail: "x" });
      expect(result.code).toBe(0);
      expect(result.out).toContain("실행 중인 OOP 서버가 없습니다");
      expect(result.signalled).toEqual([]);
    }
  });

  it("signals nothing to a server that does not answer", async () => {
    const result = await run({ kind: "unreachable", detail: "x" });
    expect(result.code).toBe(1);
    expect(result.signalled).toEqual([]);
  });

  it("signals nothing to a pid that does not check out as this user's server on that port", async () => {
    const result = await run(found({ daemon: true }), { inspect: async () => null });
    expect(result.code).toBe(1);
    expect(result.signalled).toEqual([]);
    expect(result.err).toContain("확인하지 못해 멈추지 않았습니다");
  });

  it("signals nothing to a process that is not running the OOP server script", async () => {
    const result = await run(found({ daemon: true }), {
      inspect: async () => ({ command: "/usr/bin/sleep 1000" }),
    });
    expect(result.code).toBe(1);
    expect(result.signalled).toEqual([]);
  });

  it("reports a server that is still running after the wait", async () => {
    const result = await run(found({ daemon: true }), { endsAfter: 60_000 });
    expect(result.code).toBe(1);
    expect(result.err).toContain("아직 끝나지 않았습니다");
  });
});

describe("terminateProcess", () => {
  const ports = (platform: NodeJS.Platform) => {
    const calls = { kill: [] as Array<[number, string]>, taskkill: [] as string[][] };
    return {
      calls,
      ports: {
        platform,
        kill: (pid: number, signal: "SIGTERM") => calls.kill.push([pid, signal]),
        taskkill: (args: ReadonlyArray<string>) => calls.taskkill.push([...args]),
      },
    };
  };

  it("sends SIGTERM on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { calls, ports: fake } = ports(platform);
      terminateProcess(4242, fake);
      expect(calls.kill).toEqual([[4242, "SIGTERM"]]);
      expect(calls.taskkill).toEqual([]);
    }
  });

  it("ends the whole process tree on Windows, as the app does its own backend", () => {
    const { calls, ports: fake } = ports("win32");
    terminateProcess(4242, fake);
    expect(calls.taskkill).toEqual([["/pid", "4242", "/T", "/F"]]);
    expect(calls.kill).toEqual([]);
  });
});
