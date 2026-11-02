import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import { rgbToIndexed, type ColorLevel } from "./color.ts";
import {
  MOCHA,
  MOCHA_ANSI16,
  MOCHA_ANSI16_TONE,
  MOCHA_LIQUID,
  MOCHA_PALETTE,
  MOCHA_STEAM_LIFT,
  MOCHA_TONE_CASES,
} from "./mochaArt.ts";
import {
  GREETING_MS,
  mochaCells,
  newPetMemory,
  observePet,
  PET_HEIGHT,
  PET_MINI_WIDTH,
  PET_STATES,
  PET_WIDTH,
  petClock,
  petFrameCount,
  petLook,
  petMini,
  petRows,
  petState,
  REST_AFTER_MS,
  SUCCESS_MS,
  SWITCH_MS,
  toneOf,
  touchPet,
  type PetLook,
  type PetModel,
  type PetObservation,
  type PetState,
  type PetTone,
} from "./pet.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

setLanguage("en");

const themeAt = (level: ColorLevel) => createTheme("oop", BUILTIN_THEMES.oop, level);
const truecolor = themeAt(3);
const plain = themeAt(0);

const quiet: PetObservation = {
  phase: "idle",
  tool: false,
  streaming: false,
  online: true,
  model: null,
};
const T = 1_000_000;
const model = (scope: string, key: string, tone: PetTone): PetModel => ({ scope, key, tone });
const same = (tone: PetTone): PetLook => ({ tone, from: tone });

/** The pet's rows with no colour escapes. */
const text = (
  state: PetState,
  frame: number,
  symbols = UNICODE_SYMBOLS,
  tone: PetTone = "claude",
) => petRows(state, frame, same(tone), plain, symbols).map(stripAnsi);

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
    const known = observePet(memory, { ...quiet, model: model("a", "x/y", "claude") }, T + 5);
    expect(observePet(known, { ...quiet, model: model("a", "x/y", "claude") }, T + 9)).toBe(known);
  });

  it("jumps and changes colour when the model changes in place, but not for a first or another thread's", () => {
    const seen = (m: PetModel) => ({ ...quiet, model: m });
    const t0 = T + GREETING_MS + 1;
    let memory = observePet(newPetMemory(T), seen(model("a", "codex/gpt", "openai")), t0);
    // The first model is no switch; she simply has its colour.
    expect(petState(memory, seen(model("a", "codex/gpt", "openai")), t0)).toBe("idle");
    expect(petLook(memory, "idle")).toEqual(same("openai"));
    // Another thread's model is no switch either.
    memory = observePet(memory, seen(model("b", "claude/opus", "claude")), t0 + 10);
    expect(petState(memory, seen(model("b", "claude/opus", "claude")), t0 + 10)).toBe("idle");
    // The same thread's model changing is: she leaves the old colour for the new.
    const at = t0 + 5_000;
    const now = seen(model("b", "codex/gpt", "openai"));
    memory = observePet(memory, now, at);
    expect(petState(memory, now, at + 1)).toBe("switching");
    expect(petLook(memory, "switching")).toEqual({ tone: "openai", from: "claude" });
    expect(petLook(memory, "idle")).toEqual(same("openai"));
    // It plays once from the moment of the change, the first frame first and the last at its end.
    expect(petClock("switching", at, memory).frame).toBe(0);
    expect(petClock("switching", at + SWITCH_MS - 1, memory).frame).toBe(
      petFrameCount("switching") - 1,
    );
    expect(petState(memory, now, at + SWITCH_MS)).toBe("idle");
    // A turn beats it.
    expect(petState(memory, { ...now, phase: "working" }, at + 1)).toBe("thinking");
  });
});

describe("toneOf", () => {
  it("colours the coffee by provider adapter", () => {
    for (const [driver, instanceId, modelSlug, tone] of MOCHA_TONE_CASES) {
      expect(toneOf(driver, instanceId, modelSlug), `${driver} ${instanceId} ${modelSlug}`).toBe(
        tone,
      );
    }
    expect(toneOf("claudeAgent", "a", "m")).toBe("claude");
    expect(toneOf("codex", "a", "m")).toBe("openai");
    // Words inside a longer word are no hint: a "localhost" model is not a local one.
    expect(toneOf("grok", "localhost", "m")).toBe("default");
    expect(toneOf(null, "microlocalization", "m")).toBe("default");
  });
});

