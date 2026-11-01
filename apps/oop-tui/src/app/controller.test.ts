import type {
  ClientOrchestrationCommand,
  OrchestrationShellSnapshot,
  ServerConfig,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { KeyEvent, KeyName } from "../input/keys.ts";
import type { LinkStatus } from "../link/client.ts";
import { setLanguage } from "../i18n/index.ts";
import { emptyThreadMirror, type ThreadMirrorState } from "../link/threadMirror.ts";
import { LiveRegion } from "../render/liveRegion.ts";
import { makeStyle, type Style } from "../render/style.ts";
import { ASCII_SYMBOLS, type Symbols } from "../render/symbols.ts";
import { BUILTIN_THEMES, createTheme } from "../render/theme.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import {
  approvalRequested,
  makeActivity,
  makeConfig,
  makeMessage,
  makeProject,
  makeSession,
  makeSnapshot,
  makeThread,
  makeThreadShell,
  messageSentEvent,
  T0,
  threadDeletedEvent,
  threadSnapshotItem,
} from "../testing/fixtures.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import { applyThreadItem } from "../link/threadMirror.ts";
import { CommandRejectedError } from "../link/transport.ts";
import type { ThemeSwitcher } from "../settings.ts";
import { AppController, type ControllerLink } from "./controller.ts";
import type { CheckUpdate, LatestRelease } from "./updateCheck.ts";
import { linkNotice } from "./view.ts";

const online: LinkStatus = { phase: "online", attempt: 0, retryAt: null, detail: null };

const text = (value: string): KeyEvent => ({ type: "text", text: value });
const key = (name: KeyName): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: false,
});
const shiftKey = (name: KeyName): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: true,
});
const ctrl = (letter: string): KeyEvent => ({ type: "ctrl", letter });

const flushMicrotasks = async () => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

interface Options {
  readonly cwd?: string;
  readonly continueLast?: boolean;
  /** The message `oop "..."` started with. */
  readonly prompt?: string;
  readonly shell?: OrchestrationShellSnapshot | null;
  readonly dispatch?: (command: ClientOrchestrationCommand) => Promise<void>;
  readonly config?: ServerConfig;
  readonly canonical?: (path: string) => string;
  readonly themes?: ThemeSwitcher;
  readonly style?: Style;
  readonly symbols?: Symbols;
  readonly animations?: boolean;
  readonly notify?: boolean;
  readonly columns?: number;
  /** Rows the live region may use; 24 when absent. */
  readonly rows?: number;
  readonly status?: LinkStatus;
  /** What the server's settings hold at the start; `threadGoals` is always there. */
  readonly settings?: Record<string, unknown>;
  /** Makes every settings change fail with this message. */
  readonly settingsError?: string;
  /** Makes the ask for a folder's provider commands fail. */
  readonly workspaceRefreshError?: boolean;
  /** What a turn's patch is when `/diff` asks the server for it. */
  readonly diff?: string;
  /** Makes that ask fail. */
  readonly diffError?: Error;
  /** Turns the start screen on; every field has a default. */
  readonly startup?: {
    readonly banner?: boolean;
    readonly version?: string;
    readonly checkUpdate?: CheckUpdate;
  };
}

const defaultShell = () =>
  makeSnapshot(
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
  );

const harness = (options: Options = {}) => {
  const dispatched: ClientOrchestrationCommand[] = [];
  const scrolls: string[] = [];
  const opened: ThreadId[] = [];
  let closed = 0;
  let exited = 0;
  let suspended = 0;
  let clock = Date.parse(T0);
  let frame: RegionFrame = { lines: [], cursor: null };
  const commits: string[] = [];
  const scheduled: Array<() => void> = [];
  let ids = 0;
  const timers: Array<{ readonly interval: number; readonly run: () => void; stopped: boolean }> =
    [];
  const titles: string[] = [];
  let bells = 0;
  const patches: ServerSettingsPatch[] = [];
  const refreshes: Array<{ instanceId?: string; refreshModels?: boolean } | undefined> = [];
  /** The asks for a folder's own commands and skills, which every open conversation makes once. */
  const workspaceRefreshes: Array<{ instanceId?: string; cwd?: string }> = [];
  /** The turn ranges `/diff` asked the server for. */
  const diffRequests: Array<{ threadId: string; fromTurnCount: number; toTurnCount: number }> = [];
  let settings: Record<string, unknown> = { threadGoals: {}, ...options.settings };
  const withSettings = (config: ServerConfig): ServerConfig =>
    ({ ...config, settings }) as unknown as ServerConfig;

  const link = {
    status: options.status ?? online,
    shell: options.shell === undefined ? defaultShell() : options.shell,
    config: withSettings(options.config ?? makeConfig()),
    thread: emptyThreadMirror as ThreadMirrorState,
    getSettings: async () => settings as unknown as ServerSettings,
    updateSettings: async (patch: ServerSettingsPatch) => {
      if (options.settingsError !== undefined) throw new Error(options.settingsError);
      patches.push(patch);
      settings = { ...settings, ...patch };
      link.config = withSettings(link.config);
      controller.onConfig();
      return settings as unknown as ServerSettings;
    },
    refreshProviders: async (input?: {
      instanceId?: string;
      cwd?: string;
      refreshModels?: boolean;
    }) => {
      if (input?.cwd !== undefined) {
        workspaceRefreshes.push(input);
        if (options.workspaceRefreshError !== undefined) throw new Error("offline");
      } else refreshes.push(input);
      return [];
    },
    retryCrewTask: async () => undefined,
    loadOlderTurns: async () => {
      throw new Error("no older page");
    },
    getCheckpointDiff: async (input: {
      threadId: string;
      fromTurnCount: number;
      toTurnCount: number;
    }) => {
      diffRequests.push(input);
      if (options.diffError !== undefined) throw options.diffError;
      return options.diff ?? "";
    },
    openThread: (id: ThreadId) => void opened.push(id),
    closeThread: () => void (closed += 1),
    dispatch:
      options.dispatch ??
      (async (command: ClientOrchestrationCommand) => {
        dispatched.push(command);
      }),
  } satisfies ControllerLink & { thread: ThreadMirrorState; status: LinkStatus };

  const controller = new AppController({
    link,
    region: {
      set: (next) => void (frame = next),
      commit: (lines) => void commits.push(...lines),
      usableColumns: () => (options.columns ?? 61) - 1,
      maxRows: () => options.rows ?? 24,
      abandon: () => undefined,
      scrollUp: () => void scrolls.push("up"),
      scrollDown: () => void scrolls.push("down"),
      follow: () => void scrolls.push("follow"),
    },
    style: options.style ?? makeStyle(false),
    ...(options.symbols ? { symbols: options.symbols } : {}),
    ...(options.animations === undefined ? {} : { animations: options.animations }),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ticker: (run, interval) => {
      const timer = { interval, run, stopped: false };
      timers.push(timer);
      return () => void (timer.stopped = true);
    },
    terminal: {
      setTitle: (title) => void titles.push(title),
      restoreTitle: () => void titles.push("<restored>"),
      bell: () => void (bells += 1),
    },
    home: "/home/me",
    cwd: options.cwd ?? "/work/app",
    platform: "darwin",
    context: { uuid: () => `id-${(ids += 1)}`, now: () => new Date(clock) },
    schedule: (run) => {
      scheduled.push(run);
      return () => undefined;
    },
    now: () => clock,
    runtimeMode: "approval-required",
    continueLast: options.continueLast ?? false,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    exit: () => void (exited += 1),
    suspend: () => void (suspended += 1),
    ...(options.canonical ? { canonical: options.canonical } : {}),
    ...(options.themes ? { themes: options.themes } : {}),
    ...(options.startup
      ? {
          startup: {
            banner: options.startup.banner ?? true,
            version: options.startup.version ?? "0.0.127",
            checkUpdate: options.startup.checkUpdate ?? (async () => null),
          },
        }
      : {}),
  });

  const screen = () => frame.lines.map(stripAnsi).join("\n");
  const press = (...events: KeyEvent[]) => events.forEach((event) => controller.handleKey(event));
  const typeText = (value: string) => press(text(value));
  /** Delivers the thread the way the link would, then runs the coalesced sync. */
  const deliver = (items: Parameters<typeof applyThreadItem>[1][]) => {
    for (const item of items) link.thread = applyThreadItem(link.thread, item);
    controller.onThread(link.thread);
    scheduled.splice(0).forEach((run) => run());
  };
  const start = () => {
    controller.onShell();
    return controller;
  };
  /** Opens the newest existing thread from the thread list. */
  const openNewest = () => {
    start();
    typeText("/threads");
    press(key("enter"), key("down"), key("enter"));
    // Leaving the empty conversation on the way is setup, not something the test is about.
    closed = 0;
  };
  return {
    controller,
    link,
    dispatched,
    patches,
    refreshes,
    workspaceRefreshes,
    diffRequests,
    settingsNow: () => settings,
    opened,
    commits,
    /** What the region was asked to scroll, in order. */
    scrolls,
    screen,
    press,
    typeText,
    deliver,
    start,
    openNewest,
    advance: (ms: number) => void (clock += ms),
    closedCount: () => closed,
    exitCount: () => exited,
    suspendCount: () => suspended,
    frame: () => frame,
    /** Every timer the controller asked for; only those not stopped are running. */
    timers,
    running: () => timers.filter((timer) => !timer.stopped),
    /** One timer firing, as the clock would. */
    tickAll: () => timers.filter((timer) => !timer.stopped).forEach((timer) => timer.run()),
    titles,
    bellCount: () => bells,
  };
};

describe("starting up", () => {
  it("lands on the project list when the folder belongs to no project", () => {
    const h = harness({ cwd: "/elsewhere" });
    h.start();
    expect(h.screen()).toContain("프로젝트");
    expect(h.screen()).toContain("내 프로젝트");
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
    expect(h.screen()).toContain("새 스레드");
    expect(h.screen()).toContain("최근 스레드");
  });

  it("opens an empty conversation in the project that contains the folder", () => {
    const h = harness({ cwd: "/work/app/src/deep" });
    h.start();
    expect(h.screen()).toContain("메시지");
    expect(h.screen()).not.toContain("스레드를 고르세요");
    expect(h.opened).toEqual([]);
  });

  it("shows a loading line until the server list arrives", () => {
    const h = harness({ shell: null });
    h.controller.render();
    expect(h.screen()).toContain("불러오는 중");
  });

  it("--continue reopens the newest thread of this folder's project", () => {
    const h = harness({ continueLast: true });
    h.start();
    expect(h.opened).toEqual(["thread-new"]);
    expect(h.commits.join("\n")).toContain("내 프로젝트 · 최근 스레드");
  });

  it("--continue opens an empty conversation, with a note, when there is nothing to continue", () => {
    const h = harness({ continueLast: true, shell: makeSnapshot([makeProject()], []) });
    h.start();
    expect(h.opened).toEqual([]);
    expect(h.screen()).toContain("이어갈 스레드가 없어 새 대화를 엽니다.");
    expect(h.screen()).toContain("메시지");
  });

  it("--continue opens the list, with a note, when no project holds the folder and nothing is there", () => {
    const h = harness({
      continueLast: true,
      cwd: "/elsewhere",
      shell: makeSnapshot([makeProject()], []),
    });
    h.start();
    expect(h.opened).toEqual([]);
    expect(h.screen()).toContain("이어갈 스레드가 없어 목록을 엽니다.");
    expect(h.screen()).toContain("프로젝트를 고르세요");
  });

  it("--continue shows its note on the start screen too", () => {
    const h = harness({
      continueLast: true,
      startup: {},
      columns: 101,
      shell: makeSnapshot([makeProject()], []),
    });
    h.start();
    expect(h.screen()).toContain("이어갈 스레드가 없어 새 대화를 엽니다.");
  });
});

describe("oop with a message to start with", () => {
  type TurnStart = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

  it("opens a new thread of the folder's project and sends it, with the usual defaults", async () => {
    const h = harness({ prompt: "버그를 고쳐줘" });
    h.start();
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    const command = h.dispatched[0] as TurnStart;
    expect(command.message.text).toBe("버그를 고쳐줘");
    expect(command.bootstrap?.createThread).toMatchObject({
      projectId: "project-1",
      title: "버그를 고쳐줘",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
    });
    // It goes on as a conversation: the thread is followed and the composer is free.
    expect(h.opened).toEqual([command.threadId]);
    expect(h.screen()).toContain("메시지");
  });

  it("sends a message that starts with a slash the way the chat reads it", async () => {
    const h = harness({ prompt: "/help" });
    h.start();
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.commits.join("\n")).toContain("도움말");
  });

  it("goes to the latest thread of the project with --continue, once it is loaded", async () => {
    const h = harness({ prompt: "이어서 해줘", continueLast: true });
    h.start();
    await flushMicrotasks();
    expect(h.opened).toEqual(["thread-new"]);
    expect(h.dispatched).toEqual([]);
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    const command = h.dispatched[0] as TurnStart;
    expect(command.threadId).toBe("thread-new");
    expect(command.message.text).toBe("이어서 해줘");
    expect(command.bootstrap).toBeUndefined();
  });

  it("queues the message when the latest thread is busy", async () => {
    const h = harness({ prompt: "이어서 해줘", continueLast: true });
    h.start();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
        }),
        3,
      ),
    ]);
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("대기 1건");
    expect(h.screen()).toContain("이어서 해줘");
  });

  it("starts a new thread with --continue when the project has none", async () => {
    const h = harness({
      prompt: "처음이야",
      continueLast: true,
      shell: makeSnapshot([makeProject()], []),
    });
    h.start();
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect((h.dispatched[0] as TurnStart).bootstrap?.createThread).toMatchObject({
      projectId: "project-1",
    });
    expect(h.commits.join("\n")).not.toContain("이어갈 스레드가 없어 목록을 엽니다");
  });

  it("asks which project when the folder has none, then sends to a new thread of the one picked", async () => {
    const h = harness({ prompt: "여기서 시작", cwd: "/elsewhere" });
    h.start();
    await flushMicrotasks();
    expect(h.screen()).toContain("프로젝트를 고르세요");
    expect(h.screen()).toContain("이 폴더에는 프로젝트가 없습니다");
    expect(h.dispatched).toEqual([]);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    const command = h.dispatched[0] as TurnStart;
    expect(command.message.text).toBe("여기서 시작");
    expect(command.bootstrap?.createThread).toMatchObject({ projectId: "project-1" });
    // The thread list is skipped: the message already chose the thread.
    expect(h.screen()).not.toContain("스레드를 고르세요");
  });

  it("sends --continue's message to the latest thread of the project that was picked", async () => {
    const h = harness({ prompt: "이어서", continueLast: true, cwd: "/elsewhere" });
    h.start();
    h.press(key("enter"));
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    await flushMicrotasks();
    expect((h.dispatched[0] as TurnStart).threadId).toBe("thread-new");
  });

  it("is sent once: leaving the conversation and coming back does not send it again", async () => {
    const h = harness({ prompt: "한 번만" });
    h.start();
    await flushMicrotasks();
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("escape"), key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
  });

  it("leaves what the user typed while the thread loaded in the composer", async () => {
    const h = harness({ prompt: "이어서 해줘", continueLast: true });
    h.start();
    h.typeText("먼저 쓰던 글");
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    await flushMicrotasks();
    expect((h.dispatched[0] as TurnStart).message.text).toBe("이어서 해줘");
    expect(h.screen()).toContain("먼저 쓰던 글");
  });

  it("keeps what the user typed, behind the message, when the message could not go", async () => {
    const h = harness({
      prompt: "안 갈 메시지",
      dispatch: async () => {
        throw new Error("끊김");
      },
    });
    h.start();
    h.typeText("다른 글");
    await flushMicrotasks();
    const screen = h.screen();
    expect(screen).toContain("안 갈 메시지");
    expect(screen).toContain("다른 글");
  });

  it("keeps the message when the thread it waits for cannot be opened", async () => {
    const h = harness({ prompt: "이어서 해줘", continueLast: true });
    h.start();
    h.controller.onThreadFailed("thread-new" as ThreadId, "Thread thread-new was not found");
    expect(h.commits.join("\n")).toContain("보내려던 메시지는 다음에 연 대화의 입력창에 둡니다");
    // The next conversation opened gets it in its composer, unsent.
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("이어서 해줘");
  });

  it("waits for the server's config when it has not arrived, and sends when it does", async () => {
    const h = harness({ prompt: "서버가 느려도" });
    (h.link as { config: ServerConfig | null }).config = null;
    h.start();
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).not.toContain("사용할 수 있는 모델이 없습니다");
    (h.link as { config: ServerConfig | null }).config = makeConfig();
    h.controller.onConfig();
    await flushMicrotasks();
    expect((h.dispatched[0] as TurnStart).message.text).toBe("서버가 느려도");
  });

  describe("on a cold server, whose providers are still being checked", () => {
    const provider = (over: Record<string, unknown>) =>
      makeConfig({
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            installed: false,
            status: "warning",
            auth: { status: "unknown" },
            models: [],
            ...over,
          },
        ],
      });
    const setConfig = (h: ReturnType<typeof harness>, config: ServerConfig) => {
      (h.link as { config: ServerConfig | null }).config = config;
      h.controller.onConfig();
    };

    it("waits for the provider, says it is getting ready, and sends once a model is there", async () => {
      const h = harness({ prompt: "느린 서버", config: provider({}) });
      h.start();
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("준비하는 중");
      expect(h.screen()).not.toContain("/provider add");
      setConfig(h, provider({}));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      setConfig(h, makeConfig());
      await flushMicrotasks();
      expect((h.dispatched[0] as TurnStart).message.text).toBe("느린 서버");
      expect(h.screen()).not.toContain("준비하는 중");
    });

    it("does not wait on a provider the probe left as a warning, signed out", async () => {
      const h = harness({
        prompt: "설정이 필요한 서버",
        config: provider({ auth: { status: "unauthenticated" } }),
      });
      h.start();
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("사용할 수 있는 모델이 없습니다");
      expect(h.screen()).not.toContain("준비하는 중");
    });

    it("gives up with the usual notice once the provider is settled as not usable", async () => {
      const h = harness({ prompt: "안 되는 서버", config: provider({}) });
      h.start();
      await flushMicrotasks();
      setConfig(h, provider({ status: "error" }));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("사용할 수 있는 모델이 없습니다");
      expect(h.screen()).toContain("안 되는 서버");
    });

    it("puts the message in the next conversation's composer when the user goes elsewhere", async () => {
      const h = harness({ prompt: "기다리던 말", config: provider({}) });
      h.start();
      await flushMicrotasks();
      h.typeText("/threads");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      setConfig(h, makeConfig());
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("기다리던 말");
    });
  });

  it("puts the message back in the composer when sending fails", async () => {
    const h = harness({
      prompt: "안 갈 메시지",
      dispatch: async () => {
        throw new Error("끊김");
      },
    });
    h.start();
    await flushMicrotasks();
    expect(h.screen()).toContain("안 갈 메시지");
  });
});

describe("coming back to a draft from a list", () => {
  it("keeps the mode and effort picked for it", () => {
    const h = harness();
    h.start();
    h.typeText("/mode auto-accept-edits");
    h.press(key("enter"));
    const picked = h.screen().split("\n").at(-1);
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("escape"), key("escape"));
    expect(h.screen().split("\n").at(-1)).toBe(picked);
    expect(h.exitCount()).toBe(0);
  });
});

describe("starting a conversation", () => {
  it("creates the thread with its first message, then follows it", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    expect(h.screen()).toContain("Codex / GPT-5");
    h.typeText("안녕하세요");
    h.press(key("enter"));
    await flushMicrotasks();

    expect(h.dispatched).toHaveLength(1);
    const command = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(command.type).toBe("thread.turn.start");
    expect(command.message.text).toBe("안녕하세요");
    expect(command.bootstrap?.createThread).toMatchObject({
      projectId: "project-1",
      title: "안녕하세요",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
    });
    expect(h.opened).toEqual([command.threadId]);
  });

  it("sends follow-ups in an existing thread without creating anything", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("계속해 줘");
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(command.threadId).toBe("thread-new");
    expect(command.bootstrap).toBeUndefined();
  });

  it("puts the text back and says why when the server refuses it", async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error("서버가 거절했습니다\n상세");
      },
    });
    h.start();
    h.press(key("enter"));
    h.typeText("내 질문");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.commits.join("\n")).toContain("▲  전송 실패: 서버가 거절했습니다");
    expect(h.screen()).toContain("내 질문");
  });

  it("does not send while offline", async () => {
    const h = harness({ columns: 81 });
    h.start();
    h.press(key("enter"));
    (h.link as { status: LinkStatus }).status = {
      phase: "reconnecting",
      attempt: 1,
      retryAt: null,
      detail: null,
    };
    h.typeText("보내기");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    // The banner says what is wrong with the link, and the notice says why nothing was sent.
    expect(h.screen()).toContain("연결이 끊어졌습니다");
    expect(h.screen()).toContain("서버와 연결된 뒤에 보낼 수 있습니다");
    expect(h.screen()).toContain("│  보내기");
  });

  it("uses the model chosen with /model for the next message", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    expect(h.screen()).toContain("모델 선택");
    h.press(key("down"), key("enter"));
    expect(h.screen()).toContain("Codex / GPT-5 mini");
    h.typeText("작은 모델로");
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(command.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
    expect(command.bootstrap?.createThread?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5-mini",
    });
  });
});

describe("composer", () => {
  it("edits Korean text by whole syllables", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("안녕하세요");
    h.press(key("backspace"), key("backspace"));
    h.typeText("요");
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(command.message.text).toBe("안녕하요");
  });

  it("keeps a newline for Ctrl-J and sends on Enter", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("가");
    h.press(key("newline"));
    h.typeText("나");
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(command.message.text).toBe("가\n나");
  });

  it("recalls earlier messages with Up and returns to the draft with Down", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("첫 질문");
    h.press(key("enter"));
    await flushMicrotasks();
    h.typeText("쓰던 글");
    h.press(key("up"));
    expect(h.screen()).toContain("첫 질문");
    h.press(key("down"));
    expect(h.screen()).toContain("쓰던 글");
  });
});

describe("while the agent works", () => {
  const running = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      ...extra,
    });

  it("queues a message typed while the turn runs, and shows it above the composer", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.typeText("끼어들기");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("대기 1건");
    expect(h.screen()).toContain("1. 끼어들기");
  });

  it("interrupts on Esc and on Ctrl-C", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.press(key("escape"));
    await flushMicrotasks();
    h.press(ctrl("c"));
    await flushMicrotasks();
    expect(h.dispatched.map((command) => command.type)).toEqual([
      "thread.turn.interrupt",
      "thread.turn.interrupt",
    ]);
    expect(h.exitCount()).toBe(0);
  });

  it("prints streamed output into the scrollback and keeps the unfinished line live", () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(running(), 3),
      messageSentEvent(4, { messageId: "m1", text: "완성된 줄\n쓰는 중", streaming: true }),
    ]);
    expect(h.commits.map(stripAnsi).some((line) => line.includes("완성된 줄"))).toBe(true);
    expect(h.screen()).toContain("쓰는 중");
    expect(h.commits.join("\n")).not.toContain("쓰는 중");
  });
});

describe("the queue of messages typed while a turn runs", () => {
  const turn = (id: string, state: "running" | "completed" | "error") => ({
    turnId: id,
    state,
    requestedAt: T0,
    startedAt: T0,
    completedAt: state === "running" ? null : T0,
    assistantMessageId: null,
  });
  const working = (id: string, extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new", activeTurnId: id }),
      latestTurn: turn(id, "running"),
      ...extra,
    });
  const idle = (id: string, extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("ready", { threadId: "thread-new", updatedAt: `after-${id}` }),
      latestTurn: turn(id, "completed"),
      ...extra,
    });
  const sentTexts = (h: ReturnType<typeof harness>) =>
    h.dispatched.flatMap((command) =>
      command.type === "thread.turn.start" ? [command.message.text] : [],
    );
  /** A thread in the middle of its first turn with two messages waiting. */
  const queued = async (...texts: string[]) => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(working("t1"), 3)]);
    for (const text of texts) {
      h.typeText(text);
      h.press(key("enter"));
    }
    await flushMicrotasks();
    return h;
  };

  it("sends them one at a time, each after the turn before it is over", async () => {
    const h = await queued("둘째", "셋째");
    expect(sentTexts(h)).toEqual([]);
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    // The server has not started the turn yet: the thread looks as it did, so the next waits.
    h.deliver([threadSnapshotItem(idle("t1"), 5)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.deliver([threadSnapshotItem(working("t2"), 6)]);
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.deliver([threadSnapshotItem(idle("t2"), 7)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째", "셋째"]);
    expect(h.screen()).not.toContain("대기");
  });

  it("puts the newest message back in the composer on Up, and drops it when that is cleared", async () => {
    const h = await queued("둘째", "셋째");
    h.press(key("up"));
    expect(h.screen()).toContain("대기 1건");
    expect(h.screen()).toContain("셋째");
    h.press(ctrl("u"));
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
  });

  it("gives every queued message back to the composer when the turn is stopped", async () => {
    const h = await queued("둘째", "셋째");
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.turn.interrupt"]);
    expect(h.screen()).not.toContain("대기");
    expect(h.screen()).toContain("둘째");
    expect(h.screen()).toContain("셋째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
  });

  it("stops after a turn that ended in an error, and goes on at an empty Enter", async () => {
    const h = await queued("둘째");
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("error", { threadId: "thread-new", lastError: "망가짐" }),
          latestTurn: turn("t1", "error"),
        }),
        4,
      ),
    ]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
    expect(h.screen()).toContain("오류로 끝나 멈춤");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
  });

  it("holds while an approval or a question is open", async () => {
    const h = await queued("둘째");
    h.deliver([threadSnapshotItem(working("t1", { activities: [approvalRequested("r1")] }), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
    expect(h.screen()).toContain("대기 1건");
  });

  it("does not follow the user to another thread", async () => {
    const h = await queued("둘째");
    h.typeText("/new");
    h.press(key("enter"));
    h.deliver([threadSnapshotItem(idle("t1"), 5)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
    expect(h.screen()).not.toContain("대기");
    // Back in the thread that was left, the queue is there and waits for the user.
    h.typeText("/threads");
    h.press(key("enter"), key("down"), key("enter"));
    h.deliver([threadSnapshotItem(idle("t1"), 6)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
    expect(h.screen()).toContain("스레드를 떠나 멈춤");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched.at(-1)).toMatchObject({ threadId: "thread-new" });
    expect(sentTexts(h)).toEqual(["둘째"]);
  });

  it("goes on when the approval is answered and the turn ends in the same update", async () => {
    const h = await queued("둘째");
    h.deliver([threadSnapshotItem(working("t1", { activities: [approvalRequested("r1")] }), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual([]);
    h.deliver([threadSnapshotItem(idle("t1"), 5)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
  });

  it("lines up a message typed right after the last queued one went out, behind it", async () => {
    const h = await queued("둘째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    // The server has not shown that turn yet: the thread still looks at rest, but a turn is on its way.
    h.typeText("셋째");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    expect(h.screen()).toContain("대기 1건");
    h.deliver([threadSnapshotItem(working("t2"), 5)]);
    h.deliver([threadSnapshotItem(idle("t2"), 6)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째", "셋째"]);
  });

  it("does not send the next message on a change that is not the turn starting", async () => {
    const h = await queued("둘째", "셋째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    // The session is touched again but no turn has begun.
    h.deliver([
      threadSnapshotItem(
        idle("t1", {
          session: makeSession("ready", { threadId: "thread-new", updatedAt: "later" }),
        }),
        5,
      ),
    ]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
  });

  it("is not hurried by an empty Enter: the turn that has not shown yet is still waited for", async () => {
    const h = await queued("둘째", "셋째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.press(key("enter"), key("enter"), key("enter"));
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    expect(h.screen()).toContain("대기 1건");
  });

  it("wakes up by itself when the turn that never showed is given up, and not before", async () => {
    const h = await queued("둘째", "셋째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.advance(14_000);
    h.tickAll();
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.advance(1_000);
    h.tickAll();
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째", "셋째"]);
  });

  it("has no timer once the turn shows, or the thread is left", async () => {
    const h = await queued("둘째", "셋째");
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(h.running()).toHaveLength(1);
    h.deliver([threadSnapshotItem(working("t2"), 5)]);
    h.advance(20_000);
    h.tickAll();
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째"]);
    h.deliver([threadSnapshotItem(idle("t2"), 6)]);
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["둘째", "셋째"]);
    h.deliver([threadSnapshotItem(idle("t3"), 7)]);
    await flushMicrotasks();
    h.typeText("/threads");
    h.press(key("enter"));
    expect(h.running()).toEqual([]);
  });

  it("does not send into a turn the server mirror already shows as running", async () => {
    let calls = 0;
    const h = harness({
      dispatch: async () => {
        calls += 1;
        throw new Error("끊김");
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(working("t1"), 3)]);
    h.typeText("둘째");
    h.press(key("enter"));
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(calls).toBe(1);
    // The mirror moved on to a new running turn; the screen's own status has not been recomputed yet.
    h.link.thread = {
      ...h.link.thread,
      thread: working("t2"),
    } as typeof h.link.thread;
    h.press(key("enter"));
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  it("keeps a message that could not be sent at the head, stopped", async () => {
    let calls = 0;
    const h = harness({
      dispatch: async () => {
        calls += 1;
        throw new Error("서버가 거절했습니다");
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(working("t1"), 3)]);
    h.typeText("둘째");
    h.press(key("enter"));
    h.deliver([threadSnapshotItem(idle("t1"), 4)]);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(h.screen()).toContain("대기 1건");
    expect(h.screen()).toContain("전송하지 못해 멈춤");
    h.deliver([threadSnapshotItem(idle("t1"), 5)]);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });
});

describe("approvals", () => {
  const request = (requestId: string, detail = "rm -rf build") =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested(requestId, detail)],
    });
  const waiting = () => request("req-1");
  const resolved = (requestId = "req-1") =>
    makeThread({
      id: "thread-new",
      activities: [
        approvalRequested(requestId),
        makeActivity({ id: "r", kind: "approval.resolved", payload: { requestId } }),
      ],
    });
  /** The first request is answered elsewhere and a second one takes its place. */
  const replaced = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        approvalRequested("req-1"),
        makeActivity({ id: "r", kind: "approval.resolved", payload: { requestId: "req-1" } }),
        approvalRequested("req-2", "git push --force"),
      ],
    });

  it("shows the request and decides only on Enter, once", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    expect(h.screen()).toContain("rm -rf build");
    expect(h.screen()).not.toContain("● 1 허용");

    h.press(text("1"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("● 1 허용");

    h.press(key("enter"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      type: "thread.approval.respond",
      threadId: "thread-new",
      requestId: "req-1",
      decision: "accept",
    });
  });

  it("numbers and arrows only move the selection; Enter sends it", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("3"));
    expect(h.screen()).toContain("● 3 거부");
    h.press(key("up"));
    expect(h.screen()).toContain("● 2 이 세션 동안 허용");
    h.press(key("down"), key("down"));
    expect(h.screen()).toContain("● 4 턴 취소");
    h.press(text("2"));
    expect(h.screen()).toContain("● 2 이 세션 동안 허용");
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({ decision: "acceptForSession" });
  });

  it("2 then Enter, straight after the panel appears, sends the second option", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("2"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ decision: "acceptForSession" });
  });

  it("letters are not shortcuts: y then Enter sends nothing", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    for (const letter of ["y", "a", "n", "c", "!"]) h.press(text(letter), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).not.toMatch(/> \d {2}/u);
  });

  it("does nothing on Enter while nothing is selected, and ignores other keys", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(key("enter"), text("x"), text("9"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).not.toMatch(/> \d {2}/u);
  });

  it("the tail of a sentence cannot decide, however it ends", async () => {
    for (const sentence of ["no wa", "please a", "sleep 3", "run test 1", "ok 2"]) {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(waiting(), 3)]);
      for (const char of sentence) h.press(text(char));
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched, sentence).toEqual([]);
      expect(h.screen(), sentence).toContain("↑↓로 선택 후 Enter");
    }
  });

  it("a pasted text also clears the pick and locks the numbers", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"), { type: "paste", text: "x" }, text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).not.toMatch(/> \d {2}/u);
  });

  it("x, then the arrows, then Enter sends what the arrows picked", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("x"), text("1"));
    expect(h.screen()).not.toMatch(/> \d {2}/u);
    h.press(key("down"), key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ decision: "acceptForSession" });
  });

  it("the arrows unlock the numbers", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("x"), key("down"), text("3"));
    expect(h.screen()).toContain("● 3 거부");
    expect(h.screen()).not.toContain("↑↓로 선택 후 Enter");
  });

  it("starts the next request with no selection, and keeps a lock the user typed", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"));
    expect(h.screen()).toContain("● 1 허용");
    h.press(key("down"), text("x"));
    h.deliver([threadSnapshotItem(replaced(), 4)]);
    expect(h.screen()).toContain("git push --force");
    expect(h.screen()).not.toMatch(/> \d {2}/u);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(text("2"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(key("down"), key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ requestId: "req-2", decision: "acceptForSession" });
  });

  it("does not send keys typed during a pending decision, and keeps the earlier draft", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("쓰던 글");
    h.advance(5000);
    h.deliver([threadSnapshotItem(waiting(), 4)]);
    h.press(text("z"), key("enter"));
    expect(h.dispatched).toEqual([]);
    h.deliver([threadSnapshotItem(resolved(), 9)]);
    expect(h.screen()).toContain("│  쓰던 글");
    expect(h.screen()).not.toContain("쓰던 글z");
  });

  it("lets the user answer again after a failed reply, with a fresh choice", async () => {
    let attempts = 0;
    const h = harness({
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("일시적 오류");
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    // The failed choice is not sitting there waiting for a stray Enter.
    h.press(key("enter"));
    await flushMicrotasks();
    expect(attempts).toBe(1);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(attempts).toBe(2);
  });

  it("returns to the composer once the request is resolved", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    expect(h.screen()).toContain("승인 필요:");
    h.deliver([threadSnapshotItem(resolved(), 9)]);
    expect(h.screen()).not.toContain("승인 필요:");
  });

  it("Esc still stops the turn while a decision is pending", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.turn.interrupt"]);
  });
});

describe("questions from the agent", () => {
  const asking = (questions: unknown[]) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: { requestId: "ask-1", questions },
        }),
      ],
    });
  const choice = {
    id: "db",
    header: "데이터베이스",
    question: "어느 것을 쓸까요?",
    options: [
      { label: "SQLite", description: "가볍다" },
      { label: "Postgres", description: "크다" },
    ],
  };

  it("answers a choice by number", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(asking([choice]), 3)]);
    expect(h.screen()).toContain("질문: 데이터베이스");
    expect(h.screen()).toContain("2  Postgres");
    h.typeText("2");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({
      type: "thread.user-input.respond",
      requestId: "ask-1",
      answers: { db: "Postgres" },
    });
  });

  it("accepts a free-form answer and walks through several questions", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        asking([choice, { id: "name", header: "이름", question: "프로젝트 이름은?", options: [] }]),
        3,
      ),
    ]);
    h.typeText("직접 쓴 답");
    h.press(key("enter"));
    expect(h.screen()).toContain("질문 (2/2): 이름");
    expect(h.dispatched).toEqual([]);
    h.typeText("오오피");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({ answers: { db: "직접 쓴 답", name: "오오피" } });
  });

  it("asks again instead of sending an empty answer", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(asking([{ ...choice, allowCustomAnswer: false }]), 3)]);
    h.typeText("7");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("목록의 번호로 답하세요");
  });
});

describe("moving around", () => {
  it("Esc in an idle chat does nothing; /threads is the way back", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.press(key("escape"));
    expect(h.closedCount()).toBe(0);
    expect(h.screen()).toContain("Codex / GPT-5");
    h.typeText("/threads");
    h.press(key("enter"));
    expect(h.closedCount()).toBe(1);
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("Esc still goes back from the thread list to the project list", () => {
    const h = harness();
    h.start();
    h.typeText("/threads");
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
    h.press(key("escape"));
    // The list was opened from the conversation, so Esc goes back to it.
    expect(h.screen()).toContain("↑/↓ 이동 • Enter 열기 • 글자 입력 검색 • Esc 닫기");
  });

  it("Esc does not discard a half-written message", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("쓰던 중");
    h.press(key("escape"));
    expect(h.closedCount()).toBe(0);
    expect(h.screen()).toContain("쓰던 중");
  });

  it("/projects, /threads and /new move between screens", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("/projects");
    h.press(key("enter"));
    expect(h.screen()).toContain("↑/↓ 이동 • Enter 열기 • 글자 입력 검색 • Esc 닫기");
    h.press(key("enter"));
    h.press(key("enter"));
    expect(h.commits.join("\n")).toContain("OOP  내 프로젝트 · 새 스레드");
    h.typeText("/threads");
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("starts a fresh draft with /new", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("/new");
    h.press(key("enter"));
    expect(h.opened).toEqual(["thread-new"]);
    expect(h.commits.join("\n")).toContain("새 스레드");
  });

  it("returns to the list when the open thread is deleted elsewhere", () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(makeThread({ id: "thread-new" }), 3),
      threadDeletedEvent(4, "thread-new"),
    ]);
    expect(h.commits.join("\n")).toContain("이 스레드는 삭제되었습니다");
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("the first row of the thread list starts a new thread, and Ctrl-C quits", () => {
    const h = harness({ cwd: "/elsewhere" });
    h.start();
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
    h.press(key("enter"));
    expect(h.commits.join("\n")).toContain("OOP  내 프로젝트 · 새 스레드");
    expect(h.screen()).toContain("Codex / GPT-5");
    const other = harness({ cwd: "/elsewhere" });
    other.start();
    other.press(ctrl("c"));
    expect(other.exitCount()).toBe(1);
  });

  it("Esc on a list opened from a chat goes back to that chat, and the app stays open", () => {
    for (const command of ["/projects", "/threads"]) {
      const h = harness();
      h.start();
      h.typeText(command);
      h.press(key("enter"));
      expect(h.screen()).toContain(command === "/projects" ? "Esc 닫기" : "Esc 프로젝트 목록");
      // A thread list steps back to the project list first.
      h.press(...(command === "/threads" ? [key("escape"), key("escape")] : [key("escape")]));
      expect(h.exitCount()).toBe(0);
      expect(h.screen()).toContain("메시지");
    }
  });
});

