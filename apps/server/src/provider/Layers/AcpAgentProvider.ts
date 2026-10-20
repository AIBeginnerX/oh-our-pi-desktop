/**
 * Status checks for third-party coding agents that OoP drives over ACP through the shared Grok ACP
 * adapter (MiniMax Code, ZCode). Each agent supplies its launch command and setup hints; this module
 * answers whether the CLI runs and which models its ACP agent advertises.
 */
import * as NodeOS from "node:os";

import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";
import { type AcpAgentLaunch, makeGrokAcpRuntime } from "../acp/GrokAcpSupport.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "../providerSnapshot.ts";
import {
  buildGrokModelsFromSessionModelState,
  grokSlashCommandsFromInitialize,
} from "./GrokProvider.ts";

export const ACP_AGENT_EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
// Windows launches these npm CLIs through a .cmd shim and a shell, and at startup every provider
// probes at once; a cold start there routinely takes several seconds, and initialize has been
// seen near 40 s. A timeout only delays the card, so the limits are generous.
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const ACP_INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_MODELS_TIMEOUT_MS = 20_000;

export interface AcpAgentDefinition {
  readonly presentation: ServerProviderPresentation;
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly launch: AcpAgentLaunch;
  readonly authLabel: string;
  readonly missingMessage: string;
  readonly noAnswerMessage: string;
}

export interface AcpAgentSettings {
  readonly enabled: boolean;
  readonly customModels?: ReadonlyArray<CustomModelSetting> | undefined;
}

function modelsFor(
  settings: AcpAgentSettings,
  builtInModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    settings.customModels ?? [],
    ACP_AGENT_EMPTY_CAPABILITIES,
  );
}

export function buildInitialAcpAgentSnapshot(
  agent: Pick<AcpAgentDefinition, "presentation" | "builtInModels">,
  settings: AcpAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  const name = agent.presentation.displayName;
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: agent.presentation,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: modelsFor(settings, agent.builtInModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? `Checking ${name} availability...`
          : `${name} is disabled in settings.`,
      },
    }),
  );
}

const initializeAgent = (launch: AcpAgentLaunch, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings: { binaryPath: launch.command },
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      launch,
    });
    const initialized = yield* acp.initialize();
    return {
      models: buildGrokModelsFromSessionModelState(sessionModelStateFromInitialize(initialized)),
      slashCommands: grokSlashCommandsFromInitialize(initialized),
    };
  }).pipe(Effect.scoped);

/** The selectable models in a session's `model` config option, in the agent's own order. */
export function acpConfigOptionModels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const option = configOptions?.find((entry) => entry.category === "model");
  if (option?.type !== "select") return [];
  const seen = new Set<string>();
  return option.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .flatMap((entry): ServerProviderModel[] => {
      const slug = entry.value.trim();
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: entry.name.trim() || slug,
          isCustom: false,
          capabilities: ACP_AGENT_EMPTY_CAPABILITIES,
        },
      ];
    });
}

// MiniMax Code and ZCode list their models only on a new session. Opening one costs a process and
// leaves a session in the agent's history, so it happens once per CLI version; a probe that finds
// nothing (signed out, slow agent) is retried on the next check.
const sessionModelCache = new Map<string, ReadonlyArray<ServerProviderModel>>();

const sessionModels = (
  launch: AcpAgentLaunch,
  environment: NodeJS.ProcessEnv,
  version: string | null,
) => {
  const key = `${launch.command}\0${version ?? ""}`;
  const cached = sessionModelCache.get(key);
  if (cached !== undefined) return Effect.succeed(cached);
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings: { binaryPath: launch.command },
      environment,
      childProcessSpawner,
      // Agents keep per-workspace state in the session cwd (ZCode writes .zcode/), so the probe
      // session runs in the temp dir instead of the server's working directory.
      cwd: NodeOS.tmpdir(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      launch,
    });
    const started = yield* acp.start();
    const models = acpConfigOptionModels(started.sessionSetupResult.configOptions);
    if (models.length > 0) sessionModelCache.set(key, models);
    return models;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(SESSION_MODELS_TIMEOUT_MS),
    Effect.map(Option.getOrElse((): ReadonlyArray<ServerProviderModel> => [])),
    Effect.orElseSucceed((): ReadonlyArray<ServerProviderModel> => []),
  );
};

/**
 * What the provider card says when the agent gave no usable answer. A slow start is not a sign-in
 * problem, so only a real failure points the user at signing in again.
 */
export function acpProbeMessage(
  agent: Pick<AcpAgentDefinition, "presentation" | "noAnswerMessage">,
  timedOut: boolean,
): string {
  return timedOut
    ? `${agent.presentation.displayName} is taking longer than usual to start. OoP checks it again on the next refresh.`
    : agent.noAnswerMessage;
}

export const checkAcpAgentProviderStatus = Effect.fn("checkAcpAgentProviderStatus")(function* (
  agent: AcpAgentDefinition,
  settings: AcpAgentSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const name = agent.presentation.displayName;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFor(settings, agent.builtInModels);
  const snapshot = (probe: Parameters<typeof buildServerProvider>[0]["probe"], extra = {}) =>
    buildServerProvider({
      presentation: agent.presentation,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      ...extra,
      probe,
    });
  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: `${name} is disabled in settings.`,
    });
  }

  const versionEnvironment = { ...environment, ...agent.launch.env };
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(agent.launch.command, ["--version"], {
      env: versionEnvironment,
    });
    return yield* spawnAndCollect(
      agent.launch.command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: versionEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing ? agent.missingMessage : `Failed to run the ${name} health check.`,
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: acpProbeMessage(agent, true),
    });
  }
  if (versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `${name} is installed but \`${agent.launch.command} --version\` failed.`,
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);

  const acpExit = yield* initializeAgent(agent.launch, environment).pipe(
    Effect.timeoutOption(ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const metadata = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
  const initializeTimedOut = Exit.isSuccess(acpExit) && Option.isNone(acpExit.value);
  if (metadata === undefined) {
    yield* Effect.logWarning(`${name} ACP initialize probe failed or timed out.`, {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }
  const advertised =
    metadata === undefined
      ? []
      : metadata.models.length > 0
        ? metadata.models
        : yield* sessionModels(agent.launch, environment, version);
  const models =
    advertised.length > 0
      ? modelsFor(settings, [...agent.builtInModels, ...advertised])
      : fallbackModels;

  return snapshot(
    {
      installed: true,
      version,
      status: metadata === undefined ? "warning" : "ready",
      // These agents keep their own sign-in; a signed-out CLI fails the first session instead.
      auth: { status: "unknown", label: agent.authLabel },
      ...(metadata === undefined ? { message: acpProbeMessage(agent, initializeTimedOut) } : {}),
    },
    { models, slashCommands: metadata?.slashCommands ?? [COMPACT_SLASH_COMMAND] },
  );
});
