import { describe, expect, it } from "vite-plus/test";

import { makeActivity, makeSession, makeThread, makeThreadShell } from "../testing/fixtures.ts";
import {
  crewSubThreadLabel,
  deriveCrewBoard,
  isCrewSubThread,
  listedThreads,
  waitingCrewThreads,
  waitingText,
} from "./crewBoard.ts";

const TURN = "turn-1";

const at = (second: number) => `2026-10-30T09:00:${String(second).padStart(2, "0")}.000Z`;

const taskActivity = (
  id: string,
  kind: "task.started" | "task.completed",
  second: number,
  payload: Record<string, unknown>,
  turnId = TURN,
) =>
  makeActivity({
    id,
    kind,
    summary: kind,
    turnId,
    createdAt: at(second),
    payload: { agentKind: "agent", ...payload },
  });

const leadThread = (activities: ReadonlyArray<ReturnType<typeof makeActivity>>, running: boolean) =>
  makeThread({
    id: "lead",
    session: makeSession(running ? "running" : "idle", {
      threadId: "lead",
      activeTurnId: running ? TURN : null,
    }),
    latestTurn: {
      turnId: TURN,
      state: running ? "running" : "completed",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: running ? null : at(50),
      assistantMessageId: null,
    },
    activities,
  });

describe("deriveCrewBoard", () => {
  it("is null for a thread that never used the crew", () => {
    expect(
      deriveCrewBoard(
        leadThread([makeActivity({ id: "a", kind: "tool.completed", turnId: TURN })], true),
        true,
      ),
    ).toBeNull();
  });

  it("reads each task's state, model, time and summary from the lead's activities", () => {
    const thread = leadThread(
      [
        taskActivity("s1", "task.started", 1, {
          taskId: "t1",
          title: "파서 고치기",
          crewRole: "worker",
          threadId: "sub-1",
          model: "Haiku 4",
          status: "running",
        }),
        taskActivity("s2", "task.started", 2, {
          taskId: "t2",
          title: "구조 설계",
          crewRole: "expert",
          threadId: "sub-2",
          model: "Opus 4",
          status: "running",
        }),
        taskActivity("c1", "task.completed", 11, {
          taskId: "t1",
          title: "파서 고치기",
          crewRole: "worker",
          threadId: "sub-1",
          model: "Haiku 4",
          status: "completed",
          summary: "파서의 경계 조건을 고쳤습니다.\n둘째 줄",
          tested: true,
        }),
      ],
      true,
    );
    const board = deriveCrewBoard(thread, true);
    expect(board).not.toBeNull();
    expect(board?.current).toBe(true);
    expect(board?.running).toBe(1);
    expect(board?.settled).toBe(1);
    const [worker, expert] = board?.tasks ?? [];
    expect(worker).toMatchObject({
      taskId: "t1",
      role: "worker",
      title: "파서 고치기",
      model: "Haiku 4",
      phase: "completed",
      threadId: "sub-1",
      summary: "파서의 경계 조건을 고쳤습니다.",
      unreported: false,
    });
    expect(worker?.startedAt).toBe(Date.parse(at(1)));
    expect(worker?.completedAt).toBe(Date.parse(at(11)));
    expect(worker?.evidence).toBe("tested");
    expect(worker?.actions).toEqual({ stop: false, open: true, retry: false });
    expect(expert).toMatchObject({ role: "expert", phase: "running" });
    expect(expert?.actions).toEqual({ stop: true, open: true, retry: false });
  });

  it("keeps failed, blocked and partial tasks on the board, and offers a retry for them", () => {
    const thread = leadThread(
      ["failed", "blocked", "partial"].flatMap((status, index) => [
        taskActivity(`s${index}`, "task.started", index, {
          taskId: `t-${status}`,
          title: status,
          crewRole: "worker",
          threadId: `sub-${status}`,
        }),
        taskActivity(`c${index}`, "task.completed", 20 + index, {
          taskId: `t-${status}`,
          title: status,
          crewRole: "worker",
          threadId: `sub-${status}`,
          status,
        }),
      ]),
      false,
    );
    const board = deriveCrewBoard(thread, false);
    expect(board?.tasks.map((task) => task.phase)).toEqual(["failed", "blocked", "partial"]);
    expect(board?.tasks.every((task) => task.actions.retry)).toBe(true);
    expect(board?.current).toBe(true);
  });

  it("reads a task that never reported, once the turn is over, as stopped without a report", () => {
    const activities = [
      taskActivity("s1", "task.started", 1, {
        taskId: "t1",
        title: "끝나지 않은 일",
        crewRole: "worker",
        threadId: "sub-1",
      }),
    ];
    expect(deriveCrewBoard(leadThread(activities, true), true)?.tasks[0]?.phase).toBe("running");
    const ended = deriveCrewBoard(leadThread(activities, false), false)?.tasks[0];
    expect(ended).toMatchObject({ phase: "stopped", unreported: true });
  });

  it("says the audit was left out, and that the lead got a follow-up, as notes of the turn", () => {
    const thread = leadThread(
      [
        taskActivity("s1", "task.started", 1, {
          taskId: "t1",
          crewRole: "worker",
          threadId: "sub-1",
        }),
        makeActivity({
          id: "skip",
          kind: "crew.audit-skipped",
          turnId: TURN,
          createdAt: at(5),
          payload: { changedFiles: 2 },
        }),
        makeActivity({
          id: "fu",
          kind: "crew.follow-up",
          turnId: TURN,
          createdAt: at(6),
          payload: { reason: "audit" },
        }),
      ],
      true,
    );
    const notes = deriveCrewBoard(thread, true)?.notes ?? [];
    expect(notes.map((note) => note.kind)).toEqual(["audit-skipped", "follow-up"]);
    expect(notes[0]?.text).toContain("감사 생략");
    expect(notes[0]?.text).toContain("파일 2개");
    expect(notes[1]?.text).toContain("수정을 요청");
  });

  it("marks the board of an earlier turn as not current", () => {
    const thread = makeThread({
      id: "lead",
      session: makeSession("idle", { threadId: "lead" }),
      latestTurn: {
        turnId: "turn-2",
        state: "completed",
        requestedAt: at(30),
        startedAt: at(30),
        completedAt: at(40),
        assistantMessageId: null,
      },
      activities: [
        taskActivity("s1", "task.started", 1, {
          taskId: "t1",
          crewRole: "worker",
          threadId: "sub-1",
        }),
        taskActivity("c1", "task.completed", 3, {
          taskId: "t1",
          crewRole: "worker",
          threadId: "sub-1",
          status: "completed",
        }),
      ],
    });
    expect(deriveCrewBoard(thread, false)?.current).toBe(false);
  });

  it("cleans control characters out of what the server wrote", () => {
    const thread = leadThread(
      [
        taskActivity("s1", "task.started", 1, {
          taskId: "t1",
          title: "\u001b[31m빨강\u001b[0m 작업",
          crewRole: "worker",
          threadId: "sub-1",
          model: "모델\u0007",
        }),
      ],
      true,
    );
    const task = deriveCrewBoard(thread, true)?.tasks[0];
    // eslint-disable-next-line no-control-regex
    expect(task?.title).not.toMatch(/\u001b|\u0007/u);
    // eslint-disable-next-line no-control-regex
    expect(task?.model).not.toMatch(/\u001b|\u0007/u);
  });
});

