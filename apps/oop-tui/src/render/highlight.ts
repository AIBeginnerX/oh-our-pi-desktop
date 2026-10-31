import { graphemeWidth, graphemesOf } from "../text/width.ts";

/** Which theme colour paints a piece of code; plain text has no kind. */
export type TokenKind = "keyword" | "string" | "comment" | "number";

export interface Segment {
  readonly text: string;
  readonly kind?: TokenKind;
}

/** A piece of a line carrying whatever else the caller tags it with (a code token, a changed word). */
export interface Piece {
  readonly text: string;
}

/** Highlighting is regular-expression work per line; a line longer than this stays plain. */
const HIGHLIGHT_LINE_LIMIT = 1000;

interface Language {
  readonly keywords: ReadonlySet<string>;
  readonly lineComment?: string;
  /** A `#` comment starts only at a word boundary, so `$#` and `${#x}` in shell stay code. */
  readonly commentNeedsSpace?: boolean;
  readonly blockComment?: boolean;
  readonly quotes: string;
  /** A string that may continue on the next line, with the delimiter that ends it. */
  readonly multiline?: ReadonlyArray<string>;
  /** `'` starts a character only when it closes right after one character (Rust lifetimes are code). */
  readonly charQuote?: boolean;
  /** A string followed by `:` is a key and is painted like a keyword. */
  readonly keys?: boolean;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/u));

const SCRIPT: Language = {
  keywords: words(
    `async await break case catch class const continue debugger default delete do else enum export
    extends false finally for from function if implements import in instanceof interface let new
    null of private protected public readonly return static super switch this throw true try type
    typeof undefined var void while with yield as declare namespace abstract satisfies keyof`,
  ),
  lineComment: "//",
  blockComment: true,
  quotes: "\"'`",
  multiline: ["`"],
};

const PYTHON: Language = {
  keywords: words(
    `and as assert async await break class continue def del elif else except False finally for from
    global if import in is lambda None nonlocal not or pass raise return True try while with yield
    match case`,
  ),
  lineComment: "#",
  quotes: "\"'",
  multiline: ['"""', "'''"],
};

const SHELL: Language = {
  keywords: words(
    `if then else elif fi for while until do done case esac in function select export local readonly
    return exit break continue`,
  ),
  lineComment: "#",
  commentNeedsSpace: true,
  quotes: "\"'",
};

const JSON_LANGUAGE: Language = {
  keywords: words("true false null"),
  quotes: '"',
  keys: true,
};

const GO: Language = {
  keywords: words(
    `break case chan const continue default defer else fallthrough for func go goto if import
    interface map package range return select struct switch type var true false nil iota`,
  ),
  lineComment: "//",
  blockComment: true,
  quotes: "\"'`",
  multiline: ["`"],
};

const RUST: Language = {
  keywords: words(
    `as async await break const continue crate dyn else enum extern false fn for if impl in let loop
    match mod move mut pub ref return self Self static struct super trait true type unsafe use
    where while`,
  ),
  lineComment: "//",
  blockComment: true,
  quotes: "\"'",
  charQuote: true,
};

const LANGUAGES: ReadonlyMap<string, Language> = new Map([
  ...["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"].map(
    (name) => [name, SCRIPT] as const,
  ),
  ...["py", "python", "python3"].map((name) => [name, PYTHON] as const),
  ...["sh", "bash", "shell", "zsh"].map((name) => [name, SHELL] as const),
  ...["json", "jsonc"].map((name) => [name, JSON_LANGUAGE] as const),
  ...["go", "golang"].map((name) => [name, GO] as const),
  ...["rust", "rs"].map((name) => [name, RUST] as const),
]);

const NUMBER = /0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/uy;
const IDENTIFIER = /[A-Za-z_$][\w$]*/uy;
const CHARACTER = /'(?:\\.|[^\\'])'/uy;

const matchAt = (pattern: RegExp, text: string, index: number): string | null => {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0] ?? null;
};

/** Index just past the quote that closes the string opened at `start`; the line end when none does. */
const stringEnd = (line: string, start: number, quote: string): number => {
  let index = start + quote.length;
  while (index < line.length) {
    if (line[index] === "\\") index += 2;
    else if (line.startsWith(quote, index)) return index + quote.length;
    else index += 1;
  }
  return line.length;
};

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\w$]/u.test(character);

