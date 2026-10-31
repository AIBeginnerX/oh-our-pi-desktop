import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { UNICODE_SYMBOLS } from "../render/symbols.ts";
import { stringWidth } from "../text/width.ts";
import { editorFromText } from "../input/editor.ts";
import { stripAnsi } from "../text/width.ts";
import { undoItems, undoSummary } from "./undoFlow.ts";
import { BUILTIN_THEMES, createTheme } from "../render/theme.ts";
import { noticeRows, renderPicker, renderTextPrompt } from "./view.ts";

const rowFor = (label: string, note: string, columns: number): string => {
  const { lines } = renderPicker(
    { title: "프로젝트", items: [{ label, note }], selected: 0, hint: "", empty: "" },
    columns,
    20,
    makeStyle(false),
    UNICODE_SYMBOLS,
    null,
  );
  return lines[2] as string;
};

describe("renderPicker", () => {
  const longPath = `/Users/example/Library/CloudStorage/${"내드라이브/".repeat(12)}프로젝트`;

  it("keeps the whole name when a long path would squeeze it", () => {
    const row = rowFor("펠리컨.프로젝트", longPath, 100);
    expect(row).toContain("펠리컨.프로젝트");
    expect(row).toContain("/Users/example");
    expect(stringWidth(row)).toBeLessThanOrEqual(99);
  });

  it("drops the path when no useful room is left", () => {
    const row = rowFor("가".repeat(16), longPath, 40);
    expect(row).toContain("가".repeat(16));
    expect(row).not.toContain("/Users");
    expect(stringWidth(row)).toBeLessThanOrEqual(39);
  });

  it("shows a short path whole", () => {
    expect(rowFor("oop", "/tmp/oop", 80)).toContain("/tmp/oop");
  });
});

describe("renderPicker on the rail", () => {
  const view = (count: number, selected: number) => ({
    title: "스레드를 고르세요",
    items: Array.from({ length: count }, (_, index) => ({ label: `항목 ${index}`, note: "설명" })),
    selected,
    hint: "↑/↓ 이동 • Enter 열기 • q 종료",
    empty: "아무것도 없습니다",
  });
  const draw = (
    v: ReturnType<typeof view>,
    columns: number,
    rows: number,
    banner: string | null = null,
  ) => renderPicker(v, columns, rows, makeStyle(false), UNICODE_SYMBOLS, banner).lines;

  it("asks on a step mark, fills the chosen row alone, and closes the rail under the hint", () => {
    const lines = draw(view(3, 1), 80, 20);
    expect(lines).toContain("◆  스레드를 고르세요");
    expect(lines.filter((line) => line.includes("●"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("●"))).toContain("항목 1");
    expect(lines.at(-2)).toBe("│  ↑/↓ 이동 • Enter 열기 • q 종료");
    expect(lines.at(-1)).toBe("└");
  });

  it("puts a notice row above the rail, and a bare bar between them", () => {
    const lines = draw(view(2, 0), 80, 20, "연결이 끊어졌습니다");
    expect(lines[0]).toBe("▲  연결이 끊어졌습니다");
    expect(lines[1]).toBe("│");
  });

  it("says what is out of view and keeps the chosen row in view when the list is long", () => {
    const lines = draw(view(30, 15), 80, 12);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.find((line) => line.includes("●"))).toContain("항목 15");
    expect(lines.some((line) => line.includes("… 위로"))).toBe(true);
    expect(lines.some((line) => line.includes("… 아래로"))).toBe(true);
  });

  it("explains an empty list instead of drawing a question with no answers", () => {
    const lines = draw(view(0, 0), 80, 20);
    expect(lines).toContain("│  아무것도 없습니다");
    expect(lines.some((line) => line.includes("●") || line.includes("○"))).toBe(false);
  });

  it("never draws wider than the terminal at 40, 80 and 120 columns", () => {
    for (const columns of [40, 80, 120]) {
      for (const line of draw(view(30, 3), columns, 14, "연결이 끊어졌습니다")) {
        expect(stringWidth(line), `@ ${columns}: ${line}`).toBeLessThanOrEqual(columns - 1);
      }
    }
  });
});

