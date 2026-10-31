import type { StatusLineSetting } from "../settings.ts";
import { graphemesOf, sanitizeForTerminal, stringWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { ForegroundToken, Theme } from "./theme.ts";

/** What the bar can say. Anything absent is left out of the line, not filled with a placeholder. */
export interface StatusBarInput {
  readonly model: string | null;
  /** Reasoning effort of the model selection, when it has one. */
  readonly effort: string | null;
  readonly mode: string | null;
  /** Plan mode as the bar says it ("계획 모드", with "(다음 턴)" while only held); null leaves it out. */
  readonly plan?: string | null;
  /** The thread's goal in a few words, such as `목표 2/5`. */
  readonly goal?: string | null;
  /** The crew in a few words, such as `crew` or `crew 2/3`; null when it is off. */
  readonly crew?: string | null;
  /** A crew request waits for the user: the segment is warned in colour and kept on the minimal bar. */
  readonly crewAlert?: boolean;
  /** Where the work happens (the worktree, else the project folder). */
  readonly cwd: string | null;
  /** The user's home folder, written `~` in `cwd`. */
  readonly home: string | null;
  readonly branch: string | null;
  /** 0-100 share of the context window in use. */
  readonly contextPercent: number | null;
  readonly costUsd: number | null;
  /** The cost covers only the part of the thread that was loaded. */
  readonly costPartial: boolean;
  readonly agents: number;
  /** A last, lowest-priority word, such as how to ask for help. */
  readonly hint: string | null;
}

type Level = "full" | "compact" | "minimal";

interface Segment {
  readonly text: string;
  readonly width: number;
}

const seg = (plain: string, paint: (text: string) => string): Segment => ({
  text: paint(plain),
  width: stringWidth(plain),
});

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

const BAR_CELLS = 5;
const MIN_PATH_WIDTH = 8;
const BRANCH_WIDTH = 24;

/** The context bar's colour by how full the window is: green below 50%, then yellow, orange, red from 90%. */
const contextToken = (percent: number): ForegroundToken =>
  percent >= 90 ? "ctxCritical" : percent >= 70 ? "ctxHigh" : percent >= 50 ? "ctxWarn" : "ctxOk";

const formatCost = (usd: number, partial: boolean): string => {
  const text =
    usd > 0 && usd < 0.01 ? "<$0.01" : usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
  return partial ? `${text}+` : text;
};

/** The tail of `text` that fits `max` columns, led by `…` (`~` stays the root of a home path). */
const cutHead = (text: string, max: number): string => {
  if (stringWidth(text) <= max) return text;
  const graphemes = graphemesOf(text);
  let tail = "";
  let width = 1;
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const next = stringWidth(graphemes[index] as string);
    if (width + next > max) break;
    tail = graphemes[index] + tail;
    width += next;
  }
  // Start on a folder boundary when there is one, so the end of the path reads whole.
  const boundary = tail.search(/[\\/]/u);
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
};

const cutTail = (text: string, max: number): string => {
  if (stringWidth(text) <= max) return text;
  let out = "";
  for (const grapheme of graphemesOf(text)) {
    if (stringWidth(out + grapheme) > max - 1) break;
    out += grapheme;
  }
  return `${out}…`;
};

const homeRelative = (path: string, home: string | null): string => {
  if (home === null || home === "") return path;
  if (path === home) return "~";
  const next = path.charAt(home.length);
  return path.startsWith(home) && (next === "/" || next === "\\")
    ? `~${path.slice(home.length)}`
    : path;
};

const lastFolder = (path: string): string => {
  const parts = path.split(/[\\/]/u).filter((part) => part !== "");
  return parts.at(-1) ?? path;
};

interface Context {
  readonly input: StatusBarInput;
  readonly theme: Theme;
  readonly symbols: Symbols;
  readonly level: Level;
}

