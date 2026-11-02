import { visibleWidth } from "../text/width.ts";
import { colorCodes, rgbToIndexed, type Color, type ColorLevel } from "./color.ts";
import {
  MOCHA,
  MOCHA_ANSI16,
  MOCHA_ANSI16_TONE,
  MOCHA_HEIGHT,
  MOCHA_LIQUID,
  MOCHA_MINI_WIDTH,
  MOCHA_PALETTE,
  MOCHA_STATES,
  MOCHA_STEAM_LIFT,
  MOCHA_WIDTH,
  type PetState,
  type PetTone,
} from "./mochaArt.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";

/**
 * The header's pet: Mocha, a warm coffee mug. Her coffee and steam take the colour of the provider
 * that answers (Claude, OpenAI, a local model, or plain coffee brown), she steams when she is idle,
 * brews while the model thinks, bounces while text arrives, stirs a spoon for a tool, jumps and
 * changes colour when the model is switched, falls asleep when you are away, and trembles at an error.
 *
 * Everything here is pure: what state she is in, which frame that state shows at a given time, and
 * how a frame is drawn. The controller owns the clock and the one timer; nothing in this file keeps
 * time or writes to the terminal. The pictures are the data of `mochaArt.ts`, the same ones the Rust
 * app draws (`apps/oop-tui-rs/src/pet.rs`), frame for frame and cell for cell.
 *
 * She does not walk: a mug stays on her coaster. A bounce, a jump or a shake is drawn into the
 * frames themselves, so the header repaints her strip and nothing else.
 */

export type { PetState, PetTone };
export { MOCHA_STATES as PET_STATES };

/**
 * Cells of the full pet: 14 pixels wide and 10 tall, two pixels to a cell, so 14 cells by 5 rows.
 * The header's strip is two cells wider: a gap before her and a free column next to the divider.
 */
export const PET_WIDTH = MOCHA_WIDTH;
export const PET_HEIGHT = MOCHA_HEIGHT / 2;
export const PET_TRACK_WIDTH = PET_WIDTH + 2;
/** Cells of the one-line pet used by the compact header, and of its strip. */
export const PET_MINI_WIDTH = MOCHA_MINI_WIDTH;
export const PET_MINI_TRACK_WIDTH = PET_MINI_WIDTH + 2;

/** Quiet this long, and an idle pet falls asleep. */
export const REST_AFTER_MS = 90_000;
/** How long the greeting at startup, the happy look after a finished turn and a model switch last. */
export const GREETING_MS = 4_000;
export const SUCCESS_MS = 4_000;
export const SWITCH_MS = 1_000;

// ---- which colour ------------------------------------------------------------------------

const LOCAL_HINT = /(?:^|[^a-z])(?:ollama|lm-?studio|llama[.-]?cpp|localai|local)(?:[^a-z]|$)/iu;

/**
 * The colour for the model that answers, decided per provider adapter: Claude's is terracotta and
 * Codex's emerald; a driver or instance named for a local runtime (Ollama, LM Studio, llama.cpp) is
 * violet, and so is an OpenCode model served by one (`ollama/llama3`). Cursor, Grok, Antigravity and
 * every other OpenCode model keep the default coffee brown: their models are not one vendor's.
 */
export const toneOf = (driver: string | null, instanceId: string, model: string): PetTone => {
  const kind = (driver ?? "").toLowerCase();
  if (kind === "claudeagent" || kind === "claude") return "claude";
  if (kind === "codex") return "openai";
  if (LOCAL_HINT.test(kind) || (kind === "" && LOCAL_HINT.test(instanceId))) return "local";
  if (kind === "opencode" && LOCAL_HINT.test(model.split("/")[0] ?? "")) return "local";
  return "default";
};

// ---- mood --------------------------------------------------------------------------------

/** What the app is doing, reduced to what decides the pet's mood. */
export interface PetObservation {
  /** The thread's phase; null off a conversation (project and thread lists). */
  readonly phase: "idle" | "working" | "approval" | "input" | "error" | null;
  /** A tool of the running turn has not finished. */
  readonly tool: boolean;
  /** The assistant's text is arriving. */
  readonly streaming: boolean;
  /** The link to the server is up. */
  readonly online: boolean;
  /** The model the next message goes to; null where there is none to tell. */
  readonly model: PetModel | null;
}

/** The model on screen: `scope` is the thread it belongs to, so opening another thread is no switch. */
export interface PetModel {
  readonly scope: string;
  readonly key: string;
  readonly tone: PetTone;
}

