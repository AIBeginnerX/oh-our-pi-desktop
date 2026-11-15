import type { ServerSettings, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";

import type * as ServerSettingsModule from "../serverSettings.ts";

export interface ProviderSnapshotSettings<Settings> {
  readonly provider: Settings;
  readonly enableProviderUpdateChecks: boolean;
}

function makeProviderSnapshotSettings<Settings>(
  provider: Settings,
  settings: ServerSettings,
): ProviderSnapshotSettings<Settings> {
  return {
    provider,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
  };
}

export function haveProviderSnapshotSettingsChanged<Settings>(
  previous: ProviderSnapshotSettings<Settings>,
  next: ProviderSnapshotSettings<Settings>,
): boolean {
  return !Equal.equals(previous, next);
}

export function makeProviderSnapshotSettingsSource<Settings>(
  provider: Settings,
  serverSettings: ServerSettingsModule.ServerSettingsService["Service"],
): {
  readonly getSettings: Effect.Effect<ProviderSnapshotSettings<Settings>, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<ProviderSnapshotSettings<Settings>>;
} {
  const mapSettings = (settings: ServerSettings) =>
    makeProviderSnapshotSettings(provider, settings);
  return {
    getSettings: serverSettings.getSettings.pipe(Effect.map(mapSettings)),
    streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSettings)),
  };
}

/**
 * Fail-safe read of the user's standing agent instructions for provider
 * prompts. A settings read must never fail a session start or a turn, so a
 * failure logs a warning and yields "" (which builds no instructions block).
 */
export function makeAgentInstructionsReader(
  serverSettings: ServerSettingsModule.ServerSettingsService["Service"],
): Effect.Effect<string> {
  return serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.agentInstructions),
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to read agent instructions from server settings.", { cause }),
    ),
    Effect.orElseSucceed(() => ""),
  );
}
