import { describe, expect, it } from "vite-plus/test";

import { stripAnsi } from "../text/width.ts";
import { wrapStyled } from "../text/wrap.ts";
import {
  cellText,
  DragState,
  droppedSpaces,
  highlightCells,
  selectionText,
  type SelectedRow,
} from "./selection.ts";

const REV = "\u001b[7m";
const REV_OFF = "\u001b[27m";

describe("cellText", () => {
  it("takes the cells in range of plain text", () => {
    expect(cellText("hello world", 0, 5)).toBe("hello");
    expect(cellText("hello world", 6, 99)).toBe("world");
  });

  it("counts a Korean syllable as two cells and takes it whole when either half is in range", () => {
    // 한=0,1 글=2,3 a=4
    expect(cellText("한글a", 0, 2)).toBe("한");
    expect(cellText("한글a", 1, 2)).toBe("한");
    expect(cellText("한글a", 1, 3)).toBe("한글");
    expect(cellText("한글a", 3, 5)).toBe("글a");
    expect(cellText("한글a", 4, 5)).toBe("a");
  });

  it("ignores styling and keeps a combining mark with its letter", () => {
    expect(cellText("\u001b[31mab\u001b[39m한", 1, 4)).toBe("b한");
    expect(cellText("éx", 0, 1)).toBe("é");
  });
});

describe("highlightCells", () => {
  it("wraps the selected cells in reverse video and leaves the rest alone", () => {
    expect(highlightCells("abcd", 1, 3)).toBe(`a${REV}bc${REV_OFF}d`);
    expect(stripAnsi(highlightCells("abcd", 1, 3))).toBe("abcd");
  });

  it("covers a wide glyph whole and puts the highlight on whole glyphs only", () => {
    expect(highlightCells("가나다", 1, 2)).toBe(`${REV}가${REV_OFF}나다`);
  });

  it("closes at the end of the text when the range runs past it", () => {
    expect(highlightCells("ab", 0, Infinity)).toBe(`${REV}ab${REV_OFF}`);
    expect(highlightCells("ab", 5, 9)).toBe("ab");
  });

  it("keeps other styles and re-asserts the reverse after a reset inside the range", () => {
    const row = "\u001b[31mab\u001b[0mcd";
    expect(highlightCells(row, 1, 4)).toBe(`\u001b[31ma${REV}b\u001b[0m${REV}cd${REV_OFF}`);
  });
});

describe("selectionText", () => {
  const rowOf = (styled: string, over: Partial<SelectedRow> = {}): SelectedRow => ({
    styled,
    line: Symbol(styled),
    from: 0,
    to: Infinity,
    spaceAfter: false,
    ...over,
  });

  it("is plain text, one line per row, without the rail's marks or trailing padding", () => {
    const rows = [
      rowOf("\u001b[2m│\u001b[22m"),
      rowOf("\u001b[2m│\u001b[22m  첫 줄입니다   "),
      rowOf("◇  단계"),
      rowOf("│  둘째 줄"),
    ];
    expect(selectionText(rows)).toBe("\n첫 줄입니다\n단계\n둘째 줄");
  });

  it("strips the ASCII preset's rail too", () => {
    expect(selectionText([rowOf("|  one"), rowOf("o  two")])).toBe("one\ntwo");
  });

  it("keeps a partial first and last row exactly as selected", () => {
    const rows = [
      rowOf("│  alpha beta", { from: 9, to: Infinity }),
      rowOf("│  gamma delta", { to: 10 }),
    ];
    expect(selectionText(rows)).toBe("beta\ngamma d");
  });

  it("takes the right-aligned bubble's padding off, keeping a code block's own indent", () => {
    const bubble = [rowOf("            첫째 줄  "), rowOf("            둘째    ")];
    expect(selectionText(bubble)).toBe("첫째 줄\n둘째");
    const code = [rowOf("fn main() {"), rowOf("    body();"), rowOf("}")];
    expect(selectionText(code)).toBe("fn main() {\n    body();\n}");
    const indented = [rowOf("    if x {"), rowOf("        y();"), rowOf("    }")];
    expect(selectionText(indented)).toBe("if x {\n    y();\n}");
  });

  describe("the box of the user's message", () => {
    const bubble = [
      "                            ╭──────────╮",
      "                            │ 첫째 줄  │",
      "                            │ 둘째 줄  │",
      "                            ╰──────────╯",
    ];

    it("copies the text without the border or the padding around it", () => {
      expect(selectionText(bubble.map((row) => rowOf(row)))).toBe("첫째 줄\n둘째 줄");
    });

    it("copies nothing of the box's top and bottom edges, even when only they are selected", () => {
      const [top, , , bottom] = bubble.map((row) => rowOf(row)) as [
        SelectedRow,
        SelectedRow,
        SelectedRow,
        SelectedRow,
      ];
      expect(selectionText([top])).toBe("");
      expect(selectionText([bottom])).toBe("");
      expect(selectionText([top, bottom])).toBe("");
    });

    it("takes a row from the pointer's column, border glyph included or not", () => {
      const rows = bubble.map((row) => rowOf(row));
      // The press is inside the box, on the second cell of the second row (`째`).
      const inside = rows.map((row, index) => ({ ...row, from: index === 1 ? 33 : 0 }));
      expect(selectionText(inside)).toBe("째 줄\n둘째 줄");
    });

    it("takes the ASCII border off too", () => {
      const ascii = ["            +------+", "            | 안녕 |", "            +------+"];
      expect(selectionText(ascii.map((row) => rowOf(row)))).toBe("안녕");
    });

    it("leaves a markdown table's own bars and a reply's rule alone", () => {
      expect(selectionText([rowOf("| a | b |"), rowOf("|---|---|")])).toBe("| a | b |\n|---|---|");
      expect(selectionText([rowOf("── 제목 ──"), rowOf("본문")])).toBe("── 제목 ──\n본문");
    });
  });

  it("leaves the indent inside a rail row alone: only rows off the rail share a layout indent", () => {
    expect(selectionText([rowOf("│     nested item"), rowOf("          b")])).toBe(
      "   nested item\nb",
    );
  });

  it("joins the rows of one logical line, with the space the fold dropped put back", () => {
    const line = {};
    const rows = [
      rowOf("│  the quick", { line, spaceAfter: true }),
      rowOf("brown fox", { line }),
      rowOf("│  next line"),
    ];
    expect(selectionText(rows)).toBe("the quick brown fox\nnext line");
  });

  it("joins a fold inside a word, or between Korean syllables, with nothing", () => {
    const line = {};
    expect(
      selectionText([
        rowOf("한글로 쓴 긴 문", { line, spaceAfter: false }),
        rowOf("장입니다", { line }),
      ]),
    ).toBe("한글로 쓴 긴 문장입니다");
  });

  it("drops blank lines at the end", () => {
    expect(selectionText([rowOf("│  a"), rowOf("│")])).toBe("a");
  });
});

