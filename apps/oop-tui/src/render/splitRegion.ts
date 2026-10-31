import { stripControlSequences, visibleWidth } from "../text/width.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";
import type { RegionFrame, Scheduler, TerminalOutput } from "./liveRegion.ts";
import { tasksUnavailable } from "./tasksPane.ts";

/** Narrowest and shortest terminal the side-by-side layout is offered in. */
export const MIN_SPLIT_COLUMNS = 100;
export const MIN_SPLIT_ROWS = 12;
/** Finished lines the viewport can scroll back over; older ones are only kept for `leave`. */
export const VIEW_LIMIT = 5000;
/** Finished lines kept for `leave`; past this the oldest are dropped and counted. */
export const KEEP_LIMIT = 50000;
/** Rows of conversation that stay above the live frame however tall the frame gets. */
const MIN_VIEWPORT_ROWS = 3;

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
/**
 * Alternate scroll mode: some terminals turn the mouse wheel into arrow keys on the alternate
 * screen, which would walk the composer's history. It is switched off while the split is on. Going
 * back it is switched on and then restored from the saved value: a terminal that knows the mode but
 * cannot save it (Alacritty) ignores the restore, and it must not stay off after the app is gone.
 * Terminals that do not know the mode ignore all of it.
 */
const ALT_SCROLL_SAVE = "\u001b[?1007s";
const ALT_SCROLL_OFF = "\u001b[?1007l";
const ALT_SCROLL_RESTORE = "\u001b[?1007h\u001b[?1007r";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
const CLEAR_SCREEN = "\u001b[2J";
const RESET = "\u001b[0m";
const LINE_BREAK = /\r\n|\r|\n/gu;

export interface SplitLayout {
  /** Cells of the conversation column, the one next to the divider included. */
  readonly left: number;
  /** Cells of the side panel; 0 while the panel is closed. */
  readonly panel: number;
}

/**
 * The conversation takes the left, then the divider (one cell), then the panel; the last column is
 * left empty so a full row never sits in a pending-wrap state. With the panel closed the
 * conversation takes everything but that last column.
 */
export const splitLayout = (columns: number, side = true): SplitLayout => {
  if (!side) return { left: Math.max(10, columns - 1), panel: 0 };
  const panel = Math.min(72, Math.max(36, Math.floor(columns * 0.38)));
  return { left: Math.max(10, columns - 2 - panel), panel };
};

/** What the alternate screen is asked to show; each part has its own least size. */
export interface SplitParts {
  /** The side panel (`/dag-workflow`, `/dag-agents`). */
  readonly panel: boolean;
  /** The task list under the conversation (`/tasks`). */
  readonly tasks: boolean;
}

/** Why the alternate screen cannot show `parts` at this size; null when it can. */
export const splitUnavailable = (
  columns: number,
  rows: number,
  parts: SplitParts = { panel: true, tasks: false },
): string | null => {
  if (parts.panel) {
    if (columns < MIN_SPLIT_COLUMNS) {
      return `터미널 폭이 ${MIN_SPLIT_COLUMNS}칸 미만이라 분리 창을 쓸 수 없습니다 (지금 ${columns}칸)`;
    }
    if (rows < MIN_SPLIT_ROWS) {
      return `터미널 높이가 ${MIN_SPLIT_ROWS}줄 미만이라 분리 창을 쓸 수 없습니다 (지금 ${rows}줄)`;
    }
  }
  return parts.tasks ? tasksUnavailable(columns, rows) : null;
};

interface HistoryEntry {
  readonly raw: string;
  /** `raw` folded to the conversation width; null until it is needed at the current width. */
  rows: string[] | null;
}

interface Painted {
  readonly left: ReadonlyArray<string>;
  readonly panel: ReadonlyArray<string>;
  readonly divider: string;
  readonly side: boolean;
  readonly cursor: { readonly row: number; readonly col: number } | null;
  readonly columns: number;
  readonly rows: number;
}

type Mode = "off" | "on" | "suspended";

