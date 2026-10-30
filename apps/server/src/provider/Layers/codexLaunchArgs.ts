import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import { makeProviderProcessEnvironment } from "../ProviderInstanceEnvironment.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
/** Carries the Codex analytics switch to the probe, app-server and exec launches. */
const T3CODE_CODEX_ANALYTICS_ENV = "T3CODE_CODEX_ANALYTICS";

export const makeCodexProcessEnvironment = (
  environment: Parameters<typeof makeProviderProcessEnvironment>[0],
  telemetry: boolean,
): NodeJS.ProcessEnv => {
  // Codex reads none of the shared defaults; they stay for the CLIs its tools start.
  const processEnv = makeProviderProcessEnvironment(environment);
  return telemetry ? { ...processEnv, [T3CODE_CODEX_ANALYTICS_ENV]: "on" } : processEnv;
};

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};

const analyticsKey = String.raw`(?:analytics|"analytics"|'analytics')`;
const enabledKey = String.raw`(?:enabled|"enabled"|'enabled')`;
const analyticsAssignment = new RegExp(
  String.raw`^\s*${analyticsKey}\s*(?:\.\s*${enabledKey}\s*=|=)`,
  "m",
);
const analyticsTable = new RegExp(String.raw`^\s*\[\s*${analyticsKey}\s*\]\s*(?:#.*)?$`, "m");
const enabledAssignment = new RegExp(String.raw`^\s*${enabledKey}\s*=`, "m");

/** Preserve user analytics declarations, including dotted keys and inline tables. */
const hasAnalyticsSetting = (config: string) => {
  if (analyticsAssignment.test(config)) return true;
  const table = analyticsTable.exec(config);
  if (!table) return false;
  const body = config.slice(table.index + table[0].length).split(/^\s*\[/m)[0] ?? "";
  return enabledAssignment.test(body);
};

const readsCodexHome = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const analyticsDefaultArgs = Effect.fn("withCodexAnalyticsDefault")(function* (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  // Explicit CLI config wins too; keep all caller arguments in their original order.
  if (
    environment[T3CODE_CODEX_ANALYTICS_ENV] === "on" ||
    args.some(
      (arg) =>
        arg === "--analytics-default-enabled" ||
        hasAnalyticsSetting(arg.replace(/^(?:--config=|-c=?)/, "")),
    )
  ) {
    return [...args];
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(expandHomePath(environment.CODEX_HOME || "~/.codex"), "config.toml");
  const userChoseAnalytics = yield* fileSystem.readFileString(configPath).pipe(
    Effect.map(hasAnalyticsSetting),
    // An unreadable config may contain an explicit choice. Let Codex report its own error.
    Effect.catch((cause) => Effect.succeed(cause.reason._tag !== "NotFound")),
  );
  return userChoseAnalytics
    ? [...args]
    : [...args.slice(0, 1), "-c", "analytics.enabled=false", ...args.slice(1)];
});

/** Apply the same analytics default to app-server and exec, using the child's actual home. */
export const withCodexAnalyticsDefault = (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) => analyticsDefaultArgs(args, environment).pipe(Effect.provide(readsCodexHome));
