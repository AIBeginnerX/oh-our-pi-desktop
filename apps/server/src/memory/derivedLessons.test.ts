import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";

import {
  buildDigestPromptInput,
  lessonSimilarity,
  normalizeLessonText,
  selectDigestInputs,
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

describe("selectDigestInputs", () => {
  it("keeps large numeric usage counters and still filters secret-looking text", () => {
    const busy = digest("busy", {
      usage: { turns: 200, inputTokens: 123456789, outputTokens: 12345, costUsd: 10 },
    });
    const independent = digest("independent");
    const sensitive = digest("sensitive", {
      changedFiles: ["sk-abcdefghijklmnopqrstuvwxyz0123456789"],
    });
    const result = selectDigestInputs([busy, independent, sensitive]);
    expect(result.digestsWithSignals).toBe(3);
    expect(result.sensitiveFiltered).toBe(1);
    expect(result.promptDigests).toEqual([busy, independent]);
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

  it("drops a lesson that fewer than two distinct threads support", () => {
    expect(
      selectLessons({ lessons: [lesson("a", ["T1"]), lesson("b", ["T2", "T2"])] }, digests),
    ).toEqual([]);
  });

  it("shows repeated failures to the model without letting them meet the evidence minimum", () => {
    const failed = (id: string) =>
      digest(id, {
        checks: [{ name: "test", passed: 0, failed: 1, lastStatus: "failed" }],
        signals: [{ kind: "check-failed", eventSeq: 3, subject: "test" }],
      });
    const failures = [failed("t1"), failed("t2")];
    const output = { lessons: [lesson("Run test before merging", ["T1", "T2", "T3"])] };
    expect(selectDigestInputs(failures).promptDigests).toEqual(failures);
    expect(selectLessons(output, failures)).toEqual([]);
    expect(selectLessons(output, [...failures, digest("t3")])).toEqual([]);

    const [candidate] = selectLessons(output, [failed("t1"), digest("t2"), digest("t3")]);
    expect(candidate?.evidence).toEqual([
      { threadId: "t2", eventSeq: 7 },
      { threadId: "t3", eventSeq: 7 },
      { threadId: "t1", eventSeq: 3 },
    ]);
    expect(candidate?.evidenceNamed).toBe(true);
  });

  it("keeps a thread as support when the check the lesson names only failed there", () => {
    const accepted = (id: string) =>
      digest(id, {
        signals: [
          { kind: "check-failed", eventSeq: 3, subject: "lint" },
          { kind: "result-accepted", eventSeq: 7 },
        ],
      });
    const [candidate] = selectLessons({ lessons: [lesson("Run lint first", ["T1", "T2"])] }, [
      accepted("t1"),
      accepted("t2"),
    ]);
    expect(candidate?.evidence).toEqual([
      { threadId: "t1", eventSeq: 7 },
      { threadId: "t1", eventSeq: 3 },
      { threadId: "t2", eventSeq: 7 },
      { threadId: "t2", eventSeq: 3 },
    ]);
    expect(candidate?.evidenceNamed).toBe(false);
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
        evidence: [
          { threadId: "src", eventSeq: 7 },
          { threadId: "t1", eventSeq: 7 },
        ],
        evidenceNamed: false,
      },
    ]);
    expect(selectLessons({ lessons: [lesson("Do X", ["T1"], "procedure")] }, [accepted])).toEqual(
      [],
    );
  });
});