describe("searching and pinning in the lists", () => {
  const threadsShell = () =>
    makeSnapshot(
      [
        makeProject(),
        makeProject({
          id: "project-2",
          title: "서버 API",
          workspaceRoot: "/work/api",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      [
        makeThreadShell({
          id: "t-login",
          title: "login 버그 수정",
          updatedAt: "2026-10-30T08:00:00.000Z",
        }),
        makeThreadShell({
          id: "t-docs",
          title: "문서 정리",
          updatedAt: "2026-10-29T08:00:00.000Z",
        }),
        makeThreadShell({
          id: "t-old",
          title: "오래된 스레드",
          updatedAt: "2026-10-01T08:00:00.000Z",
        }),
      ],
    );
  const openList = (over: Options = {}) => {
    const h = harness({ cwd: "/elsewhere", shell: threadsShell(), ...over });
    h.start();
    // The project list: "내 프로젝트" is the newest, so its threads come next.
    h.press(key("enter"));
    return h;
  };

  it("narrows the thread list as letters are typed, Korean too", () => {
    const h = openList();
    expect(h.screen()).toContain("검색: 글자를 치면 걸러집니다");
    h.typeText("문서");
    expect(h.screen()).toContain("검색: 문서");
    expect(h.screen()).toContain("문서 정리");
    expect(h.screen()).not.toContain("login");
    // Starting a new thread is not one of the matches.
    expect(h.screen()).not.toContain("새 스레드");
    h.press(key("enter"));
    expect(h.opened).toEqual(["t-docs"]);
  });

  it("opens the best match, and says when nothing matches", () => {
    const h = openList();
    h.typeText("LOGIN");
    h.press(key("enter"));
    expect(h.opened).toEqual(["t-login"]);
    const none = openList();
    none.typeText("zzz");
    expect(none.screen()).toContain("일치하는 스레드가 없습니다");
    none.press(key("enter"));
    expect(none.opened).toEqual([]);
  });

  it("takes j, k, q and n as letters, not as shortcuts", () => {
    const h = openList();
    h.typeText("q");
    expect(h.exitCount()).toBe(0);
    expect(h.screen()).toContain("검색: q");
    h.press(key("backspace"));
    h.typeText("n");
    expect(h.screen()).toContain("검색: n");
    expect(h.dispatched).toEqual([]);
  });

  it("clears the search with Esc and Backspace before it leaves the list", () => {
    const h = openList();
    h.typeText("문서");
    h.press(key("escape"));
    expect(h.screen()).toContain("스레드를 고르세요");
    expect(h.screen()).toContain("새 스레드");
    expect(h.screen()).toContain("login");
    h.typeText("문서");
    h.press(key("backspace"), key("backspace"));
    expect(h.screen()).toContain("검색: 글자를 치면 걸러집니다");
    h.press(key("escape"));
    expect(h.screen()).toContain("프로젝트를 고르세요");
  });

  it("searches the project list by title and folder", () => {
    const h = harness({ cwd: "/elsewhere", shell: threadsShell() });
    h.start();
    h.typeText("api");
    expect(h.screen()).toContain("서버 API");
    expect(h.screen()).not.toContain("내 프로젝트");
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
    const none = harness({ cwd: "/elsewhere", shell: threadsShell() });
    none.start();
    none.typeText("없는프로젝트");
    expect(none.screen()).toContain("일치하는 프로젝트가 없습니다");
  });

  it("Ctrl-P pins the thread under the pointer at the top of the pinned block", () => {
    const h = openList();
    h.press(key("down"), key("down"), ctrl("p"));
    expect(h.dispatched).toHaveLength(1);
    const command = h.dispatched[0] as { type: string; threadId: string; orderKey?: string };
    expect(command.type).toBe("thread.pin");
    expect(command.threadId).toBe("t-docs");
    expect(command.orderKey).toBeDefined();
  });

  it("shows pinned threads first, marked, and Ctrl-P on one unpins it", () => {
    const shell = threadsShell();
    const h = openList({
      shell: {
        ...shell,
        threads: shell.threads.map((thread) =>
          thread.id === "t-old"
            ? { ...thread, pinnedAt: "2026-10-31T00:00:00.000Z", pinOrderKey: "m" }
            : thread,
        ),
      },
    });
    const rows = h.screen().split("\n");
    const order = ["오래된 스레드", "login 버그 수정", "문서 정리"].map((title) =>
      rows.findIndex((row) => row.includes(title)),
    );
    expect(order[0]).toBeGreaterThan(0);
    expect(order[0]).toBeLessThan(order[1] as number);
    expect(rows[order[0] as number]).toContain("고정");
    h.press(key("down"), ctrl("p"));
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.unpin"]);
  });

  it("keeps the pointer on the thread when the pin moves it", () => {
    const h = openList();
    h.press(key("down"), key("down"), ctrl("p"));
    const shell = h.link.shell as OrchestrationShellSnapshot;
    h.link.shell = {
      ...shell,
      threads: shell.threads.map((thread) =>
        thread.id === "t-docs"
          ? { ...thread, pinnedAt: "2026-10-31T00:00:00.000Z", pinOrderKey: "m" }
          : thread,
      ),
    };
    h.controller.onShell();
    // The pinned thread is now the first row after "새 스레드", and the pointer went with it.
    h.press(key("enter"));
    expect(h.opened).toEqual(["t-docs"]);
  });

  it("says so when the server cannot pin, and sends nothing", () => {
    const h = openList({
      config: makeConfig({ environment: { serverVersion: "0.0.1", capabilities: {} } }),
    });
    h.press(key("down"), ctrl("p"));
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("지원하지 않습니다");
  });

  it("does nothing on the new-thread row", () => {
    const h = openList();
    h.press(ctrl("p"));
    expect(h.dispatched).toEqual([]);
  });
});

describe("/model when the list shrinks under the pointer", () => {
  const model = (slug: string, name: string, over: Record<string, unknown> = {}) => ({
    slug,
    name,
    isCustom: false,
    capabilities: null,
    ...over,
  });
  const configOf = (models: Array<Record<string, unknown>>) =>
    makeConfig({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          models,
        },
      ],
    });

  it("picks the row that is drawn, not the one at the old index", () => {
    const h = harness({
      config: configOf([model("a", "A", { isDefault: true }), model("b", "B"), model("c", "C")]),
    });
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("down"));
    // The settings change: C is gone, so the pointer is held on the last row, B.
    (h.link as { config: ServerConfig }).config = configOf([
      model("a", "A", { isDefault: true }),
      model("b", "B"),
    ]);
    h.controller.onConfig();
    h.press(key("enter"));
    expect(h.commits.join("\n")).toContain("B");
    expect(h.screen()).toContain("Codex / B");
  });
});

describe("a list opened from a chat that cannot be opened again", () => {
  it("does not loop: after a failed opening the list has nowhere to go back to", () => {
    const h = harness();
    h.openNewest();
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("escape"), key("escape"));
    expect(h.exitCount()).toBe(0);
    h.controller.onThreadFailed("thread-new" as ThreadId, "찾을 수 없음");
    expect(h.screen()).toContain("스레드를 고르세요");
    // Esc steps up to the project list, which has no chat to close to; only Ctrl-C ends the app.
    h.press(key("escape"), key("escape"));
    expect(h.exitCount()).toBe(0);
    expect(h.screen()).toContain("Ctrl+C 종료");
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });
});

describe("leaving", () => {
  it("clears the draft on the first Ctrl-C and quits on the very next one", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("지울 글");
    h.press(ctrl("c"));
    expect(h.screen()).not.toContain("지울 글");
    expect(h.screen()).toContain("한 번 더 Ctrl-C");
    expect(h.exitCount()).toBe(0);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("does not count a Ctrl-C from before other typing as half of a quit", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.press(ctrl("c"));
    expect(h.screen()).toContain("한 번 더 Ctrl-C");
    h.typeText("후회하는 글");
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(0);
    expect(h.screen()).not.toContain("후회하는 글");
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("any other key in between starts the count again", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.press(ctrl("c"), key("escape"), ctrl("c"));
    expect(h.exitCount()).toBe(0);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("does not wipe a draft the panel is hiding", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("쓰던 글");
    h.deliver([
      threadSnapshotItem(
        makeThread({ id: "thread-new", activities: [approvalRequested("req-1")] }),
        4,
      ),
    ]);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(0);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
    const other = harness();
    other.openNewest();
    other.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    other.typeText("쓰던 글");
    other.deliver([
      threadSnapshotItem(
        makeThread({ id: "thread-new", activities: [approvalRequested("req-1")] }),
        4,
      ),
    ]);
    other.press(ctrl("c"));
    other.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          activities: [
            approvalRequested("req-1"),
            makeActivity({ id: "r", kind: "approval.resolved", payload: { requestId: "req-1" } }),
          ],
        }),
        5,
      ),
    ]);
    expect(other.screen()).toContain("│  쓰던 글");
  });

  it("forgets the first Ctrl-C after two seconds", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.press(ctrl("c"));
    h.advance(2500);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(0);
  });

  it("Ctrl-D quits only on an empty composer", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("글");
    h.press(ctrl("d"));
    expect(h.exitCount()).toBe(0);
    h.press(key("home"), ctrl("d"));
    h.press(ctrl("d"));
    expect(h.exitCount()).toBe(1);
  });
});

describe("a decision key that arrives with the panel", () => {
  const running = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
    });
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "rm -rf build")],
    });

  it("does not let the Enter that was meant for the message decide", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.typeText("계속 쓰는 중");
    h.deliver([threadSnapshotItem(waiting(), 4)]);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });

  it("a letter typed after a pause selects nothing: it can never approve for the session by itself", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.typeText("끝난 글");
    h.advance(10_000);
    h.deliver([threadSnapshotItem(waiting(), 4)]);
    h.typeText("a");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).not.toMatch(/> \d {2}/u);
  });

  it("does not turn the letters typed right after the panel appeared into a decision", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.typeText("yes please");
    h.advance(100);
    h.deliver([threadSnapshotItem(waiting(), 4)]);
    for (const letter of ["y", "a", "1", "2", " ", "t", "h", "e"]) {
      h.advance(100);
      h.typeText(letter);
    }
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });

  it("takes an arrow choice however soon it comes", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.typeText("바로 쓰는 중");
    h.deliver([threadSnapshotItem(waiting(), 4)]);
    h.press(key("up"));
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ decision: "cancel" });
  });
});

describe("leaving a panel without answering", () => {
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "rm -rf build")],
    });
  const asking = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: {
            requestId: "ask-1",
            questions: [
              {
                id: "db",
                header: "DB",
                question: "무엇을 쓸까요?",
                options: [
                  { label: "SQLite", description: "가볍다" },
                  { label: "Postgres", description: "크다" },
                ],
                ...extra,
              },
            ],
          },
        }),
      ],
    });
  const ctrlT = ctrl("t");

  it("Ctrl-T goes back to the thread list from an approval, and the panel returns when reopened", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    expect(h.screen()).toContain("Ctrl-T");
    h.press(text("1"), ctrlT);
    expect(h.closedCount()).toBe(1);
    expect(h.screen()).toContain("스레드를 고르세요");
    expect(h.dispatched).toEqual([]);
    // Open the same thread again: nothing was answered, so the panel is back, with nothing chosen.
    h.press(key("down"), key("enter"));
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    expect(h.screen()).toContain("승인 필요:");
    expect(h.screen()).not.toContain("● 1 허용");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });

  it("Ctrl-T goes back from a question, even when it allows no typed answer", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(asking({ allowCustomAnswer: false }), 3)]);
    expect(h.screen()).toContain("Ctrl-T");
    h.press(ctrlT);
    expect(h.closedCount()).toBe(1);
    expect(h.screen()).toContain("스레드를 고르세요");
    h.press(key("down"), key("enter"));
    h.deliver([threadSnapshotItem(asking({ allowCustomAnswer: false }), 3)]);
    expect(h.screen()).toContain("질문: DB");
  });

  it("Ctrl-T does not throw away a draft in an ordinary chat", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("쓰던 글");
    h.press(ctrlT);
    expect(h.closedCount()).toBe(0);
    expect(h.screen()).toContain("│  쓰던 글");
  });

  it("says in /help what Ctrl-D really does", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/help");
    h.press(key("enter"));
    const help = h.commits.join("\n");
    expect(help).toContain("Ctrl-D");
    expect(help).toContain("빈 입력");
    expect(help).toContain("Ctrl-T");
  });
});

describe("/help on scrolling", () => {
  it("names the Shift form of the page keys", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/help");
    h.press(key("enter"));
    const help = h.commits.join("\n").replace(/\s+/gu, " ");
    expect(help).toContain("Shift+PageUp/PageDown");
  });
});

describe("getting out", () => {
  const running = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
    });

  it("quits on two quick Ctrl-C even while a decision is pending", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
          activities: [approvalRequested("req-1")],
        }),
        3,
      ),
    ]);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(0);
    h.advance(300);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("quits on two quick Ctrl-C while the agent works", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.press(ctrl("c"), ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("quits on two quick Ctrl-C when the link was refused mid-turn", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    (h.link as { status: LinkStatus }).status = {
      phase: "blocked",
      attempt: 1,
      retryAt: null,
      detail: "인증이 필요합니다.",
    };
    h.press(ctrl("c"));
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(1);
  });

  it("does not quit when the second Ctrl-C comes late", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    h.press(ctrl("c"));
    h.advance(2500);
    h.press(ctrl("c"));
    expect(h.exitCount()).toBe(0);
  });

  it("asks the terminal layer to suspend on Ctrl-Z, from any screen", () => {
    const h = harness();
    h.start();
    h.press(ctrl("z"));
    h.press(key("enter"));
    h.press(ctrl("z"));
    expect(h.suspendCount()).toBe(2);
    expect(h.exitCount()).toBe(0);
  });
});

describe("resending after a failure", () => {
  const failFirst = () => {
    const attempts: ClientOrchestrationCommand[] = [];
    const dispatch = async (command: ClientOrchestrationCommand) => {
      attempts.push(command);
      if (attempts.length === 1) throw new Error("연결이 끊어졌습니다");
    };
    return { attempts, dispatch };
  };
  type TurnStart = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

  it("resends the same command ids, so a turn the server already took is not doubled", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("한 번만 실행해 줘");
    h.press(key("enter"));
    await flushMicrotasks();
    h.press(key("enter"));
    await flushMicrotasks();
    expect(attempts).toHaveLength(2);
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.commandId).toBe(first.commandId);
    expect(second.message.messageId).toBe(first.message.messageId);
  });

  it("makes a new command when the text was edited after the failure", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("처음 글");
    h.press(key("enter"));
    await flushMicrotasks();
    h.typeText(" 고침");
    h.press(key("enter"));
    await flushMicrotasks();
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.message.text).toBe("처음 글 고침");
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.message.messageId).not.toBe(first.message.messageId);
  });

  it("resends a new thread's first message with its bootstrap while the thread does not exist", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch });
    h.start();
    h.press(key("enter"));
    h.typeText("새 대화");
    h.press(key("enter"));
    await flushMicrotasks();
    h.press(key("enter"));
    await flushMicrotasks();
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.commandId).toBe(first.commandId);
    expect(second.bootstrap?.createThread).toBeDefined();
  });

  it("drops the bootstrap and follows the thread once the server already has it", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch });
    h.start();
    h.press(key("enter"));
    h.typeText("새 대화");
    h.press(key("enter"));
    await flushMicrotasks();
    const first = attempts[0] as TurnStart;
    // The first request did reach the server; only the answer was lost.
    h.link.shell = makeSnapshot(
      [makeProject()],
      [makeThreadShell({ id: first.threadId, title: "새 대화" })],
    );
    h.controller.onShell();
    h.press(key("enter"));
    await flushMicrotasks();
    const second = attempts[1] as TurnStart;
    expect(second.commandId).toBe(first.commandId);
    expect(second.bootstrap).toBeUndefined();
    expect(second.titleSeed).toBeUndefined();
    expect(h.opened).toContain(first.threadId);
  });
});

describe("/model on a thread that has begun", () => {
  const provider = (instanceId: string, driver: string, displayName: string) => ({
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    models: [{ slug: `${instanceId}-m`, name: "Model", isCustom: false, capabilities: null }],
  });
  const config = makeConfig({
    providers: [provider("codex", "codex", "Codex"), provider("claude", "claudeAgent", "Claude")],
  });
  const startedShell = () =>
    makeSnapshot([makeProject()], [makeThreadShell({ id: "thread-new", latestUserMessageAt: T0 })]);

  it("lists only models of the thread's own provider", () => {
    const h = harness({ config, shell: startedShell() });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("/model");
    h.press(key("enter"));
    expect(h.screen()).toContain("Codex / Model");
    expect(h.screen()).not.toContain("Claude");
  });

  it("lists every provider for a thread that has not started", () => {
    const h = harness({ config });
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    expect(h.screen()).toContain("Codex / Model");
    expect(h.screen()).toContain("Claude / Model");
  });
});

describe("a reply to a request the server refused", () => {
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "ls")],
    });
  const refusal = (kind: string, requestId: string, detail: string) =>
    makeActivity({
      id: `fail-${kind}`,
      kind,
      tone: "error",
      summary: "응답 실패",
      createdAt: "2026-10-30T09:00:30.000Z",
      payload: { requestId, detail },
    });

  it("lets the user answer an approval again and says what went wrong", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);

    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
          activities: [
            approvalRequested("req-1", "ls"),
            refusal("provider.approval.respond.failed", "req-1", "일시적인 서버 오류"),
          ],
        }),
        5,
      ),
    ]);
    expect(h.commits.join("\n")).toContain("일시적인 서버 오류");
    expect(h.screen()).toContain("다시 시도하세요");
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(2);
  });

  it("does the same for a question's answer", async () => {
    const question = {
      id: "db",
      header: "DB",
      question: "무엇을 쓸까요?",
      options: [{ label: "SQLite" }, { label: "Postgres" }],
    };
    const asking = (extra: unknown[] = []) =>
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [
          makeActivity({
            id: "q",
            kind: "user-input.requested",
            payload: { requestId: "ask-1", questions: [question] },
          }),
          ...(extra as ReturnType<typeof makeActivity>[]),
        ],
      });
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(asking(), 3)]);
    h.typeText("1");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);

    h.deliver([
      threadSnapshotItem(
        asking([refusal("provider.user-input.respond.failed", "ask-1", "서버가 받지 못했습니다")]),
        5,
      ),
    ]);
    expect(h.commits.join("\n")).toContain("서버가 받지 못했습니다");
    expect(h.screen()).toContain("다시 시도하세요");
    h.typeText("2");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(2);
  });
});

describe("text from the server cannot break the screen", () => {
  it("keeps a multi-line question and its labels on separate single-line rows", () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
          activities: [
            makeActivity({
              id: "q",
              kind: "user-input.requested",
              payload: {
                requestId: "ask-1",
                questions: [
                  {
                    id: "a",
                    header: "머리\n말",
                    question: "첫 줄\n둘째 줄\n\n넷째 줄",
                    options: [{ label: "가\n나", description: "설명\n더" }],
                  },
                ],
              },
            }),
          ],
        }),
        3,
      ),
    ]);
    const lines = h.frame().lines;
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/u);
    // Each row sits inside the question box; its frame is not part of the text.
    const text = lines.map((line) =>
      stripAnsi(line)
        .replace(/^│|│$/gu, "")
        .trim(),
    );
    expect(text).toContain("첫 줄");
    expect(text).toContain("둘째 줄");
    expect(text).toContain("넷째 줄");
  });

  it("never emits a control sequence from project, model, link or choice text", () => {
    const osc = "\u001b]52;c;QUFB\u0007";
    const writes: string[] = [];
    const pending: Array<() => void> = [];
    const region = new LiveRegion(
      { write: (text) => writes.push(text), columns: () => 80, rows: () => 24 },
      (run) => {
        pending.push(run);
        return () => undefined;
      },
    );
    const evil = (name: string) => `${name}${osc}\u001b[2J\u001b[1;1H`;
    const shell = makeSnapshot(
      [makeProject({ title: evil("프로젝트"), workspaceRoot: evil("/work/app") })],
      [makeThreadShell({ id: "thread-new", title: evil("스레드"), latestUserMessageAt: T0 })],
    );
    const link = {
      status: { phase: "blocked", attempt: 1, retryAt: null, detail: evil("거부") } as LinkStatus,
      shell,
      config: makeConfig({
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            displayName: evil("Codex"),
            enabled: true,
            installed: true,
            models: [{ slug: "m", name: evil("모델"), isCustom: false, capabilities: null }],
          },
        ],
      }),
      thread: emptyThreadMirror as ThreadMirrorState,
      openThread: () => undefined,
      closeThread: () => undefined,
      dispatch: async () => undefined,
      getSettings: async () => ({ threadGoals: {} }) as unknown as ServerSettings,
      updateSettings: async () => ({ threadGoals: {} }) as unknown as ServerSettings,
      refreshProviders: async () => [],
      retryCrewTask: async () => undefined,
      loadOlderTurns: async () => {
        throw new Error("no older page");
      },
      getCheckpointDiff: async () => "",
    } satisfies ControllerLink;
    const controller = new AppController({
      link,
      region,
      style: makeStyle(true),
      cwd: "/elsewhere",
      platform: "darwin",
      context: { uuid: () => "id", now: () => new Date(T0) },
      schedule: (run) => {
        pending.push(run);
        return () => undefined;
      },
      now: () => Date.parse(T0),
      runtimeMode: "approval-required",
      continueLast: false,
      exit: () => undefined,
    });
    const paint = () => pending.splice(0).forEach((run) => run());
    controller.onShell();
    paint();
    controller.handleKey({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
    paint();
    controller.handleKey({ type: "key", name: "down", ctrl: false, alt: false, shift: false });
    controller.handleKey({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
    controller.handleKey({ type: "text", text: "/model" });
    controller.handleKey({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
    paint();
    // Choosing another model puts its server-given name in the scrollback; the one in use is listed
    // first, since the server's list does not have it.
    controller.handleKey({ type: "key", name: "down", ctrl: false, alt: false, shift: false });
    controller.handleKey({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
    paint();
    const output = writes.join("");
    expect(stripAnsi(output)).toContain("◇  모델");
    expect(output).toContain("프로젝트");
    expect(output).not.toContain("\u001b]");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("\u001b[1;1H");
  });
});

describe("slash commands", () => {
  it("does not quit on /q followed by a sentence, and does not send it either", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/q 이게 무슨 옵션이야?");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.exitCount()).toBe(0);
    expect(h.dispatched).toEqual([]);
    // The text stays for editing, and the way to send it as it is stays too.
    expect(h.screen()).toContain("│  /q 이게 무슨 옵션이야?");
    // The notice is folded over rows, so its words are read with the line breaks as spaces.
    const said = h.screen().replace(/\s+/gu, " ");
    expect(said).toContain("/q (/exit) 명령은 인자를 받지 않습니다");
    expect(said).toContain("그대로 보내려면 앞에 공백");
  });

  it("still runs a bare command, with surrounding spaces", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("  /exit  ");
    h.press(key("enter"));
    expect(h.exitCount()).toBe(1);
  });

  it("holds /new with a trailing sentence, and sends it with a space in front", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/new 파일을 만들어 줘");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("/new 명령은 인자를 받지 않습니다");
    h.press(key("home"));
    h.typeText(" ");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
  });
});

describe("/theme", () => {
  const fakeThemes = () => {
    const chosen: string[] = [];
    let current = "oop";
    const notes: string[] = [];
    const themes: ThemeSwitcher = {
      current: () => createTheme(current, BUILTIN_THEMES.oop, 0),
      names: () => ["oop", "aurora", "mine"],
      select: (name) => {
        chosen.push(name);
        if (name !== "aurora") {
          return { ok: false, message: `테마를 찾을 수 없습니다: ${name}`, notes: [] };
        }
        current = name;
        return { ok: true, message: "테마: aurora", notes };
      },
    };
    return { themes, chosen, notes };
  };
  const chat = (themes?: ThemeSwitcher) => {
    const h = harness(themes ? { themes } : {});
    h.start();
    h.press(key("enter"));
    return h;
  };

  const pickerRows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));

  it("opens a list that starts on the theme in use and marks it", () => {
    const { themes } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme");
    h.press(key("enter"));
    expect(h.screen()).toContain("◆  테마 선택");
    expect(pickerRows(h)).toEqual(["│  ● oop  현재", "│  ○ aurora", "│  ○ mine"]);
    expect(h.dispatched).toHaveLength(0);
  });

  it("starts the list on the theme in use even when it is not the first", () => {
    const { themes } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme aurora");
    h.press(key("enter"));
    h.typeText("/theme");
    h.press(key("enter"));
    expect(pickerRows(h)).toEqual(["│  ○ oop", "│  ● aurora  현재", "│  ○ mine"]);
  });

  it("applies the pick on Enter, saves it through the switcher and leaves the record", () => {
    const { themes, chosen } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    expect(chosen).toEqual(["aurora"]);
    const commits = h.commits.map(stripAnsi);
    const at = commits.lastIndexOf("◇  테마");
    expect(at).toBeGreaterThan(-1);
    expect(commits[at + 1]).toBe("│  aurora");
    expect(h.screen()).not.toContain("테마 선택");
    expect(h.screen()).not.toContain("테마: aurora");
    expect(h.dispatched).toHaveLength(0);
  });

  it("closes on Esc without choosing or recording anything", () => {
    const { themes, chosen } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme");
    h.press(key("enter"));
    h.press(key("down"), key("escape"));
    expect(chosen).toEqual([]);
    expect(h.screen()).not.toContain("테마 선택");
    expect(h.commits.map(stripAnsi)).not.toContain("◇  테마");
  });

  it("switches to the named theme at once, with the same record and no notice", () => {
    const { themes, chosen } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme aurora");
    h.press(key("enter"));
    expect(chosen).toEqual(["aurora"]);
    const commits = h.commits.map(stripAnsi);
    expect(commits.at(-2)).toBe("◇  테마");
    expect(commits.at(-1)).toBe("│  aurora");
    expect(h.screen()).not.toContain("테마: aurora");
    expect(h.dispatched).toHaveLength(0);
  });

  it("still says what a switch that worked could not do, such as saving", () => {
    const { themes, notes } = fakeThemes();
    notes.push("저장하지 못했습니다");
    const h = chat(themes);
    h.typeText("/theme");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    expect(h.screen()).toContain("▲  테마: aurora");
    expect(h.commits.map(stripAnsi)).toContain("│  aurora");
  });

  it("gives an unknown name a single line of guidance", () => {
    const { themes } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme nope");
    h.press(key("enter"));
    expect(h.screen()).toContain("테마를 찾을 수 없습니다: nope");
    expect(h.commits.map(stripAnsi)).not.toContain("◇  테마");
    expect(h.dispatched).toHaveLength(0);
  });

  it("leaves a longer sentence starting with /theme to the agent", async () => {
    const { themes, chosen } = fakeThemes();
    const h = chat(themes);
    h.typeText("/theme 이 뭐야 정말");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(chosen).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
  });

  it("is an ordinary message where no theme switcher was given", async () => {
    const h = chat();
    h.typeText("/theme aurora");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
  });
});

describe("a thread the server cannot open", () => {
  it("goes back to the thread list with a note, and the link stays as it is", () => {
    const h = harness();
    h.openNewest();
    h.controller.onThreadFailed("thread-new" as ThreadId, "Thread thread-new was not found");
    expect(h.commits.join("\n")).toContain("스레드를 열 수 없습니다");
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("ignores a failure for a thread the user already left", () => {
    const h = harness();
    h.start();
    h.controller.onThreadFailed("thread-new" as ThreadId, "gone");
    expect(h.commits.join("\n")).not.toContain("스레드를 열 수 없습니다");
  });
});

describe("a project behind a symlink", () => {
  it("matches the folder by real path", () => {
    const canonical = (path: string) => path.replace(/^\/private/u, "");
    const h = harness({ cwd: "/private/work/app/src", canonical });
    h.start();
    expect(h.screen()).toContain("메시지");
    expect(h.screen()).not.toContain("프로젝트를 고르세요");
  });

  it("falls to the project list when the real paths differ", () => {
    const h = harness({ cwd: "/private/work/app/src" });
    h.start();
    expect(h.screen()).toContain("↑/↓ 이동 • Enter 열기 • 글자 입력 검색 • Ctrl+C 종료");
  });
});

describe("questions: slash commands and the draft from before", () => {
  const asking = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: {
            requestId: "ask-1",
            questions: [
              {
                id: "db",
                header: "DB",
                question: "무엇을 쓸까요?",
                options: [
                  { label: "SQLite", description: "가볍다" },
                  { label: "Postgres", description: "크다" },
                ],
                ...extra,
              },
            ],
          },
        }),
      ],
    });
  const answered = () =>
    makeThread({
      id: "thread-new",
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: { requestId: "ask-1", questions: [] },
        }),
        makeActivity({
          id: "q-done",
          kind: "user-input.resolved",
          payload: { requestId: "ask-1" },
        }),
      ],
    });

  it("runs /threads, /help and /exit as commands while a question is open", async () => {
    const help = harness();
    help.openNewest();
    help.deliver([threadSnapshotItem(asking(), 3)]);
    help.typeText("/help");
    help.press(key("enter"));
    expect(help.commits.join("\n")).toContain("/threads");
    expect(help.dispatched).toEqual([]);

    const back = harness();
    back.openNewest();
    back.deliver([threadSnapshotItem(asking(), 3)]);
    back.typeText("/threads");
    back.press(key("enter"));
    await flushMicrotasks();
    expect(back.closedCount()).toBe(1);
    expect(back.screen()).toContain("스레드를 고르세요");
    expect(back.dispatched).toEqual([]);

    const quit = harness();
    quit.openNewest();
    quit.deliver([threadSnapshotItem(asking(), 3)]);
    quit.typeText("/exit");
    quit.press(key("enter"));
    expect(quit.exitCount()).toBe(1);
    expect(quit.dispatched).toEqual([]);
  });

  it("lets /threads out of a question that takes no typed answer", () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(asking({ allowCustomAnswer: false }), 3)]);
    h.typeText("/threads");
    h.press(key("enter"));
    expect(h.screen()).toContain("스레드를 고르세요");
  });

  it("does not send the draft from before the panel as the answer, and gives it back afterwards", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("쓰던 글");
    h.deliver([threadSnapshotItem(asking(), 4)]);
    expect(h.screen()).toContain("질문: DB");
    expect(h.screen()).not.toContain("쓰던 글");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.deliver([threadSnapshotItem(answered(), 9)]);
    expect(h.screen()).not.toContain("질문: DB");
    expect(h.screen()).toContain("│  쓰던 글");
  });

  it("gives the typed answer back when it could not be sent", async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error("연결이 끊어졌습니다");
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(asking(), 3)]);
    h.typeText("2");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.commits.join("\n")).toContain("답변 전송 실패");
    expect(h.screen()).toContain("│  2");
  });
});

describe("/model starts on the model in use", () => {
  const config = makeConfig();
  const rows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));

  it("marks the thread's own model as the current one and starts the pointer there", () => {
    const h = harness({
      config,
      shell: makeSnapshot(
        [makeProject()],
        [
          makeThreadShell({
            id: "thread-new",
            latestUserMessageAt: T0,
            modelSelection: { instanceId: "codex", model: "gpt-5-mini" },
          }),
        ],
      ),
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h)).toEqual(["│  ○ Codex / GPT-5", "│  ● Codex / GPT-5 mini  현재"]);
  });

  it("falls back to the project's default for a thread that has not started", () => {
    const h = harness({
      config,
      shell: makeSnapshot(
        [makeProject({ defaultModelSelection: { instanceId: "codex", model: "gpt-5-mini" } })],
        [],
      ),
    });
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h)).toEqual(["│  ○ Codex / GPT-5", "│  ● Codex / GPT-5 mini  현재"]);
  });

  it("follows a model picked in this session", () => {
    const h = harness({ config });
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h)).toEqual(["│  ○ Codex / GPT-5", "│  ● Codex / GPT-5 mini  현재"]);
  });
});

describe("/model belongs to one thread", () => {
  const provider = (model: string) => ({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    models: [{ slug: model, name: model, isDefault: true, isCustom: false, capabilities: null }],
  });
  const claude = {
    instanceId: "claude",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    models: [{ slug: "claude-m", name: "claude-m", isCustom: false, capabilities: null }],
  };
  type TurnStart = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

  it("starts the next thread on its own model, not on the one picked in the last", async () => {
    const config = makeConfig({
      providers: [
        { ...provider("gpt-5"), models: [...provider("gpt-5").models, ...claude.models] },
        claude,
      ],
    });
    const h = harness({
      config,
      shell: makeSnapshot(
        [makeProject()],
        [makeThreadShell({ id: "thread-new", latestUserMessageAt: T0 })],
      ),
    });
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("down"), key("enter"));
    expect(h.screen()).toContain("Claude / claude-m");
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    expect(h.screen()).not.toContain("Claude / claude-m");
    h.typeText("계속");
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as TurnStart;
    expect(command.threadId).toBe("thread-new");
    // The turn names the thread's own model, the one on the bar, never the one picked before.
    expect(command.modelSelection).toMatchObject({ instanceId: "codex", model: "gpt-5" });
  });

  it("does not send a model the thread can no longer use, and says so", async () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    expect(h.screen()).toContain("GPT-5 mini");
    (h.link as { config: ServerConfig }).config = makeConfig({ providers: [provider("gpt-5")] });
    h.typeText("보내기");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("선택한 모델을 쓸 수 없습니다");
    expect(h.screen()).toContain("│  보내기");
    // The stale choice is dropped, so the same text now goes out on the default model.
    h.press(key("enter"));
    await flushMicrotasks();
    const command = h.dispatched[0] as TurnStart;
    expect(command.modelSelection).toMatchObject({ model: "gpt-5" });
    expect(command.bootstrap?.createThread?.modelSelection).toMatchObject({ model: "gpt-5" });
  });
});

describe("what a failed send leaves behind", () => {
  type TurnStart = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  const failFirst = (error: () => Error = () => new Error("연결이 끊어졌습니다")) => {
    const attempts: ClientOrchestrationCommand[] = [];
    const dispatch = async (command: ClientOrchestrationCommand) => {
      attempts.push(command);
      if (attempts.length === 1) throw error();
    };
    return { attempts, dispatch };
  };
  const existing = () =>
    makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({ id: "thread-new", updatedAt: "2026-10-30T08:00:00.000Z" }),
        makeThreadShell({ id: "thread-old", updatedAt: "2026-10-28T09:00:00.000Z" }),
      ],
    );

  it("is forgotten when the user leaves the thread and writes the same words again", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch, shell: existing() });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("같은 말");
    h.press(key("enter"));
    await flushMicrotasks();
    h.press(ctrl("u"));
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("같은 말");
    h.press(key("enter"));
    await flushMicrotasks();
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.message.messageId).not.toBe(first.message.messageId);
  });

  it("is forgotten when the model is changed", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch, shell: existing() });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("같은 말");
    h.press(key("enter"));
    await flushMicrotasks();
    h.press(ctrl("u"));
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    h.typeText("같은 말");
    h.press(key("enter"));
    await flushMicrotasks();
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
  });

  it("is forgotten once the message shows up in the thread, and the leftover text goes with it", async () => {
    const { attempts, dispatch } = failFirst();
    const h = harness({ dispatch, shell: existing() });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("들어간 말");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.screen()).toContain("│  들어간 말");
    const sent = attempts[0] as TurnStart;
    // The server did take it; only the answer was lost.
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          messages: [makeMessage({ id: sent.message.messageId, role: "user", text: "들어간 말" })],
        }),
        4,
      ),
    ]);
    expect(h.screen()).not.toContain("│  들어간 말");
    h.typeText("들어간 말");
    h.press(key("enter"));
    await flushMicrotasks();
    const second = attempts[1] as TurnStart;
    expect(second.commandId).not.toBe(sent.commandId);
  });

  it("does not keep a refusal for resending: the next try is a new command", async () => {
    const { attempts, dispatch } = failFirst(
      () => new CommandRejectedError("이 명령은 거부되었습니다"),
    );
    const h = harness({ dispatch, shell: existing() });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("거부될 말");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.screen()).toContain("│  거부될 말");
    h.press(key("enter"));
    await flushMicrotasks();
    const [first, second] = attempts as [TurnStart, TurnStart];
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.message.messageId).not.toBe(first.message.messageId);
  });

  it("is not put back into the composer of a thread the user has since opened", async () => {
    let fail: (error: Error) => void = () => undefined;
    const h = harness({
      shell: existing(),
      dispatch: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("떠난 뒤 실패");
    h.press(key("enter"));
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("down"), key("down"), key("enter"));
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-old" }), 3)]);
    fail(new Error("연결이 끊어졌습니다"));
    await flushMicrotasks();
    expect(h.screen()).not.toContain("떠난 뒤 실패");
  });
});

describe("a reply that went through but never got an answer", () => {
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "ls")],
    });

  it("can be sent again once the link is back", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    // Still waiting: the server died before it could record the reply.
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);

    (h.link as { status: LinkStatus }).status = {
      phase: "reconnecting",
      attempt: 1,
      retryAt: null,
      detail: null,
    };
    h.controller.onLinkStatus();
    (h.link as { status: LinkStatus }).status = online;
    h.controller.onLinkStatus();
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(2);
  });
});

