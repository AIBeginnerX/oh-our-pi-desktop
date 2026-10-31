import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { DiffStream } from "./diff.ts";
import { makeStyle } from "./style.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const themeAt = (level: 0 | 1 | 2 | 3) => createTheme("oop", BUILTIN_THEMES.oop, level);

const draw = (text: string, level: 0 | 1 | 2 | 3 = 0, width = 40, maxLines?: number) => {
  const stream = new DiffStream({
    width,
    style: makeStyle(themeAt(level)),
    ...(maxLines === undefined ? {} : { maxLines }),
  });
  const rows = text.split("\n").flatMap((line) => stream.push(line));
  return [...rows, ...stream.finish()];
};

const HUNK = ["@@ -8,3 +8,3 @@ 함수", " 앞", "-const a = 1;", "+const a = 2;", " 뒤"].join("\n");

describe("DiffStream length", () => {
  it("shows a few hundred lines by default, since the scrollback is the only record", () => {
    const body = Array.from({ length: 450 }, (_, index) => `+line ${index}`);
    const rows = draw(["@@ -0,0 +1,450 @@", ...body].join("\n")).map(stripAnsi);
    // The hunk header counts as a line.
    expect(rows).toHaveLength(400 + 1);
    expect(rows.at(-1)).toBe("... 51줄 더");
  });
});

describe("DiffStream without colour", () => {
  it("shows a plus or minus on every changed line, with line numbers from the hunk header", () => {
    expect(draw(HUNK)).toEqual([
      "@@ -8,3 +8,3 @@ 함수",
      " 8   앞",
      " 9 - const a = 1;",
      " 9 + const a = 2;",
      "10   뒤",
    ]);
  });

  it("draws a bare diff without numbers and keeps the file header", () => {
    expect(draw("--- a/x.ts\n+++ b/x.ts\n-old\n+new\n same")).toEqual([
      "--- a/x.ts",
      "+++ b/x.ts",
      "- old",
      "+ new",
      "  same",
    ]);
  });

  it("counts a removed line that looks like a file header as content inside a hunk", () => {
    const rows = draw("@@ -1,2 +1,1 @@\n--- 주석 줄\n 남김");
    expect(rows).toEqual(["@@ -1,2 +1,1 @@", "1 - -- 주석 줄", "1   남김"].map((row) => row));
  });

  it("drops the noisy index line and notes a missing final newline", () => {
    const rows = draw(
      "diff --git a/x b/x\nindex 83db48f..bf2a8e1 100644\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file",
    );
    expect(rows).toEqual([
      "diff --git a/x b/x",
      "@@ -1 +1 @@",
      "1 - a",
      "1 + b",
      "\\ No newline at end of file",
    ]);
  });

  it("stops after the limit and says how many lines it left out", () => {
    const body = Array.from({ length: 30 }, (_, n) => `+줄 ${n}`).join("\n");
    const rows = draw(body, 0, 40, 5);
    expect(rows).toHaveLength(6);
    expect(rows[5]).toBe("... 25줄 더");
  });

  it("strips terminal control sequences from the diff text", () => {
    const rows = draw("-\u001b[2Jold\u001b]0;t\u0007\n+new");
    expect(rows).toEqual(["- old", "+ new"]);
  });
});

describe("DiffStream with colour", () => {
  const theme = themeAt(3);

  it("fills added and removed lines with their backgrounds up to the width and no further", () => {
    for (const width of [40, 80, 120]) {
      const rows = draw(HUNK, 3, width);
      const removed = rows.find((row) => stripAnsi(row).includes("= 1"));
      const added = rows.find((row) => stripAnsi(row).includes("= 2"));
      expect(removed).toContain(";48;2;61;22;32m");
      expect(added).toContain(";48;2;18;51;31m");
      expect(visibleWidth(removed as string)).toBe(width);
      expect(visibleWidth(added as string)).toBe(width);
      // Context lines take no fill.
      expect(rows.filter((row) => visibleWidth(row) === width)).toHaveLength(2);
    }
  });

  it("marks only the changed words of a single removed and added pair", () => {
    const rows = draw("-const total = price * 2;\n+const total = price * 3;", 3, 60);
    const removed = rows[0] as string;
    const added = rows[1] as string;
    expect(removed).toContain(theme.bg("diffRemoveWord", "2"));
    expect(added).toContain(theme.bg("diffAddWord", "3"));
    expect(removed).not.toContain(theme.bg("diffRemoveWord", "total"));
    expect(added).not.toContain(theme.bg("diffAddWord", "const"));
    expect(stripAnsi(added)).toBe(`+ const total = price * 3;${" ".repeat(60 - 26)}`);
  });

  it("marks changed Hangul words by word", () => {
    const rows = draw("-값을 읽는다\n+값을 쓴다", 3, 40);
    expect(rows[0]).toContain(theme.bg("diffRemoveWord", "읽는다"));
    expect(rows[1]).toContain(theme.bg("diffAddWord", "쓴다"));
    expect(rows[0]).not.toContain(theme.bg("diffRemoveWord", "값을"));
  });

  it("colours whole lines only when a change is more than one pair or shares no word", () => {
    const many = draw("-a one\n-b two\n+c three", 3);
    expect(many.join("")).not.toContain("\u001b[48;2;138;44;63m");
    expect(many.join("")).not.toContain("\u001b[48;2;31;107;58m");
    const unrelated = draw("-abc\n+xyz", 3);
    expect(unrelated.join("")).not.toContain("\u001b[48;2;31;107;58m");
  });

  it("waits for the end of a change before drawing it, then draws removals before additions", () => {
    const stream = new DiffStream({ width: 40, style: makeStyle(themeAt(0)) });
    expect(stream.push("-a")).toEqual([]);
    expect(stream.push("+b")).toEqual([]);
    expect(stream.push(" 맥락")).toEqual(["- a", "+ b", "  맥락"]);
    expect(stream.push("-c")).toEqual([]);
    expect(stream.finish()).toEqual(["- c"]);
  });

  it("falls back to the text colours on a 256-colour terminal, never on 16-colour ones", () => {
    const sixteen = themeAt(1);
    const rows = draw("-old\n+new", 1);
    expect(rows).toEqual([sixteen.error("- old"), sixteen.success("+ new")]);
    // eslint-disable-next-line no-control-regex
    expect(rows.join("")).not.toMatch(/\u001b\[(?:4[0-9]|10[0-7])[;m]/u);
    const indexed = draw("-old\n+new", 2, 20);
    expect(indexed[0]).toContain(";48;5;");
    expect(visibleWidth(indexed[0] as string)).toBe(20);
  });

  it("cuts a long changed line into rows that each stay inside the width", () => {
    const rows = draw(`-${"가나다 ".repeat(20)}\n+${"라마바 ".repeat(20)}`, 3, 30);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  });

  it("stays quick on a very long line pair", () => {
    const started = performance.now();
    draw(`-${"word ".repeat(20_000)}\n+${"term ".repeat(20_000)}`, 3, 80);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