/** The segments for one level, in the order they are dropped from the back. `path` is the one that can shrink. */
const segmentsOf = ({ input, theme, symbols, level }: Context) => {
  const list: Array<{
    readonly key: string;
    readonly build: (pathBudget: number) => Segment;
    readonly flexible?: true;
    readonly natural: number;
    /** The least room the segment can be built in; only a flexible one is below its natural width. */
    readonly min: number;
  }> = [];
  const fixed = (key: string, segment: Segment) =>
    list.push({ key, build: () => segment, natural: segment.width, min: segment.width });

  if (input.model !== null && oneLine(input.model) !== "") {
    const model = oneLine(input.model);
    const effort = level === "full" && input.effort !== null ? oneLine(input.effort) : "";
    fixed("model", {
      text: `${theme.text(model)}${effort === "" ? "" : theme.muted(` ${effort}`)}`,
      width: stringWidth(model) + (effort === "" ? 0 : 1 + stringWidth(effort)),
    });
  }
  if (level !== "minimal" && input.mode !== null && oneLine(input.mode) !== "") {
    fixed("mode", seg(oneLine(input.mode), theme.muted));
  }
  if (level !== "minimal" && input.plan) fixed("plan", seg(input.plan, theme.accent));
  if (level !== "minimal" && input.goal !== undefined && input.goal !== null) {
    const goal = oneLine(input.goal);
    if (goal !== "") fixed("goal", seg(goal, theme.muted));
  }
  if (input.crew !== undefined && input.crew !== null && (level !== "minimal" || input.crewAlert)) {
    const crew = oneLine(input.crew);
    if (crew !== "") fixed("crew", seg(crew, input.crewAlert ? theme.warning : theme.accent));
  }
  if (level !== "minimal" && input.cwd !== null && input.cwd !== "") {
    const where = homeRelative(oneLine(input.cwd), input.home);
    const folder = level === "full" ? where : lastFolder(where);
    const marker = symbols === ASCII_SYMBOLS ? "@" : "⎇";
    const branch = input.branch === null ? "" : cutTail(oneLine(input.branch), BRANCH_WIDTH);
    const branchWidth = branch === "" ? 0 : 1 + stringWidth(marker) + 1 + stringWidth(branch);
    list.push({
      key: "location",
      flexible: true,
      natural: stringWidth(folder) + branchWidth,
      min: Math.min(stringWidth(folder), MIN_PATH_WIDTH) + branchWidth,
      build: (budget) => {
        const shown = cutHead(folder, Math.max(1, budget - branchWidth));
        return {
          text: `${theme.muted(shown)}${branch === "" ? "" : ` ${theme.dim(marker)} ${theme.accent(branch)}`}`,
          width: stringWidth(shown) + branchWidth,
        };
      },
    });
  }
  if (input.contextPercent !== null) {
    const percent = Math.max(0, Math.min(100, input.contextPercent));
    const paint = theme[contextToken(percent)];
    const label = `${Math.round(percent)}%`;
    if (level === "full") {
      const filled = Math.round((percent / 100) * BAR_CELLS);
      const bar = `${symbols.context.full.repeat(filled)}${symbols.context.empty.repeat(BAR_CELLS - filled)}`;
      fixed("context", {
        text: `${paint(bar)} ${paint(label)}`,
        width: stringWidth(bar) + 1 + stringWidth(label),
      });
    } else {
      fixed("context", seg(label, paint));
    }
  }
  if (level !== "minimal" && input.costUsd !== null) {
    fixed("cost", seg(formatCost(input.costUsd, input.costPartial), theme.muted));
  }
  if (level !== "minimal" && input.agents > 0) {
    fixed("agents", seg(`에이전트 ${input.agents}`, theme.agent(0)));
  }
  if (level === "full" && input.hint !== null && oneLine(input.hint) !== "") {
    fixed("hint", seg(oneLine(input.hint), theme.dim));
  }
  return list;
};

/**
 * The line for `level`. Without `allowDrop` it is null unless every segment fits; with it, segments
 * go from the back until the rest fits, and the first one is kept however narrow the terminal is.
 * With nothing known the line is empty.
 */
const fit = (context: Context, width: number, allowDrop: boolean): string | null => {
  const separator = ` ${context.theme.dim(context.symbols.separator)} `;
  const gap = 2 + stringWidth(context.symbols.separator);
  const all = segmentsOf(context);
  for (let count = all.length; count >= (allowDrop ? 1 : all.length); count -= 1) {
    const kept = all.slice(0, count);
    const flexible = kept.find((entry) => entry.flexible);
    const others = kept
      .filter((entry) => entry !== flexible)
      .reduce((sum, entry) => sum + entry.natural, 0);
    const room = width - others - gap * (kept.length - 1);
    const budget = flexible === undefined ? 0 : Math.min(flexible.natural, room);
    const fits = flexible === undefined ? room >= 0 : budget >= flexible.min;
    if (fits || count === 1) {
      return kept.map((entry) => entry.build(budget).text).join(separator);
    }
  }
  return null;
};

/**
 * One line of segments: `gpt-5 high │ full-access │ ~/work/app ⎇ main │ ▰▰▱▱▱ 42% │ $0.12`. The
 * caller puts it after the rail's closing `└`, so the name of the app is not repeated here.
 * A segment with no value is not there. Narrow terminals lose detail before they lose segments:
 * in `auto` the full form gives way to the compact, then the minimal one, and a line that still does
 * not fit loses segments from the back. A chosen level keeps its own form and only loses from the back.
 */
export const renderStatusBar = (
  input: StatusBarInput,
  width: number,
  theme: Theme,
  symbols: Symbols,
  setting: StatusLineSetting,
): string => {
  const context = (level: Level): Context => ({ input, theme, symbols, level });
  // The first segment is kept however narrow the terminal is, so the line is cut to fit as a last resort.
  const cut = (line: string): string => truncateStyled(line, Math.max(1, width));
  if (setting === "auto") {
    for (const level of ["full", "compact"] as const) {
      const line = fit(context(level), width, false);
      if (line !== null) return cut(line);
    }
    return cut(fit(context("minimal"), width, true) ?? "");
  }
  return cut(fit(context(setting), width, true) ?? "");
};