/**
 * A tokenizer for one language that keeps what a block comment or a multi-line string needs across
 * lines. `null` for a language it does not know: that code is shown plain. It reads complete lines
 * only, so a streaming reply never re-highlights what it already printed.
 */
export const makeHighlighter = (
  lang: string,
): ((line: string) => ReadonlyArray<Segment>) | null => {
  const language = LANGUAGES.get(lang.toLowerCase());
  if (language === undefined) return null;
  let open: { readonly close: string; readonly kind: TokenKind } | null = null;

  return (line) => {
    if (line.length > HIGHLIGHT_LINE_LIMIT) return [{ text: line }];
    const out: Segment[] = [];
    let plain = "";
    const flush = () => {
      if (plain !== "") out.push({ text: plain });
      plain = "";
    };
    const emit = (text: string, kind: TokenKind) => {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === kind) out[out.length - 1] = { text: last.text + text, kind };
      else out.push({ text, kind });
    };

    let index = 0;
    while (index < line.length) {
      if (open !== null) {
        const end = line.indexOf(open.close, index);
        const stop = end === -1 ? line.length : end + open.close.length;
        emit(line.slice(index, stop), open.kind);
        if (end !== -1) open = null;
        index = stop;
        continue;
      }
      const character = line[index] as string;

      if (
        language.lineComment !== undefined &&
        line.startsWith(language.lineComment, index) &&
        (language.commentNeedsSpace !== true || index === 0 || /\s/u.test(line[index - 1] ?? ""))
      ) {
        emit(line.slice(index), "comment");
        break;
      }
      if (language.blockComment === true && line.startsWith("/*", index)) {
        open = { close: "*/", kind: "comment" };
        emit("/*", "comment");
        index += 2;
        continue;
      }
      const multiline = language.multiline?.find((quote) => line.startsWith(quote, index));
      if (multiline !== undefined) {
        const end = line.indexOf(multiline, index + multiline.length);
        if (end === -1) {
          open = { close: multiline, kind: "string" };
          emit(line.slice(index), "string");
          break;
        }
        emit(line.slice(index, end + multiline.length), "string");
        index = end + multiline.length;
        continue;
      }
      if (language.quotes.includes(character)) {
        const isCharQuote = language.charQuote === true && character === "'";
        const literal = isCharQuote ? matchAt(CHARACTER, line, index) : null;
        if (!isCharQuote || literal !== null) {
          const end = literal !== null ? index + literal.length : stringEnd(line, index, character);
          const text = line.slice(index, end);
          const isKey = language.keys === true && /^\s*:/u.test(line.slice(end));
          emit(text, isKey ? "keyword" : "string");
          index = end;
          continue;
        }
      }
      if (/\d/u.test(character) && !isWordCharacter(line[index - 1])) {
        const number = matchAt(NUMBER, line, index);
        if (number !== null) {
          emit(number, "number");
          index += number.length;
          continue;
        }
      }
      const identifier = matchAt(IDENTIFIER, line, index);
      if (identifier !== null) {
        if (language.keywords.has(identifier)) emit(identifier, "keyword");
        else plain += identifier;
        index += identifier.length;
        continue;
      }
      plain += character;
      index += 1;
    }
    flush();
    return out;
  };
};

export interface WrappedRow<T extends Piece> {
  readonly pieces: ReadonlyArray<T>;
  /** Display columns the row takes. */
  readonly width: number;
}

/**
 * Cuts a line of pieces at exactly `width` columns. Code and diff lines must keep their columns, so
 * there is no break-at-space heuristic; a piece cut in two keeps its tag on both halves.
 */
export const wrapPieces = <T extends Piece>(
  pieces: ReadonlyArray<T>,
  width: number,
): WrappedRow<T>[] => {
  const limit = Math.max(1, width);
  const rows: WrappedRow<T>[] = [];
  let row: T[] = [];
  let used = 0;
  for (const piece of pieces) {
    let text = "";
    const closePiece = () => {
      if (text !== "") row.push({ ...piece, text });
      text = "";
    };
    for (const grapheme of graphemesOf(piece.text)) {
      const columns = graphemeWidth(grapheme);
      if (used + columns > limit && used > 0) {
        closePiece();
        rows.push({ pieces: row, width: used });
        row = [];
        used = 0;
      }
      text += grapheme;
      used += columns;
    }
    closePiece();
  }
  rows.push({ pieces: row, width: used });
  return rows;
};
