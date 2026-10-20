#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- This dependency-free bootstrap runs before workspace dependencies are installed; tests inject host values. */

// Windows counterpart of scripts/macos.mjs: builds the OoP NSIS installer on a Windows PC and
// publishes it with the local update manifest. The source is the archive the Mac publishes to
// Google Drive (<Drive>\OoP\source), or, before Drive is set up, the source kept on the NAS.
// The only robocopy /MIR target is a checkout folder this script owns under %LOCALAPPDATA%.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  MIN_NODE_VERSION,
  PACKAGE_MANAGER_VERSION,
  releaseVersion,
  sourceKey,
  upstreamVersion,
} from "./macos.mjs";

export const SOURCE_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const CACHE_FOLDER = "OOP_DeskTop";
export const MANIFEST_NAME = "oop-update.json";
const ROBOCOPY_EXCLUDED_DIRECTORIES = [
  ".git",
  "node_modules",
  ".pnpm-store",
  ".t3",
  "release",
  "dist",
  "dist-electron",
  ".vite-plus",
  ".electron-runtime",
  "target",
  ".turbo",
  ".next",
  "coverage",
  "test-results",
  "playwright-report",
  "secrets",
  ".secrets",
  "credentials",
  ".credentials",
];
const ROBOCOPY_EXCLUDED_FILES = [".env", ".env.*", ".npmrc", "*.pem", "*.p12", "*.p8", "*.key"];

export const AUTO_BUILD_TASK_NAME = "OoP Windows Auto Build";
/** Google Drive for desktop mounts as G: by default; the root is "My Drive" or "내 드라이브". */
export const WINDOWS_DRIVE_ROOTS = ["G:\\My Drive\\OoP", "G:\\내 드라이브\\OoP"];
const SOURCE_INFO_NAME = "oop-source.json";
const SOURCE_ARCHIVE_NAME = "oop-source.tar.gz";
const RUNNER_FOLDER = "runner";
const RUNNER_LOG_NAME = "auto-build.log";
const RUNNER_OLD_LOG_NAME = "auto-build.old.log";
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 1024 * 1024;
const AUTO_BUILD_INTERVAL_MINUTES = 10;
const AUTO_BUILD_RETRY_MS = 60 * 60 * 1000;

