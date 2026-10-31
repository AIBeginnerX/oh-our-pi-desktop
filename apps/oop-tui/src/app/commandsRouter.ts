import { SLASH_COMMANDS, type SlashCommand } from "./slashCommands.ts";

/** A line the composer runs as a command, read apart. */
export interface SlashInvocation {
  /** The command under its own name, whichever spelling was typed. */
  readonly command: SlashCommand;
  /** The words after the command. */
  readonly args: ReadonlyArray<string>;
  /** Everything after the command word, trimmed; a sentence for a command that takes text. */
  readonly rest: string;
}

/**
 * Reads `/name args` as one of our commands. A line that is not one is a message for the agent, and
 * so is one whose arguments the command does not take (`/q what does this do?`): null.
 */
export const parseSlash = (text: string): SlashInvocation | null => {
  if (!text.startsWith("/")) return null;
  const [word = "", ...args] = text.slice(1).trim().split(/\s+/u);
  const wanted = word.toLowerCase();
  const command = SLASH_COMMANDS.find(
    (candidate) => candidate.name === wanted || candidate.aliases.includes(wanted),
  );
  if (command === undefined) return null;
  if (args.length > 0 && command.takesArgument !== true) return null;
  if (args.length > 1 && command.freeText !== true) return null;
  return { command, args, rest: text.slice(1 + word.length).trim() };
};
