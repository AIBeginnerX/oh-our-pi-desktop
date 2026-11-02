import { describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  headerRows,
  headerTrack,
  HEADER_FULL_ROWS,
  renderHeader,
  type HeaderInput,
} from "./header.ts";
import { PET_MINI_WIDTH, PET_TRACK_WIDTH, PET_WIDTH } from "./pet.ts";
import type { CrewRoleModel } from "../app/crew.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

setLanguage("en");

const input = (extra: Partial<HeaderInput> = {}): HeaderInput => ({
  columns: 76,
  rows: 45,
  theme: createTheme("oop", BUILTIN_THEMES.oop, 0),
  symbols: UNICODE_SYMBOLS,
  version: "0.0.133",
  cwd: "/home/me/work/app",
  home: "/home/me",
  status: { state: "working", model: "GPT-5.1", thread: "Fix the login bug" },
  crew: null,
  pet: { state: "working", frame: 0, look: { tone: "claude", from: "claude" } },
  ...extra,
});

const text = (rows: ReadonlyArray<string>) => rows.map(stripAnsi);

describe("renderHeader", () => {
  it("shows the logo with version, live state, model, thread and folder, and no address", () => {
    const frame = renderHeader(input());
    expect(frame.lead).toHaveLength(HEADER_FULL_ROWS);
    const lines = text(frame.lead).join("\n");
    expect(lines).toMatch(/[█▄▀]/u);
    expect(lines).toContain("v0.0.133");
    expect(lines).toContain("Working");
    expect(lines).toContain("GPT-5.1");
    expect(lines).toContain("Fix the login bug");
    expect(lines).toContain("~/work/app");
    expect(lines).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{4}|Server/u);
  });

  it("says what is true now: idle, waiting, error, offline, and no thread on a list", () => {
    const word = (state: HeaderInput["status"]["state"], thread: string | null = "t") =>
      text(renderHeader(input({ status: { state, model: null, thread } })).lead).join("\n");
    expect(word("idle")).toContain("Idle");
    expect(word("waiting")).toContain("Needs you");
    expect(word("error")).toContain("Error");
    expect(word("offline")).toContain("Offline");
    expect(word("none", null)).toContain("No thread open");
    expect(word("none", null)).toContain("No model");
  });

  it("never lets the logo, status and pet strip together exceed the column or overlap", () => {
    for (const columns of [30, 41, 53, 54, 76, 120]) {
      for (const rows of [14, 24, 45]) {
        const frame = renderHeader(input({ columns, rows }));
        const height = headerRows(columns, rows);
        expect(frame.lead).toHaveLength(height);
        const leadWidth = columns - frame.trackWidth;
        frame.lead.forEach((row, index) => {
          // the rows under the wordmark have no strip and run the full width
          const room = index < frame.track.length ? leadWidth : columns - 1;
          expect(visibleWidth(row)).toBeLessThanOrEqual(room);
        });
        for (const row of frame.track)
          expect(visibleWidth(row)).toBeLessThanOrEqual(frame.trackWidth);
        if (frame.trackWidth > 0) {
          // Mocha stands five rows tall beside the full header's notes; her one-line form is one row.
          expect(frame.track).toHaveLength(frame.trackWidth === PET_TRACK_WIDTH ? 5 : 1);
        }
      }
    }
  });

  it("stands Mocha in the strip, five rows tall: the status text and the edge stay clear", () => {
    const track = headerTrack(76, 45, true);
    expect(track).toEqual({ full: true, width: PET_TRACK_WIDTH, mini: false });
    const frame = renderHeader(input());
    expect(frame.track).toHaveLength(5);
    for (const row of text(frame.track)) {
      expect(visibleWidth(row)).toBe(frame.trackWidth);
      // a gap in front of her, and the last column free next to the divider
      expect(row.startsWith(" ")).toBe(true);
      expect(row.endsWith(" ")).toBe(true);
    }
    // the thread row is cut before the strip, and the folder row under it runs the full width
    expect(visibleWidth(frame.lead[4] as string)).toBeLessThanOrEqual(76 - frame.trackWidth);
    expect(text(frame.lead)[5]).toContain("~/work/app");
    // she holds still: the same frame draws the same strip
    expect(renderHeader(input()).track).toEqual(frame.track);
  });

  it("falls back to her one-line form on the first row where five rows do not fit", () => {
    const track = headerTrack(48, 45, true);
    expect(track).toEqual({ full: true, width: 9, mini: true });
    const frame = renderHeader(input({ columns: 48 }));
    expect(frame.lead).toHaveLength(HEADER_FULL_ROWS);
    expect(frame.track).toHaveLength(1);
    expect(frame.trackWidth).toBe(track.width);
  });

  it("folds to one line on a short terminal and keeps the state, with a one-line pet", () => {
    const frame = renderHeader(input({ columns: 54, rows: 24 }));
    expect(frame.lead).toHaveLength(1);
    expect(text(frame.lead)[0]).toContain("OOP v0.0.133");
    expect(text(frame.lead)[0]).toContain("Working");
    expect(frame.trackWidth).toBeGreaterThanOrEqual(PET_MINI_WIDTH + 2);
    // The one-line Mocha: a small cup in block glyphs, and the mark that her state adds.
    expect(text(frame.track)[0]).toMatch(/[▄▀█]{3}/u);
  });

  it("drops the pet, not the status, when the strip has no room or the pet is off", () => {
    expect(renderHeader(input({ columns: 40, rows: 45 })).trackWidth).toBe(0);
    const off = renderHeader(input({ pet: null }));
    expect(off.trackWidth).toBe(0);
    expect(off.track).toEqual([]);
    expect(text(off.lead).join("\n")).toContain("Working");
  });

  it("draws the wordmark and pet in ASCII when the symbols are ASCII", () => {
    const frame = renderHeader(input({ symbols: ASCII_SYMBOLS }));
    const all = [...text(frame.lead), ...text(frame.track)].join("\n");
    expect(all).toMatch(/^[\x20-\x7e\n]*$/u);
    expect(all).toContain("#");
  });

  it("keeps PET_WIDTH within the strip", () => {
    expect(headerTrack(76, 45, true).width).toBeGreaterThan(PET_WIDTH);
    expect(headerTrack(76, 45, false).width).toBe(0);
  });
});

