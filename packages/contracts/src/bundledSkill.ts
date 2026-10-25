import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Skills OOP ships and can install into a provider's own user skill folder on the environment's
 * host, where the provider CLI loads them and the `$` picker then lists them. Nothing here carries
 * a filesystem path: remote clients see only the skill and the target kind.
 *
 * claude: Claude Code's user skills (`<config dir>/skills`).
 * agents: the shared `~/.agents/skills` folder read by Codex and Cursor.
 */
export const BundledSkillTarget = Schema.Literals(["claude", "agents"]);
export type BundledSkillTarget = typeof BundledSkillTarget.Type;

/** different: a skill of that name is already there with other content; it is never replaced. */
export const BundledSkillInstallStatus = Schema.Literals([
  "not-installed",
  "installed",
  "different",
]);
export type BundledSkillInstallStatus = typeof BundledSkillInstallStatus.Type;

export const BundledSkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  targets: Schema.Array(
    Schema.Struct({ target: BundledSkillTarget, status: BundledSkillInstallStatus }),
  ),
});
export type BundledSkillEntry = typeof BundledSkillEntry.Type;

export const BundledSkillListResult = Schema.Struct({ skills: Schema.Array(BundledSkillEntry) });
export type BundledSkillListResult = typeof BundledSkillListResult.Type;

export const BundledSkillInstallInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  target: BundledSkillTarget,
});
export type BundledSkillInstallInput = typeof BundledSkillInstallInput.Type;

export class BundledSkillError extends Schema.TaggedError<BundledSkillError>()(
  "BundledSkillError",
  {
    reason: Schema.Literals(["unknown-skill", "conflict", "unsafe-target", "write-failed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-skill":
        return "OOP does not ship a skill with that name.";
      case "conflict":
        return "A different skill with that name is already installed; it was left unchanged.";
      case "unsafe-target":
        return "The skill folder is a link or not a folder, so nothing was written.";
      case "write-failed":
        return "The skill could not be written.";
    }
  }
}
