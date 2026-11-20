// @effect-diagnostics nodeBuiltinImport:off -- Bundle swaps and launcher writes need plain node:fs renames and the macOS tools ditto, codesign and PlistBuddy.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import {
  isOurLauncher,
  terminalLauncherScript,
  windowsTerminalLauncherScript,
} from "./TerminalLauncher.ts";

/**
 * macOS only. OOP.app carries the terminal program (`OOP Terminal.app`) and the `oop-rs` client in
 * Contents/Resources/oop, but only the update package's postinstall and the one-line installer put
 * them where people use them. A DMG drag, the in-app update and an app that predates the terminal
 * program never ran either, so the release meant to ship the native terminal left it inside
 * OOP.app and `oop` kept running the TypeScript client. Every start therefore checks, from the app
 * itself, that `OOP Terminal.app` sits beside OOP.app and that an `oop` command of ours runs oop-rs.
 * Anything that is not ours (a symlink, another app of that name, a user's own `oop`) is left alone.
 *
 * On macOS and Windows a separately installed terminal app (install-terminal.sh/.ps1) that is older
 * than this app also gives its `oop` command to the app's own copy, so the two never differ. Its
 * folder is kept; an equal or newer one stays, and this app's update check offers that release.
 */

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-terminal");

const TOOL_TIMEOUT_MS = 60_000;
export const TERMINAL_APP_NAME = "OOP Terminal.app";
const TERMINAL_APP_IN_RESOURCES = NodePath.join("oop", TERMINAL_APP_NAME);

export interface BundleInfo {
  readonly id: string;
  readonly version: string;
}

/** The outside world, so tests need neither macOS tools nor a signed app. */
export interface TerminalIntegrationTools {
  readonly readBundle: (bundle: string) => Promise<BundleInfo | undefined>;
  readonly copyBundle: (source: string, destination: string) => Promise<void>;
  readonly verifyBundle: (bundle: string) => Promise<void>;
  readonly clearQuarantine: (bundle: string) => Promise<void>;
}

const run = (file: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      { timeout: TOOL_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });

export const macTerminalIntegrationTools: TerminalIntegrationTools = {
  readBundle: async (bundle) => {
    const read = (key: string) =>
      run("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        NodePath.join(bundle, "Contents", "Info.plist"),
      ]);
    try {
      const [id, version] = await Promise.all([
        read("CFBundleIdentifier"),
        read("CFBundleShortVersionString"),
      ]);
      return id && version ? { id, version } : undefined;
    } catch {
      return undefined;
    }
  },
  copyBundle: async (source, destination) => {
    await run("/usr/bin/ditto", [source, destination]);
  },
  verifyBundle: async (bundle) => {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  },
  clearQuarantine: async (bundle) => {
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", bundle]).catch(() => undefined);
  },
};

const lstatOrUndefined = (path: string) => NodeFSP.lstat(path).catch(() => undefined);

const isWritableDirectory = (path: string) =>
  NodeFSP.access(path, NodeFS.constants.W_OK).then(
    () => true,
    () => false,
  );

export type TerminalAppOutcome =
  | "no-terminal-app" // this build carries no OOP Terminal.app
  | "installed"
  | "updated"
  | "current"
  | "blocked-symlink" // the install path is a symlink
  | "blocked-foreign" // an app of that name that is not ours
  | "not-writable"
  | "failed";

/**
 * Puts `OOP Terminal.app` beside OOP.app when it is missing or its version differs from the copy
 * inside OOP.app (a different version, not only an older one, so a rollback and the 0.1.0 stamp of
 * earlier builds both converge). Same safety checks as the package's postinstall: no symlink, the
 * same bundle identifier, a signature check on the copy, and an atomic swap that puts the previous
 * copy back when the swap fails.
 */
