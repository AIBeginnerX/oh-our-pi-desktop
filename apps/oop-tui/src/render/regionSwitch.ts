import type { LiveRegion, RegionFrame, TerminalOutput } from "./liveRegion.ts";
import { splitUnavailable, type SplitParts, type SplitRegion } from "./splitRegion.ts";
import { t } from "../i18n/index.ts";

/** What a resize took out of the side-by-side layout: all of it, or only the optional parts. */
export type ClosedPart = "all" | "tasks" | "nav" | "tasksNav";

/** What the controller can do with the side-by-side layout. */
export interface SplitControl {
  readonly active: () => boolean;
  /** Why the layout with these parts cannot be used at this size; null when it can. */
  readonly unavailable: (parts: SplitParts) => string | null;
  /** Moves to the side-by-side layout. The caller checks `unavailable` first. */
  readonly enter: () => void;
  /** Back to the inline layout; what was said meanwhile goes into the scrollback. */
  readonly leave: () => void;
  /** Columns and rows of the side panel; no columns while it is closed. */
  readonly panel: () => { readonly columns: number; readonly rows: number };
  readonly setPanel: (lines: ReadonlyArray<string>) => void;
  /** Opens or closes the side panel while the layout is on; closed, the conversation has the whole width. */
  readonly setSide: (open: boolean) => void;
  /** Columns a line of the conversation may use and the terminal's rows, for the task list under it. */
  readonly leftSize: () => { readonly columns: number; readonly rows: number };
  /** The task list under the conversation; none when empty. */
  readonly setTasks: (lines: ReadonlyArray<string>) => void;
  /** Where the thread list goes at this size (a left column, or under the conversation) and how big it is. */
  readonly navSize: () => {
    readonly placement: "left" | "bottom";
    readonly columns: number;
    readonly rows: number;
  };
  /** The thread list; null turns it off. */
  readonly setNav: (lines: ReadonlyArray<string> | null) => void;
}

/**
 * Hands every region call to the inline `LiveRegion`, or to the `SplitRegion` while the side-by-side
 * layout is on. Moving between them keeps each line said exactly once: lines still queued inline are
 * written before the alternate screen is entered, and lines said inside it are written into the
 * scrollback, folded to the width then, when it is left. Whatever way the program ends, `restore`
 * (or `clear`) leaves the alternate screen first.
 */
export class RegionSwitch implements SplitControl {
  private readonly inline: LiveRegion;
  private readonly split: SplitRegion;
  private readonly out: TerminalOutput;
  private readonly onClosed: (reason: string, part: ClosedPart) => void;

  constructor(
    inline: LiveRegion,
    split: SplitRegion,
    out: TerminalOutput,
    options: { readonly onClosed: (reason: string, part: ClosedPart) => void },
  ) {
    this.inline = inline;
    this.split = split;
    this.out = out;
    this.onClosed = options.onClosed;
  }

  /**
   * The split also takes calls while it is suspended (Ctrl-Z): it writes nothing then, and keeps
   * what is said for the full redraw on resume. The inline region would draw on the normal screen
   * the shell owns.
   */
  private get current(): LiveRegion | SplitRegion {
    return this.split.isOn() || this.split.isSuspended() ? this.split : this.inline;
  }

  maxRows(): number {
    return this.current.maxRows();
  }

  usableColumns(): number {
    return this.current.usableColumns();
  }

  commit(lines: ReadonlyArray<string>): void {
    this.current.commit(lines);
  }

  set(frame: RegionFrame): void {
    this.current.set(frame);
  }

  flush(): void {
    this.current.flush();
  }

  abandon(): void {
    this.current.abandon();
  }

  hold(): void {
    this.current.hold();
  }

  /** PageUp in the side-by-side layout; the inline layout leaves scrolling to the terminal. */
  scrollUp(): void {
    this.split.scrollUp();
  }

  scrollDown(): void {
    this.split.scrollDown();
  }

  /** New input: the conversation goes back to the newest line. */
  follow(): void {
    this.split.follow();
  }

  /**
   * The size settled. A terminal that became too small for the side-by-side layout leaves it, and
   * the controller is told why.
   */
  release(): void {
    if (this.split.isOn() && !this.fits()) return;
    this.current.release();
  }

