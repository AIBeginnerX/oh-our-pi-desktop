import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Color, type ColorLevel, colorCodes, parseColor } from "./color.ts";
import { gradientText } from "./gradient.ts";
import { t } from "../i18n/index.ts";

export { detectColorLevel } from "./color.ts";
export type { ColorLevel } from "./color.ts";

/** Colours that paint text. */
export const FOREGROUND_TOKENS = [
  "brand",
  "brandDim",
  "accent",
  "text",
  "onBg",
  "muted",
  "dim",
  "border",
  "success",
  "warning",
  "error",
  "info",
  "tool",
  "thinking",
  "keyword",
  "string",
  "comment",
  "number",
  "ctxOk",
  "ctxWarn",
  "ctxHigh",
  "ctxCritical",
] as const;

/**
 * Colours that fill behind text. A 16-colour terminal does not get them; see `Theme.bg`. The text on
 * a fill is painted in `onBg`, never in the terminal's own foreground, which may be as dark as the fill.
 */
export const BACKGROUND_TOKENS = [
  "userBg",
  "codeBg",
  "diffAddBg",
  "diffAddWord",
  "diffRemoveBg",
  "diffRemoveWord",
] as const;

export type ForegroundToken = (typeof FOREGROUND_TOKENS)[number];
export type BackgroundToken = (typeof BACKGROUND_TOKENS)[number];

/** `#rrggbb`, an integer 0-255 (256-colour palette), a 16-colour name such as "brightRed", or "default". */
export type ColorSpec = string | number;

const LIST_TOKENS = ["gradient", "agents"] as const;
type ListToken = (typeof LIST_TOKENS)[number];

/** A theme as authored: every token has a value. The logo gradient and the 8 sub-agent colours are lists. */
export type ThemeTokens = {
  readonly [K in ForegroundToken | BackgroundToken]: ColorSpec;
} & { readonly [K in ListToken]: ReadonlyArray<ColorSpec> };

/** A colour function for one token: `theme.brand("text")`, `theme.error.bold("text")`. */
export interface Paint {
  (text: string): string;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly italic: Paint;
  readonly underline: Paint;
}

export type Theme = { readonly [K in ForegroundToken]: Paint } & {
  readonly name: string;
  readonly level: ColorLevel;
  /** False when colour is off; every paint then returns its input as it is. */
  readonly enabled: boolean;
  /** Whether `bg` can fill behind text (256 colours or more). */
  readonly supportsBackground: boolean;
  /**
   * `text` on a background token, in the theme's `onBg` foreground (also after a paint inside `text`
   * closes). Where backgrounds are not supported, `text` is painted in the `fallback` foreground
   * token when one is given (a diff line in green or red), else left plain.
   */
  readonly bg: (token: BackgroundToken, text: string, fallback?: ForegroundToken) => string;
  /** The logo gradient across `text`; `phase` slides it. Flat on 16 colours, plain with no colour. */
  readonly gradient: (text: string, phase?: number) => string;
  /** The colour of the n-th sub-agent, cycling through the theme's agent colours. */
  readonly agent: (index: number) => Paint;
};

const MODIFIERS = {
  bold: ["1", "22"],
  dim: ["2", "22"],
  italic: ["3", "23"],
  underline: ["4", "24"],
} as const;

const makePaint = (
  enabled: boolean,
  opens: ReadonlyArray<string>,
  closes: ReadonlyArray<string>,
): Paint => {
  const paint = ((text: string) =>
    !enabled || opens.length === 0 || text === ""
      ? text
      : `\u001b[${opens.join(";")}m${text}\u001b[${closes.join(";")}m`) as Paint;
  for (const [name, [open, close]] of Object.entries(MODIFIERS)) {
    Object.defineProperty(paint, name, {
      get: () =>
        makePaint(enabled, [...opens, open], closes.includes(close) ? closes : [...closes, close]),
    });
  }
  return paint;
};

const DEFAULT_COLOR: Color = { kind: "default" };

