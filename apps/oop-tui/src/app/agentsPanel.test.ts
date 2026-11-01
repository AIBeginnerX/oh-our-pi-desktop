import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { makeSession, makeThread, makeThreadShell } from "../testing/fixtures.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import {
  AgentsPanel,
  deriveAgentsView,
  EMPTY_AGENTS_VIEW,
  LOADING_AGENTS_VIEW,
  renderAgentsPanel,
  type AgentsPanelInput,
  type AgentsSource,
} from "./agentsPanel.ts";
import { deriveCrewBoard } from "./crewBoard.ts";

const T = "2026-10-30T09:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T) + seconds * 1000).toISOString();
const NOW = Date.parse(T) + 100_000;

let sequence = 0;
const activity = (
  kind: string,
  time: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id: `event-${(sequence += 1)}`,
    tone: "info",
    kind,
    summary: kind,
    payload: { agentKind: "agent", ...payload },
    turnId: "turn-1",
    sequence,
    createdAt: time,
  }) as unknown as OrchestrationThreadActivity;

const tool = (time: string, id: string, kind: string, command: string, status: string) =>
  activity(status === "completed" ? "tool.completed" : "tool.updated", time, {
    itemType: "command_execution",
    toolCallId: id,
    status,
    title: "Tool",
    data: { toolCallId: id, kind, command },
  });

const crewStart = (id: string, role: string, title: string, over: Record<string, unknown> = {}) =>
  activity("task.started", at(5), {
    taskId: id,
    title,
    crewRole: role,
    model: "GPT-6.1-Sol",
    providerInstanceId: "codex",
    status: "running",
    threadId: `${id}-thread`,
    ...over,
  });

const threadOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  running = true,
): OrchestrationThread =>
  makeThread({
    id: "thread-1",
    latestTurn: {
      turnId: "turn-1",
      state: running ? "running" : "completed",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: running ? null : at(90),
      assistantMessageId: null,
    },
    session: makeSession(running ? "running" : "ready", {
      activeTurnId: running ? "turn-1" : null,
    }),
    activities,
  });

/** The lead read a file, a worker implements, a subagent finished, and a command runs. */
const busy = () =>
  threadOf([
    tool(at(1), "s1", "read", "cat a.md", "completed"),
    crewStart("crew-1", "worker", "Implement invoice totals"),
    activity("task.progress", at(8), {
      taskId: "crew-1",
      summary: "Editing totals.ts",
      typedUsage: { totalTokens: 12400, toolUses: 7 },
    }),
    activity("task.started", at(6), {
      taskId: "sub-1",
      title: "Write spec tests",
      taskType: "local_agent",
      model: "claude-opus-5-5",
    }),
    activity("task.completed", at(20), {
      taskId: "sub-1",
      status: "completed",
      summary: "12 tests written",
    }),
    tool(at(30), "s2", "execute", "npm test", "running"),
  ]);

const source = (thread: OrchestrationThread, over: Partial<AgentsSource> = {}): AgentsSource => ({
  thread,
  leadModel: "GPT-5",
  board: deriveCrewBoard(thread, thread.session?.status === "running"),
  waiting: [],
  leadWaiting: null,
  ...over,
});

const input = (
  view: ReturnType<typeof deriveAgentsView> | null,
  over: Partial<AgentsPanelInput> = {},
): AgentsPanelInput => ({
  view,
  now: NOW,
  online: true,
  columns: 50,
  rows: 60,
  style: makeStyle(false),
  symbols: UNICODE_SYMBOLS,
  ...over,
});

const draw = (thread: OrchestrationThread, over: Partial<AgentsSource> = {}) =>
  renderAgentsPanel(input(deriveAgentsView(source(thread, over)))).map(stripAnsi);

