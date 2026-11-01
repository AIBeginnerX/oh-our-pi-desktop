import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeState,
} from "@t3tools/client-runtime/workflow-graph";
import { describe, expect, it } from "vite-plus/test";

import { makeStyle } from "../render/style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { makeThread, makeSession } from "../testing/fixtures.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import {
  deriveFlows,
  parseFlowAction,
  renderFlowPanel,
  WorkflowPanel,
  type PanelInput,
} from "./workflowPanel.ts";

const T = "2026-10-30T09:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T) + seconds * 1000).toISOString();
const NOW = Date.parse(T) + 100_000;

const node = (
  id: string,
  state: WorkflowNodeState,
  wave: number,
  info: WorkflowNode["info"] = {},
  label = id,
): WorkflowNode => ({ id, label, state, wave, info });

const graph = (
  over: Partial<WorkflowGraph> & Pick<WorkflowGraph, "id" | "nodes">,
): WorkflowGraph => ({
  kind: "workflow",
  name: "Deep research",
  status: "running",
  startedAt: at(0),
  updatedAt: at(10),
  waveTitles: [],
  edges: [],
  ...over,
});

const input = (flows: WorkflowGraph[] | null, over: Partial<PanelInput> = {}): PanelInput => ({
  flows,
  pinnedId: null,
  now: NOW,
  online: true,
  columns: 40,
  rows: 30,
  style: makeStyle(false),
  symbols: UNICODE_SYMBOLS,
  ...over,
});

const plain = (lines: ReadonlyArray<string>) => lines.map(stripAnsi);

const ALL_STATES: WorkflowNodeState[] = [
  "pending",
  "blocked",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
];

describe("parseFlowAction", () => {
  it("reads the words /dag-workflow takes", () => {
    expect(parseFlowAction([])).toEqual({ kind: "toggle" });
    expect(parseFlowAction(["on"])).toEqual({ kind: "on" });
    expect(parseFlowAction(["OFF"])).toEqual({ kind: "off" });
    expect(parseFlowAction(["next"])).toEqual({ kind: "next" });
    expect(parseFlowAction(["prev"])).toEqual({ kind: "prev" });
    expect(parseFlowAction(["live"])).toEqual({ kind: "live" });
    expect(parseFlowAction(["2"])).toEqual({ kind: "pick", number: 2 });
  });

  it("refuses anything else", () => {
    expect(parseFlowAction(["later"])).toBeNull();
    expect(parseFlowAction(["-1"])).toBeNull();
    expect(parseFlowAction(["1", "2"])).toBeNull();
  });
});