describe("droppedSpaces", () => {
  it("is true where the fold swallowed a space, false where it cut a word or a syllable", () => {
    const raw = "│  aaa bbb ccc";
    const rows = wrapStyled(raw, 9);
    expect(rows).toEqual(["│  aaa", "bbb ccc"]);
    expect(droppedSpaces(raw, rows)).toEqual([true, false]);
    const long = "한글한글한글한글한글";
    const cut = wrapStyled(long, 8);
    expect(cut.length).toBeGreaterThan(1);
    expect(droppedSpaces(long, cut).every((dropped) => !dropped)).toBe(true);
  });

  it("round-trips: folded rows, selected whole and joined, give the line back", () => {
    const raw = "│  one two three four five six seven";
    const rows = wrapStyled(raw, 12);
    const spaces = droppedSpaces(raw, rows);
    const line = {};
    const selected = rows.map((styled, index) => ({
      styled,
      line,
      from: 0,
      to: Infinity,
      spaceAfter: spaces[index] ?? false,
    }));
    expect(selectionText(selected)).toBe("one two three four five six seven");
  });
});

describe("DragState", () => {
  const drag = () => new DragState<number>((a, b) => a === b);

  it("ends a press that never moved as a click", () => {
    const state = drag();
    state.press(3);
    expect(state.release()).toEqual({ kind: "click" });
  });

  it("ends a press that moved to another place as a selection from where it went down", () => {
    const state = drag();
    state.press(3);
    expect(state.move(3)).toBe(false);
    expect(state.move(5)).toBe(true);
    expect(state.dragging).toBe(true);
    expect(state.move(5)).toBe(false);
    expect(state.release()).toEqual({ kind: "select", anchor: 3, head: 5 });
    expect(state.pressed).toBe(false);
  });

  it("treats a drag that came back to its start as a click", () => {
    const state = drag();
    state.press(3);
    state.move(4);
    state.move(3);
    expect(state.release()).toEqual({ kind: "click" });
  });

  it("ignores a press outside the area until the button is up", () => {
    const state = drag();
    state.press(null);
    expect(state.pressed).toBe(false);
    expect(state.move(4)).toBe(false);
    expect(state.release()).toEqual({ kind: "none" });
  });

  it("does nothing for motion or a release with no press", () => {
    const state = drag();
    expect(state.move(1)).toBe(false);
    expect(state.release()).toEqual({ kind: "none" });
  });

  it("forgets a press that was cancelled", () => {
    const state = drag();
    state.press(1);
    state.move(2);
    state.cancel();
    expect(state.release()).toEqual({ kind: "none" });
  });
});
