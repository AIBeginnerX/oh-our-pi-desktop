import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { linkNotice } from "../app/view.ts";
import { makeStyle } from "../render/style.ts";
import { stringWidth } from "../text/width.ts";
import { CredentialStore } from "./credentials.ts";
import {
  createDaemonLauncher,
  LOCK_HELD_EXIT_CODE,
  type AppProgram,
  type DaemonLauncher,
  type SpawnDaemon,
} from "./daemon.ts";
import type { DiscoveryResult } from "./discovery.ts";
import { makeEffectTransport } from "./effectTransport.ts";
import { OWN_SERVER_GRACE_MS, resolveServer, type ResolvedTarget } from "./resolveServer.ts";
import { selectCredential } from "./selectCredential.ts";
import { TransportError } from "./transport.ts";

const found = (
  over: Partial<Extract<DiscoveryResult, { kind: "found" }>> = {},
): DiscoveryResult => ({
  kind: "found",
  pid: 42,
  origin: "http://127.0.0.1:3773",
  environmentId: "env-1",
  label: "내 Mac",
  ...over,
});

const missing: DiscoveryResult = { kind: "missing", detail: "실행 중인 OOP 서버가 없습니다." };

/** Answers each discovery with the next scripted result, then keeps repeating the last. */
const scripted = (...results: DiscoveryResult[]) => {
  let next = 0;
  return async () => results[Math.min(next++, results.length - 1)] as DiscoveryResult;
};

/** An inspection that records what it was asked and answers from a switch the test flips. */
const inspection = (accept = true) => {
  const asked: Array<{ pid: number; port: number }> = [];
  const state = { accept };
  return {
    asked,
    state,
    inspect: async (pid: number, port: number) => {
      asked.push({ pid, port });
      return state.accept ? {} : null;
    },
  };
};

const probeNothing = async () => null;
const quiet = () => undefined;
const noSleep = async () => undefined;

const located = (result: ResolvedTarget | { readonly error: string }): ResolvedTarget => {
  if ("error" in result) throw new Error(`expected a server, got: ${result.error}`);
  return result;
};

const program: AppProgram = {
  executable: "/Applications/OOP.app/Contents/MacOS/OOP",
  serverScript: "/Applications/OOP.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
  explicit: false,
};

/**
 * The terminal's own server with nothing real behind it: a clock the test moves, a spawn that
 * records what it was asked to run and ends as told (never, by default), and a hook for what the
 * start does to the world.
 */
const ownServerWorld = (options: { exit?: number | null; onSpawn?: () => void } = {}) => {
  const clock = { now: 0 };
  const flags = { updating: false };
  const spawned: string[][] = [];
  const spawn: SpawnDaemon = (file, args) => {
    spawned.push([file, ...args]);
    options.onSpawn?.();
    return {
      onExit: (listener) => {
        if (options.exit !== undefined) listener(options.exit);
      },
    };
  };
  const launcher: DaemonLauncher = createDaemonLauncher({
    program,
    home: "/Users/me/.oop-desktop",
    cwd: "/Users/me",
    env: {},
    spawn,
    pickPort: async () => 3773,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    updating: async () => flags.updating,
  });
  return { clock, spawned, launcher, flags };
};

/** A world whose server is announced once the program has been started (unless it ends badly). */
const startable = (options: { exit?: number | null } = {}) => {
  const state: { current: DiscoveryResult } = { current: missing };
  const world = ownServerWorld({
    ...options,
    onSpawn: () => {
      if (options.exit === undefined || options.exit === LOCK_HELD_EXIT_CODE) {
        state.current = found({ pid: 99, origin: "http://127.0.0.1:3774" });
      }
    },
  });
  return { ...world, state, discover: async () => state.current };
};