/** What the pet remembers between observations: when it began, when things last happened. */
export interface PetMemory {
  readonly startedAt: number;
  /** The last time anything happened: a turn moved, a key was pressed. */
  readonly activeAt: number;
  /** Whether the previous observation was a running turn. */
  readonly wasWorking: boolean;
  /** When a turn last ended without an error; null if none has since the pet woke. */
  readonly finishedAt: number | null;
  /** The model last seen, and the colour the coffee was in before the last switch. */
  readonly model: PetModel | null;
  readonly from: PetTone;
  /** When the model last changed in place; null if it has not. */
  readonly switchedAt: number | null;
}

export const newPetMemory = (now: number): PetMemory => ({
  startedAt: now,
  activeAt: now,
  wasWorking: false,
  finishedAt: null,
  model: null,
  from: "default",
  switchedAt: null,
});

const sameModel = (left: PetModel | null, right: PetModel | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.scope === right.scope &&
    left.key === right.key &&
    left.tone === right.tone);

/** Folds one observation into the memory. Returns the same object when nothing changed. */
export const observePet = (
  memory: PetMemory,
  observation: PetObservation,
  now: number,
): PetMemory => {
  const working = observation.phase === "working";
  const busy = working || observation.phase === "approval" || observation.phase === "input";
  const finished = memory.wasWorking && !working && observation.phase === "idle";
  const finishedAt = finished ? now : memory.finishedAt;
  let activeAt = busy || finished || observation.phase === "error" ? now : memory.activeAt;
  let { model, from, switchedAt } = memory;
  const seen = observation.model;
  if (seen !== null) {
    if (model === null || model.scope !== seen.scope) {
      // The first model, or another thread's: she takes its colour without a show.
      model = seen;
      from = seen.tone;
    } else if (model.key !== seen.key) {
      from = model.tone;
      model = seen;
      switchedAt = now;
      activeAt = now;
    } else {
      model = seen;
    }
  }
  if (
    working === memory.wasWorking &&
    finishedAt === memory.finishedAt &&
    activeAt === memory.activeAt &&
    switchedAt === memory.switchedAt &&
    from === memory.from &&
    sameModel(model, memory.model)
  ) {
    return memory;
  }
  return { ...memory, wasWorking: working, finishedAt, activeAt, model, from, switchedAt };
};

/** A key was pressed or the terminal came back into focus: a sleeping pet wakes. */
export const touchPet = (memory: PetMemory, now: number): PetMemory =>
  memory.activeAt === now ? memory : { ...memory, activeAt: now };

/**
 * Maps the app's state to the pet's mood. A running turn beats everything; then the quiet states.
 * `working` is the streaming mood: the model's text is arriving.
 */
export const petState = (memory: PetMemory, observation: PetObservation, now: number): PetState => {
  if (!observation.online) return "error";
  switch (observation.phase) {
    case "working":
      return observation.tool ? "tool" : observation.streaming ? "working" : "thinking";
    case "approval":
    case "input":
      return "waiting";
    case "error":
      return "error";
    default:
      break;
  }
  if (memory.switchedAt !== null && now - memory.switchedAt < SWITCH_MS) return "switching";
  if (now - memory.startedAt < GREETING_MS && memory.finishedAt === null) return "greeting";
  if (memory.finishedAt !== null && now - memory.finishedAt < SUCCESS_MS) return "success";
  if (now - memory.activeAt >= REST_AFTER_MS) return "resting";
  return "idle";
};

/** The colours a state is drawn in: the coffee's own, and in a switch the one it is leaving. */
export interface PetLook {
  readonly tone: PetTone;
  readonly from: PetTone;
}

export const petLook = (memory: PetMemory, state: PetState): PetLook => {
  const tone = memory.model?.tone ?? "default";
  return { tone, from: state === "switching" ? memory.from : tone };
};

// ---- time --------------------------------------------------------------------------------

export interface PetClockReading {
  /** Index into the state's frames. */
  readonly frame: number;
  /** Milliseconds until the frame changes. */
  readonly remaining: number;
}

/**
 * Which frame the state shows at `now`, and how long until it changes. A switch plays once from
 * the moment of the change, so it is read from `memory.switchedAt`; every other state loops by the
 * clock alone.
 */
export const petClock = (state: PetState, now: number, memory?: PetMemory): PetClockReading => {
  const script = MOCHA[state].script;
  const since = state === "switching" ? (memory?.switchedAt ?? 0) : 0;
  const at = now - since;
  let cycle = 0;
  for (const [, ms] of script) cycle += ms;
  const into = ((at % cycle) + cycle) % cycle;
  let end = 0;
  for (const [frame, ms] of script) {
    end += ms;
    if (into < end) return { frame, remaining: end - into };
  }
  return { frame: 0, remaining: cycle };
};

