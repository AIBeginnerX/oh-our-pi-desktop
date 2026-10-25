import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Layer from "effect/Layer";

/**
 * Installs the ACP-backed provider CLIs through the fixed `npm install -g <package>` commands.
 * Only the packages in NPM_CLI_PACKAGES are ever installed; the install command is never taken
 * from provider settings, messages, or any other input.
 */
export const NPM_CLI_PACKAGES: Readonly<Record<string, string>> = {
  minimax: "@minimax-ai/code",
  zcode: "zcode-acp-server",
  opencode: "opencode-ai",
};

export class NpmCliInstallationError extends Schema.TaggedError<NpmCliInstallationError>()(
  "NpmCliInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const npmArgsFor = (packageName: string, action: "install" | "uninstall") => [
  action === "install" ? "install" : "uninstall",
  "-g",
  packageName,
  "--no-fund",
  "--no-audit",
];

/**
 * One shared install pipeline for the npm-backed provider CLIs (MiniMax Code, ZCode, OpenCode).
 * Start is exclusive per service instance; the state stream replays the latest state first.
 */
export class NpmCliInstallation extends Context.Service<
  NpmCliInstallation,
  {
    readonly start: (input: {
      readonly driver: ProviderDriverKind;
    }) => Effect.Effect<
      ProviderInstallState,
      NpmCliInstallationError | PlatformError.PlatformError
    >;
    readonly remove: (input: {
      readonly driver: ProviderDriverKind;
    }) => Effect.Effect<
      ProviderInstallState,
      NpmCliInstallationError | PlatformError.PlatformError
    >;
    readonly changes: Stream.Stream<ProviderInstallState>;
    readonly state: Effect.Effect<ProviderInstallState>;
  }
>()("t3/provider/NpmCliInstallation") {}

const idleState = (driver: ProviderDriverKind): ProviderInstallState => ({
  driver,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const statesRef = yield* Ref.make<Map<string, ProviderInstallState>>(new Map());
  const events = yield* PubSub.unbounded<ProviderInstallState>();

  const publish = (state: ProviderInstallState) =>
    Effect.gen(function* () {
      yield* Ref.update(statesRef, (map) => new Map(map).set(String(state.driver), state));
      yield* PubSub.publish(events, state);
    });

  const runNpm = Effect.fn("NpmCliInstallation.runNpm")(function* (
    driver: ProviderDriverKind,
    action: "install" | "uninstall",
  ) {
    const packageName = NPM_CLI_PACKAGES[String(driver)];
    if (packageName === undefined) {
      return yield* new NpmCliInstallationError({
        operation: `${action}-npm-cli`,
        detail: "Managed installation is not available for this provider.",
      });
    }
    const running = (yield* Ref.get(statesRef)).get(String(driver));
    if (running?.phase === "downloading") return running;
    const base = { driver, downloadedBytes: 0, totalBytes: null, version: null };
    const operationId = `npm-${action}-${packageName}`;
    yield* publish({
      ...idleState(driver),
      ...base,
      phase: "downloading",
      canRemove: false,
      message: `npm ${action === "install" ? "install" : "uninstall"} -g ${packageName}`,
    });
    const spawnCommand = yield* resolveSpawnCommand("npm", npmArgsFor(packageName, action), {
      env: process.env,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: process.env,
        shell: spawnCommand.shell,
      }),
    );
    let tail = "";
    const collect = (chunk: string) => {
      tail = `${tail}${chunk}`.split("\n").slice(-3).join(" ").trim().slice(0, 400);
    };
    // Drain both pipes while waiting for the exit code: the streams end with the process.
    const exitCode = yield* Effect.all(
      [
        Stream.runForEach(child.stdout, (chunk) => Effect.sync(() => collect(chunk.toString()))),
        Stream.runForEach(child.stderr, (chunk) => Effect.sync(() => collect(chunk.toString()))),
        child.exitCode,
      ],
      { concurrency: 3 },
    ).pipe(Effect.map(([, , code]) => Number(code)));
    if (exitCode === 0) {
      const succeeded: ProviderInstallState = {
        ...base,
        operationId: null,
        phase: "succeeded",
        installedVersion: null,
        canRemove: true,
        message: null,
      };
      yield* publish(succeeded);
      return succeeded;
    }
    const failed: ProviderInstallState = {
      ...base,
      operationId,
      phase: "failed",
      installedVersion: null,
      canRemove: false,
      message: `npm exited with code ${exitCode}${tail ? `: ${tail}` : ""}`,
    };
    yield* publish(failed);
    return failed;
  });

  return NpmCliInstallation.of({
    start: (input) => Effect.scoped(runNpm(input.driver, "install")),
    remove: (input) => Effect.scoped(runNpm(input.driver, "uninstall")),
    changes: Stream.concat(
      Stream.fromEffect(Ref.get(statesRef)).pipe(
        Stream.flatMap((map) => Stream.fromIterable([...map.values()])),
      ),
      Stream.fromPubSub(events),
    ),
    state: Effect.succeed(idleState(ProviderDriverKind.make("minimax"))),
  });
});

export const layer = Layer.effect(NpmCliInstallation, make);
