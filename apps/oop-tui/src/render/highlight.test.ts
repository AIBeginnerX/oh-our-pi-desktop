import { describe, expect, it } from "vite-plus/test";

import { makeHighlighter, type Segment, wrapPieces } from "./highlight.ts";
import { visibleWidth } from "../text/width.ts";

const tokens = (lang: string, ...lines: string[]): Array<Array<[string, string]>> => {
  const highlight = makeHighlighter(lang);
  if (highlight === null) throw new Error(`no highlighter for ${lang}`);
  return lines.map((line) =>
    highlight(line)
      .filter((segment): segment is Segment & { kind: string } => segment.kind !== undefined)
      .map((segment): [string, string] => [segment.kind, segment.text]),
  );
};

describe("makeHighlighter", () => {
  it("marks keywords, strings, comments and numbers in TypeScript and JavaScript", () => {
    expect(tokens("ts", 'const name = "안녕"; // 인사')).toEqual([
      [
        ["keyword", "const"],
        ["string", '"안녕"'],
        ["comment", "// 인사"],
      ],
    ]);
    expect(tokens("javascript", "return x + 0x1F * 2.5e3")).toEqual([
      [
        ["keyword", "return"],
        ["number", "0x1F"],
        ["number", "2.5e3"],
      ],
    ]);
    // A digit inside a name is part of the name, not a number.
    expect(tokens("ts", "let a1 = b2")[0]).toEqual([["keyword", "let"]]);
  });

  it("keeps a block comment and a template string open across lines", () => {
    expect(tokens("ts", "/* 열림", "여전히 */ let x", "const t = `a", "b ${c}`;")).toEqual([
      [["comment", "/* 열림"]],
      [
        ["comment", "여전히 */"],
        ["keyword", "let"],
      ],
      [
        ["keyword", "const"],
        ["string", "`a"],
      ],
      [["string", "b ${c}`"]],
    ]);
  });

  it("reads Python comments and triple-quoted strings", () => {
    expect(tokens("py", 'def f(x): return "a#b"  # 끝', 'doc = """첫', '둘""" + 1')).toEqual([
      [
        ["keyword", "def"],
        ["keyword", "return"],
        ["string", '"a#b"'],
        ["comment", "# 끝"],
      ],
      [["string", '"""첫']],
      [
        ["string", '둘"""'],
        ["number", "1"],
      ],
    ]);
  });

  it("treats a shell # as a comment only at a word boundary", () => {
    expect(tokens("bash", "echo ${#arr[@]} # 개수")).toEqual([[["comment", "# 개수"]]]);
    expect(tokens("sh", 'if [ -n "$x" ]; then')).toEqual([
      [
        ["keyword", "if"],
        ["string", '"$x"'],
        ["keyword", "then"],
      ],
    ]);
  });

  it("tells a JSON key from a string value", () => {
    expect(tokens("json", '{ "a": "b", "n": [1, true, null] }')).toEqual([
      [
        ["keyword", '"a"'],
        ["string", '"b"'],
        ["keyword", '"n"'],
        ["number", "1"],
        ["keyword", "true"],
        ["keyword", "null"],
      ],
    ]);
  });

  it("reads Go raw strings and Rust lifetimes", () => {
    expect(tokens("go", "func main() { s := `a`; return }")[0]).toEqual([
      ["keyword", "func"],
      ["string", "`a`"],
      ["keyword", "return"],
    ]);
    expect(tokens("rust", "fn f<'a>(c: &'a str) { let d = 'x'; }")[0]).toEqual([
      ["keyword", "fn"],
      ["keyword", "let"],
      ["string", "'x'"],
    ]);
  });

  it("ends a string that is still open at the end of the line, so a streamed line cannot leak it", () => {
    expect(tokens("ts", 'say("안녕', "let y")).toEqual([
      [["string", '"안녕']],
      [["keyword", "let"]],
    ]);
  });

  it("knows no highlighter for an unknown language and leaves a very long line plain", () => {
    expect(makeHighlighter("cobol")).toBeNull();
    expect(makeHighlighter("")).toBeNull();
    const long = `const a = "${"x".repeat(2000)}"`;
    expect(makeHighlighter("ts")?.(long)).toEqual([{ text: long }]);
  });
});

describe("wrapPieces", () => {
  it("cuts at the width by display columns and keeps each half's tag", () => {
    const rows = wrapPieces([{ text: "가나다라마", kind: "string" }, { text: "ab" }], 6);
    expect(rows.map((row) => row.pieces.map((piece) => piece.text).join("|"))).toEqual([
      "가나다",
      "라마|ab",
    ]);
    expect(rows.map((row) => row.width)).toEqual([6, 6]);
    expect(rows[1]?.pieces[0]).toEqual({ text: "라마", kind: "string" });
    for (const row of rows) {
      expect(visibleWidth(row.pieces.map((piece) => piece.text).join(""))).toBe(row.width);
    }
  });

  it("returns one empty row for an empty line", () => {
    expect(wrapPieces([], 10)).toEqual([{ pieces: [], width: 0 }]);
  });
});