/** What a paint inside a fill writes to give the foreground back; the fill's own foreground must follow. */
// eslint-disable-next-line no-control-regex
const FOREGROUND_RESET = /\u001b\[39(?:;\d+)*m/gu;

const paintOf = (color: Color, level: ColorLevel): Paint => {
  const codes = colorCodes(color, level);
  return makePaint(level > 0, codes === null ? [] : [codes], codes === null ? [] : ["39"]);
};

const colorOf = (spec: ColorSpec): Color => parseColor(spec) ?? DEFAULT_COLOR;

export const createTheme = (name: string, tokens: ThemeTokens, level: ColorLevel): Theme => {
  const paints = Object.fromEntries(
    FOREGROUND_TOKENS.map((token) => [token, paintOf(colorOf(tokens[token]), level)]),
  ) as { [K in ForegroundToken]: Paint };
  const backgrounds = Object.fromEntries(
    BACKGROUND_TOKENS.map((token) => [token, colorOf(tokens[token])]),
  ) as { [K in BackgroundToken]: Color };
  const gradient = tokens.gradient.map(colorOf);
  const agents =
    tokens.agents.length > 0
      ? tokens.agents.map((spec) => paintOf(colorOf(spec), level))
      : [paints.brand];
  const supportsBackground = level >= 2;
  const onBgCodes = colorCodes(colorOf(tokens.onBg), level);
  return {
    ...paints,
    name,
    level,
    enabled: level > 0,
    supportsBackground,
    bg: (token, text, fallback) => {
      if (!supportsBackground) return fallback === undefined ? text : paints[fallback](text);
      const codes = colorCodes(backgrounds[token], level, true);
      if (codes === null || text === "") return text;
      if (onBgCodes === null) return `\u001b[${codes}m${text}\u001b[49m`;
      const body = text.replaceAll(FOREGROUND_RESET, (reset) => `${reset}\u001b[${onBgCodes}m`);
      return `\u001b[${onBgCodes};${codes}m${body}\u001b[39;49m`;
    },
    gradient: (text, phase) => gradientText(text, gradient, level, phase),
    agent: (index) => agents[((index % agents.length) + agents.length) % agents.length] as Paint,
  };
};

const oop: ThemeTokens = {
  brand: "#a78bfa",
  brandDim: "#7253b9",
  accent: "#38bdf8",
  text: "default",
  onBg: "#e5e7eb",
  muted: "#9aa3b5",
  dim: "#6b7489",
  border: "#3a4256",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  info: "#60a5fa",
  tool: "#c084fc",
  thinking: "#818cf8",
  keyword: "#c084fc",
  string: "#86efac",
  comment: "#6b7489",
  number: "#fbbf24",
  ctxOk: "#4ade80",
  ctxWarn: "#fbbf24",
  ctxHigh: "#fb923c",
  ctxCritical: "#f87171",
  userBg: "#1e2433",
  codeBg: "#1a1f2c",
  diffAddBg: "#12331f",
  diffAddWord: "#1f6b3a",
  diffRemoveBg: "#3d1620",
  diffRemoveWord: "#8a2c3f",
  gradient: ["#7253b9", "#a78bfa", "#38bdf8", "#34d399"],
  agents: ["#a78bfa", "#38bdf8", "#34d399", "#fbbf24", "#f472b6", "#fb923c", "#2dd4bf", "#818cf8"],
};

const oopLight: ThemeTokens = {
  ...oop,
  onBg: "#1f2937",
  brand: "#7253b9",
  brandDim: "#9d7fd6",
  accent: "#0284c7",
  muted: "#5b6478",
  dim: "#8a93a6",
  border: "#c3c9d6",
  success: "#15803d",
  warning: "#b45309",
  error: "#b91c1c",
  info: "#1d4ed8",
  tool: "#7e22ce",
  thinking: "#4f46e5",
  keyword: "#7e22ce",
  string: "#15803d",
  comment: "#8a93a6",
  number: "#b45309",
  ctxOk: "#15803d",
  ctxWarn: "#b45309",
  ctxHigh: "#c2410c",
  ctxCritical: "#b91c1c",
  userBg: "#eef0f6",
  codeBg: "#f1f3f8",
  diffAddBg: "#d9f2e1",
  diffAddWord: "#9fdcb3",
  diffRemoveBg: "#fbdde2",
  diffRemoveWord: "#f1a9b5",
  gradient: ["#7253b9", "#5b6fd6", "#0284c7", "#059669"],
  agents: ["#7253b9", "#0284c7", "#059669", "#b45309", "#be185d", "#c2410c", "#0f766e", "#4f46e5"],
};

const aurora: ThemeTokens = {
  ...oop,
  onBg: "#e6f4f1",
  brand: "#5eead4",
  brandDim: "#0d9488",
  accent: "#a3e635",
  muted: "#94a8a4",
  dim: "#64776f",
  border: "#2f4a45",
  success: "#4ade80",
  warning: "#facc15",
  error: "#fb7185",
  info: "#67e8f9",
  tool: "#34d399",
  thinking: "#2dd4bf",
  keyword: "#5eead4",
  string: "#bef264",
  comment: "#64776f",
  number: "#facc15",
  ctxHigh: "#fb923c",
  ctxCritical: "#fb7185",
  userBg: "#16282a",
  codeBg: "#12211f",
  diffAddBg: "#0f3326",
  diffAddWord: "#1b6b4a",
  diffRemoveBg: "#3d1a24",
  diffRemoveWord: "#8a2f45",
  gradient: ["#0d9488", "#5eead4", "#a3e635", "#86efac"],
  agents: ["#5eead4", "#a3e635", "#67e8f9", "#facc15", "#34d399", "#fb7185", "#2dd4bf", "#bef264"],
};

const sunset: ThemeTokens = {
  ...oop,
  onBg: "#f5ebe6",
  brand: "#fb923c",
  brandDim: "#c2410c",
  accent: "#f472b6",
  muted: "#b8a79a",
  dim: "#85766a",
  border: "#4a3a38",
  success: "#a3e635",
  warning: "#fde047",
  error: "#fb7185",
  info: "#f9a8d4",
  tool: "#f472b6",
  thinking: "#fda4af",
  keyword: "#f472b6",
  string: "#fdba74",
  comment: "#85766a",
  number: "#fde047",
  ctxOk: "#a3e635",
  ctxHigh: "#fb923c",
  ctxCritical: "#ef4444",
  userBg: "#2b2124",
  codeBg: "#241b1f",
  diffAddBg: "#27331a",
  diffAddWord: "#4d6b24",
  diffRemoveBg: "#44171f",
  diffRemoveWord: "#8f2d3d",
  gradient: ["#f97316", "#fb7185", "#e879f9", "#a78bfa"],
  agents: ["#fb923c", "#f472b6", "#fde047", "#e879f9", "#fb7185", "#a78bfa", "#fdba74", "#f9a8d4"],
};

/** Added lines are blue and removed lines orange; nothing depends on telling red from green. */
const colorblind: ThemeTokens = {
  ...oop,
  brand: "#56b4e9",
  brandDim: "#0072b2",
  accent: "#cc79a7",
  success: "#56b4e9",
  warning: "#f0e442",
  error: "#e69f00",
  info: "#56b4e9",
  tool: "#cc79a7",
  thinking: "#8fa8d8",
  keyword: "#cc79a7",
  string: "#56b4e9",
  comment: "#6b7489",
  number: "#f0e442",
  ctxOk: "#56b4e9",
  ctxWarn: "#f0e442",
  ctxHigh: "#e69f00",
  ctxCritical: "#ff7a45",
  diffAddBg: "#0b2f4a",
  diffAddWord: "#1a5f93",
  diffRemoveBg: "#4a2f08",
  diffRemoveWord: "#8a5a10",
  gradient: ["#0072b2", "#56b4e9", "#cc79a7", "#f0e442"],
  agents: ["#56b4e9", "#e69f00", "#cc79a7", "#f0e442", "#009e73", "#d55e00", "#8fa8d8", "#999999"],
};

/** 16-colour names only, so it looks the same on every terminal; also the default on 16 colours. */
const ansi: ThemeTokens = {
  brand: "brightMagenta",
  brandDim: "magenta",
  accent: "cyan",
  text: "default",
  onBg: "default",
  muted: "brightBlack",
  dim: "brightBlack",
  border: "brightBlack",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "blue",
  tool: "magenta",
  thinking: "brightBlue",
  keyword: "magenta",
  string: "green",
  comment: "brightBlack",
  number: "yellow",
  ctxOk: "green",
  ctxWarn: "yellow",
  ctxHigh: "brightYellow",
  ctxCritical: "red",
  userBg: "default",
  codeBg: "default",
  diffAddBg: "green",
  diffAddWord: "brightGreen",
  diffRemoveBg: "red",
  diffRemoveWord: "brightRed",
  gradient: ["magenta", "brightMagenta", "cyan", "brightCyan"],
  agents: [
    "brightMagenta",
    "cyan",
    "green",
    "yellow",
    "blue",
    "brightCyan",
    "brightGreen",
    "brightYellow",
  ],
};

export const BUILTIN_THEMES = {
  oop,
  "oop-light": oopLight,
  aurora,
  sunset,
  colorblind,
  ansi,
} as const satisfies Record<string, ThemeTokens>;

export type BuiltinThemeName = keyof typeof BUILTIN_THEMES;

export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEMES) as ReadonlyArray<BuiltinThemeName>;

