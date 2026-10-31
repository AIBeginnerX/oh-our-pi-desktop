// @effect-diagnostics nodeBuiltinImport:off - The lock is a plain synchronous node:sqlite handle.
import * as NodeFS from "node:fs";

/**
 * Single-instance lock for one OOP state directory.
 *
 * The lock is an exclusive SQLite transaction on a dedicated file, held for the
 * owner's whole lifetime. The operating system drops it when the process dies,
 * so a killed server never leaves a stale lock behind, and a pid check is never
 * needed to tell "alive" from "dead". `state.sqlite` itself stays unlocked
 * because the `pair` and `project` commands write to it from other processes.
 *
 * The server (lock owner) and the desktop (pre-start probe) share this file so
 * both agree on what "held" means.
 */
export const INSTANCE_LOCK_FILE_NAME = "server.lock";

/** Exit code of a server that found the lock taken (BSD sysexits EX_TEMPFAIL). */
export const INSTANCE_LOCKED_EXIT_CODE = 75;

export type InstanceLockAttempt =
  | { readonly _tag: "Acquired"; readonly release: () => void }
  | { readonly _tag: "Held" }
  // The runtime has no node:sqlite (older Node, Bun before it shipped the module).
  | { readonly _tag: "Unsupported" };

export type InstanceLockProbe = "free" | "held" | "unsupported";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

// Extended result codes keep the primary code in the low byte.
const isLockedError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") {
    return false;
  }
  const primary = error.errcode & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
};

/**
 * Take the lock without waiting. Returns `Held` when another process owns it
 * and throws for any other failure (unwritable directory, corrupt file, a lock
 * file the process cannot write).
 *
 * A read-only lock file is refused up front: SQLite opens it read-only and
 * `BEGIN EXCLUSIVE` then takes only a shared lock, so any number of processes
 * would "acquire" it at once. Failing closed keeps the server from starting
 * and keeps the desktop pre-check from reading the lock as free.
 *
 * The returned `release` closure keeps the database handle reachable, which is
 * what keeps the lock alive; drop it only at shutdown.
 */
export const tryAcquireInstanceLock = (lockPath: string): InstanceLockAttempt => {
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (sqlite === undefined) {
    return { _tag: "Unsupported" };
  }
  if (NodeFS.existsSync(lockPath)) {
    try {
      NodeFS.accessSync(lockPath, NodeFS.constants.W_OK);
    } catch (cause) {
      throw new Error(`Instance lock file is not writable: ${lockPath}`, { cause });
    }
  }
  const database = new sqlite.DatabaseSync(lockPath);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    closeQuietly(database);
    if (isLockedError(error)) {
      return { _tag: "Held" };
    }
    throw error;
  }
  let released = false;
  return {
    _tag: "Acquired",
    release: () => {
      if (released) return;
      released = true;
      closeQuietly(database);
    },
  };
};

const closeQuietly = (database: { close: () => void }) => {
  try {
    database.close();
  } catch {
    // Closing only matters for releasing the lock; the process is moving on.
  }
};

/**
 * Ask whether another process holds the lock. A free lock is taken for an
 * instant and released again, so a server that starts in that instant sees the
 * lock held and exits with {@link INSTANCE_LOCKED_EXIT_CODE}; callers retry.
 * A missing lock file means no instance ever took it.
 */
export const probeInstanceLock = (lockPath: string): InstanceLockProbe => {
  if (!NodeFS.existsSync(lockPath)) {
    return "free";
  }
  const attempt = tryAcquireInstanceLock(lockPath);
  switch (attempt._tag) {
    case "Held":
      return "held";
    case "Unsupported":
      return "unsupported";
    case "Acquired":
      attempt.release();
      return "free";
  }
};
