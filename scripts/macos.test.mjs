import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  assertSeparatePaths,
  build,
  defaultCacheRoot,
  isolatedEnvironment,
  main,
  mountFilesystemType,
  packageDmg,
  packagingEnvironment,
  parseArgs,
  resolvePackageSigning,
  resolvePaths,
  RSYNC_EXCLUDES,
  runCommand,
  releaseVersion,
  upstreamVersion,
  runtimePaths,
  smbShareUrlForPath,
  syncSource,
  validateHost,
  verifyMacDmgArtifact,
} from "./macos.mjs";

NodeTest.test("parses only known commands and one cache override", () => {
  NodeAssert.deepEqual(parseArgs(["package", "--cache-dir", "/tmp/Build Cache 한글"]), {
    command: "package",
    cacheDir: "/tmp/Build Cache 한글",
  });
  NodeAssert.deepEqual(parseArgs(["doctor", "--", "--cache-dir", "/tmp/Build Cache 한글"]), {
    command: "doctor",
    cacheDir: "/tmp/Build Cache 한글",
  });
  NodeAssert.throws(() => parseArgs(["package", "--cache-dir"]), /incomplete option/);
  NodeAssert.throws(() => parseArgs(["package", "--arch", "x64"]), /Unknown/);
  NodeAssert.throws(() => parseArgs(["install"]), /Usage/);
});

NodeTest.test(
  "package takes at most one explicit developer-id selector and no other command does",
  () => {
    NodeAssert.deepEqual(parseArgs(["package"]), { command: "package", cacheDir: undefined });
    const selected = { command: "package", cacheDir: "/tmp/cache", signingMode: "developer-id" };
    NodeAssert.deepEqual(
      parseArgs(["package", "--signing-mode", "developer-id", "--cache-dir", "/tmp/cache"]),
      selected,
    );
    NodeAssert.deepEqual(
      parseArgs(["package", "--", "--cache-dir", "/tmp/cache", "--signing-mode", "developer-id"]),
      selected,
    );

    for (const argv of [
      ["package", "--signing-mode"],
      ["package", "--signing-mode", "--cache-dir", "/tmp/cache"],
      ["package", "--signing-mode", "developer-id", "--signing-mode", "developer-id"],
      ["package", "--cache-dir", "/tmp/a", "--cache-dir", "/tmp/b"],
      ...["doctor", "setup", "build", "start"].map((command) => [
        command,
        "--signing-mode",
        "developer-id",
      ]),
    ]) {
      NodeAssert.throws(() => parseArgs(argv), /Unknown or incomplete option/, argv.join(" "));
    }
    // Only the new mode is selectable: ad hoc is the default and the legacy passkey mode is not a wrapper choice.
    for (const mode of ["adhoc", "developer-id-passkey", "Developer-ID", "true"]) {
      NodeAssert.throws(
        () => parseArgs(["package", "--signing-mode", mode]),
        /Unknown signing mode/,
      );
    }
  },
);

const SIGNING_IDENTITY = "Developer ID Application: Example Holder (ABCDE12345)";
const INSTALLER_PIN = "a".repeat(64); // Synthetic test fingerprint, never a real certificate pin.
const SIGNING_ENV = {
  CSC_NAME: SIGNING_IDENTITY,
  T3CODE_APPLE_TEAM_ID: "ABCDE12345",
  T3CODE_MACOS_INSTALLER_LEAF_SHA256: INSTALLER_PIN,
};

