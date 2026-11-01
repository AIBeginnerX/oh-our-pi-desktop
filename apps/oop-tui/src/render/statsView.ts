import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { stringWidth, visibleWidth } from "../text/width.ts";
import { padEndVisible, truncateStyled, wrapStyled } from "../text/wrap.ts";
import type { Style } from "./style.ts";
import type { Symbols } from "./symbols.ts";
import { asRecord, firstLine, resultSummary, toolFailed, toolTitle } from "./toolLine.ts";
import { t } from "../i18n/index.ts";

export interface StatsInput {
  /** The thread's activities, as the client has them. */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  /** The server sent only the recent part of the thread, so the numbers cover just that. */
  readonly hasOlder: boolean;
  /** 0 overview, 1 hours of the day, 2 one tool at a time. */
  readonly tab: 0 | 1 | 2;
  /** The tool picked on the tool tab, by name so a list that reorders keeps the pick; null: the first. */
  readonly selected: string | null;
  readonly width: number;
  /** The most rows the view may use. */
  readonly rows: number;
  readonly style: Style;
  readonly symbols: Symbols;
}

interface ToolStat {
  readonly name: string;
  calls: number;
  failed: number;
  lastAt: number | null;
  lastFailureAt: number | null;
  lastFailure: string;
}

const HOURS = 24;
const BAR_COLUMNS = 20;
const TOP_HOURS = 5;
/** The tool box is no wider than this, so a wide terminal does not stretch a few short lines. */
const BOX_COLUMNS = 48;
/** Below this the tool tab stacks its list over its box instead of putting them side by side. */
const SIDE_BY_SIDE_FROM = 60;
const AXIS_TENS = new Map([
  [0, "0"],
  [10, "1"],
  [20, "2"],
]);
const AXIS_ONES = new Map([
  [0, "0"],
  [5, "5"],
  [10, "0"],
  [15, "5"],
  [20, "0"],
  [23, "3"],
]);
const tabLabels = (): ReadonlyArray<string> => [
  t("render.stats.tabOverview"),
  t("render.stats.tabHours"),
  t("render.stats.tabTools"),
];

/** The widest of these, by display width. A plain loop: spreading a long list into Math.max overflows the stack. */
const widest = (texts: ReadonlyArray<string>): number =>
  texts.reduce((most, text) => Math.max(most, stringWidth(text)), 0);

const percent = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

const two = (value: number): string => String(value).padStart(2, "0");

/** The hour in the viewer's own time zone, not the server's: an activity's time is a UTC instant. */
const localTime = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** Finished and refused tools only: a tool that is still running has no outcome to count. */
const tally = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
  const tools = new Map<string, ToolStat>();
  const hours = Array.from({ length: HOURS }, () => ({ calls: 0, failed: 0 }));
  let calls = 0;
  let failed = 0;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed" && activity.kind !== "tool.denied") continue;
    const name = toolTitle(activity);
    const stat = tools.get(name) ?? {
      name,
      calls: 0,
      failed: 0,
      lastAt: null,
      lastFailureAt: null,
      lastFailure: "",
    };
    tools.set(name, stat);
    const fail = toolFailed(activity);
    const at = Date.parse(activity.createdAt);
    const known = Number.isFinite(at);
    stat.calls += 1;
    calls += 1;
    if (known && (stat.lastAt === null || at >= stat.lastAt)) stat.lastAt = at;
    if (fail) {
      stat.failed += 1;
      failed += 1;
      if (known && (stat.lastFailureAt === null || at >= stat.lastFailureAt)) {
        const payload = asRecord(activity.payload);
        stat.lastFailureAt = at;
        stat.lastFailure =
          resultSummary(asRecord(payload.data), true) || firstLine(payload.detail) || "";
      }
    }
    if (known) {
      const hour = hours[new Date(at).getHours()];
      if (hour !== undefined) {
        hour.calls += 1;
        if (fail) hour.failed += 1;
      }
    }
  }
  const list = [...tools.values()].sort(
    (left, right) =>
      right.calls - left.calls || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return { list, hours, calls, failed };
};

/** The tools the tool tab lists, in the order it lists them: most calls first. */
export const statsToolNames = (activities: ReadonlyArray<OrchestrationThreadActivity>): string[] =>
  tally(activities).list.map((tool) => tool.name);

/**
 * The `/stats` screen for one thread: three tabs over the tool calls its activities record. The
 * rows are the whole screen, redrawn on a key press and never on a timer. Every number comes from
 * an activity; nothing is estimated, and the hour is the viewer's local one.
 */
