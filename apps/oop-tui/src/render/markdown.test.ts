import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { MarkdownStream, renderInline, renderMarkdown } from "./markdown.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const plain = makeStyle(false);
const color = makeStyle(true);
const render = (text: string, width = 40) => renderMarkdown(text, { width, style: plain });

describe("renderMarkdown", () => {
  it("keeps headings, rules, and paragraphs within the width", () => {
    const rows = render("# 제목\n\n안녕하세요 반갑습니다 오늘도 좋은 하루 되세요", 16);
    expect(rows[0]).toBe("제목");
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(16);
  });

  it("indents wrapped list items under their text and keeps ordered numbers", () => {
    expect(render("- 가나다라마바", 8)).toEqual(["- 가나다", "  라마바"]);
    expect(render("1. 하나\n2) 둘")).toEqual(["1. 하나", "2) 둘"]);
  });

  it("draws code under a dim language line with a gutter, and does not reflow it", () => {
    expect(render("```ts\nconst a = 1;\n```")).toEqual(["ts", "│ const a = 1;"]);
    expect(render("```\nx\n```")[0]).toBe("code");
  });

  it("replaces chart and mermaid blocks with a Korean marker and never prints their source", () => {
    const rows = render("```mermaid\ngraph TD\n  A-->B\n```");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("mermaid 다이어그램 2줄");
    expect(rows[0]).toContain("데스크톱 앱");
    expect(rows.join("\n")).not.toContain("A-->B");
  });

  it("aligns table columns by display width, so Hangul cells line up", () => {
    const rows = render("| 이름 | 값 |\n|---|---|\n| 가나 | 1 |");
    expect(rows).toEqual(["이름 | 값", "-----+---", "가나 | 1 "]);
  });

  it("falls back to one row per line when a table is too wide to align", () => {
    const rows = render(
      "| 아주 긴 첫째 칸 내용입니다 | 아주 긴 둘째 칸 내용입니다 |\n|---|---|\n| a | b |",
      20,
    );
    expect(rows.join("\n")).toContain("a | b");
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
  });

  it("closes an unterminated fence when the message ends instead of swallowing the rest", () => {
    const stream = new MarkdownStream({ width: 40, style: plain });
    expect(stream.pushLine("```")).toEqual(["code"]);
    expect(stream.pushLine("x")).toEqual(["│ x"]);
    expect(stream.pushLine("나머지 문단")).toEqual(["│ 나머지 문단"]);
    expect(stream.finish()).toEqual([]);
    expect(stream.pushLine("끝난 뒤 문단")).toEqual(["끝난 뒤 문단"]);
  });

  it("strips terminal control sequences that arrive in agent text", () => {
    expect(render("\u001b[2J\u001b]0;title\u0007안녕")).toEqual(["안녕"]);
  });

  it("flushes a pending table before the next block", () => {
    const stream = new MarkdownStream({ width: 40, style: plain });
    expect(stream.pushLine("| a | b |")).toEqual([]);
    expect(stream.pushLine("그다음 문단")).toEqual(["a | b", "그다음 문단"]);
  });
});

describe("renderInline", () => {
  it("styles bold, code, and links, and shows the target of a link", () => {
    expect(renderInline("**굵게**", color)).toBe("\u001b[1m굵게\u001b[22m");
    expect(renderInline("`코드`", color)).toBe("\u001b[36m코드\u001b[39m");
    expect(stripAnsi(renderInline("[문서](https://example.com)", color))).toBe(
      "문서 (https://example.com)",
    );
  });

  it("leaves snake_case identifiers alone", () => {
    expect(renderInline("use some_var_name here", plain)).toBe("use some_var_name here");
  });

  it("returns plain text unchanged when colour is off", () => {
    expect(renderInline("**굵게** 와 `코드`", plain)).toBe("굵게 와 코드");
  });
});