export function parseArgs(argv) {
  const [command = "package", ...rest] = argv;
  if (!["doctor", "package", "auto", "schedule", "unschedule"].includes(command)) {
    throw new Error(
      "Usage: node scripts/windows.mjs <doctor|package|auto|schedule|unschedule> [--arch x64|arm64]",
    );
  }
  let arch = "x64";
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--arch" && ["x64", "arm64"].includes(rest[index + 1])) {
      arch = rest[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown option: ${rest[index]}`);
    }
  }
  return { command, arch };
}

// `net use` lists mapped drives as `OK  Z:  \\host\share  Microsoft Windows Network`.
export function uncPathFor(path, netUseOutput) {
  if (path.startsWith("\\\\")) return path;
  const drive = /^([A-Za-z]:)(.*)$/u.exec(path);
  if (!drive) return undefined;
  for (const line of netUseOutput.split(/\r?\n/u)) {
    const match = /\s([A-Za-z]:)\s+(\\\\\S+)/u.exec(line);
    if (match && match[1].toUpperCase() === drive[1].toUpperCase()) return `${match[2]}${drive[2]}`;
  }
  return undefined;
}

/** `\\host\share\rest` → `smb://host/share`, the address the app's Prepare step opens. */
export function smbUrlForUncPath(uncPath) {
  const match = /^\\\\([^\\]+)\\([^\\]+)/u.exec(uncPath);
  return match ? `smb://${match[1]}/${encodeURIComponent(match[2])}` : undefined;
}

export function windowsUpdateManifest({ version, arch, fileName, size, sha256 }) {
  return { schemaVersion: 1, platform: "win32", arch, version, pkg: fileName, size, sha256 };
}

/** Installer files of versions other than the published one and the newest one before it. */
export function releaseFilesToPrune(names, publishedVersion, arch) {
  const pattern = new RegExp(`^OoP-(\\d+\\.\\d+\\.\\d+)-${arch}\\.exe(\\.sha256)?$`, "u");
  const versions = [...new Set(names.flatMap((name) => pattern.exec(name)?.[1] ?? []))];
  const older = versions
    .filter((version) => compareVersions(version, publishedVersion) < 0)
    .toSorted(compareVersions);
  const keep = new Set([publishedVersion, older.at(-1)]);
  return names.filter((name) => {
    const version = pattern.exec(name)?.[1];
    return version !== undefined && !keep.has(version);
  });
}

/**
 * Puts `directory` first on the search path. Windows names the variable `Path`, and a
 * copied environment keeps that case, so writing `PATH` would add a second variable that
 * shadows the real search path for child processes.
 */
export function prependPath(env, directory, delimiter = NodePath.delimiter) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = env[key] ? `${directory}${delimiter}${env[key]}` : directory;
  return env;
}

/**
 * What `auto` does: build when the source carries a newer version than release\windows,
 * but retry a version whose build just failed only after an hour, unless this build
 * script changed since that failure (a fix should not wait for the hour).
 */
export function autoBuildDecision({ sourceVersion, publishedVersion, failed, now, scriptHash }) {
  if (publishedVersion !== null && compareVersions(sourceVersion, publishedVersion) <= 0) {
    return "up-to-date";
  }
  if (
    failed?.version === sourceVersion &&
    failed.script === scriptHash &&
    now - failed.at < AUTO_BUILD_RETRY_MS
  ) {
    return "wait-after-failure";
  }
  return "build";
}

/** Every few minutes while the user is signed in (their session holds the NAS login), no window. */
export function scheduleTaskArgs(launcherPath) {
  return [
    "/Create",
    "/F",
    "/SC",
    "MINUTE",
    "/MO",
    String(AUTO_BUILD_INTERVAL_MINUTES),
    "/TN",
    AUTO_BUILD_TASK_NAME,
    "/TR",
    `conhost.exe --headless "${launcherPath}"`,
  ];
}

/** Where to look for the OoP folder in Google Drive: OOP_DRIVE_ROOT, else the G: defaults. */
export function driveRootCandidates(env) {
  const configured = env.OOP_DRIVE_ROOT?.trim();
  return configured ? [configured] : WINDOWS_DRIVE_ROOTS;
}

/** The update folders the Windows app tries, in order, for the Drive roots above. */
export function windowsDriveUpdateCandidates(roots) {
  return roots.map((root) => `${root.replace(/[\\/]+$/u, "")}\\release\\windows`);
}

/** A source description from Drive is used only when every field is what the Mac writes. */
export function validDriveSourceInfo(info) {
  return (
    info !== null &&
    typeof info === "object" &&
    info.schemaVersion === 1 &&
    typeof info.version === "string" &&
    /^\d+\.\d+\.\d+$/u.test(info.version) &&
    info.file === SOURCE_ARCHIVE_NAME &&
    typeof info.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(info.sha256)
  );
}

/**
 * Whether this run moves the task off the NAS to the runner copy: only once Drive's
 * release\\windows carries the Drive source, because it was already up to date or this run's
 * build from it succeeded. Until then the NAS launcher keeps running and keeps publishing to the
 * NAS, which installed apps from before Drive still read.
 */
export function moveTaskToRunner({ source, fromRunner, decision, built }) {
  return source === "drive" && !fromRunner && (decision === "up-to-date" || built);
}

/** Drive's archive when Drive has one; the NAS source otherwise; nothing to build from else. */
export function autoBuildSource({ driveInfo, hasNasSource }) {
  if (validDriveSourceInfo(driveInfo)) return "drive";
  return hasNasSource ? "nas" : "none";
}

/**
 * The scheduled task's launcher once the auto-build runs from this PC. Plain ASCII on purpose:
 * cmd reads a .cmd in the console code page, so a Drive path such as "내 드라이브" would break
 * here. The log stays next to the launcher and windows.mjs copies it to Drive on every run.
 */
export function runnerLauncherScript() {
  return [
    "@echo off",
    "rem Written by scripts\\windows.mjs when the OoP auto-build moved to Google Drive.",
    'pushd "%~dp0"',
    // The log is this task's output, so only the launcher may rotate it, before node starts.
    `if exist "${RUNNER_LOG_NAME}" for %%F in ("${RUNNER_LOG_NAME}") do if %%~zF GTR ${LOG_LIMIT_BYTES} move /y "${RUNNER_LOG_NAME}" "${RUNNER_OLD_LOG_NAME}" >nul`,
    `echo [%DATE% %TIME%] task started >> "${RUNNER_LOG_NAME}"`,
    `node scripts\\windows.mjs auto >> "${RUNNER_LOG_NAME}" 2>&1`,
    "set BUILD_EXIT=%ERRORLEVEL%",
    `echo [%DATE% %TIME%] task finished with exit %BUILD_EXIT% >> "${RUNNER_LOG_NAME}"`,
    "popd",
    "exit /b %BUILD_EXIT%",
    "",
  ].join("\r\n");
}

/** A log past `limit` bytes keeps its last `keep` bytes, starting at a line. */
export function trimLog(text, limit = LOG_LIMIT_BYTES, keep = LOG_KEEP_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const tail = Buffer.from(text, "utf8").subarray(-keep).toString("utf8");
  const start = tail.indexOf("\n");
  return start === -1 ? tail : tail.slice(start + 1);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (const index of [0, 1, 2]) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  // .cmd shims need a shell on Windows; quote the shim path, which may sit under a user folder with spaces.
  const shell = command.endsWith(".cmd");
  const result = NodeChildProcess.spawnSync(shell ? `"${command}"` : command, args, {
    stdio: "inherit",
    shell,
    ...options,
  });
  if (result.error) throw result.error;
  const ok = options.okExitCodes ? options.okExitCodes(result.status) : result.status === 0;
  if (!ok) throw new Error(`${command} exited with ${result.status}`);
}

function capture(command, args) {
  // Same .cmd shim handling as run(): Node refuses to spawn .cmd files without a shell (EINVAL).
  const shell = command.endsWith(".cmd");
  const result = NodeChildProcess.spawnSync(shell ? `"${command}"` : command, args, {
    encoding: "utf8",
    shell,
  });
  return result.status === 0 ? result.stdout : "";
}

function doctor() {
  const problems = [];
  if (process.platform !== "win32") problems.push("Run this on Windows.");
  const node = process.versions.node.split(".").map(Number);
  if (compareVersions(node.join("."), MIN_NODE_VERSION.join(".")) < 0) {
    problems.push(`Node ${MIN_NODE_VERSION.join(".")} or newer is required.`);
  }
  const pnpm = capture("pnpm.cmd", ["--version"]).trim();
  if (pnpm !== PACKAGE_MANAGER_VERSION) {
    problems.push(`pnpm ${PACKAGE_MANAGER_VERSION} is required (found ${pnpm || "none"}).`);
  }
  if (!capture("cargo", ["--version"]))
    problems.push("Rust (cargo) is required: https://rustup.rs");
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("\n")}\nSee docs/operations/development.md#windows-installer-prerequisites.`,
    );
  }
}

