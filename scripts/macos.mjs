#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- This dependency-free bootstrap runs before workspace dependencies are installed; tests inject host values. */

// Local macOS workflow for source kept on a NAS. The only rsync deletion target
// is a checkout created and marked by this script inside an owned cache root.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assertReleaseNotes, macDmgName } from "./oop-release-names.mjs";

export const SOURCE_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
export const PACKAGE_MANAGER_VERSION = "11.10.0";
export const MIN_NODE_VERSION = [24, 13, 1];
/**
 * Where the OOP Mac app looks for updates first: OOP/release/macos in Google Drive for desktop,
 * whose root is named after the account and is "My Drive" or, on a Korean Mac, "내 드라이브".
 * The source's own release/macos stays the last candidate.
 */
export const MAC_DRIVE_UPDATE_CANDIDATES = [
  "~/Library/CloudStorage/GoogleDrive-*/My Drive/OOP/release/macos",
  "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OOP/release/macos",
];
const MARKER = ".oop-macos-owned.json";
const LOCK = ".oop-macos.lock";

export const RSYNC_EXCLUDES = [
  ".git/",
  "/.claude/skills",
  "node_modules/",
  ".pnpm-store/",
  ".t3/",
  ".env",
  ".env.*",
  ".npmrc",
  ".DS_Store",
  "release/",
  "dist/",
  "dist-electron/",
  ".vite-plus/",
  ".electron-runtime/",
  "target/",
  ".turbo/",
  ".next/",
  "coverage/",
  "test-results/",
  "playwright-report/",
  "*.pem",
  "*.p12",
  "*.p8",
  "*.key",
  "*.mobileprovision",
  "secrets/",
  ".secrets/",
  "credentials/",
  ".credentials/",
];

export function parseArgs(argv) {
  const commands = new Set(["doctor", "setup", "build", "package", "start"]);
  const [command, ...unparsed] = argv;
  const rest = unparsed[0] === "--" ? unparsed.slice(1) : unparsed;
  if (!commands.has(command))
    throw new Error(
      "Usage: node scripts/macos.mjs <doctor|setup|build|package|start> [--cache-dir PATH] [package --signing-mode developer-id]",
    );
  let cacheDir;
  let signingMode;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    const value = rest[i + 1];
    const repeated = option === "--cache-dir" ? cacheDir !== undefined : signingMode !== undefined;
    const known =
      option === "--cache-dir" || (option === "--signing-mode" && command === "package");
    if (!known || repeated || !value || value.startsWith("--"))
      throw new Error(`Unknown or incomplete option: ${option}`);
    if (option === "--cache-dir") cacheDir = value;
    else if (value === "developer-id") signingMode = value;
    else throw new Error(`Unknown signing mode: ${value}`);
    i++;
  }
  // `package` without the explicit selector stays ad hoc; the key is absent, not undefined.
  return { command, cacheDir, ...(signingMode ? { signingMode } : {}) };
}

// The Developer ID candidate is internal-only and chosen solely by
// `package --signing-mode developer-id`. These checks are input validation:
// they do not authenticate the certificate that actually signs the app.
const BUNDLE_ID = "com.t3tools.t3code";
const DEVELOPER_ID_IDENTITY = /^Developer ID Application: [^\p{Cc}]+ \(([A-Z0-9]{10})\)$/u;
const PASSKEY_SIGNING_INPUTS = [
  "T3CODE_MACOS_PROVISIONING_PROFILE",
  "T3CODE_CLERK_PASSKEY_RP_DOMAINS",
];
const INSTALLER_LEAF_PIN = /^[a-f0-9]{64}$/;
// The values the builder's boolean config reads as true; the candidate never reuses an existing build.
const SKIP_BUILD_TRUE = new Set(["true", "yes", "on", "1", "y"]);