export const isBuiltinTheme = (name: string): name is BuiltinThemeName =>
  Object.hasOwn(BUILTIN_THEMES, name);

/**
 * Whether the terminal says its background is light. Only `COLORFGBG` ("fg;bg", set by rxvt-style
 * terminals and some others) is read; the terminal is never asked, and a missing or odd value is "no".
 */
const hasLightBackground = (env: NodeJS.ProcessEnv): boolean => {
  const background = env.COLORFGBG?.split(";").at(-1);
  if (background === undefined || !/^\d{1,2}$/u.test(background)) return false;
  const index = Number(background);
  return index === 7 || (index >= 9 && index <= 15);
};

/**
 * The theme used when none was chosen: the 16 colours are better served by `ansi` than by a guess,
 * and a terminal that reports a light background starts on `oop-light`.
 */
export const defaultThemeName = (
  level: ColorLevel,
  env: NodeJS.ProcessEnv = {},
): BuiltinThemeName => (level === 1 ? "ansi" : hasLightBackground(env) ? "oop-light" : "oop");

const SCALAR_TOKENS: ReadonlySet<string> = new Set([...FOREGROUND_TOKENS, ...BACKGROUND_TOKENS]);

const describeValue = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

/** `base` with every valid override applied. Unknown keys and invalid values are skipped and reported. */
export const applyOverrides = (
  base: ThemeTokens,
  overrides: unknown,
): { readonly tokens: ThemeTokens; readonly warnings: ReadonlyArray<string> } => {
  const warnings: string[] = [];
  const next: Record<string, ColorSpec | ReadonlyArray<ColorSpec>> = { ...base };
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { tokens: base, warnings: [t("render.theme.overridesNotObject")] };
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (SCALAR_TOKENS.has(key)) {
      if (parseColor(value) === null) {
        warnings.push(t("render.theme.badColor", { key, value: describeValue(value) }));
      } else {
        next[key] = value as ColorSpec;
      }
    } else if ((LIST_TOKENS as ReadonlyArray<string>).includes(key)) {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((v) => parseColor(v) === null)
      ) {
        warnings.push(t("render.theme.badColorList", { key }));
      } else {
        next[key] = value as ReadonlyArray<ColorSpec>;
      }
    } else {
      warnings.push(t("render.theme.unknownKey", { key }));
    }
  }
  return { tokens: next as unknown as ThemeTokens, warnings };
};

