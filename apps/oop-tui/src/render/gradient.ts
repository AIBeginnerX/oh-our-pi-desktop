import { type Color, type ColorLevel, colorCodes, type Rgb } from "./color.ts";
import { graphemesOf } from "../text/width.ts";

const lerp = (from: number, to: number, fraction: number): number =>
  Math.round(from + (to - from) * fraction);

const isRgb = (color: Color): color is Color & { kind: "rgb" } => color.kind === "rgb";

/** Where `position` lands once the gradient slides: past either end it reflects instead of jumping. */
const reflect = (position: number): number => {
  const folded = ((position % 2) + 2) % 2;
  return folded <= 1 ? folded : 2 - folded;
};

const colorAt = (stops: ReadonlyArray<Color>, at: number): Color => {
  const last = stops.length - 1;
  const scaled = at * last;
  const index = Math.min(last, Math.floor(scaled));
  const from = stops[index] as Color;
  if (index === last || !isRgb(from)) return from;
  const to = stops[index + 1] as Color;
  if (!isRgb(to)) return from;
  const fraction = scaled - index;
  const mixed: Rgb = {
    r: lerp(from.r, to.r, fraction),
    g: lerp(from.g, to.g, fraction),
    b: lerp(from.b, to.b, fraction),
  };
  return { kind: "rgb", ...mixed };
};

/**
 * `text` painted left to right through `stops`. Truecolor and 256-colour terminals get a smooth blend
 * (the 256 palette lowers each step to its nearest slot). A 16-colour terminal gets the first stop as
 * one flat colour, and a terminal without colour gets the text untouched. Stops that are not rgb
 * (an `ansi` theme) are stepped through, never blended, so a 16-colour theme stays 16-colour.
 *
 * `phase` slides the blend along the text (0 = as authored), which is how a spinner can drift its
 * colour a little each frame. `text` must be plain; whitespace never opens or closes a colour.
 */
export const gradientText = (
  text: string,
  stops: ReadonlyArray<Color>,
  level: ColorLevel,
  phase = 0,
): string => {
  const first = stops[0];
  if (level === 0 || first === undefined || text === "") return text;
  if (level === 1 || stops.length === 1) {
    const flat = colorCodes(first, level);
    return flat === null ? text : `\u001b[${flat}m${text}\u001b[39m`;
  }
  const graphemes = graphemesOf(text);
  const span = Math.max(1, graphemes.length - 1);
  let out = "";
  let current: string | null = null;
  graphemes.forEach((grapheme, index) => {
    if (grapheme.trim() !== "") {
      const codes = colorCodes(colorAt(stops, reflect(index / span + phase)), level);
      if (codes !== current) {
        out += codes === null ? "\u001b[39m" : `\u001b[${codes}m`;
        current = codes;
      }
    }
    out += grapheme;
  });
  return current === null ? out : `${out}\u001b[39m`;
};
