import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isLanguage, t, type Language } from "./i18n/index.ts";
import { configDirectory, type PathEnv } from "./link/paths.ts";
import type { ColorLevel } from "./render/color.ts";
import type { SymbolSetting } from "./render/symbols.ts";
import {
  defaultThemeName,
  isSafeThemeName,
  listThemeNames,
  loadTheme,
  type Theme,
} from "./render/theme.ts";

export const SETTING_KEYS = [
  "theme",
  "symbols",
  "animations",
  "banner",
  "statusLine",
  "notify",
  "sidebar",
  "language",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type StatusLineSetting = "auto" | "full" | "compact" | "minimal";

export interface Settings {
  /** Null until the user picks one; the terminal's colour level then decides. */
  readonly theme: string | null;
  readonly symbols: SymbolSetting;
  readonly animations: boolean;
  readonly banner: boolean;
  readonly statusLine: StatusLineSetting;
  readonly notify: boolean;
  /** Null until the user picks one; the locale then decides. */
  readonly language: Language | null;
  /** The thread list on the left (`/sidebar`) opens by itself with the first conversation; on unless turned off. */
  readonly sidebar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: null,
  symbols: "auto",
  animations: true,
  banner: true,
  statusLine: "auto",
  notify: true,
  language: null,
  sidebar: true,
};

const SYMBOL_VALUES: ReadonlySet<string> = new Set(["auto", "unicode", "ascii"]);
const STATUS_LINE_VALUES: ReadonlySet<string> = new Set(["auto", "full", "compact", "minimal"]);

/** Each key's check: the value if `raw` is acceptable for it, else undefined. */
const VALIDATORS: { readonly [K in SettingKey]: (raw: unknown) => Settings[K] | undefined } = {
  theme: (raw) => (typeof raw === "string" && isSafeThemeName(raw) ? raw : undefined),
  symbols: (raw) =>
    typeof raw === "string" && SYMBOL_VALUES.has(raw) ? (raw as SymbolSetting) : undefined,
  animations: (raw) => (typeof raw === "boolean" ? raw : undefined),
  banner: (raw) => (typeof raw === "boolean" ? raw : undefined),
  statusLine: (raw) =>
    typeof raw === "string" && STATUS_LINE_VALUES.has(raw) ? (raw as StatusLineSetting) : undefined,
  notify: (raw) => (typeof raw === "boolean" ? raw : undefined),
  language: (raw) => (isLanguage(raw) ? raw : undefined),
  sidebar: (raw) => (typeof raw === "boolean" ? raw : undefined),
};

const EXPECTED: { readonly [K in SettingKey]: () => string } = {
  theme: () => t("settings.expected.theme"),
  symbols: () => "auto | unicode | ascii",
  animations: () => "true | false",
  banner: () => "true | false",
  statusLine: () => "auto | full | compact | minimal",
  notify: () => "true | false",
  language: () => "en | ko",
  sidebar: () => "true | false",
};

const isSettingKey = (key: string): key is SettingKey =>
  (SETTING_KEYS as ReadonlyArray<string>).includes(key);

const joinFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? NodePath.win32.join : NodePath.join;

export const settingsFilePath = (paths: PathEnv): string =>
  joinFor(paths.platform)(configDirectory(paths), "settings.json");

type RawFile =
  | { readonly ok: true; readonly object: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

/** The file as an object: a missing file is an empty one, anything unreadable or not an object is a refusal. */
const readRawFile = (file: string): RawFile => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, object: {} };
    return { ok: false, reason: t("settings.reason.unreadable") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: t("settings.reason.notJson") };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: t("settings.reason.notObject") };
  }
  return { ok: true, object: parsed as Record<string, unknown> };
};

export interface SettingsFile {
  /** Only the keys the file sets to an acceptable value. */
  readonly values: Partial<Settings>;
  readonly warnings: ReadonlyArray<string>;
  /** The file exists but is not usable; it is left exactly as it is. */
  readonly damaged: boolean;
}

