import { cli } from "./cli.ts";
import { doctor } from "./doctor.ts";
import { link } from "./link.ts";
import { providers } from "./providers.ts";
import { render } from "./render.ts";
import { session } from "./session.ts";
import { settings } from "./settings.ts";

export type Language = "en" | "ko";

export const LANGUAGES: ReadonlyArray<Language> = ["en", "ko"];

const AREAS = [cli, doctor, link, providers, render, session, settings] as const;

type AreaEn = (typeof AREAS)[number]["en"];
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

export type MessageKey = keyof UnionToIntersection<AreaEn>;

const TABLES: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  en: Object.assign({}, ...AREAS.map((area) => area.en)),
  ko: Object.assign({}, ...AREAS.map((area) => area.ko)),
};

let current: Language = "en";

export const getLanguage = (): Language => current;
export const setLanguage = (language: Language): void => {
  current = language;
};

export const isLanguage = (value: unknown): value is Language => value === "en" || value === "ko";

/** The first set one of LC_ALL, LC_MESSAGES, LANG decides: `ko...` is Korean, anything else English. */
export const detectLanguage = (env: NodeJS.ProcessEnv): Language => {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = env[name]?.trim();
    if (value) return value.toLowerCase().startsWith("ko") ? "ko" : "en";
  }
  return "en";
};

/** The `language` setting when set, else the locale. */
export const resolveLanguage = (setting: Language | null, env: NodeJS.ProcessEnv): Language =>
  setting ?? detectLanguage(env);

export type MessageVars = Readonly<Record<string, string | number>>;

/** The string for `key` in the current language, with `{name}` placeholders filled from `vars`. */
export const t = (key: MessageKey, vars?: MessageVars): string => {
  const text = TABLES[current][key] ?? TABLES.en[key] ?? key;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
};
