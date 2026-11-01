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

describe("userBubble", () => {
  it("puts a short message against the right edge, every row ending in the same column", () => {
    const rows = userBubble(plain, "안녕하세요\nhi", 40);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(visibleWidth(row)).toBe(40);
    expect(stripAnsi(rows[0] ?? "").startsWith(" ")).toBe(true);
  });

  it("measures wide characters as two columns, so a Korean line is not shifted or cut", () => {
    const text = "한글로 쓴 긴 문장입니다 ".repeat(8).trim();
    const rows = userBubble(plain, text, 50);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
    expect(rows.map((row) => stripAnsi(row).replace(/[ │]/gu, "")).join("")).toBe(
      text.replace(/ /gu, ""),
    );
    expect(stringWidth("한")).toBe(2);
  });

  it("limits the bubble to four fifths of the width, wrapping a long message inside it", () => {
    const rows = userBubble(plain, "word ".repeat(60).trim(), 100);
    const body = rows.map((row) => stripAnsi(row).trimStart().length);
    expect(Math.max(...body)).toBeLessThanOrEqual(80);
    expect(rows.length).toBeGreaterThan(1);
  });

  it("keeps blank lines of the message", () => {
    expect(userBubble(plain, "위\n\n아래", 30)).toHaveLength(3);
  });

  it("is told apart without colour: a bar closes each row where no background can be drawn", () => {
    const rows = userBubble(plain, "hi", 30);
    expect(stripAnsi(rows[0] ?? "").endsWith(UNICODE_SYMBOLS.rail.bar)).toBe(true);
    const ascii = userBubble({ style: makeStyle(false), symbols: ASCII_SYMBOLS }, "hi", 30);
    expect(stripAnsi(ascii[0] ?? "").endsWith(ASCII_SYMBOLS.rail.bar)).toBe(true);
    expect(stringWidth(stripAnsi(ascii[0] ?? ""))).toBe(visibleWidth(ascii[0] ?? ""));
    expect(Array.from(stripAnsi(ascii[0] ?? "")).every((char) => char.charCodeAt(0) < 128)).toBe(
      true,
    );
  });

  it("fills behind the text with a background where the terminal can", () => {
    const [row] = userBubble(filled, "hi", 30);
    expect(row).toContain("48;2;");
    expect(visibleWidth(row ?? "")).toBe(30);
  });

  it("never exceeds a narrow room and survives a huge message", () => {
    // Below 5 columns one double-width glyph and the frame cannot fit; no real terminal is that narrow.
    for (const width of [6, 7, 10]) {
      for (const row of userBubble(plain, "가나다라마바사", width)) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
    expect(userBubble(plain, "x\n".repeat(200_000), 40)).toHaveLength(200_001);
  });
});
