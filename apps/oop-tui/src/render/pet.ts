import { visibleWidth } from "../text/width.ts";
import { ASCII_SYMBOLS, type Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";

/**
 * The header's pet: "Oo", a small creature that is the O of the OOP wordmark with a face in its
 * hole. Everything here is pure: what state it is in, which frame that state shows at a given
 * time, where it stands on its track, and how a frame is drawn. The controller owns the clock and
 * the one timer; nothing in this file keeps time or writes to the terminal.
 */

export type PetState =
  | "idle"
  | "working"
  | "thinking"
  | "tool"
  | "waiting"
  | "success"
  | "error"
  | "resting"
  | "greeting";

export const PET_STATES: ReadonlyArray<PetState> = [
  "idle",
  "working",
  "thinking",
  "tool",
  "waiting",
  "success",
  "error",
  "resting",
  "greeting",
];

/** Cells of the full pet: a 9-wide ring and one margin column on each side for marks. */
export const PET_WIDTH = 11;
export const PET_HEIGHT = 4;
/** Cells of the one-line pet used by the compact header. */
export const PET_MINI_WIDTH = 5;

/** Quiet this long, and an idle pet falls asleep. */
export const REST_AFTER_MS = 90_000;
/** How long the greeting at startup, and the happy face after a finished turn, last. */
export const GREETING_MS = 4_000;
export const SUCCESS_MS = 4_000;

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
}

export const newPetMemory = (now: number): PetMemory => ({
  startedAt: now,
  activeAt: now,
  wasWorking: false,
  finishedAt: null,
});

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
  const activeAt = busy || finished || observation.phase === "error" ? now : memory.activeAt;
  if (
    working === memory.wasWorking &&
    finishedAt === memory.finishedAt &&
    activeAt === memory.activeAt
  ) {
    return memory;
  }
  return { ...memory, wasWorking: working, finishedAt, activeAt };
};

/** A key was pressed or the terminal came back into focus: a sleeping pet wakes. */
export const touchPet = (memory: PetMemory, now: number): PetMemory =>
  memory.activeAt === now ? memory : { ...memory, activeAt: now };

/** Maps the app's state to the pet's mood. A running turn beats everything; then the quiet states. */
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
  if (now - memory.startedAt < GREETING_MS && memory.finishedAt === null) return "greeting";
  if (memory.finishedAt !== null && now - memory.finishedAt < SUCCESS_MS) return "success";
  if (now - memory.activeAt >= REST_AFTER_MS) return "resting";
  return "idle";
};

// ---- frames ------------------------------------------------------------------------------

type Where = number | "back" | "front";

interface Mark {
  readonly ch: string;
  readonly row: number;
  /** A column of the 11-wide cell, or the margin behind or in front of the way it is walking. */
  readonly col: Where;
}

interface Frame {
  readonly eyes: readonly [string, string];
  readonly mouth: string;
  /** Which way the face is turned inside the hole; "dir" follows the way the pet walks. */
  readonly look: -1 | 0 | 1 | "dir";
  readonly marks: ReadonlyArray<Mark>;
}

const f = (
  eyes: string,
  mouth: string,
  look: Frame["look"] = 0,
  marks: ReadonlyArray<Mark> = [],
): Frame => ({ eyes: [eyes.charAt(0), eyes.charAt(1)], mouth, look, marks });
const m = (ch: string, row: number, col: Where): Mark => ({ ch, row, col });