NodeTest.test(
  "developer-id inputs are validated only after an explicit request, never inferred from credentials",
  () => {
    // Credentials and passkey inputs in the environment do not select anything.
    NodeAssert.equal(resolvePackageSigning(undefined, SIGNING_ENV), undefined);
    NodeAssert.equal(
      resolvePackageSigning(undefined, {
        T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/a.provisionprofile",
      }),
      undefined,
    );
    NodeAssert.equal(resolvePackageSigning(undefined, {}), undefined);

    NodeAssert.deepEqual(resolvePackageSigning("developer-id", SIGNING_ENV), {
      mode: "developer-id",
      identity: SIGNING_IDENTITY,
      teamId: "ABCDE12345",
      installerLeafPins: INSTALLER_PIN,
    });
    NodeAssert.deepEqual(
      resolvePackageSigning("developer-id", {
        CSC_NAME: ` ${SIGNING_IDENTITY} `,
        T3CODE_APPLE_TEAM_ID: " abcde12345 ",
        T3CODE_MACOS_INSTALLER_LEAF_SHA256: INSTALLER_PIN,
      }),
      {
        mode: "developer-id",
        identity: SIGNING_IDENTITY,
        teamId: "ABCDE12345",
        installerLeafPins: INSTALLER_PIN,
      },
    );

    for (const [env, message] of [
      [{}, /requires CSC_NAME and T3CODE_APPLE_TEAM_ID/],
      [{ CSC_NAME: SIGNING_IDENTITY }, /requires CSC_NAME and T3CODE_APPLE_TEAM_ID/],
      [{ T3CODE_APPLE_TEAM_ID: "ABCDE12345" }, /requires CSC_NAME and T3CODE_APPLE_TEAM_ID/],
      [{ ...SIGNING_ENV, CSC_NAME: "   " }, /requires CSC_NAME and T3CODE_APPLE_TEAM_ID/],
      [{ ...SIGNING_ENV, T3CODE_APPLE_TEAM_ID: "SHORT" }, /10-character/],
      [{ ...SIGNING_ENV, T3CODE_APPLE_TEAM_ID: "ZZZZZ99999" }, /does not match/],
      [
        { ...SIGNING_ENV, CSC_NAME: "Example Holder (ABCDE12345)" },
        /exact "Developer ID Application/,
      ],
      [
        { ...SIGNING_ENV, CSC_NAME: "Developer ID Installer: Example Holder (ABCDE12345)" },
        /exact "Developer ID Application/,
      ],
      [
        { ...SIGNING_ENV, CSC_NAME: "Developer ID Application: Example Holder" },
        /exact "Developer ID Application/,
      ],
      [
        { ...SIGNING_ENV, T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/a.provisionprofile" },
        /passkey signing/,
      ],
      [{ ...SIGNING_ENV, T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com" }, /passkey signing/],
      [
        { ...SIGNING_ENV, T3CODE_MACOS_INSTALLER_LEAF_SHA256: "" },
        /T3CODE_MACOS_INSTALLER_LEAF_SHA256/,
      ],
      [
        { ...SIGNING_ENV, T3CODE_MACOS_INSTALLER_LEAF_SHA256: "B".repeat(64) },
        /T3CODE_MACOS_INSTALLER_LEAF_SHA256/,
      ],
      [
        { ...SIGNING_ENV, T3CODE_MACOS_INSTALLER_LEAF_SHA256: "a".repeat(63) },
        /T3CODE_MACOS_INSTALLER_LEAF_SHA256/,
      ],
      [
        { ...SIGNING_ENV, T3CODE_MACOS_INSTALLER_LEAF_SHA256: `${INSTALLER_PIN},${INSTALLER_PIN}` },
        /T3CODE_MACOS_INSTALLER_LEAF_SHA256/,
      ],
      [
        {
          ...SIGNING_ENV,
          T3CODE_MACOS_INSTALLER_LEAF_SHA256: ["a", "b", "c", "d"]
            .map((value) => value.repeat(64))
            .join(","),
        },
        /T3CODE_MACOS_INSTALLER_LEAF_SHA256/,
      ],
    ]) {
      NodeAssert.throws(
        () => resolvePackageSigning("developer-id", env),
        (error) => message.test(error.message) && !/ABCDE12345|Example Holder/u.test(error.message),
        JSON.stringify(env),
      );
    }
    // The general Clerk key also drives ordinary auth, so it is not a passkey input.
    NodeAssert.ok(
      resolvePackageSigning("developer-id", {
        ...SIGNING_ENV,
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      }),
    );
  },
);

NodeTest.test("invalid Installer pins stop the wrapper before any operation", async () => {
  const previous = {
    CSC_NAME: process.env.CSC_NAME,
    T3CODE_APPLE_TEAM_ID: process.env.T3CODE_APPLE_TEAM_ID,
    T3CODE_MACOS_INSTALLER_LEAF_SHA256: process.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256,
    T3CODE_DESKTOP_SKIP_BUILD: process.env.T3CODE_DESKTOP_SKIP_BUILD,
  };
  const calls = [];
  try {
    process.env.CSC_NAME = SIGNING_IDENTITY;
    process.env.T3CODE_APPLE_TEAM_ID = "ABCDE12345";
    delete process.env.T3CODE_DESKTOP_SKIP_BUILD;
    for (const pins of [undefined, "", "A".repeat(64), `${INSTALLER_PIN},${INSTALLER_PIN}`]) {
      if (pins === undefined) delete process.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256;
      else process.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256 = pins;
      await NodeAssert.rejects(
        main(
          ["package", "--signing-mode", "developer-id"],
          "/definitely-absent-oop-source",
          async (...args) => {
            calls.push(args);
          },
        ),
        (error) =>
          error.message.includes("T3CODE_MACOS_INSTALLER_LEAF_SHA256") &&
          !error.message.includes(INSTALLER_PIN),
      );
      NodeAssert.deepEqual(calls, []);
    }
    process.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256 = INSTALLER_PIN;
    process.env.T3CODE_DESKTOP_SKIP_BUILD = "true";
    await NodeAssert.rejects(
      main(
        ["package", "--signing-mode", "developer-id"],
        "/definitely-absent-oop-source",
        async (...args) => {
          calls.push(args);
        },
      ),
      (error) => /skip.build/i.test(error.message) && !error.message.includes(INSTALLER_PIN),
    );
    NodeAssert.deepEqual(calls, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

NodeTest.test("a build stops on missing release notes before it syncs or builds", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-notes-gate-"));
  const calls = [];
  try {
    await NodeFSP.writeFile(NodePath.join(root, "OOP_RELEASE.json"), '{ "version": "0.0.121" }\n');
    await NodeAssert.rejects(
      main(["build"], root, async (...args) => {
        calls.push(args);
      }),
      (error) =>
        /Add the OOP 0\.0\.121 user-facing highlights/u.test(error.message) &&
        /packages\/shared\/src\/releaseNotes\.json/u.test(error.message),
    );
    NodeAssert.deepEqual(calls, []);

    // The same version with highlights passes the gate and reaches the host checks.
    await NodeFSP.mkdir(NodePath.join(root, "packages", "shared", "src"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "packages", "shared", "src", "releaseNotes.json"),
      JSON.stringify({
        versions: [
          { version: "0.0.121", date: "2026-10-29", highlights: [{ en: "A.", ko: "가." }] },
        ],
      }),
    );
    await NodeAssert.rejects(
      main(["build"], root, async (...args) => {
        calls.push(args);
      }),
      (error) => !/releaseNotes\.json/u.test(error.message),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "cache path is deterministic and cannot enclose the source in either direction",
  async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-workflow-"));
    try {
      const source = NodePath.join(base, "OOP DeskTop 한글");
      const sibling = NodePath.join(base, "Local Cache");
      await NodeFSP.mkdir(source);
      const paths = await resolvePaths(source, sibling);
      NodeAssert.equal(paths.source, await NodeFSP.realpath(source));
      NodeAssert.equal(paths.cache, NodePath.join(await NodeFSP.realpath(base), "Local Cache"));
      NodeAssert.equal(defaultCacheRoot(source, base), defaultCacheRoot(source, base));
      NodeAssert.throws(() => assertSeparatePaths(source, source), /separate/);
      await NodeAssert.rejects(resolvePaths(source, NodePath.join(source, "cache")), /separate/);
      await NodeAssert.rejects(resolvePaths(source, base), /separate/);
      const link = NodePath.join(base, "source-link");
      await NodeFSP.symlink(source, link);
      await NodeAssert.rejects(resolvePaths(source, NodePath.join(link, "cache")), /separate/);
    } finally {
      await NodeFSP.rm(base, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "run environment isolates both desktop stores and removes update destinations",
  () => {
    const runtime = runtimePaths("/Volumes/Personal/OOP Desktop 한글", "/Users/test");
    const original = {
      HOME: "/Users/test",
      GITHUB_REPOSITORY: "pingdotgg/t3code",
      T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
      OOP_DESKTOP_UPDATE_DIRECTORY: "/untrusted/feed",
      OOP_DESKTOP_UPDATE_CANDIDATES: '["/untrusted/drive"]',
      OOP_DESKTOP_UPDATE_FOLDER_KIND: "google-drive",
      OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST: "untrusted-ambient-policy",
      T3CODE_MACOS_INSTALLER_LEAF_SHA256: INSTALLER_PIN,
      ELECTRON_RUN_AS_NODE: "1",
      T3CODE_HOME: "/Users/test/.t3",
    };
    const run = isolatedEnvironment(original, runtime);
    NodeAssert.equal(run.HOME, original.HOME);
    NodeAssert.equal(run.T3CODE_HOME, runtime.t3Home);
    NodeAssert.equal(run.T3CODE_DESKTOP_USER_DATA_DIR, runtime.userData);
    NodeAssert.equal(run.T3CODE_DISABLE_AUTO_UPDATE, "true");
    NodeAssert.equal(run.GITHUB_REPOSITORY, undefined);
    NodeAssert.equal(run.T3CODE_DESKTOP_UPDATE_REPOSITORY, undefined);
    NodeAssert.equal(run.OOP_DESKTOP_UPDATE_DIRECTORY, undefined);
    NodeAssert.equal(run.OOP_DESKTOP_UPDATE_CANDIDATES, undefined);
    NodeAssert.equal(run.OOP_DESKTOP_UPDATE_FOLDER_KIND, undefined);
    NodeAssert.equal(run.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, undefined);
    NodeAssert.equal(run.ELECTRON_RUN_AS_NODE, undefined);
    NodeAssert.equal(original.GITHUB_REPOSITORY, "pingdotgg/t3code");
    const packageEnv = packagingEnvironment({
      ...original,
      T3CODE_DESKTOP_VERSION: "999.0.0",
      T3CODE_DESKTOP_SIGNED: "true",
    });
    NodeAssert.equal(packageEnv.GITHUB_REPOSITORY, undefined);
    NodeAssert.equal(packageEnv.T3CODE_DESKTOP_UPDATE_REPOSITORY, undefined);
    NodeAssert.equal(packageEnv.T3CODE_DESKTOP_VERSION, undefined);
    NodeAssert.equal(packageEnv.T3CODE_DESKTOP_SIGNED, undefined);
    NodeAssert.equal(packageEnv.OOP_DESKTOP_UPDATE_DIRECTORY, undefined);
    NodeAssert.equal(packageEnv.OOP_DESKTOP_UPDATE_CANDIDATES, undefined);
    NodeAssert.equal(packageEnv.OOP_DESKTOP_UPDATE_FOLDER_KIND, undefined);
    NodeAssert.equal(packageEnv.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, undefined);
    NodeAssert.equal(packageEnv.T3CODE_MACOS_INSTALLER_LEAF_SHA256, undefined);
  },
);

NodeTest.test(
  "release version follows OOP release independently of upstream provenance",
  async () => {
    const source = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-version-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(source, "UPSTREAM.json"),
        JSON.stringify({ source: { tag: "v0.0.44" } }),
      );
      const releasePath = NodePath.join(source, "OOP_RELEASE.json");
      await NodeFSP.writeFile(releasePath, JSON.stringify({ version: "0.0.45" }));
      NodeAssert.equal(await releaseVersion(source), "0.0.45");
      NodeAssert.equal(await upstreamVersion(source), "0.0.44");
      await NodeFSP.writeFile(
        NodePath.join(source, "UPSTREAM.json"),
        JSON.stringify({ source: { tag: "main" } }),
      );
      await NodeAssert.rejects(upstreamVersion(source), /original stable release tag/);
      NodeAssert.equal(await releaseVersion(source), "0.0.45");
      for (const version of ["0.0.45-preview.1", "v0.0.45", "00.0.45", "0.0.45\n", null, 45]) {
        await NodeFSP.writeFile(releasePath, JSON.stringify({ version }));
        await NodeAssert.rejects(releaseVersion(source), /stable OOP version/);
      }
    } finally {
      await NodeFSP.rm(source, { recursive: true, force: true });
    }
  },
);

NodeTest.test("filesystem detection honors root APFS and a more specific network mount", () => {
  const fixture =
    "/dev/disk3s5 on / (apfs, local, read-only)\n//nas/share on /Volumes/Shared (smbfs, nodev, nosuid)\n";
  NodeAssert.equal(mountFilesystemType(fixture, "/Users/test/Library/Caches/OOP_DeskTop"), "apfs");
  NodeAssert.equal(mountFilesystemType(fixture, "/Volumes/Shared/MyPJ"), "smbfs");
});

NodeTest.test(
  "source sync points rsync deletion only at the owned checkout and excludes live state",
  async () => {
    const calls = [];
    const paths = {
      source: "/Volumes/NAS/OOP DeskTop 한글",
      checkout: "/Users/test/Library/Caches/OOP_DeskTop/key/checkout",
    };
    await syncSource(paths, async (command, args) => {
      calls.push({ command, args });
    });
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0].command, "rsync");
    NodeAssert.equal(calls[0].args.at(-2), `${paths.source}/`);
    NodeAssert.equal(calls[0].args.at(-1), `${paths.checkout}/`);
    NodeAssert.ok(calls[0].args.includes("--delete"));
    NodeAssert.ok(!calls[0].args.includes("--delete-excluded"));
    NodeAssert.ok(calls[0].args.includes("--safe-links"));
    for (const pattern of [
      "node_modules/",
      ".electron-runtime/",
      "target/",
      ".t3/",
      ".env",
      "release/",
      ".git/",
    ]) {
      NodeAssert.ok(RSYNC_EXCLUDES.includes(pattern));
      NodeAssert.ok(calls[0].args.includes(`--exclude=${pattern}`));
    }
  },
);

NodeTest.test("desktop build invokes the installed local vp without pnpm exec", async () => {
  const paths = {
    source: "/Volumes/NAS/OOP DeskTop 한글",
    checkout: "/Users/test/Library/Caches/OOP_DeskTop/key/checkout",
  };
  const calls = [];
  await build(paths, async (command, args, options) => {
    calls.push({ command, args, options });
  });
  NodeAssert.equal(calls.length, 1);
  NodeAssert.equal(calls[0].command, NodePath.join(paths.checkout, "node_modules", ".bin", "vp"));
  NodeAssert.deepEqual(calls[0].args, ["run", "build:desktop"]);
  NodeAssert.equal(calls[0].options.cwd, paths.checkout);
  NodeAssert.equal(calls[0].options.env.T3CODE_DESKTOP_BUILD_PROFILE_NAME, "oop-desktop");
  NodeAssert.equal(
    calls[0].options.env.OOP_DESKTOP_UPDATE_DIRECTORY,
    NodePath.join(paths.source, "release", "macos"),
  );
  // Google Drive comes first; the source's release/macos stays the fallback.
  NodeAssert.deepEqual(JSON.parse(calls[0].options.env.OOP_DESKTOP_UPDATE_CANDIDATES), [
    "~/Library/CloudStorage/GoogleDrive-*/My Drive/OOP/release/macos",
    "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OOP/release/macos",
  ]);
  NodeAssert.equal(calls[0].options.env.OOP_DESKTOP_UPDATE_FOLDER_KIND, "google-drive");
});

NodeTest.test("host validation rejects non-arm64, wrong Node and pnpm versions", () => {
  NodeAssert.deepEqual(
    validateHost({
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "24.21.0",
      pnpmVersion: "11.10.0",
    }),
    [],
  );
  const problems = validateHost({
    platform: "linux",
    arch: "x64",
    nodeVersion: "22.1.0",
    pnpmVersion: "10.0.0",
  });
  NodeAssert.equal(problems.length, 4);
});

NodeTest.test(
  "child process spawn and nonzero failures reject with useful exit status",
  async () => {
    await NodeAssert.rejects(
      runCommand(process.execPath, ["-e", "process.exit(37)"], { stdio: "ignore" }),
      (error) => error.exitCode === 37,
    );
    await NodeAssert.rejects(
      runCommand("definitely-not-a-command-for-macos-workflow", [], { stdio: "ignore" }),
      { code: "ENOENT" },
    );
    await NodeAssert.rejects(
      runCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
        { stdio: "ignore", timeout: 400 },
      ),
      (error) => error.exitCode === 124 && /timed out/u.test(error.message),
    );
    const priorHandlers = new Set(process.listeners("SIGTERM"));
    const interrupted = runCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const forwardingHandler = process
      .listeners("SIGTERM")
      .find((handler) => !priorHandlers.has(handler));
    NodeAssert.ok(forwardingHandler);
    forwardingHandler();
    await NodeAssert.rejects(
      interrupted,
      (error) => error.exitCode === 143 && /interrupted/u.test(error.message),
    );
  },
);

NodeTest.test("final DMG verifier rejects a copied-byte mismatch before mounting", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-dmg-hash-"));
  try {
    const dmg = NodePath.join(root, "OOP.dmg");
    await NodeFSP.writeFile(dmg, "different bytes");
    await NodeAssert.rejects(
      verifyMacDmgArtifact(dmg, "expected", async () => {
        throw new Error("should not run");
      }),
      /SHA-256 mismatch/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "final DMG verifier checks image and app seal, then detaches even on signature failure",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-dmg-seal-"));
    try {
      const dmg = NodePath.join(root, "OOP.dmg");
      const bytes = "fixture dmg bytes";
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      await NodeFSP.writeFile(dmg, bytes);
      const calls = [];
      const runner = async (command, args) => {
        calls.push({ command, args });
        if (command.endsWith("hdiutil") && args[0] === "attach") {
          await NodeFSP.mkdir(NodePath.join(args.at(-2), "OOP.app"));
        }
      };
      NodeAssert.equal(await verifyMacDmgArtifact(dmg, digest, runner), digest);
      NodeAssert.deepEqual(
        calls.map(({ args }) => args[0]),
        ["verify", "attach", "--verify", "detach"],
      );
      NodeAssert.ok(calls[1].args.includes("-readonly"));
      NodeAssert.ok(calls[1].args.includes("-nobrowse"));
      NodeAssert.ok(calls[2].args.includes("--deep"));
      NodeAssert.ok(calls[2].args.includes("--strict"));
      NodeAssert.ok(
        calls.every(
          ({ command }) => command === "/usr/bin/hdiutil" || command === "/usr/bin/codesign",
        ),
      );
      const mountPoint = calls[1].args.at(-2);
      await NodeAssert.rejects(NodeFSP.stat(mountPoint), { code: "ENOENT" });

      const failureCalls = [];
      await NodeAssert.rejects(
        verifyMacDmgArtifact(dmg, digest, async (command, args) => {
          failureCalls.push(args[0]);
          if (command.endsWith("hdiutil") && args[0] === "attach")
            await NodeFSP.mkdir(NodePath.join(args.at(-2), "OOP.app"));
          if (command.endsWith("codesign")) throw new Error("invalid seal");
        }),
        /invalid seal/,
      );
      NodeAssert.deepEqual(failureCalls, ["verify", "attach", "--verify", "detach"]);

      await NodeAssert.rejects(
        verifyMacDmgArtifact(dmg, digest, async (_command, args) => {
          if (args[0] === "verify") throw new Error("invalid image");
        }),
        /invalid image/,
      );

      const partialCalls = [];
      await NodeAssert.rejects(
        verifyMacDmgArtifact(dmg, digest, async (_command, args, options) => {
          partialCalls.push({ action: args[0], timeout: options.timeout });
          if (args[0] === "attach") throw new Error("partial attach failure");
        }),
        /partial attach failure/,
      );
      NodeAssert.deepEqual(
        partialCalls.map(({ action }) => action),
        ["verify", "attach", "detach"],
      );
      NodeAssert.ok(partialCalls.every(({ timeout }) => timeout > 0));

      const symlinkCalls = [];
      await NodeAssert.rejects(
        verifyMacDmgArtifact(dmg, digest, async (_command, args) => {
          symlinkCalls.push(args[0]);
          if (args[0] === "attach")
            await NodeFSP.symlink(root, NodePath.join(args.at(-2), "OOP.app"));
        }),
        /Expected OOP\.app/,
      );
      NodeAssert.deepEqual(symlinkCalls, ["verify", "attach", "detach"]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("failed replacement leaves no stale success manifest for that version", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-package-failure-"));
  try {
    const source = NodePath.join(root, "source");
    const destination = NodePath.join(source, "release", "macos");
    const fileName = "OOP-0.0.44-arm64.dmg";
    await NodeFSP.mkdir(destination, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(destination, `${fileName}.json`),
      '{"verification":"old pass"}',
    );
    await NodeFSP.writeFile(NodePath.join(destination, `${fileName}.sha256`), "old hash");
    await NodeAssert.rejects(
      packageDmg(
        { source, checkout: root, artifactRoot: NodePath.join(root, "artifacts") },
        async () => {
          throw new Error("builder failed");
        },
        "0.0.44",
      ),
      /builder failed/,
    );
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(destination, `${fileName}.json`)), {
      code: "ENOENT",
    });
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(destination, `${fileName}.sha256`)), {
      code: "ENOENT",
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "package publishes only a verified final DMG and scoped integrity evidence",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-package-success-"));
    try {
      const source = NodePath.join(root, "source");
      const checkout = NodePath.join(root, "checkout");
      const artifactRoot = NodePath.join(root, "artifacts");
      for (const app of ["desktop", "server"]) {
        const dir = NodePath.join(source, "apps", app);
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(dir, "package.json"),
          JSON.stringify({ version: "0.0.44" }),
        );
      }
      const fileName = "OOP-0.0.44-arm64.dmg";
      const bytes = "built dmg fixture";
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      await packageDmg(
        { source, checkout, artifactRoot },
        async (command, args) => {
          if (command === process.execPath) {
            const out = args[args.indexOf("--output-dir") + 1];
            await NodeFSP.writeFile(NodePath.join(out, fileName), bytes);
          } else if (command.endsWith("hdiutil") && args[0] === "attach") {
            await NodeFSP.mkdir(NodePath.join(args.at(-2), "OOP.app"));
          }
        },
        "0.0.44",
      );
      const destination = NodePath.join(source, "release", "macos");
      NodeAssert.equal(await NodeFSP.readFile(NodePath.join(destination, fileName), "utf8"), bytes);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(destination, `${fileName}.sha256`), "utf8"),
        `${digest}  ${fileName}\n`,
      );
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(destination, `${fileName}.json`), "utf8"),
      );
      NodeAssert.equal(manifest.sha256, digest);
      NodeAssert.match(manifest.verification, /signature passed/u);
      NodeAssert.match(manifest.verification, /UI, integrations, and notarization not exercised/u);
      // The build output is not kept in the cache once release/macos holds the verified copy.
      NodeAssert.deepEqual(await NodeFSP.readdir(artifactRoot), []);
      NodeAssert.deepEqual(
        Object.keys(manifest).filter((key) =>
          ["distribution", "shippable", "passkeyConfigured", "notarized", "signing"].includes(key),
        ),
        [],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "DMG verifier adds a Developer ID Team requirement test only for an expected signer, and still detaches",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-dmg-signer-"));
    try {
      const dmg = NodePath.join(root, "OOP.dmg");
      const bytes = "fixture dmg bytes";
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      await NodeFSP.writeFile(dmg, bytes);
      const run = async (signerFails, expectedSigner) => {
        const calls = [];
        const outcome = await verifyMacDmgArtifact(
          dmg,
          digest,
          async (command, args) => {
            calls.push({ command, args });
            if (args[0] === "attach") await NodeFSP.mkdir(NodePath.join(args.at(-2), "OOP.app"));
            if (signerFails && args.some((arg) => arg.startsWith("-R=")))
              throw new Error("code failed to satisfy specified code requirement(s)");
          },
          expectedSigner,
        ).then(
          () => "verified",
          (error) => error.message,
        );
        return { calls, outcome };
      };

      const plain = await run(false, undefined);
      NodeAssert.equal(plain.outcome, "verified");
      NodeAssert.deepEqual(
        plain.calls.map(({ args }) => args[0]),
        ["verify", "attach", "--verify", "detach"],
      );
      NodeAssert.ok(plain.calls.every(({ args }) => !args.some((arg) => arg.startsWith("-R="))));

      // These runner calls prove command wiring only; a real certificate is evaluated by codesign, not by this test.
      const signed = await run(false, { teamId: "ABCDE12345" });
      NodeAssert.equal(signed.outcome, "verified");
      NodeAssert.deepEqual(
        signed.calls.map(({ args }) => args[0]),
        ["verify", "attach", "--verify", "--verify", "detach"],
      );
      const requirement = signed.calls[3].args.find((arg) => arg.startsWith("-R=")).slice(3);
      NodeAssert.ok(signed.calls[3].args.includes("--strict"));
      // Identical to the literal build-desktop-artifact.test.ts pins for the direct builder's check, so drift in either shows up.
      // It names a Developer ID Application leaf, not just any Apple-issued certificate.
      NodeAssert.equal(
        requirement,
        'identifier "com.t3tools.t3code" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"',
      );
      NodeAssert.ok(signed.calls[3].args.at(-1).endsWith("OOP.app"));

      const rejected = await run(true, { teamId: "ABCDE12345" });
      NodeAssert.match(rejected.outcome, /failed to satisfy/);
      NodeAssert.deepEqual(
        rejected.calls.map(({ args }) => args[0]),
        ["verify", "attach", "--verify", "--verify", "detach"],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

const CANDIDATE_VERSION = "0.0.44";
const CANDIDATE_FILE = `OOP-${CANDIDATE_VERSION}-arm64.dmg`;
const CANDIDATE_BYTES = "candidate dmg fixture";

// A source tree with an accepted release already published for the same version
// the candidate is built for, as with an unchanged OOP_RELEASE.json.
async function candidateFixture(root, { artifactRoot = NodePath.join(root, "artifacts") } = {}) {
  const source = NodePath.join(root, "source");
  const canonical = NodePath.join(source, "release", "macos");
  await NodeFSP.mkdir(canonical, { recursive: true });
  for (const app of ["desktop", "server"]) {
    const dir = NodePath.join(source, "apps", app);
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, "package.json"),
      JSON.stringify({ version: CANDIDATE_VERSION }),
    );
  }
  const accepted = {
    [CANDIDATE_FILE]: "accepted dmg bytes",
    [`${CANDIDATE_FILE}.sha256`]: "accepted hash\n",
    [`${CANDIDATE_FILE}.json`]: '{"verification":"accepted"}',
    "oop-update.json": '{"feed":"accepted"}',
    "LOCAL_UPDATE_STATUS.json": '{"status":"accepted"}',
  };
  for (const [name, content] of Object.entries(accepted))
    await NodeFSP.writeFile(NodePath.join(canonical, name), content);
  return { paths: { source, checkout: NodePath.join(root, "checkout"), artifactRoot }, canonical };
}

// Identity, size, mtime, and bytes of every entry, so a deletion, rewrite, or
// atomic rename over an existing file shows up as a difference.
async function snapshotTree(directory) {
  const entries = (await NodeFSP.readdir(directory, { recursive: true })).sort();
  return Promise.all(
    entries.map(async (entry) => {
      const stat = await NodeFSP.lstat(NodePath.join(directory, entry));
      return {
        entry,
        directory: stat.isDirectory(),
        size: stat.size,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        bytes: stat.isFile()
          ? await NodeFSP.readFile(NodePath.join(directory, entry), "utf8")
          : undefined,
      };
    }),
  );
}

function candidateRunner(calls, failure) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === process.execPath) {
      if (failure === "builder") throw new Error("builder failed");
      await NodeFSP.writeFile(
        NodePath.join(args[args.indexOf("--output-dir") + 1], CANDIDATE_FILE),
        CANDIDATE_BYTES,
      );
    } else if (args[0] === "attach") {
      await NodeFSP.mkdir(NodePath.join(args.at(-2), "OOP.app"));
    } else if (failure === "signer" && args.some((arg) => arg.startsWith("-R="))) {
      throw new Error("code failed to satisfy specified code requirement(s)");
    }
  };
}

const AMBIENT_SIGNING_ENV = {
  PATH: "/usr/bin",
  GITHUB_REPOSITORY: "example/upstream",
  T3CODE_DESKTOP_SIGNED: "true",
  CSC_LINK: "/tmp/untrusted.p12",
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
  ...SIGNING_ENV,
};

NodeTest.test(
  "developer-id candidate lives only in the private artifact root and never touches the canonical release",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-candidate-success-"));
    try {
      const { paths, canonical } = await candidateFixture(root);
      const before = await snapshotTree(paths.source);
      const calls = [];
      const signing = resolvePackageSigning("developer-id", AMBIENT_SIGNING_ENV);
      await packageDmg(
        paths,
        candidateRunner(calls),
        CANDIDATE_VERSION,
        signing,
        AMBIENT_SIGNING_ENV,
      );

      NodeAssert.deepEqual(await snapshotTree(paths.source), before);
      NodeAssert.deepEqual(
        (await NodeFSP.readdir(canonical)).sort(),
        [
          CANDIDATE_FILE,
          `${CANDIDATE_FILE}.json`,
          `${CANDIDATE_FILE}.sha256`,
          "LOCAL_UPDATE_STATUS.json",
          "oop-update.json",
        ].sort(),
      );

      // The builder gets the explicit selector and the expected signer, never --signed or ambient mode.
      const builder = calls.find(({ command }) => command === process.execPath);
      NodeAssert.deepEqual(builder.args.slice(builder.args.indexOf("--signing-mode")), [
        "--signing-mode",
        "developer-id",
      ]);
      NodeAssert.ok(!builder.args.includes("--signed"));
      NodeAssert.equal(builder.options.env.CSC_NAME, SIGNING_IDENTITY);
      NodeAssert.equal(builder.options.env.T3CODE_APPLE_TEAM_ID, "ABCDE12345");
      NodeAssert.equal(builder.options.env.T3CODE_DESKTOP_SIGNED, undefined);
      NodeAssert.equal(builder.options.env.GITHUB_REPOSITORY, undefined);
      NodeAssert.equal(builder.options.env.T3CODE_DESKTOP_BUILD_PROFILE_NAME, "oop-desktop");
      NodeAssert.equal(builder.options.env.OOP_DESKTOP_UPDATE_DIRECTORY, canonical);
      NodeAssert.equal(builder.options.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256, INSTALLER_PIN);
      NodeAssert.equal(builder.options.env.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, undefined);
      NodeAssert.ok(!builder.args.includes("--skip-build"));
      NodeAssert.equal(
        builder.args[builder.args.indexOf("--output-dir") + 1].startsWith(paths.artifactRoot),
        true,
      );

      const privateDirectories = (await NodeFSP.readdir(paths.artifactRoot)).filter((name) =>
        name.endsWith("-candidate"),
      );
      NodeAssert.equal(privateDirectories.length, 1);
      const privateRoot = NodePath.join(paths.artifactRoot, privateDirectories[0]);
      NodeAssert.deepEqual((await NodeFSP.readdir(privateRoot)).sort(), [
        CANDIDATE_FILE,
        `${CANDIDATE_FILE}.json`,
        `${CANDIDATE_FILE}.sha256`,
      ]);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(privateRoot, CANDIDATE_FILE), "utf8"),
        CANDIDATE_BYTES,
      );
      const digest = NodeCrypto.createHash("sha256").update(CANDIDATE_BYTES).digest("hex");
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(privateRoot, `${CANDIDATE_FILE}.sha256`), "utf8"),
        `${digest}  ${CANDIDATE_FILE}\n`,
      );

      // Metadata states limits; it does not claim notarization, passkeys, or shippability.
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(privateRoot, `${CANDIDATE_FILE}.json`), "utf8"),
      );
      NodeAssert.equal(manifest.sha256, digest);
      NodeAssert.equal(manifest.distribution, "internal-candidate");
      NodeAssert.equal(manifest.shippable, false);
      NodeAssert.equal(manifest.passkeyConfigured, false);
      NodeAssert.equal(manifest.notarized, false);
      NodeAssert.deepEqual(manifest.signing, {
        requestedMode: "developer-id",
        expectedTeamId: "ABCDE12345",
      });
      NodeAssert.match(
        manifest.verification,
        /notarization, Gatekeeper, installer trust, passkeys, UI, and runtime behavior not exercised/u,
      );

      // Command wiring only: the signer requirement runs on the mounted app before publishing, but a mocked runner
      // cannot show that a real certificate or Team signed it. That needs the real isolated package.
      const actions = calls
        .filter(({ command }) => command !== process.execPath)
        .map(({ args }) => args[0]);
      NodeAssert.deepEqual(actions, ["verify", "attach", "--verify", "--verify", "detach"]);
      NodeAssert.ok(
        calls.some(({ args }) =>
          args.some((arg) => arg.startsWith("-R=") && arg.includes('"ABCDE12345"')),
        ),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "developer-id candidate failures leave the canonical release intact and publish no candidate receipt",
  async () => {
    for (const failure of ["builder", "signer"]) {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), `macos-candidate-${failure}-`),
      );
      try {
        const { paths } = await candidateFixture(root);
        const before = await snapshotTree(paths.source);
        const signing = resolvePackageSigning("developer-id", SIGNING_ENV);
        await NodeAssert.rejects(
          packageDmg(paths, candidateRunner([], failure), CANDIDATE_VERSION, signing, SIGNING_ENV),
          failure === "builder" ? /builder failed/ : /failed to satisfy/,
        );

        NodeAssert.deepEqual(await snapshotTree(paths.source), before, failure);
        const privateRoots = (await NodeFSP.readdir(paths.artifactRoot)).filter((name) =>
          name.endsWith("-candidate"),
        );
        for (const name of privateRoots)
          NodeAssert.deepEqual(
            await NodeFSP.readdir(NodePath.join(paths.artifactRoot, name)),
            [],
            failure,
          );
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  },
);

