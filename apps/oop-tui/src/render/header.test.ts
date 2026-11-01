import { describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  headerRows,
  headerTrack,
  HEADER_FULL_ROWS,
  renderHeader,
  travelOf,
  type HeaderInput,
} from "./header.ts";
import { INITIAL_POSE, PET_WIDTH, PET_MINI_WIDTH } from "./pet.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

setLanguage("en");

const input = (extra: Partial<HeaderInput> = {}): HeaderInput => ({
  columns: 76,
  rows: 45,
  theme: createTheme("oop", BUILTIN_THEMES.oop, 0),
  symbols: UNICODE_SYMBOLS,
  version: "0.0.133",
  server: "127.0.0.1:4011",
  cwd: "/home/me/work/app",
  home: "/home/me",
  status: { state: "working", model: "GPT-5.1", thread: "Fix the login bug" },
  pet: { state: "working", frame: 0, pose: INITIAL_POSE },
  ...extra,
});

const text = (rows: ReadonlyArray<string>) => rows.map(stripAnsi);

describe("renderHeader", () => {
  it("shows the logo with version, live state, model, thread, folder and server", () => {
    const frame = renderHeader(input());
    expect(frame.lead).toHaveLength(HEADER_FULL_ROWS);
    const lines = text(frame.lead).join("\n");
    expect(lines).toMatch(/[█▄▀]/u);
    expect(lines).toContain("v0.0.133");
    expect(lines).toContain("Working");
    expect(lines).toContain("GPT-5.1");
    expect(lines).toContain("Fix the login bug");
    expect(lines).toContain("~/work/app");
    expect(lines).toContain("127.0.0.1:4011");
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
        if (frame.trackWidth > 0) expect(frame.track).toHaveLength(Math.min(height, 4));
      }
    }
  });

  it("walks the pet inside its strip: it covers neither the status text nor the edge", () => {
    const track = headerTrack(76, 45, true);
    expect(track.full).toBe(true);
    const travel = travelOf(track.width, false);
    expect(travel).toBeGreaterThan(8);
    const seen = new Set<number>();
    for (let x = 0; x <= travel; x += 1) {
      const frame = renderHeader(
        input({ pet: { state: "working", frame: 0, pose: { x, dir: 1, step: 0 } } }),
      );
      const faces = text(frame.track)[1] as string;
      expect(text(frame.lead)[5]).toContain("127.0.0.1:4011");
      seen.add(faces.indexOf("██"));
      expect(visibleWidth(faces)).toBe(frame.trackWidth);
      // the last column of the strip stays free next to the divider
      expect(faces.endsWith(" ")).toBe(true);
    }
    expect(seen.size).toBe(travel + 1);
  });

  it("folds to one line on a short terminal and keeps the state, with a one-line pet", () => {
    const frame = renderHeader(input({ columns: 54, rows: 24 }));
    expect(frame.lead).toHaveLength(1);
    expect(text(frame.lead)[0]).toContain("OOP v0.0.133");
    expect(text(frame.lead)[0]).toContain("Working");
    expect(frame.trackWidth).toBeGreaterThanOrEqual(PET_MINI_WIDTH + 2);
    expect(text(frame.track)[0]).toMatch(/\(.{3}\)/u);
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