describe("crew threads in the thread list", () => {
  const shell = (id: string, over: Record<string, unknown> = {}) =>
    makeThreadShell({ id, updatedAt: at(Number(id.replace(/\D/gu, "") || 0)), ...over });
  const threads = [
    shell("lead-1", { title: "고치기" }),
    shell("sub-1", { title: "Crew Worker · 파서", parentThreadId: "lead-1" }),
    shell("sub-2", { title: "Crew Auditor · 검토", parentThreadId: "lead-1" }),
    shell("sub-3", {
      title: "Crew Expert · 설계",
      parentThreadId: "lead-1",
      hasPendingApprovals: true,
    }),
    shell("lead-2", { title: "다른 일" }),
    shell("old-sub", { title: "Crew Worker · 오래된" }),
  ];

  it("knows a crew thread by its parent or its title", () => {
    expect(isCrewSubThread({ title: "그냥 스레드", parentThreadId: "x" })).toBe(true);
    expect(isCrewSubThread({ title: "Crew Worker · 일", parentThreadId: null })).toBe(true);
    expect(isCrewSubThread({ title: "Crew 이야기", parentThreadId: null })).toBe(false);
    expect(crewSubThreadLabel("Crew Worker · 파서")).toBe("Worker · 파서");
  });

  it("folds crew threads under the lead and lifts the ones that wait for the user", () => {
    const listed = listedThreads(threads, "project-1");
    // Newest first; the one waiting is first of all. A crew thread without a lead is folded away too.
    expect(listed.rows.map((thread) => thread.id)).toEqual(["sub-3", "lead-2", "lead-1"]);
    expect(listed.folded.get("lead-1")).toBe(2);
    expect(listed.waiting.has("sub-3")).toBe(true);
  });

  it("lists the crew threads that wait, only those of the lead (or of old threads without a lead)", () => {
    const waiting = waitingCrewThreads(
      [
        ...threads,
        shell("other-sub", {
          title: "Crew Worker · 남의 일",
          parentThreadId: "lead-2",
          hasPendingUserInput: true,
        }),
      ],
      { id: "lead-1", projectId: "project-1" },
    );
    expect(waiting.map((entry) => [entry.thread.id, entry.kind])).toEqual([["sub-3", "approval"]]);
    expect(waitingText(waiting)).toBe("crew 작업이 승인을 기다립니다 — /crew");
    expect(waitingText([])).toBeNull();
  });

  it("counts several waiting tasks and names a question apart from an approval", () => {
    const waiting = waitingCrewThreads(
      [
        shell("a", { title: "Crew Worker · a", parentThreadId: "lead", hasPendingApprovals: true }),
        shell("b", { title: "Crew Worker · b", parentThreadId: "lead", hasPendingUserInput: true }),
      ],
      { id: "lead", projectId: "project-1" },
    );
    expect(waitingText(waiting)).toBe("crew 작업 2개가 승인·질문을 기다립니다 — /crew");
    const question = waitingCrewThreads(
      [shell("b", { title: "Crew Worker · b", parentThreadId: "lead", hasPendingUserInput: true })],
      { id: "lead", projectId: "project-1" },
    );
    expect(waitingText(question)).toBe("crew 작업이 질문을 기다립니다 — /crew");
  });

  it("leaves archived crew threads out", () => {
    const waiting = waitingCrewThreads(
      [
        shell("a", {
          title: "Crew Worker · a",
          parentThreadId: "lead",
          hasPendingApprovals: true,
          archivedAt: at(9),
        }),
      ],
      { id: "lead", projectId: "project-1" },
    );
    expect(waiting).toEqual([]);
  });
});
