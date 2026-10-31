/** Every glyph the screen draws, so a terminal that cannot show Unicode can be given plain ASCII. */
export interface Symbols {
  readonly brand: string;
  readonly prompt: string;
  readonly bullet: string;
  /** Stands for each character of a secret typed into a hidden field. */
  readonly mask: string;
  readonly tree: { readonly branch: string; readonly last: string; readonly pipe: string };
  readonly progress: { readonly full: string; readonly empty: string };
  readonly context: { readonly full: string; readonly empty: string };
  readonly check: string;
  readonly cross: string;
  readonly warning: string;
  readonly todo: { readonly open: string; readonly active: string; readonly done: string };
  readonly separator: string;
  readonly rule: string;
  readonly box: {
    readonly topLeft: string;
    readonly topRight: string;
    readonly bottomLeft: string;
    readonly bottomRight: string;
    readonly horizontal: string;
    readonly vertical: string;
  };
  /** The left rail that steps hang off: done and active steps, radio marks, and its joints. */
  readonly rail: {
    readonly start: string;
    readonly bar: string;
    readonly end: string;
    readonly tee: string;
    readonly done: string;
    readonly active: string;
    readonly cancel: string;
    readonly radioOn: string;
    readonly radioOff: string;
  };
  /** One mark per state of a step in the workflow panel; each is one column wide. */
  readonly flow: {
    readonly pending: string;
    readonly blocked: string;
    readonly running: string;
    readonly paused: string;
    readonly completed: string;
    readonly failed: string;
    readonly cancelled: string;
    readonly skipped: string;
  };
  readonly spinner: ReadonlyArray<string>;
}

export type SymbolSetting = "auto" | "unicode" | "ascii";

export const UNICODE_SYMBOLS: Symbols = {
  brand: "◆",
  prompt: "❯",
  bullet: "●",
  mask: "•",
  tree: { branch: "├─", last: "└─", pipe: "│" },
  progress: { full: "━", empty: "─" },
  context: { full: "▰", empty: "▱" },
  check: "✓",
  cross: "✗",
  warning: "▲",
  todo: { open: "☐", active: "◐", done: "☑" },
  separator: "│",
  rule: "─",
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  rail: {
    start: "┌",
    bar: "│",
    end: "└",
    tee: "├",
    done: "◇",
    active: "◆",
    cancel: "■",
    radioOn: "●",
    radioOff: "○",
  },
  flow: {
    pending: "○",
    blocked: "◌",
    running: "◐",
    paused: "‖",
    completed: "✓",
    failed: "✗",
    cancelled: "■",
    skipped: "⊘",
  },
  spinner: ["◒", "◐", "◓", "◑"],
};

export const ASCII_SYMBOLS: Symbols = {
  brand: "*",
  prompt: ">",
  bullet: "*",
  mask: "*",
  tree: { branch: "|-", last: "`-", pipe: "|" },
  progress: { full: "=", empty: "-" },
  context: { full: "#", empty: "-" },
  check: "+",
  cross: "x",
  warning: "!",
  todo: { open: "[ ]", active: "[~]", done: "[x]" },
  separator: "|",
  rule: "-",
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  },
  rail: {
    start: "+",
    bar: "|",
    end: "+",
    tee: "+",
    done: "o",
    active: "*",
    cancel: "x",
    radioOn: "(*)",
    radioOff: "( )",
  },
  flow: {
    pending: ".",
    blocked: "?",
    running: "~",
    paused: "=",
    completed: "+",
    failed: "x",
    cancelled: "-",
    skipped: "/",
  },
  spinner: ["|", "/", "-", "\\"],
};

/** Time between spinner frames. */
export const SPINNER_INTERVAL_MS = 100;

/**
 * The glyph set for a terminal. "auto" picks ASCII when the locale (LC_ALL, then LC_CTYPE, then LANG)
 * does not name UTF-8; Windows has no such locale to read, so it is Unicode only under Windows Terminal.
 */
export const resolveSymbols = (
  setting: SymbolSetting,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Symbols => {
  if (setting === "unicode") return UNICODE_SYMBOLS;
  if (setting === "ascii") return ASCII_SYMBOLS;
  if (platform === "win32") {
    return env.WT_SESSION !== undefined && env.WT_SESSION !== "" ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
  }
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value);
  return locale !== undefined && /utf-?8/iu.test(locale) ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
};
