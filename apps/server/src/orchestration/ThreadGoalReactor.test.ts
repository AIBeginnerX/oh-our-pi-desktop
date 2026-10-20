import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThread, ThreadGoal } from "@t3tools/contracts";
import { THREAD_GOAL_ACTIVITY } from "@t3tools/shared/threadGoal";

import {
  CREW_AUDIT_OPEN_REASON,
  SELECTED_CHECKS_REVIEW_REASON,
  decideThreadGoal,
  selectedChecksSince,
} from "./ThreadGoalReactor.ts";

const goal: ThreadGoal = {
  id: "goal-1",
  text: "Make the login tests pass",
  maxContinues: 2,
  active: true,
  setAt: "2026-10-15T00:00:00.000Z",
};

const thread = (
  overrides: Partial<
    Pick<
      OrchestrationThread,
      "id" | "latestTurn" | "session" | "messages" | "activities" | "checkpoints"
    >
  > & {
    readonly reply?: string;
  } = {},
) =>
  ({
    id: "thread-1",
    latestTurn: {
      turnId: "turn-2",
      state: "completed",
      requestedAt: "2026-10-15T00:01:00.000Z",
      startedAt: "2026-10-15T00:01:00.000Z",
      completedAt: "2026-10-15T00:02:00.000Z",
      assistantMessageId: "reply-2",
    },
    session: { status: "ready" },
    messages: [
      {
        id: "reply-2",
        role: "assistant",
        text: overrides.reply ?? "Fixed one test.",
        turnId: "turn-2",
      },
    ],
    activities: [],
    checkpoints: [],
    ...overrides,
  }) as unknown as Pick<
    OrchestrationThread,
    "id" | "latestTurn" | "session" | "messages" | "activities" | "checkpoints"
  >;

const continued = (turnId: string) => ({
  kind: THREAD_GOAL_ACTIVITY.continued,
  payload: { goalId: goal.id, turnId },
});

describe("decideThreadGoal", () => {
  it("continues an open goal after a completed turn, up to its budget", () => {
    expect(decideThreadGoal(goal, thread())).toEqual({ kind: "continue", attempt: 1 });
    expect(
      decideThreadGoal(goal, thread({ activities: [continued("t0"), continued("t1")] as never })),
    ).toEqual({ kind: "exhausted" });
  });

  it("records the agent's verdict instead of continuing", () => {
    expect(decideThreadGoal(goal, thread({ reply: "All green.\nGOAL COMPLETE" }))).toEqual({
      kind: "met",
    });
    expect(decideThreadGoal(goal, thread({ reply: "GOAL BLOCKED: need a test account" }))).toEqual({
      kind: "blocked",
      reason: "need a test account",
    });
  });

  it("does nothing for interrupted, running, earlier, or already handled turns", () => {
    const base = thread();
    expect(
      decideThreadGoal(goal, {
        ...base,
        latestTurn: { ...base.latestTurn!, state: "interrupted" },
      }),
    ).toEqual({ kind: "none" });
    expect(decideThreadGoal(goal, thread({ session: { status: "running" } as never }))).toEqual({
      kind: "none",
    });
    expect(decideThreadGoal({ ...goal, setAt: "2026-10-15T00:05:00.000Z" }, base)).toEqual({
      kind: "none",
    });
    expect(decideThreadGoal(goal, thread({ activities: [continued("turn-2")] as never }))).toEqual({
      kind: "none",
    });
    expect(decideThreadGoal({ ...goal, active: false }, base)).toEqual({ kind: "none" });
  });
});

