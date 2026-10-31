import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { stripAnsi, visibleWidth } from "./width.ts";
import { padEndVisible, truncateStyled, wrapStyled, wrapWithPrefix } from "./wrap.ts";

const style = makeStyle(true);

describe("wrapStyled", () => {
  it("breaks at line feeds instead of passing them through", () => {
    expect(wrapStyled("a\nb", 40)).toEqual(["a", "b"]);
    expect(wrapStyled("a\n\nb", 40)).toEqual(["a", "", "b"]);
    expect(wrapStyled("가나다라 마바\n사아", 8)).toEqual(["가나다라", "마바", "사아"]);
  });

  it("keeps a style open across a line feed", () => {
    const rows = wrapStyled(style.bold("a\nb"), 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain("\n");
    expect(rows[1]).toContain(style.bold("b").slice(0, 4));
    expect(stripAnsi(rows[1] as string)).toBe("b");
  });

  it("breaks Korean text at word boundaries without exceeding the width", () => {
    const rows = wrapStyled("안녕하세요 반갑습니다 오늘도 좋은 하루", 12);
    expect(rows).toEqual(["안녕하세요", "반갑습니다", "오늘도 좋은", "하루"]);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
  });

  it("falls back to character boundaries for a long unbroken Korean run", () => {
    const rows = wrapStyled("가나다라마바사아자차", 6);
    expect(rows).toEqual(["가나다", "라마바", "사아자", "차"]);
  });

  it("never splits a wide character across rows", () => {
    const rows = wrapStyled("a가나다", 4);
    expect(rows).toEqual(["a가", "나다"]);
  });

  it("closes styles at a break and reopens them on the next row", () => {
    const rows = wrapStyled(style.bold("가나다라 마바사아"), 8);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.endsWith("\u001b[0m")).toBe(true);
    expect(rows[1]!.startsWith("\u001b[1m")).toBe(true);
    expect(rows.map(stripAnsi)).toEqual(["가나다라", "마바사아"]);
  });

  it("does not carry a finished style onto the plain text that follows it", () => {
    const rows = wrapStyled(`${style.bold("굵게")} 그리고 평범한 글자가 이어집니다`, 12);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) expect(row).not.toContain("\u001b[1m");
  });

  it("returns one empty row for an empty line", () => {
    expect(wrapStyled("", 10)).toEqual([""]);
  });
});

describe("wrapWithPrefix", () => {
  it("indents continuation rows under the first row's text", () => {
    const rows = wrapWithPrefix("가나다라마바사", 8, "● ", "  ");
    expect(rows).toEqual(["● 가나다", "  라마바", "  사"]);
  });
});

describe("truncateStyled", () => {
  it("leaves short lines alone and marks cuts with a tilde within the width", () => {
    expect(truncateStyled("짧음", 10)).toBe("짧음");
    const cut = truncateStyled("가나다라마바사아", 7);
    expect(stripAnsi(cut)).toBe("가나다~");
    expect(visibleWidth(cut)).toBeLessThanOrEqual(7);
  });

  it("closes an open style when it cuts inside it", () => {
    expect(truncateStyled(style.red("가나다라마바"), 5).endsWith("\u001b[0m~")).toBe(true);
  });
});

describe("padEndVisible", () => {
  it("pads by display width", () => {
    expect(padEndVisible("한글", 6)).toBe("한글  ");
    expect(padEndVisible("toolong", 3)).toBe("toolong");
  });
});
