import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { macUpdatePkgName } from "./oop-release-names.mjs";

import {
  buildOopUpdatePkg,
  componentPlist,
  distributionXml,
  localUpdateFeed,
  parseArgs,
  postinstallScript,
  preinstallScript,
  pruneOldReleases,
  releaseArtifactsToPrune,
  run,
  targetProcessCheck,
  validateAppMetadata,
  welcomeHtml,
} from "./build-oop-update-pkg.mjs";
import {
  hasReleaseBinding,
  releaseProductElement,
} from "../apps/desktop/src/updates/LocalPkgReleaseBinding.ts";

const validMetadata = {
  identifier: "com.t3tools.t3code",
  name: "OOP",
  executable: "OOP",
  version: "0.0.45",
  architectures: ["arm64"],
  oopProfileEmbedded: true,
};

const fakeToc = (distribution) =>
  `<xar><toc><file><data><extracted-checksum style="sha1">${NodeCrypto.createHash("sha1").update(distribution).digest("hex")}</extracted-checksum></data></file></toc></xar>`;

NodeTest.test(
  "accepts only a complete local DMG, trusted digest, version, and package path",
  () => {
    const digest = "a".repeat(64);
    NodeAssert.deepEqual(
      parseArgs([
        "--dmg",
        "input.dmg",
        "--sha256",
        digest,
        "--version",
        "0.0.45",
        "--output",
        "update.pkg",
      ]),
      {
        dmg: NodePath.resolve("input.dmg"),
        sha256: digest,
        version: "0.0.45",
        output: NodePath.resolve("update.pkg"),
      },
    );
    NodeAssert.throws(
      () => parseArgs(["--dmg", "input.dmg", "--sha256", digest]),
      /Expected one DMG/,
    );
    NodeAssert.throws(
      () =>
        parseArgs([
          "--dmg",
          "input.dmg",
          "--sha256",
          digest,
          "--version",
          "0.0.45;rm",
          "--output",
          "update.pkg",
        ]),
      /Expected one DMG/,
    );
    NodeAssert.throws(
      () =>
        parseArgs([
          "--dmg",
          "input.dmg",
          "--sha256",
          digest,
          "--version",
          "0.0.45",
          "--output",
          "update.pkg",
          "--output",
          "other.pkg",
        ]),
      /Usage/,
    );
  },
);

