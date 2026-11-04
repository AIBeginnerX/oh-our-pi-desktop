// @effect-diagnostics nodeBuiltinImport:off - Runs the terminal bundle script with stub tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const bundleScript = NodePath.join(repoRoot, "apps/oop-terminal/scripts/bundle-macos.sh");

// oxlint-disable-next-line t3code/no-global-process-runtime -- Plain vitest skip, no Effect runtime.
describe.skipIf(process.platform === "win32")("OOP Terminal.app version stamp", () => {
  // bundle-macos.sh needs cargo, an icon tool and codesign; stubs stand in for them, so the run
  // checks only what ends up in Info.plist.
  const stampedVersions = async (env: Record<string, string>) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-terminal-bundle-"));
    try {
      const crate = NodePath.join(root, "apps", "oop-terminal");
      await NodeFSP.mkdir(NodePath.join(crate, "scripts"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(crate, "target", "release"), { recursive: true });
      await NodeFSP.copyFile(bundleScript, NodePath.join(crate, "scripts", "bundle-macos.sh"));
      await NodeFSP.writeFile(NodePath.join(crate, "Cargo.toml"), '[package]\nversion = "0.1.0"\n');
      await NodeFSP.writeFile(NodePath.join(crate, "target", "release", "oop-terminal"), "binary");
      const bin = NodePath.join(root, "bin");
      await NodeFSP.mkdir(bin);
      for (const tool of ["cargo", "codesign", "sips", "iconutil"]) {
        await NodeFSP.writeFile(NodePath.join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      const result = NodeChildProcess.spawnSync(
        "bash",
        [NodePath.join(crate, "scripts", "bundle-macos.sh")],
        {
          encoding: "utf8",
          env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
        },
      );
      const plistPath = NodePath.join(
        crate,
        "target",
        "release",
        "OOP Terminal.app",
        "Contents",
        "Info.plist",
      );
      if (result.status !== 0) return { status: result.status, stderr: result.stderr };
      const plist = await NodeFSP.readFile(plistPath, "utf8");
      const read = (key: string) =>
        new RegExp(`<key>${key}</key><string>([^<]*)</string>`, "u").exec(plist)?.[1];
      return {
        status: 0,
        short: read("CFBundleShortVersionString"),
        build: read("CFBundleVersion"),
      };
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  };

  it("carries the release version OOP_VERSION names", async () => {
    expect(await stampedVersions({ OOP_VERSION: "0.0.137" })).toEqual({
      status: 0,
      short: "0.0.137",
      build: "0.0.137",
    });
  });

  it("falls back to the crate version for a local build, and refuses a malformed version", async () => {
    expect(await stampedVersions({})).toMatchObject({ status: 0, short: "0.1.0" });
    expect(await stampedVersions({ OOP_VERSION: "1.0</string>" })).toMatchObject({ status: 1 });
  });
});