describe("multi-question answers and a draft left in the composer", () => {
  const twoQuestions = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: {
            requestId: "ask-1",
            questions: [
              {
                id: "q1",
                header: "첫째",
                question: "계속할까요?",
                options: [
                  { label: "예", description: "계속" },
                  { label: "아니오", description: "중단" },
                ],
              },
              {
                id: "q2",
                header: "둘째",
                question: "어느 환경입니까?",
                options: [
                  { label: "prod", description: "운영" },
                  { label: "dev", description: "개발" },
                ],
              },
            ],
          },
        }),
      ],
    });
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "rm -rf build")],
    });

  it("stays on the last question after a failed send, and the resend keeps the earlier answers", async () => {
    let attempts = 0;
    const h = harness({
      dispatch: async (command) => {
        attempts += 1;
        if (attempts === 1) throw new Error("일시적 오류");
        h.dispatched.push(command);
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(twoQuestions(), 3)]);
    h.typeText("2");
    h.press(key("enter"));
    h.typeText("1");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(attempts).toBe(1);
    expect(h.screen()).toContain("질문 (2/2)");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ answers: { q1: "아니오", q2: "prod" } });
  });

  it("starts the approval panel locked when the user was in the middle of a sentence", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 2)]);
    h.typeText("see step ");
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    // An arrow is a deliberate move: it unlocks the panel and picks.
    h.press(key("down"));
    console.log("DBG1\n" + h.screen());
    h.press(key("enter"));
    await flushMicrotasks();
    console.log("DBG2\n" + h.screen());
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.approval.respond"]);
  });

  it("keeps the lock through a reconnect", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 2)]);
    h.typeText("see step ");
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    (h.link as { status: LinkStatus }).status = {
      phase: "reconnecting",
      attempt: 1,
      retryAt: null,
      detail: null,
    };
    h.controller.onLinkStatus();
    (h.link as { status: LinkStatus }).status = online;
    h.controller.onLinkStatus();
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
  });

  it("leaves the numbers unlocked when the composer was empty", async () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 2)]);
    h.deliver([threadSnapshotItem(waiting(), 3)]);
    // The numbers are locked while there is a draft; an arrow unlocks them.
    h.press(key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.approval.respond"]);
  });

  it("keeps every answer when the server refuses the reply", async () => {
    const refused = () => {
      const thread = twoQuestions();
      return {
        ...thread,
        activities: [
          ...thread.activities,
          makeActivity({
            id: "fail",
            kind: "provider.user-input.respond.failed",
            tone: "error",
            summary: "응답 실패",
            createdAt: "2026-10-30T09:00:30.000Z",
            payload: { requestId: "ask-1", detail: "세션 없음" },
          }),
        ],
      };
    };
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(twoQuestions(), 3)]);
    h.typeText("2");
    h.press(key("enter"));
    h.typeText("1");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);

    h.deliver([threadSnapshotItem(refused(), 5)]);
    expect(h.screen()).toContain("질문 (2/2)");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(2);
    expect(h.dispatched[1]).toMatchObject({ answers: { q1: "아니오", q2: "prod" } });
  });

  describe("when one panel replaces another", () => {
    const replaced = () =>
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [
          approvalRequested("req-1", "rm -rf build"),
          makeActivity({ id: "r", kind: "approval.resolved", payload: { requestId: "req-1" } }),
          approvalRequested("req-2", "git push --force"),
        ],
      });
    const questionThenApproval = () => {
      const thread = twoQuestions();
      return {
        ...thread,
        activities: [...thread.activities, approvalRequested("req-1", "rm -rf build")],
      };
    };

    it("keeps the lock of a draft put aside by the first approval", async () => {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 2)]);
      h.typeText("see step ");
      h.deliver([threadSnapshotItem(waiting(), 3)]);
      h.deliver([threadSnapshotItem(replaced(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("keeps the lock of letters typed over the first approval", async () => {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(waiting(), 3)]);
      h.typeText("n");
      h.deliver([threadSnapshotItem(replaced(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("locks an approval arriving over a question that hid a draft", async () => {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 2)]);
      h.typeText("see step ");
      h.deliver([threadSnapshotItem(twoQuestions(), 3)]);
      h.deliver([threadSnapshotItem(questionThenApproval(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("locks an approval arriving over a half-written answer", async () => {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(twoQuestions(), 3)]);
      h.typeText("직접 쓰는 답");
      h.deliver([threadSnapshotItem(questionThenApproval(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("does not lock the next approval after an empty composer", async () => {
      const h = harness();
      h.openNewest();
      h.deliver([threadSnapshotItem(waiting(), 3)]);
      h.deliver([threadSnapshotItem(replaced(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toHaveLength(1);
    });
  });
});

describe("the link banner", () => {
  const withLink = (status: LinkStatus) => {
    // Wide enough for the whole row: a narrower terminal cuts it, as the second test below shows.
    const h = harness({ columns: 101 });
    (h.link as { status: LinkStatus }).status = status;
    h.start();
    return h;
  };
  const blocked = (reason: string | undefined, detail: string): LinkStatus => ({
    phase: "blocked",
    attempt: 1,
    retryAt: null,
    detail,
    ...(reason !== undefined ? { reason } : {}),
  });

  it("tells a rejected token to restart oop, and a remote server to pair again", () => {
    const h = withLink(blocked("authentication", "The environment credential is invalid."));
    expect(h.screen()).toContain("토큰 거절 — 'oop' 재시작");
    // A narrow terminal cuts the row, so the whole text is checked where it is built.
    expect(linkNotice(h.link.status, Date.parse(T0), makeStyle(false))).toContain(
      "원격은 새 링크로 'oop pair'",
    );
  });

  it("tells a protocol mismatch to update, not to pair again", () => {
    const h = withLink(blocked("unsupported", "This client requires a newer server."));
    expect(h.screen()).toContain("프로토콜 불일치 — 앱이나 oop 을 업데이트하세요");
    expect(h.screen()).not.toContain("oop pair");
  });

  it("gives no advice for a cause it was not told", () => {
    const h = withLink(blocked(undefined, "Something else."));
    expect(h.screen()).toContain("연결 거부: Something else.");
    expect(h.screen()).not.toContain("oop pair");
    expect(h.screen()).not.toContain("업데이트");
  });

  it("shows why the link keeps dropping, on one row that fits the terminal", () => {
    const reason = "OOP 앱의 서버가 이전과 다른 서버라서 토큰을 보내지 않았습니다.\n두 번째 줄";
    const h = withLink({
      phase: "reconnecting",
      attempt: 3,
      retryAt: Date.parse(T0) + 4000,
      detail: reason,
    });
    const banner = h.frame().lines.find((line) => stripAnsi(line).includes("연결이 끊어졌습니다"));
    expect(stripAnsi(banner ?? "")).toContain("4초 후 재시도 (3회) — OOP 앱의 서버가");
    expect(h.screen()).not.toContain("두 번째 줄");
    // What the terminal gets is the row the live region paints; it cuts the banner to the terminal.
    const writes: string[] = [];
    const pending: Array<() => void> = [];
    const region = new LiveRegion(
      { write: (text) => writes.push(text), columns: () => 60, rows: () => 24 },
      (run) => {
        pending.push(run);
        return () => undefined;
      },
    );
    region.set(h.frame());
    pending.splice(0).forEach((run) => run());
    const painted = writes.join("").split("\r\n").map(stripAnsi);
    const row = painted.find((line) => line.includes("연결이 끊어졌습니다"));
    expect(row).toContain("4초 후 재시도 (3회)");
    expect(stringWidth(row ?? "")).toBeLessThanOrEqual(59);
  });
});

describe("the live screen while a turn runs", () => {
  const TURN = "turn-1";
  const inTurn = (activity: ReturnType<typeof makeActivity>) => ({
    ...activity,
    turnId: TurnId.make(TURN),
  });
  /** A running turn that began `secondsAgo` before the test clock. */
  const working = (extra: Record<string, unknown> = {}, secondsAgo = 12) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new", activeTurnId: TURN }),
      latestTurn: {
        turnId: TURN,
        state: "running",
        requestedAt: T0,
        startedAt: new Date(Date.parse(T0) - secondsAgo * 1000).toISOString(),
        completedAt: null,
        assistantMessageId: null,
      },
      ...extra,
    });
  const idle = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("idle", { threadId: "thread-new" }),
      ...extra,
    });
  const bash = inTurn(
    makeActivity({
      id: "tool-1",
      kind: "tool.started",
      payload: { toolCallId: "c1", title: "Bash", detail: "pnpm test" },
    }),
  );
  const open = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness({ columns: 101, ...options });
    h.openNewest();
    return h;
  };

  describe("the work row", () => {
    it("counts from the turn's real start, not from when this client looked", () => {
      const h = open();
      h.advance(40_000);
      h.deliver([threadSnapshotItem(working({}, 12), 3)]);
      expect(h.screen()).toContain("응답 생성 중  52s • Esc 중단");
    });

    it("names the running tool and what it was given", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working({ activities: [bash] }), 3)]);
      expect(h.screen()).toContain("Bash · pnpm test  12s • Esc 중단");
    });

    it("moves on with each tick, and the time with the clock", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      const first = h.frame().lines.find((line) => stripAnsi(line).includes("응답 생성 중"));
      h.advance(3000);
      h.tickAll();
      const later = h.frame().lines.find((line) => stripAnsi(line).includes("응답 생성 중"));
      expect(stripAnsi(later ?? "")).toContain("15s");
      expect(stripAnsi(later ?? "").charAt(0)).not.toBe(stripAnsi(first ?? "").charAt(0));
    });

    it("says so after a minute without a word from the server", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working({}, 20), 3)]);
      expect(h.screen()).not.toContain("응답 없음");
      h.advance(75_000);
      h.tickAll();
      expect(h.screen()).toContain("응답 없음 1m 15s");
    });

    it("falls back to when it first saw the turn if the server clock is ahead", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working({}, -600), 3)]);
      expect(h.screen()).toContain("응답 생성 중  0s");
      h.advance(5000);
      h.tickAll();
      expect(h.screen()).toContain("5s");
    });
  });

  describe("the animation timer", () => {
    it("does not exist while nothing runs", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3)]);
      h.press(text("안"));
      expect(h.timers).toHaveLength(0);
    });

    it("starts with a running turn at the spinner interval, once", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.deliver([threadSnapshotItem(working({ activities: [bash] }), 4)]);
      expect(h.running().map((timer) => timer.interval)).toEqual([100]);
      expect(h.timers).toHaveLength(1);
    });

    it("ticks once a second, for the time alone, with animations off", () => {
      const h = open({ animations: false });
      h.deliver([threadSnapshotItem(working(), 3)]);
      expect(h.running().map((timer) => timer.interval)).toEqual([1000]);
      const row = () =>
        h
          .frame()
          .lines.map(stripAnsi)
          .find((line) => line.includes("응답 생성 중"));
      const before = row();
      h.advance(1000);
      h.tickAll();
      expect(row()).not.toBe(before);
      expect(row()?.charAt(0)).toBe(before?.charAt(0));
    });

    it("stops when the turn ends", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      expect(h.running()).toHaveLength(1);
      h.deliver([threadSnapshotItem(idle(), 4)]);
      expect(h.running()).toHaveLength(0);
    });

    it("stops while an approval waits, and again while an answer is wanted", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 4)]);
      expect(h.running()).toHaveLength(0);
      h.deliver([threadSnapshotItem(working(), 5)]);
      expect(h.running()).toHaveLength(1);
      h.deliver([
        threadSnapshotItem(
          working({
            activities: [
              makeActivity({
                id: "q",
                kind: "user-input.requested",
                payload: {
                  requestId: "ask-1",
                  questions: [{ id: "a", header: "H", question: "Q?", options: [] }],
                },
              }),
            ],
          }),
          6,
        ),
      ]);
      expect(h.running()).toHaveLength(0);
    });

    it("stops when the connection drops, and starts again when it is back", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      const link = h.link as { status: LinkStatus };
      link.status = { phase: "reconnecting", attempt: 1, retryAt: null, detail: null };
      h.controller.onLinkStatus();
      expect(h.running()).toHaveLength(0);
      link.status = online;
      h.controller.onLinkStatus();
      expect(h.running()).toHaveLength(1);
    });

    it("stops when the chat is left, and when the controller is disposed", () => {
      const left = open();
      left.deliver([threadSnapshotItem(working(), 3)]);
      expect(left.running()).toHaveLength(1);
      left.deliver([threadDeletedEvent(4, "thread-new")]);
      expect(left.screen()).toContain("스레드를 고르세요");
      expect(left.running()).toHaveLength(0);

      const disposed = open();
      disposed.deliver([threadSnapshotItem(working(), 3)]);
      expect(disposed.running()).toHaveLength(1);
      disposed.controller.dispose();
      expect(disposed.running()).toHaveLength(0);
    });
  });

  describe("the status bar", () => {
    it("shows model, mode, folder and the values the server reported", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(
          working({
            branch: "feat/x",
            activities: [
              makeActivity({
                id: "ctx",
                kind: "context-window.updated",
                payload: { usedTokens: 42_000, maxTokens: 100_000 },
              }),
              makeActivity({
                id: "u1",
                kind: "owned-usage",
                payload: {
                  v: 1,
                  scope: "main-turn",
                  source: {
                    driver: "claudeAgent",
                    instanceId: "claudeAgent",
                    runtimeEventId: "e1",
                  },
                  costUsd: 0.12,
                },
              }),
            ],
          }),
          3,
        ),
      ]);
      const bar =
        h
          .screen()
          .split("\n")
          .find((line) => line.startsWith("└")) ?? "";
      expect(bar).toContain("GPT-5");
      expect(bar).toContain("승인 필요");
      expect(bar).toContain("/work/app");
      expect(bar).toContain("feat/x");
      expect(bar).toContain("42%");
      expect(bar).toContain("$0.12");
    });

    it("leaves out what the server did not report, with no placeholder", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3)]);
      const bar =
        h
          .screen()
          .split("\n")
          .find((line) => line.startsWith("└")) ?? "";
      expect(bar).not.toMatch(/\$|%|⎇|에이전트|n\/a|--|\?/u);
      expect(bar).not.toMatch(/│\s*│/u);
    });

    it("keeps model and folder in view while reconnecting, with the banner on its own row", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3)]);
      (h.link as { status: LinkStatus }).status = {
        phase: "reconnecting",
        attempt: 2,
        retryAt: Date.parse(T0) + 4000,
        detail: null,
      };
      h.controller.onLinkStatus();
      const lines = h.screen().split("\n");
      expect(lines.some((line) => line.includes("연결이 끊어졌습니다"))).toBe(true);
      const bar = lines.find((line) => line.startsWith("└")) ?? "";
      expect(bar).toContain("GPT-5");
      expect(bar).toContain("/work/app");
    });

    it("never draws a row wider than the terminal, from 30 to 120 columns", () => {
      for (const columns of [30, 40, 61, 80, 120]) {
        const h = harness({ columns });
        h.openNewest();
        h.deliver([
          threadSnapshotItem(
            working({
              activities: [
                bash,
                inTurn(
                  makeActivity({
                    id: "plan",
                    kind: "turn.plan.updated",
                    payload: {
                      plan: [{ step: "한국어 단계 설명이 아주 길어요", status: "inProgress" }],
                    },
                  }),
                ),
                inTurn(
                  makeActivity({
                    id: "ag",
                    kind: "task.started",
                    payload: { taskId: "t1", title: "리뷰어 에이전트", agentKind: "agent" },
                  }),
                ),
              ],
            }),
            3,
          ),
        ]);
        for (const line of h.frame().lines) {
          expect(stringWidth(stripAnsi(line)), `@ ${columns}`).toBeLessThanOrEqual(columns - 1);
        }
      }
    });
  });

  describe("the input area", () => {
    it("draws the rule in the warning colour while an approval waits", () => {
      const colored = createTheme("oop", BUILTIN_THEMES.oop, 3);
      const h = open({ style: makeStyle(colored) });
      h.deliver([threadSnapshotItem(working(), 3)]);
      const ruleOf = () => {
        const line =
          h.frame().lines.find((candidate) => /^─{10,}$/u.test(stripAnsi(candidate))) ?? "";
        return { line, width: stripAnsi(line).length };
      };
      const idleRule = ruleOf();
      expect(idleRule.line).toBe(colored.border("─".repeat(idleRule.width)));
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 4)]);
      const waitingRule = ruleOf();
      expect(waitingRule.line).toBe(colored.warning("─".repeat(waitingRule.width)));
    });

    it("puts the cursor after the typed text, with ascii or unicode symbols", () => {
      for (const symbols of [undefined, ASCII_SYMBOLS]) {
        const h = open(symbols ? { symbols } : {});
        h.deliver([threadSnapshotItem(idle(), 3)]);
        h.typeText("가a");
        const frame = h.frame();
        const row = stripAnsi(frame.lines[frame.cursor?.row ?? 0] ?? "");
        const typed = row.indexOf("가a") + "가a".length;
        expect(frame.cursor?.col).toBe(stringWidth(row.slice(0, typed)));
      }
    });

    it("keeps the composer and the bar when there is almost no height", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(
          working({
            activities: [
              inTurn(
                makeActivity({
                  id: "plan",
                  kind: "turn.plan.updated",
                  payload: {
                    plan: Array.from({ length: 9 }, (_, i) => ({
                      step: `단계 ${i}`,
                      status: "pending",
                    })),
                  },
                }),
              ),
            ],
          }),
          3,
        ),
      ]);
      expect(h.frame().lines.length).toBeLessThanOrEqual(24);
      const lines = h.screen().split("\n");
      expect(lines.at(-1)?.startsWith("└")).toBe(true);
      // The composer is the row the cursor sits on, and it is still on the rail.
      const cursor = h.frame().cursor;
      expect(cursor).not.toBeNull();
      expect(lines[cursor?.row ?? -1]?.startsWith("│")).toBe(true);
    });
  });

  describe("the plan and the sub-agents", () => {
    const planActivity = (steps: Array<[string, string]>) =>
      inTurn(
        makeActivity({
          id: "plan",
          kind: "turn.plan.updated",
          payload: { plan: steps.map(([step, status]) => ({ step, status })) },
        }),
      );
    const agent = (taskId: string, title: string) =>
      inTurn(
        makeActivity({
          id: `start-${taskId}`,
          kind: "task.started",
          payload: { taskId, title, agentKind: "agent" },
        }),
      );

    it("shows the plan with its marks and folds it with Ctrl-T", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(
          working({
            activities: [
              planActivity([
                ["읽기", "completed"],
                ["고치기", "inProgress"],
                ["시험", "pending"],
              ]),
            ],
          }),
          3,
        ),
      ]);
      expect(h.screen()).toContain("계획 1/3");
      expect(h.screen()).toContain("☑ 읽기");
      expect(h.screen()).toContain("◐ 고치기");
      expect(h.screen()).toContain("☐ 시험");
      h.press(ctrl("t"));
      expect(h.closedCount()).toBe(0);
      expect(h.screen()).toContain("계획 1/3");
      expect(h.screen()).not.toContain("◐ 고치기");
      h.press(ctrl("t"));
      expect(h.screen()).toContain("◐ 고치기");
    });

    it("does not offer Ctrl-T to fold the plan while an approval waits, since it leaves the chat", () => {
      const h = open();
      const activities = [planActivity([["읽기", "inProgress"]])];
      h.deliver([threadSnapshotItem(working({ activities }), 3)]);
      expect(h.screen()).toContain("계획 0/1");
      expect(h.screen()).toContain("Ctrl-T 접기");
      h.deliver([
        threadSnapshotItem(
          working({ activities: [...activities, inTurn(approvalRequested("req-1"))] }),
          4,
        ),
      ]);
      expect(h.screen()).toContain("계획 0/1");
      expect(h.screen()).not.toContain("Ctrl-T 접기");
    });

    it("lists the running sub-agents as a tree and counts them in the bar", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(
          working({ activities: [agent("t1", "탐색기"), agent("t2", "검토기")] }),
          3,
        ),
      ]);
      expect(h.screen()).toContain("├─ 탐색기");
      h.advance(12_000);
      h.tickAll();
      expect(h.screen()).toContain("└─ 검토기 · 12s");
      expect(h.screen()).toContain("에이전트 2");
    });

    it("lets both go when the turn ends", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(
          working({
            activities: [planActivity([["읽기", "inProgress"]]), agent("t1", "탐색기")],
          }),
          3,
        ),
      ]);
      h.deliver([
        threadSnapshotItem(
          idle({ activities: [planActivity([["읽기", "inProgress"]]), agent("t1", "탐색기")] }),
          4,
        ),
      ]);
      expect(h.screen()).not.toContain("계획");
      expect(h.screen()).not.toContain("탐색기");
      expect(h.screen()).not.toContain("에이전트");
    });

    it("leaves Ctrl-T alone in an ordinary chat with no plan", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3)]);
      h.typeText("초안");
      h.press(ctrl("t"));
      expect(h.closedCount()).toBe(0);
      expect(h.screen()).toContain("초안");
    });
  });

  describe("older history", () => {
    it("says once that the earlier part of the conversation was left out", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3, true)]);
      h.deliver([threadSnapshotItem(idle(), 4, true)]);
      expect(
        h.commits.map(stripAnsi).filter((line) => line.includes("/history 로 보기")),
      ).toHaveLength(1);
    });

    describe("/history", () => {
      const stamp = (n: number) => new Date(Date.UTC(2026, 9, 29, 0, 0, n)).toISOString();
      /** Messages `from`..`to` of a conversation that alternates user and reply, numbered in the text. */
      const talk = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, index) => {
          const n = from + index;
          return makeMessage({
            id: `h${n}`,
            role: n % 2 === 1 ? "user" : "assistant",
            text: `대화 ${n}`,
            createdAt: stamp(n),
          });
        });
      const loaded = (from: number, to: number, hasMore?: boolean) =>
        threadSnapshotItem(
          idle({
            messages: talk(from, to),
            session: makeSession("idle", { threadId: "thread-new" }),
          }),
          3,
          hasMore,
        );
      const say = (h: ReturnType<typeof open>, line: string) => {
        h.typeText(line);
        h.press(key("enter"));
      };
      const printed = (h: ReturnType<typeof open>) => h.commits.map(stripAnsi).join("\n");

      it("writes a plan once: the one already on screen is not printed again, an older one is", () => {
        const h = open();
        const proposed = (id: string, title: string, n: number) => ({
          id,
          turnId: null,
          planMarkdown: `# ${title}\n\n- 하나`,
          createdAt: stamp(n),
          updatedAt: stamp(n),
          implementedAt: null,
          implementationThreadId: null,
        });
        h.deliver([
          threadSnapshotItem(
            idle({
              messages: talk(1, 40),
              session: makeSession("idle", { threadId: "thread-new" }),
              proposedPlans: [
                proposed("p-old", "오래된 계획", 5),
                proposed("p-now", "화면의 계획", 35),
              ],
            }),
            3,
          ),
        ]);
        const before = h.commits.length;
        expect(printed(h)).toContain("화면의 계획");
        say(h, "/history 4");
        say(h, "/history 4");
        say(h, "/history");
        const later = h.commits.slice(before).map(stripAnsi).join("\n");
        expect(later).toContain("오래된 계획");
        expect(later.split("오래된 계획")).toHaveLength(2);
        expect(later).not.toContain("화면의 계획");
      });

      it("prints the messages before the ones shown, newest end first, and keeps going where it stopped", () => {
        const h = open();
        h.deliver([loaded(1, 40)]);
        expect(printed(h)).toContain("... 이전 메시지 10개 · /history 로 보기");
        expect(printed(h)).not.toContain("대화 10");
        const before = h.commits.length;

        say(h, "/history 4");
        const first = h.commits.slice(before).map(stripAnsi);
        expect(
          first.filter((row) => /^[◇│] {2}대화 \d+$/u.test(row)).map((row) => row.trim()),
        ).toEqual(["◇  대화 7", "│  대화 8", "◇  대화 9", "│  대화 10"]);
        expect(first.join("\n")).toContain("이전 대화 4개");
        expect(first.join("\n")).toContain("여기까지 이전 대화 · 더 이전 메시지 6개 · /history");

        const middle = h.commits.length;
        say(h, "/history");
        const rest = h.commits.slice(middle).map(stripAnsi);
        expect(rest.filter((row) => /^[◇│] {2}대화 \d+$/u.test(row))).toHaveLength(6);
        expect(rest.join("\n")).toContain("대화의 처음까지 봤습니다");

        say(h, "/history");
        expect(h.screen()).toContain("더 이전 대화가 없습니다.");
      });

      it("fetches a page of older turns from the server when the loaded part runs out", async () => {
        const h = open();
        const asked: Array<[string, string]> = [];
        Object.assign(h.link, {
          loadOlderTurns: async (threadId: string, cursor: string) => {
            asked.push([threadId, cursor]);
            return {
              snapshotSequence: 3,
              thread: makeThread({ id: "thread-new", messages: talk(1, 12) }),
              page: { beforeCursor: null, hasMore: false, snapshotSequence: 3 },
            };
          },
        });
        h.deliver([loaded(13, 44, true)]);
        expect(printed(h)).toContain("... 이전 메시지 2개 이상 · /history 로 보기");
        const before = h.commits.length;

        say(h, "/history 5");
        expect(h.screen()).toContain("이전 대화 불러오는 중");
        await flushMicrotasks();
        expect(asked).toEqual([["thread-new", "cursor"]]);
        const shown = h.commits
          .slice(before)
          .map(stripAnsi)
          .filter((row) => /^[◇│] {2}대화 \d+$/u.test(row))
          .map((row) => row.trim());
        expect(shown).toEqual([
          "│  대화 10",
          "◇  대화 11",
          "│  대화 12",
          "◇  대화 13",
          "│  대화 14",
        ]);
        expect(h.screen()).not.toContain("이전 대화 불러오는 중");
      });

      it("says why a page could not be fetched, prints nothing, and tries the same page again next time", async () => {
        const h = open();
        let fail = true;
        Object.assign(h.link, {
          loadOlderTurns: async () => {
            if (fail) throw new Error("offline");
            return {
              snapshotSequence: 3,
              thread: makeThread({ id: "thread-new", messages: talk(1, 12) }),
              page: { beforeCursor: null, hasMore: false, snapshotSequence: 3 },
            };
          },
        });
        h.deliver([loaded(13, 44, true)]);
        const before = h.commits.length;
        say(h, "/history 5");
        await flushMicrotasks();
        expect(h.screen()).toContain("이전 대화를 불러오지 못했습니다: offline");
        expect(h.commits.length).toBe(before);

        fail = false;
        say(h, "/history 5");
        await flushMicrotasks();
        expect(printed(h)).toContain("대화 12");
      });

      it("waits for a running turn to end, since its reply is written into the same scrollback", () => {
        const h = open();
        h.deliver([loaded(1, 40)]);
        h.deliver([
          threadSnapshotItem(
            idle({
              messages: talk(1, 40),
              session: makeSession("running", { threadId: "thread-new", activeTurnId: "turn-1" }),
            }),
            4,
          ),
        ]);
        const before = h.commits.length;
        say(h, "/history");
        expect(h.commits.length).toBe(before);
        expect(h.screen()).toContain("답변이 진행 중입니다");
      });

      it("asks for a count it can read, and has nothing to show on a new thread", () => {
        const h = open();
        h.deliver([loaded(1, 40)]);
        say(h, "/history lots");
        expect(h.screen()).toContain("사용법: /history [개수]");
        say(h, "/new");
        say(h, "/history");
        expect(h.screen()).toContain("새 스레드라 이전 대화가 없습니다.");
      });
    });

    it("says nothing when the whole thread was loaded", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3, false)]);
      expect(h.commits.map(stripAnsi).join("\n")).not.toContain("/history");
    });

    it("marks a cost that covers only the loaded part", () => {
      const usage = makeActivity({
        id: "u1",
        kind: "owned-usage",
        payload: {
          v: 1,
          scope: "main-turn",
          source: { driver: "claudeAgent", instanceId: "claudeAgent", runtimeEventId: "e1" },
          costUsd: 0.5,
        },
      });
      const h = open();
      h.deliver([threadSnapshotItem(idle({ activities: [usage] }), 3, true)]);
      expect(h.screen()).toContain("$0.50+");
    });
  });

  describe("the terminal title and the bell", () => {
    it("names the thread, with the mark in front only while a turn runs", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle({ title: "최근 스레드" }), 3)]);
      h.deliver([threadSnapshotItem(working({ title: "최근 스레드" }), 4)]);
      h.deliver([threadSnapshotItem(idle({ title: "최근 스레드" }), 5)]);
      // The empty conversation the folder opened comes first; it already has a title of its own.
      expect(h.titles.at(0)).toBe("OOP · 새 스레드");
      expect(h.titles.slice(-3)).toEqual([
        "OOP · 최근 스레드",
        "◆ OOP · 최근 스레드",
        "OOP · 최근 스레드",
      ]);
    });

    it("sends a title only when it changes", () => {
      const h = open();
      h.deliver([threadSnapshotItem(working(), 3)]);
      const count = h.titles.length;
      h.tickAll();
      h.tickAll();
      expect(h.titles).toHaveLength(count);
    });

    it("cleans the thread's name of control sequences and cuts a long one", () => {
      const h = open();
      h.deliver([
        threadSnapshotItem(idle({ title: `x\u001b]0;evil\u0007y\n${"가".repeat(200)}` }), 3),
      ]);
      const title = h.titles.at(-1) ?? "";
      expect(title).not.toMatch(/\p{Cc}/u);
      expect(stringWidth(title)).toBeLessThan(200);
      expect(title.endsWith("…")).toBe(true);
    });

    it("gives the shell's title back on the way out", () => {
      const h = open();
      h.deliver([threadSnapshotItem(idle(), 3)]);
      h.controller.dispose();
      expect(h.titles.at(-1)).toBe("<restored>");
    });

    it("rings the bell when a turn finishes, only with notify on", () => {
      const on = open({ notify: true });
      on.deliver([threadSnapshotItem(working(), 3)]);
      expect(on.bellCount()).toBe(0);
      on.deliver([threadSnapshotItem(idle(), 4)]);
      expect(on.bellCount()).toBe(1);
      on.deliver([threadSnapshotItem(idle(), 5)]);
      expect(on.bellCount()).toBe(1);

      const off = open({ notify: false });
      off.deliver([threadSnapshotItem(working(), 3)]);
      off.deliver([threadSnapshotItem(idle(), 4)]);
      expect(off.bellCount()).toBe(0);
    });

    it("stays quiet while a queued message is about to go, and rings when the last turn ends", async () => {
      const h = open({ notify: true });
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.typeText("둘째");
      h.press(key("enter"));
      h.deliver([threadSnapshotItem(idle(), 4)]);
      await flushMicrotasks();
      // The turn that ended is followed by the queued one at once; there is nothing to come back for.
      expect(h.bellCount()).toBe(0);
      h.deliver([threadSnapshotItem(working({}, 1), 5)]);
      h.deliver([threadSnapshotItem(idle(), 6)]);
      expect(h.bellCount()).toBe(1);
    });

    it("stays quiet for a turn the user stopped with Esc", async () => {
      const h = open({ notify: true });
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.press(key("escape"));
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(idle(), 4)]);
      expect(h.bellCount()).toBe(0);
      // The next turn is nobody's stop.
      h.deliver([threadSnapshotItem(working({}, 1), 5)]);
      h.deliver([threadSnapshotItem(idle(), 6)]);
      expect(h.bellCount()).toBe(1);
    });

    it("keeps the Esc stop to the thread it was pressed on", async () => {
      const h = open({ notify: true });
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.press(key("escape"));
      await flushMicrotasks();
      h.typeText("/threads");
      h.press(key("enter"));
      h.press(key("down"), key("down"), key("enter"));
      const other = (state: "running" | "completed") =>
        makeThread({
          id: "thread-old",
          session: makeSession(state === "running" ? "running" : "ready", {
            threadId: "thread-old",
            activeTurnId: state === "running" ? "o1" : null,
          }),
          latestTurn: {
            turnId: "o1",
            state,
            requestedAt: T0,
            startedAt: T0,
            completedAt: state === "running" ? null : T0,
            assistantMessageId: null,
          },
        });
      h.deliver([threadSnapshotItem(other("running"), 3)]);
      h.deliver([threadSnapshotItem(other("completed"), 4)]);
      expect(h.bellCount()).toBe(1);
    });

    it("rings once for an approval that arrives, and not again as the thread updates", () => {
      const h = open({ notify: true });
      h.deliver([threadSnapshotItem(working(), 3)]);
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 4)]);
      expect(h.bellCount()).toBe(1);
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 5)]);
      expect(h.bellCount()).toBe(1);
      h.deliver([
        threadSnapshotItem(
          working({ activities: [approvalRequested("r1"), approvalRequested("r2")] }),
          6,
        ),
      ]);
      expect(h.bellCount()).toBe(1);
    });

    it("rings for the next request once the first is answered", () => {
      const h = open({ notify: true });
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 3)]);
      h.deliver([threadSnapshotItem(working(), 4)]);
      h.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r2")] }), 5)]);
      // The first snapshot is the user looking at the thread, not news.
      expect(h.bellCount()).toBe(1);
    });

    it("is quiet for a request that was already waiting when the thread opened, and with notify off", () => {
      const waiting = open({ notify: true });
      waiting.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 3)]);
      expect(waiting.bellCount()).toBe(0);

      const off = open({ notify: false });
      off.deliver([threadSnapshotItem(working(), 3)]);
      off.deliver([threadSnapshotItem(working({ activities: [approvalRequested("r1")] }), 4)]);
      expect(off.bellCount()).toBe(0);
    });
  });

  describe("the thread list", () => {
    it("marks the cursor row, says which thread is running in words, and asks on the rail", () => {
      const shell = makeSnapshot(
        [makeProject()],
        [
          makeThreadShell({
            id: "thread-run",
            title: "돌아가는 중",
            updatedAt: "2026-10-30T08:00:00.000Z",
            session: makeSession("running", { threadId: "thread-run" }),
          }),
          makeThreadShell({
            id: "thread-old",
            title: "오래된 스레드",
            updatedAt: "2026-10-28T09:00:00.000Z",
          }),
        ],
      );
      const h = harness({ shell });
      h.start();
      h.typeText("/threads");
      h.press(key("enter"));
      const lines = h.screen().split("\n");
      expect(lines.some((line) => line.startsWith("◆  스레드를 고르세요"))).toBe(true);
      const running = lines.find((line) => line.includes("돌아가는 중")) ?? "";
      expect(running).toContain("실행 중");
      const old = lines.find((line) => line.includes("오래된 스레드")) ?? "";
      expect(old).not.toContain("실행 중");
      // The filled mark is the cursor alone: a running thread does not borrow it.
      expect(lines.filter((line) => line.includes("●"))).toHaveLength(1);
      expect(lines.find((line) => line.includes("●"))).toContain("새 스레드");
    });
  });
});

