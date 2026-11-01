import { stripControlSequences, visibleWidth } from "../text/width.ts";
import { truncateStyled, wrapStyled } from "../text/wrap.ts";
import type { RegionFrame, Scheduler, TerminalOutput } from "./liveRegion.ts";
import { MIN_NAV_CONVERSATION, navBottomRows, navColumns, navUnavailable } from "./navPane.ts";
import { tasksUnavailable } from "./tasksPane.ts";
import { t } from "../i18n/index.ts";

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
  /** Cells of the thread list on the far left; 0 when it is not in that column. */
  readonly nav: number;
  /** Cells of the conversation column, the one next to the divider included. */
  readonly left: number;
  /** Cells of the side panel; 0 while the panel is closed. */
  readonly panel: number;
}

/**
 * The thread list (when it is in the left column) takes the far left, then a divider; the
 * conversation follows, then a divider and the panel; the last column is left empty so a full row
 * never sits in a pending-wrap state. With the panel closed the conversation takes everything but
 * that last column.
 */
export const splitLayout = (columns: number, side = true, nav = 0): SplitLayout => {
  const used = nav > 0 ? nav + 1 : 0;
  if (!side) return { nav, left: Math.max(10, columns - 1 - used), panel: 0 };
  const panel = Math.min(72, Math.max(36, Math.floor((columns - used) * 0.38)));
  return { nav, left: Math.max(10, columns - 2 - panel - used), panel };
};

/**
 * Where the thread list sits: in a column of its own on the left when the conversation keeps a
 * usable width beside it (the side panel counted), else under the conversation.
 */
export const navPlacement = (columns: number, side: boolean): "left" | "bottom" =>
  splitLayout(columns, side, navColumns(columns)).left >= MIN_NAV_CONVERSATION ? "left" : "bottom";

/** What the alternate screen is asked to show; each part has its own least size. */
export interface SplitParts {
  /** The side panel (`/dag-workflow`, `/dag-agents`). */
  readonly panel: boolean;
  /** The task list under the conversation (`/tasks`). */
  readonly tasks: boolean;
  /** The thread list (`/sidebar`), on the left or, in a narrow terminal, under the conversation. */
  readonly nav?: boolean;
}

/** Why the alternate screen cannot show `parts` at this size; null when it can. */
export const splitUnavailable = (
  columns: number,
  rows: number,
  parts: SplitParts = { panel: true, tasks: false },
): string | null => {
  if (parts.panel) {
    if (columns < MIN_SPLIT_COLUMNS) {
      return t("render.split.tooNarrow", { min: MIN_SPLIT_COLUMNS, now: columns });
    }
    if (rows < MIN_SPLIT_ROWS) {
      return t("render.split.tooShort", { min: MIN_SPLIT_ROWS, now: rows });
    }
  }
  if (parts.nav) {
    const why = navUnavailable(columns, rows);
    if (why !== null) return why;
  }
  return parts.tasks ? tasksUnavailable(columns, rows) : null;
};

interface HistoryEntry {
  readonly raw: string;
  /** `raw` folded to the conversation width; null until it is needed at the current width. */
  rows: string[] | null;
}

/** The pinned header of the conversation column: `lead` rows and the pet's `track` beside them. */
export interface PinnedHeader {
  readonly lead: ReadonlyArray<string>;
  readonly track: ReadonlyArray<string>;
  readonly trackWidth: number;
  /** The header's form in the scrollback, written ahead of the conversation when the layout is left. */
  readonly scrollback?: ReadonlyArray<string>;
}

interface Painted {
  readonly left: ReadonlyArray<string>;
  readonly headLead: ReadonlyArray<string>;
  readonly headTrack: ReadonlyArray<string>;
  readonly panel: ReadonlyArray<string>;
  readonly nav: ReadonlyArray<string>;
  readonly navCols: number;
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
  /** The thread list; null while it is off. */
  private navLines: ReadonlyArray<string> | null = null;
  /** Rows pinned above the conversation (logo and status); null while there are none. */
  private header: PinnedHeader | null = null;
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

  /** Whether the thread list is in a column of its own, and not under the conversation. */
  private navLeft(columns: number): boolean {
    return this.navLines !== null && navPlacement(columns, this.side) === "left";
  }

  /** Rows under the conversation: the thread list when it sits there, then the task list. */
  private bottomRows(columns: number): number {
    const nav = this.navLines !== null && !this.navLeft(columns) ? this.navLines.length : 0;
    return nav + this.taskLines.length;
  }

