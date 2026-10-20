import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { assertReleaseBinding, distributionXml, welcomeHtml } from "./build-oop-update-pkg.mjs";
import { RELEASE_PACKAGE_ID } from "../apps/desktop/src/updates/LocalPkgReleaseBinding.ts";

// A payload-free package tests productbuild's actual Distribution archive handling without an app or Installer.
NodeTest.test(
  "native productbuild preserves the release binding checked by tar",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This native integration test runs only where macOS packaging tools exist.
  { skip: NodeOS.platform() !== "darwin" && "macOS packaging tools required" },
  async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "oop-release-binding-native-"),
    );
    const version = "0.0.59";
    const runBounded = async (
      command,
      args,
      timeout = 30_000,
      { rejectStderr = false, cwd } = {},
    ) => {
      const result = NodeChildProcess.spawnSync(command, args, {
        encoding: "utf8",
        timeout: Math.min(timeout, 30_000),
        maxBuffer: 64 * 1024,
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        cwd,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${NodePath.basename(command)} failed (${result.status ?? result.signal}): ${result.stderr}`,
        );
      if (rejectStderr && result.stderr !== "")
        throw new Error(`${NodePath.basename(command)} wrote to stderr.`);
      return result.stdout;
    };
    try {
      const resources = NodePath.join(root, "Resources");
      const component = NodePath.join(root, "component.pkg");
      const product = NodePath.join(root, "product.pkg");
      const distribution = NodePath.join(root, "Distribution.xml");
      await NodeFSP.mkdir(resources);
      await NodeFSP.writeFile(NodePath.join(resources, "welcome.html"), welcomeHtml());
      await NodeFSP.writeFile(distribution, distributionXml(version));
      await runBounded("/usr/bin/pkgbuild", [
        "--nopayload",
        "--identifier",
        RELEASE_PACKAGE_ID,
        "--version",
        version,
        component,
      ]);
      await runBounded("/usr/bin/productbuild", [
        "--distribution",
        distribution,
        "--package-path",
        root,
        "--resources",
        resources,
        product,
      ]);
      await assertReleaseBinding(product, version, runBounded);
      await NodeAssert.rejects(assertReleaseBinding(product, "0.0.60", runBounded));

      // A forged .59 release in a .57 archive must fail even when tar accepts its SHA-256/512 payload.
      const oldVersion = "0.0.57";
      const oldProduct = `<product id="oop-desktop" version="${oldVersion}"/>`;
      const forgedProduct = `<product id="oop-desktop" version="${version}"/>`;
      NodeAssert.equal(Buffer.byteLength(oldProduct), Buffer.byteLength(forgedProduct));
      await NodeFSP.writeFile(NodePath.join(root, "Distribution"), distributionXml(oldVersion));
      for (const algorithm of ["sha1", "sha256", "sha512"]) {
        const original = NodePath.join(root, `original-${algorithm}.xar`);
        const tampered = NodePath.join(root, `tampered-${algorithm}.xar`);
        await runBounded(
          "/usr/bin/xar",
          ["-c", "-f", original, "--compression=none", `--file-cksum=${algorithm}`, "Distribution"],
          30_000,
          { cwd: root },
        );
        const bytes = await NodeFSP.readFile(original);
        const offset = bytes.indexOf(oldProduct);
        NodeAssert.ok(
          offset >= 0,
          `${algorithm}: uncompressed Distribution was not found in the xar heap`,
        );
        NodeAssert.equal(
          bytes.indexOf(oldProduct, offset + 1),
          -1,
          `${algorithm}: Distribution appeared more than once`,
        );
        bytes.write(forgedProduct, offset, "utf8");
        await NodeFSP.writeFile(tampered, bytes);
        const before = (await NodeFSP.readdir(root)).sort();
        await NodeAssert.rejects(
          assertReleaseBinding(tampered, version, runBounded),
          `${algorithm}: forged version accepted`,
        );
        NodeAssert.deepEqual(
          (await NodeFSP.readdir(root)).sort(),
          before,
          `${algorithm}: binding check wrote to disk`,
        );
        if (algorithm !== "sha1") {
          const tarRead = await runBounded("/usr/bin/tar", [
            "-x",
            "-O",
            "-f",
            tampered,
            "--",
            "Distribution",
          ]);
          NodeAssert.ok(
            tarRead.includes(forgedProduct),
            `${algorithm}: tar did not expose the forged version`,
          );
        }
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
