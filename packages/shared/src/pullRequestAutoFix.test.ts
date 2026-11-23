import { describe, expect, it } from "vite-plus/test";
import {
  PULL_REQUEST_AUTO_FIX_ACTIVITY as activity,
  pullRequestAutoFixDecision,
  pullRequestAutoFixProgress,
  pullRequestAutoFixPrompt,
  pullRequestAutoFixTarget,
  stampPullRequestAutoFixPatch,
} from "./pullRequestAutoFix.ts";

const url = "https://github.com/oop/oop/pull/42";
const date = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
const entry = (kind: string, day: number, headSha?: string) => ({
  kind,
  createdAt: date(day),
  payload: { url, headSha },
});

describe("pull request auto-fix", () => {
  it("counts the current streak but remembers older heads even after re-enabling or passing", () => {
    const entries = [
      entry(activity.started, 5, "e"),
      entry(activity.exhausted, 3),
      entry(activity.started, 1, "a"),
      entry(activity.started, 2, "b"),
      entry(activity.passed, 4),
      { ...entry(activity.started, 5, "other"), payload: { url: "other", headSha: "other" } },
    ];
    expect(pullRequestAutoFixProgress(url, date(2), entries)).toEqual({
      attempts: 1,
      exhausted: false,
      attemptedHeads: new Set(["a", "b", "e"]),
    });
    expect(pullRequestAutoFixProgress(url, date(6), entries).attempts).toBe(0);
  });

  it("reads the attempt number an activity recorded when older ones are out of view", () => {
    const newest = {
      ...entry(activity.started, 3, "c"),
      payload: { url, headSha: "c", attempt: 3 },
    };
    expect(pullRequestAutoFixProgress(url, date(1), [newest]).attempts).toBe(3);
  });

  it("watches only the open pull request headed by the thread's own branch", () => {
    const link = (number: number, headBranch: string, state: "open" | "merged" = "open") => ({
      host: "github.com" as const,
      repository: "oop/oop",
      number,
      url: `https://github.com/oop/oop/pull/${number}`,
      source: "manual" as const,
      linkedAt: date(number),
      snapshot: {
        state,
        isDraft: false,
        title: "title",
        headBranch,
        baseBranch: "main",
        updatedAt: date(1),
        syncedAt: date(1),
        checksState: "failing" as const,
      },
      stack: null,
    });
    const links = [link(1, "mine"), link(2, "theirs"), link(3, "mine", "merged")];
    expect(pullRequestAutoFixTarget(links, "mine")?.number).toBe(1);
    expect(pullRequestAutoFixTarget(links, "nobody")).toBeNull();
    // Without a recorded branch the thread's current open pull request is the target.
    expect(pullRequestAutoFixTarget(links, null)?.number).toBe(2);
    expect(pullRequestAutoFixTarget([{ ...link(4, "mine"), snapshot: null }], "mine")).toBeNull();
  });

  it("stamps the server's time on a switch that moved and ignores the client's clock", () => {
    const stored = {
      on: { enabled: true, setAt: date(1) },
      off: { enabled: false, setAt: date(1) },
    };
    const fromClient = { enabled: true, setAt: "2099-01-01T00:00:00.000Z" };
    expect(
      stampPullRequestAutoFixPatch(
        stored,
        { on: fromClient, off: fromClient, fresh: fromClient },
        date(5),
      ),
    ).toEqual({
      // Sent again without moving: the run it belongs to keeps its start.
      on: { enabled: true, setAt: date(1) },
      off: { enabled: true, setAt: date(5) },
      fresh: { enabled: true, setAt: date(5) },
    });
  });

  it("only inspects failing checks within the attempt limit and accepts a reset after exhaustion", () => {
    const entries = [1, 2, 3].map((day) => entry(activity.started, day, String(day)));
    const progress = pullRequestAutoFixProgress(url, date(1), entries);
    const exhausted = pullRequestAutoFixProgress(url, date(1), [
      ...entries,
      entry(activity.exhausted, 4),
    ]);
    expect(pullRequestAutoFixDecision("failing", { ...progress, attempts: 2 })).toBe("inspect");
    expect(pullRequestAutoFixDecision("pending", progress)).toBe("skip");
    expect(pullRequestAutoFixDecision("failing", progress)).toBe("exhausted");
    expect(pullRequestAutoFixDecision("failing", exhausted)).toBe("skip");
    expect(pullRequestAutoFixDecision("passing", exhausted)).toBe("passed");
  });

  it("quotes single-line bounded failure data and omits cancelled checks", () => {
    const failures = Array.from({ length: 21 }, (_, index) => ({
      name: `job-${index}\nnew\tline"`,
      status: "failure" as const,
      description: "x".repeat(400),
      url: null,
    }));
    const prompt = pullRequestAutoFixPrompt(42, "feature\n/x", "0123456789abcdef", 2, [
      { name: "cancelled", status: "cancelled", description: null, url: null },
      ...failures,
    ]);
    expect(prompt.split("\n")[0]).toBe("PR auto-fix · #42 · attempt 2/3");
    expect(prompt).toContain("checks failed on commit 0123456789ab");
    expect(prompt).toContain('push it to the PR\'s branch "feature /x" with a normal push');
    expect(prompt).toContain(JSON.stringify('job-0 new line"'));
    expect(prompt.match(/^> /gm)).toHaveLength(20);
    expect(prompt).not.toContain("x".repeat(321));
    expect(prompt).not.toContain("cancelled");
  });
});
