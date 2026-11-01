import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { windowOf } from "./tasksPane.ts";
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

/** How a thread stands in the list. */
export type NavStatus = "running" | "waiting" | "idle";

export interface NavRow {
  /** Null for the row that starts a new thread. */
  readonly id: string | null;
  readonly label: string;
  readonly status: NavStatus;
  readonly pinned: boolean;
  /** The thread the conversation shows now. */
  readonly current: boolean;
}

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

/**
 * The thread list, exactly `rows` rows of at most `columns` cells: a rule with the title, one row
 * per thread (`❯` marks the pick while the list has the keys, `◆` the thread on screen, `◐` one at
 * work, `▲` one that waits for the user), and a last row naming the keys. More threads than room
 * scroll to keep the pick (or, without focus, the current thread) in view.
 */
export const renderNavPane = (
  list: ReadonlyArray<NavRow>,
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
  },
): string[] => {
  const { theme, symbols, columns, rows, focused, selected } = options;
  const lead = `${theme.border(symbols.rule.repeat(2))} ${(focused ? theme.accent : theme.brand).bold(t("render.nav.title"))} `;
  const header = `${lead}${theme.border(symbols.rule.repeat(Math.max(0, columns - visibleWidth(lead))))}`;
  const hint = theme.dim(t(focused ? "render.nav.hintFocus" : "render.nav.hintIdle"));
  const lines = [header];
  if (list.length === 0) {
    lines.push(theme.dim(t(options.loading ? "render.nav.loading" : "render.nav.empty")));
  } else {
    const room = Math.max(1, rows - 2);
    const focus = focused
      ? selected
      : Math.max(
          0,
          list.findIndex((row) => row.current),
        );
    const { start, size } = windowOf(list.length, focus, room);
    if (start > 0) lines.push(theme.dim(t("render.moreAbove", { count: start })));
    list.slice(start, start + size).forEach((row, offset) => {
      const picked = focused && start + offset === selected;
      const cursor = picked ? theme.accent(symbols.prompt) : " ";
      const here = row.current ? theme.brand(symbols.rail.active) : " ";
      const state =
        row.status === "running"
          ? theme.accent(symbols.flow.running)
          : row.status === "waiting"
            ? theme.warning(symbols.warning)
            : " ";
      const text = oneLine(row.label);
      const name = picked
        ? theme.accent.bold(text)
        : row.current
          ? theme.text.bold(text)
          : row.id === null
            ? theme.muted(text)
            : theme.text(text);
      const pin = row.pinned ? ` ${theme.dim(t("render.nav.pinned"))}` : "";
      lines.push(`${cursor}${here}${state} ${name}${pin}`);
    });
    const below = list.length - start - size;
    if (below > 0) lines.push(theme.dim(t("render.moreBelow", { count: below })));
  }
  const shown = lines.slice(0, Math.max(1, rows - 1)).map((line) => truncateStyled(line, columns));
  while (shown.length < rows - 1) shown.push("");
  shown.push(truncateStyled(hint, columns));
  return shown.slice(0, rows);
};
