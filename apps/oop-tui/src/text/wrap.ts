import { graphemeWidth, graphemesOf, visibleWidth } from "./width.ts";

const RESET = "\u001b[0m";
// eslint-disable-next-line no-control-regex
const ANSI_TOKEN = /\u001b\[[0-?]*[ -/]*[@-~]/uy;

type Token =
  | { readonly kind: "ansi"; readonly text: string }
  | { readonly kind: "glyph"; readonly text: string; readonly width: number };

const tokenize = (value: string): ReadonlyArray<Token> => {
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain.length === 0) return;
    for (const glyph of graphemesOf(plain)) {
      tokens.push({ kind: "glyph", text: glyph, width: graphemeWidth(glyph) });
    }
    plain = "";
  };
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === 0x1b) {
      ANSI_TOKEN.lastIndex = index;
      const match = ANSI_TOKEN.exec(value);
      if (match) {
        flush();
        tokens.push({ kind: "ansi", text: match[0] });
        index += match[0].length;
        continue;
      }
    }
    plain += value[index];
    index += 1;
  }
  flush();
  return tokens;
};

// eslint-disable-next-line no-control-regex
const SGR = /^\u001b\[([0-9;]*)m$/u;

const firstParam = (sequence: string): number => {
  const params = SGR.exec(sequence)?.[1] ?? "";
  return params === "" ? 0 : Number.parseInt(params.split(";")[0] ?? "0", 10);
};

/** Which opening code each closing code ends, matching the pairs in render/style.ts. */
const CLOSES: Record<number, (open: number) => boolean> = {
  22: (open) => open === 1 || open === 2,
  23: (open) => open === 3,
  24: (open) => open === 4,
  27: (open) => open === 7,
  29: (open) => open === 9,
  39: (open) => (open >= 30 && open <= 38) || (open >= 90 && open <= 97),
  49: (open) => (open >= 40 && open <= 48) || (open >= 100 && open <= 107),
};

/** The styles still in effect after `sequence`; non-SGR sequences change nothing. */
const applySgr = (active: ReadonlyArray<string>, sequence: string): string[] => {
  if (!SGR.test(sequence)) return [...active];
  const code = firstParam(sequence);
  if (code === 0) return [];
  const closes = CLOSES[code];
  if (closes) return active.filter((open) => !closes(firstParam(open)));
  return [...active, sequence];
};

/**
 * Wraps text to `width` display columns; a line feed always starts a new row. Breaks at the last space that fits and falls
 * back to a grapheme boundary for long unbroken runs (CJK text, URLs). Styles in effect at a break
 * are closed at the end of that row and reopened on the next, so rows can be printed independently.
 */
export const wrapStyled = (value: string, width: number): string[] => {
  const limit = Math.max(1, width);
  const tokens = tokenize(value);
  const rows: string[] = [];
  let active: string[] = [];
  let row: Token[] = [];
  let rowWidth = 0;
  let lastSpace = -1;

  const closeRow = (tokensOfRow: ReadonlyArray<Token>, opening: ReadonlyArray<string>): string => {
    let text = opening.join("");
    let styles = [...opening];
    for (const token of tokensOfRow) {
      text += token.text;
      if (token.kind === "ansi") styles = applySgr(styles, token.text);
    }
    return styles.length > 0 ? text + RESET : text;
  };

  const stylesAfter = (tokensOfRow: ReadonlyArray<Token>, start: ReadonlyArray<string>) => {
    let styles = [...start];
    for (const token of tokensOfRow) {
      if (token.kind === "ansi") styles = applySgr(styles, token.text);
    }
    return styles;
  };

  const push = (tokensOfRow: ReadonlyArray<Token>) => {
    let end = tokensOfRow.length;
    while (end > 0) {
      const last = tokensOfRow[end - 1];
      if (last && last.kind === "glyph" && last.text === " ") end -= 1;
      else break;
    }
    const trimmed = tokensOfRow.slice(0, end);
    rows.push(closeRow(trimmed, active));
    active = stylesAfter(tokensOfRow, active);
  };

  for (const token of tokens) {
    if (token.kind === "ansi") {
      row.push(token);
      continue;
    }
    if (token.text === "\n" || token.text === "\r\n") {
      push(row);
      row = [];
      rowWidth = 0;
      lastSpace = -1;
      continue;
    }
    if (token.width > 0 && rowWidth + token.width > limit) {
      if (lastSpace > 0) {
        const head = row.slice(0, lastSpace);
        const tail = row.slice(lastSpace + 1);
        push(head);
        row = [...tail];
        rowWidth = row.reduce((sum, t) => sum + (t.kind === "glyph" ? t.width : 0), 0);
      } else {
        push(row);
        row = [];
        rowWidth = 0;
      }
      lastSpace = -1;
      // A row that starts with the carried tail may contain a space again.
      row.forEach((t, i) => {
        if (t.kind === "glyph" && t.text === " ") lastSpace = i;
      });
      if (token.text === " " && row.length === 0) continue;
    }
    if (token.text === " ") lastSpace = row.length;
    row.push(token);
    rowWidth += token.width;
  }
  push(row);
  return rows;
};

/** Wraps `value` and prefixes the first row with `first` and the rest with `rest`. */
export const wrapWithPrefix = (
  value: string,
  width: number,
  first: string,
  rest: string,
): string[] => {
  const prefixWidth = Math.max(visibleWidth(first), visibleWidth(rest));
  const rows = wrapStyled(value, Math.max(1, width - prefixWidth));
  return rows.map((row, index) => (index === 0 ? first : rest) + row);
};

/** Cuts a styled line to `width` columns, adding an ellipsis marker when something was dropped. */
export const truncateStyled = (value: string, width: number): string => {
  if (visibleWidth(value) <= width) return value;
  const limit = Math.max(0, width - 1);
  let out = "";
  let used = 0;
  let styles: string[] = [];
  for (const token of tokenize(value)) {
    if (token.kind === "ansi") {
      out += token.text;
      styles = applySgr(styles, token.text);
      continue;
    }
    if (used + token.width > limit) break;
    out += token.text;
    used += token.width;
  }
  return `${out}${styles.length > 0 ? RESET : ""}~`;
};

export const padEndVisible = (value: string, width: number): string => {
  const missing = width - visibleWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
};
