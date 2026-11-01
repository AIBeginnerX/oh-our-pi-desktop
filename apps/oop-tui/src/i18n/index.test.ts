import { afterEach, describe, expect, it } from "vite-plus/test";

import { detectLanguage, getLanguage, resolveLanguage, setLanguage, t } from "./index.ts";

describe("detectLanguage", () => {
  it("is Korean only when the locale starts with ko", () => {
    expect(detectLanguage({ LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(detectLanguage({ LANG: "KO_kr" })).toBe("ko");
    expect(detectLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(detectLanguage({ LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(detectLanguage({})).toBe("en");
  });

  it("takes the first set of LC_ALL, LC_MESSAGES, LANG", () => {
    expect(detectLanguage({ LC_ALL: "en_US", LANG: "ko_KR" })).toBe("en");
    expect(detectLanguage({ LC_ALL: "", LC_MESSAGES: "ko_KR", LANG: "en_US" })).toBe("ko");
    expect(detectLanguage({ LC_ALL: " ", LANG: "ko_KR" })).toBe("ko");
  });
});

describe("resolveLanguage", () => {
  it("prefers the setting over the locale", () => {
    expect(resolveLanguage("en", { LANG: "ko_KR" })).toBe("en");
    expect(resolveLanguage("ko", { LANG: "en_US" })).toBe("ko");
    expect(resolveLanguage(null, { LANG: "ko_KR" })).toBe("ko");
    expect(resolveLanguage(null, {})).toBe("en");
  });
});

describe("t", () => {
  afterEach(() => setLanguage("ko"));

  it("returns the current language and fills placeholders", () => {
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(t("cli.err.needsValue", { name: "--x" })).toBe("--x needs a value.");
    setLanguage("ko");
    expect(t("cli.err.needsValue", { name: "--x" })).toBe("--x 에는 값이 필요합니다.");
  });
});
