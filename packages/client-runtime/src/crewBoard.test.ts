import { describe, expect, it } from "vite-plus/test";

import {
  runningCrewAudit,
  crewEvidence,
  crewOverall,
  crewPercent,
  crewTodoCounts,
  crewTodosProven,
  crewProofOf,
  crewTaskActions,
  crewTurnUsage,
  runningCrewTaskCount,
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

describe("runningCrewTaskCount", () => {
  it("counts crew tasks without a final report and ignores other nodes", () => {
    const task = (outcome?: string) => ({ info: { crew: { outcome } } });
    expect(
      runningCrewTaskCount([task(), task("stopped"), task("completed"), task(), { info: {} }]),
    ).toBe(2);
    expect(runningCrewTaskCount([])).toBe(0);
  });
});

describe("crew todo progress", () => {
  const counts = (total: number, verified: number, claimed = 0) => ({
    total,
    verified,
    claimed,
    failed: 0,
    blocked: 0,
  });

  it("reads the payload counts and ignores a payload without a positive total", () => {
    expect(
      crewTodoCounts({ todoTotal: 4, todoVerified: 1, todoClaimed: 2, todoFailed: -1 }),
    ).toEqual({ total: 4, verified: 1, claimed: 2, failed: 0, blocked: 0 });
    expect(crewTodoCounts({ todoTotal: 0 })).toBeUndefined();
    expect(crewTodoCounts({ todoTotal: "4" })).toBeUndefined();
    expect(crewTodoCounts({})).toBeUndefined();
  });

  it("floors the percent, so 100 means every item is finished", () => {
    expect(crewPercent(1, 3)).toBe(33);
    expect(crewPercent(2, 3)).toBe(66);
    expect(crewPercent(199, 200)).toBe(99);
    expect(crewPercent(5, 3)).toBe(100);
    expect(crewPercent(0, 0)).toBe(0);
  });

  it("counts only proven items: five claimed and none verified is 0 percent", () => {
    expect(crewTodosProven(counts(5, 0, 5))).toBe(0);
    expect(crewTodosProven(counts(5, 2, 3))).toBe(2);
    expect(crewOverall([{ todos: counts(5, 0, 5) }])).toEqual({ done: 0, total: 5, percent: 0 });
    expect(crewPercent(crewTodosProven(counts(5, 0, 5)), 5)).toBe(0);
  });

  it("sums proven items over all items and counts a task without a list as one item", () => {
    expect(crewOverall([{}, { outcome: "completed", proof: "verified" }])).toBeUndefined();
    expect(
      crewOverall([
        { todos: counts(20, 8, 2) },
        { outcome: "completed", proof: "verified" },
        {},
        { outcome: "partial" },
      ]),
    ).toEqual({ done: 9, total: 23, percent: 39 });
    // A completed task whose proof says it was not verified is not a done item.
    expect(
      crewOverall([
        { todos: counts(1, 1) },
        { outcome: "completed", proof: "not-verified" },
        { outcome: "completed", proof: "inconclusive" },
      ]),
    ).toEqual({ done: 1, total: 3, percent: 33 });
    // Items added to a task move the share back down.
    expect(crewOverall([{ todos: counts(4, 4) }])?.percent).toBe(100);
    expect(crewOverall([{ todos: counts(5, 4) }])?.percent).toBe(80);
  });

  it("counts a worker's verified list and an approved auditor without a proof as 100 percent", () => {
    expect(
      crewOverall([
        { todos: counts(4, 4) },
        // An auditor never gets a proof: its verdict stands in for one.
        { outcome: "completed" },
        // An older server sends no proof at all.
        { outcome: "completed", proof: undefined },
      ]),
    ).toEqual({ done: 6, total: 6, percent: 100 });
  });

  it("does not count a completed task without a list whose proof is inconclusive", () => {
    expect(
      crewOverall([{ todos: counts(4, 4) }, { outcome: "completed", proof: "inconclusive" }]),
    ).toEqual({ done: 4, total: 5, percent: 80 });
  });

  it("reads only the three proof verdicts", () => {
    expect(crewProofOf("verified")).toBe("verified");
    expect(crewProofOf("not-verified")).toBe("not-verified");
    expect(crewProofOf("inconclusive")).toBe("inconclusive");
    expect(crewProofOf(undefined)).toBeUndefined();
    expect(crewProofOf("VERIFIED")).toBeUndefined();
  });
});

describe("runningCrewAudit", () => {
  const event = (kind: string, taskId: string, crewRole = "auditor") => ({
    kind,
    payload: { taskId, crewRole, model: "astra" },
  });
  it("shows a running audit", () => {
    expect(runningCrewAudit([event("task.started", "a")])).toEqual({ model: "astra" });
    expect(runningCrewAudit([event("task.progress", "a")])).toEqual({ model: "astra" });
  });
  it("hides completed audits and other crew roles", () => {
    expect(runningCrewAudit([event("task.started", "a"), event("task.completed", "a")])).toBeNull();
    expect(runningCrewAudit([event("task.started", "a", "worker")])).toBeNull();
  });
  it("shows the later running audit", () => {
    expect(
      runningCrewAudit([
        event("task.started", "a"),
        event("task.completed", "a"),
        event("task.started", "b"),
      ]),
    ).toEqual({ model: "astra" });
  });
});
