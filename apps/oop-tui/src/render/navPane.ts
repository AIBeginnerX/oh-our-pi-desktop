import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import type { Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { t } from "../i18n/index.ts";

/** Narrowest and shortest terminal the thread list is offered in, in either place. */
export const MIN_NAV_COLUMNS = 30;
export const MIN_NAV_ROWS = 12;
/** Least width the conversation keeps beside a thread list in the left column. */
export const MIN_NAV_CONVERSATION = 44;

/** Why the thread list cannot be used at this size; null when it can. */
export const navUnavailable = (columns: number, rows: number): string | null => {
  if (rows < MIN_NAV_ROWS) return t("render.nav.tooShort", { min: MIN_NAV_ROWS, now: rows });
  if (columns < MIN_NAV_COLUMNS) {
    return t("render.nav.tooNarrow", { min: MIN_NAV_COLUMNS, now: columns });
  }
  return null;
};

/** Cells of the left column; the divider after it is not counted. */
export const navColumns = (terminalColumns: number): number =>
  Math.min(34, Math.max(24, Math.floor(terminalColumns * 0.24)));

/** Rows of the list when it sits under the conversation, its rule included. */
export const navBottomRows = (terminalRows: number, tasksShown: boolean): number =>
  tasksShown ? 4 : Math.min(8, Math.max(5, Math.floor(terminalRows / 4)));

/** How a thread stands in the list, in the order the desktop row decides it. */
export type NavStatus =
  | "working"
  | "monitoring"
  | "approval"
  | "input"
  | "failed"
  | "woke"
  | "unread"
  | "ready";

export type NavSection = "pinned" | "active" | "snoozed" | "settled";

/** One entry of the list; the section labels are not picked, everything else is. */
export type NavItem =
  /** The action that starts a thread. */
  | { readonly kind: "new"; readonly key: string; readonly current: boolean }
  /** A label before the pinned or the active threads. */
  | { readonly kind: "section"; readonly key: string; readonly section: "pinned" | "active" }
  /** The header of the snoozed or settled shelf, which opens and closes. */
  | {
      readonly kind: "shelf";
      readonly key: string;
      readonly section: "snoozed" | "settled";
      readonly count: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly id: string;
      /** The project the thread is in; null when the shell does not list it. */
      readonly project: string | null;
      readonly title: string;
      readonly status: NavStatus;
      /** Working time, wake time or age, already short (`3m`); empty when there is none. */
      readonly since: string;
      readonly pinned: boolean;
      /** The thread the conversation shows now. */
      readonly current: boolean;
      /** Crew tasks folded under this thread. */
      readonly crew: number;
      readonly section: NavSection;
    }
  /** The row that shows more of a shelf. */
  | { readonly kind: "more"; readonly key: string; readonly count: number };

export const isPickable = (item: NavItem): boolean => item.kind !== "section";

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

/** Rows a thread takes in the roomy form (project over title) and in the compact one (title only). */
const ROOMY_MIN_ROWS = 16;

const STATUS_KEY = {
  working: "render.nav.status.working",
  monitoring: "render.nav.status.monitoring",
  approval: "render.nav.status.approval",
  input: "render.nav.status.input",
  failed: "render.nav.status.failed",
  woke: "render.nav.status.woke",
  unread: "render.nav.status.unread",
} as const satisfies Record<Exclude<NavStatus, "ready">, string>;

const SHELF_KEY = {
  snoozed: { open: "render.nav.shelf.snoozed", closed: "render.nav.shelfClosed.snoozed" },
  settled: { open: "render.nav.shelf.settled", closed: "render.nav.shelfClosed.settled" },
} as const;

/** The mark and colour of a status; `ready` has none and shows only its age. */
const statusPaint = (
  status: NavStatus,
  theme: Theme,
  symbols: Symbols,
): { readonly mark: string; readonly paint: (text: string) => string } => {
  switch (status) {
    case "working":
      return { mark: symbols.flow.running, paint: theme.accent };
    case "monitoring":
      return { mark: symbols.flow.paused, paint: theme.info };
    case "approval":
      return { mark: symbols.warning, paint: theme.warning };
    case "input":
      return { mark: "?", paint: theme.brand };
    case "failed":
      return { mark: symbols.flow.failed, paint: theme.error };
    case "woke":
      return { mark: symbols.bullet, paint: theme.warning };
    case "unread":
      return { mark: symbols.bullet, paint: theme.success };
    default:
      return { mark: " ", paint: theme.dim };
  }
};

/** `left` and `right` on one row of `columns` cells; `right` keeps its place and `left` is cut to fit. */
const split = (left: string, right: string, columns: number): string => {
  const rightWidth = visibleWidth(right);
  const room = Math.max(1, columns - rightWidth - (right === "" ? 0 : 1));
  const cut = truncateStyled(left, room);
  const gap = Math.max(right === "" ? 0 : 1, columns - visibleWidth(cut) - rightWidth);
  return `${cut}${" ".repeat(gap)}${right}`;
};

/**
 * The lines of one entry. A thread is two lines in the roomy form, as on the desktop (the project
 * and its status over the title), one in the compact form (title and status). `picked` puts the
 * pointer in front of it.
 */
const linesOf = (
  item: NavItem,
  options: {
    readonly columns: number;
    readonly theme: Theme;
    readonly symbols: Symbols;
    readonly picked: boolean;
    readonly compact: boolean;
  },
): string[] => {
  const { theme, symbols, columns, picked, compact } = options;
  const cursor = picked ? theme.accent(symbols.prompt) : " ";
  switch (item.kind) {
    case "new": {
      const text = `${theme.brand("+")} ${picked ? theme.accent.bold(t("render.nav.new")) : item.current ? theme.text.bold(t("render.nav.new")) : theme.text(t("render.nav.new"))}`;
      return [`${cursor}${item.current ? theme.brand(symbols.rail.active) : " "}  ${text}`];
    }
    case "section":
      return [
        `  ${theme.dim(t(item.section === "pinned" ? "render.nav.section.pinned" : "render.nav.section.active"))}`,
      ];
    case "shelf": {
      const chevron = item.open ? symbols.fold.open : symbols.fold.closed;
      const label = t(SHELF_KEY[item.section][item.open ? "open" : "closed"], {
        count: item.count,
      });
      return [
        `${cursor}  ${theme.muted(chevron)} ${picked ? theme.accent.bold(label) : theme.muted(label)}`,
      ];
    }
    case "more":
      return [
        `${cursor}  ${theme.muted("+")} ${picked ? theme.accent(t("render.nav.more", { count: item.count })) : theme.muted(t("render.nav.more", { count: item.count }))}`,
      ];
    case "thread": {
      const here = item.current ? theme.brand(symbols.rail.active) : " ";
      const { mark, paint } = statusPaint(item.status, theme, symbols);
      const lead = `${cursor}${here}${item.status === "ready" ? " " : paint(mark)} `;
      const label =
        item.status === "ready"
          ? theme.dim(item.since)
          : paint(
              item.status === "working" && item.since !== ""
                ? `${t(STATUS_KEY.working)} ${item.since}`
                : t(STATUS_KEY[item.status]),
            );
      // A status word is never cut for the project's sake, but it may not eat the whole row.
      const right = truncateStyled(label, Math.max(4, Math.floor(columns / 2)));
      const receded =
        item.status === "working" || item.status === "monitoring" || item.status === "ready";
      const title = oneLine(item.title);
      const name = picked
        ? theme.accent.bold(title)
        : item.current
          ? theme.text.bold(title)
          : receded
            ? theme.muted(title)
            : theme.text(title);
      const crew = item.crew > 0 ? theme.dim(` ${t("render.nav.crew", { count: item.crew })}`) : "";
      const pin = item.pinned ? theme.dim(` ${t("render.nav.pinned")}`) : "";
      if (compact) return [`${lead}${split(`${name}${pin}${crew}`, right, columns - 4)}`];
      const project = item.project === null ? "" : theme.dim(oneLine(item.project));
      return [
        `${lead}${split(`${project}${pin}`, right, columns - 4)}`,
        `    ${truncateStyled(`${name}${crew}`, columns - 4)}`,
      ];
    }
  }
};

/**
 * The thread list, exactly `rows` rows of at most `columns` cells, built like the desktop app's
 * sidebar: a rule with the title, the new-thread action, the pinned threads and then the active
 * ones (each a project line with its status or age, and the title under it), and the snoozed and
 * settled shelves with their counts. `❯` marks the pick while the list has the keys, `◆` the thread
 * on screen. More entries than room scroll to keep the pick (or, without focus, the current thread)
 * in view, the rest counted in `… N개`; the last row names the keys.
 */
export const renderNavPane = (
  list: ReadonlyArray<NavItem>,
  options: {
    readonly columns: number;
    readonly rows: number;
    readonly theme: Theme;
    readonly symbols: Symbols;
    /** The list has the keys. */
    readonly focused: boolean;
    /** Index in `list` of the pick. */
    readonly selected: number;
    /** Threads still being read from the server. */
    readonly loading: boolean;
    /** The shell lists no project at all. */
    readonly noProjects?: boolean;
  },
): string[] => {
  const { theme, symbols, columns, rows, focused, selected } = options;
  const lead = `${theme.border(symbols.rule.repeat(2))} ${(focused ? theme.accent : theme.brand).bold(t("render.nav.title"))} `;
  const header = `${lead}${theme.border(symbols.rule.repeat(Math.max(0, columns - visibleWidth(lead))))}`;
  const hint = theme.dim(t(focused ? "render.nav.hintFocus" : "render.nav.hintIdle"));
  const lines = [header];
  const room = Math.max(1, rows - 2);
  const compact = rows < ROOMY_MIN_ROWS;
  const threads = list.some((item) => item.kind === "thread");
  if (list.length === 0) {
    lines.push(theme.dim(t(options.loading ? "render.nav.loading" : "render.nav.empty")));
  } else {
    const drawn = list.map((item, index) =>
      linesOf(item, {
        columns,
        theme,
        symbols,
        picked: focused && index === selected,
        compact,
      }),
    );
    const focus = focused
      ? selected
      : Math.max(
          0,
          list.findIndex((item) => item.kind === "thread" && item.current),
        );
    // Grow a window of entries around the focus while it fits, a row kept for each cut end.
    const height = (from: number, to: number) => {
      let rowsUsed = (from > 0 ? 1 : 0) + (to < list.length ? 1 : 0);
      for (let i = from; i < to; i += 1) rowsUsed += (drawn[i] as string[]).length;
      return rowsUsed;
    };
    let start = Math.min(focus, list.length - 1);
    let end = start + 1;
    for (let grew = true; grew;) {
      grew = false;
      if (end < list.length && height(start, end + 1) <= room) {
        end += 1;
        grew = true;
      }
      if (start > 0 && height(start - 1, end) <= room) {
        start -= 1;
        grew = true;
      }
    }
    if (start > 0) lines.push(theme.dim(t("render.moreAbove", { count: start })));
    for (let i = start; i < end; i += 1) lines.push(...(drawn[i] as string[]));
    if (!threads) {
      lines.push(
        theme.dim(t(options.noProjects === true ? "render.nav.noProjects" : "render.nav.empty")),
      );
    }
    if (end < list.length)
      lines.push(theme.dim(t("render.moreBelow", { count: list.length - end })));
  }
  const shown = lines.slice(0, Math.max(1, rows - 1)).map((line) => truncateStyled(line, columns));
  while (shown.length < rows - 1) shown.push("");
  shown.push(truncateStyled(hint, columns));
  return shown.slice(0, rows);
};