describe("the Agents view of a thread", () => {
  it("lists the lead, then the working agents before the settled, each with what the desktop panel shows", () => {
    const text = draw(busy()).join("\n");
    const order = ["Lead", "Worker", "서브에이전트"].map((name) => text.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The lead: its model, what it does now, what it has done.
    expect(text).toContain("GPT-5");
    expect(text).toContain("지금: 명령 실행 중…");
    expect(text).toContain("파일 1개 읽음");
    // The worker: role, state, task, model, elapsed, usage, tool calls, what it does now.
    expect(text).toMatch(/Worker\s+GPT-6\.1-Sol\s+진행 중/u);
    expect(text).toContain("Implement invoice totals");
    expect(text).toContain("GPT-6.1-Sol");
    expect(text).toContain("12.4k 토큰");
    expect(text).toContain("도구 7회");
    expect(text).toContain("지금: Editing totals.ts");
    // The subagent that finished says how it ended.
    expect(text).toContain("완료");
    expect(text).toContain("결과: 12 tests written");
    // Totals sit under the title where they stay in view.
    expect(text).toMatch(/작업 중 \d+ · 완료 1 · 합계 12.4k 토큰/u);
  });

  it("gives the lead a clock only while its turn runs", () => {
    const running = deriveAgentsView(source(busy())).rows[0];
    expect(running?.name).toBe("Lead");
    expect(running?.span).not.toBeNull();
    const done = deriveAgentsView(source(threadOf(busy().activities, false))).rows[0];
    expect(done?.span).toBeNull();
    expect(done?.state).toBe("완료");
  });

  it("takes how a crew task ended, what backs it and what it cost from the crew board", () => {
    const thread = threadOf([
      crewStart("crew-1", "worker", "Implement invoice totals"),
      activity("task.completed", at(40), {
        taskId: "crew-1",
        crewRole: "worker",
        status: "partial",
        usage: { inputTokens: 3000, outputTokens: 1000, costUsd: 0.42 },
      }),
    ]);
    const text = draw(thread).join("\n");
    expect(text).toContain("일부 완료");
    expect(text).toContain("근거: 보고만 있음");
    expect(text).toContain("$0.42");
    expect(text).toContain("Crew 이번 턴 · 작업 1개");
  });

  it("marks who waits for an approval or an answer, the lead included", () => {
    const thread = busy();
    const waiting = [
      {
        thread: makeThreadShell({ id: "crew-1-thread", hasPendingApprovals: true }),
        kind: "approval" as const,
      },
    ];
    const text = draw(thread, { waiting, leadWaiting: "input" }).join("\n");
    const lines = text.split("\n");
    const worker = lines.findIndex((line) => line.includes("Worker"));
    expect(lines[worker]).toContain("승인 대기");
    const lead = lines.findIndex((line) => line.includes("Lead"));
    expect(lines[lead]).toContain("질문 대기");
    // Nobody waits: nothing says so.
    expect(draw(thread).join("\n")).not.toMatch(/승인 대기|질문 대기/u);
  });

  it("folds settled agents beyond the newest few, and never one that still works", () => {
    const many = Array.from({ length: 9 }, (_, index) => [
      activity("task.started", at(10 + index), {
        taskId: `old-${index}`,
        title: `Done ${index}`,
        taskType: "local_agent",
      }),
      activity("task.completed", at(11 + index), { taskId: `old-${index}`, status: "completed" }),
    ]).flat();
    const thread = threadOf([...many, crewStart("late", "worker", "Still going")]);
    const view = deriveAgentsView(source(thread));
    expect(view.folded).toBe(4);
    const text = renderAgentsPanel(input(view, { rows: 100 }))
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("Still going");
    expect(text).toContain("이전 4개 생략");
  });

  it("shows a running workflow by phase with the running phase's members, a settled one as one line", () => {
    const workflow = (done: boolean) => [
      activity("task.started", at(10), {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit",
        workflowName: "audit",
      }),
      activity("task.progress", at(11), {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", at(12), {
        taskId: "wf-1:wf:0",
        title: "audit:a",
        status: "completed",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
      }),
      activity("task.completed", at(13), {
        taskId: "wf-1:wf:0",
        status: "completed",
        parentAgentId: "wf-1",
      }),
      activity("task.progress", at(14), {
        taskId: "wf-1:wf:1",
        title: "verify:b",
        status: done ? "completed" : "running",
        parentAgentId: "wf-1",
        agentIndex: 1,
        phaseIndex: 1,
        typedUsage: { totalTokens: 4000 },
        summary: "checking refresh",
      }),
      ...(done
        ? [
            activity("task.completed", at(15), {
              taskId: "wf-1:wf:1",
              status: "completed",
              parentAgentId: "wf-1",
            }),
            activity("task.completed", at(16), { taskId: "wf-1", status: "completed" }),
          ]
        : []),
    ];
    const live = draw(threadOf(workflow(false))).join("\n");
    expect(live).toContain("audit  1/2 완료");
    expect(live).toContain("단계 Audit  완료 1");
    expect(live).toContain("단계 Verify  진행 1 · 완료 0");
    expect(live).toContain("verify:b");
    expect(live).toContain("지금: checking refresh");
    const settled = draw(threadOf(workflow(true), false)).join("\n");
    expect(settled).toContain("에이전트 2개");
    expect(settled).not.toContain("단계 Verify");
  });

  it("lays the turn's work out in order, naming each agent as the list does", () => {
    const text = draw(busy()).join("\n");
    const lane = text.slice(text.indexOf("흐름 · 이번 턴"));
    const first = lane.indexOf("파일 1개 읽음");
    const worker = lane.indexOf("Worker · Implement invoice totals");
    const sub = lane.indexOf("서브에이전트 · Write spec tests");
    expect(first).toBeGreaterThan(0);
    expect(worker).toBeGreaterThan(first);
    expect(sub).toBeGreaterThan(worker);
  });

  it("says what to do when nothing has run, when no thread is open, and when the link is down", () => {
    const quiet = draw(makeThread({ id: "thread-1" })).join("\n");
    expect(quiet).toContain("이 스레드가 실행되면");
    expect(quiet).not.toContain("에이전트\n");
    const none = renderAgentsPanel(input(null)).map(stripAnsi).join("\n");
    expect(none).toContain("스레드를 열면");
    const view = deriveAgentsView(source(busy()));
    const down = renderAgentsPanel(input(view, { online: false }))
      .map(stripAnsi)
      .join("\n");
    expect(down).toContain("연결 끊김");
    expect(down).toContain("Implement invoice totals");
  });

  it("says a thread is loading, and promises nothing for a thread whose link is down", () => {
    const text = (view: typeof EMPTY_AGENTS_VIEW, online: boolean) =>
      renderAgentsPanel(input(view, { online })).map(stripAnsi).join("\n");
    expect(text(LOADING_AGENTS_VIEW, true)).toContain("불러오는 중");
    expect(text(LOADING_AGENTS_VIEW, true)).not.toContain("실행되면");
    const down = text(LOADING_AGENTS_VIEW, false);
    expect(down).toContain("연결 끊김");
    expect(down).not.toContain("실행되면");
    expect(down).not.toContain("불러오는 중");
    expect(text(EMPTY_AGENTS_VIEW, true)).toContain("실행되면");
    const emptyDown = text(EMPTY_AGENTS_VIEW, false);
    expect(emptyDown).toContain("연결 끊김");
    expect(emptyDown).not.toContain("실행되면");
  });

  it("settles a finished turn: nothing in it is still working", () => {
    const thread = threadOf(
      [crewStart("crew-1", "worker", "Left open"), tool(at(2), "s1", "read", "cat a", "running")],
      false,
    );
    const view = deriveAgentsView(source(thread));
    expect(view.live).toBe(false);
    expect(view.rows.every((row) => !row.live)).toBe(true);
    // The header counts it as the row says: stopped, not working.
    expect(view.counts).toMatchObject({ working: 0, stopped: 1 });
    expect(draw(thread).join("\n")).toContain("중단됨 · 보고 없음");
  });
});

describe("the header's counts", () => {
  const crewDone = (id: string, status: string, start = 5) => [
    crewStart(id, "worker", `Task ${id}`),
    activity("task.completed", at(start + 1), { taskId: id, crewRole: "worker", status }),
  ];

  it("counts a crew task that ended partial or blocked as a failure, not as done", () => {
    const thread = threadOf([
      ...crewDone("a", "completed"),
      ...crewDone("b", "partial"),
      ...crewDone("c", "blocked"),
      ...crewDone("d", "failed"),
    ]);
    const { counts } = deriveAgentsView(source(thread));
    expect(counts).toMatchObject({ done: 1, failed: 3, working: 0 });
    expect(draw(thread).join("\n")).toMatch(/완료 1 · 실패 3/u);
  });

  it("counts by the board whether or not the row is folded, and counts nobody twice", () => {
    const thread = threadOf(
      Array.from({ length: 10 }, (_, index) =>
        crewDone(`t${index}`, index < 4 ? "partial" : "completed", 5 + index * 2),
      ).flat(),
    );
    const view = deriveAgentsView(source(thread));
    expect(view.folded).toBeGreaterThan(0);
    expect(view.counts).toMatchObject({ done: 6, failed: 4, stopped: 0, working: 0, idle: 0 });
    const { done, failed, stopped, working, idle } = view.counts;
    expect(done + failed + stopped + working + idle).toBe(10);
  });

  it("does not count a task the board has settled as working as well", () => {
    // The turn ended with the task open: the board has it stopped.
    const thread = threadOf([crewStart("a", "worker", "Left open")], false);
    const { counts } = deriveAgentsView(source(thread));
    expect(counts).toMatchObject({ working: 0, stopped: 1, done: 0, failed: 0 });
  });
});

describe("what a row says", () => {
  it("calls an agent that has not started yet by the word the header counts it under", () => {
    const thread = threadOf([
      activity("task.started", at(5), {
        taskId: "sub-1",
        title: "Queued work",
        taskType: "local_agent",
        status: "pending",
      }),
    ]);
    const view = deriveAgentsView(source(thread));
    const row = view.rows.find((entry) => entry.task === "Queued work");
    expect(row?.state).toBe("작업 중");
    expect(view.counts.working).toBe(1);
  });
});

describe("drawing the Agents view", () => {
  const view = () => deriveAgentsView(source(busy()));

  it("never draws a row wider than the panel, wide characters included", () => {
    const wide = threadOf([
      crewStart("crew-1", "worker", "가".repeat(80)),
      activity("task.progress", at(8), { taskId: "crew-1", summary: "나".repeat(120) }),
    ]);
    for (const columns of [24, 36, 50, 72]) {
      const lines = renderAgentsPanel(input(deriveAgentsView(source(wide)), { columns }));
      for (const line of lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
    }
  });

  it("cleans control characters out of text the agents wrote", () => {
    const hostile = threadOf([
      crewStart("crew-1", "worker", "evil\u001b[2Jtitle"),
      activity("task.progress", at(8), {
        taskId: "crew-1",
        summary: "now\u001b]0;pwned\u0007 here",
      }),
    ]);
    const raw = renderAgentsPanel(input(deriveAgentsView(source(hostile)))).join("\n");
    expect(raw).not.toContain("\u001b[2J");
    expect(raw).not.toContain("\u001b]0;");
    expect(raw).not.toContain("\u0007");
  });

  it("cleans the model, the effort, the role and the phase title, which the server also writes", () => {
    const esc = (word: string) => `${word}\u001b[2J\u001b]0;pwned\u0007\u009b31m`;
    const thread = threadOf([
      activity("task.started", at(5), {
        taskId: "sub-1",
        title: "Sub",
        taskType: "local_agent",
        role: esc("role"),
        model: esc("claude-opus-5-5"),
        effort: esc("high"),
      }),
      activity("task.started", at(10), {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit",
        workflowName: esc("audit"),
      }),
      activity("task.progress", at(11), {
        taskId: "wf-1",
        phases: [{ index: 0, title: esc("Phase") }],
      }),
      activity("task.progress", at(12), {
        taskId: "wf-1:wf:0",
        title: "member",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        role: esc("reviewer"),
        model: esc("gpt-6"),
        effort: esc("low"),
      }),
    ]);
    const lines = renderAgentsPanel(
      input(deriveAgentsView(source(thread, { leadModel: esc("GPT") }))),
    );
    const raw = lines.join("\n");
    // The style has no colour, so any escape in the output came from the server.
    for (const char of ["\u001b", "\u0007", "\u009b"]) expect(raw).not.toContain(char);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("opus-5-5");
    expect(text).toContain("reviewer");
    expect(text).toContain("단계 Phase");
  });

  it("does not stumble over a role that is also a property of every object", () => {
    const roles = ["constructor", "toString", "__proto__", "hasOwnProperty"];
    const thread = threadOf(
      roles.flatMap((role, index) => [
        activity("task.started", at(5 + index), {
          taskId: `sub-${index}`,
          title: role,
          taskType: "local_agent",
          role,
        }),
      ]),
    );
    const text = draw(thread).join("\n");
    for (const role of roles) expect(text).toContain(role);
  });

  it("keeps the working agent in view when the content is longer than the panel", () => {
    const lines = renderAgentsPanel(input(view(), { rows: 10 })).map(stripAnsi);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("Lead");
    expect(lines.some((line) => line.includes("아래에"))).toBe(true);
  });

  it("scrolls to a working row after the lead has finished", () => {
    const thread = threadOf(
      [
        tool(at(1), "s1", "read", "cat a.md", "completed"),
        tool(at(2), "s2", "execute", "npm test", "completed"),
        ...Array.from({ length: 4 }, (_, index) => [
          activity("task.started", at(10 + index), {
            taskId: `done-${index}`,
            title: `Finished ${index}`,
            taskType: "local_agent",
          }),
          activity("task.completed", at(11 + index), {
            taskId: `done-${index}`,
            status: "completed",
          }),
        ]).flat(),
        activity("task.started", at(30), {
          taskId: "bg-1",
          title: "Background indexer",
          taskType: "local_agent",
        }),
      ],
      false,
    );
    const view = deriveAgentsView(source(thread));
    expect(view.rows[0]?.live).toBe(false);
    expect(view.rows.find((row) => row.task === "Background indexer")?.live).toBe(true);
    const lines = renderAgentsPanel(input(view, { rows: 12 })).map(stripAnsi);
    expect(lines).toHaveLength(12);
    expect(lines.join("\n")).toContain("Background indexer");
    expect(lines.some((line) => line.includes("위에"))).toBe(true);
  });

  it("keeps a row that waits for the user in view however far down the roster it is", () => {
    // Eight tasks run; the one that asks for approval started first, so it is the last in the list.
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      id: `crew-${index}`,
      start: crewStart(`crew-${index}`, "worker", `Task number ${index}`, {
        threadId: `crew-${index}-thread`,
      }),
    }));
    const thread = threadOf(
      tasks.map((entry, index) => ({
        ...entry.start,
        createdAt: at(5 + index),
        payload: { ...(entry.start.payload as object) },
      })) as OrchestrationThreadActivity[],
    );
    const waiting = [
      {
        thread: makeThreadShell({ id: "crew-0-thread", hasPendingApprovals: true }),
        kind: "approval" as const,
      },
    ];
    const view = deriveAgentsView(source(thread, { waiting }));
    expect(view.rows[1]?.waiting).toBe("approval");
    for (const rows of [10, 14, 20]) {
      const lines = renderAgentsPanel(input(view, { rows })).map(stripAnsi);
      expect(lines.some((line) => line.includes("승인 대기"))).toBe(true);
    }
    // Nobody waits: the list keeps the order the turn gave it.
    expect(deriveAgentsView(source(thread)).rows.some((row) => row.waiting !== null)).toBe(false);
  });

  it("never folds away a row that waits for the user", () => {
    const old = Array.from({ length: 9 }, (_, index) => [
      crewStart(`crew-${index}`, "worker", `Task number ${index}`, {
        threadId: `crew-${index}-thread`,
      }),
      activity("task.completed", at(6 + index), {
        taskId: `crew-${index}`,
        crewRole: "worker",
        status: "completed",
      }),
    ]).flat();
    const thread = threadOf(old);
    const plain = deriveAgentsView(source(thread));
    expect(plain.folded).toBeGreaterThan(0);
    const hidden = Array.from({ length: 9 }, (_, index) => index).find(
      (index) => !plain.rows.some((row) => row.task === `Task number ${index}`),
    );
    expect(hidden).toBeDefined();
    const waiting = [
      {
        thread: makeThreadShell({ id: `crew-${hidden}-thread`, hasPendingUserInput: true }),
        kind: "input" as const,
      },
    ];
    const asked = deriveAgentsView(source(thread, { waiting }));
    expect(asked.rows.find((row) => row.task === `Task number ${hidden}`)?.waiting).toBe("input");
    expect(asked.folded).toBe(plain.folded - 1);
  });

  it("draws only ASCII marks when the symbols are ASCII", () => {
    const text = renderAgentsPanel(input(view(), { symbols: ASCII_SYMBOLS }))
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("Worker");
    expect(text).not.toMatch(/[○◌◐‖✓✗■⊘❯─│▸Σ]/u);
  });

  it("uses colour only when the style has it", () => {
    expect(renderAgentsPanel(input(view())).join("\n")).not.toContain("\u001b[");
    expect(renderAgentsPanel(input(view(), { style: makeStyle(true) })).join("\n")).toContain(
      "\u001b[",
    );
  });
});