describe("the art", () => {
  it("is 14 by 10 pixels, 2 to 4 frames a state, every frame in its script", () => {
    expect(PET_WIDTH).toBe(14);
    expect(PET_HEIGHT).toBe(5);
    expect(PET_MINI_WIDTH).toBe(7);
    expect(PET_STATES).toHaveLength(10);
    for (const state of PET_STATES) {
      const art = MOCHA[state];
      expect(art.frames.length).toBeGreaterThanOrEqual(2);
      expect(art.frames.length).toBeLessThanOrEqual(4);
      expect(art.mini).toHaveLength(art.frames.length);
      for (const frame of art.frames) {
        expect(frame).toHaveLength(10);
        for (const row of frame) expect([...row]).toHaveLength(14);
      }
      for (const frame of art.mini) {
        expect(frame).toHaveLength(2);
        for (const row of frame) expect([...row]).toHaveLength(7);
      }
      for (const [frame] of art.script) expect(frame).toBeLessThan(art.frames.length);
    }
  });

  it("uses only pixels the palette knows, and the coffee's two shades only in a switch", () => {
    for (const state of PET_STATES) {
      for (const frame of [...MOCHA[state].frames, ...MOCHA[state].mini]) {
        for (const ch of frame.join("")) {
          expect(ch === "." || ch in MOCHA_PALETTE || "LSls".includes(ch), ch).toBe(true);
          if (state !== "switching") expect("ls".includes(ch)).toBe(false);
        }
      }
    }
  });

  it("keeps the body solid: no hollow centre, whatever the eyes, bounce or shake", () => {
    for (const state of PET_STATES) {
      for (const frame of MOCHA[state].frames) {
        const first = frame.findIndex((row) => row.includes("B"));
        for (const row of frame.slice(first, first + 5)) {
          const edge = [...row].findIndex((ch) => ch === "B" || ch === "H");
          expect([...row].slice(edge, edge + 6)).not.toContain(".");
        }
      }
    }
  });

  it("never changes frame faster than four times a second but the idle blink", () => {
    for (const state of PET_STATES) {
      for (const [frame, ms] of MOCHA[state].script) {
        if (state === "idle" && frame === 2) continue;
        expect(ms, state).toBeGreaterThanOrEqual(250);
      }
    }
    // An idle pet steams in turns every second or two and blinks every three or four seconds.
    const idle = MOCHA.idle.script;
    expect(idle.reduce((sum, [, ms]) => sum + ms, 0)).toBeGreaterThanOrEqual(3000);
    expect(idle.reduce((sum, [, ms]) => sum + ms, 0)).toBeLessThanOrEqual(4000);
    expect(Math.min(...MOCHA.resting.script.map(([, ms]) => ms))).toBeGreaterThanOrEqual(4000);
  });

  it("gives every state a look of its own, in the picture and in its one-line form", () => {
    // A switch's first picture is an idle one in the old colour; the wave is told by the whole run.
    const look = new Set(
      PET_STATES.map((state) =>
        Array.from(
          { length: petFrameCount(state) },
          (_, frame) =>
            `${text(state, frame).join("\n")}\n${stripAnsi(petMini(state, frame, same("claude"), plain, UNICODE_SYMBOLS))}`,
        ).join("\n--\n"),
      ),
    );
    expect(look.size).toBe(PET_STATES.length);
    // the idle blink closes her eyes
    expect(text("idle", 2).join("\n")).not.toBe(text("idle", 0).join("\n"));
  });

  it("has no steam when she sleeps, and a bounce that lifts the cup off the coaster", () => {
    expect(MOCHA.resting.frames.every((frame) => !frame.join("").includes("S"))).toBe(true);
    // Row 9 is the coaster; a bounced cup leaves row 8 (the cup's bottom) empty above it.
    expect(
      MOCHA.working.frames.some((frame) => (frame[8] as string).replaceAll(".", "") === ""),
    ).toBe(true);
  });
});

