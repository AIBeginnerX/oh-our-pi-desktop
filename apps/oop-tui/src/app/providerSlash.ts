import type { ServerProvider } from "@t3tools/contracts";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";

import { SLASH_COMMANDS } from "./slashCommands.ts";

/** A command or skill the provider offers under `/`, as the menu lists it. */
export interface ProviderSlashEntry {
  readonly kind: "command" | "skill";
  /** What the menu shows: `/name`, or `/skill:name` for a skill (as the desktop app labels it). */
  readonly label: string;
  readonly name: string;
  readonly note: string;
  /** What picking it puts in the composer, with the space the argument follows. */
  readonly fill: string;
}

const builtinWords = new Set(
  SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
);

const flat = (value: string | undefined): string => (value ?? "").replace(/\s+/gu, " ").trim();

/**
 * The provider's commands and the skills a user may start, for the folder the conversation runs in,
 * the way the desktop composer lists them: a command a visible skill has the name of is left out, a
 * skill name appears once, and picking a skill writes `$name`. A command that shares its name with
 * one of ours is dropped: ours runs.
 */
export const providerSlashEntries = (
  provider: ServerProvider | null,
  cwd: string | null,
): ReadonlyArray<ProviderSlashEntry> => {
  if (provider === null || !provider.enabled) return [];
  // A list the server left out counts as empty, as in `providerWords`.
  const skills = getProviderSkillsForSlashMenu(
    resolveProviderSkillsForCwd(provider, cwd) ?? [],
    true,
  );
  const commands = getProviderSlashCommandsForSlashMenu(
    resolveProviderSlashCommandsForCwd(provider, cwd) ?? [],
    skills,
  ).filter((command) => !builtinWords.has(command.name.trim().toLowerCase()));
  return [
    ...commands.map((command): ProviderSlashEntry => ({
      kind: "command",
      label: `/${command.name}`,
      name: command.name,
      note: flat(command.description ?? command.input?.hint),
      fill: `/${command.name} `,
    })),
    ...skills.map((skill): ProviderSlashEntry => ({
      kind: "skill",
      label: `/skill:${skill.name}`,
      name: skill.name,
      note: flat(skill.shortDescription ?? skill.description ?? skill.scope),
      fill: `$${skill.name} `,
    })),
  ];
};

/** Entries whose name begins with the query, then those with it inside the name, then inside the note. */
export const matchProviderEntries = (
  entries: ReadonlyArray<ProviderSlashEntry>,
  query: string,
): ReadonlyArray<ProviderSlashEntry> => {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return entries;
  const bandOf = (entry: ProviderSlashEntry): number => {
    const name = entry.name.toLowerCase();
    if (entry.label.toLowerCase().startsWith(`/${wanted}`) || name.startsWith(wanted)) return 0;
    if (name.includes(wanted) || entry.label.toLowerCase().includes(wanted)) return 1;
    return entry.note.toLowerCase().includes(wanted) ? 2 : 3;
  };
  return entries
    .map((entry, index) => ({ entry, index, band: bandOf(entry) }))
    .filter((item) => item.band < 3)
    .toSorted((left, right) => left.band - right.band || left.index - right.index)
    .map((item) => item.entry);
};
