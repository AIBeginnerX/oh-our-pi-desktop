import { describe, expect, it } from "vite-plus/test";

import { makeStyle, shouldUseColor } from "./style.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

describe("makeStyle", () => {
  it("keeps the plain 16-colour escapes callers have always got", () => {
    const style = makeStyle(true);
    expect(style.enabled).toBe(true);
    expect(style.red("x")).toBe("\u001b[31mx\u001b[39m");
    expect(style.green("x")).toBe("\u001b[32mx\u001b[39m");
    expect(style.yellow("x")).toBe("\u001b[33mx\u001b[39m");
    expect(style.blue("x")).toBe("\u001b[34mx\u001b[39m");
    expect(style.magenta("x")).toBe("\u001b[35mx\u001b[39m");
    expect(style.cyan("x")).toBe("\u001b[36mx\u001b[39m");
    expect(style.bold("x")).toBe("\u001b[1mx\u001b[22m");
    expect(style.dim("x")).toBe("\u001b[2mx\u001b[22m");
    expect(style.inverse("x")).toBe("\u001b[7mx\u001b[27m");
  });

  it("is plain text when off", () => {
    const style = makeStyle(false);
    expect(style.enabled).toBe(false);
    for (const paint of [style.red, style.bold, style.dim, style.cyan, style.strike]) {
      expect(paint("x")).toBe("x");
    }
  });

  it("colours through the tokens of the theme it is given", () => {
    const style = makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 3));
    expect(style.red("x")).toBe("\u001b[38;2;248;113;113mx\u001b[39m");
    expect(style.theme.name).toBe("oop");
  });

  it("follows a theme change when given a function", () => {
    let theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
    const style = makeStyle(() => theme);
    const before = style.green("x");
    theme = createTheme("colorblind", BUILTIN_THEMES.colorblind, 3);
    expect(style.green("x")).not.toBe(before);
    expect(style.theme.name).toBe("colorblind");
    theme = createTheme("oop", BUILTIN_THEMES.oop, 0);
    expect(style.enabled).toBe(false);
    expect(style.bold("x")).toBe("x");
  });
});

describe("shouldUseColor", () => {
  it("keeps the NO_COLOR, dumb terminal, and not-a-terminal rules", () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldUseColor({ TERM: "dumb" }, true)).toBe(false);
  });
});
