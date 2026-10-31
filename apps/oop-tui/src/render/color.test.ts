import { describe, expect, it } from "vite-plus/test";

import { colorCodes, detectColorLevel, parseColor, type Color } from "./color.ts";

const level = (env: NodeJS.ProcessEnv, isTty = true) => detectColorLevel(env, isTty);

describe("detectColorLevel", () => {
  it("is 16 colours for a plain terminal and none for a stream that is not a terminal", () => {
    expect(level({ TERM: "xterm" })).toBe(1);
    expect(level({}, true)).toBe(1);
    expect(level({ TERM: "xterm-256color", COLORTERM: "truecolor" }, false)).toBe(0);
  });

  it("reads truecolor from COLORTERM or Windows Terminal, and 256 from TERM", () => {
    expect(level({ COLORTERM: "truecolor" })).toBe(3);
    expect(level({ COLORTERM: "24bit", TERM: "xterm" })).toBe(3);
    expect(level({ WT_SESSION: "abc", TERM: "xterm" })).toBe(3);
    expect(level({ TERM: "xterm-256color" })).toBe(2);
    expect(level({ TERM: "screen-256color" })).toBe(2);
    expect(level({ COLORTERM: "yes", TERM: "xterm" })).toBe(1);
  });

  it("follows the same rules inside tmux", () => {
    expect(level({ TERM: "tmux-256color" })).toBe(2);
    expect(level({ TERM: "tmux-256color", COLORTERM: "truecolor" })).toBe(3);
    expect(level({ TERM: "screen" })).toBe(1);
  });

  it("turns colour off for NO_COLOR and TERM=dumb, as it always did", () => {
    expect(level({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(0);
    expect(level({ TERM: "dumb", COLORTERM: "truecolor" })).toBe(0);
    expect(level({ NO_COLOR: "", COLORTERM: "truecolor" })).toBe(3);
  });

  it("lets FORCE_COLOR decide 0 to 3 before anything else, even without a terminal", () => {
    expect(level({ FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe(0);
    expect(level({ FORCE_COLOR: "1", COLORTERM: "truecolor" })).toBe(1);
    expect(level({ FORCE_COLOR: "2", NO_COLOR: "1" })).toBe(2);
    expect(level({ FORCE_COLOR: "3", TERM: "dumb" }, false)).toBe(3);
  });

  it("treats an empty or unknown FORCE_COLOR as not set", () => {
    expect(level({ FORCE_COLOR: "", TERM: "xterm-256color" })).toBe(2);
    expect(level({ FORCE_COLOR: "yes", TERM: "xterm-256color" })).toBe(2);
    expect(level({ FORCE_COLOR: "9", NO_COLOR: "1" })).toBe(0);
    expect(level({ FORCE_COLOR: "true" }, false)).toBe(0);
  });
});

describe("parseColor", () => {
  it("takes #rrggbb, 0-255, the 16 names, and default", () => {
    expect(parseColor("#A78bfa")).toEqual({ kind: "rgb", r: 167, g: 139, b: 250 });
    expect(parseColor(208)).toEqual({ kind: "indexed", index: 208 });
    expect(parseColor("brightRed")).toEqual({ kind: "ansi", index: 9 });
    expect(parseColor("default")).toEqual({ kind: "default" });
  });

  it("refuses everything else", () => {
    for (const value of [
      "#fff",
      "#12345g",
      "purple",
      "",
      256,
      -1,
      1.5,
      null,
      undefined,
      {},
      ["#fff"],
    ]) {
      expect(parseColor(value)).toBeNull();
    }
  });
});

describe("colorCodes", () => {
  const rgb: Color = { kind: "rgb", r: 167, g: 139, b: 250 };

  it("writes each level in its own form", () => {
    expect(colorCodes(rgb, 3)).toBe("38;2;167;139;250");
    expect(colorCodes(rgb, 2)).toBe("38;5;141");
    expect(colorCodes(rgb, 1)).toBe("94");
    expect(colorCodes(rgb, 0)).toBeNull();
  });

  it("paints backgrounds with the matching introducers", () => {
    expect(colorCodes(rgb, 3, true)).toBe("48;2;167;139;250");
    expect(colorCodes(rgb, 2, true)).toBe("48;5;141");
    expect(colorCodes({ kind: "ansi", index: 1 }, 1, true)).toBe("41");
    expect(colorCodes({ kind: "ansi", index: 9 }, 1, true)).toBe("101");
  });

  it("keeps 16-colour names at 16 colours at every level and writes nothing for default", () => {
    for (const lvl of [1, 2, 3] as const) {
      expect(colorCodes({ kind: "ansi", index: 2 }, lvl)).toBe("32");
      expect(colorCodes({ kind: "ansi", index: 12 }, lvl)).toBe("94");
      expect(colorCodes({ kind: "default" }, lvl)).toBeNull();
    }
  });

  it("lowers a palette index to the 16 colours when that is all there is", () => {
    expect(colorCodes({ kind: "indexed", index: 208 }, 3)).toBe("38;5;208");
    expect(colorCodes({ kind: "indexed", index: 9 }, 2)).toBe("91");
    expect(colorCodes({ kind: "indexed", index: 196 }, 1)).toBe("91");
  });

  it("lowers greys to the grey ramp and hues to the cube, the same way every time", () => {
    expect(colorCodes({ kind: "rgb", r: 128, g: 128, b: 128 }, 2)).toBe("38;5;244");
    expect(colorCodes({ kind: "rgb", r: 255, g: 0, b: 0 }, 2)).toBe("38;5;196");
    expect(colorCodes({ kind: "rgb", r: 255, g: 0, b: 0 }, 1)).toBe("91");
    expect(colorCodes({ kind: "rgb", r: 154, g: 163, b: 181 }, 1)).toBe("90");
    expect(colorCodes({ kind: "rgb", r: 0, g: 200, b: 0 }, 1)).toBe("32");
    expect(colorCodes({ kind: "rgb", r: 0, g: 0, b: 0 }, 1)).toBe("30");
  });

  it("keeps a soft hue on its own colour at 16 colours instead of a grey or a neighbour", () => {
    const at = (r: number, g: number, b: number) => colorCodes({ kind: "rgb", r, g, b }, 1);
    expect(at(248, 113, 113)).toBe("91");
    expect(at(239, 68, 68)).toBe("91");
    expect(at(74, 222, 128)).toBe("32");
    expect(at(251, 191, 36)).toBe("33");
    expect(at(96, 165, 250)).toBe("94");
    expect(at(192, 132, 252)).toBe("35");
    expect(at(251, 146, 60)).toBe("91");
    expect(at(30, 36, 51)).toBe("30");
    expect(at(107, 116, 137)).toBe("90");
    expect(at(255, 255, 255)).toBe("97");
  });
});