NodeTest.test(
  "Installer metadata replaces exact OOP bundle at system location and preserves repair installs",
  () => {
    const component = componentPlist();
    for (const expected of [
      "Applications/OOP.app",
      "BundleIsRelocatable</key><false/>",
      "BundleIsVersionChecked</key><false/>",
      "BundleHasStrictIdentifier</key><true/>",
      "BundleOverwriteAction</key><string>upgrade</string>",
    ]) {
      NodeAssert.ok(component.includes(expected));
    }
    const distribution = distributionXml("0.0.45");
    NodeAssert.match(
      distribution,
      /enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/u,
    );
    NodeAssert.match(distribution, /<welcome file="welcome\.html"\/>/u);
    NodeAssert.match(distribution, /<options [^>]*hostArchitectures="arm64"/u);
    NodeAssert.match(distribution, /<title>OOP 0\.0\.45 설치<\/title>/u);
    NodeAssert.equal(distribution.split("<product").length, 2);
    NodeAssert.ok(distribution.includes(releaseProductElement("0.0.45")));
    NodeAssert.equal(hasReleaseBinding(distribution, "0.0.45"), true);
    NodeAssert.equal(hasReleaseBinding(distribution, "0.0.44"), false);
    NodeAssert.equal(
      hasReleaseBinding(distribution + releaseProductElement("0.0.45"), "0.0.45"),
      false,
    );
    NodeAssert.match(welcomeHtml(), /<html lang="ko">/u);
    NodeAssert.match(welcomeHtml(), /\/Applications\/OOP\.app/u);
    NodeAssert.doesNotMatch(welcomeHtml(), /<product/u);
    const preinstall = preinstallScript("0.0.45");
    NodeAssert.ok(preinstall.includes(targetProcessCheck()));
    NodeAssert.match(preinstall, /pids=\$\(\/usr\/bin\/pgrep -x "\$exe"\) \|\| rc=\$\?/u);
    NodeAssert.doesNotMatch(preinstall, /pgrep -x "\$exe"\) \|\| true/u);
    NodeAssert.match(preinstall, /\$\(\/bin\/ps -o comm= -p "\$pid"/u);
    NodeAssert.match(preinstall, /targetExe="\$target\/Contents\/MacOS\/\$exe"/u);
    NodeAssert.doesNotMatch(preinstall, /pgrep -x "\$exe" >\/dev\/null/u);
    NodeAssert.match(preinstall, /\/Updates/u);
    NodeAssert.match(preinstall, /stat -f %u/u);
    NodeAssert.match(preinstall, /stat -f %Lp/u);
    NodeAssert.match(preinstall, /com\.t3tools\.t3code/u);
    NodeAssert.doesNotMatch(preinstall, /pkill|killall|osascript|\bkill\b/u);
    const postinstall = postinstallScript("0.0.45");
    NodeAssert.match(postinstall, /codesign --verify --deep --strict/u);
    NodeAssert.match(postinstall, /xattr -d -r com\.apple\.quarantine "\$target"/u);
    NodeAssert.match(postinstall, /\$version" != '0\.0\.45'/u);
  },
);

const targetExecutable = "/Applications/OOP.app/Contents/MacOS/OOP";
const isolatedExecutable = "/tmp/oop-ui049/OOP.app/Contents/MacOS/OOP";
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Runs the real fragment under `set -eu` with fake pgrep/ps. `processes` maps PID to the executable path
// ps reports, or null when ps fails for it. `pgrepResults` is one `{ exit, pids }` per pgrep call; by default
// the first call lists every PID and each recheck finds nothing (the null processes really exited). A call past
// the end exits 99. Every run also asserts pgrep ran at most once plus once per ps failure, always as `-x OOP`.
async function runTargetProcessCheck(processes, pgrepResults) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-proc-check-"));
  try {
    const [pgrep, ps, driver, callLog] = ["pgrep", "ps", "check.sh", "pgrep.calls"].map((name) =>
      NodePath.join(root, name),
    );
    const pids = Object.keys(processes);
    const psFailures = pids.filter((pid) => processes[pid] === null).length;
    const sequence = pgrepResults ?? [
      { exit: pids.length === 0 ? 1 : 0, pids },
      ...Array.from({ length: psFailures }, () => ({ exit: 1, pids: [] })),
    ];
    const results = sequence
      .map(
        (call, index) =>
          `${index + 1}) ${call.pids.length === 0 ? "" : `printf '%s\\n' ${call.pids.join(" ")}; `}exit ${call.exit} ;;`,
      )
      .join("\n");
    const lookups = pids
      .map(
        (pid) =>
          `${pid}) ${processes[pid] === null ? "exit 1" : `printf '%s\\n' ${shellQuote(processes[pid])}`} ;;`,
      )
      .join("\n");
    await NodeFSP.writeFile(
      pgrep,
      `#!/bin/sh\necho "$*" >> ${shellQuote(callLog)}\nn=$(wc -l < ${shellQuote(callLog)})\ncase $((n)) in\n${results}\n*) exit 99 ;;\nesac\n`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(
      ps,
      `#!/bin/sh\n[ "$1 $2 $3" = '-o comm= -p' ] || exit 2\ncase "$4" in\n${lookups}\n*) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(
      driver,
      `#!/bin/sh\nset -eu\ntarget=/Applications/OOP.app\nexe=OOP\n${targetProcessCheck({ pgrep, ps })}echo passed\n`,
    );
    const result = NodeChildProcess.spawnSync("/bin/sh", [driver], { encoding: "utf8" });
    const pgrepCalls = (await NodeFSP.readFile(callLog, "utf8")).split("\n").filter(Boolean);
    NodeAssert.ok(
      pgrepCalls.length >= 1 && pgrepCalls.length <= 1 + psFailures,
      `pgrep called ${pgrepCalls.length} times for ${psFailures} ps failures`,
    );
    NodeAssert.ok(
      pgrepCalls.every((args) => args === "-x OOP"),
      pgrepCalls.join("\n"),
    );
    return Object.assign(result, { pgrepCalls });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

NodeTest.test(
  "process check passes without OOP, for a copy elsewhere, or for a process that already exited",
  async () => {
    for (const processes of [
      {},
      { 4101: isolatedExecutable },
      { 4101: "/tmp/OOP copy.app/Contents/MacOS/OOP" },
      { 4102: null },
      { 4101: isolatedExecutable, 4102: null },
    ]) {
      const result = await runTargetProcessCheck(processes);
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.equal(result.stdout, "passed\n");
      NodeAssert.equal(result.stderr, "");
    }
  },
);

NodeTest.test(
  "process check blocks only the target executable and logs each blocking PID and path",
  async () => {
    const result = await runTargetProcessCheck({
      4101: isolatedExecutable,
      4102: targetExecutable,
      4103: targetExecutable,
    });
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(result.stdout, "");
    NodeAssert.ok(result.stderr.includes(`(pid 4102, ${targetExecutable})`));
    NodeAssert.ok(result.stderr.includes(`(pid 4103, ${targetExecutable})`));
    NodeAssert.doesNotMatch(result.stderr, /4101/u);
    NodeAssert.match(result.stderr, /Cmd\+Q/u);
  },
);

NodeTest.test(
  "process check blocks when ps does not give an absolute executable path",
  async () => {
    for (const comm of ["OOP", ""]) {
      const result = await runTargetProcessCheck({ 4104: comm });
      NodeAssert.equal(result.status, 1);
      NodeAssert.equal(result.stdout, "");
      NodeAssert.ok(
        result.stderr.includes(`pid 4104 has an unverifiable executable path '${comm}'`),
      );
    }
  },
);

NodeTest.test("process check blocks when pgrep itself fails, without asking again", async () => {
  for (const exit of [2, 3]) {
    const result = await runTargetProcessCheck({}, [{ exit, pids: [] }]);
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(result.stdout, "");
    NodeAssert.ok(result.stderr.includes(`pgrep exit ${exit}`));
    NodeAssert.equal(result.pgrepCalls.length, 1);
  }
});

NodeTest.test(
  "process check rechecks a PID ps cannot read and passes only once it is gone",
  async () => {
    for (const recheck of [
      { exit: 0, pids: [4101] },
      { exit: 1, pids: [] },
      { exit: 0, pids: [41020] },
    ]) {
      const result = await runTargetProcessCheck({ 4102: null }, [
        { exit: 0, pids: [4102] },
        recheck,
      ]);
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.equal(result.stdout, "passed\n");
      NodeAssert.equal(result.stderr, "");
      NodeAssert.equal(result.pgrepCalls.length, 2);
    }
  },
);

NodeTest.test(
  "process check blocks when a PID ps cannot read is still listed or the recheck fails",
  async () => {
    for (const recheck of [[4102], [41020, 4102, 4103]]) {
      const result = await runTargetProcessCheck({ 4102: null }, [
        { exit: 0, pids: [4102] },
        { exit: 0, pids: recheck },
      ]);
      NodeAssert.equal(result.status, 1);
      NodeAssert.equal(result.stdout, "");
      NodeAssert.ok(result.stderr.includes("pid 4102 is still running but ps could not read it"));
      NodeAssert.match(result.stderr, /Cmd\+Q/u);
      NodeAssert.equal(result.pgrepCalls.length, 2);
    }
    const failed = await runTargetProcessCheck({ 4102: null }, [
      { exit: 0, pids: [4102] },
      { exit: 3, pids: [] },
    ]);
    NodeAssert.equal(failed.status, 1);
    NodeAssert.equal(failed.stdout, "");
    NodeAssert.ok(failed.stderr.includes("pgrep exit 3"));
    NodeAssert.equal(failed.pgrepCalls.length, 2);
  },
);

NodeTest.test(
  "process check keeps blocking a readable target when another PID's ps failure is cleared",
  async () => {
    const result = await runTargetProcessCheck({ 4102: null, 4103: targetExecutable }, [
      { exit: 0, pids: [4102, 4103] },
      { exit: 0, pids: [4103] },
    ]);
    NodeAssert.equal(result.status, 1);
    NodeAssert.equal(result.stdout, "");
    NodeAssert.ok(result.stderr.includes(`(pid 4103, ${targetExecutable})`));
    NodeAssert.doesNotMatch(result.stderr, /4102/u);
  },
);

NodeTest.test(
  "process check only accepts plain absolute tool paths, and installer scripts parse as sh",
  async () => {
    NodeAssert.throws(() => targetProcessCheck({ pgrep: "pgrep" }), /Invalid process tool path/u);
    NodeAssert.throws(
      () => targetProcessCheck({ ps: "/bin/ps; rm -rf /" }),
      /Invalid process tool path/u,
    );
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-sh-syntax-"));
    try {
      for (const [name, script] of [
        ["preinstall", preinstallScript("0.0.52")],
        ["postinstall", postinstallScript("0.0.52")],
      ]) {
        const file = NodePath.join(root, name);
        await NodeFSP.writeFile(file, script);
        const result = NodeChildProcess.spawnSync("/bin/sh", ["-n", file], { encoding: "utf8" });
        NodeAssert.equal(result.status, 0, `${name}: ${result.stderr}`);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "rejects wrong product, architecture, version, or missing embedded OOP profile",
  () => {
    validateAppMetadata(validMetadata, "0.0.45");
    for (const invalid of [
      { ...validMetadata, name: "T3 Code" },
      { ...validMetadata, identifier: "other.bundle" },
      { ...validMetadata, version: "0.0.44" },
      { ...validMetadata, architectures: ["x64"] },
      { ...validMetadata, oopProfileEmbedded: false },
    ]) {
      NodeAssert.throws(() => validateAppMetadata(invalid, "0.0.45"));
    }
  },
);

NodeTest.test("the feed keeps the legacy OoP package name through 0.0.110, then uses OOP", () => {
  const sha256 = "a".repeat(64);
  NodeAssert.equal(macUpdatePkgName("0.0.110"), "OoP-0.0.110-arm64-update.pkg");
  NodeAssert.equal(macUpdatePkgName("0.0.111"), "OOP-0.0.111-arm64-update.pkg");
  NodeAssert.equal(macUpdatePkgName("0.1.0"), "OOP-0.1.0-arm64-update.pkg");
  NodeAssert.equal(
    localUpdateFeed("0.0.111", "OOP-0.0.111-arm64-update.pkg", 100, sha256).pkg,
    "OOP-0.0.111-arm64-update.pkg",
  );
  NodeAssert.throws(() => localUpdateFeed("0.0.111", "OoP-0.0.111-arm64-update.pkg", 100, sha256));
  NodeAssert.throws(() => localUpdateFeed("0.0.110", "OOP-0.0.110-arm64-update.pkg", 100, sha256));
});

NodeTest.test("local update feed requires exact versioned arm64 package metadata", () => {
  const sha256 = "a".repeat(64);
  NodeAssert.deepEqual(localUpdateFeed("0.0.50", "OoP-0.0.50-arm64-update.pkg", 100, sha256), {
    schemaVersion: 1,
    platform: "darwin",
    arch: "arm64",
    version: "0.0.50",
    pkg: "OoP-0.0.50-arm64-update.pkg",
    size: 100,
    sha256,
  });
  for (const [version, pkg, size, digest] of [
    ["0.0.50", "OoP-0.0.49-arm64-update.pkg", 100, sha256],
    ["0.0.50", "../OoP-0.0.50-arm64-update.pkg", 100, sha256],
    ["0.0.50", "OoP-0.0.50-arm64-update.pkg", 0, sha256],
    ["0.0.50", "OoP-0.0.50-arm64-update.pkg", 1024 ** 3 + 1, sha256],
    ["0.0.50", "OoP-0.0.50-arm64-update.pkg", 100, "A".repeat(64)],
    ["0.00.50", "OoP-0.00.50-arm64-update.pkg", 100, sha256],
    ["9007199254740992.0.50", "OoP-9007199254740992.0.50-arm64-update.pkg", 100, sha256],
  ])
    NodeAssert.throws(
      () => localUpdateFeed(version, pkg, size, digest),
      /Invalid local OOP update package metadata/u,
    );
});

NodeTest.test("verified DMG becomes a package with a hash-bound, scoped manifest", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-pkg-test-"));
  try {
    const dmg = NodePath.join(root, "OOP.dmg");
    const output = NodePath.join(root, "OOP-0.0.45-update.pkg");
    await NodeFSP.writeFile(dmg, "trusted image fixture");
    const sha256 = NodeCrypto.createHash("sha256").update("trusted image fixture").digest("hex");
    const calls = [];
    const shipped = {};
    const fakeRun = async (command, args, timeout) => {
      calls.push({ command, args, timeout });
      if (command.endsWith("pkgbuild"))
        shipped.preinstall = await NodeFSP.readFile(
          NodePath.join(args[args.indexOf("--scripts") + 1], "preinstall"),
          "utf8",
        );
      if (command.endsWith("productbuild")) {
        shipped.distribution = await NodeFSP.readFile(
          args[args.indexOf("--distribution") + 1],
          "utf8",
        );
        shipped.welcome = await NodeFSP.readFile(
          NodePath.join(args[args.indexOf("--resources") + 1], "welcome.html"),
          "utf8",
        );
        shipped.builtProduct = args.at(-1);
      }
      if (command === "/usr/bin/tar")
        return args[0] === "-t" ? "Distribution\n" : shipped.distribution;
      if (command === "/usr/bin/xar") return fakeToc(shipped.distribution);
      if (command.endsWith("hdiutil") && args[0] === "attach") {
        const mount = args[args.indexOf("-mountpoint") + 1];
        await NodeFSP.mkdir(NodePath.join(mount, "OOP.app"), { recursive: true });
        return "<plist>attached</plist>";
      }
      if (command.endsWith("plutil") && args[0] === "-convert") {
        const mount = calls
          .find((call) => call.command.endsWith("hdiutil") && call.args[0] === "attach")
          .args.at(-2);
        return JSON.stringify({
          "system-entities": [{ "mount-point": mount, "dev-entry": "/dev/disk99s1" }],
        });
      }
      if (command.endsWith("ditto")) await NodeFSP.cp(args[0], args[1], { recursive: true });
      if (command.endsWith("pkgbuild") || command.endsWith("productbuild"))
        await NodeFSP.writeFile(args.at(-1), "package bytes");
      return "";
    };
    const manifest = await buildOopUpdatePkg(
      { dmg, sha256, version: "0.0.45", output },
      { run: fakeRun, inspectApp: async () => validMetadata },
    );
    NodeAssert.equal(manifest.inputDmgSha256, sha256);
    NodeAssert.equal(
      manifest.packageSha256,
      NodeCrypto.createHash("sha256").update("package bytes").digest("hex"),
    );
    NodeAssert.match(manifest.validation, /app usability not verified/u);
    NodeAssert.equal(await NodeFSP.readFile(output, "utf8"), "package bytes");
    NodeAssert.match(
      await NodeFSP.readFile(`${output}.sha256`, "utf8"),
      new RegExp(manifest.packageSha256),
    );
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(root, "oop-update.json")), {
      code: "ENOENT",
    });
    NodeAssert.ok(
      calls.some(
        (call) =>
          call.command.endsWith("pkgbuild") &&
          call.args.includes("--component-plist") &&
          call.args.includes("--root"),
      ),
    );
    NodeAssert.ok(
      calls.some(
        (call) => call.command.endsWith("productbuild") && call.args.includes("--resources"),
      ),
    );
    const productBuildIndex = calls.findIndex((call) => call.command.endsWith("productbuild"));
    NodeAssert.deepEqual(
      calls
        .slice(productBuildIndex + 1, productBuildIndex + 4)
        .map(({ command, args }) => ({ command, args })),
      [
        { command: "/usr/bin/tar", args: ["-t", "-f", shipped.builtProduct, "--", "Distribution"] },
        {
          command: "/usr/bin/tar",
          args: ["-x", "-O", "-f", shipped.builtProduct, "--", "Distribution"],
        },
        { command: "/usr/bin/xar", args: ["--dump-toc=/dev/stdout", "-f", shipped.builtProduct] },
      ],
    );
    NodeAssert.ok(
      calls.some(
        (call) =>
          call.command.endsWith("hdiutil") &&
          call.args[0] === "detach" &&
          call.args[1] === "/dev/disk99s1",
      ),
    );
    NodeAssert.ok(calls.every((call) => call.timeout > 0));
    NodeAssert.deepEqual(shipped, {
      preinstall: preinstallScript("0.0.45"),
      distribution: distributionXml("0.0.45"),
      welcome: welcomeHtml(),
      builtProduct: shipped.builtProduct,
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "canonical package publishes an exact feed last, while failed or same-version rebuild preserves it",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-feed-test-"));
    try {
      const dmg = NodePath.join(root, "OOP.dmg");
      const output = NodePath.join(root, "OoP-0.0.50-arm64-update.pkg");
      const feedPath = NodePath.join(root, "oop-update.json");
      await NodeFSP.writeFile(dmg, "trusted image fixture");
      const sha256 = NodeCrypto.createHash("sha256").update("trusted image fixture").digest("hex");
      const oldFeed = {
        schemaVersion: 1,
        platform: "darwin",
        arch: "arm64",
        version: "0.0.49",
        pkg: "OoP-0.0.49-arm64-update.pkg",
        size: 3,
        sha256: "b".repeat(64),
      };
      await NodeFSP.writeFile(feedPath, JSON.stringify(oldFeed));
      const calls = [];
      let mount;
      let builtDistribution;
      const fakeRun = async (command, args) => {
        calls.push(args[0]);
        if (command.endsWith("hdiutil") && args[0] === "attach") {
          mount = args[args.indexOf("-mountpoint") + 1];
          await NodeFSP.mkdir(NodePath.join(mount, "OOP.app"));
          return "<plist>attached</plist>";
        }
        if (command.endsWith("plutil") && args[0] === "-convert") {
          return JSON.stringify({
            "system-entities": [{ "mount-point": mount, "dev-entry": "/dev/disk99s1" }],
          });
        }
        if (command.endsWith("ditto")) await NodeFSP.cp(args[0], args[1], { recursive: true });
        if (command.endsWith("productbuild"))
          builtDistribution = await NodeFSP.readFile(
            args[args.indexOf("--distribution") + 1],
            "utf8",
          );
        if (command === "/usr/bin/tar")
          return args[0] === "-t" ? "Distribution\n" : builtDistribution;
        if (command === "/usr/bin/xar") return fakeToc(builtDistribution);
        if (command.endsWith("pkgbuild") || command.endsWith("productbuild"))
          await NodeFSP.writeFile(args.at(-1), "package bytes");
        return "";
      };
      const input = { dmg, sha256, version: "0.0.50", output };
      const manifest = await buildOopUpdatePkg(input, {
        run: fakeRun,
        inspectApp: async () => ({ ...validMetadata, version: "0.0.50" }),
      });
      const feed = JSON.parse(await NodeFSP.readFile(feedPath, "utf8"));
      NodeAssert.deepEqual(
        feed,
        localUpdateFeed(
          "0.0.50",
          NodePath.basename(output),
          Buffer.byteLength("package bytes"),
          manifest.packageSha256,
        ),
      );
      NodeAssert.equal(await NodeFSP.readFile(output, "utf8"), "package bytes");
      NodeAssert.match(await NodeFSP.readFile(`${output}.sha256`, "utf8"), new RegExp(feed.sha256));
      NodeAssert.equal(
        JSON.parse(await NodeFSP.readFile(`${output}.json`, "utf8")).packageSha256,
        feed.sha256,
      );
      const callCount = calls.length;
      await NodeAssert.rejects(buildOopUpdatePkg(input, { run: fakeRun }), /already published/u);
      NodeAssert.equal(calls.length, callCount);
      for (const invalidVersion of ["0.00.50", "9007199254740992.0.50"]) {
        await NodeAssert.rejects(
          buildOopUpdatePkg(
            {
              ...input,
              version: invalidVersion,
              output: NodePath.join(root, macUpdatePkgName(invalidVersion)),
            },
            { run: fakeRun },
          ),
          /Invalid stable OOP update feed version/u,
        );
        NodeAssert.equal(calls.length, callCount);
      }
      const nextOutput = NodePath.join(root, "OoP-0.0.51-arm64-update.pkg");
      await NodeAssert.rejects(
        buildOopUpdatePkg(
          { ...input, version: "0.0.51", output: nextOutput },
          {
            run: async (command, args, timeout) => {
              if (command.endsWith("productbuild")) throw new Error("productbuild failed");
              return fakeRun(command, args, timeout);
            },
            inspectApp: async () => ({ ...validMetadata, version: "0.0.51" }),
          },
        ),
        /productbuild failed/u,
      );
      NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(feedPath, "utf8")), feed);
      await NodeAssert.rejects(NodeFSP.stat(nextOutput), { code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "bad input hash, partial attach, or bad signature cannot publish a successful package",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-pkg-fail-"));
    try {
      const dmg = NodePath.join(root, "OOP.dmg");
      const output = NodePath.join(root, "OOP-update.pkg");
      await NodeFSP.writeFile(dmg, "image");
      const sha256 = NodeCrypto.createHash("sha256").update("image").digest("hex");
      await NodeAssert.rejects(
        buildOopUpdatePkg({ dmg, sha256: "0".repeat(64), version: "0.0.45", output }),
        /trusted digest/u,
      );
      const calls = [];
      await NodeAssert.rejects(
        buildOopUpdatePkg(
          { dmg, sha256, version: "0.0.45", output },
          {
            run: async (command, args) => {
              calls.push(args[0]);
              if (command.endsWith("hdiutil") && args[0] === "attach")
                throw new Error("partial attach");
              return "";
            },
          },
        ),
        /partial attach/u,
      );
      NodeAssert.deepEqual(calls, ["verify", "attach", "detach"]);
      const signatureCalls = [];
      await NodeAssert.rejects(
        buildOopUpdatePkg(
          { dmg, sha256, version: "0.0.45", output },
          {
            run: async (command, args) => {
              signatureCalls.push(args[0]);
              if (command.endsWith("hdiutil") && args[0] === "attach") {
                const mount = args[args.indexOf("-mountpoint") + 1];
                signatureCalls.mount = mount;
                await NodeFSP.mkdir(NodePath.join(mount, "OOP.app"));
                return "<plist>attached</plist>";
              }
              if (command.endsWith("plutil") && args[0] === "-convert") {
                const mount = signatureCalls.mount;
                return JSON.stringify({
                  "system-entities": [{ "mount-point": mount, "dev-entry": "/dev/disk99s1" }],
                });
              }
              if (command.endsWith("codesign")) throw new Error("invalid app seal");
              return "";
            },
          },
        ),
        /invalid app seal/u,
      );
      NodeAssert.ok(signatureCalls.includes("detach"));
      await NodeAssert.rejects(NodeFSP.stat(`${output}.json`), { code: "ENOENT" });
      await NodeAssert.rejects(NodeFSP.stat(output), { code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("timed-out child that exits zero still fails the package command", async () => {
  await NodeAssert.rejects(
    run(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      400,
    ),
    /timed out/u,
  );
});

const fixtureSha256 = NodeCrypto.createHash("sha256").update("trusted image fixture").digest("hex");
const lockName = ".oop-update-publish.lock";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Gives a test a fresh DMG and an output directory that does not exist yet; the directory holds the
// feed, packages, and publish lock.
async function withPublishDir(body) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-publish-test-"));
  try {
    const dmg = NodePath.join(root, "OOP.dmg");
    const outDir = NodePath.join(root, "out");
    await NodeFSP.writeFile(dmg, "trusted image fixture");
    await body({
      dmg,
      outDir,
      feedPath: NodePath.join(outDir, "oop-update.json"),
      lockPath: NodePath.join(outDir, lockName),
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

// Starts the real buildOopUpdatePkg with fake packaging tools that create the files the real ones would.
// `hook(command, args)` runs first on every tool call so a test can block or fail a chosen step; `calls` lists them.
function startBuild(
  { dmg, outDir },
  version,
  {
    output = NodePath.join(outDir, macUpdatePkgName(version)),
    hook,
    tarList = "Distribution\n",
    tarDistribution,
  } = {},
) {
  const calls = [];
  let mount;
  let builtDistribution;
  const fakeRun = async (command, args) => {
    calls.push(`${NodePath.basename(command)} ${args[0]}`);
    await hook?.(command, args);
    if (command.endsWith("hdiutil") && args[0] === "attach") {
      mount = args[args.indexOf("-mountpoint") + 1];
      await NodeFSP.mkdir(NodePath.join(mount, "OOP.app"));
      return "<plist>attached</plist>";
    }
    if (command.endsWith("plutil") && args[0] === "-convert") {
      return JSON.stringify({
        "system-entities": [{ "mount-point": mount, "dev-entry": "/dev/disk99s1" }],
      });
    }
    if (command.endsWith("ditto")) await NodeFSP.cp(args[0], args[1], { recursive: true });
    if (command.endsWith("productbuild"))
      builtDistribution = await NodeFSP.readFile(args[args.indexOf("--distribution") + 1], "utf8");
    if (command === "/usr/bin/tar")
      return args[0] === "-t" ? tarList : (tarDistribution ?? builtDistribution);
    if (command === "/usr/bin/xar") return fakeToc(builtDistribution);
    if (command.endsWith("pkgbuild") || command.endsWith("productbuild"))
      await NodeFSP.writeFile(args.at(-1), "package bytes");
    return "";
  };
  const result = buildOopUpdatePkg(
    { dmg, sha256: fixtureSha256, version, output },
    { run: fakeRun, inspectApp: async () => ({ ...validMetadata, version }) },
  );
  return { calls, result };
}

// A published version: its package, both sidecars, and the exact feed pointing at it.
async function seedPublished({ outDir, feedPath }, version) {
  const pkg = macUpdatePkgName(version);
  const bytes = `published ${version}`;
  await NodeFSP.mkdir(outDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outDir, pkg), bytes);
  await NodeFSP.writeFile(NodePath.join(outDir, `${pkg}.sha256`), `sha ${version}\n`);
  await NodeFSP.writeFile(NodePath.join(outDir, `${pkg}.json`), `{"seeded":"${version}"}\n`);
  const feed = localUpdateFeed(
    version,
    pkg,
    Buffer.byteLength(bytes),
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  );
  await NodeFSP.writeFile(feedPath, JSON.stringify(feed, null, 2) + "\n");
  return feed;
}

// Every entry of the output directory with its content, so equal snapshots prove nothing was created,
// changed, or left behind (temp files, locks).
async function snapshot(dir) {
  const entries = {};
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
    entries[entry.name] = entry.isFile()
      ? await NodeFSP.readFile(NodePath.join(dir, entry.name), "utf8")
      : "<dir>";
  }
  return entries;
}

const readFeed = async (feedPath) => JSON.parse(await NodeFSP.readFile(feedPath, "utf8"));
const leftovers = (entries) =>
  Object.keys(entries).filter((name) => name === lockName || name.includes(".tmp"));

NodeTest.test(
  "local update feed rejects non-string versions and digests that coerce to valid ones",
  () => {
    const sha256 = "a".repeat(64);
    NodeAssert.throws(
      () => localUpdateFeed(["0.0.50"], "OoP-0.0.50-arm64-update.pkg", 100, sha256),
      /Invalid local OOP update package metadata/u,
    );
    NodeAssert.throws(
      () => localUpdateFeed("0.0.50", "OoP-0.0.50-arm64-update.pkg", 100, [sha256]),
      /Invalid local OOP update package metadata/u,
    );
  },
);

NodeTest.test(
  "canonical publish only moves the feed forward: newer publishes, then equal and older are rejected untouched",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      const manifest = await startBuild(dir, "0.0.59").result;
      NodeAssert.deepEqual(
        await readFeed(dir.feedPath),
        localUpdateFeed(
          "0.0.59",
          "OoP-0.0.59-arm64-update.pkg",
          Buffer.byteLength("package bytes"),
          manifest.packageSha256,
        ),
      );
      const published = await snapshot(dir.outDir);
      NodeAssert.equal(published["OoP-0.0.58-arm64-update.pkg"], "published 0.0.58");
      NodeAssert.deepEqual(leftovers(published), []);
      for (const version of ["0.0.59", "0.0.58"]) {
        const rejected = startBuild(dir, version);
        await NodeAssert.rejects(
          rejected.result,
          /already published or older than the published feed version 0\.0\.59/u,
        );
        NodeAssert.deepEqual(rejected.calls, []);
        NodeAssert.deepEqual(await snapshot(dir.outDir), published);
      }
    });
  },
);

NodeTest.test("canonical publish compares versions numerically, not as strings", async () => {
  for (const [current, next, allowed] of [
    ["0.0.9", "0.0.10", true],
    ["0.0.99", "0.1.0", true],
    ["0.99.99", "1.0.0", true],
    ["0.0.10", "0.0.9", false],
    ["0.1.0", "0.0.99", false],
  ]) {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, current);
      const build = startBuild(dir, next);
      if (allowed) {
        await build.result;
        NodeAssert.equal((await readFeed(dir.feedPath)).version, next);
      } else {
        await NodeAssert.rejects(build.result, /already published or older/u);
        NodeAssert.deepEqual(build.calls, []);
        NodeAssert.equal((await readFeed(dir.feedPath)).version, current);
      }
    });
  }
});

NodeTest.test(
  "a published feed that is not an exact local update feed fails closed before any mutation",
  async () => {
    await withPublishDir(async (dir) => {
      const good = await seedPublished(dir, "0.0.58");
      const variants = [
        "not json",
        "null",
        "[]",
        "58",
        JSON.stringify({ ...good, extra: true }),
        JSON.stringify(Object.fromEntries(Object.entries(good).filter(([key]) => key !== "size"))),
        JSON.stringify({ ...good, schemaVersion: 2 }),
        JSON.stringify({ ...good, platform: "linux" }),
        JSON.stringify({ ...good, arch: "x64" }),
        JSON.stringify({ ...good, version: ["0.0.58"] }),
        JSON.stringify({ ...good, version: "0.00.58", pkg: "OoP-0.00.58-arm64-update.pkg" }),
        JSON.stringify({ ...good, pkg: "OoP-0.0.57-arm64-update.pkg" }),
        JSON.stringify({ ...good, size: "3" }),
        JSON.stringify({ ...good, sha256: [good.sha256] }),
        JSON.stringify({ ...good, sha256: good.sha256.toUpperCase() }),
      ];
      for (const text of variants) {
        await NodeFSP.writeFile(dir.feedPath, text);
        const before = await snapshot(dir.outDir);
        const rejected = startBuild(dir, "0.0.59");
        await NodeAssert.rejects(rejected.result, /not an exact local update feed/u, text);
        NodeAssert.deepEqual(rejected.calls, [], text);
        NodeAssert.deepEqual(await snapshot(dir.outDir), before, text);
      }
      await NodeFSP.rm(dir.feedPath);
      await NodeFSP.mkdir(dir.feedPath);
      const before = await snapshot(dir.outDir);
      const unreadable = startBuild(dir, "0.0.59");
      await NodeAssert.rejects(unreadable.result, { code: "EISDIR" });
      NodeAssert.deepEqual(unreadable.calls, []);
      NodeAssert.deepEqual(await snapshot(dir.outDir), before);
    });
  },
);

NodeTest.test(
  "an existing publish lock blocks the build, stays in place, and nothing is mutated",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      await NodeFSP.mkdir(dir.lockPath);
      const before = await snapshot(dir.outDir);
      NodeAssert.equal(before[lockName], "<dir>");
      const blocked = startBuild(dir, "0.0.59");
      await NodeAssert.rejects(blocked.result, (error) => {
        NodeAssert.ok(error.message.includes(dir.lockPath));
        NodeAssert.match(
          error.message,
          /Remove it manually only after confirming no publisher is running/u,
        );
        return true;
      });
      NodeAssert.deepEqual(blocked.calls, []);
      NodeAssert.deepEqual(await snapshot(dir.outDir), before);
    });
  },
);

NodeTest.test(
  "a publisher blocked inside the lock excludes another until it finishes and releases the lock",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      const entered = deferred();
      const release = deferred();
      const first = startBuild(dir, "0.0.59", {
        hook: async (command, args) => {
          if (command.endsWith("hdiutil") && args[0] === "verify") {
            entered.resolve();
            await release.promise;
          }
        },
      });
      try {
        await entered.promise;
        NodeAssert.ok((await NodeFSP.stat(dir.lockPath)).isDirectory());
        const held = await snapshot(dir.outDir);
        const second = startBuild(dir, "0.0.60");
        await NodeAssert.rejects(second.result, (error) => error.message.includes(dir.lockPath));
        NodeAssert.deepEqual(second.calls, []);
        NodeAssert.deepEqual(await snapshot(dir.outDir), held);
        NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.58");
      } finally {
        release.resolve();
        await first.result.catch(() => {});
      }
      const manifest = await first.result;
      NodeAssert.equal((await readFeed(dir.feedPath)).sha256, manifest.packageSha256);
      NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.59");
      NodeAssert.deepEqual(leftovers(await snapshot(dir.outDir)), []);
    });
  },
);

NodeTest.test("first canonical publish needs no feed, and success releases the lock", async () => {
  await withPublishDir(async (dir) => {
    const build = startBuild(dir, "0.0.50");
    const manifest = await build.result;
    NodeAssert.ok(build.calls.length > 0);
    NodeAssert.deepEqual(Object.keys(await snapshot(dir.outDir)).sort(), [
      "OoP-0.0.50-arm64-update.pkg",
      "OoP-0.0.50-arm64-update.pkg.json",
      "OoP-0.0.50-arm64-update.pkg.sha256",
      "oop-update.json",
    ]);
    NodeAssert.equal((await readFeed(dir.feedPath)).sha256, manifest.packageSha256);
  });
});

NodeTest.test(
  "archive release binding failure preserves the package, sidecars, and feed",
  async () => {
    for (const [label, options, expectedReads] of [
      [
        "missing product",
        { tarDistribution: distributionXml("0.0.59").replace(releaseProductElement("0.0.59"), "") },
        1,
      ],
      ["wrong version", { tarDistribution: distributionXml("0.0.57") }, 1],
      ["duplicate Distribution", { tarList: "Distribution\nDistribution\n" }, 0],
    ]) {
      await withPublishDir(async (dir) => {
        await seedPublished(dir, "0.0.58");
        const before = await snapshot(dir.outDir);
        const build = startBuild(dir, "0.0.59", options);
        await NodeAssert.rejects(
          build.result,
          (error) => {
            NodeAssert.doesNotMatch(error.message, /oop-publish-test-/u, label);
            return true;
          },
          label,
        );
        NodeAssert.deepEqual(
          build.calls.filter((call) => call.startsWith("tar ")),
          expectedReads === 1 ? ["tar -t", "tar -x"] : ["tar -t"],
          label,
        );
        NodeAssert.deepEqual(
          build.calls.filter((call) => call.startsWith("xar ")),
          expectedReads === 1 ? ["xar --dump-toc=/dev/stdout"] : [],
          label,
        );
        NodeAssert.deepEqual(await snapshot(dir.outDir), before, label);
      });
    }
  },
);

NodeTest.test(
  "failed noncanonical rebuild preserves an existing package and its sidecars",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      const output = NodePath.join(dir.outDir, "OOP-0.0.59-arm64-candidate.pkg");
      await NodeFSP.writeFile(output, "existing candidate package");
      await NodeFSP.writeFile(`${output}.sha256`, "existing candidate hash\n");
      await NodeFSP.writeFile(`${output}.json`, '{"existing":"candidate"}\n');
      const before = await snapshot(dir.outDir);
      const build = startBuild(dir, "0.0.59", {
        output,
        hook: (command, args) => {
          if (command.endsWith("hdiutil") && args[0] === "verify")
            throw new Error("input image verification failed");
        },
      });
      await NodeAssert.rejects(build.result, /input image verification failed/u);
      NodeAssert.deepEqual(await snapshot(dir.outDir), before);
    });
  },
);

