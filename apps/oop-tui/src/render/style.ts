import { detectColorLevel } from "./color.ts";
import { BUILTIN_THEMES, createTheme, type Theme } from "./theme.ts";

/**
 * Text styling for code that predates theme tokens. The six colour names are kept and answer to the
 * current theme (red is `error`, green `success`, yellow `warning`, blue `info`, magenta `tool`, cyan
 * `accent`), so they follow `/theme` and the terminal's colour level. New code reads `theme` instead.
 */
export interface Style {
  readonly enabled: boolean;
  /** The theme in effect now; it changes when the user picks another one. */
  readonly theme: Theme;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly italic: (text: string) => string;
  readonly underline: (text: string) => string;
  readonly strike: (text: string) => string;
  readonly inverse: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly magenta: (text: string) => string;
  readonly cyan: (text: string) => string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;

/**
 * `true` styles with the plain 16 colours (the built-in `ansi` theme), `false` turns styling off.
 * A theme, or a function returning the current one, styles with that theme; the function form is how
 * a running screen follows a theme change.
 */
export const makeStyle = (source: boolean | Theme | (() => Theme)): Style => {
  const current: () => Theme =
    typeof source === "function"
      ? source
      : (
          (fixed) => () =>
            fixed
        )(
          typeof source === "boolean"
            ? createTheme("ansi", BUILTIN_THEMES.ansi, source ? 1 : 0)
            : source,
        );
  const modifier = (open: number, close: number) => {
    const apply = wrap(open, close);
    return (text: string) => (current().enabled ? apply(text) : text);
  };
  return {
    get enabled() {
      return current().enabled;
    },
    get theme() {
      return current();
    },
    bold: modifier(1, 22),
    dim: modifier(2, 22),
    italic: modifier(3, 23),
    underline: modifier(4, 24),
    strike: modifier(9, 29),
    inverse: modifier(7, 27),
    red: (text) => current().error(text),
    green: (text) => current().success(text),
    yellow: (text) => current().warning(text),
    blue: (text) => current().info(text),
    magenta: (text) => current().tool(text),
    cyan: (text) => current().accent(text),
  };
};

/** NO_COLOR (https://no-color.org) and dumb terminals turn colour off; FORCE_COLOR turns it on. */
export const shouldUseColor = (env: NodeJS.ProcessEnv, isTty: boolean): boolean =>
  detectColorLevel(env, isTty) > 0;
