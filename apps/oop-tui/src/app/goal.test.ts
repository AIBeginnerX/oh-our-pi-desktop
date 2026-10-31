import type { OrchestrationThread, ThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeActivity, makeMessage, makeThread, T0 } from "../testing/fixtures.ts";
import {
  goalBarText,
  goalsWith,
  goalsWithout,
  goalViewOf,
  makeGoal,
  parseGoalMax,
} from "./goal.ts";

const goal = (over: Partial<ThreadGoal> = {}): ThreadGoal => ({
  id: "goal-1",
  text: "테스트 통과",
  maxContinues: 5,
  active: true,
  setAt: T0,
  ...over,
});

const goalActivity = (kind: string, id: string, payload: Record<string, unknown> = {}) =>
  makeActivity({
    id,
    kind,
    tone: "info",
    summary: kind,
    payload: { goalId: "goal-1", turnId: `turn-${id}`, ...payload },
    createdAt: "2026-10-30T09:05:00.000Z",
  });

const threadWith = (kinds: Array<[string, Record<string, unknown>?]>): OrchestrationThread =>
  makeThread({
    activities: kinds.map(([kind, payload], index) => goalActivity(kind, `a${index}`, payload)),
  });

describe("makeGoal", () => {
  it("is a new active goal with the default count, set now", () => {
    expect(makeGoal({ text: "  목표  ", id: "g", now: new Date(T0) })).toEqual({
      id: "g",
      text: "목표",
      maxContinues: 5,
      active: true,
      setAt: T0,
    });
    expect(makeGoal({ text: "x", id: "g", now: new Date(T0), maxContinues: 9 }).maxContinues).toBe(
      9,
    );
  });
});

describe("goal records", () => {
  it("sets one thread's goal and leaves the others", () => {
    const next = goalsWith({ other: goal({ id: "o" }) } as never, "t1" as never, goal());
    expect(Object.keys(next)).toEqual(["other", "t1"]);
  });

  it("removes the key when a goal is cleared", () => {
    const next = goalsWithout({ t1: goal(), t2: goal({ id: "x" }) } as never, "t1" as never);
    expect(Object.keys(next)).toEqual(["t2"]);
  });
});

describe("parseGoalMax", () => {
  it("accepts whole numbers from 1 to 20 only", () => {
    expect(parseGoalMax("1")).toBe(1);
    expect(parseGoalMax("20")).toBe(20);
    for (const bad of ["0", "21", "-1", "2.5", "five", "", "1e1"])
      expect(parseGoalMax(bad)).toBeNull();
  });
});

describe("goalViewOf", () => {
  it("counts the continuations of this goal only", () => {
    const thread = makeThread({
      activities: [
        goalActivity("goal.continued", "a1"),
        goalActivity("goal.continued", "a2"),
        { ...goalActivity("goal.continued", "a3"), payload: { goalId: "another", turnId: "t9" } },
      ],
    });
    expect(goalViewOf(goal(), thread, false)).toEqual({
      state: "working",
      continues: 2,
      partial: false,
    });
  });

  it("follows the server's verdict: met, blocked with its reason, exhausted as stopped", () => {
    expect(goalViewOf(goal(), threadWith([["goal.met"]]), false).state).toBe("met");
    const blocked = goalViewOf(
      goal(),
      threadWith([["goal.blocked", { reason: "권한 없음" }]]),
      false,
    );
    expect(blocked).toMatchObject({ state: "blocked", reason: "권한 없음" });
    expect(goalViewOf(goal(), threadWith([["goal.exhausted"]]), false).state).toBe("stopped");
  });

  it("shows an inactive goal as stopped", () => {
    expect(goalViewOf(goal({ active: false }), threadWith([]), false).state).toBe("stopped");
  });

  it("says the count is at least that when older turns were not loaded", () => {
    const later = makeThread({
      messages: [makeMessage({ id: "m1", createdAt: "2026-10-30T10:00:00.000Z" })],
      activities: [],
    });
    expect(goalViewOf(goal(), later, true).partial).toBe(true);
    expect(goalViewOf(goal(), later, false).partial).toBe(false);
    // A window that starts before the goal was set misses nothing.
    const early = makeThread({
      messages: [makeMessage({ id: "m1", createdAt: "2026-10-30T08:00:00.000Z" })],
    });
    expect(goalViewOf(goal(), early, true).partial).toBe(false);
  });
});

describe("goalBarText", () => {
  it("shows the progress, the + for a partial count, the verdict, and ? when not loaded", () => {
    expect(goalBarText(goal(), { state: "working", continues: 2, partial: false })).toBe(
      "목표 2/5",
    );
    expect(goalBarText(goal(), { state: "working", continues: 2, partial: true })).toBe(
      "목표 2+/5",
    );
    expect(goalBarText(goal(), { state: "met", continues: 3, partial: false })).toBe("목표 완료");
    expect(goalBarText(goal(), { state: "blocked", continues: 1, partial: false })).toBe(
      "목표 차단",
    );
    expect(goalBarText(goal(), { state: "stopped", continues: 5, partial: false })).toBe(
      "목표 중지",
    );
    expect(goalBarText(goal(), null)).toBe("목표 ?/5");
  });
});
