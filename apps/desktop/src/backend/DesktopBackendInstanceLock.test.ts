// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - The live-ports test holds a real lock from a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as DesktopBackendInstanceLock from "./DesktopBackendInstanceLock.ts";

interface FakeWorld {
  // Ticks (fake 100 ms sleeps) until the lock frees after a signal; undefined = never.
  releaseAfterTicks: { SIGTERM?: number; SIGKILL?: number };
  held: boolean;
  owner: Option.Option<DesktopBackendInstanceLock.RuntimeOwner>;
  alive: boolean;
  probeResult?: "unsupported";
  probeThrows?: boolean;
}

const makeWorld = (overrides: Partial<FakeWorld> = {}) => {
  const world: FakeWorld = {
    releaseAfterTicks: { SIGTERM: 3 },
    held: true,
    owner: Option.some({ pid: 4242, serviceManaged: false }),
    alive: true,
    ...overrides,
  };
  const signals: Array<readonly [number, string]> = [];
  let ticksUntilRelease: number | undefined;
  let ticks = 0;
  const ports: DesktopBackendInstanceLock.InstanceLockGuardPorts = {
    probe: () => {
      if (world.probeThrows) throw new Error("unreadable lock file");
      if (world.probeResult) return world.probeResult;
      return world.held ? "held" : "free";
    },
    readOwner: () => Effect.succeed(world.owner),
    isAlive: () => world.alive,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const after = world.releaseAfterTicks[signal];
      if (after !== undefined) ticksUntilRelease = after;
    },
    sleep: () =>
      Effect.sync(() => {
        ticks += 1;
        if (ticksUntilRelease !== undefined && --ticksUntilRelease <= 0) {
          world.held = false;
          world.alive = false;
        }
      }),
  };
  return { world, ports, signals, ticks: () => ticks };
};

const run = (ports: DesktopBackendInstanceLock.InstanceLockGuardPorts) =>
  DesktopBackendInstanceLock.ensureInstanceLockFree(
    { stateDir: "/state", joinPath: (...parts) => parts.join("/") },
    ports,
  );

describe("windowsTaskkillPath", () => {
  it("points at System32 under the system root", () => {
    assert.equal(
      DesktopBackendInstanceLock.windowsTaskkillPath("D:\\Win"),
      "D:\\Win\\System32\\taskkill.exe",
    );
  });

  it("falls back to C:\\Windows when the system root is unset or empty", () => {
    const expected = "C:\\Windows\\System32\\taskkill.exe";
    assert.equal(DesktopBackendInstanceLock.windowsTaskkillPath(undefined), expected);
    assert.equal(DesktopBackendInstanceLock.windowsTaskkillPath(""), expected);
  });
});