describe("renderPicker when the rows run out", () => {
  it("keeps the last words of what is confirmed and the options, and drops the first rows", () => {
    const plan = {
      turn: 3,
      target: 2,
      files: { count: 4, additions: 20, deletions: 5 },
      prompt: "로그인 고쳐줘",
      restore: "possible" as const,
    };
    const theme = createTheme("oop", BUILTIN_THEMES.oop, 0);
    const { lines } = renderPicker(
      {
        title: "마지막 턴 되돌리기",
        items: undoItems(plan),
        selected: 0,
        hint: "↑/↓ 이동 • Enter 선택 • Esc 취소",
        empty: "",
        before: undoSummary(plan, theme, 80 - 1 - 3, 2),
      },
      80,
      8,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    expect(lines.length).toBeLessThanOrEqual(8);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("되돌린 것을 다시 되돌리는 기능은 데스크톱 앱에도 없습니다.");
    expect(text).toContain("취소");
    expect(text).toContain("마지막 턴 되돌리기");
  });

  it("keeps a single row before the list however short the room", () => {
    const { lines } = renderPicker(
      {
        title: "모델 선택",
        before: ["검색: opus"],
        items: [{ label: "A" }, { label: "B" }, { label: "C" }],
        selected: 0,
        hint: "Esc 닫기",
        empty: "없음",
      },
      60,
      6,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    expect(lines.join("\n")).toContain("검색: opus");
  });
});

describe("renderPicker with rows before the list", () => {
  it("draws them under the question, on the rail, before the first option", () => {
    const { lines } = renderPicker(
      {
        title: "모델 선택",
        before: ["검색: opus"],
        items: [{ label: "Claude / Opus" }],
        selected: 0,
        hint: "Esc 닫기",
        empty: "없음",
      },
      60,
      20,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    const question = lines.indexOf("◆  모델 선택");
    expect(lines[question + 1]).toBe("│  검색: opus");
    expect(lines[question + 2]).toContain("● Claude / Opus");
  });

  it("keeps them when nothing matches", () => {
    const { lines } = renderPicker(
      {
        title: "모델 선택",
        before: ["검색: zzz"],
        items: [],
        selected: 0,
        hint: "Esc",
        empty: "일치하는 모델이 없습니다.",
      },
      60,
      20,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    expect(lines).toContain("│  검색: zzz");
    expect(lines.join("\n")).toContain("일치하는 모델이 없습니다.");
  });
});

describe("renderTextPrompt", () => {
  const draw = (text: string, columns = 60) =>
    renderTextPrompt(
      {
        title: "목표",
        editor: editorFromText(text),
        placeholder: "예: 테스트 통과",
        hint: "Enter 저장 • Esc 취소",
      },
      columns,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );

  it("asks on a step mark, shows the placeholder while empty, and closes the rail", () => {
    const { lines, cursor } = draw("");
    expect(lines).toContain("◆  목표");
    expect(lines.join("\n")).toContain("예: 테스트 통과");
    expect(lines.at(-1)).toBe("└");
    expect(cursor).not.toBeNull();
  });

  it("shows what was typed, wide letters included, and puts the cursor after it", () => {
    const { lines, cursor } = draw("테스트");
    expect(lines.join("\n")).toContain("│  테스트");
    expect(lines.join("\n")).not.toContain("예: 테스트 통과");
    expect(cursor?.col).toBe(3 + stringWidth("테스트"));
  });

  it("never draws wider than the terminal, at 40 columns", () => {
    for (const row of draw("가".repeat(60), 40).lines)
      expect(stringWidth(row)).toBeLessThanOrEqual(39);
  });

  it("draws a secret as marks, one per letter, and never the letters", () => {
    const { lines, cursor } = renderTextPrompt(
      {
        title: "API 키",
        editor: editorFromText("test-value-1234 한글"),
        placeholder: "",
        hint: "",
        mask: "•",
      },
      60,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    const screen = lines.join("\n");
    expect(screen).toContain("•".repeat(Array.from("test-value-1234 한글").length));
    expect(screen).not.toContain("test-value");
    expect(screen).not.toContain("한글");
    expect(cursor?.col).toBe(3 + Array.from("test-value-1234 한글").length);
  });

  it("draws the rows given as `before` between the question and the field, cut to the terminal", () => {
    const { lines } = renderTextPrompt(
      {
        title: "삭제",
        editor: editorFromText(""),
        placeholder: "yes",
        hint: "",
        before: ["첫 줄", "긴 줄 ".repeat(30)],
      },
      40,
      makeStyle(false),
      UNICODE_SYMBOLS,
      null,
    );
    expect(lines.indexOf("◆  삭제")).toBeLessThan(lines.findIndex((row) => row.includes("첫 줄")));
    expect(lines.findIndex((row) => row.includes("첫 줄"))).toBeLessThan(
      lines.findIndex((row) => row.includes("yes")),
    );
    for (const row of lines) expect(stringWidth(row)).toBeLessThanOrEqual(39);
  });
  it("keeps the warning on top when a long answer is taller than the terminal, and the cursor on its row", () => {
    const text = Array.from({ length: 12 }, (_, index) => `줄 ${index + 1}`).join("\n");
    const { lines, cursor } = renderTextPrompt(
      { title: "목표", editor: editorFromText(text), placeholder: "", hint: "Enter 저장" },
      60,
      makeStyle(false),
      UNICODE_SYMBOLS,
      "승인이 기다립니다",
      "warning",
      8,
    );
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("승인이 기다립니다");
    expect(lines[cursor?.row ?? -1]).toContain("줄 12");
    // Unbounded, as before, when no height is given.
    const free = renderTextPrompt(
      { title: "목표", editor: editorFromText(text), placeholder: "", hint: "Enter 저장" },
      60,
      makeStyle(false),
      UNICODE_SYMBOLS,
      "승인이 기다립니다",
    );
    expect(free.lines.length).toBeGreaterThan(8);
  });
});

describe("a notice above the rail", () => {
  const style = makeStyle(false);
  const rail = { style, symbols: UNICODE_SYMBOLS };
  const long =
    "목표가 자동으로 이어지는 중이라 모드를 지금 바꿀 수 없습니다. /goal clear 로 해제 후 바꾸세요.";
  const flat = (rows: ReadonlyArray<string>) => rows.join(" ").replace(/\s+/gu, " ");

  it("is folded onto up to three rows instead of cut, and keeps the way out at the end", () => {
    for (const columns of [40, 60, 80]) {
      const rows = noticeRows(rail, long, "warning", columns - 1);
      expect(rows.length, `${columns}`).toBeGreaterThan(1);
      expect(rows.length).toBeLessThanOrEqual(3);
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns - 1);
      expect(flat(rows)).toContain("/goal clear");
    }
  });

  it("takes one row when it fits, and cuts only past three rows", () => {
    expect(noticeRows(rail, "짧은 안내", "warning", 59)).toHaveLength(1);
    const rows = noticeRows(rail, "가나다라 ".repeat(60), "warning", 39);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(39);
  });

  it("pushes a picker down by every row of the notice, at 40 columns", () => {
    const view = {
      title: "모델 선택",
      items: [{ label: "Claude / Opus" }, { label: "Claude / Sonnet" }],
      selected: 0,
      hint: "Esc 닫기",
      empty: "없음",
    };
    const { lines } = renderPicker(view, 40, 30, style, UNICODE_SYMBOLS, long);
    const question = lines.indexOf("◆  모델 선택");
    expect(question).toBeGreaterThanOrEqual(4);
    expect(flat(lines.slice(0, question))).toContain("/goal clear");
    for (const row of lines) expect(stringWidth(row)).toBeLessThanOrEqual(39);
  });

  it("keeps every notice row and the cursor on its own row in a text prompt, at 40 columns", () => {
    const view = {
      title: "목표",
      editor: editorFromText("가나다"),
      placeholder: "예",
      hint: "Enter 저장",
    };
    const { lines, cursor } = renderTextPrompt(
      view,
      40,
      style,
      UNICODE_SYMBOLS,
      long,
      "warning",
      30,
    );
    expect(flat(lines.slice(0, 3))).toContain("/goal clear");
    expect(cursor).not.toBeNull();
    expect(lines[cursor?.row ?? 0]).toContain("가나다");
  });

  it("keeps all its rows when a tall text prompt is cut to the terminal, with the cursor following", () => {
    const view = {
      title: "목표",
      editor: editorFromText(Array.from({ length: 20 }, (_, index) => `줄 ${index}`).join("\n")),
      placeholder: "예",
      hint: "Enter 저장",
    };
    const { lines, cursor } = renderTextPrompt(
      view,
      40,
      style,
      UNICODE_SYMBOLS,
      long,
      "warning",
      10,
    );
    expect(lines).toHaveLength(10);
    expect(flat(lines.slice(0, 3))).toContain("/goal clear");
    expect(lines[cursor?.row ?? 0]).toContain("줄 19");
  });
});
