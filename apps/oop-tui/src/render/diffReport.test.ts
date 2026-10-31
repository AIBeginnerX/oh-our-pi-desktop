import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { diffReportRows, diffTotals, matchFiles, OVERVIEW_LINES } from "./diffReport.ts";
import type { Rail } from "./rail.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const rail: Rail = {
  style: makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 0)),
  symbols: ASCII_SYMBOLS,
};

const file = (path: string, additions: number, deletions = 0) => ({
  path,
  kind: "modified",
  additions,
  deletions,
});

const section = (path: string, added: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${added} @@`,
    ...Array.from({ length: added }, (_, index) => `+${path} line ${index}`),
  ].join("\n");

const show = (rows: ReadonlyArray<string>) => rows.map(stripAnsi);

describe("diffTotals and matchFiles", () => {
  it("adds up the counts of every file", () => {
    expect(diffTotals([file("a", 2, 1), file("b", 5)])).toEqual({
      count: 2,
      additions: 7,
      deletions: 1,
    });
  });

  it("matches a path exactly first, then by its tail", () => {
    const files = [file("src/a.ts", 1), file("lib/a.ts", 1), file("a.ts", 1)];
    expect(matchFiles(files, "a.ts").map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(matchFiles(files, "./src/a.ts").map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(matchFiles([file("src/a.ts", 1), file("lib/a.ts", 1)], "a.ts")).toHaveLength(2);
    expect(matchFiles(files, "zzz")).toEqual([]);
  });

  it("finds a Korean name however its letters are composed, in the typed name or in the file's path", () => {
    const decomposed = [file("문서/한글.md".normalize("NFD"), 1)];
    const composed = [file("문서/한글.md".normalize("NFC"), 1)];
    expect(matchFiles(decomposed, "한글.md".normalize("NFC"))).toHaveLength(1);
    expect(matchFiles(composed, "한글.md".normalize("NFD"))).toHaveLength(1);
    expect(matchFiles(decomposed, "문서/한글.md".normalize("NFC"))).toHaveLength(1);
  });
});

describe("diffReportRows", () => {
  it("heads the diff with the turn, the file count and the totals, then lists the files", () => {
    const rows = show(
      diffReportRows({
        rail,
        width: 80,
        turn: 2,
        files: [file("src/a.ts", 3, 1), file("src/b.ts", 4)],
        diff: `${section("src/a.ts", 2)}\n${section("src/b.ts", 1)}\n`,
      }),
    ).join("\n");
    expect(rows).toContain("턴 2 변경 · 파일 2개  +7 -1");
    expect(rows).toContain("src/a.ts");
    expect(rows).toContain("+3 -1");
    expect(rows).toContain("src/a.ts line 0");
    expect(rows).toContain("src/b.ts line 0");
    expect(rows).not.toContain("생략");
  });

  it("stops a big turn after a few hundred lines and says how to see one file whole", () => {
    const rows = show(
      diffReportRows({
        rail,
        width: 80,
        turn: 5,
        files: [file("big.ts", 900), file("small.ts", 1)],
        diff: `${section("big.ts", 900)}\n${section("small.ts", 1)}\n`,
      }),
    );
    const text = rows.join("\n");
    expect(text).toContain("생략했습니다. 한 파일 전체: /diff 5 <파일>");
    expect(text).not.toContain("big.ts line 899");
    expect(text).not.toContain("small.ts line 0");
    // The report is bounded: the cap plus the stream's own "more" line and the headings.
    expect(rows.length).toBeLessThan(OVERVIEW_LINES * 2 + 40);
  });

  it("shows one file in full length, and nothing of the others", () => {
    const rows = show(
      diffReportRows({
        rail,
        width: 80,
        turn: 5,
        files: [file("src/big.ts", 900), file("small.ts", 1)],
        diff: `${section("src/big.ts", 900)}\n${section("small.ts", 1)}\n`,
        file: "big.ts",
      }),
    ).join("\n");
    expect(rows).toContain("턴 5 · src/big.ts");
    expect(rows).toContain("src/big.ts line 899");
    expect(rows).not.toContain("small.ts line");
    expect(rows).not.toContain("생략");
  });

  it("finds a file whose name git writes quoted in the patch, as it does for any non-ASCII name", () => {
    // The file list holds the name as it is; the patch header holds it as octal bytes in quotes.
    const quoted = (name: string) =>
      `"${[...Buffer.from(name)].map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8)}`)).join("")}"`;
    const name = "src/한글 파일.ts";
    const patch = [
      `diff --git ${quoted(`a/${name}`)} ${quoted(`b/${name}`)}`,
      `--- ${quoted(`a/${name}`)}`,
      `+++ ${quoted(`b/${name}`)}`,
      "@@ -0,0 +1,1 @@",
      "+한글 내용",
      section("other.ts", 1),
      "",
    ].join("\n");
    const base = {
      rail,
      width: 80,
      turn: 3,
      files: [file(name, 1), file("other.ts", 1)],
      diff: patch,
    };
    const picked = show(diffReportRows({ ...base, file: "한글 파일.ts" })).join("\n");
    expect(picked).toContain("턴 3 · src/한글 파일.ts");
    expect(picked).toContain("한글 내용");
    expect(picked).not.toContain("other.ts line");
    expect(picked).not.toContain("찾지 못했습니다");
    // A rename keeps the old name plain and quotes the new one.
    const renamed = diffReportRows({
      ...base,
      diff: `diff --git a/plain.ts ${quoted(`b/${name}`)}\n@@ -0,0 +1,1 @@\n+이름 바뀜\n`,
      file: "한글 파일.ts",
    });
    expect(show(renamed).join("\n")).toContain("이름 바뀜");
  });

  it("says so when the server's diff has no section for the file, or no diff at all", () => {
    const missing = show(
      diffReportRows({
        rail,
        width: 80,
        turn: 1,
        files: [file("a.ts", 1)],
        diff: "",
        file: "a.ts",
      }),
    ).join("\n");
    expect(missing).toContain("diff 에서 이 파일을 찾지 못했습니다");
    const empty = show(
      diffReportRows({ rail, width: 80, turn: 1, files: [file("a.ts", 1)], diff: "" }),
    ).join("\n");
    expect(empty).toContain("표시할 diff 가 없습니다");
    const none = show(diffReportRows({ rail, width: 80, turn: 1, files: [], diff: "" })).join("\n");
    expect(none).toContain("이 턴에서 바뀐 파일이 없습니다.");
  });

  it("names twenty files and counts the rest", () => {
    const files = Array.from({ length: 23 }, (_, index) => file(`f${index}.ts`, 1));
    const text = show(diffReportRows({ rail, width: 80, turn: 1, files, diff: "" })).join("\n");
    expect(text).toContain("f19.ts");
    expect(text).not.toContain("f20.ts");
    expect(text).toContain("… 외 파일 3개");
  });

  it("cuts a very long line and keeps every row inside the width", () => {
    const rows = diffReportRows({
      rail,
      width: 40,
      turn: 1,
      files: [file("min.js", 1)],
      diff: `${section("min.js", 0)}\n+${"x".repeat(5000)}\n`,
    });
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    expect(rows.length).toBeLessThan(60);
  });
});