/** The reasons the banner shows while the terminal waits for, fails to start, or is slow to start its own server. */
const ownServerReasons = async (): Promise<string[]> => {
  const reasons: string[] = [];
  for (const exit of [undefined, 1] as const) {
    const world = ownServerWorld(exit === undefined ? {} : { exit });
    let current: DiscoveryResult = found();
    const target = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: async () => current,
        inspect: inspection().inspect,
        ownServer: world.launcher,
        notify: quiet,
        now: () => world.clock.now,
      }),
    );
    current = missing;
    const locate = target.locateOrigin;
    if (locate === undefined) throw new Error("expected a way to find the address again");
    const ask = async () =>
      ((await locate().catch((cause: unknown) => cause)) as TransportError).message;
    reasons.push(await ask());
    world.clock.now += OWN_SERVER_GRACE_MS;
    reasons.push(await ask());
  }
  const updating = ownServerWorld();
  let current: DiscoveryResult = found();
  const target = located(
    await resolveServer({
      server: null,
      probe: probeNothing,
      discover: async () => current,
      inspect: inspection().inspect,
      ownServer: updating.launcher,
      notify: quiet,
      now: () => updating.clock.now,
    }),
  );
  current = missing;
  updating.flags.updating = true;
  const locateWhileUpdating = target.locateOrigin;
  if (locateWhileUpdating === undefined)
    throw new Error("expected a way to find the address again");
  await locateWhileUpdating().catch(() => undefined);
  updating.clock.now += OWN_SERVER_GRACE_MS;
  reasons.push(
    ((await locateWhileUpdating().catch((cause: unknown) => cause)) as TransportError).message,
  );
  return [...new Set(reasons)];
};

describe("resolveServer, announced by the desktop app", () => {
  it("returns the server once its process checks out", async () => {
    const check = inspection();
    const result = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: scripted(found()),
        inspect: check.inspect,
        notify: quiet,
      }),
    );
    expect(result).toMatchObject({
      origin: "http://127.0.0.1:3773",
      environmentId: "env-1",
      pid: 42,
    });
    expect(check.asked).toEqual([{ pid: 42, port: 3773 }]);
  });

  it("checks the scheme's default port when the address has none", async () => {
    const plain = inspection();
    await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(found({ origin: "http://127.0.0.1:80" })),
      inspect: plain.inspect,
      notify: quiet,
    });
    const secure = inspection();
    await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(found({ origin: "https://localhost" })),
      inspect: secure.inspect,
      notify: quiet,
    });
    expect(plain.asked).toEqual([{ pid: 42, port: 80 }]);
    expect(secure.asked).toEqual([{ pid: 42, port: 443 }]);
  });

  it("hands out no server, and says so, when the process does not check out", async () => {
    const result = await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(found()),
      inspect: inspection(false).inspect,
      notify: quiet,
    });
    expect(result).toEqual({ error: expect.stringContaining("토큰을 보내지 않았습니다") });
  });

  it("counts an inspection that fails as a refusal", async () => {
    const result = await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(found()),
      inspect: async () => {
        throw new Error("boom");
      },
      notify: quiet,
    });
    expect("error" in result).toBe(true);
  });

  it("leaves an announced address off the loopback to the saved-token rules", async () => {
    const check = inspection(false);
    const result = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: scripted(found({ origin: "http://192.168.0.5:3773" })),
        inspect: check.inspect,
        notify: quiet,
      }),
    );
    expect(check.asked).toEqual([]);
    expect(result.locateOrigin).toBeUndefined();
  });

  it("starts the app when asked to and waits for a server that checks out", async () => {
    const check = inspection(false);
    let started = 0;
    const notices: string[] = [];
    const result = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        // Missing before the app runs, then announced but not yet listening, then ready.
        discover: scripted(missing, found(), found()),
        inspect: async (pid, port) => {
          const answer = await check.inspect(pid, port);
          if (check.asked.length === 2) check.state.accept = true;
          return answer;
        },
        startApp: async () => {
          started += 1;
          return true;
        },
        notify: (text) => notices.push(text),
        sleep: noSleep,
      }),
    );
    expect(started).toBe(1);
    expect(notices).toHaveLength(1);
    expect(result.pid).toBe(42);
  });

  it("does not start the app that is running but whose process does not check out", async () => {
    let started = 0;
    const result = await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(found()),
      inspect: inspection(false).inspect,
      startApp: async () => {
        started += 1;
        return true;
      },
      notify: quiet,
      sleep: noSleep,
    });
    expect(started).toBe(0);
    expect(result).toEqual({ error: expect.stringContaining("토큰을 보내지 않았습니다") });
  });

  it("does not start the app unless given the means", async () => {
    const result = await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(missing),
      notify: quiet,
    });
    expect(result).toEqual({ error: missing.detail });
  });
});

