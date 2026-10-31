import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_THEMES, createTheme } from "../render/theme.ts";
import { stripAnsi } from "../text/width.ts";
import { makeActivity, makeThread } from "../testing/fixtures.ts";
import type { UndoPlan } from "./checkpoints.ts";
import { undoChoices, undoItems, undoSummary, UndoTracker } from "./undoFlow.ts";

const theme = createTheme("oop", BUILTIN_THEMES.oop, 0);

const plan = (over: Partial<UndoPlan> = {}): UndoPlan => ({
  turn: 3,
  target: 2,
  files: { count: 4, additions: 20, deletions: 5 },
  prompt: "로그인 고쳐줘",
  restore: "possible",
  ...over,
});

const checkpointAt = (count: number) => ({
  turnId: `turn-${count}`,
  checkpointTurnCount: count,
  checkpointRef: `refs/c/${count}`,
  status: "ready",
  files: [],
  assistantMessageId: null,
  completedAt: "2026-10-30T09:05:00.000Z",
});

const threadAt = (turns: number, activities: ReturnType<typeof makeActivity>[] = []) =>
  makeThread({
    checkpoints: Array.from({ length: turns }, (_, index) => checkpointAt(index + 1)),
    activities,
  });

const THREAD = threadAt(1).id;

const failure = (id: string, detail?: string) =>
  makeActivity({
    id,
    kind: "checkpoint.revert.failed",
    tone: "error",
    payload: detail === undefined ? {} : { detail },
  });

describe("the confirmation", () => {
  it("opens on cancel, and offers the file restore only when it is possible", () => {
    expect(undoChoices(plan())).toEqual(["cancel", "files", "conversation"]);
    expect(undoChoices(plan({ restore: "shared-folder" }))).toEqual(["cancel", "conversation"]);
    expect(undoItems(plan())[0]?.label).toBe("취소");
    expect(undoItems(plan({ restore: "checkpoint-unusable" })).map((item) => item.label)).toEqual([
      "취소",
      "대화 되돌리기",
    ]);
  });

  it("states the turn, the files, the conversation and that there is no way back", () => {
    const text = undoSummary(plan(), theme, 200).map(stripAnsi).join("\n");
    expect(text).toContain("턴 3: 로그인 고쳐줘");
    expect(text).toContain("파일 4개 (+20 -5)");
    expect(text).toContain(
      "대화: 이 턴의 질문과 답변이 대화에서 지워집니다. 질문은 입력창으로 돌아옵니다.",
    );
    expect(text).toContain("턴 2 이 끝난 상태");
    expect(text).toContain("되돌린 것을 다시 되돌리는 기능은 데스크톱 앱에도 없습니다.");
  });

  it("says the files stay when the folder is shared, and points to /diff", () => {
    const text = undoSummary(plan({ restore: "shared-folder" }), theme, 70)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("파일: 그대로 둡니다");
    expect(text).toContain("/diff 3");
    expect(text).not.toContain("폴더 전체가");
  });

  it("describes going back to before the first turn", () => {
    const text = undoSummary(plan({ turn: 1, target: 0 }), theme, 70)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("이 스레드를 시작하기 전 상태");
  });

  it("folds every row into the room it has", () => {
    for (const row of undoSummary(plan(), theme, 30)) {
      expect(Array.from(stripAnsi(row)).length).toBeLessThanOrEqual(30);
    }
  });
});

describe("UndoTracker", () => {
  const send = (tracker: UndoTracker, thread = threadAt(3), now = 0) =>
    tracker.start({ thread, plan: plan(), restoreFiles: true, now });

  it("does not run out while the thread is off screen, and counts its minute from the way back", () => {
    const tracker = new UndoTracker();
    send(tracker);
    tracker.leave(THREAD);
    expect(tracker.active(THREAD, 600_000)).toBe(true);
    tracker.arrive(THREAD, 600_000);
    expect(tracker.active(THREAD, 659_999)).toBe(true);
    expect(tracker.active(THREAD, 660_000)).toBe(false);
  });

  it("is done once the thread has fallen back to the target turn", () => {
    const tracker = new UndoTracker();
    send(tracker);
    expect(tracker.active(THREAD, 1)).toBe(true);
    expect(tracker.observe(threadAt(3))).toBeNull();
    expect(tracker.observe(threadAt(2))).toEqual({
      kind: "done",
      plan: plan(),
      restoreFiles: true,
    });
    expect(tracker.active(THREAD, 2)).toBe(false);
    expect(tracker.observe(threadAt(2))).toBeNull();
  });

  it("fails on a revert failure that was not there when it was sent", () => {
    const tracker = new UndoTracker();
    send(tracker, threadAt(3, [failure("old")]));
    expect(tracker.observe(threadAt(3, [failure("old")]))).toBeNull();
    expect(tracker.observe(threadAt(3, [failure("old"), failure("new", "dirty\nmore")]))).toEqual({
      kind: "failed",
      detail: "dirty",
      restoreFiles: true,
    });
    expect(tracker.active(THREAD, 1)).toBe(false);
  });

  it("gives up waiting after a minute and when told the request never arrived", () => {
    const tracker = new UndoTracker();
    send(tracker);
    expect(tracker.active(THREAD, 59_999)).toBe(true);
    expect(tracker.active(THREAD, 60_000)).toBe(false);
    send(tracker);
    tracker.drop();
    expect(tracker.active(THREAD, 1)).toBe(false);
  });

  it("holds only the thread it was sent for", () => {
    const tracker = new UndoTracker();
    send(tracker);
    expect(tracker.active(THREAD, 1)).toBe(true);
    expect(tracker.active("other" as typeof THREAD, 1)).toBe(false);
  });

  it("does not read another thread's answer as its own", () => {
    const tracker = new UndoTracker();
    send(tracker);
    expect(tracker.observe(makeThread({ id: "other", checkpoints: [] }))).toBeNull();
    expect(tracker.active(THREAD, 1)).toBe(true);
  });
});
