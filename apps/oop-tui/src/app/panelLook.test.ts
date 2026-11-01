import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { WorkflowGraph, WorkflowNode } from "@t3tools/client-runtime/workflow-graph";
import { describe, expect, it } from "vite-plus/test";

import { setLanguage } from "../i18n/index.ts";
import { makeStyle } from "../render/style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../render/symbols.ts";
import { makeSession, makeThread, makeThreadShell } from "../testing/fixtures.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import { deriveAgentsView, renderAgentsPanel, type AgentsSource } from "./agentsPanel.ts";
import { deriveCrewBoard } from "./crewBoard.ts";
import { renderFlowPanel, type PanelInput } from "./workflowPanel.ts";

// What the desktop app's right pane looks like, drawn as text: two tabs, cards with a state
// mark, connectors between them. The fixtures are what a real run of the crew leaves behind.

const T = "2026-10-30T09:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T) + seconds * 1000).toISOString();
const NOW = Date.parse(T) + 125_000;

// ---- a workflow that is running: parallel steps, one of them failed -----------------------------

const step = (
  id: string,
  label: string,
  state: WorkflowNode["state"],
  wave: number,
  info: WorkflowNode["info"] = {},
): WorkflowNode => ({ id, label, state, wave, info });

const researchFlow = (): WorkflowGraph => ({
  id: "wf-research",
  kind: "workflow",
  name: "Deep research",
  status: "running",
  startedAt: at(0),
  updatedAt: at(120),
  waveTitles: ["계획", "자료 수집", "초안 작성"],
  nodes: [
    step("plan", "연구 계획 세우기", "completed", 0, {
      model: "claude-opus-5-5-20260101",
      startedAt: at(0),
      completedAt: at(18),
      tokens: 4200,
      costUsd: 0.07,
      evidence: "reported",
    }),
    step("web", "웹 자료 조사 및 출처 정리", "completed", 1, {
      model: "claude-sonnet-5-5",
      subtitle: "공개 문서 12건",
      startedAt: at(20),
      completedAt: at(75),
      tokens: 31800,
      evidence: "tested",
    }),
    step("code", "저장소 코드 읽기", "running", 1, {
      model: "GPT-6.1-Sol",
      startedAt: at(20),
      progress: "src/billing 12개 파일 읽는 중",
      tokens: 9600,
    }),
    step("bench", "Benchmark the parser against the corpus", "failed", 1, {
      model: "claude-haiku-5",
      startedAt: at(20),
      completedAt: at(61),
      error: "Timed out after 40 s while loading the corpus",
      tokens: 1200,
    }),
    step("draft", "보고서 초안 작성", "pending", 2, { model: "claude-opus-5-5" }),
  ],
  edges: [
    { from: "plan", to: "web" },
    { from: "plan", to: "code" },
    { from: "plan", to: "bench" },
    { from: "web", to: "draft" },
    { from: "code", to: "draft" },
    { from: "bench", to: "draft" },
  ],
});

// ---- agents: one working, one waiting for an approval, one finished -------------------------------

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

const crewThread = (): OrchestrationThread =>
  makeThread({
    id: "thread-1",
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: null,
      assistantMessageId: null,
    },
    session: makeSession("running", { activeTurnId: "turn-1" }),
    activities: [
      activity("tool.completed", at(1), {
        itemType: "command_execution",
        toolCallId: "s1",
        status: "completed",
        title: "Tool",
        data: { toolCallId: "s1", kind: "read", command: "cat billing.md" },
      }),
      activity("task.started", at(5), {
        taskId: "crew-1",
        title: "청구서 합계 계산 구현",
        crewRole: "worker",
        model: "GPT-6.1-Sol",
        providerInstanceId: "codex",
        status: "running",
        threadId: "crew-1-thread",
      }),
      activity("task.progress", at(8), {
        taskId: "crew-1",
        summary: "totals.ts 수정 중",
        typedUsage: { totalTokens: 12400, toolUses: 7 },
      }),
      activity("task.started", at(6), {
        taskId: "crew-2",
        title: "Review the migration plan",
        crewRole: "auditor",
        model: "claude-opus-5-5",
        providerInstanceId: "claude",
        status: "running",
        threadId: "crew-2-thread",
      }),
      activity("task.started", at(7), {
        taskId: "sub-1",
        title: "테스트 명세 작성",
        taskType: "local_agent",
        model: "claude-opus-5-5",
      }),
      activity("task.completed", at(40), {
        taskId: "sub-1",
        status: "completed",
        summary: "테스트 12개 작성",
      }),
    ],
  });

const agentsSource = (thread: OrchestrationThread): AgentsSource => ({
  thread,
  leadModel: "GPT-5",
  board: deriveCrewBoard(thread, true),
  waiting: [
    {
      thread: makeThreadShell({ id: "crew-2-thread", hasPendingApprovals: true }),
      kind: "approval" as const,
    },
  ],
  leadWaiting: null,
});

// ---- drawing ---------------------------------------------------------------------------------------

