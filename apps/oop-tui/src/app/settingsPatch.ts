import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

import { CommandRejectedError } from "../link/transport.ts";
import { sanitizeForTerminal } from "../text/width.ts";

/** The part of the link that reads and writes the server's settings. */
export interface SettingsLink {
  readonly getSettings: () => Promise<ServerSettings>;
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
}

export type PatchResult =
  | {
      readonly ok: true;
      /** The settings as they were just before the patch; what a message about the change may quote. */
      readonly before: ServerSettings;
      readonly after: ServerSettings;
      /** False when the builder had nothing to change and nothing was sent. */
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      /** The server read the patch and refused it, as opposed to a request that may not have arrived. */
      readonly rejected: boolean;
      /** One line, safe to print. */
      readonly message: string;
    };

/** Makes the patch from the newest settings; null means there is nothing to change. */
export type PatchBuilder = (current: ServerSettings) => ServerSettingsPatch | null;

const failure = (cause: unknown): PatchResult => ({
  ok: false,
  rejected: cause instanceof CommandRejectedError,
  message:
    sanitizeForTerminal(cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ??
    "",
});

/**
 * Settings patches that replace a whole record (`threadGoals`, `crew`, `providerInstances`) must be
 * built from the newest value, or they undo a change made a moment ago elsewhere. Each patch reads
 * the settings first and is built from what was read; patches run one at a time, so two quick ones
 * from this app cannot overwrite each other either. It never throws: a failure is the result.
 */
export const createSettingsPatcher = (link: SettingsLink) => {
  let tail: Promise<unknown> = Promise.resolve();
  const attempt = async (build: PatchBuilder): Promise<PatchResult> => {
    try {
      const before = await link.getSettings();
      const patch = build(before);
      if (patch === null) return { ok: true, before, after: before, changed: false };
      return { ok: true, before, after: await link.updateSettings(patch), changed: true };
    } catch (cause) {
      return failure(cause);
    }
  };
  return (build: PatchBuilder): Promise<PatchResult> => {
    const run = tail.then(() => attempt(build));
    tail = run;
    return run;
  };
};
