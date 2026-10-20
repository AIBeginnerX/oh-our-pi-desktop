import {
  MINIMAX_CODE_DEFAULT_MODEL,
  MiniMaxCodeSettings,
  type GrokSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  buildInitialMiniMaxProviderSnapshot,
  checkMiniMaxProviderStatus,
  miniMaxCodeAcpLaunch,
} from "../Layers/MiniMaxProvider.ts";
import { readMiniMaxUsageLimits } from "../Layers/minimaxUsageLimits.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("minimax");
const MINIMAX_CODE_NPM_PACKAGE = "@minimax-ai/code";

/** MiniMax Code ships as an npm package, so a global npm, pnpm, bun, or Vite+ install updates in one click like the other CLIs; anything else stays manual. */
export const MINIMAX_MAINTENANCE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: MINIMAX_CODE_NPM_PACKAGE,
  nativeUpdate: null,
});

export type MiniMaxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * MiniMax Code, MiniMax's own coding agent, over ACP. Sessions, turns, tools, and approvals reuse
 * the Grok ACP adapter with `mcode acp` as the agent; only the status probe is MiniMax-specific.
 */
export const MiniMaxDriver: ProviderDriver<MiniMaxCodeSettings, MiniMaxDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "MiniMax Code",
    supportsMultipleInstances: true,
  },
  configSchema: MiniMaxCodeSettings,
  defaultConfig: (): MiniMaxCodeSettings => decodeMiniMaxCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies MiniMaxCodeSettings;
      // The Grok ACP path only reads these fields; MiniMax Code needs no xAI-specific settings.
      const acpSettings = {
        enabled,
        binaryPath: effectiveConfig.binaryPath,
        customModels: effectiveConfig.customModels,
      } satisfies GrokSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(MINIMAX_MAINTENANCE, {
          binaryPath: effectiveConfig.binaryPath || "mcode",
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const adapter = yield* makeGrokAdapter(acpSettings, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        driverKind: DRIVER_KIND,
        providerLabel: "MiniMax Code",
        launch: () => miniMaxCodeAcpLaunch(effectiveConfig),
        productModelSlug: MINIMAX_CODE_DEFAULT_MODEL,
        harnessLabel: "MiniMax Code",
        signInCommand: `${miniMaxCodeAcpLaunch(effectiveConfig).command} login --region global`,
      });
      const textGeneration = yield* makeGrokTextGeneration(acpSettings, processEnv, {
        launch: miniMaxCodeAcpLaunch(effectiveConfig),
        productModelSlug: MINIMAX_CODE_DEFAULT_MODEL,
        label: "MiniMax Code",
      });

      const checkProvider = checkMiniMaxProviderStatus(effectiveConfig, processEnv).pipe(
        // Token Plan limits come from the account MiniMax Code signs in with, for the Usage view.
        Effect.flatMap((status) =>
          effectiveConfig.enabled && status.installed
            ? readMiniMaxUsageLimits(
                processEnv,
                miniMaxCodeAcpLaunch(effectiveConfig).command,
              ).pipe(Effect.map((usageLimits) => ({ ...status, usageLimits })))
            : Effect.succeed(status),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<MiniMaxCodeSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialMiniMaxProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build MiniMax Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