describe("the Rust app draws the same pictures", () => {
  // fixtures/pet/mocha.json is what `scripts/export-fixtures.mjs` writes from mochaArt.ts and pet.ts;
  // src/pet.rs loads it and its tests compare every cell it draws with these. `--check` of the script
  // fails when it is stale.
  const fixture = JSON.parse(
    NodeFS.readFileSync(
      new URL("../../../oop-tui-rs/fixtures/pet/mocha.json", import.meta.url),
      "utf8",
    ),
  ) as {
    palette: unknown;
    liquid: unknown;
    steamLift: number;
    ansi16: unknown;
    ansi16Tone: unknown;
    states: unknown;
    toneCases: unknown;
    golden: {
      look: PetLook;
      glyphs: Record<string, Record<string, string[][]>>;
      cells: Record<string, Record<string, { full: string[]; mini: string[] }>>;
    };
  };

  it("holds the very data of this client", () => {
    expect(fixture.palette).toEqual(MOCHA_PALETTE);
    expect(fixture.liquid).toEqual(MOCHA_LIQUID);
    expect(fixture.steamLift).toBe(MOCHA_STEAM_LIFT);
    expect(fixture.ansi16).toEqual(MOCHA_ANSI16);
    expect(fixture.ansi16Tone).toEqual(MOCHA_ANSI16_TONE);
    expect(fixture.states).toEqual(MOCHA);
    expect(fixture.toneCases).toEqual(MOCHA_TONE_CASES);
  });

  it("records every glyph this client draws, in colour, flat and ASCII", () => {
    const { look, glyphs } = fixture.golden;
    const modes = {
      rich: { level: 3, ascii: false },
      flat: { level: 0, ascii: false },
      ascii: { level: 0, ascii: true },
    } as const;
    for (const [mode, draw] of Object.entries(modes)) {
      for (const state of PET_STATES) {
        const of = (list: ReadonlyArray<ReadonlyArray<string>>) =>
          list.map((rows) =>
            mochaCells(rows, look, draw).map((row) => row.map((c) => c.glyph).join("")),
          );
        expect(of(MOCHA[state].frames)).toEqual(glyphs[mode]?.[state]);
        expect(of(MOCHA[state].mini)).toEqual(glyphs[`mini-${mode}`]?.[state]);
      }
    }
  });

  it("records every cell and colour of each state's first picture at each colour level", () => {
    const { look, cells } = fixture.golden;
    const levels = {
      "3": { level: 3, ascii: false },
      "1": { level: 1, ascii: false },
      "0": { level: 0, ascii: false },
      ascii1: { level: 1, ascii: true },
    } as const;
    for (const [name, draw] of Object.entries(levels)) {
      for (const state of PET_STATES) {
        const encode = (rows: ReadonlyArray<string>) =>
          mochaCells(rows, look, draw).map((row) =>
            row.map((c) => `${c.glyph} ${c.fg} ${c.bg}`).join(","),
          );
        expect(encode(MOCHA[state].frames[0] as string[])).toEqual(cells[name]?.[state]?.full);
        expect(encode(MOCHA[state].mini[0] as string[])).toEqual(cells[name]?.[state]?.mini);
      }
    }
  });
});

