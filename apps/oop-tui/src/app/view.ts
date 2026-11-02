import { layoutInput, type EditorState, type InputLayout } from "../input/editor.ts";
import { maskEditor } from "./textPrompt.ts";
import type { LinkStatus } from "../link/client.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { renderAgents, renderPlan } from "../render/panels.ts";
import {
  packHint,
  RAIL_COLUMNS,
  railActive,
  railChoice,
  railEnd,
  railGap,
  railRow,
  railRule,
  railWrap,
  type Rail,
  type RailTone,
} from "../render/rail.ts";
import { renderWorkRow } from "../render/spinner.ts";
import { renderStatusBar, type StatusBarInput } from "../render/statusBar.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { shellCommand } from "../render/toolLine.ts";
import type { StatusLineSetting } from "../settings.ts";
import type { ThreadStatus } from "../state/threadStatus.ts";
import { sanitizeForTerminal, stringWidth } from "../text/width.ts";
import { padEndVisible, truncateStyled, wrapStyled } from "../text/wrap.ts";
import { windowAround } from "./projects.ts";
import { t } from "../i18n/index.ts";

export interface PickerItem {
  readonly label: string;
  /** Dim, after the name; cut first when the row is narrow. */
  readonly note?: string;
}

export interface PickerView {
  /** The question the list answers. */
  readonly title: string;
  readonly items: ReadonlyArray<PickerItem>;
  readonly selected: number;
  readonly hint: string;
  readonly empty: string;
  /** Rows between the question and the list, already styled: a search line, for one. */
  readonly before?: ReadonlyArray<string>;
}

/** Cleaned text on a single row: a field that must not span lines never carries a line feed. */
const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\n/gu, " ");

/** A one-line warning above the rail: the connection, a refused key, a failed turn. */
export const noticeLine = (rail: Rail, text: string, tone: RailTone = "warning"): string => {
  const { theme } = rail.style;
  const paint = tone === "error" ? theme.error : theme.warning;
  return `${paint(rail.symbols.warning)}  ${text}`;
};

/** Most rows a notice takes; what does not fit in them is cut from the end. */
const NOTICE_ROWS = 3;

/**
 * A notice above the rail folded to the terminal, `width` counting the mark: the way out of a
 * refusal is usually the end of the sentence, so a narrow terminal gets more rows (three at most)
 * instead of a cut line.
 */
export const noticeRows = (rail: Rail, text: string, tone: RailTone, width: number): string[] => {
  const room = Math.max(1, width - RAIL_COLUMNS);
  const folded = wrapStyled(text, room);
  const rows =
    folded.length <= NOTICE_ROWS
      ? folded
      : [
          ...folded.slice(0, NOTICE_ROWS - 1),
          truncateStyled(folded.slice(NOTICE_ROWS - 1).join(" "), room),
        ];
  const [first = "", ...rest] = rows;
  return [noticeLine(rail, first, tone), ...rest.map((row) => `${" ".repeat(RAIL_COLUMNS)}${row}`)];
};

