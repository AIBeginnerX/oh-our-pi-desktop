// @effect-diagnostics nodeBuiltinImport:off -- A one-shot taskkill on Windows; see `signal` below.
// Pre-start check for the desktop's own server: make sure no other server
// (typically the terminal's `serve --daemon`) still holds the data directory.
//
// Two servers on one directory is never allowed: the second one orphans the
// first one's running turns. The server enforces that with `server.lock`; this
// check makes the app win the handover instead of failing against the daemon.
// It runs before every backend start, which includes the restarts that follow
// a server exiting with code 75, so the small gap between "lock looked free"
// and "server took the lock" is closed by that retry rather than by holding the
// lock here.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { INSTANCE_LOCK_FILE_NAME, probeInstanceLock } from "@t3tools/shared/instanceLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SERVER_RUNTIME_FILE_NAME = "server-runtime.json";
const POLL_MS = 100;
const TERM_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
// Lock held but nobody named in the runtime file: a server that is starting or
// finishing its shutdown. Give a finishing one time to let go.
const UNNAMED_OWNER_WAIT_MS = 5_000;

export type InstanceLockGuardOutcome =
  // Nothing holds the lock.
  | "free"
  // This runtime cannot probe the lock; the server's own check decides.
  | "unsupported"
  // The owner exited after SIGTERM.
  | "stopped"
  // The owner ignored SIGTERM and was killed.
  | "killed"
  // A service-supervised server owns it; signalling it would only be restarted.
  | "service-managed"
  // Gave up waiting. The server will exit with code 75 and the manager retries.
  | "still-held";

export interface RuntimeOwner {
  readonly pid: number;
  readonly serviceManaged: boolean;
}

/** Everything the guard touches outside this module, so tests can fake the OS. */
export interface InstanceLockGuardPorts {
  readonly probe: (lockPath: string) => ReturnType<typeof probeInstanceLock>;
  readonly readOwner: (runtimeStatePath: string) => Effect.Effect<Option.Option<RuntimeOwner>>;
  readonly isAlive: (pid: number) => boolean;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly sleep: (millis: number) => Effect.Effect<void>;
}

const RuntimeOwnerFromJson = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    serviceManaged: Schema.optional(Schema.Boolean),
  }),
);
const decodeRuntimeOwner = Schema.decodeUnknownEffect(RuntimeOwnerFromJson);

/**
 * The system `taskkill`, by absolute path: a bare name would search the working directory and
 * PATH, and this runs from an app whose PATH is not under our control.
 */
export const windowsTaskkillPath = (systemRoot: string | undefined): string =>
  NodePath.win32.join(
    systemRoot !== undefined && systemRoot.length > 0 ? systemRoot : "C:\\Windows",
    "System32",
    "taskkill.exe",
  );

export const makeLivePorts = (fileSystem: FileSystem.FileSystem): InstanceLockGuardPorts => ({
  probe: probeInstanceLock,
  readOwner: (runtimeStatePath) =>
    fileSystem.readFileString(runtimeStatePath).pipe(
      Effect.flatMap(decodeRuntimeOwner),
      Effect.map((state) =>
        Option.some({ pid: state.pid, serviceManaged: state.serviceManaged === true }),
      ),
      Effect.orElseSucceed(() => Option.none<RuntimeOwner>()),
    ),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the pid exists but belongs to someone else.
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  },
  signal: (pid, signal) => {
    if (Effect.runSync(HostProcessPlatform) !== "win32") {
      process.kill(pid, signal);
      return;
    }
    // Windows has no graceful signal, and `process.kill` would leave the server's provider and
    // terminal children running. Same tree kill the app uses for its own backend.
    NodeChildProcess.spawnSync(
      windowsTaskkillPath(process.env.SystemRoot),
      ["/pid", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
  },
  sleep: (millis) => Effect.sleep(millis),
});

/**
 * If another process holds `<stateDir>/server.lock`, stop it and wait for the
 * lock. Never fails: whatever it cannot settle is left to the server's own
 * lock check and the manager's restart loop.
 *
 * Signals go only to the pid recorded in `server-runtime.json`, and only while
 * the lock is actually held. A holding server rewrites that file at startup,
 * so a held lock means the file names the holder, not a recycled pid.
 */
export const ensureInstanceLockFree = Effect.fn("desktop.backend.ensureInstanceLockFree")(
  function* (
    input: { readonly stateDir: string; readonly joinPath: (...parts: string[]) => string },
    ports: InstanceLockGuardPorts,
  ): Effect.fn.Return<InstanceLockGuardOutcome> {
    const lockPath = input.joinPath(input.stateDir, INSTANCE_LOCK_FILE_NAME);
    const runtimeStatePath = input.joinPath(input.stateDir, SERVER_RUNTIME_FILE_NAME);

    const probe = (): ReturnType<typeof probeInstanceLock> => {
      try {
        return ports.probe(lockPath);
      } catch {
        // An unreadable lock file is the server's problem to report.
        return "unsupported";
      }
    };
    const signal = (pid: number, name: "SIGTERM" | "SIGKILL") => {
      try {
        ports.signal(pid, name);
      } catch {
        // Already gone, or not ours to signal; the wait below tells which.
      }
    };
    // True once the lock is free, polling for up to `budgetMs`.
    const waitUntilFree = Effect.fnUntraced(function* (budgetMs: number) {
      for (let waited = 0; ; waited += POLL_MS) {
        if (probe() !== "held") return true;
        if (waited >= budgetMs) return false;
        yield* ports.sleep(POLL_MS);
      }
    });

    const initial = probe();
    if (initial !== "held") {
      return initial === "free" ? "free" : "unsupported";
    }

    const owner = yield* ports.readOwner(runtimeStatePath);
    if (Option.isSome(owner) && owner.value.serviceManaged) {
      yield* Effect.logWarning(
        "Another server managed by the OOP service holds the data directory; leaving it running.",
        { pid: owner.value.pid },
      );
      return "service-managed";
    }
    const pid = Option.isSome(owner) ? owner.value.pid : undefined;
    if (pid === undefined || pid <= 1 || pid === process.pid || !ports.isAlive(pid)) {
      const released = yield* waitUntilFree(UNNAMED_OWNER_WAIT_MS);
      return released ? "stopped" : "still-held";
    }

    yield* Effect.logInfo("Stopping the server that holds the data directory before starting.", {
      pid,
    });
    signal(pid, "SIGTERM");
    if (yield* waitUntilFree(TERM_WAIT_MS)) return "stopped";

    yield* Effect.logWarning("The server ignored SIGTERM; killing it.", { pid });
    if (ports.isAlive(pid)) {
      signal(pid, "SIGKILL");
    }
    return (yield* waitUntilFree(KILL_WAIT_MS)) ? "killed" : "still-held";
  },
);
