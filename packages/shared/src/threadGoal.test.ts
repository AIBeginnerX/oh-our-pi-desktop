import { describe, expect, it } from "vite-plus/test";

import {
  CREW_AUDIT_SKIPPED_ACTIVITY,
  THREAD_GOAL_ACTIVITY,
  threadGoalCrewGate,
  threadGoalProgress,
  threadGoalVerdict,
} from "./threadGoal.ts";

describe("threadGoalVerdict", () => {
  it("reads a completion or blocked marker on its own line at the end of the reply", () => {
    expect(threadGoalVerdict("Tests pass.\n\n**GOAL COMPLETE**")).toEqual({ kind: "met" });
    expect(threadGoalVerdict("Done.\nGOAL BLOCKED: need the staging password\n")).toEqual({
      kind: "blocked",
      reason: "need the staging password",
    });
    expect(threadGoalVerdict("GOAL BLOCKED")).toEqual({
      kind: "blocked",
      reason: "No reason given",
    });
  });

  it("ignores replies that only mention the marker or put it early", () => {
    expect(threadGoalVerdict("I will say GOAL COMPLETE when the tests pass.")).toBeNull();
    expect(
      threadGoalVerdict(["GOAL COMPLETE", "a", "b", "c", "d", "e", "still working"].join("\n")),
    ).toBeNull();
  });
});

describe("threadGoalProgress", () => {
  const activity = (kind: string, payload: unknown) => ({ kind, payload });

  it("counts only this goal's records and keeps the latest outcome", () => {
    const progress = threadGoalProgress({ id: "g2" }, [
      activity(THREAD_GOAL_ACTIVITY.continued, { goalId: "g1", turnId: "t0" }),
      activity(THREAD_GOAL_ACTIVITY.continued, { goalId: "g2", turnId: "t1" }),
      activity(THREAD_GOAL_ACTIVITY.continued, { goalId: "g2", turnId: "t2" }),
      activity(THREAD_GOAL_ACTIVITY.blocked, { goalId: "g2", turnId: "t3", reason: "need a key" }),
      activity("tool.started", { goalId: "g2" }),
    ]);
    expect(progress.status).toBe("blocked");
    expect(progress.continues).toBe(2);
    expect(progress.blockedReason).toBe("need a key");
    expect([...progress.handledTurnIds]).toEqual(["t1", "t2", "t3"]);
  });

  it("starts a fresh goal as working", () => {
    expect(threadGoalProgress({ id: "g3" }, []).status).toBe("working");
  });
});

