import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";
import { runDesktopSmoke, DESKTOP_SMOKE_READY_MARKER } from "./smoke-runner.mjs";

class FakeChild extends NodeEvents.EventEmitter {
  pid = 42;
  exitCode = null;
  signalCode = null;
  stdout = new NodeStream.PassThrough();
  stderr = new NodeStream.PassThrough();
  killCalls = [];

  kill(signal) {
    this.killCalls.push(signal);
    setImmediate(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }

  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const smokeOptions = (child, overrides = {}) => {
  const events = [];
  return {
    events,
    options: {
      env: {
        HOME: "/Users/keep-home",
        T3CODE_HOME: "/live/t3",
        T3CODE_DESKTOP_USER_DATA_DIR: "/live/profile",
        ELECTRON_RUN_AS_NODE: "1",
      },
      spawn: (command, args, spawnOptions) => {
        events.push("spawn");
        events.push({ command, args, spawnOptions });
        return child;
      },
      createTempDir: async () => "/tmp/unique-smoke-root",
      removeTempDir: async (directory) => {
        NodeAssert.equal(directory, "/tmp/unique-smoke-root");
        events.push("remove-temp");
      },
      startupTimeoutMs: 500,
      terminationGraceMs: 100,
      ...overrides,
    },
  };
};

NodeTest.test(
  "passes only after control-socket readiness, isolates both profiles, and waits for child cleanup",
  async () => {
    const child = new FakeChild();
    const { events, options } = smokeOptions(child);
    const resultPromise = runDesktopSmoke("electron-test-double", ["boot.cjs"], options);
    await new Promise((resolve) => setImmediate(resolve));
    const spawnEvent = events.find((event) => typeof event === "object");
    const spawnedEnv = spawnEvent.spawnOptions.env;

    NodeAssert.equal(spawnEvent.command, "electron-test-double");
    NodeAssert.deepEqual(spawnEvent.args, ["boot.cjs"]);
    NodeAssert.equal(spawnedEnv.HOME, "/Users/keep-home");
    NodeAssert.equal("ELECTRON_RUN_AS_NODE" in spawnedEnv, false);
    NodeAssert.equal(spawnedEnv.T3CODE_HOME, "/tmp/unique-smoke-root/t3-home");
    NodeAssert.equal(
      spawnedEnv.T3CODE_DESKTOP_USER_DATA_DIR,
      "/tmp/unique-smoke-root/electron-user-data",
    );
    NodeAssert.equal(spawnedEnv.T3CODE_DISABLE_AUTO_UPDATE, "true");

    child.stdout.write(`INFO ${DESKTOP_SMOKE_READY_MARKER}\n`);
    const result = await resultPromise;

    NodeAssert.equal(result.pid, 42);
    NodeAssert.match(result.output, /desktop app control socket ready/);
    NodeAssert.deepEqual(child.killCalls, ["SIGTERM"]);
    NodeAssert.equal(child.stdout.listenerCount("data"), 1, "only output capture remains attached");
    NodeAssert.equal(child.stderr.listenerCount("data"), 1, "only output capture remains attached");
    NodeAssert.ok(
      events.indexOf("remove-temp") > 0,
      "temporary profile cleanup ran after process teardown",
    );
  },
);

NodeTest.test(
  "rejects and cleans up when the child exits before readiness, including fast zero exits",
  async (t) => {
    for (const code of [1, 0]) {
      await t.test(`exit code ${code}`, async () => {
        const child = new FakeChild();
        const { events, options } = smokeOptions(child);
        const resultPromise = runDesktopSmoke("electron-test-double", [], options);
        await new Promise((resolve) => setImmediate(resolve));
        child.stderr.write("startup ended early\n");
        child.exit(code);

        await NodeAssert.rejects(resultPromise, /exited before readiness/);
        NodeAssert.deepEqual(child.killCalls, []);
        NodeAssert.ok(events.includes("remove-temp"));
      });
    }
  },
);

NodeTest.test("rejects fatal startup output and terminates the captured child", async () => {
  const child = new FakeChild();
  const { events, options } = smokeOptions(child);
  const resultPromise = runDesktopSmoke("electron-test-double", [], options);
  await new Promise((resolve) => setImmediate(resolve));
  child.stderr.write("Error: Cannot find module 'desktop-entry'\n");

  await NodeAssert.rejects(resultPromise, /fatal startup output: Cannot find module/);
  NodeAssert.deepEqual(child.killCalls, ["SIGTERM"]);
  NodeAssert.ok(events.includes("remove-temp"));
});

NodeTest.test(
  "rejects when readiness never arrives and waits for the spawned process to exit before cleanup",
  async () => {
    const child = new FakeChild();
    const { events, options } = smokeOptions(child, { startupTimeoutMs: 15 });

    await NodeAssert.rejects(
      runDesktopSmoke("electron-test-double", [], options),
      /timed out after 15ms waiting for desktop activation control socket readiness/,
    );
    NodeAssert.deepEqual(child.killCalls, ["SIGTERM"]);
    NodeAssert.equal(child.signalCode, "SIGTERM");
    NodeAssert.ok(events.indexOf("remove-temp") > 0);
  },
);

NodeTest.test("rejects asynchronous spawn errors and removes the isolated profile", async () => {
  const child = new FakeChild();
  child.pid = undefined;
  const { events, options } = smokeOptions(child, {
    spawn: () => {
      setImmediate(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
  });

  await NodeAssert.rejects(
    runDesktopSmoke("missing-electron", [], options),
    /Could not start Electron smoke process: ENOENT/,
  );
  NodeAssert.deepEqual(child.killCalls, []);
  NodeAssert.ok(events.includes("remove-temp"));
});

NodeTest.test(
  "on Windows ends the whole process tree of the spawned PID, then releases the output pipes",
  async () => {
    const child = new FakeChild();
    const killedTrees = [];
    const { events, options } = smokeOptions(child, {
      platform: "win32",
      killTree: (pid) => {
        killedTrees.push(pid);
        setImmediate(() => child.exit(null, "SIGTERM"));
      },
    });
    const resultPromise = runDesktopSmoke("electron-test-double", [], options);
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`INFO ${DESKTOP_SMOKE_READY_MARKER}\n`);
    await resultPromise;

    NodeAssert.deepEqual(killedTrees, [42]);
    NodeAssert.deepEqual(child.killCalls, [], "TerminateProcess alone would leave the backend");
    NodeAssert.equal(
      child.stdout.destroyed,
      true,
      "an orphan holding the pipe cannot hang the caller",
    );
    NodeAssert.equal(child.stderr.destroyed, true);
    NodeAssert.ok(events.includes("remove-temp"));
  },
);
