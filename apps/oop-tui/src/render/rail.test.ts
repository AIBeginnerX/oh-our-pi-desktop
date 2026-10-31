import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  RAIL_COLUMNS,
  packHint,
  railActive,
  railCancelled,
  railChoice,
  railDone,
  railEnd,
  railGap,
  railNote,
  railRow,
  railSelect,
  railStart,
  railStartRows,
  railWrap,
  type Rail,
} from "./rail.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS, type Symbols } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const railOf = (level: 0 | 1 | 2 | 3 = 0, symbols: Symbols = UNICODE_SYMBOLS): Rail => ({
  style: makeStyle(createTheme("oop", BUILTIN_THEMES.oop, level)),
  symbols,
});

const plain = (lines: ReadonlyArray<string>) => lines.map(stripAnsi);
const WIDTHS = [20, 40, 80, 120];
const SETS: ReadonlyArray<[string, Symbols]> = [
  ["unicode", UNICODE_SYMBOLS],
  ["ascii", ASCII_SYMBOLS],
];

describe("the rail's single rows", () => {
  it("draws the bar, the step marks and the end in the glyphs of the set", () => {
    const rail = railOf();
    expect(railGap(rail)).toBe("│");
    expect(railRow(rail, "내용")).toBe("│  내용");
    expect(railDone(rail, "끝")).toBe("◇  끝");
    expect(railActive(rail, "묻는 중")).toBe("◆  묻는 중");
    expect(railCancelled(rail, "멈춤")).toBe("■  멈춤");
    expect(railEnd(rail)).toBe("└");
    expect(railEnd(rail, "끝")).toBe("└  끝");
    const ascii = railOf(0, ASCII_SYMBOLS);
    expect(railRow(ascii, "x")).toBe("|  x");
    expect(railEnd(ascii, "x")).toBe("+  x");
  });

  it("is a bare bar for an empty row, so no line ends in spaces", () => {
    expect(railRow(railOf(), "")).toBe("│");
  });

  it("keeps its content aligned: every row's text begins RAIL_COLUMNS in", () => {
    const rail = railOf();
    for (const row of [railRow(rail, "a"), railDone(rail, "a"), railActive(rail, "a")]) {
      expect(visibleWidth(row) - 1).toBe(RAIL_COLUMNS);
    }
  });

  it("paints the bar by tone and nothing else of the row", () => {
    const rail = railOf(3);
    const { theme } = rail.style;
    expect(railRow(rail, "x", "warning")).toBe(`${theme.warning("│")}  x`);
    expect(railRow(rail, "x", "error")).toBe(`${theme.error("│")}  x`);
    expect(railRow(rail, "x", "active")).toBe(`${theme.accent("│")}  x`);
    expect(railRow(rail, "x")).toBe(`${theme.dim("│")}  x`);
    expect(railGap(rail, "warning")).toBe(theme.warning("│"));
  });

  it("emits no escape codes without colour", () => {
    const rail = railOf(0);
    for (const row of [
      railStart(rail, "OOP", "부제"),
      railDone(rail, "a"),
      railCancelled(rail, "a"),
      railEnd(rail, "a", "error"),
    ]) {
      expect(row).toBe(stripAnsi(row));
    }
  });
});

describe("railStart", () => {
  it("puts the name on a filled chip with the subtitle beside it, when colour allows", () => {
    const row = railStart(railOf(3), "OOP", "프로젝트 · 제목");
    expect(row).toContain("\u001b[7m");
    expect(stripAnsi(row)).toBe("┌   OOP   프로젝트 · 제목");
  });

  it("writes the bare name where a chip cannot be drawn: no colour, or the ascii set", () => {
    expect(railStart(railOf(0), "OOP", "부제")).toBe("┌  OOP  부제");
    const ascii = railStart(railOf(3, ASCII_SYMBOLS), "OOP", "부제");
    expect(ascii).not.toContain("\u001b[7m");
    expect(stripAnsi(ascii)).toBe("+  OOP  부제");
  });

  it("has no trailing spaces without a subtitle", () => {
    expect(railStart(railOf(0), "OOP")).toBe("┌  OOP");
  });
});

