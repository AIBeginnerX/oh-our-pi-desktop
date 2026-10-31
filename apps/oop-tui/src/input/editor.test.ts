import { describe, expect, it } from "vite-plus/test";

import {
  backspace,
  deleteForward,
  deleteWordBack,
  editorFromText,
  editorText,
  emptyEditor,
  insertNewline,
  insertText,
  killToLineEnd,
  killToLineStart,
  layoutInput,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
} from "./editor.ts";

describe("editor", () => {
  it("removes one Hangul syllable per Backspace and keeps the rest intact", () => {
    let state = insertText(emptyEditor, "안녕하세요");
    state = backspace(state);
    expect(editorText(state)).toBe("안녕하세");
    state = backspace(backspace(state));
    expect(editorText(state)).toBe("안녕");
  });

  it("removes a whole emoji with its skin tone in one Backspace", () => {
    const state = backspace(insertText(emptyEditor, "a👍🏽"));
    expect(editorText(state)).toBe("a");
  });

  it("joins a conjoining jamo typed after a syllable into the same character", () => {
    let state = insertText(emptyEditor, "하");
    state = insertText(state, "ᆫ");
    expect(state.chars).toEqual(["한"]);
    expect(state.cursor).toBe(1);
  });

  it("joins a jamo into a syllable in the middle of a long buffer", () => {
    let state = editorFromText(`${"가".repeat(500)}하${"나".repeat(500)}`);
    state = { ...state, cursor: 501 };
    state = insertText(state, "ᆫ");
    expect(state.chars).toHaveLength(1001);
    expect(state.chars[500]).toBe("하\u11AB");
    expect(state.cursor).toBe(501);
  });

  it("inserts at the cursor and keeps the cursor after the inserted text", () => {
    let state = editorFromText("가다");
    state = moveLeft(state);
    state = insertText(state, "나");
    expect(editorText(state)).toBe("가나다");
    expect(state.cursor).toBe(2);
  });

  it("does nothing at the buffer edges", () => {
    expect(backspace(emptyEditor)).toBe(emptyEditor);
    expect(moveLeft(emptyEditor)).toBe(emptyEditor);
    const full = editorFromText("가");
    expect(moveRight(full)).toBe(full);
    expect(deleteForward(full)).toBe(full);
  });

  it("deletes forward without moving the cursor", () => {
    const state = deleteForward({ ...editorFromText("가나다"), cursor: 1 });
    expect(editorText(state)).toBe("가다");
    expect(state.cursor).toBe(1);
  });

  it("drops control characters from pasted text but keeps newlines and turns tabs into spaces", () => {
    const state = insertText(emptyEditor, "a\u001b[31mb\r\nc\td");
    expect(editorText(state)).toBe("a[31mb\nc  d");
  });

  it("moves by word across Korean and ASCII", () => {
    const state = editorFromText("hello 한글 world");
    expect(moveWordLeft(state).cursor).toBe(9);
    expect(moveWordLeft(moveWordLeft(state)).cursor).toBe(6);
    expect(moveWordRight({ ...state, cursor: 0 }).cursor).toBe(5);
    expect(editorText(deleteWordBack(state))).toBe("hello 한글 ");
  });

  it("kills to the start or end of the current line only", () => {
    const state = { ...editorFromText("앞줄\n뒷줄 끝"), cursor: 5 };
    expect(editorText(killToLineEnd(state))).toBe("앞줄\n뒷줄");
    expect(editorText(killToLineStart(state))).toBe("앞줄\n 끝");
    expect(moveHome(state).cursor).toBe(3);
    expect(moveEnd(state).cursor).toBe(7);
  });

  it("joins the next line when Ctrl-K is pressed at a line end", () => {
    const state = { ...editorFromText("가\n나"), cursor: 1 };
    expect(editorText(killToLineEnd(state))).toBe("가나");
  });
});

describe("layoutInput", () => {
  it("wraps by display width and never splits a wide character", () => {
    const layout = layoutInput(editorFromText("가나다라마"), 5);
    expect(layout.rows).toEqual(["가나", "다라", "마"]);
  });

  it("places the cursor by display column", () => {
    const layout = layoutInput({ ...editorFromText("가a나"), cursor: 2 }, 10);
    expect(layout.cursor).toEqual({ row: 0, col: 3 });
  });

  it("lets the cursor sit one column past a full row", () => {
    const layout = layoutInput(editorFromText("가나"), 4);
    expect(layout.rows).toEqual(["가나"]);
    expect(layout.cursor).toEqual({ row: 0, col: 4 });
  });

  it("starts a new row when the next character no longer fits", () => {
    const layout = layoutInput(editorFromText("가나다"), 4);
    expect(layout.rows).toEqual(["가나", "다"]);
    expect(layout.cursor).toEqual({ row: 1, col: 2 });
  });

  it("handles explicit newlines", () => {
    const layout = layoutInput(insertNewline(editorFromText("가")), 10);
    expect(layout.rows).toEqual(["가", ""]);
    expect(layout.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("moveVertical", () => {
  it("keeps the visual column across rows of mixed width", () => {
    const state = { ...editorFromText("abcdef\n가나다라"), cursor: 3 };
    const down = moveVertical(state, 20, 1);
    // Column 3 falls inside the second syllable (columns 2-3), so the cursor stops before it.
    expect(down?.cursor).toBe(7 + 1);
    const up = moveVertical(down as typeof state, 20, -1);
    expect(up?.cursor).toBe(2);
  });

  it("returns null at the first and last row so the caller can use the key for history", () => {
    const state = editorFromText("한 줄");
    expect(moveVertical(state, 20, -1)).toBeNull();
    expect(moveVertical(state, 20, 1)).toBeNull();
  });
});
