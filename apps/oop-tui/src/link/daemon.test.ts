import * as NodeNet from "node:net";

import { describe, expect, it, vi } from "vite-plus/test";

// Nothing here may start a real process: the launcher is given a fake, and this makes any path
// that reaches the real spawn fail loudly instead of running the app's server.
vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("a test reached the real spawn");
  },
}));

import {
  canListenEverywhere,
  createDaemonLauncher,
  DAEMON_ENTRY_VARIABLE,
  daemonCommand,
  daemonEnvironment,
  findAppProgram,
  LOCK_HELD_EXIT_CODE,
  mayRunOwnServer,
  pickPort,
  STARTUP_TIMEOUT_MS,
  type AppLookup,
  type AppProgram,
  type DaemonOutcome,
  desktopUpdateMarkerPath,
  UPDATE_MARKER_FRESH_MS,
  updateInProgress,
  type SpawnDaemon,
} from "./daemon.ts";
import { parseServerScript } from "./localAccess.ts";

const lookup = (over: Partial<AppLookup> & { present?: ReadonlyArray<string> } = {}): AppLookup => {
  const { present = [], ...rest } = over;
  return {
    platform: "darwin",
    env: {},
    home: "/Users/me",
    execPath: "/usr/local/bin/node",
    electron: undefined,
    exists: (path) => present.includes(path),
    ...rest,
  };
};

const MAC_EXE = "/Applications/OOP.app/Contents/MacOS/OOP";
const MAC_ARCHIVE = "/Applications/OOP.app/Contents/Resources/app.asar";
const MAC_SCRIPT = `${MAC_ARCHIVE}/apps/server/dist/bin.mjs`;
const WIN_EXE = "C:\\Users\\me\\AppData\\Local\\Programs\\OOP\\OOP.exe";
const WIN_ARCHIVE = "C:\\Users\\me\\AppData\\Local\\Programs\\OOP\\resources\\server.asar";
const WIN_SCRIPT = `${WIN_ARCHIVE}\\apps\\server\\dist\\bin.mjs`;

describe("findAppProgram", () => {
  it("finds the macOS app under /Applications from a system Node", () => {
    expect(findAppProgram(lookup({ present: [MAC_EXE, MAC_ARCHIVE] }))).toEqual({
      executable: MAC_EXE,
      serverScript: MAC_SCRIPT,
      explicit: false,
    });
  });

  it("falls back to ~/Applications on macOS", () => {
    const exe = "/Users/me/Applications/OOP.app/Contents/MacOS/OOP";
    const archive = "/Users/me/Applications/OOP.app/Contents/Resources/app.asar";
    expect(findAppProgram(lookup({ present: [exe, archive] }))?.executable).toBe(exe);
  });

  it("uses the app's own executable when the app's runtime runs the terminal", () => {
    const program = findAppProgram(
      lookup({
        electron: "44.9.3",
        execPath: MAC_EXE,
        present: [MAC_EXE, MAC_ARCHIVE],
        // A system install elsewhere does not matter then.
      }),
    );
    expect(program).toMatchObject({ executable: MAC_EXE, serverScript: MAC_SCRIPT });
  });

  it("reads the server tree from server.asar beside the executable on Windows", () => {
    expect(
      findAppProgram(
        lookup({
          platform: "win32",
          electron: "44.9.3",
          execPath: WIN_EXE,
          present: [WIN_EXE, WIN_ARCHIVE],
        }),
      ),
    ).toEqual({ executable: WIN_EXE, serverScript: WIN_SCRIPT, explicit: false });
  });

  it("looks for the per-user install under LOCALAPPDATA from a system Node on Windows", () => {
    expect(
      findAppProgram(
        lookup({
          platform: "win32",
          env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
          present: [WIN_EXE, WIN_ARCHIVE],
        }),
      )?.executable,
    ).toBe(WIN_EXE);
  });

  it("has nothing on Linux, and nothing when the app or its archive is missing", () => {
    expect(
      findAppProgram(lookup({ platform: "linux", present: [MAC_EXE, MAC_ARCHIVE] })),
    ).toBeNull();
    expect(findAppProgram(lookup({ present: [MAC_EXE] }))).toBeNull();
    expect(findAppProgram(lookup({ present: [] }))).toBeNull();
  });

  it("runs the named server file with the program running oop when OOP_DAEMON_ENTRY is set", () => {
    const entry = "/work/repo/apps/server/dist/bin.mjs";
    expect(
      findAppProgram(
        lookup({ env: { [DAEMON_ENTRY_VARIABLE]: entry }, present: [entry, MAC_EXE, MAC_ARCHIVE] }),
      ),
    ).toEqual({ executable: "/usr/local/bin/node", serverScript: entry, explicit: true });
  });

  it("does not fall back to the installed app when the named file is missing", () => {
    expect(
      findAppProgram(
        lookup({
          env: { [DAEMON_ENTRY_VARIABLE]: "/nope/bin.mjs" },
          present: [MAC_EXE, MAC_ARCHIVE],
        }),
      ),
    ).toBeNull();
  });
});