describe("AgentsPanel", () => {
  it("reads the thread once per change and draws the same lines again without redoing it", () => {
    const panel = new AgentsPanel();
    const thread = threadOf(busy().activities, false);
    const read = source(thread);
    const first = panel.read(read);
    expect(panel.read({ ...read })).toBe(first);
    const lines = panel.lines(input(first));
    expect(panel.lines(input(first))).toBe(lines);
    // Settled work has no clock: time passing changes nothing.
    expect(panel.lines(input(first, { now: NOW + 60_000 }))).toBe(lines);
    // A new activity is a new thread to read.
    const next = {
      ...thread,
      activities: [...thread.activities, crewStart("crew-2", "expert", "More")],
    };
    expect(panel.read({ ...read, thread: next })).not.toBe(first);
  });

  it("redraws every second while something works, and not otherwise", () => {
    const panel = new AgentsPanel();
    const running = panel.read(source(busy()));
    const lines = panel.lines(input(running));
    expect(panel.lines(input(running, { now: NOW + 400 }))).toBe(lines);
    expect(panel.lines(input(running, { now: NOW + 2000 }))).not.toBe(lines);
  });

  it("reads again when the crew board, the waiting threads, or the lead's request change", () => {
    const panel = new AgentsPanel();
    const thread = busy();
    const base = source(thread);
    const first = panel.read(base);
    expect(panel.read({ ...base })).toBe(first);
    expect(panel.read({ ...base, leadWaiting: "approval" })).not.toBe(first);
    const asking = [
      {
        thread: makeThreadShell({ id: "crew-1-thread", hasPendingApprovals: true }),
        kind: "approval" as const,
      },
    ];
    const withAsk = panel.read({ ...base, waiting: asking });
    expect(withAsk).not.toBe(first);
    // The same threads waiting for the same thing, as a new list: nothing to read again.
    expect(panel.read({ ...base, waiting: [...asking] })).toBe(withAsk);
    expect(panel.read({ ...base, waiting: [{ ...asking[0]!, kind: "input" }] })).not.toBe(withAsk);
  });

  it("reads a new list of the same waiting threads without redoing the work", () => {
    const panel = new AgentsPanel();
    const base = source(busy());
    const first = panel.read(base);
    expect(panel.read({ ...base, waiting: [] })).toBe(first);
  });

  it("forgets everything for another thread", () => {
    const panel = new AgentsPanel();
    const thread = busy();
    const read = source(thread);
    const first = panel.read(read);
    panel.reset();
    expect(panel.read(read)).not.toBe(first);
  });
});
