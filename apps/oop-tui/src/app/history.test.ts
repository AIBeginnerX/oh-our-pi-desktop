import type { OrchestrationProposedPlan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeActivity, makeMessage, makeThread } from "../testing/fixtures.ts";
import {
  addHistoryPage,
  HISTORY_DEFAULT,
  HISTORY_MAX,
  historyLeft,
  openHistoryPool,
  parseHistoryCount,
  takeHistoryBatch,
} from "./history.ts";

const at = (second: number) => `2026-10-30T09:00:${String(second).padStart(2, "0")}.000Z`;
const message = (n: number) =>
  makeMessage({
    id: `m${n}`,
    role: n % 2 === 1 ? "user" : "assistant",
    text: `m${n}`,
    createdAt: at(n),
  });
const tool = (n: number) => makeActivity({ id: `a${n}`, kind: "tool.completed", createdAt: at(n) });
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);
const plan = (n: number): OrchestrationProposedPlan => ({
  id: `p${n}` as OrchestrationProposedPlan["id"],
  turnId: null,
  planMarkdown: `# 계획 ${n}`,
  createdAt: at(n),
  updatedAt: at(n),
  implementedAt: null,
  implementationThreadId: null,
});

const page = (messages: number[], activities: number[], cursor: string | null) =>
  ({
    snapshotSequence: 1,
    thread: makeThread({ messages: messages.map(message), activities: activities.map(tool) }),
    page: { beforeCursor: cursor, hasMore: cursor !== null, snapshotSequence: 1 },
  }) as Parameters<typeof addHistoryPage>[1];

describe("history pool", () => {
  it("starts with the loaded messages the opening skipped, and the activities before the printed part", () => {
    const thread = makeThread({
      messages: [1, 2, 3, 4, 5, 6].map(message),
      activities: [tool(1), tool(3), tool(5)],
    });
    const pool = openHistoryPool(thread, 3, "c1");
    expect(ids(pool.messages)).toEqual(["m1", "m2", "m3"]);
    expect(ids(pool.activities)).toEqual(["a1", "a3"]);
    expect(pool.cursor).toBe("c1");
    expect(historyLeft(pool)).toBe(true);
  });

  it("reads back from the newest end, taking the tools between the batch and what was printed", () => {
    const thread = makeThread({
      messages: [1, 2, 3, 4, 5, 6].map(message),
      activities: [tool(1), tool(3), tool(5)],
    });
    const pool = openHistoryPool(thread, 4, null);
    const first = takeHistoryBatch(pool, 2);
    expect(ids(first.messages)).toEqual(["m3", "m4"]);
    expect(ids(first.activities)).toEqual(["a3"]);
    const second = takeHistoryBatch(pool, 5);
    expect(ids(second.messages)).toEqual(["m1", "m2"]);
    expect(ids(second.activities)).toEqual(["a1"]);
    expect(historyLeft(pool)).toBe(false);
  });

  it("puts a fetched page in front, once, and follows its cursor", () => {
    const thread = makeThread({ messages: [5, 6].map(message) });
    const pool = openHistoryPool(thread, 1, "c1");
    addHistoryPage(pool, page([2, 3, 4], [3], "c2"));
    expect(ids(pool.messages)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(ids(pool.activities)).toEqual(["a3"]);
    expect(pool.cursor).toBe("c2");
    addHistoryPage(pool, page([1, 2], [], null));
    expect(ids(pool.messages)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(pool.cursor).toBeNull();
  });

  it("stops asking when a page brings nothing new or hands back the same cursor", () => {
    const pool = openHistoryPool(makeThread({ messages: [3, 4].map(message) }), 1, "c1");
    addHistoryPage(pool, page([], [], "c2"));
    expect(pool.cursor).toBeNull();
    const again = openHistoryPool(makeThread({ messages: [3, 4].map(message) }), 1, "c1");
    addHistoryPage(again, page([2], [], "c1"));
    expect(again.cursor).toBeNull();
  });

  it("hands over only the plans written in the stretch it prints, never one already on screen", () => {
    const thread = makeThread({
      messages: [1, 2, 3, 4, 5, 6].map(message),
      proposedPlans: [plan(1), plan(3), plan(5)],
    });
    // The opening printed from message 4 on, so the plan at 5 is already in the scrollback.
    const pool = openHistoryPool(thread, 3, null);
    expect(ids(pool.plans)).toEqual(["p1", "p3"]);
    const first = takeHistoryBatch(pool, 1);
    expect(ids(first.plans)).toEqual(["p3"]);
    expect(ids(takeHistoryBatch(pool, 5).plans)).toEqual(["p1"]);
    expect(pool.plans).toEqual([]);
  });

  it("leaves the plans to the opening: the server sends every plan with each page, the ones on screen too", () => {
    const thread = makeThread({
      messages: [1, 2, 3, 4, 5, 6].map(message),
      proposedPlans: [plan(1), plan(5)],
    });
    const pool = openHistoryPool(thread, 3, "c1");
    expect(ids(pool.plans)).toEqual(["p1"]);
    const fetched = page([2, 3], [], "c2");
    (fetched.thread as { proposedPlans: unknown }).proposedPlans = [plan(1), plan(5)];
    addHistoryPage(pool, fetched);
    addHistoryPage(pool, fetched);
    expect(ids(pool.plans)).toEqual(["p1"]);
    expect(ids(takeHistoryBatch(pool, 10).plans)).toEqual(["p1"]);
  });

  it("takes every activity before the first message once nothing older is left", () => {
    const thread = makeThread({ messages: [2, 3].map(message), activities: [tool(1)] });
    const pool = openHistoryPool(thread, 1, null);
    expect(ids(takeHistoryBatch(pool, 5).activities)).toEqual(["a1"]);
  });
});

describe("parseHistoryCount", () => {
  it("defaults, cuts to the most, and refuses anything that is not a count", () => {
    expect(parseHistoryCount(undefined)).toBe(HISTORY_DEFAULT);
    expect(parseHistoryCount("12")).toBe(12);
    expect(parseHistoryCount("99999")).toBe(HISTORY_MAX);
    expect(parseHistoryCount("0")).toBeNull();
    expect(parseHistoryCount("-3")).toBeNull();
    expect(parseHistoryCount("many")).toBeNull();
  });
});