describe("mayRunOwnServer", () => {
  const installed: AppProgram = { executable: MAC_EXE, serverScript: MAC_SCRIPT, explicit: false };
  const named: AppProgram = { ...installed, explicit: true };

  it("allows the default home with the installed app", () => {
    expect(mayRunOwnServer(installed, false)).toBe(true);
  });

  it("does not run the app's program for an isolated home", () => {
    expect(mayRunOwnServer(installed, true)).toBe(false);
  });

  it("runs a named server in an isolated home, the one switch for tests", () => {
    expect(mayRunOwnServer(named, true)).toBe(true);
  });

  it("has nothing to run without a program", () => {
    expect(mayRunOwnServer(null, false)).toBe(false);
  });
});

describe("daemonCommand", () => {
  it("serves on the loopback from the given home and port", () => {
    const { file, args } = daemonCommand(
      { executable: MAC_EXE, serverScript: MAC_SCRIPT, explicit: false },
      "/Users/me/.oop-desktop",
      3774,
    );
    expect(file).toBe(MAC_EXE);
    expect(args).toEqual([
      MAC_SCRIPT,
      "serve",
      "--daemon",
      "--base-dir",
      "/Users/me/.oop-desktop",
      "--host",
      "127.0.0.1",
      "--port",
      "3774",
    ]);
  });

  it("gives a command line the pairing step recognises, on macOS", () => {
    const { file, args } = daemonCommand(
      { executable: MAC_EXE, serverScript: MAC_SCRIPT, explicit: false },
      "/Users/me/.oop-desktop",
      3773,
    );
    expect(parseServerScript([file, ...args].join(" "))).toBe(MAC_SCRIPT);
  });

  it("gives a command line the pairing step recognises, on Windows, quoted as Windows shows it", () => {
    const { file, args } = daemonCommand(
      { executable: WIN_EXE, serverScript: WIN_SCRIPT, explicit: false },
      "C:\\Users\\me\\.oop-desktop",
      3773,
    );
    const shown = [file, ...args].map((part) => (/\s/u.test(part) ? `"${part}"` : part));
    expect(parseServerScript(shown.join(" "))).toBe(WIN_SCRIPT);
    const spaced = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\OOP\\resources\\server.asar";
    const spacedScript = `${spaced}\\apps\\server\\dist\\bin.mjs`;
    expect(
      parseServerScript(`"C:\\Users\\Jane Doe\\x\\OOP.exe" "${spacedScript}" serve --daemon`),
    ).toBe(spacedScript);
  });
});

describe("daemonEnvironment", () => {
  it("drops the settings of the app's own server and makes the program run as Node", () => {
    expect(
      daemonEnvironment({
        PATH: "/bin",
        T3CODE_HOME: "/other",
        T3CODE_PORT: "1",
        ELECTRON_RUN_AS_NODE: "0",
      }),
    ).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  });
});

describe("pickPort", () => {
  it("takes the first free port from 3873 on, leaving the app's 3773 alone", async () => {
    const asked: number[] = [];
    const port = await pickPort(async (candidate) => {
      asked.push(candidate);
      return candidate >= 3875;
    });
    expect(port).toBe(3875);
    expect(asked).toEqual([3873, 3874, 3875]);
  });

  it("gives up when none of the ports near it is free", async () => {
    expect(await pickPort(async () => false)).toBeNull();
  });
});