/** A list of choices on the rail: `◆ question`, `● selected`, `○ others`, hint, and the end of the rail. */
export const renderPicker = (
  view: PickerView,
  columns: number,
  rows: number,
  style: Style,
  symbols: Symbols,
  banner: string | null,
  bannerTone: RailTone = "warning",
): RegionFrame => {
  const rail: Rail = { style, symbols };
  const { theme } = style;
  const width = Math.max(10, columns - 1);
  const lines: string[] = [];
  if (banner !== null) lines.push(...noticeRows(rail, banner, bannerTone, width));
  const bannerRows = lines.length;
  lines.push(railGap(rail, "active"));
  const question = theme.text.bold(view.title);
  if (view.items.length === 0) {
    lines.push(
      railActive(rail, question),
      ...(view.before ?? []).map((row) =>
        railRow(rail, truncateStyled(row, width - RAIL_COLUMNS), "active"),
      ),
      railRow(rail, theme.dim(view.empty), "active"),
      railRow(rail, theme.dim(truncateStyled(view.hint, width - RAIL_COLUMNS)), "active"),
      railEnd(rail, "", "active"),
    );
    return { lines: pinBanner(lines, bannerRows, rows), cursor: null };
  }
  // What is not a list row: the lines above, the question, the end row, the two "more" markers and
  // the hint, which a narrow terminal folds onto several rows.
  const hintRows = packHint(view.hint, width - RAIL_COLUMNS).length;
  // Short of room, the options come first; the rows before them lose their first rows, since what
  // such a row ends with (the undo warning) is what must stay, but never the last row itself.
  const before = view.before ?? [];
  const roomForBefore = rows - (lines.length + 2 + 2 + hintRows) - view.items.length;
  const shownBefore = before.slice(
    before.length - Math.max(Math.min(1, before.length), Math.min(before.length, roomForBefore)),
  );
  const chrome = lines.length + 2 + 2 + hintRows + shownBefore.length;
  const { start, end } = windowAround(view.selected, view.items.length, Math.max(1, rows - chrome));
  lines.push(
    ...railChoice(rail, {
      question,
      ...(view.before === undefined ? {} : { before: shownBefore }),
      options: view.items.slice(start, end).map((item) => ({
        label: oneLine(item.label),
        ...(item.note ? { note: oneLine(item.note) } : {}),
      })),
      selected: view.selected - start,
      hint: view.hint,
      width,
      tone: "active",
      hidden: { above: start, below: view.items.length - end },
    }),
    railEnd(rail, "", "active"),
  );
  return { lines: pinBanner(lines, bannerRows, rows), cursor: null };
};

export interface TextPromptView {
  /** The question the text answers. */
  readonly title: string;
  readonly editor: EditorState;
  /** Dim words in the empty field that say what to type. */
  readonly placeholder: string;
  readonly hint: string;
  /** Rows between the question and the field, already styled: what is being confirmed, for one. */
  readonly before?: ReadonlyArray<string>;
  /** Draws this instead of each character typed, for a secret. */
  readonly mask?: string;
}

/** A question answered by typing: `◆ question`, the field on the rail, the keys, and the end of the rail. */
export const renderTextPrompt = (
  view: TextPromptView,
  columns: number,
  style: Style,
  symbols: Symbols,
  banner: string | null,
  bannerTone: RailTone = "warning",
  rows?: number,
): RegionFrame => {
  const rail: Rail = { style, symbols };
  const { theme } = style;
  const width = Math.max(10, columns - 1);
  const inner = Math.max(2, width - RAIL_COLUMNS);
  const layout = layoutInput(
    view.mask === undefined ? view.editor : maskEditor(view.editor, view.mask),
    inner,
  );
  const lines: string[] = [];
  if (banner !== null) lines.push(...noticeRows(rail, banner, bannerTone, width));
  const bannerRows = lines.length;
  lines.push(railGap(rail, "active"), railActive(rail, theme.text.bold(view.title)));
  for (const row of view.before ?? []) {
    lines.push(railRow(rail, truncateStyled(row, inner), "active"));
  }
  const composerStart = lines.length;
  const empty = layout.rows.length === 1 && layout.rows[0] === "";
  layout.rows.forEach((row, index) => {
    const text = index === 0 && empty ? theme.dim(truncateStyled(view.placeholder, inner)) : row;
    lines.push(railRow(rail, text, "active"));
  });
  for (const row of packHint(view.hint, inner)) lines.push(railRow(rail, theme.dim(row), "active"));
  lines.push(railEnd(rail, "", "active"));
  const cursorRow = composerStart + layout.cursor.row;
  if (rows === undefined) {
    return { lines, cursor: { row: cursorRow, col: RAIL_COLUMNS + layout.cursor.col } };
  }
  // A long answer pushes the top off the screen; the warning stays and the cursor follows its row.
  const pinned = pinBanner(lines, bannerRows, rows);
  const lost = lines.length - pinned.length;
  const row = bannerRows > 0 && lost > 0 ? Math.max(bannerRows, cursorRow - lost) : cursorRow;
  return { lines: pinned, cursor: { row, col: RAIL_COLUMNS + layout.cursor.col } };
};