NodeTest.test(
  "a failed build releases the lock, and retrying an interrupted publish overwrites its leftovers",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      // A crash after the package renames but before the feed rename leaves this unpublished version above the feed.
      const leftover = NodePath.join(dir.outDir, "OoP-0.0.59-arm64-update.pkg");
      await NodeFSP.writeFile(leftover, "stale package");
      await NodeFSP.writeFile(`${leftover}.sha256`, "stale\n");
      await NodeFSP.writeFile(`${leftover}.json`, "{}\n");
      const failed = startBuild(dir, "0.0.59", {
        hook: (command) => {
          if (command.endsWith("productbuild")) throw new Error("productbuild failed");
        },
      });
      await NodeAssert.rejects(failed.result, /productbuild failed/u);
      NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.58");
      NodeAssert.deepEqual(leftovers(await snapshot(dir.outDir)), []);
      const retried = await startBuild(dir, "0.0.59").result;
      NodeAssert.equal(await NodeFSP.readFile(leftover, "utf8"), "package bytes");
      NodeAssert.equal(
        JSON.parse(await NodeFSP.readFile(`${leftover}.json`, "utf8")).packageSha256,
        retried.packageSha256,
      );
      NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.59");
      NodeAssert.deepEqual(leftovers(await snapshot(dir.outDir)), []);
    });
  },
);