  private layout(columns: number): SplitLayout {
    return splitLayout(columns, this.side, this.navLeft(columns) ? navColumns(columns) : 0);
  }

  /** Tallest live frame the left column can hold; the viewport keeps a few rows above it. */
  maxRows(): number {
    const columns = this.out.columns();
    return Math.max(
      3,
      this.out.rows() - this.bottomRows(columns) - this.headerRows() - MIN_VIEWPORT_ROWS,
    );
  }

  /** Rows the header takes, never so many that the conversation has fewer than a few left. */
  private headerRows(): number {
    if (this.header === null) return 0;
    const room = this.out.rows() - this.bottomRows(this.out.columns()) - MIN_VIEWPORT_ROWS - 3;
    return Math.max(0, Math.min(this.header.lead.length, room));
  }

  /** Columns a line of the conversation may use. */
  usableColumns(): number {
    return Math.max(10, this.layout(this.out.columns()).left - 1);
  }

  /** Size of the side panel, for what is drawn in it. */
  panelSize(): { readonly columns: number; readonly rows: number } {
    return { columns: this.layout(this.out.columns()).panel, rows: this.out.rows() };
  }

  /** Where the thread list goes at this size and how big it is, for what is drawn in it. */
  navSize(): {
    readonly placement: "left" | "bottom";
    readonly columns: number;
    readonly rows: number;
  } {
    const columns = this.out.columns();
    const rows = this.out.rows();
    if (navPlacement(columns, this.side) === "left") {
      return { placement: "left", columns: navColumns(columns), rows };
    }
    const layout = splitLayout(columns, this.side);
    return {
      placement: "bottom",
      columns: Math.max(10, layout.left - 1),
      rows: navBottomRows(rows, this.taskLines.length > 0),
    };
  }

