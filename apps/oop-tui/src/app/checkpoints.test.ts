import { describe, expect, it } from "vite-plus/test";

import { makeActivity, makeMessage, makeThread, T0 } from "../testing/fixtures.ts";
import {
  checkpointGapText,
  diffTurn,
  parseDiffArgs,
  promptPreview,
  turnCountOf,
  undoPlan,
} from "./checkpoints.ts";

const END = "2026-10-30T09:05:00.000Z";
const LONG_AFTER = Date.parse(END) + 10 * 60_000;
const JUST_AFTER = Date.parse(END) + 5_000;

const checkpoint = (count: number, over: Record<string, unknown> = {}) => ({
  turnId: `turn-${count}`,
  checkpointTurnCount: count,
  checkpointRef: `refs/checkpoints/${count}`,
  status: "ready",
  files: [
    { path: "src/a.ts", kind: "modified", additions: 3, deletions: 1 },
    { path: "src/b.ts", kind: "added", additions: 10, deletions: 0 },
  ],
  assistantMessageId: `reply-${count}`,
  completedAt: END,
  ...over,
});

const turn = (count: number, state = "completed") => ({
  turnId: `turn-${count}`,
  state,
  requestedAt: T0,
  startedAt: T0,
  completedAt: state === "running" ? null : END,
  assistantMessageId: `reply-${count}`,
});

const messagesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => [
    makeMessage({ id: `ask-${index + 1}`, role: "user", text: `질문 ${index + 1}` }),
    makeMessage({ id: `reply-${index + 1}`, role: "assistant", text: `답 ${index + 1}` }),
  ]).flat();

const threadWith = (count: number, over: Record<string, unknown> = {}) =>
  makeThread({
    latestTurn: turn(count),
    checkpoints: Array.from({ length: count }, (_, index) => checkpoint(index + 1)),
    messages: messagesOf(count),
    ...over,
  });

describe("diffTurn", () => {
  it("picks the newest turn by default and a numbered one when asked", () => {
    const thread = threadWith(3);
    const newest = diffTurn(thread, null, LONG_AFTER);
    expect(newest.ok && newest.checkpoint.checkpointTurnCount).toBe(3);
    const second = diffTurn(thread, 2, LONG_AFTER);
    expect(second.ok && second.checkpoint.checkpointTurnCount).toBe(2);
  });

  it("explains a turn that is not there with the range that is", () => {
    const found = diffTurn(threadWith(3), 7, LONG_AFTER);
    expect(found).toEqual({
      ok: false,
      gap: { kind: "no-such-turn", turn: 7, first: 1, last: 3 },
    });
    expect(checkpointGapText((!found.ok && found.gap) as never)).toBe(
      "턴 7 의 체크포인트가 없습니다. 있는 턴은 1~3 입니다.",
    );
  });

  it("says there is no turn at all for a thread nothing has run in", () => {
    expect(diffTurn(makeThread(), null, LONG_AFTER)).toEqual({
      ok: false,
      gap: { kind: "no-turn" },
    });
  });

  it("says a thread has no checkpoints when its turns ended long ago without any", () => {
    const found = diffTurn(makeThread({ latestTurn: turn(1) }), null, LONG_AFTER);
    expect(found).toEqual({ ok: false, gap: { kind: "none" } });
    expect(checkpointGapText({ kind: "none" })).toContain("git");
  });

  it("calls a turn that ended a moment ago still being processed", () => {
    const found = diffTurn(makeThread({ latestTurn: turn(1) }), null, JUST_AFTER);
    expect(found).toEqual({ ok: false, gap: { kind: "processing" } });
  });

  it("does not show an older turn when the newest has no checkpoint yet", () => {
    const thread = makeThread({
      latestTurn: turn(2),
      checkpoints: [checkpoint(1)],
      messages: messagesOf(2),
    });
    expect(diffTurn(thread, null, JUST_AFTER)).toEqual({ ok: false, gap: { kind: "processing" } });
    expect(diffTurn(thread, null, LONG_AFTER)).toEqual({
      ok: false,
      gap: { kind: "capture-failed", detail: null },
    });
  });

  it("reports the server's reason when it recorded that the capture failed", () => {
    const thread = makeThread({
      latestTurn: turn(1),
      activities: [
        makeActivity({
          id: "f1",
          kind: "checkpoint.capture.failed",
          tone: "error",
          turnId: "turn-1",
          payload: { detail: "not a git repository\nsecond line" },
        }),
      ],
    });
    expect(diffTurn(thread, null, LONG_AFTER)).toEqual({
      ok: false,
      gap: { kind: "capture-failed", detail: "not a git repository" },
    });
  });

  it("ignores the checkpoint of a turn that is still running", () => {
    const thread = makeThread({
      latestTurn: turn(2, "running"),
      checkpoints: [checkpoint(1), checkpoint(2, { status: "missing" })],
      messages: messagesOf(2),
    });
    const found = diffTurn(thread, null, LONG_AFTER);
    expect(found.ok && found.checkpoint.checkpointTurnCount).toBe(1);
  });

  it("refuses a checkpoint that is not ready", () => {
    const thread = threadWith(2, {
      checkpoints: [checkpoint(1), checkpoint(2, { status: "missing" })],
    });
    expect(diffTurn(thread, null, LONG_AFTER)).toEqual({
      ok: false,
      gap: { kind: "unusable", turn: 2, status: "missing" },
    });
  });
});