export async function ensureTerminalApp(input: {
  readonly appBundle: string;
  readonly resourcesPath: string;
  readonly tools?: TerminalIntegrationTools;
}): Promise<TerminalAppOutcome> {
  const tools = input.tools ?? macTerminalIntegrationTools;
  const source = NodePath.join(input.resourcesPath, TERMINAL_APP_IN_RESOURCES);
  const directory = NodePath.dirname(input.appBundle);
  const destination = NodePath.join(directory, TERMINAL_APP_NAME);
  const staged = NodePath.join(directory, `.${TERMINAL_APP_NAME}.new-${process.pid}`);
  const previous = NodePath.join(directory, `.${TERMINAL_APP_NAME}.old-${process.pid}`);
  try {
    const sourceStat = await lstatOrUndefined(source);
    if (!sourceStat?.isDirectory()) return "no-terminal-app";
    const sourceInfo = await tools.readBundle(source);
    if (sourceInfo === undefined) return "failed";

    const destinationStat = await lstatOrUndefined(destination);
    if (destinationStat?.isSymbolicLink()) return "blocked-symlink";
    if (destinationStat !== undefined) {
      const destinationInfo = await tools.readBundle(destination);
      if (destinationInfo?.id !== sourceInfo.id) return "blocked-foreign";
      if (destinationInfo.version === sourceInfo.version) return "current";
    }
    if (!(await isWritableDirectory(directory))) return "not-writable";

    await NodeFSP.rm(staged, { recursive: true, force: true });
    await NodeFSP.rm(previous, { recursive: true, force: true });
    try {
      await tools.copyBundle(source, staged);
      await tools.verifyBundle(staged);
      await tools.clearQuarantine(staged);
      if (destinationStat !== undefined) await NodeFSP.rename(destination, previous);
      try {
        await NodeFSP.rename(staged, destination);
      } catch (error) {
        if (destinationStat !== undefined) await NodeFSP.rename(previous, destination);
        throw error;
      }
      await NodeFSP.rm(previous, { recursive: true, force: true });
      return destinationStat === undefined ? "installed" : "updated";
    } finally {
      await NodeFSP.rm(staged, { recursive: true, force: true });
    }
  } catch {
    return "failed";
  }
}

export type TerminalCommandOutcome =
  | "no-terminal-client" // this app has no oop-rs to run
  | "terminal-install"
  | "replaced-older-terminal"
  | "created"
  | "updated"
  | "current"
  | "foreign" // an `oop` that is not ours: left alone
  | "removed-by-user" // we made one once and it is gone; not recreated
  | "failed";

const olderTerminalInstall = async (root: string | undefined, appVersion: string | undefined) => {
  if (!root || !appVersion || !/^\d+\.\d+\.\d+$/.test(appVersion)) return false;
  const text = await NodeFSP.readFile(NodePath.join(root, ".oop-terminal-install"), "utf8").catch(
    () => "",
  );
  const version = text.split(/\r?\n/)[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const installed = version.split(".").map(BigInt);
  const desktop = appVersion.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (installed[i] !== desktop[i]) return installed[i]! < desktop[i]!;
  }
  return false;
};

const terminalShellRoot = (text: string) => {
  const lines = text.split("\n");
  if (
    lines[0] !== "#!/bin/sh" ||
    lines[1] !== "# oop-terminal-launcher (written by install-terminal.sh; safe to delete)"
  )
    return undefined;
  const value = lines.find((line) => line.startsWith("root="))?.slice(5);
  if (!value || !/^'(?:[^']|'\\'')*'$/.test(value)) return undefined;
  return value.slice(1, -1).replaceAll("'\\''", "'");
};

/**
 * Keeps `<binDir>/oop` pointing at this app and running oop-rs. A launcher with our mark is
 * rewritten when its text differs (this is how a launcher written by an older release moves to the
 * current one). A missing file is created once; `markerFile` remembers that, so deleting the
 * launcher (the mark says that is safe) is respected. An older terminal-only install is replaced;
 * foreign files and symlinks are left alone.
 */
