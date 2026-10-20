#!/usr/bin/env node
// Build-only macOS packaging tool. The resulting Installer package needs no Node runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  RELEASE_BUNDLE_ID,
  RELEASE_PACKAGE_ID,
  hasReleaseBinding,
  releaseProductElement,
  signedExtractedSha1s,
} from "../apps/desktop/src/updates/LocalPkgReleaseBinding.ts";
import { developerIdRequirement } from "./macos.mjs";

const APP_NAME = "OoP.app";
const UPDATE_FEED_NAME = "oop-update.json";
const SIGNING_MODE = "developer-id";
const USAGE =
  "Usage: node scripts/build-oop-update-pkg.mjs --dmg PATH --sha256 HEX --version X.Y.Z --output PATH.pkg [--signing-mode developer-id]";
const DEFAULT_REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const MAX_UPDATE_PACKAGE_SIZE = 1024 ** 3;
const STABLE_FEED_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function isStableFeedVersion(version) {
  const match = typeof version === "string" ? STABLE_FEED_VERSION.exec(version) : null;
  return match !== null && match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
}

export function localUpdateFeed(version, pkg, size, sha256) {
  if (
    !isStableFeedVersion(version) ||
    pkg !== `OoP-${version}-arm64-update.pkg` ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_UPDATE_PACKAGE_SIZE ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256)
  ) {
    throw new Error("Invalid local OoP update package metadata.");
  }
  return { schemaVersion: 1, platform: "darwin", arch: "arm64", version, pkg, size, sha256 };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--dmg", "--sha256", "--version", "--output", "--signing-mode"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values[key] !== undefined
    ) {
      throw new Error(USAGE);
    }
    values[key] = value;
  }
  const signingMode = values["--signing-mode"];
  if (signingMode !== undefined && signingMode !== SIGNING_MODE) throw new Error(USAGE);
  if (
    Object.keys(values).length - (signingMode === undefined ? 0 : 1) !== 4 ||
    !/^[a-fA-F0-9]{64}$/u.test(values["--sha256"]) ||
    !/^\d+\.\d+\.\d+$/u.test(values["--version"]) ||
    !values["--dmg"].endsWith(".dmg") ||
    !values["--output"].endsWith(".pkg")
  ) {
    throw new Error("Expected one DMG path, SHA-256 digest, X.Y.Z version, and .pkg output path.");
  }
  // The key is absent, not undefined, without the explicit flag.
  return {
    dmg: NodePath.resolve(values["--dmg"]),
    sha256: values["--sha256"].toLowerCase(),
    version: values["--version"],
    output: NodePath.resolve(values["--output"]),
    ...(signingMode === undefined ? {} : { signingMode }),
  };
}

export function componentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>Applications/OoP.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><false/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
`;
}

export function distributionXml(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Invalid package version.");
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>OoP ${version} 설치</title>
  ${releaseProductElement(version)}
  <welcome file="welcome.html"/>
  <options customize="never" require-scripts="true" rootVolumeOnly="true" hostArchitectures="arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" visible="false"><pkg-ref id="${RELEASE_PACKAGE_ID}"/></choice>
  <pkg-ref id="${RELEASE_PACKAGE_ID}" version="${version}">component.pkg</pkg-ref>
</installer-gui-script>
`;
}

