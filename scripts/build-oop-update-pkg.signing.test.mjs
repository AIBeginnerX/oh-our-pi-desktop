import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { buildOopUpdatePkg, parseArgs } from "./build-oop-update-pkg.mjs";

const VERSION = "0.0.59";
const DMG_BYTES = "trusted candidate DMG fixture";
const DMG_SHA256 = NodeCrypto.createHash("sha256").update(DMG_BYTES).digest("hex");
const CANDIDATE_NAME = `OOP-${VERSION}-arm64-signed-candidate.pkg`;
const CANDIDATE_LOCK = ".oop-signed-candidate.lock";
const POLICY = { mode: "developer-id", teamId: "ABCDE12345", leafPins: ["a".repeat(64)] };
const APP_METADATA = {
  identifier: "com.t3tools.t3code",
  name: "OOP",
  executable: "OOP",
  version: VERSION,
  architectures: ["arm64"],
  oopProfileEmbedded: true,
};

async function withCandidateFixture(body) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-signed-pkg-test-"));
  try {
    const repoRoot = NodePath.join(root, "checkout");
    const outputRoot = NodePath.join(root, "private");
    const dmg = NodePath.join(root, "input.dmg");
    await NodeFSP.mkdir(repoRoot);
    await NodeFSP.mkdir(outputRoot);
    await NodeFSP.writeFile(dmg, DMG_BYTES);
    await body({
      root,
      repoRoot,
      outputRoot,
      dmg,
      output: NodePath.join(outputRoot, CANDIDATE_NAME),
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function snapshot(directory) {
  const entries = {};
  for (const name of (await NodeFSP.readdir(directory)).sort()) {
    const path = NodePath.join(directory, name);
    const stat = await NodeFSP.lstat(path);
    entries[name] = stat.isFile()
      ? await NodeFSP.readFile(path, "utf8")
      : stat.isDirectory()
        ? "<dir>"
        : "<symlink>";
  }
  return entries;
}

async function snapshotTree(root) {
  const entries = {};
  async function visit(directory) {
    for (const name of (await NodeFSP.readdir(directory)).sort()) {
      const path = NodePath.join(directory, name);
      const relative = NodePath.relative(root, path);
      const stat = await NodeFSP.lstat(path);
      if (stat.isDirectory()) {
        entries[relative] = "<dir>";
        await visit(path);
      } else if (stat.isSymbolicLink()) {
        entries[relative] = `<symlink:${await NodeFSP.readlink(path)}>`;
      } else {
        entries[relative] = await NodeFSP.readFile(path, "utf8");
      }
    }
  }
  await visit(root);
  return entries;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeSigningModule = {
  resolvePkgSigning: () => ({
    installerIdentity: "Developer ID Installer: Fixture (ABCDE12345)",
    teamId: "ABCDE12345",
    policy: POLICY,
    notaryProfile: "fixture",
  }),
  checkEmbeddedPolicy: () => {},
  signPackage: async () => {
    throw new Error("guard let signing begin");
  },
  notarizeAndStaple: async () => {
    throw new Error("guard let notarization begin");
  },
  assessNotarizedPackage: async () => {
    throw new Error("guard let assessment begin");
  },
};

function fakePackageRunner(events, { bindingRead } = {}) {
  let mount;
  let distribution;
  return async (command, args) => {
    const name = NodePath.basename(command);
    events.push(`${name} ${args[0]}`);
    if (name === "codesign" && args.some((arg) => arg.startsWith("-R=")))
      events.push("codesign requirement");
    if (name === "hdiutil" && args[0] === "attach") {
      mount = args[args.indexOf("-mountpoint") + 1];
      const resources = NodePath.join(mount, "OOP.app", "Contents", "Resources");
      await NodeFSP.mkdir(resources, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(resources, "app.asar"),
        "OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:" + POLICY.leafPins[0],
      );
      return "<plist>attached</plist>";
    }
    if (name === "plutil" && args[0] === "-convert") {
      return JSON.stringify({
        "system-entities": [{ "mount-point": mount, "dev-entry": "/dev/disk99s1" }],
      });
    }
    if (name === "ditto") await NodeFSP.cp(args[0], args[1], { recursive: true });
    if (name === "pkgbuild") await NodeFSP.writeFile(args.at(-1), "component bytes");
    if (name === "productbuild") {
      distribution = await NodeFSP.readFile(args[args.indexOf("--distribution") + 1], "utf8");
      await NodeFSP.writeFile(args.at(-1), "unsigned package bytes");
    }
    if (name === "tar")
      return args[0] === "-t"
        ? "Distribution\n"
        : (bindingRead?.(args[args.indexOf("-f") + 1], distribution) ?? distribution);
    if (name === "xar")
      return `<xar><toc><file><data><extracted-checksum style="sha1">${NodeCrypto.createHash("sha1").update(distribution).digest("hex")}</extracted-checksum></data></file></toc></xar>`;
    return "";
  };
}

function signingModule(events, { failAt, mutateAtAssess = false } = {}) {
  return {
    resolvePkgSigning: fakeSigningModule.resolvePkgSigning,
    checkEmbeddedPolicy: (asar) => {
      events.push("embedded policy");
      NodeAssert.ok(
        Buffer.from(asar)
          .toString("latin1")
          .includes("OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:"),
      );
      if (failAt === "embedded") throw new Error("embedded policy failed");
    },
    signPackage: async (_signing, unsignedPath, signedPath) => {
      events.push("sign and pin");
      NodeAssert.equal(await NodeFSP.readFile(unsignedPath, "utf8"), "unsigned package bytes");
      if (failAt === "sign") throw new Error("sign and pin failed");
      await NodeFSP.writeFile(signedPath, "signed package bytes");
      return { leafFingerprint: POLICY.leafPins[0] };
    },
    notarizeAndStaple: async (_signing, signedPath) => {
      events.push("notarize and staple");
      if (failAt === "notarize") throw new Error("notarize and staple failed");
      await NodeFSP.writeFile(signedPath, "stapled package bytes");
      return { submissionId: "123e4567-e89b-42d3-a456-426614174000" };
    },
    assessNotarizedPackage: async (_signing, signedPath, version) => {
      events.push("assess final");
      NodeAssert.equal(version, VERSION);
      if (failAt === "assess") throw new Error("final assessment failed");
      if (mutateAtAssess) await NodeFSP.appendFile(signedPath, "mutation after hash");
    },
  };
}

async function assertPreflightReject(label, setup, loadSigning = async () => fakeSigningModule) {
  await withCandidateFixture(async (fixture) => {
    const { output, env = {}, repoRoot = fixture.repoRoot } = await setup(fixture);
    const before = await snapshotTree(fixture.root);
    const calls = [];
    await NodeAssert.rejects(
      buildOopUpdatePkg(
        {
          dmg: fixture.dmg,
          sha256: DMG_SHA256,
          version: VERSION,
          output,
          signingMode: "developer-id",
        },
        {
          repoRoot,
          env,
          loadSigning,
          run: async (...args) => {
            calls.push(args);
            throw new Error("preflight ran a tool");
          },
        },
      ),
    );
    NodeAssert.deepEqual(calls, [], label);
    NodeAssert.deepEqual(await snapshotTree(fixture.root), before, label);
  });
}

NodeTest.test("only an explicit developer-id flag selects signed PKG mode", () => {
  const args = [
    "--dmg",
    "input.dmg",
    "--sha256",
    DMG_SHA256,
    "--version",
    VERSION,
    "--output",
    CANDIDATE_NAME,
  ];
  const legacy = parseArgs(args);
  NodeAssert.equal(Object.hasOwn(legacy, "signingMode"), false);
  NodeAssert.deepEqual(parseArgs([...args, "--signing-mode", "developer-id"]), {
    ...legacy,
    signingMode: "developer-id",
  });
  for (const invalid of [
    [...args, "--signing-mode"],
    [...args, "--signing-mode", ""],
    [...args, "--signing-mode", "adhoc"],
    [...args, "--signing-mode", "developer-id", "--signing-mode", "developer-id"],
  ])
    NodeAssert.throws(() => parseArgs(invalid));
});

NodeTest.test("candidate signing helper imports under Node type stripping", async () => {
  const helper = await import("../apps/desktop/src/updates/LocalPkgCandidateSigning.ts");
  for (const exportName of [
    "resolvePkgSigning",
    "checkEmbeddedPolicy",
    "signPackage",
    "notarizeAndStaple",
    "assessNotarizedPackage",
  ]) {
    NodeAssert.equal(typeof helper[exportName], "function", exportName);
  }
});

NodeTest.test("ambient signing inputs never select mode or load the signing helper", async () => {
  await withCandidateFixture(async ({ dmg, outputRoot }) => {
    const output = NodePath.join(outputRoot, `OoP-${VERSION}-arm64-update.pkg`);
    const events = [];
    const manifest = await buildOopUpdatePkg(
      { dmg, sha256: DMG_SHA256, version: VERSION, output },
      {
        env: {
          T3CODE_MACOS_INSTALLER_IDENTITY: "Developer ID Installer: Fixture (ABCDE12345)",
          T3CODE_APPLE_TEAM_ID: "ABCDE12345",
          T3CODE_MACOS_INSTALLER_LEAF_SHA256: POLICY.leafPins[0],
          T3CODE_NOTARY_KEYCHAIN_PROFILE: "fixture",
        },
        loadSigning: async () => {
          throw new Error("legacy build imported signing helper");
        },
        run: fakePackageRunner(events),
        inspectApp: async () => APP_METADATA,
      },
    );
    NodeAssert.equal(manifest.packageSigned, false);
    NodeAssert.equal(
      (await NodeFSP.readFile(NodePath.join(outputRoot, "oop-update.json"), "utf8")).includes(
        `"version": "${VERSION}"`,
      ),
      true,
    );
    NodeAssert.ok(events.some((event) => event.startsWith("productbuild ")));
    NodeAssert.ok(
      events.every((event) => !event.startsWith("productsign ") && !event.startsWith("xcrun ")),
    );
  });
});

NodeTest.test("signed candidate rejects unsafe output locations before any mutation", async () => {
  await assertPreflightReject("canonical output name", async ({ outputRoot }) => ({
    output: NodePath.join(outputRoot, `OoP-${VERSION}-arm64-update.pkg`),
  }));
  await assertPreflightReject("wrong candidate name", async ({ outputRoot }) => ({
    output: NodePath.join(outputRoot, `OOP-${VERSION}-arm64-rollback.pkg`),
  }));
  await assertPreflightReject("inside repository", async ({ repoRoot }) => ({
    output: NodePath.join(repoRoot, "release", CANDIDATE_NAME),
  }));
  await assertPreflightReject("symlink into repository", async ({ root, repoRoot }) => {
    const link = NodePath.join(root, "repo-link");
    await NodeFSP.symlink(repoRoot, link);
    return { output: NodePath.join(link, "future", CANDIDATE_NAME) };
  });
  await assertPreflightReject("inside update directory", async ({ root }) => {
    const updateDir = NodePath.join(root, "updates");
    const link = NodePath.join(root, "update-link");
    await NodeFSP.mkdir(updateDir);
    await NodeFSP.symlink(updateDir, link);
    return {
      output: NodePath.join(link, "future", CANDIDATE_NAME),
      env: { OOP_DESKTOP_UPDATE_DIRECTORY: updateDir },
    };
  });
  for (const entry of ["oop-update.json", ".oop-update-publish.lock"]) {
    await assertPreflightReject(`directory containing ${entry}`, async ({ outputRoot, output }) => {
      await NodeFSP.writeFile(NodePath.join(outputRoot, entry), "existing");
      return { output };
    });
  }
  await assertPreflightReject("ancestor with OOP_RELEASE.json", async ({ outputRoot, output }) => {
    await NodeFSP.writeFile(NodePath.join(outputRoot, "OOP_RELEASE.json"), "existing");
    return { output };
  });
});

NodeTest.test(
  "signed candidate fails closed when signing helper or its environment is invalid",
  async () => {
    await assertPreflightReject(
      "helper import failed",
      async ({ outputRoot }) => ({ output: NodePath.join(outputRoot, "future", CANDIDATE_NAME) }),
      async () => {
        throw new Error("helper import failed");
      },
    );
    await assertPreflightReject(
      "bad signing environment",
      async ({ outputRoot }) => ({ output: NodePath.join(outputRoot, "future", CANDIDATE_NAME) }),
      async () => ({
        ...fakeSigningModule,
        resolvePkgSigning: () => {
          throw new Error("bad signing environment");
        },
      }),
    );
  },
);

NodeTest.test("signed candidate verifies stapled bytes before private publication", async () => {
  await withCandidateFixture(async ({ repoRoot, dmg, outputRoot, output }) => {
    const events = [];
    const manifest = await buildOopUpdatePkg(
      { dmg, sha256: DMG_SHA256, version: VERSION, output, signingMode: "developer-id" },
      {
        repoRoot,
        env: {},
        loadSigning: async () => signingModule(events),
        run: fakePackageRunner(events),
        inspectApp: async () => APP_METADATA,
        readAsar: async () =>
          Buffer.from("OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:" + POLICY.leafPins[0]),
      },
    );
    const first = (prefix, start = 0) =>
      events.findIndex((event, index) => index >= start && event.startsWith(prefix));
    const productbuild = first("productbuild ");
    const unsignedBinding = first("tar -t", productbuild + 1);
    const signing = first("sign and pin", unsignedBinding + 1);
    const signedBinding = first("tar -t", signing + 1);
    const notarize = first("notarize and staple", signedBinding + 1);
    const assess = first("assess final", notarize + 1);
    const finalBinding = first("tar -t", assess + 1);
    NodeAssert.ok(
      [productbuild, unsignedBinding, signing, signedBinding, notarize, assess, finalBinding].every(
        (index) => index >= 0,
      ),
      events.join("\n"),
    );
    NodeAssert.equal(events.filter((event) => event === "embedded policy").length, 2);
    NodeAssert.equal(events.filter((event) => event === "codesign requirement").length, 2);
    NodeAssert.equal(events.filter((event) => event === "tar -t").length, 3);
    NodeAssert.deepEqual(
      (await NodeFSP.readdir(outputRoot)).sort(),
      [CANDIDATE_NAME, `${CANDIDATE_NAME}.json`, `${CANDIDATE_NAME}.sha256`].sort(),
    );
    NodeAssert.equal(await NodeFSP.readFile(output, "utf8"), "stapled package bytes");
    const digest = NodeCrypto.createHash("sha256").update("stapled package bytes").digest("hex");
    NodeAssert.equal(manifest.packageSha256, digest);
    NodeAssert.equal(
      await NodeFSP.readFile(`${output}.sha256`, "utf8"),
      `${digest}  ${CANDIDATE_NAME}\n`,
    );
    NodeAssert.equal(manifest.distribution, "internal-candidate");
    NodeAssert.equal(manifest.shippable, false);
    NodeAssert.equal(manifest.packageSigned, true);
    NodeAssert.equal(manifest.packageNotarized, true);
    NodeAssert.equal(manifest.stapled, true);
    NodeAssert.equal(manifest.appNotarizationAssessed, false);
    NodeAssert.equal(Object.hasOwn(manifest, "appNotarized"), false);
    NodeAssert.deepEqual(manifest.signing, { mode: "developer-id", expectedTeamId: POLICY.teamId });
    NodeAssert.deepEqual(manifest.notarization, {
      submissionId: "123e4567-e89b-42d3-a456-426614174000",
    });
    NodeAssert.deepEqual(Object.keys(manifest), [
      "artifact",
      "version",
      "packageSha256",
      "inputDmgSha256",
      "componentIdentifier",
      "appBundleIdentifier",
      "appInstallPath",
      "distribution",
      "shippable",
      "packageSigned",
      "packageNotarized",
      "stapled",
      "appNotarizationAssessed",
      "signing",
      "notarization",
      "validation",
    ]);
    NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(`${output}.json`, "utf8")), manifest);
    for (const limit of [
      "Installer execution",
      "offline Gatekeeper",
      "revocation",
      "app usability",
      "runtime",
    ])
      NodeAssert.ok(manifest.validation.includes(limit), limit);
  });
});

NodeTest.test("an existing signed candidate lock is never removed or bypassed", async () => {
  await withCandidateFixture(async ({ repoRoot, root, dmg, outputRoot, output }) => {
    const lock = NodePath.join(outputRoot, CANDIDATE_LOCK);
    await NodeFSP.mkdir(lock);
    await NodeFSP.writeFile(NodePath.join(lock, "owner"), "another build");
    const before = await snapshotTree(root);
    const events = [];
    await NodeAssert.rejects(
      buildOopUpdatePkg(
        { dmg, sha256: DMG_SHA256, version: VERSION, output, signingMode: "developer-id" },
        {
          repoRoot,
          env: {},
          loadSigning: async () => signingModule(events),
          run: fakePackageRunner(events),
          inspectApp: async () => APP_METADATA,
        },
      ),
      /Another signed candidate build may be running/u,
    );
    NodeAssert.deepEqual(events, []);
    NodeAssert.deepEqual(await snapshotTree(root), before);
  });
});

NodeTest.test(
  "a signed candidate holds its lock through final verification and excludes a second build",
  async () => {
    await withCandidateFixture(async ({ repoRoot, dmg, outputRoot, output }) => {
      await NodeFSP.writeFile(output, "old candidate package");
      await NodeFSP.writeFile(`${output}.sha256`, "old candidate digest\n");
      await NodeFSP.writeFile(`${output}.json`, '{"old":"candidate"}\n');
      const entered = deferred();
      const release = deferred();
      const firstEvents = [];
      const firstHelper = signingModule(firstEvents);
      const assess = firstHelper.assessNotarizedPackage;
      firstHelper.assessNotarizedPackage = async (...args) => {
        entered.resolve();
        await release.promise;
        return assess(...args);
      };
      const first = buildOopUpdatePkg(
        { dmg, sha256: DMG_SHA256, version: VERSION, output, signingMode: "developer-id" },
        {
          repoRoot,
          env: {},
          loadSigning: async () => firstHelper,
          run: fakePackageRunner(firstEvents),
          inspectApp: async () => APP_METADATA,
          readAsar: async () =>
            Buffer.from("OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:" + POLICY.leafPins[0]),
        },
      );
      try {
        await entered.promise;
        const lock = NodePath.join(outputRoot, CANDIDATE_LOCK);
        NodeAssert.ok((await NodeFSP.stat(lock)).isDirectory());
        const held = await snapshot(outputRoot);
        const secondEvents = [];
        await NodeAssert.rejects(
          buildOopUpdatePkg(
            { dmg, sha256: DMG_SHA256, version: VERSION, output, signingMode: "developer-id" },
            {
              repoRoot,
              env: {},
              loadSigning: async () => signingModule(secondEvents),
              run: fakePackageRunner(secondEvents),
              inspectApp: async () => APP_METADATA,
            },
          ),
          /Another signed candidate build may be running/u,
        );
        NodeAssert.deepEqual(secondEvents, []);
        NodeAssert.deepEqual(await snapshot(outputRoot), held);
      } finally {
        release.resolve();
        await first.catch(() => {});
      }
      await first;
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(outputRoot, CANDIDATE_LOCK)), {
        code: "ENOENT",
      });
      NodeAssert.equal(await NodeFSP.readFile(output, "utf8"), "stapled package bytes");
    });
  },
);