NodeTest.test(
  "a lock that cannot be released reports that publication completed, and never hides a build failure",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      // A foreign file makes the lock directory impossible to remove.
      const blockRelease = () => NodeFSP.writeFile(NodePath.join(dir.lockPath, "foreign"), "");
      const published = startBuild(dir, "0.0.59", { hook: blockRelease });
      await NodeAssert.rejects(published.result, (error) => {
        NodeAssert.match(error.message, /^OOP update 0\.0\.59 was published, but releasing /u);
        NodeAssert.ok(error.message.includes(dir.lockPath));
        NodeAssert.match(
          error.message,
          /remove it manually after confirming no publisher is running/u,
        );
        return true;
      });
      NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.59");
      NodeAssert.ok((await NodeFSP.stat(dir.lockPath)).isDirectory());
      await NodeFSP.rm(dir.lockPath, { recursive: true });
      const failed = startBuild(dir, "0.0.60", {
        hook: async (command) => {
          await blockRelease();
          if (command.endsWith("productbuild")) throw new Error("productbuild failed");
        },
      });
      await NodeAssert.rejects(failed.result, (error) => {
        NodeAssert.match(error.message, /^productbuild failed/u);
        NodeAssert.match(error.message, /releasing .* failed/u);
        NodeAssert.doesNotMatch(error.message, /was published/u);
        return true;
      });
      NodeAssert.equal((await readFeed(dir.feedPath)).version, "0.0.59");
    });
  },
);

