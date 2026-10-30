import { useCallback } from "react";

import { currentUiLanguage, useUiLanguage, type UiLanguage } from "../state/menuLanguage";
import { CHAT_MESSAGES } from "./messages/chat";
import { CHROME_MESSAGES } from "./messages/chrome";
import { DIFF_MESSAGES } from "./messages/diff";
import { ONBOARDING_MESSAGES } from "./messages/onboarding";
import { PANELS_MESSAGES } from "./messages/panels";
import { SETTINGS_MESSAGES } from "./messages/settings";
import { SETTINGS_DEFAULTS_MESSAGES } from "./messages/settingsDefaults";
import { SIDEBAR_MESSAGES } from "./messages/sidebar";
import { WORKFLOWS_MESSAGES } from "./messages/workflows";
import type { MessageCatalog } from "./messages/types";

/**
 * Every translated interface string, keyed by its English text. English needs no entry: a
 * string without one, or a language without a translation, shows the English text.
 */
export const MESSAGES: MessageCatalog = {
  ...CHROME_MESSAGES,
  ...SIDEBAR_MESSAGES,
  ...SETTINGS_MESSAGES,
  ...SETTINGS_DEFAULTS_MESSAGES,
  ...ONBOARDING_MESSAGES,
  ...CHAT_MESSAGES,
  ...WORKFLOWS_MESSAGES,
  ...DIFF_MESSAGES,
  ...PANELS_MESSAGES,
};

export type TranslationValues = Readonly<Record<string, string | number>>;

/** `text` in `language`, with `{name}` placeholders filled from `values`. */
export function translate(language: UiLanguage, text: string, values?: TranslationValues): string {
  const translated = language === "en" ? text : (MESSAGES[text]?.[language] ?? text);
  if (values === undefined) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** Translates for code outside React, such as toasts, in the language chosen right now. */
export function t(text: string, values?: TranslationValues): string {
  return translate(currentUiLanguage(), text, values);
}

/** A translate function bound to the interface language; the caller re-renders on change. */
export function useT() {
  const language = useUiLanguage();
  return useCallback(
    (text: string, values?: TranslationValues) => translate(language, text, values),
    [language],
  );
}
