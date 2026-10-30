import { describe, expect, it } from "vite-plus/test";

import {
  crewEvidence,
  crewTaskActions,
  crewTurnUsage,
  type CrewEvidenceTask,
} from "./crewBoard.ts";

const worker = (id: string, completedAt: string, extra: Partial<CrewEvidenceTask> = {}) => ({
  id,
  role: "worker",
  outcome: "completed",
  completedAt,
  ...extra,
});
const audit = (id: string, completedAt: string, verdict: string, outcome = "completed") => ({
  id,
  role: "auditor",
  outcome,
  completedAt,
  verdict,
});

describe("crewEvidence", () => {
  it("calls an untested, unaudited result reported", () => {
    const evidence = crewEvidence([
      worker("a", "2026-10-14T01:00:00.000Z"),
      worker("b", "2026-10-14T01:00:01.000Z", { outcome: "partial" }),
    ]);
    expect(evidence.get("a")).toBe("reported");
    expect(evidence.get("b")).toBe("reported");
  });

  it("calls a task tested when its run passed tests", () => {
    expect(crewEvidence([worker("a", "2026-10-14T01:00:00.000Z", { tested: true })]).get("a")).toBe(
      "tested",
    );
  });

  it("calls a task audited only when an approving audit finished after it", () => {
    const evidence = crewEvidence([
      audit("early", "2026-10-14T00:59:00.000Z", "approve"),
      worker("a", "2026-10-14T01:00:00.000Z", { tested: true }),
      worker("b", "2026-10-14T01:00:00.000Z"),
      audit("late", "2026-10-14T01:05:00.000Z", "approve"),
    ]);
    expect(evidence.get("a")).toBe("audited");
    expect(evidence.get("b")).toBe("audited");
    expect(
      crewEvidence([
        audit("early", "2026-10-14T00:59:00.000Z", "approve"),
        worker("a", "2026-10-14T01:00:00.000Z"),
      ]).get("a"),
    ).toBe("reported");
  });

  it("goes by the latest audit and ignores audits that did not complete", () => {
    const tasks = [
      worker("a", "2026-10-14T01:00:00.000Z", { tested: true }),
      audit("first", "2026-10-14T01:05:00.000Z", "approve"),
      audit("second", "2026-10-14T01:10:00.000Z", "needs-changes"),
    ];
    expect(crewEvidence(tasks).get("a")).toBe("tested");
    expect(
      crewEvidence([
        ...tasks,
        audit("third", "2026-10-14T01:15:00.000Z", "approve", "stopped"),
      ]).get("a"),
    ).toBe("tested");
  });

  it("gives running, failed, blocked, and stopped tasks and auditors no label", () => {
    const evidence = crewEvidence([
      { id: "running", role: "worker" },
      worker("failed", "2026-10-14T01:00:00.000Z", { outcome: "failed" }),
      worker("blocked", "2026-10-14T01:00:00.000Z", { outcome: "blocked" }),
      worker("stopped", "2026-10-14T01:00:00.000Z", { outcome: "stopped" }),
      audit("audit", "2026-10-14T01:05:00.000Z", "approve"),
    ]);
    expect([...evidence.keys()]).toEqual([]);
  });
});

describe("crewTurnUsage", () => {
  it("is null when no task has usage", () => {
    expect(crewTurnUsage([])).toBeNull();
    expect(crewTurnUsage([undefined])).toBeNull();
  });

  it("adds tokens and the costs that were reported", () => {
    expect(
      crewTurnUsage([
        { tokens: 1200, costUsd: 0.25 },
        { tokens: 800, costUsd: 0.5 },
      ]),
    ).toEqual({
      tokens: 2000,
      costUsd: 0.75,
      unpriced: false,
    });
  });

  it("marks a total unpriced when a task with usage reported no cost", () => {
    expect(crewTurnUsage([{ tokens: 1200, costUsd: 0.25 }, { tokens: 800 }, undefined])).toEqual({
      tokens: 2000,
      costUsd: 0.25,
      unpriced: true,
    });
    expect(crewTurnUsage([{ tokens: 800 }])).toEqual({ tokens: 800, unpriced: true });
  });
});

describe("crewTaskActions", () => {
  it("offers Stop only to a task without a final report, and Open once its thread is known", () => {
    expect(crewTaskActions({ role: "worker", threadId: "t" })).toEqual({
      stop: true,
      open: true,
      retry: false,
    });
    expect(crewTaskActions({ role: "worker" })).toEqual({ stop: false, open: false, retry: false });
    expect(crewTaskActions({ role: "worker", threadId: "t", outcome: "completed" })).toEqual({
      stop: false,
      open: true,
      retry: false,
    });
  });

  it("offers Retry to worker and expert tasks that ended without finishing", () => {
    for (const outcome of ["failed", "stopped", "blocked", "partial"]) {
      expect(crewTaskActions({ role: "expert", outcome }).retry).toBe(true);
    }
    expect(crewTaskActions({ role: "auditor", outcome: "failed" }).retry).toBe(false);
  });
});