describe("the rail", () => {
  const running = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      ...extra,
    });
  const idleThread = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("idle", { threadId: "thread-new" }),
      ...extra,
    });
  const themes: ThemeSwitcher = {
    current: () => createTheme("oop", BUILTIN_THEMES.oop, 0),
    names: () => ["oop", "aurora"],
    select: () => ({ ok: true, message: "", notes: [] }),
  };
  const chat = (options: Options = {}) => {
    const h = harness({ themes, ...options });
    h.openNewest();
    h.deliver([threadSnapshotItem(idleThread(), 3)]);
    return h;
  };
  const lines = (h: ReturnType<typeof harness>) => h.screen().split("\n");

  describe("starting and leaving", () => {
    it("starts the rail only once the server list has arrived, with the connection as a done step", () => {
      const h = harness({ shell: null });
      h.controller.render();
      expect(h.commits).toEqual([]);
      (h.link as { shell: OrchestrationShellSnapshot | null }).shell = defaultShell();
      h.controller.onShell();
      const commits = h.commits.map(stripAnsi);
      expect(commits[0]).toMatch(/^┌ +OOP 터미널/u);
      expect(commits).toContain("◇  서버 연결됨");
    });

    it("leaves what was picked as done steps, closes the setup rail and starts the thread's own", () => {
      const h = harness({ cwd: "/elsewhere" });
      h.start();
      h.press(key("enter"));
      h.press(key("enter"));
      const commits = h.commits.map(stripAnsi);
      expect(commits).toContain("◇  프로젝트");
      expect(commits).toContain("│  내 프로젝트");
      expect(commits).toContain("◇  스레드");
      expect(commits).toContain("│  새 스레드");
      expect(commits.filter((line) => line.startsWith("└"))).toHaveLength(1);
      expect(commits.findLast((line) => line.startsWith("┌"))).toMatch(
        /^┌ +OOP +내 프로젝트 · 새 스레드$/u,
      );
    });

    it("says goodbye on the rail, and only if the rail was ever drawn", () => {
      const never = harness({ shell: null });
      never.controller.farewell(0);
      expect(never.commits).toEqual([]);

      const h = harness();
      h.start();
      h.controller.farewell(0);
      expect(h.commits.map(stripAnsi).at(-1)).toBe("└  다음에 또 봐요");
      const failed = harness();
      failed.start();
      failed.controller.farewell(2);
      expect(failed.commits.map(stripAnsi).at(-1)).toBe("■  종료합니다 (코드 2)");
    });
  });

  describe("the input area", () => {
    it("is the question, the composer on the rail, then the status bar that closes it", () => {
      const h = chat();
      const rows = lines(h);
      expect(rows.at(-5)).toBe("◆  메시지");
      expect(rows.at(-3)).toBe("│  예: hello.ts에 add 함수를 만들어줘 · / 로 명령 보기");
      expect(rows.at(-1)?.startsWith("└  ")).toBe(true);
      expect(rows.some((row) => /^─{3,}/u.test(row))).toBe(false);
    });

    describe("the lines round it", () => {
      /** Columns the line has beside the rail at the harness's width of 61. */
      const RULE = "─".repeat(57);

      it("sit above and below the composer, on the rail, and the slash menu hangs under the lower one", () => {
        const h = chat();
        h.typeText("안녕");
        let rows = lines(h);
        const composer = rows.indexOf("│  안녕");
        expect(rows[composer - 1]).toBe(`│  ${RULE}`);
        expect(rows[composer + 1]).toBe(`│  ${RULE}`);
        expect(rows[composer + 2]?.startsWith("└  ")).toBe(true);
        h.press(ctrl("u"));
        h.typeText("/");
        rows = lines(h);
        const lower = rows.findLastIndex((row) => row === `│  ${RULE}`);
        expect(rows[lower + 1]).toMatch(/^● \/model|^│ {2}● \/model/u);
        expect(rows.at(-1)?.startsWith("└  ")).toBe(true);
      });

      it("grow with the draft and keep the cursor on the typed row", () => {
        const h = chat();
        h.typeText("첫 줄");
        h.press(key("newline"));
        h.typeText("둘째");
        const rows = lines(h);
        const first = rows.indexOf("│  첫 줄");
        expect(rows[first - 1]).toBe(`│  ${RULE}`);
        expect(rows[first + 2]).toBe(`│  ${RULE}`);
        expect(h.frame().cursor).toEqual({ row: first + 1, col: 3 + 4 });
      });

      it("stay through the whole conversation, while a turn runs and after it", () => {
        const h = chat();
        const ruleCount = () => lines(h).filter((row) => row === `│  ${RULE}`).length;
        expect(ruleCount()).toBe(2);
        h.deliver([threadSnapshotItem(running(), 4)]);
        expect(ruleCount()).toBe(2);
        h.deliver([threadSnapshotItem(idleThread(), 5)]);
        expect(ruleCount()).toBe(2);
      });

      it("are drawn in a colour of every built-in theme and follow the rail's state", () => {
        for (const [name, tokens] of Object.entries(BUILTIN_THEMES)) {
          const theme = createTheme(name, tokens, 3);
          const calm = chat({ style: makeStyle(theme) });
          const painted = calm.frame().lines.filter((row) => row.includes("─"));
          expect(painted, name).toHaveLength(2);
          for (const row of painted) expect(row, name).toContain(theme.brandDim("─".repeat(57)));
          const down = chat({ style: makeStyle(theme) });
          (down.link as { status: LinkStatus }).status = {
            phase: "reconnecting",
            attempt: 1,
            retryAt: null,
            detail: null,
          };
          down.controller.onLinkStatus();
          for (const row of down.frame().lines.filter((line) => line.includes("─"))) {
            expect(row, name).toContain(theme.error("─".repeat(57)));
          }
        }
      });

      it("are hyphens in the ascii preset and plain characters without colour", () => {
        const ascii = chat({ symbols: ASCII_SYMBOLS });
        expect(lines(ascii).filter((row) => row === `|  ${"-".repeat(57)}`)).toHaveLength(2);
        expect(ascii.screen()).not.toContain("─");
        const plain = chat({ style: makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 0)) });
        const painted = plain.frame().lines.filter((row) => row.includes("─"));
        expect(painted).toEqual([`│  ${RULE}`, `│  ${RULE}`]);
        for (const row of plain.frame().lines) expect(row).toBe(stripAnsi(row));
      });

      it("fit the terminal at 40 columns", () => {
        const narrow = chat({ columns: 40 });
        for (const row of narrow.frame().lines) {
          expect(stringWidth(row), row).toBeLessThanOrEqual(39);
        }
        expect(lines(narrow).filter((row) => row.includes("─"))).toHaveLength(2);
      });

      it("go as a pair when the screen is too short, never one alone, and never take the composer's place", () => {
        for (const rows of [3, 4, 5, 6, 7, 8, 12]) {
          const h = chat({ rows });
          const shown = lines(h);
          const rules = shown.filter((row) => row.includes("─")).length;
          expect(rules === 0 || rules === 2, `rows ${rows}`).toBe(true);
          expect(shown.length, `rows ${rows}`).toBeLessThanOrEqual(rows);
          expect(shown.at(-1)?.startsWith("└"), `rows ${rows}`).toBe(true);
          expect(h.frame().cursor, `rows ${rows}`).not.toBeNull();
        }
      });
    });

    it("puts the terminal cursor after the typed text, past the rail, in columns not characters", () => {
      const h = chat();
      h.typeText("안녕a");
      const cursor = h.frame().cursor;
      expect(cursor).toEqual({ row: lines(h).findIndex((row) => row === "│  안녕a"), col: 3 + 5 });
    });

    it("keeps a multi-line draft on the rail, row by row, with the cursor on the last", () => {
      const h = chat();
      h.typeText("첫 줄");
      h.press(key("newline"));
      h.typeText("둘째");
      const rows = lines(h);
      const first = rows.indexOf("│  첫 줄");
      expect(first).toBeGreaterThan(-1);
      expect(rows[first + 1]).toBe("│  둘째");
      expect(h.frame().cursor).toEqual({ row: first + 1, col: 3 + 4 });
    });

    it("turns the rail's colour with the state: accent, error when the link is down, dim in a turn", () => {
      const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
      const style = makeStyle(theme);
      const barOf = (h: ReturnType<typeof harness>) =>
        h.frame().lines.find((row) => stripAnsi(row).startsWith("│")) ?? "";
      const calm = chat({ style });
      expect(barOf(calm)).toContain(theme.accent("│"));
      const working = chat({ style });
      working.deliver([threadSnapshotItem(running(), 4)]);
      expect(barOf(working)).toContain(theme.dim("│"));
      const down = chat({ style });
      (down.link as { status: LinkStatus }).status = {
        phase: "reconnecting",
        attempt: 1,
        retryAt: null,
        detail: null,
      };
      down.controller.onLinkStatus();
      expect(barOf(down)).toContain(theme.error("│"));
    });

    it("keeps the composer row but leaves the example out while a turn runs", () => {
      const h = chat();
      expect(lines(h).at(-3)).toContain("예: ");
      h.deliver([threadSnapshotItem(running(), 4)]);
      const rows = lines(h);
      expect(h.screen()).not.toContain("예: ");
      expect(rows.at(-3)).toBe("│");
      expect(rows.at(-1)?.startsWith("└")).toBe(true);
      expect(h.frame().cursor).toEqual({ row: rows.length - 3, col: 3 });
      h.deliver([threadSnapshotItem(idleThread(), 5)]);
      expect(lines(h).at(-3)).toContain("예: ");
    });

    it("never draws a row wider than the terminal at 40, 80 and 120 columns", () => {
      for (const columns of [40, 80, 120]) {
        const h = chat({ columns });
        h.typeText("한국어로 길게 쓴 메시지 ".repeat(12));
        h.press(text("/"));
        for (const row of lines(h)) {
          expect(stringWidth(row), `@ ${columns}: ${row}`).toBeLessThanOrEqual(columns - 1);
        }
      }
    });
  });

  describe("the slash menu", () => {
    const menuRows = (h: ReturnType<typeof harness>) =>
      lines(h).filter((row) => /^│ {2}[●○] \//u.test(row));

    it("opens on a bare slash with the first six commands, the first one filled", () => {
      const h = chat();
      h.typeText("/");
      const rows = menuRows(h);
      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatch(/^│ {2}● \/model +모델 선택/u);
      expect(rows[1]).toMatch(/^│ {2}○ \/mode +권한 모드/u);
    });

    it("narrows to what the text starts, aliases included", () => {
      const h = chat();
      h.typeText("/th");
      expect(menuRows(h).map((row) => row.match(/\/\w+/u)?.[0])).toEqual(["/threads", "/theme"]);
      const alias = chat();
      alias.typeText("/q");
      expect(menuRows(alias).map((row) => row.match(/\/\w+/u)?.[0])).toEqual(["/exit"]);
    });

    it("moves the filled mark with the arrows and stops at both ends", () => {
      const h = chat();
      h.typeText("/");
      h.press(key("up"));
      expect(menuRows(h)[0]).toContain("●");
      h.press(key("down"), key("down"));
      expect(menuRows(h)[2]).toContain("●");
      for (let i = 0; i < 20; i += 1) h.press(key("down"));
      expect(menuRows(h).filter((row) => row.includes("●"))).toHaveLength(1);
      expect(menuRows(h).at(-1)).toContain("●");
    });

    it("keeps a long list in view around the chosen command", () => {
      const h = chat();
      h.typeText("/");
      // Past the last command the pointer stays on it.
      for (let i = 0; i < 30; i += 1) h.press(key("down"));
      expect(menuRows(h)).toHaveLength(6);
      expect(menuRows(h).at(-1)).toMatch(/● \/exit/u);
    });

    it("completes with Tab and leaves a space only where an argument is expected", () => {
      const h = chat();
      h.typeText("/th");
      h.press(key("tab"));
      expect(lines(h)).toContain("│  /threads");
      const theme = chat();
      theme.typeText("/th");
      theme.press(key("down"), key("tab"));
      expect(lines(theme)).toContain("│  /theme ");
      // A space ends the command word, so the menu is gone and what follows is the argument.
      expect(menuRows(theme)).toEqual([]);
    });

    it("runs the chosen command on Enter, whatever was typed so far", () => {
      const h = chat();
      h.typeText("/proj");
      h.press(key("enter"));
      expect(h.screen()).toContain("프로젝트를 고르세요");
      const second = chat();
      second.typeText("/");
      for (let i = 0; i < 10; i += 1) second.press(key("down"));
      second.press(key("enter"));
      expect(second.screen()).toContain("스레드를 고르세요");
    });

    it("closes on Esc without touching the text, and opens again when the text changes", () => {
      const h = chat();
      h.typeText("/n");
      expect(menuRows(h)).toHaveLength(1);
      h.press(key("escape"));
      expect(menuRows(h)).toEqual([]);
      expect(h.closedCount()).toBe(0);
      expect(lines(h)).toContain("│  /n");
      h.typeText("e");
      expect(menuRows(h)).toHaveLength(1);
    });

    it("says nothing matches; Enter holds a word nothing answers to, with the nearest command", async () => {
      const h = chat();
      h.typeText("/zzz");
      expect(menuRows(h)).toEqual([]);
      expect(h.screen()).toContain("일치하는 명령이 없습니다. 그대로 보내려면 앞에 공백");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("알 수 없는 명령: /zzz");
      expect(h.screen()).toContain("앞에 공백");
    });

    describe("a slash message that no command answers to", () => {
      const withProvider = (over: Record<string, unknown>) =>
        chat({
          config: makeConfig({
            providers: [
              {
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                enabled: true,
                installed: true,
                slashCommands: [{ name: "compact" }],
                skills: [
                  { name: "deploy", path: "/s/deploy", enabled: true },
                  { name: "hidden", path: "/s/hidden", enabled: true, userInvocable: false },
                ],
                models: [
                  {
                    slug: "gpt-5",
                    name: "GPT-5",
                    isCustom: false,
                    isDefault: true,
                    capabilities: null,
                  },
                ],
                ...over,
              },
            ],
          }),
        });
      const secretTypo = "/providers add zai --set apiKey=KEYWORD";

      describe("the slash menu", () => {
        const menuProvider = () =>
          withProvider({
            slashCommands: [
              { name: "compact", description: "대화를 줄입니다" },
              { name: "model", description: "공급자의 모델 명령" },
            ],
            skills: [
              { name: "deploy", path: "/s/deploy", enabled: true, description: "배포하기" },
              { name: "hidden", path: "/s/hidden", enabled: true, userInvocable: false },
            ],
          });

        it("lists the provider's commands and skills after ours, marked as the provider's", () => {
          const h = menuProvider();
          h.typeText("/");
          expect(h.screen()).toContain("/model");
          h.typeText("com");
          expect(h.screen()).toContain("/compact");
          expect(h.screen()).toContain("[provider]");
          expect(h.screen()).toContain("대화를 줄입니다");
          h.press(ctrl("u"));
          h.typeText("/dep");
          expect(h.screen()).toContain("/skill:deploy");
          expect(h.screen()).toContain("[스킬]");
          h.press(ctrl("u"));
          h.typeText("/hid");
          expect(h.screen()).not.toContain("hidden");
        });

        it("lets our command win a name the provider shares, and the menu shows it once", () => {
          const h = menuProvider();
          h.typeText("/model");
          const rows = h
            .screen()
            .split("\n")
            .filter((row) => row.includes("/model"));
          expect(rows).toHaveLength(2); // the typed text and our menu row
          expect(h.screen()).not.toContain("공급자의 모델 명령");
        });

        it("fills the composer with a provider command and sends nothing", async () => {
          const h = menuProvider();
          h.typeText("/comp");
          h.press(key("enter"));
          await flushMicrotasks();
          expect(h.dispatched).toEqual([]);
          h.typeText("now");
          h.press(key("enter"));
          await flushMicrotasks();
          expect(
            h.dispatched.map((c) => (c as { message: { text: string } }).message.text),
          ).toEqual(["/compact now"]);
        });

        it("fills a skill as $name on Tab", async () => {
          const h = menuProvider();
          h.typeText("/dep");
          h.press(key("tab"));
          h.typeText("지금");
          h.press(key("enter"));
          await flushMicrotasks();
          expect(
            h.dispatched.map((c) => (c as { message: { text: string } }).message.text),
          ).toEqual(["$deploy 지금"]);
        });

        it("keeps working and says so when the folder's list has not arrived", () => {
          const h = withProvider({});
          h.typeText("/zzz");
          expect(h.screen()).toContain("불러오는 중");
          h.press(key("escape"));
          h.press(ctrl("u"));
          h.typeText("/mod");
          expect(h.screen()).toContain("/model");
        });

        it("asks the server for nothing as the menu is typed into", async () => {
          const h = menuProvider();
          await flushMicrotasks();
          const asked = h.workspaceRefreshes.length + h.refreshes.length;
          for (const letter of "/comp") h.typeText(letter);
          h.press(key("down"), key("up"));
          expect(h.workspaceRefreshes.length + h.refreshes.length).toBe(asked);
        });
      });

      it("is not sent: the text stays, and the nearest command is named", async () => {
        const h = withProvider({});
        h.typeText(secretTypo);
        h.press(key("enter"));
        await flushMicrotasks();
        expect(h.dispatched).toEqual([]);
        expect(h.screen()).toContain("알 수 없는 명령: /providers");
        expect(h.screen()).toContain("가까운 명령 /provider");
        expect(h.screen()).toContain(secretTypo);
        // The notice names the word only; the rest of the line is never echoed.
        expect(h.screen().split("알 수 없는 명령")[1]?.split("\n")[0]).not.toContain("KEYWORD");
      });

      it("still sends the provider's own commands and user-invocable skills", async () => {
        const h = withProvider({});
        for (const text of ["/compact", "/deploy now", "/COMPACT"]) {
          h.typeText(text);
          h.press(key("enter"));
          await flushMicrotasks();
          h.deliver([threadSnapshotItem(idleThread(), 4 + h.dispatched.length)]);
        }
        expect(h.dispatched.map((c) => (c as { message: { text: string } }).message.text)).toEqual([
          "/compact",
          "/deploy now",
          "/COMPACT",
        ]);
      });

      const said = (h: ReturnType<typeof harness>) => h.screen().replace(/\s+/gu, " ");
      const shipConfig = () =>
        makeConfig({
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
              enabled: true,
              installed: true,
              slashCommands: [{ name: "compact" }],
              skills: [],
              workspaceSnapshots: [
                { cwd: "/work/app", slashCommands: [{ name: "ship" }], skills: [] },
              ],
              models: [
                {
                  slug: "gpt-5",
                  name: "GPT-5",
                  isCustom: false,
                  isDefault: true,
                  capabilities: null,
                },
              ],
            },
          ],
        });

      it("asks the server once for the folder's own commands, and the word that comes with the answer is sent", async () => {
        const h = withProvider({});
        expect(h.workspaceRefreshes).toEqual([{ instanceId: "codex", cwd: "/work/app" }]);
        // Typed before the answer: held, and the notice does not claim the command is wrong.
        h.typeText("/ship now");
        h.press(key("enter"));
        expect(h.dispatched).toEqual([]);
        expect(said(h)).toContain("알 수 없는 명령: /ship");
        expect(said(h)).toContain("프로젝트 명령 목록을 받는 중일 수 있습니다");
        await flushMicrotasks();
        // The server lists the folder and says so on its config stream.
        h.link.config = shipConfig();
        h.controller.onConfig();
        h.press(key("enter"));
        await flushMicrotasks();
        expect(h.dispatched.map((c) => (c as { message: { text: string } }).message.text)).toEqual([
          "/ship now",
        ]);
        // Many draws later, still the one ask.
        expect(h.workspaceRefreshes).toHaveLength(1);
      });

      it("does not ask when the folder is already listed, and stops saying 'maybe late' once it is answered", async () => {
        const listed = chat({ config: shipConfig() });
        expect(listed.workspaceRefreshes).toEqual([]);

        const h = withProvider({});
        await flushMicrotasks();
        h.typeText("/nope");
        h.press(key("enter"));
        expect(said(h)).toContain("알 수 없는 명령: /nope");
        expect(said(h)).not.toContain("받는 중일 수 있습니다");
      });

      it("tries again after a failure, no sooner than a pause, and says the list may be short meanwhile", async () => {
        const h = withProvider({});
        const failing = chat({ workspaceRefreshError: true, config: makeConfig() });
        await flushMicrotasks();
        expect(failing.workspaceRefreshes).toHaveLength(1);
        failing.typeText("/nope");
        failing.press(key("enter"));
        expect(said(failing)).toContain("받는 중일 수 있습니다");
        // Drawing again at once does not ask again.
        failing.controller.render();
        expect(failing.workspaceRefreshes).toHaveLength(1);
        failing.advance(11_000);
        failing.controller.render();
        expect(failing.workspaceRefreshes).toHaveLength(2);
        expect(h.workspaceRefreshes).toHaveLength(1);
      });

      it("holds a skill the provider keeps for the agent", async () => {
        const h = withProvider({});
        h.typeText("/hidden");
        h.press(key("enter"));
        await flushMicrotasks();
        expect(h.dispatched).toEqual([]);
        expect(h.screen()).toContain("알 수 없는 명령: /hidden");
      });

      it("sends a path, and a line with a space in front", async () => {
        const h = withProvider({});
        h.typeText("/Users/foo 봐줘");
        h.press(key("enter"));
        await flushMicrotasks();
        expect(h.dispatched).toHaveLength(1);
        h.deliver([threadSnapshotItem(idleThread(), 4)]);
        h.typeText(" /providers 가 뭐야");
        h.press(key("enter"));
        await flushMicrotasks();
        expect(h.dispatched).toHaveLength(2);
        expect((h.dispatched[1] as { message: { text: string } }).message.text).toBe(
          "/providers 가 뭐야",
        );
      });
    });

    it("is not offered after a space, or for text that does not begin with a slash", () => {
      const h = chat();
      h.typeText("/theme aurora");
      expect(menuRows(h)).toEqual([]);
      expect(h.screen()).not.toContain("일치하는 명령이 없습니다");
      const plain = chat();
      plain.typeText("a/b");
      expect(menuRows(plain)).toEqual([]);
    });

    it("does not take the arrows when there is no menu", () => {
      const h = chat();
      h.typeText("두 줄");
      h.press(key("up"), key("down"));
      expect(lines(h)).toContain("│  두 줄");
      expect(h.dispatched).toEqual([]);
    });

    it("keeps the composer on screen when there is almost no room for the menu", () => {
      for (const columns of [40, 80]) {
        const h = chat({ columns });
        h.typeText("/");
        const rows = lines(h);
        expect(rows.some((row) => row.startsWith("│  /"))).toBe(true);
        expect(rows.at(-1)?.startsWith("└")).toBe(true);
      }
    });
  });

  describe("/help", () => {
    it("is a note on the rail with commands, keys and approvals, and sends nothing", () => {
      const h = chat();
      h.typeText("/help");
      h.press(key("enter"));
      const note = h.commits.map(stripAnsi).join("\n");
      expect(note).toMatch(/◇ {2}도움말 /u);
      for (const command of ["/model", "/threads", "/stats", "/exit"]) {
        expect(note).toContain(command);
      }
      expect(note).toContain("승인");
      expect(h.dispatched).toEqual([]);
    });

    it("draws every row of the note to the same width, at 40, 80 and 120 columns", () => {
      for (const columns of [40, 80, 120]) {
        const h = chat({ columns });
        h.typeText("/help");
        h.press(key("enter"));
        const rows = h.commits.map(stripAnsi);
        const start = rows.findLastIndex((row) => /^◇ {2}도움말 /u.test(row));
        const box = rows.slice(start);
        expect(box.length).toBeGreaterThan(3);
        expect(new Set(box.map((row) => stringWidth(row))).size, `@ ${columns}`).toBe(1);
        expect(Math.max(...box.map((row) => stringWidth(row)))).toBeLessThanOrEqual(columns - 1);
      }
    });
  });

  describe("approvals", () => {
    const asked = (detail = "/bin/zsh -lc 'git status --short'") =>
      running({ activities: [approvalRequested("req-1", detail)] });

    it("shows the command without the shell around it, nothing filled, and the hint", () => {
      const h = chat();
      h.deliver([threadSnapshotItem(asked(), 4)]);
      const screen = h.screen();
      expect(screen).toContain("◆  승인 필요: 명령 실행");
      expect(screen).toContain("git status --short");
      expect(screen).not.toContain("/bin/zsh");
      expect(screen).not.toContain("●");
      expect(screen).toContain("↑/↓ 이동 • 번호");
      expect(h.frame().cursor).toBeNull();
    });

    it("leaves the answer in the scrollback as a done step once it was sent", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(asked(), 4)]);
      h.press(text("2"));
      expect(h.commits).toEqual(expect.not.arrayContaining([expect.stringContaining("승인")]));
      h.press(key("enter"));
      await flushMicrotasks();
      const commits = h.commits.map(stripAnsi);
      const at = commits.indexOf("◇  승인: 명령 실행");
      expect(at).toBeGreaterThan(-1);
      expect(commits[at + 1]).toBe("│  이 세션 동안 허용");
    });

    it("does not repeat the answer as a notice, while it is sent or once the turn is over", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(asked(), 4)]);
      h.press(text("2"), key("enter"));
      expect(h.screen()).not.toContain("응답:");
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(idleThread(), 5)]);
      expect(h.screen()).not.toContain("응답:");
      expect(h.screen()).not.toContain("▲");
    });

    it("says nothing in the scrollback when the answer was refused", async () => {
      const h = chat({
        dispatch: async () => {
          throw new Error("거절");
        },
      });
      h.deliver([threadSnapshotItem(asked(), 4)]);
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi)).not.toContain("◇  승인: 명령 실행");
    });
  });

  describe("questions", () => {
    const asking = (count = 1) =>
      running({
        activities: [
          makeActivity({
            id: "q",
            kind: "user-input.requested",
            payload: {
              requestId: "ask-1",
              questions: Array.from({ length: count }, (_, index) => ({
                id: `q${index}`,
                header: `머리 ${index + 1}`,
                question: `무엇 ${index + 1}?`,
                options: [
                  { label: "가", description: "첫째" },
                  { label: "나", description: "둘째" },
                ],
              })),
            },
          }),
        ],
      });

    it("asks on the rail, with an example in the empty composer and the cursor in it", () => {
      const h = chat();
      h.deliver([threadSnapshotItem(asking(), 4)]);
      const rows = lines(h);
      expect(rows).toContain("◆  질문: 머리 1");
      expect(rows).toContain("│  무엇 1?");
      expect(rows.some((row) => row.startsWith("│  번호나 답을 입력하세요"))).toBe(true);
      expect(h.frame().cursor).not.toBeNull();
    });

    it("leaves each answer as a done step: at once for a middle one, after sending for the last", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(asking(2), 4)]);
      h.typeText("1");
      h.press(key("enter"));
      expect(h.commits.map(stripAnsi)).toContain("◇  질문 (1/2)");
      expect(h.commits.map(stripAnsi)).toContain("│  가");
      expect(h.commits.map(stripAnsi)).not.toContain("◇  질문 (2/2)");
      h.typeText("2");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi)).toContain("◇  질문 (2/2)");
      expect(h.commits.map(stripAnsi)).toContain("│  나");
    });
  });

  describe("stopping a turn", () => {
    it("says so once on the rail however many times it was asked, in the error colour", async () => {
      const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
      const h = chat({ style: makeStyle(theme) });
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.press(key("escape"));
      await flushMicrotasks();
      h.press(key("escape"));
      await flushMicrotasks();
      const stops = h.commits.filter((row) => stripAnsi(row) === "■  작업 중단");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toContain(theme.error("작업 중단"));
    });

    it("says it again for the next turn, and says nothing when a turn ends by itself", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.deliver([threadSnapshotItem(idleThread(), 5)]);
      expect(h.commits.map(stripAnsi)).not.toContain("■  작업 중단");
      h.deliver([threadSnapshotItem(running(), 6)]);
      h.press(key("escape"));
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(idleThread(), 7)]);
      h.deliver([threadSnapshotItem(running(), 8)]);
      h.press(key("escape"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi).filter((row) => row === "■  작업 중단")).toHaveLength(2);
    });

    it("leaves no 'requested' notice behind once the stop was printed", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.press(key("escape"));
      expect(h.screen()).toContain("▲  중단을 요청했습니다…");
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi)).toContain("■  작업 중단");
      expect(h.screen()).not.toContain("중단을 요청했습니다");
      h.deliver([threadSnapshotItem(idleThread(), 5)]);
      expect(h.screen()).not.toContain("▲");
    });

    it("drops the 'requested' notice when the turn ends before the answer comes", async () => {
      const h = chat();
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.press(ctrl("c"));
      expect(h.screen()).toContain("중단을 요청했습니다…");
      h.deliver([threadSnapshotItem(idleThread(), 5)]);
      expect(h.screen()).not.toContain("중단을 요청했습니다");
      await flushMicrotasks();
      expect(h.screen()).not.toContain("▲");
    });

    it("keeps the failure line when the stop could not be sent", async () => {
      const h = chat({
        dispatch: async () => {
          throw new Error("끊겼습니다");
        },
      });
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.press(key("escape"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi)).toContain("▲  중단 요청 실패: 끊겼습니다");
      expect(h.commits.map(stripAnsi)).not.toContain("■  작업 중단");
      expect(h.screen()).not.toContain("중단을 요청했습니다");
    });
  });

  describe("notices", () => {
    it("puts a refused send on a warning row above the rail, one line", async () => {
      const h = chat({
        dispatch: async () => {
          throw new Error("서버가 거절했습니다\n상세");
        },
      });
      h.typeText("보내자");
      h.press(key("enter"));
      await flushMicrotasks();
      const failure = h.commits.map(stripAnsi).find((row) => row.startsWith("▲"));
      expect(failure).toBe("▲  전송 실패: 서버가 거절했습니다");
    });

    it("puts a lost connection on a warning row, and an error one once it is blocked", () => {
      const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
      const h = chat({ style: makeStyle(theme), columns: 81 });
      const notice = () => h.frame().lines.find((line) => stripAnsi(line).startsWith("▲")) ?? "";
      (h.link as { status: LinkStatus }).status = {
        phase: "reconnecting",
        attempt: 1,
        retryAt: null,
        detail: null,
      };
      h.controller.onLinkStatus();
      expect(stripAnsi(notice())).toContain("연결이 끊어졌습니다");
      expect(notice()).toContain(theme.warning("▲"));
      (h.link as { status: LinkStatus }).status = {
        phase: "blocked",
        attempt: 0,
        retryAt: null,
        detail: "토큰이 거절되었습니다",
      };
      h.controller.onLinkStatus();
      expect(notice()).toContain(theme.error("▲"));
    });
  });
});

describe("/stats", () => {
  const done = (id: string, title: string, minute: number, failed = false) =>
    makeActivity({
      id,
      kind: "tool.completed",
      createdAt: new Date(2026, 9, 30, 9, minute).toISOString(),
      payload: { title, ...(failed ? { status: "failed" } : {}) },
    });
  const statsChat = (options: Options = {}) => {
    const h = harness(options);
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("idle", { threadId: "thread-new" }),
          activities: [
            done("a1", "Ran command", 1),
            done("a2", "Ran command", 2, true),
            done("a3", "Edit", 3),
            done("a4", "Read", 4),
          ],
        }),
        3,
      ),
    ]);
    h.typeText("/stats");
    h.press(key("enter"));
    return h;
  };
  const tabOf = (h: ReturnType<typeof harness>) => {
    const row = h.screen().split("\n")[0] ?? "";
    return row;
  };

  it("replaces the chat with the statistics, and closes the rail the chat was drawing", () => {
    const h = statsChat();
    expect(h.screen()).toContain("[1] 개요");
    expect(h.screen()).toContain("Ran command");
    expect(h.screen()).not.toContain("메시지");
    expect(h.frame().cursor).toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it("starts on the overview and moves between tabs with 1, 2, 3 and the left and right arrows", () => {
    const h = statsChat();
    const overview = h.screen();
    h.press(text("2"));
    const hours = h.screen();
    expect(hours).not.toBe(overview);
    h.press(text("3"));
    const tools = h.screen();
    expect(tools).toContain("▶");
    expect(tools).not.toBe(hours);
    // The arrows walk the same three screens and stop at the ends.
    h.press(key("right"));
    expect(h.screen()).toBe(tools);
    h.press(key("left"));
    expect(h.screen()).toBe(hours);
    h.press(key("left"), key("left"));
    expect(h.screen()).toBe(overview);
    expect(tabOf(h)).toContain("[1] 개요");
  });

  it("moves the chosen tool with the arrows on the tools tab, and stops at the first and the last", () => {
    const h = statsChat();
    h.press(text("3"));
    const marked = () =>
      h
        .screen()
        .split("\n")
        .find((row) => row.includes("▶")) ?? "";
    const first = marked();
    h.press(key("up"));
    expect(marked()).toBe(first);
    h.press(key("down"));
    const second = marked();
    expect(second).not.toBe(first);
    for (let i = 0; i < 10; i += 1) h.press(key("down"));
    const last = marked();
    h.press(key("down"));
    expect(marked()).toBe(last);
    expect([first, second, last].some((row) => row.includes("Ran command"))).toBe(true);
  });

  it("closes on q and on Esc, back to the chat with the draft where it was", () => {
    for (const closer of [text("q"), key("escape")]) {
      const h = statsChat();
      h.press(closer);
      expect(h.screen()).toContain("메시지");
      expect(h.screen()).not.toContain("[1] 개요");
      expect(h.closedCount()).toBe(0);
    }
  });

  it("does not send keys to the composer, and redraws on r without leaving", () => {
    const h = statsChat();
    const before = h.screen();
    h.press(text("r"), text("x"), key("enter"));
    expect(h.screen()).toBe(before);
    expect(h.dispatched).toEqual([]);
  });

  it("starts no timer of its own while it is open", () => {
    const h = statsChat();
    expect(h.running()).toEqual([]);
  });

  it("stays open when an approval arrives, and says that one waits", () => {
    const h = statsChat();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
          activities: [approvalRequested("req-1", "rm -rf build")],
        }),
        4,
      ),
    ]);
    expect(h.screen()).toContain("[1] 개요");
    expect(h.screen()).toContain("▲  승인이 기다립니다 · Esc로 닫으면 표시됩니다");
    expect(h.screen()).not.toContain("승인 필요:");
  });

  it("never draws a row wider than the terminal at 40, 80 and 120 columns on any tab", () => {
    for (const columns of [40, 80, 120]) {
      const h = statsChat({ columns });
      for (const tab of ["1", "2", "3"]) {
        h.press(text(tab));
        for (const row of h.screen().split("\n")) {
          expect(stringWidth(row), `@ ${columns} tab ${tab}: ${row}`).toBeLessThanOrEqual(
            columns - 1,
          );
        }
      }
    }
  });
});

describe("a menu, the statistics or a list that is open when a request arrives", () => {
  const running = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
    });
  const waiting = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [approvalRequested("req-1", "rm -rf build")],
    });
  const asking = () =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new" }),
      activities: [
        makeActivity({
          id: "q",
          kind: "user-input.requested",
          payload: {
            requestId: "ask-1",
            questions: [
              {
                id: "db",
                header: "DB",
                question: "무엇을 쓸까요?",
                options: [{ label: "SQLite" }, { label: "Postgres" }],
              },
            ],
          },
        }),
      ],
    });
  const WARNING = "▲  승인이 기다립니다 · Esc로 닫으면 표시됩니다";
  const chat = (options: Options & { rows?: number } = {}) => {
    const h = harness(options);
    h.openNewest();
    h.deliver([threadSnapshotItem(running(), 3)]);
    return h;
  };
  const arrive = (h: ReturnType<typeof harness>) => h.deliver([threadSnapshotItem(waiting(), 4)]);
  const optionRows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /[●○] \d /u.test(row));
  const nothingPicked = (h: ReturnType<typeof harness>) => {
    expect(optionRows(h)).toHaveLength(4);
    expect(optionRows(h).every((row) => row.includes("○"))).toBe(true);
  };
  const answers = (h: ReturnType<typeof harness>) =>
    h.dispatched.filter((command) => command.type === "thread.approval.respond");

  it("keeps the slash menu: ↓ and Enter pick a command, never an answer", async () => {
    const h = chat();
    h.typeText("/");
    arrive(h);
    expect(h.screen()).toContain("/model");
    expect(h.screen()).toContain(WARNING);
    expect(h.screen()).not.toContain("승인 필요:");
    h.press(key("down"));
    expect(h.screen()).toContain("● /mode");
    expect(h.screen()).toContain(WARNING);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });

  it("closes the menu on Esc without stopping the turn, then shows the panel with nothing picked", async () => {
    const h = chat();
    h.typeText("/");
    arrive(h);
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    expect(h.screen()).not.toContain(WARNING);
    nothingPicked(h);
    // What was left in the composer is a draft: the numbers stay locked, as for any typed text.
    expect(h.screen()).toContain("번호 잠김");
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(key("down"), key("enter"));
    await flushMicrotasks();
    expect(answers(h)).toHaveLength(1);
    expect(answers(h)[0]).toMatchObject({ decision: "accept" });
  });

  it("draws no lines round a composer while the panel is what is asked, and brings them back after", () => {
    const h = chat();
    const rule = `│  ${"─".repeat(57)}`;
    arrive(h);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    expect(h.screen().split("\n")).not.toContain(rule);
    h.deliver([threadSnapshotItem(running(), 5)]);
    expect(
      h
        .screen()
        .split("\n")
        .filter((row) => row === rule),
    ).toHaveLength(2);
  });

  it("answers normally once a command from the menu has run and the panel is up", async () => {
    const h = chat();
    h.typeText("/he");
    arrive(h);
    expect(h.screen()).toContain(WARNING);
    h.press(key("enter"));
    expect(h.commits.join("\n")).toContain("도움말");
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    nothingPicked(h);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(text("2"), key("enter"));
    await flushMicrotasks();
    expect(answers(h)).toHaveLength(1);
    expect(answers(h)[0]).toMatchObject({ decision: "acceptForSession" });
  });

  it("keeps /stats: Esc closes it alone, and the panel then waits for a pick", async () => {
    const h = chat();
    h.typeText("/stats");
    h.press(key("enter"));
    arrive(h);
    expect(h.screen()).toContain("[1] 개요");
    expect(h.screen()).toContain(WARNING);
    expect(h.screen()).not.toContain("승인 필요:");
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    expect(h.screen()).not.toContain("[1] 개요");
    nothingPicked(h);
    h.press(text("2"), key("enter"));
    await flushMicrotasks();
    expect(answers(h)[0]).toMatchObject({ decision: "acceptForSession" });
  });

  it("keeps /stats: a tab number changes the tab and picks no answer", async () => {
    const h = chat();
    h.typeText("/stats");
    h.press(key("enter"));
    arrive(h);
    h.press(text("2"));
    expect(h.screen()).toContain(">[2] 시간대<");
    expect(optionRows(h)).toEqual([]);
    h.press(key("enter"), key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(text("q"));
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    nothingPicked(h);
  });

  it("keeps /stats opened from the menu while the request waits behind the menu", async () => {
    const h = chat();
    h.typeText("/sta");
    arrive(h);
    h.press(key("enter"));
    expect(h.screen()).toContain("[1] 개요");
    expect(h.screen()).toContain(WARNING);
    h.press(text("2"), key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    nothingPicked(h);
  });

  it("keeps a /model list: its keys choose a model, and the panel shows when it closes", async () => {
    const h = chat();
    h.typeText("/model");
    h.press(key("enter"));
    arrive(h);
    expect(h.screen()).toContain("모델 선택");
    expect(h.screen()).toContain(WARNING);
    expect(h.screen()).not.toContain("승인 필요:");
    h.press(key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.commits.join("\n")).toContain("Codex / GPT-5 mini");
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    nothingPicked(h);
  });

  it("keeps a list that Esc closes without stopping the turn", async () => {
    const h = chat();
    h.typeText("/model");
    h.press(key("enter"));
    arrive(h);
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("승인 필요: 명령 실행");
    nothingPicked(h);
  });

  it("does the same for a question: the menu is kept and Enter in it answers nothing", async () => {
    const h = chat();
    h.typeText("/zzz");
    h.deliver([threadSnapshotItem(asking(), 4)]);
    expect(h.screen()).toContain("▲  질문이 기다립니다 · Esc로 닫으면 표시됩니다");
    expect(h.screen()).not.toContain("질문: DB");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("질문: DB");
  });

  it("leaves nothing in the way when the request goes away while the overlay is open", async () => {
    const h = chat();
    h.typeText("/stats");
    h.press(key("enter"));
    arrive(h);
    h.deliver([threadSnapshotItem(running(), 5)]);
    expect(h.screen()).not.toContain(WARNING);
    h.press(key("escape"));
    expect(h.screen()).toContain("응답 생성 중");
    expect(h.screen()).not.toContain("승인 필요:");
    expect(h.dispatched).toEqual([]);
  });

  it("draws the warning inside the width on every overlay", () => {
    const columns = 30;
    for (const open of [
      (h: ReturnType<typeof harness>) => h.typeText("/"),
      (h: ReturnType<typeof harness>) => h.press(text("/stats"), key("enter")),
      (h: ReturnType<typeof harness>) => h.press(text("/model"), key("enter")),
    ]) {
      const h = chat({ columns });
      open(h);
      arrive(h);
      expect(h.screen()).toContain("승인이");
      expect(h.frame().lines.length).toBeLessThanOrEqual(24);
      for (const row of h.screen().split("\n")) {
        expect(stringWidth(row), row).toBeLessThanOrEqual(columns - 1);
      }
    }
  });
});

describe("what a screen left behind", () => {
  const stats = (h: ReturnType<typeof harness>) => {
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.press(text("/stats"), key("enter"));
  };

  it("does not let the statistics of a deleted thread cover the next chat", () => {
    const h = harness();
    h.openNewest();
    stats(h);
    expect(h.screen()).toContain("[1] 개요");
    h.deliver([threadDeletedEvent(4, "thread-new")]);
    expect(h.screen()).toContain("스레드를 고르세요");
    h.press(key("enter"));
    expect(h.screen()).not.toContain("[1] 개요");
    h.typeText("안녕");
    expect(h.screen()).toContain("│  안녕");
  });

  it("does not let the statistics survive a thread the server could not open", () => {
    const h = harness();
    h.openNewest();
    stats(h);
    h.controller.onThreadFailed("thread-new" as ThreadId, "Thread thread-new was not found");
    h.press(key("enter"));
    expect(h.screen()).not.toContain("[1] 개요");
    h.typeText("안녕");
    expect(h.screen()).toContain("│  안녕");
  });
});

describe("/model with the model already in use", () => {
  const effort = [{ id: "reasoningEffort", value: "high" }];
  const own = { instanceId: "codex", model: "gpt-5", options: effort };
  const rows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));
  const started = (selection: Record<string, unknown>) => {
    const h = harness({
      shell: makeSnapshot(
        [makeProject()],
        [
          makeThreadShell({
            id: "thread-new",
            title: "t",
            modelSelection: selection,
            latestUserMessageAt: T0,
          }),
        ],
      ),
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new", modelSelection: selection }), 3)]);
    return h;
  };

  it("changes nothing and says nothing when the model in use is picked again", async () => {
    const h = started(own);
    const bar = h.screen().split("\n").at(-1);
    h.typeText("/model");
    h.press(key("enter"));
    const before = h.commits.length;
    h.press(key("enter"));
    expect(h.commits.length).toBe(before);
    expect(h.screen().split("\n").at(-1)).toBe(bar);
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    // The turn names the thread's own selection, reasoning effort included.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ modelSelection: own });
  });

  it("lists a model the server does not know first, marked as in use, and picks it for no change", async () => {
    const h = started({ instanceId: "codex", model: "gpt-9-custom" });
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h)).toEqual([
      "│  ● gpt-9-custom  현재",
      "│  ○ Codex / GPT-5",
      "│  ○ Codex / GPT-5 mini",
    ]);
    const before = h.commits.length;
    h.press(key("enter"));
    expect(h.commits.length).toBe(before);
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({
      modelSelection: { instanceId: "codex", model: "gpt-9-custom" },
    });
  });

  it("still switches to another model", async () => {
    const h = started(own);
    h.typeText("/model");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    expect(h.commits.join("\n")).toContain("Codex / GPT-5 mini");
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({ modelSelection: { model: "gpt-5-mini" } });
  });
});

describe("the statistics and the lists keep the notices", () => {
  const reconnecting: LinkStatus = {
    phase: "reconnecting",
    attempt: 2,
    retryAt: null,
    detail: null,
  };
  const chat = () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    return h;
  };

  it("shows a lost connection on /stats and on a list", () => {
    const h = chat();
    h.press(text("/stats"), key("enter"));
    h.link.status = reconnecting;
    h.controller.onLinkStatus();
    expect(h.screen()).toContain("연결이 끊어졌습니다");
    expect(h.screen()).toContain("[1] 개요");
    h.press(key("escape"), text("/model"), key("enter"));
    expect(h.screen()).toContain("연결이 끊어졌습니다");
    expect(h.screen()).toContain("모델 선택");
  });

  it("tells the first Ctrl-C in a list, and in the statistics", () => {
    const h = chat();
    h.press(text("/model"), key("enter"), ctrl("c"));
    expect(h.screen()).toContain("한 번 더 Ctrl-C");
    expect(h.screen()).toContain("모델 선택");
    h.press(key("escape"), text("/stats"), key("enter"), ctrl("c"));
    expect(h.screen()).toContain("한 번 더 Ctrl-C");
    expect(h.screen()).toContain("[1] 개요");
  });
});

describe("/stats keeps the picked tool by name", () => {
  const done = (id: string, title: string, minute: number) =>
    makeActivity({
      id,
      kind: "tool.completed",
      createdAt: new Date(2026, 9, 30, 9, minute).toISOString(),
      payload: { title },
    });
  const thread = (activities: ReturnType<typeof makeActivity>[]) =>
    makeThread({ id: "thread-new", activities });

  it("stays on the tool when new calls put the list in another order", () => {
    const h = harness();
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        thread([done("a1", "Ran command", 1), done("a2", "Ran command", 2), done("a3", "Edit", 3)]),
        3,
      ),
    ]);
    h.press(text("/stats"), key("enter"), text("3"), key("down"));
    const marked = () =>
      h
        .screen()
        .split("\n")
        .find((row) => row.includes("▶")) ?? "";
    expect(marked()).toContain("Edit");
    // Edit now has the most calls and moves to the top; the pick follows it.
    h.deliver([
      threadSnapshotItem(
        thread([
          done("a1", "Ran command", 1),
          done("a2", "Ran command", 2),
          done("a3", "Edit", 3),
          done("a4", "Edit", 4),
          done("a5", "Edit", 5),
        ]),
        4,
      ),
    ]);
    expect(marked()).toContain("Edit (3)");
    // An arrow goes on from the tool that is picked, not from where it used to be in the list.
    h.press(key("down"));
    expect(marked()).toContain("Ran command");
  });
});

