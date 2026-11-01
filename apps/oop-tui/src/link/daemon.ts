import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { DESKTOP_UPDATE_INSTALLING_MARKER_FILE } from "@t3tools/contracts";
import { t } from "../i18n/index.ts";

/**
 * The terminal's own server. When the desktop app is not running, `oop` starts the server that is
 * inside the installed app's bundle, in the same OOP home, as a background process (`serve
 * --daemon`). The server keeps `<home>/userdata/server.lock` for its whole life, so there is never
 * more than one: a second start ends at once with `LOCK_HELD_EXIT_CODE`.
 */

/** Exit code of a server that found another one holding the lock. Not a failure: look again. */
export const LOCK_HELD_EXIT_CODE = 75;

/**
 * Where the scan for a free port starts. The desktop app prefers 3773, and its address is what
 * remote access and the phone app have saved, so the terminal's server stays out of the way of it:
 * with this one on 3773 the app would be pushed to 3774 and those addresses would stop working.
 */
const FIRST_PORT = 3873;
const PORT_SCAN_LENGTH = 100;

/**
 * How long a started server may take before it is announced. Not measured on a real start (running
 * a server is off limits for the people who wrote this); it is the ceiling, since a server that
 * fails ends on its own and is noticed at once, and sits between the 30 seconds `oop` already gives
 * the whole desktop app and the minute the app gives its own server.
 */
export const STARTUP_TIMEOUT_MS = 45_000;
const POLL_MS = 250;

/** After a start that ended with the lock held elsewhere, the earliest the next one may begin. */
const HELD_GAP_MS = 5_000;
const FAILURE_BACKOFF_FIRST_MS = 10_000;
const FAILURE_BACKOFF_CAP_MS = 120_000;

/** How long after the app wrote its installing marker the terminal still holds back a server of its own. */
export const UPDATE_MARKER_FRESH_MS = 15 * 60_000;

/**
 * The file the desktop app writes before it quits to install an update, on every install path
 * (feed, disk image, setup). While it is fresh the installer may be replacing the bundle, and on
 * Windows a running OOP.exe stops it, so the terminal starts no server then. The app removes it
 * when the install fails to start and at its next start.
 */
export const desktopUpdateMarkerPath = (home: string): string =>
  NodePath.join(home, "runtime", DESKTOP_UPDATE_INSTALLING_MARKER_FILE);

/** True when the marker exists and was written within `UPDATE_MARKER_FRESH_MS`. */
export const updateInProgress = async (input: {
  readonly markerPath: string;
  readonly now: () => number;
  readonly modifiedAt?: (path: string) => Promise<number | null>;
}): Promise<boolean> => {
  const modifiedAt =
    input.modifiedAt ??
    ((path: string) =>
      NodeFSP.stat(path).then(
        (stats) => stats.mtimeMs,
        () => null,
      ));
  const written = await modifiedAt(input.markerPath);
  return written !== null && input.now() - written < UPDATE_MARKER_FRESH_MS;
};

/** Setting this to a server's `bin.mjs` runs that file, with the program running `oop`, instead of the app's. */
export const DAEMON_ENTRY_VARIABLE = "OOP_DAEMON_ENTRY";

export interface AppProgram {
  /** The program that runs the server script: the app's own executable, which acts as Node. */
  readonly executable: string;
  readonly serverScript: string;
  /** Whether the server was chosen by `OOP_DAEMON_ENTRY`, which also allows an isolated home. */
  readonly explicit: boolean;
}

export interface AppLookup {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly execPath: string;
  /** `process.versions.electron`: set when the terminal was run by the app's own executable. */
  readonly electron: string | undefined;
  readonly exists: (path: string) => boolean;
}

const SERVER_SCRIPT_PARTS = ["apps", "server", "dist", "bin.mjs"] as const;

/**
 * Where the app keeps its server, given the app's executable: the same places the app itself runs
 * it from (`DesktopEnvironment`). macOS has it in the app archive; a packaged Windows build puts the
 * server tree in the `server.asar` next to the executable. `archive` is what exists on disk; the
 * script is inside it, where only the app's own runtime can see.
 */
const bundleOf = (
  platform: NodeJS.Platform,
  executable: string,
): { readonly serverScript: string; readonly archive: string } | null => {
  if (platform === "darwin") {
    const resources = NodePath.posix.join(
      NodePath.posix.dirname(NodePath.posix.dirname(executable)),
      "Resources",
    );
    const archive = NodePath.posix.join(resources, "app.asar");
    return { archive, serverScript: NodePath.posix.join(archive, ...SERVER_SCRIPT_PARTS) };
  }
  if (platform === "win32") {
    const archive = NodePath.win32.join(
      NodePath.win32.dirname(executable),
      "resources",
      "server.asar",
    );
    return { archive, serverScript: NodePath.win32.join(archive, ...SERVER_SCRIPT_PARTS) };
  }
  return null;
};