describe("petRows", () => {
  it("is five rows of PET_WIDTH cells for every state, frame, colour level and symbol set", () => {
    for (const level of [0, 1, 2, 3] as const) {
      for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
        for (const state of PET_STATES) {
          for (let frame = 0; frame < petFrameCount(state); frame += 1) {
            const rows = petRows(state, frame, same("local"), themeAt(level), symbols);
            expect(rows).toHaveLength(PET_HEIGHT);
            for (const row of rows) expect(visibleWidth(row)).toBe(PET_WIDTH);
            const mini = petMini(state, frame, same("local"), themeAt(level), symbols);
            expect(visibleWidth(mini)).toBe(PET_MINI_WIDTH);
          }
        }
      }
    }
  });

  it("uses nothing but ASCII when the symbols are ASCII, and reads as a mug", () => {
    for (const state of PET_STATES) {
      for (let frame = 0; frame < petFrameCount(state); frame += 1) {
        for (const theme of [plain, truecolor]) {
          const rows = petRows(state, frame, same("claude"), theme, ASCII_SYMBOLS).map(stripAnsi);
          expect(rows.join("")).toMatch(/^[\x20-\x7e]*$/u);
          const mini = petMini(state, frame, same("claude"), theme, ASCII_SYMBOLS);
          expect(stripAnsi(mini)).toMatch(/^[\x20-\x7e]*$/u);
        }
      }
    }
    expect(
      text("idle", 0, ASCII_SYMBOLS)
        .slice(2)
        .every((row) => row.includes("#")),
    ).toBe(true);
  });

  it("draws nothing but glyphs a terminal shows in one cell", () => {
    // Block elements and ASCII only: no emoji, no ambiguous-width symbols.
    for (const state of PET_STATES) {
      for (let frame = 0; frame < petFrameCount(state); frame += 1) {
        expect(text(state, frame).join("")).toMatch(/^[\x20-\x7e▄▀█]*$/u);
      }
    }
  });

  it("paints truecolor pixels with the exact palette, two to a cell", () => {
    const rows = petRows("idle", 0, same("claude"), truecolor, UNICODE_SYMBOLS);
    // The coffee is the provider's own hex, the steam lifted toward white.
    expect(rows[1]).toContain("38;2;217;119;87");
    // The shaded cup over the wooden coaster: one cell, cream shade on brown.
    expect(rows[4]).toContain("38;2;216;207;194;48;2;140;90;60");
    // Eyes are dark espresso, cheeks soft terracotta.
    expect(rows.join("")).toContain("43;38;37");
    expect(rows.join("")).toContain("224;122;95");
  });

  it("follows the provider: each one's coffee, in its own hex", () => {
    for (const [tone, rgb] of [
      ["claude", "38;2;217;119;87"],
      ["openai", "38;2;16;163;127"],
      ["local", "38;2;124;58;237"],
      ["default", "38;2;111;78;55"],
    ] as const) {
      expect(petRows("idle", 0, same(tone), truecolor, UNICODE_SYMBOLS).join("")).toContain(rgb);
    }
  });

  it("paints a switch as a wave from the old colour to the new", () => {
    const look: PetLook = { tone: "openai", from: "claude" };
    const first = petRows("switching", 0, look, truecolor, UNICODE_SYMBOLS).join("");
    const last = petRows(
      "switching",
      petFrameCount("switching") - 1,
      look,
      truecolor,
      UNICODE_SYMBOLS,
    ).join("");
    expect(first).toContain("16;163;127");
    expect(first).toContain("217;119;87");
    expect(last).toContain("16;163;127");
    expect(last).not.toContain("217;119;87");
  });

  it("uses the nearest 256-colour slots, and no truecolor, at 256 colours", () => {
    const rows = petRows("idle", 0, same("openai"), themeAt(2), UNICODE_SYMBOLS).join("");
    expect(rows).not.toContain("38;2;");
    expect(rows).toContain(`38;5;${rgbToIndexed({ r: 0x10, g: 0xa3, b: 0x7f })}`);
    expect(rows).toContain(`48;5;${rgbToIndexed({ r: 0x8c, g: 0x5a, b: 0x3c })}`);
  });

  it("draws one colour a cell at 16 colours, with no background, and the eyes as holes", () => {
    const flat = themeAt(1);
    const rows = petRows("idle", 0, same("local"), flat, UNICODE_SYMBOLS);
    const all = rows.join("");
    // The coffee is magenta, the cup white, the coaster yellow-brown: only the 16 colours.
    expect(all).toContain("\u001b[35m");
    expect(all).toContain("\u001b[97m");
    expect(all).not.toContain("\u001b[38;");
    expect(all).not.toContain("\u001b[48;");
    // no background at all: a 16-colour cell is one colour
    expect(all.split("\u001b[").some((part) => /^4\d[;m]/u.test(part))).toBe(false);
    // The eyes are gaps in a row of cup: still a mug, just unpainted.
    expect(stripAnsi(rows[2] as string)).toMatch(/▀.*▀/u);
  });

  it("is plain glyphs, with no escape at all, with no colour", () => {
    for (const state of PET_STATES) {
      const rows = petRows(state, 0, same("claude"), plain, UNICODE_SYMBOLS);
      expect(rows.join("")).not.toContain("\u001b");
    }
  });
});

describe("petClock", () => {
  it("walks through the script and says how long a frame has left", () => {
    expect(petClock("working", 0)).toEqual({ frame: 0, remaining: 250 });
    expect(petClock("working", 260)).toEqual({ frame: 1, remaining: 240 });
    expect(petClock("working", 1000)).toEqual({ frame: 0, remaining: 250 });
    // The steam alternates, and the blink is brief and comes every few seconds.
    expect(petClock("idle", 100).frame).toBe(0);
    expect(petClock("idle", 1700).frame).toBe(1);
    expect(petClock("idle", 1600 + 1700 + 100)).toEqual({ frame: 2, remaining: 100 });
  });
});
