import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  makeCodexProcessEnvironment,
  resolveCodexLaunchArgs,
  withCodexAnalyticsDefault,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

effectIt.layer(NodeServices.layer)("withCodexAnalyticsDefault", (it) => {
  const codexHome = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-analytics-" });
    const writeConfig = (config: string) =>
      fileSystem.writeFileString(path.join(home, "config.toml"), config);
    return { home, writeConfig, configPath: path.join(home, "config.toml"), fileSystem };
  });

  for (const command of ["app-server", "exec"]) {
    it.effect(`disables analytics by default for ${command}`, () =>
      Effect.gen(function* () {
        const { home } = yield* codexHome;
        const args = [command, "--strict-config"];
        NodeAssert.deepStrictEqual(yield* withCodexAnalyticsDefault(args, { CODEX_HOME: home }), [
          command,
          "-c",
          "analytics.enabled=false",
          "--strict-config",
        ]);
        NodeAssert.deepStrictEqual(args, [command, "--strict-config"]);
      }),
    );
  }

  for (const config of [
    "[analytics]\nenabled = true\n",
    "[analytics] # user choice\nenabled = false\n",
    ' [ "analytics" ]\n "enabled" = true\n',
    "['analytics']\n'enabled' = false\n",
    "analytics.enabled = true\n",
    '"analytics" . "enabled" = false\n',
    "analytics = { enabled = true }\n",
  ]) {
    it.effect(`preserves the user's config: ${JSON.stringify(config)}`, () =>
      Effect.gen(function* () {
        const { home, writeConfig } = yield* codexHome;
        yield* writeConfig(config);
        for (const args of [["app-server"], ["exec"]]) {
          NodeAssert.deepStrictEqual(
            yield* withCodexAnalyticsDefault(args, { CODEX_HOME: home }),
            args,
          );
        }
      }),
    );
  }

  for (const config of [
    "# [analytics]\n# enabled = true\n",
    "[other]\nenabled = true\n",
    "[analytics]\n[other]\nenabled = true\n",
    "[analytics.other]\nenabled = true\n",
  ]) {
    it.effect(`ignores unrelated settings: ${JSON.stringify(config)}`, () =>
      Effect.gen(function* () {
        const { home, writeConfig } = yield* codexHome;
        yield* writeConfig(config);
        NodeAssert.deepStrictEqual(
          yield* withCodexAnalyticsDefault(["exec"], { CODEX_HOME: home }),
          ["exec", "-c", "analytics.enabled=false"],
        );
      }),
    );
  }

  for (const launchArgs of [
    "-c analytics.enabled=true",
    "--config analytics.enabled=false",
    "--config=analytics.enabled=true",
    "-c=analytics.enabled=true",
    "--analytics-default-enabled",
  ]) {
    it.effect(`preserves explicit launch args: ${launchArgs}`, () =>
      Effect.gen(function* () {
        const { home } = yield* codexHome;
        const args = codexAppServerArgs(launchArgs);
        NodeAssert.deepStrictEqual(
          yield* withCodexAnalyticsDefault(args, { CODEX_HOME: home }),
          args,
        );
      }),
    );
  }

  it.effect("leaves Codex analytics alone when its switch is on", () =>
    Effect.gen(function* () {
      const { home } = yield* codexHome;
      const environment = makeCodexProcessEnvironment(
        [{ name: "CODEX_HOME", value: home, sensitive: false }],
        true,
      );
      NodeAssert.deepStrictEqual(yield* withCodexAnalyticsDefault(["exec"], environment), ["exec"]);
      // CLIs that Codex tools start keep the shared defaults.
      NodeAssert.equal(environment.DISABLE_TELEMETRY, "1");
      NodeAssert.deepStrictEqual(
        yield* withCodexAnalyticsDefault(
          ["exec"],
          makeCodexProcessEnvironment(
            [{ name: "CODEX_HOME", value: home, sensitive: false }],
            false,
          ),
        ),
        ["exec", "-c", "analytics.enabled=false"],
      );
    }),
  );

  it.effect("leaves unreadable config handling to Codex", () =>
    Effect.gen(function* () {
      const { home, configPath, fileSystem } = yield* codexHome;
      yield* fileSystem.makeDirectory(configPath);
      NodeAssert.deepStrictEqual(yield* withCodexAnalyticsDefault(["exec"], { CODEX_HOME: home }), [
        "exec",
      ]);
    }),
  );

  it.effect("reads the config again for each process launch", () =>
    Effect.gen(function* () {
      const { home, writeConfig } = yield* codexHome;
      const args = ["app-server"];
      NodeAssert.ok(
        (yield* withCodexAnalyticsDefault(args, { CODEX_HOME: home })).includes(
          "analytics.enabled=false",
        ),
      );
      yield* writeConfig("[analytics]\nenabled = true\n");
      NodeAssert.deepStrictEqual(
        yield* withCodexAnalyticsDefault(args, { CODEX_HOME: home }),
        args,
      );
    }),
  );
});
