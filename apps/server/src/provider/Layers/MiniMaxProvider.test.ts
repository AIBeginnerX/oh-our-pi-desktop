import { MINIMAX_CODE_DEFAULT_MODEL, MiniMaxCodeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialMiniMaxProviderSnapshot,
  checkMiniMaxProviderStatus,
  MINIMAX_CODE_PRESENTATION,
  miniMaxApiKeyDirName,
  miniMaxCodeAcpLaunch,
  prepareMiniMaxApiKeyDataDir,
  withApiKeyModelNames,
} from "./MiniMaxProvider.ts";
import {
  ACP_AGENT_EMPTY_CAPABILITIES,
  acpConfigOptionModels,
  acpProbeMessage,
} from "./AcpAgentProvider.ts";

const decodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

const settings = (overrides: Partial<MiniMaxCodeSettings> = {}): MiniMaxCodeSettings => ({
  ...decodeSettings({}),
  ...overrides,
});

describe("MiniMax Code provider", () => {
  it("launches MiniMax Code as an ACP agent without an explicit sign-in method", () => {
    expect(miniMaxCodeAcpLaunch(settings())).toEqual({
      command: "mcode",
      args: ["acp"],
      env: { MAVIS_REGION: "en" },
    });
    expect(miniMaxCodeAcpLaunch(settings({ binaryPath: "/opt/mcode" })).command).toBe("/opt/mcode");
  });

  it("names M3.1-Flash without MiniMax Code's free-tier label on an API key", () => {
    const named = withApiKeyModelNames(
      [
        { slug: "m:minimax:MiniMax-M3.1-Flash:v:", name: "M3.1-Flash (Free)" },
        { slug: "m:minimax:MiniMax-M3.1-Flash:v:thinking", name: "M3.1-Flash (Free) · thinking" },
        { slug: "m:minimax:MiniMax-M3:v:", name: "M3" },
      ].map((model) => ({ ...model, isCustom: false, capabilities: ACP_AGENT_EMPTY_CAPABILITIES })),
    );
    expect(named.map((model) => model.name)).toEqual(["M3.1-Flash", "M3.1-Flash · thinking", "M3"]);
  });

  it("keeps MiniMax Code state in the API-key data dir when one is given", () => {
    expect(miniMaxCodeAcpLaunch(settings(), "/state/providers/minimax/minimax").env).toEqual({
      MAVIS_REGION: "en",
      MINIMAX_DATA_DIR: "/state/providers/minimax/minimax",
    });
  });

  it.effect("starts disabled with the product model that keeps the session's own model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMiniMaxProviderSnapshot(settings());
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([MINIMAX_CODE_DEFAULT_MODEL]);
    }),
  );

  it.effect("tells the user how to install and sign in when the CLI is missing", () =>
    checkMiniMaxProviderStatus(
      settings({ enabled: true, binaryPath: "/nonexistent/oop-test/mcode" }),
    ).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("mcode login --region global");
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
});

const exitedWith = (code: number, stderr: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: stderr ? Stream.make(new TextEncoder().encode(stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

interface SpawnRecord {
  readonly args: ReadonlyArray<string>;
  readonly dataDir: string | undefined;
  readonly key: string | undefined;
}

/**
 * Prepares each listed key in turn, in its own data dir as the driver lays them out. `mcode` fails
 * (echoing the key on stderr, as a CLI might) for keys starting with `sk-cp-bad`.
 */
const prepareWith = (keys: ReadonlyArray<string | undefined>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "oop-minimax-key-" });
    const instanceDir = path.join(root, "providers", "minimax", "minimax");
    const dataDirOf = (key: string) => path.join(instanceDir, miniMaxApiKeyDirName(key));
    const spawns: Array<SpawnRecord> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const { args, options } = command as unknown as {
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv };
      };
      spawns.push({
        args,
        dataDir: options.env?.MINIMAX_DATA_DIR,
        key: options.env?.OOP_MINIMAX_API_KEY,
      });
      const key = options.env?.OOP_MINIMAX_API_KEY ?? "";
      return Effect.succeed(
        key.startsWith("sk-cp-bad")
          ? exitedWith(1, `error: invalid MiniMax API key ${key}\n`)
          : exitedWith(0, ""),
      );
    });
    const outcomes: Array<"ok" | string> = [];
    for (const key of keys) {
      const environment = key === undefined ? {} : { OOP_MINIMAX_API_KEY: key };
      const launch = miniMaxCodeAcpLaunch(settings(), dataDirOf(key?.trim() || "none"));
      outcomes.push(
        yield* prepareMiniMaxApiKeyDataDir(launch, environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.as("ok"),
          Effect.catch((cause) => Effect.succeed(String(cause))),
        ),
      );
    }
    const remainingDirs = (yield* fs.exists(instanceDir))
      ? [...(yield* fs.readDirectory(instanceDir))].sort()
      : [];
    return { spawns, outcomes, dataDirOf, remainingDirs };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const SET_KEY_ARGS = ["provider", "set-minimax-key", "--api-key-env", "OOP_MINIMAX_API_KEY"];