/** A theme name becomes a file name, so anything that could leave the themes folder is refused. */
export const isSafeThemeName = (name: string): boolean =>
  name !== "" && name.length <= 64 && !name.startsWith(".") && !/[\\/:\p{Cc}]/u.test(name);

export const themesDirectory = (configDir: string): string => NodePath.join(configDir, "themes");

export type ThemeLoad =
  | { readonly ok: true; readonly theme: Theme; readonly warnings: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string };

/**
 * A built-in theme, or `<configDir>/themes/<name>.json` shaped
 * `{ "base": "oop", "overrides": { "brand": "#ff00aa" } }`. Built-in names always mean the built-in.
 * A missing `base` is `oop`; an unknown one is reported and `oop` used.
 */
export const loadTheme = (input: {
  readonly name: string;
  readonly level: ColorLevel;
  readonly configDir: string;
}): ThemeLoad => {
  const { name, level, configDir } = input;
  if (isBuiltinTheme(name)) {
    return { ok: true, theme: createTheme(name, BUILTIN_THEMES[name], level), warnings: [] };
  }
  if (!isSafeThemeName(name)) return { ok: false, error: t("render.theme.badName", { name }) };
  const file = NodePath.join(themesDirectory(configDir), `${name}.json`);
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      error: missing
        ? t("render.theme.notFound", { name })
        : t("render.theme.unreadable", { file }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: t("render.theme.notJson", { file }) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: t("render.theme.notObject", { file }) };
  }
  const { base, overrides, ...rest } = parsed as Record<string, unknown>;
  const warnings: string[] = Object.keys(rest).map((key) => t("render.theme.unknownKey", { key }));
  let baseName: BuiltinThemeName = "oop";
  if (base !== undefined) {
    if (typeof base === "string" && isBuiltinTheme(base)) baseName = base;
    else warnings.push(t("render.theme.badBase", { value: describeValue(base) }));
  }
  const merged =
    overrides === undefined
      ? { tokens: BUILTIN_THEMES[baseName] as ThemeTokens, warnings: [] }
      : applyOverrides(BUILTIN_THEMES[baseName], overrides);
  return {
    ok: true,
    theme: createTheme(name, merged.tokens, level),
    warnings: [...warnings, ...merged.warnings].map((warning) => `${name}.json: ${warning}`),
  };
};

/** Built-in themes, then the user's, each name once. */
export const listThemeNames = (configDir: string): ReadonlyArray<string> => {
  let files: ReadonlyArray<string> = [];
  try {
    files = NodeFS.readdirSync(themesDirectory(configDir));
  } catch {
    // No themes folder is the usual case.
  }
  const custom = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => isSafeThemeName(name) && !isBuiltinTheme(name))
    .toSorted();
  return [...BUILTIN_THEME_NAMES, ...custom];
};