describe("the title of a thread on the rail", () => {
  const shellWith = (projectTitle: string, threadTitle: string) =>
    makeSnapshot(
      [makeProject({ title: projectTitle })],
      [
        makeThreadShell({
          id: "thread-new",
          title: threadTitle,
          updatedAt: "2026-10-30T08:00:00.000Z",
        }),
      ],
    );

  it("cannot start a row of its own with a line feed", () => {
    const h = harness({
      shell: shellWith("프로젝트\n◆  가짜 줄", "제목\n◆  승인 필요: 가짜\r\n└  끝"),
    });
    h.openNewest();
    const rows = h.commits.map(stripAnsi);
    for (const row of rows) expect(row).toMatch(/^(│|┌|◇|└|$)/u);
    expect(rows.join("\n")).toContain("제목 ◆ 승인 필요: 가짜 └ 끝");
    expect(rows.join("\n")).toContain("프로젝트 ◆ 가짜 줄");
  });

  it("folds a long title under the rail instead of onto the first column", () => {
    const columns = 30;
    const h = harness({
      columns,
      shell: shellWith(
        "아주아주 긴 프로젝트 이름입니다",
        "한 줄에 다 들어가지 않을 만큼 길게 이어지는 스레드 제목입니다 정말로 깁니다",
      ),
    });
    h.openNewest();
    const rows = h.commits.map(stripAnsi);
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(stringWidth(row), row).toBeLessThanOrEqual(columns - 1);
      expect(row).toMatch(/^(│|┌|◇|└|$)/u);
    }
    expect(rows.join("\n")).toContain("정말로 깁니다");
  });
});

describe("a list on a narrow terminal", () => {
  it("keeps the connection banner inside the rows it has", () => {
    const threads = Array.from({ length: 40 }, (_, index) =>
      makeThreadShell({
        id: `t-${index}`,
        title: `아주아주 긴 한글 프로젝트 이름입니다 ${index}`,
        updatedAt: "2026-10-20T08:00:00.000Z",
      }),
    );
    for (const columns of [31, 40, 61]) {
      const h = harness({
        columns,
        rows: 23,
        shell: makeSnapshot([makeProject()], threads),
        status: { phase: "reconnecting", attempt: 2, retryAt: null, detail: null },
      });
      h.start();
      const lines = h.frame().lines;
      expect(lines.length, `@ ${columns}`).toBeLessThanOrEqual(23);
      expect(stripAnsi(lines[0] ?? "")).toContain("연결이 끊어졌습니다");
    }
  });
});

describe("an approval taller than the terminal", () => {
  it("cuts the command, never the title or the options", () => {
    const detail = Array.from({ length: 12 }, (_, index) => `step-${index}`).join("\n");
    for (const rows of [24, 14, 12, 10, 9]) {
      const h = harness({ rows });
      h.openNewest();
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "thread-new",
            session: makeSession("running", { threadId: "thread-new" }),
            activities: [approvalRequested("req-1", detail)],
          }),
          3,
        ),
      ]);
      const screen = h.screen();
      expect(h.frame().lines.length, `@ ${rows}`).toBeLessThanOrEqual(rows);
      expect(screen).toContain("승인 필요: 명령 실행");
      expect(screen).toContain("1 허용");
      expect(screen).toContain("4 턴 취소");
      expect(screen).toContain("step-0");
    }
  });
});

describe("a refused approval answer", () => {
  it("clears the pick, so Enter alone cannot send it again", async () => {
    const h = harness();
    h.openNewest();
    const waitingFor = (extra: ReturnType<typeof makeActivity>[]) =>
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [approvalRequested("req-1", "ls"), ...extra],
      });
    h.deliver([threadSnapshotItem(waitingFor([]), 3)]);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    h.deliver([
      threadSnapshotItem(
        waitingFor([
          makeActivity({
            id: "fail",
            kind: "provider.approval.respond.failed",
            tone: "error",
            summary: "응답 실패",
            createdAt: "2026-10-30T09:00:30.000Z",
            payload: { requestId: "req-1", detail: "일시적인 서버 오류" },
          }),
        ]),
        5,
      ),
    ]);
    expect(h.screen()).toContain("다시 시도하세요");
    expect(h.screen()).not.toContain("● 1 허용");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
    h.press(text("1"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(2);
  });
});

describe("a request that changes behind an open menu", () => {
  const ask = (requestId: string) =>
    makeActivity({
      id: `q-${requestId}`,
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [
          {
            id: "db",
            header: "DB",
            question: "무엇을 쓸까요?",
            options: [
              { label: "SQLite", description: "파일" },
              { label: "Postgres", description: "서버" },
            ],
          },
        ],
      },
    });
  const answered = (requestId: string) =>
    makeActivity({
      id: `r-${requestId}`,
      kind: "user-input.resolved",
      payload: { requestId, answers: {} },
    });
  const approvalResolved = (requestId: string) =>
    makeActivity({
      id: `ar-${requestId}`,
      kind: "approval.resolved",
      payload: { requestId },
    });
  const thread = (status: string, activities: ReturnType<typeof makeActivity>[] = []) =>
    makeThread({
      id: "thread-new",
      session: makeSession(status, { threadId: "thread-new" }),
      activities,
    });
  const chat = () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    return h;
  };

  it("keeps the menu when the question goes away: Enter runs the command, not the draft", async () => {
    const h = chat();
    h.typeText("초안");
    h.deliver([threadSnapshotItem(thread("running", [ask("ask-1")]), 4)]);
    h.typeText("/m");
    h.deliver([threadSnapshotItem(thread("ready", [ask("ask-1"), answered("ask-1")]), 5)]);
    expect(h.screen()).toContain("● /model");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("모델 선택");
  });

  it("keeps the menu's Esc for the menu: the turn goes on, and what was written is not lost", async () => {
    const h = chat();
    h.typeText("초안");
    h.deliver([threadSnapshotItem(thread("running", [ask("ask-1")]), 4)]);
    h.typeText("/");
    h.deliver([threadSnapshotItem(thread("running", [ask("ask-1"), answered("ask-1")]), 5)]);
    expect(h.screen()).toContain("● /model");
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("초안");
  });

  it("brings the approval up once the menu is closed; the menu's text goes, the draft stays", async () => {
    const h = chat();
    h.typeText("초안");
    h.deliver([threadSnapshotItem(thread("running", [ask("ask-1")]), 4)]);
    h.typeText("/mo");
    h.deliver([
      threadSnapshotItem(
        thread("running", [ask("ask-1"), answered("ask-1"), approvalRequested("req-1")]),
        5,
      ),
    ]);
    expect(h.screen()).toContain("● /model");
    expect(h.screen()).not.toContain("승인 필요:");
    h.press(key("escape"));
    expect(h.screen()).toContain("승인 필요:");
    expect(h.dispatched).toEqual([]);
    // The numbers are locked while there is a draft; an arrow unlocks them.
    h.press(key("down"), key("enter"));
    await flushMicrotasks();
    expect(h.dispatched.map((command) => command.type)).toEqual(["thread.approval.respond"]);
    h.deliver([
      threadSnapshotItem(
        thread("running", [
          ask("ask-1"),
          answered("ask-1"),
          approvalRequested("req-1"),
          approvalResolved("req-1"),
        ]),
        6,
      ),
    ]);
    expect(h.screen()).toContain("초안");
    expect(h.screen()).not.toContain("/mo");
  });

  it("brings the approval up the moment a delivery confirmation empties the menu's text", async () => {
    let failing = true;
    const sent: ClientOrchestrationCommand[] = [];
    const h = harness({
      dispatch: async (command) => {
        sent.push(command);
        if (command.type === "thread.turn.start" && failing) throw new Error("socket closed");
      },
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
    h.typeText("/usr/bin/env");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.screen()).toContain("/usr/bin/env");
    failing = false;
    const messageId = (sent[0] as { message: { messageId: string } }).message.messageId;
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession("running", { threadId: "thread-new" }),
          messages: [makeMessage({ id: messageId, role: "user", text: "/usr/bin/env" })],
          activities: [approvalRequested("req-1")],
        }),
        4,
      ),
    ]);
    expect(h.screen()).toContain("승인 필요:");
    expect(h.screen()).not.toContain("승인이 기다립니다");
  });

  it("says Esc, not Enter, on a menu with no match while the approval waits", async () => {
    const h = chat();
    h.typeText("/foo");
    h.deliver([threadSnapshotItem(thread("running", [approvalRequested("req-1")]), 4)]);
    expect(h.screen()).toContain("Esc로 닫기");
    expect(h.screen()).not.toContain("메시지로 보내려면 Enter");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });
});

describe("/model back to the thread's own model", () => {
  const effort = [{ id: "reasoningEffort", value: "high" }];
  const own = { instanceId: "codex", model: "gpt-5", options: effort };
  const started = (selection: Record<string, unknown>) => {
    const h = harness({
      shell: makeSnapshot(
        [makeProject()],
        [
          makeThreadShell({
            id: "thread-new",
            title: "t",
            modelSelection: selection,
            latestUserMessageAt: T0,
          }),
        ],
      ),
    });
    h.openNewest();
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new", modelSelection: selection }), 3)]);
    return h;
  };
  const pick = (h: ReturnType<typeof harness>, steps: KeyName[]) => {
    h.typeText("/model");
    h.press(key("enter"));
    h.press(...steps.map(key), key("enter"));
  };
  const rows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));

  it("sends the model with its reasoning effort when it is picked again", async () => {
    const h = started(own);
    pick(h, ["down"]);
    expect(h.screen().split("\n").at(-1)).toContain("GPT-5 mini");
    pick(h, ["up"]);
    expect(h.screen().split("\n").at(-1)).not.toContain("GPT-5 mini");
    // The change back is a change: it is written down like the first one.
    expect(h.commits.filter((record) => record.includes("모델"))).toHaveLength(2);
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({ modelSelection: own });
  });

  it("runs the next turn on the model it went back to, after a turn ran on the other one", async () => {
    const h = started(own);
    pick(h, ["down"]);
    h.typeText("하나");
    h.press(key("enter"));
    await flushMicrotasks();
    // The server does not move the thread's own model with a turn, so the thread still names `own`.
    pick(h, ["up"]);
    h.typeText("둘");
    h.press(key("enter"));
    await flushMicrotasks();
    const turns = h.dispatched.filter((command) => command.type === "thread.turn.start");
    expect(turns[0]).toMatchObject({ modelSelection: { model: "gpt-5-mini" } });
    expect(turns[1]).toMatchObject({ modelSelection: own });
  });

  it("names the thread's own model after leaving the thread and coming back", async () => {
    const h = started(own);
    pick(h, ["down"]);
    h.typeText("하나");
    h.press(key("enter"));
    await flushMicrotasks();
    h.typeText("/threads");
    h.press(key("enter"));
    h.press(key("down"), key("enter"));
    h.deliver([threadSnapshotItem(makeThread({ id: "thread-new", modelSelection: own }), 5)]);
    expect(h.screen().split("\n").at(-1)).toContain("GPT-5");
    h.typeText("둘");
    h.press(key("enter"));
    await flushMicrotasks();
    const turns = h.dispatched.filter((command) => command.type === "thread.turn.start");
    expect(turns[1]).toMatchObject({ modelSelection: own });
  });

  it("names the thread's selection as the server has it now, effort changed elsewhere included", async () => {
    const h = started(own);
    const low = { ...own, options: [{ id: "reasoningEffort", value: "low" }] };
    (h.link as { shell: OrchestrationShellSnapshot | null }).shell = makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({
          id: "thread-new",
          title: "t",
          modelSelection: low,
          latestUserMessageAt: T0,
        }),
      ],
    );
    h.controller.onShell();
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({ modelSelection: low });
  });

  it("keeps the effort on the status bar after going back", () => {
    const h = started(own);
    const bar = h.screen().split("\n").at(-1);
    pick(h, ["down"]);
    pick(h, ["up"]);
    expect(h.screen().split("\n").at(-1)).toBe(bar);
  });

  it("keeps the project's default, effort included, for a new thread that goes back to it", async () => {
    const h = harness({ shell: makeSnapshot([makeProject({ defaultModelSelection: own })], []) });
    h.start();
    h.press(key("enter"));
    pick(h, ["down"]);
    pick(h, ["up"]);
    h.typeText("처음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched[0]).toMatchObject({
      bootstrap: { createThread: { modelSelection: own } },
    });
  });

  it("keeps a model the server does not list in the list after another model was picked", async () => {
    const h = started({ instanceId: "codex", model: "retired-1" });
    pick(h, ["down"]);
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h)[0]).toContain("retired-1");
    h.press(key("up"), key("enter"));
    h.typeText("다음");
    h.press(key("enter"));
    await flushMicrotasks();
    // The thread's own model is sent as it is, though the server no longer lists it.
    expect(h.dispatched[0]).toMatchObject({
      modelSelection: { instanceId: "codex", model: "retired-1" },
    });
  });

  it("keeps the model picked here in the list, as the one in use, when the server stops listing it", () => {
    const h = started(own);
    pick(h, ["down"]);
    (h.link as { config: ServerConfig }).config = makeConfig({
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          models: [
            { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
            { slug: "gpt-5-nano", name: "GPT-5 nano", isCustom: false, capabilities: null },
          ],
        },
      ],
    });
    h.typeText("/model");
    h.press(key("enter"));
    expect(rows(h).filter((row) => row.includes("현재"))).toHaveLength(1);
    expect(rows(h).find((row) => row.includes("현재"))).toContain("GPT-5 mini");
  });
});

describe("a short terminal with a question or a request held back", () => {
  const long = Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join("\n");

  it("cuts the end of a long question, not its header", () => {
    for (const rows of [8, 10, 14]) {
      const h = harness({ rows });
      h.openNewest();
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "thread-new",
            session: makeSession("running", { threadId: "thread-new" }),
            activities: [
              makeActivity({
                id: "q",
                kind: "user-input.requested",
                payload: {
                  requestId: "ask-1",
                  questions: [
                    {
                      id: "q1",
                      header: "큰 질문",
                      question: long,
                      options: [
                        { label: "하나", description: "첫째" },
                        { label: "둘", description: "둘째" },
                      ],
                    },
                  ],
                },
              }),
            ],
          }),
          3,
        ),
      ]);
      const frame = h.frame();
      expect(frame.lines.length, `@ ${rows}`).toBeLessThanOrEqual(rows);
      expect(h.screen()).toContain("질문: 큰 질문");
      expect(h.screen()).toContain("1  하나");
      expect(h.screen()).toMatch(/… \d+줄 더/u);
    }
  });

  it("keeps the warning of a held request on top of a list that is taller than the terminal", () => {
    const models = Array.from({ length: 12 }, (_, index) => ({
      slug: `m${index}`,
      name: `M${index}`,
      isCustom: false,
      capabilities: null,
    }));
    for (const rows of [6, 7, 8, 9, 12]) {
      const h = harness({
        rows,
        config: makeConfig({
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
              enabled: true,
              installed: true,
              models,
            },
          ],
        }),
      });
      h.openNewest();
      h.deliver([threadSnapshotItem(makeThread({ id: "thread-new" }), 3)]);
      h.typeText("/model");
      h.press(key("enter"));
      for (let step = 0; step < 5; step += 1) h.press(key("down"));
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "thread-new",
            session: makeSession("running", { threadId: "thread-new" }),
            activities: [approvalRequested("req-1")],
          }),
          4,
        ),
      ]);
      const lines = h.frame().lines;
      expect(lines.length, `@ ${rows}`).toBeLessThanOrEqual(rows);
      expect(stripAnsi(lines[0] ?? ""), `@ ${rows}`).toContain("승인이 기다립니다");
    }
  });
});

describe("what was typed over a panel that goes away", () => {
  const ask = (requestId: string) =>
    makeActivity({
      id: `q-${requestId}`,
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [
          {
            id: "db",
            header: "DB",
            question: "무엇을 쓸까요?",
            options: [
              { label: "A", description: "" },
              { label: "B", description: "" },
            ],
          },
        ],
      },
    });
  const thread = (activities: ReturnType<typeof makeActivity>[] = []) =>
    makeThread({
      id: "thread-new",
      session: makeSession("ready", { threadId: "thread-new" }),
      activities,
    });
  const chat = () => {
    const h = harness();
    h.openNewest();
    h.deliver([threadSnapshotItem(thread(), 3)]);
    return h;
  };
  const sentTexts = (h: ReturnType<typeof harness>) =>
    h.dispatched.map((command) => (command as { message?: { text: string } }).message?.text);

  it("is the answer, not a draft: Enter after the question went away sends nothing", async () => {
    const h = chat();
    h.deliver([threadSnapshotItem(thread([ask("ask-1")]), 4)]);
    h.press(text("1"));
    h.deliver([threadSnapshotItem(thread(), 5)]);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
  });

  it("goes with the question, and the draft put aside comes back as it was", async () => {
    const h = chat();
    h.typeText("내 초안 전문");
    h.deliver([threadSnapshotItem(thread([ask("ask-1")]), 4)]);
    h.press(text("2"));
    h.deliver([threadSnapshotItem(thread(), 5)]);
    expect(h.screen()).toContain("내 초안 전문");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(sentTexts(h)).toEqual(["내 초안 전문"]);
  });
});

describe("a menu over a long question", () => {
  it("keeps the frame inside the terminal and the question's title on screen", () => {
    const long = Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join("\n");
    for (const rows of [6, 8, 10, 14]) {
      const h = harness({ rows });
      h.openNewest();
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "thread-new",
            session: makeSession("running", { threadId: "thread-new" }),
            activities: [
              makeActivity({
                id: "q",
                kind: "user-input.requested",
                payload: {
                  requestId: "ask-1",
                  questions: [
                    {
                      id: "q1",
                      header: "큰 질문",
                      question: long,
                      options: [
                        { label: "하나", description: "첫째" },
                        { label: "둘", description: "둘째" },
                      ],
                    },
                  ],
                },
              }),
            ],
          }),
          3,
        ),
      ]);
      h.typeText("/");
      expect(h.frame().lines.length, `@ ${rows}`).toBeLessThanOrEqual(rows);
      expect(h.screen(), `@ ${rows}`).toContain("질문: 큰 질문");
    }
  });
});

describe("a panel that is not the request there is", () => {
  const ask = (requestId: string, question = "어느 것?") =>
    makeActivity({
      id: `q-${requestId}`,
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [
          {
            id: "db",
            header: "DB",
            question,
            options: [
              { label: "A", description: "" },
              { label: "B", description: "" },
            ],
          },
        ],
      },
    });
  const thread = (activities: ReturnType<typeof makeActivity>[] = []) =>
    makeThread({
      id: "thread-new",
      session: makeSession("ready", { threadId: "thread-new" }),
      activities,
    });
  const chat = (options: Options = {}) => {
    const h = harness(options);
    h.openNewest();
    h.deliver([threadSnapshotItem(thread(), 2)]);
    return h;
  };
  let sequence = 10;
  const put = (h: ReturnType<typeof harness>, activities: ReturnType<typeof makeActivity>[] = []) =>
    h.deliver([threadSnapshotItem(thread(activities), (sequence += 1))]);

  it("does not send what a menu with no match holds once its question is gone", async () => {
    const h = chat();
    h.typeText("초안");
    put(h, [ask("ask-1")]);
    h.typeText("/tmp/x");
    put(h);
    expect(h.screen()).toContain("일치하는 명령이 없습니다. Esc로 닫기");
    expect(h.screen()).not.toContain("기다립니다");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    // Esc closes the menu; the draft put aside is back and the path is not.
    h.press(key("escape"));
    expect(h.screen()).toContain("초안");
    expect(h.screen()).not.toContain("/tmp/x");
  });

  it("still runs a command the menu matches when its question is gone", async () => {
    const h = chat();
    put(h, [ask("ask-1")]);
    h.typeText("/mod");
    put(h);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    expect(h.screen()).toContain("모델 선택");
  });

  it("gives the words of a failed send back with the draft when the panel closes", async () => {
    let rejectSend: (error: Error) => void = () => {};
    const h = chat({
      dispatch: (command) =>
        command.type === "thread.turn.start"
          ? new Promise<void>((_, reject) => {
              rejectSend = reject;
            })
          : Promise.resolve(),
    });
    h.typeText("중요한 긴 메시지");
    h.press(key("enter"));
    await flushMicrotasks();
    put(h, [ask("ask-1")]);
    rejectSend(new Error("끊김"));
    await flushMicrotasks();
    expect(h.screen()).not.toContain("중요한 긴 메시지");
    put(h);
    expect(h.screen()).toContain("중요한 긴 메시지");
  });

  it("does not bring back a message the thread shows was delivered, though its ack failed", async () => {
    const sent: ClientOrchestrationCommand[] = [];
    let rejectSend: (error: Error) => void = () => {};
    const h = chat({
      dispatch: (command) => {
        sent.push(command);
        if (command.type !== "thread.turn.start") return Promise.resolve();
        return new Promise<void>((_, reject) => {
          rejectSend = reject;
        });
      },
    });
    h.typeText("중요한 긴 메시지");
    h.press(key("enter"));
    await flushMicrotasks();
    const turn = sent[0];
    if (turn?.type !== "thread.turn.start") throw new Error("the turn was not sent");
    const delivered = makeMessage({
      id: turn.message.messageId,
      role: "user",
      text: "중요한 긴 메시지",
    });
    const withMessage = (activities: ReturnType<typeof makeActivity>[] = []) =>
      h.deliver([
        threadSnapshotItem({ ...thread(activities), messages: [delivered] }, (sequence += 1)),
      ]);
    withMessage([ask("ask-1")]);
    rejectSend(new Error("끊김"));
    await flushMicrotasks();
    withMessage();
    h.press(key("enter"));
    await flushMicrotasks();
    expect(sent.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
  });

  it("drops the answer of a failed reply once its question is gone or another one is up", async () => {
    for (const next of ["gone", "other"] as const) {
      let rejectReply: (error: Error) => void = () => {};
      const sent: ClientOrchestrationCommand[] = [];
      const h = chat({
        dispatch: (command) => {
          sent.push(command);
          return command.type === "thread.user-input.respond"
            ? new Promise<void>((_, reject) => {
                rejectReply = reject;
              })
            : Promise.resolve();
        },
      });
      put(h, [ask("ask-1")]);
      h.press(text("2"), key("enter"));
      await flushMicrotasks();
      put(h, next === "gone" ? [] : [ask("ask-2", "다른 질문?")]);
      rejectReply(new Error("연결 끊김"));
      await flushMicrotasks();
      h.press(key("enter"));
      await flushMicrotasks();
      // Only the first reply went out: the answer did not come back to be sent again or as a turn.
      expect(
        sent.map((command) => command.type),
        next,
      ).toEqual(["thread.user-input.respond"]);
    }
  });

  it("gives the answer of a failed reply back while its question is still up", async () => {
    let rejectReply: (error: Error) => void = () => {};
    const h = chat({
      dispatch: (command) =>
        command.type === "thread.user-input.respond"
          ? new Promise<void>((_, reject) => {
              rejectReply = reject;
            })
          : Promise.resolve(),
    });
    put(h, [ask("ask-1")]);
    h.typeText("내 답");
    h.press(key("enter"));
    await flushMicrotasks();
    rejectReply(new Error("연결 끊김"));
    await flushMicrotasks();
    expect(h.screen()).toContain("│  내 답");
  });
});

