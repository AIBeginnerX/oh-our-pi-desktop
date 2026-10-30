import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import {
  AUTO_BUILD_TASK_NAME,
  autoBuildDecision,
  autoBuildSource,
  copyRunnerLog,
  driveRootCandidates,
  moveTaskToRunner,
  parseArgs,
  prependPath,
  releaseFilesToPrune,
  removeBrokenNsisCache,
  RUNNER_SCRIPTS,
  runnerLauncherScript,
  scheduleTaskArgs,
  smbUrlForUncPath,
  trimLog,
  uncPathFor,
  validDriveSourceInfo,
  WINDOWS_DRIVE_ROOTS,
  windowsDriveUpdateCandidates,
  windowsLogSources,
  windowsUpdateManifest,
} from "./windows.mjs";

NodeTest.test("parses the command and target architecture", () => {
  NodeAssert.deepEqual(parseArgs([]), { command: "package", arch: "x64" });
  NodeAssert.deepEqual(parseArgs(["package", "--arch", "arm64"]), {
    command: "package",
    arch: "arm64",
  });
  NodeAssert.throws(() => parseArgs(["package", "--arch", "ia32"]));
  NodeAssert.throws(() => parseArgs(["start"]));
  NodeAssert.deepEqual(parseArgs(["auto"]), { command: "auto", arch: "x64" });
  NodeAssert.equal(parseArgs(["schedule"]).command, "schedule");
  NodeAssert.equal(parseArgs(["unschedule"]).command, "unschedule");
});

NodeTest.test("prepends to the search path under the name Windows uses", () => {
  NodeAssert.deepEqual(prependPath({ Path: "C:\\pnpm;C:\\node" }, "C:\\bin", ";"), {
    Path: "C:\\bin;C:\\pnpm;C:\\node",
  });
  NodeAssert.deepEqual(prependPath({ PATH: "/usr/bin" }, "/bin2", ":"), { PATH: "/bin2:/usr/bin" });
  NodeAssert.deepEqual(prependPath({}, "C:\\bin", ";"), { PATH: "C:\\bin" });
});

NodeTest.test("drops an NSIS toolset whose extraction is missing makensis.exe", async () => {
  const cache = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-nsis-cache-"));
  const write = (...segments) => {
    const file = NodePath.join(cache, ...segments);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "");
  };
  try {
    write("nsis-3.0.4.1", "nsis-3.0.4.1.7z");
    write("nsis-3.0.4.1", "nsis-3.0.4.1-1mx3n", "Stubs", "lzma-x86-unicode");
    write("nsis-3.0.5.0", "nsis-3.0.5.0-abcde", "Bin", "makensis.exe");
    write("nsis-resources-3.4.1", "nsis-resources-3.4.1-xyz12", "plugins", "a.dll");

    NodeAssert.deepEqual(await removeBrokenNsisCache(cache), [
      NodePath.join(cache, "nsis-3.0.4.1"),
    ]);
    NodeAssert.deepEqual(NodeFS.readdirSync(cache).toSorted(), [
      "nsis-3.0.5.0",
      "nsis-resources-3.4.1",
    ]);
    NodeAssert.deepEqual(await removeBrokenNsisCache(NodePath.join(cache, "absent")), []);
  } finally {
    NodeFS.rmSync(cache, { recursive: true, force: true });
  }
});

NodeTest.test("lists each OOP home's log folder once", () => {
  const home = NodePath.join("C:", "Users", "me");
  NodeAssert.deepEqual(windowsLogSources({}, home), [
    { name: ".oop-desktop", logs: NodePath.join(home, ".oop-desktop", "userdata", "logs") },
    { name: ".t3", logs: NodePath.join(home, ".t3", "userdata", "logs") },
  ]);
  const custom = NodePath.join("D:", "oop-home");
  NodeAssert.deepEqual(
    windowsLogSources({ T3CODE_HOME: custom }, home).map((source) => source.name),
    ["oop-home", ".oop-desktop", ".t3"],
  );
  NodeAssert.equal(windowsLogSources({ T3CODE_HOME: NodePath.join(home, ".t3") }, home).length, 2);
});