/** A picker too tall for the terminal loses its own top rows, never the `kept` warning rows above it. */
const pinBanner = (lines: string[], kept: number, rows: number): string[] =>
  kept === 0 || lines.length <= rows
    ? lines
    : [...lines.slice(0, kept), ...lines.slice(lines.length - Math.max(0, rows - kept))];

/** A command the slash menu offers: `/model` and what it does. */
export interface SlashMenuItem {
  readonly label: string;
  readonly note: string;
  /** Marks a command of the provider, which is not ours: `provider` or `skill`. */
  readonly tag?: string;
  /** What picking the item writes into the composer without running it (the provider's own commands). */
  readonly fill?: string;
}

export interface SlashMenuView {
  /** Every command the typed text could become; empty says nothing matches. */
  readonly items: ReadonlyArray<SlashMenuItem>;
  readonly selected: number;
  /** What the menu says when nothing matches; Enter sends the text as a message unless this says otherwise. */
  readonly noMatch?: string;
}

/** The most commands the menu shows at once. */
export const SLASH_MENU_ROWS = 6;

/** Messages waiting for their turn, as they show above the composer. */
export interface QueueView {
  readonly items: ReadonlyArray<string>;
  /** Why the queue is not sending by itself, in words; null while it is just waiting for the turn. */
  readonly held: string | null;
}

export interface ChatView {
  readonly queue?: QueueView | null;
  readonly partial: ReadonlyArray<string>;
  /** An approval or question panel, already on the rail; it has no closing row. */
  readonly panel: ReadonlyArray<string>;
  readonly status: ThreadStatus | null;
  readonly link: LinkStatus;
  readonly now: number;
  readonly loading: boolean;
  readonly notice: string | null;
  readonly sending: boolean;
  readonly editor: EditorState;
  /** Dim words in the empty composer that say what to type. */
  readonly placeholder: string;
  /** The composer is replaced by a panel that answers with single keys. */
  readonly composerEnabled: boolean;
  /** Commands under the composer while it holds a half-typed `/command`; null when there is no menu. */
  readonly menu: SlashMenuView | null;
  readonly style: Style;
  readonly symbols: Symbols;
  readonly animations: boolean;
  /** Which frame the animation timer is on. */
  readonly tick: number;
  /** When the running turn began, and when the server last said anything about it (epoch ms). */
  readonly turnStartedAt: number | null;
  readonly lastEventAt: number | null;
  readonly planCollapsed: boolean;
  /** The task list has a pane of its own, so the plan of the running turn is not drawn here again. */
  readonly planHidden?: true;
  readonly bar: StatusBarInput;
  readonly barSetting: StatusLineSetting;
}

/** The first line of a server's explanation, safe to print. The row it goes on cuts it to the terminal. */
const firstLine = (value: string): string => oneLine(value.split("\n")[0] ?? "");

/**
 * What to do about a refused connection. The causes need different fixes, so each gets its own
 * line: a rejected token is renewed by starting `oop` again (same computer) or by a new pairing
 * link (a server given with --server), while a protocol mismatch is fixed by updating, never by
 * pairing again. A cause that was not named gets no advice rather than a wrong one.
 */
const blockedAdvice = (reason: string | undefined): string | null => {
  if (reason === "authentication") {
    return t("session.link.authRejected");
  }
  if (reason === "unsupported") {
    return t("session.link.unsupported");
  }
  return null;
};

/** The one-line notice shown whenever the link is not simply online; null when it is. */
export const linkNotice = (link: LinkStatus, now: number, style: Style): string | null => {
  const { theme } = style;
  if (link.phase === "blocked") {
    const advice = blockedAdvice(link.reason);
    const detail = firstLine(link.detail ?? "");
    if (advice === null) {
      return theme.error(
        t("session.link.refusedNoAdvice", { detail: detail || t("session.link.cannotConnect") }),
      );
    }
    return theme.error(
      t("session.link.refusedAdvice", { advice, detail: detail ? ` · ${detail}` : "" }),
    );
  }
  if (link.phase === "reconnecting" || link.phase === "connecting") {
    if (link.phase === "connecting") return theme.warning(t("session.link.connecting"));
    const wait =
      link.retryAt !== null
        ? t("session.link.retryIn", {
            seconds: Math.max(0, Math.ceil((link.retryAt - now) / 1000)),
          })
        : "";
    // The reason comes last: the countdown above it changes width, and a narrow terminal cuts the tail.
    const why = firstLine(link.detail ?? "");
    return theme.warning(
      t("session.link.disconnected", {
        wait,
        attempt: link.attempt,
        why: why ? ` — ${why}` : "",
      }),
    );
  }
  return null;
};

