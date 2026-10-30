import { describe, expect, it } from "vite-plus/test";

import { hasUnseenReleaseNotes } from "./whatsNew";

const notes = { version: "0.0.121", date: "2026-10-29", highlights: [{ en: "A change" }] };

describe("hasUnseenReleaseNotes", () => {
  it("is unseen for a version with notes that was never seen", () => {
    expect(hasUnseenReleaseNotes({ version: "0.0.121", notes, seenVersion: null })).toBe(true);
  });

  it("is seen once this exact version was seen", () => {
    expect(hasUnseenReleaseNotes({ version: "0.0.121", notes, seenVersion: "0.0.121" })).toBe(
      false,
    );
  });

  it("is unseen again after an update because the stored version is older", () => {
    expect(hasUnseenReleaseNotes({ version: "0.0.121", notes, seenVersion: "0.0.120" })).toBe(true);
  });

  it("is never unseen for a version without notes", () => {
    expect(hasUnseenReleaseNotes({ version: "0.0.122", notes: undefined, seenVersion: null })).toBe(
      false,
    );
  });
});