NodeTest.test("auto-builds only a version newer than the published installer", () => {
  const now = 10 * 60 * 60 * 1000;
  const decide = (sourceVersion, publishedVersion, failed = null, scriptHash = "s1") =>
    autoBuildDecision({ sourceVersion, publishedVersion, failed, now, scriptHash });
  NodeAssert.equal(decide("0.0.85", "0.0.83"), "build");
  NodeAssert.equal(decide("0.0.85", null), "build");
  NodeAssert.equal(decide("0.0.85", "0.0.85"), "up-to-date");
  NodeAssert.equal(decide("0.0.85", "0.0.86"), "up-to-date");
  const recent = { version: "0.0.85", at: now - 5 * 60 * 1000, script: "s1" };
  NodeAssert.equal(decide("0.0.85", "0.0.83", recent), "wait-after-failure");
  NodeAssert.equal(
    decide("0.0.85", "0.0.83", { ...recent, at: now - 2 * 60 * 60 * 1000 }),
    "build",
  );
  NodeAssert.equal(decide("0.0.86", "0.0.83", recent), "build");
  // A changed build script retries at once; a failure recorded before hashes existed too.
  NodeAssert.equal(decide("0.0.85", "0.0.83", recent, "s2"), "build");
  NodeAssert.equal(
    decide("0.0.85", "0.0.83", { version: "0.0.85", at: now - 5 * 60 * 1000 }),
    "build",
  );
});

NodeTest.test("schedules the launcher without a console window", () => {
  NodeAssert.deepEqual(scheduleTaskArgs("\\\\nas\\share\\OOP\\scripts\\windows-auto-build.cmd"), [
    "/Create",
    "/F",
    "/SC",
    "MINUTE",
    "/MO",
    "10",
    "/TN",
    AUTO_BUILD_TASK_NAME,
    "/TR",
    'conhost.exe --headless "\\\\nas\\share\\OOP\\scripts\\windows-auto-build.cmd"',
  ]);
});

NodeTest.test("resolves the network path of the release folder", () => {
  const netUse = [
    "New connections will be remembered.",
    "Status       Local     Remote                    Network",
    "-------------------------------------------------------------------------------",
    "OK           Z:        \\\\192.168.1.10\\Shared  Microsoft Windows Network",
  ].join("\r\n");
  NodeAssert.equal(
    uncPathFor("Z:\\MyPJ\\OOP_DeskTop\\release\\windows", netUse),
    "\\\\192.168.1.10\\Shared\\MyPJ\\OOP_DeskTop\\release\\windows",
  );
  NodeAssert.equal(uncPathFor("\\\\nas\\share\\release", ""), "\\\\nas\\share\\release");
  NodeAssert.equal(uncPathFor("C:\\work\\release", netUse), undefined);
  NodeAssert.equal(
    smbUrlForUncPath("\\\\192.168.1.10\\Shared\\MyPJ"),
    "smb://192.168.1.10/Shared",
  );
});

NodeTest.test("writes the manifest the desktop updater reads", () => {
  NodeAssert.deepEqual(
    windowsUpdateManifest({
      version: "0.0.80",
      arch: "x64",
      fileName: "OoP-0.0.80-x64.exe",
      size: 9,
      sha256: "a".repeat(64),
    }),
    {
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      version: "0.0.80",
      pkg: "OoP-0.0.80-x64.exe",
      size: 9,
      sha256: "a".repeat(64),
    },
  );
});

NodeTest.test("keeps only the published installer and the one before it", () => {
  const names = [
    "OoP-0.0.78-x64.exe",
    "OoP-0.0.78-x64.exe.sha256",
    "OoP-0.0.79-x64.exe",
    "OoP-0.0.79-x64.exe.sha256",
    "OoP-0.0.80-x64.exe",
    "OoP-0.0.80-x64.exe.sha256",
    "OoP-0.0.77-arm64.exe",
    "oop-update.json",
  ];
  NodeAssert.deepEqual(releaseFilesToPrune(names, "0.0.80", "x64"), [
    "OoP-0.0.78-x64.exe",
    "OoP-0.0.78-x64.exe.sha256",
  ]);
});

NodeTest.test("looks for the OOP folder of Google Drive on G: unless told otherwise", () => {
  NodeAssert.deepEqual(driveRootCandidates({}), WINDOWS_DRIVE_ROOTS);
  NodeAssert.deepEqual(WINDOWS_DRIVE_ROOTS, ["G:\\My Drive\\OOP", "G:\\내 드라이브\\OOP"]);
  NodeAssert.deepEqual(driveRootCandidates({ OOP_DRIVE_ROOT: " H:\\My Drive\\OOP " }), [
    "H:\\My Drive\\OOP",
  ]);
  NodeAssert.deepEqual(windowsDriveUpdateCandidates(["G:\\My Drive\\OOP\\", "H:\\x"]), [
    "G:\\My Drive\\OOP\\release\\windows",
    "H:\\x\\release\\windows",
  ]);
});