describe("decideThreadGoal with selected checks", () => {
  const sha = "a".repeat(64);
  const tree = { kind: "complete", treeOid: "b".repeat(40) };
  const repo = { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" };
  const check = (startedAt: string, endedAt: string) => ({
    scriptId: "lint",
    status: "passed",
    startedAt,
    endedAt,
    exitCode: 0,
    exitedBy: "exit",
    exitSignal: null,
    pgid: 41234,
    group: "empty",
    stdout: { bytes: 120, sha256: sha },
    stderr: { bytes: 0, sha256: "e".repeat(64) },
    failure: null,
  });
  // The shape a completed, fully proven attempt writes, as in the contracts' selected-check tests.
  const receipt = (
    startedAt: string,
    endedAt: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    schemaVersion: 1,
    threadId: "thread-1",
    attemptId: "attempt-1",
    revision: 2,
    threadAnchorSequence: 5,
    context: {
      projectId: "project-1",
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      cwd: "/tmp/workspace",
      shell: "/bin/zsh",
      envSha256: sha,
    },
    planned: [{ scriptId: "lint", scriptName: "Lint", commandSha256: sha, timeoutMs: 60_000 }],
    environment: {
      environmentId: "env-1",
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.6.0",
      serverVersion: "1.0.0",
      nodeVersion: "22.11.0",
    },
    tree: { atStart: tree, atEnd: tree, repoAtStart: repo, repoAtEnd: repo },
    phase: "completed",
    checks: [check(startedAt, endedAt)],
    startedAt,
    endedAt,
    error: null,
    ...overrides,
  });
  const recorded = (payload: unknown) => ({
    id: "selected-check-receipt:thread-1",
    kind: "selected-check-receipt",
    tone: "info",
    summary: "Selected checks",
    payload,
    turnId: null,
    sequence: 7,
    createdAt: "2026-10-15T00:06:00.000Z",
  });
  // The fixture's latest turn ended at 00:02.
  const before = receipt("2026-10-15T00:01:30Z", "2026-10-15T00:01:50Z");
  const after = receipt("2026-10-15T00:05:00Z", "2026-10-15T00:06:00Z");
  const done = (activities: ReadonlyArray<unknown>) =>
    decideThreadGoal(goal, thread({ reply: "GOAL COMPLETE", activities: activities as never }));

  it("meets a claimed goal only once the thread's checks pass on the latest change", () => {
    expect(done([])).toEqual({ kind: "met" });
    expect(done([recorded(after)])).toEqual({ kind: "met" });
    expect(done([recorded(before)])).toEqual({
      kind: "blocked",
      reason: SELECTED_CHECKS_REVIEW_REASON,
    });
    const running = receipt("2026-10-15T00:05:00Z", "2026-10-15T00:06:00Z", {
      phase: "running",
      endedAt: null,
      checks: [],
    });
    expect(done([recorded(running)])).toEqual({ kind: "none" });
    const failed = receipt("2026-10-15T00:05:00Z", "2026-10-15T00:06:00Z", {
      checks: [
        { ...check("2026-10-15T00:05:00Z", "2026-10-15T00:06:00Z"), status: "failed", exitCode: 1 },
      ],
    });
    expect(done([recorded(failed)])).toEqual({
      kind: "blocked",
      reason: SELECTED_CHECKS_REVIEW_REASON,
    });
  });

  it("reads no receipt as no checks, and an unknown or unreadable time as not passed", () => {
    const since = (activities: ReadonlyArray<unknown>, at: string | null) =>
      selectedChecksSince("thread-1" as never, activities as never, at);
    expect(since([], null)).toBe("none");
    expect(since([recorded(after)], null)).toBe("not-passed");
    expect(since([recorded({ ...after, startedAt: "soon" })], "2026-10-15T00:02:00.000Z")).toBe(
      "not-passed",
    );
    expect(since([recorded(after)], "2026-10-15T00:02:00.000Z")).toBe("passed");
  });

  it("turns a goal held for its checks into met once they pass on that change", () => {
    const held = {
      kind: THREAD_GOAL_ACTIVITY.blocked,
      payload: { goalId: goal.id, turnId: "turn-2", reason: SELECTED_CHECKS_REVIEW_REASON },
    };
    expect(done([held, recorded(after)])).toEqual({ kind: "met" });
    expect(done([held, recorded(before)])).toEqual({ kind: "none" });
    const otherReason = { ...held, payload: { ...held.payload, reason: "need a test account" } };
    expect(done([otherReason, recorded(after)])).toEqual({ kind: "none" });
  });
});

