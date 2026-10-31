import { padEndVisible, truncateStyled, wrapStyled } from "../text/wrap.ts";
import { visibleWidth } from "../text/width.ts";
import type { Style } from "./style.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";

/** What a rail needs to draw itself. */
export interface Rail {
  readonly style: Style;
  readonly symbols: Symbols;
}

/** Waiting on someone is `active`; `warning` is a decision with consequences; `idle` is history. */
export type RailTone = "active" | "warning" | "error" | "idle";

/** Columns the rail takes in front of its content. */
export const RAIL_COLUMNS = 3;

const paintRail = ({ style }: Rail, tone: RailTone, text: string): string => {
  const { theme } = style;
  if (tone === "active") return theme.accent(text);
  if (tone === "warning") return theme.warning(text);
  if (tone === "error") return theme.error(text);
  return theme.dim(text);
};

/** A rail row with no content: the gap between two steps. */
export const railGap = (rail: Rail, tone: RailTone = "idle"): string =>
  paintRail(rail, tone, rail.symbols.rail.bar);

/** A row of content inside a step. */
export const railRow = (rail: Rail, text: string, tone: RailTone = "idle"): string =>
  text === "" ? railGap(rail, tone) : `${paintRail(rail, tone, rail.symbols.rail.bar)}  ${text}`;

/**
 * A horizontal line across the room beside the rail, `width` counting the rail: the top and bottom
 * edge of the box the user types in. It takes the colour of the rail's tone, and of the theme's
 * quiet brand colour while the prompt is waiting, so it shows on a dark and a light theme alike.
 */
export const railRule = (rail: Rail, width: number, tone: RailTone = "idle"): string => {
  const { theme } = rail.style;
  const line = rail.symbols.rule.repeat(Math.max(1, width - RAIL_COLUMNS));
  const paint =
    tone === "warning" ? theme.warning : tone === "error" ? theme.error : theme.brandDim;
  return `${paintRail(rail, tone, rail.symbols.rail.bar)}  ${paint(line)}`;
};

/** `text` folded to the room beside the rail, one rail row per line. `width` counts the rail. */
export const railWrap = (
  rail: Rail,
  text: string,
  width: number,
  tone: RailTone = "idle",
): string[] =>
  wrapStyled(text, Math.max(1, width - RAIL_COLUMNS)).map((row) => railRow(rail, row, tone));

/**
 * A hint of `•`-separated keys folded to `room` columns without cutting a key in two: a new row
 * starts at a separator, so no row begins with one.
 */
export const packHint = (hint: string, room: number): string[] => {
  const rows: string[] = [];
  let row = "";
  for (const part of hint.split(" • ")) {
    const joined = row === "" ? part : `${row} • ${part}`;
    if (row !== "" && visibleWidth(joined) > room) {
      rows.push(row);
      row = part;
    } else {
      row = joined;
    }
  }
  rows.push(row);
  return rows.flatMap((text) => wrapStyled(text, Math.max(1, room)));
};

/** A finished step, which stays in the scrollback. */
export const railDone = (rail: Rail, text: string): string =>
  `${rail.style.theme.success(rail.symbols.rail.done)}  ${text}`;

/** The step that is waiting for an answer. */
export const railActive = (rail: Rail, text: string, tone: RailTone = "active"): string =>
  `${paintRail(rail, tone, rail.symbols.rail.active)}  ${text}`;

/** A step that was stopped before it finished. */
export const railCancelled = (rail: Rail, text: string): string =>
  `${rail.style.theme.error(rail.symbols.rail.cancel)}  ${text}`;

/** The last row of a rail. */
export const railEnd = (rail: Rail, text = "", tone: RailTone = "idle"): string =>
  text === ""
    ? paintRail(rail, tone, rail.symbols.rail.end)
    : `${paintRail(rail, tone, rail.symbols.rail.end)}  ${text}`;

/**
 * The first row of a rail: the name on a filled chip, then what this rail is about. Without colour,
 * and on the ASCII preset, a filled chip cannot be drawn or is not wanted, so the name stands alone.
 */
export const railStart = (rail: Rail, name: string, subtitle = ""): string => {
  const { style, symbols } = rail;
  const chip =
    style.enabled && symbols !== ASCII_SYMBOLS
      ? style.inverse(style.theme.brand.bold(` ${name} `))
      : name;
  const lead = `${style.theme.dim(symbols.rail.start)}  ${chip}`;
  return subtitle === "" ? lead : `${lead}  ${style.theme.dim(subtitle)}`;
};

/**
 * `railStart` for a subtitle that may be longer than the line: what does not fit beside the name is
 * folded onto rail rows under it, so no part of it lands in the first column. `width` counts the rail.
 */
export const railStartRows = (
  rail: Rail,
  name: string,
  subtitle: string,
  width: number,
): string[] => {
  const lead = railStart(rail, name);
  if (subtitle === "") return [lead];
  // The text is folded as if every row began under the rail; the first row is padded out to where
  // it really starts, beside the name, and the padding is taken off again.
  const pad = Math.max(0, visibleWidth(lead) + 2 - RAIL_COLUMNS);
  const rows = wrapStyled(
    `${" ".repeat(pad)}${rail.style.theme.dim(subtitle)}`,
    Math.max(pad + 1, width - RAIL_COLUMNS),
  );
  const head = (rows[0] ?? "").slice(pad);
  return [
    head === "" ? lead : `${lead}  ${head}`,
    ...rows.slice(1).map((row) => railRow(rail, row)),
  ];
};