  /**
   * Whether the layout fits the size now. When only the task list or the thread list is too big
   * for it and something else the layout shows still fits, that part is folded and the rest stays;
   * otherwise the layout is left.
   */
  private fits(): boolean {
    const parts = this.split.parts();
    const reason = this.unavailable(parts);
    if (reason === null) return true;
    const folds: ReadonlyArray<{
      readonly tasks: boolean;
      readonly nav: boolean;
      readonly part: ClosedPart;
    }> = [
      { tasks: true, nav: false, part: "tasks" },
      { tasks: false, nav: true, part: "nav" },
      { tasks: true, nav: true, part: "tasksNav" },
    ];
    for (const fold of folds) {
      if ((fold.tasks && !parts.tasks) || (fold.nav && parts.nav !== true)) continue;
      const rest = {
        panel: parts.panel,
        tasks: parts.tasks && !fold.tasks,
        nav: parts.nav === true && !fold.nav,
      };
      if (!rest.panel && !rest.tasks && !rest.nav) continue;
      if (this.unavailable(rest) !== null) continue;
      if (fold.tasks) this.split.setTasks([]);
      if (fold.nav) this.split.setNav(null);
      const key =
        fold.part === "tasks"
          ? "render.region.tasksClosed"
          : fold.part === "nav"
            ? "render.region.navClosed"
            : "render.region.splitClosed";
      this.onClosed(t(key, { reason }), fold.part);
      return true;
    }
    this.leave();
    this.onClosed(t("render.region.splitClosed", { reason }), "all");
    return false;
  }

  // ---- the side-by-side layout ---------------------------------------------------------------

  active(): boolean {
    return this.split.isOn();
  }

  unavailable(parts: SplitParts): string | null {
    return splitUnavailable(this.out.columns(), this.out.rows(), parts);
  }

  enter(): void {
    if (this.split.isOn()) return;
    // The live region is erased first, with anything still queued, so the scrollback keeps it all.
    this.inline.clear();
    this.split.enter();
  }

  leave(): void {
    if (!this.split.isOn() && !this.split.isSuspended()) return;
    this.inline.commit(this.split.leave());
  }

  panel(): { readonly columns: number; readonly rows: number } {
    return this.split.panelSize();
  }

  setPanel(lines: ReadonlyArray<string>): void {
    this.split.setPanel(lines);
  }

  setSide(open: boolean): void {
    this.split.setSide(open);
  }

  leftSize(): { readonly columns: number; readonly rows: number } {
    return { columns: this.split.usableColumns(), rows: this.out.rows() };
  }

  setTasks(lines: ReadonlyArray<string>): void {
    this.split.setTasks(lines);
  }

  navSize(): {
    readonly placement: "left" | "bottom";
    readonly columns: number;
    readonly rows: number;
  } {
    return this.split.navSize();
  }

  setNav(lines: ReadonlyArray<string> | null): void {
    this.split.setNav(lines);
  }

  // ---- the ways out of the program -----------------------------------------------------------

  /** Erases the live region (or leaves the side-by-side layout) and writes what is pending. */
  clear(): void {
    this.leave();
    this.inline.clear();
  }

  /**
   * The normal way out: like `clear`, and from here the region writes nothing until `drain`, so
   * nothing that finishes while the process waits for the server can redraw over the shell.
   */
  close(): void {
    this.clear();
    this.inline.close();
  }

  /** After the wait: what was said since `close` goes into the scrollback, once. */
  drain(): void {
    this.inline.drain();
  }

  /**
   * The last thing on every way out, including a crash: the alternate screen is left and what was
   * said inside it reaches the scrollback. Does nothing when the layout is not on.
   */
  restore(): void {
    if (!this.split.isOn() && !this.split.isSuspended()) return;
    this.leave();
    this.inline.flush();
  }

  /** Ctrl-Z: the terminal is handed back; the side-by-side conversation is kept for `resume`. */
  suspend(): void {
    if (this.split.isOn()) this.split.suspend();
    else this.inline.clear();
  }

  /**
   * After the process continues: the layout it was in is drawn whole. The terminal may have been
   * resized while the process was stopped, so the split checks the size again and, if it no longer
   * fits, hands its lines to the scrollback instead.
   */
  resume(): void {
    if (!this.split.isSuspended()) {
      this.current.invalidate();
      return;
    }
    if (this.fits()) this.split.resume();
  }
}
