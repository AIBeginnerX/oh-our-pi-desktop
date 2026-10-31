import { graphemeWidth, graphemesOf } from "../text/width.ts";

/**
 * The composer buffer. Text is held as grapheme clusters so one Backspace removes one visible
 * character (a Hangul syllable, an emoji with its modifiers) and the cursor never lands inside one.
 */
export interface EditorState {
  readonly chars: ReadonlyArray<string>;
  readonly cursor: number;
}

export const emptyEditor: EditorState = { chars: [], cursor: 0 };

export const editorText = (state: EditorState): string => state.chars.join("");

export const editorFromText = (text: string): EditorState => {
  const chars = graphemesOf(text);
  return { chars, cursor: chars.length };
};

/** Pasted and typed text: newlines kept, other control characters dropped, tabs become spaces. */
export const normalizeInsertedText = (text: string): string =>
  text
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "");

/** How many graphemes before the cursor are segmented again with an insertion: enough for a cluster that can still join. */
const SEAM_GRAPHEMES = 8;

export const insertText = (state: EditorState, text: string): EditorState => {
  const inserted = graphemesOf(normalizeInsertedText(text));
  if (inserted.length === 0) return state;
  // Re-segment the seam: a combining jamo typed after a syllable must join it. Only the few
  // graphemes next to the cursor can join, so a long buffer is not segmented again on each key.
  const from = Math.max(0, state.cursor - SEAM_GRAPHEMES);
  const head = state.chars.slice(from, state.cursor).join("");
  const joined = graphemesOf(head + inserted.join(""));
  return {
    chars: [...state.chars.slice(0, from), ...joined, ...state.chars.slice(state.cursor)],
    cursor: from + joined.length,
  };
};

export const insertNewline = (state: EditorState): EditorState => insertText(state, "\n");

export const backspace = (state: EditorState): EditorState => {
  if (state.cursor === 0) return state;
  const chars = [...state.chars.slice(0, state.cursor - 1), ...state.chars.slice(state.cursor)];
  return { chars, cursor: state.cursor - 1 };
};

export const deleteForward = (state: EditorState): EditorState => {
  if (state.cursor >= state.chars.length) return state;
  const chars = [...state.chars.slice(0, state.cursor), ...state.chars.slice(state.cursor + 1)];
  return { chars, cursor: state.cursor };
};

export const moveLeft = (state: EditorState): EditorState =>
  state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 };

export const moveRight = (state: EditorState): EditorState =>
  state.cursor >= state.chars.length ? state : { ...state, cursor: state.cursor + 1 };

const lineStart = (state: EditorState, from = state.cursor): number => {
  let index = from;
  while (index > 0 && state.chars[index - 1] !== "\n") index -= 1;
  return index;
};

const lineEnd = (state: EditorState, from = state.cursor): number => {
  let index = from;
  while (index < state.chars.length && state.chars[index] !== "\n") index += 1;
  return index;
};

export const moveHome = (state: EditorState): EditorState => ({
  ...state,
  cursor: lineStart(state),
});

export const moveEnd = (state: EditorState): EditorState => ({ ...state, cursor: lineEnd(state) });

const isWordChar = (grapheme: string) => /[\p{L}\p{N}_]/u.test(grapheme);

export const moveWordLeft = (state: EditorState): EditorState => {
  let index = state.cursor;
  while (index > 0 && !isWordChar(state.chars[index - 1] as string)) index -= 1;
  while (index > 0 && isWordChar(state.chars[index - 1] as string)) index -= 1;
  return { ...state, cursor: index };
};

export const moveWordRight = (state: EditorState): EditorState => {
  let index = state.cursor;
  while (index < state.chars.length && !isWordChar(state.chars[index] as string)) index += 1;
  while (index < state.chars.length && isWordChar(state.chars[index] as string)) index += 1;
  return { ...state, cursor: index };
};

export const deleteWordBack = (state: EditorState): EditorState => {
  const target = moveWordLeft(state).cursor;
  return {
    chars: [...state.chars.slice(0, target), ...state.chars.slice(state.cursor)],
    cursor: target,
  };
};

export const killToLineEnd = (state: EditorState): EditorState => {
  const end = lineEnd(state);
  // At a line end, Ctrl-K joins the next line.
  const stop = end === state.cursor && end < state.chars.length ? end + 1 : end;
  return {
    chars: [...state.chars.slice(0, state.cursor), ...state.chars.slice(stop)],
    cursor: state.cursor,
  };
};

export const killToLineStart = (state: EditorState): EditorState => {
  const start = lineStart(state);
  return {
    chars: [...state.chars.slice(0, start), ...state.chars.slice(state.cursor)],
    cursor: start,
  };
};

export interface InputLayout {
  readonly rows: ReadonlyArray<string>;
  readonly cursor: { readonly row: number; readonly col: number };
}

/**
 * Lays the buffer out in rows of at most `width` columns and finds the on-screen cursor cell. A wide
 * character that does not fit moves to the next row whole. The cursor may sit one column past the
 * last character, which is why callers pass `columns - 1 - prefixWidth`.
 */
export const layoutInput = (state: EditorState, width: number): InputLayout => {
  const limit = Math.max(2, width);
  const rows: string[] = [""];
  let col = 0;
  let cursor = { row: 0, col: 0 };
  for (let index = 0; index <= state.chars.length; index += 1) {
    const grapheme = state.chars[index];
    const w = grapheme === undefined || grapheme === "\n" ? 0 : graphemeWidth(grapheme);
    if (grapheme !== undefined && grapheme !== "\n" && col + w > limit) {
      rows.push("");
      col = 0;
    }
    if (index === state.cursor) cursor = { row: rows.length - 1, col };
    if (grapheme === undefined) break;
    if (grapheme === "\n") {
      rows.push("");
      col = 0;
      continue;
    }
    rows[rows.length - 1] += grapheme;
    col += w;
  }
  return { rows, cursor };
};

/** Cursor index for a target cell, used by Up/Down to keep the visual column. */
export const indexAtCell = (
  state: EditorState,
  width: number,
  target: { readonly row: number; readonly col: number },
): number => {
  const limit = Math.max(2, width);
  let row = 0;
  let col = 0;
  let best = 0;
  for (let index = 0; index <= state.chars.length; index += 1) {
    const grapheme = state.chars[index];
    const w = grapheme === undefined || grapheme === "\n" ? 0 : graphemeWidth(grapheme);
    if (grapheme !== undefined && grapheme !== "\n" && col + w > limit) {
      row += 1;
      col = 0;
    }
    if (row === target.row && col <= target.col) best = index;
    if (row > target.row) break;
    if (grapheme === undefined) break;
    if (grapheme === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    col += w;
  }
  return best;
};

/** Up/Down within the buffer; returns null when the cursor is already on the first/last row. */
export const moveVertical = (
  state: EditorState,
  width: number,
  direction: -1 | 1,
): EditorState | null => {
  const layout = layoutInput(state, width);
  const targetRow = layout.cursor.row + direction;
  if (targetRow < 0 || targetRow >= layout.rows.length) return null;
  return {
    ...state,
    cursor: indexAtCell(state, width, { row: targetRow, col: layout.cursor.col }),
  };
};
