import { RAIL_COLUMNS } from "../render/rail.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { graphemeWidth, graphemesOf, stripAnsi, visibleWidth } from "../text/width.ts";

/**
 * Selecting text of the conversation with the mouse. Everything here is about cells: a row of the
 * conversation is a styled string, a column is a terminal cell, and a Korean syllable takes two of
 * them. Nothing here knows about the screen; `SplitRegion` owns the geometry and calls these.
 */

/** What the controller can do with a mouse drag over the conversation; `x` and `y` count from 1. */
export interface SelectionControl {
  readonly selectStart: (x: number, y: number) => void;
  readonly selectMove: (x: number, y: number) => void;
  /** Ends the drag; returns the text to copy, or null for a click (or an empty selection). */
  readonly selectEnd: (x: number, y: number) => string | null;
  readonly selectClear: () => void;
  /** Whether a selection is shown or a drag is under way. */
  readonly selecting: () => boolean;
}

const ANSI_TOKEN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/uy;
// eslint-disable-next-line no-control-regex
const RESETS_ALL = /^\u001b\[0?m$/u;

type Piece =
  | { readonly kind: "ansi"; readonly text: string }
  | {
      readonly kind: "glyph";
      readonly text: string;
      /** First column of the glyph, and the column after its last. A zero-width mark has start === end. */
      readonly start: number;
      readonly end: number;
    };

const pieces = (styled: string): Piece[] => {
  const out: Piece[] = [];
  let column = 0;
  let plain = "";
  const flush = () => {
    if (plain === "") return;
    for (const glyph of graphemesOf(plain)) {
      const width = graphemeWidth(glyph);
      out.push({ kind: "glyph", text: glyph, start: column, end: column + width });
      column += width;
    }
    plain = "";
  };
  let index = 0;
  while (index < styled.length) {
    if (styled.charCodeAt(index) === 0x1b) {
      ANSI_TOKEN.lastIndex = index;
      const match = ANSI_TOKEN.exec(styled);
      if (match !== null) {
        flush();
        out.push({ kind: "ansi", text: match[0] });
        index += match[0].length;
        continue;
      }
    }
    plain += styled[index];
    index += 1;
  }
  flush();
  return out;
};

/** A glyph is in `[from, to)` when any column of it is; a zero-width mark goes with the glyph before it. */
const inside = (piece: Extract<Piece, { kind: "glyph" }>, from: number, to: number): boolean =>
  piece.end > piece.start
    ? piece.start < to && piece.end > from
    : piece.start > from && piece.start <= to;

/** The plain text of the cells `[from, to)` of a styled row; a wide glyph is whole if any half of it is in. */
export const cellText = (styled: string, from: number, to: number): string => {
  let text = "";
  for (const piece of pieces(styled)) {
    if (piece.kind === "glyph" && inside(piece, from, to)) text += piece.text;
  }
  return text;
};

const REVERSE_ON = "\u001b[7m";
const REVERSE_OFF = "\u001b[27m";

/**
 * `styled` with the cells `[from, to)` in reverse video, every other style kept. A reset inside the
 * range would end the reverse, so it is followed by the reverse again. Cells past the end of the
 * text are not drawn on, so a row is highlighted as far as it has text.
 */
export const highlightCells = (styled: string, from: number, to: number): string => {
  let out = "";
  let on = false;
  for (const piece of pieces(styled)) {
    if (piece.kind === "ansi") {
      out += piece.text;
      if (on && RESETS_ALL.test(piece.text)) out += REVERSE_ON;
      continue;
    }
    const selected = inside(piece, from, to);
    if (selected && !on) out += REVERSE_ON;
    if (!selected && on) out += REVERSE_OFF;
    on = selected;
    out += piece.text;
  }
  return on ? out + REVERSE_OFF : out;
};

// ---- text -------------------------------------------------------------------------------------

const escapeForRegExp = (glyph: string): string => glyph.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const RAIL_GLYPHS = [
  ...new Set(
    [UNICODE_SYMBOLS.rail, ASCII_SYMBOLS.rail].flatMap(
      ({ start, bar, end, tee, done, active, cancel }) => [
        start,
        bar,
        end,
        tee,
        done,
        active,
        cancel,
      ],
    ),
  ),
];
/** The mark that leads a row on the rail, in either symbol preset, with the two columns after it. */
const RAIL_PREFIX = new RegExp(`^(?:${RAIL_GLYPHS.map(escapeForRegExp).join("|")})(?: {2}|$)`, "u");

/** One row of a selection: the row as drawn, and the columns of it that are selected. */
export interface SelectedRow {
  readonly styled: string;
  /** Rows with the same `line` came from one logical line, folded to the width on screen. */
  readonly line: unknown;
  readonly from: number;
  /** One past the last column; `Infinity` for the rest of the row. */
  readonly to: number;
  /** The fold dropped a space after this row, so joined with the next row of its line it needs one back. */
  readonly spaceAfter: boolean;
}

interface Line {
  text: string;
  /** The row led with the rail's mark (removed) or started at the first column of a row with none. */
  railed: boolean;
  /** Whether the row was taken from its first column, so its indent is the message's and not the user's pick. */
  whole: boolean;
}

// ---- the user's box ----------------------------------------------------------------------------

/** The glyphs a message's box is drawn with, in either symbol preset, and its horizontal rule. */
const BOX_CORNERS = [
  ...new Set(
    [UNICODE_SYMBOLS, ASCII_SYMBOLS].flatMap(({ box }) => [
      box.topLeft,
      box.topRight,
      box.bottomLeft,
      box.bottomRight,
    ]),
  ),
];
const BOX_RULES = [...new Set([UNICODE_SYMBOLS.box.horizontal, ASCII_SYMBOLS.box.horizontal])];
const BOX_SIDES = [...new Set([UNICODE_SYMBOLS.box.vertical, ASCII_SYMBOLS.box.vertical])];
/** The sides that are only a box's: a markdown table's `|` and the ASCII corner's `+` are not. */
const TABLE_SIDES: ReadonlySet<string> = new Set(["|", "+"]);
const BOX_SIDES_ALONE: ReadonlySet<string> = new Set(
  BOX_SIDES.filter((side) => !TABLE_SIDES.has(side)),
);

const oneOf = (glyphs: ReadonlyArray<string>): string =>
  `(?:${glyphs.map(escapeForRegExp).join("|")})`;

/** The edge of a box: nothing but spaces before it, a corner, the rule, a corner, nothing after. */
const BOX_EDGE = new RegExp(
  `^ *${oneOf(BOX_CORNERS)}${oneOf(BOX_RULES)}+${oneOf(BOX_CORNERS)} *$`,
  "u",
);

/**
 * A row of a box: the spaces the right-aligned box was placed with, a side, one space of padding,
 * the text, the padding, the side. A markdown table's row is never one: its bars start at the first
 * column, while a box is always indented to sit against the right edge.
 */
const BOX_ROW = new RegExp(`^( *)(?:${oneOf(BOX_SIDES)}) (.*) (?:${oneOf(BOX_SIDES)})$`, "u");

/**
 * The columns of a row that hold a message's text, or null when the row is not part of a box;
 * `from === to` for a box's top or bottom edge, which holds none of the message. The message's own
 * indent is left in: only the border and its padding are taken off.
 */
export const boxContent = (
  styled: string,
): { readonly from: number; readonly to: number } | null => {
  const plain = stripAnsi(styled).trimEnd();
  // An edge is nothing but its corners and rule, so it holds no text of the message.
  if (BOX_EDGE.test(plain)) return { from: 0, to: 0 };
  const parts = BOX_ROW.exec(plain);
  if (parts === null) return null;
  const lead = (parts[1] ?? "").length;
  const opening = [...plain][lead] as string;
  // `|` and `+` are a markdown table's glyphs as much as a box's, and a table's rows start at the
  // first column; a box is always indented to sit against the right edge. Only a `│` at the first
  // column is a box's on its own.
  if (lead === 0 && !BOX_SIDES_ALONE.has(opening)) return null;
  return { from: lead + 2, to: visibleWidth(plain) - 2 };
};

/**
 * The text of a selection, ready for the clipboard: no styling, no rail marks, no border of a
 * message's box and no trailing padding. Rows of one logical line are joined into one, with the space
 * the fold swallowed put back; other rows are lines. The right-aligned message of the user and code
 * that sits off the rail carry the same indent on every row; that common indent is removed, so the
 * text starts at its first column and an indent inside the code stays.
 */
export const selectionText = (rows: ReadonlyArray<SelectedRow>): string => {
  const lines: Line[] = [];
  let previous: SelectedRow | null = null;
  for (const row of rows) {
    // The border of a message's box is never part of the message, whichever cells were dragged over.
    const box = boxContent(row.styled);
    if (box !== null && box.to <= box.from) continue;
    const from = box === null ? row.from : Math.max(row.from, box.from);
    const to = box === null ? row.to : Math.min(row.to, box.to);
    let text = cellText(row.styled, from, to).trimEnd();
    const continuation = previous !== null && previous.line === row.line && lines.length > 0;
    if (continuation) {
      const last = lines[lines.length - 1] as Line;
      last.text += `${previous?.spaceAfter === true && text !== "" ? " " : ""}${text}`;
    } else {
      const whole = from === 0;
      let railed = false;
      if (from < RAIL_COLUMNS) {
        const stripped = text.replace(RAIL_PREFIX, "");
        railed = stripped !== text;
        text = stripped;
      }
      lines.push({ text, railed, whole });
    }
    previous = row;
  }
  // Rows without the rail that run on together share an indent, which is layout, not text. A box's
  // rows start at their own first cell, so the space in front of the box is not part of the message.
  for (let start = 0; start < lines.length;) {
    const first = lines[start] as Line;
    if (first.railed || !first.whole) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < lines.length && !(lines[end] as Line).railed && (lines[end] as Line).whole) {
      end += 1;
    }
    const group = lines.slice(start, end);
    const indent = group
      .filter((line) => line.text !== "")
      .reduce(
        (least, line) => Math.min(least, line.text.length - line.text.trimStart().length),
        Infinity,
      );
    if (Number.isFinite(indent) && indent > 0) {
      for (const line of group) line.text = line.text.slice(Math.min(indent, line.text.length));
    }
    start = end;
  }
  return lines
    .map((line) => line.text)
    .join("\n")
    .replace(/\n+$/u, "");
};

