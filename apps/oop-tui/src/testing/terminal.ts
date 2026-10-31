import { graphemesOf, graphemeWidth } from "../text/width.ts";

// eslint-disable-next-line no-control-regex
const CSI = /^\u001b\[([?0-9;]*)([A-Za-z])/u;

/**
 * Just enough of a terminal to see what bytes end up where: a normal screen that scrolls into a
 * scrollback, an alternate screen, absolute and relative cursor moves, erases, autowrap, wide
 * characters, and the modes the app sets. Colours are ignored. Not a faithful emulator; it is the
 * oracle for tests of the live region, the split region and the way between them.
 */
export class FakeTerminal {
  columns: number;
  rows: number;
  /** Rows that scrolled off the top of the normal screen, oldest first. */
  readonly scrollback: string[] = [];
  /** Every distinct private mode change seen, in order. */
  readonly modes: string[] = [];
  cursorVisible = true;
  altScreen = false;
  /** Alternate scroll mode (`?1007`); a terminal starts with it as the user configured it. */
  altScroll: boolean;
  private savedAltScroll: boolean | null = null;
  private main: string[][];
  private alt: string[][];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  /** Bytes written, for tests that count writes. */
  readonly writes: string[] = [];

  constructor(columns: number, rows: number, options: { altScroll?: boolean } = {}) {
    this.altScroll = options.altScroll ?? false;
    this.columns = columns;
    this.rows = rows;
    this.main = this.blank();
    this.alt = this.blank();
  }

  /** A window resize. The normal screen's text is kept at its rows; the alternate screen starts blank. */
  resize(columns: number, rows: number): void {
    const keep = this.main.map((line) => line.join("").trimEnd());
    this.columns = columns;
    this.rows = rows;
    this.main = this.blank().map((line, row) => {
      const chars = graphemesOf(keep[row] ?? "").slice(0, columns);
      chars.forEach((char, index) => void (line[index] = char));
      return line;
    });
    this.alt = this.blank();
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, columns - 1);
  }

  private blank(): string[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => " "));
  }

  private get grid(): string[][] {
    return this.altScreen ? this.alt : this.main;
  }

  /** The cursor, 0-based. */
  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  write(text: string): void {
    this.writes.push(text);
    let rest = text;
    while (rest.length > 0) {
      if (rest.startsWith("\u001b")) {
        const match = CSI.exec(rest);
        if (match === null) {
          // An escape sequence this oracle does not know would be a bug in the code under test.
          throw new Error(`unknown escape sequence: ${JSON.stringify(rest.slice(0, 12))}`);
        }
        this.csi(match[1] ?? "", match[2] ?? "");
        rest = rest.slice(match[0].length);
        continue;
      }
      let end = rest.indexOf("\u001b");
      if (end === -1) end = rest.length;
      this.print(rest.slice(0, end));
      rest = rest.slice(end);
    }
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    const top = this.grid.shift() ?? [];
    this.grid.push(Array.from({ length: this.columns }, () => " "));
    if (!this.altScreen) this.scrollback.push(top.join("").trimEnd());
  }

  private print(text: string): void {
    for (const piece of text.split(/(\r|\n)/u)) {
      if (piece === "\r") {
        this.col = 0;
        continue;
      }
      if (piece === "\n") {
        this.lineFeed();
        continue;
      }
      for (const grapheme of graphemesOf(piece)) {
        const width = graphemeWidth(grapheme);
        if (width === 0) continue;
        if (this.col + width > this.columns) {
          this.col = 0;
          this.lineFeed();
        }
        const line = this.grid[this.row] as string[];
        line[this.col] = grapheme;
        if (width === 2) line[this.col + 1] = "";
        this.col += width;
      }
    }
  }

  private csi(params: string, final: string): void {
    const numbers = params
      .replace("?", "")
      .split(";")
      .map((part) => (part === "" ? 0 : Number(part)));
    const first = numbers[0] ?? 0;
    const amount = Math.max(1, first);
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - amount);
        return;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + amount);
        return;
      case "C":
        this.col = Math.min(this.columns - 1, this.col + amount);
        return;
      case "D":
        this.col = Math.max(0, this.col - amount);
        return;
      case "H":
        this.row = Math.min(this.rows - 1, Math.max(0, (numbers[0] || 1) - 1));
        this.col = Math.min(this.columns - 1, Math.max(0, (numbers[1] || 1) - 1));
        return;
      case "J":
        if (first === 2) {
          for (const line of this.grid) line.fill(" ");
        } else {
          const line = this.grid[this.row] as string[];
          line.fill(" ", this.col);
          for (let row = this.row + 1; row < this.rows; row += 1)
            (this.grid[row] as string[]).fill(" ");
        }
        return;
      case "K":
        (this.grid[this.row] as string[]).fill(" ", this.col);
        return;
      case "m":
        return;
      case "h":
      case "l":
        this.mode(params, final === "h");
        return;
      case "s":
      case "r":
        // Only the private forms (XTSAVE and XTRESTORE of one mode) are known; a plain `s` is
        // "save cursor" in some terminals and "set margins" in others, so it stays an error.
        if (params !== "?1007")
          throw new Error(`unknown control sequence: ESC [ ${params}${final}`);
        this.modes.push(`${params}${final}`);
        if (final === "s") this.savedAltScroll = this.altScroll;
        else if (this.savedAltScroll !== null) this.altScroll = this.savedAltScroll;
        return;
      default:
        throw new Error(`unknown control sequence: ESC [ ${params}${final}`);
    }
  }

  private mode(params: string, on: boolean): void {
    this.modes.push(`${params}${on ? "h" : "l"}`);
    if (params === "?25") this.cursorVisible = on;
    if (params === "?1007") this.altScroll = on;
    if (params === "?1049") {
      if (on && !this.altScreen) {
        this.saved = { row: this.row, col: this.col };
        this.altScreen = true;
        this.alt = this.blank();
      } else if (!on && this.altScreen) {
        this.altScreen = false;
        this.row = this.saved.row;
        this.col = this.saved.col;
      }
    }
  }

  /** The text of cells `from` up to (not including) `to` of a row of the screen now showing, trailing blanks cut. */
  text(row: number, from: number, to = this.columns): string {
    return (this.grid[row] ?? []).slice(from, to).join("").trimEnd();
  }

  /** The glyph in one cell of the screen now showing; "" for the second half of a wide character. */
  cell(row: number, col: number): string {
    return this.grid[row]?.[col] ?? "";
  }

  /** The rows of the screen now showing, trailing blanks cut. */
  screen(): string[] {
    return this.grid.map((line) => line.join("").trimEnd());
  }

  /** Everything on the normal screen: the scrollback, then the visible rows, trailing blank rows cut. */
  normalText(): string[] {
    const visible = this.main.map((line) => line.join("").trimEnd());
    while (visible.length > 0 && visible[visible.length - 1] === "") visible.pop();
    return [...this.scrollback, ...visible];
  }
}
