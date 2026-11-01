import { describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  GREETING_MS,
  INITIAL_POSE,
  newPetMemory,
  observePet,
  PET_FRAMES,
  PET_HEIGHT,
  PET_SCRIPTS,
  PET_STATES,
  PET_WALKS,
  PET_WIDTH,
  petClock,
  petMini,
  petRows,
  petState,
  REST_AFTER_MS,
  stepPose,
  SUCCESS_MS,
  touchPet,
  type PetObservation,
  type PetState,
} from "./pet.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

setLanguage("en");

const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
const plain = createTheme("oop", BUILTIN_THEMES.oop, 0);

const quiet: PetObservation = { phase: "idle", tool: false, streaming: false, online: true };
const T = 1_000_000;

describe("petState", () => {
  it("maps a running turn to thinking, working (text arrives) or tool", () => {
    const memory = newPetMemory(T);
    const turn = { ...quiet, phase: "working" } as const;
    expect(petState(memory, turn, T)).toBe("thinking");
    expect(petState(memory, { ...turn, streaming: true }, T)).toBe("working");
    expect(petState(memory, { ...turn, streaming: true, tool: true }, T)).toBe("tool");
  });

  it("waits for approvals and answers, and is sad for errors and a lost link", () => {
    const memory = newPetMemory(T);
    expect(petState(memory, { ...quiet, phase: "approval" }, T)).toBe("waiting");
    expect(petState(memory, { ...quiet, phase: "input" }, T)).toBe("waiting");
    expect(petState(memory, { ...quiet, phase: "error" }, T)).toBe("error");
    expect(petState(memory, { ...quiet, online: false }, T)).toBe("error");
  });

  it("greets at startup, then idles", () => {
    const memory = newPetMemory(T);
    expect(petState(memory, quiet, T)).toBe("greeting");
    expect(petState(memory, quiet, T + GREETING_MS)).toBe("idle");
  });

  it("is happy for a moment when a turn ends well, and not when it ends in an error", () => {
    const working = { ...quiet, phase: "working" } as const;
    let memory = observePet(newPetMemory(T), working, T + 10_000);
    memory = observePet(memory, quiet, T + 20_000);
    expect(petState(memory, quiet, T + 20_000)).toBe("success");
    expect(petState(memory, quiet, T + 20_000 + SUCCESS_MS)).toBe("idle");
    const failed = observePet(
      observePet(newPetMemory(T), working, T + 10_000),
      { ...quiet, phase: "error" },
      T + 20_000,
    );
    expect(petState(failed, { ...quiet, phase: "error" }, T + 20_000)).toBe("error");
    expect(failed.finishedAt).toBeNull();
  });

  it("falls asleep after a quiet while, and a key press wakes it", () => {
    const memory = newPetMemory(T);
    const late = T + REST_AFTER_MS + GREETING_MS;
    expect(petState(memory, quiet, late - 1)).toBe("resting");
    expect(petState(touchPet(memory, late), quiet, late)).toBe("idle");
  });

  it("does not change memory for an observation that changed nothing", () => {
    const memory = newPetMemory(T);
    expect(observePet(memory, quiet, T + 5)).toBe(memory);
  });

  it("has every state with at least two frames, each in the script", () => {
    for (const state of PET_STATES) {
      expect(PET_FRAMES[state].length).toBeGreaterThanOrEqual(2);
      for (const part of PET_SCRIPTS[state]) {
        expect(part.frame).toBeLessThan(PET_FRAMES[state].length);
      }
    }
  });
});

describe("petClock", () => {
  const segments = (state: PetState) => PET_SCRIPTS[state].length;

  it("never changes frame faster than four times a second", () => {
    for (const state of PET_STATES) {
      for (const part of PET_SCRIPTS[state]) {
        // A blink is the one instant frame; it is idle's and comes after seconds of stillness.
        if (state === "idle" && part.frame === 1) continue;
        expect(part.ms).toBeGreaterThanOrEqual(250);
      }
    }
  });

  it("changes an idle or sleeping pet only every few seconds, apart from the blink", () => {
    const cycle = (state: PetState) => PET_SCRIPTS[state].reduce((sum, part) => sum + part.ms, 0);
    const held = PET_SCRIPTS.idle.filter((part) => part.frame !== 1);
    expect(Math.min(...held.map((part) => part.ms))).toBeGreaterThanOrEqual(1300);
    // Seven changes in sixteen seconds, one of them the blink.
    expect(cycle("idle") / PET_SCRIPTS.idle.length).toBeGreaterThan(2000);
    expect(Math.min(...PET_SCRIPTS.resting.map((part) => part.ms))).toBeGreaterThanOrEqual(4000);
  });

  it("walks through the script and says how long a frame has left", () => {
    expect(petClock("working", 0)).toEqual({ frame: 0, step: 0, remaining: 250 });
    expect(petClock("working", 260)).toEqual({ frame: 1, step: 1, remaining: 240 });
    expect(petClock("working", 500)).toEqual({ frame: 0, step: 2, remaining: 250 });
    expect(petClock("idle", 4000 + 100).frame).toBe(2);
    expect(segments("idle")).toBe(7);
  });
});

