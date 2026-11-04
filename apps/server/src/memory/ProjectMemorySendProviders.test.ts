import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_MEMORY_SEND_DECISIONS,
  PROJECT_MEMORY_SEND_DRIVER_KINDS,
} from "./ProjectMemorySendProviders.ts";

describe("project memory send providers", () => {
  it("allows exactly Claude and Codex", () => {
    expect([...PROJECT_MEMORY_SEND_DRIVER_KINDS].sort()).toEqual(["claudeAgent", "codex"]);
  });

  it("records an explicit not-verified decision for every other known adapter", () => {
    for (const driver of ["cursor", "grok", "opencode", "antigravity"] as const) {
      const decision = PROJECT_MEMORY_SEND_DECISIONS[driver];
      expect(decision.status).toBe("not-supported-yet");
      expect("reason" in decision && decision.reason).toContain("not verified");
      expect(PROJECT_MEMORY_SEND_DRIVER_KINDS.has(ProviderDriverKind.make(driver))).toBe(false);
    }
  });

  it("denies drivers it does not name", () => {
    for (const driver of ["minimax", "zcode", "some-new-driver"]) {
      expect(PROJECT_MEMORY_SEND_DRIVER_KINDS.has(ProviderDriverKind.make(driver))).toBe(false);
    }
  });
});