describe("permission mode, plan mode, effort and goals", () => {
  const TURN = "turn-1";
  const running = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("running", { threadId: "thread-new", activeTurnId: TURN }),
      latestTurn: {
        turnId: TURN,
        state: "running",
        requestedAt: T0,
        startedAt: T0,
        completedAt: null,
        assistantMessageId: null,
      },
      ...extra,
    });
  const idle = (extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      session: makeSession("idle", { threadId: "thread-new" }),
      ...extra,
    });

  const effortOptions = (
    values: string[],
    defaultValue: string,
    extra: Record<string, unknown> = {},
  ) => ({
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: values.map((value) => ({
          id: value,
          label: value,
          ...(value === defaultValue ? { isDefault: true } : {}),
        })),
        ...extra,
      },
    ],
  });
  const provider = (
    instanceId: string,
    driver: string,
    displayName: string,
    models: Array<Record<string, unknown>>,
    over: Record<string, unknown> = {},
  ) => ({ instanceId, driver, displayName, enabled: true, installed: true, models, ...over });
  const model = (slug: string, name: string, capabilities: unknown = null, over = {}) => ({
    slug,
    name,
    isCustom: false,
    capabilities,
    ...over,
  });
  const richConfig = (codexOver: Record<string, unknown> = {}) =>
    makeConfig({
      providers: [
        provider(
          "codex",
          "codex",
          "Codex",
          [
            model("gpt-5", "GPT-5", effortOptions(["low", "medium", "high"], "medium"), {
              isDefault: true,
            }),
            model("gpt-5-mini", "GPT-5 mini"),
          ],
          codexOver,
        ),
        provider("claude", "claudeAgent", "Claude", [
          model(
            "opus",
            "Claude Opus",
            effortOptions(["low", "high", "ultrathink"], "high", {
              promptInjectedValues: ["ultrathink"],
            }),
          ),
          model("sonnet", "Claude Sonnet", effortOptions(["low", "high"], "high")),
        ]),
        provider("anti", "antigravity", "Antigravity", [model("pro-high", "Pro High")]),
      ],
    });

  const draft = (options: Options = {}) => {
    const h = harness({ columns: 101, ...options });
    h.start();
    h.press(key("enter"));
    return h;
  };
  const existing = (options: Options = {}, thread = idle()) => {
    const h = harness({ columns: 101, ...options });
    h.openNewest();
    h.deliver([threadSnapshotItem(thread, 3)]);
    return h;
  };
  const run = (h: ReturnType<typeof harness>, line: string) => {
    h.typeText(line);
    h.press(key("enter"));
  };
  const barOf = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .find((row) => row.startsWith("└")) ?? "";
  const sent = (h: ReturnType<typeof harness>) =>
    h.dispatched.filter(
      (command): command is Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
  const radioRows = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));

  it("asks for the folder's commands again only when a model pick moves to another provider", async () => {
    const h = existing({ config: richConfig() });
    await flushMicrotasks();
    expect(h.workspaceRefreshes).toEqual([{ instanceId: "codex", cwd: "/work/app" }]);
    run(h, "/model");
    run(h, "mini");
    h.press(key("enter"));
    expect(h.workspaceRefreshes).toHaveLength(1);
    run(h, "/model");
    run(h, "opus");
    h.press(key("enter"));
    expect(h.workspaceRefreshes).toEqual([
      { instanceId: "codex", cwd: "/work/app" },
      { instanceId: "claude", cwd: "/work/app" },
    ]);
    run(h, "/model");
    run(h, "gpt-5");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.workspaceRefreshes).toHaveLength(2);
  });

  describe("/help", () => {
    it("lists the new commands with how they are written, and the model search", () => {
      const h = existing({ columns: 101 });
      run(h, "/help");
      const note = h.commits.join("\n");
      for (const word of ["/mode", "/effort", "/plan", "/default", "/goal"])
        expect(note).toContain(word);
      expect(note).toContain("[승인 필요|편집 자동 승인|자동|전체 접근]");
      expect(note).toContain("[내용|clear|max 횟수]");
      expect(note).toContain("/model 에서 글자를 치면");
    });
  });

  describe("/mode", () => {
    it("opens a list on the current mode, in Korean with what each does, and marks it", () => {
      const h = existing();
      run(h, "/mode");
      const rows = radioRows(h);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toContain("● 승인 필요");
      expect(rows[0]).toContain("현재");
      expect(
        rows.map((row) => row.match(/승인 필요|편집 자동 승인|자동(?! 승인)|전체 접근/u)?.[0]),
      ).toEqual(["승인 필요", "편집 자동 승인", "자동", "전체 접근"]);
      expect(h.screen()).toContain("명령과 파일 변경 전에 묻습니다");
    });

    it("sends thread.runtime-mode.set at once for an idle thread, and the bar shows the label", async () => {
      const h = existing();
      run(h, "/mode");
      h.press(key("down"), key("down"), key("down"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toMatchObject([
        { type: "thread.runtime-mode.set", threadId: "thread-new", runtimeMode: "full-access" },
      ]);
      expect(h.commits.join("\n")).toContain("권한 모드");
      expect(h.commits.join("\n")).toContain("전체 접근");
      expect(barOf(h)).toContain("전체 접근");
      expect(barOf(h)).not.toContain("승인 필요");
    });

    it("takes a value, an alias or a label without opening anything", async () => {
      const h = existing();
      run(h, "/mode edits");
      await flushMicrotasks();
      expect(radioRows(h)).toEqual([]);
      expect(h.dispatched).toMatchObject([
        { type: "thread.runtime-mode.set", runtimeMode: "auto-accept-edits" },
      ]);
      run(h, "/mode full-access");
      await flushMicrotasks();
      expect(h.dispatched.at(-1)).toMatchObject({ runtimeMode: "full-access" });
      expect(barOf(h)).toContain("전체 접근");
    });

    it("says what is wrong with an unknown word, and when the mode is already set", async () => {
      const h = existing();
      run(h, "/mode yolo");
      expect(h.screen()).toContain(
        "알 수 없는 권한 모드입니다: yolo (approval, edits, auto, full)",
      );
      run(h, "/mode approval");
      expect(h.screen()).toContain("이미 승인 필요 모드입니다");
      expect(h.dispatched).toEqual([]);
    });

    it("keeps what the server shows once it shows it", async () => {
      const h = existing();
      run(h, "/mode auto");
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(idle({ runtimeMode: "auto" }), 4)]);
      expect(barOf(h)).toContain("자동");
      // Nothing is held any more: the next turn sends no second command.
      run(h, "다음");
      await flushMicrotasks();
      expect(h.dispatched.map((command) => command.type)).toEqual([
        "thread.runtime-mode.set",
        "thread.turn.start",
      ]);
    });

    it("is not applied while a turn runs: it is held, said so, shown on the bar, and sent before the next turn", async () => {
      const h = existing({}, running());
      run(h, "/mode full");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.commits.join("\n")).toContain("다음 메시지부터 적용");
      expect(barOf(h)).toContain("전체 접근 (다음 턴)");
      h.deliver([threadSnapshotItem(idle(), 4)]);
      run(h, "이어서 해 줘");
      await flushMicrotasks();
      expect(h.dispatched.map((command) => command.type)).toEqual([
        "thread.runtime-mode.set",
        "thread.turn.start",
      ]);
      expect(h.dispatched[0]).toMatchObject({ runtimeMode: "full-access", threadId: "thread-new" });
      expect(barOf(h)).toContain("전체 접근");
      expect(barOf(h)).not.toContain("다음 턴");
    });

    it("refuses a mode change under a running turn when a goal would continue it by itself", async () => {
      const h = existing(
        {
          settings: {
            threadGoals: {
              "thread-new": {
                id: "g1",
                text: "테스트 통과",
                maxContinues: 5,
                active: true,
                setAt: T0,
              },
            },
          },
        },
        running(),
      );
      run(h, "/mode full");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("자동으로 이어지는 중");
      expect(h.screen()).toContain("/goal clear");
      expect(barOf(h)).not.toContain("다음 턴");
      // Without a goal the same pick is held, as before.
      const plain = existing({}, running());
      run(plain, "/mode full");
      expect(barOf(plain)).toContain("전체 접근 (다음 턴)");
    });

    it("takes a mode written as the help writes it, label with its space", async () => {
      const h = existing();
      run(h, "/mode 편집 자동 승인");
      await flushMicrotasks();
      expect(h.dispatched).toMatchObject([
        { type: "thread.runtime-mode.set", runtimeMode: "auto-accept-edits" },
      ]);
      run(h, "/mode 전체 접근");
      await flushMicrotasks();
      expect(h.dispatched.at(-1)).toMatchObject({ runtimeMode: "full-access" });
      // Words after the label are no mode: said so, and nothing goes to the agent.
      run(h, "/mode 전체 접근 해줘");
      await flushMicrotasks();
      expect(h.dispatched).toHaveLength(2);
      expect(h.screen()).toContain("알 수 없는 권한 모드입니다: 전체 접근 해줘");
    });

    it("keeps a failed send ready to resend when /mode is refused", async () => {
      // A refusal changes nothing, so the resend must still carry the ids the server may have seen.
      const attempts: ClientOrchestrationCommand[] = [];
      const h = existing(
        {
          settings: {
            threadGoals: {
              "thread-new": {
                id: "g1",
                text: "테스트 통과",
                maxContinues: 5,
                active: true,
                setAt: T0,
              },
            },
          },
          dispatch: async (command) => {
            attempts.push(command);
            if (attempts.length === 1) throw new Error("연결이 끊어졌습니다");
          },
        },
        idle(),
      );
      run(h, "다시 해 줘");
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(running(), 4)]);
      h.press(ctrl("u"));
      run(h, "/mode full");
      expect(h.screen()).toContain("자동으로 이어지는 중");
      expect(attempts).toHaveLength(1);
      h.deliver([threadSnapshotItem(idle(), 5)]);
      run(h, "다시 해 줘");
      await flushMicrotasks();
      const turns = attempts.filter((command) => command.type === "thread.turn.start") as Array<
        Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>
      >;
      expect(turns).toHaveLength(2);
      expect(turns[1]?.commandId).toBe(turns[0]?.commandId);
      expect(turns[1]?.message.messageId).toBe(turns[0]?.message.messageId);
    });

    it("shows how to lift a refusal whole on a 40 column terminal, folded on at most three rows", async () => {
      const h = existing(
        {
          columns: 40,
          settings: {
            threadGoals: {
              "thread-new": {
                id: "g1",
                text: "테스트 통과",
                maxContinues: 5,
                active: true,
                setAt: T0,
              },
            },
          },
        },
        running(),
      );
      run(h, "/mode full");
      await flushMicrotasks();
      const rows = h.frame().lines.map(stripAnsi);
      const start = rows.findIndex((row) => row.startsWith("▲") || row.startsWith("!"));
      expect(start).toBeGreaterThanOrEqual(0);
      const noticeRows = rows.slice(start).filter((row, i) => i === 0 || row.startsWith("   "));
      expect(noticeRows.length).toBeGreaterThan(1);
      expect(noticeRows.length).toBeLessThanOrEqual(3);
      expect(noticeRows.join(" ")).toContain("/goal clear 로 해제 후 바꾸세요.");
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(39);
    });

    it("warns that a held mode does not reach the goal's own turns when the goal is set after it", async () => {
      const h = existing({}, running());
      run(h, "/mode full");
      run(h, "/goal 테스트 통과");
      await flushMicrotasks();
      expect(h.screen()).toContain("자동 연속 턴은 그 전까지 지금 모드로 돕니다");
      expect(h.screen()).toContain("권한 모드 예약은 다음 메시지부터입니다");
      expect(barOf(h)).toContain("전체 접근 (다음 메시지)");
    });

    it("forgets a held mode when the thread is left, so it never reaches another thread", async () => {
      const h = existing({}, running());
      run(h, "/mode full");
      run(h, "/threads");
      h.press(key("down"), key("down"), key("enter"));
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "thread-old",
            session: makeSession("idle", { threadId: "thread-old" }),
          }),
          5,
        ),
      ]);
      expect(barOf(h)).toContain("승인 필요");
      run(h, "안녕");
      await flushMicrotasks();
      expect(h.dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
    });

    it("sends nothing for a held mode that is back to the server's value", async () => {
      const h = existing({}, running());
      run(h, "/mode full");
      run(h, "/mode approval");
      expect(h.commits.join("\n")).toContain("예약 취소");
      h.deliver([threadSnapshotItem(idle(), 4)]);
      run(h, "계속");
      await flushMicrotasks();
      expect(h.dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
    });

    it("remembers the pick for a new thread and creates it with that mode", async () => {
      const h = draft();
      run(h, "/mode auto");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(barOf(h)).toContain("자동");
      run(h, "시작");
      await flushMicrotasks();
      const command = sent(h)[0];
      expect(command?.runtimeMode).toBe("auto");
      expect(command?.bootstrap?.createThread?.runtimeMode).toBe("auto");
    });

    it("starts a new thread in the mode of --mode when nothing is picked", async () => {
      const h = draft();
      expect(barOf(h)).toContain("승인 필요");
      run(h, "시작");
      await flushMicrotasks();
      expect(sent(h)[0]?.bootstrap?.createThread?.runtimeMode).toBe("approval-required");
    });

    it("takes the pick back and says why when the server refuses it", async () => {
      const h = existing({
        dispatch: async (command) => {
          if (command.type === "thread.runtime-mode.set") throw new CommandRejectedError("거절됨");
        },
      });
      run(h, "/mode full");
      await flushMicrotasks();
      expect(h.commits.join("\n")).toContain("권한 모드 변경 실패: 거절됨");
      expect(barOf(h)).toContain("승인 필요");
    });

    it("does not send the turn when a held mode is refused, and gives the words back", async () => {
      const h = existing(
        {
          dispatch: async (command) => {
            if (command.type === "thread.runtime-mode.set")
              throw new CommandRejectedError("거절됨");
          },
        },
        running(),
      );
      run(h, "/mode full");
      h.deliver([threadSnapshotItem(idle(), 4)]);
      run(h, "보내기");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("보내기");
    });

    it("works in ASCII, without colour, and at 40 columns", () => {
      const h = existing({ columns: 40, symbols: ASCII_SYMBOLS });
      run(h, "/mode");
      for (const row of h.frame().lines) expect(stringWidth(row)).toBeLessThanOrEqual(39);
      expect(h.screen()).toContain("현재");
    });
  });

  describe("/plan and /default", () => {
    it("switches the thread to plan mode, and back, with thread.interaction-mode.set", async () => {
      const h = existing({ config: richConfig() });
      run(h, "/plan");
      await flushMicrotasks();
      expect(h.dispatched).toMatchObject([
        { type: "thread.interaction-mode.set", threadId: "thread-new", interactionMode: "plan" },
      ]);
      expect(barOf(h)).toContain("계획 모드");
      h.deliver([threadSnapshotItem(idle({ interactionMode: "plan" }), 4)]);
      expect(barOf(h)).toContain("계획 모드");
      run(h, "/default");
      await flushMicrotasks();
      expect(h.dispatched.at(-1)).toMatchObject({ interactionMode: "default" });
      h.deliver([threadSnapshotItem(idle({ interactionMode: "default" }), 5)]);
      expect(barOf(h)).not.toContain("계획 모드");
    });

    it("says so when it is already in that mode", () => {
      const h = existing({ config: richConfig() });
      run(h, "/default");
      expect(h.screen()).toContain("이미 기본 모드입니다");
      expect(h.dispatched).toEqual([]);
    });

    it("only shows a notice when the provider has no plan mode", () => {
      const h = existing({ config: richConfig({ showInteractionModeToggle: false }) });
      run(h, "/plan");
      expect(h.screen()).toContain("이 제공자는 계획 모드를 지원하지 않습니다");
      expect(h.dispatched).toEqual([]);
      expect(barOf(h)).not.toContain("계획 모드");
    });

    it("is a message for the agent when anything follows the word", async () => {
      const h = existing({ config: richConfig() });
      run(h, "/plan the migration");
      await flushMicrotasks();
      expect(sent(h)[0]?.message.text).toBe("/plan the migration");
    });

    it("holds plan mode while a turn runs and creates a new thread in it", async () => {
      const held = existing({ config: richConfig() }, running());
      run(held, "/plan");
      expect(held.dispatched).toEqual([]);
      expect(barOf(held)).toContain("계획 모드 (다음 턴)");
      held.deliver([threadSnapshotItem(idle(), 4)]);
      run(held, "계획 세워 줘");
      await flushMicrotasks();
      expect(held.dispatched.map((command) => command.type)).toEqual([
        "thread.interaction-mode.set",
        "thread.turn.start",
      ]);

      const fresh = draft({ config: richConfig() });
      run(fresh, "/plan");
      run(fresh, "시작");
      await flushMicrotasks();
      expect(sent(fresh)[0]?.interactionMode).toBe("plan");
      expect(sent(fresh)[0]?.bootstrap?.createThread?.interactionMode).toBe("plan");
    });

    describe("/implement", () => {
      const PLAN = "# 로그인 계획\n\n- 해시 칸 추가\n- 핸들러 작성\n";
      const proposed = (over: Record<string, unknown> = {}) => ({
        id: "plan-1",
        turnId: TURN,
        planMarkdown: PLAN,
        createdAt: T0,
        updatedAt: T0,
        implementedAt: null,
        implementationThreadId: null,
        ...over,
      });
      const settled = {
        turnId: TURN,
        state: "completed",
        requestedAt: T0,
        startedAt: T0,
        completedAt: T0,
        assistantMessageId: null,
      };
      const planned = (extra: Record<string, unknown> = {}) =>
        idle({
          interactionMode: "plan",
          latestTurn: settled,
          proposedPlans: [proposed()],
          ...extra,
        });

      it("sends what the desktop Implement button sends: the plan as the message, in the plain mode, naming the plan", async () => {
        const h = existing({ config: richConfig() }, planned());
        run(h, "/implement");
        await flushMicrotasks();
        expect(h.dispatched.map((command) => command.type)).toEqual([
          "thread.interaction-mode.set",
          "thread.turn.start",
        ]);
        expect(h.dispatched[0]).toMatchObject({
          threadId: "thread-new",
          interactionMode: "default",
        });
        const [turn] = sent(h);
        expect(turn?.message.text).toBe(`PLEASE IMPLEMENT THIS PLAN:\n${PLAN.trim()}`);
        expect(turn?.interactionMode).toBe("default");
        expect(turn?.sourceProposedPlan).toEqual({ threadId: "thread-new", planId: "plan-1" });
        expect(turn?.modelSelection).toMatchObject({ instanceId: "codex" });
        expect(barOf(h)).not.toContain("계획 모드");
      });

      it("sends the turn alone when the thread is already in the plain mode", async () => {
        const h = existing({ config: richConfig() }, planned({ interactionMode: "default" }));
        run(h, "/implement");
        await flushMicrotasks();
        expect(h.dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
        expect(sent(h)[0]?.sourceProposedPlan).toEqual({
          threadId: "thread-new",
          planId: "plan-1",
        });
      });

      it("implements the newest plan, even one from an earlier turn", async () => {
        const h = existing(
          { config: richConfig() },
          planned({
            latestTurn: { ...settled, turnId: "turn-2" },
            proposedPlans: [
              proposed({ id: "plan-old", updatedAt: "2026-10-30T08:00:00.000Z", turnId: "turn-0" }),
              proposed({ id: "plan-1", turnId: TURN, planMarkdown: "# 새 계획\n- 하나" }),
            ],
          }),
        );
        run(h, "/implement");
        await flushMicrotasks();
        expect(sent(h)[0]?.sourceProposedPlan?.planId).toBe("plan-1");
        expect(sent(h)[0]?.message.text).toContain("# 새 계획");
      });

      it("says so, and sends nothing, when there is no plan, and says when it was built already", async () => {
        const none = existing({ config: richConfig() }, idle({ interactionMode: "plan" }));
        run(none, "/implement");
        await flushMicrotasks();
        expect(none.dispatched).toEqual([]);
        expect(none.screen()).toContain("구현할 계획이 없습니다");
        const built = existing(
          { config: richConfig() },
          planned({ proposedPlans: [proposed({ implementedAt: T0 })] }),
        );
        run(built, "/implement");
        await flushMicrotasks();
        expect(built.dispatched).toEqual([]);
        expect(built.screen()).toContain("이미 구현한 계획입니다. 다시 하려면 메시지를 보내세요");
        expect(built.screen()).not.toContain("구현할 계획이 없습니다");
      });

      it("waits for the running turn", async () => {
        const busy = existing({ config: richConfig() }, planned({ session: running().session }));
        run(busy, "/implement");
        await flushMicrotasks();
        expect(busy.dispatched).toEqual([]);
        expect(busy.screen()).toContain("작업 중에는 보낼 수 없습니다");
      });

      it("leaves plan mode on the screen, and sends no turn, when the mode change is refused", async () => {
        const attempts: ClientOrchestrationCommand[] = [];
        const h = existing(
          {
            config: richConfig(),
            dispatch: async (command) => {
              attempts.push(command);
              if (command.type === "thread.interaction-mode.set") throw new Error("거부됨");
            },
          },
          planned(),
        );
        run(h, "/implement");
        await flushMicrotasks();
        expect(attempts.map((command) => command.type)).toEqual(["thread.interaction-mode.set"]);
        expect(barOf(h)).toContain("계획 모드");
      });

      it("spends a one-off effort the agent reads in the prompt, as any message does", async () => {
        const claude = { instanceId: "claude", model: "opus" };
        const h = existing(
          {
            config: richConfig(),
            shell: makeSnapshot(
              [makeProject()],
              [makeThreadShell({ id: "thread-new", modelSelection: claude })],
            ),
          },
          planned({ modelSelection: claude }),
        );
        run(h, "/effort ultrathink");
        expect(barOf(h)).toContain("ultrathink");
        run(h, "/implement");
        await flushMicrotasks();
        expect(sent(h)[0]?.message.text).toMatch(/^Ultrathink:/u);
        expect(barOf(h)).not.toContain("ultrathink");
      });

      it("is a command in the menu and the help", () => {
        const h = existing({ config: richConfig() }, planned());
        h.typeText("/impl");
        expect(h.screen()).toContain("/implement");
      });
    });

    const goalOn = {
      threadGoals: {
        "thread-new": { id: "g1", text: "테스트 통과", maxContinues: 5, active: true, setAt: T0 },
      },
    };

    it("refuses to hold plan mode under a running turn when a goal would continue it by itself", async () => {
      // The server starts a goal's own turns from the mode stored on the thread, so a held pick
      // would never reach them.
      const h = existing({ config: richConfig(), settings: goalOn }, running());
      run(h, "/plan");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("자동으로 이어지는 중");
      expect(h.screen()).toContain("/goal clear");
      expect(barOf(h)).not.toContain("다음 턴");
      expect(barOf(h)).not.toContain("계획 모드");
      // Without a goal the same pick is held, as before.
      const plain = existing({ config: richConfig() }, running());
      run(plain, "/plan");
      expect(barOf(plain)).toContain("계획 모드 (다음 턴)");
    });

    it("says the whole of the goal warning on a 40 column terminal, with both picks held", async () => {
      const h = existing({ config: richConfig(), columns: 40 }, running());
      run(h, "/plan");
      run(h, "/mode full");
      run(h, "/goal 테스트 통과");
      await flushMicrotasks();
      const rows = h.frame().lines.map(stripAnsi);
      expect(rows.join(" ").replace(/\s+/gu, " ")).toContain(
        "자동 연속 턴은 그 전까지 지금 모드로 돕니다.",
      );
      expect(rows.some((row) => row.endsWith("~"))).toBe(false);
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(39);
    });

    it("sends the pick at once when the goal's thread is idle: the stored mode is what its turns use", async () => {
      const h = existing({ config: richConfig(), settings: goalOn }, idle());
      run(h, "/plan");
      await flushMicrotasks();
      expect(h.dispatched).toMatchObject([
        { type: "thread.interaction-mode.set", interactionMode: "plan" },
      ]);
    });

    it("calls a pick held before the goal 'next message', not 'next turn', and says so when the goal is saved", async () => {
      const h = existing({ config: richConfig() }, running());
      run(h, "/plan");
      expect(barOf(h)).toContain("계획 모드 (다음 턴)");
      run(h, "/goal 테스트 통과");
      await flushMicrotasks();
      expect(h.screen()).toContain("작업 방식 예약은 다음 메시지부터입니다");
      expect(h.screen()).toContain("자동 연속 턴은 그 전까지 지금 모드로 돕니다");
      expect(barOf(h)).toContain("계획 모드 (다음 메시지)");
      expect(barOf(h)).not.toContain("다음 턴");
    });
  });

  describe("/effort", () => {
    it("lists the values the model gives, starting on the one in use", () => {
      const h = draft({ config: richConfig() });
      expect(barOf(h)).toContain("GPT-5 medium");
      run(h, "/effort");
      const rows = radioRows(h);
      expect(rows.map((row) => row.replace(/^│ {2}[●○] /u, "").split(/\s+/u)[0])).toEqual([
        "low",
        "medium",
        "high",
      ]);
      expect(rows[1]).toContain("● medium");
      expect(rows[1]).toContain("현재");
    });

    it("picks with the list, shows it on the bar, and sends it in the next turn's model options", async () => {
      const h = draft({ config: richConfig() });
      run(h, "/effort");
      h.press(key("down"), key("down"), key("enter"));
      expect(barOf(h)).toContain("GPT-5 high");
      expect(h.commits.join("\n")).toContain("리저닝 강도");
      run(h, "시작");
      await flushMicrotasks();
      const command = sent(h)[0];
      expect(command?.modelSelection).toMatchObject({
        instanceId: "codex",
        model: "gpt-5",
        options: [{ id: "effort", value: "high" }],
      });
      expect(command?.bootstrap?.createThread?.modelSelection).toMatchObject({
        options: [{ id: "effort", value: "high" }],
      });
    });

    it("sends the default explicitly when nothing is picked, so what is shown is what runs", async () => {
      const h = draft({ config: richConfig() });
      run(h, "시작");
      await flushMicrotasks();
      expect(sent(h)[0]?.modelSelection).toMatchObject({
        options: [{ id: "effort", value: "medium" }],
      });
    });

    it("takes a value without opening a list, and refuses one the model does not have", () => {
      const h = draft({ config: richConfig() });
      run(h, "/effort low");
      expect(radioRows(h)).toEqual([]);
      expect(barOf(h)).toContain("GPT-5 low");
      run(h, "/effort max");
      expect(h.screen()).toContain("알 수 없는 강도입니다: max (low, medium, high)");
      expect(barOf(h)).toContain("GPT-5 low");
      run(h, "/effort LOW");
      expect(h.screen()).toContain("이미 low");
    });

    it("explains why a model has no effort, and what Antigravity does instead", () => {
      const h = draft({ config: richConfig() });
      run(h, "/model");
      run(h, "mini");
      h.press(key("enter"));
      run(h, "/effort");
      expect(h.screen()).toContain("이 모델은 리저닝 강도를 바꿀 수 없습니다");
      run(h, "/model");
      run(h, "pro");
      h.press(key("enter"));
      run(h, "/effort");
      expect(h.screen()).toContain("Antigravity는 모델 이름이 곧 강도입니다");
      expect(radioRows(h)).toEqual([]);
    });

    it("keeps ultrathink out of the options: the agent gets it in the prompt, once", async () => {
      const h = draft({ config: richConfig() });
      run(h, "/model");
      run(h, "opus");
      h.press(key("enter"));
      run(h, "/effort ultrathink");
      expect(barOf(h)).toContain("ultrathink");
      run(h, "이 버그를 고쳐 줘");
      await flushMicrotasks();
      const first = sent(h)[0];
      expect(first?.message.text).toMatch(/^Ultrathink:/u);
      expect(first?.message.text).toContain("이 버그를 고쳐 줘");
      expect(first?.modelSelection?.options).toEqual([{ id: "effort", value: "high" }]);
      // The thread title is made from what the user typed.
      expect(first?.bootstrap?.createThread?.title).toBe("이 버그를 고쳐 줘");
      // It belonged to that message only.
      expect(barOf(h)).not.toContain("ultrathink");
      run(h, "다음 일");
      await flushMicrotasks();
      expect(sent(h)[1]?.message.text).toBe("다음 일");
    });

    it("drops a value the new model does not offer, and keeps one it does", () => {
      const h = draft({ config: richConfig() });
      run(h, "/model");
      run(h, "opus");
      h.press(key("enter"));
      run(h, "/effort ultrathink");
      run(h, "/model");
      run(h, "sonnet");
      h.press(key("enter"));
      expect(barOf(h)).toContain("Claude Sonnet high");
      run(h, "/effort low");
      run(h, "/model");
      run(h, "opus");
      h.press(key("enter"));
      expect(barOf(h)).toContain("Claude Opus low");
    });

    it("starts over on another thread, as the model pick does", () => {
      const h = existing({ config: richConfig() });
      run(h, "/effort low");
      expect(barOf(h)).toContain("low");
      run(h, "/threads");
      h.press(key("down"), key("down"), key("enter"));
      expect(barOf(h)).not.toContain("low");
    });

    it("does not resend a failed turn's old command once the effort changed", async () => {
      let fail = true;
      const h = draft({
        config: richConfig(),
        dispatch: async (command) => {
          if (command.type !== "thread.turn.start") return;
          if (fail) throw new Error("끊김");
          h.dispatched.push(command);
        },
      });
      run(h, "시작");
      await flushMicrotasks();
      fail = false;
      h.press(ctrl("u"));
      run(h, "/effort high");
      run(h, "시작");
      await flushMicrotasks();
      expect(sent(h)[0]?.modelSelection).toMatchObject({
        options: [{ id: "effort", value: "high" }],
      });
    });
  });

  describe("/goal", () => {
    const goalOf = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      text: "테스트 통과",
      maxContinues: 5,
      active: true,
      setAt: T0,
      ...over,
    });
    const goalsIn = (h: ReturnType<typeof harness>) =>
      (h.settingsNow() as { threadGoals: Record<string, Record<string, unknown>> }).threadGoals;
    const goalActivity = (
      kind: string,
      id: string,
      goalId: string,
      over: Record<string, unknown> = {},
    ) =>
      makeActivity({
        id,
        kind,
        tone: "info",
        summary: kind,
        payload: { goalId, turnId: `turn-${id}`, ...over },
        createdAt: "2026-10-30T09:05:00.000Z",
      });
    const withGoal = (over: Record<string, unknown> = {}, options: Options = {}) =>
      existing({ settings: { threadGoals: { "thread-new": goalOf("g1", over) } }, ...options });

    describe("a goal set on a draft", () => {
      const draftWithGoal = async () => {
        const h = harness();
        h.start();
        h.press(key("enter"));
        run(h, "/goal 테스트 통과");
        await flushMicrotasks();
        return h;
      };

      it("is still the draft's goal after /threads and q: the same id comes back", async () => {
        const h = await draftWithGoal();
        const ids = Object.keys(goalsIn(h));
        expect(ids).toHaveLength(1);
        run(h, "/threads");
        h.press(key("escape"), key("escape"));
        await flushMicrotasks();
        expect(h.screen()).toContain("목표");
        expect(Object.keys(goalsIn(h))).toEqual(ids);
        // Still one entry, and it is the one the screen shows.
        expect(h.screen()).toContain("목표 0/5");
      });

      it("is removed when the draft is left for another thread, and kept when it comes back", async () => {
        const h = await draftWithGoal();
        run(h, "/threads");
        h.press(key("down"), key("enter"));
        await flushMicrotasks();
        expect(goalsIn(h)).toEqual({});
      });
    });

    it("asks for the goal when there is none, saves it whole, and says so", async () => {
      const h = existing();
      run(h, "/goal");
      expect(h.screen()).toContain("목표");
      h.press(text("테스트 통과 시키기"));
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.patches).toHaveLength(1);
      expect(Object.keys(h.patches[0] ?? {})).toEqual(["threadGoals"]);
      expect(goalsIn(h)["thread-new"]).toMatchObject({
        text: "테스트 통과 시키기",
        maxContinues: 5,
        active: true,
        setAt: T0,
      });
      expect(typeof goalsIn(h)["thread-new"]?.id).toBe("string");
      expect(h.commits.join("\n")).toContain("테스트 통과 시키기");
      expect(barOf(h)).toContain("목표 0/5");
      expect(h.screen()).not.toContain("Enter 저장");
    });

    it("sets the goal from the line itself, and a new save is a new goal", async () => {
      const h = existing();
      run(h, "/goal 버그 고치기");
      await flushMicrotasks();
      const first = goalsIn(h)["thread-new"];
      expect(first).toMatchObject({ text: "버그 고치기", maxContinues: 5 });
      run(h, "/goal 문서 쓰기");
      await flushMicrotasks();
      const second = goalsIn(h)["thread-new"];
      expect(second).toMatchObject({ text: "문서 쓰기" });
      expect(second?.id).not.toBe(first?.id);
    });

    it("keeps the other threads' goals when it saves", async () => {
      const h = existing({ settings: { threadGoals: { other: goalOf("o") } } });
      run(h, "/goal 내 목표");
      await flushMicrotasks();
      expect(Object.keys(goalsIn(h)).toSorted()).toEqual(["other", "thread-new"]);
      expect(goalsIn(h).other).toMatchObject({ id: "o" });
    });

    it("shows the goal and how far it is when there is one", () => {
      const h = withGoal();
      run(h, "/goal");
      const commits = h.commits.join("\n");
      expect(commits).toContain("테스트 통과");
      expect(commits).toContain("진행 중");
      expect(commits).toContain("연속 0/5");
      expect(h.patches).toEqual([]);
    });

    it("changes how many times it continues: a new goal id with the same words", async () => {
      const h = withGoal({ maxContinues: 3 });
      run(h, "/goal max 9");
      await flushMicrotasks();
      expect(goalsIn(h)["thread-new"]).toMatchObject({ text: "테스트 통과", maxContinues: 9 });
      expect(goalsIn(h)["thread-new"]?.id).not.toBe("g1");
      expect(barOf(h)).toContain("목표 0/9");
    });

    it("refuses a count out of range, and says there is no goal to change", async () => {
      const h = withGoal();
      for (const bad of ["0", "21", "abc", ""]) {
        run(h, `/goal max ${bad}`.trim());
        await flushMicrotasks();
      }
      expect(h.screen()).toContain("사용법: /goal max <횟수> (1~20)");
      expect(h.patches).toEqual([]);
      const none = existing();
      run(none, "/goal max 4");
      await flushMicrotasks();
      expect(none.screen()).toContain("설정된 목표가 없습니다");
      expect(none.patches).toEqual([]);
    });

    it("clears at once with no question, and shows what it removed so it can be set again", async () => {
      const h = existing({
        settings: {
          threadGoals: { "thread-new": goalOf("g1", { maxContinues: 9 }), other: goalOf("o") },
        },
      });
      run(h, "/goal clear");
      await flushMicrotasks();
      expect(Object.keys(goalsIn(h))).toEqual(["other"]);
      const commits = h.commits.join("\n");
      expect(commits).toContain("목표 해제");
      expect(commits).toContain("테스트 통과");
      expect(commits).toContain("되돌리려면: /goal 테스트 통과");
      expect(commits).toContain("/goal max 9");
      expect(barOf(h)).not.toContain("목표");
    });

    it("says there is nothing to clear", async () => {
      const h = existing();
      run(h, "/goal clear");
      await flushMicrotasks();
      expect(h.screen()).toContain("설정된 목표가 없습니다");
      expect(h.patches).toEqual([]);
    });

    it("says why the goal was not saved, and leaves the bar alone", async () => {
      const h = existing({ settingsError: "서버가 설정을 거절했습니다\n상세" });
      run(h, "/goal 안 되는 목표");
      await flushMicrotasks();
      expect(h.commits.join("\n")).toContain("목표 저장 실패: 서버가 설정을 거절했습니다");
      expect(h.commits.join("\n")).not.toContain("상세");
      expect(barOf(h)).not.toContain("목표");
    });

    it("sets a goal for a new thread before its first message, under that thread's id", async () => {
      const h = draft();
      run(h, "/goal 처음부터 목표");
      await flushMicrotasks();
      const [threadId] = Object.keys(goalsIn(h));
      expect(threadId).toBeDefined();
      expect(barOf(h)).toContain("목표 0/5");
      run(h, "시작");
      await flushMicrotasks();
      expect(sent(h)[0]?.threadId).toBe(threadId);
    });

    it("counts only this goal's continuations, and shows ? until the thread is loaded", () => {
      const h = harness({
        columns: 101,
        settings: { threadGoals: { "thread-new": goalOf("g1") } },
      });
      h.openNewest();
      expect(barOf(h)).toContain("목표 ?/5");
      h.deliver([
        threadSnapshotItem(
          idle({
            activities: [
              goalActivity("goal.continued", "c1", "g1"),
              goalActivity("goal.continued", "c2", "g1"),
              goalActivity("goal.continued", "c3", "an-older-goal"),
            ],
          }),
          3,
        ),
      ]);
      expect(barOf(h)).toContain("목표 2/5");
    });

    it("says at least when older turns were not loaded, instead of a count it cannot know", () => {
      const h = withGoal();
      h.deliver([
        threadSnapshotItem(
          idle({
            messages: [
              makeMessage({
                id: "m1",
                role: "user",
                text: "나중",
                createdAt: "2026-10-30T10:00:00.000Z",
              }),
            ],
            activities: [
              {
                ...goalActivity("goal.continued", "c1", "g1"),
                createdAt: "2026-10-30T10:01:00.000Z",
              },
            ],
          }),
          4,
          true,
        ),
      ]);
      expect(barOf(h)).toContain("목표 1+/5");
      run(h, "/goal");
      expect(h.commits.join("\n")).toContain("연속 1+/5");
    });

    it("writes the server's verdicts in the scrollback, once, and shows them on the bar", () => {
      const h = withGoal();
      h.deliver([
        threadSnapshotItem(idle({ activities: [goalActivity("goal.met", "m1", "g1")] }), 4),
      ]);
      expect(h.commits.join("\n")).toContain("목표 완료");
      expect(barOf(h)).toContain("목표 완료");
      const blocked = withGoal();
      blocked.deliver([
        threadSnapshotItem(
          idle({
            activities: [goalActivity("goal.blocked", "b1", "g1", { reason: "권한이 없습니다" })],
          }),
          4,
        ),
      ]);
      expect(blocked.commits.join("\n")).toContain("목표 차단: 권한이 없습니다");
      expect(barOf(blocked)).toContain("목표 차단");
      const exhausted = withGoal();
      exhausted.deliver([
        threadSnapshotItem(idle({ activities: [goalActivity("goal.exhausted", "e1", "g1")] }), 4),
      ]);
      expect(exhausted.commits.join("\n")).toContain("목표 중지");
      expect(barOf(exhausted)).toContain("목표 중지");
    });

    it("never sends a verdict: only settings and the turn go out", async () => {
      const h = withGoal();
      run(h, "/goal max 4");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(Object.keys(h.patches[0] ?? {})).toEqual(["threadGoals"]);
    });

    it("leaves without saving on Esc, and wants words before it saves", async () => {
      const h = existing();
      run(h, "/goal");
      h.press(key("enter"));
      expect(h.screen()).toContain("목표 내용을 입력하세요");
      h.press(key("escape"));
      expect(h.screen()).not.toContain("목표 내용을 입력하세요");
      expect(h.screen()).toContain("메시지");
      await flushMicrotasks();
      expect(h.patches).toEqual([]);
    });

    it("keeps every key while an approval arrives: nothing answers it, and Esc closes the question, not the turn", async () => {
      const h = harness({ columns: 101 });
      h.openNewest();
      h.deliver([threadSnapshotItem(running(), 3)]);
      run(h, "/goal");
      h.deliver([
        threadSnapshotItem(
          running({ activities: [approvalRequested("req-1", "rm -rf build")] }),
          4,
        ),
      ]);
      expect(h.screen()).toContain("승인이 기다립니다");
      h.press(text("1"), key("down"), key("tab"));
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("│  1");
      h.press(key("escape"));
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("승인 필요: 명령 실행");
      expect(h.screen()).not.toContain("승인이 기다립니다");
      expect(h.screen()).not.toMatch(/● \d /u);
    });

    it("takes Korean and a paste, and never draws wider than 40 columns", () => {
      const h = existing({ columns: 40 });
      run(h, "/goal");
      h.press(text("한글 목표"));
      h.press({ type: "paste", text: " 가나다".repeat(20) });
      for (const row of h.frame().lines) expect(stringWidth(row)).toBeLessThanOrEqual(39);
      expect(h.screen()).toContain("한글 목표");
    });
  });

  describe("searching in /model", () => {
    const open = (options: Options = {}) => {
      const h = draft({ config: richConfig(), ...options });
      run(h, "/model");
      return h;
    };
    const labels = (h: ReturnType<typeof harness>) =>
      radioRows(h).map((row) =>
        row
          .replace(/^│ {2}[●○] /u, "")
          .replace(/\s+현재.*$/u, "")
          .trim(),
      );

    it("filters while typing, shows the words, and takes them back with Backspace", () => {
      const h = open();
      expect(labels(h)).toHaveLength(5);
      h.press(text("o"), text("p"), text("u"));
      expect(labels(h)).toEqual(["Claude / Claude Opus"]);
      expect(h.screen()).toContain("검색: opu");
      h.press(key("backspace"), key("backspace"), key("backspace"));
      expect(labels(h)).toHaveLength(5);
    });

    it("needs every word, over name, provider and driver", () => {
      const h = open();
      h.press(text("claude sonnet"));
      expect(labels(h)).toEqual(["Claude / Claude Sonnet"]);
      h.press(key("escape"));
      h.press(text("claudeagent"));
      expect(labels(h)).toEqual(["Claude / Claude Opus", "Claude / Claude Sonnet"]);
    });

    it("puts an exact match before a longer one", () => {
      const h = open();
      h.press(text("gpt-5"));
      expect(labels(h)).toEqual(["Codex / GPT-5", "Codex / GPT-5 mini"]);
    });

    it("clears the words on Esc first and closes only when there are none", () => {
      const h = open();
      h.press(text("zzz"));
      expect(labels(h)).toEqual([]);
      expect(h.screen()).toContain("일치하는 모델이 없습니다");
      h.press(key("enter"));
      expect(h.screen()).toContain("모델 선택");
      h.press(key("escape"));
      expect(labels(h)).toHaveLength(5);
      expect(h.screen()).toContain("모델 선택");
      h.press(key("escape"));
      expect(h.screen()).not.toContain("모델 선택");
    });

    it("treats j and k as letters there, and moves with the arrows", () => {
      const h = open();
      h.press(text("j"));
      expect(h.screen()).toContain("검색: j");
      h.press(key("escape"), text("k"));
      expect(h.screen()).toContain("검색: k");
      h.press(key("escape"), key("down"), key("down"));
      expect(radioRows(h)[2]).toContain("●");
    });

    it("keeps the mark on the model in use while searching, and picks from the narrowed list", () => {
      const h = open();
      h.press(text("gpt"));
      expect(radioRows(h)[0]).toContain("현재");
      h.press(key("down"), key("enter"));
      expect(barOf(h)).toContain("GPT-5 mini");
    });

    it("takes Korean text, and a paste, and cuts the words at a limit", () => {
      const h = open({
        config: makeConfig({
          providers: [
            provider("codex", "codex", "코덱스", [
              model("a", "추론 모델"),
              model("b", "빠른 모델"),
            ]),
          ],
        }),
      });
      h.press(text("빠른"));
      expect(labels(h)).toEqual(["코덱스 / 빠른 모델"]);
      h.press(key("backspace"), key("backspace"));
      h.press({ type: "paste", text: "추론\n" });
      expect(labels(h)).toEqual(["코덱스 / 추론 모델"]);
      h.press({ type: "paste", text: "x".repeat(200) });
      expect(h.screen()).toContain(`검색: 추론 ${"x".repeat(57)}`);
      expect(h.screen()).not.toContain("x".repeat(58));
    });

    it("stays open and keeps its words when an approval arrives", () => {
      const h = harness({ columns: 101, config: richConfig() });
      h.openNewest();
      h.deliver([threadSnapshotItem(running(), 3)]);
      run(h, "/model");
      h.press(text("gpt"));
      h.deliver([
        threadSnapshotItem(
          running({ activities: [approvalRequested("req-1", "rm -rf build")] }),
          4,
        ),
      ]);
      expect(h.screen()).toContain("승인이 기다립니다");
      expect(h.screen()).toContain("검색: gpt");
      // Letters still search; none of them answer the approval.
      h.press(text("1"), key("enter"));
      expect(h.dispatched.filter((command) => command.type === "thread.approval.respond")).toEqual(
        [],
      );
    });

    it("never draws wider than the terminal at 40 columns", () => {
      const h = open({ columns: 40, symbols: ASCII_SYMBOLS });
      h.press(text("claude"));
      for (const row of h.frame().lines) expect(stringWidth(row)).toBeLessThanOrEqual(39);
    });
  });
});

describe("the start screen", () => {
  const note = (version: string, date: string, ...highlights: string[]) => ({
    version,
    date,
    highlights: highlights.map((ko) => ({ en: `en ${ko}`, ko })),
  });
  const NEWER: LatestRelease = {
    latest: "0.0.130",
    releases: [
      note("0.0.130", "2026-11-03", "핵심 가", "핵심 나"),
      note("0.0.129", "2026-11-02", "핵심 다"),
      note("0.0.128", "2026-11-01", "핵심 라", "핵심 마", "핵심 바"),
      note("0.0.127", "2026-10-31", "이미 쓰는 버전의 핵심"),
    ],
  };
  const CURRENT: LatestRelease = { latest: "0.0.127", releases: NEWER.releases.slice(3) };
  const rowsOf = (h: ReturnType<typeof harness>) => h.screen().split("\n");
  /** The start screen with the empty conversation the folder's project opens. */
  const draftChat = (options: Options = {}) => {
    const h = harness({ columns: 101, startup: {}, ...options });
    h.start();
    return h;
  };

  describe("the first frame", () => {
    it("is as tall as the terminal, wordmark on top and the loading line at the foot", () => {
      const h = harness({ shell: null, rows: 24, columns: 101, startup: {} });
      h.controller.render();
      const rows = rowsOf(h);
      expect(rows).toHaveLength(24);
      expect(rows.slice(0, 5).join("\n")).toMatch(/[█▄▀]/u);
      expect(rows.slice(0, 5).join("\n")).toContain("v0.0.127");
      expect(rows.at(-1)).toContain("서버에서 프로젝트를 불러오는 중");
      expect(rows.slice(6, -1).every((row) => row === "")).toBe(true);
      expect(h.commits).toEqual([]);
    });

    it("keeps the setup steps out of the scrollback while it is up", () => {
      const h = harness({ startup: {} });
      h.start();
      expect(h.screen()).toContain("메시지");
      expect(h.commits).toEqual([]);
      expect(h.frame().lines).toHaveLength(24);
    });

    it("opens quietly: a title for the empty conversation, no bell, no timer, no scrollback", () => {
      const h = draftChat({ rows: 24, notify: true });
      expect(h.titles).toEqual(["OOP · 새 스레드"]);
      expect(h.bellCount()).toBe(0);
      expect(h.running()).toEqual([]);
      expect(h.commits).toEqual([]);
    });

    it("has no part in an app that was given no start screen", () => {
      const h = harness({ shell: null });
      h.controller.render();
      expect(h.frame().lines).toHaveLength(1);
    });
  });

  describe("the update notice", () => {
    it("is above the project list when no project holds the folder", () => {
      const h = harness({ cwd: "/elsewhere", columns: 101, startup: {} });
      h.controller.onLatestRelease(NEWER);
      h.start();
      const rows = rowsOf(h);
      expect(rows).toHaveLength(24);
      const header = rows.findIndex((row) => row.includes("업데이트 있음: 0.0.127 → 0.0.130"));
      expect(header).toBeGreaterThan(-1);
      expect(header).toBeLessThan(rows.findIndex((row) => row.includes("프로젝트를 고르세요")));
      const text = h.screen();
      expect(text).toContain("0.0.130 2026-11-03");
      expect(text).toContain("핵심 가");
      expect(text).toContain("0.0.128 2026-11-01");
      expect(text).not.toContain("이미 쓰는 버전의 핵심");
      expect(text).toContain("업데이트 방법: 앱 메뉴 '업데이트 확인...'");
    });

    it("fills in where it is when the answer comes late, without making the frame taller", () => {
      const h = harness({ cwd: "/elsewhere", columns: 101, startup: {} });
      h.start();
      expect(h.screen()).not.toContain("업데이트 있음");
      const before = h.frame().lines.length;
      h.controller.onLatestRelease(NEWER);
      expect(h.screen()).toContain("업데이트 있음: 0.0.127 → 0.0.130");
      expect(h.frame().lines).toHaveLength(before);
    });

    it("says only that it is current when the app is the newest, and nothing when the lookup failed", () => {
      const current = harness({ startup: {}, columns: 101 });
      current.controller.onLatestRelease(CURRENT);
      current.start();
      expect(current.screen()).toContain("최신 버전입니다 (0.0.127)");
      expect(current.screen()).not.toContain("업데이트 있음");
      const failed = harness({ startup: {}, columns: 101 });
      failed.controller.onLatestRelease(null);
      failed.start();
      expect(failed.screen()).not.toContain("최신 버전");
      expect(failed.screen()).not.toContain("업데이트 있음");
    });

    it("measures from the app's version, not the terminal's, and warns when the terminal is older", () => {
      const h = harness({
        startup: { version: "0.0.120" },
        columns: 101,
        config: makeConfig({ environment: { serverVersion: "0.0.129" } }),
      });
      h.controller.onLatestRelease(NEWER);
      h.start();
      expect(h.screen()).toContain("업데이트 있음: 0.0.129 → 0.0.130");
      expect(h.screen()).toContain("터미널 앱 0.0.120 이 앱 0.0.129 보다 오래되었습니다");
      expect(h.screen()).toContain("sh apps/oop-tui/install.sh");
    });

    it("falls back to the terminal's version when the server does not say, but waits while connecting", () => {
      const unknown = makeConfig({ environment: { serverVersion: "dev" } });
      const online = harness({ startup: {}, columns: 101, config: unknown });
      online.controller.onLatestRelease(NEWER);
      online.start();
      expect(online.screen()).toContain("업데이트 있음: 0.0.127 → 0.0.130");
      const connecting = harness({
        startup: {},
        columns: 101,
        config: unknown,
        status: { phase: "connecting", attempt: 0, retryAt: null, detail: null },
      });
      connecting.controller.onLatestRelease(NEWER);
      connecting.start();
      expect(connecting.screen()).not.toContain("업데이트 있음");
    });
  });

  describe("on a short or a narrow screen", () => {
    it("keeps the whole input area at every height and gives the notice what is left", () => {
      for (const rows of [7, 8, 11, 12, 24, 40]) {
        const h = draftChat({ rows });
        h.controller.onLatestRelease(NEWER);
        const shown = rowsOf(h);
        expect(shown, `rows ${rows}`).toHaveLength(rows);
        expect(shown.at(-1)?.startsWith("└"), `rows ${rows}`).toBe(true);
        expect(
          shown.filter((row) => row.includes("─")),
          `rows ${rows}`,
        ).toHaveLength(2);
        expect(h.screen(), `rows ${rows}`).toContain("예: hello.ts");
        expect(h.frame().cursor?.row, `rows ${rows}`).toBe(shown.length - 3);
        expect(h.screen(), `rows ${rows}`).toContain("업데이트 있음: 0.0.127 → 0.0.130");
      }
    });

    it("shrinks the wordmark before the notice, and the notice to its headline last", () => {
      const tall = draftChat({ rows: 40 });
      tall.controller.onLatestRelease(NEWER);
      expect(tall.screen()).toMatch(/[█▄▀]/u);
      expect(tall.screen()).toContain("핵심 바");
      const low = draftChat({ rows: 11 });
      low.controller.onLatestRelease(NEWER);
      expect(low.screen()).not.toMatch(/[█▄▀]/u);
      expect(low.screen()).toContain("◆ OOP v0.0.127");
      expect(low.screen()).toContain("릴리스 3개 — /update");
      const tiny = draftChat({ rows: 7 });
      tiny.controller.onLatestRelease(NEWER);
      expect(tiny.screen()).not.toContain("◆ OOP");
      expect(tiny.screen()).not.toContain("업데이트 방법");
    });

    it("ends the notice with the number of releases left out and where to read them", () => {
      const many: LatestRelease = {
        latest: "0.0.134",
        releases: ["0.0.134", "0.0.133", "0.0.132", "0.0.131", "0.0.130", "0.0.129"].map((v) =>
          note(v, "2026-11-03", `핵심 ${v}`),
        ),
      };
      const h = draftChat({ rows: 40 });
      h.controller.onLatestRelease(many);
      expect(h.screen()).toContain("0.0.134 2026-11-03");
      expect(h.screen()).not.toContain("0.0.131 2026-11-03");
      expect(h.screen()).toContain("외 3개 릴리스 — /update");
    });

    it("never draws wider than the terminal at 40 columns, and still shows the input", () => {
      const h = draftChat({ columns: 40, rows: 24 });
      h.controller.onLatestRelease(NEWER);
      for (const row of h.frame().lines) expect(stringWidth(row), row).toBeLessThanOrEqual(39);
      expect(h.screen()).toContain("업데이트 있음");
      expect(h.screen()).toContain("메시지");
      expect(rowsOf(h).at(-1)?.startsWith("└")).toBe(true);
    });

    it("uses plain characters in the ascii preset", () => {
      const h = draftChat({ symbols: ASCII_SYMBOLS, rows: 40 });
      h.controller.onLatestRelease(NEWER);
      expect(h.screen()).not.toMatch(/[█▄▀◆─│└]/u);
      expect(h.screen()).toContain("#");
      expect(h.screen()).toContain("업데이트 있음");
    });

    it("leaves the wordmark out, and only it, when the banner setting is off", () => {
      const h = draftChat({ startup: { banner: false }, rows: 24 });
      h.controller.onLatestRelease(NEWER);
      const shown = rowsOf(h);
      expect(h.screen()).not.toMatch(/[█▄▀]/u);
      expect(h.screen()).not.toContain("OOP 터미널 ");
      expect(shown[0]).toContain("업데이트 있음");
      expect(shown).toHaveLength(24);
      expect(shown.at(-1)?.startsWith("└")).toBe(true);
    });
  });

  describe("with something else on the screen", () => {
    it("keeps the slash menu whole under the composer, and the composer above it", () => {
      for (const rows of [12, 24]) {
        const h = draftChat({ rows });
        h.controller.onLatestRelease(NEWER);
        h.typeText("/");
        const shown = rowsOf(h);
        expect(shown, `rows ${rows}`).toHaveLength(rows);
        expect(shown.at(-1)?.startsWith("└"), `rows ${rows}`).toBe(true);
        expect(
          shown.some((row) => row.includes("/model")),
          `rows ${rows}`,
        ).toBe(true);
        expect(
          shown.some((row) => row === "│  /"),
          `rows ${rows}`,
        ).toBe(true);
        expect(h.frame().cursor?.col, `rows ${rows}`).toBe(4);
      }
    });

    it("keeps a list opened with /model whole, with the home above what is left", () => {
      const h = draftChat({ rows: 24 });
      h.controller.onLatestRelease(NEWER);
      h.typeText("/model");
      h.press(key("enter"));
      const shown = rowsOf(h);
      expect(shown).toHaveLength(24);
      expect(h.screen()).toContain("모델 선택");
      expect(shown.at(-1)).toBe("└");
      expect(h.screen()).toContain("업데이트 있음");
      const low = draftChat({ rows: 8 });
      low.typeText("/model");
      low.press(key("enter"));
      expect(rowsOf(low)).toHaveLength(8);
      expect(low.screen()).toContain("모델 선택");
      expect(rowsOf(low).at(-1)).toBe("└");
    });

    it("keeps the notice about a lost connection above the composer", () => {
      const h = draftChat({ rows: 12 });
      h.controller.onLatestRelease(NEWER);
      (h.link as { status: LinkStatus }).status = {
        phase: "reconnecting",
        attempt: 2,
        retryAt: null,
        detail: null,
      };
      h.controller.onLinkStatus();
      const shown = rowsOf(h);
      expect(shown).toHaveLength(12);
      expect(h.screen()).toContain("연결이 끊어졌습니다");
      expect(h.screen()).toContain("예: hello.ts");
      expect(shown.at(-1)?.startsWith("└")).toBe(true);
    });

    it("keeps the connecting and refused-connection notices on a short screen while the list loads", () => {
      for (const phase of ["connecting", "blocked"] as const) {
        const h = harness({
          shell: null,
          rows: 8,
          columns: 101,
          startup: {},
          status: { phase, attempt: 0, retryAt: null, detail: null },
        });
        h.controller.render();
        const shown = rowsOf(h);
        expect(shown, phase).toHaveLength(8);
        expect(shown.at(-1), phase).toContain(
          phase === "connecting" ? "서버에 연결하는 중" : "연결 거부",
        );
      }
    });

    it("gives a project list at least twelve rows when the terminal has them, and all of a short one", () => {
      const projects = Array.from({ length: 30 }, (_, index) =>
        makeProject({ id: `p-${index}`, title: `프로젝트 ${index}`, workspaceRoot: `/w/${index}` }),
      );
      const tall = harness({
        cwd: "/elsewhere",
        rows: 30,
        columns: 101,
        startup: {},
        shell: makeSnapshot(projects, []),
      });
      tall.controller.onLatestRelease(NEWER);
      tall.start();
      expect(rowsOf(tall)).toHaveLength(30);
      expect(tall.screen()).toContain("업데이트 있음");
      expect(tall.screen().match(/프로젝트 \d+/gu)?.length).toBeGreaterThanOrEqual(5);
      const short = harness({
        cwd: "/elsewhere",
        rows: 10,
        columns: 101,
        startup: {},
        shell: makeSnapshot(projects, []),
      });
      short.controller.onLatestRelease(NEWER);
      short.start();
      expect(rowsOf(short)).toHaveLength(10);
      expect(rowsOf(short).at(-1)).toBe("└");
      expect(short.screen()).toContain("프로젝트를 고르세요");
    });
  });

  describe("when it ends", () => {
    it("is over with the first message: one banner line, then what waited, and no padding after", async () => {
      const h = draftChat({ rows: 24 });
      h.controller.onLatestRelease(NEWER);
      expect(h.commits).toEqual([]);
      h.typeText("안녕");
      h.press(key("enter"));
      await flushMicrotasks();
      const commits = h.commits.map(stripAnsi);
      expect(commits[0]).toBe("◆ OOP v0.0.127");
      expect(commits[1]).toBe("");
      expect(commits[2]).toMatch(/^┌ +OOP 터미널/u);
      expect(commits.findLast((row) => row.startsWith("┌"))).toMatch(/^┌ +OOP +내 프로젝트/u);
      expect(h.screen()).not.toContain("업데이트 있음");
      expect(h.frame().lines.length).toBeLessThan(10);
    });

    it("is over too when the first message is refused, since the refusal is written down; the words stay", async () => {
      const h = draftChat({
        rows: 24,
        dispatch: async () => {
          throw new Error("거절");
        },
      });
      h.controller.onLatestRelease(NEWER);
      h.typeText("안녕");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi)[0]).toBe("◆ OOP v0.0.127");
      expect(h.commits.join("\n")).toContain("전송 실패");
      expect(h.screen()).toContain("안녕");
      expect(h.screen()).not.toContain("업데이트 있음");
    });

    it("is over when an existing thread is opened, and the banner comes before the setup steps", () => {
      const h = harness({ startup: {}, columns: 101 });
      h.controller.onLatestRelease(NEWER);
      h.openNewest();
      const commits = h.commits.map(stripAnsi);
      expect(commits[0]).toBe("◆ OOP v0.0.127");
      expect(commits.indexOf("◇  서버 연결됨")).toBeGreaterThan(0);
      expect(commits.findLast((row) => row.startsWith("┌"))).toMatch(/^┌ +OOP +내 프로젝트 · /u);
      expect(h.screen()).not.toContain("업데이트 있음");
    });

    it("leaves nothing behind for an empty conversation that was set aside for the list", async () => {
      const h = draftChat({ rows: 24 });
      h.typeText("/threads");
      h.press(key("enter"));
      expect(h.commits).toEqual([]);
      h.press(key("escape"), key("escape"));
      expect(h.exitCount()).toBe(0);
      expect(h.screen()).toContain("메시지");
      h.typeText("안녕");
      h.press(key("enter"));
      await flushMicrotasks();
      const commits = h.commits.map(stripAnsi);
      expect(commits.filter((row) => /^┌ +OOP +내 프로젝트/u.test(row))).toHaveLength(1);
      expect(commits.filter((row) => row === "└")).toHaveLength(1);
    });

    it("keeps one header for a fresh empty conversation made with /new while the start screen is up", async () => {
      const h = draftChat({ rows: 24 });
      h.typeText("/new");
      h.press(key("enter"));
      h.typeText("안녕");
      h.press(key("enter"));
      await flushMicrotasks();
      const commits = h.commits.map(stripAnsi);
      expect(commits.filter((row) => /^┌ +OOP +내 프로젝트/u.test(row))).toHaveLength(1);
      expect(commits.filter((row) => row === "└")).toHaveLength(1);
    });

    it("is over at once with --continue", () => {
      const h = harness({ startup: {}, continueLast: true, columns: 101 });
      h.start();
      expect(h.opened).toEqual(["thread-new"]);
      expect(h.commits.map(stripAnsi)[0]).toBe("◆ OOP v0.0.127");
    });

    it("is over when a command writes into the scrollback, as /help does", () => {
      const h = draftChat();
      h.typeText("/help");
      h.press(key("enter"));
      expect(h.commits.map(stripAnsi)[0]).toBe("◆ OOP v0.0.127");
      expect(h.commits.join("\n")).toContain("도움말");
    });

    it("never comes back: /new is a plain empty conversation", async () => {
      const h = draftChat({ rows: 24 });
      h.controller.onLatestRelease(NEWER);
      h.typeText("/help");
      h.press(key("enter"));
      h.typeText("/new");
      h.press(key("enter"));
      h.controller.onLatestRelease(NEWER);
      expect(h.screen()).not.toContain("업데이트 있음");
      expect(h.frame().lines.length).toBeLessThan(10);
      expect(h.commits.filter((row) => stripAnsi(row) === "◆ OOP v0.0.127")).toHaveLength(1);
    });

    it("leaves no banner line behind when the banner setting is off", () => {
      const h = draftChat({ startup: { banner: false } });
      h.typeText("/help");
      h.press(key("enter"));
      expect(h.commits.map(stripAnsi).some((row) => row.includes("◆ OOP v"))).toBe(false);
      expect(h.commits.join("\n")).toContain("도움말");
    });

    it("says goodbye after the banner and the steps when the user leaves from the list", () => {
      const h = harness({ startup: {}, cwd: "/elsewhere" });
      h.start();
      h.controller.dispose();
      h.controller.farewell(0);
      const commits = h.commits.map(stripAnsi);
      expect(commits[0]).toBe("◆ OOP v0.0.127");
      expect(commits.at(-1)).toBe("└  다음에 또 봐요");
    });
  });

  describe("/update", () => {
    it("looks the release up again, lists what is new on the rail, and ends the start screen", async () => {
      const asked: boolean[] = [];
      const h = draftChat({
        startup: {
          checkUpdate: async ({ refresh }) => {
            asked.push(refresh);
            return NEWER;
          },
        },
      });
      h.typeText("/update");
      h.press(key("enter"));
      expect(h.screen()).toContain("업데이트 확인 중…");
      await flushMicrotasks();
      expect(asked).toEqual([true]);
      const note = h.commits.map(stripAnsi).join("\n");
      expect(note).toContain("업데이트 있음: 0.0.127 → 0.0.130");
      expect(note).toContain("0.0.128 (2026-11-01)");
      expect(note).toContain("핵심 바");
      expect(note).toContain("업데이트 방법:");
      expect(h.screen()).not.toContain("업데이트 확인 중…");
    });

    it("says so when the app is the newest, and when the lookup failed", async () => {
      const current = draftChat({ startup: { checkUpdate: async () => CURRENT } });
      current.typeText("/update");
      current.press(key("enter"));
      await flushMicrotasks();
      expect(current.commits.map(stripAnsi).join("\n")).toContain("이미 최신입니다 (0.0.127).");
      const failed = draftChat({ startup: { checkUpdate: async () => null } });
      failed.typeText("/update");
      failed.press(key("enter"));
      await flushMicrotasks();
      expect(failed.commits.map(stripAnsi).join("\n")).toContain("업데이트를 확인하지 못했습니다");
    });

    it("is in the menu only where it can look", () => {
      const withLookup = draftChat();
      withLookup.typeText("/upd");
      expect(withLookup.screen()).toContain("/update");
      const without = harness();
      without.openNewest();
      without.deliver([threadSnapshotItem(idleThreadForUpdate(), 3)]);
      without.typeText("/upd");
      expect(without.screen()).not.toContain("/update");
    });
  });
});