/**
 * For each row of the fold of `raw` (a logical line), whether the fold dropped a space after it. A
 * fold at a space removes it; a fold inside a word or between Korean syllables does not.
 */
export const droppedSpaces = (raw: string, rows: ReadonlyArray<string>): boolean[] => {
  const plain = stripAnsi(raw);
  let at = 0;
  return rows.map((row) => {
    const text = stripAnsi(row);
    if (!plain.startsWith(text, at)) return false;
    at += text.length;
    const before = at;
    while (plain[at] === " ") at += 1;
    return at > before;
  });
};

// ---- drag -------------------------------------------------------------------------------------

type DragPhase = "idle" | "ignored" | "pressed" | "dragging";

export type DragEnd<P> =
  | { readonly kind: "none" }
  | { readonly kind: "click" }
  | { readonly kind: "select"; readonly anchor: P; readonly head: P };

/**
 * The life of one press: it starts on a position or outside the area (then ignored until the button
 * is up), becomes a drag when the pointer reaches another position, and ends as a click (the button
 * came up where it went down) or a selection. Positions are compared with `same`.
 */
export class DragState<P> {
  private phase: DragPhase = "idle";
  private from: P | null = null;
  private to: P | null = null;

  private readonly same: (left: P, right: P) => boolean;

  constructor(same: (left: P, right: P) => boolean) {
    this.same = same;
  }

