import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

// The module reaches Electron only through clearCodeCacheAfterVersionChange,
// which these tests never call; the mock keeps importing it from starting a
// real Electron app.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/unused-user-data" },
  session: { defaultSession: { clearCodeCaches: async () => undefined } },
}));

import * as DesktopCodeCache from "./DesktopCodeCache.ts";

const withTempDir = <A, E>(
  run: (tempDir: string, path: Path.Path) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-code-cache-test-",
    });
    return yield* run(tempDir, path);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const versionFilePath = (path: Path.Path, tempDir: string) =>
  path.join(tempDir, "userData", DesktopCodeCache.CODE_CACHE_VERSION_FILE_NAME);

describe("shouldClearCodeCache", () => {
  it("keeps the cache when the version is unchanged", () => {
    assert.equal(DesktopCodeCache.shouldClearCodeCache("1.2.3", "1.2.3"), false);
  });

  it("clears the cache when the version changed", () => {
    assert.equal(DesktopCodeCache.shouldClearCodeCache("1.2.3", "1.2.4"), true);
  });

  it("clears when no version is recorded, since older profiles have no record", () => {
    assert.equal(DesktopCodeCache.shouldClearCodeCache(null, "1.2.3"), true);
  });
});

describe("runCodeCacheMaintenance", () => {
  it.effect("clears once and records the version when none was recorded", () =>
    withTempDir((tempDir, path) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const recordedPath = versionFilePath(path, tempDir);
        const clearCodeCaches = vi.fn(async () => undefined);

        yield* DesktopCodeCache.runCodeCacheMaintenance({
          versionFilePath: recordedPath,
          currentVersion: "1.2.3",
          clearCodeCaches,
        });

        assert.equal(clearCodeCaches.mock.calls.length, 1);
        assert.equal(
          (yield* fileSystem.readFileString(recordedPath)).trim(),
          '{"version":"1.2.3"}',
        );
      }),
    ),
  );

  it.effect("clears once and records the new version when the version changed", () =>
    withTempDir((tempDir, path) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const recordedPath = versionFilePath(path, tempDir);
        const clearCodeCaches = vi.fn(async () => undefined);

        yield* fileSystem.makeDirectory(path.dirname(recordedPath), { recursive: true });
        yield* fileSystem.writeFileString(recordedPath, '{"version":"1.2.3"}\n');

        yield* DesktopCodeCache.runCodeCacheMaintenance({
          versionFilePath: recordedPath,
          currentVersion: "1.2.4",
          clearCodeCaches,
        });

        assert.equal(clearCodeCaches.mock.calls.length, 1);
        assert.equal(
          (yield* fileSystem.readFileString(recordedPath)).trim(),
          '{"version":"1.2.4"}',
        );
      }),
    ),
  );

  it.effect("records the new version even when clearing fails", () =>
    withTempDir((tempDir, path) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const recordedPath = versionFilePath(path, tempDir);

        yield* fileSystem.makeDirectory(path.dirname(recordedPath), { recursive: true });
        yield* fileSystem.writeFileString(recordedPath, '{"version":"1.2.3"}\n');

        yield* DesktopCodeCache.runCodeCacheMaintenance({
          versionFilePath: recordedPath,
          currentVersion: "1.2.4",
          clearCodeCaches: async () => {
            throw new Error("cache is busy");
          },
        });

        assert.equal(
          (yield* fileSystem.readFileString(recordedPath)).trim(),
          '{"version":"1.2.4"}',
        );
      }),
    ),
  );
});