describe("prepareMiniMaxApiKeyDataDir", () => {
  it.effect("selects each key once in its own data dir and drops the earlier key's dir", () =>
    Effect.gen(function* () {
      const { spawns, outcomes, dataDirOf, remainingDirs } = yield* prepareWith([
        "sk-cp-one",
        "sk-cp-one",
        "sk-cp-two",
      ]);
      expect(outcomes).toEqual(["ok", "ok", "ok"]);
      expect(spawns).toEqual([
        { args: SET_KEY_ARGS, dataDir: dataDirOf("sk-cp-one"), key: "sk-cp-one" },
        { args: SET_KEY_ARGS, dataDir: dataDirOf("sk-cp-two"), key: "sk-cp-two" },
      ]);
      expect(dataDirOf("sk-cp-one")).not.toBe(dataDirOf("sk-cp-two"));
      expect(remainingDirs).toEqual([miniMaxApiKeyDirName("sk-cp-two")]);
    }),
  );

  it.effect("leaves MiniMax Code alone without a key", () =>
    Effect.gen(function* () {
      const { spawns, outcomes } = yield* prepareWith([undefined, "  "]);
      expect(outcomes).toEqual(["ok", "ok"]);
      expect(spawns).toEqual([]);
    }),
  );

  it.effect("keeps a rejected key's dir apart from the working one and never reports the key", () =>
    Effect.gen(function* () {
      const { spawns, outcomes, remainingDirs } = yield* prepareWith([
        "sk-cp-one",
        "sk-cp-bad-secret",
        "sk-cp-bad-secret",
      ]);
      expect(spawns.map((spawn) => spawn.key)).toEqual([
        "sk-cp-one",
        "sk-cp-bad-secret",
        "sk-cp-bad-secret",
      ]);
      expect(outcomes[0]).toBe("ok");
      for (const outcome of outcomes.slice(1)) {
        expect(outcome).toContain("mcode exited with code 1");
        expect(outcome).not.toContain("sk-cp-bad-secret");
      }
      // The failed key's dir has no marker and the earlier key's dir stays only until a key works.
      expect(remainingDirs).toEqual(
        [miniMaxApiKeyDirName("sk-cp-one"), miniMaxApiKeyDirName("sk-cp-bad-secret")].sort(),
      );
    }),
  );
});

describe("acpConfigOptionModels", () => {
  it("lists the selectable models of a session's model option once each, in order", () => {
    const models = acpConfigOptionModels([
      {
        id: "permissionMode",
        name: "Mode",
        category: "_permission",
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "m:minimax:MiniMax-M3:v:thinking",
        options: [
          { value: "m:minimax:MiniMax-M3:v:", name: "M3" },
          { value: "m:minimax:MiniMax-M3:v:thinking", name: "M3 · thinking" },
          { value: "m:minimax:MiniMax-M3:v:", name: "M3 again" },
          { value: "  ", name: "blank" },
        ],
      },
    ]);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["m:minimax:MiniMax-M3:v:", "M3"],
      ["m:minimax:MiniMax-M3:v:thinking", "M3 · thinking"],
    ]);
    expect(acpConfigOptionModels(undefined)).toEqual([]);
  });

  it("does not send the user to sign in when the agent is only slow to start", () => {
    const agent = {
      presentation: MINIMAX_CODE_PRESENTATION,
      noAnswerMessage: "MiniMax Code did not answer. If you are signed out, run mcode login.",
    };
    expect(acpProbeMessage(agent, true)).toBe(
      "MiniMax Code is taking longer than usual to start. OoP checks it again on the next refresh.",
    );
    expect(acpProbeMessage(agent, false)).toBe(agent.noAnswerMessage);
  });
});