/** The room a note leaves around its box: `◇  ` before it and `│` after it, plus the padding. */
const NOTE_FRAME_COLUMNS = 4;

/**
 * A boxed note hanging off the rail: the title row joins the box to the rail, and so does its last
 * row. `body` rows are already styled; the box is as wide as the widest of them, up to `width`, and
 * every row of it, corners included, ends in the same column.
 */
export const railNote = (
  rail: Rail,
  title: string,
  body: ReadonlyArray<string>,
  width: number,
  tone: RailTone = "idle",
): string[] => {
  const { symbols } = rail;
  const widest = Math.max(visibleWidth(title), ...body.map((row) => visibleWidth(row)));
  // `len` is the width of the box between the rail and the right edge, padding included.
  const len = Math.max(6, Math.min(width - NOTE_FRAME_COLUMNS, widest + 2));
  const cut = truncateStyled(title, len - 3);
  const horizontal = symbols.box.horizontal;
  const side = paintRail(rail, tone, symbols.rail.bar);
  const row = (text: string): string =>
    `${side}  ${padEndVisible(truncateStyled(text, len - 2), len - 2)}  ${side}`;
  return [
    `${rail.style.theme.success(symbols.rail.done)}  ${cut} ${paintRail(
      rail,
      tone,
      `${horizontal.repeat(Math.max(1, len - visibleWidth(cut) - 1))}${symbols.box.topRight}`,
    )}`,
    row(""),
    ...body.map(row),
    row(""),
    paintRail(
      rail,
      tone,
      `${symbols.rail.tee}${horizontal.repeat(len + 2)}${symbols.box.bottomRight}`,
    ),
  ];
};

export interface RailOption {
  /** Plain text: the row paints it itself, so a chosen label and a dim one differ. */
  readonly label: string;
  /** Dim text after the label, cut first when the row is too narrow. */
  readonly note?: string;
  /** Said in the error colour on its own row under the option. */
  readonly warning?: string;
}

export interface RailChoice {
  readonly question: string;
  /** Rows of content between the question and the options, already styled. */
  readonly before?: ReadonlyArray<string>;
  readonly options: ReadonlyArray<RailOption>;
  /** The option that is filled; null while nothing is picked. */
  readonly selected: number | null;
  readonly hint: string;
  readonly width: number;
  readonly tone?: RailTone;
  /** Options that did not fit and are left out above and below the ones shown. */
  readonly hidden?: { readonly above: number; readonly below: number };
}

/**
 * A single-choice question without its closing row, for a step that goes on below it: the selected
 * row is filled, the others are dim, and the hint is folded to the width.
 */
export const railChoice = (rail: Rail, choice: RailChoice): string[] => {
  const { style, symbols } = rail;
  const { theme } = style;
  const tone = choice.tone ?? "active";
  const lines = [
    railActive(rail, truncateStyled(choice.question, choice.width - RAIL_COLUMNS), tone),
    ...(choice.before ?? []).map((row) =>
      railRow(rail, truncateStyled(row, choice.width - RAIL_COLUMNS), tone),
    ),
  ];
  const more = (count: number, direction: string) =>
    railRow(rail, theme.dim(`… ${direction} ${count}개`), tone);
  if (choice.hidden !== undefined && choice.hidden.above > 0) {
    lines.push(more(choice.hidden.above, "위로"));
  }
  for (const [index, option] of choice.options.entries()) {
    const chosen = index === choice.selected;
    const mark = chosen ? theme.success(symbols.rail.radioOn) : theme.dim(symbols.rail.radioOff);
    const lead = visibleWidth(mark) + 1;
    const room = Math.max(4, choice.width - RAIL_COLUMNS - lead);
    const label = truncateStyled(option.label, room);
    const left = room - visibleWidth(label) - 2;
    const note =
      option.note !== undefined && left >= 8
        ? `  ${theme.dim(truncateStyled(option.note, left))}`
        : "";
    lines.push(railRow(rail, `${mark} ${chosen ? label : theme.dim(label)}${note}`, tone));
    if (option.warning !== undefined) {
      lines.push(
        railRow(
          rail,
          `${" ".repeat(lead)}${theme.error(truncateStyled(option.warning, room))}`,
          tone,
        ),
      );
    }
  }
  if (choice.hidden !== undefined && choice.hidden.below > 0) {
    lines.push(more(choice.hidden.below, "아래로"));
  }
  for (const row of packHint(choice.hint, choice.width - RAIL_COLUMNS)) {
    lines.push(railRow(rail, theme.dim(row), tone));
  }
  return lines;
};

/** A single-choice question that closes the rail: `railChoice` with an end row under it. */
export const railSelect = (
  rail: Rail,
  question: string,
  options: ReadonlyArray<RailOption>,
  selected: number,
  hint: string,
  width: number,
  tone: RailTone = "active",
  hidden?: RailChoice["hidden"],
): string[] => [
  ...railChoice(rail, {
    question,
    options,
    selected,
    hint,
    width,
    tone,
    ...(hidden === undefined ? {} : { hidden }),
  }),
  railEnd(rail, "", tone),
];
