// @effect-diagnostics nodeBuiltinImport:off - vitest empties CSS imports, so the source is read from disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_PRESENTATION } from "./usageProviders";

const css = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

/** The value a rule with exactly this selector gives a custom property (the selector may open several rules). */
const declared = (selector: string, property: string): string | undefined => {
  const escaped = selector.replace(/[[\]]/g, "\\$&");
  for (const block of css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "gu"))) {
    const value = new RegExp(`${property}:\\s*([^;]+);`, "u").exec(block[1] ?? "")?.[1];
    if (value !== undefined) return value.trim();
  }
  return undefined;
};

describe("Claude series colour", () => {
  it("is a variable that is the brand orange everywhere except the iris theme", () => {
    expect(PROVIDER_PRESENTATION.claude.color).toBe("var(--provider-claude)");
    expect(declared(":root", "--provider-claude")).toBe("#d97757");
    expect(declared('html[data-theme-id="iris"]', "--provider-claude")).toBe("var(--primary)");
  });

  it("is overridden by no other theme", () => {
    const overrides = [...css.matchAll(/--provider-claude:/gu)];
    expect(overrides).toHaveLength(2);
  });
});