NodeTest.test(
  "developer-id candidate refuses an artifact root inside the source tree before doing anything",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-candidate-inside-"));
    try {
      for (const relative of ["release/macos", "release", "."]) {
        const { paths } = await candidateFixture(root, {
          artifactRoot: NodePath.join(root, "source", relative),
        });
        const before = await snapshotTree(paths.source);
        const calls = [];
        await NodeAssert.rejects(
          packageDmg(
            paths,
            candidateRunner(calls),
            CANDIDATE_VERSION,
            resolvePackageSigning("developer-id", SIGNING_ENV),
            SIGNING_ENV,
          ),
          /outside the source tree/,
        );
        NodeAssert.deepEqual(calls, []);
        NodeAssert.deepEqual(await snapshotTree(paths.source), before, relative);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "default package ignores ambient signing selectors and keeps its canonical export semantics",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "macos-package-default-"));
    try {
      const { paths, canonical } = await candidateFixture(root);
      const calls = [];
      // No explicit selector: credentials, the legacy signed env, and a passkey profile change nothing.
      const ambient = {
        ...AMBIENT_SIGNING_ENV,
        T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/a.provisionprofile",
      };
      NodeAssert.equal(resolvePackageSigning(undefined, ambient), undefined);
      await packageDmg(paths, candidateRunner(calls), CANDIDATE_VERSION, undefined, ambient);

      const builder = calls.find(({ command }) => command === process.execPath);
      NodeAssert.ok(!builder.args.includes("--signing-mode"));
      NodeAssert.ok(!builder.args.includes("--signed"));
      NodeAssert.equal(builder.options.env.T3CODE_DESKTOP_SIGNED, undefined);
      NodeAssert.equal(builder.options.env.T3CODE_DESKTOP_BUILD_PROFILE_NAME, "oop-desktop");
      NodeAssert.equal(builder.options.env.OOP_DESKTOP_UPDATE_DIRECTORY, canonical);
      NodeAssert.equal(builder.options.env.T3CODE_MACOS_INSTALLER_LEAF_SHA256, undefined);
      NodeAssert.equal(builder.options.env.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST, undefined);
      NodeAssert.ok(builder.args.includes("--skip-build"));
      NodeAssert.equal(
        builder.args[builder.args.indexOf("--output-dir") + 1].startsWith(paths.artifactRoot),
        true,
      );
      NodeAssert.ok(calls.every(({ args }) => !args.some((arg) => arg.startsWith("-R="))));

      // The default export still replaces the canonical DMG and its receipts, and builds no private candidate.
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(canonical, CANDIDATE_FILE), "utf8"),
        CANDIDATE_BYTES,
      );
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(canonical, `${CANDIDATE_FILE}.json`), "utf8"),
      );
      NodeAssert.match(
        manifest.verification,
        /strict\/deep signature passed; UI, integrations, and notarization not exercised/u,
      );
      NodeAssert.equal(manifest.shippable, undefined);
      NodeAssert.deepEqual(
        (await NodeFSP.readdir(paths.artifactRoot)).filter((name) => name.endsWith("-candidate")),
        [],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("finds the SMB share that holds the update folder", () => {
  const mounts = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "//user@192.168.1.10/Shared on /Volumes/Shared (smbfs, nodev, nosuid, mounted by user)",
    "//nas.local/oop%20share on /Volumes/oop share (smbfs, nodev, nosuid)",
  ].join("\n");
  NodeAssert.equal(
    smbShareUrlForPath(mounts, "/Volumes/Shared/MyPJ/OOP_DeskTop/release/macos"),
    "smb://192.168.1.10/Shared",
  );
  NodeAssert.equal(
    smbShareUrlForPath(mounts, "/Volumes/oop share/release"),
    "smb://nas.local/oop%20share",
  );
  NodeAssert.equal(smbShareUrlForPath(mounts, "/Volumes/Shared-1/release"), undefined);
  NodeAssert.equal(smbShareUrlForPath(mounts, "/Users/example/release"), undefined);
});
