import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { formatElapsed, renderWorkRow, type WorkRowInput } from "./spinner.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const base = (extra: Partial<WorkRowInput> = {}): WorkRowInput => ({
  theme: createTheme("oop", BUILTIN_THEMES.oop, 3),
  symbols: UNICODE_SYMBOLS,
  tick: 2,
  animations: true,
  tool: null,
  detail: null,
  elapsedMs: 12_000,
  silentMs: 0,
  interruptible: true,
  ...extra,
});

describe("formatElapsed", () => {
  it("counts seconds, then minutes, then hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });

  it("never goes negative", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("renderWorkRow", () => {
  it("names the tool, what it was given and the time", () => {
    const text = stripAnsi(renderWorkRow(base({ tool: "Bash", detail: "pnpm test" }), 80));
    expect(text).toBe("◓  Bash · pnpm test  12s • Esc 중단");
  });

  it("says the agent is writing when no tool runs", () => {
    expect(stripAnsi(renderWorkRow(base(), 80))).toBe("◓  응답 생성 중  12s • Esc 중단");
  });

  it("leaves out the stop hint when Esc cannot stop the turn", () => {
    expect(stripAnsi(renderWorkRow(base({ interruptible: false }), 80))).toBe(
      "◓  응답 생성 중  12s",
    );
  });

  it("warns after a minute of silence, and not before", () => {
    const quiet = renderWorkRow(base({ elapsedMs: 80_000, silentMs: 75_000 }), 80);
    expect(stripAnsi(quiet)).toContain("응답 없음 1m 15s");
    const warningOpen = createTheme("oop", BUILTIN_THEMES.oop, 3).warning("응답 없음 1m 15s");
    expect(quiet).toContain(warningOpen);
    expect(stripAnsi(renderWorkRow(base({ silentMs: 59_999 }), 80))).not.toContain("응답 없음");
  });

  it("moves the glyph and its colour with the tick, and holds still without animations", () => {
    const first = renderWorkRow(base({ tick: 0 }), 80);
    const second = renderWorkRow(base({ tick: 1 }), 80);
    expect(first).not.toBe(second);
    const still = [0, 1, 7].map((tick) => renderWorkRow(base({ tick, animations: false }), 80));
    expect(new Set(still).size).toBe(1);
    expect(stripAnsi(still[0] as string).startsWith("◒  ")).toBe(true);
  });

  it("cycles through the spinner frames of the preset", () => {
    const frames = [0, 1, 2, 3].map((tick) =>
      stripAnsi(renderWorkRow(base({ tick, symbols: ASCII_SYMBOLS }), 80)).charAt(0),
    );
    expect(frames).toEqual(["|", "/", "-", "\\"]);
  });

  it("keeps the time and shortens the label when the line is narrow", () => {
    const text = stripAnsi(
      renderWorkRow(
        base({ tool: "Bash", detail: "a-very-long-command --with --many --flags" }),
        40,
      ),
    );
    expect(visibleWidth(text)).toBeLessThanOrEqual(40);
    expect(text).toContain("12s • Esc 중단");
    expect(text).toContain("Bash");
  });

  it("fits Korean details to the screen width", () => {
    for (let width = 20; width <= 60; width += 4) {
      const line = renderWorkRow(
        base({ tool: "읽기", detail: "한국어로 된 아주 긴 파일 경로 설명" }),
        width,
      );
      expect(visibleWidth(line), `@ ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("is plain text with no colour and drops control sequences from tool text", () => {
    const plain = renderWorkRow(
      base({
        theme: createTheme("oop", BUILTIN_THEMES.oop, 0),
        tool: "Ba\u001b[2Jsh",
        detail: "x\u0007y",
      }),
      80,
    );
    expect(plain).not.toContain("\u001b");
    expect(plain).not.toContain("\u0007");
  });
});