  /** `at` is where the button went down, or null for a press outside the area. */
  press(at: P | null): void {
    this.phase = at === null ? "ignored" : "pressed";
    this.from = at;
    this.to = at;
  }

  /** Whether a press is down on the area. */
  get pressed(): boolean {
    return this.phase === "pressed" || this.phase === "dragging";
  }

  get dragging(): boolean {
    return this.phase === "dragging";
  }

  get anchor(): P | null {
    return this.from;
  }

  /** The pointer moved with the button down; true when the selection is now different. */
  move(at: P): boolean {
    if (!this.pressed || this.from === null) return false;
    if (this.phase === "pressed" && this.same(at, this.from)) return false;
    if (this.to !== null && this.phase === "dragging" && this.same(at, this.to)) return false;
    this.phase = "dragging";
    this.to = at;
    return true;
  }

  /** The button came up. */
  release(): DragEnd<P> {
    const phase = this.phase;
    const anchor = this.from;
    const head = this.to;
    this.phase = "idle";
    this.from = null;
    this.to = null;
    if (phase === "pressed") return { kind: "click" };
    if (phase !== "dragging" || anchor === null || head === null) return { kind: "none" };
    return this.same(anchor, head) ? { kind: "click" } : { kind: "select", anchor, head };
  }

  cancel(): void {
    this.phase = "idle";
    this.from = null;
    this.to = null;
  }
}