export function welcomeHtml() {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>OoP 설치</title></head><body>
<h1>OoP 설치</h1>
<p>이 설치 프로그램은 OoP를 /Applications/OoP.app에 설치합니다. 처음 설치할 때와 새 버전으로 업데이트할 때 모두 이 파일을 씁니다.</p>
<h2>설치 전에</h2>
<ol>
<li>OoP가 실행 중이면 Cmd+Q로 완전히 종료합니다. 창을 닫는 것만으로는 종료되지 않습니다.</li>
<li>계속을 누르고, 물어보면 관리자 암호를 입력합니다.</li>
</ol>
<h2>처음 설치하는 Mac이라면</h2>
<ol>
<li>설치가 끝나면 응용 프로그램 폴더에서 OoP를 엽니다. 보안 경고 없이 열리도록 설치 과정에서 처리합니다.</li>
<li>첫 실행 안내가 업데이트 폴더(NAS 공유 폴더) 연결, 에이전트 로그인, 프로젝트 가져오기를 차례로 도와줍니다.</li>
<li>대화·프로젝트·설정은 Mac마다 따로 저장되므로 새 Mac은 빈 상태로 시작합니다.</li>
</ol>
<p>업데이트할 때는 기존 대화와 설정이 그대로 유지되고, 이전 앱은 /Library/Application Support/OoP/Updates에 백업됩니다.</p>
</body></html>
`;
}

// Shell fragment for preinstall's `$target` block. Blocks only on a process whose executable is the
// target's own; copies running from another absolute path are ignored, and a path ps cannot
// give us blocks. pgrep exit 0/1 means a normal list/no match; any other exit is an unknown
// process state and blocks. When ps fails for a PID, pgrep is asked once more: the PID is
// skipped only if it is gone, and still listed or a failed recheck blocks. Logs each blocker's
// PID and never signals anything. Tests pass fake pgrep/ps paths; the installer script always
// uses the defaults.
export function targetProcessCheck({ pgrep = "/usr/bin/pgrep", ps = "/bin/ps" } = {}) {
  if (![pgrep, ps].every((tool) => /^\/[\w./-]+$/u.test(tool)))
    throw new Error("Invalid process tool path.");
  return `  targetExe="$target/Contents/MacOS/OoP"
  blocked=''
  rc=0; pids=$(${pgrep} -x OoP) || rc=$?
  if [ "$rc" != 0 ] && [ "$rc" != 1 ]; then echo "Could not list OOP processes (pgrep exit $rc)." >&2; exit 1; fi
  for pid in $pids; do
    if comm=$(${ps} -o comm= -p "$pid" 2>/dev/null); then
      case "$comm" in
        "$targetExe") echo "OOP is running (pid $pid, $targetExe)." >&2; blocked=1 ;;
        /*) ;;
        *) echo "OOP pid $pid has an unverifiable executable path '$comm'." >&2; blocked=1 ;;
      esac
    else
      rc=0; again=$(${pgrep} -x OoP) || rc=$?
      if [ "$rc" != 0 ] && [ "$rc" != 1 ]; then echo "Could not recheck OOP pid $pid (pgrep exit $rc)." >&2; exit 1; fi
      case " $(printf '%s ' $again)" in *" $pid "*) echo "OOP pid $pid is still running but ps could not read it." >&2; blocked=1 ;; esac
    fi
  done
  if [ -n "$blocked" ]; then echo 'Quit OOP with Cmd+Q before installing this update.' >&2; exit 1; fi
`;
}

export function preinstallScript(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Invalid package version.");
  return `#!/bin/sh
set -eu
target=/Applications/OoP.app
if [ "$(/usr/bin/id -u)" != '0' ]; then echo 'System installation requires administrator authorization.' >&2; exit 1; fi
if [ -L "$target" ]; then echo 'OOP install path is a symlink; refusing replacement.' >&2; exit 1; fi
if [ -e "$target" ]; then
  if [ ! -d "$target" ]; then echo 'OOP install path is not an app bundle.' >&2; exit 1; fi
  plist="$target/Contents/Info.plist"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist") || exit 1
  name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist") || exit 1
  exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist") || exit 1
  if [ "$id" != '${RELEASE_BUNDLE_ID}' ] || [ "$name" != 'OoP' ] || [ "$exe" != 'OoP' ]; then
    echo 'The existing application is not the expected OOP bundle.' >&2; exit 1
  fi
${targetProcessCheck()}  parent='/Library/Application Support/OoP'
  backups="$parent/Updates"
  for path in "$parent" "$backups"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      if [ -L "$path" ] || [ ! -d "$path" ] || [ "$(/usr/bin/stat -f %u "$path")" != '0' ] || [ "$(/usr/bin/stat -f %Lp "$path")" != '700' ]; then
        echo 'Unsafe OOP backup directory ownership or permissions.' >&2; exit 1
      fi
    else
      /bin/mkdir -m 700 "$path"
    fi
  done
  backupDir="$backups/before-${version}-$(/bin/date +%Y%m%d%H%M%S)-$$"
  /bin/mkdir -m 700 "$backupDir"
  backup="$backupDir/OoP.app"
  /usr/bin/ditto "$target" "$backup"
  if [ ! -f "$backup/Contents/Info.plist" ]; then echo 'Could not back up the existing OOP app.' >&2; exit 1; fi
  echo "OOP app backup: $backup"
fi
exit 0
`;
}

export function postinstallScript(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Invalid package version.");
  return `#!/bin/sh
set -eu
target=/Applications/OoP.app
if [ -L "$target" ] || [ ! -d "$target" ]; then echo 'Installed OOP bundle missing or unsafe.' >&2; exit 1; fi
plist="$target/Contents/Info.plist"
id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist") || exit 1
name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist") || exit 1
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist") || exit 1
if [ "$id" != '${RELEASE_BUNDLE_ID}' ] || [ "$name" != 'OoP' ] || [ "$version" != '${version}' ]; then
  echo 'Installed OOP identity or version is incorrect.' >&2; exit 1
fi
# A first install from a downloaded package can leave the app quarantined; clear it so OoP
# opens without the Gatekeeper "Open Anyway" step. Exits 0 when nothing is quarantined.
/usr/bin/xattr -d -r com.apple.quarantine "$target"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$target" || exit 1
exit 0
`;
}

async function sha256File(filePath) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

// Fixed argv and deadlines; a child exiting zero after timeout is still a failure. `rejectStderr` is for
// callers that read the output as data: any stderr fails, and the result waits for the pipes to close so
// stdout and stderr are complete (other callers keep settling on exit and ignore stderr when it exits zero).
export function run(command, args, timeout = 120_000, { rejectStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKill;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (!settled && child.pid) child.kill("SIGKILL");
      }, 5_000);
    }, timeout);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once(rejectStderr ? "close" : "exit", (code, signal) => {
      if (timedOut) finish(new Error(`${command} timed out after ${timeout}ms`));
      else if (code !== 0)
        finish(new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`));
      else if (rejectStderr && stderr !== "")
        finish(new Error(`${command} wrote to stderr: ${stderr.trim()}`));
      else finish(undefined, stdout);
    });
  });
}

export function validateAppMetadata(metadata, expectedVersion) {
  if (
    metadata.identifier !== RELEASE_BUNDLE_ID ||
    metadata.name !== "OoP" ||
    metadata.executable !== "OoP" ||
    metadata.version !== expectedVersion
  ) {
    throw new Error("DMG contains an unexpected app identity or version.");
  }
  if (metadata.architectures.length !== 1 || metadata.architectures[0] !== "arm64") {
    throw new Error("DMG must contain the native arm64 OoP executable.");
  }
  if (!metadata.oopProfileEmbedded) throw new Error("DMG lacks the OoP desktop build profile.");
}

const MAX_BINDING_BYTES = 64 * 1024;

// Check our own productbuild output before publishing. tar alone misses some checksum failures,
// so require its Distribution bytes to match a SHA-1 extracted checksum in the TOC, then the
// release product element. This authenticates content, not member identity or app behavior;
// see signedExtractedSha1s for the own-publisher premise. Both outputs are capped at 64 KiB
// after capture here; the runtime uses streaming caps. No archive entries are written to disk.
export async function assertReleaseBinding(pkgPath, version, runCommand = run) {
  const options = { rejectStderr: true };
  const listing = await runCommand(
    "/usr/bin/tar",
    ["-t", "-f", pkgPath, "--", "Distribution"],
    30_000,
    options,
  );
  if (listing !== "Distribution\n")
    throw new Error("Installer package must contain exactly one Distribution entry.");
  const distribution = await runCommand(
    "/usr/bin/tar",
    ["-x", "-O", "-f", pkgPath, "--", "Distribution"],
    30_000,
    options,
  );
  if (Buffer.byteLength(distribution) > MAX_BINDING_BYTES)
    throw new Error("Installer package Distribution is larger than 64 KiB.");
  const toc = await runCommand(
    "/usr/bin/xar",
    ["--dump-toc=/dev/stdout", "-f", pkgPath],
    30_000,
    options,
  );
  if (Buffer.byteLength(toc) > MAX_BINDING_BYTES)
    throw new Error("Installer package table of contents is larger than 64 KiB.");
  if (
    !signedExtractedSha1s(toc).has(
      NodeCrypto.createHash("sha1").update(distribution, "utf8").digest("hex"),
    )
  ) {
    throw new Error(
      "Installer package Distribution does not match a SHA-1 extracted checksum in its table of contents.",
    );
  }
  if (!hasReleaseBinding(distribution, version)) {
    throw new Error(
      `Installer package Distribution does not carry the OOP release identity for version ${version}.`,
    );
  }
}

async function inspectApp(appPath, runCommand) {
  const plist = NodePath.join(appPath, "Contents", "Info.plist");
  const executable = NodePath.join(appPath, "Contents", "MacOS", "OoP");
  const read = async (key) =>
    (await runCommand("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], 10_000)).trim();
  const architectures = (await runCommand("/usr/bin/lipo", ["-archs", executable], 10_000))
    .trim()
    .split(/\s+/u);
  const asar = await NodeFSP.readFile(NodePath.join(appPath, "Contents", "Resources", "app.asar"));
  return {
    identifier: await read("CFBundleIdentifier"),
    name: await read("CFBundleName"),
    executable: await read("CFBundleExecutable"),
    version: await read("CFBundleShortVersionString"),
    architectures,
    oopProfileEmbedded: asar.includes(Buffer.from('embeddedProfileName = "oop-desktop"')),
  };
}

function mountedDeviceFromPlist(plist, mountPoint) {
  const matches = Array.isArray(plist["system-entities"])
    ? plist["system-entities"].filter((entity) => entity["mount-point"] === mountPoint)
    : [];
  const device = matches[0]?.["dev-entry"];
  if (
    matches.length !== 1 ||
    typeof device !== "string" ||
    !/^\/dev\/disk[0-9]+s[0-9]+$/u.test(device)
  ) {
    throw new Error("Could not identify the private DMG mount device.");
  }
  return device;
}

// Output names of this shape belong to the canonical build of that exact version, the only build that locks
// and moves the feed. Any other build must not overwrite a package the feed may reference by SHA. Matched
// case-insensitively because macOS volumes usually are.
const CANONICAL_PACKAGE_NAME = /^OoP-\d+\.\d+\.\d+-arm64-update\.pkg$/iu;
const PUBLISH_LOCK_NAME = ".oop-update-publish.lock";

function compareStableVersions(left, right) {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// The feed is the version floor for canonical publishes, so only a feed localUpdateFeed could have written
// is trusted: exact keys and values, stable numeric version. Anything else fails closed and is never overwritten.
async function readPublishedFeed(feedPath) {
  const invalid = () =>
    new Error(
      `The published OoP update feed ${feedPath} is not an exact local update feed; fix or remove it before publishing.`,
    );
  let feed;
  try {
    feed = JSON.parse(await NodeFSP.readFile(feedPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw invalid();
    throw error;
  }
  if (typeof feed !== "object" || feed === null || Array.isArray(feed)) throw invalid();
  let expected;
  try {
    expected = localUpdateFeed(feed.version, feed.pkg, feed.size, feed.sha256);
  } catch {
    throw invalid();
  }
  const entries = Object.entries(expected);
  if (
    Object.keys(feed).length !== entries.length ||
    !entries.every(([key, value]) => feed[key] === value)
  )
    throw invalid();
  return feed;
}

const RELEASE_MARKER_NAME = "OOP_RELEASE.json";

const signedCandidateName = (version) => `OoP-${version}-arm64-signed-candidate.pkg`;

// Like macos.mjs: the real path of the deepest existing ancestor, so a symlinked parent cannot hide the target.
async function canonicalFuturePath(target) {
  const suffix = [];
  let existing = NodePath.resolve(target);
  for (;;) {
    try {
      const real = await NodeFSP.realpath(existing);
      return NodePath.join(real, ...suffix.toReversed());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = NodePath.dirname(existing);
      if (parent === existing) throw error;
      suffix.push(NodePath.basename(existing));
      existing = parent;
    }
  }
}

function isInside(parent, child) {
  const relative = NodePath.relative(parent, child);
  return relative.split(NodePath.sep)[0] !== ".." && !NodePath.isAbsolute(relative);
}

async function pathExists(target) {
  try {
    await NodeFSP.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

// Keeps a signed candidate away from places that hold, or look like they hold, published releases: the repository,
// OOP_DESKTOP_UPDATE_DIRECTORY, a directory with the feed or its lock, and any directory below one that carries
// OOP_RELEASE.json (the canonical release folder and its mirrors). This prevents accidents; it is not a sandbox,
// and a process that can swap paths between this check and the renames is not stopped by it.
async function assertSignedOutputLocation(outDir, { repoRoot, env }) {
  const reject = (why) => new Error(`Signed candidate output ${why}.`);
  const realOutDir = await canonicalFuturePath(outDir);
  if (isInside(await NodeFSP.realpath(repoRoot), realOutDir))
    throw reject("must be outside the repository");
  const updateDirectory = env.OOP_DESKTOP_UPDATE_DIRECTORY;
  if (updateDirectory && isInside(await canonicalFuturePath(updateDirectory), realOutDir))
    throw reject("must be outside OOP_DESKTOP_UPDATE_DIRECTORY");
  for (const name of [UPDATE_FEED_NAME, PUBLISH_LOCK_NAME]) {
    if (await pathExists(NodePath.join(realOutDir, name)))
      throw reject(`directory must not contain ${name}`);
  }
  for (let directory = realOutDir; ; directory = NodePath.dirname(directory)) {
    if (await pathExists(NodePath.join(directory, RELEASE_MARKER_NAME)))
      throw reject(`must not be inside a release folder (found ${RELEASE_MARKER_NAME})`);
    if (NodePath.dirname(directory) === directory) break;
  }
}

// Serializes signed candidate builds in one output directory, whatever their version: two builds of the same
// output could both verify and then interleave their package and sidecar renames into a mismatched trio. This is
// not the publish lock, which a candidate never takes. Like it, a lock left by a killed build is never broken
// automatically.
const CANDIDATE_LOCK_NAME = ".oop-signed-candidate.lock";

// Only the explicit signing mode gets here; the environment never selects it. Everything that can fail without
// touching anything runs first (helper import, signing inputs, output location), then the output directory is
// created, the location is checked once more and the candidate lock is taken. A candidate never touches the feed.
async function buildSignedCandidate(input, dependencies) {
  const expectedName = signedCandidateName(input.version);
  if (NodePath.basename(input.output) !== expectedName)
    throw new Error(`Signed candidate output must be named ${expectedName}.`);
  const env = dependencies.env ?? process.env;
  const location = { repoRoot: dependencies.repoRoot ?? DEFAULT_REPO_ROOT, env };
  let helper;
  try {
    helper = await (
      dependencies.loadSigning ??
      (() => import("../apps/desktop/src/updates/LocalPkgCandidateSigning.ts"))
    )();
  } catch (error) {
    throw new Error(
      "The Developer ID signing helper could not be loaded; install workspace dependencies first.",
      { cause: error },
    );
  }
  const signing = helper.resolvePkgSigning(env);
  const outDir = NodePath.dirname(input.output);
  await assertSignedOutputLocation(outDir, location);
  const dmgStat = await NodeFSP.lstat(input.dmg);
  if (!dmgStat.isFile()) throw new Error("DMG must be a regular file, not a symlink.");
  await NodeFSP.mkdir(outDir, { recursive: true });
  await assertSignedOutputLocation(outDir, location);
  const lockPath = NodePath.join(outDir, CANDIDATE_LOCK_NAME);
  try {
    await NodeFSP.mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Another signed candidate build may be running: ${lockPath} exists. Remove it manually only after confirming no candidate build is running.`,
        { cause: error },
      );
    }
    throw error;
  }
  let manifest;
  let failure;
  try {
    manifest = await buildPackage(input, dependencies, false, { helper, signing });
  } catch (error) {
    failure = error;
  }
  try {
    await NodeFSP.rmdir(lockPath);
  } catch (error) {
    const manual = `releasing ${lockPath} failed (${error.message}); remove it manually after confirming no candidate build is running.`;
    throw failure
      ? new Error(`${failure.message}; additionally, ${manual}`, { cause: failure })
      : new Error(`Signed candidate ${input.version} was built, but ${manual}`, { cause: error });
  }
  if (failure) throw failure;
  return manifest;
}

// A canonical build (output OoP-<version>-arm64-update.pkg) publishes the feed last, and only for a version
// strictly newer than the current feed. It holds an exclusive lock directory beside the feed from reading the
// feed through the feed rename, so concurrent publishers cannot both pass the version check. A lock left by a
// killed publisher is never broken automatically. A crash after the package renames but before the feed rename
// leaves an unpublished package above the feed version; retrying that version is allowed and overwrites it.
// Noncanonical outputs (e.g. rollback builds) skip the lock and the feed, but cannot use a canonical name.
// `input.signingMode === "developer-id"` builds the internal signed candidate instead (buildSignedCandidate).
export async function buildOopUpdatePkg(input, dependencies = {}) {
  if (
    !/^\d+\.\d+\.\d+$/u.test(input.version) ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    !input.dmg.endsWith(".dmg") ||
    !input.output.endsWith(".pkg") ||
    (input.signingMode !== undefined && input.signingMode !== SIGNING_MODE)
  ) {
    throw new Error("Invalid OoP installer package input.");
  }
  if (input.signingMode !== undefined) return buildSignedCandidate(input, dependencies);
  const outDir = NodePath.dirname(input.output);
  const packageName = NodePath.basename(input.output);
  const publishFeed = packageName === `OoP-${input.version}-arm64-update.pkg`;
  if (!publishFeed && CANONICAL_PACKAGE_NAME.test(packageName)) {
    throw new Error(
      `${packageName} is reserved for the canonical build of that version; use another output name for version ${input.version}.`,
    );
  }
  if (publishFeed && !isStableFeedVersion(input.version))
    throw new Error("Invalid stable OoP update feed version.");
  const dmgStat = await NodeFSP.lstat(input.dmg);
  if (!dmgStat.isFile()) throw new Error("DMG must be a regular file, not a symlink.");
  await NodeFSP.mkdir(outDir, { recursive: true });
  if (!publishFeed) return buildPackage(input, dependencies, false);
  const lockPath = NodePath.join(outDir, PUBLISH_LOCK_NAME);
  try {
    await NodeFSP.mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Another OoP update publish may be running: ${lockPath} exists. Remove it manually only after confirming no publisher is running.`,
        { cause: error },
      );
    }
    throw error;
  }
  let manifest;
  let failure;
  try {
    const previousFeed = await readPublishedFeed(NodePath.join(outDir, UPDATE_FEED_NAME));
    if (previousFeed && compareStableVersions(input.version, previousFeed.version) <= 0) {
      throw new Error(
        `OoP update ${input.version} is already published or older than the published feed version ${previousFeed.version}; use a newer version to preserve the active feed.`,
      );
    }
    manifest = await buildPackage(input, dependencies, true);
  } catch (error) {
    failure = error;
  }
  try {
    await NodeFSP.rmdir(lockPath);
  } catch (error) {
    const manual = `releasing ${lockPath} failed (${error.message}); remove it manually after confirming no publisher is running.`;
    throw failure
      ? new Error(`${failure.message}; additionally, ${manual}`, { cause: failure })
      : new Error(`OoP update ${input.version} was published, but ${manual}`, { cause: error });
  }
  if (failure) throw failure;
  return manifest;
}

async function readAppAsar(appPath) {
  const asarPath = NodePath.join(appPath, "Contents", "Resources", "app.asar");
  if (!(await NodeFSP.lstat(asarPath)).isFile())
    throw new Error("app.asar must be a regular file.");
  return NodeFSP.readFile(asarPath);
}

// A signed candidate's app must also come from the expected Developer ID Application Team and its app.asar must hold
// only the expected developer-id marker (a whole-archive scan; see checkEmbeddedPolicy for what that does not prove).
async function verifySignedApp(appPath, { helper, signing }, runCommand, readAsar) {
  await runCommand(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      "--verbose=2",
      `-R=${developerIdRequirement(signing.teamId)}`,
      appPath,
    ],
    120_000,
  );
  helper.checkEmbeddedPolicy(await readAsar(appPath), signing.policy);
}

// Signs, notarizes and staples the built package, then judges the stapled bytes themselves: hash, publisher and
// binding checks, hash again. The package is staged under the runtime's canonical name so the runtime's own
// publisher check applies unchanged. Apple only ever receives a package that already carries our pinned
// signature and release identity. A candidate never becomes a feed entry, so nothing here is published.
async function finalizeSignedPackage(
  input,
  { helper, signing },
  work,
  unsignedPackage,
  runCommand,
) {
  const signedDirectory = NodePath.join(work, "signed");
  await NodeFSP.mkdir(signedDirectory, { mode: 0o700 });
  const signedPackage = NodePath.join(signedDirectory, `OoP-${input.version}-arm64-update.pkg`);
  await helper.signPackage(signing, unsignedPackage, signedPackage);
  await assertReleaseBinding(signedPackage, input.version, runCommand);
  const { submissionId } = await helper.notarizeAndStaple(signing, signedPackage);
  const digest = await sha256File(signedPackage);
  await helper.assessNotarizedPackage(signing, signedPackage, input.version);
  await assertReleaseBinding(signedPackage, input.version, runCommand);
  if ((await sha256File(signedPackage)) !== digest)
    throw new Error("Signed installer package changed during final verification.");
  const stat = await NodeFSP.lstat(signedPackage);
  if (
    !stat.isFile() ||
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0 ||
    stat.size > MAX_UPDATE_PACKAGE_SIZE
  )
    throw new Error("Signed installer package is not a valid package of at most 1 GiB.");
  return { path: signedPackage, digest, size: stat.size, submissionId };
}

// Says what passed and, equally, what nobody has looked at. No app notarization is claimed or assessed.
function signedCandidateManifest(input, signing, packageDigest, inputDmgDigest, submissionId) {
  return {
    artifact: NodePath.basename(input.output),
    version: input.version,
    packageSha256: packageDigest,
    inputDmgSha256: inputDmgDigest,
    componentIdentifier: RELEASE_PACKAGE_ID,
    appBundleIdentifier: RELEASE_BUNDLE_ID,
    appInstallPath: "/Applications/OoP.app",
    distribution: "internal-candidate",
    shippable: false,
    packageSigned: true,
    packageNotarized: true,
    stapled: true,
    appNotarizationAssessed: false,
    signing: { mode: SIGNING_MODE, expectedTeamId: signing.teamId },
    notarization: { submissionId },
    validation:
      "Input DMG hash, image integrity, OoP identity/profile/arm64, mounted and copied app strict signatures with the Developer ID Application Team requirement, a whole-app.asar scan that found only the expected developer-id trust marker (not proof of the active main entry; the input DMG is trusted to come from the artifact builder), installer package Developer ID Installer pin, notary service Accepted verdict, stapler validation, pkgutil/spctl notarized-package assessment, release binding, and final package hash passed. Not verified: Installer execution, offline Gatekeeper behavior, certificate revocation, app usability, runtime update admission. The notary submission covered the installer package; the app itself was not separately notarized or assessed.",
  };
}

// Builds the package, then renames it, its sidecars, and (when publishFeed) the feed last. `signed` ({ helper, signing })
// adds the Developer ID checks and finalization; a signed build never publishes the feed.
async function buildPackage(input, dependencies, publishFeed, signed = undefined) {
  const runCommand = dependencies.run ?? run;
  const inspect = dependencies.inspectApp ?? inspectApp;
  const readAsar = dependencies.readAsar ?? readAppAsar;
  const outDir = NodePath.dirname(input.output);
  const packageName = NodePath.basename(input.output);
  const feedPath = NodePath.join(outDir, UPDATE_FEED_NAME);
  const work = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-update-pkg-")),
  );
  const copiedDmg = NodePath.join(work, "input.dmg");
  const mountPoint = NodePath.join(work, "mount");
  const payloadRoot = NodePath.join(work, "payload");
  const stagedApp = NodePath.join(payloadRoot, "Applications", APP_NAME);
  const scriptsDir = NodePath.join(work, "scripts");
  const resourcesDir = NodePath.join(work, "resources");
  const builtComponent = NodePath.join(work, "component.pkg");
  const builtProduct = NodePath.join(work, "product.pkg");
  const finalTemp = NodePath.join(
    outDir,
    `.${NodePath.basename(input.output)}.${NodeCrypto.randomUUID()}.tmp.pkg`,
  );
  const feedTemp = NodePath.join(outDir, `.${UPDATE_FEED_NAME}.${NodeCrypto.randomUUID()}.tmp`);
  let mountMayRemain = false;
  try {
    await NodeFSP.copyFile(input.dmg, copiedDmg);
    const actualDigest = await sha256File(copiedDmg);
    if (actualDigest !== input.sha256)
      throw new Error("Input DMG SHA-256 does not match the trusted digest.");
    let device;
    let attachAttempted = false;
    let failure;
    try {
      await NodeFSP.mkdir(mountPoint, { mode: 0o700 });
      await runCommand("/usr/bin/hdiutil", ["verify", copiedDmg], 120_000);
      attachAttempted = true;
      mountMayRemain = true;
      const attachedPlist = await runCommand(
        "/usr/bin/hdiutil",
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-plist",
          "-mountpoint",
          mountPoint,
          copiedDmg,
        ],
        60_000,
      );
      const attachedPlistPath = NodePath.join(work, "attached.plist");
      await NodeFSP.writeFile(attachedPlistPath, attachedPlist);
      device = mountedDeviceFromPlist(
        JSON.parse(
          await runCommand(
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", attachedPlistPath],
            10_000,
          ),
        ),
        mountPoint,
      );
      const mountedApp = NodePath.join(mountPoint, APP_NAME);
      const mountedStat = await NodeFSP.lstat(mountedApp);
      if (!mountedStat.isDirectory()) throw new Error("Expected OoP.app directory inside DMG.");
      await runCommand(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", mountedApp],
        120_000,
      );
      validateAppMetadata(await inspect(mountedApp, runCommand), input.version);
      if (signed) await verifySignedApp(mountedApp, signed, runCommand, readAsar);
      await NodeFSP.mkdir(NodePath.dirname(stagedApp), { recursive: true });
      await runCommand("/usr/bin/ditto", [mountedApp, stagedApp], 120_000);
      await runCommand(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", stagedApp],
        120_000,
      );
      validateAppMetadata(await inspect(stagedApp, runCommand), input.version);
      if (signed) await verifySignedApp(stagedApp, signed, runCommand, readAsar);
    } catch (error) {
      failure = error;
    }
    if (attachAttempted) {
      try {
        await runCommand("/usr/bin/hdiutil", ["detach", device ?? mountPoint], 60_000);
        mountMayRemain = false;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    await NodeFSP.mkdir(scriptsDir);
    await NodeFSP.mkdir(resourcesDir);
    await NodeFSP.writeFile(
      NodePath.join(scriptsDir, "preinstall"),
      preinstallScript(input.version),
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(
      NodePath.join(scriptsDir, "postinstall"),
      postinstallScript(input.version),
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(NodePath.join(resourcesDir, "welcome.html"), welcomeHtml());
    const plistPath = NodePath.join(work, "components.plist");
    const distributionPath = NodePath.join(work, "Distribution.xml");
    await NodeFSP.writeFile(plistPath, componentPlist());
    await NodeFSP.writeFile(distributionPath, distributionXml(input.version));
    await runCommand("/usr/bin/plutil", ["-lint", plistPath], 10_000);
    await runCommand("/usr/bin/xmllint", ["--noout", distributionPath], 10_000);
    await runCommand(
      "/usr/bin/pkgbuild",
      [
        "--root",
        payloadRoot,
        "--install-location",
        "/",
        "--component-plist",
        plistPath,
        "--scripts",
        scriptsDir,
        "--identifier",
        RELEASE_PACKAGE_ID,
        "--version",
        input.version,
        builtComponent,
      ],
      180_000,
    );
    await runCommand(
      "/usr/bin/productbuild",
      [
        "--distribution",
        distributionPath,
        "--package-path",
        work,
        "--resources",
        resourcesDir,
        builtProduct,
      ],
      180_000,
    );
    const packageStat = await NodeFSP.stat(builtProduct);
    if (
      !packageStat.isFile() ||
      !Number.isSafeInteger(packageStat.size) ||
      packageStat.size <= 0 ||
      packageStat.size > MAX_UPDATE_PACKAGE_SIZE
    )
      throw new Error("productbuild did not create a valid package of at most 1 GiB.");
    await assertReleaseBinding(builtProduct, input.version, runCommand);
    const finalPackage = signed
      ? await finalizeSignedPackage(input, signed, work, builtProduct, runCommand)
      : { path: builtProduct, digest: await sha256File(builtProduct), size: packageStat.size };
    const packageDigest = finalPackage.digest;
    await NodeFSP.copyFile(finalPackage.path, finalTemp);
    if ((await sha256File(finalTemp)) !== packageDigest)
      throw new Error("Copied installer package SHA-256 mismatch.");
    const copiedPackageStat = await NodeFSP.stat(finalTemp);
    if (copiedPackageStat.size !== finalPackage.size)
      throw new Error("Copied installer package size mismatch.");
    const checksumTemp = `${finalTemp}.sha256`;
    const manifestTemp = `${finalTemp}.json`;
    const manifest = signed
      ? signedCandidateManifest(
          input,
          signed.signing,
          packageDigest,
          actualDigest,
          finalPackage.submissionId,
        )
      : {
          artifact: NodePath.basename(input.output),
          version: input.version,
          packageSha256: packageDigest,
          inputDmgSha256: actualDigest,
          componentIdentifier: RELEASE_PACKAGE_ID,
          appBundleIdentifier: RELEASE_BUNDLE_ID,
          appInstallPath: "/Applications/OoP.app",
          validation:
            "Input DMG hash, image integrity, OoP identity/profile/arm64, mounted and copied app strict signatures, and output package hash passed. Installer execution and app usability not verified.",
          packageSigned: false,
          appNotarized: false,
        };
    await NodeFSP.writeFile(checksumTemp, `${packageDigest}  ${NodePath.basename(input.output)}\n`);
    await NodeFSP.writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n");
    if (publishFeed) {
      const feed = localUpdateFeed(
        input.version,
        packageName,
        copiedPackageStat.size,
        packageDigest,
      );
      await NodeFSP.writeFile(feedTemp, JSON.stringify(feed, null, 2) + "\n");
    }
    // Commit. Every check and temp write has passed, so only now are the previous sidecars removed: a failure
    // before this point leaves the earlier package and both sidecars untouched, and a failure partway through the
    // renames can leave a package without sidecars but never a new package beside a stale hash or manifest. The
    // sequence is not atomic: after the removals, a failed or interrupted rename can still leave the old package
    // with no sidecars, or the new package with none or only one.
    await NodeFSP.rm(`${input.output}.sha256`, { force: true });
    await NodeFSP.rm(`${input.output}.json`, { force: true });
    await NodeFSP.rename(finalTemp, input.output);
    await NodeFSP.rename(checksumTemp, `${input.output}.sha256`);
    await NodeFSP.rename(manifestTemp, `${input.output}.json`);
    if (publishFeed) await NodeFSP.rename(feedTemp, feedPath);
    return manifest;
  } finally {
    if (!mountMayRemain) await NodeFSP.rm(work, { recursive: true, force: true });
    await NodeFSP.rm(finalTemp, { force: true });
    await NodeFSP.rm(`${finalTemp}.sha256`, { force: true });
    await NodeFSP.rm(`${finalTemp}.json`, { force: true });
    await NodeFSP.rm(feedTemp, { force: true });
  }
}

const RELEASE_ARTIFACT_NAME = /^OoP-(\d+\.\d+\.\d+)-/u;

/**
 * Build files a publish of `publishedVersion` makes obsolete: every OoP-<version>-* file older than
 * both the published version and the newest version before it. Newer, unpublished leftovers stay.
 */
