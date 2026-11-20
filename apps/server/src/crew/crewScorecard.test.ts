import { describe, expect, it } from "vite-plus/test";

import type { CrewTaskRecoveryState } from "./crewRecoveryState.ts";
import { aggregateCrewScorecard } from "./crewScorecard.ts";

type Task = typeof CrewTaskRecoveryState.Type;
type Report = NonNullable<Task["report"]>;

function record(
  role: Task["role"],
  status: Report["status"],
  fields: Partial<Report> = {},
  model = "Model A (Provider)",
) {
  return JSON.stringify({
    version: 1,
    taskId: "task",
    leadThreadId: "lead",
    leadTurnId: null,
    role,
    subject: "Fixture",
    attempts: [
      { model: "Earlier model", threadId: "earlier", error: "the turn failed" },
      { model, threadId: "member" },
    ],
    report: { taskId: "task", role, status, result: null, ...fields },
    collected: false,
    ended: status !== "running",
    auditState: "none",
  });
}

describe("aggregateCrewScorecard", () => {
  it("counts terminal outcomes and proof by role and the model that ran", () => {
    expect(
      aggregateCrewScorecard([
        record("worker", "completed", { proof: { verdict: "verified", reason: "tests passed" } }),
        record("worker", "failed"),
        record("worker", "partial"),
        record("worker", "running"),
        record("worker", "completed", {}, "Model B (Provider)"),
        record("expert", "completed"),
        record("expert", "interrupted"),
        '{"version":99}',
      ]),
    ).toEqual([
      {
        role: "expert",
        model: "Model A (Provider)",
        tasks: 1,
        completed: 1,
        verified: 0,
        failed: 0,
      },
      {
        role: "worker",
        model: "Model A (Provider)",
        tasks: 3,
        completed: 1,
        verified: 1,
        failed: 1,
      },
      {
        role: "worker",
        model: "Model B (Provider)",
        tasks: 1,
        completed: 1,
        verified: 0,
        failed: 0,
      },
    ]);
  });

  it("counts the audits that asked for changes and how many backed it with evidence", () => {
    const blocker = { severity: "P1", confidence: 1, title: "Fails", proven: true };
    const review = (level: string) =>
      `\`\`\`json\n${JSON.stringify({
        verdict: "needs changes",
        summary: "Review",
        findings: [{ ...blocker, level, evidence: "Reproduced with the fixture" }],
      })}\n\`\`\``;
    expect(
      aggregateCrewScorecard([
        record("auditor", "completed", { result: review("ran") }),
        record("auditor", "completed", { result: review("line") }),
        record("auditor", "completed", { result: "Verdict: needs changes" }),
        record("auditor", "failed"),
      ]),
    ).toEqual([
      {
        role: "auditor",
        model: "Model A (Provider)",
        audits: 4,
        needsChanges: 3,
        provenBlocking: 1,
        unreadable: 1,
      },
    ]);
  });
});
