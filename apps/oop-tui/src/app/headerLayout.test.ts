import type { OrchestrationThread } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { KeyEvent, KeyName } from "../input/keys.ts";
import type { LinkStatus } from "../link/client.ts";
import {
  applyThreadItem,
  emptyThreadMirror,
  type ThreadMirrorState,
} from "../link/threadMirror.ts";
import { setLanguage } from "../i18n/index.ts";
import { petFrameCount, petRows, type PetLook, type PetState } from "../render/pet.ts";
import { LiveRegion, type Scheduler } from "../render/liveRegion.ts";
import { RegionSwitch } from "../render/regionSwitch.ts";
import { SplitRegion } from "../render/splitRegion.ts";
import { makeStyle, type Style } from "../render/style.ts";
import { UNICODE_SYMBOLS, type Symbols } from "../render/symbols.ts";
import {
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
import { visibleWidth } from "../text/width.ts";
import { AppController, type ControllerLink } from "./controller.ts";

const online: LinkStatus = { phase: "online", attempt: 0, retryAt: null, detail: null };
const text = (value: string): KeyEvent => ({ type: "text", text: value });
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
  readonly workflow?: boolean;
  readonly saveWorkflow?: (on: boolean) => void;
  readonly pet?: boolean;
  readonly savePet?: (on: boolean) => void;
  readonly animations?: boolean;
  /** The server's config, for a test that needs the crew's settings and providers. */
  readonly config?: ReturnType<typeof makeConfig>;
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
    config: options.config ?? makeConfig(),
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
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    ...(options.saveWorkflow === undefined ? {} : { saveWorkflow: options.saveWorkflow }),
    ...(options.pet === undefined ? {} : { pet: options.pet }),
    ...(options.savePet === undefined ? {} : { savePet: options.savePet }),
    ...(options.animations === undefined ? {} : { animations: options.animations }),
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
      ? {
          startup: { banner: true, version: "0.0.133", checkUpdate: async () => null },
        }
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
    activeTimers: () => tickers.filter((timer) => !timer.stopped).length,
    exited: () => exited,
    advance: (ms: number) => void (clock += ms),
    /** Everything written since `mark`, as one string. */
    since: (mark: number) => term.writes.slice(mark).join(""),
    screen: () => term.screen().join("\n"),
  };
};

beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage("ko"));

const runningThread = (extra: Record<string, unknown> = {}) =>
  makeThread({
    id: "thread-new",
    title: "Fix the login bug",
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: T0,
      startedAt: T0,
      completedAt: null,
      assistantMessageId: null,
    },
    session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
    ...extra,
  });

/** Rows of the screen, left column only, as the conversation sees them. */
const screenRows = (h: ReturnType<typeof harness>) => h.term.screen();