describe("the crew in the header", () => {
  const crew: ReadonlyArray<CrewRoleModel> = [
    { role: "worker", model: "DeepSeek V4.1 Flash" },
    { role: "expert", model: "Sonnet 5.5" },
    { role: "auditor", model: "Opus 5.5" },
  ];
  const line = (frame: ReturnType<typeof renderHeader>, index: number) =>
    text(frame.lead)[index] as string;

  it("names each role with its model on the folder row of the full header", () => {
    for (const columns of [100, 140]) {
      const frame = renderHeader(input({ columns, crew }));
      expect(frame.lead).toHaveLength(HEADER_FULL_ROWS);
      expect(line(frame, 5)).toContain("~/work/app");
      expect(line(frame, 5)).toContain(
        "Crew worker DeepSeek V4.1 Flash · expert Sonnet 5.5 · auditor Opus 5.5",
      );
    }
  });

  it("says nothing of the crew when it is off, and keeps the row", () => {
    const frame = renderHeader(input({ columns: 140, crew: null }));
    expect(frame.lead).toHaveLength(HEADER_FULL_ROWS);
    expect(text(frame.lead).join("\n")).not.toMatch(/Crew|worker/u);
    expect(line(frame, 5)).toContain("~/work/app");
  });

  it("falls back to a letter for each role, then to an ellipsis, and never overflows", () => {
    const wide = renderHeader(input({ columns: 100, crew }));
    expect(line(wide, 5)).toContain("worker DeepSeek");
    const narrow = renderHeader(input({ columns: 80, crew }));
    expect(line(narrow, 5)).toContain("Crew w DeepSeek V4.1 Flash · e Sonnet 5.5");
    expect(line(narrow, 5)).not.toContain("worker");
    for (const columns of [41, 54, 80, 100, 140]) {
      const frame = renderHeader(input({ columns, rows: 45, crew }));
      for (const row of frame.lead) expect(visibleWidth(row)).toBeLessThanOrEqual(columns - 1);
    }
    // Where the row is short the folder gives way first, then leaves the row to the crew.
    const cut = line(renderHeader(input({ columns: 80, crew })), 5);
    expect(cut).toContain("Folder ~/work/app");
    expect(cut).toContain("a Opus 5.5");
    const tight = line(renderHeader(input({ columns: 62, crew })), 5);
    expect(tight).not.toContain("Folder");
    expect(tight).toContain("Crew w DeepSeek V4.1 Flash · e Sonnet 5.5 · a Opus 5.5");
    expect(line(renderHeader(input({ columns: 41, crew })), 5)).toContain("Crew w DeepSeek");
  });

  it("writes a role no model can fill as a dash", () => {
    const frame = renderHeader(
      input({ columns: 140, crew: [{ role: "worker", model: null }, ...crew.slice(1)] }),
    );
    expect(line(frame, 5)).toContain("worker - · expert Sonnet 5.5");
  });

  it("is short on the one-line header and gives way to the thread's title first", () => {
    const frame = renderHeader(input({ columns: 120, rows: 24, crew, pet: null }));
    expect(frame.lead).toHaveLength(1);
    const row = line(frame, 0);
    expect(row).toContain("Crew w DeepSeek V4.1 Flash · e Sonnet 5.5 · a Opus 5.5");
    expect(row.indexOf("Crew")).toBeLessThan(row.indexOf("Fix the login bug"));
    const cut = line(renderHeader(input({ columns: 70, rows: 24, crew, pet: null })), 0);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(69);
    expect(cut).toContain("Crew w DeepSeek");
    expect(cut).not.toContain("Fix the login bug");
    expect(line(renderHeader(input({ columns: 120, rows: 24, pet: null })), 0)).not.toContain(
      "Crew",
    );
  });

  it("uses a plain bar between the facts in ASCII, and says 크루 in Korean", () => {
    const ascii = renderHeader(input({ columns: 140, crew, symbols: ASCII_SYMBOLS }));
    expect(line(ascii, 5)).toMatch(/^[\x20-\x7e]*$/u);
    expect(line(ascii, 5)).toContain("worker DeepSeek V4.1 Flash | expert Sonnet 5.5");
    setLanguage("ko");
    try {
      expect(line(renderHeader(input({ columns: 140, crew })), 5)).toContain(
        "크루 worker DeepSeek",
      );
    } finally {
      setLanguage("en");
    }
  });
});