NodeTest.test(
  "a noncanonical output cannot take a canonical name for another version",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      const before = await snapshot(dir.outDir);
      for (const name of [
        "OoP-0.0.58-arm64-update.pkg",
        "oop-0.0.58-arm64-update.pkg",
        "OoP-0.00.58-arm64-update.pkg",
        "OoP-0.0.60-arm64-update.pkg",
      ]) {
        const rejected = startBuild(dir, "0.0.57", { output: NodePath.join(dir.outDir, name) });
        await NodeAssert.rejects(rejected.result, /reserved for the canonical build/u, name);
        NodeAssert.deepEqual(rejected.calls, [], name);
        NodeAssert.deepEqual(await snapshot(dir.outDir), before, name);
      }
    });
  },
);

NodeTest.test(
  "a noncanonical rollback build publishes its package but leaves the feed and canonical packages alone",
  async () => {
    await withPublishDir(async (dir) => {
      await seedPublished(dir, "0.0.58");
      const before = await snapshot(dir.outDir);
      const name = "OOP-0.0.57-arm64-rollback.pkg";
      const manifest = await startBuild(dir, "0.0.57", { output: NodePath.join(dir.outDir, name) })
        .result;
      const after = await snapshot(dir.outDir);
      NodeAssert.equal(after[name], "package bytes");
      NodeAssert.equal(JSON.parse(after[`${name}.json`]).packageSha256, manifest.packageSha256);
      NodeAssert.deepEqual(
        Object.keys(after).sort(),
        [...Object.keys(before), name, `${name}.json`, `${name}.sha256`].sort(),
      );
      for (const [entry, content] of Object.entries(before))
        NodeAssert.equal(after[entry], content, entry);
    });
  },
);

