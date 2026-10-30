import type { UiLanguage } from "../../state/menuLanguage";

/** Translations of one English interface string into every other shipped language. */
export type MessageTranslations = Readonly<Record<Exclude<UiLanguage, "en">, string>>;

export type MessageCatalog = Readonly<Record<string, MessageTranslations>>;