// ---- drawing -----------------------------------------------------------------------------

/**
 * A colour of a cell: `-` the terminal's own, `#RRGGBB` truecolor, `i<n>` a slot of the 256-colour
 * palette, `a<n>` one of the 16 colours. A string, so a cell can be compared and kept in a fixture.
 */
export type Ink = string;

/** One cell of the drawing: a glyph, its foreground and the background it is packed over. */
export interface PetCell {
  readonly glyph: string;
  readonly fg: Ink;
  readonly bg: Ink;
}

export interface PetDraw {
  readonly level: ColorLevel;
  readonly ascii: boolean;
}

const NONE: Ink = "-";

const rgbOf = (hex: string): { r: number; g: number; b: number } => {
  const packed = Number.parseInt(hex.slice(1), 16);
  return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
};

const hexOf = (rgb: { r: number; g: number; b: number }): string =>
  `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** The steam: the coffee's colour lifted toward white, so it still shows on a dark background. */
const lifted = (hex: string): string => {
  const rgb = rgbOf(hex);
  const up = (v: number) => Math.round(v + (255 - v) * MOCHA_STEAM_LIFT);
  return hexOf({ r: up(rgb.r), g: up(rgb.g), b: up(rgb.b) });
};

/** The truecolor of a pixel; null for nothing. `L S` are the old colour of a switch, `l s` the new. */
const pixelHex = (ch: string, tone: PetTone, from: PetTone): string | null => {
  switch (ch) {
    case ".":
      return null;
    case "L":
      return MOCHA_LIQUID[from];
    case "l":
      return MOCHA_LIQUID[tone];
    case "S":
      return lifted(MOCHA_LIQUID[from]);
    case "s":
      return lifted(MOCHA_LIQUID[tone]);
    default:
      return MOCHA_PALETTE[ch] ?? null;
  }
};

/** The ink of a truecolor at a colour level (3 and 2 here; the 16 colours have their own table). */
const inkOf = (hex: string, level: ColorLevel): Ink =>
  level === 3 ? hex : level === 2 ? `i${rgbToIndexed(rgbOf(hex))}` : NONE;

/** A pixel's ink in the flat renderer at 16 colours: its own table entry, the coffee's by provider. */
const ansi16Of = (ch: string, tone: PetTone, from: PetTone): Ink => {
  const index =
    ch === "L" || ch === "S"
      ? MOCHA_ANSI16_TONE[from]
      : ch === "l" || ch === "s"
        ? MOCHA_ANSI16_TONE[tone]
        : MOCHA_ANSI16[ch];
  return index === undefined ? NONE : `a${index}`;
};

/** Glyphs for the ASCII form, by pixel: both pixels of a cell, the upper one, the lower one. */
const ASCII_GLYPHS: Readonly<Record<string, readonly [string, string, string]>> = {
  L: ["=", '"', "_"],
  l: ["=", '"', "_"],
  S: [":", "'", "."],
  s: [":", "'", "."],
  Y: ["*", "*", "*"],
  R: ["v", "v", "v"],
  Z: ["z", "z", "z"],
  M: ["~", "~", "~"],
  T: ["|", "|", "|"],
  o: ["o", "o", "o"],
};
const ASCII_BODY: readonly [string, string, string] = ["#", '"', "_"];

/** In the flat renderer a cell of two different pixels shows the one that matters most. */
const weight = (ch: string): number => (ch === "K" ? 2 : ch === "B" || ch === "H" ? 1 : 3);

/**
 * The pixel rows (two to a cell row) drawn as cells. Where the terminal gives a background (256
 * colours or more, Unicode symbols) two pixels of different colours are one `▀` with a foreground
 * and a background, so every pixel keeps its colour. Without one (16 colours, no colour, ASCII) a
 * cell has one colour and the pixels only decide its shape (`▀ ▄ █`, or `" _ #`): the eyes are
 * left unpainted, a hole in the cup, and where two pixels differ the more important one wins.
 */