describe("hostile input", () => {
  const timed = (text: string) => {
    const started = performance.now();
    const rows = render(text, 60);
    return { rows, ms: performance.now() - started };
  };

  it("renders a run of unfinished image markers in bounded time", () => {
    const { rows, ms } = timed("![a](".repeat(800));
    expect(rows.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
  });

  it("stays fast on other unmatched markers too", () => {
    for (const unit of ["`a ", "[a](", "**a ", "~~a ", "*a ", "[a "]) {
      const { ms } = timed(unit.repeat(5000));
      expect(ms).toBeLessThan(500);
    }
  });

  it("still renders formatting inside a very long line", () => {
    const rows = render(`${"가나다 ".repeat(1500)}**굵게** 끝`, 60);
    expect(rows.join("\n")).toContain("굵게 끝");
    expect(rows.join("\n")).not.toContain("**");
  });

  it("never lets a carriage return become a line break inside a row", () => {
    const rows = render("앞\r뒤\r\n다음");
    expect(rows).toEqual(["앞", "뒤", "다음"]);
    for (const row of new MarkdownStream({ width: 40, style: plain }).pushLine("a\rb")) {
      expect(row).not.toContain("\n");
    }
  });

  it("keeps a carriage return from a fenced block out of its gutter rows", () => {
    const rows = render("```\nx\ry\n```");
    for (const row of rows) expect(row).not.toContain("\n");
  });
});

describe("input that used to make rendering explode", () => {
  /** Runs `work` and returns how long it took, in milliseconds. */
  const timed = (work: () => void) => {
    const started = performance.now();
    work();
    return performance.now() - started;
  };
  // Generous: the broken versions take many seconds or never finish at these sizes.
  const BUDGET_MS = 1500;

  it("renders a very long run of backticks after a letter in bounded time", () => {
    const text = `x${"`".repeat(50_000)}`;
    expect(timed(() => render(text, 80))).toBeLessThan(BUDGET_MS);
  });

  it("renders a very long line of # after a heading marker in bounded time", () => {
    const text = `# ${"#".repeat(64_000)}x`;
    expect(timed(() => render(text, 80))).toBeLessThan(BUDGET_MS);
  });

  it("renders a table separator padded with spaces in bounded time", () => {
    const text = `|---${" ".repeat(200_000)}x |`;
    expect(timed(() => render(text, 80))).toBeLessThan(BUDGET_MS);
  });

  it("renders a long run of blanks before a separator in bounded time", () => {
    const text = `|a|\n${" ".repeat(200_000)}x`;
    expect(timed(() => render(text, 80))).toBeLessThan(BUDGET_MS);
  });

  it("renders a table of 200000 rows without crashing", () => {
    const rows = ["| a | b |", "|---|---|", ...Array.from({ length: 200_000 }, () => "| 1 | 2 |")];
    let rendered: string[] = [];
    expect(timed(() => (rendered = render(rows.join("\n"), 80)))).toBeLessThan(BUDGET_MS * 4);
    expect(rendered.length).toBe(200_002);
  });

  it("still styles ordinary code spans and headings", () => {
    expect(render("# 제목 ##")[0]).toBe("제목");
    expect(renderInline("`a` 그리고 ``b`c``", plain)).toBe("a 그리고 b`c");
  });
});

describe("themed Markdown", () => {
  const themeOf = (level: 0 | 1 | 2 | 3) => createTheme("oop", BUILTIN_THEMES.oop, level);
  const styled = (level: 0 | 1 | 2 | 3) => makeStyle(themeOf(level));
  const renderAt = (level: 0 | 1 | 2 | 3, text: string, width = 40) =>
    renderMarkdown(text, { width, style: styled(level) });

  it("paints headings in the brand colour and inline code in the accent colour", () => {
    const theme = themeOf(3);
    expect(renderAt(3, "# 제목")).toEqual([theme.brand.bold("제목")]);
    expect(renderAt(3, "쓰기 `code` 끝")).toEqual([`쓰기 ${theme.accent("code")} 끝`]);
    // A code span inside a heading does not end the heading colour for the words after it.
    expect(renderAt(3, "# 앞 `c` 뒤")).toEqual([
      `${theme.brand.bold("앞 ")}${theme.accent("c")}${theme.brand.bold(" 뒤")}`,
    ]);
  });

  it("draws a quote with a muted bar and a link in the info colour", () => {
    const theme = themeOf(3);
    expect(renderAt(3, "> 인용")).toEqual([`${theme.muted("│")} ${theme.muted("인용")}`]);
    const link = renderAt(3, "[문서](https://a.b)")[0] as string;
    expect(link).toContain(theme.info.underline("문서"));
    expect(stripAnsi(link)).toBe("문서 (https://a.b)");
  });

  it("marks list items with an accent bullet and keeps wrapped text aligned", () => {
    const theme = themeOf(3);
    const rows = renderAt(3, "- 가나다라마바", 8);
    expect(rows[0]).toBe(`${theme.accent("-")} 가나다`);
    expect(rows[1]).toBe("  라마바");
  });

  it("uses ASCII bars and rules with the ASCII symbols", () => {
    const rows = renderMarkdown("> 인용\n\n---\n\n```ts\nlet a = 1;\n```", {
      width: 40,
      style: makeStyle(false),
      symbols: ASCII_SYMBOLS,
    });
    expect(rows).toEqual(["| 인용", "", "-".repeat(40), "", "ts", "| let a = 1;"]);
  });

  it("highlights code tokens on a 16-colour terminal without any background", () => {
    const theme = themeOf(1);
    const rows = renderAt(1, "```ts\nconst n = 42; // 끝\n```");
    expect(rows[1]).toBe(
      `${theme.dim("│")} ${theme.keyword("const")} n = ${theme.number("42")}; ${theme.comment("// 끝")}`,
    );
    // eslint-disable-next-line no-control-regex
    expect(rows.join("")).not.toMatch(/\u001b\[4[0-9;]*m/u);
  });

  it("fills a code block with the code background, to the block width and no further", () => {
    const rows = renderAt(3, "```py\nprint('안녕')\n```", 30);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(visibleWidth(row)).toBe(30);
      expect(row).toContain(";48;2;26;31;44m");
    }
    expect(stripAnsi(rows[1] as string).trim()).toBe("print('안녕')");
  });

  it("cuts a long or Hangul code line at the block width without breaking a token's colour", () => {
    const theme = themeOf(3);
    const rows = renderAt(3, `\`\`\`ts\nconst s = "${"가".repeat(30)}";\n\`\`\``, 30);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
    // Every row of the cut string opens with the string colour again.
    const stringOpen = theme.string("x").split("x")[0] as string;
    for (const row of rows.slice(1)) expect(row).toContain(stringOpen);
  });

  it("highlights a streamed code block line by line and survives one left open", () => {
    const theme = themeOf(1);
    const stream = new MarkdownStream({ width: 40, style: styled(1) });
    stream.pushLine("```ts");
    expect(stream.pushLine("/* 시작")).toEqual([`${theme.dim("│")} ${theme.comment("/* 시작")}`]);
    // The comment carries on to the next line until it is closed.
    expect(stream.pushLine("끝 */ return 1")).toEqual([
      `${theme.dim("│")} ${theme.comment("끝 */")} ${theme.keyword("return")} ${theme.number("1")}`,
    ]);
    expect(stream.finish()).toEqual([]);
  });

  it("leaves code in an unknown language plain, and strips escapes before highlighting", () => {
    const rows = renderAt(1, "```cobol\nMOVE \u001b[2J\u001b]0;x\u0007 A TO B\n```");
    expect(rows[1]).toBe(`${themeOf(1).dim("│")} MOVE  A TO B`);
    expect(renderAt(1, "```ts\nlet \u001b[31mx = 1\n```")[1]).not.toContain("\u001b[31m");
  });

  it("renders a diff block with its changed lines marked and prints no escape without colour", () => {
    const rows = render("```diff\n@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n```");
    expect(rows).toEqual(["diff", "@@ -1,2 +1,2 @@", "1   keep", "2 - old line", "2 + new line"]);
    expect(rows.join("")).not.toContain("\u001b");
  });
});

describe("railed Markdown", () => {
  const railed = (text: string, width = 40, style = plain) =>
    renderMarkdown(text, { width, style, railed: true });

  it("puts text on the rail, a blank line as a bare bar, and never starts or ends on one", () => {
    expect(railed("\n첫 문단\n\n\n\n둘째 문단\n\n")).toEqual(["│  첫 문단", "│", "│  둘째 문단"]);
  });

  it("wraps text to what is left after the rail, in columns and not characters", () => {
    const rows = railed("가나다 라마바 사아자 차카타 파하", 12);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.startsWith("│  ")).toBe(true);
      expect(visibleWidth(row)).toBeLessThanOrEqual(12);
    }
  });

  it("breaks the rail for code, which starts at column 0 with no gutter, one bar either side", () => {
    expect(railed("앞 문단\n```ts\nconst a = 1;\n```\n뒤 문단")).toEqual([
      "│  앞 문단",
      "│",
      "ts",
      "const a = 1;",
      "│",
      "│  뒤 문단",
    ]);
  });

  it("does not add a bar of its own where the text already has a blank line around the code", () => {
    expect(railed("앞\n\n```\nx\n```\n\n뒤")).toEqual(["│  앞", "│", "code", "x", "│", "│  뒤"]);
  });

  it("leaves no bar after code that ends the reply, or before code that starts it", () => {
    expect(railed("```\nx\n```")).toEqual(["code", "x"]);
  });

  it("gives code the whole width, which a railed paragraph does not get", () => {
    const code = "x".repeat(38);
    expect(railed(`\`\`\`\n${code}\n\`\`\``, 40)).toEqual(["code", code]);
    expect(railed(code, 40).length).toBe(2);
  });

  it("starts a diff at column 0 as well", () => {
    expect(railed("바꿈\n```diff\n-a\n+b\n```", 40)).toEqual([
      "│  바꿈",
      "│",
      "diff",
      "- a",
      "+ b",
    ]);
  });

  it("closes an unterminated fence at the end without a bar after it", () => {
    const stream = new MarkdownStream({ width: 40, style: plain, railed: true });
    expect(stream.pushLine("```")).toEqual(["code"]);
    expect(stream.inCode).toBe(true);
    expect(stream.pushLine("x")).toEqual(["x"]);
    expect(stream.finish()).toEqual([]);
    expect(stream.inCode).toBe(false);
  });

  it("says a bar is due after a code block, until the next text row has paid it", () => {
    const stream = new MarkdownStream({ width: 40, style: plain, railed: true });
    stream.pushLine("```");
    stream.pushLine("x");
    expect(stream.gapDue).toBe(false);
    expect(stream.pushLine("```")).toEqual([]);
    expect(stream.gapDue).toBe(true);
    expect(stream.pushLine("뒤")).toEqual(["│", "│  뒤"]);
    expect(stream.gapDue).toBe(false);
  });

  it("keeps the marker that stands in for a chart on the rail, and tables inside the text width", () => {
    expect(railed("```chart\n{}\n```")[0]?.startsWith("│  [차트")).toBe(true);
    const rows = railed("| 이름 | 값 |\n|---|---|\n| 가나 | 1 |");
    expect(rows).toEqual(["│  이름 | 값", "│  -----+---", "│  가나 | 1 "]);
    const tooWide = railed(
      "| 아주 긴 첫째 칸 내용입니다 | 아주 긴 둘째 칸 내용입니다 |\n|---|---|\n| a | b |",
      30,
    );
    for (const row of tooWide) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  });

  it("keeps the code background on the coloured code rows and the rail off them", () => {
    const style = makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 3));
    const rows = railed("```ts\nlet a = 1;\n```", 40, style);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toContain(";48;2;");
      expect(visibleWidth(row)).toBe(40);
    }
  });

  it("draws the same rows as before when it is not railed", () => {
    expect(renderMarkdown("앞\n\n```ts\nx\n```\n뒤", { width: 40, style: plain })).toEqual([
      "앞",
      "",
      "ts",
      "│ x",
      "뒤",
    ]);
  });

  it("keeps the rail's symbols in the ASCII preset", () => {
    expect(
      renderMarkdown("앞\n```\nx\n```", {
        width: 40,
        style: plain,
        railed: true,
        symbols: ASCII_SYMBOLS,
      }),
    ).toEqual(["|  앞", "|", "code", "x"]);
  });
});
