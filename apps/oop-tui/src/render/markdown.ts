import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { padEndVisible, truncateStyled, wrapStyled, wrapWithPrefix } from "../text/wrap.ts";
import { DiffStream } from "./diff.ts";
import { makeHighlighter, type Segment, wrapPieces } from "./highlight.ts";
import { RAIL_COLUMNS, railGap, railRow, type Rail } from "./rail.ts";
import type { Style } from "./style.ts";
import { type Symbols, UNICODE_SYMBOLS } from "./symbols.ts";

/** Blocks the desktop app draws as graphics. A terminal shows a short marker, never the source. */
const VISUAL_BLOCKS: ReadonlyMap<string, string> = new Map([
  ["chart", "차트"],
  ["mermaid", "mermaid 다이어그램"],
]);

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/u;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
// No two optional whitespace runs touch, so a long run of blanks cannot be split between them.
const TABLE_SEPARATOR = /^\s*(?:\|\s*)?:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)*(?:\s*\|)?\s*$/u;

/**
 * The block patterns above may scan a line more than once, so a line longer than this is never
 * tested against them: it is a paragraph (or, inside a fence, code) whatever it starts with.
 */
const BLOCK_LINE_LIMIT = 4000;

const INLINE =
  /(`{1,6})([\s\S]{0,400}?[^`])\1(?!`)|\*\*([^\s*][\s\S]*?)\*\*|__([^\s_][\s\S]*?)__|~~([\s\S]+?)~~|!\[([^\]]*)\]\(([^)\s]+)(?:\s[^)]*)?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s[^)]*)?\)|\*([^\s*][^*]*?)\*|(?<![\p{L}\p{N}_])_([^\s_][^_]*?)_(?![\p{L}\p{N}_])/gu;

/**
 * Every inline pattern may scan to the end of its input from each possible start, so the work grows
 * with the square of the line. A model can write one very long line, so such a line is rendered in
 * pieces; a span that crosses a piece boundary stays as plain text.
 */
const INLINE_LIMIT = 1000;

const inlinePieces = (text: string): string[] => {
  const pieces: string[] = [];
  let start = 0;
  while (text.length - start > INLINE_LIMIT) {
    const window = text.slice(start, start + INLINE_LIMIT);
    let cut = window.lastIndexOf(" ") + 1;
    if (cut === 0) {
      cut = INLINE_LIMIT;
      const code = window.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    pieces.push(text.slice(start, start + cut));
    start += cut;
  }
  pieces.push(text.slice(start));
  return pieces;
};

const identity = (text: string): string => text;

/**
 * Inline Markdown as styled text. `base` paints the plain text between spans (a heading's colour,
 * a quote's), so a code span inside it does not leave the rest of the line unpainted.
 */
export const renderInline = (text: string, style: Style, base = identity): string => {
  if (text.length > INLINE_LIMIT) {
    return inlinePieces(text)
      .map((piece) => renderInline(piece, style, base))
      .join("");
  }
  const { theme } = style;
  let out = "";
  let last = 0;
  // matchAll clones the regex: the recursive calls below must not disturb this loop's position.
  for (const match of text.matchAll(INLINE)) {
    out += base(text.slice(last, match.index));
    const [, ticks, code, bold, bold2, strike, imageAlt, , linkText, linkUrl, italic, italic2] =
      match;
    if (ticks !== undefined && code !== undefined) out += theme.accent(code);
    else if (bold !== undefined) out += style.bold(renderInline(bold, style, base));
    else if (bold2 !== undefined) out += style.bold(renderInline(bold2, style, base));
    else if (strike !== undefined) out += style.strike(renderInline(strike, style, base));
    else if (imageAlt !== undefined) out += theme.dim(`[image: ${imageAlt || "-"}]`);
    else if (linkText !== undefined && linkUrl !== undefined) {
      out += `${theme.info.underline(renderInline(linkText, style))} ${theme.dim(`(${linkUrl})`)}`;
    } else if (italic !== undefined) out += style.italic(renderInline(italic, style, base));
    else if (italic2 !== undefined) out += style.italic(renderInline(italic2, style, base));
    last = match.index + match[0].length;
  }
  return out + base(text.slice(last));
};

const splitCells = (row: string): string[] => {
  const trimmed = row.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim().replace(/\\\|/gu, "|"));
};

export interface MarkdownOptions {
  /** The whole terminal width. Code and diffs use all of it; with `railed`, text keeps the rail's share out. */
  readonly width: number;
  readonly style: Style;
  readonly symbols?: Symbols;
  /**
   * Hangs the text off the transcript rail (`│  text`, a blank line as a bare `│`). Code blocks and
   * diffs break out of it and start at column 0, joined to the text around them by one `│` row, so
   * copying them from the terminal takes no rail along.
   */
  readonly railed?: boolean;
}

/** The fence being read: how to draw each line of it, until the closing fence. */
interface OpenFence {
  readonly marker: string;
  readonly lang: string;
  lines: number;
  readonly highlight: ((line: string) => ReadonlyArray<Segment>) | null;
  readonly diff: DiffStream | null;
}

const DIFF_LANGUAGES: ReadonlySet<string> = new Set(["diff", "patch"]);

/**
 * Renders Markdown one source line at a time, so a streaming reply can be committed to the terminal
 * as soon as each line is complete. Only fenced blocks and tables need memory across lines.
 */
export class MarkdownStream {
  private fence: OpenFence | null = null;
  private table: string[] = [];
  /** Railed only: whether the last row written was a bare `│` (a stream starts as if it were). */
  private lastGap = true;
  /** Railed only: a bare `│` is owed before the next row, from a blank line or a code block that ended. */
  private owed = false;

  private readonly options: MarkdownOptions;
  private readonly rail: Rail;

  constructor(options: MarkdownOptions) {
    this.options = options;
    this.rail = { style: options.style, symbols: options.symbols ?? UNICODE_SYMBOLS };
  }

  /** The width of a text row: what is left of the line after the rail. */
  private get textWidth(): number {
    return this.options.railed === true
      ? Math.max(1, this.options.width - RAIL_COLUMNS)
      : this.options.width;
  }

  /** Whether the next row written is a code or diff row, which the rail does not carry. */
  get inCode(): boolean {
    return this.fence !== null && !VISUAL_BLOCKS.has(this.fence.lang);
  }

  /** Whether the next text row starts with a bare `│` that the caller has not seen yet. */
  get gapDue(): boolean {
    return this.options.railed === true && this.owed;
  }

  /**
   * Text rows onto the rail. A blank line is a bare `│` only once a row follows it, so a reply never
   * ends on one and two blanks in a row are one.
   */
  private textRows(rows: ReadonlyArray<string>): string[] {
    if (this.options.railed !== true) return [...rows];
    const out: string[] = [];
    for (const row of rows) {
      if (row === "") {
        if (!this.lastGap) this.owed = true;
        continue;
      }
      if (this.owed) out.push(railGap(this.rail));
      out.push(railRow(this.rail, row));
      this.lastGap = false;
      this.owed = false;
    }
    return out;
  }

  /** The first row of a code or diff block, set off from the text before it. */
  private openBlock(header: string): string[] {
    if (this.options.railed !== true) return [header];
    const lead = this.lastGap ? [] : [railGap(this.rail)];
    this.lastGap = false;
    this.owed = false;
    return [...lead, header];
  }

  private blockRows(rows: string[]): string[] {
    if (rows.length > 0) this.lastGap = false;
    return rows;
  }

  private closeBlock(rows: string[]): string[] {
    this.lastGap = false;
    this.owed = true;
    return rows;
  }

  /** `raw` is one source line; a carriage return inside it still ends a row. */
  pushLine(raw: string): string[] {
    return sanitizeForTerminal(raw)
      .split("\n")
      .flatMap((line) => this.pushCleanLine(line));
  }

  private pushCleanLine(line: string): string[] {
    const { style } = this.options;

    const oversized = line.length > BLOCK_LINE_LIMIT;

    if (this.fence) {
      const closing = oversized ? null : FENCE.exec(line);
      if (
        closing &&
        (closing[2] ?? "").startsWith(this.fence.marker[0] as string) &&
        (closing[2] ?? "").length >= this.fence.marker.length &&
        line.trim() === (closing[2] ?? "")
      ) {
        const done = this.fence;
        this.fence = null;
        return this.closeFence(done);
      }
      this.fence.lines += 1;
      if (VISUAL_BLOCKS.has(this.fence.lang)) return [];
      if (this.fence.diff) return this.blockRows(this.fence.diff.push(line));
      return this.blockRows(this.codeRows(line, this.fence.highlight));
    }

    if (!oversized && TABLE_ROW.test(line)) {
      this.table.push(line);
      return [];
    }
    const out = this.textRows(this.flushTable());
    if (oversized) {
      return [...out, ...this.textRows(wrapStyled(renderInline(line, style), this.textWidth))];
    }

    const opening = FENCE.exec(line);
    if (opening) {
      const lang = (opening[3] ?? "").toLowerCase();
      this.fence = {
        marker: opening[2] as string,
        lang,
        lines: 0,
        highlight: makeHighlighter(lang),
        diff: DIFF_LANGUAGES.has(lang)
          ? new DiffStream({ width: Math.max(8, this.options.width), style })
          : null,
      };
      if (VISUAL_BLOCKS.has(lang)) return out;
      return [...out, ...this.openBlock(this.blockHeader(lang || "code"))];
    }

    return [...out, ...this.textRows(this.renderBlock(line))];
  }

  /** Ends the message: an unclosed fence or buffered table is written out rather than lost. */
  finish(): string[] {
    const out = this.textRows(this.flushTable());
    if (this.fence) {
      const done = this.fence;
      this.fence = null;
      out.push(...this.closeFence(done));
    }
    return out;
  }

  private closeFence(fence: OpenFence): string[] {
    const { theme } = this.options.style;
    const label = VISUAL_BLOCKS.get(fence.lang);
    if (label !== undefined) {
      const note = theme.dim(
        `[${label} ${fence.lines}줄 - 데스크톱 앱에서 볼 수 있으며 터미널에는 그리지 않습니다]`,
      );
      return this.options.railed === true ? this.textRows([note]) : [`  ${note}`];
    }
    return this.closeBlock(fence.diff ? fence.diff.finish() : []);
  }

  /** The dim language line over a code block, on the code background where the terminal has one. */
  private blockHeader(label: string): string {
    const { theme } = this.options.style;
    const inner = Math.max(1, this.options.width);
    const text = theme.dim(truncateStyled(label, inner - 2));
    if (!theme.supportsBackground) return text;
    return theme.bg("codeBg", padEndVisible(` ${text}`, inner));
  }

  /** One line of code as rows: highlighted, cut at the block width, never reflowed at spaces. */
  private codeRows(line: string, highlight: OpenFence["highlight"]): string[] {
    const { theme } = this.options.style;
    const symbols = this.options.symbols ?? UNICODE_SYMBOLS;
    // Without a background, the missing rail is what sets code apart, so a railed one has no gutter.
    const gutter = !theme.supportsBackground && this.options.railed !== true;
    const inner = Math.max(8, this.options.width - (theme.supportsBackground || gutter ? 2 : 0));
    const segments: ReadonlyArray<Segment> = highlight ? highlight(line) : [{ text: line }];
    return wrapPieces(segments, inner).map((row) => {
      const body = row.pieces
        .map((piece) => (piece.kind === undefined ? piece.text : theme[piece.kind](piece.text)))
        .join("");
      if (!theme.supportsBackground) {
        return gutter ? `${theme.dim(symbols.tree.pipe)} ${body}` : body;
      }
      return theme.bg("codeBg", ` ${body}${" ".repeat(inner - row.width + 1)}`);
    });
  }

  private renderBlock(line: string): string[] {
    const { style } = this.options;
    const width = this.textWidth;
    const { theme } = style;
    const symbols = this.options.symbols ?? UNICODE_SYMBOLS;
    if (line.trim() === "") return [""];

    const heading = HEADING.exec(line);
    if (heading) {
      return wrapStyled(renderInline(heading[2] as string, style, theme.brand.bold), width);
    }
    if (RULE.test(line)) return [theme.dim(symbols.rule.repeat(Math.min(width, 40)))];

    const quote = QUOTE.exec(line);
    if (quote) {
      const bar = `${theme.muted(symbols.tree.pipe)} `;
      return wrapWithPrefix(renderInline(quote[1] as string, style, theme.muted), width, bar, bar);
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = " ".repeat(Math.min(12, (item[1] as string).length));
      const marker = /^\d/u.test(item[2] as string) ? (item[2] as string) : "-";
      return wrapWithPrefix(
        renderInline(item[3] as string, style),
        width,
        `${indent}${theme.accent(marker)} `,
        `${indent}${" ".repeat(visibleWidth(marker) + 1)}`,
      );
    }

    return wrapStyled(renderInline(line, style), width);
  }

  private flushTable(): string[] {
    if (this.table.length === 0) return [];
    const rows = this.table;
    this.table = [];
    const { style } = this.options;
    const width = this.textWidth;
    const { theme } = style;
    const body = rows.filter((row) => !TABLE_SEPARATOR.test(row)).map(splitCells);
    const hasHeader = rows.length > 1 && TABLE_SEPARATOR.test(rows[1] as string);
    // Plain loops: spreading a table of a few hundred thousand rows into Math.max overflows the stack.
    let columns = 0;
    for (const cells of body) columns = Math.max(columns, cells.length);
    const widths = Array.from({ length: columns }, () => 0);
    for (const cells of body) {
      for (let column = 0; column < columns; column += 1) {
        widths[column] = Math.max(
          widths[column] as number,
          visibleWidth(renderInline(cells[column] ?? "", style)),
        );
      }
    }
    const total = widths.reduce((sum, w) => sum + w, 0) + 3 * (columns - 1);
    if (total > width) {
      // Too wide to align: keep every cell, one row per line.
      return rows
        .filter((row) => !TABLE_SEPARATOR.test(row))
        .flatMap((row) => wrapStyled(theme.dim(row.trim()), width));
    }
    const out: string[] = [];
    body.forEach((cells, rowIndex) => {
      const text = widths
        .map((w, column) => padEndVisible(renderInline(cells[column] ?? "", style), w))
        .join(` ${theme.dim("|")} `);
      out.push(hasHeader && rowIndex === 0 ? style.bold(text) : text);
      if (hasHeader && rowIndex === 0) {
        out.push(theme.dim(widths.map((w) => "-".repeat(w)).join("-+-")));
      }
    });
    return out;
  }
}

export const renderMarkdown = (text: string, options: MarkdownOptions): string[] => {
  const stream = new MarkdownStream(options);
  const rows = sanitizeForTerminal(text)
    .split("\n")
    .flatMap((line) => stream.pushLine(line));
  return [...rows, ...stream.finish()];
};
