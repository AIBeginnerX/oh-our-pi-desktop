import type { ServerProvider } from "@t3tools/contracts";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";

import { parseSlash } from "./commandsRouter.ts";
import { SLASH_COMMANDS } from "./slashCommands.ts";

const NAME_LIMIT = 40;

/** Names are compared lower-cased and without a leading slash. */
const normalize = (name: string): string => name.trim().replace(/^\//u, "").toLowerCase();

/** Our own commands, aliases included. */
const ownWords = (): string[] =>
  SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]);

/**
 * What the provider answers to under a slash: its commands and the skills a user may start, from
 * the provider's own list and from every workspace snapshot of it (which folder the thread runs
 * in does not matter here; naming a command of another folder is no reason to hold a message).
 */
export const providerWords = (provider: ServerProvider): string[] => {
  const lists = [provider, ...(provider.workspaceSnapshots ?? [])];
  // A list the server left out counts as empty: the message is then held, not the controller broken.
  return lists.flatMap((list) => [
    ...(list.slashCommands ?? []).map((command) => command.name),
    ...(list.skills ?? []).filter(isProviderSkillUserInvocable).map((skill) => skill.name),
  ]);
};

/** Edit distance between two short words. */
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
};

/** The known word nearest to `word` (a prefix of it, or a few edits away), or null. */
const nearest = (word: string, known: ReadonlyArray<string>): string | null => {
  let best: { name: string; score: number } | null = null;
  for (const name of known) {
    const wanted = normalize(name);
    if (wanted === "") continue;
    const edits = distance(word, wanted);
    const close = edits <= Math.max(1, Math.floor(word.length / 3));
    const prefix = word.length >= 2 && (wanted.startsWith(word) || word.startsWith(wanted));
    if (!close && !prefix) continue;
    const score = prefix && !close ? 1 : edits;
    if (best === null || score < best.score) best = { name: wanted, score };
  }
  return best === null ? null : best.name;
};

/** Top-level folders of a computer: `/tmp what is in here?` is a question about a path, not a command. */
const FOLDER_NAMES: ReadonlySet<string> = new Set([
  "applications",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "library",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "root",
  "sbin",
  "srv",
  "sys",
  "system",
  "tmp",
  "users",
  "usr",
  "var",
  "volumes",
]);

/**
 * `/plan <task>` is the provider's own command as well (Claude Code starts planning with it), so a
 * sentence after it is a message even though our `/plan` takes no argument.
 */
const TAKES_TEXT_FOR_PROVIDER: ReadonlySet<string> = new Set(["plan"]);

/** What a held message got wrong: a word nothing answers to, or arguments a command does not take. */
export interface HeldSlash {
  readonly kind: "unknown" | "arguments";
  readonly word: string;
  readonly nearest: string | null;
  /** For `arguments`: the command the word runs, which differs from `word` for an alias. */
  readonly command?: string;
}

/**
 * Why a message that starts with `/` is held back instead of reaching the agent (a mistyped
 * `/providers add ... apiKey=...` would leave its key in the thread); null when it may be sent.
 * Held: a word nothing answers to; arguments after one of our commands that takes none (`/p add zai
 * ...`); `/provider/add`, whose first piece is a command of ours. Sent: a path (`/Users/foo`, or a
 * folder name such as `/tmp`), a word the provider answers to, text typed with a space in front
 * (which is how a user sends it anyway). While the provider is not known (the connection is still
 * coming up) only a word that is a typo of a command of ours is held.
 */
export const unknownSlash = (typed: string, provider: ServerProvider | null): HeldSlash | null => {
  if (!typed.startsWith("/")) return null;
  const first = typed.split(/\s/u, 1)[0] ?? "";
  const word = first.slice(1);
  if (word === "") return null;
  const names = SLASH_COMMANDS.map((command) => command.name);
  if (/[\\/]/u.test(word)) {
    // A path, unless it is a command of ours with a slash where a space belongs.
    const head = (word.split(/[\\/]/u, 1)[0] ?? "").toLowerCase();
    if (head.length < 2 || !ownWords().some((name) => normalize(name) === head)) return null;
    return { kind: "unknown", word: word.slice(0, NAME_LIMIT), nearest: nearest(head, names) };
  }
  const wanted = word.toLowerCase();
  const own = SLASH_COMMANDS.find(
    (command) => command.name === wanted || command.aliases.includes(wanted),
  );
  const answeredByProvider =
    provider !== null && providerWords(provider).some((name) => normalize(name) === wanted);
  if (own !== undefined) {
    // A command that takes a word and got more of them is left to the agent; only one that takes
    // none is held, since a line like `/p add zai --set ...` was meant for a command, not for the agent.
    if (
      own.takesArgument === true ||
      parseSlash(typed) !== null ||
      answeredByProvider ||
      TAKES_TEXT_FOR_PROVIDER.has(own.name)
    ) {
      return null;
    }
    return { kind: "arguments", word: word.slice(0, NAME_LIMIT), nearest: null, command: own.name };
  }
  if (answeredByProvider || FOLDER_NAMES.has(wanted)) return null;
  if (provider === null) {
    // Without the provider's list only a typo of our own command is certain to be one.
    const close = nearest(wanted, names);
    return close === null
      ? null
      : { kind: "unknown", word: word.slice(0, NAME_LIMIT), nearest: close };
  }
  // Short aliases such as `/p` are no help as a suggestion, so only full names are offered.
  const offered = [...names, ...providerWords(provider)];
  return { kind: "unknown", word: word.slice(0, NAME_LIMIT), nearest: nearest(wanted, offered) };
};
