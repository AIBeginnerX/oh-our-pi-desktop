import { sanitizeForTerminal } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { type Piece, wrapPieces } from "./highlight.ts";
import type { Style } from "./style.ts";
import { t } from "../i18n/index.ts";

export interface DiffOptions {
  readonly width: number;
  readonly style: Style;
  /** Diff lines drawn before the rest is summarised as `... N줄 더`. */
  readonly maxLines?: number;
}

const DEFAULT_MAX_LINES = 400;

/** Word comparison is quadratic, so a longer pair of lines is left with whole-line colour only. */
const WORD_DIFF_TOKEN_LIMIT = 200;
const WORD_DIFF_CHARACTER_LIMIT = 2000;

type LineKind = "add" | "remove" | "context";

interface DiffLine {
  readonly kind: LineKind;
  /** The line number in the old file (removed) or the new one; null when the diff gave no hunk header. */
  readonly number: number | null;
  readonly text: string;
}

interface Part extends Piece {
  readonly changed: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
const FILE_HEADER = /^(?:\+\+\+|---) /u;
const NOISE_HEADER = /^index [\da-f]+\.\./u;
const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

const SIGNS: Record<LineKind, string> = { add: "+", remove: "-", context: " " };

const mergeParts = (tokens: ReadonlyArray<Part>): Part[] => {
  const merged: Part[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.changed === token.changed) {
      merged[merged.length - 1] = { text: last.text + token.text, changed: token.changed };
    } else {
      merged.push(token);
    }
  }
  return merged;
};

/**
 * Splits a removed and an added line into runs that are the same on both sides and runs that differ.
 * Null when the lines share no word at all (the whole line differs, which the line colour already
 * says) or are too long to compare.
 */
const changedWords = (before: string, after: string): [Part[], Part[]] | null => {
  if (before.length > WORD_DIFF_CHARACTER_LIMIT || after.length > WORD_DIFF_CHARACTER_LIMIT) {
    return null;
  }
  const left = before.match(WORD) ?? [];
  const right = after.match(WORD) ?? [];
  if (left.length > WORD_DIFF_TOKEN_LIMIT || right.length > WORD_DIFF_TOKEN_LIMIT) return null;

  // Longest common subsequence of the two token lists.
  const columns = right.length + 1;
  const table = new Uint16Array((left.length + 1) * columns);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        left[row] === right[column]
          ? (table[(row + 1) * columns + column + 1] as number) + 1
          : Math.max(
              table[(row + 1) * columns + column] as number,
              table[row * columns + column + 1] as number,
            );
    }
  }
  const leftParts: Part[] = left.map((text) => ({ text, changed: true }));
  const rightParts: Part[] = right.map((text) => ({ text, changed: true }));
  let sharesWord = false;
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      leftParts[row] = { text: left[row] as string, changed: false };
      rightParts[column] = { text: right[column] as string, changed: false };
      if ((left[row] as string).trim() !== "") sharesWord = true;
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * columns + column] as number) >=
      (table[row * columns + column + 1] as number)
    ) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return sharesWord ? [mergeParts(leftParts), mergeParts(rightParts)] : null;
};

/**
 * Draws a unified diff one source line at a time, so a streaming reply can print each change as it
 * arrives. A run of removed lines followed by added ones is held back until it ends, because a single
 * removed and added pair has its changed words marked. Line numbers appear once a hunk header has
 * been seen; a diff without one (a model's sketch of a change) is drawn without numbers.
 */
export class DiffStream {
  private removes: DiffLine[] = [];
  private adds: DiffLine[] = [];
  private oldNumber = 0;
  private newNumber = 0;
  private oldLeft = 0;
  private newLeft = 0;
  private numberWidth = 0;
  private shown = 0;
  private hidden = 0;

  private readonly options: DiffOptions;

  constructor(options: DiffOptions) {
    this.options = options;
  }

  push(raw: string): string[] {
    return sanitizeForTerminal(raw)
      .split("\n")
      .flatMap((line) => this.pushLine(line));
  }

  /** Ends the diff: a pending change is drawn, and lines past the limit are counted. */
  finish(): string[] {
    const out = this.flushChange();
    if (this.hidden > 0) {
      out.push(this.options.style.theme.dim(t("render.moreLinesDots", { count: this.hidden })));
      this.hidden = 0;
    }
    return out;
  }

  /** Whether another line fits under the limit; a line that does not is only counted. */
  private admit(): boolean {
    if (this.shown >= (this.options.maxLines ?? DEFAULT_MAX_LINES)) {
      this.hidden += 1;
      return false;
    }
    this.shown += 1;
    return true;
  }

