import {
  INSTANCE_LOCK_FILE_NAME,
  INSTANCE_LOCKED_EXIT_CODE,
  tryAcquireInstanceLock,
} from "@t3tools/shared/instanceLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { ServerConfig } from "./config.ts";

/**
 * Another server owns this state directory. The process exits with code 75 so
 * its supervisor (the desktop, a terminal) can tell "retry shortly" from a
 * crash.
 */
export class ServerInstanceLockedError extends Schema.TaggedError<ServerInstanceLockedError>()(
  "ServerInstanceLockedError",
  {
    lockPath: Schema.String,
  },
) {
  override readonly [Runtime.errorExitCode] = INSTANCE_LOCKED_EXIT_CODE;

  override get message(): string {
    return `Another OOP server already runs on this data directory (${this.lockPath} is locked).`;
  }
}

export class ServerInstanceLockUnavailableError extends Schema.TaggedError<ServerInstanceLockUnavailableError>()(
  "ServerInstanceLockUnavailableError",
  {
    lockPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not take the single-instance lock at ${this.lockPath}.`;
  }
}

/**
 * Hold `<stateDir>/server.lock` for the life of the server when
 * `ServerConfig.instanceLock` is set. Everything else in the server is built on
 * top of this layer: a second server on the same directory must stop before its
 * database layer migrates or its startup recovery touches the first server's
 * turns. Without the flag the layer does nothing, so dev servers,
 * `t3 service`, and plain `serve` behave as before.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.instanceLock !== true) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = path.join(config.stateDir, INSTANCE_LOCK_FILE_NAME);

    const attempt = yield* Effect.try({
      try: () => tryAcquireInstanceLock(lockPath),
      catch: (cause) => new ServerInstanceLockUnavailableError({ lockPath, cause }),
    });
    switch (attempt._tag) {
      case "Held":
        return yield* new ServerInstanceLockedError({ lockPath });
      case "Unsupported":
        return yield* new ServerInstanceLockUnavailableError({
          lockPath,
          cause: new Error("node:sqlite is not available in this runtime."),
        });
      case "Acquired":
        yield* Effect.addFinalizer(() => Effect.sync(attempt.release));
    }

    // Holding the lock means no live server owns the runtime file, so whatever
    // is there came from a process that died. Clearing it keeps a pid that the
    // OS has since handed to an unrelated process from being read as ours.
    yield* fs
      .remove(config.serverRuntimeStatePath, { force: true })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to clear a stale server runtime state", { cause }),
        ),
      );
  }),
);