describe("threadGoalCrewGate", () => {
  type GateInput = Parameters<typeof threadGoalCrewGate>[0];
  const at = (minute: number) => `2026-10-15T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const changed = [{ turnId: "t2", checkpointRef: "refs/t3/checkpoints/t/2", files: ["a.ts"] }];
  const unchanged = [{ turnId: "t2", checkpointRef: "refs/t3/checkpoints/t/2", files: [] }];
  const audit = (
    kind: "task.started" | "task.completed",
    turnId: string,
    minute: number,
    extra: Record<string, unknown> = {},
  ) => ({
    kind,
    turnId,
    createdAt: at(minute),
    payload: { taskId: `audit-${turnId}`, crewRole: "auditor", ...extra },
  });
  const gate = (
    overrides: Partial<Omit<GateInput, "activities">> & {
      readonly activities?: ReadonlyArray<unknown>;
    } = {},
  ) =>
    threadGoalCrewGate({
      turnId: "t2",
      auditsTurns: true,
      diffExpected: true,
      turnPredatesServer: false,
      since: at(0),
      liveSince: at(0),
      checkpoints: changed,
      ...overrides,
      activities: (overrides.activities ?? []) as GateInput["activities"],
    });

  it("waits for an earlier turn's running audit before judging on an older verdict", () => {
    // As measured: t1's audit asked for changes, the fix turns' audits were still running, and a
    // later turn t2 that changed nothing claimed the goal.
    const asked = audit("task.completed", "t1", 2, { verdict: "needs-changes" });
    const fixAudit = {
      ...audit("task.started", "t1b", 3),
      payload: { taskId: "audit-fix", crewRole: "auditor" },
    };
    const fixDone = {
      ...audit("task.completed", "t1b", 6),
      payload: { taskId: "audit-fix", crewRole: "auditor", verdict: "approve" },
    };
    expect(gate({ checkpoints: unchanged, activities: [asked, fixAudit] })).toBe("wait");
    expect(gate({ checkpoints: unchanged, activities: [asked, fixAudit, fixDone] })).toBe("clear");
    // One started before the goal was set still holds it, since its verdict lands after.
    expect(gate({ checkpoints: unchanged, since: at(4), activities: [fixAudit] })).toBe("wait");
    // An audit from before this server started never ends, so it holds nothing.
    expect(gate({ checkpoints: unchanged, liveSince: at(4), activities: [asked, fixAudit] })).toBe(
      "needs-changes",
    );
  });

  it("tells a provider placeholder from a real checkpoint by its ref, then waits for the audit", () => {
    expect(
      gate({ checkpoints: [{ turnId: "t2", checkpointRef: "provider-diff:e1", files: [] }] }),
    ).toBe("wait");
    expect(gate()).toBe("wait");
    expect(
      gate({
        activities: [
          audit("task.started", "t2", 3),
          audit("task.completed", "t2", 4, { verdict: "approve" }),
        ],
      }),
    ).toBe("clear");
  });

  it("ends the wait when the capture failed or the audit failed or could not start", () => {
    const captureFailed = {
      kind: "checkpoint.capture.failed",
      turnId: "t2",
      createdAt: at(2),
      payload: { detail: "git failed" },
    };
    expect(gate({ checkpoints: [], activities: [captureFailed] })).toBe("clear");
    expect(gate({ activities: [audit("task.completed", "t2", 3, { status: "failed" })] })).toBe(
      "clear",
    );
    expect(
      gate({
        activities: [
          audit("task.started", "t2", 3),
          audit("task.completed", "t2", 4, { status: "failed" }),
        ],
      }),
    ).toBe("clear");
    expect(gate({ checkpoints: [], diffExpected: false })).toBe("clear");
  });

  it("ends the wait when the crew left the turn unaudited on purpose", () => {
    const skipped = {
      kind: CREW_AUDIT_SKIPPED_ACTIVITY,
      turnId: "t2",
      createdAt: at(3),
      payload: { crewRole: "auditor" },
    };
    expect(gate({ activities: [skipped] })).toBe("clear");
    expect(gate({ activities: [{ ...skipped, turnId: "t1" }] })).toBe("wait");
  });

  it("keeps the latest audit since the goal was set open until a newer one approves", () => {
    const asked = audit("task.completed", "t1", 2, { verdict: "needs-changes" });
    expect(gate({ checkpoints: unchanged, activities: [asked] })).toBe("needs-changes");
    expect(gate({ checkpoints: unchanged, activities: [asked], since: at(3) })).toBe("clear");
    expect(
      gate({
        activities: [
          asked,
          audit("task.started", "t2", 5),
          audit("task.completed", "t2", 6, { verdict: "approve" }),
        ],
      }),
    ).toBe("clear");
    expect(gate({ auditsTurns: false, checkpoints: unchanged, activities: [asked] })).toBe("clear");
  });

  it("waits for nothing a server restart cut off but keeps a recorded verdict", () => {
    const followUp = {
      kind: "crew.follow-up",
      turnId: "t2",
      createdAt: at(3),
      payload: { reason: "audit" },
    };
    expect(gate({ activities: [followUp] })).toBe("crew-pending");
    expect(gate({ turnPredatesServer: true, checkpoints: [], activities: [followUp] })).toBe(
      "clear",
    );
    // The server started at minute 10, after this audit began.
    expect(
      gate({
        turnPredatesServer: true,
        liveSince: at(10),
        activities: [audit("task.started", "t2", 3)],
      }),
    ).toBe("clear");
    expect(
      gate({
        turnPredatesServer: true,
        activities: [
          audit("task.started", "t2", 3),
          audit("task.completed", "t2", 4, { verdict: "needs-changes" }),
        ],
      }),
    ).toBe("needs-changes");
  });
});