describe("resolveServer, with an address given", () => {
  it("probes that address and trusts nothing else about it", async () => {
    const check = inspection(false);
    const result = located(
      await resolveServer({
        server: "127.0.0.1:9000",
        probe: async (origin) =>
          origin === "http://127.0.0.1:9000" ? { environmentId: "e", label: "l" } : null,
        discover: scripted(found()),
        inspect: check.inspect,
        notify: quiet,
      }),
    );
    expect(result).toEqual({ origin: "http://127.0.0.1:9000", environmentId: "e", label: "l" });
    expect(check.asked).toEqual([]);
  });

  it("reports a server that does not answer", async () => {
    const result = await resolveServer({
      server: "https://oop.example",
      probe: probeNothing,
      discover: scripted(found()),
      notify: quiet,
    });
    expect(result).toEqual({ error: expect.stringContaining("https://oop.example") });
  });
});

describe("the address for each reconnection", () => {
  const setup = async (...later: DiscoveryResult[]) => {
    const check = inspection();
    const result = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: scripted(found(), ...later),
        inspect: check.inspect,
        notify: quiet,
      }),
    );
    const locate = result.locateOrigin;
    if (locate === undefined) throw new Error("expected a way to find the address again");
    return { check, locate };
  };

  it("is the same address while the server checks out", async () => {
    const { locate } = await setup(found());
    expect(await locate()).toBe("http://127.0.0.1:3773");
  });

  it("follows the app to a new port when it is the same server", async () => {
    const { check, locate } = await setup(found({ origin: "http://127.0.0.1:41000", pid: 77 }));
    expect(await locate()).toBe("http://127.0.0.1:41000");
    expect(check.asked.at(-1)).toEqual({ pid: 77, port: 41000 });
  });

  it("refuses, as a transient failure, when the process no longer checks out", async () => {
    const { check, locate } = await setup(found());
    check.state.accept = false;
    const failure = await locate().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({
      kind: "transient",
      message: expect.stringContaining("토큰 보내지 않음"),
    });
  });

  it("refuses, as a transient failure, while the app is not there", async () => {
    const { locate } = await setup(missing);
    await expect(locate()).rejects.toMatchObject({
      kind: "transient",
      message: "OOP 앱 꺼짐 — 켜면 자동 재연결",
    });
  });

  it("refuses a different server on the same loopback", async () => {
    const { locate } = await setup(
      found({ environmentId: "env-2", origin: "http://127.0.0.1:41000" }),
    );
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
  });

  it("gives reasons the reconnecting banner shows whole on 80 columns, with the countdown", async () => {
    const style = makeStyle(false);
    const unverified = await setup();
    unverified.check.state.accept = false;
    const other = await setup(found({ environmentId: "env-2", origin: "http://127.0.0.1:41000" }));
    const gone = await setup(missing);
    const reasons = [
      ...(await Promise.all(
        [unverified, other, gone].map(
          async ({ locate }) =>
            ((await locate().catch((cause: unknown) => cause)) as TransportError).message,
        ),
      )),
      ...(await ownServerReasons()),
    ];
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("곧 자동으로 띄웁니다"),
        expect.stringContaining("서버 시작 실패"),
        expect.stringContaining("서버 시작이 느림"),
        expect.stringContaining("켜면 자동 재연결"),
        expect.stringContaining("앱 업데이트 중"),
      ]),
    );
    for (const message of reasons) {
      const detail = { message };
      // The longest countdown and attempt count the banner can reach.
      const banner = linkNotice(
        { phase: "reconnecting", attempt: 100, retryAt: 10_000, detail: detail.message },
        0,
        style,
      );
      expect(banner).toContain(detail.message);
      expect(stringWidth(banner ?? "")).toBeLessThanOrEqual(79);
    }
  });

  it("refuses an announcement that moved off the loopback", async () => {
    const { locate } = await setup(found({ origin: "http://192.168.0.5:3773" }));
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("resolveServer, with no server running", () => {
  const resolveWith = (
    world: ReturnType<typeof startable>,
    extra: Partial<Parameters<typeof resolveServer>[0]> = {},
  ) =>
    resolveServer({
      server: null,
      probe: probeNothing,
      discover: world.discover,
      inspect: inspection().inspect,
      ownServer: world.launcher,
      notify: quiet,
      sleep: noSleep,
      now: () => world.clock.now,
      ...extra,
    });

  it("starts the terminal's own server once, and not the app", async () => {
    const world = startable();
    let appStarts = 0;
    const notices: string[] = [];
    const result = located(
      await resolveWith(world, {
        startApp: async () => {
          appStarts += 1;
          return true;
        },
        notify: (text) => notices.push(text),
      }),
    );
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]).toContain("--daemon");
    expect(appStarts).toBe(0);
    expect(result).toMatchObject({ pid: 99, origin: "http://127.0.0.1:3774" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("앱 없이");
  });

  it("goes back to starting the app when the bundle from before the flag ends at once", async () => {
    const world = startable({ exit: 1 });
    let appStarts = 0;
    const result = located(
      await resolveWith(world, {
        startApp: async () => {
          appStarts += 1;
          world.state.current = found();
          return true;
        },
      }),
    );
    expect(world.spawned).toHaveLength(1);
    expect(appStarts).toBe(1);
    expect(result.pid).toBe(42);
  });

  it("looks for the server again when the lock is held, and starts neither a second server nor the app", async () => {
    const world = startable({ exit: LOCK_HELD_EXIT_CODE });
    // The holder of the lock is not announced yet when ours has ended, and is after a few more looks.
    let looks = 0;
    let appStarts = 0;
    const result = located(
      await resolveWith(world, {
        discover: async () => {
          looks += 1;
          return looks >= 4 ? found({ pid: 55 }) : missing;
        },
        startApp: async () => {
          appStarts += 1;
          return true;
        },
      }),
    );
    expect(world.spawned).toHaveLength(1);
    expect(appStarts).toBe(0);
    expect(result.pid).toBe(55);
  });

  it("waits for the holder of the lock as long as a server of ours may take, before the app is started", async () => {
    const world = startable({ exit: LOCK_HELD_EXIT_CODE });
    // Announced on the 40th look: later than the 30 seconds that start the app behind it used to be.
    let looks = 0;
    let appStarts = 0;
    const result = located(
      await resolveWith(world, {
        discover: async () => {
          looks += 1;
          return looks >= 40 ? found({ pid: 55 }) : missing;
        },
        startApp: async () => {
          appStarts += 1;
          return true;
        },
      }),
    );
    expect(result.pid).toBe(55);
    expect(appStarts).toBe(0);
    expect(world.spawned).toHaveLength(1);
  });

  it("starts the app only after that wait has run out", async () => {
    const world = startable({ exit: LOCK_HELD_EXIT_CODE });
    let looks = 0;
    let appStarts = 0;
    await resolveWith(world, {
      discover: async () => {
        looks += 1;
        return missing;
      },
      startApp: async () => {
        appStarts += 1;
        return false;
      },
    });
    expect(appStarts).toBe(1);
    // Two looks of the start itself, then the 45 seconds of looking, one a second.
    expect(looks).toBeGreaterThanOrEqual(45);
  });

  it("reports a server that never shows up, without starting the app behind it", async () => {
    const world = startable({});
    let appStarts = 0;
    const result = await resolveWith(world, {
      discover: async () => missing,
      startApp: async () => {
        appStarts += 1;
        return true;
      },
    });
    expect(result).toEqual({ error: expect.stringContaining("제때 시작되지 않았습니다") });
    expect(appStarts).toBe(0);
  });

  it("starts neither a server nor the app while the app installs an update", async () => {
    const world = startable();
    world.flags.updating = true;
    let appStarts = 0;
    const result = await resolveWith(world, {
      startApp: async () => {
        appStarts += 1;
        return true;
      },
    });
    expect(result).toEqual({ error: expect.stringContaining("업데이트를 설치하는 중") });
    expect(world.spawned).toHaveLength(0);
    expect(appStarts).toBe(0);
  });

  it("starts nothing while installing even with no program of its own, and says nothing first", async () => {
    const notices: string[] = [];
    let appStarts = 0;
    const result = await resolveServer({
      server: null,
      probe: async () => null,
      discover: async () => ({ kind: "missing", detail: "no server" }),
      updating: async () => true,
      startApp: async () => {
        appStarts += 1;
        return true;
      },
      notify: (text) => notices.push(text),
    });
    expect(result).toEqual({ error: expect.stringContaining("최대 15분") });
    expect(appStarts).toBe(0);
    expect(notices).toEqual([]);
  });

  it("starts nothing for an address given with --server", async () => {
    const world = startable();
    const result = await resolveWith(world, {
      server: "192.168.0.5:3773",
      probe: async () => ({ environmentId: "e", label: "l" }),
    });
    expect(world.spawned).toHaveLength(0);
    expect("error" in result).toBe(false);
  });

  it("starts nothing for a server that is running", async () => {
    const world = startable();
    world.state.current = found();
    located(await resolveWith(world));
    expect(world.spawned).toHaveLength(0);
  });

  it("starts nothing when not given the means (an isolated home, or no app on this computer)", async () => {
    const result = await resolveServer({
      server: null,
      probe: probeNothing,
      discover: scripted(missing),
      notify: quiet,
    });
    expect(result).toEqual({ error: missing.detail });
  });
});

describe("the address for each reconnection, with the terminal's own server available", () => {
  const connect = async (world: ReturnType<typeof startable>) => {
    world.state.current = found();
    const target = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: world.discover,
        inspect: inspection().inspect,
        ownServer: world.launcher,
        notify: quiet,
        sleep: noSleep,
        now: () => world.clock.now,
      }),
    );
    const locate = target.locateOrigin;
    if (locate === undefined) throw new Error("expected a way to find the address again");
    world.state.current = missing;
    return locate;
  };

  it("starts nothing during the grace after the server went away", async () => {
    const world = startable();
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("곧 자동으로 띄웁니다"),
    });
    world.clock.now += OWN_SERVER_GRACE_MS - 1;
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    expect(world.spawned).toHaveLength(0);
  });

  it("starts the server after the grace and connects to it on its own port", async () => {
    const world = startable();
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    expect(await locate()).toBe("http://127.0.0.1:3774");
    expect(world.spawned).toHaveLength(1);
  });

  it("starts one server for attempts that overlap", async () => {
    const world = startable();
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    const both = await Promise.all([locate(), locate()]);
    expect(both).toEqual(["http://127.0.0.1:3774", "http://127.0.0.1:3774"]);
    expect(world.spawned).toHaveLength(1);
  });

  it("counts the grace from the last time a server was there", async () => {
    const world = startable();
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += 3_000;
    // The app is back for a moment, then gone again.
    world.state.current = found();
    expect(await locate()).toBe("http://127.0.0.1:3773");
    world.state.current = missing;
    world.clock.now += 3_000;
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    expect(world.spawned).toHaveLength(0);
  });

  it("looks again when the lock is held, which is how several terminals settle on one server", async () => {
    const world = startable({ exit: LOCK_HELD_EXIT_CODE });
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    // The holder of the lock is announced by the time ours has ended.
    expect(await locate()).toBe("http://127.0.0.1:3774");
    expect(world.spawned).toHaveLength(1);
  });

  it("says it could not start the server, and tries again later instead of at once", async () => {
    const world = startable({ exit: 1 });
    const locate = await connect(world);
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    await expect(locate()).rejects.toMatchObject({
      message: expect.stringContaining("서버 시작 실패"),
    });
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    expect(world.spawned).toHaveLength(1);
    world.clock.now += 10_000;
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    expect(world.spawned).toHaveLength(2);
  });

  it("holds the start back while the app installs an update, and keeps looking", async () => {
    const world = startable();
    const locate = await connect(world);
    world.flags.updating = true;
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    await expect(locate()).rejects.toMatchObject({
      kind: "transient",
      message: expect.stringContaining("앱 업데이트 중"),
    });
    world.clock.now += 60_000;
    await expect(locate()).rejects.toMatchObject({ message: expect.stringContaining("업데이트") });
    expect(world.spawned).toHaveLength(0);
    // The updated app brings its server up: found without any start of ours.
    world.state.current = found({ pid: 77, origin: "http://127.0.0.1:3790" });
    expect(await locate()).toBe("http://127.0.0.1:3790");
    // The marker went stale (or the install failed): the terminal's own server may start again.
    world.state.current = missing;
    world.flags.updating = false;
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
    world.clock.now += OWN_SERVER_GRACE_MS;
    expect(await locate()).toBe("http://127.0.0.1:3774");
    expect(world.spawned).toHaveLength(1);
  });

  it("still refuses a different server that appears while the terminal waits", async () => {
    const world = startable();
    const locate = await connect(world);
    world.state.current = found({ environmentId: "env-2", origin: "http://127.0.0.1:41000" });
    await expect(locate()).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("the app taking over from the terminal's own server", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-handoff-"));
  });
  afterAll(() => NodeFSP.rm(directory, { recursive: true, force: true }));

  it("keeps the saved token when the same environment comes back on another port with another pid", async () => {
    const store = new CredentialStore(NodePath.join(directory, "credentials.json"));
    await store.save({
      environmentId: "env-1",
      label: "내 Mac",
      httpBaseUrl: "http://127.0.0.1:3773",
      token: "saved-token",
      savedAt: "2026-10-30T00:00:00.000Z",
    });
    const state: { current: DiscoveryResult } = { current: found({ pid: 10 }) };
    const target = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: async () => state.current,
        inspect: inspection().inspect,
        notify: quiet,
      }),
    );
    // The app starts: its server has another pid and, the daemon's port being taken, another port.
    state.current = found({ pid: 20, origin: "http://127.0.0.1:3775" });
    const origin = (await target.locateOrigin?.()) ?? "";
    expect(origin).toBe("http://127.0.0.1:3775");
    expect(
      await selectCredential(store, { origin, environmentId: "env-1", label: "내 Mac" }),
    ).toMatchObject({ credential: { token: "saved-token" } });
  });
});

describe("a reconnecting transport", () => {
  const requests: string[] = [];
  const listener = NodeHttp.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.statusCode = 500;
    response.end();
  });
  let origin = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(listener.address() as NodeNet.AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => listener.close(resolve)));

  const identity = { label: "oop test", os: "Linux", appVersion: "0.0.0" };

  it("sends nothing to the server when its process no longer checks out, and resumes when it does", async () => {
    const check = inspection();
    const target = located(
      await resolveServer({
        server: null,
        probe: probeNothing,
        discover: scripted(found({ origin })),
        inspect: check.inspect,
        notify: quiet,
      }),
    );
    const transport = makeEffectTransport({
      httpBaseUrl: target.origin,
      bearerToken: "secret",
      identity,
      locateOrigin: target.locateOrigin,
    });

    check.state.accept = false;
    await expect(transport.open()).rejects.toMatchObject({ kind: "transient" });
    expect(requests).toEqual([]);

    // The same transport does talk to the server once it checks out again.
    check.state.accept = true;
    await expect(transport.open()).rejects.toBeInstanceOf(Error);
    expect(requests.length).toBeGreaterThan(0);
  });
});
