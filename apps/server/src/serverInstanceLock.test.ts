// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Spawns real processes: OS-level locks cannot be faked in-process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { INSTANCE_LOCK_FILE_NAME, probeInstanceLock } from "@t3tools/shared/instanceLock";
import { afterEach, assert, describe, it } from "@effect/vitest";

const CHILD = NodePath.join(import.meta.dirname, "testUtils", "instanceLockChild.ts");
const WAIT_MS = 30_000;

interface Child {
  readonly process: NodeChildProcess.ChildProcess;
  readonly stdout: () => string;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const spawned: Array<NodeChildProcess.ChildProcess> = [];
const tempDirs: Array<string> = [];

const makeBaseDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-instance-lock-"));
  tempDirs.push(dir);
  return dir;
};

const spawnChild = (baseDir: string, mode: "lock" | "nolock"): Child => {
  const child = NodeChildProcess.spawn(process.execPath, [CHILD, baseDir, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return { process: child, stdout: () => stdout, exit };
};

// Resolves when the child printed "ready", or with its exit if it ended first.
const settle = (child: Child) =>
  new Promise<"ready" | { code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const poll = setInterval(() => {
      if (/^ready$/mu.test(child.stdout())) {
        clearInterval(poll);
        resolve("ready");
      }
    }, 20);
    void child.exit.then((exit) => {
      clearInterval(poll);
      resolve(exit);
    });
  });

afterEach(() => {
  for (const child of spawned.splice(0)) {
    // Only children this test spawned and holds the handle of.
    child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("server instance lock", () => {
  it(
    "makes a second server on the same data directory exit with code 75",
    async () => {
      const baseDir = makeBaseDir();
      const first = spawnChild(baseDir, "lock");
      assert.equal(await settle(first), "ready");

      const second = spawnChild(baseDir, "lock");
      const outcome = await settle(second);

      assert.deepEqual(outcome, { code: 75, signal: null });
      // Effect's default logger writes the failure to stdout.
      assert.include(second.stdout(), "already runs on this data directory");
      assert.isNull(first.process.exitCode, "the first server must keep running");
      assert.equal(
        probeInstanceLock(NodePath.join(baseDir, "userdata", INSTANCE_LOCK_FILE_NAME)),
        "held",
      );
    },
    WAIT_MS,
  );

  it(
    "lets a third server take the lock once the first is killed with SIGKILL",
    async () => {
      const baseDir = makeBaseDir();
      const first = spawnChild(baseDir, "lock");
      assert.equal(await settle(first), "ready");
      assert.deepEqual(await settle(spawnChild(baseDir, "lock")), { code: 75, signal: null });

      first.process.kill("SIGKILL");
      await first.exit;

      const third = spawnChild(baseDir, "lock");
      assert.equal(await settle(third), "ready");
    },
    WAIT_MS,
  );

  it(
    "takes no lock without the flag, so two servers can share a directory as before",
    async () => {
      const baseDir = makeBaseDir();
      const first = spawnChild(baseDir, "nolock");
      const second = spawnChild(baseDir, "nolock");

      assert.equal(await settle(first), "ready");
      assert.equal(await settle(second), "ready");
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(baseDir, "userdata", INSTANCE_LOCK_FILE_NAME)),
      );
    },
    WAIT_MS,
  );

  it(
    "clears a runtime file left by a dead server once it holds the lock",
    async () => {
      const baseDir = makeBaseDir();
      const stateDir = NodePath.join(baseDir, "userdata");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      const runtimePath = NodePath.join(stateDir, "server-runtime.json");
      NodeFS.writeFileSync(runtimePath, "{}\n");

      assert.equal(await settle(spawnChild(baseDir, "lock")), "ready");

      assert.isFalse(NodeFS.existsSync(runtimePath));
    },
    WAIT_MS,
  );

  // Root can write a 0444 file, so the lock works there and the case does not exist.
  // No getuid (Windows) skips too: file modes mean nothing there.
  it.skipIf((process.getuid?.() ?? 0) === 0)(
    "fails closed on a read-only lock file instead of starting a second server",
    async () => {
      const baseDir = makeBaseDir();
      const stateDir = NodePath.join(baseDir, "userdata");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      const lockPath = NodePath.join(stateDir, INSTANCE_LOCK_FILE_NAME);
      NodeFS.writeFileSync(lockPath, "");
      NodeFS.chmodSync(lockPath, 0o444);

      const first = spawnChild(baseDir, "lock");
      const second = spawnChild(baseDir, "lock");

      // Exit 1 (unavailable), not 0 and not "ready": neither server may run.
      assert.deepEqual(await settle(first), { code: 1, signal: null });
      assert.deepEqual(await settle(second), { code: 1, signal: null });
      assert.include(first.stdout(), "Could not take the single-instance lock");
    },
    WAIT_MS,
  );
});
