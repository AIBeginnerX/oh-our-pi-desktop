// @effect-diagnostics nodeBuiltinImport:off - The lock is a real file held by a real sqlite handle.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import { probeInstanceLock, tryAcquireInstanceLock } from "./instanceLock.ts";

const tempDirs: Array<string> = [];
const lockPathInNewDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-lock-"));
  tempDirs.push(dir);
  return NodePath.join(dir, "server.lock");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("instance lock", () => {
  it("excludes a second holder until the first releases", () => {
    const lockPath = lockPathInNewDir();

    const first = tryAcquireInstanceLock(lockPath);
    assert.equal(first._tag, "Acquired");
    assert.deepEqual(tryAcquireInstanceLock(lockPath), { _tag: "Held" });
    assert.equal(probeInstanceLock(lockPath), "held");

    if (first._tag === "Acquired") first.release();
    // Releasing twice is harmless.
    if (first._tag === "Acquired") first.release();

    assert.equal(probeInstanceLock(lockPath), "free");
    const again = tryAcquireInstanceLock(lockPath);
    assert.equal(again._tag, "Acquired");
    if (again._tag === "Acquired") again.release();
  });

  it("probing a free lock leaves it free, and a missing file means nobody ever held it", () => {
    const lockPath = lockPathInNewDir();

    assert.equal(probeInstanceLock(lockPath), "free");
    assert.isFalse(NodeFS.existsSync(lockPath), "probing must not create the lock file");

    NodeFS.writeFileSync(lockPath, "");
    assert.equal(probeInstanceLock(lockPath), "free");
    const holder = tryAcquireInstanceLock(lockPath);
    assert.equal(holder._tag, "Acquired");
    if (holder._tag === "Acquired") holder.release();
  });

  it("reports an unusable path as an error instead of pretending the lock is held", () => {
    const missingDir = NodePath.join(lockPathInNewDir(), "nested", "server.lock");

    assert.throws(() => tryAcquireInstanceLock(missingDir));
  });

  // Root can write a 0444 file, so the lock works there and the case does not exist.
  // No getuid (Windows) skips too: file modes mean nothing there.
  it.skipIf((process.getuid?.() ?? 0) === 0)(
    "refuses a read-only lock file instead of letting several processes acquire it",
    () => {
      const lockPath = lockPathInNewDir();
      NodeFS.writeFileSync(lockPath, "");
      NodeFS.chmodSync(lockPath, 0o444);

      assert.throws(() => tryAcquireInstanceLock(lockPath), /not writable/);
      // The pre-start probe must not read this as "free" either.
      assert.throws(() => probeInstanceLock(lockPath), /not writable/);
    },
  );
});