/**
 * The installed app's executable and server script, or null when this computer has no app that can
 * be used (Linux is not covered: no bundle path is known there). Run by the app's own runtime
 * (`electron` set), `execPath` is the app. Run by a system Node, the places the installer puts it
 * are tried: /Applications and ~/Applications on macOS, %LOCALAPPDATA%\Programs\OOP on Windows.
 */
export const findAppProgram = (lookup: AppLookup): AppProgram | null => {
  const entry = lookup.env[DAEMON_ENTRY_VARIABLE]?.trim();
  if (entry) {
    return lookup.exists(entry)
      ? { executable: lookup.execPath, serverScript: entry, explicit: true }
      : null;
  }
  const candidates: string[] = [];
  if (lookup.electron !== undefined) {
    candidates.push(lookup.execPath);
  } else if (lookup.platform === "darwin") {
    candidates.push(
      "/Applications/OOP.app/Contents/MacOS/OOP",
      NodePath.posix.join(lookup.home, "Applications", "OOP.app", "Contents", "MacOS", "OOP"),
    );
  } else if (lookup.platform === "win32") {
    const local =
      lookup.env.LOCALAPPDATA?.trim() || NodePath.win32.join(lookup.home, "AppData", "Local");
    candidates.push(NodePath.win32.join(local, "Programs", "OOP", "OOP.exe"));
  }
  for (const executable of candidates) {
    const bundle = bundleOf(lookup.platform, executable);
    if (bundle !== null && lookup.exists(executable) && lookup.exists(bundle.archive)) {
      return { executable, serverScript: bundle.serverScript, explicit: false };
    }
  }
  return null;
};

/**
 * Whether the terminal may start a server with this program. An isolated home (`--home`,
 * `OOP_HOME`) is someone's test server, and the app's program would serve another one there, so it
 * is allowed only when the program was named on purpose with `OOP_DAEMON_ENTRY`.
 */
export const mayRunOwnServer = (program: AppProgram | null, isolated: boolean): boolean =>
  program !== null && (!isolated || program.explicit);

/**
 * The command that starts the server. The host is always the loopback: this server is for the
 * terminal on this computer, not for the network.
 */
export const daemonCommand = (
  program: AppProgram,
  home: string,
  port: number,
): { readonly file: string; readonly args: ReadonlyArray<string> } => ({
  file: program.executable,
  args: [
    program.serverScript,
    "serve",
    "--daemon",
    "--base-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
});

/**
 * The environment of the server: this one, without the settings that steer an app's own server
 * (T3CODE_*), and with the switch that makes the app's executable run a script as plain Node.
 */
export const daemonEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("T3CODE_")) kept[name] = value;
  }
  return { ...kept, ELECTRON_RUN_AS_NODE: "1" };
};

/**
 * The interfaces a port must be free on, the same three the desktop app checks before it takes one
 * (`DesktopApp.ts`). Loopback alone is not enough: on macOS a socket can bind 127.0.0.1:P while
 * another server listens on `*:P`, and then it takes that server's loopback connections away.
 */
const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

/** The first free port from `first` on, or null when none of the scanned ones is. */
export const pickPort = async (
  canListen: (port: number) => Promise<boolean>,
  first: number = FIRST_PORT,
): Promise<number | null> => {
  for (let port = first; port < first + PORT_SCAN_LENGTH; port += 1) {
    if (await canListen(port)) return port;
  }
  return null;
};

/**
 * Whether a TCP server could bind `host:port`. A host this computer has no address for
 * (EADDRNOTAVAIL, e.g. no IPv6) counts as free, as it does for the app.
 */
const canListenOnHost = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = NodeNet.createServer();
    probe.once("error", (cause: NodeJS.ErrnoException) => resolve(cause.code === "EADDRNOTAVAIL"));
    probe.listen({ host, port }, () => probe.close(() => resolve(true)));
  });

/** True only when `port` is free on every one of `PORT_PROBE_HOSTS`. */
export const canListenEverywhere = async (port: number): Promise<boolean> => {
  for (const host of PORT_PROBE_HOSTS) {
    if (!(await canListenOnHost(port, host))) return false;
  }
  return true;
};

export interface DaemonProcess {
  /** Called once, with the exit code (null when it was a signal or the program could not run). */
  readonly onExit: (listener: (code: number | null) => void) => void;
}

export type SpawnDaemon = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly env: Record<string, string>; readonly cwd: string },
) => DaemonProcess;

/**
 * Starts the server so that it outlives this terminal: detached, no window, nothing connected to
 * it. Its output is not kept: a pairing token it printed would otherwise sit in a log file.
 */
