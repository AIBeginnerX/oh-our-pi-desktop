import { describe, expect, it } from "vite-plus/test";

import { buildThreadHandoffSeed, THREAD_HANDOFF_SEED_MAX_CHARS } from "./threadHandoffSeed.ts";

type Facts = Parameters<typeof buildThreadHandoffSeed>[0]["thread"];

const message = (role: "user" | "assistant", text: string, n: number) =>
  ({
    id: `m${n}`,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as Facts["messages"][number];

const checkpoint = (count: number, paths: ReadonlyArray<string>, status = "ready") =>
  ({
    turnId: `t${count}`,
    checkpointTurnCount: count,
    checkpointRef: `ref${count}`,
    status,
    files: paths.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as Facts["checkpoints"][number];

const plan = (sequence: number, steps: ReadonlyArray<[string, string]>) =>
  ({
    id: `a${sequence}`,
    tone: "info",
    kind: "turn.plan.updated",
    summary: "plan",
    payload: { plan: steps.map(([step, status]) => ({ step, status })) },
    turnId: null,
    sequence,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as Facts["activities"][number];

const base = (over: Partial<Facts> = {}): Facts => ({
  id: "thread-1" as Facts["id"],
  title: "Fix login" as Facts["title"],
  messages: [],
  checkpoints: [],
  activities: [],
  ...over,
});

describe("buildThreadHandoffSeed", () => {
  it("has only the header and closing line for an empty thread", () => {
    const seed = buildThreadHandoffSeed({ thread: base(), goalText: null });
    expect(seed).toContain('Continuing from thread "Fix login" (id: thread-1)');
    expect(seed).not.toMatch(/Goal:|Last result:|Changed files:|Open items:/);
    expect(seed).toContain("Read files by path");
  });

  it("prefers the goal, falling back to the first user message", () => {
    const messages = [message("user", "first ask", 1), message("assistant", "done it", 2)];
    const withGoal = buildThreadHandoffSeed({
      thread: base({ messages }),
      goalText: "ship the fix",
    });
    expect(withGoal).toContain("Goal: ship the fix");
    expect(withGoal).toContain("Last result: done it");
    const without = buildThreadHandoffSeed({ thread: base({ messages }), goalText: null });
    expect(without).toContain("Goal: first ask");
  });

  it("lists changed files newest first, once each, at most 20", () => {
    const checkpoints = [
      checkpoint(1, ["a.ts", "shared.ts"]),
      checkpoint(2, Array.from({ length: 30 }, (_, i) => `f${i}.ts`).concat("shared.ts")),
      checkpoint(3, ["skipped.ts"], "missing"),
    ];
    const seed = buildThreadHandoffSeed({ thread: base({ checkpoints }), goalText: null });
    const lines = seed.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("- f0.ts");
    expect(seed).not.toContain("skipped.ts");
    expect(seed).not.toContain("a.ts");
  });

  it("lists only unfinished steps of the latest plan", () => {
    const activities = [
      plan(1, [["old step", "pending"]]),
      plan(2, [
        ["done step", "completed"],
        ["next step", "in_progress"],
      ]),
    ];
    const seed = buildThreadHandoffSeed({ thread: base({ activities }), goalText: null });
    expect(seed).toContain("Open items:\n- next step");
    expect(seed).not.toContain("old step");
    expect(seed).not.toContain("done step");
    const allDone = buildThreadHandoffSeed({
      thread: base({ activities: [plan(1, [["x", "completed"]])] }),
      goalText: null,
    });
    expect(allDone).not.toContain("Open items:");
  });

  it("stays under the cap and is deterministic", () => {
    const long = "word ".repeat(2_000);
    const thread = base({
      title: long as Facts["title"],
      messages: [message("user", long, 1), message("assistant", long, 2)],
      checkpoints: [
        checkpoint(
          1,
          Array.from({ length: 25 }, (_, i) => `${long.slice(0, 300)}${i}`),
        ),
      ],
      activities: [
        plan(
          1,
          Array.from({ length: 20 }, (_, i) => [`${long}${i}`, "pending"] as [string, string]),
        ),
      ],
    });
    const seed = buildThreadHandoffSeed({ thread, goalText: long });
    expect(seed.length).toBeLessThanOrEqual(THREAD_HANDOFF_SEED_MAX_CHARS);
    expect(buildThreadHandoffSeed({ thread, goalText: long })).toBe(seed);
  });
});