describe("stepPose", () => {
  it("walks one cell per step while working, turning at the ends of the track", () => {
    let pose = INITIAL_POSE;
    const xs: number[] = [];
    for (let step = 0; step < 9; step += 1) {
      pose = stepPose(pose, "working", step, 3);
      xs.push(pose.x);
    }
    expect(xs).toEqual([1, 2, 3, 2, 1, 0, 1, 2, 3]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(3);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  it("moves once per step however often it is asked", () => {
    const once = stepPose(INITIAL_POSE, "tool", 5, 4);
    expect(stepPose(once, "tool", 5, 4)).toBe(once);
  });

  it("stays still when it is not working, and where it stopped", () => {
    const walked = stepPose(stepPose(INITIAL_POSE, "working", 1, 6), "working", 2, 6);
    for (const state of PET_STATES.filter((state) => !PET_WALKS.has(state))) {
      expect(stepPose(walked, state, 3, 6).x).toBe(walked.x);
    }
  });

  it("does not move on a track with no room, and pulls back when the track shrinks", () => {
    expect(stepPose(INITIAL_POSE, "working", 1, 0).x).toBe(0);
    expect(stepPose({ x: 9, dir: 1, step: 1 }, "idle", 2, 4).x).toBe(4);
  });
});

describe("petRows", () => {
  it("is four rows of eleven cells for every state and frame, in Unicode and ASCII", () => {
    for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
      for (const state of PET_STATES) {
        for (let frame = 0; frame < PET_FRAMES[state].length; frame += 1) {
          for (const dir of [1, -1] as const) {
            const rows = petRows(state, frame, dir, plain, symbols);
            expect(rows).toHaveLength(PET_HEIGHT);
            for (const row of rows) expect(visibleWidth(row)).toBe(PET_WIDTH);
          }
        }
      }
    }
    expect(PET_WIDTH).toBeGreaterThanOrEqual(8);
    expect(PET_WIDTH).toBeLessThanOrEqual(12);
  });

  it("uses nothing but ASCII when the symbols are ASCII", () => {
    for (const state of PET_STATES) {
      for (let frame = 0; frame < PET_FRAMES[state].length; frame += 1) {
        const text = petRows(state, frame, 1, plain, ASCII_SYMBOLS).join("");
        expect(text).toMatch(/^[\x20-\x7e]*$/u);
      }
    }
  });

  it("paints the ring in the theme's lavender", () => {
    const brand = petRows("idle", 0, 1, theme, UNICODE_SYMBOLS)[1] as string;
    expect(brand).toContain(theme.brand("██"));
  });

  it("gives each state a face of its own", () => {
    const faces = new Set(
      PET_STATES.map((state) => stripAnsi(petRows(state, 0, 1, plain, UNICODE_SYMBOLS).join("\n"))),
    );
    expect(faces.size).toBe(PET_STATES.length);
    const blink = stripAnsi(petRows("idle", 1, 1, plain, UNICODE_SYMBOLS)[1] as string);
    const open = stripAnsi(petRows("idle", 0, 1, plain, UNICODE_SYMBOLS)[1] as string);
    expect(blink).not.toBe(open);
  });

  it("turns the working face toward the way it walks", () => {
    const right = stripAnsi(petRows("working", 0, 1, plain, UNICODE_SYMBOLS)[1] as string);
    const left = stripAnsi(petRows("working", 0, -1, plain, UNICODE_SYMBOLS)[1] as string);
    expect(right).not.toBe(left);
  });

  it("has a one-line form of five cells", () => {
    for (const state of PET_STATES) {
      expect(visibleWidth(petMini(state, 0, plain))).toBe(5);
    }
  });
});
