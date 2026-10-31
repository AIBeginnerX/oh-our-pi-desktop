import { describe, expect, it } from "vite-plus/test";

import type { CrewBoard, CrewTask } from "../app/crewBoard.ts";
import {
  boardSummary,
  crewBarText,
  crewStatusWord,
  phaseWord,
  taskDetail,
  taskHeadline,
  taskNote,
} from "./crewBoard.ts";

const task = (over: Partial<CrewTask> = {}): CrewTask => ({
  taskId: "t1",
  role: "worker",
  title: "파서 고치기",
  model: "Haiku 4",
  phase: "running",
  unreported: false,
  threadId: null,
  summary: null,
  startedAt: 1_000_000,
  completedAt: null,
  tokens: null,
  costUsd: null,
  evidence: null,
  actions: { stop: false, open: false, retry: false },
  ...over,
});

const board = (tasks: ReadonlyArray<CrewTask>, over: Partial<CrewBoard> = {}): CrewBoard => ({
  turnId: "turn-1",
  current: true,
  tasks,
  notes: [],
  running: tasks.filter((entry) => entry.phase === "running").length,
  settled: tasks.filter((entry) => entry.phase !== "running").length,
  usage: null,
  ...over,
});

describe("a crew task row", () => {
  it("names the role, the state and the task, then the model, the time and the usage", () => {
    const running = task();
    expect(taskHeadline(running)).toBe("Worker  진행 중 · 파서 고치기");
    expect(taskNote(running, 1_000_000 + 65_000)).toBe("Haiku 4 · 1m 05s");
    const done = task({
      phase: "completed",
      completedAt: 1_012_000,
      tokens: 12_400,
      costUsd: 0.034,
    });
    expect(taskNote(done, 9_999_999)).toBe("Haiku 4 · 12s · 12.4k 토큰 · $0.03");
  });

  it("says a stopped task with no report apart from one that was stopped with its report", () => {
    expect(phaseWord(task({ phase: "stopped", unreported: true }))).toBe("중단됨 · 보고 없음");
    expect(phaseWord(task({ phase: "stopped" }))).toBe("중단됨");
    expect(phaseWord(task({ phase: "blocked" }))).toBe("차단됨");
    expect(crewStatusWord("partial")).toBe("일부 완료");
    expect(crewStatusWord("bogus")).toBeNull();
  });

  it("lists everything the task has on its detail screen, and which request it waits for", () => {
    const detail = taskDetail(
      task({
        phase: "completed",
        completedAt: 1_005_000,
        summary: "고쳤습니다",
        evidence: "audited",
        tokens: 800,
      }),
      0,
      "approval",
    );
    expect(detail).toEqual([
      ["작업", "파서 고치기"],
      ["역할", "Worker"],
      ["상태", "완료 · 승인 대기"],
      ["모델", "Haiku 4"],
      ["경과", "5s"],
      ["사용량", "800 토큰"],
      ["근거", "감사 승인"],
      ["요약", "고쳤습니다"],
    ]);
  });
});

describe("the crew in the status bar", () => {
  const running = board([task(), task({ taskId: "t2", phase: "completed" })]);

  it("counts the tasks that ended out of all of them while one runs", () => {
    expect(crewBarText({ on: true, board: running, waiting: 0 })).toBe("crew 1/2");
  });

  it("says only that the crew is on when nothing runs, and nothing when it is off", () => {
    const settled = board([task({ phase: "completed" })]);
    expect(crewBarText({ on: true, board: settled, waiting: 0 })).toBe("crew");
    expect(crewBarText({ on: false, board: null, waiting: 0 })).toBeNull();
  });

  it("names a request that waits for the user before anything else", () => {
    expect(crewBarText({ on: false, board: running, waiting: 2 })).toBe("crew 승인·질문 대기 2");
  });

  it("sums a board up in one line", () => {
    expect(boardSummary(board([task()], { usage: { tokens: 2500, costUsd: 0.5 } }))).toBe(
      "이번 턴 · 작업 1개 · 진행 1 · 2.5k 토큰 · $0.50",
    );
    expect(boardSummary(board([task({ phase: "failed" })], { current: false }))).toBe(
      "이전 턴 · 작업 1개 · 끝남 1",
    );
  });
});