const idleThreadForUpdate = () => makeThread({ id: "thread-new" });

describe("/crew", () => {
  const TURN = "turn-1";
  const LEAD = "thread-new";
  const provider = (
    instanceId: string,
    driver: string,
    displayName: string,
    models: ReadonlyArray<[string, string]>,
  ) => ({
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map(([slug, name], index) => ({
      slug,
      name,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
  });
  const crewConfig = () =>
    makeConfig({
      providers: [
        provider("codex", "codex", "Codex", [
          ["gpt-5", "GPT-5"],
          ["gpt-5-mini", "GPT-5 mini"],
        ]),
        provider("claudeAgent", "claudeAgent", "Claude", [
          ["claude-opus-4", "Opus 4"],
          ["claude-haiku-4", "Haiku 4"],
        ]),
        provider("opencode", "opencode", "OpenCode", [["o-1", "Open One"]]),
      ],
    });
  const haiku = { instanceId: "claudeAgent", model: "claude-haiku-4" };
  const subShell = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id,
    title,
    parentThreadId: LEAD,
    updatedAt: "2026-10-30T07:00:00.000Z",
    ...over,
  });
  const shellOf = (
    subs: ReadonlyArray<Record<string, unknown>> = [],
    lead: Record<string, unknown> = {},
  ) =>
    makeSnapshot(
      [makeProject()],
      [
        makeThreadShell({ id: LEAD, updatedAt: "2026-10-30T08:00:00.000Z", ...lead }),
        ...subs.map((sub) => makeThreadShell(sub)),
      ],
    );
  const taskActivity = (
    id: string,
    kind: "task.started" | "task.completed",
    second: number,
    payload: Record<string, unknown>,
  ) =>
    makeActivity({
      id,
      kind,
      summary: kind,
      turnId: TURN,
      createdAt: `2026-10-30T09:00:${String(second).padStart(2, "0")}.000Z`,
      payload: { agentKind: "agent", ...payload },
    });
  const started = (taskId: string, role: string, title: string, second: number) =>
    taskActivity(`s-${taskId}`, "task.started", second, {
      taskId,
      crewRole: role,
      title,
      threadId: `sub-${taskId}`,
      model: role === "worker" ? "Haiku 4" : "Opus 4",
      status: "running",
    });
  const finished = (
    taskId: string,
    role: string,
    title: string,
    second: number,
    status: string,
    extra: Record<string, unknown> = {},
  ) =>
    taskActivity(`c-${taskId}`, "task.completed", second, {
      taskId,
      crewRole: role,
      title,
      threadId: `sub-${taskId}`,
      model: role === "worker" ? "Haiku 4" : "Opus 4",
      status,
      ...extra,
    });
  const leadThread = (
    activities: ReadonlyArray<ReturnType<typeof makeActivity>> = [],
    running = false,
  ) =>
    makeThread({
      id: LEAD,
      session: makeSession(running ? "running" : "idle", {
        threadId: LEAD,
        activeTurnId: running ? TURN : null,
      }),
      latestTurn: {
        turnId: TURN,
        state: running ? "running" : "completed",
        requestedAt: T0,
        startedAt: T0,
        completedAt: running ? null : T0,
        assistantMessageId: null,
      },
      activities,
    });
  const crewChat = (
    options: Options & {
      activities?: ReadonlyArray<ReturnType<typeof makeActivity>>;
      running?: boolean;
      subs?: ReadonlyArray<Record<string, unknown>>;
      lead?: Record<string, unknown>;
    } = {},
  ) => {
    const { activities, running, subs, lead, ...rest } = options;
    const h = harness({
      columns: 101,
      continueLast: true,
      config: crewConfig(),
      shell: shellOf(subs, lead),
      ...rest,
    });
    h.start();
    h.deliver([threadSnapshotItem(leadThread(activities, running), 3)]);
    return h;
  };
  const run = (h: ReturnType<typeof harness>, line: string) => {
    h.typeText(line);
    h.press(key("enter"));
  };
  const barOf = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .find((row) => /^└ {2}\S/u.test(row)) ?? "";
  const crewIn = (h: ReturnType<typeof harness>) =>
    (h.settingsNow() as { crew: Record<string, unknown> }).crew as {
      enabled: boolean;
      preset: string;
      pinned: Record<string, unknown>;
      threads: Record<
        string,
        { enabled?: boolean; preset?: string; pinned?: Record<string, unknown> }
      >;
    };
  const crewSettings = (over: Record<string, unknown> = {}) => ({
    crew: { enabled: false, preset: "recommended", pinned: {}, threads: {}, ...over },
  });
  const rowsOf = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .split("\n")
      .filter((row) => /^│ {2}[●○] /u.test(row));

  describe("the screen", () => {
    it("shows whether the crew is on, the preset, each role's model and where a change lands", () => {
      const h = crewChat();
      run(h, "/crew");
      const screen = h.screen();
      expect(screen).toContain("◆  Crew");
      expect(rowsOf(h)[0]).toContain("1  Crew  꺼짐");
      expect(rowsOf(h)[0]).toContain("이 스레드");
      expect(screen).toContain("프리셋  OOP 추천");
      expect(screen).toMatch(/Worker {2}Auto · /u);
      expect(screen).toMatch(/Expert {2}Auto · /u);
      expect(screen).toMatch(/Auditor {2}Auto · /u);
      expect(screen).toContain("새 채팅 기본값으로 사용");
      expect(screen).toContain("이 스레드에는 아직 crew 작업이 없습니다.");
      expect(h.patches).toEqual([]);
    });

    it("is in the slash menu and in /help", () => {
      const h = crewChat();
      h.typeText("/cr");
      expect(h.screen()).toContain("/crew");
      h.press(key("escape"), ctrl("u"));
      run(h, "/help");
      const commits = h.commits.map(stripAnsi).join("\n");
      expect(commits).toContain("/crew on|off");
      expect(commits).toContain("/crew back");
    });

    it("moves with the arrows and the digits, and acts only on Enter", async () => {
      const h = crewChat();
      run(h, "/crew");
      h.press(text("2"));
      expect(rowsOf(h).findIndex((row) => row.startsWith("│  ●"))).toBe(1);
      h.press(key("down"));
      expect(rowsOf(h).findIndex((row) => row.startsWith("│  ●"))).toBe(2);
      expect(h.patches).toEqual([]);
      h.press(key("escape"));
      expect(h.screen()).not.toContain("◆  Crew");
      expect(h.patches).toEqual([]);
    });

    it("turns the crew on for this thread alone and keeps every other setting", async () => {
      const h = crewChat({
        settings: crewSettings({
          preset: "speed",
          pinned: { worker: haiku },
          threads: { other: { enabled: true, preset: "quality" } },
        }),
      });
      run(h, "/crew");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.patches).toHaveLength(1);
      expect(Object.keys(h.patches[0] ?? {})).toEqual(["crew"]);
      const crew = crewIn(h);
      expect(crew.enabled).toBe(false);
      expect(crew.preset).toBe("speed");
      expect(crew.pinned).toEqual({ worker: haiku });
      expect(crew.threads.other).toEqual({ enabled: true, preset: "quality" });
      expect(crew.threads[LEAD]).toEqual({ enabled: true, pinned: {} });
      expect(h.commits.map(stripAnsi).join("\n")).toContain("Crew");
      expect(h.screen()).toContain("1  Crew  켜짐");
      h.press(key("escape"));
      expect(barOf(h)).toContain("crew");
    });

    it("picks a preset from its list and leaves pinned roles alone", async () => {
      const h = crewChat({
        settings: crewSettings({ threads: { [LEAD]: { pinned: { worker: haiku } } } }),
      });
      run(h, "/crew");
      h.press(key("down"), key("enter"));
      expect(h.screen()).toContain("Crew 프리셋");
      expect(rowsOf(h)).toHaveLength(4);
      h.press(text("2"), key("enter"));
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]).toEqual({ preset: "speed", pinned: { worker: haiku } });
      expect(h.screen()).toContain("프리셋  속도");
    });

    it("pins a role from the model list, with the search the model list has", async () => {
      const h = crewChat();
      run(h, "/crew");
      h.press(text("3"), key("enter"));
      expect(h.screen()).toContain("Worker 모델");
      expect(rowsOf(h)[0]).toContain("Auto");
      h.press(text("h"), text("a"), text("i"));
      expect(rowsOf(h)).toHaveLength(1);
      expect(rowsOf(h)[0]).toContain("Haiku 4");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.pinned).toEqual({ worker: haiku });
      expect(h.screen()).toMatch(/Worker {2}Haiku 4/u);
    });

    it("puts a pinned role back on Auto, even where the defaults pin it", async () => {
      const h = crewChat({ settings: crewSettings({ pinned: { worker: haiku } }) });
      run(h, "/crew");
      h.press(text("3"), key("enter"));
      // The model in use is marked, and Auto is the first row.
      expect(h.screen()).toContain("현재");
      h.press(key("up"), key("up"), key("up"), key("up"), key("up"), key("enter"));
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.pinned).toEqual({ worker: null });
      expect(crewIn(h).pinned).toEqual({ worker: haiku });
    });

    it("sets every role back on Auto at once, when any is pinned", async () => {
      const h = crewChat({ settings: crewSettings({ pinned: { worker: haiku } }) });
      run(h, "/crew");
      expect(h.screen()).toContain("역할 모델 모두 Auto");
      h.press(text("6"), key("enter"));
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.pinned).toEqual({
        worker: null,
        expert: null,
        auditor: null,
      });
      run(h, "/crew");
      expect(h.screen()).not.toContain("역할 모델 모두 Auto");
    });

    it("makes what the thread runs with the default for new chats", async () => {
      const h = crewChat({
        settings: crewSettings({
          threads: { [LEAD]: { enabled: true, preset: "quality", pinned: { worker: haiku } } },
        }),
      });
      run(h, "/crew");
      h.press(text("7"), key("enter"));
      await flushMicrotasks();
      const crew = crewIn(h);
      expect(crew.enabled).toBe(true);
      expect(crew.preset).toBe("quality");
      expect(crew.pinned).toEqual({ worker: haiku });
      expect(crew.threads[LEAD]).toEqual({
        enabled: true,
        preset: "quality",
        pinned: { worker: haiku },
      });
    });

    it("reports a refused save and leaves the screen as it was", async () => {
      const h = crewChat({ settingsError: "서버가 거부했습니다" });
      run(h, "/crew");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi).join("\n")).toContain(
        "Crew 설정 저장 실패: 서버가 거부했습니다",
      );
      expect(h.screen()).toContain("1  Crew  꺼짐");
    });
  });

  describe("the commands", () => {
    it("turns the crew on and off for the thread, and says when it already is", async () => {
      const h = crewChat();
      run(h, "/crew on");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.enabled).toBe(true);
      expect(barOf(h)).toContain("crew");
      run(h, "/crew on");
      expect(h.screen()).toContain("이미 Crew 켜짐입니다.");
      run(h, "/crew off");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.enabled).toBe(false);
      expect(barOf(h)).not.toContain("crew");
      expect(h.patches).toHaveLength(2);
    });

    it("changes the defaults, not an override, for a conversation that has not started", async () => {
      const h = harness({ columns: 101, config: crewConfig() });
      h.start();
      run(h, "/crew on");
      await flushMicrotasks();
      expect(crewIn(h).enabled).toBe(true);
      expect(crewIn(h).threads).toEqual({});
      run(h, "/crew");
      expect(rowsOf(h).join("\n")).toContain("새 채팅 기본값");
      expect(h.screen()).not.toContain("새 채팅 기본값으로 사용");
      h.press(key("escape"));
      run(h, "/crew default");
      expect(h.screen()).toContain("이미 새 채팅 기본값입니다");
    });

    it("sets a preset by name, alias or label and refuses an unknown one", async () => {
      const h = crewChat();
      run(h, "/crew preset speed");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.preset).toBe("speed");
      run(h, "/crew preset 예산");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.preset).toBe("budget");
      run(h, "/crew preset slow");
      expect(h.screen()).toContain(
        "알 수 없는 프리셋입니다: slow (recommended|speed|quality|budget)",
      );
      expect(h.patches).toHaveLength(2);
      run(h, "/crew preset");
      expect(h.screen()).toContain("Crew 프리셋");
    });

    it("pins a role with the one model the words name, and Auto with `auto`", async () => {
      const h = crewChat();
      run(h, "/crew model worker haiku");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.pinned).toEqual({ worker: haiku });
      run(h, "/crew model auditor opus");
      await flushMicrotasks();
      expect(Object.keys(crewIn(h).threads[LEAD]?.pinned ?? {}).toSorted()).toEqual([
        "auditor",
        "worker",
      ]);
      run(h, "/crew model worker auto");
      await flushMicrotasks();
      expect(crewIn(h).threads[LEAD]?.pinned?.worker).toBeNull();
      expect(crewIn(h).threads[LEAD]?.pinned?.auditor).toMatchObject({ model: "claude-opus-4" });
    });

    it("opens the model list, narrowed, when the words fit several models or none is given", () => {
      const h = crewChat();
      run(h, "/crew model expert");
      expect(h.screen()).toContain("Expert 모델");
      expect(rowsOf(h)).toHaveLength(6);
      h.press(key("escape"));
      expect(h.screen()).toContain("◆  Crew");
      h.press(key("escape"));
      run(h, "/crew model expert gpt");
      expect(h.screen()).toContain("Expert 모델");
      expect(rowsOf(h)).toHaveLength(2);
      expect(h.patches).toEqual([]);
    });

    it("explains a wrong role or a model nothing matches", () => {
      const h = crewChat();
      run(h, "/crew model boss haiku");
      expect(h.screen()).toContain("알 수 없는 역할입니다: boss");
      run(h, "/crew model worker zzzz");
      expect(h.screen()).toContain("일치하는 모델이 없습니다: zzzz");
      run(h, "/crew model");
      expect(h.screen()).toContain("사용법: /crew model <worker|expert|auditor>");
      run(h, "/crew nonsense");
      expect(h.screen()).toContain("사용법: /crew [on|off|preset");
      expect(h.patches).toEqual([]);
    });

    it("makes the thread's crew the default with /crew default", async () => {
      const h = crewChat({
        settings: crewSettings({ threads: { [LEAD]: { enabled: true } } }),
      });
      run(h, "/crew default");
      await flushMicrotasks();
      expect(crewIn(h).enabled).toBe(true);
    });
  });

  describe("a model that cannot lead a crew", () => {
    const opencodeLead = { modelSelection: { instanceId: "opencode", model: "o-1" } };

    it("saves the choice but says why the crew will not run", async () => {
      const h = crewChat({ lead: opencodeLead });
      run(h, "/crew on");
      await flushMicrotasks();
      expect(h.screen()).toContain("OpenCode 모델은 crew 의 brain 이 될 수 없습니다");
      expect(crewIn(h).threads[LEAD]?.enabled).toBe(true);
      expect(barOf(h)).toContain("crew 미지원");
    });

    it("says it on the crew screen too", () => {
      const h = crewChat({ lead: opencodeLead });
      run(h, "/crew");
      expect(h.screen()).toContain("brain 이 될 수 없습니다");
    });
  });

  describe("the board", () => {
    const busyTurn = () => [
      started("t1", "worker", "파서 고치기", 1),
      started("t2", "expert", "구조 설계", 2),
      finished("t1", "worker", "파서 고치기", 11, "completed", {
        summary: "경계 조건을 고쳤습니다.",
        tested: true,
      }),
    ];

    it("lists the turn's tasks with role, state, model and time, and counts them in the bar", () => {
      const h = crewChat({
        activities: busyTurn(),
        running: true,
        settings: crewSettings({ threads: { [LEAD]: { enabled: true } } }),
      });
      expect(barOf(h)).toContain("crew 1/2");
      run(h, "/crew");
      const screen = h.screen();
      expect(screen).toContain("이번 턴 · 작업 2개 · 진행 1 · 끝남 1");
      expect(screen).toContain("Worker  완료 · 파서 고치기");
      expect(screen).toContain("Expert  진행 중 · 구조 설계");
      expect(screen).toContain("Haiku 4 · 10s");
    });

    it("does not count crew tasks as agents in the bar", () => {
      const h = crewChat({ activities: busyTurn(), running: true });
      expect(barOf(h)).not.toContain("에이전트");
    });

    it("keeps failed, blocked and left-out work in view", () => {
      const h = crewChat({
        activities: [
          started("t1", "worker", "실패한 일", 1),
          finished("t1", "worker", "실패한 일", 5, "failed"),
          started("t2", "expert", "막힌 일", 2),
          finished("t2", "expert", "막힌 일", 6, "blocked"),
          makeActivity({
            id: "skip",
            kind: "crew.audit-skipped",
            turnId: TURN,
            createdAt: "2026-10-30T09:00:07.000Z",
            payload: { changedFiles: 1 },
          }),
        ],
      });
      run(h, "/crew");
      const screen = h.screen();
      expect(screen).toContain("Worker  실패 · 실패한 일");
      expect(screen).toContain("Expert  차단됨 · 막힌 일");
      expect(screen).toContain("감사 생략");
    });

    it("writes a line to the scrollback when a task starts and when it ends", () => {
      const h = crewChat({ activities: busyTurn(), running: true });
      const commits = h.commits.map(stripAnsi).join("\n");
      expect(commits).toContain("crew Worker 시작 · 파서 고치기 (Haiku 4)");
      expect(commits).toContain("crew Worker 완료 · 파서 고치기 (Haiku 4)");
      expect(commits).toContain("crew Expert 시작 · 구조 설계 (Opus 4)");
    });

    it("shows a task in full: summary, evidence, and what can be done with it", () => {
      const h = crewChat({ activities: busyTurn(), running: true });
      run(h, "/crew");
      h.press(text("7"), key("enter"));
      const screen = h.screen();
      expect(screen).toContain("Worker 작업");
      expect(screen).toContain("요약");
      expect(screen).toContain("경계 조건을 고쳤습니다.");
      expect(screen).toContain("근거");
      expect(screen).toContain("테스트 통과");
      expect(rowsOf(h).map((row) => row.replace(/^│ {2}[●○] /u, ""))).toEqual([
        "1  서브 스레드 열기  작업의 대화를 봅니다",
        "2  보드로",
      ]);
      h.press(key("escape"));
      expect(h.screen()).toContain("◆  Crew");
    });

    it("stops a running task only after one confirmation, by interrupting the task's own thread", async () => {
      const h = crewChat({ activities: busyTurn(), running: true });
      run(h, "/crew");
      h.press(text("8"), key("enter"));
      expect(
        rowsOf(h).map((row) => row.replace(/^│ {2}[●○] \d {2}/u, "").split(/ {2}/u)[0]),
      ).toEqual(["서브 스레드 열기", "중단", "보드로"]);
      h.press(text("2"), key("enter"));
      expect(h.screen()).toContain("이 작업을 중단할까요?");
      expect(h.dispatched).toEqual([]);
      // The pointer starts on "cancel": a second Enter by habit does not stop anything.
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      h.press(text("2"), key("enter"));
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: "sub-t2",
      });
      expect(h.commits.map(stripAnsi).join("\n")).toContain("Expert 작업 중단을 요청했습니다");
    });

    it("cancels a stop with Esc", async () => {
      const h = crewChat({ activities: busyTurn(), running: true });
      run(h, "/crew");
      h.press(text("8"), key("enter"), text("2"), key("enter"));
      h.press(key("escape"));
      expect(h.screen()).toContain("Expert 작업");
      expect(h.screen()).not.toContain("이 작업을 중단할까요?");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("retries a task that did not finish, asking the server once", async () => {
      const calls: Array<{ leadThreadId: string; taskId: string }> = [];
      const h = crewChat({
        activities: [
          started("t1", "worker", "다시 할 일", 1),
          finished("t1", "worker", "다시 할 일", 5, "failed"),
        ],
      });
      Object.assign(h.link, {
        retryCrewTask: async (input: { leadThreadId: string; taskId: string }) => {
          calls.push(input);
        },
      });
      run(h, "/crew");
      h.press(text("7"), key("enter"));
      expect(
        rowsOf(h).map((row) => row.replace(/^│ {2}[●○] \d {2}/u, "").split(/ {2}/u)[0]),
      ).toEqual(["서브 스레드 열기", "재시도", "보드로"]);
      h.press(text("2"), key("enter"), key("enter"));
      await flushMicrotasks();
      expect(calls).toEqual([{ leadThreadId: LEAD, taskId: "t1" }]);
      expect(h.commits.map(stripAnsi).join("\n")).toContain("Worker 작업을 다시 시작했습니다");
    });

    it("says why a retry failed, and offers no retry for an audit", async () => {
      const h = crewChat({
        activities: [
          started("t1", "worker", "일", 1),
          finished("t1", "worker", "일", 5, "failed"),
          started("t2", "auditor", "검토", 6),
          finished("t2", "auditor", "검토", 9, "failed"),
        ],
      });
      Object.assign(h.link, {
        retryCrewTask: async () => {
          throw new Error("Crew 가 꺼져 있습니다");
        },
      });
      run(h, "/crew");
      h.press(text("8"), key("enter"));
      expect(h.screen()).toContain("Auditor 작업");
      expect(h.screen()).not.toContain("재시도");
      h.press(key("escape"), text("7"), key("enter"), text("2"), key("enter"));
      await flushMicrotasks();
      expect(h.commits.map(stripAnsi).join("\n")).toContain(
        "crew 재시도 실패: Crew 가 꺼져 있습니다",
      );
    });

    it("cleans control characters out of a task's name", () => {
      const h = crewChat({
        activities: [started("t1", "worker", "\u001b[31m빨강\u001b[0m 작업\u0007", 1)],
        running: true,
      });
      run(h, "/crew");
      expect(h.screen()).toContain("빨강");
      // eslint-disable-next-line no-control-regex
      expect(h.screen()).not.toMatch(/[\u001b\u0007]/u);
      // eslint-disable-next-line no-control-regex
      expect(h.commits.join("\n")).not.toMatch(/[\u001b\u0007]/u);
    });
  });

  describe("a crew task waits for the user", () => {
    const waiting = () => [
      subShell("sub-t1", "Crew Worker · 파서 고치기", { hasPendingApprovals: true }),
      subShell("sub-t2", "Crew Expert · 설계", { updatedAt: "2026-10-30T06:00:00.000Z" }),
    ];
    const activities = () => [
      started("t1", "worker", "파서 고치기", 1),
      started("t2", "expert", "설계", 2),
    ];

    it("warns in the chat and in the bar, with the way to answer", () => {
      const h = crewChat({ activities: activities(), running: true, subs: waiting() });
      expect(h.screen()).toContain("crew 작업이 승인을 기다립니다 — /crew");
      expect(barOf(h)).toContain("crew 승인·질문 대기 1");
    });

    it("keeps the warning while a list is open, and starts the board on the waiting task", () => {
      const h = crewChat({ activities: activities(), running: true, subs: waiting() });
      run(h, "/model");
      expect(h.screen()).toContain("crew 작업이 승인을 기다립니다 — /crew");
      h.press(key("escape"));
      run(h, "/crew");
      expect(rowsOf(h).findIndex((row) => row.startsWith("│  ●"))).toBe(6);
      expect(h.screen()).toContain("Worker  진행 중 · 파서 고치기 · 승인 대기");
    });

    it("opens the task's thread from the board and warns there that it is not the lead", () => {
      const h = crewChat({ activities: activities(), running: true, subs: waiting() });
      run(h, "/crew");
      h.press(key("enter"));
      expect(h.screen()).toContain("승인·질문에 답합니다");
      h.press(key("enter"));
      expect(h.opened.at(-1)).toBe("sub-t1");
      expect(h.screen()).toContain("crew 작업 스레드 · /crew back");
      expect(h.commits.map(stripAnsi).join("\n")).toContain("Crew 작업 스레드");
    });

    it("lets the user answer there and does not send what they type to the lead", async () => {
      const h = crewChat({ activities: activities(), running: true, subs: waiting() });
      run(h, "/crew");
      h.press(key("enter"), key("enter"));
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "sub-t1",
            title: "Crew Worker · 파서 고치기",
            parentThreadId: LEAD,
            session: makeSession("running", { threadId: "sub-t1" }),
            activities: [approvalRequested("req-1", "ls")],
          }),
          5,
        ),
      ]);
      expect(h.screen()).toContain("승인");
      expect(rowsOf(h).every((row) => row.includes("○"))).toBe(true);
      expect(barOf(h)).toContain("crew 작업");
      expect(barOf(h)).toContain("/crew back");
    });

    it("blocks a message typed on a task's thread and goes back to the lead with /crew back", async () => {
      const h = crewChat({ activities: activities(), running: true, subs: waiting() });
      run(h, "/crew");
      h.press(key("enter"), key("enter"));
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "sub-t1",
            title: "Crew Worker · 파서 고치기",
            parentThreadId: LEAD,
            session: makeSession("idle", { threadId: "sub-t1" }),
          }),
          5,
        ),
      ]);
      run(h, "이 말은 lead 에게 가면 안 됩니다");
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).toContain("crew 작업 스레드입니다. 메시지는 lead 로 보내세요: /crew back");
      h.press(ctrl("u"));
      run(h, "/goal 이것도 안 됩니다");
      expect(h.screen()).toContain("crew 작업 스레드에는 목표를 둘 수 없습니다");
      run(h, "/crew on");
      expect(h.screen()).toContain("crew 작업 스레드에서는 /crew back 만 쓸 수 있습니다.");
      run(h, "/crew back");
      expect(h.opened.at(-1)).toBe(LEAD);
      expect(h.patches).toEqual([]);
      expect(h.dispatched).toEqual([]);
    });

    it("tells the user on the task's thread that the lead is waiting too", () => {
      const h = crewChat({
        activities: activities(),
        running: true,
        subs: waiting(),
        lead: { hasPendingApprovals: true },
      });
      run(h, "/crew");
      h.press(key("enter"), key("enter"));
      h.deliver([
        threadSnapshotItem(
          makeThread({
            id: "sub-t1",
            title: "Crew Worker · 파서 고치기",
            parentThreadId: LEAD,
            session: makeSession("idle", { threadId: "sub-t1" }),
          }),
          5,
        ),
      ]);
      expect(h.screen()).toContain("lead 스레드가 승인을 기다립니다 — /crew back");
      expect(barOf(h)).toContain("crew 작업");
    });
  });

  describe("an open overlay and a request from the agent", () => {
    const approving = () =>
      makeThread({
        id: LEAD,
        session: makeSession("running", { threadId: LEAD }),
        activities: [approvalRequested("req-1", "rm -rf build")],
      });

    it("keeps every key and the warning when an approval arrives, and shows the panel after Esc", async () => {
      const h = crewChat({ running: true });
      run(h, "/crew");
      h.deliver([threadSnapshotItem(approving(), 4)]);
      expect(h.screen()).toContain("◆  Crew");
      expect(h.screen()).toContain("승인이 기다립니다 · Esc로 닫으면 표시됩니다");
      // The digits belong to the screen: nothing is picked in the approval, nothing is sent.
      h.press(text("1"), key("down"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.filter((command) => command.type === "thread.approval.respond")).toEqual(
        [],
      );
      h.press(key("escape"));
      h.press(key("escape"));
      const options = h
        .screen()
        .split("\n")
        .filter((row) => /[●○] \d /u.test(row));
      expect(options).toHaveLength(4);
      expect(options.every((row) => row.includes("○"))).toBe(true);
    });

    it("does not close the model list of a role either", () => {
      const h = crewChat({ running: true });
      run(h, "/crew model worker");
      h.deliver([threadSnapshotItem(approving(), 4)]);
      expect(h.screen()).toContain("Worker 모델");
      expect(h.screen()).toContain("승인이 기다립니다 · Esc로 닫으면 표시됩니다");
      h.press(key("enter"));
      expect(h.dispatched).toEqual([]);
    });
  });

  describe("/threads", () => {
    const threadsShell = () =>
      shellOf([
        subShell("sub-a", "Crew Worker · 파서", { updatedAt: "2026-10-30T07:30:00.000Z" }),
        subShell("sub-b", "Crew Auditor · 검토", { updatedAt: "2026-10-30T07:20:00.000Z" }),
        subShell("sub-c", "Crew Expert · 설계", {
          updatedAt: "2026-10-30T07:10:00.000Z",
          hasPendingApprovals: true,
        }),
      ]);
    const itemRows = (h: ReturnType<typeof harness>) =>
      h
        .screen()
        .split("\n")
        .filter((row) => /^│ {2}[●○] /u.test(row));

    it("folds crew threads under the lead and puts a waiting one on top", () => {
      const h = crewChat({ shell: threadsShell() });
      run(h, "/threads");
      const rows = itemRows(h);
      expect(rows[0]).toContain("새 스레드");
      expect(rows[1]).toContain("crew Expert · 설계");
      expect(rows[1]).toContain("승인 대기");
      expect(rows.find((row) => row.includes("테스트 스레드"))).toContain("crew 작업 2");
      expect(h.screen()).not.toContain("Worker · 파서");
      expect(h.screen()).not.toContain("Auditor · 검토");
    });

    it("opens a waiting crew thread from the list", () => {
      const h = crewChat({ shell: threadsShell() });
      run(h, "/threads");
      h.press(key("down"), key("enter"));
      expect(h.opened.at(-1)).toBe("sub-c");
    });

    it("never takes a crew thread for the last thread when continuing", () => {
      const h = harness({
        continueLast: true,
        config: crewConfig(),
        shell: makeSnapshot(
          [makeProject()],
          [
            makeThreadShell({ id: LEAD, updatedAt: "2026-10-30T08:00:00.000Z" }),
            makeThreadShell(
              subShell("sub-z", "Crew Worker · 더 최근", { updatedAt: "2026-10-30T09:00:00.000Z" }),
            ),
          ],
        ),
      });
      h.start();
      expect(h.opened).toEqual([LEAD]);
    });
  });

  describe("a narrow terminal and ASCII", () => {
    it("fits the screens in 40 columns and uses no box characters in ASCII", () => {
      const h = crewChat({
        columns: 40,
        symbols: ASCII_SYMBOLS,
        activities: [
          started("t1", "worker", "아주 긴 작업 이름이 좁은 터미널을 넘칩니다", 1),
          finished("t1", "worker", "아주 긴 작업 이름이 좁은 터미널을 넘칩니다", 9, "failed", {
            summary: "요약이 아주 길어서 여러 줄로 접혀야 하는 경우입니다 요약이 아주 깁니다",
          }),
        ],
      });
      const check = () => {
        for (const row of h.screen().split("\n")) {
          expect(stringWidth(row), row).toBeLessThanOrEqual(39);
          expect(row).not.toMatch(/[│◆◇●○└┌▲✗─]/u);
        }
      };
      run(h, "/crew");
      check();
      h.press(text("7"), key("enter"));
      check();
      expect(h.screen()).toContain("요약");
      h.press(key("escape"), text("3"), key("enter"));
      check();
    });
  });
});

