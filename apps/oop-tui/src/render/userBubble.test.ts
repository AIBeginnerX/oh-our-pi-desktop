import { describe, expect, it } from "vite-plus/test";

import { stringWidth, stripAnsi, visibleWidth } from "../text/width.ts";
import { userBubble } from "./userBubble.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const plain = { style: makeStyle(false), symbols: UNICODE_SYMBOLS };
const filled = {
  style: makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 3)),
  symbols: UNICODE_SYMBOLS,
};
const ascii = { style: makeStyle(false), symbols: ASCII_SYMBOLS };

describe("userBubble", () => {
  it("boxes a short message against the right edge, every row ending in the same column", () => {
    const rows = userBubble(plain, "안녕하세요\nhi", 40);
    // Top edge, two rows of text, bottom edge.
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(visibleWidth(row)).toBe(40);
    const text = rows.map(stripAnsi);
    // The box is the widest row (안녕하세요, ten cells) plus a border and a space on each side.
    const lead = " ".repeat(26);
    expect(text[0]).toBe(`${lead}╭${"─".repeat(12)}╮`);
    expect(text[3]).toBe(`${lead}╰${"─".repeat(12)}╯`);
    // The narrower row is padded inside the same sides, so every row ends in the same column.
    expect(text[1]).toBe(`${lead}│ 안녕하세요 │`);
    expect(text[2]).toBe(`${lead}│ hi         │`);
    expect(new Set(text.map((row) => visibleWidth(row)))).toEqual(new Set([40]));
  });

  it("measures wide characters as two columns, so a Korean line is not shifted or cut", () => {
    const text = "한글로 쓴 긴 문장입니다 ".repeat(8).trim();
    const rows = userBubble(plain, text, 50);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
    const inside = rows
      .map(stripAnsi)
      .slice(1, -1)
      .map((row) => row.slice(row.indexOf("│ ") + 2, row.lastIndexOf(" │")))
      .join("")
      .replace(/ +$/gu, "");
    expect(inside.replace(/ /gu, "")).toBe(text.replace(/ /gu, ""));
    expect(stringWidth("한")).toBe(2);
  });

  it("limits the box to four fifths of the width, wrapping a long message inside it", () => {
    const rows = userBubble(plain, "word ".repeat(60).trim(), 100);
    const body = rows.map((row) => stripAnsi(row).trimStart().length);
    expect(Math.max(...body)).toBeLessThanOrEqual(80 + 4);
    expect(rows.length).toBeGreaterThan(3);
  });

  it("keeps blank lines of the message", () => {
    // three rows of text plus the two edges
    expect(userBubble(plain, "위\n\n아래", 30)).toHaveLength(5);
  });

  it("keeps the box where no background can be drawn: rounded, or ASCII", () => {
    const rows = userBubble(plain, "hi", 30).map(stripAnsi);
    expect(rows[0]?.trim()).toBe("╭────╮");
    expect(rows[1]?.trim()).toBe("│ hi │");
    expect(rows[2]?.trim()).toBe("╰────╯");
    const bars = userBubble(ascii, "hi", 30).map(stripAnsi);
    expect(bars[0]?.trim()).toBe("+----+");
    expect(bars[1]?.trim()).toBe("| hi |");
    expect(bars[2]?.trim()).toBe("+----+");
    expect(stringWidth(bars[1] ?? "")).toBe(visibleWidth(bars[1] ?? ""));
    expect(Array.from(bars.join("")).every((char) => char.charCodeAt(0) < 128)).toBe(true);
  });

  it("fills behind the text with a background where the terminal can", () => {
    const rows = userBubble(filled, "hi", 30);
    const [row] = rows;
    expect(row).toContain("48;2;");
    expect(visibleWidth(row ?? "")).toBe(30);
    // The whole box is tinted, the edges included.
    for (const line of rows) expect(line).toContain("48;2;");
  });

  it("never exceeds a narrow room and survives a huge message", () => {
    // Below 5 columns one double-width glyph and the frame cannot fit; no real terminal is that narrow.
    for (const width of [6, 7, 10]) {
      for (const row of userBubble(plain, "가나다라마바사", width)) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
    expect(userBubble(plain, "x\n".repeat(200_000), 40)).toHaveLength(200_003);
  });

  describe("the colour of the text", () => {
    const at = (name: keyof typeof BUILTIN_THEMES, level: 0 | 1 | 2 | 3) => ({
      style: makeStyle(createTheme(name, BUILTIN_THEMES[name], level)),
      symbols: UNICODE_SYMBOLS,
    });
    const mark = (rail: ReturnType<typeof at>) => rail.style.theme.userFg("hi");

    it("is the theme's userFg at every depth where colour is on, with or without a fill", () => {
      for (const name of Object.keys(BUILTIN_THEMES) as Array<keyof typeof BUILTIN_THEMES>) {
        for (const level of [1, 2, 3] as const) {
          const rail = at(name, level);
          const row = userBubble(rail, "hi", 30)[1] ?? "";
          // The text sits inside userFg's own open and close, whatever wraps it.
          const open = mark(rail).slice(0, mark(rail).indexOf("hi"));
          expect(row, `${name} at ${level}`).toContain(`${open}│ hi │`);
        }
      }
    });

    it("is not the colour of an agent's text or of the brand, so the two sides read apart", () => {
      for (const level of [1, 2, 3] as const) {
        const rail = at("oop", level);
        const [row] = userBubble(rail, "hi", 30);
        const { theme } = rail.style;
        expect(row).not.toContain(theme.brand("hi").slice(0, theme.brand("hi").indexOf("hi")));
        expect(theme.userFg("hi")).not.toBe(theme.text("hi"));
      }
    });

    it("on 256 colours (macOS Terminal) is a palette colour, not the same grey as the text", () => {
      const rows = userBubble(at("oop", 2), "hi", 30);
      expect(rows[1]).toContain("38;5;221");
      expect(rows[1]).toContain("48;5;");
    });

    it("on 16 colours has no fill, so the colour and the box carry it", () => {
      const rows = userBubble(at("oop", 1), "hi", 30).map((row) => row);
      expect(rows[1]).toContain("\u001b[33m│ hi │");
      expect(rows[1]).not.toContain("48;");
      expect(stripAnsi(rows[1] ?? "").trim()).toBe("│ hi │");
    });

    it("in the ansi theme on 256 colours or more has no fill either, so it keeps the box", () => {
      for (const level of [2, 3] as const) {
        const rows = userBubble(at("ansi", level), "hi", 30);
        expect(rows[1]).toContain("\u001b[36m│ hi │");
        expect(stripAnsi(rows[1] ?? "").trim()).toBe("│ hi │");
        expect(visibleWidth(rows[1] ?? "")).toBe(30);
      }
    });

    it("with NO_COLOR is plain text inside a box of the message's own", () => {
      const rows = userBubble(at("oop", 0), "hi", 30);
      expect(rows[0]).toBe(`${" ".repeat(30 - 6)}╭────╮`);
      expect(rows[1]).toBe(`${" ".repeat(30 - 6)}│ hi │`);
      expect(rows[2]).toBe(`${" ".repeat(30 - 6)}╰────╯`);
    });
  });
});
