import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { KeyEvent, KeyName } from "../input/keys.ts";
import type { LinkStatus } from "../link/client.ts";
import {
  applyThreadItem,
  emptyThreadMirror,
  type ThreadMirrorState,
} from "../link/threadMirror.ts";
import { setLanguage } from "../i18n/index.ts";
import { LiveRegion, type Scheduler } from "../render/liveRegion.ts";
import { RegionSwitch } from "../render/regionSwitch.ts";
import { navBottomRows, navColumns } from "../render/navPane.ts";
import { SplitRegion, splitLayout } from "../render/splitRegion.ts";
import { tasksPaneRows } from "../render/tasksPane.ts";
import { makeStyle, type Style } from "../render/style.ts";
import { ASCII_SYMBOLS, type Symbols } from "../render/symbols.ts";
import {
  approvalRequested,
  makeConfig,
  makeProject,
  makeSession,
  makeSnapshot,
  makeThread,
  makeThreadShell,
  T0,
  threadSnapshotItem,
} from "../testing/fixtures.ts";
import { FakeTerminal } from "../testing/terminal.ts";
import { AppController, type ControllerLink } from "./controller.ts";

// Every read of a thread into the Agents view runs `agentFlow` once; counting the calls counts the reads.
const flowReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@t3tools/client-runtime/agent-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/agent-flow")>();
  return {
    ...actual,
    agentFlow: (...args: Parameters<typeof actual.agentFlow>) => {
      flowReads.count += 1;
      return actual.agentFlow(...args);
    },
  };
});

const online: LinkStatus = { phase: "online", attempt: 0, retryAt: null, detail: null };
const text = (value: string): KeyEvent => ({ type: "text", text: value });
const ctrl = (letter: string): KeyEvent => ({ type: "ctrl", letter });
const key = (name: KeyName): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: false,
});

interface Options {
  readonly columns?: number;
  readonly rows?: number;
  readonly style?: Style;
  readonly symbols?: Symbols;
  readonly startup?: boolean;
  /** Builds the controller without the split layout, as a caller that cannot have one would. */
  readonly noSplit?: boolean;
  /** Settings `sidebar`, and what remembers `/sidebar on|off`. */
  readonly sidebar?: boolean;
  readonly saveSidebar?: (on: boolean) => void;
}

/**
 * The real controller on the real region switch, drawing into a fake terminal. Timers are
 * manual: `settle` runs the paints the regions asked for.
 */
const harness = (options: Options = {}) => {
  const term = new FakeTerminal(options.columns ?? 120, options.rows ?? 30);
  const paints: Array<() => void> = [];
  const schedule: Scheduler = (run) => {
    paints.push(run);
    return () => void paints.splice(paints.indexOf(run), 1);
  };
  const out = {
    write: (chunk: string) => term.write(chunk),
    columns: () => term.columns,
    rows: () => term.rows,
  };
  const splitClosed: string[] = [];
  const region = new RegionSwitch(
    new LiveRegion(out, schedule),
    new SplitRegion(out, schedule, { divider: () => (options.symbols ? "|" : "│") }),
    out,
    {
      onClosed: (reason, part) =>
        void (splitClosed.push(reason), controller.onSplitClosed(reason, part)),
    },
  );
  const link = {
    status: online as LinkStatus,
    shell: makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({
          id: "thread-old",
          title: "오래된 스레드",
          updatedAt: "2026-10-28T09:00:00.000Z",
        }),
        makeThreadShell({
          id: "thread-new",
          title: "최근 스레드",
          updatedAt: "2026-10-30T08:00:00.000Z",
        }),
      ],
    ),
    config: makeConfig(),
    thread: emptyThreadMirror as ThreadMirrorState,
    getSettings: async () => ({ threadGoals: {} }) as never,
    updateSettings: async () => ({}) as never,
    refreshProviders: async () => [],
    retryCrewTask: async () => undefined,
    loadOlderTurns: async () => {
      throw new Error("no older page");
    },
    getCheckpointDiff: async () => "",
    openThread: () => undefined,
    closeThread: () => undefined,
    dispatch: async () => undefined,
  } satisfies ControllerLink & { thread: ThreadMirrorState; status: LinkStatus };
  const syncs: Array<() => void> = [];
  const tickers: Array<{ run: () => void; stopped: boolean }> = [];
  let clock = Date.parse(T0);
  let exited = 0;
  const controller = new AppController({
    link,
    region,
    ...(options.noSplit ? {} : { split: region }),
    ...(options.sidebar === undefined ? {} : { sidebar: options.sidebar }),
    ...(options.saveSidebar === undefined ? {} : { saveSidebar: options.saveSidebar }),
    style: options.style ?? makeStyle(false),
    ...(options.symbols ? { symbols: options.symbols } : {}),
    ticker: (run) => {
      const timer = { run, stopped: false };
      tickers.push(timer);
      return () => void (timer.stopped = true);
    },
    home: "/home/me",
    cwd: "/work/app",
    platform: "darwin",
    context: { uuid: () => "id-1", now: () => new Date(clock) },
    schedule: (run) => {
      syncs.push(run);
      return () => undefined;
    },
    now: () => clock,
    runtimeMode: "approval-required",
    continueLast: false,
    exit: () => void (exited += 1),
    ...(options.startup
      ? { startup: { banner: true, version: "0.0.127", checkUpdate: async () => null } }
      : {}),
  });
  const settle = () => {
    syncs.splice(0).forEach((run) => run());
    paints.splice(0).forEach((run) => run());
  };
  const press = (...events: KeyEvent[]) => {
    events.forEach((event) => controller.handleKey(event));
    settle();
  };
  const run = (command: string) => press(text(command), key("enter"));
  const deliver = (thread: OrchestrationThread, sequence = 3) => {
    link.thread = applyThreadItem(link.thread, threadSnapshotItem(thread, sequence));
    controller.onThread(link.thread);
    settle();
  };
  const start = () => {
    controller.onShell();
    settle();
  };
  /** Opens the newest existing thread from the thread list. */
  const openNewest = () => {
    start();
    run("/threads");
    press(key("down"), key("enter"));
  };
  const writes = () => term.writes.length;
  return {
    term,
    region,
    controller,
    link,
    splitClosed,
    settle,
    press,
    run,
    deliver,
    start,
    openNewest,
    writes,
    tickers,
    exited: () => exited,
    advance: (ms: number) => void (clock += ms),
    /** Everything written since `mark`, as one string. */
    since: (mark: number) => term.writes.slice(mark).join(""),
    screen: () => term.screen().join("\n"),
  };
};

