import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * OOP Crew: the thread's own model is the brain; it hands work to these roles through OoP's
 * crew tools, and the auditor reviews turns that changed files.
 */
export const CrewRole = Schema.Literals(["worker", "expert", "auditor"]);
export type CrewRole = typeof CrewRole.Type;

export const CREW_ROLES: ReadonlyArray<CrewRole> = ["worker", "expert", "auditor"];

/** How unpinned roles are filled from the models this environment has ready. */
export const CrewPreset = Schema.Literals(["recommended", "speed", "quality", "budget"]);
export type CrewPreset = typeof CrewPreset.Type;

/**
 * Roles the user chose by hand; a pinned role ignores the preset. In a thread override, null
 * means Auto for that role even when the defaults pin it.
 */
export const CrewPinnedRoles = Schema.Struct({
  worker: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  expert: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  auditor: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type CrewPinnedRoles = typeof CrewPinnedRoles.Type;

export const CrewThreadOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  preset: Schema.optionalKey(CrewPreset),
  pinned: Schema.optionalKey(CrewPinnedRoles),
});
export type CrewThreadOverride = typeof CrewThreadOverride.Type;

export const CrewSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  preset: CrewPreset.pipe(Schema.withDecodingDefault(Effect.succeed("recommended" as const))),
  pinned: CrewPinnedRoles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Per-thread changes layered over the defaults above. */
  threads: Schema.Record(ThreadId, CrewThreadOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type CrewSettings = typeof CrewSettings.Type;

export const DEFAULT_CREW_SETTINGS: CrewSettings = {
  enabled: false,
  preset: "recommended",
  pinned: {},
  threads: {},
};
