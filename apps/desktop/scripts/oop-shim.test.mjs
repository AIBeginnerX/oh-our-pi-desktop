import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

const shimSource = NodeURL.fileURLToPath(new URL("../resources/oop-shim/oop.mjs", import.meta.url));

function stage(withFakeClient) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-shim-test-"));
  NodeFS.copyFileSync(shimSource, NodePath.join(dir, "oop.mjs"));
  if (withFakeClient) {
    NodeFS.writeFileSync(
      NodePath.join(dir, "oop-rs"),
      [
        "#!/bin/sh",
        'for a in "$@"; do echo "arg=[$a]"; done',
        'echo "in_desktop=$OOP_IN_DESKTOP_APP"',
        'echo "electron_run_as_node=${ELECTRON_RUN_AS_NODE-unset}"',
        "exit 7",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  return dir;
}

function runShim(dir, args) {
  return NodeChildProcess.spawnSync(process.execPath, [NodePath.join(dir, "oop.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

// The fake client is a /bin/sh script.
describe.skipIf(NodePath.sep === "\\")("oop.mjs compatibility shim", () => {
  it("runs the sibling oop-rs with args, the desktop env and its exit code", () => {
    const dir = stage(true);
    try {
      const result = runShim(dir, ["a", "b c"]);
      assert.equal(result.status, 7);
      assert.equal(result.stdout, "arg=[a]\narg=[b c]\nin_desktop=1\nelectron_run_as_node=unset\n");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards SIGTERM to oop-rs instead of orphaning it", async () => {
    const dir = stage(true);
    const marker = NodePath.join(dir, "got-term");
    // Overwrite the fake client: it announces itself, then waits for TERM, records it and dies of it.
    NodeFS.writeFileSync(
      NodePath.join(dir, "oop-rs"),
      [
        "#!/bin/sh",
        "sleep 3600 &",
        "pid=$!",
        "trap 'kill $pid; echo term > \"$1\"; trap - TERM; kill -TERM $$' TERM",
        "echo ready",
        "wait $pid",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const shim = NodeChildProcess.spawn(process.execPath, [NodePath.join(dir, "oop.mjs"), marker], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    try {
      const ready = new Promise((resolve) => {
        let out = "";
        shim.stdout.setEncoding("utf8");
        shim.stdout.on("data", (chunk) => {
          out += chunk;
          if (out.includes("ready")) resolve(undefined);
        });
      });
      const exited = new Promise((resolve) =>
        shim.on("exit", (code, signal) => resolve({ code, signal })),
      );
      await ready;
      shim.kill("SIGTERM");
      const { code, signal } = await exited;
      assert.equal(NodeFS.readFileSync(marker, "utf8"), "term\n");
      assert.isTrue(signal === "SIGTERM" || code === 128 + NodeOS.constants.signals.SIGTERM);
    } finally {
      shim.kill("SIGKILL");
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 127 with one clear line when oop-rs is missing", () => {
    const dir = stage(false);
    try {
      const result = runShim(dir, ["x"]);
      assert.equal(result.status, 127);
      assert.match(result.stderr, /^OOP\.app is too old or incomplete.*\n$/);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