describe("canListenEverywhere, on real sockets", () => {
  // Ports come from the system, never from 3773 and its neighbours: the app's may be running.
  const listenOn = (host: string) =>
    new Promise<{ port: number; close: () => Promise<void> } | null>((resolve) => {
      const server = NodeNet.createServer();
      server.once("error", () => resolve(null));
      server.listen({ host, port: 0 }, () =>
        resolve({
          port: (server.address() as NodeNet.AddressInfo).port,
          close: () => new Promise((done) => server.close(() => done())),
        }),
      );
    });

  it("is true for a port nothing listens on", async () => {
    const reserved = await listenOn("127.0.0.1");
    if (reserved === null) throw new Error("no loopback socket");
    await reserved.close();
    expect(await canListenEverywhere(reserved.port)).toBe(true);
  });

  it("is false for a port another server listens on across all interfaces", async () => {
    const wildcard = await listenOn("0.0.0.0");
    if (wildcard === null) throw new Error("no wildcard socket");
    try {
      expect(await canListenEverywhere(wildcard.port)).toBe(false);
    } finally {
      await wildcard.close();
    }
  });

  it("is false for a port listened on the IPv6 wildcard, where there is IPv6", async () => {
    const wildcard = await listenOn("::");
    if (wildcard === null) return;
    try {
      expect(await canListenEverywhere(wildcard.port)).toBe(false);
    } finally {
      await wildcard.close();
    }
  });

  it("is false for a port listened on the loopback only", async () => {
    const loopback = await listenOn("127.0.0.1");
    if (loopback === null) throw new Error("no loopback socket");
    try {
      expect(await canListenEverywhere(loopback.port)).toBe(false);
    } finally {
      await loopback.close();
    }
  });

  it("makes the scan skip the port of a wildcard listener", async () => {
    const wildcard = await listenOn("0.0.0.0");
    if (wildcard === null) throw new Error("no wildcard socket");
    try {
      const picked = await pickPort(canListenEverywhere, wildcard.port);
      expect(picked).not.toBeNull();
      expect(picked).toBeGreaterThan(wildcard.port);
    } finally {
      await wildcard.close();
    }
  });
});

describe("the update marker", () => {
  it("is runtime/desktop-update-installing under the OOP home", () => {
    expect(desktopUpdateMarkerPath("/Users/me/.oop-desktop").replaceAll("\\", "/")).toBe(
      "/Users/me/.oop-desktop/runtime/desktop-update-installing",
    );
  });

  const check = (age: number | null) =>
    updateInProgress({
      markerPath: "/m",
      now: () => 1_000_000,
      modifiedAt: async () => (age === null ? null : 1_000_000 - age),
    });

  it("counts as an update only while the file is recent", async () => {
    expect(await check(0)).toBe(true);
    expect(await check(UPDATE_MARKER_FRESH_MS - 1)).toBe(true);
    expect(await check(UPDATE_MARKER_FRESH_MS)).toBe(false);
    expect(await check(60 * 60_000)).toBe(false);
  });

  it("is no update when there is no file", async () => {
    expect(await check(null)).toBe(false);
  });

  it("is fifteen minutes", () => {
    expect(UPDATE_MARKER_FRESH_MS).toBe(15 * 60_000);
  });
});

