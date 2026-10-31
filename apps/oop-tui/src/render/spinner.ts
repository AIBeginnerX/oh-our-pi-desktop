import type { Theme } from "./theme.ts";
import type { Symbols } from "./symbols.ts";
import { sanitizeForTerminal, stringWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";

/** Calls `run` every `intervalMs` until the returned function is called. */
export type Ticker = (run: () => void, intervalMs: number) => () => void;

/** The timer is `unref`ed: a spinner alone never keeps the process from exiting. */
export const defaultTicker: Ticker = (run, intervalMs) => {
  const handle = setInterval(run, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
};

/** With animations off the only thing that changes is the elapsed time, which counts in seconds. */
export const STATIC_TICK_MS = 1000;

/** Silence from the server for this long is worth saying out loud. */
export const SILENT_AFTER_MS = 60_000;

/** The colour phase moves a little each frame: one full pass through the gradient takes about ten seconds. */
const PHASE_PER_TICK = 0.02;

/** `12s`, `1m 05s`, `1h 02m`. */
export const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

export interface WorkRowInput {
  readonly theme: Theme;
  readonly symbols: Symbols;
  /** Which frame the running timer is on; ignored when animations are off. */
  readonly tick: number;
  readonly animations: boolean;
  /** The tool running now and what it was given; both absent while the agent is only writing. */
  readonly tool: string | null;
  readonly detail: string | null;
  readonly elapsedMs: number;
  /** Time since the last word from the server. */
  readonly silentMs: number;
  /** Whether Esc can stop the turn, which is what the hint at the end says. */
  readonly interruptible: boolean;
}

/** Between the time and the hints at the end of the row. */
const TAIL_SEPARATOR = "•";

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

/**
 * The line that takes the place of the composer's title while a turn runs: `◒  Bash · pnpm test  12s
 * • Esc 중단`. The glyph comes from the same colour gradient as the logo and slides along it; with
 * animations off it is a still frame. What the line says is only ever what the server reported: the
 * running tool, the time since the turn began, and, after a minute without a word, how long it has
 * been quiet.
 */
export const renderWorkRow = (input: WorkRowInput, width: number): string => {
  const { theme, symbols } = input;
  const frames = symbols.spinner;
  const glyph = input.animations
    ? theme.gradient(
        frames[input.tick % frames.length] ?? symbols.bullet,
        input.tick * PHASE_PER_TICK,
      )
    : theme.brand(frames[0] ?? symbols.bullet);
  const tool = input.tool === null ? "" : oneLine(input.tool);
  const detail = input.detail === null ? "" : oneLine(input.detail);

  const parts = [
    { text: formatElapsed(input.elapsedMs), paint: theme.dim },
    ...(input.silentMs >= SILENT_AFTER_MS
      ? [{ text: `응답 없음 ${formatElapsed(input.silentMs)}`, paint: theme.warning }]
      : []),
    ...(input.interruptible ? [{ text: "Esc 중단", paint: theme.dim }] : []),
  ];
  const tail = parts.map((part) => part.paint(part.text)).join(theme.dim(` ${TAIL_SEPARATOR} `));
  const tailWidth = stringWidth(parts.map((part) => part.text).join(` ${TAIL_SEPARATOR} `));

  // The tail is what changes second by second, so it keeps its room and the label gives way.
  const room = Math.max(4, width - stringWidth(frames[0] ?? symbols.bullet) - 2 - 2 - tailWidth);
  const label =
    tool === ""
      ? theme.muted("응답 생성 중")
      : `${theme.tool(tool)}${detail === "" ? "" : theme.muted(` · ${detail}`)}`;
  return truncateStyled(`${glyph}  ${truncateStyled(label, room)}  ${tail}`, width);
};