const WIDTHS = [30, 44] as const;
const PRESETS = [
  ["unicode", UNICODE_SYMBOLS],
  ["ascii", ASCII_SYMBOLS],
] as const;

const base = (columns: number, symbols: typeof UNICODE_SYMBOLS, colour = false) => ({
  now: NOW,
  online: true,
  columns,
  rows: 60,
  style: makeStyle(colour),
  symbols,
  switchKey: "Tab",
});

const workflowLines = (...args: Parameters<typeof base>): string[] => {
  const input: PanelInput = { ...base(...args), flows: [researchFlow()], pinnedId: null };
  return renderFlowPanel(input);
};

const agentsLines = (...args: Parameters<typeof base>): string[] =>
  renderAgentsPanel({
    ...base(...args),
    view: deriveAgentsView(agentsSource(crewThread())),
  });

describe("the right pane as the desktop draws it", () => {
  for (const columns of WIDTHS) {
    for (const [name, symbols] of PRESETS) {
      it(`keeps both tabs inside ${columns} columns with ${name} marks, Korean text included`, () => {
        for (const lines of [workflowLines(columns, symbols), agentsLines(columns, symbols)]) {
          expect(lines.length).toBeGreaterThan(10);
          for (const line of lines)
            expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
          if (name === "ascii") {
            expect(lines.map(stripAnsi).join("")).not.toMatch(/[○◌◐‖✓✗■⊘❯─━│┆▼›╭╮╰╯┌└Σ]/u);
          }
        }
      });
    }
  }

  it("shows Workflow and Agents as two tabs, the one on screen lit and underlined", () => {
    const flow = workflowLines(44, UNICODE_SYMBOLS).map(stripAnsi);
    expect(flow[0]).toMatch(/^ Workflow │ Agents/u);
    // The heavy underline runs under the first tab only.
    expect(flow[1]).toMatch(/^ ━{8}─+$/u);
    const agents = agentsLines(44, UNICODE_SYMBOLS).map(stripAnsi);
    expect(agents[0]).toMatch(/^ Workflow │ Agents/u);
    expect(agents[1]).toMatch(/^ ─{11}━{6}─+$/u);
    // Lit with the accent colour, the other tab dim.
    const { theme } = makeStyle(true);
    expect(workflowLines(44, UNICODE_SYMBOLS, true)[0]).toContain(theme.accent.bold("Workflow"));
    expect(workflowLines(44, UNICODE_SYMBOLS, true)[0]).toContain(theme.dim("Agents"));
  });

  it("names the key that switches tabs when there is room, and always the way to close", () => {
    expect(workflowLines(44, UNICODE_SYMBOLS).map(stripAnsi)[2]).toBe(
      " Tab 로 전환 · /dag-workflow 로 닫기",
    );
    expect(workflowLines(30, UNICODE_SYMBOLS).map(stripAnsi)[2]).toBe(" /dag-workflow 로 닫기");
    expect(agentsLines(30, UNICODE_SYMBOLS).map(stripAnsi)[2]).toBe(" /dag-agents 로 닫기");
  });

  it("draws each step as a framed card: mark, role, model, note, and a status line with time and tokens", () => {
    const text = workflowLines(44, UNICODE_SYMBOLS).map(stripAnsi);
    const joined = text.join("\n");
    expect(joined).toContain("╭");
    expect(joined).toContain("╰");
    // The finished step: mark, title, evidence at the right, model without the date, status line.
    const plan = text.findIndex((line) => line.includes("✓ 연구 계획 세우기"));
    expect(plan).toBeGreaterThan(-1);
    expect(text[plan]).toContain("[보고만 있음]");
    expect(text[plan + 1]).toContain("opus-5-5");
    const status = text[plan + 2] ?? "";
    expect(status).toContain("완료 · 18s");
    expect(text.slice(plan, plan + 6).join("\n")).toContain("4.2k");
    expect(text.slice(plan, plan + 6).join("\n")).toContain("$0.07");
    // The one running: its own mark, progress, and a clock that has moved on.
    const running = text.findIndex((line) => line.includes("◐ 저장소 코드 읽기"));
    expect(text.slice(running, running + 6).join("\n")).toContain("작업 중 · 1m 45s");
    expect(text.slice(running, running + 6).join("\n")).toContain("GPT-6.1-Sol");
    // The failed one: mark, error in the card, and its frame.
    const failed = text.findIndex((line) => line.includes("✗ Benchmark"));
    expect(text.slice(failed, failed + 8).join("\n")).toContain("Timed out after 40 s");
  });

  it("colours each mark and frame by the state of its step", () => {
    const { theme } = makeStyle(true);
    const lines = workflowLines(44, UNICODE_SYMBOLS, true);
    const has = (text: string) => lines.some((line) => line.includes(text));
    expect(has(theme.success("✓"))).toBe(true);
    expect(has(theme.accent("◐"))).toBe(true);
    expect(has(theme.error("✗"))).toBe(true);
    expect(has(theme.dim("○"))).toBe(true);
    // The frame of the running card is the accent, the failed one's is red.
    const top = `╭${"─".repeat(39)}╮`;
    expect(has(theme.accent(top))).toBe(true);
    expect(has(theme.error(top))).toBe(true);
  });

  it("joins the waves with connectors: solid where taken or live, dashed where not", () => {
    const text = workflowLines(44, UNICODE_SYMBOLS).map(stripAnsi);
    expect(text.filter((line) => line.trim() === "▼")).toHaveLength(2);
    // Plan -> gather: the plan finished and the gather step runs, so the link is lit and solid.
    const heading = text.findIndex((line) => line.includes("2. 자료 수집"));
    expect(text[heading - 2]?.trim()).toBe("│");
    expect(text[heading]).toContain("병렬 3");
    expect(text[heading]).toContain("실패 1");
    // Gather -> draft: a failed step upstream, nothing running after it, so the link is dashed.
    const last = text.findIndex((line) => line.includes("3. 초안 작성"));
    expect(text[last - 2]?.trim()).toBe("┆");
    const { theme } = makeStyle(true);
    const coloured = workflowLines(44, UNICODE_SYMBOLS, true);
    expect(coloured.some((line) => line.includes(theme.accent("│")))).toBe(true);
    expect(coloured.some((line) => line.includes(theme.error("┆")))).toBe(true);
    // ASCII gets its own connector marks.
    const plain = workflowLines(44, ASCII_SYMBOLS).map(stripAnsi);
    expect(plain.some((line) => line.trim() === "v")).toBe(true);
    expect(plain.some((line) => line.trim() === ":")).toBe(true);
  });

  it("draws the agents as cards with the state word at the right, then the flow as a linked chain, totals last", () => {
    const text = agentsLines(44, UNICODE_SYMBOLS).map(stripAnsi);
    const worker = text.findIndex((line) => line.includes("Worker"));
    expect(text[worker]).toMatch(/^ ┌ ◐ Worker {2}GPT-6\.1-Sol\s+진행 중$/u);
    expect(text[worker + 1]).toContain("청구서 합계 계산 구현");
    expect(text.slice(worker, worker + 5).join("\n")).toContain("12.4k 토큰");
    // The one that waits for an approval says so where the state is.
    const auditor = text.findIndex((line) => line.includes("Auditor"));
    expect(text[auditor]).toMatch(/승인 대기$/u);
    // The finished one says how it ended.
    expect(text.join("\n")).toContain("결과: 테스트 12개 작성");
    // The flow: cards of two lines joined by a line.
    const flow = text.findIndex((line) => line.includes("흐름 · 이번 턴"));
    expect(text[flow + 1]).toMatch(/^ ┌ /u);
    expect(text[flow + 2]).toMatch(/^ └ /u);
    expect(text[flow + 3]?.trim()).toBe("│");
    // The totals are the last rows, under a rule.
    const tail = text.filter((line) => line.trim() !== "").slice(-3);
    expect(tail[0]).toMatch(/^ ─+$/u);
    expect(tail.join(" ")).toMatch(/● 작업 중 \d.*합계 /u);
  });

  it("marks agent states by the colour of their bar and mark", () => {
    const { theme } = makeStyle(true);
    const lines = agentsLines(44, UNICODE_SYMBOLS, true);
    const has = (text: string) => lines.some((line) => line.includes(text));
    expect(has(theme.accent("◐"))).toBe(true);
    expect(has(theme.success("✓"))).toBe(true);
    expect(has(theme.warning("승인 대기"))).toBe(true);
  });

  it("shows a centred title and a few words when there is nothing yet, in both tabs", () => {
    const style = makeStyle(false);
    const common = { ...base(44, UNICODE_SYMBOLS), style };
    const flow = renderFlowPanel({ ...common, flows: [], pinnedId: null }).map(stripAnsi);
    expect(flow.join("\n")).toContain("그릴 작업이 아직 없습니다");
    const title = flow.find((line) => line.includes("그릴 작업이 아직 없습니다")) ?? "";
    expect(title.length - title.trimStart().length).toBeGreaterThan(4);
    const empty = deriveAgentsView(agentsSource(makeThread({ id: "t", activities: [] })));
    const agents = renderAgentsPanel({ ...common, view: { ...empty, empty: true } }).map(stripAnsi);
    expect(agents.join("\n")).toContain("에이전트가 아직 없습니다");
    for (const line of [...flow, ...agents]) expect(stringWidth(line)).toBeLessThanOrEqual(44);
  });

  it("reads in English too, inside the same widths", () => {
    setLanguage("en");
    try {
      for (const columns of WIDTHS) {
        const lines = [
          ...workflowLines(columns, UNICODE_SYMBOLS),
          ...agentsLines(columns, UNICODE_SYMBOLS),
        ];
        for (const line of lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
      }
      expect(workflowLines(44, UNICODE_SYMBOLS).map(stripAnsi).join("\n")).toContain(
        "3 in parallel",
      );
    } finally {
      setLanguage("ko");
    }
  });
});