describe("/provider", () => {
  const SECRET = "test-value-1234";
  const readyProvider = (instanceId: string, driver: string, displayName: string) => ({
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "m1", name: "M1", isCustom: false, isDefault: true, capabilities: null }],
  });
  const instances = () => ({
    codex: { driver: "codex", enabled: true },
    opencode_zai: {
      driver: "opencode",
      displayName: "Z.AI",
      enabled: true,
      config: {
        enabled: true,
        binaryPath: "opencode",
        serverUrl: "",
        customModels: ["zai/glm-5.3"],
      },
      environment: [{ name: "OOP_ZAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
    },
    codex_work: { driver: "codex" },
  });
  const providerChat = (options: Options & { running?: boolean } = {}) => {
    const { running, ...rest } = options;
    const h = harness({
      columns: 61,
      config: makeConfig({
        providers: [
          readyProvider("codex", "codex", "Codex"),
          readyProvider("opencode_zai", "opencode", "Z.AI"),
          readyProvider("codex_work", "codex", "Work"),
        ],
      }),
      settings: { providerInstances: instances() },
      ...rest,
    });
    h.openNewest();
    h.deliver([
      threadSnapshotItem(
        makeThread({
          id: "thread-new",
          session: makeSession(running ? "running" : "idle", { threadId: "thread-new" }),
        }),
        3,
      ),
    ]);
    return h;
  };
  const run = (h: ReturnType<typeof harness>, line: string) => {
    h.typeText(line);
    h.press(key("enter"));
  };
  const everything = (h: ReturnType<typeof harness>) =>
    [...h.commits.map(stripAnsi), h.screen()].join("\n");
  /** Adds the Z.AI preset through the screens, up to the review. */
  const toReview = (h: ReturnType<typeof harness>) => {
    run(h, "/provider add zai --id opencode_zai2");
    h.press(key("enter"), text(SECRET), key("enter"));
    h.press(key("down"), key("down"), key("down"), key("down"), key("enter"));
  };

  it("is in the slash menu and in /help", () => {
    const h = providerChat();
    h.typeText("/prov");
    expect(h.screen()).toContain("/provider");
    h.press(key("escape"), ctrl("u"));
    run(h, "/help");
    const commits = h.commits.map(stripAnsi).join("\n");
    expect(commits).toContain("/provider");
    expect(commits).toContain("remove <id>");
  });

  it("lists the instances into the scrollback, without opening a screen", () => {
    const h = providerChat();
    run(h, "/provider");
    const commits = h.commits.map(stripAnsi).join("\n");
    expect(commits).toContain("opencode_zai");
    expect(commits).toContain("준비됨");
    expect(commits).toContain("기본");
    expect(h.screen()).not.toContain("◆  Provider");
    run(h, "/provider list");
    expect(h.patches).toEqual([]);
  });

  it("adds an instance through the screens, keeps the others, and has the server look again", async () => {
    const h = providerChat();
    toReview(h);
    expect(h.screen()).toContain("추가할까요?");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.patches).toHaveLength(1);
    expect(Object.keys(h.patches[0] ?? {})).toEqual(["providerInstances"]);
    const sent = (h.patches[0] as { providerInstances: Record<string, unknown> }).providerInstances;
    expect(Object.keys(sent)).toEqual(["codex", "opencode_zai", "codex_work", "opencode_zai2"]);
    expect(sent.opencode_zai).toEqual(instances().opencode_zai);
    expect(h.refreshes).toEqual([{ instanceId: "opencode_zai2" }]);
    expect(h.commits.map(stripAnsi).join("\n")).toContain("opencode_zai2 추가됨");
    expect(h.screen()).not.toContain("추가할까요?");
  });

  it("never lets the key reach the screen or the scrollback", async () => {
    const h = providerChat();
    run(h, "/provider add zai --id opencode_zai2");
    h.press(key("enter"), text(SECRET));
    expect(h.screen()).not.toContain(SECRET);
    expect(h.screen()).toContain("•");
    h.press(key("enter"), key("down"), key("down"), key("down"), key("down"), key("enter"));
    expect(everything(h)).not.toContain(SECRET);
    h.press(key("enter"));
    await flushMicrotasks();
    expect(everything(h)).not.toContain(SECRET);
  });

  it("refuses a key on the line and says to type it in", () => {
    const h = providerChat();
    run(h, `/provider add zai --id x --set apiKey=${SECRET}`);
    expect(h.screen()).toContain("입력 화면");
    expect(h.screen()).not.toContain("◆  Z.AI 추가");
    expect(h.patches).toEqual([]);
  });

  it("removes only the instance named, after the plan and a yes", async () => {
    const h = providerChat();
    run(h, "/provider remove opencode_zai");
    expect(h.screen()).toContain("yes");
    expect(h.screen()).toContain("비밀값 1개");
    h.typeText("yes");
    h.press(key("enter"));
    await flushMicrotasks();
    const sent = (h.patches[0] as { providerInstances: Record<string, unknown> }).providerInstances;
    expect(Object.keys(sent)).toEqual(["codex", "codex_work"]);
    expect(h.refreshes).toEqual([undefined]);
    expect(h.commits.map(stripAnsi).join("\n")).toContain("opencode_zai 삭제됨");
  });

  it("leaves the built-in instance alone and says why", () => {
    const h = providerChat();
    run(h, "/provider remove codex");
    expect(h.commits.map(stripAnsi).join("\n")).toContain("기본 인스턴스");
    expect(h.screen()).not.toContain("yes");
    expect(h.patches).toEqual([]);
  });

  it("changes nothing on Esc", async () => {
    const h = providerChat();
    run(h, "/provider remove codex_work");
    h.typeText("yes");
    h.press(key("escape"));
    await flushMicrotasks();
    expect(h.patches).toEqual([]);
    expect(h.screen()).not.toContain("yes");
  });

  it("does not touch a turn that is running", async () => {
    const h = providerChat({ running: true });
    run(h, "/provider remove codex_work");
    h.typeText("yes");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.patches).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
  });

  describe("with the link down", () => {
    const reconnecting = {
      phase: "reconnecting",
      attempt: 1,
      retryAt: null,
      detail: null,
    } as const;

    it("opens, shows the state of the link, and sends nothing until it is back", async () => {
      const h = providerChat();
      toReview(h);
      (h.link as { status: unknown }).status = reconnecting;
      h.controller.onLinkStatus();
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.patches).toEqual([]);
      expect(h.screen()).toContain("연결이 끊겨");
      (h.link as { status: unknown }).status = online;
      h.controller.onLinkStatus();
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.patches).toHaveLength(1);
    });

    it("says it needs a server when there is no config at all", () => {
      const h = providerChat();
      (h.link as { config: unknown }).config = null;
      run(h, "/provider");
      expect(h.screen()).toContain("서버에 연결된 뒤에 쓸 수 있습니다.");
    });
  });

  describe("an open screen and a request from the agent", () => {
    const approving = () =>
      makeThread({
        id: "thread-new",
        session: makeSession("running", { threadId: "thread-new" }),
        activities: [approvalRequested("req-1", "rm -rf build")],
      });

    it("keeps every key and the warning when an approval arrives, and shows the panel after Esc", async () => {
      const h = providerChat({ running: true });
      run(h, "/provider add");
      h.deliver([threadSnapshotItem(approving(), 4)]);
      expect(h.screen()).toContain("추가할 Provider");
      expect(h.screen()).toContain("승인이 기다립니다 · Esc로 닫으면 표시됩니다");
      h.press(text("1"), key("down"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.filter((command) => command.type === "thread.approval.respond")).toEqual(
        [],
      );
      expect(h.screen()).toMatch(/◆ {2}\S+ 추가/u);
      h.press(key("escape"), key("escape"), key("escape"));
      const options = h
        .screen()
        .split("\n")
        .filter((row) => /[●○] \d /u.test(row));
      expect(options).toHaveLength(4);
      expect(options.every((row) => row.includes("○"))).toBe(true);
    });

    it("locks the numbers when the screen closes by itself under a waiting approval, until an arrow lifts it", async () => {
      const h = providerChat({ running: true });
      toReview(h);
      h.deliver([threadSnapshotItem(approving(), 4)]);
      expect(h.screen()).toContain("승인이 기다립니다");
      // The save finishes with no key from the user: the screen closes and the panel comes up.
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.patches).toHaveLength(1);
      const options = () =>
        h
          .screen()
          .split("\n")
          .filter((row) => /[●○] \d /u.test(row));
      expect(options()).toHaveLength(4);
      // Digits and Enter typed while it was saving reach nothing.
      h.press(text("1"), key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.filter((command) => command.type === "thread.approval.respond")).toEqual(
        [],
      );
      expect(options().every((row) => row.includes("○"))).toBe(true);
      // An arrow lifts the lock; then a digit picks.
      h.press(key("down"), text("1"));
      expect(options().some((row) => row.includes("●"))).toBe(true);
    });

    it("leaves the numbers free when the user's own Esc is what closes the screen", () => {
      const h = providerChat({ running: true });
      run(h, "/provider add");
      h.deliver([threadSnapshotItem(approving(), 4)]);
      h.press(key("escape"), key("escape"), key("escape"));
      h.press(text("1"));
      const picked = h
        .screen()
        .split("\n")
        .filter((row) => /[●○] \d /u.test(row) && row.includes("●"));
      expect(picked).toHaveLength(1);
    });

    it("does the same for the removal question, and does not answer it with a stray y", () => {
      const h = providerChat({ running: true });
      run(h, "/provider remove codex_work");
      h.deliver([threadSnapshotItem(approving(), 4)]);
      expect(h.screen()).toContain("yes");
      expect(h.screen()).toContain("승인이 기다립니다");
      h.typeText("y");
      h.press(key("enter"));
      expect(h.patches).toEqual([]);
      expect(h.dispatched).toEqual([]);
    });
  });

  describe("on a narrow or plain terminal", () => {
    it("fits 40 columns and uses no Unicode marks when the terminal has none", () => {
      const h = providerChat({ columns: 41, symbols: ASCII_SYMBOLS });
      const check = () => {
        for (const row of h.screen().split("\n")) {
          expect(stringWidth(row), row).toBeLessThanOrEqual(40);
          expect(row).not.toMatch(/[│◆◇●○└┌▲✗─]/u);
        }
      };
      run(h, "/provider add");
      check();
      h.press(key("escape"));
      run(h, "/provider add zai --id opencode_zai2");
      check();
      h.press(key("enter"), text(SECRET));
      check();
      expect(h.screen()).toContain("*".repeat(SECRET.length));
      h.press(key("escape"), key("escape"), key("escape"));
      run(h, "/provider remove opencode_zai");
      check();
    });
  });
});

describe("scrolling the conversation of the split layout", () => {
  it("passes PageUp and PageDown to the region, and any other input makes it follow again", () => {
    const h = harness();
    h.openNewest();
    h.scrolls.length = 0;
    h.press(key("pageup"), key("pageup"), key("pagedown"));
    expect(h.scrolls).toEqual(["up", "up", "down"]);
    h.scrolls.length = 0;
    h.typeText("a");
    expect(h.scrolls).toEqual(["follow"]);
    // A page key is not input: it never types anything.
    expect(h.screen()).not.toContain("5~");
  });

  it("takes Shift+PageUp and Shift+PageDown as the same scrolling", () => {
    const h = harness();
    h.openNewest();
    h.scrolls.length = 0;
    h.press(shiftKey("pageup"), shiftKey("pagedown"));
    expect(h.scrolls).toEqual(["up", "down"]);
  });

  it("leaves an open list its own PageUp and PageDown", () => {
    const h = harness();
    h.start();
    h.typeText("/threads");
    h.press(key("enter"));
    h.scrolls.length = 0;
    h.press(key("pagedown"), key("pageup"));
    expect(h.scrolls).toEqual([]);
  });
});

describe("when no model can run", () => {
  const provider = (over: Record<string, unknown> = {}) => ({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: false,
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
    ],
    ...over,
  });
  const stuck = () => {
    const h = harness({
      config: makeConfig({
        providers: [
          provider(),
          provider({ instanceId: "cursor", displayName: "Cursor", enabled: false }),
        ],
      }),
    });
    h.start();
    return h;
  };

  it("says why a message is not sent and where to go, and keeps the text", async () => {
    const h = stuck();
    h.typeText("안녕");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toEqual([]);
    const said = h.screen().replace(/\s+/gu, " ");
    expect(said).toContain("Codex 설치 안 됨");
    expect(said).toContain("/provider add");
    expect(said).toContain("oop provider add");
    expect(h.screen()).toContain("안녕");
    expect(h.screen()).toContain("모델 없음");
  });

  it("explains the empty model list too, and Enter there opens the provider screen", () => {
    const h = stuck();
    h.typeText("/model");
    h.press(key("enter"));
    expect(h.screen()).toContain("Codex 설치 안 됨");
    expect(h.screen()).toContain("Enter Provider 추가");
    h.press(key("enter"));
    expect(h.screen()).toContain("추가할 Provider");
  });

  it("lists the model and sends as soon as the server reports a provider that can run", async () => {
    const h = stuck();
    h.typeText("안녕");
    h.press(key("enter"));
    h.link.config = makeConfig({ providers: [provider({ installed: true })] });
    h.controller.onConfig();
    expect(h.screen()).not.toContain("모델 없음");
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);
  });

  it("names a server with no provider on at all", async () => {
    const h = harness({ config: makeConfig({ providers: [] }) });
    h.start();
    h.typeText("/model");
    h.press(key("enter"));
    expect(h.screen()).toContain("켜진 Provider 가 없습니다");
  });
});

describe("a very long paste", () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `줄 ${index + 1}`).join("\n");
  const chat = (options: Options = {}) => {
    const h = harness(options);
    h.start();
    h.press(key("enter"));
    return h;
  };

  it("keeps the composer short, says how much is out of sight, and follows the cursor", () => {
    const h = chat();
    h.press({ type: "paste", text: lines(1000) });
    expect(h.frame().lines.length).toBeLessThan(24);
    expect(h.screen()).toContain("줄 1000");
    expect(h.screen()).not.toContain("줄 1\n");
    expect(h.screen()).toMatch(/↑ 9\d\d줄 더/u);
    // The cursor is on a drawn row, and moving it up scrolls the window instead of leaving it behind.
    for (let step = 0; step < 990; step += 1) h.press(key("up"));
    expect(h.screen()).toContain("줄 10");
    expect(h.screen()).not.toContain("줄 3000");
    const cursor = h.frame().cursor;
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBeLessThan(h.frame().lines.length);
  });

  it("sends all of the text, not the part that is drawn", async () => {
    const h = chat();
    const text = lines(3000);
    h.press({ type: "paste", text });
    h.press(key("enter"));
    await flushMicrotasks();
    const sent = h.dispatched[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(sent.message.text).toBe(text);
  });

  it("can be edited and cleared", () => {
    const h = chat();
    h.press({ type: "paste", text: lines(300) });
    h.press(ctrl("u"));
    expect(h.screen()).toContain("줄 더");
    for (let step = 0; step < 300; step += 1) h.press(ctrl("u"), key("backspace"));
    expect(h.screen()).not.toContain("줄 더");
    expect(h.screen()).toContain("예: hello.ts");
  });

  it("refuses a message over the server's limit, with the excess, and keeps the text", async () => {
    const h = chat();
    h.press({ type: "paste", text: "가".repeat(120_000) });
    h.press(key("enter"));
    await flushMicrotasks();
    expect(h.dispatched).toHaveLength(1);

    const over = chat();
    over.press({ type: "paste", text: "가".repeat(120_005) });
    over.press(key("enter"));
    await flushMicrotasks();
    expect(over.dispatched).toEqual([]);
    expect(over.screen().replace(/\s+/gu, " ")).toContain("상한(120,000자)보다 5자 깁니다");
    expect(over.screen()).toContain("가가가");
  });
});

describe("/diff and /undo", () => {
  const DONE = "2026-10-30T08:00:00.000Z";
  const checkpointOf = (count: number) => ({
    turnId: `turn-${count}`,
    checkpointTurnCount: count,
    checkpointRef: `refs/checkpoints/${count}`,
    status: "ready",
    files: [
      { path: "src/a.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "docs/a.md", kind: "added", additions: 1, deletions: 0 },
    ],
    assistantMessageId: `reply-${count}`,
    completedAt: DONE,
  });
  const turnOf = (count: number) => ({
    turnId: `turn-${count}`,
    state: "completed",
    requestedAt: DONE,
    startedAt: DONE,
    completedAt: DONE,
    assistantMessageId: `reply-${count}`,
  });
  /** A thread of `turns` finished turns, each with its question, its reply and its checkpoint. */
  const threadOf = (turns: number, extra: Record<string, unknown> = {}) =>
    makeThread({
      id: "thread-new",
      latestTurn: turns === 0 ? null : turnOf(turns),
      checkpoints: Array.from({ length: turns }, (_, index) => checkpointOf(index + 1)),
      messages: Array.from({ length: turns }, (_, index) => [
        makeMessage({ id: `ask-${index + 1}`, role: "user", text: `질문 ${index + 1}` }),
        makeMessage({ id: `reply-${index + 1}`, role: "assistant", text: `답 ${index + 1}` }),
      ]).flat(),
      ...extra,
    });
  const PATCH = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "+more",
    "",
  ].join("\n");
  const open = (turns: number, extra: Record<string, unknown> = {}, options: Options = {}) => {
    const h = harness(options);
    h.openNewest();
    h.deliver([threadSnapshotItem(threadOf(turns, extra), 3)]);
    return h;
  };
  const scrollback = (h: ReturnType<typeof harness>) => h.commits.map(stripAnsi).join("\n");
  /** Notices are folded to the width; this joins the folded rows back into one line. */
  const flat = (value: string) => value.replace(/\s*\n[│\s]*/gu, " ");

  describe("/diff", () => {
    it("shows the last turn: its files and its patch go to the scrollback", async () => {
      const h = open(2, {}, { diff: PATCH });
      h.typeText("/diff");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([
        { threadId: "thread-new", fromTurnCount: 1, toTurnCount: 2 },
      ]);
      const out = scrollback(h);
      expect(out).toContain("턴 2 변경 · 파일 2개");
      expect(out).toContain("src/a.ts");
      expect(out).toContain("new");
      expect(h.screen()).not.toContain("diff 불러오는 중");
    });

    it("shows one file whose name is Korean, which the patch spells in octal bytes", async () => {
      const octal = (name: string) =>
        `"${[...Buffer.from(name)].map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8)}`)).join("")}"`;
      const path = "문서/한글.md";
      const patch = [
        `diff --git ${octal(`a/${path}`)} ${octal(`b/${path}`)}`,
        `--- ${octal(`a/${path}`)}`,
        `+++ ${octal(`b/${path}`)}`,
        "@@ -1 +1 @@",
        "-옛 내용",
        "+새 내용",
        "",
      ].join("\n");
      const h = open(
        1,
        {
          checkpoints: [
            { ...checkpointOf(1), files: [{ path, kind: "modified", additions: 1, deletions: 1 }] },
          ],
        },
        { diff: patch },
      );
      h.typeText("/diff 1 한글.md");
      h.press(key("enter"));
      await flushMicrotasks();
      const out = scrollback(h);
      expect(out).toContain("턴 1 · 문서/한글.md");
      expect(out).toContain("새 내용");
      expect(out).not.toContain("찾지 못했습니다");
    });

    it("takes the first turn from the start of the thread", async () => {
      const h = open(2, {}, { diff: PATCH });
      h.typeText("/diff 1");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([
        { threadId: "thread-new", fromTurnCount: 0, toTurnCount: 1 },
      ]);
      expect(scrollback(h)).toContain("턴 1 변경");
    });

    it("narrows to one file by its name, and says when the name fits none or several", async () => {
      const h = open(1, {}, { diff: PATCH });
      h.typeText("/diff a.ts");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(scrollback(h)).toContain("턴 1 · src/a.ts");
      h.typeText("/diff nope.ts");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(scrollback(h)).toContain('"nope.ts" 가 없습니다');
      // Neither miss asked the server for anything beyond the one file that matched.
      expect(h.diffRequests).toHaveLength(1);
    });

    it("asks for a longer path when two files end in the name", async () => {
      const twin = (path: string) => ({ path, kind: "modified", additions: 1, deletions: 0 });
      const h = open(1, {
        checkpoints: [{ ...checkpointOf(1), files: [twin("src/a.ts"), twin("lib/a.ts")] }],
      });
      h.typeText("/diff a.ts");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([]);
      expect(flat(scrollback(h))).toContain("해당하는 파일이 여럿입니다: src/a.ts, lib/a.ts");
    });

    it("explains a thread with no checkpoints and asks the server for nothing", async () => {
      const h = open(0);
      h.typeText("/diff");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([]);
      expect(scrollback(h)).toContain("아직 끝난 턴이 없습니다.");
    });

    it("explains a finished turn that never got a checkpoint, as in a folder that is not a repository", async () => {
      const h = open(1, { checkpoints: [] });
      h.typeText("/diff");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(flat(scrollback(h))).toContain("git 이 아닌 폴더");
    });

    it("says the checkpoint is still being made for a turn that has just ended", async () => {
      const h = open(1, { checkpoints: [] });
      h.advance(-3_600_000 + 5_000);
      h.typeText("/diff");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(scrollback(h)).toContain("체크포인트를 만드는 중입니다");
    });

    it("reports the server's refusal and a lost connection differently", async () => {
      const refused = open(1, {}, { diffError: new CommandRejectedError("diff too large") });
      refused.typeText("/diff");
      refused.press(key("enter"));
      await flushMicrotasks();
      expect(scrollback(refused)).toContain("diff 를 불러오지 못했습니다: diff too large");
      expect(flat(scrollback(refused))).not.toContain("연결을 확인하고");
      const lost = open(1, {}, { diffError: new Error("socket closed") });
      lost.typeText("/diff");
      lost.press(key("enter"));
      await flushMicrotasks();
      expect(flat(scrollback(lost))).toContain("socket closed · 연결을 확인하고 다시 시도하세요");
    });

    it("refuses a bad turn number without asking the server", async () => {
      const h = open(1);
      h.typeText("/diff 0");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([]);
      expect(h.screen()).toContain("턴 번호는 1 이상의 숫자입니다");
    });

    it("needs a conversation that exists on the server", async () => {
      const h = harness();
      h.start();
      h.typeText("/diff");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.diffRequests).toEqual([]);
      expect(h.screen()).toContain("아직 시작하지 않은 스레드");
    });
  });

  describe("/diff while the agent answers", () => {
    it("is refused like /history, since the report would end up in the middle of the reply", () => {
      const h = open(2, { session: makeSession("running", { threadId: "thread-new" }) });
      h.typeText("/diff");
      h.press(key("enter"));
      expect(h.screen()).toContain("답변이 진행 중입니다");
      expect(h.diffRequests).toEqual([]);
    });
  });

  describe("/undo", () => {
    const undoCommand = (h: ReturnType<typeof harness>) =>
      h.dispatched.find((command) => command.type.endsWith(".revert"));

    it("is refused while a turn runs, before it shows anything", () => {
      const h = open(2, { session: makeSession("running", { threadId: "thread-new" }) });
      h.typeText("/undo");
      h.press(key("enter"));
      expect(h.screen()).toContain("작업 중에는 되돌릴 수 없습니다");
      expect(h.screen()).not.toContain("마지막 턴 되돌리기");
    });

    it("shows what would go first, and cancels by default", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      const screen = flat(h.screen());
      expect(screen).toContain("마지막 턴 되돌리기");
      expect(screen).toContain("턴 2: 질문 2");
      expect(screen).toContain("파일 2개 (+3 -1)");
      expect(screen).toContain("대화");
      expect(screen).toContain("다시 되돌리는 기능은 데스크톱 앱에도 없습니다");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
    });

    it("cancels on Esc", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("escape"));
      await flushMicrotasks();
      expect(h.dispatched).toEqual([]);
      expect(h.screen()).not.toContain("마지막 턴 되돌리기");
    });

    it("restores the files and the conversation to the turn before, then marks the scrollback and gives the question back", async () => {
      const h = open(3, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toMatchObject({
        type: "thread.checkpoint.revert",
        threadId: "thread-new",
        turnCount: 2,
      });
      // The server answers by rewinding the thread: one turn fewer.
      h.deliver([threadSnapshotItem(threadOf(2, { worktreePath: "/work/app-wt" }), 4)]);
      const out = scrollback(h);
      expect(out).toContain("턴 3부터 되돌림 · 대화는 턴 2까지 남았습니다");
      expect(out).toContain("파일: 턴 2 이 끝난 상태로 복원했습니다.");
      expect(h.screen()).toContain("질문 3");
      // It is shown once.
      const marks = out.split("되돌림 ·").length;
      h.deliver([threadSnapshotItem(threadOf(2, { worktreePath: "/work/app-wt" }), 5)]);
      expect(scrollback(h).split("되돌림 ·").length).toBe(marks);
    });

    it("rewinds only the conversation on request, and leaves the files", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toMatchObject({ type: "thread.conversation.revert", turnCount: 1 });
      h.deliver([threadSnapshotItem(threadOf(1, { worktreePath: "/work/app-wt" }), 4)]);
      expect(scrollback(h)).toContain("파일: 그대로 두었습니다.");
    });

    it("offers no file restore in a folder the thread shares, and says why", async () => {
      const h = open(2);
      h.typeText("/undo");
      h.press(key("enter"));
      const screen = flat(h.screen());
      expect(screen).toContain("함께 쓰므로 파일 복원은 지원되지 않습니다");
      expect(screen).not.toContain("파일과 대화 되돌리기");
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toMatchObject({ type: "thread.conversation.revert", turnCount: 1 });
    });

    it("goes back to before the first turn when that is the only one", async () => {
      const h = open(1, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toMatchObject({ type: "thread.checkpoint.revert", turnCount: 0 });
    });

    it("explains a thread with no checkpoints, a turn still being captured, and a provider that cannot roll back", () => {
      const none = open(0);
      none.typeText("/undo");
      none.press(key("enter"));
      expect(scrollback(none)).toContain("아직 끝난 턴이 없습니다.");
      const fresh = open(1, { checkpoints: [] });
      fresh.advance(-3_600_000 + 5_000);
      fresh.typeText("/undo");
      fresh.press(key("enter"));
      expect(scrollback(fresh)).toContain("체크포인트를 만드는 중입니다");
      const unsupported = open(
        1,
        {},
        {
          config: makeConfig({
            providers: [
              {
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                enabled: true,
                installed: true,
                supportsConversationRollback: false,
                models: [],
              },
            ],
          }),
        },
      );
      unsupported.typeText("/undo");
      unsupported.press(key("enter"));
      expect(scrollback(unsupported)).toContain("Codex 는 대화 되돌리기를 지원하지 않습니다");
      expect(unsupported.screen()).not.toContain("마지막 턴 되돌리기");
    });

    it("holds new messages while the undo is on its way", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      h.typeText("바로 다음 질문");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.filter((command) => command.type === "thread.turn.start")).toEqual([]);
      expect(h.screen()).toContain("되돌리는 중입니다");
    });

    it("tells when the server could not do it, and that the conversation is as it was", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      h.deliver([
        threadSnapshotItem(
          threadOf(2, {
            worktreePath: "/work/app-wt",
            activities: [
              makeActivity({
                id: "revert-failed",
                kind: "checkpoint.revert.failed",
                tone: "error",
                payload: { detail: "restore failed" },
              }),
            ],
          }),
          4,
        ),
      ]);
      const out = flat(scrollback(h));
      expect(out).toContain("되돌리지 못했습니다");
      expect(out).toContain("대화는 그대로입니다. 파일 상태는 /diff 로 확인하고");
      expect(out).not.toContain("되돌림 ·");
      // The wait is over: a message can go again.
      h.typeText("다시");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.some((command) => command.type === "thread.turn.start")).toBe(true);
    });

    it("stops waiting and says so when the request itself failed", async () => {
      const h = open(
        2,
        { worktreePath: "/work/app-wt" },
        {
          dispatch: async () => {
            throw new CommandRejectedError("server said no");
          },
        },
      );
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(scrollback(h)).toContain("server said no");
      h.typeText("다시");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.screen()).not.toContain("되돌리는 중입니다");
    });

    it("marks the scrollback when another client rewinds the thread", () => {
      const h = open(3);
      h.deliver([threadSnapshotItem(threadOf(1), 4)]);
      const out = scrollback(h);
      expect(out).toContain("턴 3부터 되돌림 · 대화는 턴 1까지 남았습니다");
      // Nothing was asked of this client, so no question is put in the composer.
      expect(h.screen()).not.toContain("질문 3");
    });

    it("does not offer to undo what the thread no longer has", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      // Another client rewinds while the confirmation is open.
      h.deliver([threadSnapshotItem(threadOf(1, { worktreePath: "/work/app-wt" }), 4)]);
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toBeUndefined();
      expect(h.screen()).toContain("대화가 바뀌어 취소했습니다");
    });

    it("does not carry out a choice whose file restore the thread no longer allows", async () => {
      const h = open(2, { worktreePath: "/work/app-wt" });
      h.typeText("/undo");
      h.press(key("enter"));
      // The thread loses its own folder while the confirmation is open.
      h.deliver([threadSnapshotItem(threadOf(2), 4)]);
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      expect(undoCommand(h)).toBeUndefined();
      expect(h.screen()).toContain("대화가 바뀌어 취소했습니다");
    });

    it("lets go of a send that failed: its command is not sent again after the thread was rewound", async () => {
      const attempts: ClientOrchestrationCommand[] = [];
      const h = open(
        2,
        { worktreePath: "/work/app-wt" },
        {
          dispatch: async (command) => {
            attempts.push(command);
            if (attempts.length === 1) throw new Error("끊김");
          },
        },
      );
      h.typeText("같은 말");
      h.press(key("enter"));
      await flushMicrotasks();
      h.press(ctrl("u"));
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("down"), key("enter"));
      await flushMicrotasks();
      h.deliver([threadSnapshotItem(threadOf(1, { worktreePath: "/work/app-wt" }), 4)]);
      h.press(ctrl("u"));
      h.typeText("같은 말");
      h.press(key("enter"));
      await flushMicrotasks();
      const starts = attempts.filter((command) => command.type === "thread.turn.start");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.commandId).not.toBe(starts[0]?.commandId);
    });

    it("keeps /implement from starting a turn while the undo is on its way", async () => {
      const plan = {
        id: "plan-1",
        turnId: "turn-2",
        planMarkdown: "# 계획\n\n- 하나",
        createdAt: DONE,
        updatedAt: DONE,
        implementedAt: null,
        implementationThreadId: null,
      };
      const h = open(2, {
        worktreePath: "/work/app-wt",
        interactionMode: "plan",
        proposedPlans: [plan],
      });
      h.typeText("/undo");
      h.press(key("enter"));
      h.press(key("down"), key("enter"));
      await flushMicrotasks();
      h.typeText("/implement");
      h.press(key("enter"));
      await flushMicrotasks();
      expect(h.dispatched.filter((command) => command.type === "thread.turn.start")).toEqual([]);
      expect(h.screen()).toContain("되돌리는 중입니다");
    });

    it("is refused while the turn of a queued message is starting", async () => {
      const h = open(2, {
        worktreePath: "/work/app-wt",
        session: makeSession("running", { threadId: "thread-new" }),
      });
      h.typeText("둘째");
      h.press(key("enter"));
      h.deliver([
        threadSnapshotItem(
          threadOf(2, {
            worktreePath: "/work/app-wt",
            session: makeSession("ready", { threadId: "thread-new", updatedAt: "after" }),
          }),
          4,
        ),
      ]);
      await flushMicrotasks();
      h.typeText("/undo");
      h.press(key("enter"));
      expect(h.screen()).toContain("작업 중에는 되돌릴 수 없습니다");
      expect(h.screen()).not.toContain("마지막 턴 되돌리기");
    });

    describe("with messages waiting in the queue", () => {
      const WT = { worktreePath: "/work/app-wt" };
      const resting = (turns = 2) =>
        threadOf(turns, {
          ...WT,
          session: makeSession("ready", { threadId: "thread-new", updatedAt: "after" }),
        });
      const turnStarts = (attempts: ClientOrchestrationCommand[]) =>
        attempts.flatMap((command) =>
          command.type === "thread.turn.start" ? [command.message.text] : [],
        );
      /** Two finished turns and one message that could not be sent, so the queue waits, stopped. */
      const stopped = async () => {
        const attempts: ClientOrchestrationCommand[] = [];
        const refuse = { turns: true };
        const h = open(
          2,
          { ...WT, session: makeSession("running", { threadId: "thread-new" }) },
          {
            dispatch: async (command) => {
              attempts.push(command);
              if (command.type === "thread.turn.start" && refuse.turns) throw new Error("끊김");
            },
          },
        );
        h.typeText("둘째");
        h.press(key("enter"));
        h.deliver([threadSnapshotItem(resting(), 4)]);
        await flushMicrotasks();
        expect(h.screen()).toContain("대기 1건");
        return { h, attempts, refuse };
      };
      const confirmFiles = (h: ReturnType<typeof harness>) => {
        h.typeText("/undo");
        h.press(key("enter"));
        h.press(key("down"), key("enter"));
      };

      it("is not let go by an empty Enter before the undo has answered", async () => {
        const { h, attempts } = await stopped();
        confirmFiles(h);
        await flushMicrotasks();
        expect(attempts.some((command) => command.type.endsWith(".revert"))).toBe(true);
        h.press(key("enter"));
        await flushMicrotasks();
        expect(turnStarts(attempts)).toEqual(["둘째"]);
        expect(h.screen()).toContain("되돌리는 중입니다");
      });

      it("gives the queue back to the composer with the question when the undo is done", async () => {
        const { h, attempts, refuse } = await stopped();
        confirmFiles(h);
        await flushMicrotasks();
        h.deliver([threadSnapshotItem(resting(1), 5)]);
        expect(h.screen()).not.toContain("대기 1건");
        const typed = h.screen();
        expect(typed).toContain("질문 2");
        expect(typed).toContain("둘째");
        // The question comes first, as it was asked first.
        expect(typed.indexOf("질문 2")).toBeLessThan(typed.indexOf("둘째"));
        refuse.turns = false;
        h.press(key("enter"));
        await flushMicrotasks();
        expect(turnStarts(attempts)).toEqual(["둘째", "질문 2\n\n둘째"]);
      });

      it("still gives the queue back when the undo finished while the user was in another thread", async () => {
        const { h, attempts } = await stopped();
        confirmFiles(h);
        await flushMicrotasks();
        h.typeText("/threads");
        h.press(key("enter"));
        // Longer than an undo is waited for in the thread: the answer is still read on the way back.
        h.advance(120_000);
        h.press(key("down"), key("enter"));
        // An Enter before the thread has loaded must not let the old message go either.
        h.press(key("enter"));
        h.deliver([threadSnapshotItem(resting(1), 6)]);
        await flushMicrotasks();
        expect(h.screen()).not.toContain("대기 1건");
        expect(h.screen()).toContain("둘째");
        expect(turnStarts(attempts)).toEqual(["둘째"]);
      });

      it("says on the confirmation that the queue goes back to the composer", async () => {
        const { h } = await stopped();
        h.typeText("/undo");
        h.press(key("enter"));
        expect(flat(h.screen())).toContain("대기 중인 메시지 1건은 입력창으로 돌아옵니다");
      });
    });

    describe("on another thread", () => {
      it("does not hold a message for a thread the undo is not on", async () => {
        const h = open(2, { worktreePath: "/work/app-wt" });
        h.typeText("/undo");
        h.press(key("enter"));
        h.press(key("down"), key("enter"));
        await flushMicrotasks();
        h.typeText("/threads");
        h.press(key("enter"));
        h.press(key("down"), key("down"), key("enter"));
        h.deliver([threadSnapshotItem(makeThread({ id: "thread-old" }), 3)]);
        h.typeText("다른 스레드 질문");
        h.press(key("enter"));
        await flushMicrotasks();
        const started = h.dispatched.filter((command) => command.type === "thread.turn.start");
        expect(started).toMatchObject([{ threadId: "thread-old" }]);
      });
    });
  });

  describe("the lists", () => {
    it("has both commands in the slash menu", () => {
      const diff = open(1);
      diff.typeText("/di");
      expect(diff.screen()).toContain("/diff");
      const undo = open(1);
      undo.typeText("/und");
      expect(undo.screen()).toContain("/undo");
    });

    it("explains both in the help", () => {
      const h = open(1);
      h.typeText("/help");
      h.press(key("enter"));
      const help = flat(scrollback(h));
      expect(help).toContain("/diff <턴번호> 로 다른 턴");
      expect(help).toContain("/undo 는 마지막 턴을 대화에서 지웁니다");
    });
  });
});

describe("in English", () => {
  /** The screen with the rail glyphs and line folds read as single spaces. */
  const flat = (h: ReturnType<typeof harness>) =>
    h
      .screen()
      .replace(/내 프로젝트/gu, "Project")
      .replace(/[│▲◆└┌\s]+/gu, " ");

  beforeEach(() => setLanguage("en"));
  afterEach(() => setLanguage("ko"));

  it("writes /help in English and mentions the language setting", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/help");
    h.press(key("enter"));
    const help = h.commits.join("\n");
    expect(help).toContain("Commands");
    expect(help).toContain("Pick a model");
    expect(help).toContain("Undo the last turn");
    expect(help).toContain("oop config set language en|ko");
    expect(help.replace(/내 프로젝트/gu, "")).not.toMatch(/[가-힣]/u);
  });

  it("labels the composer in English", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    expect(flat(h)).toContain("Message");
    expect(flat(h)).toContain("e.g. add a function to hello.ts · / for commands");
    expect(flat(h)).not.toMatch(/[가-힣]/u);
  });

  it("says why a command cannot run, in English", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/mode bogus");
    h.press(key("enter"));
    expect(flat(h)).toContain("Unknown permission mode: bogus");
    h.press(key("escape"));
    h.typeText("/undo");
    h.press(key("enter"));
    expect(flat(h)).toContain("has not started yet");
  });

  it("opens the permission mode list with English labels", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/mode");
    h.press(key("enter"));
    expect(flat(h)).toContain("Permission mode");
    expect(flat(h)).toContain("Auto-accept edits");
    expect(flat(h)).toContain("Allows commands and edits without asking.");
  });

  it("holds an unknown slash message with the way to send it anyway", () => {
    const h = harness();
    h.start();
    h.press(key("enter"));
    h.typeText("/nosuchthing");
    h.press(key("enter"));
    expect(flat(h)).toContain("Unknown command: /nosuchthing");
    expect(flat(h)).toContain("start with a space");
  });
});
