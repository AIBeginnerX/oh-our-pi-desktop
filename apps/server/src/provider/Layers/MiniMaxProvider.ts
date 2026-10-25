import * as NodeCrypto from "node:crypto";
import {
  MINIMAX_CODE_DEFAULT_MODEL,
  type MiniMaxCodeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import type { AcpAgentLaunch } from "../acp/GrokAcpSupport.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  ACP_AGENT_EMPTY_CAPABILITIES,
  type AcpAgentDefinition,
  buildInitialAcpAgentSnapshot,
  checkAcpAgentProviderStatus,
} from "./AcpAgentProvider.ts";

export const MINIMAX_CODE_PRESENTATION = {
  displayName: "MiniMax Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

export const MINIMAX_CODE_SETUP_HINT =
  "Install MiniMax Code (npm i -g @minimax-ai/code), then run `mcode login --region global`.";

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MINIMAX_CODE_DEFAULT_MODEL,
    name: "MiniMax Code",
    isCustom: false,
    capabilities: ACP_AGENT_EMPTY_CAPABILITIES,
  },
];

/** Instance variable holding a MiniMax API key (a Coding Plan `sk-cp-` key or a general one). */
export const MINIMAX_API_KEY_VARIABLE = "OOP_MINIMAX_API_KEY";

export function miniMaxApiKeyOf(environment: NodeJS.ProcessEnv): string | undefined {
  const key = environment[MINIMAX_API_KEY_VARIABLE]?.trim();
  return key ? key : undefined;
}

/**
 * Model names for an instance running on its API key. MiniMax Code labels M3.1-Flash "(Free)" for
 * its own signed-in accounts; on a key the model runs on the key's plan, so the label drops it.
 */
export function withApiKeyModelNames(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({ ...model, name: model.name.replace(/\s*\(Free\)/u, "") }));
}

const keyDigest = (key: string) => NodeCrypto.createHash("sha256").update(key).digest("hex");

/**
 * The data dir name for one API key. Each key gets its own MiniMax Code data dir, so a key that
 * fails to apply leaves MiniMax Code signed out there instead of running on an earlier key.
 */
export function miniMaxApiKeyDirName(key: string): string {
  return keyDigest(key).slice(0, 16);
}

/**
 * `mcode acp` runs MiniMax Code as an ACP agent; it signs in on its own via `mcode login`. With no
 * region on the command line, in `MAVIS_REGION`, or from an earlier login, MiniMax Code picks the
 * China region (`cn`), so OOP pins the global one (`en`) and a first sign-in opens the global site.
 * With `apiKeyDataDir`, MiniMax Code keeps its state there instead of `~/.minimax`; that is how an
 * instance with an API key runs on the key rather than the user's own MiniMax Code sign-in.
 */
export function miniMaxCodeAcpLaunch(
  settings: Pick<MiniMaxCodeSettings, "binaryPath">,
  apiKeyDataDir?: string,
): AcpAgentLaunch {
  return {
    command: settings.binaryPath || "mcode",
    args: ["acp"],
    env: {
      MAVIS_REGION: "en",
      ...(apiKeyDataDir ? { MINIMAX_DATA_DIR: apiKeyDataDir } : {}),
    },
  };
}

const API_KEY_MARKER = "oop-api-key.sha256";

/** Carries only the exit code: MiniMax Code's own output may echo the key. */
export class MiniMaxApiKeyError extends Schema.TaggedError<MiniMaxApiKeyError>()(
  "MiniMaxApiKeyError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `MiniMax Code could not use the MiniMax API key (mcode exited with code ${this.exitCode}). Check ${MINIMAX_API_KEY_VARIABLE} under Variables.`;
  }
}

/**
 * Points the key's MiniMax Code data dir at the instance's API key: `mcode provider
 * set-minimax-key` saves the key there and selects it as MiniMax Code's credential source, so
 * models run on the key's plan. A marker is written after success, so this spawns MiniMax Code
 * only for a new key; the data dirs of earlier keys are then removed, since they hold those keys.
 */
export const prepareMiniMaxApiKeyDataDir = Effect.fn("prepareMiniMaxApiKeyDataDir")(function* (
  launch: AcpAgentLaunch,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataDir = launch.env?.MINIMAX_DATA_DIR;
  const key = miniMaxApiKeyOf(environment);
  if (!dataDir || !key) return;
  const digest = keyDigest(key);
  const marker = path.join(dataDir, API_KEY_MARKER);
  const recorded = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
  if (recorded.trim() === digest) return;

  yield* fs.makeDirectory(dataDir, { recursive: true });
  const env = { ...environment, ...launch.env };
  const args = ["provider", "set-minimax-key", "--api-key-env", MINIMAX_API_KEY_VARIABLE];
  const spawnCommand = yield* resolveSpawnCommand(launch.command, args, { env });
  const result = yield* spawnAndCollect(
    launch.command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env,
      shell: spawnCommand.shell,
    }),
  ).pipe(Effect.timeout("60 seconds"));
  if (result.code !== 0) {
    return yield* new MiniMaxApiKeyError({ exitCode: result.code });
  }
  yield* fs.writeFileString(marker, digest);

  const keysDir = path.dirname(dataDir);
  const current = path.basename(dataDir);
  const entries = yield* fs.readDirectory(keysDir).pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    if (entry === current) continue;
    yield* fs.remove(path.join(keysDir, entry), { recursive: true }).pipe(Effect.ignore);
  }
});

const miniMaxAgent = (
  settings: MiniMaxCodeSettings,
  apiKeyDataDir?: string,
): AcpAgentDefinition => ({
  presentation: MINIMAX_CODE_PRESENTATION,
  builtInModels: BUILT_IN_MODELS,
  launch: miniMaxCodeAcpLaunch(settings, apiKeyDataDir),
  authLabel: "MiniMax account",
  missingMessage: `MiniMax Code (\`mcode\`) is not installed or not on PATH. ${MINIMAX_CODE_SETUP_HINT}`,
  noAnswerMessage:
    "MiniMax Code is installed but its ACP agent did not answer. If you are signed out, run `mcode login --region global`.",
});

export const buildInitialMiniMaxProviderSnapshot = (settings: MiniMaxCodeSettings) =>
  buildInitialAcpAgentSnapshot(miniMaxAgent(settings), settings);

export const checkMiniMaxProviderStatus = (
  settings: MiniMaxCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  apiKeyDataDir?: string,
) => checkAcpAgentProviderStatus(miniMaxAgent(settings, apiKeyDataDir), settings, environment);