NodeTest.test(
  "signed candidate failure preserves an existing same-target package and both sidecars",
  async () => {
    for (const failure of [
      "app requirement",
      "embedded",
      "productbuild",
      "unsigned binding",
      "sign",
      "signed binding",
      "notarize",
      "assess",
      "final binding",
      "post-hash mutation",
    ]) {
      await withCandidateFixture(async ({ repoRoot, dmg, outputRoot, output }) => {
        await NodeFSP.writeFile(output, "old candidate package");
        await NodeFSP.writeFile(`${output}.sha256`, "old candidate digest\n");
        await NodeFSP.writeFile(`${output}.json`, '{"old":"candidate"}\n');
        const before = await snapshot(outputRoot);
        const events = [];
        let bindingReads = 0;
        const run = fakePackageRunner(events, {
          bindingRead: (_path, distribution) => {
            bindingReads += 1;
            if (
              (failure === "unsigned binding" && bindingReads === 1) ||
              (failure === "signed binding" && bindingReads === 2) ||
              (failure === "final binding" && bindingReads === 3)
            ) {
              return distribution.replace(`version="${VERSION}"`, 'version="0.0.57"');
            }
            return distribution;
          },
        });
        const failingRun = async (command, args, ...rest) => {
          if (
            failure === "app requirement" &&
            command.endsWith("codesign") &&
            args.some((arg) => arg.startsWith("-R="))
          )
            throw new Error("app requirement failed");
          if (failure === "productbuild" && command.endsWith("productbuild"))
            throw new Error("productbuild failed");
          return run(command, args, ...rest);
        };
        const helper = signingModule(events, {
          failAt: failure,
          mutateAtAssess: failure === "post-hash mutation",
        });
        await NodeAssert.rejects(
          buildOopUpdatePkg(
            { dmg, sha256: DMG_SHA256, version: VERSION, output, signingMode: "developer-id" },
            {
              repoRoot,
              env: {},
              loadSigning: async () => helper,
              run: failingRun,
              inspectApp: async () => APP_METADATA,
              readAsar: async () =>
                Buffer.from("OOP_LOCAL_PKG_TRUST_V1:developer-id:ABCDE12345:" + POLICY.leafPins[0]),
            },
          ),
        );
        NodeAssert.deepEqual(await snapshot(outputRoot), before, failure);
        await NodeAssert.rejects(NodeFSP.stat(NodePath.join(outputRoot, CANDIDATE_LOCK)), {
          code: "ENOENT",
        });
      });
    }
  },
);