export function releaseArtifactsToPrune(names, publishedVersion) {
  const versionOf = (name) => RELEASE_ARTIFACT_NAME.exec(name)?.[1];
  const older = [...new Set(names.map(versionOf))]
    .filter(
      (version) => version !== undefined && compareStableVersions(version, publishedVersion) < 0,
    )
    .sort(compareStableVersions);
  const previous = older.at(-1);
  return names.filter((name) => {
    const version = versionOf(name);
    return (
      version !== undefined &&
      version !== previous &&
      compareStableVersions(version, publishedVersion) < 0
    );
  });
}

/** Keeps the release folder to the published version and the one before it. */
export async function pruneOldReleases(outDir, publishedVersion) {
  const entries = await NodeFSP.readdir(outDir, { withFileTypes: true });
  const obsolete = releaseArtifactsToPrune(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    publishedVersion,
  );
  for (const name of obsolete) await NodeFSP.rm(NodePath.join(outDir, name), { force: true });
  return obsolete;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildOopUpdatePkg(args);
    console.log(
      `${args.signingMode ? "Signed candidate package (internal, not shippable)" : "Installer package"}: ${args.output}\nSHA-256: ${result.packageSha256}`,
    );
    // Only a published canonical build retires older builds; a failed cleanup never fails the publish.
    if (
      !args.signingMode &&
      NodePath.basename(args.output) === `OoP-${args.version}-arm64-update.pkg`
    ) {
      try {
        const removed = await pruneOldReleases(NodePath.dirname(args.output), args.version);
        if (removed.length > 0)
          console.log(
            `Removed ${removed.length} older build files, keeping ${args.version} and the version before it.`,
          );
      } catch (error) {
        console.warn(
          `[oop-update-pkg] Could not remove older builds: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(`[oop-update-pkg] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