/** Whether the link, or the thread's session, is broken enough to show the mark in the error colour. */
const noticeTone = (view: ChatView): RailTone =>
  view.link.phase === "blocked" || (view.link.phase === "online" && view.status?.phase === "error")
    ? "error"
    : "warning";

/**
 * The rows above the rail that say what is off: a broken link, a failed session, or why the last
 * key did nothing. It is absent when all is well. The bar under the composer keeps showing the model
 * and folder throughout.
 */
const stateLine = (view: ChatView, rail: Rail, width: number): string[] | null => {
  const { theme } = view.style;
  const banner = linkNotice(view.link, view.now, view.style);
  const parts: string[] = [];
  if (banner !== null) {
    // The banner says what is wrong with the link; the notice still says why the last key did nothing.
    if (view.notice) parts.push(view.notice);
    parts.push(banner);
  } else {
    if (view.status?.phase === "error") {
      const why = view.status.lastError ? `: ${firstLine(view.status.lastError)}` : "";
      parts.push(theme.error(t("session.view.error", { why })));
    }
    if (view.notice) parts.push(view.notice);
  }
  return parts.length === 0
    ? null
    : noticeRows(rail, parts.join(theme.dim(" · ")), noticeTone(view), width);
};

/** The widest the name column of the slash menu gets, so one long skill name leaves room for its note. */
const MENU_LABEL_MAX = 28;

/** Rows of the slash menu, `room` of them at most, with the selected command always among them. */
const menuRows = (menu: SlashMenuView, rail: Rail, width: number, room: number): string[] => {
  const { theme } = rail.style;
  if (menu.items.length === 0) {
    return railWrap(
      rail,
      theme.dim(menu.noMatch ?? t("session.view.noMatch")),
      width,
      "active",
    ).slice(0, room);
  }
  const { start, end } = windowAround(menu.selected, menu.items.length, room);
  const labelWidth = Math.min(
    MENU_LABEL_MAX,
    Math.max(...menu.items.slice(start, end).map((item) => stringWidth(item.label))),
  );
  return menu.items.slice(start, end).map((item, offset) => {
    const chosen = start + offset === menu.selected;
    const mark = chosen
      ? theme.success(rail.symbols.rail.radioOn)
      : theme.dim(rail.symbols.rail.radioOff);
    const label = padEndVisible(truncateStyled(item.label, labelWidth), labelWidth);
    const tag = item.tag === undefined ? "" : `${theme.accent(`[${item.tag}]`)} `;
    const text = `${mark} ${chosen ? theme.text.bold(label) : theme.dim(label)}  ${tag}${theme.dim(item.note)}`;
    return railRow(rail, truncateStyled(text, width - RAIL_COLUMNS), "active");
  });
};

/** Most rows the composer takes on a tall screen; more text scrolls inside it, following the cursor. */
const COMPOSER_MAX_ROWS = 10;

/**
 * The rows of the composer that are drawn. A long paste (thousands of rows) is not laid out on the
 * screen: a window of rows follows the cursor, with a line above and below that say how much is
 * out of sight. Text that fits is drawn whole.
 */
const composerWindow = (
  layout: InputLayout,
  maxRows: number,
): { rows: ReadonlyArray<string>; above: number; below: number; cursorRow: number } => {
  const room = Math.max(3, Math.min(COMPOSER_MAX_ROWS, Math.floor(maxRows / 3)));
  if (layout.rows.length <= room) {
    return { rows: layout.rows, above: 0, below: 0, cursorRow: layout.cursor.row };
  }
  const { start, end } = windowAround(layout.cursor.row, layout.rows.length, room);
  return {
    rows: layout.rows.slice(start, end),
    above: start,
    below: layout.rows.length - end,
    cursorRow: layout.cursor.row - start,
  };
};