/** Pads a styled line to exactly `width` cells, closing its styles before the padding. */
const cell = (line: string, width: number): string =>
  `${line}${RESET}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;

const at = (row: number, col: number): string => `\u001b[${row + 1};${col + 1}H`;

/**
 * Side-by-side rendering in the alternate screen: the conversation on the left (finished lines in a
 * viewport above the live frame), a panel on the right, a divider between. It offers the calls of
 * `LiveRegion` the controller uses, so the controller does not know which one it draws on. Lines
 * committed while it is on are kept as they came and handed back by `leave`, which is how they reach
 * the scrollback. Painting is by segment: the left or right part of a row is rewritten only if it
 * differs from what is on screen, and a frame identical to the one on screen writes nothing. A
 * resize holds painting until the size settles and then writes the whole screen. PageUp and
 * PageDown (`scrollUp`, `scrollDown`) move the conversation back and forth; it follows the newest
 * line again when it reaches the bottom or `follow` is called.
 */
export class SplitRegion {
  private mode: Mode = "off";
  private frame: RegionFrame = { lines: [], cursor: null };
  private panelLines: ReadonlyArray<string> = [];
  /** Whether the side panel is shown; closed, the conversation has the whole width. */
  private side = true;
  /** The task list under the conversation; none when empty. */
  private taskLines: ReadonlyArray<string> = [];
  private history: HistoryEntry[] = [];
  /** Entries before this one were scrolled out of view with Ctrl-L; `leave` still hands them back. */
  private viewFrom = 0;
  /** Lines dropped from the front of `history` because it passed `KEEP_LIMIT`. */
  private omitted = 0;
  /** Rows the conversation is scrolled back from the newest line; 0 follows the newest. */
  private scroll = 0;
  /** Rows the viewport had at the last paint, for the size of a page. */
  private viewRows = 0;
  private wrapWidth = 0;
  private dirty = false;
  private held = false;
  private stale = true;
  private cancel: (() => void) | null = null;
  private painted: Painted | null = null;

  private readonly out: TerminalOutput;
  private readonly schedule: Scheduler;
  private readonly divider: () => string;

  constructor(
    out: TerminalOutput,
    schedule: Scheduler,
    options: { readonly divider: () => string },
  ) {
    this.out = out;
    this.schedule = schedule;
    this.divider = options.divider;
  }

  isOn(): boolean {
    return this.mode === "on";
  }

  isSuspended(): boolean {
    return this.mode === "suspended";
  }

  /** Tallest live frame the left column can hold; the viewport keeps a few rows above it. */
  maxRows(): number {
    return Math.max(3, this.out.rows() - this.taskLines.length - MIN_VIEWPORT_ROWS);
  }

  /** Columns a line of the conversation may use. */
  usableColumns(): number {
    return Math.max(10, splitLayout(this.out.columns(), this.side).left - 1);
  }

  /** Size of the side panel, for what is drawn in it. */
  panelSize(): { readonly columns: number; readonly rows: number } {
    return { columns: splitLayout(this.out.columns(), this.side).panel, rows: this.out.rows() };
  }

  /** What the alternate screen shows now, for the size check on a resize. */
  parts(): SplitParts {
    return { panel: this.side, tasks: this.taskLines.length > 0 };
  }

  /** Switches to the alternate screen. */
  enter(): void {
    this.mode = "on";
    this.stale = true;
    this.painted = null;
    this.out.write(ALT_ON + ALT_SCROLL_SAVE + ALT_SCROLL_OFF + HIDE_CURSOR);
    this.requestPaint();
  }

  /**
   * Back to the normal screen. Returns the lines committed while it was on, as they came, for the
   * caller to write into the scrollback; nothing is kept. At most `KEEP_LIMIT` lines come back, the
   * newest, and when older ones were dropped a first line says how many. Safe to call when it is
   * not on.
   */
  leave(): string[] {
    this.cancelScheduled();
    if (this.mode === "on") this.out.write(ALT_SCROLL_RESTORE + ALT_OFF + SHOW_CURSOR);
    const lines = this.history.map((entry) => entry.raw);
    if (this.omitted > 0) lines.unshift(`… 분할 중 ${this.omitted}줄 생략`);
    this.mode = "off";
    this.history = [];
    this.omitted = 0;
    this.scroll = 0;
    this.viewFrom = 0;
    this.wrapWidth = 0;
    this.dirty = false;
    this.held = false;
    this.painted = null;
    this.frame = { lines: [], cursor: null };
    this.panelLines = [];
    this.side = true;
    this.taskLines = [];
    return lines;
  }

  /** The process is being stopped: the normal screen comes back, the conversation is kept. */
  suspend(): void {
    this.cancelScheduled();
    if (this.mode !== "on") return;
    this.out.write(ALT_SCROLL_RESTORE + ALT_OFF + SHOW_CURSOR);
    this.mode = "suspended";
    this.painted = null;
  }

  /** The process continues after a stop: back into the alternate screen, drawn whole. */
  resume(): void {
    if (this.mode === "suspended") this.enter();
  }

  /** Queues finished lines for the conversation column. They show above the live frame. */
  commit(lines: ReadonlyArray<string>): void {
    if (lines.length === 0) return;
    for (const line of lines) {
      for (const row of line.split(LINE_BREAK)) {
        const entry: HistoryEntry = { raw: stripControlSequences(row), rows: null };
        this.history.push(entry);
        // A reader who scrolled back keeps their place: the new rows count against the offset.
        if (this.scroll > 0) {
          entry.rows = wrapStyled(entry.raw, this.wrapWidth);
          this.scroll += entry.rows.length;
        }
      }
    }
    const excess = this.history.length - KEEP_LIMIT;
    if (excess > 0) {
      this.history.splice(0, excess);
      this.omitted += excess;
      this.viewFrom = Math.max(0, this.viewFrom - excess);
    }
    this.requestPaint();
  }

  set(frame: RegionFrame): void {
    this.frame = {
      lines: frame.lines.map((line) => stripControlSequences(line.replace(LINE_BREAK, " "))),
      cursor: frame.cursor,
    };
    this.requestPaint();
  }

  /** Replaces the side panel; the same lines as before cause no paint. */
  setPanel(lines: ReadonlyArray<string>): void {
    const next = lines.map((line) => stripControlSequences(line.replace(LINE_BREAK, " ")));
    if (next.length === this.panelLines.length && next.every((l, i) => l === this.panelLines[i])) {
      return;
    }
    this.panelLines = next;
    this.requestPaint();
  }

  /** Opens or closes the side panel; the whole screen is drawn again. */
  setSide(open: boolean): void {
    if (open === this.side) return;
    this.side = open;
    this.stale = true;
    this.requestPaint();
  }

  /** Replaces the task list under the conversation (none when empty); the same lines cause no paint. */
  setTasks(lines: ReadonlyArray<string>): void {
    const next = lines.map((line) => stripControlSequences(line.replace(LINE_BREAK, " ")));
    if (next.length === this.taskLines.length && next.every((l, i) => l === this.taskLines[i])) {
      return;
    }
    this.taskLines = next;
    this.requestPaint();
  }

  flush(): void {
    this.cancelScheduled();
    if (!this.dirty || this.held || this.mode !== "on") return;
    this.dirty = false;
    this.paint();
  }

  /** Ctrl-L: what is in the viewport is scrolled out of view; `leave` still hands it back. */
  abandon(): void {
    this.viewFrom = this.history.length;
    this.scroll = 0;
    this.requestPaint();
  }

  /** PageUp: shows the page of conversation before the one on screen. */
  scrollUp(): void {
    if (this.mode !== "on") return;
    this.scroll += this.page();
    this.requestPaint();
    this.flush();
  }

  /** PageDown: one page toward the newest line; at the bottom the conversation follows again. */
  scrollDown(): void {
    if (this.mode !== "on" || this.scroll === 0) return;
    this.scroll = Math.max(0, this.scroll - this.page());
    this.requestPaint();
  }

  /** New input: the conversation goes back to the newest line. */
  follow(): void {
    if (this.scroll === 0) return;
    this.scroll = 0;
    this.requestPaint();
  }

  private page(): number {
    return Math.max(1, (this.viewRows || this.maxRows()) - 1);
  }

  /** A resize began: nothing is painted until `release`. */
  hold(): void {
    this.held = true;
    this.stale = true;
  }

  release(): void {
    this.held = false;
    this.requestPaint();
  }

  /** What is on screen can no longer be trusted: the next paint writes everything. */
  invalidate(): void {
    this.stale = true;
    this.requestPaint();
  }

  private requestPaint(): void {
    if (this.mode !== "on") return;
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

  /**
   * `count` rows of the conversation at `width`: the newest ones, or those `scroll` rows further
   * back, with blank rows on top if there are fewer. A scrolled view says so on its last row.
   */
  private viewport(count: number, width: number): string[] {
    if (width !== this.wrapWidth) {
      this.wrapWidth = width;
      for (const entry of this.history) entry.rows = null;
    }
    const newestFirst: string[] = [];
    const oldest = Math.max(this.viewFrom, this.history.length - VIEW_LIMIT);
    for (
      let index = this.history.length - 1;
      index >= oldest && newestFirst.length < count + this.scroll;
      index -= 1
    ) {
      const entry = this.history[index] as HistoryEntry;
      entry.rows ??= wrapStyled(entry.raw, width);
      for (let row = entry.rows.length - 1; row >= 0; row -= 1) {
        newestFirst.push(entry.rows[row] as string);
      }
    }
    this.scroll = Math.min(this.scroll, Math.max(0, newestFirst.length - count));
    const rows = newestFirst.slice(this.scroll, this.scroll + count).toReversed();
    if (this.scroll > 0 && rows.length > 0) {
      rows[rows.length - 1] = truncateStyled(
        "↑ 스크롤 중 · PageDown 또는 Shift+PageDown 으로 아래로",
        width,
      );
    }
    return [...Array.from({ length: count - rows.length }, () => ""), ...rows];
  }

  private paint(): void {
    const columns = this.out.columns();
    const rows = this.out.rows();
    const side = this.side;
    const layout = splitLayout(columns, side);
    const leftLimit = Math.max(10, layout.left - 1);
    // The task list sits at the foot of the left column; the conversation and its live frame have what is above it.
    const tasks = this.taskLines.slice(0, Math.max(0, rows - MIN_VIEWPORT_ROWS - 1));
    const leftRows = rows - tasks.length;
    let lines = this.frame.lines.map((line) => truncateStyled(line, leftLimit));
    let cursor = this.frame.cursor;
    const cap = this.maxRows();
    if (lines.length > cap) {
      const drop = lines.length - cap;
      lines = lines.slice(drop);
      cursor = cursor ? { row: Math.max(0, cursor.row - drop), col: cursor.col } : null;
    }
    const top = Math.max(0, leftRows - lines.length);
    this.viewRows = top;
    const left = [
      ...[...this.viewport(top, leftLimit), ...lines].slice(-leftRows),
      ...tasks.map((line) => truncateStyled(line, leftLimit)),
    ].map((line) => cell(line, layout.left));
    const panel = side
      ? Array.from({ length: rows }, (_, row) =>
          cell(truncateStyled(this.panelLines[row] ?? "", layout.panel), layout.panel),
        )
      : [];
    const divider = side ? this.divider() : "";
    const place =
      cursor === null
        ? null
        : {
            row: Math.min(leftRows - 1, top + cursor.row),
            col: Math.min(layout.left - 1, cursor.col),
          };

    const before = this.painted;
    let text = "";
    if (
      before === null ||
      this.stale ||
      before.columns !== columns ||
      before.rows !== rows ||
      before.side !== side
    ) {
      text += CLEAR_SCREEN;
      for (let row = 0; row < rows; row += 1) {
        text += at(row, 0) + (left[row] as string) + RESET;
        if (!side) continue;
        text += at(row, layout.left) + divider + RESET;
        text += at(row, layout.left + 1) + (panel[row] as string) + RESET;
      }
    } else {
      for (let row = 0; row < rows; row += 1) {
        if (left[row] !== before.left[row]) text += at(row, 0) + (left[row] as string) + RESET;
        if (!side) continue;
        if (divider !== before.divider) text += at(row, layout.left) + divider + RESET;
        if (panel[row] !== before.panel[row]) {
          text += at(row, layout.left + 1) + (panel[row] as string) + RESET;
        }
      }
    }
    const sameCursor =
      before !== null && before.cursor?.row === place?.row && before.cursor?.col === place?.col;
    this.painted = { left, panel, divider, side, cursor: place, columns, rows };
    this.stale = false;
    if (text === "" && sameCursor) return;
    const finish = place === null ? HIDE_CURSOR : at(place.row, place.col) + SHOW_CURSOR;
    this.out.write(SYNC_BEGIN + HIDE_CURSOR + text + finish + SYNC_END);
  }
}