export function resolvePackageSigning(signingMode, env) {
  if (signingMode === undefined) return undefined;
  for (const key of PASSKEY_SIGNING_INPUTS) {
    if (env[key]?.trim())
      throw new Error(
        `${key} configures passkey signing and cannot be combined with --signing-mode developer-id`,
      );
  }
  const identity = env.CSC_NAME?.trim() ?? "";
  const rawTeamId = env.T3CODE_APPLE_TEAM_ID?.trim() ?? "";
  if (!identity || !rawTeamId)
    throw new Error("--signing-mode developer-id requires CSC_NAME and T3CODE_APPLE_TEAM_ID");
  const teamId = rawTeamId.toUpperCase();
  if (!/^[A-Z0-9]{10}$/u.test(teamId))
    throw new Error("T3CODE_APPLE_TEAM_ID must be a 10-character Apple Team ID");
  const identityTeamId = DEVELOPER_ID_IDENTITY.exec(identity)?.[1];
  if (identityTeamId === undefined)
    throw new Error(
      'CSC_NAME must be the exact "Developer ID Application: Name (TEAMID)" identity',
    );
  if (identityTeamId !== teamId)
    throw new Error("CSC_NAME Team ID does not match T3CODE_APPLE_TEAM_ID");
  if (SKIP_BUILD_TRUE.has(env.T3CODE_DESKTOP_SKIP_BUILD))
    throw new Error(
      "--signing-mode developer-id always builds and cannot be combined with T3CODE_DESKTOP_SKIP_BUILD",
    );
  // Format check only, never echoed; the artifact builder validates them again with the runtime's policy schema.
  const installerLeafPins = env.T3CODE_MACOS_INSTALLER_LEAF_SHA256 ?? "";
  if (!installerLeafPins)
    throw new Error("--signing-mode developer-id requires T3CODE_MACOS_INSTALLER_LEAF_SHA256");
  const pins = installerLeafPins.split(",");
  if (
    pins.length > 3 ||
    pins.some((pin) => !INSTALLER_LEAF_PIN.test(pin)) ||
    new Set(pins).size !== pins.length
  ) {
    throw new Error(
      "T3CODE_MACOS_INSTALLER_LEAF_SHA256 must be 1 to 3 different comma-separated lowercase SHA-256 hex fingerprints",
    );
  }
  return { mode: signingMode, identity, teamId, installerLeafPins };
}

// Opt-in stable signing identity (see docs/operations/macos-oop.md). It replaces ad hoc signing only
// and never combines with the Developer ID candidate, whose flag selects a different signer.
// The Windows runner copies this file without ./desktop-build (RUNNER_SCRIPTS in windows.mjs), so
// the name and checks mirror desktop-build/mac-signature.ts here and its verifier loads lazily.
const MAC_LOCAL_SIGN_IDENTITY_ENV = "OOP_MAC_LOCAL_SIGN_IDENTITY";

export function resolveLocalSignIdentity(signingMode, env) {
  const identity = env[MAC_LOCAL_SIGN_IDENTITY_ENV]?.trim() || undefined;
  if (identity === undefined) return undefined;
  if (signingMode !== undefined)
    throw new Error(
      `${MAC_LOCAL_SIGN_IDENTITY_ENV} cannot be combined with --signing-mode ${signingMode}`,
    );
  if (identity === "-" || /\p{Cc}/u.test(identity))
    throw new Error(
      `${MAC_LOCAL_SIGN_IDENTITY_ENV} must be a keychain identity name or SHA-1 hash, not "-" or text with control characters`,
    );
  return identity;
}

const IDENTITY_LINE = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"/;

function listsIdentity(findIdentityOutput, identity) {
  return findIdentityOutput.split("\n").some((line) => {
    const match = IDENTITY_LINE.exec(line);
    return match && (match[2] === identity || match[1].toLowerCase() === identity.toLowerCase());
  });
}

// `validOutput` is `security find-identity -v -p codesigning` (usable identities only) and
// `allOutput` the same without -v. electron-builder and @electron/osx-sign only see the valid list,
// so an identity that appears only in the full list is untrusted and would be skipped silently.
export function localSignIdentityProblem(identity, validOutput, allOutput) {
  if (listsIdentity(validOutput, identity)) return undefined;
  if (listsIdentity(allOutput, identity))
    return `${MAC_LOCAL_SIGN_IDENTITY_ENV} identity "${identity}" exists but is not trusted for code signing. 키체인 접근에서 해당 인증서를 열고 신뢰 > 코드 서명을 "항상 신뢰"로 바꾸세요. / In Keychain Access open the certificate, set Trust > Code Signing to "Always Trust".`;
  return `${MAC_LOCAL_SIGN_IDENTITY_ENV} identity "${identity}" was not found among the code-signing identities. 키체인 접근 > 인증서 지원 > 인증서 생성에서 이름 "${identity}", 신원 유형 "자체 서명 루트", 인증서 유형 "코드 서명"으로 만드세요. / Create it in Keychain Access > Certificate Assistant > Create a Certificate (Self-Signed Root, Code Signing), or fix the name. See docs/operations/macos-oop.md.`;
}

