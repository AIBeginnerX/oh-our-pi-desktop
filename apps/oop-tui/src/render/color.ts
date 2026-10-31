/**
 * Colour values and how they are written for a terminal of a given ability. Nothing here knows about
 * themes: `theme.ts` decides which colour means what, this decides what bytes a colour becomes.
 */

/** 0 = no colour, 1 = the 16 ANSI colours, 2 = the 256-colour palette, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export type Color =
  /** The terminal's own foreground or background: no escape is written. */
  | { readonly kind: "default" }
  /** One of the 16 ANSI colours, 0-7 normal and 8-15 bright. */
  | { readonly kind: "ansi"; readonly index: number }
  /** A slot of the 256-colour palette. */
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export type Rgb = Pick<Extract<Color, { kind: "rgb" }>, "r" | "g" | "b">;

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** How a typical terminal paints the 16 colours; only used to pick the nearest one, never emitted. */
const ANSI_RGB: ReadonlyArray<Rgb> = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;
const HEX_COLOR = /^#([0-9a-f]{6})$/iu;

/** `#rrggbb`, an integer 0-255 (256-colour palette), a 16-colour name, or "default". Else null. */
export const parseColor = (value: unknown): Color | null => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255
      ? { kind: "indexed", index: value }
      : null;
  }
  if (typeof value !== "string") return null;
  if (value === "default") return { kind: "default" };
  const hex = HEX_COLOR.exec(value);
  if (hex !== null) {
    const packed = Number.parseInt(hex[1] as string, 16);
    return { kind: "rgb", r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
  }
  const index = (ANSI_NAMES as ReadonlyArray<string>).indexOf(value);
  return index === -1 ? null : { kind: "ansi", index };
};

const cubeRgb = (index: number): Rgb => {
  const offset = index - 16;
  return {
    r: CUBE_STEPS[Math.floor(offset / 36)] as number,
    g: CUBE_STEPS[Math.floor(offset / 6) % 6] as number,
    b: CUBE_STEPS[offset % 6] as number,
  };
};

export const indexedToRgb = (index: number): Rgb => {
  if (index < 16) return ANSI_RGB[index] as Rgb;
  if (index < 232) return cubeRgb(index);
  const level = 8 + (index - 232) * 10;
  return { r: level, g: level, b: level };
};

/** Squared distance weighted for how the eye sees it ("redmean"), so greys do not drift to hues. */
const distance = (a: Rgb, b: Rgb): number => {
  const mean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
};

/** The nearest of `candidates` (indices into the 16); the lowest index wins a tie so the answer never varies. */
const nearestAnsi = (rgb: Rgb, candidates: ReadonlyArray<number>): number => {
  let best = candidates[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of candidates) {
    const d = distance(rgb, ANSI_RGB[index] as Rgb);
    if (d < bestDistance) {
      best = index;
      bestDistance = d;
    }
  }
  return best;
};

const ALL_ANSI: ReadonlyArray<number> = ANSI_RGB.map((_, index) => index);

/** Red, yellow, green, cyan, blue, magenta: the 16 colours' hues, 60 degrees apart, as normal indices. */
const HUE_ANSI = [1, 3, 2, 6, 4, 5] as const;

/**
 * The 16 colours cover few hues, so a distance in RGB is a poor judge for a coloured pixel: a soft
 * red lands on grey and a soft green on cyan. A colour with any saturation takes the nearest hue
 * (then the normal or bright form of it, by distance); only greys, white and near-black are matched
 * by distance. The lowest index wins a tie so the answer never varies.
 */
export const rgbToAnsi16 = (rgb: Rgb): number => {
  const high = Math.max(rgb.r, rgb.g, rgb.b);
  const chroma = high - Math.min(rgb.r, rgb.g, rgb.b);
  if (high < 64 || chroma < 0.25 * high) return nearestAnsi(rgb, ALL_ANSI);
  const degrees =
    high === rgb.r
      ? ((rgb.g - rgb.b) / chroma + 6) % 6
      : high === rgb.g
        ? (rgb.b - rgb.r) / chroma + 2
        : (rgb.r - rgb.g) / chroma + 4;
  const normal = HUE_ANSI[Math.round(degrees) % 6] as number;
  return nearestAnsi(rgb, [normal, normal + 8]);
};

const nearestCubeStep = (channel: number): number => {
  let best = 0;
  for (let step = 1; step < CUBE_STEPS.length; step += 1) {
    if (
      Math.abs((CUBE_STEPS[step] as number) - channel) <
      Math.abs((CUBE_STEPS[best] as number) - channel)
    ) {
      best = step;
    }
  }
  return best;
};

/** The nearest slot of the 6x6x6 cube or the 24-step grey ramp (never the first 16 slots). */
export const rgbToIndexed = (rgb: Rgb): number => {
  const cube =
    16 + 36 * nearestCubeStep(rgb.r) + 6 * nearestCubeStep(rgb.g) + nearestCubeStep(rgb.b);
  const average = (rgb.r + rgb.g + rgb.b) / 3;
  const ramp = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
  const grey = 232 + ramp;
  return distance(rgb, indexedToRgb(grey)) < distance(rgb, indexedToRgb(cube)) ? grey : cube;
};

export const colorToRgb = (color: Color): Rgb | null => {
  switch (color.kind) {
    case "default":
      return null;
    case "ansi":
    case "indexed":
      return indexedToRgb(color.index);
    case "rgb":
      return color;
  }
};

const ansiCode = (index: number, background: boolean): string =>
  String((index < 8 ? (background ? 40 : 30) : background ? 92 : 82) + index);

/**
 * The SGR parameters that paint `color` on a terminal of `level`, or null for no escape at all.
 * Colours are lowered, never raised: an `ansi` colour stays one of the 16 at every level.
 */
export const colorCodes = (color: Color, level: ColorLevel, background = false): string | null => {
  if (level === 0 || color.kind === "default") return null;
  const lead = background ? 48 : 38;
  switch (color.kind) {
    case "ansi":
      return ansiCode(color.index, background);
    case "indexed":
      if (level >= 2 && color.index >= 16) return `${lead};5;${color.index}`;
      return ansiCode(
        color.index < 16 ? color.index : rgbToAnsi16(indexedToRgb(color.index)),
        background,
      );
    case "rgb":
      if (level === 3) return `${lead};2;${color.r};${color.g};${color.b}`;
      if (level === 2) return `${lead};5;${rgbToIndexed(color)}`;
      return ansiCode(rgbToAnsi16(color), background);
  }
};

/**
 * Which colour level a terminal supports, from its environment. The first rule that applies wins:
 * FORCE_COLOR (0-3; empty or anything else counts as unset), NO_COLOR and TERM=dumb, a stream that
 * is not a terminal, COLORTERM, Windows Terminal, a `256color` TERM, else 16 colours.
 * tmux and screen follow the same rules; they pass COLORTERM through or set a `-256color` TERM.
 */
export const detectColorLevel = (env: NodeJS.ProcessEnv, isTty: boolean): ColorLevel => {
  const forced = env.FORCE_COLOR?.trim();
  if (forced === "0") return 0;
  if (forced === "1") return 1;
  if (forced === "2") return 2;
  if (forced === "3") return 3;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (env.TERM === "dumb") return 0;
  if (!isTty) return 0;
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return 3;
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return 3;
  if (env.TERM?.includes("-256color") === true) return 2;
  return 1;
};
