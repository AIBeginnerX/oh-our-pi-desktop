import {
  ZCODE_DEFAULT_MODEL,
  ZCodeSettings,
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
  buildInitialZCodeProviderSnapshot,
  checkZCodeProviderStatus,
  zcodeAcpLaunch,
} from "../Layers/ZCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { readZCodeUsageLimits } from "../Layers/zcodeUsageLimits.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeProviderProcessEnvironment } from "../ProviderInstanceEnvironment.ts";
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

const decodeZCodeSettings = Schema.decodeSync(ZCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("zcode");
const ZCODE_ACP_NPM_PACKAGE = "zcode-acp-server";

/** The updatable piece is the zcode-acp-server bridge, an npm package; a global package-manager install updates in one click, anything else stays manual. */
export const ZCODE_MAINTENANCE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: ZCODE_ACP_NPM_PACKAGE,
  nativeUpdate: null,
});

export type ZCodeDriverEnv =
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
 * ZCode, Z.ai's coding agent for GLM, through the `zcode-acp-server` ACP bridge. Sessions, turns,
 * tools, and approvals reuse the Grok ACP adapter; only the status probe is ZCode-specific.
 */
export const ZCodeDriver: ProviderDriver<ZCodeSettings, ZCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => decodeZCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = makeProviderProcessEnvironment(environment, process.env, {
        ...(config.telemetry ? { telemetryOn: "zcode" as const } : {}),
      });
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
      const effectiveConfig = { ...config, enabled } satisfies ZCodeSettings;
      // The Grok ACP path only reads these fields; ZCode needs no xAI-specific settings.
      const acpSettings = {
        enabled,
        binaryPath: effectiveConfig.binaryPath,
        customModels: effectiveConfig.customModels,
        telemetry: effectiveConfig.telemetry,
      } satisfies GrokSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(ZCODE_MAINTENANCE, {
          binaryPath: effectiveConfig.bridgePath || "zcode-acp-server",
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
        providerLabel: "ZCode",
        launch: () => zcodeAcpLaunch(effectiveConfig),
        productModelSlug: ZCODE_DEFAULT_MODEL,
        harnessLabel: "ZCode",
      });
      const textGeneration = yield* makeGrokTextGeneration(acpSettings, processEnv, {
        launch: zcodeAcpLaunch(effectiveConfig),
        productModelSlug: ZCODE_DEFAULT_MODEL,
        label: "ZCode",
      });

      const checkProvider = checkZCodeProviderStatus(effectiveConfig, processEnv).pipe(
        // GLM plan limits come from the Z.ai key ZCode signs in with, for the Usage limits view.
        Effect.flatMap((status) =>
          effectiveConfig.enabled && status.installed
            ? readZCodeUsageLimits(processEnv).pipe(
                Effect.map((usageLimits) => ({ ...status, usageLimits })),
              )
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
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ZCodeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialZCodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ZCode snapshot: ${cause.message ?? String(cause)}`,
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
