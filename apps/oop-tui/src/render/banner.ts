import { sanitizeForTerminal } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { t } from "../i18n/index.ts";

/** Below this many columns the wordmark and its notes do not fit side by side. */
const WORDMARK_MIN_COLUMNS = 80;
const GAP = "   ";

/** Four rows of half blocks, drawn for this app: O, O, P. */
export const WORDMARK: ReadonlyArray<string> = [
  " ▄██▄   ▄██▄   ████▄ ",
  "██  ██ ██  ██  ██  ██",
  "██  ██ ██  ██  ████▀ ",
  " ▀██▀   ▀██▀   ██    ",
];

export interface BannerInput {
  readonly version: string;
  readonly cwd: string;
  readonly home: string | null;
  readonly columns: number;
  readonly theme: Theme;
  readonly symbols: Symbols;
  /** The one-line form even where the wordmark would fit; what stays in the scrollback after the home screen. */
  readonly compact?: boolean;
}

export const oneLine = (value: string): string =>
  sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

export const homeRelative = (path: string, home: string | null): string => {
  if (home === null || home === "") return path;
  if (path === home) return "~";
  const next = path.charAt(home.length);
  return path.startsWith(home) && (next === "/" || next === "\\")
    ? `~${path.slice(home.length)}`
    : path;
};

/**
 * What is printed once into the scrollback when the app opens: the wordmark in the logo gradient
 * with the version and folder beside it, or one line where there is no room for that. The
 * block letters become `#` on a terminal that was given ASCII symbols.
 */
export const renderBanner = (input: BannerInput): string[] => {
  const { theme, symbols } = input;
  const usable = Math.max(10, input.columns - 1);
  const version = oneLine(input.version);
  if (input.compact === true || input.columns < WORDMARK_MIN_COLUMNS) {
    return [
      truncateStyled(
        `${theme.brand.bold(`${symbols.brand} OOP`)} ${theme.muted(`v${version}`)}`,
        usable,
      ),
      "",
    ];
  }
  const notes: ReadonlyArray<string> = [
    "",
    `${theme.brand.bold(t("render.banner.title"))}  ${theme.muted(`v${version}`)}`,
    `${theme.dim(t("render.banner.folder"))}${homeRelative(oneLine(input.cwd), input.home)}`,
  ];
  const lines = WORDMARK.map((row, index) => {
    const art = symbols === ASCII_SYMBOLS ? row.replace(/[▄▀█]/gu, "#") : row;
    const note = notes[index] ?? "";
    return truncateStyled(`${theme.gradient(art)}${note === "" ? "" : GAP + note}`, usable);
  });
  return [...lines, ""];
};
