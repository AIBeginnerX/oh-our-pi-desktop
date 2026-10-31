import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { RAIL_COLUMNS, railDone, railRow } from "./rail.ts";
import type { Style } from "./style.ts";
import type { Symbols } from "./symbols.ts";

export interface ToolLineOptions {
  readonly width: number;
  readonly style: Style;
  readonly symbols: Symbols;
}

/** The command or path after a tool's name stops here, so one long command is not a wall of text. */
const DETAIL_COLUMNS = 90;

/** Changed files named under a file edit before the rest are counted. */
const FILES_LISTED = 3;

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The first non-empty-trimmed line of a server string, cleaned for the terminal; "" for anything else. */
export const firstLine = (value: unknown): string =>
  typeof value === "string" ? (sanitizeForTerminal(value).split("\n")[0]?.trim() ?? "") : "";

const SHELL_WRAPPER = /^(?:\/[\w./-]*\/)?(?:ba|z|da)?sh\s+-l?c\s+/;

/**
 * The command a provider ran, without the `/bin/zsh -lc '…'` around it. The closing quote may be gone
 * when the server cut the detail short.
 */
export const shellCommand = (detail: string): string => {
  const inner = detail.replace(SHELL_WRAPPER, "");
  if (inner === detail) return detail;
  const quote = inner[0];
  if (quote !== "'" && quote !== '"') return inner;
  const body = inner.slice(1);
  const unquoted = body.endsWith(quote) ? body.slice(0, -1) : body;
  return quote === "'" ? unquoted.replaceAll("'\\''", "'") : unquoted;
};

/** A tool took long enough to be worth saying how long; a quicker one is left unmarked. */
export const formatDuration = (milliseconds: number): string | null => {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return null;
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
};

/** What a tool is called: the same name on every screen that lists tools. */
export const toolTitle = (activity: OrchestrationThreadActivity): string =>
  firstLine(asRecord(activity.payload).title) ||
  firstLine(activity.summary) ||
  firstLine(asRecord(activity.payload).toolName) ||
  "tool";

/** Whether a finished tool failed or was refused. */
export const toolFailed = (activity: OrchestrationThreadActivity): boolean => {
  const { status } = asRecord(activity.payload);
  return activity.kind === "tool.denied" || status === "failed" || status === "declined";
};

/** The one line of output the server keeps for a finished tool, or why it failed. */
export const resultSummary = (data: Record<string, unknown>, failed: boolean): string => {
  const item = asRecord(data.item);
  const error = item.error;
  const candidates = [
    ...(failed ? [typeof error === "string" ? error : asRecord(error).message] : []),
    item.aggregatedOutput,
    asRecord(item.result).content,
    asRecord(data.rawOutput).content,
    asRecord(data.result).content,
  ];
  for (const candidate of candidates) {
    const line = firstLine(candidate);
    if (line !== "") return line;
  }
  return "";
};

const changedFiles = (data: Record<string, unknown>): string[] => {
  if (!Array.isArray(data.files)) return [];
  return data.files.flatMap((file) => {
    const path = firstLine(asRecord(file).path);
    return path === "" ? [] : [path];
  });
};

const filesSummary = (files: ReadonlyArray<string>): string => {
  const listed = files.slice(0, FILES_LISTED).join(", ");
  return files.length > FILES_LISTED ? `${listed} 외 ${files.length - FILES_LISTED}개` : listed;
};

/**
 * The scrollback lines for a finished tool, hung off the transcript rail: `◇  name  command  2.3s`
 * (`✗` in the rail's place when it failed), then a dim rail row with what the tool reported, when
 * the activity carries any. `elapsedMs` is the time between the tool's
 * start and finish activities, used when the tool did not report its own duration.
 */
export const toolLines = (
  activity: OrchestrationThreadActivity,
  elapsedMs: number | null,
  options: ToolLineOptions,
): string[] => {
  const { width, style, symbols } = options;
  const { theme } = style;
  const rail = { style, symbols };
  const payload = asRecord(activity.payload);
  const data = asRecord(payload.data);

  const title = toolTitle(activity);
  const detail = shellCommand(firstLine(payload.detail));
  const failed = toolFailed(activity);

  const reported = asRecord(data.item).durationMs;
  const duration = formatDuration(typeof reported === "number" ? reported : (elapsedMs ?? 0));

  const name = failed ? theme.error.bold(title) : theme.tool.bold(title);
  const head = failed ? `${theme.error.bold(symbols.cross)}  ${name}` : railDone(rail, name);
  const tail = duration === null ? "" : `  ${theme.dim(duration)}`;
  const room = Math.min(DETAIL_COLUMNS, width - visibleWidth(head) - visibleWidth(tail) - 2);
  const shownDetail =
    detail !== "" && room >= 4 ? `  ${theme.muted(truncateStyled(detail, room))}` : "";
  const rows = [truncateStyled(`${head}${shownDetail}${tail}`, width)];

  let result = resultSummary(data, failed);
  if (result === "" && payload.itemType === "file_change")
    result = filesSummary(changedFiles(data));
  if (result !== "" && result !== detail && result !== title) {
    const room = Math.max(1, width - RAIL_COLUMNS);
    const shown = truncateStyled(result, room);
    rows.push(railRow(rail, failed ? theme.error(shown) : theme.dim(shown)));
  }
  return rows;
};
