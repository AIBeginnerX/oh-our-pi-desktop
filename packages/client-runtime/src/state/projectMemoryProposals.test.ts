import { describe, expect, it } from "@effect/vitest";
import type { ProjectMemoryProposal } from "@t3tools/contracts";

import { projectMemoryAnalyserState, projectMemoryProposalView } from "./projectMemoryProposals.ts";

const base = {
  proposalId: "p1",
  projectId: "project-1",
  threadId: "thread-1",
  title: "t",
  body: "b",
  reason: "r",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as ProjectMemoryProposal;

describe("projectMemoryProposalView", () => {
  it("treats a proposal without analysis as an approvable agent proposal", () => {
    expect(projectMemoryProposalView(base)).toEqual({
      source: "agent",
      target: "memory",
      canApprove: true,
      evidenceThreadIds: [],
      related: [],
    });
  });

  it("lists each evidence thread once and blocks approving a skill suggestion", () => {
    const view = projectMemoryProposalView({
      ...base,
      analysis: {
        target: "skill",
        evidence: [
          { threadId: "t1", eventSeq: 1 },
          { threadId: "t1", eventSeq: 2 },
          { threadId: "t2", eventSeq: 3 },
        ],
        related: [],
      },
    } as unknown as ProjectMemoryProposal);
    expect(view.source).toBe("analyser");
    expect(view.canApprove).toBe(false);
    expect(view.evidenceThreadIds).toEqual(["t1", "t2"]);
  });
});

describe("projectMemoryAnalyserState", () => {
  const config = (supported: boolean | undefined, on: boolean | undefined) => ({
    environment: { capabilities: { projectMemory: { analyser: supported } } },
    settings: { projectMemoryAnalyser: on },
  });

  it("is off by default and unsupported on older servers", () => {
    expect(projectMemoryAnalyserState(null)).toBe("unsupported");
    expect(projectMemoryAnalyserState(config(undefined, true))).toBe("unsupported");
    expect(projectMemoryAnalyserState(config(true, undefined))).toBe("off");
    expect(projectMemoryAnalyserState(config(true, false))).toBe("off");
    expect(projectMemoryAnalyserState(config(true, true))).toBe("on");
  });
});
