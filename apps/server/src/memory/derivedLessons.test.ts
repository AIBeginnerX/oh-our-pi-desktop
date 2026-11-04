import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";

import {
  buildDigestPromptInput,
  lessonSimilarity,
  normalizeLessonText,
  selectLessons,
} from "./derivedLessons.ts";
import type { ThreadWorkDigest } from "./workDigest.ts";

const digest = (id: string, overrides: Partial<ThreadWorkDigest> = {}): ThreadWorkDigest => ({
  threadId: id as ThreadId,
  firstSequence: 1,
  lastSequence: 9,
  checks: [{ name: "test", passed: 1, failed: 1, lastStatus: "passed" }],
  result: { accepted: 0, withdrawn: 0, acceptedNow: false },
  audits: [
    { eventSeq: 5, verdict: "needs-changes", sourceThreadId: null, summary: "Missing a test" },
  ],
  reverts: 0,
  interrupts: 0,
  changedFiles: ["a.ts"],
  usage: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  signals: [{ kind: "check-failed-then-passed", eventSeq: 7, subject: "test" }],
  ...overrides,
});

describe("lesson text", () => {
  it("normalizes case, width and whitespace", () => {
    expect(normalizeLessonText("  Ｒun   LINT\n now ")).toBe("run lint now");
  });

  it("scores word overlap from 0 to 1", () => {
    expect(lessonSimilarity("run lint first", "Run lint first.")).toBe(1);
    expect(lessonSimilarity("run lint first", "deploy to staging")).toBe(0);
    expect(lessonSimilarity("", "anything")).toBe(0);
  });
});

describe("buildDigestPromptInput", () => {
  it("labels threads and leaves out thread ids and event numbers", () => {
    const text = buildDigestPromptInput([digest("thread-secret-id"), digest("thread-other")]);
    expect(text).toContain('"label":"T1"');
    expect(text).toContain('"label":"T2"');
    expect(text).not.toContain("thread-secret-id");
    expect(text).not.toContain("eventSeq");
  });
});

describe("selectLessons", () => {
  const digests = [digest("t1"), digest("t2"), digest("t3")];
  const lesson = (text: string, threads: string[], category: "fact" | "procedure" = "fact") => ({
    category,
    text,
    threads,
  });

  it("takes evidence from the digests, not the model", () => {
    const [candidate] = selectLessons({ lessons: [lesson("Run lint", ["T1", "T3"])] }, digests);
    expect(candidate?.evidence).toEqual([
      { threadId: "t1", eventSeq: 7 },
      { threadId: "t3", eventSeq: 7 },
    ]);
    // No check name matched: the first signal only stands in, so it is not an identity.
    expect(candidate?.evidenceNamed).toBe(false);
  });

  it("cites the signals the lesson is about, not just the thread's first", () => {
    const busy = (id: string) =>
      digest(id, {
        signals: [
          { kind: "check-failed-then-passed", eventSeq: 3, subject: "lint" },
          { kind: "check-failed-then-passed", eventSeq: 8, subject: "typecheck" },
          { kind: "revert", eventSeq: 9 },
        ],
      });
    const [candidate] = selectLessons(
      { lessons: [lesson("Fix the typecheck failure before moving on", ["T1", "T2"])] },
      [busy("t1"), busy("t2")],
    );
    expect(candidate?.evidence).toEqual([
      { threadId: "t1", eventSeq: 8 },
      { threadId: "t2", eventSeq: 8 },
    ]);
    expect(candidate?.evidenceNamed).toBe(true);
  });

  it("counts a lead thread and its crew helpers as one piece of work", () => {
    const lessons = { lessons: [lesson("Run lint", ["T1", "T2"])] };
    const pair = [digest("lead"), digest("helper")];
    const leadOf = new Map([["helper" as ThreadId, "lead" as ThreadId]]);
    expect(selectLessons(lessons, pair, leadOf)).toEqual([]);
    expect(selectLessons(lessons, pair)).toHaveLength(1);
    expect(selectLessons(lessons, [digest("lead"), digest("other")], leadOf)).toHaveLength(1);
  });

  it("drops a lesson that fewer than two distinct threads support", () => {
    expect(
      selectLessons({ lessons: [lesson("a", ["T1"]), lesson("b", ["T2", "T2"])] }, digests),
    ).toEqual([]);
  });

  it("drops secrets and caps one run at three lessons", () => {
    const many = ["one", "two", "three", "four"].map((word) =>
      lesson(`Lesson ${word}`, ["T1", "T2"]),
    );
    const out = selectLessons(
      { lessons: [lesson("token sk-abcdefghijklmnopqrstuvwxyz0123456789", ["T1", "T2"]), ...many] },
      digests,
    );
    expect(out.map((item) => item.text)).toEqual(["Lesson one", "Lesson two", "Lesson three"]);
  });

  it("nominates a procedure only from a thread with an accepted, passing result", () => {
    const accepted = digest("src", { result: { accepted: 1, withdrawn: 0, acceptedNow: true } });
    const out = selectLessons({ lessons: [lesson("Do X then Y", ["T1", "T2"], "procedure")] }, [
      digest("t1"),
      accepted,
    ]);
    expect(out).toEqual([
      {
        target: "skill",
        text: "Do X then Y",
        evidence: [{ threadId: "src", eventSeq: 7 }],
        evidenceNamed: false,
      },
    ]);
    expect(selectLessons({ lessons: [lesson("Do X", ["T1"], "procedure")] }, digests)).toEqual([]);
  });
});