export const PET_FRAMES: Readonly<Record<PetState, ReadonlyArray<Frame>>> = {
  // 0 open, 1 blink, 2 looks left, 3 looks right
  idle: [f("oo", "_"), f("--", "_"), f("oo", "_", -1), f("oo", "_", 1)],
  // typing while it walks: the mouth chews, speed lines trail behind
  working: [f("oo", "-", "dir", [m("-", 1, "back")]), f("oo", "o", "dir", [m("-", 2, "back")])],
  thinking: [f("oo", "-", "dir", [m("?", 0, 10)]), f("oo", "o", "dir", [m("?", 1, 10)])],
  tool: [
    f("><", "=", "dir", [m("*", 0, 0), m("+", 0, 10)]),
    f("><", "-", "dir", [m("+", 0, 0), m("*", 0, 10)]),
  ],
  waiting: [f("OO", "o", 0, [m("!", 0, 10)]), f("OO", "o", 0, [m("!", 0, 0), m("!", 0, 10)])],
  success: [
    f("^^", "u", 0, [m("*", 0, 0), m("+", 1, 10)]),
    f("^^", "u", 0, [m("+", 0, 10), m("*", 1, 0)]),
  ],
  error: [f(";;", "n", 0, [m("'", 1, 10)]), f("xx", "o", 0, [m("!", 0, 10)])],
  resting: [
    f("--", ".", 0, [m("z", 1, 10)]),
    f("--", ".", 0, [m("Z", 0, 10)]),
    f("--", "o", 0, [m("z", 1, 10), m("Z", 0, 10)]),
  ],
  greeting: [f("^^", "u", 0, [m("/", 1, 10)]), f("^^", "u", 0, [m("\\", 1, 10)])],
};

interface Segment {
  readonly frame: number;
  readonly ms: number;
}

const seg = (frame: number, ms: number): Segment => ({ frame, ms });

/**
 * How long each frame stays, in order, then round again. A running turn moves at four frames a
 * second at most; an idle pet changes every few seconds and only blinks for an instant.
 */
export const PET_SCRIPTS: Readonly<Record<PetState, ReadonlyArray<Segment>>> = {
  idle: [
    seg(0, 4000),
    seg(2, 2500),
    seg(0, 3000),
    seg(1, 200),
    seg(0, 2500),
    seg(3, 2500),
    seg(0, 1300),
  ],
  working: [seg(0, 250), seg(1, 250)],
  thinking: [seg(0, 500), seg(1, 500)],
  tool: [seg(0, 250), seg(1, 250)],
  waiting: [seg(0, 1000), seg(1, 1000)],
  success: [seg(0, 500), seg(1, 500)],
  error: [seg(0, 800), seg(1, 800)],
  resting: [seg(0, 4000), seg(1, 4000), seg(2, 4000)],
  greeting: [seg(0, 500), seg(1, 500)],
};

/** The states in which the pet walks along its track. */
export const PET_WALKS: ReadonlySet<PetState> = new Set<PetState>(["working", "thinking", "tool"]);

export interface PetClockReading {
  /** Index into `PET_FRAMES[state]`. */
  readonly frame: number;
  /** Counts every segment shown since time zero, so a walk can move once per segment. */
  readonly step: number;
  /** Milliseconds until the frame changes. */
  readonly remaining: number;
}

/** Which frame the state shows at `now`, and how long until it changes. */
export const petClock = (state: PetState, now: number): PetClockReading => {
  const script = PET_SCRIPTS[state];
  let cycle = 0;
  for (const part of script) cycle += part.ms;
  const lap = Math.floor(now / cycle);
  const into = now - lap * cycle;
  let end = 0;
  for (let index = 0; index < script.length; index += 1) {
    const part = script[index] as Segment;
    end += part.ms;
    if (into < end) {
      return { frame: part.frame, step: lap * script.length + index, remaining: end - into };
    }
  }
  return { frame: 0, step: lap * script.length, remaining: cycle };
};

// ---- motion ------------------------------------------------------------------------------

export interface PetPose {
  /** Cells from the left end of the track. */
  readonly x: number;
  readonly dir: 1 | -1;
  /** The last step moved on, so two draws in one step move it once. */
  readonly step: number;
}

export const INITIAL_POSE: PetPose = { x: 0, dir: 1, step: -1 };

/**
 * Moves the pet one cell per step while the state walks, turning at the ends of the track; a pet
 * that does not walk stays where it is. `travel` is how many cells the track has beyond the pet.
 */