function securityCodesigningIdentities(valid) {
  const result = NodeChildProcess.spawnSync(
    "/usr/bin/security",
    ["find-identity", ...(valid ? ["-v"] : []), "-p", "codesigning"],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout : "";
}

// Evaluated by `codesign -R`: Apple-anchored chain, Developer ID Application
// leaf (OID ...6.1.13) issued under the Developer ID CA (OID ...6.2.6), the
// expected Team as certificate OU, and the product's bundle identifier.
export function developerIdRequirement(teamId) {
  return `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

export function sourceKey(sourceRoot) {
  return NodeCrypto.createHash("sha256")
    .update(NodePath.normalize(sourceRoot).normalize("NFC"))
    .digest("hex")
    .slice(0, 16);
}

export function defaultCacheRoot(sourceRoot, home = NodeOS.homedir()) {
  return NodePath.join(home, "Library", "Caches", "OOP_DeskTop", sourceKey(sourceRoot));
}

export function runtimePaths(sourceRoot, home = NodeOS.homedir()) {
  const root = NodePath.join(
    home,
    "Library",
    "Application Support",
    "OOP_DeskTop",
    sourceKey(sourceRoot),
  );
  return {
    root,
    t3Home: NodePath.join(root, "t3-home"),
    userData: NodePath.join(root, "electron-profile"),
  };
}

export async function releaseVersion(sourceRoot) {
  const release = JSON.parse(
    await NodeFSP.readFile(NodePath.join(sourceRoot, "OOP_RELEASE.json"), "utf8"),
  );
  if (
    typeof release.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)
  ) {
    throw new Error("OOP_RELEASE.json must contain a stable OOP version such as 0.0.45");
  }
  return release.version;
}

export async function upstreamVersion(sourceRoot) {
  const upstream = JSON.parse(
    await NodeFSP.readFile(NodePath.join(sourceRoot, "UPSTREAM.json"), "utf8"),
  );
  const match = /^v(\d+\.\d+\.\d+)$/.exec(upstream.source?.tag ?? "");
  if (!match) throw new Error("UPSTREAM.json must contain the original stable release tag");
  return match[1];
}

export function isolatedEnvironment(baseEnv, runtime) {
  const env = { ...baseEnv };
  env.T3CODE_HOME = runtime.t3Home;
  env.T3CODE_DESKTOP_USER_DATA_DIR = runtime.userData;
  env.T3CODE_DISABLE_AUTO_UPDATE = "true";
  delete env.GITHUB_REPOSITORY;
  delete env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
  delete env.OOP_DESKTOP_UPDATE_DIRECTORY;
  delete env.OOP_DESKTOP_UPDATE_CONNECT_URL;
  delete env.OOP_DESKTOP_UPDATE_CANDIDATES;
  delete env.OOP_DESKTOP_UPDATE_FOLDER_KIND;
  delete env.ELECTRON_RUN_AS_NODE;
  // Build-time only: LOCAL_PKG_TRUST_BUILD_ENV in apps/desktop/src/updates/LocalPkgTrustPolicy.ts (not importable before install).
  delete env.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST;
  return env;
}

export function packagingEnvironment(baseEnv) {
  const env = { ...baseEnv };
  delete env.GITHUB_REPOSITORY;
  delete env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
  delete env.T3CODE_DESKTOP_VERSION;
  delete env.T3CODE_DESKTOP_TARGET;
  delete env.T3CODE_DESKTOP_ARCH;
  delete env.T3CODE_DESKTOP_PLATFORM;
  delete env.T3CODE_DESKTOP_OUTPUT_DIR;
  delete env.T3CODE_DESKTOP_SIGNED;
  delete env.T3CODE_DESKTOP_MOCK_UPDATES;
  delete env.OOP_DESKTOP_UPDATE_DIRECTORY;
  delete env.OOP_DESKTOP_UPDATE_CONNECT_URL;
  delete env.OOP_DESKTOP_UPDATE_CANDIDATES;
  delete env.OOP_DESKTOP_UPDATE_FOLDER_KIND;
  // Build-time only: LOCAL_PKG_TRUST_BUILD_ENV in apps/desktop/src/updates/LocalPkgTrustPolicy.ts (not importable before install).
  delete env.OOP_DESKTOP_BUILD_LOCAL_PKG_TRUST;
  delete env.T3CODE_MACOS_INSTALLER_LEAF_SHA256;
  return env;
}

// Finds the SMB share that holds `target` in `mount` output, so the built app can point a new PC
// at it (`//user@host/share on /Volumes/share (smbfs, ...)` becomes `smb://host/share`).
export function smbShareUrlForPath(mountOutput, target) {
  let best;
  for (const line of mountOutput.split("\n")) {
    const match = /^\/\/(?:[^@\s/]+@)?([^/\s]+)\/(\S+) on (.+) \(smbfs[,)]/u.exec(line);
    if (!match) continue;
    const [, host, share, mountPoint] = match;
    if (target !== mountPoint && !target.startsWith(`${mountPoint}/`)) continue;
    if (best === undefined || mountPoint.length > best.mountPoint.length)
      best = { host, share, mountPoint };
  }
  return best === undefined ? undefined : `smb://${best.host}/${best.share}`;
}

function readMounts() {
  try {
    return NodeChildProcess.execFileSync("/sbin/mount", { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    console.warn(`Could not read mounts for the update share address: ${error.message}`);
    return "";
  }
}

function checkoutEnvironment(paths, baseEnv, isolated = false) {
  const env = isolated
    ? isolatedEnvironment(baseEnv, runtimePaths(paths.source))
    : packagingEnvironment(baseEnv);
  env.PATH = [NodePath.join(paths.checkout, "node_modules", ".bin"), baseEnv.PATH]
    .filter(Boolean)
    .join(NodePath.delimiter);
  env.T3CODE_DESKTOP_BUILD_PROFILE_NAME = "oop-desktop";
  if (!isolated) {
    env.OOP_DESKTOP_UPDATE_DIRECTORY = NodePath.join(paths.source, "release", "macos");
    env.OOP_DESKTOP_UPDATE_CANDIDATES = JSON.stringify(MAC_DRIVE_UPDATE_CANDIDATES);
    env.OOP_DESKTOP_UPDATE_FOLDER_KIND = "google-drive";
    const connectUrl = smbShareUrlForPath(readMounts(), env.OOP_DESKTOP_UPDATE_DIRECTORY);
    if (connectUrl !== undefined) env.OOP_DESKTOP_UPDATE_CONNECT_URL = connectUrl;
  }
  return env;
}

export function assertSeparatePaths(sourceRoot, cacheRoot) {
  const source = NodePath.resolve(sourceRoot);
  const cache = NodePath.resolve(cacheRoot);
  if (
    source === cache ||
    source.startsWith(`${cache}${NodePath.sep}`) ||
    cache.startsWith(`${source}${NodePath.sep}`)
  ) {
    throw new Error(`Source and cache must be separate directories: ${source} / ${cache}`);
  }
}

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

export async function resolvePaths(sourceRoot, cacheOverride) {
  const source = await NodeFSP.realpath(sourceRoot);
  const cache = await canonicalFuturePath(cacheOverride ?? defaultCacheRoot(source));
  assertSeparatePaths(source, cache);
  const checkout = NodePath.join(cache, "checkout");
  return { source, cache, checkout, artifactRoot: NodePath.join(cache, "artifacts") };
}

function versionAtLeast(version, minimum) {
  const actual = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index] || !Number.isFinite(actual[index])) return false;
  }
  return true;
}

export function validateHost({
  platform = NodeOS.platform(),
  arch = NodeOS.arch(),
  nodeVersion = process.versions.node,
  pnpmVersion,
} = {}) {
  const problems = [];
  if (platform !== "darwin") problems.push(`macOS required (found ${platform})`);
  if (arch !== "arm64") problems.push(`Apple Silicon arm64 required (found ${arch})`);
  if (!versionAtLeast(nodeVersion, MIN_NODE_VERSION) || Number(nodeVersion.split(".")[0]) !== 24) {
    problems.push(`Node 24.13.1 or newer 24.x required (found ${nodeVersion})`);
  }
  if (pnpmVersion !== PACKAGE_MANAGER_VERSION)
    problems.push(`pnpm ${PACKAGE_MANAGER_VERSION} required (found ${pnpmVersion ?? "missing"})`);
  return problems;
}

function toolVersion(command) {
  const result = NodeChildProcess.spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function mountFilesystemType(mountOutput, target) {
  const mounts = mountOutput.split("\n").flatMap((line) => {
    const match = /^.* on (.+?) \(([^,)]+)/.exec(line);
    return match ? [{ path: match[1], type: match[2] }] : [];
  });
  return mounts
    .filter(
      (mount) =>
        mount.path === NodePath.sep ||
        target === mount.path ||
        target.startsWith(`${mount.path}${NodePath.sep}`),
    )
    .sort((left, right) => right.path.length - left.path.length)[0]?.type;
}

function fsType(target) {
  const result = NodeChildProcess.spawnSync("mount", [], { encoding: "utf8" });
  return result.status === 0 ? mountFilesystemType(result.stdout, target) : undefined;
}

async function nearestExistingDirectory(target) {
  let current = target;
  for (;;) {
    try {
      const stat = await NodeFSP.stat(current);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot inspect ${current}`, { cause: error });
      const parent = NodePath.dirname(current);
      if (parent === current)
        throw new Error(`Cannot resolve parent directory for ${target}`, { cause: error });
      current = parent;
    }
  }
}

export async function doctor(
  paths,
  localIdentity = undefined,
  listIdentities = securityCodesigningIdentities,
) {
  const cacheMount = await nearestExistingDirectory(paths.cache);
  const type = NodeOS.platform() === "darwin" ? fsType(cacheMount) : undefined;
  const problems = validateHost({ pnpmVersion: toolVersion("pnpm") });
  if (!toolVersion("rsync")) problems.push("rsync is required");
  if (!toolVersion("cargo")) problems.push("Rust (cargo) is required: https://rustup.rs");
  if (type && type.toLowerCase() !== "apfs")
    problems.push(`Cache must be on local APFS (found ${type})`);
  if (type === undefined && NodeOS.platform() === "darwin")
    problems.push("Could not determine cache filesystem type");
  if (localIdentity !== undefined) {
    const problem = localSignIdentityProblem(
      localIdentity,
      listIdentities(true),
      listIdentities(false),
    );
    if (problem) problems.push(problem);
  }
  console.log(`Source: ${paths.source}`);
  console.log(`Local cache: ${paths.cache}`);
  if (type) console.log(`Cache filesystem: ${type}`);
  console.log(`Node: ${process.versions.node}; pnpm: ${toolVersion("pnpm") ?? "missing"}`);
  if (localIdentity !== undefined) console.log(`Local signing identity: ${localIdentity}`);
  if (problems.length) throw new Error(problems.join("\n"));
  return { filesystem: type };
}

async function prepareOwnedCache(paths) {
  const markerPath = NodePath.join(paths.cache, MARKER);
  let marker;
  try {
    marker = JSON.parse(await NodeFSP.readFile(markerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`Invalid cache ownership marker: ${markerPath}`, { cause: error });
  }
  if (marker) {
    if (marker.source !== paths.source || marker.format !== 1)
      throw new Error(`Cache belongs to another source: ${paths.cache}`);
  } else {
    let entries = [];
    try {
      entries = await NodeFSP.readdir(paths.cache);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (entries.length) throw new Error(`Refusing nonempty unowned cache: ${paths.cache}`);
    await NodeFSP.mkdir(paths.cache, { recursive: true });
    await NodeFSP.writeFile(
      markerPath,
      JSON.stringify({ format: 1, source: paths.source }, null, 2) + "\n",
      { flag: "wx" },
    );
  }
  try {
    const checkout = await NodeFSP.lstat(paths.checkout);
    if (!checkout.isDirectory() || checkout.isSymbolicLink())
      throw new Error(`Unsafe checkout path: ${paths.checkout}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await NodeFSP.mkdir(paths.checkout, { recursive: true });
}

async function withLock(paths, action) {
  await prepareOwnedCache(paths);
  const lockPath = NodePath.join(paths.cache, LOCK);
  let handle;
  try {
    handle = await NodeFSP.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Another macOS workflow owns ${paths.cache}; inspect ${lockPath}`, {
        cause: error,
      });
    throw new Error(`Cannot acquire workflow lock at ${lockPath}`, { cause: error });
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, source: paths.source }) + "\n");
    return await action();
  } finally {
    await handle.close();
    await NodeFSP.unlink(lockPath);
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout, ...spawnOptions } = options;
    const child = NodeChildProcess.spawn(command, args, { stdio: "inherit", ...spawnOptions });
    let settled = false;
    let timedOut = false;
    let interruptedSignal;
    let forceKillTimer;
    const terminate = (signal) => {
      if (child.pid) child.kill(signal);
      forceKillTimer ??= setTimeout(() => {
        if (!settled && child.pid) child.kill("SIGKILL");
      }, 5_000);
    };
    const onSigInt = () => {
      interruptedSignal = "SIGINT";
      terminate("SIGINT");
    };
    const onSigTerm = () => {
      interruptedSignal = "SIGTERM";
      terminate("SIGTERM");
    };
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    const timeoutTimer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate("SIGTERM");
          }, timeout);
    const cleanup = () => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut)
        reject(
          Object.assign(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms`), {
            exitCode: 124,
          }),
        );
      else if (interruptedSignal)
        reject(
          Object.assign(
            new Error(`${command} ${args.join(" ")} interrupted (${interruptedSignal})`),
            { exitCode: interruptedSignal === "SIGINT" ? 130 : 143 },
          ),
        );
      else if (code === 0) resolve();
      else
        reject(
          Object.assign(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`), {
            exitCode: signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 1),
          }),
        );
    });
  });
}

export async function syncSource(paths, runner = runCommand) {
  await runner("rsync", [
    "-a",
    "--safe-links",
    "--delete",
    ...RSYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    `${paths.source}${NodePath.sep}`,
    `${paths.checkout}${NodePath.sep}`,
  ]);
}

async function install(paths, runner) {
  await runner(
    "pnpm",
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
    { cwd: paths.checkout, env: checkoutEnvironment(paths, process.env) },
  );
}

export async function build(paths, runner) {
  await runner(
    NodePath.join(paths.checkout, "node_modules", ".bin", "vp"),
    ["run", "build:desktop"],
    { cwd: paths.checkout, env: checkoutEnvironment(paths, process.env) },
  );
}

// The Rust terminal client (apps/oop-tui-rs, `oop-rs`) and the native terminal program
// (apps/oop-terminal, `OOP Terminal.app`) are built here and handed to the artifact builder with
// OOP_RS_BIN and OOP_TERMINAL_APP. oop-rs is the only terminal, so its build is mandatory. The
// build runs in the checkout, whose target/ folders the rsync neither copies nor deletes, so
// repeated builds stay incremental.
export const RUST_CLIENT_DIR = "apps/oop-tui-rs";
export const RUST_TERMINAL_DIR = "apps/oop-terminal";
export const TERMINAL_APP_BUNDLE_NAME = "OOP Terminal.app";

/** The release version reaches cargo as OOP_VERSION; ~/.cargo/bin is added for a rustup toolchain. */
export function rustBuildEnvironment(baseEnv, version, home = NodeOS.homedir()) {
  const env = packagingEnvironment(baseEnv);
  env.OOP_VERSION = version;
  env.PATH = [baseEnv.PATH, NodePath.join(home, ".cargo", "bin")]
    .filter(Boolean)
    .join(NodePath.delimiter);
  return env;
}

export function cargoReleaseArgs({ locked }) {
  return ["build", "--release", ...(locked ? ["--locked"] : [])];
}

/** The newest `OOP Terminal.app` the bundle script left below `root`, or undefined. */
export async function findTerminalApp(root) {
  let best;
  const visit = async (directory, depth) => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = NodePath.join(directory, entry.name);
      if (entry.name === TERMINAL_APP_BUNDLE_NAME) {
        const { mtimeMs } = await NodeFSP.stat(full);
        if (best === undefined || mtimeMs > best.mtimeMs) best = { full, mtimeMs };
      } else if (
        depth < 4 &&
        !["node_modules", "deps", "build", "incremental"].includes(entry.name)
      ) {
        await visit(full, depth + 1);
      }
    }
  };
  await visit(root, 0);
  return best?.full;
}

async function exists(target) {
  return NodeFSP.stat(target).then(
    () => true,
    () => false,
  );
}

/**
 * `cargo build --release` for oop-rs, then, when apps/oop-terminal is in the source, for the
 * terminal program and its scripts/bundle-macos.sh with OOP_RS_BIN naming the oop-rs it embeds.
 * Returns the environment the artifact builder reads. oop-rs must print the release version, so a
 * stale build cannot ship under a new version number.
 */
export async function buildRustClients(
  paths,
  runner,
  version,
  baseEnv = process.env,
  printedVersion = (binary) =>
    NodeChildProcess.execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
) {
  const cliDir = NodePath.join(paths.checkout, RUST_CLIENT_DIR);
  if (!(await exists(NodePath.join(cliDir, "Cargo.toml"))))
    throw new Error(`${RUST_CLIENT_DIR} is missing from this source: oop-rs is the only terminal.`);
  const env = rustBuildEnvironment(baseEnv, version);
  const cargo = async (cwd) =>
    runner("cargo", cargoReleaseArgs({ locked: await exists(NodePath.join(cwd, "Cargo.lock")) }), {
      cwd,
      env,
    });
  await cargo(cliDir);
  const oopRs = NodePath.join(cliDir, "target", "release", "oop-rs");
  const printed = printedVersion(oopRs);
  if (printed !== version)
    throw new Error(`oop-rs prints "${printed}", not ${version}; its build is out of date.`);
  const result = { OOP_RS_BIN: oopRs };
  const terminalDir = NodePath.join(paths.checkout, RUST_TERMINAL_DIR);
  if (await exists(NodePath.join(terminalDir, "Cargo.toml"))) {
    await cargo(terminalDir);
    await runner("bash", ["scripts/bundle-macos.sh"], {
      cwd: terminalDir,
      env: { ...env, OOP_RS_BIN: oopRs },
    });
    const app = await findTerminalApp(terminalDir);
    if (app === undefined)
      throw new Error(
        `scripts/bundle-macos.sh left no ${TERMINAL_APP_BUNDLE_NAME} below ${terminalDir}.`,
      );
    result.OOP_TERMINAL_APP = app;
  } else {
    console.log(
      `No ${RUST_TERMINAL_DIR} in this source: no ${TERMINAL_APP_BUNDLE_NAME} is bundled.`,
    );
  }
  return result;
}

async function sha256File(filePath) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

// `expectedSigner` is set only for the Developer ID candidate. Its extra codesign
// requirement test is the only place the actual signer is evaluated; the generic
// seal check alone accepts a valid signature from any identity.
export async function verifyMacDmgArtifact(
  dmgPath,
  expectedSha256,
  runner = runCommand,
  expectedSigner = undefined,
  localIdentity = undefined,
  verifyLocalIdentity = async (input) =>
    (await import("./desktop-build/mac-signature.ts")).verifyMacLocalIdentitySignatures(input),
) {
  const actualSha256 = await sha256File(dmgPath);
  if (actualSha256 !== expectedSha256) throw new Error(`Copied DMG SHA-256 mismatch: ${dmgPath}`);

  await runner("/usr/bin/hdiutil", ["verify", dmgPath], { timeout: 120_000 });
  const mountPoint = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-dmg-verify-"));
  let attachAttempted = false;
  let failure;
  try {
    attachAttempted = true;
    await runner(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, dmgPath],
      { timeout: 60_000 },
    );
    const appPath = NodePath.join(mountPoint, "OOP.app");
    const app = await NodeFSP.lstat(appPath).catch(() => undefined);
    if (!app?.isDirectory()) throw new Error(`Expected OOP.app inside DMG: ${dmgPath}`);
    await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
      timeout: 120_000,
    });
    if (localIdentity !== undefined)
      await verifyLocalIdentity({ appPath, identity: localIdentity });
    if (expectedSigner) {
      await runner(
        "/usr/bin/codesign",
        [
          "--verify",
          "--strict",
          "--verbose=2",
          `-R=${developerIdRequirement(expectedSigner.teamId)}`,
          appPath,
        ],
        { timeout: 120_000 },
      );
    }
  } catch (error) {
    failure = error;
  }
  let detached = false;
  if (attachAttempted) {
    try {
      await runner("/usr/bin/hdiutil", ["detach", mountPoint], { timeout: 60_000 });
      detached = true;
    } catch (error) {
      failure ??= error;
    }
  }
  if (detached) await NodeFSP.rm(mountPoint, { recursive: true, force: true });
  else await NodeFSP.rmdir(mountPoint).catch(() => {});
  if (failure) throw failure;
  return actualSha256;
}

function isInside(parent, child) {
  const relative = NodePath.relative(parent, child);
  return relative.split(NodePath.sep)[0] !== ".." && !NodePath.isAbsolute(relative);
}

// `signing` is the explicit Developer ID candidate from resolvePackageSigning.
// Without it this exports to the canonical release/macos as always. With it,
// everything stays in a private directory of the owned artifact root, so a
// candidate can never delete, replace, or add to a canonical release file, even
// when it fails or reuses the version of an accepted release.
export async function packageDmg(
  paths,
  runner,
  appVersion,
  signing = undefined,
  baseEnv = process.env,
) {
  const candidate = signing !== undefined;
  const localIdentity = candidate ? undefined : resolveLocalSignIdentity(undefined, baseEnv);
  if (candidate && isInside(paths.source, paths.artifactRoot))
    throw new Error(`Candidate output must stay outside the source tree: ${paths.artifactRoot}`);
  const stamp = `${Date.now()}-${process.pid}`;
  const out = NodePath.join(paths.artifactRoot, stamp);
  await NodeFSP.mkdir(out, { recursive: true });
  const destination = candidate
    ? NodePath.join(paths.artifactRoot, `${stamp}-candidate`)
    : NodePath.join(paths.source, "release", "macos");
  const fileName = macDmgName(appVersion);
  await NodeFSP.mkdir(destination, { recursive: true });
  if (!candidate) {
    // A failed replacement must not leave a prior success record for this version.
    await NodeFSP.rm(NodePath.join(destination, `${fileName}.sha256`), { force: true });
    await NodeFSP.rm(NodePath.join(destination, `${fileName}.json`), { force: true });
  }
  const env = checkoutEnvironment(paths, baseEnv);
  if (candidate) {
    // The mode travels only as the explicit flag below; these name the expected signer and the installer pins.
    env.CSC_NAME = signing.identity;
    env.T3CODE_APPLE_TEAM_ID = signing.teamId;
    env.T3CODE_MACOS_INSTALLER_LEAF_SHA256 = signing.installerLeafPins;
  }
  // Ad hoc reuses the prebuild (which embeds the legacy policy); the candidate builds its own bundle.
  await runner(
    process.execPath,
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--arch",
      "arm64",
      "--target",
      "dmg",
      "--build-version",
      appVersion,
      ...(candidate ? [] : ["--skip-build"]),
      "--output-dir",
      out,
      ...(candidate ? ["--signing-mode", signing.mode] : []),
    ],
    { cwd: paths.checkout, env },
  );
  const dmgs = (await NodeFSP.readdir(out)).filter((name) => name.endsWith(".dmg"));
  if (dmgs.length !== 1 || dmgs[0] !== fileName)
    throw new Error(`Expected ${fileName} in ${out}, found ${dmgs.join(", ") || "none"}`);
  const sourceManifest = {
    desktop: JSON.parse(
      await NodeFSP.readFile(NodePath.join(paths.source, "apps/desktop/package.json"), "utf8"),
    ).version,
    server: JSON.parse(
      await NodeFSP.readFile(NodePath.join(paths.source, "apps/server/package.json"), "utf8"),
    ).version,
  };
  const digest = await sha256File(NodePath.join(out, fileName));
  const temp = NodePath.join(
    destination,
    `.${fileName}.${process.pid}.${NodeCrypto.randomUUID()}.tmp.dmg`,
  );
  try {
    await NodeFSP.copyFile(NodePath.join(out, fileName), temp);
    await verifyMacDmgArtifact(temp, digest, runner, signing, localIdentity);
    await NodeFSP.rename(temp, NodePath.join(destination, fileName));
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
  const built = {
    artifact: fileName,
    sha256: digest,
    arch: "arm64",
    platform: "mac",
    appVersion,
    sourceManifest,
    sourceKey: sourceKey(paths.source),
    builtAt: new Date().toISOString(),
  };
  // Candidate metadata states limits only. passkeyConfigured:false means no
  // Associated Domains profile was used, not that passkeys were tested.
  const manifest = candidate
    ? {
        ...built,
        distribution: "internal-candidate",
        shippable: false,
        passkeyConfigured: false,
        notarized: false,
        signing: { requestedMode: signing.mode, expectedTeamId: signing.teamId },
        verification:
          "final copied DMG SHA-256, image integrity, internal OOP.app strict/deep signature, and a codesign Developer ID Application/Team requirement test passed; revocation, notarization, Gatekeeper, installer trust, passkeys, UI, and runtime behavior not exercised",
      }
    : {
        ...built,
        ...(localIdentity === undefined ? {} : { signing: { requestedMode: "local-identity" } }),
        verification:
          localIdentity === undefined
            ? "final copied DMG SHA-256, image integrity, and internal OOP.app strict/deep signature passed; UI, integrations, and notarization not exercised"
            : "final copied DMG SHA-256, image integrity, internal OOP.app strict/deep signature, and a certificate-based signature of the configured local identity on every nested code object passed; UI, integrations, and notarization not exercised",
      };
  const metadataTempPrefix = NodePath.join(
    destination,
    `.${fileName}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  const checksumTemp = `${metadataTempPrefix}.sha256.tmp`;
  const manifestTemp = `${metadataTempPrefix}.json.tmp`;
  try {
    await NodeFSP.writeFile(checksumTemp, `${digest}  ${fileName}\n`);
    await NodeFSP.writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n");
    await NodeFSP.rename(checksumTemp, NodePath.join(destination, `${fileName}.sha256`));
    await NodeFSP.rename(manifestTemp, NodePath.join(destination, `${fileName}.json`));
  } finally {
    await NodeFSP.rm(checksumTemp, { force: true });
    await NodeFSP.rm(manifestTemp, { force: true });
  }
  // The verified copy now lives in release/macos; the build output (DMG plus zip, about 280 MB)
  // would otherwise stay in the cache after every build. A candidate keeps its private output.
  if (!candidate) await NodeFSP.rm(out, { recursive: true, force: true });
  console.log(
    `${candidate ? "Candidate DMG (internal, not shippable)" : "DMG"}: ${NodePath.join(destination, fileName)}`,
  );
}

export async function main(
  argv = process.argv.slice(2),
  sourceRoot = SOURCE_ROOT,
  runner = runCommand,
) {
  const { command, cacheDir, signingMode } = parseArgs(argv);
  // Reject incomplete or conflicting signing inputs before any sync, install, or build.
  const signing = resolvePackageSigning(signingMode, process.env);
  const localIdentity = resolveLocalSignIdentity(signingMode, process.env);
  const paths = await resolvePaths(sourceRoot, cacheDir);
  // The app bundles the release notes, so a version without user-facing highlights must stop
  // before the rsync, install, and desktop build. `package` builds too unless signing.
  if (command === "build" || command === "package") {
    await assertReleaseNotes({
      repoRoot: paths.source,
      version: await releaseVersion(paths.source),
    });
  }
  await doctor(paths, command === "doctor" || command === "package" ? localIdentity : undefined);
  if (command === "doctor") return;
  await withLock(paths, async () => {
    await syncSource(paths, runner);
    await install(paths, runner);
    if (command === "setup") return;
    if (command === "start") {
      const runtime = runtimePaths(paths.source);
      await NodeFSP.mkdir(runtime.t3Home, { recursive: true });
      await NodeFSP.mkdir(runtime.userData, { recursive: true });
      await runner(
        process.execPath,
        ["scripts/dev-runner.ts", "dev:desktop", "--home-dir", runtime.t3Home],
        { cwd: paths.checkout, env: checkoutEnvironment(paths, process.env, true) },
      );
      return;
    }
    const appVersion = await releaseVersion(paths.source);
    // Web/server versions select upstream remote CLI artifacts; the OOP shell
    // release must not make those clients request an unrelated upstream tag.
    await runner(
      process.execPath,
      ["scripts/update-release-package-versions.ts", await upstreamVersion(paths.source)],
      { cwd: paths.checkout, env: checkoutEnvironment(paths, process.env) },
    );
    // The candidate builds inside the artifact step, which embeds and then verifies its own trust policy marker.
    if (!signing) await build(paths, runner);
    if (command === "package") {
      const rust = await buildRustClients(paths, runner, appVersion);
      await packageDmg(paths, runner, appVersion, signing, { ...process.env, ...rust });
    }
  });
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[macos] ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