/** Reads settings.json. Never throws and never writes: a damaged file means defaults and one warning. */
export const readSettings = (file: string): SettingsFile => {
  const raw = readRawFile(file);
  if (!raw.ok) {
    return {
      values: {},
      warnings: [t("settings.warn.damaged", { reason: raw.reason, file })],
      damaged: true,
    };
  }
  const values: { -readonly [K in SettingKey]?: Settings[K] } = {};
  const warnings: string[] = [];
  for (const key of SETTING_KEYS) {
    const value = raw.object[key];
    if (value === undefined) continue;
    const accepted = VALIDATORS[key](value);
    if (accepted === undefined) {
      warnings.push(t("settings.warn.invalidValue", { key, expected: EXPECTED[key]() }));
    } else {
      (values as Record<string, unknown>)[key] = accepted;
    }
  }
  return { values, warnings, damaged: false };
};

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Sets one key and keeps every other key of the file, including ones this version does not know. */
export const writeSetting = (file: string, key: SettingKey, value: unknown): WriteResult => {
  const raw = readRawFile(file);
  if (!raw.ok) {
    return {
      ok: false,
      error: t("settings.err.damaged", { reason: raw.reason, file }),
    };
  }
  // A settings file that is a symlink (dotfiles) stays one: the target is replaced, not the link,
  // and it keeps the permissions it had.
  let target = file;
  try {
    target = NodeFS.realpathSync(file);
  } catch {
    try {
      // A dangling link writes the file it points at, which is what a link to dotfiles expects.
      target = NodePath.resolve(NodePath.dirname(file), NodeFS.readlinkSync(file));
    } catch {
      // No file yet: write at the path as given.
    }
  }
  const directory = NodePath.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    // mode only applies to a folder created here; an existing config folder keeps its permissions.
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let mode: number | undefined;
    try {
      mode = NodeFS.statSync(target).mode & 0o7777;
    } catch {
      // A new file gets the default mode.
    }
    NodeFS.writeFileSync(
      temporary,
      `${JSON.stringify({ ...raw.object, [key]: value }, null, 2)}\n`,
      mode === undefined ? undefined : { mode },
    );
    // writeFileSync's mode is cut by the umask; setting it again keeps the file exactly as it was.
    if (mode !== undefined) NodeFS.chmodSync(temporary, mode);
    NodeFS.renameSync(temporary, target);
    return { ok: true };
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    return {
      ok: false,
      error: t("settings.err.saveFailed", {
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    };
  }
};

export interface ResolvedSettings {
  readonly settings: Settings;
  /** Keys whose value came from an environment variable rather than the file. */
  readonly fromEnv: ReadonlyArray<SettingKey>;
}

/** OOP_THEME, OOP_ANIMATIONS (0 or 1) and OOP_SYMBOLS beat the file; anything unusable is not an override. */
export const resolveSettings = (
  values: Partial<Settings>,
  env: NodeJS.ProcessEnv,
): ResolvedSettings => {
  const settings: { -readonly [K in SettingKey]: Settings[K] } = { ...DEFAULT_SETTINGS, ...values };
  const fromEnv: SettingKey[] = [];
  const theme = VALIDATORS.theme(env.OOP_THEME?.trim());
  if (theme !== undefined) {
    settings.theme = theme;
    fromEnv.push("theme");
  }
  const animations = env.OOP_ANIMATIONS?.trim();
  if (animations === "0" || animations === "1") {
    settings.animations = animations === "1";
    fromEnv.push("animations");
  }
  const symbols = VALIDATORS.symbols(env.OOP_SYMBOLS?.trim().toLowerCase());
  if (symbols !== undefined) {
    settings.symbols = symbols;
    fromEnv.push("symbols");
  }
  return { settings, fromEnv };
};

/** The theme to start with. One that cannot be loaded is reported and the default is used instead. */
export const loadStartupTheme = (input: {
  readonly theme: string | null;
  readonly level: ColorLevel;
  readonly configDir: string;
  readonly env?: NodeJS.ProcessEnv;
}): { readonly theme: Theme; readonly warnings: ReadonlyArray<string> } => {
  const fallback = defaultThemeName(input.level, input.env);
  const wanted = input.theme ?? fallback;
  const loaded = loadTheme({ name: wanted, level: input.level, configDir: input.configDir });
  if (loaded.ok) return { theme: loaded.theme, warnings: loaded.warnings };
  const second = loadTheme({ name: fallback, level: input.level, configDir: input.configDir });
  if (!second.ok) throw new Error(second.error);
  return {
    theme: second.theme,
    warnings: [t("settings.warn.themeFallback", { error: loaded.error, fallback })],
  };
};

/** `notes` are what a switch that worked still has to say: a warning, a failed save, an env override. */
export type ThemeSelection = {
  readonly ok: boolean;
  readonly message: string;
  readonly notes: ReadonlyArray<string>;
};

/** What `/theme` drives: the theme in use now, the names to choose from, and switching with saving. */
export interface ThemeSwitcher {
  readonly current: () => Theme;
  readonly names: () => ReadonlyArray<string>;
  readonly select: (name: string) => ThemeSelection;
}

export const createThemeSwitcher = (input: {
  readonly initial: Theme;
  readonly level: ColorLevel;
  readonly configDir: string;
  readonly settingsFile: string;
  readonly env: NodeJS.ProcessEnv;
}): ThemeSwitcher => {
  let theme = input.initial;
  return {
    current: () => theme,
    names: () => listThemeNames(input.configDir),
    select: (name) => {
      const loaded = loadTheme({ name, level: input.level, configDir: input.configDir });
      if (!loaded.ok) {
        return {
          ok: false,
          message: t("settings.theme.listHint", { error: loaded.error }),
          notes: [],
        };
      }
      theme = loaded.theme;
      const notes = [...loaded.warnings];
      const saved = writeSetting(input.settingsFile, "theme", name);
      if (!saved.ok) notes.push(saved.error);
      else if (VALIDATORS.theme(input.env.OOP_THEME?.trim()) !== undefined) {
        notes.push(t("settings.theme.envWins"));
      }
      return {
        ok: true,
        message:
          notes.length === 0
            ? t("settings.theme.selected", { name })
            : t("settings.theme.selectedNotes", { name, notes: notes.join("; ") }),
        notes,
      };
    },
  };
};

export type ConfigAction =
  | { readonly action: "list" }
  | { readonly action: "path" }
  | { readonly action: "get"; readonly key: string }
  | { readonly action: "set"; readonly key: string; readonly value: string };

const BOOLEAN_WORDS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["on", true],
  ["1", true],
  ["false", false],
  ["off", false],
  ["0", false],
]);

