import { describe, expect, it } from "vite-plus/test";

import { shouldSuggestContextHandoff } from "./contextHandoff";

describe("shouldSuggestContextHandoff", () => {
  const at = (usedPercentage: number | null, driverKind: string | null) =>
    shouldSuggestContextHandoff({ usedPercentage, driverKind });

  it("starts at 70% for providers that do not compact", () => {
    for (const driver of ["cursor", "grok", "opencode", "antigravity", null]) {
      expect(at(69.9, driver)).toBe(false);
      expect(at(70, driver)).toBe(true);
      expect(at(100, driver)).toBe(true);
    }
  });

  it("never fires for Claude and Codex, or when the payload says it compacts", () => {
    expect(at(95, "claudeAgent")).toBe(false);
    expect(at(95, "codex")).toBe(false);
    expect(
      shouldSuggestContextHandoff({
        usedPercentage: 95,
        driverKind: "cursor",
        compactsAutomatically: true,
      }),
    ).toBe(false);
  });

  it("stays quiet without a known window size", () => {
    expect(at(null, "cursor")).toBe(false);
  });
});