export const renderStats = (input: StatsInput): string[] => {
  const { activities, hasOlder, tab, style, symbols } = input;
  const width = Math.max(1, input.width);
  const limit = Math.max(0, input.rows);
  const { theme } = style;
  const ascii = /^[ -~]+$/u.test(symbols.rail.bar);
  const data = tally(activities);
  const inner = Math.max(1, width - 1);
  const note = hasOlder ? theme.dim(t("render.stats.recentOnly")) : "";

  const tabs = tabLabels()
    .map((label, index) => {
      const text = ` ${label} `;
      if (index !== tab) return text;
      return style.enabled ? style.inverse(style.bold(text)) : `>${label}<`;
    })
    .join(" ");
  const tabsWidth = visibleWidth(tabs);
  const hint = theme.dim(t("render.stats.hint"));
  const head =
    tabsWidth + 2 + visibleWidth(hint) <= width
      ? `${tabs}${" ".repeat(width - tabsWidth - visibleWidth(hint))}${hint}`
      : tabs;

  const out: string[] = [head, ""];
  const line = (text: string): void => {
    out.push(` ${text}`);
  };
  /** The numbers line, followed by the note on the same row when it fits and on its own when it does not. */
  const summaryLine = (text: string): void => {
    if (note === "") line(text);
    else if (visibleWidth(text) + 2 + visibleWidth(note) <= inner) line(`${text}  ${note}`);
    else {
      line(text);
      line(note);
    }
  };
  if (data.list.length === 0) {
    summaryLine(theme.dim(t("render.stats.none")));
    return fit(out, width, limit);
  }

  const summary = (extra: string): string =>
    t("render.stats.summary", {
      extra,
      calls: style.bold(String(data.calls)),
      rate:
        data.failed > 0
          ? theme.error(`${percent(data.failed, data.calls)}%`)
          : style.bold(`${percent(data.failed, data.calls)}%`),
    });

  if (tab === 0) {
    summaryLine(
      summary(t("render.stats.toolCount", { count: style.bold(String(data.list.length)) })),
    );
    out.push("");
    const spare = Math.max(0, limit - out.length);
    const shown =
      data.list.length > spare && spare >= 2 ? data.list.slice(0, spare - 1) : data.list;
    const names = Math.min(
      16,
      widest(shown.map((tool) => tool.name)),
      Math.max(4, Math.floor(inner / 3)),
    );
    const full = shown.map((tool) =>
      t("render.stats.split", {
        failed: tool.failed,
        ok: tool.calls - tool.failed,
        calls: tool.calls,
      }),
    );
    const wide = widest(full);
    // On a narrow screen the bar matters more than the split, so the split gives way first.
    const compact = inner - names - 1 - wide - 1 < 6;
    const counts = compact
      ? shown.map((tool) => t("render.stats.callsOnly", { calls: tool.calls }))
      : full;
    const countsWidth = widest(counts);
    const bar = Math.max(1, Math.min(BAR_COLUMNS, inner - names - 1 - countsWidth - 1));
    shown.forEach((tool, index) => {
      line(
        `${theme.accent(padEndVisible(truncateStyled(tool.name, names), names))} ${barOf(tool, bar, style, ascii)} ${theme.dim(counts[index] ?? "")}`,
      );
    });
    if (shown.length < data.list.length) {
      line(theme.dim(t("render.stats.moreTools", { count: data.list.length - shown.length })));
    }
    return fit(out, width, limit);
  }

  if (tab === 1) {
    const peak = data.hours.reduce(
      (best, hour, index) => (hour.calls > (data.hours[best]?.calls ?? 0) ? index : best),
      0,
    );
    const most = data.hours[peak]?.calls ?? 0;
    summaryLine(
      `${summary("")}${most > 0 ? t("render.stats.peak", { hour: style.bold(`${two(peak)}:00`) }) : ""}`,
    );
    out.push("");
    const glyphs = ascii ? [".", ":", "*", "#"] : ["░", "▒", "▓", "█"];
    const cells = data.hours
      .map((hour, index) => {
        const level = hour.calls === 0 ? 0 : Math.max(1, Math.ceil((hour.calls / most) * 3));
        const glyph = glyphs[level] ?? "░";
        if (level === 0) return theme.dim(glyph);
        return index === peak ? theme.warning(glyph) : theme.accent(glyph);
      })
      .join("");
    const hourWord = t("render.stats.hour");
    const label = `${hourWord}  `;
    line(`${style.bold(hourWord)}  ${cells}`);
    const axis = (marks: ReadonlyMap<number, string>): string =>
      Array.from({ length: HOURS }, (_, hour) => marks.get(hour) ?? " ").join("");
    line(theme.dim(`${" ".repeat(stringWidth(label))}${axis(AXIS_TENS)}`));
    line(theme.dim(`${" ".repeat(stringWidth(label))}${axis(AXIS_ONES)}`));
    out.push("");
    line(style.bold(t("render.stats.busyHours")));
    const ranked = data.hours
      .map((hour, index) => ({ ...hour, index }))
      .filter((hour) => hour.calls > 0)
      .sort((left, right) => right.calls - left.calls || left.index - right.index)
      .slice(0, TOP_HOURS);
    for (const hour of ranked) {
      const failed =
        hour.failed > 0
          ? `  ${theme.error(t("render.stats.hourFailed", { count: hour.failed }))}`
          : "";
      line(
        `  ${two(hour.index)}:00  ${t("render.stats.hourCalls", { calls: hour.calls })}${failed}`,
      );
    }
    return fit(out, width, limit);
  }

  if (note !== "") line(note);
  const room = Math.max(0, limit - out.length);
  const selected = Math.max(
    0,
    data.list.findIndex((tool) => tool.name === input.selected),
  );
  const current = data.list[selected] as ToolStat;
  const sideBySide = width >= SIDE_BY_SIDE_FROM;
  const marker = ascii ? ">" : "▶";
  const listWidth = sideBySide
    ? Math.min(
        Math.floor(width * 0.4),
        widest(data.list.map((tool) => `  ${tool.name} (${tool.calls})`)),
      )
    : inner;
  const boxWidth = sideBySide ? Math.min(BOX_COLUMNS, inner - listWidth - 2) : inner;
  const box = toolBox(current, boxWidth, style, symbols);
  // The list keeps the picked tool in view; stacked, it gives the box the rows it needs first.
  const listRows = Math.max(
    1,
    Math.min(data.list.length, sideBySide ? room : Math.min(6, room - box.length - 1)),
  );
  const from = Math.min(
    Math.max(0, selected - Math.floor(listRows / 2)),
    data.list.length - listRows,
  );
  const list = data.list.slice(from, from + listRows).map((tool, offset) => {
    const picked = from + offset === selected;
    const count = ` (${tool.calls})`;
    const name = truncateStyled(tool.name, Math.max(1, listWidth - 2 - stringWidth(count)));
    const text = padEndVisible(`${picked ? marker : " "} ${name}${count}`, listWidth);
    if (picked) return style.enabled ? style.inverse(text) : text;
    return tool.failed === tool.calls ? theme.error(text) : text;
  });
  if (sideBySide) {
    for (let row = 0; row < Math.max(list.length, box.length); row += 1) {
      line(`${padEndVisible(list[row] ?? "", listWidth)}  ${box[row] ?? ""}`.trimEnd());
    }
  } else {
    for (const row of list) line(row.trimEnd());
    if (room - list.length > 1) out.push("");
    for (const row of box) line(row);
  }
  return fit(out, width, limit);
};