export const mochaCells = (
  pixels: ReadonlyArray<string>,
  look: PetLook,
  draw: PetDraw,
): PetCell[][] => {
  const { tone, from } = look;
  const rich = !draw.ascii && draw.level >= 2;
  const out: PetCell[][] = [];
  for (let row = 0; row + 1 < pixels.length; row += 2) {
    const upper = pixels[row] as string;
    const lower = pixels[row + 1] as string;
    const cells: PetCell[] = [];
    for (let col = 0; col < upper.length; col += 1) {
      const top = upper.charAt(col);
      const bottom = lower.charAt(col);
      if (rich) {
        const a = pixelHex(top, tone, from);
        const b = pixelHex(bottom, tone, from);
        const fa = a === null ? NONE : inkOf(a, draw.level);
        const fb = b === null ? NONE : inkOf(b, draw.level);
        if (a === null && b === null) cells.push({ glyph: " ", fg: NONE, bg: NONE });
        else if (b === null) cells.push({ glyph: "▀", fg: fa, bg: NONE });
        else if (a === null) cells.push({ glyph: "▄", fg: fb, bg: NONE });
        else if (fa === fb) cells.push({ glyph: "█", fg: fa, bg: NONE });
        else cells.push({ glyph: "▀", fg: fa, bg: fb });
        continue;
      }
      const onTop = top !== "." && top !== "E";
      const onBottom = bottom !== "." && bottom !== "E";
      if (!onTop && !onBottom) {
        cells.push({ glyph: " ", fg: NONE, bg: NONE });
        continue;
      }
      const shown =
        onTop && onBottom ? (weight(top) > weight(bottom) ? top : bottom) : onTop ? top : bottom;
      const glyphs = ASCII_GLYPHS[shown] ?? ASCII_BODY;
      const glyph = draw.ascii
        ? onTop && onBottom
          ? glyphs[0]
          : onTop
            ? glyphs[1]
            : glyphs[2]
        : onTop && onBottom
          ? "█"
          : onTop
            ? "▀"
            : "▄";
      const hex = pixelHex(shown, tone, from);
      const fg =
        draw.level === 1
          ? ansi16Of(shown, tone, from)
          : hex === null || draw.level === 0
            ? NONE
            : inkOf(hex, draw.level);
      cells.push({ glyph, fg, bg: NONE });
    }
    out.push(cells);
  }
  return out;
};

const colorOfInk = (ink: Ink): Color | null => {
  if (ink === NONE) return null;
  if (ink.startsWith("#")) return { kind: "rgb", ...rgbOf(ink) };
  const index = Number.parseInt(ink.slice(1), 10);
  return ink.startsWith("i") ? { kind: "indexed", index } : { kind: "ansi", index };
};

/** Where a colour is already at the terminal's level, so it is written as is. */
const sgr = (ink: Ink, background: boolean): string | null => {
  const color = colorOfInk(ink);
  return color === null ? null : colorCodes(color, 3, background);
};

/** A row of cells as one string: runs of equal colours share their escapes. */
const paintCells = (cells: ReadonlyArray<PetCell>): string => {
  let out = "";
  let run = "";
  let open = "";
  const flush = () => {
    if (run === "") return;
    out += open === "" ? run : `\u001b[${open}m${run}\u001b[39;49m`;
    run = "";
  };
  for (const cell of cells) {
    const codes = [sgr(cell.fg, false), sgr(cell.bg, true)].filter((code) => code !== null);
    const next = cell.glyph === " " ? "" : codes.join(";");
    if (next !== open) {
      flush();
      open = next;
    }
    run += cell.glyph;
  }
  flush();
  return out;
};

const drawOf = (theme: Theme, symbols: Symbols): PetDraw => ({
  level: theme.level,
  ascii: symbols === ASCII_SYMBOLS,
});

const frameOf = <T>(list: ReadonlyArray<T>, index: number): T => list[index % list.length] as T;

/** The pet as `PET_HEIGHT` rows of exactly `PET_WIDTH` cells, in glyphs and colours the terminal can show. */
export const petRows = (
  state: PetState,
  frameIndex: number,
  look: PetLook,
  theme: Theme,
  symbols: Symbols,
): string[] =>
  mochaCells(frameOf(MOCHA[state].frames, frameIndex), look, drawOf(theme, symbols)).map(
    paintCells,
  );

/** The one-line pet, `PET_MINI_WIDTH` cells: a cup with her eyes and the state's mark. */
export const petMini = (
  state: PetState,
  frameIndex: number,
  look: PetLook,
  theme: Theme,
  symbols: Symbols,
): string =>
  paintCells(
    mochaCells(frameOf(MOCHA[state].mini, frameIndex), look, drawOf(theme, symbols))[0] ?? [],
  );

/** How many pictures a state has. */
export const petFrameCount = (state: PetState): number => MOCHA[state].frames.length;

/** Cells a drawn pet row takes; for tests and the header's own bookkeeping. */
export const petCells = (rows: ReadonlyArray<string>): number =>
  rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 0);