describe("the launcher", () => {
  const program: AppProgram = { executable: MAC_EXE, serverScript: MAC_SCRIPT, explicit: false };

  /** A clock the fake sleep moves, so a wait takes no time and its length can be read. */
  const harness = (options: { ended?: number | null; endsAfterSpawn?: boolean } = {}) => {
    const clock = { now: 0 };
    const spawned: Array<{
      file: string;
      args: ReadonlyArray<string>;
      env: Record<string, string>;
    }> = [];
    let announce = false;
    let exit: ((code: number | null) => void) | null = null;
    const spawn: SpawnDaemon = (file, args, spawnOptions) => {
      spawned.push({ file, args, env: spawnOptions.env });
      return {
        onExit: (listener) => {
          exit = listener;
          if (options.endsAfterSpawn === true) listener(options.ended ?? null);
        },
      };
    };
    const launcher = createDaemonLauncher({
      program,
      home: "/Users/me/.oop-desktop",
      cwd: "/Users/me",
      env: { PATH: "/bin", T3CODE_HOME: "/other" },
      spawn,
      pickPort: async () => 3773,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    const discover = async () => ({ kind: announce ? "found" : "missing" });
    return {
      clock,
      spawned,
      launcher,
      discover,
      announce: () => {
        announce = true;
      },
      end: (code: number | null) => exit?.(code),
    };
  };

  it("starts the server once and is ready when it is announced", async () => {
    const h = harness();
    const pending = h.launcher.start(async () => {
      // The server shows up on the third look.
      if (h.clock.now >= 500) h.announce();
      return h.discover();
    });
    await expect(pending).resolves.toEqual({ kind: "ready" });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({ file: MAC_EXE });
    expect(h.spawned[0]?.args).toContain("--daemon");
    expect(h.spawned[0]?.env).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("goes back to the app when the bundle does not know the flag and ends at once", async () => {
    const h = harness({ endsAfterSpawn: true, ended: 1 });
    const outcome = await h.launcher.start(h.discover);
    expect(outcome.kind).toBe("unusable");
    expect(h.spawned).toHaveLength(1);
  });

  it("treats a program that cannot run at all as unusable", async () => {
    const h = harness({ endsAfterSpawn: true, ended: null });
    expect((await h.launcher.start(h.discover)).kind).toBe("unusable");
  });

  it("looks again, instead of failing, when the lock is held by another server", async () => {
    const h = harness({ endsAfterSpawn: true, ended: LOCK_HELD_EXIT_CODE });
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "occupied" });
  });

  it("calls the server that is announced the server even when ours ended with the lock held", async () => {
    const h = harness({ endsAfterSpawn: true, ended: LOCK_HELD_EXIT_CODE });
    h.announce();
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "ready" });
  });

  it("gives up after the timeout when nothing is announced and nothing ended", async () => {
    const h = harness();
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "slow" });
    expect(h.clock.now).toBeGreaterThanOrEqual(STARTUP_TIMEOUT_MS);
  });

  it("starts nothing, and counts no failure, while the app installs an update", async () => {
    const h = harness();
    let updating = true;
    const launcher = createDaemonLauncher({
      program,
      home: "/h",
      cwd: "/",
      env: {},
      spawn: (file, args, options) => {
        h.spawned.push({ file, args, env: options.env });
        return { onExit: () => undefined };
      },
      pickPort: async () => 3773,
      now: () => h.clock.now,
      sleep: async (ms) => {
        h.clock.now += ms;
      },
      updating: async () => updating,
    });
    expect(await launcher.start(h.discover)).toEqual({ kind: "updating" });
    expect(await launcher.start(h.discover)).toEqual({ kind: "updating" });
    expect(h.spawned).toHaveLength(0);
    // The marker is gone: the next attempt starts at once, with no backoff to wait out.
    updating = false;
    h.announce();
    expect(await launcher.start(h.discover)).toEqual({ kind: "ready" });
    expect(h.spawned).toHaveLength(1);
  });

  it("starts only one server when asked twice at once", async () => {
    const h = harness();
    const first = h.launcher.start(h.discover);
    const second = h.launcher.start(h.discover);
    h.announce();
    const outcomes: DaemonOutcome[] = await Promise.all([first, second]);
    expect(outcomes).toEqual([{ kind: "ready" }, { kind: "ready" }]);
    expect(h.spawned).toHaveLength(1);
  });

  it("starts nothing for a while after a failure, then backs off further each time", async () => {
    const h = harness({ endsAfterSpawn: true, ended: 1 });
    expect((await h.launcher.start(h.discover)).kind).toBe("unusable");
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "cooling" });
    expect(h.spawned).toHaveLength(1);

    h.clock.now += 10_000;
    expect((await h.launcher.start(h.discover)).kind).toBe("unusable");
    // The second failure waits twice as long.
    h.clock.now += 10_000;
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "cooling" });
    h.clock.now += 10_000;
    expect((await h.launcher.start(h.discover)).kind).toBe("unusable");
    expect(h.spawned).toHaveLength(3);
  });

  it("waits a few seconds before another start after the lock was held", async () => {
    const h = harness({ endsAfterSpawn: true, ended: LOCK_HELD_EXIT_CODE });
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "occupied" });
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "cooling" });
    h.clock.now += 5_000;
    expect(await h.launcher.start(h.discover)).toEqual({ kind: "occupied" });
    expect(h.spawned).toHaveLength(2);
  });

  it("reports a spawn that throws as unusable", async () => {
    const launcher = createDaemonLauncher({
      program,
      home: "/h",
      cwd: "/",
      env: {},
      spawn: () => {
        throw new Error("EACCES");
      },
      pickPort: async () => 3773,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect((await launcher.start(async () => ({ kind: "missing" }))).kind).toBe("unusable");
  });

  it("starts nothing when there is no free port", async () => {
    const spawn = vi.fn();
    const launcher = createDaemonLauncher({
      program,
      home: "/h",
      cwd: "/",
      env: {},
      spawn,
      pickPort: async () => null,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect((await launcher.start(async () => ({ kind: "missing" }))).kind).toBe("unusable");
    expect(spawn).not.toHaveBeenCalled();
  });
});