/** Rows the composer takes on screen, the lines about hidden text included. */
export const composerHeight = (editor: EditorState, inner: number, maxRows: number): number => {
  const shown = composerWindow(layoutInput(editor, inner), maxRows);
  return shown.rows.length + (shown.above > 0 ? 1 : 0) + (shown.below > 0 ? 1 : 0);
};

/** Most waiting messages that get a row of their own; the rest are counted in the title. */
const QUEUE_ROWS = 3;

/** `N queued` and the first words of the next messages; `room` rows at most, the title always first. */
const queueRows = (
  queue: QueueView,
  rail: Rail,
  width: number,
  room: number,
  pullBack: boolean,
): string[] => {
  const { theme } = rail.style;
  const inner = width - RAIL_COLUMNS;
  // The arrow belongs to the panel while one waits for an answer, so it pulls nothing back then.
  const pull = pullBack ? t("session.view.pullBack") : "";
  const title =
    queue.held === null
      ? t("session.view.queueIdle", { count: queue.items.length, pull })
      : t("session.view.queueHeld", { count: queue.items.length, held: queue.held, pull });
  const shown = Math.min(QUEUE_ROWS, queue.items.length, Math.max(0, room - 1));
  const rows = [railRow(rail, theme.warning(truncateStyled(title, inner)), "idle")];
  queue.items.slice(0, shown).forEach((item, index) => {
    const first = oneLine(item.split("\n")[0] ?? "");
    const more = item.includes("\n") ? " …" : "";
    rows.push(
      railRow(rail, theme.userFg(truncateStyled(`${index + 1}. ${first}${more}`, inner)), "idle"),
    );
  });
  return rows.slice(0, room);
};

/** The rail tone of the prompt: what the connection and the thread are doing right now. */
const promptTone = (view: ChatView): RailTone => {
  const { phase } = view.link;
  if (phase === "blocked" || phase === "reconnecting") return "error";
  if (view.status?.phase === "approval") return "warning";
  if (view.status?.phase === "working") return "idle";
  return "active";
};

/**
 * The live region of a chat, top to bottom: the unfinished reply, the plan and sub-agents of the
 * running turn, a line of state, then the prompt on the rail: a gap, `◆ Message` (the work row while a
 * turn runs, nothing when a panel asks something instead), the panel, the composer between two
 * lines of the theme, the slash menu under it, and the status bar as the end of the rail. When the
 * screen is short the menu shrinks first, then the state line and the gap go, then the plan and
 * agents, then the reply tail; the panel, the composer and the bar are never traded away. The two
 * lines round the composer are kept before the menu, the title and the gap are.
 */
