import type { CrewRoleModel } from "../app/crew.ts";
import { visibleWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { homeRelative, oneLine, WORDMARK } from "./banner.ts";
import { roleWord } from "./crewBoard.ts";
import {
  PET_MINI_TRACK_WIDTH,
  PET_TRACK_WIDTH,
  petMini,
  petRows,
  type PetLook,
  type PetState,
} from "./pet.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { t } from "../i18n/index.ts";

/** The full header needs this many columns and rows; below either it folds to one line. */
export const HEADER_FULL_MIN_COLUMNS = 40;
export const HEADER_FULL_MIN_ROWS = 30;
/** Rows of the full header: the wordmark, the thread line, the folder line and a rule. Mocha is five rows tall. */
export const HEADER_FULL_ROWS = 7;
const LOGO_WIDTH = 21;
const GAP = 2;
const NOTES_X = LOGO_WIDTH + GAP;
const MIN_NOTES = 14;

export type HeaderState = "idle" | "working" | "waiting" | "error" | "offline" | "none";

export interface HeaderInput {
  /** Cells of the conversation column, the one next to the divider included. */
  readonly columns: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly symbols: Symbols;
  readonly version: string;
  readonly cwd: string;
  readonly home: string | null;
  /** What is true now, read from the thread on screen. */
  readonly status: {
    readonly state: HeaderState;
    readonly model: string | null;
    readonly thread: string | null;
  };
  /** The crew's roles and the model each runs; null when the crew is off. */
  readonly crew: ReadonlyArray<CrewRoleModel> | null;
  /** Null with Mocha turned off. */
  readonly pet: {
    readonly state: PetState;
    readonly frame: number;
    readonly look: PetLook;
  } | null;
}

/**
 * The header in two parts per row: `lead` (logo and status, which change with the thread) and
 * `track` (the strip Mocha stands in, `trackWidth` cells at the right edge of the rows that have
 * one: five in the full header, the wordmark's four and the thread row; the rows under them have
 * none and run the full width). The region paints them separately, so a pet that moves rewrites its
 * strip and nothing else.
 */
export interface HeaderFrame {
  readonly lead: string[];
  readonly track: string[];
  readonly trackWidth: number;
  /** Set by the caller when the scrollback still lacks the banner line this header stands for. */
  readonly scrollback?: ReadonlyArray<string>;
}

const stateText = (input: HeaderInput): string => {
  const { theme, symbols } = input;
  const state = input.status.state;
  const word = t(`render.header.state.${state}`);
  const dot =
    state === "working"
      ? theme.brand(symbols.bullet)
      : state === "waiting"
        ? theme.warning(symbols.warning)
        : state === "error" || state === "offline"
          ? theme.error(symbols.cross)
          : theme.success(symbols.bullet);
  return `${dot} ${theme.text(word)}`;
};

const modelText = (input: HeaderInput): string =>
  input.status.model === null
    ? input.theme.dim(t("render.header.noModel"))
    : input.theme.muted(oneLine(input.status.model));

const threadText = (input: HeaderInput): string =>
  input.status.thread === null || input.status.thread === ""
    ? input.theme.dim(t("render.header.noThread"))
    : input.theme.dim(oneLine(input.status.thread));

/** Between the facts of a line; the middle dot is not ASCII. */
const dotOf = (symbols: Symbols): string => (symbols === ASCII_SYMBOLS ? "|" : "·");

/**
 * `Crew  worker DeepSeek V4.1 Flash · expert Sonnet 5.5 · auditor Opus 5.5`: each role with the
 * model it runs, or a letter for the role where the room is short. Empty with the crew off.
 */
const crewText = (input: HeaderInput, words: boolean): string => {
  const { theme, symbols } = input;
  if (input.crew === null) return "";
  const between = theme.dim(` ${dotOf(symbols)} `);
  const roles = input.crew.map(
    ({ role, model }) =>
      `${theme.muted(words ? roleWord(role) : roleWord(role).charAt(0))} ${
        model === null ? theme.dim("-") : theme.text(oneLine(model))
      }`,
  );
  return `${theme.dim(t("render.header.crew"))}${roles.join(between)}`;
};

/** Mocha's rows as the strip: a gap in front, and the last column free next to the divider. */
const place = (pet: string[], trackWidth: number): string[] =>
  pet.map((row) => {
    const width = visibleWidth(row);
    return " " + row + " ".repeat(Math.max(0, trackWidth - 1 - width));
  });

/** The least the folder is worth showing in: fewer cells than this and the crew has the row to itself. */
const FOLDER_MIN = 20;

/**
 * The folder line with the crew after it, on the row the full header has for facts. The crew's
 * models are what this row is for: the folder is cut short to make room for them, and left out of
 * the row (the status bar still names it) when even that does not leave it a useful width.
 */
const crewBeside = (input: HeaderInput, folder: string, wide: number): string => {
  const between = input.theme.dim(`  ${dotOf(input.symbols)}  `);
  const gap = visibleWidth(between);
  const words = crewText(input, true);
  if (visibleWidth(folder) + gap + visibleWidth(words) <= wide) {
    return `${folder}${between}${words}`;
  }
  const letters = crewText(input, false);
  const folderRoom = wide - gap - visibleWidth(letters);
  if (folderRoom < FOLDER_MIN) return truncateStyled(letters, wide);
  return `${truncateStyled(folder, folderRoom)}${between}${letters}`;
};

/**
 * Whether the full header fits, and how wide Mocha's strip is (0 when there is no room for her).
 * `mini` is her one-line form: the compact header always shows her so, and the full header falls
 * back to it on the first row where the strip beside the notes is too narrow for all five rows.
 */
export const headerTrack = (
  columns: number,
  rows: number,
  petOn: boolean,
): { readonly full: boolean; readonly width: number; readonly mini: boolean } => {
  const full = columns >= HEADER_FULL_MIN_COLUMNS && rows >= HEADER_FULL_MIN_ROWS;
  if (!petOn) return { full, width: 0, mini: !full };
  const avail = full ? columns - NOTES_X - MIN_NOTES : columns - 24;
  if (full && avail >= PET_TRACK_WIDTH) return { full, width: PET_TRACK_WIDTH, mini: false };
  return avail >= PET_MINI_TRACK_WIDTH
    ? { full, width: PET_MINI_TRACK_WIDTH, mini: true }
    : { full, width: 0, mini: true };
};

/** The full or the one-line header for this size. */
export const renderHeader = (input: HeaderInput): HeaderFrame => {
  const { theme, symbols } = input;
  const {
    full,
    width: trackWidth,
    mini: trackMini,
  } = headerTrack(input.columns, input.rows, input.pet !== null);
  const version = oneLine(input.version);
  if (!full) {
    const between = theme.dim(` ${dotOf(symbols)} `);
    const room = input.columns - trackWidth - 1;
    const facts = [
      `${theme.brand.bold(`${symbols.brand} OOP`)} ${theme.muted(`v${version}`)}`,
      stateText(input),
      modelText(input),
    ].join(between);
    // The crew comes before the thread's title, which is the first to be cut; where it would
    // have less than a few cells it is left out whole rather than shown as a stub.
    const crewRoom = room - visibleWidth(facts) - visibleWidth(between);
    const parts = [
      facts,
      ...(input.crew === null || crewRoom < 14
        ? []
        : [truncateStyled(crewText(input, false), crewRoom)]),
      threadText(input),
    ];
    const lead = truncateStyled(parts.join(between), room);
    if (trackWidth === 0 || input.pet === null) return { lead: [lead], track: [], trackWidth: 0 };
    const mini = petMini(input.pet.state, input.pet.frame, input.pet.look, theme, symbols);
    return { lead: [lead], track: place([mini], trackWidth), trackWidth };
  }

  // The wordmark rows and the thread row share the strip with the pet (all five rows, or just the
  // first with her one-line form); the rows under them run the full width.
  const leadWidth = input.columns - trackWidth - (trackWidth === 0 ? 1 : 0);
  const wide = input.columns - 1;
  const notesWidth = leadWidth - NOTES_X;
  const title = notesWidth >= 22 ? t("render.banner.title") : "OOP";
  const notes = [
    `${theme.brand.bold(title)} ${theme.muted(`v${version}`)}`,
    stateText(input),
    modelText(input),
    "",
  ];
  const lead = WORDMARK.map((row, index) => {
    const art = symbols === ASCII_SYMBOLS ? row.replace(/[▄▀█]/gu, "#") : row;
    return truncateStyled(
      `${theme.gradient(art)}${" ".repeat(GAP)}${notes[index] ?? ""}`,
      leadWidth,
    );
  });
  const folder = `${theme.dim(t("render.header.folder"))}${homeRelative(oneLine(input.cwd), input.home)}`;
  const threadRow = `${theme.dim(t("render.header.thread"))}${threadText(input)}`;
  lead.push(truncateStyled(threadRow, trackWidth > 0 && !trackMini ? leadWidth : wide));
  lead.push(input.crew === null ? truncateStyled(folder, wide) : crewBeside(input, folder, wide));
  lead.push(theme.border(symbols.rule.repeat(wide)));
  const { pet } = input;
  const track =
    trackWidth === 0 || pet === null
      ? []
      : place(
          trackMini
            ? [petMini(pet.state, pet.frame, pet.look, theme, symbols)]
            : petRows(pet.state, pet.frame, pet.look, theme, symbols),
          trackWidth,
        );
  return { lead, track, trackWidth };
};

/** Rows the header takes at this size, so the caller can reserve them without drawing. */
export const headerRows = (columns: number, rows: number): number =>
  columns >= HEADER_FULL_MIN_COLUMNS && rows >= HEADER_FULL_MIN_ROWS ? HEADER_FULL_ROWS : 1;
