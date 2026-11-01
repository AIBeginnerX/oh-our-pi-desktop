import type { ActivePlanState } from "@t3tools/client-runtime/thread-plan";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CrewBoard, CrewTask } from "../app/crewBoard.ts";
import { setLanguage } from "../i18n/index.ts";
import { TranscriptPrinter } from "../state/transcript.ts";
import { makeActivity, makeThread } from "../testing/fixtures.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import { boardSummary, crewBarText, phaseWord, taskDetail, taskHeadline } from "./crewBoard.ts";
import { diffReportRows } from "./diffReport.ts";
import { defaultApprovalOptions, renderApprovalPanel, renderPlan } from "./panels.ts";
import type { Rail } from "./rail.ts";
import { renderStatusBar, type StatusBarInput } from "./statusBar.ts";
import { renderStats } from "./statsView.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { renderTasksPane, tasksUnavailable } from "./tasksPane.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const theme = createTheme("oop", BUILTIN_THEMES.oop, 0);
const rail: Rail = { style: makeStyle(theme), symbols: ASCII_SYMBOLS };

const crewTask = (over: Partial<CrewTask> = {}): CrewTask => ({
  taskId: "t1",
  role: "worker",
  title: "Fix the parser",
  model: "Haiku 4",
  phase: "running",
  unreported: false,
  threadId: null,
  summary: null,
  startedAt: 1_000_000,
  completedAt: null,
  tokens: 1500,
  costUsd: null,
  evidence: "tested",
  actions: { stop: false, open: false, retry: false },
  ...over,
});

describe("English terminal text", () => {
  beforeEach(() => setLanguage("en"));
  afterEach(() => setLanguage("ko"));

  it("words the approval panel in English and keeps every row inside the width", () => {
    const rows = renderApprovalPanel(
      {
        requestKind: "command",
        detail: "pnpm install",
        appName: undefined,
        options: defaultApprovalOptions(),
        selected: null,
        locked: false,
      },
      60,
      rail,
    ).map(stripAnsi);
    const text = rows.join("\n");
    expect(text).toContain("Approval needed: Run command");
    expect(text).toContain("Allow for this session");
    expect(text).toContain("move");
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
  });

  it("words the plan header, tasks pane and its size limits", () => {
    const steps = [
      { step: "Write tests", status: "completed" as const },
      { step: "Fix it", status: "inProgress" as const },
    ];
    const plan = renderPlan(steps, {
      theme,
      symbols: UNICODE_SYMBOLS,
      columns: 40,
      maxRows: 5,
      collapsed: false,
      foldable: true,
    }).map(stripAnsi);
    expect(plan[0]).toContain("Plan 1/2");
    expect(plan[0]).toContain("Ctrl-T collapse");

    const state: ActivePlanState = { createdAt: "2026-10-30T09:00:00.000Z", turnId: null, steps };
    const pane = renderTasksPane(
      { kind: "plan", plan: state },
      { columns: 40, rows: 6, theme, symbols: UNICODE_SYMBOLS },
    ).map(stripAnsi);
    expect(pane[0]).toMatch(/^── Tasks 1\/2 ─+$/u);
    expect(tasksUnavailable(80, 3)).toContain("shorter than");
  });

  it("words the status bar", () => {
    const input: StatusBarInput = {
      model: "gpt-5",
      effort: null,
      mode: null,
      cwd: "/home/me/app",
      home: "/home/me",
      branch: null,
      contextPercent: null,
      costUsd: null,
      costPartial: false,
      agents: 2,
      hint: null,
    };
    const text = stripAnsi(renderStatusBar(input, 80, theme, UNICODE_SYMBOLS, "auto"));
    expect(text).toContain("Agents 2");
  });

  it("words the stats screen without the Korean tab labels", () => {
    const rows = renderStats({
      activities: [],
      hasOlder: true,
      tab: 0,
      selected: null,
      width: 60,
      rows: 10,
      style: makeStyle(false),
      symbols: UNICODE_SYMBOLS,
    });
    const text = rows.join("\n");
    expect(text).toContain("[1] Overview");
    expect(text).toContain("r:refresh q:close");
    expect(text).toContain("No tool activity to show yet");
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
  });

  it("words the crew board", () => {
    const task = crewTask();
    expect(taskHeadline(task)).toBe("Worker  In progress · Fix the parser");
    expect(phaseWord(crewTask({ phase: "stopped", unreported: true }))).toBe("Stopped · no report");
    const rows = taskDetail(task, 1_065_000, "approval");
    expect(rows[0]).toEqual(["Task", "Fix the parser"]);
    expect(rows[2]).toEqual(["Status", "In progress · awaiting approval"]);
    const board: CrewBoard = {
      turnId: "turn-1",
      current: true,
      tasks: [task],
      notes: [],
      running: 1,
      settled: 0,
      usage: { tokens: 1500, costUsd: null },
    };
    expect(boardSummary(board)).toBe("This turn · Tasks 1 · 1 running · 1.5k tokens");
    expect(crewBarText({ on: true, board: null, waiting: 2 })).toBe(
      "crew awaiting approval/answer 2",
    );
  });

  it("words the diff report", () => {
    const rows = diffReportRows({ rail, width: 80, turn: 3, files: [], diff: "" }).map(stripAnsi);
    expect(rows.join("\n")).toContain("No files changed in this turn.");
  });

  it("words a goal verdict in the scrollback", () => {
    const printer = new TranscriptPrinter({
      width: 40,
      style: makeStyle(false),
      historyMessages: 20,
    });
    const out = printer.sync(
      makeThread({
        activities: [
          makeActivity({
            id: "g1",
            kind: "goal.met",
            createdAt: "2026-10-30T09:00:02.000Z",
            tone: "info",
            summary: "goal.met",
            payload: { goalId: "g" },
          }),
        ],
      }),
    ).commit;
    expect(out.map(stripAnsi).join("\n")).toContain("Goal reached");
  });
});
