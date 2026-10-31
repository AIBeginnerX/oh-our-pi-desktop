import {
  LISTED_HIGHLIGHTS,
  terminalBehindText,
  terminalIsBehind,
  UPDATE_HOW_TO,
  type ReleaseView,
  type UpdateReport,
} from "../app/updateCheck.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";
import { renderBanner } from "./banner.ts";
import type { RegionFrame } from "./liveRegion.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";

/** Releases the home screen spells out; the rest are counted and left to `/update`. */
const HOME_RELEASES = 3;
/** Rows the notice must have before the big wordmark is allowed to take room from it. */
const NOTICE_NEED_ROWS = 3;
const INDENT = "  ";

/** The mark in front of a highlight; not the filled dot, which a list of choices uses for the chosen one. */
export const highlightMark = (symbols: Symbols): string => (symbols === ASCII_SYMBOLS ? "-" : "·");

export interface HomeInput {
  readonly columns: number;
  readonly theme: Theme;
  readonly symbols: Symbols;
  /** What the wordmark says beside it; null when the banner is turned off, which leaves the notice alone. */
  readonly banner: {
    readonly version: string;
    readonly server: string | null;
    readonly cwd: string;
    readonly home: string | null;
  } | null;
  /** The newest release compared with the app in use; null until the lookup answered, or when it failed. */
  readonly report: UpdateReport | null;
  /** The terminal app's own version, and the app's when it is known, for the reinstall line. */
  readonly versions: { readonly terminal: string; readonly app: string | null };
}

/** The part of the home screen that says whether and how to update. Empty when there is nothing to say. */
const updateBlock = (input: HomeInput, report: UpdateReport, room: number): string[] => {
  const { theme, symbols } = input;
  const usable = Math.max(10, input.columns - 1);
  if (report.status === "current") {
    return room < 1
      ? []
      : [`${theme.success(symbols.check)} ${theme.dim(`최신 버전입니다 (${report.current})`)}`];
  }
  const header = truncateStyled(
    `${theme.accent(symbols.brand)} ${theme.accent.bold("업데이트 있음")}${theme.dim(":")} ${theme.muted(report.current)} → ${theme.text.bold(report.latest)}`,
    usable,
  );
  const howTo = wrapStyled(theme.dim(UPDATE_HOW_TO), Math.max(8, usable - INDENT.length)).map(
    (row) => INDENT + row,
  );
  const releaseRows = (release: ReleaseView, highlights: number): string[] => [
    truncateStyled(
      `${INDENT}${theme.text.bold(release.version)}${release.date === "" ? "" : ` ${theme.dim(release.date)}`}`,
      usable,
    ),
    ...release.highlights
      .slice(0, highlights)
      .map((text) =>
        truncateStyled(`${INDENT}${INDENT}${theme.dim(highlightMark(symbols))} ${text}`, usable),
      ),
  ];
  const tail = (omitted: number, onlyThese: boolean): string =>
    `${INDENT}${theme.dim(onlyThese ? `릴리스 ${omitted}개 — /update` : `외 ${omitted}개 릴리스 — /update`)}`;
  const total = report.releases.length;
  const visible = Math.min(total, HOME_RELEASES);
  // From the fullest listing to the barest; the first that fits is shown.
  const candidates: Array<() => string[]> = [];
  for (let shown = visible; shown >= 1; shown -= 1) {
    for (const highlights of [LISTED_HIGHLIGHTS, 1]) {
      candidates.push(() => [
        header,
        ...howTo,
        ...report.releases.slice(0, shown).flatMap((release) => releaseRows(release, highlights)),
        ...(total > shown ? [tail(total - shown, false)] : []),
      ]);
    }
  }
  if (total > 0) candidates.push(() => [header, ...howTo, tail(total, true)]);
  candidates.push(
    () => [header, ...howTo],
    () => [header],
  );
  for (const candidate of candidates) {
    const rows = candidate();
    if (rows.length <= room) return rows;
  }
  return room >= 1 ? [header] : [];
};

/** The reinstall line, folded onto the room there is; empty unless the terminal app is the older one. */
const behindBlock = (input: HomeInput, room: number): string[] => {
  const { theme, symbols } = input;
  const { terminal, app } = input.versions;
  if (app === null || !terminalIsBehind(terminal, app)) return [];
  const usable = Math.max(10, input.columns - 1);
  const rows = wrapStyled(theme.warning(terminalBehindText(terminal, app)), usable - 2);
  return rows
    .slice(0, Math.max(0, room))
    .map((row, index) => (index === 0 ? `${theme.warning(symbols.warning)} ${row}` : `  ${row}`));
};

/** Everything under the wordmark that fits `room` rows: the update notice, then the reinstall line. */
const noticeRows = (input: HomeInput, room: number): string[] => {
  // The reinstall line is the shorter and the more specific, so the notice makes room for it.
  const behind = behindBlock(input, room);
  const update =
    input.report === null
      ? []
      : updateBlock(input, input.report, Math.max(0, room - behind.length));
  return [...update, ...behind];
};

/**
 * The top of the start screen, at most `budget` rows: the wordmark with the version, server and
 * folder, then the update notice. A short screen gives the notice its room first: the wordmark
 * shrinks to one line, then goes, before the notice is cut below three rows.
 */
export const fitHome = (input: HomeInput, budget: number): string[] => {
  const room = Math.max(0, budget);
  const need = Math.min(noticeRows(input, Number.POSITIVE_INFINITY).length, NOTICE_NEED_ROWS);
  const wordmark = (compact: boolean): string[] =>
    input.banner === null
      ? []
      : renderBanner({
          ...input.banner,
          columns: input.columns,
          theme: input.theme,
          symbols: input.symbols,
          compact,
        });
  const marks: ReadonlyArray<string[]> =
    input.banner === null ? [[]] : [wordmark(false), wordmark(true), []];
  for (const mark of marks) {
    if (room - mark.length >= need) return [...mark, ...noticeRows(input, room - mark.length)];
  }
  return noticeRows(input, room);
};

/** Rows `fitHome` would use with all the room it could ask for. */
export const homeNaturalRows = (input: HomeInput): number =>
  fitHome(input, Number.POSITIVE_INFINITY).length;

/**
 * The home above the frame of whatever is below it. Blank rows fill what the home leaves, so the
 * whole frame is `rows` tall and the bottom frame sits at the foot of the terminal. A bottom frame
 * that takes every row leaves no home at all.
 */
export const composeHome = (
  home: ReadonlyArray<string>,
  bottom: RegionFrame,
  rows: number,
): RegionFrame => {
  const room = Math.max(0, rows - bottom.lines.length);
  const top = home.slice(0, room);
  return {
    lines: [...top, ...Array.from({ length: room - top.length }, () => ""), ...bottom.lines],
    cursor:
      bottom.cursor === null ? null : { row: bottom.cursor.row + room, col: bottom.cursor.col },
  };
};