const show = (value: unknown): string => (value === null ? t("settings.default") : String(value));

/** `oop config`. Returns the exit code; every line goes through `io` so a test can read it. */
export const runConfigCommand = (
  command: ConfigAction,
  io: {
    readonly paths: PathEnv;
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
  },
): number => {
  const file = settingsFilePath(io.paths);
  if (command.action === "path") {
    io.out(file);
    return 0;
  }
  const read = readSettings(file);
  for (const warning of read.warnings) io.err(warning);
  const { settings, fromEnv } = resolveSettings(read.values, io.paths.env);
  const origin = (key: SettingKey) => (fromEnv.includes(key) ? t("settings.fromEnv") : "");
  if (command.action === "list") {
    for (const key of SETTING_KEYS) io.out(`${key} = ${show(settings[key])}${origin(key)}`);
    return 0;
  }
  if (!isSettingKey(command.key)) {
    io.err(t("settings.err.unknownKey", { key: command.key, keys: SETTING_KEYS.join(", ") }));
    return 2;
  }
  const key = command.key;
  if (command.action === "get") {
    io.out(`${show(settings[key])}${origin(key)}`);
    return 0;
  }
  const typed: unknown =
    typeof DEFAULT_SETTINGS[key] === "boolean"
      ? BOOLEAN_WORDS.get(command.value.toLowerCase())
      : command.value;
  const value = VALIDATORS[key](typed);
  if (value === undefined) {
    io.err(t("settings.err.badValue", { key, expected: EXPECTED[key]() }));
    return 2;
  }
  if (key === "theme" && !listThemeNames(configDirectory(io.paths)).includes(value as string)) {
    io.err(
      t("settings.err.unknownTheme", {
        value: value as string,
        themes: listThemeNames(configDirectory(io.paths)).join(", "),
      }),
    );
    return 2;
  }
  const saved = writeSetting(file, key, value);
  if (!saved.ok) {
    io.err(saved.error);
    return 1;
  }
  io.out(`${key} = ${show(value)}`);
  if (fromEnv.includes(key)) io.err(t("settings.warn.envWins"));
  return 0;
};
