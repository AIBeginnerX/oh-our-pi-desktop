import { describe, expect, it } from "vite-plus/test";

import { type Color } from "./color.ts";
import { gradientText } from "./gradient.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";

const rgb = (r: number, g: number, b: number): Color => ({ kind: "rgb", r, g, b });
const stops = [rgb(0, 0, 0), rgb(200, 100, 50)];

describe("gradientText", () => {
  it("blends from the first stop to the last on a truecolor terminal", () => {
    const out = gradientText("abc", stops, 3);
    expect(out).toBe(
      "\u001b[38;2;0;0;0ma\u001b[38;2;100;50;25mb\u001b[38;2;200;100;50mc\u001b[39m",
    );
    expect(stripAnsi(out)).toBe("abc");
  });

  it("lowers each step to the 256 palette", () => {
    const out = gradientText("abc", stops, 2);
    expect(out.startsWith("\u001b[38;5;")).toBe(true);
    expect(out).not.toContain("38;2;");
    expect(stripAnsi(out)).toBe("abc");
  });

  it("is one flat colour on 16 colours, and the text itself with no colour", () => {
    expect(gradientText("abc", [rgb(255, 0, 0), rgb(0, 0, 255)], 1)).toBe(
      "\u001b[91mabc\u001b[39m",
    );
    expect(gradientText("abc", stops, 0)).toBe("abc");
    expect(gradientText("", stops, 3)).toBe("");
  });

  it("steps through 16-colour names rather than blending them", () => {
    const ansi: Color[] = [
      { kind: "ansi", index: 5 },
      { kind: "ansi", index: 6 },
    ];
    const out = gradientText("abcd", ansi, 3);
    expect(out).not.toContain("38;");
    expect(out).toContain("\u001b[35m");
    expect(out).toContain("\u001b[36m");
  });

  it("leaves spaces uncoloured and counts Korean by column", () => {
    const out = gradientText("한글 OOP", stops, 3);
    expect(stripAnsi(out)).toBe("한글 OOP");
    expect(visibleWidth(out)).toBe(visibleWidth("한글 OOP"));
    expect(out).not.toContain("m \u001b[");
  });

  it("slides with phase, and phase 0 is the plain blend", () => {
    expect(gradientText("abc", stops, 3, 0)).toBe(gradientText("abc", stops, 3));
    expect(gradientText("abc", stops, 3, 0.5)).not.toBe(gradientText("abc", stops, 3));
    // A full there-and-back (phase 2) lands where it started.
    expect(gradientText("abc", stops, 3, 2)).toBe(gradientText("abc", stops, 3));
  });

  it("colours a single character from the phase alone", () => {
    expect(gradientText("⠋", stops, 3, 0)).toBe("\u001b[38;2;0;0;0m⠋\u001b[39m");
    expect(gradientText("⠋", stops, 3, 1)).toBe("\u001b[38;2;200;100;50m⠋\u001b[39m");
  });
});