  /** What the alternate screen shows now, for the size check on a resize. */
  parts(): SplitParts {
    return { panel: this.side, tasks: this.taskLines.length > 0, nav: this.navLines !== null };
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
    if (this.header?.scrollback !== undefined) lines.unshift(...this.header.scrollback);
    if (this.omitted > 0) lines.unshift(t("render.split.omitted", { count: this.omitted }));
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
    this.navLines = null;
    this.header = null;
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

  /**
   * Pins rows above the conversation, or none with null. The same rows cause no paint; a change in
   * their number moves the conversation, so the whole screen is drawn again.
   */
  setHeader(header: PinnedHeader | null): void {
    const before = this.header;
    const same =
      header === null || before === null
        ? header === before
        : header.trackWidth === before.trackWidth &&
          header.lead.length === before.lead.length &&
          header.lead.every((l, i) => l === before.lead[i]) &&
          header.track.length === before.track.length &&
          header.track.every((l, i) => l === before.track[i]);
    if (same) return;
    const clean = (rows: ReadonlyArray<string>) =>
      rows.map((row) => stripControlSequences(row.replace(LINE_BREAK, " ")));
    if ((header?.lead.length ?? 0) !== (before?.lead.length ?? 0)) this.stale = true;
    if ((header?.trackWidth ?? 0) !== (before?.trackWidth ?? 0)) this.stale = true;
    this.header =
      header === null ? null : { ...header, lead: clean(header.lead), track: clean(header.track) };
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

  /**
   * Replaces the thread list; null turns it off, and any list turns it on, which changes the width
   * of the conversation and so draws the whole screen again. The same lines cause no paint.
   */
  setNav(lines: ReadonlyArray<string> | null): void {
    const next =
      lines === null
        ? null
        : lines.map((line) => stripControlSequences(line.replace(LINE_BREAK, " ")));
    const before = this.navLines;
    if (
      next !== null &&
      before !== null &&
      next.length === before.length &&
      next.every((l, i) => l === before[i])
    ) {
      return;
    }
    if (next === null || before === null) this.stale = true;
    this.navLines = next;
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
      rows[rows.length - 1] = truncateStyled(t("render.split.scrolling"), width);
    }
    return [...Array.from({ length: count - rows.length }, () => ""), ...rows];
  }

  private paint(): void {
    const columns = this.out.columns();
    const rows = this.out.rows();
    const side = this.side;
    const layout = this.layout(columns);
    const navCols = layout.nav;
    const x0 = navCols > 0 ? navCols + 1 : 0;
    const leftLimit = Math.max(10, layout.left - 1);
    // The thread list (when it is not in its own column) and the task list sit at the foot of the
    // conversation column; the conversation and its live frame have what is above them.
    const tasks = [
      ...(this.navLines !== null && navCols === 0 ? this.navLines : []),
      ...this.taskLines,
    ].slice(0, Math.max(0, rows - MIN_VIEWPORT_ROWS - 1));
    const head = this.headerRows();
    const trackWidth = head > 0 ? (this.header?.trackWidth ?? 0) : 0;
    const leadWidth = layout.left - trackWidth;
    // A row with no strip of its own runs the full width of the column.
    const stripped = (row: number) => trackWidth > 0 && row < (this.header?.track.length ?? 0);
    const headLead = Array.from({ length: head }, (_, row) => {
      const width = stripped(row) ? leadWidth : layout.left;
      return cell(truncateStyled(this.header?.lead[row] ?? "", Math.max(1, width)), width);
    });
    const headTrack = Array.from({ length: head }, (_, row) =>
      stripped(row)
        ? cell(truncateStyled(this.header?.track[row] ?? "", trackWidth), trackWidth)
        : "",
    );
    const leftRows = rows - tasks.length - head;
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
    left.unshift(...Array.from({ length: head }, () => ""));
    const nav =
      navCols > 0
        ? Array.from({ length: rows }, (_, row) =>
            cell(truncateStyled(this.navLines?.[row] ?? "", navCols), navCols),
          )
        : [];
    const panel = side
      ? Array.from({ length: rows }, (_, row) =>
          cell(truncateStyled(this.panelLines[row] ?? "", layout.panel), layout.panel),
        )
      : [];
    const divider = navCols > 0 || side ? this.divider() : "";
    const place =
      cursor === null
        ? null
        : {
            row: head + Math.min(leftRows - 1, top + cursor.row),
            col: x0 + Math.min(layout.left - 1, cursor.col),
          };

    const before = this.painted;
    let text = "";
    if (
      before === null ||
      this.stale ||
      before.columns !== columns ||
      before.rows !== rows ||
      before.side !== side ||
      before.navCols !== navCols
    ) {
      text += CLEAR_SCREEN;
      for (let row = 0; row < rows; row += 1) {
        if (navCols > 0) {
          text += at(row, 0) + (nav[row] as string) + RESET;
          text += at(row, navCols) + divider + RESET;
        }
        if (row < head) {
          text += at(row, x0) + (headLead[row] as string) + RESET;
          if (stripped(row)) text += at(row, x0 + leadWidth) + (headTrack[row] as string) + RESET;
        } else {
          text += at(row, x0) + (left[row] as string) + RESET;
        }
        if (!side) continue;
        text += at(row, x0 + layout.left) + divider + RESET;
        text += at(row, x0 + layout.left + 1) + (panel[row] as string) + RESET;
      }
    } else {
      for (let row = 0; row < rows; row += 1) {
        if (navCols > 0 && nav[row] !== before.nav[row]) {
          text += at(row, 0) + (nav[row] as string) + RESET;
        }
        if (navCols > 0 && divider !== before.divider) {
          text += at(row, navCols) + divider + RESET;
        }
        if (row < head) {
          if (headLead[row] !== before.headLead[row]) {
            text += at(row, x0) + (headLead[row] as string) + RESET;
          }
          if (stripped(row) && headTrack[row] !== before.headTrack[row]) {
            text += at(row, x0 + leadWidth) + (headTrack[row] as string) + RESET;
          }
        } else if (left[row] !== before.left[row]) {
          text += at(row, x0) + (left[row] as string) + RESET;
        }
        if (!side) continue;
        if (divider !== before.divider) text += at(row, x0 + layout.left) + divider + RESET;
        if (panel[row] !== before.panel[row]) {
          text += at(row, x0 + layout.left + 1) + (panel[row] as string) + RESET;
        }
      }
    }
    const sameCursor =
      before !== null && before.cursor?.row === place?.row && before.cursor?.col === place?.col;
    this.painted = {
      left,
      headLead,
      headTrack,
      panel,
      nav,
      navCols,
      divider,
      side,
      cursor: place,
      columns,
      rows,
    };
    this.stale = false;
    if (text === "" && sameCursor) return;
    const finish = place === null ? HIDE_CURSOR : at(place.row, place.col) + SHOW_CURSOR;
    this.out.write(SYNC_BEGIN + HIDE_CURSOR + text + finish + SYNC_END);
  }
}