export async function ensureTerminalCommand(input: {
  readonly appBundle: string;
  readonly binDirectory: string;
  readonly markerFile: string;
  readonly appVersion?: string;
}): Promise<TerminalCommandOutcome> {
  const target = NodePath.join(input.binDirectory, "oop");
  const script = terminalLauncherScript(input.appBundle);
  try {
    const client = NodePath.join(input.appBundle, "Contents", "Resources", "oop", "oop-rs");
    if (!(await lstatOrUndefined(client))?.isFile()) return "no-terminal-client";

    const targetStat = await lstatOrUndefined(target);
    let outcome: "created" | "updated" | "replaced-older-terminal";
    if (targetStat === undefined) {
      if ((await lstatOrUndefined(input.markerFile)) !== undefined) return "removed-by-user";
      outcome = "created";
    } else {
      if (!targetStat.isFile()) return "foreign";
      const existing = await NodeFSP.readFile(target, "utf8");
      if (!isOurLauncher(existing)) {
        const root = terminalShellRoot(existing);
        if (root === undefined) return "foreign";
        if (!(await olderTerminalInstall(root, input.appVersion))) return "terminal-install";
        outcome = "replaced-older-terminal";
      } else {
        outcome = "updated";
      }
      if (existing === script) {
        await rememberLauncher(input.markerFile);
        return "current";
      }
    }
    await NodeFSP.mkdir(input.binDirectory, { recursive: true });
    const temporary = NodePath.join(input.binDirectory, `.oop.${NodeCrypto.randomUUID()}`);
    try {
      await NodeFSP.writeFile(temporary, script, { mode: 0o755, flag: "wx" });
      await NodeFSP.chmod(temporary, 0o755);
      await NodeFSP.rename(temporary, target);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
    await rememberLauncher(input.markerFile);
    return outcome;
  } catch {
    return "failed";
  }
}

/** Only migrates an older terminal-only command; missing and desktop commands are left alone. */
export async function ensureWindowsTerminalCommand(input: {
  readonly executable: string;
  readonly resourcesPath: string;
  readonly appVersion: string;
  readonly localAppData: string | undefined;
  readonly programFiles: string | undefined;
}): Promise<TerminalCommandOutcome> {
  if (!input.localAppData) return "foreign";
  const directory = NodePath.join(input.localAppData, "oop-terminal");
  const target = NodePath.join(directory, "oop.cmd");
  try {
    if (!(await lstatOrUndefined(target))?.isFile()) return "foreign";
    const text = await NodeFSP.readFile(target, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines[1] !== "rem oop-terminal-launcher (written by install-terminal.ps1; safe to delete)")
      return "foreign";
    const encoded = lines
      .map((line) => /^"(.+)\\oop-rs\.exe" %\*$/.exec(line)?.[1])
      .find((root) => root !== undefined);
    if (!encoded) return "terminal-install";
    const root = encoded.replace(/%%|%LOCALAPPDATA%|%ProgramFiles%/gi, (token) =>
      token === "%%"
        ? "%"
        : token.toLowerCase() === "%localappdata%"
          ? input.localAppData!
          : (input.programFiles ?? token),
    );
    if (!(await olderTerminalInstall(root, input.appVersion))) return "terminal-install";
    const client = NodePath.join(input.resourcesPath, "oop", "oop-rs.exe");
    if (!(await lstatOrUndefined(client))?.isFile()) return "no-terminal-client";
    const script = windowsTerminalLauncherScript(
      input.executable,
      client,
      input.localAppData,
      input.programFiles,
    );
    if (script === undefined) return "terminal-install";
    const temporary = NodePath.join(directory, `.oop.${NodeCrypto.randomUUID()}.tmp`);
    try {
      await NodeFSP.writeFile(temporary, script, { flag: "wx" });
      await NodeFSP.rename(temporary, target);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
    return "replaced-older-terminal";
  } catch {
    return "failed";
  }
}

const rememberLauncher = async (markerFile: string) => {
  await NodeFSP.mkdir(NodePath.dirname(markerFile), { recursive: true });
  await NodeFSP.writeFile(markerFile, "", { flag: "a" });
};

/** The app bundle when it is the one people install: OOP.app in /Applications or ~/Applications. */
export const installedAppBundle = (appBundle: string, homeDirectory: string) => {
  if (NodePath.basename(appBundle) !== "OOP.app") return undefined;
  const directory = NodePath.dirname(appBundle);
  return directory === "/Applications" || directory === NodePath.join(homeDirectory, "Applications")
    ? appBundle
    : undefined;
};

const appBundleFromPath = (path: string) => {
  const index = path.lastIndexOf(".app/Contents/");
  return index < 0 ? undefined : path.slice(0, index + ".app".length);
};

/**
 * Checks macOS integration and migrates older Windows terminal-only commands at packaged startup.
 * Never fails the start: each step reports its outcome and the worst case is a log line.
 */
export const ensureTerminalIntegration = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return;
  if (environment.platform === "win32") {
    const command = yield* Effect.promise(() =>
      ensureWindowsTerminalCommand({
        executable: process.execPath,
        resourcesPath: environment.resourcesPath,
        appVersion: environment.appVersion,
        localAppData: process.env.LOCALAPPDATA,
        programFiles: process.env.ProgramFiles,
      }),
    );
    yield* (command === "failed" ? logWarning : logInfo)("terminal integration checked", {
      command,
    });
    return;
  }
  if (environment.platform !== "darwin") return;
  const bundle = appBundleFromPath(environment.appPath);
  const appBundle =
    bundle === undefined ? undefined : installedAppBundle(bundle, environment.homeDirectory);
  if (appBundle === undefined) return;

  const app = yield* Effect.promise(() =>
    ensureTerminalApp({ appBundle, resourcesPath: environment.resourcesPath }),
  );
  const command = yield* Effect.promise(() =>
    ensureTerminalCommand({
      appBundle,
      appVersion: environment.appVersion,
      binDirectory: NodePath.join(environment.homeDirectory, ".local", "bin"),
      markerFile: NodePath.join(environment.stateDir, "terminal-command-installed"),
    }),
  );
  const log = app === "failed" || command === "failed" ? logWarning : logInfo;
  yield* log("terminal integration checked", { app, command });
}).pipe(
  Effect.catchCause((cause) => logWarning("terminal integration failed", { cause: String(cause) })),
  Effect.withSpan("desktop.terminal.ensureIntegration"),
);
