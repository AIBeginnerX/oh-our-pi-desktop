import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { renderBanner, type BannerInput } from "./banner.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const input = (extra: Partial<BannerInput> = {}): BannerInput => ({
  version: "0.1.0",
  server: "127.0.0.1:3773",
  cwd: "/home/me/work/app",
  home: "/home/me",
  columns: 100,
  theme: createTheme("oop", BUILTIN_THEMES.oop, 3),
  symbols: UNICODE_SYMBOLS,
  ...extra,
});

describe("renderBanner", () => {
  it("draws a wordmark of at most five rows with version, server and folder beside it", () => {
    const lines = renderBanner(input());
    const rows = lines.filter((line) => line !== "");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(5);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("v0.1.0");
    expect(text).toContain("127.0.0.1:3773");
    expect(text).toContain("~/work/app");
    expect(text).toMatch(/[█▄▀]/u);
    expect(lines.at(-1)).toBe("");
  });

  it("is one line below 80 columns", () => {
    const lines = renderBanner(input({ columns: 79 }));
    expect(lines.map(stripAnsi)).toEqual(["◆ OOP v0.1.0", ""]);
  });

  it("fits every line to the terminal at any width", () => {
    for (const columns of [20, 40, 79, 80, 81, 100, 160]) {
      for (const line of renderBanner(input({ columns }))) {
        expect(visibleWidth(line), `@ ${columns}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("uses no block characters in the ascii preset", () => {
    const text = renderBanner(input({ symbols: ASCII_SYMBOLS }))
      .map(stripAnsi)
      .join("\n");
    expect(text).not.toMatch(/[█▄▀◆]/u);
    expect(text).toContain("#");
    expect(renderBanner(input({ symbols: ASCII_SYMBOLS, columns: 60 })).map(stripAnsi)[0]).toBe(
      "* OOP v0.1.0",
    );
  });

  it("is plain text with no colour", () => {
    for (const line of renderBanner(input({ theme: createTheme("oop", BUILTIN_THEMES.oop, 0) }))) {
      expect(line).toBe(stripAnsi(line));
    }
  });

  it("leaves the server line out when there is none, and cleans control sequences", () => {
    const text = renderBanner(input({ server: null }))
      .map(stripAnsi)
      .join("\n");
    expect(text).not.toContain("서버");
    const dirty = renderBanner(input({ server: "h\u001b[2Jost", cwd: "/w\u001b]0;x\u0007" })).join(
      "\n",
    );
    expect(dirty).not.toContain("\u001b[2J");
    expect(dirty).not.toContain("\u001b]0;");
  });
});

describe("renderBanner compact", () => {
  it("is the one-line form at any width, with the version and no server or folder", () => {
    const lines = renderBanner(input({ compact: true, columns: 200 }));
    expect(lines.map(stripAnsi)).toEqual(["◆ OOP v0.1.0", ""]);
  });
});
