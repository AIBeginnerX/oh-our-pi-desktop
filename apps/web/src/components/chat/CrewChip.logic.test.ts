import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { CrewModelOption } from "@t3tools/shared/crew";
import { describe, expect, it } from "vite-plus/test";

import { crewFallbackCandidates, crewLeadAvailability } from "./CrewChip.logic";

const provider = (instanceId: string, extra: Record<string, unknown>) =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    ...extra,
  }) as unknown as ServerProvider;
const brain = (instanceId: string) => ({ instanceId, model: "m" }) as unknown as ModelSelection;
const option = (model: string): CrewModelOption =>
  ({
    selection: { instanceId: "p", model },
    label: model,
    providerLabel: "P",
    driver: "p",
    tier: 2,
    isDefault: false,
  }) as unknown as CrewModelOption;
const selectionOf = (entry: CrewModelOption) => entry.selection.model;

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

describe("crewFallbackCandidates", () => {
  it("leaves out the role's own model and the ones already listed", () => {
    const options = [option("a"), option("b"), option("c"), option("d")];
    expect(
      crewFallbackCandidates(options, option("b"), [option("d").selection]).map(selectionOf),
    ).toEqual(["a", "c"]);
  });

  it("treats a model of another instance as a different model", () => {
    const elsewhere = {
      ...option("a"),
      selection: { instanceId: "q", model: "a" },
    } as unknown as CrewModelOption;
    expect(
      crewFallbackCandidates([option("a"), elsewhere], null, [option("a").selection]).map(
        selectionOf,
      ),
    ).toEqual(["a"]);
  });

  it("excludes only the listed ones when the role is on Auto", () => {
    const options = [option("a"), option("b")];
    expect(crewFallbackCandidates(options, null, [option("b").selection]).map(selectionOf)).toEqual(
      ["a"],
    );
  });

  it("offers nothing when every model is taken", () => {
    const options = [option("a"), option("b")];
    expect(crewFallbackCandidates(options, option("a"), [option("b").selection])).toEqual([]);
  });
});