describe("parseDiffArgs", () => {
  it("reads a leading number as the turn and the rest as one file", () => {
    expect(parseDiffArgs([])).toEqual({ turn: null, file: null });
    expect(parseDiffArgs(["2"])).toEqual({ turn: 2, file: null });
    expect(parseDiffArgs(["2", "src/a.ts"])).toEqual({ turn: 2, file: "src/a.ts" });
    expect(parseDiffArgs(["my", "file.ts"])).toEqual({ turn: null, file: "my file.ts" });
    expect(parseDiffArgs(["a.ts"])).toEqual({ turn: null, file: "a.ts" });
  });

  it("rejects turn zero", () => {
    expect(parseDiffArgs(["0"])).toEqual({ error: "턴 번호는 1 이상의 숫자입니다. 예: /diff 2" });
  });
});

describe("undoPlan", () => {
  it("rewinds to the turn before the newest and sums what that turn changed", () => {
    const found = undoPlan(threadWith(3, { worktreePath: "/wt" }), LONG_AFTER);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.plan).toEqual({
      turn: 3,
      target: 2,
      files: { count: 2, additions: 13, deletions: 1 },
      prompt: "질문 3",
      restore: "possible",
    });
  });

  it("allows no file restore in a folder the thread shares", () => {
    const found = undoPlan(threadWith(2), LONG_AFTER);
    expect(found.ok && found.plan.restore).toBe("shared-folder");
  });

  it("goes back to before the first turn when there is only one", () => {
    const found = undoPlan(threadWith(1, { worktreePath: "/wt" }), LONG_AFTER);
    expect(found.ok && [found.plan.target, found.plan.restore]).toEqual([0, "possible"]);
  });

  it("will not restore files to a checkpoint that is not usable", () => {
    const found = undoPlan(
      threadWith(2, {
        worktreePath: "/wt",
        checkpoints: [checkpoint(1, { status: "missing" }), checkpoint(2)],
      }),
      LONG_AFTER,
    );
    expect(found.ok && found.plan.restore).toBe("checkpoint-unusable");
  });

  it("takes off the ultrathink prefix from the prompt and finds none when it is blank", () => {
    const prefixed = threadWith(1, {
      messages: [
        makeMessage({ id: "ask-1", role: "user", text: "Ultrathink:\n깊게 생각해" }),
        makeMessage({ id: "reply-1", role: "assistant", text: "답" }),
      ],
    });
    const found = undoPlan(prefixed, LONG_AFTER);
    expect(found.ok && found.plan.prompt).toBe("깊게 생각해");
    const blank = threadWith(1, { messages: [makeMessage({ id: "reply-1", text: "답" })] });
    const none = undoPlan(blank, LONG_AFTER);
    expect(none.ok && none.plan.prompt).toBeNull();
  });

  it("explains instead of planning when there is no checkpoint", () => {
    expect(undoPlan(makeThread(), LONG_AFTER)).toEqual({ ok: false, gap: { kind: "no-turn" } });
    expect(undoPlan(makeThread({ latestTurn: turn(1) }), JUST_AFTER)).toEqual({
      ok: false,
      gap: { kind: "processing" },
    });
  });
});

describe("small helpers", () => {
  it("counts turns by the newest checkpoint", () => {
    expect(turnCountOf(makeThread())).toBe(0);
    expect(turnCountOf(threadWith(4))).toBe(4);
  });

  it("cuts a prompt to one short line", () => {
    expect(promptPreview("한 줄\n\n두 줄  사이")).toBe("한 줄 두 줄 사이");
    const long = promptPreview("가".repeat(200));
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });
});