/** The rows (0-based) that the writes after `mark` moved the cursor to. */
const rowsWritten = (h: ReturnType<typeof harness>, mark: number): Set<number> => {
  const rows = new Set<number>();
  // eslint-disable-next-line no-control-regex
  for (const match of h.since(mark).matchAll(/\u001b\[(\d+);\d+H/gu))
    rows.add(Number(match[1]) - 1);
  return rows;
};

describe("the default layout of a conversation", () => {
  it("opens the thread list on the left and the workflow panel on the right", () => {
    const h = harness({ startup: true, columns: 120, rows: 36, sidebar: true, workflow: true });
    h.openNewest();
    expect(h.term.altScreen).toBe(true);
    const text = screenRows(h).join("\n");
    expect(text).toContain("Threads");
    expect(text).toContain("/dag-workflow");
    // The logo and status are the top of the middle column.
    expect(screenRows(h)[0]).toMatch(/[█▄▀]/u);
    expect(text).toContain("OOP Terminal".slice(0, 3));
    expect(text).toContain("v0.0.133");
    expect(text).toContain("/work/app");
  });

  it("shows a sensible empty panel when the thread has no workflow", () => {
    const h = harness({ startup: true, columns: 120, rows: 36, sidebar: true, workflow: true });
    h.openNewest();
    const right = screenRows(h)
      .map((row) => row.slice(-40))
      .join("\n");
    expect(right).toMatch(/Workflow/u);
    expect(right).toMatch(/no workflow|No workflow|nothing|not yet|\/dag-workflow/iu);
  });

  it("keeps the conversation first on a terminal too narrow for the panel", () => {
    const h = harness({ startup: true, columns: 80, rows: 24, sidebar: true, workflow: true });
    h.openNewest();
    expect(h.term.altScreen).toBe(true);
    const text = screenRows(h).join("\n");
    expect(text).toContain("Threads");
    expect(text).not.toContain("/dag-workflow");
    expect(screenRows(h)[0]).toContain("OOP v0.0.133");
    // Nothing is said about what did not fit.
    expect(text).not.toContain("100");
  });

  it("stays in the plain layout when the terminal is too small for either pane", () => {
    const h = harness({ startup: true, columns: 60, rows: 10, sidebar: true, workflow: true });
    h.openNewest();
    expect(h.term.altScreen).toBe(false);
  });

  it("leaves the panel closed with the workflow setting off, and the list with sidebar off", () => {
    const off = harness({ startup: true, columns: 120, rows: 36, sidebar: true, workflow: false });
    off.openNewest();
    expect(off.term.altScreen).toBe(true);
    expect(screenRows(off).join("\n")).not.toContain("/dag-workflow");
    const none = harness({
      startup: true,
      columns: 120,
      rows: 36,
      sidebar: false,
      workflow: false,
    });
    none.openNewest();
    expect(none.term.altScreen).toBe(false);
  });

  it("opens by itself only on the first conversation: closing the panel keeps it closed", () => {
    const saved: boolean[] = [];
    const h = harness({
      startup: true,
      columns: 120,
      rows: 36,
      sidebar: true,
      workflow: true,
      saveWorkflow: (on) => void saved.push(on),
    });
    h.openNewest();
    h.run("/dag-workflow off");
    expect(saved).toEqual([false]);
    expect(screenRows(h).join("\n")).not.toContain("/dag-workflow 로 닫기");
    h.run("/threads");
    h.press(key("down"), key("enter"));
    expect(screenRows(h).join("\n")).not.toContain("closes");
    h.run("/dag-workflow");
    expect(saved).toEqual([false, true]);
  });

  it("closes only the panel when the terminal shrinks below 100 columns, and keeps the header", () => {
    const h = harness({ startup: true, columns: 160, rows: 45, sidebar: true, workflow: true });
    h.openNewest();
    h.region.hold();
    h.term.resize(80, 45);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(h.term.altScreen).toBe(true);
    expect(h.splitClosed).toHaveLength(1);
    expect(h.splitClosed[0]).toContain("Right panel closed");
    const text = screenRows(h).join("\n");
    expect(text).toContain("Threads");
    expect(screenRows(h)[0]).toMatch(/[█▄▀]|OOP/u);
  });
});

describe("the pinned header", () => {
  const open = (options: Options = {}) => {
    const h = harness({
      startup: true,
      columns: 120,
      rows: 36,
      sidebar: true,
      workflow: true,
      ...options,
    });
    h.openNewest();
    return h;
  };

  it("is not printed into the scrollback, and the banner reaches it once when the layout is left", () => {
    const h = open();
    h.run("/dag-workflow off");
    h.run("/sidebar off");
    expect(h.term.altScreen).toBe(false);
    const all = [...h.term.scrollback, ...h.term.normalText()].join("\n");
    expect(all.match(/v0\.0\.133/gu)?.length).toBe(1);
  });

  it("follows the thread: its title, model and working state, not stale values", () => {
    const h = open();
    expect(screenRows(h).join("\n")).toContain("Idle");
    h.deliver(runningThread());
    const top = screenRows(h).slice(0, 7).join("\n");
    expect(top).toContain("Working");
    expect(top).toContain("Fix the login bug");
    h.deliver(
      makeThread({ id: "thread-new", title: "Renamed thread", latestTurn: null, session: null }),
      4,
    );
    const after = screenRows(h).slice(0, 7).join("\n");
    expect(after).toContain("Renamed thread");
    expect(after).toContain("Idle");
  });

  it("stays on top through a long conversation and a window resize", () => {
    const h = open();
    h.region.commit(Array.from({ length: 300 }, (_, index) => `message ${index}`));
    h.settle();
    expect(screenRows(h)[0]).toMatch(/[█▄▀]/u);
    expect(screenRows(h).join("\n")).toContain("message 299");
    h.region.hold();
    h.term.resize(140, 40);
    h.region.release();
    h.controller.render();
    h.settle();
    expect(screenRows(h)[0]).toMatch(/[█▄▀]/u);
    h.region.hold();
    h.term.resize(120, 20);
    h.region.release();
    h.controller.render();
    h.settle();
    // too short for the full header: one line, the conversation keeps the room
    expect(screenRows(h)[0]).toContain("OOP v0.0.133");
    expect(screenRows(h).join("\n")).toContain("message 299");
  });

  it("is also there on the thread list, saying that no thread is open", () => {
    const h = open();
    h.run("/threads");
    expect(h.term.altScreen).toBe(true);
    const top = screenRows(h).slice(0, 7).join("\n");
    expect(top).toContain("No thread open");
    expect(top).toContain("v0.0.133");
  });

  it("is absent with the banner setting off", () => {
    const h = harness({ columns: 120, rows: 36, sidebar: true, workflow: true });
    h.openNewest();
    expect(h.term.altScreen).toBe(true);
    expect(screenRows(h).join("\n")).not.toContain("v0.0.133");
  });

  it("does not repaint the header for streamed tokens", () => {
    const h = open();
    h.deliver(runningThread());
    const streaming = (sequence: number) =>
      runningThread({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "x".repeat(sequence * 40),
            turnId: "turn-1",
            streaming: true,
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      });
    // The first words move Mocha from thinking to typing; the words after that change nothing.
    h.deliver(streaming(4), 4);
    const mark = h.term.writes.length;
    for (let sequence = 5; sequence < 12; sequence += 1) {
      h.deliver(streaming(sequence), sequence);
    }
    const rows = rowsWritten(h, mark);
    const headerRows = [0, 1, 2, 3, 4, 5, 6];
    expect(headerRows.some((row) => rows.has(row))).toBe(false);
  });
});

describe("the pet", () => {
  const open = (options: Options = {}) => {
    const h = harness({
      startup: true,
      columns: 120,
      rows: 36,
      sidebar: true,
      workflow: true,
      ...options,
    });
    h.openNewest();
    return h;
  };
  /** With no provider known she has the default coffee; plain colour makes the glyphs the same. */
  const look: PetLook = { tone: "default", from: "default" };
  /** The picture pet.ts draws for one frame of a state, plain, as this header shows it. */
  const picture = (state: PetState, frame = 0): string[] =>
    petRows(state, frame, look, makeStyle(false).theme, UNICODE_SYMBOLS).map((row) => row.trim());
  /** Whether the header carries that picture now, every row of it on the row it belongs to. */
  const shows = (h: ReturnType<typeof harness>, state: PetState, frame = 0): boolean => {
    const rows = screenRows(h).slice(0, 5);
    return picture(state, frame).every((row, index) => (rows[index] ?? "").includes(row));
  };
  /** Whether the header shows any frame of a state; the clock alone picks the frame. */
  const showing = (h: ReturnType<typeof harness>, state: PetState): boolean =>
    Array.from({ length: petFrameCount(state) }, (_, frame) => frame).some((frame) =>
      shows(h, state, frame),
    );
  /**
   * The column Mocha stands at: the left edge of her coaster, a solid run with a half block at each
   * end on the strip's last row, which neither the wordmark nor the thread line makes. -1 when no
   * pet is drawn. In cells, since a thread title in the row before it can be wide.
   */
  const petAt = (h: ReturnType<typeof harness>): number => {
    const row = screenRows(h)[4] as string;
    const index = row.search(/▄▄[▄█]{6}▄▄/u);
    return index < 0 ? -1 : visibleWidth(row.slice(0, index));
  };

  it("greets at startup, then idles", () => {
    const h = open();
    // She waves hello with a wave of steam, which no idle frame has.
    expect(showing(h, "greeting")).toBe(true);
    h.advance(5000);
    h.controller.render();
    h.settle();
    expect(showing(h, "idle")).toBe(true);
    expect(showing(h, "greeting")).toBe(false);
  });

  it("shows how the turn goes: thinking, a tool, a question for you", () => {
    const h = open({ animations: false });
    h.advance(5000);
    h.deliver(runningThread());
    // Thick steam and rising bubbles while she thinks.
    expect(showing(h, "thinking")).toBe(true);
    h.deliver(
      runningThread({
        activities: [
          {
            id: "a1",
            tone: "tool",
            kind: "tool.started",
            summary: "Run tests",
            payload: { toolCallId: "t1", title: "Run tests" },
            turnId: "turn-1",
            sequence: 4,
            createdAt: T0,
          },
        ],
      }),
      5,
    );
    // She stirs with a spoon at the work; the bubbles are gone.
    expect(showing(h, "tool")).toBe(true);
    expect(showing(h, "thinking")).toBe(false);
  });

  it("keeps exactly one timer while idle, none while unfocused, none with animations off", () => {
    const h = open();
    expect(h.activeTimers()).toBe(1);
    h.controller.handleKey({ type: "focus", focused: false });
    h.settle();
    expect(h.activeTimers()).toBe(0);
    h.controller.handleKey({ type: "focus", focused: true });
    h.settle();
    expect(h.activeTimers()).toBe(1);
    const still = open({ animations: false });
    expect(still.activeTimers()).toBe(0);
  });

  it("runs the spinner's timer and no second one during a turn, and stops everything after", () => {
    const h = open();
    h.deliver(runningThread());
    expect(h.activeTimers()).toBe(1);
    h.deliver(
      makeThread({ id: "thread-new", title: "Fix the login bug", latestTurn: null, session: null }),
      6,
    );
    // Back to idle: only Mocha's one slow timer.
    expect(h.activeTimers()).toBe(1);
    h.controller.handleKey({ type: "focus", focused: false });
    expect(h.activeTimers()).toBe(0);
  });

  it("stays where she is while the turn runs and when it ends: she does not walk", () => {
    const h = open();
    h.advance(5000);
    h.controller.render();
    h.settle();
    const rest = petAt(h);
    expect(rest).toBeGreaterThanOrEqual(0);
    h.deliver(runningThread());
    for (let frame = 0; frame < 12; frame += 1) {
      h.advance(250);
      h.controller.render();
      h.settle();
      expect(petAt(h)).toBe(rest);
    }
    h.deliver(
      makeThread({ id: "thread-new", title: "Fix the login bug", latestTurn: null, session: null }),
      9,
    );
    for (let frame = 0; frame < 6; frame += 1) {
      h.advance(500);
      h.controller.render();
      h.settle();
      expect(petAt(h)).toBe(rest);
    }
  });

  it("writes about four header updates a second while working and a slow trickle while idle", () => {
    const h = open();
    h.deliver(runningThread());
    const mark = h.term.writes.length;
    for (let tick = 0; tick < 40; tick += 1) {
      h.advance(100);
      h.controller.render();
      h.settle();
    }
    // Ten seconds of 100 ms ticks is four seconds of turn: about 16 of Mocha's frames at most.
    const working = h.term.writes.length - mark;
    expect(working).toBeLessThanOrEqual(17);
    expect(h.since(mark)).not.toContain("\u001b[2J");
    h.deliver(
      makeThread({ id: "thread-new", title: "Fix the login bug", latestTurn: null, session: null }),
      9,
    );
    h.advance(60_000);
    const idleMark = h.term.writes.length;
    for (let tick = 0; tick < 100; tick += 1) {
      h.advance(100);
      h.controller.render();
      h.settle();
    }
    // Ten seconds idle: the steam trades places every second or two and she blinks every three and
    // a half, each a repaint of her strip alone; not a stream.
    expect(h.term.writes.length - idleMark).toBeLessThanOrEqual(12);
  });

  it("goes to sleep after a quiet while", () => {
    const h = open();
    h.advance(200_000);
    h.controller.render();
    h.settle();
    // Eyes shut, no steam, and a z.
    expect(showing(h, "resting")).toBe(true);
    expect(showing(h, "idle")).toBe(false);
  });

  it("jumps for a moment when /model changes the model, and then settles", () => {
    const h = open();
    h.advance(5000);
    h.controller.render();
    h.settle();
    expect(showing(h, "idle")).toBe(true);
    h.run("/model");
    h.press(key("down"), key("enter"));
    // Her third picture of the switch (half a second in) is a jump no other state draws.
    h.advance(600);
    h.controller.render();
    h.settle();
    expect(shows(h, "switching", 2)).toBe(true);
    expect(showing(h, "idle")).toBe(false);
    h.advance(2000);
    h.controller.render();
    h.settle();
    expect(showing(h, "idle")).toBe(true);
  });

  it("is turned off and on with /pet and remembered", () => {
    const saved: boolean[] = [];
    const h = open({ savePet: (on) => void saved.push(on) });
    h.advance(5000);
    h.run("/pet off");
    expect(saved).toEqual([false]);
    expect(petAt(h)).toBe(-1);
    expect(screenRows(h).join("\n")).toContain("v0.0.133");
    expect(h.activeTimers()).toBe(0);
    h.run("/pet");
    expect(saved).toEqual([false, true]);
    expect(petAt(h)).toBeGreaterThanOrEqual(0);
    expect(showing(h, "idle")).toBe(true);
    h.run("/pet maybe");
    expect(h.screen()).toContain("Usage: /pet [on|off]");
  });

  it("is off from the start with the pet setting off", () => {
    const h = open({ pet: false });
    expect(petAt(h)).toBe(-1);
    expect(h.activeTimers()).toBe(0);
  });

  it("is listed in the slash menu and in /help", () => {
    const h = open();
    h.press(text("/pe"));
    expect(h.screen()).toContain("/pet");
    const help = open();
    help.run("/help");
    // Leaving the layout writes the whole conversation, help included, into the scrollback.
    help.run("/dag-workflow off");
    help.run("/sidebar off");
    expect(help.screen() + help.term.scrollback.join("\n")).toContain("/pet");
  });
});

describe("the crew at the top of the conversation", () => {
  const model = (instanceId: string, slug: string, name: string, isDefault = false) => ({
    slug,
    name,
    isCustom: false,
    isDefault,
    capabilities: null,
    instanceId,
  });
  const providers = [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [model("codex", "gpt-5", "GPT-5", true), model("codex", "gpt-5-mini", "GPT-5 mini")],
    },
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [model("claudeAgent", "claude-opus-4", "Opus 4", true)],
    },
  ];
  const pins = {
    worker: { instanceId: "codex", model: "gpt-5-mini" },
    expert: { instanceId: "claudeAgent", model: "claude-opus-4" },
    auditor: { instanceId: "codex", model: "gpt-5" },
  };
  const configWith = (crew: Record<string, unknown>) =>
    makeConfig({
      providers,
      settings: {
        crew: { enabled: false, preset: "recommended", pinned: {}, threads: {}, ...crew },
      },
    });
  const open = (crew: Record<string, unknown>, options: Options = {}) => {
    const h = harness({
      startup: true,
      // Wide enough that the middle column has room for the full words beside the side panels.
      columns: 200,
      rows: 36,
      sidebar: true,
      workflow: true,
      config: configWith(crew),
      ...options,
    });
    h.openNewest();
    return h;
  };
  const top = (h: ReturnType<typeof harness>) => screenRows(h).slice(0, 8).join("\n");

  it("names each role with its model while the crew is on", () => {
    const h = open({ enabled: true, pinned: pins });
    expect(top(h)).toContain("Crew worker GPT-5 mini · expert Opus 4 · auditor GPT-5");
  });

  it("says nothing of the crew while it is off", () => {
    const h = open({ enabled: false, pinned: pins });
    expect(top(h)).not.toMatch(/Crew|worker|auditor/u);
  });

  it("follows the crew setting and a role's model as they change in the session", () => {
    const h = open({ enabled: false, pinned: pins });
    expect(top(h)).not.toContain("worker");
    h.link.config = configWith({ enabled: true, pinned: pins });
    h.controller.render();
    h.settle();
    expect(top(h)).toContain("worker GPT-5 mini");
    h.link.config = configWith({
      enabled: true,
      pinned: { ...pins, worker: { instanceId: "codex", model: "gpt-5" } },
    });
    h.controller.render();
    h.settle();
    expect(top(h)).toContain("worker GPT-5 · expert Opus 4");
    h.link.config = configWith({ enabled: false, pinned: pins });
    h.controller.render();
    h.settle();
    expect(top(h)).not.toContain("worker");
  });

  it("uses the thread's own switch over the default", () => {
    const h = open({
      enabled: false,
      pinned: pins,
      threads: { "thread-new": { enabled: true } },
    });
    expect(top(h)).toContain("worker GPT-5 mini");
  });

  it("is a short form on the one-line header, and the width is never exceeded", () => {
    const h = open({ enabled: true, pinned: pins }, { rows: 24 });
    const first = screenRows(h)[0] as string;
    expect(first).toContain("Crew w GPT-5 mini · e Opus 4 · a GPT-5");
    expect(first).not.toContain("worker");
    // With little room it is left out whole, not shown as a stub.
    const narrow = open({ enabled: true, pinned: pins }, { columns: 100, rows: 24 });
    expect(screenRows(narrow)[0]).not.toContain("Crew");
    for (const row of screenRows(narrow)) expect(row.length).toBeLessThanOrEqual(100);
  });
});