describe("railStartRows", () => {
  it("is the one row of railStart when the subtitle fits", () => {
    expect(railStartRows(railOf(0), "OOP", "부제", 40)).toEqual(["┌  OOP  부제"]);
    expect(railStartRows(railOf(0), "OOP", "", 40)).toEqual(["┌  OOP"]);
  });

  it("folds a long subtitle onto rail rows under it, never into the first column", () => {
    for (const width of [16, 20, 30, 40]) {
      for (const level of [0, 3] as const) {
        const rows = railStartRows(
          railOf(level),
          "OOP",
          "아주아주 긴 프로젝트 이름 · 그보다 더 긴 스레드 제목입니다 끝까지 이어집니다",
          width,
        );
        expect(rows.length).toBeGreaterThan(1);
        expect(stripAnsi(rows[0] ?? "").startsWith("┌")).toBe(true);
        for (const row of rows.slice(1)) expect(stripAnsi(row).startsWith("│  ")).toBe(true);
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("railWrap and packHint", () => {
  it("folds text to the room beside the rail, one rail row per line, Korean included", () => {
    const rail = railOf();
    for (const width of WIDTHS) {
      const rows = railWrap(rail, "한국어 문장을 아주 길게 이어서 씁니다 ".repeat(4), width);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(row.startsWith("│  ")).toBe(true);
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("folds a hint at a separator, never starting a row with one and never cutting a key", () => {
    const hint = "↑/↓ 이동 • 번호 • Enter 확정 • Ctrl-T 나중에 • Esc 턴 중단";
    expect(packHint(hint, 200)).toEqual([hint]);
    for (const room of [20, 30, 40]) {
      const rows = packHint(hint, room);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(room);
        expect(row.startsWith("•")).toBe(false);
      }
      expect(rows.join(" • ")).toContain("Ctrl-T 나중에");
    }
  });

  it("still fits a single key that is wider than the room, by folding inside it", () => {
    for (const row of packHint("가나다라마바사아자차카타파하", 6)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(6);
    }
  });
});

describe("railNote", () => {
  const body = ["첫째 줄", "둘째 줄은 조금 더 깁니다", "x"];

  it("draws a box whose every row ends in the same column, at any width, in both sets", () => {
    for (const [name, symbols] of SETS) {
      for (const width of WIDTHS) {
        const rows = plain(railNote(railOf(0, symbols), "제목", body, width));
        expect(new Set(rows.map(visibleWidth)).size, `${name} @ ${width}`).toBe(1);
        expect(visibleWidth(rows[0] as string)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("joins the box to the rail at the title and at its last row", () => {
    const rows = plain(railNote(railOf(), "제목", body, 80));
    expect(rows[0]?.startsWith("◇  제목 ")).toBe(true);
    expect(rows[0]?.endsWith("╮")).toBe(true);
    expect(rows.at(-1)?.startsWith("├")).toBe(true);
    expect(rows.at(-1)?.endsWith("╯")).toBe(true);
    for (const row of rows.slice(1, -1)) {
      expect(row.startsWith("│  ")).toBe(true);
      expect(row.endsWith("  │")).toBe(true);
    }
  });

  it("is only as wide as its widest row, and leaves a blank row above and below the text", () => {
    const rows = plain(railNote(railOf(), "제목", ["가나다"], 120));
    expect(visibleWidth(rows[0] as string)).toBeLessThan(30);
    expect(rows[1]?.replace(/[│\s]/gu, "")).toBe("");
    expect(rows.at(-2)?.replace(/[│\s]/gu, "")).toBe("");
    expect(rows.some((row) => row.includes("가나다"))).toBe(true);
  });

  it("cuts a row, and a title, that are wider than the terminal instead of overflowing", () => {
    for (const width of [12, 20, 40]) {
      const rows = plain(
        railNote(railOf(), "아주 긴 제목 ".repeat(6), ["가나다라마바사 ".repeat(10)], width),
      );
      for (const row of rows) expect(visibleWidth(row), `@ ${width}`).toBeLessThanOrEqual(width);
      expect(new Set(rows.map(visibleWidth)).size).toBe(1);
    }
  });

  it("paints the box in the tone's colour", () => {
    const rail = railOf(3);
    const rows = railNote(rail, "제목", ["x"], 40, "warning");
    expect(rows[1]).toContain(rail.style.theme.warning("│"));
  });
});

describe("railChoice and railSelect", () => {
  const options = [
    { label: "첫째", note: "설명이 붙습니다" },
    { label: "둘째" },
    { label: "셋째", warning: "되돌릴 수 없음" },
  ];
  const choice = (extra: Partial<Parameters<typeof railChoice>[1]> = {}) => ({
    question: "무엇을 할까요?",
    options,
    selected: 1,
    hint: "↑/↓ 이동 • Enter 선택",
    width: 60,
    ...extra,
  });

  it("asks on a step mark, fills only the selected option, and says how to answer", () => {
    const rows = plain(railChoice(railOf(), choice()));
    expect(rows[0]).toBe("◆  무엇을 할까요?");
    expect(rows.filter((row) => row.includes("●"))).toEqual(["│  ● 둘째"]);
    expect(rows).toContain("│  ○ 첫째  설명이 붙습니다");
    expect(rows.at(-1)).toBe("│  ↑/↓ 이동 • Enter 선택");
  });

  it("fills nothing while nothing is picked", () => {
    const rows = plain(railChoice(railOf(), choice({ selected: null })));
    expect(rows.some((row) => row.includes("●"))).toBe(false);
  });

  it("closes the rail only in railSelect", () => {
    const open = railChoice(railOf(), choice());
    const closed = railSelect(railOf(), "무엇을 할까요?", options, 1, "힌트", 60);
    expect(open.some((row) => stripAnsi(row).startsWith("└"))).toBe(false);
    expect(stripAnsi(closed.at(-1) as string)).toBe("└");
  });

  it("puts a warning on its own row under its option, in the error colour", () => {
    const rail = railOf(3);
    const rows = railChoice(rail, choice());
    const at = plain(rows).findIndex((row) => row.includes("셋째"));
    expect(stripAnsi(rows[at + 1] as string)).toContain("되돌릴 수 없음");
    expect(rows[at + 1]).toContain(rail.style.theme.error("되돌릴 수 없음"));
  });

  it("says how many options are out of view above and below", () => {
    const rows = plain(railChoice(railOf(), choice({ hidden: { above: 2, below: 5 } })));
    expect(rows).toContain("│  … 위로 2개");
    expect(rows).toContain("│  … 아래로 5개");
    const none = plain(railChoice(railOf(), choice({ hidden: { above: 0, below: 0 } })));
    expect(none.some((row) => row.includes("…"))).toBe(false);
  });

  it("drops an option's note first when the row is narrow, and keeps its label", () => {
    const rows = plain(railChoice(railOf(), choice({ width: 16 })));
    expect(rows.some((row) => row.includes("설명이"))).toBe(false);
    expect(rows.some((row) => row.includes("첫째"))).toBe(true);
  });

  it("uses the three-column ascii marks without overflowing", () => {
    for (const width of [12, 20, 40, 80]) {
      const rows = plain(railChoice(railOf(0, ASCII_SYMBOLS), choice({ width })));
      expect(rows.some((row) => row.includes("(*) 둘째"))).toBe(true);
      expect(rows.some((row) => row.includes("( ) 첫째"))).toBe(true);
      for (const row of rows) expect(visibleWidth(row), `@ ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("never draws wider than the width, with Korean labels, at any width", () => {
    const long = [
      { label: "아주 긴 한국어 선택지 이름 ".repeat(5), note: "긴 설명 ".repeat(10) },
      { label: "x", warning: "경고 문장이 아주 깁니다 ".repeat(6) },
    ];
    for (const [, symbols] of SETS) {
      for (const width of [10, 16, 24, 40, 80, 120]) {
        const rows = plain(
          railChoice(
            railOf(0, symbols),
            choice({ question: "긴 질문 ".repeat(20), options: long, width }),
          ),
        );
        for (const row of rows) expect(visibleWidth(row), `@ ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("shows the rows between the question and the options", () => {
    const rows = plain(railChoice(railOf(), choice({ before: ["rm -rf build"] })));
    expect(rows[1]).toBe("│  rm -rf build");
  });
});