NodeTest.test("builds from Drive's archive when it is described, else from the NAS", () => {
  const info = {
    schemaVersion: 1,
    version: "0.0.98",
    commit: "abc",
    file: "oop-source.tar.gz",
    size: 1,
    sha256: "a".repeat(64),
  };
  NodeAssert.equal(validDriveSourceInfo(info), true);
  NodeAssert.equal(autoBuildSource({ driveInfo: info, hasNasSource: true }), "drive");
  NodeAssert.equal(autoBuildSource({ driveInfo: null, hasNasSource: true }), "nas");
  NodeAssert.equal(autoBuildSource({ driveInfo: null, hasNasSource: false }), "none");
  for (const broken of [
    { ...info, version: "next" },
    { ...info, file: "../evil.tar.gz" },
    { ...info, sha256: "short" },
    { ...info, schemaVersion: 2 },
  ]) {
    NodeAssert.equal(autoBuildSource({ driveInfo: broken, hasNasSource: true }), "nas");
  }
});

NodeTest.test("writes an ASCII launcher for the task on this PC", () => {
  const launcher = runnerLauncherScript();
  // cmd reads .cmd files in the console code page, so nothing outside ASCII may appear.
  NodeAssert.equal(Buffer.byteLength(launcher, "utf8"), launcher.length);
  NodeAssert.match(launcher, /node scripts\\windows\.mjs auto >> "auto-build\.log" 2>&1/u);
  // The launcher, not node, rotates its log before node holds it open.
  const lines = launcher.split("\r\n");
  NodeAssert.ok(
    lines.findIndex((line) => line.includes("move /y")) <
      lines.findIndex((line) => line.startsWith("node ")),
  );
  NodeAssert.ok(
    launcher
      .split("\n")
      .slice(0, -1)
      .every((line) => line.endsWith("\r")),
  );
});

NodeTest.test("the runner's script copies load on their own", async () => {
  // The task runs windows.mjs from a folder holding only these copies; a missed import breaks every run.
  const runner = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-runner-scripts-"));
  try {
    for (const name of RUNNER_SCRIPTS) {
      NodeFS.copyFileSync(new URL(name, import.meta.url), NodePath.join(runner, name));
    }
    const loaded = await import(NodeURL.pathToFileURL(NodePath.join(runner, "windows.mjs")).href);
    NodeAssert.equal(typeof loaded.main, "function");
  } finally {
    NodeFS.rmSync(runner, { recursive: true, force: true });
  }
});

NodeTest.test("trims a long log to its last lines", () => {
  NodeAssert.equal(trimLog("short\n", 100, 10), "short\n");
  const text = `${"old line\n".repeat(20)}new line 1\nnew line 2\n`;
  const trimmed = trimLog(text, 50, 30);
  NodeAssert.ok(Buffer.byteLength(trimmed) <= 30);
  NodeAssert.ok(trimmed.endsWith("new line 2\n"));
  NodeAssert.ok(!trimmed.startsWith("ld line"), "cut at a line start");
});

NodeTest.test("copies the runner log to Drive trimmed and leaves the local log alone", async () => {
  const cacheRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-runner-log-"));
  const driveRoot = NodePath.join(cacheRoot, "drive", "OOP");
  NodeFS.mkdirSync(NodePath.join(cacheRoot, "runner"), { recursive: true });
  const local = NodePath.join(cacheRoot, "runner", "auto-build.log");
  const text = `${"old line\n".repeat(20)}new line\n`;
  NodeFS.writeFileSync(local, text);
  await copyRunnerLog(cacheRoot, driveRoot, 50, 30);
  NodeAssert.equal(NodeFS.readFileSync(local, "utf8"), text);
  const copied = NodeFS.readFileSync(
    NodePath.join(driveRoot, "release", "windows-auto-build.log"),
    "utf8",
  );
  NodeAssert.ok(copied.endsWith("new line\n") && Buffer.byteLength(copied) <= 30);
  // A Drive that cannot be written is logged, never thrown.
  NodeFS.writeFileSync(NodePath.join(cacheRoot, "blocked"), "a file, not a folder");
  await copyRunnerLog(cacheRoot, NodePath.join(cacheRoot, "blocked", "OOP"));
});

NodeTest.test("moves the task off the NAS only once Drive carries the build", () => {
  const drive = { source: "drive", fromRunner: false };
  NodeAssert.equal(moveTaskToRunner({ ...drive, decision: "up-to-date", built: false }), true);
  NodeAssert.equal(moveTaskToRunner({ ...drive, decision: "build", built: true }), true);
  // A failed build, a wait after one, or Drive still syncing keeps the NAS launcher publishing.
  NodeAssert.equal(moveTaskToRunner({ ...drive, decision: "build", built: false }), false);
  NodeAssert.equal(
    moveTaskToRunner({ ...drive, decision: "wait-after-failure", built: false }),
    false,
  );
  NodeAssert.equal(
    moveTaskToRunner({ source: "drive", fromRunner: true, decision: "up-to-date", built: false }),
    false,
  );
  NodeAssert.equal(
    moveTaskToRunner({ source: "nas", fromRunner: false, decision: "up-to-date", built: false }),
    false,
  );
});
