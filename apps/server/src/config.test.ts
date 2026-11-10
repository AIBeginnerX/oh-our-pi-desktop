import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "./config.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(NodeServices.layer)("ServerConfig.ensureServerDirectories", (it) => {
  // File modes mean nothing on Windows, where the chmod is skipped entirely.
  it.effect.skipIf(windowsHost)(
    "restricts the state directory so other local users cannot read state.sqlite",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-state-dir-mode-" });
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });
        // Simulates a state dir created before the mode was tightened.
        yield* fs.makeDirectory(paths.stateDir, { recursive: true });
        yield* fs.chmod(paths.stateDir, 0o755);

        yield* ServerConfig.ensureServerDirectories(paths);

        const stat = yield* fs.stat(paths.stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      }),
  );

  // A state dir owned by another user cannot be chmod-ed; that must not block startup.
  it.effect.skipIf(windowsHost)(
    "warns and keeps starting up when the state directory cannot be restricted",
    () => {
      const warnings: Array<string> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      });

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-state-dir-chmod-denied-",
        });
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });
        const chmodDenied = {
          ...fs,
          chmod: (path: string, _mode: number) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "chmod",
                pathOrDescriptor: path,
                description: "Operation not permitted.",
              }),
            ),
        } satisfies FileSystem.FileSystem;

        yield* ServerConfig.ensureServerDirectories(paths).pipe(
          Effect.provideService(FileSystem.FileSystem, chmodDenied),
        );

        expect(yield* fs.exists(paths.stateDir)).toBe(true);
        expect(
          warnings.some((message) =>
            message.includes("Could not restrict the server state directory"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );
});