  private pushLine(line: string): string[] {
    const inHunk = this.oldLeft > 0 || this.newLeft > 0;
    if (line.startsWith("\\")) return this.flushChange().concat(this.noteRow(line));

    if (inHunk && !line.startsWith("@@")) {
      if (line.startsWith("+")) {
        this.newLeft = Math.max(0, this.newLeft - 1);
        return this.addLine(line.slice(1), this.newNumber++);
      }
      if (line.startsWith("-")) {
        this.oldLeft = Math.max(0, this.oldLeft - 1);
        return this.removeLine(line.slice(1), this.oldNumber++);
      }
      this.oldLeft = Math.max(0, this.oldLeft - 1);
      this.newLeft = Math.max(0, this.newLeft - 1);
      this.oldNumber += 1;
      return this.contextLine(line.slice(1), this.newNumber++);
    }

    const hunk = HUNK.exec(line);
    if (hunk) {
      const out = this.flushChange();
      const oldStart = Number(hunk[1]);
      const newStart = Number(hunk[3]);
      this.oldNumber = oldStart;
      this.newNumber = newStart;
      this.oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      this.newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      const last = Math.max(oldStart + this.oldLeft, newStart + this.newLeft);
      this.numberWidth = Math.max(this.numberWidth, String(last).length);
      if (this.admit()) out.push(this.headerRow(line));
      return out;
    }
    if (FILE_HEADER.test(line) || (!/^[+\- ]/u.test(line) && line !== "")) {
      const out = this.flushChange();
      if (!NOISE_HEADER.test(line) && this.admit()) out.push(this.headerRow(line));
      return out;
    }
    // Outside a counted hunk: a model's bare diff, drawn without line numbers.
    if (line.startsWith("+")) return this.addLine(line.slice(1), null);
    if (line.startsWith("-")) return this.removeLine(line.slice(1), null);
    return this.contextLine(line.slice(1), null);
  }

  private addLine(text: string, number: number | null): string[] {
    if (!this.admit()) return [];
    this.adds.push({ kind: "add", number, text });
    return [];
  }

  private removeLine(text: string, number: number | null): string[] {
    // A removal after additions starts the next change.
    const out = this.adds.length > 0 ? this.flushChange() : [];
    if (!this.admit()) return out;
    this.removes.push({ kind: "remove", number, text });
    return out;
  }

  private contextLine(text: string, number: number | null): string[] {
    const out = this.flushChange();
    if (this.admit()) out.push(...this.lineRows({ kind: "context", number, text }));
    return out;
  }

  private flushChange(): string[] {
    const { removes, adds } = this;
    this.removes = [];
    this.adds = [];
    const out: string[] = [];
    const [removed] = removes;
    const [added] = adds;
    const words =
      removes.length === 1 && adds.length === 1 && this.options.style.theme.supportsBackground
        ? changedWords((removed as DiffLine).text, (added as DiffLine).text)
        : null;
    for (const line of removes) out.push(...this.lineRows(line, words?.[0]));
    for (const line of adds) out.push(...this.lineRows(line, words?.[1]));
    return out;
  }

  private headerRow(line: string): string {
    return truncateStyled(this.options.style.theme.muted(line), this.options.width);
  }

  private noteRow(line: string): string[] {
    return this.admit()
      ? [truncateStyled(this.options.style.theme.dim(line), this.options.width)]
      : [];
  }

  private lineRows(line: DiffLine, words?: ReadonlyArray<Part>): string[] {
    const { theme } = this.options.style;
    const gutter =
      this.numberWidth === 0
        ? ""
        : `${(line.number === null ? "" : String(line.number)).padStart(this.numberWidth)} `;
    const sign = SIGNS[line.kind];
    const prefixWidth = gutter.length + 2;
    const contentWidth = Math.max(4, this.options.width - prefixWidth);
    const wrapped = wrapPieces<Part>(words ?? [{ text: line.text, changed: false }], contentWidth);
    const lineToken = line.kind === "add" ? "diffAddBg" : "diffRemoveBg";
    const wordToken = line.kind === "add" ? "diffAddWord" : "diffRemoveWord";
    const signPaint = line.kind === "add" ? theme.success : theme.error;
    const fallback = line.kind === "add" ? "success" : "error";

    return wrapped.map((row, index) => {
      const head = index === 0 ? gutter : " ".repeat(gutter.length);
      const mark = index === 0 ? sign : " ";
      if (line.kind === "context") {
        return `${theme.dim(head)}${mark} ${row.pieces.map((piece) => piece.text).join("")}`;
      }
      if (!theme.supportsBackground) {
        const text = `${head}${mark} ${row.pieces.map((piece) => piece.text).join("")}`;
        return theme.bg(lineToken, text, fallback);
      }
      // The fill stops at the line width, so the row never wraps in the terminal.
      const fill = Math.max(0, this.options.width - prefixWidth - row.width);
      return (
        theme.bg(lineToken, `${theme.dim(head)}${signPaint(mark)} `) +
        row.pieces
          .map((piece) => theme.bg(piece.changed ? wordToken : lineToken, piece.text))
          .join("") +
        theme.bg(lineToken, " ".repeat(fill))
      );
    });
  }
}