describe("ensureInstanceLockFree", () => {
  it.effect("does nothing when no server holds the lock", () =>
    Effect.gen(function* () {
      const { ports, signals } = makeWorld({ held: false });

      assert.equal(yield* run(ports), "free");
      assert.deepEqual(signals, []);
    }),
  );

  it.effect("stops the lock holder named in the runtime file and waits for the lock", () =>
    Effect.gen(function* () {
      const { ports, signals, world } = makeWorld();

      assert.equal(yield* run(ports), "stopped");
      assert.deepEqual(signals, [[4242, "SIGTERM"]]);
      assert.isFalse(world.held);
    }),
  );

  it.effect("kills a holder that ignores SIGTERM after the 5 second grace", () =>
    Effect.gen(function* () {
      const { ports, signals, ticks } = makeWorld({
        releaseAfterTicks: { SIGKILL: 2 },
      });

      assert.equal(yield* run(ports), "killed");
      assert.deepEqual(signals, [
        [4242, "SIGTERM"],
        [4242, "SIGKILL"],
      ]);
      // 5 s of SIGTERM grace plus the wait after SIGKILL, in 100 ms ticks.
      assert.isAtLeast(ticks(), 50);
    }),
  );

  it.effect("reports still-held, without throwing, when even SIGKILL does not free the lock", () =>
    Effect.gen(function* () {
      const { ports } = makeWorld({ releaseAfterTicks: {} });

      assert.equal(yield* run(ports), "still-held");
    }),
  );

  it.effect("never signals a service-managed server", () =>
    Effect.gen(function* () {
      const { ports, signals } = makeWorld({
        owner: Option.some({ pid: 4242, serviceManaged: true }),
      });

      assert.equal(yield* run(ports), "service-managed");
      assert.deepEqual(signals, []);
    }),
  );

  it.effect("never signals when the runtime file is missing or names a dead pid", () =>
    Effect.gen(function* () {
      const noFile = makeWorld({ owner: Option.none(), releaseAfterTicks: {} });
      assert.equal(yield* run(noFile.ports), "still-held");
      assert.deepEqual(noFile.signals, []);

      const deadPid = makeWorld({ alive: false, releaseAfterTicks: {} });
      assert.equal(yield* run(deadPid.ports), "still-held");
      assert.deepEqual(deadPid.signals, []);
    }),
  );

  it.effect("waits for a holder that is already shutting down to let go", () =>
    Effect.gen(function* () {
      const { ports, signals, world } = makeWorld({ owner: Option.none() });
      // The old server finishes on its own after 4 ticks; nobody signals it.
      let ticks = 0;
      const sleep = ports.sleep;
      const waiting = {
        ...ports,
        sleep: (millis: number) =>
          sleep(millis).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (++ticks >= 4) world.held = false;
              }),
            ),
          ),
      };

      assert.equal(yield* run(waiting), "stopped");
      assert.deepEqual(signals, []);
    }),
  );

  it.effect("leaves the decision to the server when the lock cannot be probed", () =>
    Effect.gen(function* () {
      const unsupported = makeWorld({ probeResult: "unsupported" });
      assert.equal(yield* run(unsupported.ports), "unsupported");

      const unreadable = makeWorld({ probeThrows: true });
      assert.equal(yield* run(unreadable.ports), "unsupported");
      assert.deepEqual([...unsupported.signals, ...unreadable.signals], []);
    }),
  );

  it.effect("survives a holder that exited between the probe and the signal", () =>
    Effect.gen(function* () {
      const { ports, world } = makeWorld();
      const throwing = {
        ...ports,
        signal: () => {
          world.held = false;
          throw new Error("ESRCH");
        },
      };

      assert.equal(yield* run(throwing), "stopped");
    }),
  );
});

describe("ensureInstanceLockFree with the real lock", () => {
  it.live("stops a real process holding server.lock and then the lock is free", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-guard-"));
      const lockModule = NodePath.join(
        import.meta.dirname,
        "../../../../packages/shared/src/instanceLock.ts",
      );
      // The child plays a daemon: takes the lock, then publishes its pid.
      const script = `
        import { tryAcquireInstanceLock } from ${JSON.stringify(lockModule)};
        import { writeFileSync } from "node:fs";
        const attempt = tryAcquireInstanceLock(${JSON.stringify(NodePath.join(stateDir, "server.lock"))});
        if (attempt._tag !== "Acquired") process.exit(3);
        // The lock lives as long as the handle is reachable.
        globalThis.heldLock = attempt;
        writeFileSync(${JSON.stringify(NodePath.join(stateDir, "server-runtime.json"))}, JSON.stringify({ pid: process.pid }));
        console.log("ready");
        setInterval(() => {}, 1000);
      `;
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGKILL")));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve());
            child.once("exit", (code) => reject(new Error(`child exited early: ${code}`)));
          }),
      );
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("exit", (_code, signal) => resolve(signal)),
      );

      const outcome = yield* DesktopBackendInstanceLock.ensureInstanceLockFree(
        { stateDir, joinPath: NodePath.join },
        DesktopBackendInstanceLock.makeLivePorts(fileSystem),
      );

      assert.equal(outcome, "stopped");
      assert.equal(yield* Effect.promise(() => exited), "SIGTERM");
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Root can write a 0444 file, so the lock works there and the case does not exist.
  // No getuid (Windows) skips too: file modes mean nothing there.
  it.live.skipIf((process.getuid?.() ?? 0) === 0)(
    "does not read a read-only lock file as free",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-guard-ro-"));
        const lockPath = NodePath.join(stateDir, "server.lock");
        NodeFS.writeFileSync(lockPath, "");
        NodeFS.chmodSync(lockPath, 0o444);

        const outcome = yield* DesktopBackendInstanceLock.ensureInstanceLockFree(
          { stateDir, joinPath: NodePath.join },
          DesktopBackendInstanceLock.makeLivePorts(fileSystem),
        );

        // "unsupported" hands the decision to the server, which fails closed on this file.
        assert.equal(outcome, "unsupported");
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
