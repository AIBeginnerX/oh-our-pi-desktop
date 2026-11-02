import { visibleWidth } from "../text/width.ts";
import { wrapStyled } from "../text/wrap.ts";
import type { Rail } from "./rail.ts";

/** Least width the text of a bubble gets, whatever the room. */
const MIN_INNER = 8;

/**
 * What the user said, as a rounded box against the right edge of a `width`-column conversation, so
 * it is told apart from the agent's text, which stays on the left. The box is as wide as its longest
 * row plus a border and a space on each side, and never wider than four fifths of the room, so a
 * long message wraps inside it. Widths are display widths: a Korean syllable takes two columns, and
 * every row of the box ends in the same column. The text and the border are always in the theme's
 * `userFg`, a hue of its own (not the brand's, not the body text's), at every colour depth. Where the
 * terminal can fill behind text the box also carries the `userBg` tint; where it cannot (16 colours, a
 * theme that leaves `userBg` at the terminal's own, NO_COLOR, the ASCII preset) the box's own border
 * is what sets the message apart, so a message is never shown without one. The Rust app draws the
 * same box (`apps/oop-tui-rs/src/transcript.rs`), and only the text cells of it are selectable.
 */
export const userBubble = (rail: Rail, text: string, width: number): string[] => {
  const { theme } = rail.style;
  const { box, rule } = rail.symbols;
  const filled = theme.fills("userBg");
  // A border and a space of padding on each side.
  const frame = 4;
  const most = Math.max(
    1,
    Math.min(width - frame, Math.max(MIN_INNER, Math.floor((width * 8) / 10) - frame)),
  );
  const rows = text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapStyled(line, most)))
    .map((row) => row.trimEnd());
  // Not `Math.max(...)`: a message of a few hundred thousand rows would overflow the call stack.
  const inner = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 1);
  const lead = " ".repeat(Math.max(0, width - inner - frame));
  const ink = (body: string): string =>
    filled ? theme.bg("userBg", theme.userFg(body)) : theme.userFg(body);
  const edge = (left: string, right: string): string =>
    `${lead}${ink(`${left}${rule.repeat(inner + 2)}${right}`)}`;
  return [
    edge(box.topLeft, box.topRight),
    ...rows.map((row) => {
      const fill = " ".repeat(Math.max(0, inner - visibleWidth(row)));
      return `${lead}${ink(`${box.vertical} ${row}${fill} ${box.vertical}`)}`;
    }),
    edge(box.bottomLeft, box.bottomRight),
  ];
};