async function sha256File(filePath) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function writeAtomically(destination, content) {
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    await NodeFSP.writeFile(temp, content);
    await NodeFSP.rename(temp, destination);
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
}

/**
 * Builds the installer from `sourceRoot` and publishes it to every folder in
 * `releaseDirectories`. The app it builds looks in Google Drive first and, when the build runs
 * against the NAS, falls back to the share's release\\windows.
 */
async function packageInstaller(
  sourceRoot,
  arch,
  {
    releaseDirectories = [NodePath.join(sourceRoot, "release", "windows")],
    nasReleaseDirectory = NodePath.join(sourceRoot, "release", "windows"),
    requireShare = true,
  } = {},
) {
  const localAppData =
    process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local");
  const checkout = NodePath.join(localAppData, CACHE_FOLDER, sourceKey(sourceRoot), "checkout");
  const updateDirectory =
    process.env.OOP_WINDOWS_UPDATE_DIRECTORY ??
    (nasReleaseDirectory === null
      ? undefined
      : uncPathFor(nasReleaseDirectory, capture("net", ["use"])));
  if (updateDirectory === undefined && requireShare) {
    throw new Error(
      "Could not find the network path of release\\windows. Open the source from \\\\host\\share or a mapped drive, or set OOP_WINDOWS_UPDATE_DIRECTORY.",
    );
  }

  const electronBuilderCache =
    process.env.ELECTRON_BUILDER_CACHE?.trim() ||
    NodePath.join(localAppData, "electron-builder", "Cache");
  for (const removed of await removeBrokenNsisCache(electronBuilderCache)) {
    console.log(`Removed an incomplete NSIS download, it will be fetched again: ${removed}`);
  }

  // Earlier builds' output is already published to release\windows; clear it before
  // building so repeated builds do not fill the local disk.
  const artifactsRoot = NodePath.join(
    localAppData,
    CACHE_FOLDER,
    sourceKey(sourceRoot),
    "artifacts",
  );
  await NodeFSP.rm(artifactsRoot, { recursive: true, force: true });
  await NodeFSP.mkdir(checkout, { recursive: true });
  run(
    "robocopy",
    [
      sourceRoot,
      checkout,
      "/MIR",
      "/NFL",
      "/NDL",
      "/NJH",
      "/NJS",
      "/R:2",
      "/W:2",
      "/XD",
      ...ROBOCOPY_EXCLUDED_DIRECTORIES,
      "/XF",
      ...ROBOCOPY_EXCLUDED_FILES,
    ],
    // robocopy exit codes below 8 mean the copy succeeded.
    { okExitCodes: (status) => status !== null && status < 8 },
  );

  const env = { ...process.env };
  for (const key of [
    "GITHUB_REPOSITORY",
    "T3CODE_DESKTOP_UPDATE_REPOSITORY",
    "T3CODE_DESKTOP_VERSION",
    "T3CODE_DESKTOP_TARGET",
    "T3CODE_DESKTOP_ARCH",
    "T3CODE_DESKTOP_PLATFORM",
    "T3CODE_DESKTOP_OUTPUT_DIR",
    "T3CODE_DESKTOP_SIGNED",
    "T3CODE_DESKTOP_MOCK_UPDATES",
    "OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST",
    "OOP_DESKTOP_UPDATE_DIRECTORY",
    "OOP_DESKTOP_UPDATE_CONNECT_URL",
    "OOP_DESKTOP_UPDATE_CANDIDATES",
    "OOP_DESKTOP_UPDATE_FOLDER_KIND",
  ]) {
    delete env[key];
  }
  env.T3CODE_DESKTOP_BUILD_PROFILE_NAME = "oop-desktop";
  env.OOP_DESKTOP_UPDATE_CANDIDATES = JSON.stringify(
    windowsDriveUpdateCandidates(driveRootCandidates(process.env)),
  );
  env.OOP_DESKTOP_UPDATE_FOLDER_KIND = "google-drive";
  if (updateDirectory !== undefined) {
    env.OOP_DESKTOP_UPDATE_DIRECTORY = updateDirectory;
    const connectUrl = smbUrlForUncPath(updateDirectory);
    if (connectUrl !== undefined) env.OOP_DESKTOP_UPDATE_CONNECT_URL = connectUrl;
  }
  prependPath(env, NodePath.join(checkout, "node_modules", ".bin"));

  run(
    "pnpm.cmd",
    [
      "install",
      "--frozen-lockfile",
      "--filter",
      ".",
      "--filter",
      "@t3tools/desktop...",
      "--filter",
      "@t3tools/web...",
      "--filter",
      "@t3tools/scripts...",
      "--filter",
      "t3...",
    ],
    { cwd: checkout, env },
  );
  const version = await releaseVersion(sourceRoot);
  run(
    process.execPath,
    ["scripts/update-release-package-versions.ts", await upstreamVersion(sourceRoot)],
    { cwd: checkout, env },
  );
  run(NodePath.join(checkout, "node_modules", ".bin", "vp.cmd"), ["run", "build:desktop"], {
    cwd: checkout,
    env,
  });
  const out = NodePath.join(artifactsRoot, `${Date.now()}`);
  await NodeFSP.mkdir(out, { recursive: true });
  run(
    process.execPath,
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "win",
      "--arch",
      arch,
      "--target",
      "nsis",
      "--build-version",
      version,
      "--skip-build",
      "--output-dir",
      out,
    ],
    { cwd: checkout, env },
  );

  const fileName = `OoP-${version}-${arch}.exe`;
  const built = NodePath.join(out, fileName);
  const size = (await NodeFSP.stat(built)).size;
  const sha256 = await sha256File(built);
  for (const releaseDirectory of releaseDirectories) {
    await publishInstaller({ built, releaseDirectory, fileName, version, arch, size, sha256 });
  }
  await NodeFSP.rm(out, { recursive: true, force: true });
}