const activity = (
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id: `event-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: "turn-1",
    sequence,
    createdAt: new Date(Date.parse(T0) + sequence * 1000).toISOString(),
  }) as unknown as OrchestrationThreadActivity;

/** A thread whose turn delegated one piece of work to a worker, still running. */
const crewThread = (id = "thread-new", title = "Implement invoice totals") =>
  makeThread({
    id,
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: T0,
      startedAt: T0,
      completedAt: null,
      assistantMessageId: null,
    },
    session: makeSession("running", { threadId: id, activeTurnId: "turn-1" }),
    activities: [
      activity(1, "task.started", {
        taskId: "crew-1",
        title,
        agentKind: "agent",
        crewRole: "worker",
        model: "GPT-6.1-Sol",
        providerInstanceId: "codex",
        status: "running",
      }),
    ],
  });

const panelOf = (h: ReturnType<typeof harness>) =>
  Array.from({ length: h.term.rows }, (_, row) =>
    h.term.text(row, splitLayout(h.term.columns).left + 1),
  );

describe("/dag-workflow", () => {
  it("stays inline until it is asked for", () => {
    const h = harness();
    h.openNewest();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.modes).not.toContain("?1049h");
  });

  it("is not a command, and not in the menu, where the controller has no split layout", () => {
    const h = harness({ noSplit: true });
    h.openNewest();
    h.press(text("/dag"));
    expect(h.screen()).not.toContain("dag-workflow");
    const withSplit = harness();
    withSplit.openNewest();
    withSplit.press(text("/dag"));
    expect(withSplit.screen()).toContain("dag-workflow");
  });

  it("opens the split layout and closes it again, saying each line of the conversation once", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    const before = h.term.normalText().filter((row) => row.includes("내 프로젝트 · 최근 스레드"));
    expect(before).toHaveLength(1);
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    expect(h.region.active()).toBe(true);
    expect(h.term.cursorVisible).toBe(true);
    expect(h.screen()).toContain("Workflow");
    // Said while the layout is up: it is on the left now, and in the scrollback once it closes.
    h.run("/help");
    expect(h.screen()).toContain("/dag-workflow");
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(false);
    expect(h.region.active()).toBe(false);
    const after = h.term.normalText();
    expect(after.filter((row) => row.includes("내 프로젝트 · 최근 스레드"))).toHaveLength(1);
    expect(after.filter((row) => row.includes("Workflow"))).toHaveLength(1);
    const help = after.filter((row) => row.includes("오른쪽에 작업 흐름 창을 열고"));
    expect(help.length).toBeGreaterThan(0);
    // Closing it again, or twice, repeats nothing.
    const total = h.term.normalText().length;
    h.run("/dag-workflow off");
    expect(h.term.normalText()).toHaveLength(total);
  });

  it("also takes the name /workflow, and on / off", () => {
    const h = harness();
    h.openNewest();
    h.run("/workflow");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-workflow on");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-workflow off");
    expect(h.term.altScreen).toBe(false);
    h.run("/dag-workflow off");
    expect(h.term.altScreen).toBe(false);
  });

  it("refuses a terminal narrower than 100 columns and writes nothing for it", () => {
    const h = harness({ columns: 99 });
    h.openNewest();
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(false);
    expect(h.term.modes).not.toContain("?1049h");
    expect(h.screen()).toContain("100칸 미만");
  });

  it("ends the start screen first: its banner is said once, then the layout opens", () => {
    const h = harness({ startup: true, columns: 120 });
    h.start();
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-workflow");
    const rows = h.term.normalText();
    expect(rows.filter((row) => row.includes("0.0.127"))).toHaveLength(1);
  });
});

describe("the panel", () => {
  it("shows the flow of the thread on screen, with its crew", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Workflow");
    expect(panel).toContain("턴 1 · Crew");
    expect(panel).toContain("메인 에이전트");
    expect(panel).toContain("Worker");
    expect(panel).toContain("Implement invoice totals");
  });

  it("follows the thread when another one is opened", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    expect(panelOf(h).join("\n")).toContain("Implement invoice totals");
    h.run("/threads");
    h.press(key("down"), key("down"), key("enter"));
    h.deliver(crewThread("thread-old", "Second thread work"), 4);
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Second thread work");
    expect(panel).not.toContain("Implement invoice totals");
  });

  it("explains itself when the conversation has nothing to draw yet", () => {
    const h = harness();
    h.start();
    h.run("/dag-workflow");
    expect(panelOf(h).join("\n")).toContain("에이전트가");
  });

  it("stays up on the lists and says to open a thread", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.run("/threads");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("스레드를 열면");
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("says the link is down and keeps the last flow", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    h.link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
    h.controller.onLinkStatus();
    h.settle();
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("연결 끊김");
    expect(panel).toContain("Implement invoice totals");
  });

  it("picks a flow by number and refuses one that is not there, without opening", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow 5");
    expect(h.term.altScreen).toBe(false);
    expect(h.screen()).toContain("흐름 번호는 1~1 입니다.");
    h.run("/dag-workflow 1");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-workflow sideways");
    expect(h.screen()).toContain("사용법");
  });

  it("draws in ASCII with no colour: a plain divider, only ASCII marks in the panel", () => {
    const h = harness({ symbols: ASCII_SYMBOLS });
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    const { left } = splitLayout(120);
    for (let row = 0; row < h.term.rows; row += 1) expect(h.term.cell(row, left)).toBe("|");
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Worker");
    expect(panel).not.toMatch(/[○◌◐‖✓✗■⊘❯─│]/u);
    // Colour is off: nothing written carries an SGR parameter other than the reset.
    const colours = h.term.writes
      .join("")
      .split("\u001b[")
      .slice(1)
      .filter((sequence) => /^(?:[1-9]|[34]\d)[0-9;]*m/u.test(sequence));
    expect(colours).toEqual([]);
  });
});

describe("painting in the split layout", () => {
  it("writes nothing when the frame is the same, even if the controller renders again", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    const mark = h.writes();
    h.controller.render();
    h.controller.render();
    h.settle();
    expect(h.writes()).toBe(mark);
  });

  it("writes only the rows that changed when a spinner ticks", () => {
    const h = harness();
    h.openNewest();
    h.deliver(crewThread());
    h.run("/dag-workflow");
    const mark = h.writes();
    h.advance(1000);
    h.tickers.filter((timer) => !timer.stopped).forEach((timer) => timer.run());
    h.settle();
    const written = h.since(mark);
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain("\u001b[2J");
    expect(written).not.toContain("Implement invoice totals");
  });

  it("keeps everything on the left within the conversation column", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.controller.handleKey(text("가".repeat(150)));
    h.settle();
    const { left } = splitLayout(120);
    for (let row = 0; row < h.term.rows; row += 1) {
      expect(h.term.cell(row, left)).toBe("│");
      expect(h.term.cell(row, left - 1).trim()).toBe("");
    }
  });
});

describe("approvals in the split layout", () => {
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "rm -rf build")],
    });

  it("keeps the options unselected, inside the conversation column", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.deliver(waiting());
    const left = Array.from({ length: h.term.rows }, (_, row) =>
      h.term.text(row, 0, splitLayout(120).left),
    ).join("\n");
    expect(left).toContain("승인 필요: 명령 실행");
    expect(left).toContain("rm -rf build");
    expect(left).not.toContain("● 1 허용");
    expect(left).toContain("○ 1 허용");
    h.press(text("1"));
    expect(h.screen()).toContain("● 1 허용");
  });
});

describe("leaving the program with the layout open", () => {
  it("/exit with the layout open: the screen is restored and the farewell is said once", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.run("/exit");
    expect(h.exited()).toBe(1);
    h.controller.farewell(0);
    h.region.clear();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.cursorVisible).toBe(true);
    const rows = h.term.normalText();
    expect(rows.filter((row) => row.includes("다음에 또 봐요"))).toHaveLength(1);
    expect(rows.filter((row) => row.includes("내 프로젝트 · 최근 스레드"))).toHaveLength(1);
  });

  it("restores the normal screen once when the controller stops", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.region.clear();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.cursorVisible).toBe(true);
    const mark = h.writes();
    h.region.restore();
    expect(h.writes()).toBe(mark);
  });

  it("closes itself when the terminal shrinks, and the notice is on the screen", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.region.hold();
    h.term.resize(80, 30);
    h.region.release();
    h.settle();
    expect(h.term.altScreen).toBe(false);
    expect(h.splitClosed).toHaveLength(1);
    expect(h.screen()).toContain("분리 창을 닫았습니다");
  });
});

describe("/dag-agents", () => {
  /** The worker has a thread of its own, which is how a waiting request is tied to its task. */
  const withCrewThread = (running = true) => {
    const base = crewThread();
    const [started] = base.activities;
    return {
      ...base,
      latestTurn: running
        ? base.latestTurn
        : {
            ...base.latestTurn!,
            state: "completed" as const,
            completedAt: "2026-10-30T09:05:00.000Z",
          },
      session: running ? base.session : makeSession("ready", { threadId: "thread-new" }),
      activities: [
        { ...started!, payload: { ...(started!.payload as object), threadId: "crew-thread-1" } },
      ],
    } as OrchestrationThread;
  };
  const crewShell = (over: Record<string, unknown> = {}) =>
    makeThreadShell({
      id: "crew-thread-1",
      title: "Crew Worker · Implement invoice totals",
      parentThreadId: "thread-new",
      ...over,
    });
  const setShell = (
    h: ReturnType<typeof harness>,
    extra: ReadonlyArray<ReturnType<typeof makeThreadShell>>,
  ) => {
    h.link.shell = makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({
          id: "thread-old",
          title: "오래된 스레드",
          updatedAt: "2026-10-28T09:00:00.000Z",
        }),
        makeThreadShell({
          id: "thread-new",
          title: "최근 스레드",
          updatedAt: "2026-10-30T08:00:00.000Z",
        }),
        ...extra,
      ],
    );
    h.controller.onShell();
    h.settle();
  };
  /** An earlier turn that finished its crew task, and the newest that is still running its own. */
  const twoTurns = () => {
    const base = withCrewThread();
    const task = (id: string, title: string, turnId: string, sequence: number) =>
      ({
        ...activity(sequence, "task.started", {
          taskId: id,
          title,
          agentKind: "agent",
          crewRole: "worker",
          model: "GPT-6.1-Sol",
          providerInstanceId: "codex",
          status: "running",
        }),
        turnId,
      }) as unknown as OrchestrationThreadActivity;
    const done = {
      ...activity(2, "task.completed", {
        taskId: "crew-a",
        crewRole: "worker",
        status: "completed",
      }),
      turnId: "turn-1",
    } as unknown as OrchestrationThreadActivity;
    return {
      ...base,
      latestTurn: { ...base.latestTurn!, turnId: "turn-2" },
      session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-2" }),
      activities: [
        task("crew-a", "First turn work", "turn-1", 1),
        done,
        task("crew-b", "Second turn work", "turn-2", 3),
      ],
    } as unknown as OrchestrationThread;
  };
  const count = (list: ReadonlyArray<string>, mode: string) =>
    list.filter((entry) => entry === mode).length;

  it("opens the split layout on the Agents view, and typing it again closes it, each line said once", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    expect(h.term.altScreen).toBe(true);
    expect(h.region.active()).toBe(true);
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Agents");
    expect(panel).toContain("/dag-agents 로 닫기");
    expect(panel).not.toContain("/dag-workflow");
    h.run("/dag-agents");
    expect(h.term.altScreen).toBe(false);
    const rows = h.term.normalText();
    expect(rows.filter((row) => row.includes("내 프로젝트 · 최근 스레드"))).toHaveLength(1);
    expect(rows.filter((row) => row.includes("Agents  /dag-agents"))).toHaveLength(0);
    // Closing again repeats nothing.
    const total = h.term.normalText().length;
    h.run("/dag-agents off");
    expect(h.term.normalText()).toHaveLength(total);
  });

  it("switches views without closing the layout, and each command closes its own view", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-workflow");
    expect(panelOf(h).join("\n")).toContain("Workflow");
    const entered = count(h.term.modes, "?1049h");
    h.run("/dag-agents");
    // The layout stayed up: it was not left and entered again.
    expect(h.term.altScreen).toBe(true);
    expect(h.region.active()).toBe(true);
    expect(count(h.term.modes, "?1049h")).toBe(entered);
    expect(count(h.term.modes, "?1049l")).toBe(0);
    expect(panelOf(h).join("\n")).toContain("/dag-agents 로 닫기");
    expect(panelOf(h).join("\n")).not.toContain("/dag-workflow 로 닫기");
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    // Typed once more, the view that is up closes.
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(false);
    h.run("/dag-agents");
    h.run("/dag-workflow on");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    h.run("/dag-agents on");
    expect(panelOf(h).join("\n")).toContain("/dag-agents 로 닫기");
    h.run("/dag-agents live");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-agents off");
    expect(h.term.altScreen).toBe(false);
  });

  it("does not close the other view when told off", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.run("/dag-agents off");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    // It is not ignored in silence: one line says which view is up and how to close it.
    expect(h.screen()).toContain("Agents 창은 열려 있지 않습니다");
    h.run("/dag-agents");
    h.run("/dag-workflow off");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-agents 로 닫기");
    expect(h.screen()).toContain("Workflow 창은 열려 있지 않습니다");
  });

  it("flips between the Workflow and Agents tabs with Tab, and Shift-Tab, keeping the layout", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-workflow");
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    h.press(key("tab"));
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-agents 로 닫기");
    expect(panelOf(h).join("\n")).toContain("흐름 · 이번 턴");
    h.press(key("backtab"));
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    // With the panel closed Tab is not taken.
    h.run("/dag-workflow");
    h.press(key("tab"));
    expect(h.term.altScreen).toBe(false);
  });

  it("keeps the flow picked in the Workflow view when going to Agents and back", () => {
    const h = harness();
    h.openNewest();
    h.deliver(twoTurns());
    // The flow still running is followed; picking the finished one pins it.
    h.run("/dag-workflow");
    expect(panelOf(h).join("\n")).toContain("Second turn work");
    h.run("/dag-workflow 1");
    expect(panelOf(h).join("\n")).toContain("First turn work");
    h.run("/dag-agents");
    expect(panelOf(h).join("\n")).toContain("Second turn work");
    h.run("/dag-workflow");
    const back = panelOf(h).join("\n");
    expect(back).toContain("First turn work");
    expect(back).not.toContain("Second turn work");
    // A pick for the other view still switches to it.
    h.run("/dag-agents");
    h.run("/dag-workflow 1");
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
  });

  it("explains that there is one turn to show for a number, next and prev, and opens nothing", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    for (const word of ["2", "next", "prev"]) {
      h.run(`/dag-agents ${word}`);
      expect(h.term.altScreen).toBe(false);
      expect(h.screen()).toContain("현재 턴을 보여 줍니다");
    }
    // With the Workflow view up it stays there.
    h.run("/dag-workflow");
    h.run("/dag-agents next");
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
    h.run("/dag-agents sideways");
    expect(h.screen()).toContain("사용법: /dag-agents [on|off|live]");
  });

  it("refuses a terminal narrower than 100 columns and writes nothing for it", () => {
    const h = harness({ columns: 99 });
    h.openNewest();
    h.run("/dag-agents");
    expect(h.term.altScreen).toBe(false);
    expect(h.term.modes).not.toContain("?1049h");
    expect(h.screen()).toContain("100칸 미만");
  });

  it("ends the start screen first: its banner is said once, then the layout opens", () => {
    const h = harness({ startup: true, columns: 120 });
    h.start();
    h.run("/dag-agents");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-agents");
    expect(h.term.normalText().filter((row) => row.includes("0.0.127"))).toHaveLength(1);
  });

  it("is in the menu and in /help only where there is a split layout", () => {
    const bare = harness({ noSplit: true });
    bare.openNewest();
    bare.press(text("/dag"));
    expect(bare.screen()).not.toContain("dag-agents");
    bare.run("/dag-agents");
    expect(bare.term.altScreen).toBe(false);
    const h = harness();
    h.openNewest();
    h.press(text("/dag"));
    expect(h.screen()).toContain("dag-agents");
    expect(h.screen()).toContain("dag-workflow");
    const helped = harness({ rows: 60 });
    helped.openNewest();
    helped.run("/help");
    expect(helped.screen()).toContain("/dag-agents");
  });

  it("shows the lead and the crew of the thread on screen, with the crew's own words", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Lead");
    expect(panel).toMatch(/Worker\s+GPT-6\.1-Sol\s+진행 중/u);
    expect(panel).toContain("Implement invoice totals");
    expect(panel).toContain("GPT-6.1-Sol");
    expect(panel).toContain("Crew 이번 턴");
    expect(panel).toContain("흐름 · 이번 턴");
  });

  it("marks a crew task that waits for an approval, and the lead that waits for an answer", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    expect(panelOf(h).join("\n")).not.toMatch(/승인 대기|질문 대기/u);
    setShell(h, [crewShell({ hasPendingApprovals: true })]);
    const worker = panelOf(h).find((row) => row.includes("Worker"));
    expect(worker).toContain("승인 대기");
    setShell(h, [crewShell()]);
    expect(panelOf(h).join("\n")).not.toMatch(/승인 대기|질문 대기/u);
    // The lead's own thread asks a question.
    h.link.shell = makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({
          id: "thread-old",
          title: "오래된 스레드",
          updatedAt: "2026-10-28T09:00:00.000Z",
        }),
        makeThreadShell({
          id: "thread-new",
          title: "최근 스레드",
          updatedAt: "2026-10-30T08:00:00.000Z",
          hasPendingUserInput: true,
        }),
        crewShell(),
      ],
    );
    h.controller.onShell();
    h.settle();
    expect(panelOf(h).find((row) => row.includes("Lead"))).toContain("질문 대기");
  });

  it("follows the thread when another one is opened, and says to open one on the lists", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    expect(panelOf(h).join("\n")).toContain("Implement invoice totals");
    h.run("/threads");
    expect(panelOf(h).join("\n")).toContain("스레드를 열면");
    h.press(key("down"), key("down"), key("enter"));
    h.deliver(crewThread("thread-old", "Second thread work"), 4);
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Second thread work");
    expect(panel).not.toContain("Implement invoice totals");
  });

  it("explains itself when the conversation has nothing to show yet", () => {
    const h = harness();
    h.openNewest();
    h.deliver(makeThread({ id: "thread-new" }));
    h.run("/dag-agents");
    expect(panelOf(h).join("\n")).toContain("이 스레드가 실행되면");
    // A new conversation that is not on the server yet has nothing to read either.
    const early = harness();
    early.start();
    early.run("/dag-agents");
    expect(panelOf(early).join("\n")).toContain("이 스레드가 실행되면");
  });

  it("says it is loading for a thread that has not arrived, and promises nothing while the link is down", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-agents");
    expect(panelOf(h).join("\n")).toContain("불러오는 중");
    expect(panelOf(h).join("\n")).not.toContain("실행되면");
    h.link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
    h.controller.onLinkStatus();
    h.settle();
    const down = panelOf(h).join("\n");
    expect(down).toContain("연결 끊김");
    expect(down).not.toContain("실행되면");
    expect(down).not.toContain("불러오는 중…");
    // An empty thread read earlier makes no promise while the link is down either.
    h.link.status = online;
    h.controller.onLinkStatus();
    h.deliver(makeThread({ id: "thread-new" }));
    expect(panelOf(h).join("\n")).toContain("이 스레드가 실행되면");
    h.link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
    h.controller.onLinkStatus();
    h.settle();
    expect(panelOf(h).join("\n")).not.toContain("실행되면");
  });

  it("says the link is down and keeps the last agents", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    h.link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
    h.controller.onLinkStatus();
    h.settle();
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("연결 끊김");
    expect(panel).toContain("Implement invoice totals");
  });

  it("draws in ASCII: a plain divider and only ASCII marks", () => {
    const h = harness({ symbols: ASCII_SYMBOLS });
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    const { left } = splitLayout(120);
    for (let row = 0; row < h.term.rows; row += 1) expect(h.term.cell(row, left)).toBe("|");
    const panel = panelOf(h).join("\n");
    expect(panel).toContain("Worker");
    expect(panel).not.toMatch(/[○◌◐‖✓✗■⊘❯─│]/u);
  });

  it("writes nothing for an identical frame, and only the panel's changed rows as time passes", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    let mark = h.writes();
    let reads = flowReads.count;
    h.controller.render();
    h.controller.render();
    h.settle();
    expect(h.writes()).toBe(mark);
    // Drawing again reads the thread again for nothing.
    expect(flowReads.count).toBe(reads);
    mark = h.writes();
    h.advance(1000);
    h.tickers.filter((timer) => !timer.stopped).forEach((timer) => timer.run());
    h.settle();
    const written = h.since(mark);
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain("\u001b[2J");
    // Time passing redraws the clocks but reads nothing: the thread is the same.
    expect(flowReads.count).toBe(reads);
    // A new activity is a different thread: read once.
    reads = flowReads.count;
    h.deliver(
      {
        ...withCrewThread(),
        activities: [
          ...withCrewThread().activities,
          activity(9, "task.progress", { taskId: "crew-1", summary: "Editing" }),
        ],
      } as OrchestrationThread,
      4,
    );
    expect(flowReads.count).toBe(reads + 1);
  });

  it("writes nothing when a thread update leaves what the panel reads the same", () => {
    const h = harness();
    h.openNewest();
    const thread = withCrewThread(false);
    h.deliver(thread);
    h.run("/dag-agents");
    const reads = flowReads.count;
    h.deliver({ ...thread, title: "새 제목" } as OrchestrationThread, 4);
    // The title is not something the panel reads, so the thread is not read again.
    expect(flowReads.count).toBe(reads);
  });

  it("does not read the thread again when the thread list changes but the same crew threads wait", () => {
    const h = harness();
    h.openNewest();
    h.deliver(withCrewThread());
    h.run("/dag-agents");
    setShell(h, [crewShell({ hasPendingApprovals: true })]);
    let reads = flowReads.count;
    // A new list with the same thread waiting for the same thing (another thread was renamed).
    setShell(h, [crewShell({ hasPendingApprovals: true })]);
    setShell(h, [
      crewShell({ hasPendingApprovals: true }),
      makeThreadShell({ id: "other", title: "other" }),
    ]);
    expect(flowReads.count).toBe(reads);
    // What it waits for changes: read once.
    setShell(h, [crewShell({ hasPendingUserInput: true })]);
    expect(flowReads.count).toBe(reads + 1);
    expect(panelOf(h).find((row) => row.includes("Worker"))).toContain("질문 대기");
    reads = flowReads.count;
    setShell(h, [crewShell({ hasPendingUserInput: true, title: "Crew Worker · renamed" })]);
    expect(flowReads.count).toBe(reads);
  });

  describe("the clocks", () => {
    const running = (h: ReturnType<typeof harness>) =>
      h.tickers.filter((timer) => !timer.stopped).length;
    const waitingOnApproval = () => {
      const thread = withCrewThread();
      return {
        ...thread,
        session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
        activities: [...thread.activities, approvalRequested("req-1", "rm -rf build")],
      } as unknown as OrchestrationThread;
    };

    it("keep moving while the lead waits for an approval, writing the panel's rows alone", () => {
      const h = harness();
      h.openNewest();
      h.run("/dag-agents");
      h.deliver(waitingOnApproval());
      expect(h.screen()).toContain("승인 필요: 명령 실행");
      // The spinner is still, but the clocks have their own timer.
      expect(running(h)).toBe(1);
      const before = panelOf(h).join("\n");
      const mark = h.writes();
      const reads = flowReads.count;
      h.advance(2000);
      h.tickers.filter((timer) => !timer.stopped).forEach((timer) => timer.run());
      h.settle();
      expect(panelOf(h).join("\n")).not.toBe(before);
      const written = h.since(mark);
      expect(written.length).toBeGreaterThan(0);
      // Neither the approval nor the composer is written again, and nothing is read again.
      expect(written).not.toContain("승인 필요");
      expect(written).not.toContain("허용");
      expect(written).not.toContain("Implement invoice totals");
      expect(flowReads.count).toBe(reads);
      // The options are still unselected after the tick.
      expect(h.screen()).toContain("○ 1 허용");
    });

    /** The turn is over, but a subagent it started still works. */
    const backgroundWork = () => {
      const thread = withCrewThread(false);
      return {
        ...thread,
        activities: [
          activity(1, "task.started", {
            taskId: "bg-1",
            title: "Background indexer",
            agentKind: "agent",
            taskType: "local_agent",
          }),
        ],
      } as unknown as OrchestrationThread;
    };

    it("stop when there is nothing to time: another view, a lost link, a closed layout, a finished agent", () => {
      const h = harness();
      h.openNewest();
      h.run("/dag-agents");
      h.deliver(backgroundWork());
      expect(running(h)).toBe(1);
      h.run("/dag-workflow");
      expect(running(h)).toBe(0);
      h.run("/dag-agents");
      expect(running(h)).toBe(1);
      h.link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
      h.controller.onLinkStatus();
      h.settle();
      expect(running(h)).toBe(0);
      h.link.status = online;
      h.controller.onLinkStatus();
      h.settle();
      expect(running(h)).toBe(1);
      h.run("/dag-agents");
      expect(h.term.altScreen).toBe(false);
      expect(running(h)).toBe(0);
      h.run("/dag-agents");
      expect(running(h)).toBe(1);
      const done = backgroundWork();
      h.deliver(
        {
          ...done,
          activities: [
            ...done.activities,
            activity(2, "task.completed", { taskId: "bg-1", status: "completed" }),
          ],
        } as unknown as OrchestrationThread,
        6,
      );
      expect(running(h)).toBe(0);
    });

    it("do not add a second timer while the spinner runs, and write nothing when idle", () => {
      const h = harness();
      h.openNewest();
      h.run("/dag-agents");
      h.deliver(withCrewThread());
      expect(running(h)).toBe(1);
      const mark = h.writes();
      h.deliver(withCrewThread(false), 5);
      h.advance(5000);
      h.tickers.filter((timer) => !timer.stopped).forEach((timer) => timer.run());
      h.settle();
      expect(running(h)).toBe(0);
      const idle = h.writes();
      h.advance(60_000);
      h.settle();
      expect(h.writes()).toBe(idle);
      expect(mark).toBeLessThan(idle);
    });
  });

  it("keeps the approval options unselected, inside the conversation column", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-agents");
    h.deliver(
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [approvalRequested("req-1", "rm -rf build")],
      }),
    );
    const left = Array.from({ length: h.term.rows }, (_, row) =>
      h.term.text(row, 0, splitLayout(120).left),
    ).join("\n");
    expect(left).toContain("승인 필요: 명령 실행");
    expect(left).toContain("○ 1 허용");
    expect(left).not.toContain("● 1 허용");
  });

  it("leaves the alternate screen once when the program ends with the Agents view up", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-agents");
    h.run("/exit");
    h.controller.farewell(0);
    h.region.clear();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.cursorVisible).toBe(true);
    expect(h.term.normalText().filter((row) => row.includes("다음에 또 봐요"))).toHaveLength(1);
  });

  it("closes itself when the terminal shrinks, and opens again on the view asked for", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    h.run("/dag-agents");
    h.region.hold();
    h.term.resize(80, 30);
    h.region.release();
    h.settle();
    expect(h.term.altScreen).toBe(false);
    expect(h.screen()).toContain("분리 창을 닫았습니다");
    h.term.resize(120, 30);
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("/dag-workflow 로 닫기");
  });
});

describe("/tasks", () => {
  type Status = "pending" | "inProgress" | "completed";
  const planActivity = (
    sequence: number,
    statuses: ReadonlyArray<Status>,
    turnId = "turn-1",
    extra: Record<string, unknown> = {},
  ): OrchestrationThreadActivity =>
    ({
      ...activity(sequence, "turn.plan.updated", {
        plan: statuses.map((status, index) => ({ step: `단계 ${index + 1}`, status })),
        ...extra,
      }),
      turnId,
    }) as unknown as OrchestrationThreadActivity;
  const turn = (turnId: string, state: "running" | "completed") => ({
    turnId,
    state,
    requestedAt: T0,
    startedAt: T0,
    completedAt: state === "completed" ? T0 : null,
    assistantMessageId: null,
  });
  const idle = (id: string, activities: OrchestrationThreadActivity[], turnId = "turn-1") =>
    makeThread({
      id,
      latestTurn: turn(turnId, "completed"),
      session: makeSession("ready", { threadId: id }),
      activities,
    });
  const rowsOf = (h: ReturnType<typeof harness>) => h.screen().split("\n");

  it("stays off until asked for, and is a command only where there is a split layout", () => {
    const h = harness();
    h.openNewest();
    expect(h.term.altScreen).toBe(false);
    h.press(text("/ta"));
    expect(h.screen()).toContain("/tasks");
    const bare = harness({ noSplit: true });
    bare.openNewest();
    bare.press(text("/ta"));
    expect(bare.screen()).not.toContain("작업 목록 열기");
  });

  it("splits the left column: the conversation above, the list below, the whole width, no divider", () => {
    const h = harness({ columns: 80, rows: 30 });
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["completed", "inProgress", "pending"])]));
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    expect(h.term.cursorVisible).toBe(true);
    const rows = rowsOf(h);
    const top = rows.findIndex((row) => row.startsWith("── 작업 1/3"));
    expect(top).toBe(30 - tasksPaneRows(30));
    expect(rows.slice(top + 1, top + 4).map((row) => row.trimEnd())).toEqual([
      "  ☑ 단계 1",
      "  ◐ 단계 2",
      "  ☐ 단계 3",
    ]);
    // The composer is part of the conversation above the list; no divider, and the rule spans the width.
    expect(rows.slice(0, top).join("\n")).toContain("hello.ts에 add 함수");
    for (let row = 0; row < h.term.rows; row += 1) {
      expect(h.term.cell(row, splitLayout(80).left)).not.toBe("│");
    }
    expect(rows[top]?.trimEnd().length).toBeGreaterThan(70);
    expect(h.term.cell(5, 79)).toBe(" ");
  });

  it("closes and opens again, saying each line of the conversation once", () => {
    const h = harness();
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress"])]));
    h.run("/tasks");
    h.run("/help");
    h.run("/tasks");
    expect(h.term.altScreen).toBe(false);
    expect(h.region.active()).toBe(false);
    const helpRows = h.term
      .normalText()
      .filter((row) => row.includes("왼쪽 아래에 이 스레드의 작업 목록"));
    expect(helpRows).toHaveLength(1);
    h.run("/tasks on");
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).toContain("작업 0/1");
    h.run("/tasks off");
    expect(h.term.altScreen).toBe(false);
    h.run("/tasks off");
    expect(h.screen()).toContain("작업 목록이 열려 있지 않습니다");
  });

  it("rejects words it does not take, opening nothing", () => {
    const h = harness();
    h.openNewest();
    h.run("/tasks maybe");
    expect(h.term.altScreen).toBe(false);
    expect(h.screen()).toContain("사용법: /tasks [on|off]");
  });

  it("keeps the last list through a later turn that made none, as the desktop app does", () => {
    const h = harness();
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["completed", "pending"])]));
    h.run("/tasks");
    expect(h.screen()).toContain("작업 1/2");
    h.deliver(idle("thread-new", [planActivity(1, ["completed", "pending"])], "turn-2"), 4);
    expect(h.screen()).toContain("작업 1/2");
    h.deliver(
      idle(
        "thread-new",
        [
          planActivity(1, ["completed", "pending"]),
          planActivity(2, ["completed", "completed"], "turn-2"),
        ],
        "turn-2",
      ),
      5,
    );
    expect(h.screen()).toContain("작업 2/2");
  });

  it("says there is no list yet, for a thread with none and for one not read yet", () => {
    const h = harness();
    h.start();
    h.run("/tasks");
    expect(h.screen()).toContain("아직 작업 목록이 없습니다");
    h.run("/threads");
    h.press(key("down"), key("enter"));
    expect(h.screen()).toContain("불러오는 중…");
    h.deliver(idle("thread-new", []));
    expect(h.screen()).toContain("아직 작업 목록이 없습니다");
  });

  it("follows the thread when another one is opened", () => {
    const h = harness();
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress", "pending"])]));
    h.run("/tasks");
    expect(h.screen()).toContain("작업 0/2");
    h.run("/threads");
    h.press(key("down"), key("down"), key("enter"));
    h.deliver(idle("thread-old", [planActivity(1, ["completed", "completed", "inProgress"])]), 4);
    expect(h.screen()).toContain("작업 2/3");
    expect(h.screen()).not.toContain("작업 0/2");
  });

  it("scrolls a long list to the step under way", () => {
    const h = harness({ rows: 24 });
    h.openNewest();
    const statuses: Status[] = Array.from({ length: 20 }, (_, i) =>
      i < 10 ? "completed" : i === 10 ? "inProgress" : "pending",
    );
    h.deliver(idle("thread-new", [planActivity(1, statuses)]));
    h.run("/tasks");
    const screen = h.screen();
    expect(screen).toContain("작업 10/20");
    expect(screen).toContain("◐ 단계 11");
    expect(screen).toMatch(/… 위로 \d+개/u);
    expect(screen).toMatch(/… 아래로 \d+개/u);
  });

  it("works with the side panel open, and each closes without the other", () => {
    const h = harness();
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress"])]));
    h.run("/dag-workflow");
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    const { left } = splitLayout(120);
    expect(h.screen()).toContain("작업 0/1");
    expect(h.term.cell(2, left)).toBe("│");
    expect(h.term.text(h.term.rows - 2, left + 1)).not.toContain("작업");
    expect(panelOf(h).join("\n")).toContain("Workflow");
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).toContain("작업 0/1");
    expect(h.term.cell(2, left)).not.toBe("│");
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(true);
    expect(panelOf(h).join("\n")).toContain("Workflow");
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).not.toContain("작업 0/1");
    h.run("/dag-workflow");
    expect(h.term.altScreen).toBe(false);
  });

  it("works with the side panel opened after the list, and the list opened over the panel", () => {
    const h = harness();
    h.openNewest();
    h.run("/tasks");
    h.run("/dag-agents");
    expect(h.screen()).toContain("작업");
    expect(h.term.cell(2, splitLayout(120).left)).toBe("│");
    h.run("/dag-agents");
    h.run("/tasks");
    expect(h.term.altScreen).toBe(false);
  });

  it("refuses a terminal too short or too narrow, writes nothing for it, and says why", () => {
    const short = harness({ rows: 15 });
    short.openNewest();
    short.run("/tasks");
    expect(short.term.altScreen).toBe(false);
    expect(short.term.modes).not.toContain("?1049h");
    expect(short.screen()).toContain("16줄 미만");
    const narrow = harness({ columns: 39 });
    narrow.openNewest();
    narrow.run("/tasks");
    expect(narrow.term.altScreen).toBe(false);
    expect(narrow.screen()).toContain("40칸 미만");
  });

  it("works in a terminal narrower than the side panel allows", () => {
    const h = harness({ columns: 60, rows: 24 });
    h.openNewest();
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    h.run("/dag-workflow");
    expect(h.screen()).toContain("100칸 미만");
    expect(h.term.altScreen).toBe(true);
  });

  it("resizes with the terminal, and closes itself when it gets too short, then opens again", () => {
    const h = harness({ rows: 30 });
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress"])]));
    h.run("/tasks");
    h.region.hold();
    h.term.resize(120, 45);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(rowsOf(h).findIndex((row) => row.startsWith("── 작업"))).toBe(45 - tasksPaneRows(45));
    h.region.hold();
    h.term.resize(120, 14);
    h.region.release();
    h.settle();
    expect(h.term.altScreen).toBe(false);
    expect(h.screen()).toContain("작업 목록을 쓸 수 없습니다");
    h.term.resize(120, 30);
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).toContain("작업 0/1");
  });

  it("keeps the side panel when only the task list no longer fits", () => {
    const h = harness({ rows: 30 });
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress"])]));
    h.run("/dag-workflow");
    h.run("/tasks");
    h.region.hold();
    h.term.resize(120, 14);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).toContain("작업 목록을 닫았습니다");
    expect(h.screen()).not.toContain("── 작업");
    // The list is off now: /tasks opens it again once the terminal is tall enough.
    h.term.resize(120, 30);
    h.run("/tasks");
    expect(h.screen()).toContain("작업 0/1");
    expect(h.term.altScreen).toBe(true);
  });

  it("writes nothing while idle, and only the changed rows when the list changes", () => {
    const h = harness();
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["inProgress", "pending"])]));
    h.run("/tasks");
    const mark = h.writes();
    h.controller.render();
    h.controller.render();
    h.settle();
    expect(h.writes()).toBe(mark);
    h.deliver(
      idle("thread-new", [
        planActivity(1, ["inProgress", "pending"]),
        planActivity(2, ["completed", "inProgress"]),
      ]),
      4,
    );
    const written = h.since(mark);
    expect(written).toContain("작업 1/2");
    expect(written).not.toContain("\u001b[2J");
  });

  it("does not draw the running turn's plan twice", () => {
    const h = harness();
    h.openNewest();
    h.deliver(
      makeThread({
        id: "thread-new",
        latestTurn: turn("turn-1", "running"),
        session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
        activities: [planActivity(1, ["inProgress", "pending"])],
      }),
    );
    expect(h.screen()).toContain("계획 0/2");
    h.run("/tasks");
    expect(h.screen()).not.toContain("계획 0/2");
    expect(h.screen()).toContain("작업 0/2");
    h.run("/tasks");
    expect(h.screen()).toContain("계획 0/2");
  });

  it("keeps the approval options inside the conversation, above the list", () => {
    const h = harness();
    h.openNewest();
    h.run("/tasks");
    h.deliver(
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [approvalRequested("req-1", "rm -rf build"), planActivity(2, ["inProgress"])],
      }),
    );
    const rows = rowsOf(h);
    const top = rows.findIndex((row) => row.startsWith("── 작업"));
    expect(rows.slice(0, top).join("\n")).toContain("승인 필요: 명령 실행");
    expect(rows.slice(0, top).join("\n")).toContain("○ 1 허용");
    h.press(text("1"));
    expect(h.screen()).toContain("● 1 허용");
  });

  it("leaves the plan's fold alone with Ctrl-T while the list shows the plan instead", () => {
    const h = harness();
    h.openNewest();
    h.deliver(
      makeThread({
        id: "thread-new",
        latestTurn: turn("turn-1", "running"),
        session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
        activities: [planActivity(1, ["inProgress", "pending"])],
      }),
    );
    expect(h.screen()).toContain("Ctrl-T 접기");
    h.run("/tasks");
    h.press({ type: "ctrl", letter: "t" });
    h.run("/tasks");
    // The fold was not changed behind the list: the plan is as open as it was.
    expect(h.screen()).toContain("◐ 단계 1");
  });

  it("hides the pull-back hint of the queue while an approval waits, since the arrow answers the panel", () => {
    const h = harness();
    h.openNewest();
    const running = (activities: OrchestrationThreadActivity[]) =>
      makeThread({
        id: "thread-new",
        latestTurn: turn("turn-1", "running"),
        session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
        activities,
      });
    h.deliver(running([]));
    h.run("다음 할 일");
    expect(h.screen()).toContain("↑ 꺼내기");
    h.deliver(running([approvalRequested("req-1", "rm -rf build")]));
    expect(h.screen()).toContain("승인 필요");
    expect(h.screen()).toContain("대기 1건");
    expect(h.screen()).not.toContain("꺼내기");
  });

  it("slash menu opens above the list and the composer keeps its place", () => {
    const h = harness();
    h.openNewest();
    h.run("/tasks");
    h.press(text("/"));
    const rows = rowsOf(h);
    const top = rows.findIndex((row) => row.startsWith("── 작업"));
    expect(rows.slice(0, top).join("\n")).toContain("/model");
  });

  it("leaves the alternate screen once when the program ends with the list up", () => {
    const h = harness();
    h.openNewest();
    h.run("/tasks");
    h.run("/exit");
    expect(h.exited()).toBe(1);
    h.controller.farewell(0);
    h.region.clear();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.cursorVisible).toBe(true);
    expect(h.term.normalText().filter((row) => row.includes("다음에 또 봐요"))).toHaveLength(1);
  });

  it("ends the start screen first: its banner is said once, then the layout opens", () => {
    const h = harness({ startup: true });
    h.start();
    h.run("/tasks");
    expect(h.term.altScreen).toBe(true);
    h.run("/tasks");
    expect(h.term.normalText().filter((row) => row.includes("0.0.127"))).toHaveLength(1);
  });

  it("draws in ASCII with no colour", () => {
    const h = harness({ symbols: ASCII_SYMBOLS });
    h.openNewest();
    h.deliver(idle("thread-new", [planActivity(1, ["completed", "inProgress"])]));
    h.run("/tasks");
    const screen = h.screen();
    expect(screen).toContain("-- 작업 1/2");
    expect(screen).toContain("[x] 단계 1");
    expect(screen).toContain("[~] 단계 2");
  });
});

describe("/sidebar", () => {
  type H = ReturnType<typeof harness>;
  /** The text of the first `width` cells of every row (a wide character is one string, two cells). */
  const leftEdge = (h: H, width: number) =>
    Array.from({ length: h.term.rows }, (_, row) => h.term.text(row, 0, width));
  /**
   * The row of the list that holds `title`, cut to `width` cells, in the form `<pick><current><state> <title>`:
   * a thread is two rows (its project and status, then its title under it), and the marks are read off the
   * first. The conversation's own mentions of the title are not it.
   */
  const listRow = (h: H, title: string, width = h.term.columns) => {
    const rows = leftEdge(h, width);
    if (title === "새 스레드") {
      const row = rows.find((candidate) => /^[❯ ][◆ ] {2}\+ 새 스레드/u.test(candidate));
      return row === undefined ? "" : `${row.slice(0, 3)} 새 스레드`;
    }
    const at = rows.findIndex(
      (row, index) =>
        row.startsWith(`    ${title}`) && /^.{3} 내 프로젝트/u.test(rows[index - 1] ?? ""),
    );
    if (at >= 0) return `${(rows[at - 1] as string).slice(0, 3)} ${title}`;
    // Under the conversation the list is compact: one row per thread, marks then title.
    const compact = rows.find((row) => new RegExp(`^[❯ ][◆ ].? ${title}`, "u").test(row));
    return compact === undefined ? "" : `${compact.slice(0, 3)} ${title}`;
  };
  /** The titles of the list, top to bottom. */
  const listTitles = (h: H, width: number) => {
    const rows = leftEdge(h, width);
    return rows.flatMap((row, index) =>
      /^.{3} 내 프로젝트/u.test(row) ? [(rows[index + 1] ?? "").trim()] : [],
    );
  };
  const ruleRow = (h: H, title: string) =>
    leftEdge(h, h.term.columns).findIndex((row) => row.startsWith(`── ${title}`));
  const thread = (id: string, title: string, over: Record<string, unknown> = {}) =>
    makeThreadShell({ id, title, updatedAt: "2026-10-30T08:00:00.000Z", ...over });
  const ready = (id: string, over: Record<string, unknown> = {}) =>
    makeThread({ id, session: makeSession("ready", { threadId: id }), ...over });

  it("stays off until asked for, and is a command only where there is a split layout", () => {
    const h = harness();
    h.openNewest();
    expect(h.term.altScreen).toBe(false);
    h.press(text("/side"));
    expect(h.screen()).toContain("/sidebar");
    const bare = harness({ noSplit: true });
    bare.openNewest();
    bare.press(text("/side"));
    expect(bare.screen()).not.toContain("/sidebar");
  });

  it("puts the project's threads in a full-height left column beside the conversation", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    expect(h.term.altScreen).toBe(true);
    const width = navColumns(140);
    // The divider runs the whole height, right after the column.
    for (let row = 0; row < 40; row += 1) expect(h.term.cell(row, width)).toBe("│");
    expect(h.term.text(0, 0, width)).toContain("── 스레드");
    // Newest first; the thread on screen carries the mark of the current one.
    expect(listRow(h, "최근 스레드", width)).not.toBe("");
    expect(listRow(h, "최근 스레드", width)).toMatch(/^ ◆ {2}최근 스레드/u);
    expect(listRow(h, "오래된 스레드", width)).toMatch(/^ {4}오래된 스레드/u);
    expect(listRow(h, "새 스레드", width)).toMatch(/^ {4}새 스레드/u);
    // The conversation is to the right of the divider and the cursor is in it.
    const right = Array.from({ length: 40 }, (_, row) => h.term.text(row, width + 1)).join("\n");
    expect(right).toContain("예: hello.ts");
    expect(h.term.cursor.col).toBeGreaterThan(width);
  });

  it("closes when typed again, and with off, and says what is already so", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.run("/sidebar on");
    expect(h.screen()).toContain("이미 열려 있습니다");
    h.run("/sidebar");
    expect(h.term.altScreen).toBe(false);
    h.run("/sidebar off");
    expect(h.screen()).toContain("열려 있지 않습니다");
    h.run("/sidebar maybe");
    expect(h.screen()).toContain("사용법: /sidebar [on|off]");
    expect(h.term.altScreen).toBe(false);
  });

  it("opens and closes with Ctrl-O too, and remembers the choice", () => {
    const saved: boolean[] = [];
    const h = harness({ columns: 140, rows: 40, saveSidebar: (on) => void saved.push(on) });
    h.openNewest();
    h.press(ctrl("o"));
    expect(h.term.altScreen).toBe(true);
    h.press(ctrl("o"));
    expect(h.term.altScreen).toBe(false);
    h.run("/sidebar on");
    expect(saved).toEqual([true, false, true]);
  });

  it("opens by itself with the first conversation when the setting is on, if the terminal has room", () => {
    const h = harness({ columns: 140, rows: 40, sidebar: true });
    h.openNewest();
    expect(h.term.altScreen).toBe(true);
    expect(h.term.text(0, 0, navColumns(140))).toContain("── 스레드");
    // Closing it by hand is not undone by the next conversation.
    h.press(ctrl("o"));
    expect(h.term.altScreen).toBe(false);
    const narrow = harness({ columns: 28, rows: 40, sidebar: true });
    narrow.openNewest();
    expect(narrow.term.altScreen).toBe(false);
  });

  it("gives the keys to the list with Tab, picks with the arrows, and Esc goes back to the input", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.press(text("draft words"));
    const width = navColumns(140);
    expect(h.screen()).toContain("Tab 으로 선택");
    h.press(key("tab"));
    expect(h.screen()).toContain("↑↓ Enter Esc");
    expect(h.term.cursorVisible).toBe(false);
    // The pick starts on the thread on screen.
    expect(listRow(h, "최근 스레드", width)).toMatch(/^❯◆ {2}최근 스레드/u);
    h.press(key("down"));
    expect(listRow(h, "오래된 스레드", width)).toMatch(/^❯ {3}오래된 스레드/u);
    // The list ends there: the pick stays on the last row.
    h.press(key("down"), key("down"));
    expect(listRow(h, "오래된 스레드", width)).toMatch(/^❯ {3}오래된 스레드/u);
    h.press(key("home"));
    expect(listRow(h, "새 스레드", width)).toMatch(/^❯/u);
    h.press(key("escape"));
    expect(h.screen()).toContain("Tab 으로 선택");
    expect(h.term.cursorVisible).toBe(true);
    // The words in the composer are still there, and typing goes on in them.
    h.press(text("!"));
    expect(h.screen()).toContain("draft words!");
    // Tab again, and Tab leaves; typing a letter leaves too and is typed.
    h.press(key("tab"), key("tab"));
    expect(h.screen()).toContain("Tab 으로 선택");
    h.press(key("tab"), text("x"));
    expect(h.screen()).toContain("draft words!x");
    expect(h.screen()).toContain("Tab 으로 선택");
  });

  it("opens the picked thread with Enter, and what is typed next goes to that thread", async () => {
    const h = harness({ columns: 140, rows: 40 });
    const opened = vi.spyOn(h.link, "openThread");
    const dispatched = vi.spyOn(h.link, "dispatch");
    h.openNewest();
    opened.mockClear();
    h.run("/sidebar");
    h.press(key("tab"), key("down"), key("enter"));
    expect(opened).toHaveBeenCalledWith("thread-old");
    // The list is still up, the keys are back in the input, and the old thread is marked.
    const width = navColumns(140);
    expect(h.term.altScreen).toBe(true);
    expect(listRow(h, "오래된 스레드", width)).toMatch(/^ ◆ {2}오래된 스레드/u);
    expect(listRow(h, "최근 스레드", width)).toMatch(/^ {4}최근 스레드/u);
    expect(h.screen()).toContain("Tab 으로 선택");
    h.deliver(ready("thread-old", { title: "오래된 스레드" }));
    h.press(text("다음 질문입니다"));
    h.press(key("enter"));
    await Promise.resolve();
    await Promise.resolve();
    const calls = dispatched.mock.calls as unknown as Array<
      [{ type: string; threadId?: string; message?: { text: string } }]
    >;
    const sent = calls
      .map(([command]) => command)
      .filter((command) => command.type === "thread.turn.start");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe("thread-old");
    expect(sent[0]?.message?.text).toBe("다음 질문입니다");
  });

  it("starts the opened thread on a clean view, and the earlier lines still reach the scrollback", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.run("/help");
    const width = navColumns(140);
    const right = () =>
      Array.from({ length: 40 }, (_, row) => h.term.text(row, width + 1)).join("\n");
    expect(right()).toContain("표시 언어");
    h.press(key("tab"), key("down"), key("enter"));
    // The opened thread begins with its own header, and the help is out of its view.
    expect(right()).toContain("· 오래된 스레드");
    expect(right()).not.toContain("표시 언어");
    // Nothing is lost: leaving the layout hands both conversations to the scrollback.
    h.press(ctrl("o"));
    const all = h.term.normalText().join("\n");
    expect(all).toContain("표시 언어");
    expect(all).toContain("· 오래된 스레드");
  });

  it("starts a new thread from its row", () => {
    const h = harness({ columns: 140, rows: 40 });
    const closed = vi.spyOn(h.link, "closeThread");
    h.openNewest();
    h.run("/sidebar");
    h.press(key("tab"), key("home"), key("enter"));
    expect(closed).toHaveBeenCalled();
    const width = navColumns(140);
    expect(listRow(h, "새 스레드", width)).toMatch(/^ ◆ {2}새 스레드/u);
    expect(listRow(h, "최근 스레드", width)).toMatch(/^ {4}최근 스레드/u);
  });

  it("shows pinned threads first with a mark, and running and waiting threads by state", () => {
    const h = harness({ columns: 140, rows: 40 });
    const pinned = {
      pinnedAt: "2026-10-02T00:00:00.000Z",
      pinOrderKey: "g",
      updatedAt: "2026-10-01T08:00:00.000Z",
    };
    const shellOf = (over: { old?: object; pin?: object } = {}) =>
      makeSnapshot(
        [makeProject()],
        [
          thread("thread-old", "오래된 스레드", {
            updatedAt: "2026-10-28T09:00:00.000Z",
            ...over.old,
          }),
          thread("thread-new", "최근 스레드"),
          thread("thread-pin", "고정한 스레드", { ...pinned, ...over.pin }),
        ],
      );
    h.link.shell = shellOf();
    h.openNewest();
    h.run("/sidebar");
    const width = navColumns(140);
    expect(listTitles(h, width)).toEqual(["고정한 스레드", "최근 스레드", "오래된 스레드"]);
    const left = leftEdge(h, width).join("\n");
    expect(left).toContain("+ 새 스레드");
    // The pinned block is told apart from the rest, as the desktop's pinned block is.
    expect(left).toContain("고정됨");
    expect(left).toContain("활성");
    expect(left).toContain("내 프로젝트 고정");
    // A thread starts running while the list is up: its row changes, and nothing is cleared.
    h.link.shell = shellOf({
      old: { session: makeSession("running", { threadId: "thread-old" }) },
      pin: { hasPendingApprovals: true },
    });
    const mark = h.writes();
    h.controller.onShell();
    h.settle();
    expect(listRow(h, "오래된 스레드", width)).toMatch(/^ {2}◐ /u);
    // The pinned thread is the one on screen, so it carries both marks.
    expect(listRow(h, "고정한 스레드", width)).toMatch(/^ ◆▲ /u);
    expect(h.since(mark)).not.toContain("\u001b[2J");
  });

  it("writes nothing while idle, and does not redraw the list when only the conversation changes", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.deliver(ready("thread-new"));
    const mark = h.writes();
    h.controller.render();
    h.controller.render();
    h.settle();
    expect(h.writes()).toBe(mark);
    h.run("/help");
    h.deliver(ready("thread-new", { title: "최근 스레드 (제목 바뀜)" }), 4);
    const after = h.writes();
    h.controller.render();
    h.settle();
    expect(h.writes()).toBe(after);
  });

  it("falls back to the same list under the conversation when the terminal is too narrow", () => {
    const h = harness({ columns: 60, rows: 24 });
    const opened = vi.spyOn(h.link, "openThread");
    h.openNewest();
    opened.mockClear();
    h.run("/sidebar");
    expect(h.term.altScreen).toBe(true);
    const top = ruleRow(h, "스레드");
    expect(top).toBe(24 - navBottomRows(24, false));
    // Full width, no divider column.
    for (let row = 0; row < 24; row += 1) expect(h.term.cell(row, navColumns(60))).not.toBe("│");
    expect(listRow(h, "최근 스레드")).toMatch(/^ ◆ {2}최근 스레드/u);
    h.press(key("tab"), key("down"), key("enter"));
    expect(opened).toHaveBeenCalledWith("thread-old");
    expect(listRow(h, "오래된 스레드")).toMatch(/^ ◆ {2}오래된 스레드/u);
    // The composer is above the list: it keeps its place and its cursor.
    h.press(text("a"));
    expect(h.term.cursor.row).toBeLessThan(top);
  });

  it("moves between the column and the bottom as the terminal is resized", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.press(key("tab"), key("down"));
    h.region.hold();
    h.term.resize(60, 24);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(h.term.altScreen).toBe(true);
    expect(ruleRow(h, "스레드")).toBe(24 - navBottomRows(24, false));
    // The pick survives the move.
    expect(listRow(h, "오래된 스레드")).toMatch(/^❯/u);
    h.region.hold();
    h.term.resize(140, 40);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(ruleRow(h, "스레드")).toBe(0);
    expect(listRow(h, "오래된 스레드", navColumns(140))).toMatch(/^❯/u);
  });

  it("closes itself in a terminal too small for it, and says why", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.region.hold();
    h.term.resize(28, 40);
    h.region.release();
    h.settle();
    expect(h.term.altScreen).toBe(false);
    // The notice is folded and cut to the width of the terminal.
    const said = () => h.screen().replace(/\s+/gu, "");
    expect(said()).toContain("분리창을닫았습니다:터미널폭이30칸미만이라스레드목록을");
    h.run("/sidebar");
    expect(h.term.altScreen).toBe(false);
    expect(said()).toContain("30칸미만");
  });

  it("works with the side panel: three columns where they fit, the list under the conversation where they do not", () => {
    const wide = harness({ columns: 160, rows: 40 });
    wide.openNewest();
    wide.run("/sidebar");
    wide.run("/dag-agents");
    const nav = navColumns(160);
    const layout = splitLayout(160, true, nav);
    expect(wide.term.cell(5, nav)).toBe("│");
    expect(wide.term.cell(5, nav + 1 + layout.left)).toBe("│");
    expect(listRow(wide, "최근 스레드", nav)).not.toBe("");
    wide.press(key("tab"), key("down"), key("enter"));
    expect(listRow(wide, "오래된 스레드", nav)).toMatch(/^ ◆ {2}오래된 스레드/u);
    // Closing the panel leaves the list, and the other way round.
    wide.run("/dag-agents");
    expect(wide.term.altScreen).toBe(true);
    expect(ruleRow(wide, "스레드")).toBe(0);
    wide.run("/sidebar");
    expect(wide.term.altScreen).toBe(false);
    const tight = harness({ columns: 104, rows: 40 });
    tight.openNewest();
    tight.run("/dag-agents");
    tight.run("/sidebar");
    expect(ruleRow(tight, "스레드")).toBe(40 - navBottomRows(40, false));
    tight.press(key("tab"), key("down"), key("enter"));
    expect(listRow(tight, "오래된 스레드")).toMatch(/^ ◆ {2}오래된 스레드/u);
  });

  it("works with /tasks: the task list stays under the conversation, the list in its column", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/tasks");
    h.run("/sidebar");
    expect(ruleRow(h, "스레드")).toBe(0);
    const nav = navColumns(140);
    const task = Array.from({ length: 40 }, (_, row) => h.term.text(row, nav + 1)).findIndex(
      (row) => row.startsWith("── 작업"),
    );
    expect(task).toBe(40 - tasksPaneRows(40));
    h.run("/tasks");
    expect(h.screen()).not.toContain("── 작업");
    expect(ruleRow(h, "스레드")).toBe(0);
  });

  it("with /tasks in a narrow terminal stacks both under the conversation, the list first", () => {
    const h = harness({ columns: 60, rows: 30 });
    h.openNewest();
    h.run("/tasks");
    h.run("/sidebar");
    const nav = ruleRow(h, "스레드");
    const task = ruleRow(h, "작업");
    expect(nav).toBeGreaterThan(0);
    expect(task).toBeGreaterThan(nav);
    h.press(key("tab"), key("down"), key("enter"));
    expect(listRow(h, "오래된 스레드")).toMatch(/^ ◆ {2}오래된 스레드/u);
  });

  it("keeps the list when only the task list no longer fits", () => {
    const h = harness({ columns: 160, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.run("/tasks");
    h.region.hold();
    h.term.resize(160, 14);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(h.term.altScreen).toBe(true);
    expect(h.screen()).toContain("작업 목록을 닫았습니다");
    expect(ruleRow(h, "스레드")).toBe(0);
  });

  it("leaves the alternate screen once when the program ends with the list up", () => {
    const h = harness({ columns: 140, rows: 40 });
    h.openNewest();
    h.run("/sidebar");
    h.region.restore();
    expect(h.term.altScreen).toBe(false);
    expect(h.term.modes.filter((mode) => mode === "?1049l")).toHaveLength(1);
  });

  it("draws in ASCII: a plain divider and only ASCII marks", () => {
    const h = harness({ columns: 140, rows: 40, symbols: ASCII_SYMBOLS });
    h.openNewest();
    h.run("/sidebar");
    h.press(key("tab"));
    const nav = navColumns(140);
    const left = leftEdge(h, nav).join("\n");
    expect(left).toContain("-- 스레드");
    expect(left).not.toMatch(/[─│◆◐▲❯]/u);
    expect(h.term.cell(5, nav)).toBe("|");
  });

  it("speaks English with no Korean of its own when the language is English", () => {
    setLanguage("en");
    try {
      const h = harness({ columns: 140, rows: 40 });
      h.link.shell = makeSnapshot(
        [makeProject({ title: "App" })],
        [thread("thread-a", "Fix login"), thread("thread-b", "Add tests")],
      );
      h.openNewest();
      h.run("/sidebar");
      const nav = navColumns(140);
      const chrome = leftEdge(h, nav).join("\n");
      expect(chrome).toContain("── Threads");
      expect(chrome).toContain("New thread");
      expect(chrome).toContain("Tab to pick");
      expect(chrome).not.toMatch(/[가-힣]/u);
      h.press(key("tab"));
      expect(h.term.text(39, 0, nav)).toBe("↑↓ Enter Esc");
      h.press(key("escape"));
      h.run("/sidebar");
      h.run("/sidebar off");
      const notice =
        h
          .screen()
          .split("\n")
          .find((row) => row.includes("The thread list")) ?? "";
      expect(notice).toContain("The thread list is not open.");
      expect(notice).not.toMatch(/[가-힣]/u);
    } finally {
      setLanguage("ko");
    }
  });

  it("is in /help", () => {
    const h = harness({ rows: 70 });
    h.openNewest();
    h.run("/help");
    expect(h.screen()).toContain("/sidebar");
    expect(h.screen()).toContain("Ctrl-O");
  });
});

describe("the wheel and the keys that scroll the split conversation", () => {
  const wheel = (action: "wheelUp" | "wheelDown"): KeyEvent => ({
    type: "mouse",
    action,
    x: 5,
    y: 5,
  });
  const ON = "\u001b[?1000h\u001b[?1006h";
  const OFF = "\u001b[?1006l\u001b[?1000l";
  const SCROLLING = "스크롤 중";
  const opened = () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    // Enough said to need scrolling.
    for (let n = 0; n < 4; n += 1) h.run("/help");
    return h;
  };

  it("scrolls the conversation with the wheel and follows again at the bottom", () => {
    const h = opened();
    expect(h.screen()).not.toContain(SCROLLING);
    h.press(wheel("wheelUp"));
    expect(h.screen()).toContain(SCROLLING);
    for (let n = 0; n < 40; n += 1) h.controller.handleKey(wheel("wheelDown"));
    h.settle();
    expect(h.screen()).not.toContain(SCROLLING);
  });

  it("End follows the newest line again", () => {
    const h = opened();
    h.press(wheel("wheelUp"), wheel("wheelUp"));
    expect(h.screen()).toContain(SCROLLING);
    h.press(key("end"));
    expect(h.screen()).not.toContain(SCROLLING);
  });

  it("typing a command takes a scrolled-back reader to the newest line", () => {
    const h = opened();
    h.press(wheel("wheelUp"));
    h.run("/help");
    expect(h.screen()).not.toContain(SCROLLING);
  });

  it("Home goes to the top of what is kept", () => {
    const h = opened();
    h.press(key("home"));
    expect(h.screen()).toContain(SCROLLING);
  });

  it("ignores the wheel when the layout is not split", () => {
    const h = harness();
    h.openNewest();
    const mark = h.writes();
    h.press(wheel("wheelUp"));
    expect(h.writes()).toBe(mark);
  });

  it("ignores clicks", () => {
    const h = opened();
    h.press({ type: "mouse", action: "press", x: 5, y: 5 });
    expect(h.screen()).not.toContain(SCROLLING);
  });

  it("asks for wheel reports on entry, turns them off with /mouse off and back on with /mouse on", () => {
    const h = harness();
    h.openNewest();
    const mark = h.writes();
    h.run("/dag-workflow");
    expect(h.since(mark)).toContain(ON);
    const before = h.writes();
    h.run("/mouse off");
    expect(h.since(before)).toContain(OFF);
    const again = h.writes();
    h.run("/mouse on");
    expect(h.since(again)).toContain(ON);
  });

  it("gives the mouse back when the layout closes and when the program restores the screen", () => {
    const h = harness();
    h.openNewest();
    h.run("/dag-workflow");
    const mark = h.writes();
    h.run("/dag-workflow");
    expect(h.since(mark)).toContain(OFF);
    h.run("/dag-workflow");
    const crash = h.writes();
    h.region.restore();
    expect(h.since(crash)).toContain(OFF);
    expect(h.term.altScreen).toBe(false);
  });
});