export const renderChat = (view: ChatView, columns: number, maxRows: number): RegionFrame => {
  const { style, symbols } = view;
  const { theme } = style;
  const rail: Rail = { style, symbols };
  const width = Math.max(10, columns - 1);
  const status = view.status;
  const working = status?.phase === "working";
  const tone = promptTone(view);

  const state = stateLine(view, rail, width);
  const work = working
    ? renderWorkRow(
        {
          theme,
          symbols,
          tick: view.tick,
          animations: view.animations,
          tool: status.runningTool,
          detail: status.runningToolDetail === null ? null : shellCommand(status.runningToolDetail),
          elapsedMs: view.turnStartedAt === null ? 0 : Math.max(0, view.now - view.turnStartedAt),
          silentMs: view.lastEventAt === null ? 0 : Math.max(0, view.now - view.lastEventAt),
          interruptible: status.interruptible,
        },
        width,
      )
    : null;
  const progress = view.sending
    ? ` ${theme.dim("•")} ${theme.accent(t("session.view.sending"))}`
    : view.loading
      ? ` ${theme.dim("•")} ${theme.dim(t("session.view.loading"))}`
      : "";
  const header =
    view.panel.length > 0
      ? null
      : (work ??
        railActive(rail, `${theme.text.bold(t("session.view.message"))}${progress}`, tone));

  const inner = Math.max(2, width - RAIL_COLUMNS);
  const layout = layoutInput(view.editor, inner);
  const shown = composerWindow(layout, maxRows);
  const composerRows = view.composerEnabled
    ? shown.rows.length + (shown.above > 0 ? 1 : 0) + (shown.below > 0 ? 1 : 0)
    : 0;
  let spare = Math.max(0, maxRows - view.panel.length - composerRows - 1);
  const take = (count: number): boolean => {
    if (spare < count) return false;
    spare -= count;
    return true;
  };
  // A running turn is what the title row says, so it goes first; otherwise what is off comes first.
  let withHeader = working && header !== null && take(1);
  // The whole notice if it fits; on a short screen only its first row, cut to the terminal.
  const stateRows = state === null ? 0 : take(state.length) ? state.length : take(1) ? 1 : 0;
  // The lines round the composer go only as a pair, and only where a composer is drawn.
  const withRules = view.composerEnabled && take(2);
  const queued =
    view.queue === undefined || view.queue === null || view.queue.items.length === 0
      ? []
      : queueRows(
          view.queue,
          rail,
          width,
          Math.min(spare, 1 + QUEUE_ROWS),
          view.panel.length === 0,
        );
  spare -= queued.length;
  let menu: string[] = [];
  if (view.menu !== null && view.composerEnabled) {
    const wanted =
      view.menu.items.length === 0 ? 2 : Math.min(SLASH_MENU_ROWS, view.menu.items.length);
    menu = menuRows(view.menu, rail, width, Math.min(wanted, spare));
    spare -= menu.length;
  }
  if (!withHeader) withHeader = header !== null && take(1);
  const withGap = take(1);

  // Whatever is left above is shared: the plan first, then the agents, then the reply tail.
  const plan = renderPlan(view.planHidden ? [] : (status?.plan ?? []), {
    collapsed: view.planCollapsed,
    foldable: view.panel.length === 0,
    columns: columns - RAIL_COLUMNS,
    maxRows: Math.max(0, spare - 1),
    theme,
    symbols,
  });
  spare -= plan.length;
  const agents = renderAgents(status?.agents ?? [], {
    now: view.now,
    columns: columns - RAIL_COLUMNS,
    maxRows: Math.max(0, Math.min(4, spare - 1)),
    theme,
    symbols,
  });
  spare -= agents.length;

  const lines: string[] = view.partial.slice(Math.max(0, view.partial.length - spare));
  for (const row of [...plan, ...agents]) lines.push(railRow(rail, row, "idle"));
  if (state !== null && stateRows > 0) {
    lines.push(...state.slice(0, stateRows).map((row) => truncateStyled(row, width)));
  }
  if (withGap) lines.push(railGap(rail, tone));
  if (withHeader && header !== null) lines.push(header);
  lines.push(...view.panel);
  lines.push(...queued);
  if (withRules) lines.push(railRule(rail, width, tone));
  const composerStart = lines.length + (shown.above > 0 ? 1 : 0);
  if (view.composerEnabled) {
    const empty = layout.rows.length === 1 && layout.rows[0] === "";
    const more = (arrow: string, count: number) =>
      railRow(
        rail,
        theme.dim(
          truncateStyled(
            t("session.view.moreLines", { arrow, count: count.toLocaleString("en-US") }),
            inner,
          ),
        ),
        tone,
      );
    if (shown.above > 0) lines.push(more("↑", shown.above));
    shown.rows.forEach((row, index) => {
      // While a turn runs nothing is being asked for, so the empty row stays bare.
      const text =
        index === 0 && empty && !working ? theme.dim(truncateStyled(view.placeholder, inner)) : row;
      lines.push(railRow(rail, text, tone));
    });
    if (shown.below > 0) lines.push(more("↓", shown.below));
  }
  if (withRules) lines.push(railRule(rail, width, tone));
  lines.push(...menu);
  lines.push(
    railEnd(
      rail,
      renderStatusBar(view.bar, width - RAIL_COLUMNS, theme, symbols, view.barSetting),
      tone,
    ),
  );
  return {
    lines,
    cursor: view.composerEnabled
      ? { row: composerStart + shown.cursorRow, col: RAIL_COLUMNS + layout.cursor.col }
      : null,
  };
};
