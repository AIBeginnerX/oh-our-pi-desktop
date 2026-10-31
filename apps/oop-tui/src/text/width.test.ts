import { describe, expect, it } from "vite-plus/test";

import { graphemesOf, sanitizeForTerminal, stringWidth, stripAnsi, visibleWidth } from "./width.ts";

describe("stringWidth", () => {
  it("counts a Hangul syllable as two columns and ASCII as one", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("한글")).toBe(4);
    expect(stringWidth("a한b")).toBe(4);
  });

  it("treats a conjoining jamo sequence as one two-column syllable", () => {
    const han = "한";
    expect(graphemesOf(han)).toEqual([han]);
    expect(stringWidth(han)).toBe(2);
  });

  it("counts emoji and CJK as wide, and combining marks as zero", () => {
    expect(stringWidth("😀")).toBe(2);
    expect(stringWidth("漢字")).toBe(4);
    expect(stringWidth("é")).toBe(1);
    expect(stringWidth("👍🏽")).toBe(2);
  });

  it("measures visible width without the ANSI styling around it", () => {
    expect(visibleWidth("\u001b[1m한글\u001b[0m")).toBe(4);
    expect(stripAnsi("\u001b[31mred\u001b[39m")).toBe("red");
  });
});

describe("sanitizeForTerminal", () => {
  it("removes escape sequences an agent could use to move the cursor or retitle the window", () => {
    expect(sanitizeForTerminal("a\u001b[2Jb")).toBe("ab");
    expect(sanitizeForTerminal("x\u001b]0;pwned\u0007y")).toBe("xy");
    expect(sanitizeForTerminal("\u009b31mred")).toBe("31mred");
  });

  it("keeps newlines, turns tabs into spaces, and drops bare carriage returns", () => {
    expect(sanitizeForTerminal("a\r\nb\rc\td")).toBe("a\nb\nc  d");
  });

  it("drops line separators and bidirectional overrides", () => {
    expect(sanitizeForTerminal("a b‮c⁦d")).toBe("abcd");
  });

  it("leaves Korean text untouched", () => {
    expect(sanitizeForTerminal("안녕하세요, 세계!")).toBe("안녕하세요, 세계!");
  });
});
