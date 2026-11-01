import { visibleWidth } from "../text/width.ts";
import { padEndVisible, wrapStyled } from "../text/wrap.ts";
import type { Rail } from "./rail.ts";

/** Least width the text of a bubble gets, whatever the room. */
const MIN_INNER = 8;

/**
 * What the user said, as a block against the right edge of a `width`-column conversation, so it is
 * told apart from the agent's text, which stays on the left. The block is as wide as its longest row
 * (padding included) and never wider than four fifths of the room, so a long message wraps inside
 * it. Widths are display widths: a Korean syllable takes two columns, and every row of the block ends
 * in the same column. On a terminal that can fill behind text the block carries the theme's `userBg`
 * tint; where it cannot (16 colours, NO_COLOR, the ASCII preset) the text is in the brand colour and
 * a bar closes each row on the right, so the block is still told apart without any colour.
 */
export const userBubble = (rail: Rail, text: string, width: number): string[] => {
  const { theme } = rail.style;
  const filled = theme.supportsBackground;
  // One column of padding on each side of the text, and the bar when there is no fill.
  const frame = filled ? 2 : 3;
  const most = Math.max(
    1,
    Math.min(width - frame, Math.max(MIN_INNER, Math.floor(width * 0.8) - frame)),
  );
  const rows = text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapStyled(line, most)))
    .map((row) => row.trimEnd());
  // Not `Math.max(...)`: a message of a few hundred thousand rows would overflow the call stack.
  const inner = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 1);
  const lead = " ".repeat(Math.max(0, width - inner - frame));
  return rows.map((row) => {
    const body = padEndVisible(row, inner);
    return filled
      ? `${lead}${theme.bg("userBg", ` ${body} `, "brand")}`
      : `${lead}${theme.brand(` ${body} `)}${theme.brand(rail.symbols.rail.bar)}`;
  });
};
