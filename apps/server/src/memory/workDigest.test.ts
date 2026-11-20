import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { deriveWorkDigest, withoutProviderText, WORK_DIGEST_MAX_SIGNALS } from "./workDigest.ts";

const thread = "thread-1" as ThreadId;

let seq = 0;
const event = (type: string, payload: unknown, aggregateId: string = thread): OrchestrationEvent =>
  ({
    sequence: ++seq,
    eventId: `event-${seq}`,
    aggregateKind: "thread",
    aggregateId,
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  }) as unknown as OrchestrationEvent;

const activity = (kind: string, payload: unknown, id = `activity-${seq + 1}`) =>
  event("thread.activity-appended", {
    threadId: thread,
    activity: {
      id,
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });

const receipt = (attemptId: string, revision: number, phase: string, status: string) =>
  activity("selected-check-receipt", {
    attemptId,
    revision,
    phase,
    planned: [{ scriptId: "s1", scriptName: "test" }],
    checks: [{ scriptId: "s1", status }],
  });

const taskResult = (version: number, accepted: boolean) =>
  activity("task-result", {
    requirements: { version },
    acceptance: accepted ? { acceptedAt: "2026-01-01T00:00:00.000Z" } : null,
  });

const audit = (verdict: string | null, summary = "finding") =>
  activity("task.completed", { crewRole: "auditor", verdict, summary });

const userMessage = (text = "secret words") =>
  event("thread.message-sent", {
    threadId: thread,
    role: "user",
    text,
    streaming: false,
  });

describe("deriveWorkDigest", () => {
  it("detects a check that failed and later passed, ignoring running receipts", () => {
    const events = [
      receipt("a1", 0, "running", "running"),
      receipt("a1", 1, "completed", "failed"),
      receipt("a2", 0, "running", "running"),
      receipt("a2", 1, "completed", "passed"),
    ];
    const digest = deriveWorkDigest(thread, events);
    expect(digest.checks).toEqual([{ name: "test", passed: 1, failed: 1, lastStatus: "passed" }]);
    expect(digest.signals).toEqual([
      { kind: "check-failed-then-passed", eventSeq: events[3]!.sequence, subject: "test" },
    ]);
  });

  it("keeps clean passing checks and an accepted result as evidence", () => {
    const events = [receipt("a1", 1, "completed", "passed"), taskResult(1, true)];
    expect(deriveWorkDigest(thread, events).signals).toEqual([
      { kind: "check-passed", eventSeq: events[0]!.sequence, subject: "test" },
      { kind: "result-accepted", eventSeq: events[1]!.sequence },
    ]);
  });

  it("cites the latest failed attempt once when a check has never passed", () => {
    const first = receipt("a1", 1, "completed", "failed");
    const last = receipt("a2", 1, "completed", "timed-out");
    expect(deriveWorkDigest(thread, [first, last]).signals).toEqual([
      { kind: "check-failed", eventSeq: last.sequence, subject: "test" },
    ]);
  });

  it("does not call a check failed while a retry is running or if it ever passed", () => {
    const failed = receipt("a1", 1, "completed", "failed");
    const running = receipt("a2", 0, "running", "pending");
    expect(deriveWorkDigest(thread, [failed, running]).signals).toEqual([]);
    const passed = receipt("a0", 1, "completed", "passed");
    const failedAfterPass = receipt("a3", 1, "completed", "failed");
    expect(deriveWorkDigest(thread, [passed, failedAfterPass]).signals).toEqual([]);
    expect(deriveWorkDigest(thread, [failed, passed]).signals.map((signal) => signal.kind)).toEqual(
      ["check-failed-then-passed"],
    );
  });

  it("keeps verified crew completion and approval without their report text", () => {
    const completed = (status: string, proof: string) =>
      activity("task.completed", { crewRole: "worker", status, proof, summary: "crew report" });
    const digest = deriveWorkDigest(thread, [
      completed("completed", "verified"),
      completed("completed", "inconclusive"),
      completed("partial", "not-verified"),
      audit("approve"),
    ]);
    expect(digest.signals.map((signal) => signal.kind)).toEqual([
      "crew-work-verified",
      "audit-approved",
    ]);
    expect(JSON.stringify(digest)).not.toContain("crew report");
  });

  it("detects needs-changes followed by approve", () => {
    const events = [audit("needs-changes"), audit("approve")];
    const digest = deriveWorkDigest(thread, events);
    expect(digest.signals).toEqual([
      { kind: "audit-needs-changes-then-fixed", eventSeq: events[1]!.sequence },
    ]);
    expect(digest.audits.map((a) => a.verdict)).toEqual(["needs-changes", "approve"]);
  });

  it("cites the latest requested changes once when no later audit approved", () => {
    const earlier = audit("needs-changes");
    const latest = audit("needs-changes");
    expect(deriveWorkDigest(thread, [earlier, latest, audit(null)]).signals).toEqual([
      { kind: "audit-needs-changes-unresolved", eventSeq: latest.sequence },
    ]);
  });

  it.each([
    { status: "failed", proof: undefined },
    { status: "completed", proof: undefined },
    { status: "completed", proof: "inconclusive" },
  ])("cites a crew task with status $status and proof $proof once", ({ status, proof }) => {
    const payload = { taskId: "task-1", crewRole: "expert", status, proof };
    const completion = activity("task.completed", payload);
    const redelivery = activity("task.completed", payload);
    expect(deriveWorkDigest(thread, [completion, redelivery]).signals).toEqual([
      { kind: "crew-work-unverified", eventSeq: completion.sequence },
    ]);
    const verified = activity("task.completed", {
      ...payload,
      status: "completed",
      proof: "verified",
    });
    expect(deriveWorkDigest(thread, [completion, verified]).signals).toEqual([
      { kind: "crew-work-verified", eventSeq: verified.sequence },
    ]);
  });

  it("pairs an approval with requested changes only within one user request", () => {
    const followUp = userMessage('<oop_crew_follow_up round="1" fixes="1">\nFix it');
    const fixed = deriveWorkDigest(thread, [audit("needs-changes"), followUp, audit("approve")]);
    expect(fixed.signals.map((s) => s.kind)).toEqual(["audit-needs-changes-then-fixed"]);
    const unrelated = deriveWorkDigest(thread, [
      audit("needs-changes"),
      userMessage("Now do something else"),
      audit("approve"),
    ]);
    expect(unrelated.signals.map((s) => s.kind)).toEqual(["audit-approved"]);
  });

  it("detects reverts and an interrupt followed by a user message, without message text", () => {
    const events = [
      event("thread.reverted", { threadId: thread, turnCount: 1 }),
      event("thread.turn-interrupt-requested", { threadId: thread, createdAt: "x" }),
      userMessage(),
      userMessage(),
    ];
    const digest = deriveWorkDigest(thread, events);
    expect(digest.reverts).toBe(1);
    expect(digest.interrupts).toBe(1);
    expect(digest.signals.map((s) => s.kind)).toEqual(["revert", "interrupt-then-follow-up"]);
    expect(JSON.stringify(digest)).not.toContain("secret words");
  });

  it("counts a withdrawal but not an acceptance cleared by new requirements", () => {
    const withdrawn = deriveWorkDigest(thread, [taskResult(1, true), taskResult(1, false)]);
    expect(withdrawn.result).toEqual({ accepted: 1, withdrawn: 1, acceptedNow: false });
    expect(withdrawn.signals.map((s) => s.kind)).toEqual(["result-accepted", "result-withdrawn"]);
    const respecced = deriveWorkDigest(thread, [taskResult(1, true), taskResult(2, false)]);
    expect(respecced.result.withdrawn).toBe(0);
  });

  it("collects changed files and usage, counting a redelivered usage record once", () => {
    const usage = (id: string) =>
      activity("owned-usage", { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.5 }, id);
    const digest = deriveWorkDigest(thread, [
      event("thread.turn-diff-completed", {
        threadId: thread,
        files: [{ path: "b.ts" }, { path: "a.ts" }],
      }),
      usage("u1"),
      usage("u1"),
      usage("u2"),
    ]);
    expect(digest.changedFiles).toEqual(["a.ts", "b.ts"]);
    expect(digest.usage).toEqual({ turns: 2, inputTokens: 20, outputTokens: 10, costUsd: 1 });
  });

  it("is deterministic and independent of input order", () => {
    const events = [
      receipt("a1", 1, "completed", "failed"),
      receipt("a2", 1, "completed", "passed"),
      audit("needs-changes"),
      audit("approve"),
      event("thread.reverted", { threadId: thread, turnCount: 1 }),
    ];
    const first = deriveWorkDigest(thread, events);
    expect(deriveWorkDigest(thread, events)).toEqual(first);
    expect(deriveWorkDigest(thread, events.toReversed())).toEqual(first);
  });

  it("covers a thread with more than 500 activities", () => {
    const early = receipt("a1", 1, "completed", "failed");
    const filler = Array.from({ length: 700 }, (_, index) =>
      activity("tool.completed", {}, `filler-${index}`),
    );
    const events = [early, ...filler, receipt("a2", 1, "completed", "passed")];
    const digest = deriveWorkDigest(thread, events);
    expect(digest.checks[0]).toMatchObject({ failed: 1, passed: 1 });
    expect(digest.signals).toHaveLength(1);
    expect(digest.firstSequence).toBe(early.sequence);
  });

  it("starts over at the latest thread.created and ignores other threads", () => {
    const events = [
      event("thread.reverted", { threadId: thread, turnCount: 1 }),
      event("thread.created", { threadId: thread }),
      event("thread.reverted", { threadId: "other", turnCount: 1 }, "other"),
    ];
    expect(deriveWorkDigest(thread, events).reverts).toBe(0);
  });

  it("caps signals and can strip provider text", () => {
    const many = Array.from({ length: WORK_DIGEST_MAX_SIGNALS + 5 }, () =>
      event("thread.reverted", { threadId: thread, turnCount: 1 }),
    );
    expect(deriveWorkDigest(thread, many).signals).toHaveLength(WORK_DIGEST_MAX_SIGNALS);
    const digest = deriveWorkDigest(thread, [audit("needs-changes", "provider words")]);
    expect(digest.audits[0]?.summary).toBe("provider words");
    expect(withoutProviderText(digest).audits[0]?.summary).toBeNull();
  });
});
