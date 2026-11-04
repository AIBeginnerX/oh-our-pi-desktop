import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { crewLeadAvailability } from "./CrewChip.logic";

const provider = (instanceId: string, extra: Record<string, unknown>) =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    ...extra,
  }) as unknown as ServerProvider;
const brain = (instanceId: string) => ({ instanceId, model: "m" }) as unknown as ModelSelection;

describe("crewLeadAvailability", () => {
  it("lets a provider the server says can lead do so", () => {
    expect(
      crewLeadAvailability([provider("codex", { canLeadCrew: true })], brain("codex")),
    ).toEqual({ canLead: true, reason: null });
  });

  it("blocks a provider the server says cannot lead, and says why", () => {
    const result = crewLeadAvailability(
      [provider("cursor", { canLeadCrew: false, displayName: "Cursor" })],
      brain("cursor"),
    );
    expect(result.canLead).toBe(false);
    expect(result.reason).toContain("Cursor");
    expect(result.reason).toContain("Claude or Codex");
  });

  it("falls back to the driver list when an older server does not say", () => {
    expect(crewLeadAvailability([provider("codex", {})], brain("codex")).canLead).toBe(true);
    expect(crewLeadAvailability([provider("claudeAgent", {})], brain("claudeAgent")).canLead).toBe(
      true,
    );
    const cursor = crewLeadAvailability([provider("cursor", {})], brain("cursor"));
    expect(cursor.canLead).toBe(false);
    expect(cursor.reason).toContain("Claude or Codex");
  });

  it("does not block a provider the snapshot does not list", () => {
    expect(crewLeadAvailability([], brain("cursor"))).toEqual({ canLead: true, reason: null });
  });
});