/** Every row cut to the width, and the whole cut to the rows the screen gave. */
const fit = (rows: ReadonlyArray<string>, width: number, limit: number): string[] =>
  rows.slice(0, limit).map((row) => truncateStyled(row, width));

/** Failed and succeeded calls as one bar of `columns` cells, failures first. */
const barOf = (tool: ToolStat, columns: number, style: Style, ascii: boolean): string => {
  const { theme } = style;
  const ok = ascii ? "#" : "█";
  const bad = ascii ? "x" : style.enabled ? "█" : "▒";
  const failedCells =
    tool.failed === 0
      ? 0
      : tool.failed === tool.calls
        ? columns
        : Math.min(columns - 1, Math.max(1, Math.round((tool.failed / tool.calls) * columns)));
  return `${theme.error(bad.repeat(failedCells))}${theme.success(ok.repeat(columns - failedCells))}`;
};

/** One tool's numbers in a box, for the tool tab. */
const toolBox = (tool: ToolStat, outer: number, style: Style, symbols: Symbols): string[] => {
  const { theme } = style;
  const { box } = symbols;
  const inside = Math.max(1, outer - 4);
  const succeeded = tool.calls - tool.failed;
  const body = [
    theme.accent.bold(truncateStyled(tool.name, inside)),
    "",
    t("render.stats.detailCalls", {
      calls: style.bold(String(tool.calls)),
      failed: theme.error(String(tool.failed)),
      ok: theme.success(String(succeeded)),
    }),
    `${theme.dim(t("render.stats.lastCall"))} ${tool.lastAt === null ? "-" : localTime(tool.lastAt)}`,
    "",
    ...(tool.failed === 0
      ? [theme.dim(t("render.stats.noLastFailure"))]
      : wrapStyled(
          theme.error(
            truncateStyled(
              t("render.stats.lastFailure", { reason: tool.lastFailure || "-" }),
              inside * 3,
            ),
          ),
          inside,
        ).slice(0, 3)),
  ];
  const side = theme.dim(box.vertical);
  return [
    theme.dim(`${box.topLeft}${box.horizontal.repeat(Math.max(0, outer - 2))}${box.topRight}`),
    ...body.map((row) => `${side} ${padEndVisible(truncateStyled(row, inside), inside)} ${side}`),
    theme.dim(
      `${box.bottomLeft}${box.horizontal.repeat(Math.max(0, outer - 2))}${box.bottomRight}`,
    ),
  ];
};