export const stepPose = (pose: PetPose, state: PetState, step: number, travel: number): PetPose => {
  const limit = Math.max(0, travel);
  const x = Math.min(pose.x, limit);
  if (step === pose.step || !PET_WALKS.has(state) || limit === 0) {
    return x === pose.x && step === pose.step ? pose : { ...pose, x, step };
  }
  let dir = pose.dir;
  let next = x + dir;
  if (next < 0 || next > limit) {
    dir = dir === 1 ? -1 : 1;
    next = x + dir;
  }
  return { x: next, dir, step };
};

// ---- drawing -----------------------------------------------------------------------------

const BODY_TOP = " ▄█████▄ ";
const BODY_BOTTOM = " ▀█████▀ ";
const BODY_SIDE = "██";
type Kind = "body" | "face" | "mark" | "space";
const BODY_CHARS = /[▄▀█]/gu;

const cellOf = (frame: Frame, dir: 1 | -1, row: number): string => {
  const look = frame.look === "dir" ? dir : frame.look;
  const hole = [" ", " ", " ", " ", " "];
  // Eyes sit at 1 and 3 of the 5-cell hole, the mouth between them; the look shifts all three.
  if (row === 1) {
    hole[1 + look] = frame.eyes[0];
    hole[3 + look] = frame.eyes[1];
  } else if (row === 2) {
    hole[2 + look] = frame.mouth;
  }
  return `${BODY_SIDE}${hole.join("")}${BODY_SIDE}`;
};

/** The pet as `PET_HEIGHT` rows of exactly `PET_WIDTH` cells, in glyphs `symbols` can show. */
export const petRows = (
  state: PetState,
  frameIndex: number,
  dir: 1 | -1,
  theme: Theme,
  symbols: Symbols,
): string[] => {
  const frames = PET_FRAMES[state];
  const frame = frames[frameIndex % frames.length] as Frame;
  const ascii = symbols === ASCII_SYMBOLS;
  const accent =
    state === "error" ? theme.error : state === "waiting" ? theme.warning : theme.accent;
  const rows: string[] = [];
  for (let row = 0; row < PET_HEIGHT; row += 1) {
    const body = row === 0 ? BODY_TOP : row === 3 ? BODY_BOTTOM : cellOf(frame, dir, row);
    const cells = [" ", ...body, " "];
    for (const mark of frame.marks) {
      if (mark.row !== row) continue;
      const col =
        mark.col === "back"
          ? dir === 1
            ? 0
            : 10
          : mark.col === "front"
            ? dir === 1
              ? 10
              : 0
            : mark.col;
      cells[col] = `\u0000${mark.ch}`;
    }
    let out = "";
    let run = "";
    let kind: Kind | null = null;
    const paint = (which: Kind | null, text: string): string =>
      which === "body"
        ? theme.brand(text)
        : which === "face"
          ? theme.text.bold(text)
          : which === "mark"
            ? accent.bold(text)
            : text;
    for (const cell of cells) {
      const isMark = cell.startsWith("\u0000");
      const ch = isMark ? cell.slice(1) : cell;
      const next: Kind = isMark
        ? "mark"
        : ch === " "
          ? "space"
          : BODY_CHARS.test(ch)
            ? "body"
            : "face";
      BODY_CHARS.lastIndex = 0;
      if (next !== kind && run !== "") {
        out += paint(kind, run);
        run = "";
      }
      kind = next;
      run += ascii ? ch.replace(BODY_CHARS, "#") : ch;
      BODY_CHARS.lastIndex = 0;
    }
    out += paint(kind, run);
    rows.push(out);
  }
  return rows;
};

/** The one-line pet, `PET_MINI_WIDTH` cells: the same face inside brackets. */
export const petMini = (state: PetState, frameIndex: number, theme: Theme): string => {
  const frames = PET_FRAMES[state];
  const frame = frames[frameIndex % frames.length] as Frame;
  return `${theme.brand("(")}${theme.text.bold(frame.eyes[0] + frame.mouth + frame.eyes[1])}${theme.brand(")")}`;
};

/** Cells a drawn pet row takes; for tests and the header's own bookkeeping. */
export const petCells = (rows: ReadonlyArray<string>): number =>
  rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 0);
