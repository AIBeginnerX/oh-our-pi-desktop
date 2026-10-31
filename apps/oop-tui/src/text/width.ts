/**
 * Terminal display width. Korean text is the common case, so the unit of work is the grapheme
 * cluster (a Hangul syllable, or a jamo sequence that composes into one), not the code point.
 * Ambiguous-width characters count as 1, as most terminals draw them. The UI's own chrome (bars,
 * marks, tree lines) includes some of them, so a terminal set to draw ambiguous characters wide
 * misplaces those rows; `OOP_SYMBOLS=ascii` is the way out, since it draws ASCII chrome only.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

export const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
/* eslint-enable no-control-regex */

/**
 * Text that came from the server or an agent is untrusted. An escape sequence in it could move the
 * cursor, rewrite the title, or fake a prompt, so every control character except newline and tab is
 * dropped before display.
 */
export const sanitizeForTerminal = (value: string): string =>
  stripAnsi(value).replace(/\r\n?/gu, "\n").replace(/\t/gu, "  ").replace(CONTROL_CHARACTERS, "");

// eslint-disable-next-line no-control-regex
const SGR_SEQUENCE = /^\u001b\[[0-9;]*m$/u;

/**
 * The last line of defence before text reaches the terminal: everything is dropped except plain
 * characters and SGR styling (colors, bold), which is all this UI ever draws. A cursor move, a title
 * change, or an OSC 52 clipboard write in untrusted text never survives. Line feeds are not handled
 * here; callers split or flatten lines first.
 */
export const stripControlSequences = (line: string): string => {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(ANSI_PATTERN)) {
    out += line.slice(last, match.index).replace(CONTROL_CHARACTERS, "");
    if (SGR_SEQUENCE.test(match[0])) out += match[0];
    last = match.index + match[0].length;
  }
  return out + line.slice(last).replace(CONTROL_CHARACTERS, "");
};

const ASCII_PRINTABLE = /^[ -~]*$/u;

export const graphemesOf = (value: string): ReadonlyArray<string> =>
  ASCII_PRINTABLE.test(value)
    ? value.split("")
    : Array.from(segmenter.segment(value), (part) => part.segment);

const isWideCodePoint = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0x303e) ||
  (cp >= 0x3041 && cp <= 0x33ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xa000 && cp <= 0xa4cf) ||
  (cp >= 0xa960 && cp <= 0xa97f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe19) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f200 && cp <= 0x1f2ff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const TEXT_EMOJI_WITH_VS16 = /\p{Extended_Pictographic}️/u;
const REGIONAL_INDICATOR_PAIR = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const NONSPACING = /^[\p{Mn}\p{Me}\p{Cf}]/u;

export const graphemeWidth = (grapheme: string): 0 | 1 | 2 => {
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x7f) return 1;
  if (NONSPACING.test(grapheme)) return 0;
  if (isWideCodePoint(cp)) return 2;
  if (
    EMOJI_PRESENTATION.test(grapheme) ||
    TEXT_EMOJI_WITH_VS16.test(grapheme) ||
    REGIONAL_INDICATOR_PAIR.test(grapheme)
  ) {
    return 2;
  }
  return 1;
};

/** Display width of plain text (no ANSI). */
export const stringWidth = (value: string): number => {
  if (ASCII_PRINTABLE.test(value)) return value.length;
  let width = 0;
  for (const grapheme of graphemesOf(value)) width += graphemeWidth(grapheme);
  return width;
};

/** Display width of text that may contain ANSI styling. */
export const visibleWidth = (value: string): number => stringWidth(stripAnsi(value));
