import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";
import { t } from "../i18n/index.ts";

/** A command the composer runs itself, instead of sending it to the agent. */
export interface SlashCommand {
  readonly name: string;
  /** What the menu says it does. */
  readonly note: string;
  /** Other spellings that run the same command. */
  readonly aliases: ReadonlyArray<string>;
  /** Tab leaves a space after it, since the command is usually given a word. */
  readonly takesArgument?: true;
  /** The argument is a sentence, not one word (`/goal <text>`). */
  readonly freeText?: true;
  /** How `/help` writes the argument, such as `[value]`. */
  readonly usage?: string;
}

/** In the order the menu lists them when nothing narrows them down. */
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    name: "model",
    get note() {
      return t("session.slash.model.note");
    },
    aliases: ["models"],
  },
  {
    name: "mode",
    get note() {
      return t("session.slash.mode.note");
    },
    aliases: [],
    takesArgument: true,
    // The labels in the help have spaces in them (`/mode Full access`).
    freeText: true,
    get usage() {
      return t("session.slash.mode.usage");
    },
  },
  {
    name: "effort",
    get note() {
      return t("session.slash.effort.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.effort.usage");
    },
  },
  {
    name: "plan",
    get note() {
      return t("session.slash.plan.note");
    },
    aliases: [],
  },
  {
    name: "default",
    get note() {
      return t("session.slash.default.note");
    },
    aliases: [],
  },
  {
    name: "implement",
    get note() {
      return t("session.slash.implement.note");
    },
    aliases: [],
  },
  {
    name: "goal",
    get note() {
      return t("session.slash.goal.note");
    },
    aliases: [],
    takesArgument: true,
    freeText: true,
    get usage() {
      return t("session.slash.goal.usage");
    },
  },
  {
    name: "crew",
    get note() {
      return t("session.slash.crew.note");
    },
    aliases: [],
    takesArgument: true,
    freeText: true,
    get usage() {
      return t("session.slash.crew.usage");
    },
  },
  {
    name: "provider",
    get note() {
      return t("session.slash.provider.note");
    },
    aliases: [],
    takesArgument: true,
    freeText: true,
    get usage() {
      return t("session.slash.provider.usage");
    },
  },
  {
    name: "dag-workflow",
    get note() {
      return t("session.slash.dag-workflow.note");
    },
    aliases: ["workflow"],
    takesArgument: true,
    get usage() {
      return t("session.slash.dag-workflow.usage");
    },
  },
  {
    name: "dag-agents",
    get note() {
      return t("session.slash.dag-agents.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.dag-agents.usage");
    },
  },
  {
    name: "new",
    get note() {
      return t("session.slash.new.note");
    },
    aliases: [],
  },
  {
    name: "threads",
    get note() {
      return t("session.slash.threads.note");
    },
    aliases: ["t"],
  },
  {
    name: "projects",
    get note() {
      return t("session.slash.projects.note");
    },
    aliases: ["p"],
  },
  {
    name: "stats",
    get note() {
      return t("session.slash.stats.note");
    },
    aliases: [],
  },
  {
    name: "tasks",
    get note() {
      return t("session.slash.tasks.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.tasks.usage");
    },
  },
  {
    name: "sidebar",
    get note() {
      return t("session.slash.sidebar.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.sidebar.usage");
    },
  },
  {
    name: "mouse",
    get note() {
      return t("session.slash.mouse.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.mouse.usage");
    },
  },
  {
    name: "pet",
    get note() {
      return t("session.slash.pet.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.pet.usage");
    },
  },
  {
    name: "history",
    get note() {
      return t("session.slash.history.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.history.usage");
    },
  },
  {
    name: "diff",
    get note() {
      return t("session.slash.diff.note");
    },
    aliases: [],
    takesArgument: true,
    // A file name may have spaces in it.
    freeText: true,
    get usage() {
      return t("session.slash.diff.usage");
    },
  },
  {
    name: "undo",
    get note() {
      return t("session.slash.undo.note");
    },
    aliases: [],
  },
  {
    name: "theme",
    get note() {
      return t("session.slash.theme.note");
    },
    aliases: [],
    takesArgument: true,
    get usage() {
      return t("session.slash.theme.usage");
    },
  },
  {
    name: "update",
    get note() {
      return t("session.slash.update.note");
    },
    aliases: [],
  },
  {
    name: "help",
    get note() {
      return t("session.slash.help.note");
    },
    aliases: ["?"],
  },
  {
    name: "exit",
    get note() {
      return t("session.slash.exit.note");
    },
    aliases: ["quit", "q"],
  },
];

/**
 * The word after the slash while the text is still one word, which is when the menu is open;
 * null for anything else, since a space ends the command and what follows is its argument.
 */
export const slashQuery = (text: string): string | null =>
  text.startsWith("/") && !/\s/u.test(text) ? text.slice(1).toLowerCase() : null;

/** Rank bands, best first: the name, an alias, a word of the description. Equal bands keep the menu's order. */
const BAND = 1000;

const bandOf = (command: SlashCommand, query: string): number | null => {
  const match = (value: string, exact: number, prefix: number, includes?: number): number | null =>
    scoreQueryMatch({
      value: normalizeSearchQuery(value),
      query,
      exactBase: exact * BAND,
      prefixBase: prefix * BAND,
      ...(includes === undefined ? {} : { includesBase: includes * BAND }),
    });
  const bands = [
    match(command.name, 0, 1),
    ...command.aliases.map((alias) => match(alias, 2, 3)),
    match(command.note, 4, 4, 4),
  ]
    .filter((score): score is number => score !== null)
    .map((score) => Math.floor(score / BAND));
  return bands.length === 0 ? null : Math.min(...bands);
};

/**
 * The commands whose name or an alias begins with what has been typed, then those whose description
 * contains it. Equal matches keep the order of the menu.
 */
export const matchSlashCommands = (query: string): ReadonlyArray<SlashCommand> => {
  const wanted = normalizeSearchQuery(query);
  if (wanted === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.map((command, index) => ({ command, index, band: bandOf(command, wanted) }))
    .filter(
      (entry): entry is { command: SlashCommand; index: number; band: number } =>
        entry.band !== null,
    )
    .toSorted((left, right) => left.band - right.band || left.index - right.index)
    .map((entry) => entry.command);
};
