// @effect-diagnostics nodeBuiltinImport:off -- Bundle swaps and launcher writes need plain node:fs renames and the macOS tools ditto, codesign and PlistBuddy.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import { isOurLauncher, terminalLauncherScript } from "./TerminalLauncher.ts";

/**
 * macOS only. OOP.app carries the terminal program (`OOP Terminal.app`) and the `oop-rs` client in
 * Contents/Resources/oop, but only the update package's postinstall and the one-line installer put
 * them where people use them. A DMG drag, the in-app update and an app that predates the terminal
 * program never ran either, so the release meant to ship the native terminal left it inside
 * OOP.app and `oop` kept running the TypeScript client. Every start therefore checks, from the app
 * itself, that `OOP Terminal.app` sits beside OOP.app and that an `oop` command of ours runs oop-rs.
 * Anything that is not ours (a symlink, another app of that name, a user's own `oop`) is left alone.
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
  | "created"
  | "updated"
  | "current"
  | "foreign" // an `oop` that is not ours: left alone
  | "removed-by-user" // we made one once and it is gone; not recreated
  | "failed";

/**
 * Keeps `<binDir>/oop` pointing at this app and running oop-rs. A launcher with our mark is
 * rewritten when its text differs (this is how a launcher written by an older release moves to the
 * current one). A missing file is created once; `markerFile` remembers that, so deleting the
 * launcher (the mark says that is safe) is respected. A file without our mark, or a symlink, is
 * never touched, whatever it contains.
 */
export async function ensureTerminalCommand(input: {
  readonly appBundle: string;
  readonly binDirectory: string;
  readonly markerFile: string;
}): Promise<TerminalCommandOutcome> {
  const target = NodePath.join(input.binDirectory, "oop");
  const script = terminalLauncherScript(input.appBundle);
  try {
    const client = NodePath.join(input.appBundle, "Contents", "Resources", "oop", "oop-rs");
    if (!(await lstatOrUndefined(client))?.isFile()) return "no-terminal-client";

    const targetStat = await lstatOrUndefined(target);
    let outcome: "created" | "updated";
    if (targetStat === undefined) {
      if ((await lstatOrUndefined(input.markerFile)) !== undefined) return "removed-by-user";
      outcome = "created";
    } else {
      if (!targetStat.isFile()) return "foreign";
      const existing = await NodeFSP.readFile(target, "utf8");
      if (!isOurLauncher(existing)) return "foreign";
      if (existing === script) {
        await rememberLauncher(input.markerFile);
        return "current";
      }
      outcome = "updated";
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
 * Runs both steps on every start of a packaged macOS app that is installed in a standard place.
 * Never fails the start: each step reports its outcome and the worst case is a log line.
 */
export const ensureTerminalIntegration = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin" || !environment.isPackaged) return;
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