/** Installer first through a verified temp copy, then its .sha256, the manifest last; then prune. */
async function publishInstaller({
  built,
  releaseDirectory,
  fileName,
  version,
  arch,
  size,
  sha256,
}) {
  await NodeFSP.mkdir(releaseDirectory, { recursive: true });
  const temp = NodePath.join(releaseDirectory, `.${fileName}.${process.pid}.tmp`);
  try {
    await NodeFSP.copyFile(built, temp);
    if ((await sha256File(temp)) !== sha256)
      throw new Error("The copied installer does not match the build.");
    await NodeFSP.rename(temp, NodePath.join(releaseDirectory, fileName));
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
  await writeAtomically(
    NodePath.join(releaseDirectory, `${fileName}.sha256`),
    `${sha256}  ${fileName}\n`,
  );
  await writeAtomically(
    NodePath.join(releaseDirectory, MANIFEST_NAME),
    `${JSON.stringify(windowsUpdateManifest({ version, arch, fileName, size, sha256 }), null, 2)}\n`,
  );
  const pruned = releaseFilesToPrune(await NodeFSP.readdir(releaseDirectory), version, arch);
  for (const name of pruned)
    await NodeFSP.rm(NodePath.join(releaseDirectory, name), { force: true });
  console.log(`Installer: ${NodePath.join(releaseDirectory, fileName)}`);
  console.log(`SHA-256: ${sha256}`);
  if (pruned.length > 0) console.log(`Removed ${pruned.length} older build files.`);
}

/**
 * electron-builder reuses an extracted `nsis-*` toolset folder whenever it exists, so an
 * extraction cut short (for example by a full disk) fails every later build with
 * `makensis.exe ENOENT`. Drops such toolsets, archive included, so the next build
 * downloads them again. Returns the removed folders.
 */
export async function removeBrokenNsisCache(cacheRoot) {
  const removed = [];
  const releases = await NodeFSP.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  for (const release of releases) {
    if (!release.isDirectory() || !/^nsis-\d/u.test(release.name)) continue;
    const releaseDir = NodePath.join(cacheRoot, release.name);
    const entries = await NodeFSP.readdir(releaseDir, { withFileTypes: true });
    const extracted = entries.filter((entry) => entry.isDirectory());
    const complete = await Promise.all(
      extracted.map((entry) =>
        NodeFSP.access(NodePath.join(releaseDir, entry.name, "Bin", "makensis.exe")).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (extracted.length > 0 && complete.every(Boolean)) continue;
    await NodeFSP.rm(releaseDir, { recursive: true, force: true });
    removed.push(releaseDir);
  }
  return removed;
}

/**
 * The OOP log folders this PC may have: a configured T3CODE_HOME, then the homes the
 * desktop app uses by default. Each is mirrored under release\win-logs\<name>.
 */
export function windowsLogSources(env, homeDirectory) {
  const homes = [
    env.T3CODE_HOME?.trim(),
    NodePath.join(homeDirectory, ".oop-desktop"),
    NodePath.join(homeDirectory, ".t3"),
  ];
  const seen = new Set();
  return homes.flatMap((home) => {
    if (!home || seen.has(home.toLowerCase())) return [];
    seen.add(home.toLowerCase());
    return [{ name: NodePath.basename(home), logs: NodePath.join(home, "userdata", "logs") }];
  });
}

// For now the build PC's OOP logs are copied to the share on every scheduled run, so
// Windows problems can be read from the Mac without visiting the PC.
async function mirrorLogsTo(releaseRoot) {
  for (const source of windowsLogSources(process.env, NodeOS.homedir())) {
    const exists = await NodeFSP.stat(source.logs).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    if (!exists) continue;
    try {
      run(
        "robocopy",
        [
          source.logs,
          NodePath.join(releaseRoot, "win-logs", source.name),
          "/MIR",
          "/NFL",
          "/NDL",
          "/NJH",
          "/NJS",
          "/NP",
          "/R:1",
          "/W:1",
        ],
        { okExitCodes: (status) => status !== null && status < 8 },
      );
    } catch (error) {
      console.log(`  could not copy logs from ${source.logs}: ${error.message}`);
    }
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function isDirectory(path) {
  return NodeFSP.stat(path).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

async function findDriveRoot(env) {
  for (const root of driveRootCandidates(env)) if (await isDirectory(root)) return root;
  return null;
}

/**
 * A local copy of Drive's source archive, checked against its description, unpacked into a folder
 * this script owns. Returns null while Drive is still syncing a new archive.
 */
async function extractDriveSource(driveRoot, info, cacheRoot) {
  const work = NodePath.join(cacheRoot, "drive-source");
  const archive = NodePath.join(work, SOURCE_ARCHIVE_NAME);
  const source = NodePath.join(work, "source");
  await NodeFSP.mkdir(work, { recursive: true });
  await NodeFSP.copyFile(NodePath.join(driveRoot, "source", SOURCE_ARCHIVE_NAME), archive);
  if ((await sha256File(archive)) !== info.sha256) return null;
  await NodeFSP.rm(source, { recursive: true, force: true });
  await NodeFSP.mkdir(source, { recursive: true });
  run("tar", ["-xzf", archive, "-C", source]);
  return source;
}

/** Copies this script and macos.mjs to the runner folder and writes its launcher. */
async function installRunner(scriptsDirectory, cacheRoot) {
  const runner = NodePath.join(cacheRoot, RUNNER_FOLDER);
  await NodeFSP.mkdir(NodePath.join(runner, "scripts"), { recursive: true });
  for (const name of ["windows.mjs", "macos.mjs"]) {
    await NodeFSP.copyFile(
      NodePath.join(scriptsDirectory, name),
      NodePath.join(runner, "scripts", name),
    );
  }
  const launcher = NodePath.join(runner, "windows-auto-build.cmd");
  await writeAtomically(launcher, runnerLauncherScript());
  return launcher;
}

/**
 * The runner's own log, trimmed, copied next to release\\windows in Drive. The local log is this
 * run's own output, so it is only read here (the launcher rotates it), and a failed copy never
 * stops the build.
 */
export async function copyRunnerLog(
  cacheRoot,
  driveRoot,
  limit = LOG_LIMIT_BYTES,
  keep = LOG_KEEP_BYTES,
) {
  try {
    const text = await NodeFSP.readFile(
      NodePath.join(cacheRoot, RUNNER_FOLDER, RUNNER_LOG_NAME),
      "utf8",
    ).catch(() => null);
    if (text === null) return;
    await NodeFSP.mkdir(NodePath.join(driveRoot, "release"), { recursive: true });
    await writeAtomically(
      NodePath.join(driveRoot, "release", "windows-auto-build.log"),
      trimLog(text, limit, keep),
    );
  } catch (error) {
    console.log(`  could not copy the auto-build log to Google Drive: ${error.message}`);
  }
}

async function autoBuild(sourceRoot, arch) {
  const localAppData =
    process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local");
  const cacheRoot = NodePath.join(localAppData, CACHE_FOLDER);
  const statePath = NodePath.join(cacheRoot, "auto-build-state.json");
  const runnerRoot = NodePath.join(cacheRoot, RUNNER_FOLDER);
  const fromRunner = NodePath.resolve(sourceRoot).toLowerCase() === runnerRoot.toLowerCase();
  const driveRoot = await findDriveRoot(process.env);
  const hasNasSource =
    !fromRunner &&
    (await NodeFSP.stat(NodePath.join(sourceRoot, "OOP_RELEASE.json")).then(
      () => true,
      () => false,
    ));
  const nasRelease = hasNasSource ? NodePath.join(sourceRoot, "release", "windows") : null;
  if (driveRoot !== null) {
    await mirrorLogsTo(NodePath.join(driveRoot, "release"));
    await copyRunnerLog(cacheRoot, driveRoot);
  }
  if (hasNasSource) await mirrorLogsTo(NodePath.join(sourceRoot, "release"));

  const driveInfo =
    driveRoot === null
      ? null
      : await readJson(NodePath.join(driveRoot, "source", SOURCE_INFO_NAME));
  const source = autoBuildSource({ driveInfo, hasNasSource });
  if (source === "none") {
    console.log(
      `[${new Date().toISOString()}] nothing to build from: ${
        driveRoot === null
          ? "the OoP folder in Google Drive was not found (install Google Drive for desktop, sign in, and make OoP available offline)"
          : "Google Drive has no OoP\\source yet"
      }`,
    );
    return;
  }
  const sourceVersion = source === "drive" ? driveInfo.version : await releaseVersion(sourceRoot);
  const publishedDirectory =
    source === "drive" ? NodePath.join(driveRoot, "release", "windows") : nasRelease;
  const manifest = await readJson(NodePath.join(publishedDirectory, MANIFEST_NAME));
  const publishedVersion =
    manifest?.arch === arch && typeof manifest.version === "string" ? manifest.version : null;
  const failed = await readJson(statePath);
  const scriptHash = await sha256File(NodeURL.fileURLToPath(import.meta.url));
  const decision = autoBuildDecision({
    sourceVersion,
    publishedVersion,
    failed,
    now: Date.now(),
    scriptHash,
  });
  console.log(
    `[${new Date().toISOString()}] ${source} source ${sourceVersion}, published ${publishedVersion ?? "none"}: ${decision}`,
  );
  if (decision === "wait-after-failure") {
    console.log(`  last failure: ${failed.error ?? "unknown"}`);
    console.log(`  next attempt after ${new Date(failed.at + AUTO_BUILD_RETRY_MS).toISOString()}`);
  }
  let built = false;
  if (decision === "build") {
    doctor();
    try {
      if (source === "drive") {
        const extracted = await extractDriveSource(driveRoot, driveInfo, cacheRoot);
        if (extracted === null) {
          console.log("  Google Drive is still syncing the source archive; trying again next run.");
          return;
        }
        // The NAS keeps getting installers while devices still read it; see docs/user/install.md.
        await packageInstaller(extracted, arch, {
          releaseDirectories: [publishedDirectory, ...(nasRelease === null ? [] : [nasRelease])],
          nasReleaseDirectory: nasRelease,
          requireShare: false,
        });
        await installRunner(NodePath.join(extracted, "scripts"), cacheRoot);
        built = true;
      } else {
        await packageInstaller(sourceRoot, arch);
      }
      await NodeFSP.rm(statePath, { force: true });
    } catch (error) {
      await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
      const message = error instanceof Error ? error.message : String(error);
      await NodeFSP.writeFile(
        statePath,
        JSON.stringify({
          version: sourceVersion,
          at: Date.now(),
          script: scriptHash,
          error: message.slice(0, 500),
        }),
      );
      throw error;
    }
  }
  // Once Drive's release carries the Drive source, the task stops depending on the NAS: it runs a
  // copy of this script from this PC. Registering again replaces the task; this run finishes first.
  if (moveTaskToRunner({ source, fromRunner, decision, built })) {
    const launcher = await installRunner(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      cacheRoot,
    );
    run("schtasks", scheduleTaskArgs(launcher));
    console.log(`  moved "${AUTO_BUILD_TASK_NAME}" to ${launcher}`);
  }
}

function schedule(sourceRoot) {
  const launcher = NodePath.join(sourceRoot, "scripts", "windows-auto-build.cmd");
  // A mapped drive may not exist when the task runs, so the task names the share itself.
  const taskLauncher = uncPathFor(launcher, capture("net", ["use"])) ?? launcher;
  run("schtasks", scheduleTaskArgs(taskLauncher));
  // The first check runs now instead of waiting a full interval after (re)registration.
  run("schtasks", ["/Run", "/TN", AUTO_BUILD_TASK_NAME]);
  console.log(
    `Scheduled "${AUTO_BUILD_TASK_NAME}" every ${AUTO_BUILD_INTERVAL_MINUTES} minutes while you are signed in, and started the first check.`,
  );
  console.log(`Progress: ${NodePath.join(sourceRoot, "release", "windows-auto-build.log")}`);
}

export async function main(argv = process.argv.slice(2), sourceRoot = SOURCE_ROOT) {
  const { command, arch } = parseArgs(argv);
  if (command === "schedule") return schedule(sourceRoot);
  if (command === "unschedule")
    return run("schtasks", ["/Delete", "/F", "/TN", AUTO_BUILD_TASK_NAME]);
  if (command === "auto") return autoBuild(sourceRoot, arch);
  doctor();
  if (command === "doctor") return;
  await packageInstaller(sourceRoot, arch);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[windows] ${error.message}`);
    process.exitCode = 1;
  });
}