NodeTest.describe("old release cleanup", () => {
  const names = [
    "OOP-0.0.9-arm64.dmg",
    "OoP-0.0.10-arm64-update.pkg",
    "OoP-0.0.10-arm64-update.pkg.json",
    "OOP-0.0.11-arm64.dmg",
    "OOP-0.0.11-arm64.dmg.sha256",
    "OOP-0.0.12-arm64.dmg",
    "OoP-0.0.13-arm64-update.pkg",
    "oop-update.json",
    "LOCAL_UPDATE_STATUS.json",
  ];

  NodeTest.it("keeps the published version and the one before it, by version order", () => {
    NodeAssert.deepEqual(releaseArtifactsToPrune(names, "0.0.12"), [
      "OOP-0.0.9-arm64.dmg",
      "OoP-0.0.10-arm64-update.pkg",
      "OoP-0.0.10-arm64-update.pkg.json",
    ]);
  });

  NodeTest.it("removes only obsolete files from the release folder", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-prune-"));
    try {
      for (const name of names) await NodeFSP.writeFile(NodePath.join(dir, name), "");
      await NodeFSP.mkdir(NodePath.join(dir, "OOP-0.0.1-arm64-folder"));
      await pruneOldReleases(dir, "0.0.12");
      NodeAssert.deepEqual((await NodeFSP.readdir(dir)).sort(), [
        "LOCAL_UPDATE_STATUS.json",
        "OOP-0.0.1-arm64-folder",
        "OOP-0.0.11-arm64.dmg",
        "OOP-0.0.11-arm64.dmg.sha256",
        "OOP-0.0.12-arm64.dmg",
        "OoP-0.0.13-arm64-update.pkg",
        "oop-update.json",
      ]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
