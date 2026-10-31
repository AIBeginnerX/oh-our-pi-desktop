import { graphemesOf, graphemeWidth, stripAnsi, stripControlSequences } from "../text/width.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";

export interface TerminalOutput {
  readonly write: (text: string) => void;
  readonly columns: () => number;
  readonly rows: () => number;
}

export interface RegionFrame {
  readonly lines: ReadonlyArray<string>;
  /** Where the real terminal cursor belongs; an input method anchors its composition window here. */
  readonly cursor: { readonly row: number; readonly col: number } | null;
}

export type Scheduler = (run: () => void) => () => void;

const REPAINT_DELAY_MS = 16;

export const defaultScheduler: Scheduler = (run) => {
  const handle = setTimeout(run, REPAINT_DELAY_MS);
  return () => clearTimeout(handle);
};

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
const CLEAR_BELOW = "\u001b[J";
const RESET = "\u001b[0m";
const LINE_BREAK = /\r\n|\r|\n/gu;

/** Screen rows a painted line fills once the terminal folds it, up to the cell `upTo` if given. */
const foldedRows = (line: string, columns: number, upTo = Number.POSITIVE_INFINITY): number => {
  let rows = 1;
  let col = 0;
  let cell = 0;
  for (const grapheme of graphemesOf(stripAnsi(line))) {
    const size = graphemeWidth(grapheme);
    // A wide character that does not fit moves to the next row whole.
    if (col + size > columns) {
      rows += 1;
      col = 0;
    }
    if (cell >= upTo) break;
    col += size;
    cell += size;
  }
  return rows;
};

/**
 * Inline rendering without the alternate screen: finished lines are written once into the normal
 * scrollback, and only a small "live region" at the bottom (status, composer, pickers) is erased and
 * redrawn. Every line is cleaned of control sequences on the way in, so no caller can leak one.
 * The region never repaints by itself: a paint happens only after a caller set a frame, and bursts of
 * calls collapse into one write. A caller may set frames on a timer (the turn spinner does), so a
 * paint that only changes some rows rewrites just those rows, and a frame identical to the one on
 * screen writes nothing. Everything else (first paint, a changed row count or terminal size,
 * scrollback output, after `clear`, `abandon` or `invalidate`) erases the region and writes it whole.
 * While the window is being resized the region is held: nothing is written until the size settles,
 * and then the old region is erased where the terminal refolded it, so no copy stays behind. A
 * terminal that clips long lines instead of refolding them loses that many rows above the region.
 */
export class LiveRegion {
  private frame: RegionFrame = { lines: [], cursor: null };
  private queued: string[] = [];
  private dirty = false;
  /** Set from the first resize event until the size settles; nothing is painted meanwhile. */
  private held = false;
  /** The terminal was handed back (`close`): nothing is painted, and what is said waits for `drain`. */
  private closed = false;
  /** The screen may not match `painted`, so the next paint writes the region whole. */
  private stale = false;
  private cancel: (() => void) | null = null;
  private paintedHeight = 0;
  private paintedCursorRow = 0;
  /** What is on screen after the last paint, so the next one can rewrite only the rows that differ. */
  private painted: {
    readonly lines: ReadonlyArray<string>;
    readonly cursor: RegionFrame["cursor"];
    readonly columns: number;
    readonly rows: number;
  } | null = null;

  private readonly out: TerminalOutput;
  private readonly schedule: Scheduler;

  constructor(out: TerminalOutput, schedule: Scheduler = defaultScheduler) {
    this.out = out;
    this.schedule = schedule;
  }

  /** Tallest region that can be redrawn in place. */
  maxRows(): number {
    return Math.max(3, this.out.rows() - 1);
  }

  /** Columns a line may use. One is kept free so a full row never sits in a pending-wrap state. */
  usableColumns(): number {
    return Math.max(10, this.out.columns() - 1);
  }

  /** Queues finished lines for the scrollback. They appear above the live region on the next paint. */
  commit(lines: ReadonlyArray<string>): void {
    if (lines.length === 0) return;
    for (const line of lines) {
      for (const row of line.split(LINE_BREAK)) this.queued.push(stripControlSequences(row));
    }
    this.requestPaint();
  }

  /**
   * The program is leaving and the terminal has been handed back: the region never writes again,
   * not even a hidden cursor, so a request that finishes while the process waits for the server
   * cannot redraw over the shell. Whatever is said from now on is kept for `drain`.
   */
  close(): void {
    this.cancelScheduled();
    this.dirty = false;
    this.closed = true;
  }

  /** Writes the lines said since `close`, once, below the farewell; the cursor is shown. */
  drain(): void {
    if (!this.closed || this.queued.length === 0) return;
    this.out.write(this.takeQueuedAsText() + SHOW_CURSOR);
  }

  set(frame: RegionFrame): void {
    // A line feed would add a row the cursor math does not know about, so it becomes a space.
    this.frame = {
      lines: frame.lines.map((line) => stripControlSequences(line.replace(LINE_BREAK, " "))),
      cursor: frame.cursor,
    };
    this.requestPaint();
  }

  /** Writes any pending change now. Used before exit and by tests. */
  flush(): void {
    this.cancelScheduled();
    if (!this.dirty || this.held) return;
    this.dirty = false;
    this.paint();
  }

  /** Erases the region and leaves the cursor where it began, ready for ordinary output. */
  clear(): void {
    this.cancelScheduled();
    this.dirty = false;
    let text = "";
    if (this.queued.length > 0) text += this.takeQueuedAsText();
    this.out.write(this.moveToRegionTop() + CLEAR_BELOW + text);
    this.paintedHeight = 0;
    this.paintedCursorRow = 0;
    this.painted = null;
    this.frame = { lines: [], cursor: null };
    this.held = false;
  }

