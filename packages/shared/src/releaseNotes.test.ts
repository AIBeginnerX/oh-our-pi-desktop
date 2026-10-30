import { describe, expect, it } from "vite-plus/test";

import {
  compareReleaseVersions,
  localizedHighlight,
  releaseNotes,
  releaseNotesFor,
} from "./releaseNotes.ts";

describe("releaseNotes data", () => {
  it("lists unique versions, newest first, each with dated English highlights", () => {
    expect(releaseNotes.length).toBeGreaterThan(0);
    const versions = releaseNotes.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let index = 1; index < releaseNotes.length; index += 1) {
      const newer = releaseNotes[index - 1]!;
      const older = releaseNotes[index]!;
      expect(
        compareReleaseVersions(newer.version, older.version),
        `${newer.version} must come before ${older.version}`,
      ).toBeGreaterThan(0);
    }
    for (const entry of releaseNotes) {
      expect(entry.version, entry.version).toMatch(/^\d+(\.\d+)*$/);
      expect(entry.date, entry.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.highlights.length, entry.version).toBeGreaterThan(0);
      for (const highlight of entry.highlights) {
        expect(highlight.en.trim(), entry.version).toBeTruthy();
        for (const text of Object.values(highlight)) {
          expect(text.trim(), entry.version).toBeTruthy();
        }
      }
    }
  });
});

describe("compareReleaseVersions", () => {
  it("compares dotted parts numerically", () => {
    expect(compareReleaseVersions("0.0.121", "0.0.99")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.1.0", "0.0.121")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("0.0.9", "0.0.10")).toBeLessThan(0);
  });
});

describe("releaseNotesFor", () => {
  it("finds a listed version and returns nothing for an unlisted one", () => {
    const newest = releaseNotes[0]!;
    expect(releaseNotesFor(newest.version)).toBe(newest);
    expect(releaseNotesFor("0.0.0-unlisted")).toBeUndefined();
  });
});

describe("localizedHighlight", () => {
  const highlight = { en: "English text", ko: "한국어 문장" };

  it("uses the requested language when it exists", () => {
    expect(localizedHighlight(highlight, "ko")).toBe("한국어 문장");
    expect(localizedHighlight(highlight, "en")).toBe("English text");
  });

  it("falls back to English when the translation is missing or blank", () => {
    expect(localizedHighlight(highlight, "ja")).toBe("English text");
    expect(localizedHighlight({ en: "English text", es: "  " }, "es")).toBe("English text");
  });
});