export const spawnDetached: SpawnDaemon = (file, args, options) => {
  const child = NodeChildProcess.spawn(file, [...args], {
    env: options.env,
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return {
    onExit: (listener) => {
      child.once("exit", (code) => listener(code));
      child.once("error", () => listener(null));
    },
  };
};

/**
 * - ready: a server is announced and answers (ours, or another terminal's or the app's).
 * - occupied: ours found the lock held and ended with `LOCK_HELD_EXIT_CODE`; whoever holds it is
 *   about to announce itself, so look again.
 * - unusable: the program could not be run, or it ended any other way (an app from before the
 *   flag existed does that at once). The caller goes back to what it did before.
 * - slow: still running, and not announced within `STARTUP_TIMEOUT_MS`.
 * - updating: the app is installing an update; nothing was started and nothing counts as failed.
 * - cooling: an earlier attempt failed or found the lock held a moment ago; nothing was started.
 */
export type DaemonOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "occupied" }
  | { readonly kind: "unusable"; readonly detail: string }
  | { readonly kind: "slow" }
  | { readonly kind: "updating" }
  | { readonly kind: "cooling" };

export interface DaemonLauncher {
  /**
   * Starts the server unless a start is already under way here (then it joins that one) or the
   * last one ended badly a moment ago. `discover` is how an announced server is recognised.
   */
  readonly start: (discover: () => Promise<{ readonly kind: string }>) => Promise<DaemonOutcome>;
}

export interface DaemonDeps {
  readonly program: AppProgram;
  /** The OOP home the server works in: where `userdata/server.lock` and the announcement are. */
  readonly home: string;
  /** Where the server's process starts; never this terminal's folder. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: SpawnDaemon;
  readonly pickPort: () => Promise<number | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  /** True while the app installs an update, see `updateInProgress`. */
  readonly updating?: () => Promise<boolean>;
}

export const createDaemonLauncher = (deps: DaemonDeps): DaemonLauncher => {
  let running: Promise<DaemonOutcome> | null = null;
  let notBefore = 0;
  let failures = 0;

  const attempt = async (
    discover: () => Promise<{ readonly kind: string }>,
  ): Promise<DaemonOutcome> => {
    const port = await deps.pickPort();
    if (port === null) return { kind: "unusable", detail: t("link.daemon.noPort") };
    const exit: { ended: boolean; code: number | null } = { ended: false, code: null };
    try {
      const { file, args } = daemonCommand(deps.program, deps.home, port);
      deps.spawn(file, args, { env: daemonEnvironment(deps.env), cwd: deps.cwd }).onExit((code) => {
        exit.ended = true;
        exit.code = code;
      });
    } catch {
      return { kind: "unusable", detail: t("link.daemon.spawnFailed") };
    }
    const deadline = deps.now() + (deps.timeoutMs ?? STARTUP_TIMEOUT_MS);
    for (;;) {
      // An announcement counts even when the process behind it has just ended with the lock held:
      // the one that holds it is the server.
      if ((await discover()).kind === "found") return { kind: "ready" };
      if (exit.ended) {
        return exit.code === LOCK_HELD_EXIT_CODE
          ? { kind: "occupied" }
          : {
              kind: "unusable",
              detail: t("link.daemon.exited", { code: exit.code ?? t("link.daemon.noCode") }),
            };
      }
      if (deps.now() >= deadline) return { kind: "slow" };
      await deps.sleep(POLL_MS);
    }
  };

  const settle = (outcome: DaemonOutcome): DaemonOutcome => {
    if (outcome.kind === "ready") {
      failures = 0;
      notBefore = 0;
    } else if (outcome.kind === "occupied") {
      failures = 0;
      notBefore = deps.now() + HELD_GAP_MS;
    } else {
      failures += 1;
      notBefore =
        deps.now() +
        Math.min(FAILURE_BACKOFF_CAP_MS, FAILURE_BACKOFF_FIRST_MS * 2 ** (failures - 1));
    }
    return outcome;
  };

  return {
    start: (discover) => {
      if (running !== null) return running;
      if (deps.now() < notBefore) return Promise.resolve({ kind: "cooling" });
      const current = (deps.updating?.() ?? Promise.resolve(false))
        .catch(() => false)
        .then((updating): Promise<DaemonOutcome> | DaemonOutcome =>
          updating ? { kind: "updating" } : attempt(discover).then(settle),
        )
        .finally(() => {
          running = null;
        });
      running = current;
      return current;
    },
  };
};

/** The launcher of this process, or null when there is no app program to run on this computer. */
export const defaultLauncher = (
  program: AppProgram,
  home: string,
  homeDirectory: string,
): DaemonLauncher =>
  createDaemonLauncher({
    program,
    home,
    cwd: homeDirectory,
    env: process.env,
    spawn: spawnDetached,
    pickPort: () => pickPort(canListenEverywhere),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    updating: () => updateInProgress({ markerPath: desktopUpdateMarkerPath(home), now: Date.now }),
  });

export const currentAppLookup = (home: string, platform: NodeJS.Platform): AppLookup => ({
  platform,
  env: process.env,
  home,
  execPath: process.execPath,
  electron: process.versions.electron,
  exists: (path) => NodeFS.existsSync(path),
});