  /** Forgets the painted region without erasing it, leaving what is on screen in the scrollback. */
  abandon(): void {
    this.forget();
    this.requestPaint();
  }

  /**
   * A resize began: the terminal is refolding the region, so a timer that keeps setting frames must
   * not draw onto it. Nothing is painted until `release`.
   */
  hold(): void {
    this.held = true;
    this.stale = true;
  }

  /** The size settled; the old region is erased and drawn whole at its new width. */
  release(): void {
    this.held = false;
    this.requestPaint();
  }

  /**
   * What is on screen can no longer be trusted (the process was stopped and continued): the next
   * paint erases the region and writes it whole instead of rewriting rows that differ.
   */
  invalidate(): void {
    this.stale = true;
    this.requestPaint();
  }

  private forget(): void {
    if (this.paintedHeight === 0) return;
    const below = this.paintedHeight - 1 - this.paintedCursorRow;
    this.out.write((below > 0 ? `\u001b[${below}B` : "") + "\r\n");
    this.paintedHeight = 0;
    this.paintedCursorRow = 0;
    this.painted = null;
  }

  private requestPaint(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.held || this.cancel) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.flush();
    });
  }

  private cancelScheduled(): void {
    if (!this.cancel) return;
    this.cancel();
    this.cancel = null;
  }

  /** Screen rows from the region's top to the cursor at the current width. */
  private rowsAboveCursor(): number {
    if (!this.painted) return this.paintedCursorRow;
    const columns = this.out.columns();
    const { lines, cursor } = this.painted;
    let rows = 0;
    for (const line of lines.slice(0, this.paintedCursorRow)) rows += foldedRows(line, columns);
    const cursorLine = lines[this.paintedCursorRow] ?? "";
    return rows + foldedRows(cursorLine, columns, cursor?.col ?? 0) - 1;
  }

  private moveToRegionTop(): string {
    const rows = this.rowsAboveCursor();
    return `${rows > 0 ? `\u001b[${rows}A` : ""}\r`;
  }

  private takeQueuedAsText(): string {
    const limit = this.usableColumns();
    // A line queued during a resize was laid out for the old width. It goes to the scrollback for
    // good, so it is folded rather than cut; nothing above the region counts towards the cursor.
    const text = this.queued
      .flatMap((line) => wrapStyled(line, limit))
      .map((line) => `${line}${RESET}\r\n`)
      .join("");
    this.queued = [];
    return text;
  }

  private paint(): void {
    const limit = this.usableColumns();
    const cap = this.maxRows();
    let lines = this.frame.lines.map((line) => truncateStyled(line, limit));
    let cursor = this.frame.cursor;
    if (lines.length > cap) {
      const drop = lines.length - cap;
      lines = lines.slice(drop);
      cursor = cursor ? { row: Math.max(0, cursor.row - drop), col: cursor.col } : null;
    }
    const columns = this.out.columns();
    const rows = this.out.rows();
    const lastRow = Math.max(0, lines.length - 1);
    const target = cursor ?? { row: lastRow, col: 0 };
    const row = Math.min(target.row, lastRow);

    const before = this.painted;
    const inPlace =
      before !== null &&
      !this.stale &&
      this.queued.length === 0 &&
      before.columns === columns &&
      before.rows === rows &&
      before.lines.length === lines.length;
    if (inPlace) {
      this.paintChangedRows(before, lines, cursor, row, target.col);
    } else {
      let text = SYNC_BEGIN + HIDE_CURSOR + this.moveToRegionTop() + CLEAR_BELOW;
      text += this.takeQueuedAsText();
      text += lines.join("\r\n");
      text += this.placeCursor(lastRow, row, target.col, cursor !== null) + SYNC_END;
      this.out.write(text);
    }
    this.painted = { lines, cursor, columns, rows };
    this.stale = false;
    this.paintedHeight = Math.max(1, lines.length);
    this.paintedCursorRow = row;
  }

  /** From the last row written to the cursor's row and column; the cursor shows only if there is one. */
  private placeCursor(from: number, row: number, col: number, visible: boolean): string {
    let text = "";
    if (from > row) text += `\u001b[${from - row}A`;
    else if (row > from) text += `\u001b[${row - from}B`;
    text += "\r";
    if (col > 0) text += `\u001b[${col}C`;
    // Pickers have no text cursor; it stays hidden rather than blinking at the end of a hint line.
    return text + (visible ? SHOW_CURSOR : "");
  }

  /** Same size and row count as what is on screen: rewrite the rows that differ, or nothing at all. */
  private paintChangedRows(
    before: NonNullable<LiveRegion["painted"]>,
    lines: ReadonlyArray<string>,
    cursor: RegionFrame["cursor"],
    cursorRow: number,
    cursorCol: number,
  ): void {
    const changed: number[] = [];
    lines.forEach((line, index) => {
      if (line !== before.lines[index]) changed.push(index);
    });
    const sameCursor = before.cursor?.row === cursor?.row && before.cursor?.col === cursor?.col;
    if (changed.length === 0 && sameCursor) return;
    let text = SYNC_BEGIN + HIDE_CURSOR;
    let at = this.paintedCursorRow;
    for (const index of changed) {
      if (index < at) text += `\u001b[${at - index}A`;
      else if (index > at) text += `\u001b[${index - at}B`;
      // A row is erased to its end after it is written, so a shorter line leaves nothing behind.
      text += `\r${lines[index]}${RESET}\u001b[K`;
      at = index;
    }
    text += this.placeCursor(at, cursorRow, cursorCol, cursor !== null) + SYNC_END;
    this.out.write(text);
  }
}
