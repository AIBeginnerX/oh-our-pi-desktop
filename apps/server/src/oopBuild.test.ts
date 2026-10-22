import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import packageJson from "../package.json" with { type: "json" };
import * as ProcessRunner from "./processRunner.ts";

// The OoP identity is a build-time constant, so each case loads fresh module
// instances with the constant set the way the build would set it.
const load = (release: string | undefined) =>
  Effect.promise(async () => {
    vi.resetModules();
    vi.stubGlobal("__T3CODE_BUILD_OOP_RELEASE__", release);
    return {
      build: await import("./oopBuild.ts"),
      pinned: await import("./cloud/pinnedRuntime.ts"),
    };
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const noDownloads = HttpClient.make((request) => Effect.die(`unexpected download ${request.url}`));
const noProcesses = ProcessRunner.ProcessRunner.of({
  run: (input) => Effect.die(`unexpected process ${input.command}`),
});

it.layer(NodeServices.layer)("OoP build identity", (it) => {
  it.effect("an upstream build keeps its package version and ~/.t3", () =>
    Effect.gen(function* () {
      const { build } = yield* load(undefined);
      assert.isNull(build.OOP_RELEASE_VERSION);
      assert.equal(build.CLI_VERSION, packageJson.version);
      assert.equal(build.DEFAULT_HOME_DIR_NAME, ".t3");
    }),
  );

  it.effect("an OoP build reports its release and keeps its data in ~/.oop-desktop", () =>
    Effect.gen(function* () {
      const { build } = yield* load("0.0.100");
      assert.equal(build.OOP_RELEASE_VERSION, "0.0.100");
      assert.equal(build.CLI_VERSION, "0.0.100");
      assert.equal(build.DEFAULT_HOME_DIR_NAME, ".oop-desktop");
    }),
  );

  it.effect("an OoP build uses the runtime the desktop installed and never downloads one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { build, pinned } = yield* load("0.0.100");
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "oop-pinned-" });
      const validated: string[] = [];
      const install = () =>
        pinned.ensurePinnedRuntimeInstalled({
          baseDir,
          version: "0.0.100",
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: noDownloads,
          runner: noProcesses,
          validate: (runtime) => Effect.sync(() => void validated.push(runtime.entryPath)),
        });

      const missing = yield* Effect.flip(install());
      assert.include(missing.message, build.OOP_UPDATE_MESSAGE);
      assert.deepEqual(validated, []);

      const paths = pinned.pinnedRuntimePaths(path, baseDir, "0.0.100", "linux");
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, "0.0.100\n");
      const installed = yield* install();
      assert.equal(installed.entryPath, paths.entryPath);
      assert.deepEqual(validated, [paths.entryPath]);
    }),
  );
});
