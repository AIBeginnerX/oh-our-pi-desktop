import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

// Chromium keys its V8 code cache by the scripts it compiled. After an app
// update the previous version's entries can never be hit again but stay on
// disk (about 150 MB once the renderer and the preload have been seen a few
// times), so the first launch of a new version drops them once. The record of
// the last version that ran lives next to the cache it governs, in userData.
export const CODE_CACHE_VERSION_FILE_NAME = "code-cache-version.json";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-code-cache");

const CodeCacheVersionDocument = Schema.Struct({ version: Schema.String });
const decodeCodeCacheVersionDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodeCacheVersionDocument),
);
const encodeCodeCacheVersionDocument = Schema.encodeEffect(
  Schema.fromJsonString(CodeCacheVersionDocument),
);

/**
 * Clears unless the recorded version is the running one. A missing record also
 * clears: profiles that predate this file carry an older version's cache, and
 * dropping a fresh profile's near-empty cache costs one recompile.
 */
export function shouldClearCodeCache(previous: string | null, current: string): boolean {
  return previous !== current;
}

const readPreviousVersion = (
  fileSystem: FileSystem.FileSystem,
  versionFilePath: string,
): Effect.Effect<string | null> =>
  fileSystem.readFileString(versionFilePath).pipe(
    Effect.flatMap(decodeCodeCacheVersionDocument),
    Effect.map((document) => document.version),
    // An unreadable or corrupt record counts as unknown, which clears once.
    Effect.orElseSucceed(() => null),
  );

const writeCurrentVersion = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  versionFilePath: string,
  currentVersion: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const encoded = yield* encodeCodeCacheVersionDocument({ version: currentVersion });
    yield* fileSystem.makeDirectory(path.dirname(versionFilePath), { recursive: true });
    yield* fileSystem.writeFileString(versionFilePath, `${encoded}\n`);
  }).pipe(
    // A version that cannot be recorded only means the next launch sweeps the
    // cache again, which is cheaper than failing this one.
    Effect.orElseSucceed(() => undefined),
  );

export interface DesktopCodeCacheMaintenanceInput {
  /** `code-cache-version.json` inside the Electron userData directory. */
  readonly versionFilePath: string;
  readonly currentVersion: string;
  /** The only Electron call this path makes: `session.defaultSession.clearCodeCaches({})`. */
  readonly clearCodeCaches: () => Promise<void>;
}

/**
 * Reads the version that ran last, drops the V8 code cache when it differs,
 * then records the current version. Never fails: every step degrades to a log
 * line so cache housekeeping can never take startup down with it.
 */
export const runCodeCacheMaintenance = Effect.fn("desktop.codeCache.runMaintenance")(function* (
  input: DesktopCodeCacheMaintenanceInput,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previousVersion = yield* readPreviousVersion(fileSystem, input.versionFilePath);

  if (shouldClearCodeCache(previousVersion, input.currentVersion)) {
    yield* Effect.tryPromise(() => input.clearCodeCaches()).pipe(
      Effect.flatMap(() =>
        logInfo("cleared V8 code cache for a new app version", {
          previousVersion,
          currentVersion: input.currentVersion,
        }),
      ),
      Effect.catchCause((cause) =>
        logWarning("could not clear the V8 code cache", {
          previousVersion,
          currentVersion: input.currentVersion,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }

  yield* writeCurrentVersion(fileSystem, path, input.versionFilePath, input.currentVersion);
});

/**
 * The Electron entry point. Runs off the startup path: the caller forks it
 * once the app is ready so a cache sweep cannot delay the window.
 */
export const clearCodeCacheAfterVersionChange = Effect.fn(
  "desktop.codeCache.clearAfterVersionChange",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  yield* runCodeCacheMaintenance({
    versionFilePath: path.join(Electron.app.getPath("userData"), CODE_CACHE_VERSION_FILE_NAME),
    currentVersion: environment.appVersion,
    clearCodeCaches: () => Electron.session.defaultSession.clearCodeCaches({}),
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("code cache housekeeping failed", { cause: Cause.pretty(cause) }),
    ),
  );
});
