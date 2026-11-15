import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROJECT_MEMORY_SEND_DRIVER_KINDS } from "./ProjectMemorySendProviders.ts";

describe("project memory send providers", () => {
  it("allows exactly Antigravity, Claude, Codex, Cursor, Grok, MiniMax, OpenCode and ZCode", () => {
    expect([...PROJECT_MEMORY_SEND_DRIVER_KINDS].sort()).toEqual([
      "antigravity",
      "claudeAgent",
      "codex",
      "cursor",
      "grok",
      "minimax",
      "opencode",
      "zcode",
    ]);
  });

  it("denies drivers it does not name", () => {
    for (const driver of ["some-new-driver"]) {
      expect(PROJECT_MEMORY_SEND_DRIVER_KINDS.has(ProviderDriverKind.make(driver))).toBe(false);
    }
  });
});