describe("decideThreadGoal with Crew audits", () => {
  const audits = { auditsTurns: true, diffExpected: true, serverStartedAt: null };
  const changed = [
    {
      turnId: "turn-2",
      status: "ready",
      checkpointRef: "refs/t3/checkpoints/thread/2",
      files: [{ path: "src/login.ts" }],
    },
  ];
  const auditStarted = {
    kind: "task.started",
    turnId: "turn-2",
    createdAt: "2026-10-15T00:02:10.000Z",
    payload: { taskId: "a1", crewRole: "auditor" },
  };
  const audited = (verdict: "approve" | "needs-changes") => ({
    kind: "task.completed",
    turnId: "turn-2",
    createdAt: "2026-10-15T00:03:00.000Z",
    payload: { taskId: "a1", crewRole: "auditor", status: "completed", verdict },
  });
  const withCrew = (
    reply: string,
    activities: ReadonlyArray<unknown>,
    checkpoints: ReadonlyArray<unknown> = changed,
  ) => thread({ reply, activities: activities as never, checkpoints: checkpoints as never });

  it("takes GOAL COMPLETE only after the turn's diff and its audit approve", () => {
    const done = "All green.\nGOAL COMPLETE";
    const placeholder = [
      { turnId: "turn-2", status: "missing", checkpointRef: "provider-diff:e1", files: [] },
    ];
    expect(decideThreadGoal(goal, withCrew(done, [], placeholder), audits)).toEqual({
      kind: "none",
    });
    expect(decideThreadGoal(goal, withCrew(done, [auditStarted]), audits)).toEqual({
      kind: "none",
    });
    const approved = [auditStarted, audited("approve")];
    expect(decideThreadGoal(goal, withCrew(done, approved), audits)).toEqual({ kind: "met" });
    // An interrupted turn's real checkpoint is "missing" too; only the placeholder ref means waiting.
    const interrupted = [{ ...changed[0], status: "missing" }];
    expect(decideThreadGoal(goal, withCrew(done, approved, interrupted), audits)).toEqual({
      kind: "met",
    });
  });

  it("ends the goal blocked when the agent reports it met but the audit still asks for changes", () => {
    const asked = [auditStarted, audited("needs-changes")];
    expect(decideThreadGoal(goal, withCrew("GOAL COMPLETE", asked), audits)).toEqual({
      kind: "blocked",
      reason: CREW_AUDIT_OPEN_REASON,
    });
    expect(decideThreadGoal(goal, withCrew("Still fixing the edge case.", asked), audits)).toEqual({
      kind: "continue",
      attempt: 1,
    });
  });

  it("leaves the next turn to a queued Crew follow-up instead of continuing", () => {
    const followUp = {
      kind: "crew.follow-up",
      turnId: "turn-2",
      createdAt: "2026-10-15T00:02:59.000Z",
      payload: { reason: "audit" },
    };
    expect(
      decideThreadGoal(
        goal,
        withCrew("Done.", [auditStarted, followUp, audited("needs-changes")]),
        audits,
      ),
    ).toEqual({ kind: "none" });
    expect(decideThreadGoal(goal, thread({ activities: [followUp] as never }))).toEqual({
      kind: "none",
    });
  });

  it("judges at once when the turn changed nothing or the workspace is not a git repository", () => {
    const unchanged = [{ ...changed[0], files: [] }];
    expect(decideThreadGoal(goal, withCrew("GOAL COMPLETE", [], unchanged), audits)).toEqual({
      kind: "met",
    });
    expect(
      decideThreadGoal(goal, withCrew("GOAL COMPLETE", [], []), { ...audits, diffExpected: false }),
    ).toEqual({ kind: "met" });
  });

  it("does not wait on a diff or an audit that a server restart cut off", () => {
    const restarted = { ...audits, serverStartedAt: "2026-10-15T00:10:00.000Z" };
    expect(decideThreadGoal(goal, withCrew("GOAL COMPLETE", [], []), restarted)).toEqual({
      kind: "met",
    });
    expect(decideThreadGoal(goal, withCrew("GOAL COMPLETE", [auditStarted]), restarted)).toEqual({
      kind: "met",
    });
  });
});
