import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCrewDecisionLog, crewDecisionCell, crewDecisionLogTsv } from "./crewDecisionLog.ts";

let sequence = 0;
const activity = (
  kind: string,
  at: string,
  payload: Record<string, unknown>,
  summary = kind,
): OrchestrationThreadActivity =>
  ({
    id: `event-${(sequence += 1)}`,
    tone: "info",
    kind,
    summary,
    payload,
    turnId: "turn-1",
    sequence,
    createdAt: at,
  }) as unknown as OrchestrationThreadActivity;

const T = (second: number) => `2026-10-14T01:00:${String(second).padStart(2, "0")}.000Z`;

const run = [
  activity("task.started", T(1), {
    taskId: "w1",
    crewRole: "worker",
    title: "Fix the parser",
    model: "Haiku",
    threadId: "th-1",
    why: "cheap and the change is mechanical",
  }),
  // A checklist progress row is overwritten in place and is not a decision.
  activity("task.progress", T(2), { taskId: "w1", crewRole: "worker", todoTotal: 3 }),
  activity(
    "task.progress",
    T(3),
    { taskId: "w1", crewRole: "worker", model: "Sonnet", summary: "Haiku failed (rate limit)" },
    "Worker switched to Sonnet: Fix the parser",
  ),
  activity("task.completed", T(4), {
    taskId: "w1",
    crewRole: "worker",
    status: "completed",
    todoTotal: 3,
    todoVerified: 2,
    proof: "inconclusive",
  }),
  activity("task.completed", T(5), {
    taskId: "a1",
    crewRole: "auditor",
    status: "completed",
    verdict: "needs-changes",
  }),
  activity("crew.follow-up", T(6), { reason: "audit" }),
  activity("crew.stopped", T(7), {
    taskIds: ["w2", "w3"],
    reason: "Stopped on request.",
    why: "wrong repo",
  }),
];

describe("buildCrewDecisionLog", () => {
  it("makes a row per decision point, in time order, with the columns of the design", () => {
    const rows = buildCrewDecisionLog(run.toReversed());
    expect(rows.map((row) => row.phase)).toEqual([
      "delegate:worker",
      "fallback",
      "result:worker",
      "audit",
      "follow-up",
      "stop",
    ]);
    expect(rows[0]).toEqual({
      id: run[0]?.id,
      ts: T(1),
      phase: "delegate:worker",
      decision: "handed to Haiku: Fix the parser",
      why: "cheap and the change is mechanical",
      evidence: "task:w1 thread:th-1",
      result: "running",
    });
    expect(rows[1]).toMatchObject({
      decision: "switched to Sonnet",
      why: "Haiku failed (rate limit)",
      result: "retrying",
    });
    expect(rows[2]).toMatchObject({
      decision: "worker finished",
      evidence: "task:w1 todos 2/3",
      result: "INCONCLUSIVE",
    });
    expect(rows[3]).toMatchObject({ decision: "auditor needs-changes", result: "needs-changes" });
    expect(rows[4]).toMatchObject({ why: "audit", result: "queued" });
    expect(rows[5]).toMatchObject({
      decision: "stopped 2 tasks",
      why: "wrong repo",
      evidence: "tasks:w2,w3",
      result: "stopped",
    });
  });

  it("reads an older server's activities: no why, no proof, and never a verified result", () => {
    const rows = buildCrewDecisionLog([
      activity("task.started", T(1), { taskId: "w1", crewRole: "worker", title: "t", model: "M" }),
      activity("task.completed", T(2), { taskId: "w1", crewRole: "worker", status: "completed" }),
      activity("crew.stopped", T(3), { taskIds: ["w9"], reason: "Stopped on request." }),
      activity("crew.stopping", T(4), {
        taskIds: ["w9"],
        stopping: ["w9"],
        reason: "Stopped on request.",
      }),
      activity("tool.completed", T(5), {}),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.why).toBe("");
    expect(rows[1]?.result).toBe("UNKNOWN");
    // A stop the user asked for has only the server's reason.
    expect(rows[2]).toMatchObject({ why: "Stopped on request.", decision: "stopped 1 task" });
    expect(rows[3]).toMatchObject({ decision: "stopping 1 task", result: "stopping" });
  });

  it("is empty for a thread that never used the crew", () => {
    expect(buildCrewDecisionLog([activity("tool.completed", T(1), {})])).toEqual([]);
  });

  it("shows the unfinished results the follow-up cap dropped", () => {
    const rows = buildCrewDecisionLog([
      // No crewRole at top level, like crew.follow-up, so it must still reach the log.
      activity("crew.results-dropped", T(1), {
        tasks: [
          { taskId: "w2", crewRole: "worker", subject: "Fix the parser", status: "partial" },
          { taskId: "w3", crewRole: "worker", subject: "Add tests", status: "blocked" },
        ],
      }),
      activity("crew.results-dropped", T(2), {
        tasks: [{ taskId: "w4", crewRole: "worker", subject: "Docs", status: "failed" }],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      phase: "follow-up",
      decision: "2 unfinished results dropped (follow-up limit)",
      why: "",
      evidence: "tasks:w2,w3",
      result: "dropped",
    });
    expect(rows[1]).toMatchObject({
      decision: "1 unfinished result dropped (follow-up limit)",
      evidence: "tasks:w4",
      result: "dropped",
    });
  });

  it("leaves out a provider-native task that carries no crew role", () => {
    const rows = buildCrewDecisionLog([
      // The plan's own step: the provider emits task.started without a crewRole.
      activity(
        "task.started",
        T(1),
        { taskId: "plan-1", taskType: "plan", title: "Read the repo" },
        "Task started",
      ),
      activity("task.completed", T(2), { taskId: "plan-1", taskType: "plan" }, "Task completed"),
      // A crew task still counts, and a stop stays, because those are the lead's.
      activity("task.started", T(3), { taskId: "w1", crewRole: "worker", model: "Haiku" }),
      activity("crew.stopped", T(4), { taskIds: ["w1"], reason: "Stopped on request." }),
    ]);
    expect(rows.map((row) => row.phase)).toEqual(["delegate:worker", "stop"]);
  });
});

describe("crewDecisionLogTsv", () => {
  it("writes a header and one line per row with six tab-separated cells", () => {
    const lines = crewDecisionLogTsv(buildCrewDecisionLog(run)).split("\n");
    expect(lines[0]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");
    expect(lines).toHaveLength(7);
    expect(lines.every((line) => line.split("\t").length === 6)).toBe(true);
  });

  it("keeps a hostile cell on one line and defuses a spreadsheet formula", () => {
    expect(crewDecisionCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    for (const lead of ["+", "-", "@"]) expect(crewDecisionCell(`${lead}1`)).toBe(`'${lead}1`);
    expect(crewDecisionCell("a\tb\r\nc d\u0007e")).toBe("a b c d e");
    // A tab or newline in front must not hide the formula marker.
    expect(crewDecisionCell("\t=1+1")).toBe("'=1+1");
    expect(crewDecisionCell("x".repeat(900))).toHaveLength(500);
    const rows = buildCrewDecisionLog([
      activity("task.started", T(1), {
        taskId: "w\t1",
        crewRole: "worker",
        title: '=HYPERLINK("http://x")\nsecond line',
        why: "-2+3",
      }),
    ]);
    const [, line] = crewDecisionLogTsv(rows).split("\n");
    expect(line?.split("\t")).toHaveLength(6);
    expect(line).toContain("\t'-2+3\t");
    expect(line).toContain("handed to worker: =HYPERLINK");
    expect(crewDecisionLogTsv(rows).split("\n")).toHaveLength(2);
  });
});