describe("the flow panel as text", () => {
  it("draws every state with its own mark and word, in unicode and in ascii", () => {
    const flow = graph({
      id: "wf",
      nodes: ALL_STATES.map((state, index) => node(`n-${state}`, state, 0, {}, `단계 ${index}`)),
    });
    for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
      const text = plain(renderFlowPanel(input([flow], { symbols, rows: 60 })));
      const words = [
        "시작 전",
        "대기 중",
        "작업 중",
        "일시 중지",
        "완료",
        "실패",
        "중단됨",
        "건너뜀",
      ];
      ALL_STATES.forEach((state, index) => {
        const row = text.findIndex((line) => line.includes(`단계 ${index}`));
        expect(row, state).toBeGreaterThan(-1);
        expect(text[row]).toContain(symbols.flow[state]);
        expect(text[row + 1]).toContain(words[index]);
      });
      expect(new Set(Object.values(symbols.flow)).size).toBe(8);
    }
  });

  it("groups steps by wave with the wave titles, counts and the steps they wait for", () => {
    const flow = graph({
      id: "wf",
      waveTitles: ["Plan", "Build"],
      nodes: [
        node("a", "completed", 0, {}, "계획 세우기"),
        node("b", "running", 1, { model: "claude-opus-5-5", startedAt: at(70) }, "코드 쓰기"),
        node("c", "pending", 1, {}, "테스트 쓰기"),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    });
    const text = plain(renderFlowPanel(input([flow])));
    const joined = text.join("\n");
    expect(joined).toContain("1. Plan 1/1");
    expect(joined).toContain("2. Build 0/2");
    expect(joined).toContain("선행: 계획 세우기");
    expect(joined).toContain("완료 1 · 진행 1");
    // 100 s since the step began at +70 s is 30 s.
    const at_ = text.findIndex((line) => line.includes("코드 쓰기"));
    expect(text[at_ + 1]).toContain("opus-5-5");
    expect(text[at_ + 2]).toContain("작업 중 · 30s");
  });

  it("says what to do when there is nothing to draw, and when no thread is open", () => {
    expect(plain(renderFlowPanel(input([]))).join(" ")).toContain("단계가 여기에 나타납니다");
    expect(plain(renderFlowPanel(input(null))).join(" ")).toContain("스레드를 열면");
  });

  it("says the content is the last that arrived when the server is not reachable", () => {
    const flow = graph({ id: "wf", nodes: [node("a", "running", 0)] });
    const text = plain(renderFlowPanel(input([flow], { online: false }))).join("\n");
    expect(text).toContain("연결 끊김");
    expect(text).toContain("a");
  });

  it("lists several flows by number, marks the one shown, and shows the picked one", () => {
    const flows = [
      graph({ id: "new", name: "Newest", nodes: [node("n1", "running", 0, {}, "새 단계")] }),
      graph({
        id: "old",
        name: "Oldest",
        status: "completed",
        startedAt: at(-50),
        nodes: [node("o1", "completed", 0, {}, "옛 단계")],
      }),
    ];
    const live = plain(renderFlowPanel(input(flows))).join("\n");
    expect(live).toContain("흐름 2개");
    expect(live).toContain("❯ 1");
    expect(live).toContain("새 단계");
    expect(live).not.toContain("옛 단계");
    const picked = plain(renderFlowPanel(input(flows, { pinnedId: "old" }))).join("\n");
    expect(picked).toContain("❯ 2");
    expect(picked).toContain("옛 단계");
  });

  it("keeps the wave in progress in view when the content is longer than the panel", () => {
    const done = Array.from({ length: 12 }, (_, i) =>
      node(`d${i}`, "completed", 0, {}, `끝난 일 ${i}`),
    );
    const flow = graph({
      id: "wf",
      waveTitles: ["Old", "Now"],
      nodes: [...done, node("live", "running", 1, {}, "지금 하는 일")],
      edges: done.map((from) => ({ from: from.id, to: "live" })),
    });
    const lines = plain(renderFlowPanel(input([flow], { rows: 14 })));
    expect(lines).toHaveLength(14);
    const joined = lines.join("\n");
    expect(joined).toContain("지금 하는 일");
    expect(joined).toContain("2. Now");
    expect(joined).toMatch(/↑ 위에 \d+줄/u);
    expect(joined).not.toContain("✓ 끝난 일 0");
  });

  it("never draws a row wider than the panel, wide characters included", () => {
    const flow = graph({
      id: "wf",
      nodes: [
        node(
          "a",
          "running",
          0,
          { model: "claude-opus-5-5-20260101" },
          "아주 긴 한국어 단계 이름이 줄 바꿈 되어야 합니다",
        ),
        node(
          "b",
          "failed",
          0,
          { error: "오류가 발생했습니다 그리고 설명이 아주 깁니다 정말로" },
          "x".repeat(80),
        ),
      ],
    });
    for (const columns of [36, 40, 72]) {
      for (const line of renderFlowPanel(input([flow], { columns, rows: 40 }))) {
        expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("cleans control characters out of text the agents wrote", () => {
    const flow = graph({
      id: "wf",
      nodes: [node("a", "running", 0, {}, "\u001b]0;pwned\u0007제목\u001b[2J 끝")],
    });
    const text = renderFlowPanel(input([flow])).join("\n");
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\u001b\](?:0;)|\u001b\[2J/u);
    expect(stripAnsi(text)).toContain("제목");
  });

  it("uses colour only when the style has it", () => {
    const flow = graph({ id: "wf", nodes: [node("a", "failed", 0)] });
    expect(renderFlowPanel(input([flow])).join("")).not.toContain("\u001b[");
    expect(renderFlowPanel(input([flow], { style: makeStyle(true) })).join("")).toContain(
      "\u001b[",
    );
  });
});

describe("WorkflowPanel", () => {
  const flows = [
    graph({ id: "new", nodes: [node("n", "running", 0)] }),
    graph({
      id: "mid",
      status: "completed",
      startedAt: at(-10),
      nodes: [node("m", "completed", 0)],
    }),
    graph({
      id: "old",
      status: "completed",
      startedAt: at(-20),
      nodes: [node("o", "completed", 0)],
    }),
  ];

  it("picks a flow by number, steps through them in a ring, and goes back to the live one", () => {
    const panel = new WorkflowPanel();
    expect(panel.choose(flows, { kind: "pick", number: 3 })).toBeNull();
    expect(panel.pinnedId()).toBe("old");
    panel.choose(flows, { kind: "next" });
    // Past the last one it wraps to the newest, which is the one being followed anyway.
    expect(panel.pinnedId()).toBeNull();
    panel.choose(flows, { kind: "prev" });
    expect(panel.pinnedId()).toBe("old");
    panel.choose(flows, { kind: "live" });
    expect(panel.pinnedId()).toBeNull();
  });

  it("refuses a number that is not there, and leaves the pick as it was", () => {
    const panel = new WorkflowPanel();
    panel.choose(flows, { kind: "pick", number: 2 });
    expect(panel.choose(flows, { kind: "pick", number: 9 })).toBe("흐름 번호는 1~3 입니다.");
    expect(panel.pinnedId()).toBe("mid");
    expect(panel.choose([], { kind: "pick", number: 1 })).toBe("고를 흐름이 없습니다.");
    expect(panel.choose(null, { kind: "next" })).toBe("고를 흐름이 없습니다.");
  });

  it("forgets the pick for another thread", () => {
    const panel = new WorkflowPanel();
    panel.choose(flows, { kind: "pick", number: 3 });
    panel.reset();
    expect(panel.pinnedId()).toBeNull();
  });

  it("reads the thread once per change and draws the same lines again without redoing it", () => {
    const panel = new WorkflowPanel();
    const thread = makeThread({ id: "t" });
    const first = panel.flows(thread, null);
    expect(panel.flows(thread, null)).toBe(first);
    expect(panel.flows({ ...thread, activities: [] }, null)).not.toBe(first);
    const view = {
      flows,
      now: NOW,
      online: true,
      columns: 40,
      rows: 20,
      style: makeStyle(false),
      symbols: UNICODE_SYMBOLS,
    };
    const lines = panel.lines(view);
    // Time passing changes nothing drawn while a step runs only after the second turns over.
    expect(panel.lines({ ...view, now: NOW + 400 })).toBe(lines);
    expect(panel.lines({ ...view, now: NOW + 1500 })).not.toBe(lines);
    const idle = { ...view, flows: [flows[1] as WorkflowGraph] };
    const drawn = panel.lines(idle);
    expect(panel.lines({ ...idle, now: NOW + 60_000 })).toBe(drawn);
  });
});

describe("the panel's lines after /theme", () => {
  it("are drawn again when the theme changes under the same style object", () => {
    const panel = new WorkflowPanel();
    let name = "dark";
    const base = makeStyle(false);
    // The controller's style keeps its identity and swaps its theme, which is what /theme does.
    const style = {
      ...base,
      get theme() {
        return { ...base.theme, name };
      },
    } as typeof base;
    const view = {
      flows: [] as WorkflowGraph[],
      now: NOW,
      online: true,
      columns: 40,
      rows: 10,
      style,
      symbols: UNICODE_SYMBOLS,
    };
    const first = panel.lines(view);
    expect(panel.lines(view)).toBe(first);
    name = "light";
    expect(panel.lines(view)).not.toBe(first);
  });
});

describe("flows read from a thread", () => {
  let sequence = 0;
  const activity = (
    kind: string,
    time: string,
    payload: Record<string, unknown>,
    turnId = "turn-1",
  ): OrchestrationThreadActivity =>
    ({
      id: `event-${(sequence += 1)}`,
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId,
      sequence,
      createdAt: time,
    }) as unknown as OrchestrationThreadActivity;

  const crewThread = (running: boolean): OrchestrationThread =>
    makeThread({
      id: "thread-1",
      latestTurn: {
        turnId: "turn-1",
        state: running ? "running" : "completed",
        requestedAt: at(0),
        startedAt: at(0),
        completedAt: running ? null : at(60),
        assistantMessageId: null,
      },
      session: makeSession(running ? "running" : "ready", {
        activeTurnId: running ? "turn-1" : null,
      }),
      activities: [
        activity("task.started", at(5), {
          taskId: "crew-1",
          title: "Implement invoice totals",
          agentKind: "agent",
          crewRole: "worker",
          model: "GPT-6.1-Sol",
          providerInstanceId: "codex",
          status: "running",
        }),
        activity("task.completed", at(20), { taskId: "crew-1", status: "completed" }),
      ],
    });

  it("draws a running turn with its crew and the main agent working", () => {
    const flows = deriveFlows(crewThread(true), "GPT-5");
    expect(flows).toHaveLength(1);
    const text = plain(renderFlowPanel(input(flows, { rows: 40 }))).join("\n");
    expect(text).toContain("턴 1 · Crew");
    expect(text).toContain("메인 에이전트");
    expect(text).toContain("Worker");
    expect(text).toContain("Implement invoice totals");
    expect(text).toContain("위임된 작업");
    expect(text).toContain("선행: 메인 에이전트");
  });

  it("settles a turn that ended: nothing in it is still working", () => {
    const flows = deriveFlows(crewThread(false), "GPT-5");
    expect(flows.flatMap((flow) => flow.nodes).some((n) => n.state === "running")).toBe(false);
    expect(flows[0]?.status).not.toBe("running");
  });

  // A member that was started and has not reported back: only the session says if it is alive.
  const openMember = (status: string): OrchestrationThread => {
    const base = crewThread(true);
    return {
      ...base,
      session: makeSession(status, {
        activeTurnId: status === "running" ? "turn-1" : null,
      }) as OrchestrationThread["session"],
      activities: base.activities.filter((entry) => entry.kind === "task.started"),
    };
  };
  const memberState = (thread: OrchestrationThread) =>
    deriveFlows(thread, "GPT-5")
      .flatMap((flow) => flow.nodes)
      .find((node) => node.id === "crew-1")?.state;

  it("keeps a working member working through a network drop: the link is not the session", () => {
    // `deriveFlows` takes no link state; a live session is all that keeps the member working.
    expect(memberState(openMember("running"))).toBe("running");
    expect(memberState(openMember("ready"))).toBe("running");
    expect(workflowMemberState("running")).toBe("running");
  });

  // A workflow member (no crew role) is what `sessionLive` decides; a crew member follows its turn.
  const workflowMemberState = (status: string) => {
    const thread: OrchestrationThread = {
      ...openMember(status),
      latestTurn: null,
      activities: [
        activity("task.started", at(1), {
          taskId: "wf",
          taskType: "local_workflow",
          workflowName: "Research",
          title: "Research",
          agentKind: "agent",
        }),
        activity("task.progress", at(2), {
          taskId: "wf:1",
          title: "scan",
          status: "running",
          agentKind: "agent",
          parentAgentId: "wf",
          phaseIndex: 1,
          agentIndex: 1,
        }),
      ],
    };
    return deriveFlows(thread, "GPT-5")
      .flatMap((flow) => flow.nodes)
      .find((node) => node.id === "wf:1")?.state;
  };

  it("does not leave a dead member working when the provider session errored or stopped", () => {
    for (const status of ["error", "stopped", "interrupted"]) {
      expect(workflowMemberState(status), status).toBe("cancelled");
    }
  });

  it("has no flows for a thread that did nothing", () => {
    expect(deriveFlows(makeThread({ id: "empty" }), null)).toEqual([]);
  });
});
