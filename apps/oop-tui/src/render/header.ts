import { truncateStyled } from "../text/wrap.ts";
import { homeRelative, oneLine, WORDMARK } from "./banner.ts";
import { PET_MINI_WIDTH, PET_WIDTH, petMini, petRows, type PetPose, type PetState } from "./pet.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { t } from "../i18n/index.ts";

/** The full header needs this many columns and rows; below either it folds to one line. */
export const HEADER_FULL_MIN_COLUMNS = 40;
export const HEADER_FULL_MIN_ROWS = 30;
/** Rows of the full header: the wordmark, the thread line, the folder line and a rule. */
export const HEADER_FULL_ROWS = 7;
const LOGO_WIDTH = 21;
const GAP = 2;
const NOTES_X = LOGO_WIDTH + GAP;
const MIN_NOTES = 14;
/** Cells the pet may walk beyond its own width. */
const MAX_TRAVEL = 16;

export type HeaderState = "idle" | "working" | "waiting" | "error" | "offline" | "none";

export interface HeaderInput {
  /** Cells of the conversation column, the one next to the divider included. */
  readonly columns: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly symbols: Symbols;
  readonly version: string;
  readonly server: string | null;
  readonly cwd: string;
  readonly home: string | null;
  /** What is true now, read from the thread on screen. */
  readonly status: {
    readonly state: HeaderState;
    readonly model: string | null;
    readonly thread: string | null;
  };
  /** Null with the pet turned off. */
  readonly pet: {
    readonly state: PetState;
    readonly frame: number;
    readonly pose: PetPose;
  } | null;
}

/**
 * The header in two parts per row: `lead` (logo and status, which change with the thread) and
 * `track` (the strip the pet walks in, `trackWidth` cells at the right edge of the rows that have
 * one; the rows under the wordmark have none and run the full width). The region paints them
 * separately, so a pet that moves rewrites its strip and nothing else.
 */
export interface HeaderFrame {
  readonly lead: string[];
  readonly track: string[];
  readonly trackWidth: number;
  /** Set by the caller when the scrollback still lacks the banner line this header stands for. */
  readonly scrollback?: ReadonlyArray<string>;
}

/** Cells the pet may walk beyond its own width in a track. */
export const travelOf = (trackWidth: number, mini: boolean): number =>
  Math.max(0, trackWidth - 1 - (mini ? PET_MINI_WIDTH : PET_WIDTH));

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

const place = (pet: string[], pose: PetPose, trackWidth: number, width: number): string[] => {
  const x = Math.min(pose.x, Math.max(0, trackWidth - 1 - width));
  return pet.map((row) => " ".repeat(x) + row + " ".repeat(Math.max(0, trackWidth - x - width)));
};

/** Whether the full header fits, and how wide the pet's strip is (0 when there is no room for it). */
export const headerTrack = (
  columns: number,
  rows: number,
  petOn: boolean,
): { readonly full: boolean; readonly width: number } => {
  const full = columns >= HEADER_FULL_MIN_COLUMNS && rows >= HEADER_FULL_MIN_ROWS;
  if (!petOn) return { full, width: 0 };
  if (!full) {
    const avail = columns - 24;
    return { full, width: avail >= PET_MINI_WIDTH + 2 ? Math.min(avail, PET_MINI_WIDTH + 7) : 0 };
  }
  const avail = columns - NOTES_X - MIN_NOTES;
  return { full, width: avail >= PET_WIDTH + 1 ? Math.min(avail, PET_WIDTH + 1 + MAX_TRAVEL) : 0 };
};

/** The full or the one-line header for this size. */
export const renderHeader = (input: HeaderInput): HeaderFrame => {
  const { theme, symbols } = input;
  const { full, width: trackWidth } = headerTrack(input.columns, input.rows, input.pet !== null);
  const version = oneLine(input.version);
  if (!full) {
    const parts = [
      `${theme.brand.bold(`${symbols.brand} OOP`)} ${theme.muted(`v${version}`)}`,
      stateText(input),
      modelText(input),
      threadText(input),
    ];
    const lead = truncateStyled(
      parts.join(theme.dim(` ${dotOf(symbols)} `)),
      input.columns - trackWidth - 1,
    );
    if (trackWidth === 0 || input.pet === null) return { lead: [lead], track: [], trackWidth: 0 };
    const mini = petMini(input.pet.state, input.pet.frame, theme);
    return {
      lead: [lead],
      track: place([mini], input.pet.pose, trackWidth, PET_MINI_WIDTH),
      trackWidth,
    };
  }

  // The wordmark rows share the strip with the pet; the rows under them run the full width.
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
  const where = [
    `${theme.dim(t("render.header.folder"))}${homeRelative(oneLine(input.cwd), input.home)}`,
    ...(input.server === null
      ? []
      : [`${theme.dim(t("render.header.server"))}${oneLine(input.server)}`]),
  ];
  lead.push(truncateStyled(`${theme.dim(t("render.header.thread"))}${threadText(input)}`, wide));
  lead.push(truncateStyled(where.join(theme.dim(`  ${dotOf(symbols)}  `)), wide));
  lead.push(theme.border(symbols.rule.repeat(wide)));
  const track =
    trackWidth === 0 || input.pet === null
      ? []
      : place(
          petRows(input.pet.state, input.pet.frame, input.pet.pose.dir, theme, symbols),
          input.pet.pose,
          trackWidth,
          PET_WIDTH,
        );
  return { lead, track, trackWidth };
};

/** Rows the header takes at this size, so the caller can reserve them without drawing. */
export const headerRows = (columns: number, rows: number): number =>
  columns >= HEADER_FULL_MIN_COLUMNS && rows >= HEADER_FULL_MIN_ROWS ? HEADER_FULL_ROWS : 1;
