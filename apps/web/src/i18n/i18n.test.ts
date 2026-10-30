import { describe, expect, it } from "vite-plus/test";

import { resolveUiLanguage } from "../state/menuLanguage";
import { MESSAGES, translate } from "./index";

describe("interface translation", () => {
  it("has every shipped language for every message", () => {
    for (const [english, translations] of Object.entries(MESSAGES)) {
      for (const language of ["ko", "ja", "zh-CN", "es"] as const) {
        expect(translations[language]?.trim(), `${language}: ${english}`).toBeTruthy();
      }
    }
  });

  it("keeps the placeholders of the English text in every translation", () => {
    for (const [english, translations] of Object.entries(MESSAGES)) {
      const expected = [...english.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted();
      for (const [language, text] of Object.entries(translations)) {
        const actual = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted();
        expect(actual, `${language}: ${english}`).toEqual(expected);
      }
    }
  });

  it("translates, falls back to English, and fills placeholders", () => {
    expect(translate("ko", "Settings")).toBe("설정");
    expect(translate("en", "Settings")).toBe("Settings");
    expect(translate("ja", "A string nobody translated")).toBe("A string nobody translated");
    expect(translate("en", "{count} items", { count: 3 })).toBe("3 items");
  });

  it("maps OS locales to a shipped language, else English", () => {
    expect(resolveUiLanguage("ko-KR")).toBe("ko");
    expect(resolveUiLanguage("ja_JP")).toBe("ja");
    expect(resolveUiLanguage("zh-TW")).toBe("zh-CN");
    expect(resolveUiLanguage("es-419")).toBe("es");
    expect(resolveUiLanguage("fr-FR")).toBe("en");
    expect(resolveUiLanguage(undefined)).toBe("en");
  });
});
