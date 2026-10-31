import { describe, expect, it } from "vite-plus/test";

import { ASCII_SYMBOLS, resolveSymbols, UNICODE_SYMBOLS } from "./symbols.ts";
import { stringWidth } from "../text/width.ts";

describe("resolveSymbols", () => {
  it("obeys an explicit choice over the environment", () => {
    expect(resolveSymbols("ascii", { LANG: "ko_KR.UTF-8" }, "darwin")).toBe(ASCII_SYMBOLS);
    expect(resolveSymbols("unicode", { LANG: "C" }, "linux")).toBe(UNICODE_SYMBOLS);
  });

  it("picks by locale when left on auto: LC_ALL, then LC_CTYPE, then LANG", () => {
    expect(resolveSymbols("auto", { LANG: "ko_KR.UTF-8" }, "linux")).toBe(UNICODE_SYMBOLS);
    expect(resolveSymbols("auto", { LANG: "en_US.utf8" }, "darwin")).toBe(UNICODE_SYMBOLS);
    expect(resolveSymbols("auto", { LANG: "C" }, "linux")).toBe(ASCII_SYMBOLS);
    expect(resolveSymbols("auto", { LANG: "ko_KR.UTF-8", LC_ALL: "C" }, "linux")).toBe(
      ASCII_SYMBOLS,
    );
    expect(resolveSymbols("auto", { LC_CTYPE: "UTF-8", LANG: "C" }, "darwin")).toBe(
      UNICODE_SYMBOLS,
    );
    expect(resolveSymbols("auto", {}, "linux")).toBe(ASCII_SYMBOLS);
  });

  it("uses Unicode on Windows only under Windows Terminal", () => {
    expect(resolveSymbols("auto", { WT_SESSION: "x" }, "win32")).toBe(UNICODE_SYMBOLS);
    expect(resolveSymbols("auto", { LANG: "ko_KR.UTF-8" }, "win32")).toBe(ASCII_SYMBOLS);
  });
});

describe("the presets", () => {
  it("give ascii nothing outside printable ASCII, and every glyph one column", () => {
    const glyphs = JSON.stringify(ASCII_SYMBOLS);
    expect(glyphs).toMatch(/^[ -~]*$/u);
    expect(ASCII_SYMBOLS.spinner.map(stringWidth)).toEqual([1, 1, 1, 1]);
    expect(ASCII_SYMBOLS.prompt).toBe(">");
  });

  it("give a secret's characters one column each, and ascii a printable one", () => {
    expect(stringWidth(UNICODE_SYMBOLS.mask)).toBe(1);
    expect(stringWidth(ASCII_SYMBOLS.mask)).toBe(1);
    expect(ASCII_SYMBOLS.mask).toMatch(/^[ -~]$/u);
  });

  it("keep the unicode spinner and bars the design names", () => {
    expect(UNICODE_SYMBOLS.spinner).toEqual(["◒", "◐", "◓", "◑"]);
    expect(UNICODE_SYMBOLS.spinner.every((frame) => stringWidth(frame) === 1)).toBe(true);
    expect(UNICODE_SYMBOLS.brand).toBe("◆");
    expect(UNICODE_SYMBOLS.context.full + UNICODE_SYMBOLS.context.empty).toBe("▰▱");
  });

  it("draw the rail with glyphs one column wide, except the radio marks of the ascii preset", () => {
    const { radioOn, radioOff, ...joints } = UNICODE_SYMBOLS.rail;
    for (const glyph of [radioOn, radioOff, ...Object.values(joints)]) {
      expect(stringWidth(glyph), glyph).toBe(1);
    }
    expect(stringWidth(ASCII_SYMBOLS.rail.radioOn)).toBe(stringWidth(ASCII_SYMBOLS.rail.radioOff));
    // A step, a choice and a stop must be told apart without colour.
    for (const set of [ASCII_SYMBOLS, UNICODE_SYMBOLS]) {
      const { done, active, cancel, radioOn, radioOff } = set.rail;
      expect(new Set([done, active, cancel, radioOn, radioOff]).size).toBe(5);
    }
  });
});
