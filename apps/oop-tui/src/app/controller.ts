import {
  DEFAULT_THREAD_GOAL_MAX_CONTINUES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ClientOrchestrationCommand,
  type CrewRole,
  type CrewSettings,
  OrchestrationProposedPlanId,
  OrchestrationThread,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderApprovalOption,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
  ThreadGoal,
  ThreadId,
} from "@t3tools/contracts";

import {
  buildPlanImplementationPrompt,
  deriveActivePlanState,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  type ActivePlanState,
  type LatestProposedPlanState,
} from "@t3tools/client-runtime/thread-plan";
import { resolveCrew } from "@t3tools/shared/crew";

import {
  backspace,
  deleteForward,
  deleteWordBack,
  editorFromText,
  editorText,
  emptyEditor,
  insertNewline,
  insertText,
  killToLineEnd,
  killToLineStart,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  type EditorState,
} from "../input/editor.ts";
import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame, Scheduler } from "../render/liveRegion.ts";
import type { SplitControl } from "../render/regionSwitch.ts";
import { renderTasksPane, tasksPaneRows, type TasksContent } from "../render/tasksPane.ts";
import {
  defaultApprovalOptions,
  renderApprovalPanel,
  renderQuestionPanel,
  requestKindLabel,
} from "../render/panels.ts";
import {
  RAIL_COLUMNS,
  railActive,
  railCancelled,
  railDone,
  railEnd,
  railGap,
  railNote,
  railRow,
  railStartRows,
  railWrap,
  type Rail,
  type RailTone,
} from "../render/rail.ts";
import { renderBanner } from "../render/banner.ts";
import { crewBarText, roleName } from "../render/crewBoard.ts";
import {
  composeHome,
  fitHome,
  highlightMark,
  homeNaturalRows,
  type HomeInput,
} from "../render/home.ts";
import { defaultTicker, STATIC_TICK_MS, type Ticker } from "../render/spinner.ts";
import type { StatusBarInput } from "../render/statusBar.ts";
import type { Style } from "../render/style.ts";
import { diffReportRows, matchFiles } from "../render/diffReport.ts";
import { renderStats, statsToolNames } from "../render/statsView.ts";
import { SPINNER_INTERVAL_MS, type Symbols, UNICODE_SYMBOLS } from "../render/symbols.ts";
import type { StatusLineSetting, ThemeSwitcher } from "../settings.ts";
import { deriveThreadStatus, type ThreadStatus } from "../state/threadStatus.ts";
import { TranscriptPrinter } from "../state/transcript.ts";
import { graphemesOf, sanitizeForTerminal } from "../text/width.ts";
import { wrapStyled, wrapWithPrefix } from "../text/wrap.ts";
import type { LinkStatus } from "../link/client.ts";
import type { ThreadMirrorState } from "../link/threadMirror.ts";
import { CommandRejectedError } from "../link/transport.ts";
import {
  approvalCommand,
  availableModels,
  noModelCause,
  noModelNotice,
  providersPending,
  type CommandContext,
  compatibleModels,
  defaultModelSelection,
  dismissUserInputCommand,
  interactionModeCommand,
  interruptCommand,
  modelSelectionOf,
  type ModelChoice,
  newThreadId,
  pinCommand,
  revertCommand,
  runtimeModeCommand,
  turnStartCommand,
  unpinCommand,
  userInputCommand,
  withoutBootstrap,
} from "./commands.ts";
import {
  checkpointGapText,
  diffTurn,
  parseDiffArgs,
  turnCountOf,
  undoPlan,
  type UndoPlan,
} from "./checkpoints.ts";
import { parseSlash } from "./commandsRouter.ts";
import {
  addHistoryPage,
  HISTORY_MAX,
  historyLeft,
  openHistoryPool,
  parseHistoryCount,
  takeHistoryBatch,
  type HistoryPool,
} from "./history.ts";
import { appendToSearch, eraseFromSearch } from "./listSearch.ts";
import {
  filterProjects,
  isPinned,
  threadRowLabel,
  threadRows,
  topPinOrderKey,
} from "./threadList.ts";
import { unknownSlash } from "./unknownSlash.ts";
import {
  applyCrewChange,
  crewAsDefault,
  crewBrainProblem,
  crewEnabledFor,
  crewPickItems,
  crewSettingsOf,
  parseCrewPreset,
  parseCrewRole,
  PRESETS,
  presetLabel,
  presetWords,
  type CrewChange,
} from "./crew.ts";
import {
  crewSubThreadLabel,
  deriveCrewBoard,
  isCrewSubThread,
  waitingCrewThreads,
  waitingText,
  type CrewBoard,
  type CrewTask,
  type WaitingCrewThread,
} from "./crewBoard.ts";
import {
  crewContext,
  crewFrame,
  crewKey,
  openCrewView,
  openModelView,
  type CrewContext,
  type CrewEffect,
  type CrewView,
} from "./crewScreen.ts";
import {
  effortControl,
  effortStillValid,
  noEffortReason,
  resolveEffort,
  withPromptEffort,
  type EffortControl,
} from "./effort.ts";
import {
  goalBarText,
  goalStateWord,
  goalsWith,
  goalsWithout,
  goalViewOf,
  makeGoal,
  parseGoalMax,
  GOAL_MAX_CONTINUES_RANGE,
  type GoalView,
} from "./goal.ts";
import { filterModels } from "./modelSearch.ts";
import {
  isThreadRunning,
  projectForDirectory,
  realDirectory,
  relativeTime,
  sortedProjects,
  threadsOfProject,
} from "./projects.ts";
import {
  parseRuntimeMode,
  RUNTIME_MODES,
  runtimeModeLabel,
  runtimeModeWords,
} from "./runtimeMode.ts";
import { createSettingsPatcher } from "./settingsPatch.ts";
import {
  matchSlashCommands,
  SLASH_COMMANDS,
  slashQuery,
  type SlashCommand,
} from "./slashCommands.ts";
import { ProviderFlow } from "./providerFlow.ts";
import { undoChoices, undoItems, undoSummary, UndoTracker, type UndoOutcome } from "./undoFlow.ts";
import { EMPTY_AGENTS_VIEW, LOADING_AGENTS_VIEW, type AgentsView } from "./agentsPanel.ts";
import { offElsewhereNotice, PANEL_USAGE, planPanelMove, SidePanel } from "./sidePanel.ts";
import { nextStopStep } from "./stopConfirm.ts";
import { agentModelOf, parseFlowAction, type PanelView } from "./workflowPanel.ts";
import { editPromptText } from "./textPrompt.ts";
import {
  buildUpdateReport,
  isReleaseVersion,
  LISTED_HIGHLIGHTS,
  listedReleases,
  releaseTitle,
  terminalBehindText,
  terminalIsBehind,
  updateHowTo,
  type CheckUpdate,
  type LatestRelease,
} from "./updateCheck.ts";
import {
  composerHeight,
  linkNotice,
  noticeLine,
  noticeRows,
  renderChat,
  renderPicker,
  renderTextPrompt,
  type PickerItem,
  type QueueView,
  type SlashMenuItem,
  type SlashMenuView,
} from "./view.ts";
import type { HeldSlash } from "./unknownSlash.ts";
import { MessageQueue, type TurnMark } from "./messageQueue.ts";
import {
  matchProviderEntries,
  providerSlashEntries,
  type ProviderSlashEntry,
} from "./providerSlash.ts";
import { WorkspaceLists } from "./workspaceLists.ts";
import { t } from "../i18n/index.ts";

/** The slice of the link the controller needs; a fake stands in for it in tests. */
export interface ControllerLink {
  readonly status: LinkStatus;
  readonly shell: OrchestrationShellSnapshot | null;
  readonly config: ServerConfig | null;
  readonly thread: ThreadMirrorState;
  readonly openThread: (threadId: ThreadId) => void;
  readonly closeThread: () => void;
  readonly dispatch: (command: ClientOrchestrationCommand) => Promise<void>;
  readonly getSettings: () => Promise<ServerSettings>;
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  readonly refreshProviders: (input?: {
    readonly instanceId?: string;
    readonly cwd?: string;
    readonly refreshModels?: boolean;
  }) => Promise<ReadonlyArray<ServerProvider>>;
  readonly retryCrewTask: (input: {
    readonly leadThreadId: ThreadId;
    readonly taskId: string;
  }) => Promise<void>;
  readonly loadOlderTurns: (
    threadId: ThreadId,
    beforeCursor: string,
  ) => Promise<OrchestrationThreadDetailSnapshot>;
  readonly getCheckpointDiff: (input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }) => Promise<string>;
}

export interface ControllerRegion {
  readonly set: (frame: RegionFrame) => void;
  readonly commit: (lines: ReadonlyArray<string>) => void;
  readonly usableColumns: () => number;
  readonly maxRows: () => number;
  readonly abandon: () => void;
  /** PageUp and PageDown scroll the conversation of the side-by-side layout; the inline one leaves that to the terminal. */
  readonly scrollUp?: () => void;
  readonly scrollDown?: () => void;
  /** Called on input other than PageUp and PageDown: a scrolled conversation goes back to the newest line. */
  readonly follow?: () => void;
}

export interface ControllerDeps {
  readonly link: ControllerLink;
  readonly region: ControllerRegion;
  /** Moves between the inline layout and the one with the side panel; without it there is no `/dag-workflow` or `/dag-agents`. */
  readonly split?: SplitControl;
  readonly style: Style;
  /** What `/theme` lists and switches; without it `/theme` is just a message for the agent. */
  readonly themes?: ThemeSwitcher;
  readonly symbols?: Symbols;
  /** False when the user turned animations off (settings `animations`, OOP_ANIMATIONS=0). */
  readonly animations?: boolean;
  /** Settings `statusLine`; "auto" when absent. */
  readonly statusLine?: StatusLineSetting;
  /** Settings `notify`: ring the terminal bell when a turn finishes or waits for an approval or an answer. */
  readonly notify?: boolean;
  /** Repeats a call while a turn runs; the spinner and the elapsed time hang off it. */
  readonly ticker?: Ticker;
  /** Reaches the terminal's title and bell. Absent where neither should be touched (no colour, no tty). */
  readonly terminal?: {
    readonly setTitle: (title: string) => void;
    /** Gives the terminal the title it had before the first `setTitle`. */
    readonly restoreTitle: () => void;
    readonly bell: () => void;
  };
  /** The user's home folder, shown as `~` in the status bar. */
  readonly home?: string;
  /** `host:port` of the server, said once when the connection is up. Absent: the step is left out. */
  readonly server?: string | null;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly context: CommandContext;
  readonly schedule: Scheduler;
  readonly now: () => number;
  /** Runtime mode for threads created here. */
  readonly runtimeMode: RuntimeMode;
  readonly continueLast: boolean;
  /** The message from `oop "..."`: sent as soon as the conversation it belongs to is open. */
  readonly prompt?: string | null;
  readonly exit: () => void;
  /** Hands the terminal back to the shell (Ctrl-Z); absent where the platform cannot suspend. */
  readonly suspend?: () => void;
  /** Maps a path to its real path so a symlinked workspace still matches; defaults to the file system. */
  readonly canonical?: (path: string) => string;
  /**
   * The start screen and the update lookup. Without it the app opens straight into its lists and
   * there is no `/update`.
   */
  readonly startup?: {
    /** Settings `banner`: whether the wordmark is on the start screen and the one-line banner stays after it. */
    readonly banner: boolean;
    /** Version of this terminal app. */
    readonly version: string;
    readonly checkUpdate: CheckUpdate;
  };
}

interface ChatScreen {
  readonly kind: "chat";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  isDraft: boolean;
  readonly printer: TranscriptPrinter;
  partial: ReadonlyArray<string>;
  status: ThreadStatus | null;
  loaded: boolean;
  /** Local time of the last thread update from the server; how long a turn has been quiet. */
  lastEventAt: number | null;
  /** Local time this client first saw the turn running; the fallback when the server's start time is unusable. */
  turnSeenAt: number | null;
  planCollapsed: boolean;
  /** Older conversation `/history` reads from; opened by the first use and kept while the thread is on screen. */
  history: HistoryPool | null;
  /** A `/history` is fetching older turns; a second one waits for it. */
  historyBusy: boolean;
  /** Turns the thread had at the last sync: a drop means the server rewound it. Null before the first. */
  turnCount: number | null;
}

/** The `/stats` screen: which tab is up and which tool is picked on the tool tab, by name. */
interface StatsScreen {
  tab: 0 | 1 | 2;
  selected: string | null;
}

type Screen =
  | { kind: "loading" }
  | { kind: "projects"; selected: number; query: string }
  | {
      kind: "threads";
      projectId: ProjectId;
      selected: number;
      query: string;
      /** A thread just pinned or unpinned: the pointer goes with it when the list is reordered. */
      follow: { readonly id: string; readonly pinned: boolean } | null;
    }
  | ChatScreen;

interface QuestionDraft {
  readonly requestId: string;
  index: number;
  readonly answers: Record<string, string | string[]>;
  /** The last answer as typed, given back to the composer if the server refuses the reply. */
  sent: string;
}

const HISTORY_MESSAGES = 30;
const DOUBLE_CTRL_C_MS = 2000;
const FAILED_REPLY_KINDS = new Set([
  "provider.approval.respond.failed",
  "provider.user-input.respond.failed",
]);
const HISTORY_LIMIT = 100;
/** What the empty composer suggests: a thing to ask, and that `/` lists the commands. */
const composerPlaceholder = (): string => t("session.c.placeholder");
const TITLE_LIMIT = 80;
/** Rows a project or thread list keeps for itself under the start screen, when the terminal has them. */
const MIN_LIST_ROWS = 12;
/** The notice `/update` leaves until the lookup answers. */
const checkingNotice = (): string => t("session.c.checkingUpdate");
const historyLoadingNotice = (): string => t("session.c.historyLoading");
/** The notice an interrupt leaves until the turn it stopped is gone; the `■ Interrupted` line replaces it. */
const interruptNotice = (): string => t("session.c.interruptRequested");
/** How long a start sent from the queue is waited for to show in the thread, before the next may go. */
const TURN_START_WAIT_MS = 15_000;
const startWaitNotice = (): string => t("session.c.startWait");
/** The composer of a crew task's own thread: messages are not sent from here. */
const crewSubPlaceholder = (): string => t("session.c.crewSubPlaceholder");

/**
 * The list `/model`, `/theme`, `/mode` or `/effort` opened over the chat; the themes and the effort
 * values are read once, when it opens. `/model` also takes typed letters, which narrow the list.
 */
type ListPicker =
  | { readonly kind: "model"; selected: number; query: string }
  | { readonly kind: "theme"; selected: number; readonly names: ReadonlyArray<string> }
  | { readonly kind: "mode"; selected: number }
  | { readonly kind: "effort"; selected: number; readonly control: EffortControl }
  | { readonly kind: "undo"; selected: number; readonly plan: UndoPlan };

/** The question typed in a full-screen field: for now only the goal. */
interface PromptScreen {
  readonly kind: "goal";
  editor: EditorState;
}

/**
 * A mode picked for the thread but not yet true on the server. For a thread that exists it is sent
 * at once when the thread is idle (`reserved` false, kept until the thread list shows it), or held
 * for the next turn while one runs (`reserved` true).
 */
interface ModeIntent<T> {
  readonly value: T;
  readonly reserved: boolean;
}

/** How a command ended: the server took it, refused it outright, or it is not known what happened. */
type Outcome = "sent" | "rejected" | "failed";

const sameModel = (
  left: { readonly instanceId: string; readonly model: string },
  right: { readonly instanceId: string; readonly model: string },
): boolean => left.instanceId === right.instanceId && left.model === right.model;

/** Server text for a field that stays on one row: a line feed in it cannot start a row of its own. */
const flatten = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

export class AppController {
  private readonly deps: ControllerDeps;
  private screen: Screen = { kind: "loading" };
  private editor: EditorState = emptyEditor;
  private history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";
  private notice: string | null = null;
  private modelOverride: ModelChoice | null = null;
  private picker: ListPicker | null = null;
  /** A typed question over the chat (`/goal` with no goal yet); it has every key until closed. */
  private prompt: PromptScreen | null = null;
  /** Permission mode and plan mode picked for this thread, until the server's own values show them. */
  private runtimeIntent: ModeIntent<RuntimeMode> | null = null;
  private interactionIntent: ModeIntent<ProviderInteractionMode> | null = null;
  /** The reasoning effort picked with `/effort`; it belongs to the model on screen. */
  private effortPick: string | null = null;
  /** Goal progress for the activities last read, so a repaint does not read them all again. */
  private goalMemo: {
    readonly activities: unknown;
    readonly goalId: string;
    readonly hasOlder: boolean;
    readonly view: GoalView;
  } | null = null;
  /** Reads the settings, builds a patch from them, sends it; one at a time. */
  private readonly patchSettings: ReturnType<typeof createSettingsPatcher>;
  /** The `/undo` this client has sent and is waiting for the server to carry out. */
  private readonly undo = new UndoTracker();
  /** A `/diff` is being read from the server, so a second one waits for it. */
  private diffBusy = false;
  /** The `/stats` screen while it is open; it replaces the chat until `q` or Esc. */
  private stats: StatsScreen | null = null;
  /** The `/crew` screen while it is open; it replaces the chat and has every key until it is closed. */
  private crewView: CrewView | null = null;
  /** `/provider`: adds and removes provider instances; its screens replace the chat while open. */
  private readonly provider: ProviderFlow;
  /** `/dag-workflow` and `/dag-agents`: the side panel's view, its pick and the work of drawing it. */
  private readonly sidePanel = new SidePanel();
  /** The side panel is open; the alternate screen may also be up for the task list alone. */
  private panelOpen = false;
  /** `/tasks`: the task list is shown under the conversation. */
  private tasksOn = false;
  /** The task list for the activities last read, so a repaint does not sort them all again. */
  private activePlanMemo: {
    readonly activities: unknown;
    readonly turnId: unknown;
    readonly plan: ActivePlanState | null;
  } | null = null;
  /** The crew board for the activities last read, so a repaint does not read them all again. */
  private crewBoardMemo: {
    readonly activities: unknown;
    readonly session: unknown;
    readonly latestTurn: unknown;
    readonly running: boolean;
    readonly board: CrewBoard | null;
  } | null = null;
  /** The crew threads waiting for the user, for the thread list last read. */
  private crewWaitMemo: {
    readonly threads: unknown;
    readonly leadId: string;
    readonly waiting: ReadonlyArray<WaitingCrewThread>;
  } | null = null;
  /** A crew stop or retry is on its way, so a second key cannot send it twice. */
  private crewBusy = false;
  /** The chat a list was opened from with `/projects` or `/threads`; Esc goes back to it. */
  private listedFrom: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    /** The thread was a draft, so Esc opens it again as the same draft, not as another one. */
    readonly isDraft: boolean;
    /** What was picked for it; a draft has them nowhere else, and they are still what Esc shows. */
    readonly choices: {
      readonly modelOverride: ModelChoice | null;
      readonly effortPick: string | null;
      readonly runtimeIntent: ModeIntent<RuntimeMode> | null;
      readonly interactionIntent: ModeIntent<ProviderInteractionMode> | null;
    };
  } | null = null;
  /** Which command the slash menu has under the arrow, and the text Esc closed the menu for. */
  private menuIndex = 0;
  private menuClosedFor: string | null = null;
  /** The setup rail (`┌ OOP Terminal`) has been drawn, so leaving closes it. */
  private railOpen = false;
  /** `■ Interrupted` is already in the scrollback for the turn that is running. */
  private interruptShown = false;
  /** Esc or Ctrl-C asked to stop the turn that runs: its end is the user's own doing, not news. */
  /** The thread whose turn the user stopped with Esc and that has not come to rest yet. */
  private stopRequested: ThreadId | null = null;
  private questionDraft: QuestionDraft | null = null;
  private responding: string | null = null;
  /** Failed-reply activities that already existed when the current reply was sent. */
  private respondingBaseline: ReadonlySet<string> = new Set();
  private lastCtrlC: number | null = null;
  /** When Stop last warned that background agents would end with it; the next press inside the window confirms. */
  private stopWarnedAt: number | null = null;
  private lastPhase: LinkStatus["phase"] | null = null;
  /**
   * What the keys have picked in the approval panel. Only Enter sends it, and it belongs to one
   * request: a new panel starts with nothing picked. Typing that is not an option locks the numbers
   * (the user was writing a sentence), and only the arrows unlock them. A panel that opens over a
   * draft, or replaces a locked panel, starts locked for the same reason.
   */
  private approvalChoice: {
    readonly requestId: string;
    readonly index: number | null;
    readonly locked: boolean;
  } | null = null;
  /** The panel on screen (an approval or a question), and the draft that was in the composer before it. */
  private panelKey: string | null = null;
  /** Some screen was open at the last redraw, and a key is being handled now (for `trackPanel`). */
  private overlayWasOpen = false;
  private handlingKey = false;
  private stashedDraft: EditorState | null = null;
  /**
   * A turn whose delivery is unknown (the link broke while sending), kept whole so a resend carries
   * the same ids. A refusal is not kept: the server did not take it, so the next try is a new command.
   */
  private failedSend: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly text: string;
    readonly command: ClientOrchestrationCommand;
  } | null = null;
  private readonly realPaths = new Map<string, string>();
  /** Messages typed while a turn runs, per thread; they go out one by one once it is over. */
  private readonly queue = new MessageQueue();
  private sending = false;
  /** Requests (`approval:<id>`, `input:<id>`) the bell has already been rung for. */
  private readonly rungFor = new Set<string>();
  /** Drafts whose first message has been sent: their goal belongs to a thread now being created. */
  private readonly startedDrafts = new Set<ThreadId>();
  private syncScheduled = false;
  private disposed = false;
  /** Runs only while a turn does; null otherwise, so an idle app has no timer at all. */
  private stopTicker: (() => void) | null = null;
  /** The one-second timer for the Agents panel's clocks alone, while the spinner's timer is not running. */
  private stopPanelClock: (() => void) | null = null;
  /**
   * The one timer that wakes the queue when the turn of the message it just sent has not shown by
   * `TURN_START_WAIT_MS`; it exists only while the screen's thread is waiting for that turn.
   */
  private startWait: { readonly due: number; readonly stop: () => void } | null = null;
  private tick = 0;
  private lastTitle: string | null = null;
  /**
   * The start screen is up while this is set: the frame is the home with the current screen at its
   * foot, and scrollback output that belongs to getting into a conversation waits in `held`. It is
   * cleared for good by the first thing that is not that, and never set again.
   */
  private landing: { readonly held: string[]; setupEndAt: number | null } | null;
  /** The newest release as the last lookup found it. */
  private latest: LatestRelease | null = null;
  private lookingUp = false;
  /** The provider's menu entries for the provider record and folder last read; see `providerEntries`. */
  private providerEntriesMemo: {
    readonly provider: ServerProvider | null;
    readonly cwd: string;
    readonly entries: ReadonlyArray<ProviderSlashEntry>;
  } | null = null;
  /** The provider commands and skills of the folder the conversation is in; see `WorkspaceLists`. */
  private readonly workspace: WorkspaceLists;
  /**
   * The message `oop "..."` was started with, until it is sent. `threadId` is the existing thread
   * it waits for (it goes once that thread is loaded, so a running turn or a refusal is seen first);
   * null while no project is chosen, which a folder with no project of its own leaves to the user.
   */
  private startPrompt: { readonly text: string; threadId: ThreadId | null } | null;
  /** The message of a new thread waiting for the server's config, since no model can be named before it. */
  private waitingStart: { readonly text: string; readonly screen: ChatScreen } | null = null;
  /** A start message whose thread could not be opened: it goes to the composer of the next conversation. */
  private rescuedStart: string | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.patchSettings = createSettingsPatcher(deps.link);
    this.provider = new ProviderFlow({
      config: () => deps.link.config,
      shell: () => deps.link.shell,
      online: () => deps.link.status.phase === "online",
      patch: this.patchSettings,
      refresh: (input) => deps.link.refreshProviders(input),
      rail: () => this.rail,
      width: () => this.width,
      say: (lines) => this.emit(lines),
      record: (label, value) => this.record(label, value),
      error: (text) => this.emit([noticeLine(this.rail, text, "error")]),
      notify: (text) => {
        this.notice = text;
      },
      changed: () => this.render(),
    });
    this.workspace = new WorkspaceLists({
      refresh: (input) => deps.link.refreshProviders(input),
      now: () => deps.now(),
      changed: () => this.render(),
    });
    this.landing = deps.startup === undefined ? null : { held: [], setupEndAt: null };
    const prompt = deps.prompt?.trim();
    this.startPrompt = prompt ? { text: prompt, threadId: null } : null;
  }

  private get symbols(): Symbols {
    return this.deps.symbols ?? UNICODE_SYMBOLS;
  }

  private get rail(): Rail {
    return { style: this.deps.style, symbols: this.symbols };
  }

  /** Width of a line of scrollback: one column is kept free, as the live region does. */
  private get width(): number {
    return this.deps.region.usableColumns();
  }

  // ---- link events -------------------------------------------------------------------------

  onLinkStatus(): void {
    const { phase } = this.deps.link.status;
    if (phase === "online" && this.lastPhase !== "online") {
      // A reply that went out just before the server died may never have been recorded; the request
      // is still open on the other side, so let the user answer it again.
      this.responding = null;
      // Nothing stays picked, but a lock does: only the arrows lift it.
      if (this.approvalChoice !== null) {
        this.approvalChoice = { ...this.approvalChoice, index: null };
      }
    }
    this.lastPhase = phase;
    if (this.screen.kind === "chat") this.pumpQueue(this.screen);
    this.render();
  }

  onShell(): void {
    if (this.screen.kind === "loading") this.navigateFromStart();
    else if (this.screen.kind === "threads") this.followPinned(this.screen);
    else if (this.screen.kind === "chat") {
      this.reconcileDraft(this.screen);
      this.settleModeIntents(this.screen);
    }
    this.render();
  }

  /** The server's config changed (settings, providers); what is drawn from it is drawn again. */
  onConfig(): void {
    const waiting = this.waitingStart;
    if (waiting !== null && this.screen === waiting.screen && !this.startMustWait(waiting.screen)) {
      this.waitingStart = null;
      if (this.notice === startWaitNotice()) this.notice = null;
      this.sendStartPrompt(waiting.text);
    }
    this.render();
  }

  /** The first lookup of the newest release answered; null (it failed, nothing cached) leaves the home without a notice. */
  onLatestRelease(info: LatestRelease | null): void {
    if (info === null) return;
    this.latest = info;
    this.render();
  }

  /** The server refused to open the thread on screen; the link is fine, so only the view moves. */
  onThreadFailed(threadId: ThreadId, message: string): void {
    const { screen } = this;
    if (screen.kind !== "chat" || screen.threadId !== threadId) return;
    const reason = sanitizeForTerminal(message).split("\n")[0] ?? "";
    // The message `oop -c "..."` came with was waiting for this thread; it is not lost with it.
    const start = this.startPrompt?.threadId === threadId ? this.startPrompt.text : null;
    if (start !== null) {
      this.startPrompt = null;
      this.rescuedStart = start;
    }
    this.emit([
      noticeLine(
        this.rail,
        t("session.c.cannotOpenThread", { reason }) +
          (start === null ? "" : t("session.c.cannotOpenThreadKept")),
      ),
    ]);
    this.leaveChat("threads");
    // Closing the list must not open the thread that just failed (it would fail and land here again).
    this.listedFrom = null;
    this.render();
  }

  /** A "new" thread that the server already has (its first send got through) is an ordinary one. */
  private reconcileDraft(screen: ChatScreen): void {
    if (!screen.isDraft) return;
    if (!this.deps.link.shell?.threads.some((thread) => thread.id === screen.threadId)) return;
    screen.isDraft = false;
    this.deps.link.openThread(screen.threadId);
  }

  private canonical(path: string): string {
    let real = this.realPaths.get(path);
    if (real === undefined) {
      real = (this.deps.canonical ?? realDirectory)(path);
      this.realPaths.set(path, real);
    }
    return real;
  }

  onThread(mirror: ThreadMirrorState): void {
    const { screen } = this;
    if (screen.kind !== "chat") return;
    if (mirror.thread === null || mirror.thread.id !== screen.threadId) {
      this.render();
      return;
    }
    if (mirror.deleted) {
      this.queue.drop(screen.threadId);
      this.emit([noticeLine(this.rail, t("session.c.threadDeleted"))]);
      this.leaveChat("threads");
      return;
    }
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    this.deps.schedule(() => {
      this.syncScheduled = false;
      this.syncThread();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnimation();
    this.stopClock();
    this.stopStartWait();
    // The title was ours for the session; the shell's own comes back.
    this.deps.terminal?.restoreTitle();
    this.lastTitle = null;
  }

  /**
   * The last row of the rail, written into the scrollback as the app leaves: `└  See you next time`, or
   * `■` when something other than the user ended it. Nothing is said if the rail never began.
   */
  farewell(code: number): void {
    this.endHome();
    if (!this.railOpen) return;
    const { theme } = this.deps.style;
    this.emit([
      railGap(this.rail),
      code === 0
        ? railEnd(this.rail, theme.text(t("session.c.bye")))
        : railCancelled(this.rail, theme.error(t("session.c.exiting", { code }))),
    ]);
  }

  // ---- scrollback and the start screen ------------------------------------------------------

  /** Writes into the scrollback. The start screen is over by then: this is the conversation. */
  private emit(lines: ReadonlyArray<string>): void {
    if (lines.length === 0) return;
    this.endHome();
    this.deps.region.commit(lines);
  }

  /** Scrollback output of getting into a conversation: it waits behind the start screen, if that is up. */
  private hold(lines: ReadonlyArray<string>): void {
    if (this.landing === null) this.deps.region.commit(lines);
    else this.landing.held.push(...lines);
  }

  /**
   * Ends the start screen: its padding is dropped and one line of banner goes into the scrollback,
   * followed by what waited. It does not come back in this run, and a new thread is a plain empty one.
   */
  private endHome(): void {
    const landing = this.landing;
    const startup = this.deps.startup;
    if (landing === null || startup === undefined) return;
    this.landing = null;
    const { region, style } = this.deps;
    this.deps.region.commit([
      ...(startup.banner
        ? renderBanner({
            version: startup.version,
            server: this.deps.server ?? null,
            cwd: this.deps.cwd,
            home: this.deps.home ?? null,
            columns: region.usableColumns() + 1,
            theme: style.theme,
            symbols: this.symbols,
            compact: true,
          })
        : []),
      ...landing.held,
    ]);
  }

  // ---- navigation --------------------------------------------------------------------------

  private navigateFromStart(): void {
    const shell = this.deps.link.shell;
    if (shell === null) return;
    const matched = projectForDirectory(shell.projects, this.deps.cwd, this.deps.platform, (path) =>
      this.canonical(path),
    );
    this.commitSetupStart(matched?.title ?? null);
    if (this.startPrompt !== null) {
      // The message goes to the folder's project; a folder with none lets the user pick one first.
      if (matched) this.openWithPrompt(matched.id);
      else {
        this.notice = this.deps.continueLast
          ? t("session.c.noProjectContinue")
          : t("session.c.noProjectNew");
        this.showProjects();
      }
      return;
    }
    if (this.deps.continueLast) {
      // A crew task's own thread is not what "the last thread" means.
      const latest = (
        matched
          ? threadsOfProject(shell.threads, matched.id)
          : shell.threads
              .filter((thread) => thread.archivedAt === null)
              .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      ).find((thread) => !isCrewSubThread(thread));
      if (latest) {
        this.endSetup(null);
        this.openChat(latest.projectId, latest.id, false);
        return;
      }
      this.notice = matched ? t("session.c.noThreadNew") : t("session.c.noThreadList");
    }
    if (matched) {
      // The folder says which project this is, so the composer is ready; /threads has the rest.
      this.endSetup(null);
      this.openChat(matched.id, null, true);
    } else this.showProjects();
  }

  /**
   * Opens the conversation `oop "..."` is for and sends the message: a new thread of the project,
   * or with `--continue` its latest one. A new thread sends at once; an existing one first loads, so
   * what it is doing shows before the message is added to it.
   */
  private openWithPrompt(projectId: ProjectId): void {
    const shell = this.deps.link.shell;
    const prompt = this.startPrompt;
    if (shell === null || prompt === null) return;
    this.startPrompt = null;
    this.endSetup(null);
    const latest = this.deps.continueLast
      ? threadsOfProject(shell.threads, projectId).find((thread) => !isCrewSubThread(thread))
      : undefined;
    if (latest) {
      this.openChat(projectId, latest.id, false);
      this.startPrompt = { text: prompt.text, threadId: latest.id };
      return;
    }
    if (this.deps.continueLast) this.notice = t("session.c.noThreadNew");
    this.openChat(projectId, null, true);
    this.sendStartPrompt(prompt.text);
  }

  /**
   * A new thread has no model to name yet: the server has not sent its config, or still checks its
   * providers for the first time. The message goes when one is there (`onConfig` asks again), and a
   * provider that turns out unusable ends the wait with the usual "no model" notice.
   */
  private startMustWait(screen: ChatScreen): boolean {
    if (!screen.isDraft) return false;
    const { link } = this.deps;
    const project = link.shell?.projects.find((candidate) => candidate.id === screen.projectId);
    return (
      defaultModelSelection(project, link.config) === null &&
      (link.config === null || providersPending(link.config))
    );
  }

  /**
   * Sends the message through the composer, as if it were typed. What the user typed while the
   * conversation was loading is theirs: it is given back once the message has gone, and stays
   * behind it when the message did not.
   */
  private sendStartPrompt(text: string): void {
    const screen = this.screen;
    if (screen.kind !== "chat") return;
    if (this.startMustWait(screen)) {
      this.waitingStart = { text, screen };
      this.notice = startWaitNotice();
      return;
    }
    const typed = editorText(this.editor);
    this.editor = editorFromText(text);
    void this.submit(screen);
    if (typed.trim() === "") return;
    this.editor = editorFromText(
      editorText(this.editor) === "" ? typed : `${editorText(this.editor)}\n\n${typed}`,
    );
  }

  /**
   * The first thing in the scrollback after the banner: the rail's start, and the step that says
   * the server answered. It is drawn when the first project list arrives, so it is never a claim
   * about a connection that has not happened.
   */
  private commitSetupStart(project: string | null): void {
    const { style } = this.deps;
    const server = this.deps.server;
    this.railOpen = true;
    this.hold([
      ...railStartRows(
        this.rail,
        t("session.c.startTitle"),
        project === null ? t("session.c.startTagline") : flatten(project),
        this.width,
      ),
      railGap(this.rail),
      railDone(this.rail, t("session.c.serverConnected")),
      ...(server ? [railRow(this.rail, style.theme.dim(sanitizeForTerminal(server)))] : []),
    ]);
  }

  /**
   * What was chosen to get into a thread, left in the scrollback as a finished step, and the end of
   * the rail those steps hang off. The chat that follows starts its own.
   */
  private endSetup(chosen: { readonly label: string; readonly value: string } | null): void {
    // Remembered so an empty conversation set aside again takes its steps with it.
    if (this.landing !== null) this.landing.setupEndAt = this.landing.held.length;
    this.hold([...(chosen === null ? [] : this.answered(chosen)), railEnd(this.rail)]);
  }

  /** A step that was answered: the question as a finished step, and the answer dim under it. */
  private answered(step: { readonly label: string; readonly value: string }): string[] {
    const { theme } = this.deps.style;
    return [
      railGap(this.rail),
      railDone(this.rail, step.label),
      ...railWrap(
        this.rail,
        theme.dim(sanitizeForTerminal(step.value).replace(/\s+/gu, " ").trim()),
        this.width,
      ),
    ];
  }

  private showProjects(): void {
    const shell = this.deps.link.shell;
    const projects = shell ? sortedProjects(shell.projects, shell.threads) : [];
    const matched = shell
      ? projectForDirectory(projects, this.deps.cwd, this.deps.platform, (path) =>
          this.canonical(path),
        )
      : undefined;
    const selected = matched
      ? Math.max(
          0,
          projects.findIndex((project) => project.id === matched.id),
        )
      : 0;
    this.screen = { kind: "projects", selected, query: "" };
    this.render();
  }

  private showThreads(projectId: ProjectId): void {
    this.screen = { kind: "threads", projectId, selected: 0, query: "", follow: null };
    this.editor = emptyEditor;
    this.render();
  }

  /** A printer for the conversation, folded to the room the terminal has when each line is written. */
  private newPrinter(historyMessages: number): TranscriptPrinter {
    const { region, style, symbols } = this.deps;
    return new TranscriptPrinter({
      get width() {
        return region.usableColumns();
      },
      style,
      historyMessages,
      ...(symbols ? { symbols } : {}),
    });
  }

  /** A message waiting for the server's models goes nowhere else: it is kept for the next composer. */
  private rescueWaitingStart(): void {
    const waiting = this.waitingStart;
    if (waiting === null) return;
    this.waitingStart = null;
    if (this.notice === startWaitNotice()) this.notice = null;
    this.rescuedStart = waiting.text;
  }

  private openChat(projectId: ProjectId, threadId: ThreadId | null, draft: boolean): void {
    this.rescueWaitingStart();
    if (this.screen.kind === "chat") this.undo.leave(this.screen.threadId);
    const { link } = this.deps;
    const shell = link.shell;
    const project = shell?.projects.find((candidate) => candidate.id === projectId);
    const id = threadId ?? newThreadId(this.deps.context);
    this.undo.arrive(id, this.deps.now());
    const abandoned = this.abandonedDraft(id);
    this.listedFrom = null;
    this.queue.holdAll();
    // A message waiting for a thread to load goes nowhere else.
    if (this.startPrompt?.threadId != null) this.startPrompt = null;
    const printer = this.newPrinter(HISTORY_MESSAGES);
    this.screen = {
      kind: "chat",
      projectId,
      threadId: id,
      isDraft: draft,
      printer,
      partial: [],
      status: null,
      loaded: draft,
      lastEventAt: null,
      turnSeenAt: null,
      planCollapsed: false,
      history: null,
      historyBusy: false,
      turnCount: null,
    };
    this.editor = this.rescuedStart === null ? emptyEditor : editorFromText(this.rescuedStart);
    this.rescuedStart = null;
    this.resetPanelState();
    this.resetThreadChoices();
    this.failedSend = null;
    const title = draft
      ? t("session.c.newThread")
      : (shell?.threads.find((thread) => thread.id === id)?.title ?? "");
    const header = [
      "",
      ...railStartRows(
        this.rail,
        "OOP",
        [flatten(project?.title ?? ""), flatten(title)].filter((part) => part !== "").join(" · "),
        this.width,
      ),
    ];
    // An empty conversation opened from the start screen waits behind it; a thread's history does not.
    if (draft) this.hold(header);
    else this.emit(header);
    if (!draft) link.openThread(id);
    if (abandoned !== null) void this.dropDraftGoal(abandoned);
    this.render();
  }

  /**
   * The draft the user is leaving for `next`, if it was never sent: the one on screen, or the one
   * the list was opened from. Null when `next` is that same draft (coming back to it) or it began.
   */
  private abandonedDraft(next: ThreadId): ThreadId | null {
    const screen = this.screen;
    const draft =
      screen.kind === "chat" && screen.isDraft
        ? screen.threadId
        : this.listedFrom?.isDraft === true
          ? this.listedFrom.threadId
          : null;
    return draft === null || draft === next || this.startedDrafts.has(draft) ? null : draft;
  }

  /** A draft that was left unsent leaves no goal behind; one that began (or exists on the server) keeps it. */
  private async dropDraftGoal(draftId: ThreadId): Promise<void> {
    await this.patchSettings((current) =>
      current.threadGoals[draftId] === undefined ||
      this.deps.link.shell?.threads.some((thread) => thread.id === draftId) === true
        ? null
        : { threadGoals: goalsWithout(current.threadGoals, draftId) },
    );
  }

  private leaveChat(target: "threads" | "projects"): void {
    const screen = this.screen;
    if (screen.kind !== "chat") return;
    this.rescueWaitingStart();
    this.undo.leave(screen.threadId);
    this.deps.link.closeThread();
    this.queue.holdAll();
    this.dropHeldDraft(screen);
    this.listedFrom = {
      projectId: screen.projectId,
      threadId: screen.threadId,
      isDraft: screen.isDraft,
      choices: {
        modelOverride: this.modelOverride,
        effortPick: this.effortPick,
        runtimeIntent: this.runtimeIntent,
        interactionIntent: this.interactionIntent,
      },
    };
    this.picker = null;
    this.stats = null;
    this.resetThreadChoices();
    this.failedSend = null;
    this.resetPanelState();
    this.editor = emptyEditor;
    if (target === "projects") this.showProjects();
    else this.showThreads(screen.projectId);
  }

  /**
   * An empty conversation still behind the start screen was never shown to anyone: it is dropped
   * from what waits, and the steps that led to it are said again when the next one is chosen.
   */
  private dropHeldDraft(screen: Extract<Screen, { kind: "chat" }>): void {
    const landing = this.landing;
    if (landing === null || !screen.isDraft || landing.setupEndAt === null) return;
    landing.held.length = landing.setupEndAt;
  }

  /**
   * What was picked for the thread on screen and is not the server's: model, reasoning effort,
   * permission and plan mode, an open question. A mode held for the next turn is dropped with the
   * thread, so it can never be applied to another one.
   */
  private resetThreadChoices(): void {
    this.modelOverride = null;
    this.effortPick = null;
    this.runtimeIntent = null;
    this.interactionIntent = null;
    this.prompt = null;
    this.goalMemo = null;
    this.crewView = null;
    this.provider.close();
    this.crewBoardMemo = null;
    this.sidePanel.reset();
  }

  /** Everything tied to the request on screen, for when the thread on screen changes. */
  private resetPanelState(): void {
    this.questionDraft = null;
    this.responding = null;
    this.approvalChoice = null;
    this.panelKey = null;
    this.stashedDraft = null;
  }

  // ---- thread sync -------------------------------------------------------------------------

  private syncThread(): void {
    const screen = this.screen;
    if (this.disposed || screen.kind !== "chat") return;
    const thread = this.deps.link.thread.thread;
    if (thread === null || thread.id !== screen.threadId) return;
    const first = !screen.loaded;
    // The printer says what the opening left out, the server's window included.
    const result = screen.printer.sync(thread, first && this.deps.link.thread.hasOlder);
    this.emit(result.commit);
    screen.partial = result.partial;
    this.noteRewind(screen, thread);
    const before = screen.status?.phase;
    screen.status = deriveThreadStatus(thread);
    if (!screen.status.interruptible) {
      this.interruptShown = false;
      if (this.notice?.startsWith(interruptNotice())) this.notice = null;
    }
    const wasLoaded = screen.loaded;
    screen.loaded = true;
    const now = this.deps.now();
    screen.lastEventAt = now;
    if (screen.status.phase === "working") screen.turnSeenAt ??= now;
    else screen.turnSeenAt = null;
    const turnEnded =
      before === "working" && (screen.status.phase === "idle" || screen.status.phase === "error");
    // Nobody needs calling back for a turn the user stopped or one a queued message follows at once.
    if (
      turnEnded &&
      this.deps.notify === true &&
      this.stopRequested !== screen.threadId &&
      !this.queueWillGoOn(screen)
    ) {
      this.deps.terminal?.bell();
    }
    if (!screen.status.interruptible && this.stopRequested === screen.threadId) {
      this.stopRequested = null;
    }
    this.ringForRequest(screen, wasLoaded);
    const approval = screen.status.pending.approvals[0];
    if (this.responding !== null && approval?.requestId !== this.responding) {
      const stillOpen = screen.status.pending.userInputs.some(
        (input) => input.requestId === this.responding,
      );
      if (!stillOpen) this.responding = null;
    }
    this.releaseRefusedReply(thread);
    this.forgetDeliveredSend(thread);
    this.settleModeIntents(screen);
    if (screen.status.phase === "error" && before !== "error")
      this.queue.hold(screen.threadId, "error");
    this.pumpQueue(screen);
    if (first && this.startPrompt?.threadId === screen.threadId) {
      const { text } = this.startPrompt;
      this.startPrompt = null;
      this.sendStartPrompt(text);
    }
    this.render();
  }

  /**
   * Rings the bell once for each approval or question that arrives while the thread is open, so a
   * user in another window hears that the agent is stuck. A request already waiting when the thread
   * was opened is not rung for (the user opened it to look), and the same request never rings twice
   * however often the thread updates.
   */
  private ringForRequest(screen: ChatScreen, wasLoaded: boolean): void {
    const key = this.pendingKey(screen);
    if (key === null || this.rungFor.has(key)) return;
    this.rungFor.add(key);
    if (wasLoaded && this.deps.notify === true) this.deps.terminal?.bell();
  }

  /** What the server says about the thread's turn and session, and the turn it showed last. */
  private static turnMark(thread: OrchestrationThread, at: number): TurnMark {
    const { latestTurn, session } = thread;
    return {
      at,
      key: [
        latestTurn?.turnId,
        latestTurn?.state,
        latestTurn?.completedAt,
        session?.status,
        session?.activeTurnId,
        session?.updatedAt,
      ].join("|"),
      turnId: latestTurn?.turnId ?? null,
    };
  }

  /**
   * The queue sent a message whose turn has not shown in the thread yet: the server has taken it but
   * still reads at rest, or changed something that is not a turn beginning. Another start now would
   * race it. It is not waited for beyond `TURN_START_WAIT_MS`, for a turn that never shows.
   */
  private turnStarting(screen: ChatScreen): boolean {
    const mark = this.queue.awaiting(screen.threadId);
    const thread = this.serverThreadOf(screen);
    if (mark === null || thread === null) return false;
    if (this.deps.now() - mark.at >= TURN_START_WAIT_MS) return false;
    if (AppController.turnMark(thread, mark.at).key === mark.key) return true;
    return screen.status?.phase === "idle" && (thread.latestTurn?.turnId ?? null) === mark.turnId;
  }

  /** The turn that just ended is followed by a queued message at once, so nobody has to come back. */
  private queueWillGoOn(screen: ChatScreen): boolean {
    const id = screen.threadId;
    return (
      this.queue.items(id).length > 0 &&
      this.queue.held(id) === null &&
      screen.status?.phase === "idle"
    );
  }

  /**
   * Sends the next queued message of the thread on screen when its turn is over. Nothing goes while
   * a turn, an approval or a question is open, an undo is on its way, or before the server has shown
   * the turn of the last start. A turn that ended in an error stops the queue (see `syncThread`),
   * since the next message may have been written for a turn that went well.
   */
  private pumpQueue(screen: ChatScreen): void {
    const id = screen.threadId;
    if (this.disposed || this.screen !== screen) return;
    if (this.undo.active(id, this.deps.now())) return;
    if (this.queue.items(id).length === 0) return;
    // The panel is settled first: one that has just gone away must not keep the queue waiting.
    this.trackPanel(screen);
    const status = screen.status;
    if (status === null || this.queue.held(id) !== null) return;
    // An error leaves the thread in `error` until the next turn, so a queue the user let go on still sends.
    if (status.phase !== "idle" && status.phase !== "error") return;
    const thread = this.deps.link.thread.thread;
    if (thread === null || thread.id !== id) return;
    // The screen's status is computed on the next sync; the mirror may already show a turn running.
    if (thread.latestTurn?.state === "running") return;
    if (this.deps.link.status.phase !== "online" || this.sending || this.panelKey !== null) return;
    if (this.turnStarting(screen)) return;
    const text = this.queue.next(id, AppController.turnMark(thread, this.deps.now()));
    if (text === undefined) return;
    void this.transmit(screen, text, "queue");
  }

  /**
   * Every queued message goes back into the composer, ahead of what is typed there, so Esc and
   * Ctrl-C leave nothing behind that would be sent after the user stopped the turn.
   */
  private takeBackQueue(screen: ChatScreen): void {
    const queued = this.queue.takeAll(screen.threadId);
    if (queued.length === 0) return;
    const held = this.panelKey !== null;
    const draft = editorText(held ? (this.stashedDraft ?? emptyEditor) : this.editor);
    const merged = editorFromText([...queued, ...(draft === "" ? [] : [draft])].join("\n\n"));
    if (held) this.stashedDraft = merged;
    else this.editor = merged;
  }

  /** The request a panel is wanted for: the first approval, else the first question. */
  private pendingKey(screen: ChatScreen): string | null {
    const approval = screen.status?.pending.approvals[0];
    const question = screen.status?.pending.userInputs[0];
    return approval
      ? `approval:${approval.requestId}`
      : question
        ? `input:${question.requestId}`
        : null;
  }

  /** A full-screen overlay is open: a list, the statistics or a typed question. */
  private screenOverlayOpen(): boolean {
    return (
      this.picker !== null ||
      this.stats !== null ||
      this.prompt !== null ||
      this.crewView !== null ||
      this.provider.isOpen()
    );
  }

  /** The slash menu, the statistics, a list or a question is open; it has every key until it is closed. */
  private overlayOpen(): boolean {
    return this.screenOverlayOpen() || this.slashMenu() !== null;
  }

  /** What is on screen is not what is asked: a panel an open overlay keeps up or keeps off. */
  private panelDeferred(screen: ChatScreen): boolean {
    return this.pendingKey(screen) !== this.panelKey;
  }

  /** A request is waiting but its panel is not up, because an overlay was open when it arrived. */
  private requestHeld(screen: ChatScreen): boolean {
    const key = this.pendingKey(screen);
    return key !== null && key !== this.panelKey;
  }

  /**
   * Said while an open overlay keeps a waiting request off the screen, so it is not forgotten;
   * null when the request's panel is up or nothing waits.
   */
  private requestWarning(screen: ChatScreen): string | null {
    const key = this.pendingKey(screen);
    if (key === null) return null;
    if (!this.screenOverlayOpen() && key === this.panelKey) return null;
    return this.deps.style.theme.warning(
      t(key.startsWith("approval:") ? "session.c.approvalWaiting" : "session.c.questionWaiting"),
    );
  }

  /**
   * A panel hides the composer, or reuses it for an answer. What the user had written before it
   * appeared is put aside so one Enter cannot turn that draft into the answer, and comes back once
   * no panel is left. What was typed over a panel is the answer to that panel, not a draft: it goes
   * with the panel.
   * A menu, the statistics or a list that is open is never closed by a change of panel: the change
   * waits until it is closed, so the keys the user is pressing for the overlay never reach a panel
   * and its text stays where it is.
   */
  private trackPanel(screen: ChatScreen): void {
    const key = this.pendingKey(screen);
    const approval = screen.status?.pending.approvals[0];
    const overlay = this.overlayOpen();
    // A screen that closed on its own (a save that finished, a list that went stale) hands the
    // keys to a panel nobody asked for; keys already on their way to that screen must not pick.
    const closedByItself = this.overlayWasOpen && !overlay && !this.handlingKey;
    this.overlayWasOpen = overlay;
    if (key === this.panelKey || overlay) return;
    const wasOpen = this.panelKey !== null;
    this.panelKey = key;
    const wasLocked = this.approvalChoice?.locked === true;
    this.approvalChoice = null;
    if (!wasOpen && key !== null) this.stashedDraft = this.editor;
    if (key !== null) {
      // A draft means the user was typing, whether it is in the composer or put aside by the panel
      // this one replaces: the numbers start locked so a digit meant for that sentence cannot pick
      // an option. So does a lock already on the panel this one replaces. The arrows still work.
      const typing = [this.editor, this.stashedDraft].some(
        (draft) => draft !== null && editorText(draft).trim() !== "",
      );
      if (approval && (typing || wasLocked || closedByItself)) {
        this.approvalChoice = { requestId: approval.requestId, index: null, locked: true };
      }
      this.editor = emptyEditor;
      this.historyIndex = -1;
    } else if (this.stashedDraft !== null) {
      this.editor = this.stashedDraft;
      this.stashedDraft = null;
    }
  }

  /** The thread shows the message we thought we had not sent: it got through, so there is nothing to resend. */
  private forgetDeliveredSend(thread: OrchestrationThread): void {
    const failed = this.failedSend;
    if (failed === null || failed.threadId !== thread.id) return;
    if (!thread.messages.some((message) => message.id === failed.messageId)) return;
    this.failedSend = null;
    if (editorText(this.editor) === failed.text) this.editor = emptyEditor;
    if (this.stashedDraft !== null && editorText(this.stashedDraft) === failed.text) {
      this.stashedDraft = null;
    }
  }

  /** The server records a refused reply as an activity; the request stays open, so let the user try again. */
  private releaseRefusedReply(thread: OrchestrationThread): void {
    const requestId = this.responding;
    if (requestId === null) return;
    const refusal = thread.activities.find(
      (activity) =>
        FAILED_REPLY_KINDS.has(activity.kind) &&
        !this.respondingBaseline.has(activity.id) &&
        (activity.payload as { requestId?: unknown } | null)?.requestId === requestId,
    );
    if (refusal === undefined) return;
    // The reason itself is printed into the scrollback as an error-toned activity.
    this.responding = null;
    // The pick that was sent is not kept: the next answer is a new pick, not that one waiting for Enter.
    if (this.approvalChoice?.requestId === requestId) {
      this.approvalChoice = { ...this.approvalChoice, index: null };
    }
    // As after a failed send: the earlier answers stay and the last one goes back to the composer.
    const draft = this.questionDraft;
    if (draft?.requestId === requestId && editorText(this.editor) === "") {
      this.editor = editorFromText(draft.sent);
    }
    this.notice = t("session.c.replyNotProcessed");
  }

  // ---- rendering ---------------------------------------------------------------------------

  render(): void {
    if (this.disposed) return;
    const { region, style, link } = this.deps;
    // Whatever changed the thread, the composer or an overlay, the panel is settled before drawing:
    // it comes up the moment nothing is open over it, and not before.
    if (this.screen.kind === "chat") this.trackPanel(this.screen);
    // The task list takes rows from the conversation, so it is sized before the frame is built.
    this.syncTasks();
    const columns = region.usableColumns() + 1;
    const rows = region.maxRows();
    const now = this.deps.now();
    const banner = linkNotice(link.status, now, style);
    const frame =
      this.landing === null
        ? this.buildFrame(columns, rows, banner, now)
        : this.buildHomeFrame(columns, rows, banner, now);
    region.set(frame);
    this.syncPanel();
    this.syncAnimation();
    this.syncStartWait();
    this.syncTitle();
    this.syncWorkspaceLists();
  }

  /** The folder a conversation works in: its worktree, else its project's folder, else where oop was started. */
  private workspaceCwd(screen: ChatScreen): string {
    const { link } = this.deps;
    const project = link.shell?.projects.find((candidate) => candidate.id === screen.projectId);
    const threadShell = link.shell?.threads.find((thread) => thread.id === screen.threadId);
    const mirror = link.thread.thread?.id === screen.threadId ? link.thread.thread : null;
    return (
      mirror?.worktreePath ?? threadShell?.worktreePath ?? project?.workspaceRoot ?? this.deps.cwd
    );
  }

  /** Asks for the folder's provider commands when a conversation is open on a provider that has not listed them. */
  private syncWorkspaceLists(): void {
    const screen = this.screen;
    if (this.disposed || screen.kind !== "chat" || this.deps.link.status.phase !== "online") return;
    this.workspace.ensure(this.currentProvider(screen), this.workspaceCwd(screen));
  }

  // ---- animation and terminal title --------------------------------------------------------

  /**
   * The timer exists only while there is something moving: a turn that is running, with the link
   * up and the chat in view. Waiting for an approval or an answer, an idle thread, a lost
   * connection, the pickers and a disposed controller all have none. With animations off the same
   * timer ticks once a second, for the elapsed time alone.
   *
   * The one exception is the Agents panel: while it shows work in progress its clocks must keep
   * moving even when the lead waits for an approval, so a second timer, once a second, redraws the
   * panel's rows and nothing else.
   */
  private syncAnimation(): void {
    const screen = this.screen;
    const online = this.deps.link.status.phase === "online";
    const calm = !this.disposed && screen.kind === "chat" && !this.screenOverlayOpen() && online;
    const moving = calm && screen.status?.phase === "working";
    if (!moving) {
      this.stopAnimation();
    } else if (this.stopTicker === null) {
      const interval = this.deps.animations === false ? STATIC_TICK_MS : SPINNER_INTERVAL_MS;
      this.stopTicker = (this.deps.ticker ?? defaultTicker)(() => {
        this.tick += 1;
        this.render();
      }, interval);
    }
    // The spinner's timer redraws the panel with everything else; the clock is for when it is not running.
    const clock =
      calm &&
      !moving &&
      this.panelOpen &&
      this.sidePanel.view() === "agents" &&
      this.agentsViewOf(screen)?.live === true;
    if (!clock) {
      this.stopClock();
    } else if (this.stopPanelClock === null) {
      this.stopPanelClock = (this.deps.ticker ?? defaultTicker)(
        () => this.syncPanel(),
        STATIC_TICK_MS,
      );
    }
  }

  /**
   * While the thread on screen is waiting for the turn of a message the queue sent, one timer is set
   * for the moment that wait runs out, since nothing else would tell the queue to look again. It is
   * dropped as soon as the turn shows, the thread is left, or the wait has run out.
   */
  private syncStartWait(): void {
    const screen = this.screen;
    const mark =
      !this.disposed && screen.kind === "chat" && this.turnStarting(screen)
        ? this.queue.awaiting(screen.threadId)
        : null;
    if (mark === null || screen.kind !== "chat") {
      this.stopStartWait();
      return;
    }
    const due = mark.at + TURN_START_WAIT_MS;
    if (this.startWait?.due === due) return;
    this.stopStartWait();
    const chat = screen;
    const stop = (this.deps.ticker ?? defaultTicker)(
      () => {
        this.stopStartWait();
        if (this.screen === chat) this.pumpQueue(chat);
        this.render();
      },
      Math.max(1, due - this.deps.now()),
    );
    this.startWait = { due, stop };
  }

  private stopStartWait(): void {
    this.startWait?.stop();
    this.startWait = null;
  }

  private stopAnimation(): void {
    this.stopTicker?.();
    this.stopTicker = null;
  }

  private stopClock(): void {
    this.stopPanelClock?.();
    this.stopPanelClock = null;
  }

  /** `OOP · title`, with the brand mark in front while a turn runs. Sent only when it changes. */
  private syncTitle(): void {
    const terminal = this.deps.terminal;
    if (terminal === undefined || this.disposed) return;
    const { symbols = UNICODE_SYMBOLS } = this.deps;
    const screen = this.screen;
    let title = "OOP";
    if (screen.kind === "chat") {
      const mirror = this.deps.link.thread.thread;
      const known =
        mirror?.id === screen.threadId
          ? mirror.title
          : this.deps.link.shell?.threads.find((thread) => thread.id === screen.threadId)?.title;
      const name = sanitizeForTerminal(screen.isDraft ? t("session.c.newThread") : (known ?? ""))
        .replace(/\s+/gu, " ")
        .trim();
      const cut = graphemesOf(name);
      const short = cut.length > TITLE_LIMIT ? `${cut.slice(0, TITLE_LIMIT - 1).join("")}…` : name;
      title = `${screen.status?.phase === "working" ? `${symbols.brand} ` : ""}OOP${short === "" ? "" : ` · ${short}`}`;
    }
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    terminal.setTitle(title);
  }

  /** The version the update is measured from: the app's when the server told it, else this terminal app's. */
  private appVersion(): string | null {
    const version = this.deps.link.config?.environment.serverVersion.trim() ?? "";
    return isReleaseVersion(version) ? version : null;
  }

  private homeInput(startup: NonNullable<ControllerDeps["startup"]>, columns: number): HomeInput {
    const { style, link } = this.deps;
    const app = this.appVersion();
    // Until the server has said which version it is, the app's version is not guessed from this one.
    const current = app ?? (link.status.phase === "connecting" ? null : startup.version);
    return {
      columns,
      theme: style.theme,
      symbols: this.symbols,
      banner: startup.banner
        ? {
            version: startup.version,
            server: this.deps.server ?? null,
            cwd: this.deps.cwd,
            home: this.deps.home ?? null,
          }
        : null,
      report:
        this.latest !== null && current !== null ? buildUpdateReport(current, this.latest) : null,
      versions: { terminal: startup.version, app },
    };
  }

  /**
   * The frame of the start screen: whatever the app would show now, at the foot of a frame as tall
   * as the live region may be, with the wordmark and the update notice in the room above it. The
   * composer, a panel or a list is built first and never gives up a row to the home; a project or
   * thread list is held to what the home leaves it, but not below `MIN_LIST_ROWS`.
   */
  private buildHomeFrame(
    columns: number,
    rows: number,
    banner: string | null,
    now: number,
  ): RegionFrame {
    const startup = this.deps.startup;
    if (startup === undefined) return this.buildFrame(columns, rows, banner, now);
    const input = this.homeInput(startup, columns);
    const onList = this.screen.kind === "projects" || this.screen.kind === "threads";
    const listRows = onList
      ? Math.min(rows, Math.max(MIN_LIST_ROWS, rows - homeNaturalRows(input)))
      : rows;
    const bottom = this.buildFrame(columns, listRows, banner, now);
    return composeHome(fitHome(input, rows - bottom.lines.length), bottom, rows);
  }

  private buildFrame(
    columns: number,
    rows: number,
    banner: string | null,
    now: number,
  ): RegionFrame {
    const { style, link } = this.deps;
    const shell = link.shell;
    const screen = this.screen;
    const bannerTone = link.status.phase === "blocked" ? "error" : "warning";
    if (screen.kind === "loading") {
      return {
        lines:
          banner !== null
            ? noticeRows(this.rail, banner, bannerTone, this.width)
            : [railActive(this.rail, style.theme.dim(t("session.c.loadingProjects")))],
        cursor: null,
      };
    }
    if (screen.kind === "projects") {
      const projects = this.visibleProjects(screen);
      const items: PickerItem[] = projects.map((project) => ({
        label: project.title,
        note: project.workspaceRoot,
      }));
      return renderPicker(
        {
          title: t("session.c.pickProject"),
          items,
          selected: Math.min(screen.selected, Math.max(0, items.length - 1)),
          hint: t("session.c.projectsHint", {
            end:
              screen.query === ""
                ? this.listedFrom
                  ? t("session.c.escClose")
                  : t("session.c.ctrlCQuit")
                : t("session.c.escClearSearch"),
          }),
          empty: screen.query === "" ? t("session.c.noProjects") : t("session.c.noProjectMatch"),
          before: [this.searchLine(screen.query)],
        },
        columns,
        rows,
        style,
        this.symbols,
        banner ?? this.takeNotice(),
        bannerTone,
      );
    }
    if (screen.kind === "threads") {
      const found = shell ? threadRows(shell.threads, screen.projectId, screen.query) : null;
      const listed = found?.listed ?? null;
      const nowDate = new Date(now);
      const items: PickerItem[] = [
        // Words typed are looking for a thread: starting a new one is not among the matches.
        ...(screen.query === "" ? [{ label: t("session.c.newThread") }] : []),
        ...(found?.rows ?? []).map((thread) => {
          const when = relativeTime(thread.updatedAt, nowDate);
          if (listed?.waiting.has(thread.id) === true) {
            // A crew task that waits for the user is never folded away.
            const what = thread.hasPendingApprovals
              ? t("session.c.approvalPending")
              : t("session.c.questionPending");
            return {
              label: threadRowLabel(thread, listed),
              note: when ? `${what} · ${when}` : what,
            };
          }
          const crew = listed?.folded.get(thread.id) ?? 0;
          // The word says it, so the row needs no marker that could be taken for the radio mark.
          return {
            label: thread.title,
            note: [
              isPinned(thread) ? t("session.c.pinned") : "",
              isThreadRunning(thread)
                ? when
                  ? t("session.c.runningWhen", { when })
                  : t("session.c.running")
                : when,
              crew > 0 ? t("session.c.crewTasks", { count: crew }) : "",
            ]
              .filter((part) => part !== "")
              .join(" · "),
          };
        }),
      ];
      return renderPicker(
        {
          title: t("session.c.pickThread"),
          items,
          selected: Math.min(screen.selected, items.length - 1),
          hint: t("session.c.threadsHint", {
            end:
              screen.query === "" ? t("session.c.projectList") : t("session.c.escClearSearchWord"),
          }),
          empty: t("session.c.noThreadMatch"),
          before: [this.searchLine(screen.query)],
        },
        columns,
        rows,
        style,
        this.symbols,
        banner ?? this.takeNotice(),
        bannerTone,
      );
    }
    return this.buildChatFrame(screen, columns, rows, now);
  }

  /** The search field of a list: what to do while it is empty, the words typed once they are. */
  private searchLine(query: string): string {
    const { theme } = this.deps.style;
    return query === ""
      ? theme.dim(t("session.c.searchEmpty"))
      : `${theme.dim(t("session.c.searchLabel"))} ${theme.text(query)}`;
  }

  private visibleProjects(
    screen: Extract<Screen, { kind: "projects" }>,
  ): ReadonlyArray<OrchestrationProjectShell> {
    const shell = this.deps.link.shell;
    return shell ? filterProjects(sortedProjects(shell.projects, shell.threads), screen.query) : [];
  }

  /** The thread shells the list shows, in row order; the "New thread" row ahead of them is not one. */
  private visibleThreads(
    screen: Extract<Screen, { kind: "threads" }>,
  ): ReadonlyArray<OrchestrationThreadShell> {
    const shell = this.deps.link.shell;
    return shell ? threadRows(shell.threads, screen.projectId, screen.query).rows : [];
  }

  private takeNotice(): string | null {
    const notice = this.notice;
    return notice === null ? null : this.deps.style.theme.warning(notice);
  }

  /** Commands the typed text could become, as the menu lists them; null when no menu belongs to it. */
  private slashMenu(deferred = false): SlashMenuView | null {
    // A long paste is not joined into a string for every redraw just to learn it is no command.
    if (this.editor.chars[0] !== "/") return null;
    const text = editorText(this.editor);
    const query = slashQuery(text);
    if (query === null || this.menuClosedFor === text) return null;
    const matches = this.slashMatches(query);
    // Ours come first and win a shared name (the entries already leave such names out).
    const provided = matchProviderEntries(this.providerEntries(), query);
    const items: SlashMenuItem[] = [
      ...matches.map((command) => ({ label: `/${command.name}`, note: command.note })),
      ...provided.map((entry) => ({
        label: entry.label,
        note: entry.note,
        tag: entry.kind === "skill" ? t("session.c.skillTag") : "provider",
        fill: entry.fill,
      })),
    ];
    const loading = this.providerListPending();
    return {
      items,
      selected: Math.min(this.menuIndex, Math.max(0, items.length - 1)),
      // Enter sends nothing while the panel on screen is not the request there is.
      ...(deferred
        ? { noMatch: t("session.c.noCmdEsc") }
        : loading
          ? {
              noMatch: t("session.c.noCmdLoading"),
            }
          : {}),
    };
  }

  /**
   * The provider's own commands and skills for the conversation on screen. They come with the
   * server's config, which the link already holds, so a keystroke asks the server for nothing; the
   * list is rebuilt only when the provider's record or the folder changes.
   */
  private providerEntries(): ReadonlyArray<ProviderSlashEntry> {
    const screen = this.screen;
    if (screen.kind !== "chat") return [];
    const provider = this.currentProvider(screen);
    const cwd = this.workspaceCwd(screen);
    const memo = this.providerEntriesMemo;
    if (memo !== null && memo.provider === provider && memo.cwd === cwd) return memo.entries;
    const entries = providerSlashEntries(provider, cwd);
    this.providerEntriesMemo = { provider, cwd, entries };
    return entries;
  }

  /** The folder's own list has been asked for and is not in yet: a command missing from the menu may be late. */
  private providerListPending(): boolean {
    const screen = this.screen;
    return (
      screen.kind === "chat" &&
      this.workspace.pending(this.currentProvider(screen), this.workspaceCwd(screen))
    );
  }

  /** `/theme` is offered only where there are themes to switch between, `/update` only where it can look. */
  private slashMatches(query: string): ReadonlyArray<SlashCommand> {
    return matchSlashCommands(query).filter(
      (command) =>
        (command.name !== "theme" || this.deps.themes !== undefined) &&
        (command.name !== "update" || this.deps.startup !== undefined) &&
        ((command.name !== "dag-workflow" &&
          command.name !== "dag-agents" &&
          command.name !== "tasks") ||
          this.deps.split !== undefined),
    );
  }

  /**
   * What the full-screen overlays (`/stats`, the lists) say above themselves, which their own keys
   * leave no other room for: a request they are hiding, a key that did nothing, the state of the link.
   */
  private overlayNotice(screen: ChatScreen, now: number): { text: string; tone: RailTone } | null {
    const { style, link } = this.deps;
    const parts = [
      this.requestWarning(screen),
      // The crew screen lists what waits itself.
      this.crewView === null ? this.crewWarning(screen) : null,
      this.provider.message(),
      this.takeNotice(),
      linkNotice(link.status, now, style),
    ].filter((part) => part !== null);
    if (parts.length === 0) return null;
    return {
      // Folded where it is drawn (`noticeRows`): the order puts the least urgent last.
      text: parts.join(style.theme.dim(" · ")),
      tone: link.status.phase === "blocked" ? "error" : "warning",
    };
  }

  private buildChatFrame(
    screen: ChatScreen,
    columns: number,
    rows: number,
    now: number,
  ): RegionFrame {
    const { style, link } = this.deps;
    if (this.stats !== null) {
      const thread = link.thread.thread;
      const notice = this.overlayNotice(screen, now);
      const noticeShown =
        notice === null ? [] : noticeRows(this.rail, notice.text, notice.tone, this.width);
      return {
        lines: [
          ...noticeShown,
          ...renderStats({
            activities: thread?.id === screen.threadId ? thread.activities : [],
            hasOlder: link.thread.hasOlder,
            tab: this.stats.tab,
            selected: this.stats.selected,
            width: this.width,
            rows: Math.max(0, rows - noticeShown.length),
            style,
            symbols: this.symbols,
          }),
        ],
        cursor: null,
      };
    }
    if (this.picker !== null) return this.buildPickerFrame(screen, this.picker, columns, rows, now);
    if (this.crewView !== null) {
      const notice = this.overlayNotice(screen, now);
      return crewFrame(this.crewView, this.crewContextOf(screen, now), {
        columns,
        rows,
        style,
        symbols: this.symbols,
        banner: notice?.text ?? null,
        tone: notice?.tone ?? "warning",
      });
    }
    if (this.provider.isOpen()) {
      const notice = this.overlayNotice(screen, now);
      return this.provider.frame({
        columns,
        rows,
        style,
        symbols: this.symbols,
        banner: notice?.text ?? null,
        tone: notice?.tone ?? "warning",
      });
    }
    if (this.prompt !== null) {
      const notice = this.overlayNotice(screen, now);
      return renderTextPrompt(
        {
          title: t("session.c.goalPromptTitle"),
          editor: this.prompt.editor,
          placeholder: t("session.c.goalPlaceholder"),
          hint: t("session.c.goalHint"),
        },
        columns,
        this.deps.style,
        this.symbols,
        notice?.text ?? null,
        notice?.tone,
        rows,
      );
    }
    const status = screen.status;
    const panel: string[] = [];
    let placeholder = this.crewSub(screen) === null ? composerPlaceholder() : crewSubPlaceholder();
    let composerEnabled = true;
    // A request whose panel an open menu is holding back is neither drawn nor answered from here.
    const held = this.requestHeld(screen);
    const approval = held ? undefined : status?.pending.approvals[0];
    const question = held ? undefined : status?.pending.userInputs[0];
    if (approval) {
      composerEnabled = false;
      panel.push(
        ...renderApprovalPanel(
          {
            requestKind: approval.requestKind,
            detail: approval.detail,
            appName: approval.appName,
            options: this.approvalOptions(approval.options),
            selected:
              this.approvalChoice?.requestId === approval.requestId
                ? this.approvalChoice.index
                : null,
            locked:
              this.approvalChoice?.requestId === approval.requestId && this.approvalChoice.locked,
          },
          columns,
          this.rail,
          Math.max(1, rows - 1),
        ),
      );
    } else if (question) {
      const draft = this.draftFor(question.requestId);
      const current = question.questions[Math.min(draft.index, question.questions.length - 1)];
      if (current) {
        panel.push(
          ...renderQuestionPanel(
            {
              index: draft.index,
              total: question.questions.length,
              header: current.header,
              question: current.question,
              options: current.options,
              multiSelect: current.multiSelect === true,
              allowCustom: current.allowCustomAnswer !== false,
              dismissible: question.dismissible,
            },
            columns,
            this.rail,
            // Under the panel stay the composer and the status bar.
            Math.max(
              1,
              rows -
                1 -
                composerHeight(
                  this.editor,
                  Math.max(2, Math.max(10, columns - 1) - RAIL_COLUMNS),
                  rows,
                ),
            ),
          ),
        );
        placeholder =
          current.options.length > 0 ? t("session.c.answerOrNumber") : t("session.c.typeAnswer");
      }
    }
    // A server clock ahead of this one would put the turn's start in the future; then the time
    // this client first saw it running is the better start.
    const reported = status?.turnStartedAt ?? null;
    const turnStartedAt = reported !== null && reported <= now ? reported : screen.turnSeenAt;
    return renderChat(
      {
        partial: screen.partial,
        panel,
        status,
        link: link.status,
        now,
        loading: !screen.loaded,
        notice:
          [held ? this.requestWarning(screen) : null, this.notice, this.crewWarning(screen)]
            .filter((part) => part !== null)
            .join(style.theme.dim(" · ")) || null,
        sending: this.sending,
        queue: this.queueView(screen),
        editor: this.editor,
        placeholder,
        composerEnabled,
        menu: composerEnabled ? this.slashMenu(this.panelDeferred(screen)) : null,
        style,
        symbols: this.symbols,
        animations: this.deps.animations !== false,
        tick: this.tick,
        turnStartedAt,
        lastEventAt: screen.lastEventAt,
        planCollapsed: screen.planCollapsed,
        ...(this.tasksOn ? { planHidden: true as const } : {}),
        bar: this.statusBarInput(screen, status),
        barSetting: this.deps.statusLine ?? "auto",
      },
      columns,
      rows,
    );
  }

  private queueView(screen: ChatScreen): QueueView | null {
    const items = this.queue.items(screen.threadId);
    if (items.length === 0) return null;
    const held = this.queue.held(screen.threadId);
    const reason =
      held === "error"
        ? t("session.c.heldError")
        : held === "failed"
          ? t("session.c.heldFailed")
          : held === "left"
            ? t("session.c.heldLeft")
            : null;
    return { items, held: reason };
  }

  /** `/model`, `/theme`, `/mode` and `/effort`: the choices on the rail, the one in use noted `current`. */
  private buildPickerFrame(
    screen: ChatScreen,
    picker: ListPicker,
    columns: number,
    rows: number,
    now: number,
  ): RegionFrame {
    const { style } = this.deps;
    const { theme } = style;
    const notice = this.overlayNotice(screen, now);
    const items: PickerItem[] = [];
    const current = (isCurrent: boolean, extra = ""): { note?: string } => {
      const note = [isCurrent ? t("session.c.current") : "", extra]
        .filter((part) => part !== "")
        .join(" · ");
      return note === "" ? {} : { note };
    };
    let title = t("session.c.pickTheme");
    let empty = t("session.c.noThemes");
    let hint = t("session.c.hintApply");
    let before: string[] | undefined;
    if (picker.kind === "model") {
      const inUse = this.currentModel(screen);
      for (const model of this.visibleModels(screen, picker.query)) {
        items.push({ label: model.label, ...current(inUse !== null && sameModel(inUse, model)) });
      }
      title = t("session.c.pickModel");
      // Nothing on the server can run (not just nothing this thread may switch to): the way on is a provider.
      const none =
        picker.query === "" &&
        items.length === 0 &&
        availableModels(this.deps.link.config).length === 0;
      empty = picker.query === "" ? t("session.c.noModels") : t("session.c.noModelMatch");
      hint = none
        ? t("session.c.hintAddProvider")
        : t("session.c.hintSelectEsc", {
            end: picker.query === "" ? t("session.c.close") : t("session.c.escClearSearchWord"),
          });
      before = none
        ? [
            theme.warning(noModelCause(this.deps.link.config)),
            theme.dim(t("session.c.providerStatus")),
          ]
        : [
            picker.query === ""
              ? theme.dim(t("session.c.searchEmpty"))
              : `${theme.dim(t("session.c.searchLabel"))} ${theme.text(picker.query)}`,
          ];
    } else if (picker.kind === "mode") {
      const mode = this.runtimeModeOf(screen);
      for (const entry of RUNTIME_MODES) {
        items.push({ label: entry.label, ...current(entry.value === mode, entry.description) });
      }
      title = t("session.c.permissionMode");
      hint = t("session.c.hintSelect");
    } else if (picker.kind === "effort") {
      const sel = this.turnSelection(screen);
      const shown =
        sel === null ? null : resolveEffort(this.deps.link.config, sel, this.effortPick).shown;
      for (const choice of picker.control.choices) {
        const label = choice.label.toLowerCase() === choice.value.toLowerCase() ? "" : choice.label;
        items.push({ label: choice.value, ...current(choice.value === shown, label) });
      }
      title = t("session.c.reasoningEffort");
      hint = t("session.c.hintSelect");
    } else if (picker.kind === "undo") {
      items.push(...undoItems(picker.plan));
      title = t("session.c.undoTitle");
      hint = t("session.c.hintSelectCancel");
      before = undoSummary(
        picker.plan,
        theme,
        columns - 1 - RAIL_COLUMNS,
        this.queue.items(screen.threadId).length,
      );
    } else {
      const active = this.deps.themes?.current().name;
      for (const name of picker.names) items.push({ label: name, ...current(name === active) });
    }
    return renderPicker(
      {
        title,
        items,
        selected: Math.min(picker.selected, Math.max(0, items.length - 1)),
        hint,
        empty,
        ...(before === undefined ? {} : { before }),
      },
      columns,
      rows,
      style,
      this.symbols,
      notice?.text ?? null,
      notice?.tone,
    );
  }

  /** The bar's facts, each from where the server reports it; what is not reported is left out. */
  private statusBarInput(screen: ChatScreen, status: ThreadStatus | null): StatusBarInput {
    const { link } = this.deps;
    const threadShell = link.shell?.threads.find((thread) => thread.id === screen.threadId);
    const mirror = link.thread.thread?.id === screen.threadId ? link.thread.thread : null;
    const selection = this.modelOverride ?? null;
    const known = threadShell?.modelSelection ?? null;
    const model = selection
      ? selection.label
      : known
        ? this.labelForModel(known.instanceId, known.model)
        : (this.defaultModelLabel(screen.projectId) ??
          (link.config !== null && availableModels(link.config).length === 0
            ? t("session.c.noModelBar")
            : null));
    const onScreen = this.turnSelection(screen);
    const effort =
      onScreen === null ? null : resolveEffort(link.config, onScreen, this.effortPick).shown;
    return {
      model,
      effort,
      mode: `${runtimeModeLabel(this.runtimeModeOf(screen))}${this.runtimeIntent?.reserved === true ? ` (${this.heldFor(screen)})` : ""}`,
      plan: this.planBarText(screen),
      goal: this.goalBarText(screen),
      cwd: this.workspaceCwd(screen),
      home: this.deps.home ?? null,
      branch: mirror?.branch ?? threadShell?.branch ?? null,
      contextPercent: status?.context?.percent ?? null,
      costUsd: status?.costUsd ?? null,
      // Costs are summed over the turns that were loaded; an older part of the thread is not in it.
      costPartial: link.thread.hasOlder,
      ...this.crewBarInput(screen),
      // A crew task is counted by the crew segment, not as one of the agents.
      agents: this.agentsOutsideCrew(screen, status),
      hint:
        this.crewSub(screen) !== null
          ? t("session.c.hintCrewBack")
          : status?.phase === "working"
            ? null
            : t("session.c.hintHelp"),
    };
  }

  /** Models offered by /model: anything for a new thread, the thread's own provider once it has begun. */
  private pickableModels(screen: ChatScreen): ReadonlyArray<ModelChoice> {
    const { link } = this.deps;
    const shell = screen.isDraft
      ? undefined
      : link.shell?.threads.find((thread) => thread.id === screen.threadId);
    const started =
      shell !== undefined &&
      (shell.latestTurn !== null || shell.latestUserMessageAt !== null || shell.session !== null);
    return started
      ? compatibleModels(link.config, shell.modelSelection)
      : availableModels(link.config);
  }

  /**
   * What `/model` lists: the models above, and the thread's own model and the one picked here put
   * first when the server does not list them, so they can be seen, returned to, and the pointer
   * starts on the one in use.
   */
  private modelItems(screen: ChatScreen): ReadonlyArray<ModelChoice> {
    const models = this.pickableModels(screen);
    const base = this.baseModel(screen);
    const unlisted: ModelChoice[] = [];
    for (const kept of [
      base === null ? null : { ...base, label: this.labelForModel(base.instanceId, base.model) },
      this.modelOverride,
    ]) {
      if (kept === null) continue;
      if ([...models, ...unlisted].some((model) => sameModel(model, kept))) continue;
      unlisted.push({ instanceId: kept.instanceId, model: kept.model, label: kept.label });
    }
    return [...unlisted, ...models];
  }

  /** The model the thread runs on when nothing is picked here: its own, or the project's default for a new one. */
  private baseModel(screen: ChatScreen): ModelSelection | null {
    const own = this.deps.link.shell?.threads.find(
      (thread) => thread.id === screen.threadId,
    )?.modelSelection;
    if (own) return own;
    const project = this.deps.link.shell?.projects.find(
      (candidate) => candidate.id === screen.projectId,
    );
    return defaultModelSelection(project, this.deps.link.config);
  }

  /** The model the next message would run on: the one picked here, or the thread's own. */
  private currentModel(
    screen: ChatScreen,
  ): { readonly instanceId: string; readonly model: string } | null {
    return this.modelOverride ?? this.baseModel(screen);
  }

  private labelForModel(instanceId: string, model: string): string {
    const choice = availableModels(this.deps.link.config).find(
      (candidate) => candidate.instanceId === instanceId && candidate.model === model,
    );
    return choice?.label ?? model;
  }

  private defaultModelLabel(projectId: string): string | null {
    const project = this.deps.link.shell?.projects.find((candidate) => candidate.id === projectId);
    const selection = defaultModelSelection(project, this.deps.link.config);
    return selection ? this.labelForModel(selection.instanceId, selection.model) : null;
  }

  /** What `/model` shows for the typed words: the matches, best first; every model for no words. */
  private visibleModels(screen: ChatScreen, query: string): ReadonlyArray<ModelChoice> {
    return filterModels(this.modelItems(screen), query);
  }

  /** Where the pointer starts in the list for these words: on the model in use, else the top. */
  private modelPointer(screen: ChatScreen, query: string): number {
    const inUse = this.currentModel(screen);
    const index = this.visibleModels(screen, query).findIndex(
      (model) => inUse !== null && sameModel(model, inUse),
    );
    return Math.max(0, index);
  }

  /** The model selection the next turn is built from, before the effort is settled: the one on screen. */
  private turnSelection(screen: ChatScreen): ModelSelection | null {
    return this.modelOverride ? modelSelectionOf(this.modelOverride) : this.baseModel(screen);
  }

  // ---- permission mode and plan mode ---------------------------------------------------------

  /** A turn is in flight or waits for an answer; a mode picked now is held for the next one. */
  private turnRunning(screen: ChatScreen): boolean {
    const status = screen.status;
    return (
      status?.interruptible === true || status?.phase === "working" || status?.phase === "approval"
    );
  }

  private serverThread(screen: ChatScreen): {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  } | null {
    if (screen.isDraft) return null;
    const mirror = this.deps.link.thread.thread;
    if (mirror !== null && mirror.id === screen.threadId) return mirror;
    return this.deps.link.shell?.threads.find((thread) => thread.id === screen.threadId) ?? null;
  }

  /** The permission mode in force: what was picked for the next turn, else the thread's, else the default for new threads. */
  private runtimeModeOf(screen: ChatScreen): RuntimeMode {
    return (
      this.runtimeIntent?.value ?? this.serverThread(screen)?.runtimeMode ?? this.deps.runtimeMode
    );
  }

  private interactionModeOf(screen: ChatScreen): ProviderInteractionMode {
    return this.interactionIntent?.value ?? this.serverThread(screen)?.interactionMode ?? "default";
  }

  /** A pick the server's own value now shows is done with. */
  private settleModeIntents(screen: ChatScreen): void {
    const server = this.serverThread(screen);
    if (server === null) return;
    if (this.runtimeIntent?.value === server.runtimeMode) this.runtimeIntent = null;
    if (this.interactionIntent?.value === server.interactionMode) this.interactionIntent = null;
  }

  /** The provider the next message would go to; null while the server has not listed it. */
  private currentProvider(screen: ChatScreen): ServerProvider | null {
    const model = this.currentModel(screen);
    return (
      this.deps.link.config?.providers.find(
        (candidate) => candidate.instanceId === model?.instanceId,
      ) ?? null
    );
  }

  /** Plan mode needs a provider that offers the toggle, as in the desktop app. */
  private planSupported(screen: ChatScreen): boolean {
    const provider = this.currentProvider(screen);
    return provider !== null && provider.showInteractionModeToggle !== false;
  }

  /** The status bar's word for plan mode; null when the thread is in the plain mode and nothing is held. */
  private planBarText(screen: ChatScreen): string | null {
    const mode = this.interactionModeOf(screen);
    const held = this.interactionIntent?.reserved === true ? ` (${this.heldFor(screen)})` : "";
    if (mode === "plan") return `${t("session.c.planModeLabel")}${held}`;
    return held === "" ? null : `${t("session.c.defaultModeLabel")}${held}`;
  }

  /**
   * When a held pick takes effect: with the user's next message. A running goal starts its own turns
   * before that, from the mode stored on the thread, so there "next turn" would promise too much.
   */
  private heldFor(screen: ChatScreen): string {
    return this.goalContinuesByItself(screen)
      ? t("session.c.heldMessage")
      : t("session.c.heldTurn");
  }

  /** Why a mode cannot be held for later under a running turn; null when it can. */
  private heldModeRefusal(screen: ChatScreen, what: string): string | null {
    if (!this.goalContinuesByItself(screen)) return null;
    return t("session.c.goalHoldsMode", { what });
  }

  /** A step of the user's choice, left in the scrollback as a finished step. */
  private record(label: string, value: string): void {
    this.emit(this.answered({ label, value }));
  }

  /**
   * `/mode`: for a thread that has not started the pick is remembered for its first message; for
   * one that has, it is sent now when the thread is idle and held for the next turn while one runs.
   */
  private setRuntimeMode(screen: ChatScreen, mode: RuntimeMode, said: boolean): void {
    const label = runtimeModeLabel(mode);
    if (mode === this.runtimeModeOf(screen)) {
      if (said) this.notice = t("session.c.alreadyMode", { label });
      return;
    }
    // A refused pick changes nothing, so a failed send stays ready to resend; one that is taken
    // differs from what a resend would carry, which makes the resend wrong.
    const refusal =
      !screen.isDraft && mode !== this.serverThread(screen)?.runtimeMode && this.turnRunning(screen)
        ? this.heldModeRefusal(screen, t("session.c.whatPermission"))
        : null;
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    this.failedSend = null;
    if (screen.isDraft) {
      this.runtimeIntent = { value: mode, reserved: false };
      this.record(t("session.c.permissionMode"), label);
      return;
    }
    if (mode === this.serverThread(screen)?.runtimeMode) {
      this.runtimeIntent = null;
      this.record(t("session.c.permissionMode"), t("session.c.holdCancelled", { label }));
      return;
    }
    if (this.turnRunning(screen)) {
      // The server restarts the provider session when the permission mode changes, so a change is
      // never sent under a running turn (the desktop app waits for the next message too). A goal
      // starts its own turns from the thread's stored mode, so a held pick would not reach them
      // (refused above).
      this.runtimeIntent = { value: mode, reserved: true };
      this.record(t("session.c.permissionMode"), t("session.c.appliesNext", { label }));
      return;
    }
    const before = this.runtimeIntent;
    this.runtimeIntent = { value: mode, reserved: false };
    void this.run(
      runtimeModeCommand(this.deps.context, { threadId: screen.threadId, runtimeMode: mode }),
      t("session.c.permissionFailed"),
    ).then((outcome) => {
      if (outcome === "sent") this.record(t("session.c.permissionMode"), label);
      else if (this.screen === screen && this.runtimeIntent?.value === mode) {
        this.runtimeIntent = before;
      }
      this.render();
    });
  }

  /** `/plan` and `/default`: the same as `/mode`, for the plan mode. */
  private setInteractionMode(screen: ChatScreen, mode: ProviderInteractionMode): void {
    const label = t(mode === "plan" ? "session.c.planModeLabel" : "session.c.defaultModeLabel");
    if (mode === "plan" && !this.planSupported(screen)) {
      this.notice = t("session.c.noPlanSupport");
      return;
    }
    if (mode === this.interactionModeOf(screen)) {
      this.notice = t("session.c.alreadyPlan", { label });
      return;
    }
    const refusal =
      !screen.isDraft &&
      mode !== this.serverThread(screen)?.interactionMode &&
      this.turnRunning(screen)
        ? this.heldModeRefusal(screen, t("session.c.whatWorkMode"))
        : null;
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    this.failedSend = null;
    if (screen.isDraft) {
      this.interactionIntent = { value: mode, reserved: false };
      this.record(t("session.c.workMode"), label);
      return;
    }
    if (mode === this.serverThread(screen)?.interactionMode) {
      this.interactionIntent = null;
      this.record(t("session.c.workMode"), t("session.c.holdCancelled", { label }));
      return;
    }
    if (this.turnRunning(screen)) {
      this.interactionIntent = { value: mode, reserved: true };
      this.record(t("session.c.workMode"), t("session.c.appliesNext", { label }));
      return;
    }
    const before = this.interactionIntent;
    this.interactionIntent = { value: mode, reserved: false };
    void this.run(
      interactionModeCommand(this.deps.context, {
        threadId: screen.threadId,
        interactionMode: mode,
      }),
      t("session.c.workModeFailed"),
    ).then((outcome) => {
      if (outcome === "sent") this.record(t("session.c.workMode"), label);
      else if (this.screen === screen && this.interactionIntent?.value === mode) {
        this.interactionIntent = before;
      }
      this.render();
    });
  }

  /** The plan `/implement` would build: the thread's latest proposed plan, if nothing has built it yet. */
  private actionablePlan(screen: ChatScreen): LatestProposedPlanState | null {
    const { thread } = this.deps.link.thread;
    if (screen.isDraft || thread === null || thread.id !== screen.threadId) return null;
    const plan = findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null);
    return hasActionableProposedPlan(plan) ? plan : null;
  }

  /** Whether the thread's latest plan has been built already, which is why `/implement` has none to offer. */
  private builtPlan(screen: ChatScreen): boolean {
    const { thread } = this.deps.link.thread;
    if (screen.isDraft || thread === null || thread.id !== screen.threadId) return false;
    return findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  }

  /**
   * `/implement`: what the desktop app's Implement button sends. The plan goes as the message
   * `PLEASE IMPLEMENT THIS PLAN:` and the plan, in the plain mode, naming the plan as its source so
   * the server marks it built. The thread leaves plan mode first, as the app's does.
   */
  private async implementPlan(screen: ChatScreen): Promise<void> {
    const plan = this.actionablePlan(screen);
    if (plan === null) {
      this.notice = this.builtPlan(screen) ? t("session.c.planBuilt") : t("session.c.noPlan");
      return;
    }
    if (screen.status?.pending.approvals[0] || screen.status?.pending.userInputs[0]) {
      this.notice = t("session.c.answerPendingFirst");
      return;
    }
    if (this.crewSub(screen) !== null) {
      this.notice = t("session.c.crewPlanBack");
      return;
    }
    if (screen.status?.interruptible === true) {
      this.notice = t("session.c.busyCannotSend");
      return;
    }
    const refusal =
      this.startRefusal(screen) ?? (this.turnStarting(screen) ? t("session.c.waitingStart") : null);
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    const before = this.interactionIntent;
    this.interactionIntent = { value: "default", reserved: false };
    const command = this.turnCommandFor(screen, buildPlanImplementationPrompt(plan.planMarkdown), {
      interactionMode: "default",
      sourceProposedPlan: { threadId: screen.threadId, planId: plan.id },
    });
    if (command === null) {
      this.interactionIntent = before;
      return;
    }
    this.failedSend = null;
    const outcome = await this.sendTurn(screen, command);
    if (
      outcome !== "sent" &&
      this.screen === screen &&
      this.interactionIntent?.value === "default"
    ) {
      this.interactionIntent = before;
    }
    // The thread may have moved on while this went out, with nothing left to wake the queue.
    this.pumpQueue(screen);
    this.render();
  }

  /**
   * Sends the modes held for the next turn just before it, the way the desktop app does, since a
   * turn start does not change them on a thread that exists. False when one was refused or lost:
   * the turn is not sent, so it never runs under a mode the screen does not show.
   */
  private async applyHeldModes(screen: ChatScreen): Promise<boolean> {
    if (screen.isDraft) return true;
    const server = this.serverThread(screen);
    const steps: Array<{ command: ClientOrchestrationCommand; failure: string }> = [];
    const runtime = this.runtimeIntent;
    if (runtime !== null && runtime.value !== server?.runtimeMode) {
      steps.push({
        command: runtimeModeCommand(this.deps.context, {
          threadId: screen.threadId,
          runtimeMode: runtime.value,
        }),
        failure: t("session.c.permissionFailed"),
      });
    }
    const interaction = this.interactionIntent;
    if (interaction !== null && interaction.value !== server?.interactionMode) {
      steps.push({
        command: interactionModeCommand(this.deps.context, {
          threadId: screen.threadId,
          interactionMode: interaction.value,
        }),
        failure: t("session.c.workModeFailed"),
      });
    }
    for (const step of steps) {
      if ((await this.run(step.command, step.failure)) !== "sent") return false;
    }
    if (this.screen === screen) {
      if (this.runtimeIntent !== null)
        this.runtimeIntent = { ...this.runtimeIntent, reserved: false };
      if (this.interactionIntent !== null) {
        this.interactionIntent = { ...this.interactionIntent, reserved: false };
      }
    }
    return true;
  }

  // ---- reasoning effort ----------------------------------------------------------------------

  /** `/effort` opens the list of values the model offers; `/effort <value>` picks one. */
  private runEffortCommand(screen: ChatScreen, requested: string | undefined): void {
    const { link } = this.deps;
    const selection = this.turnSelection(screen);
    if (selection === null) {
      this.notice = t("session.c.noModelCheck");
      return;
    }
    const control = effortControl(link.config, selection);
    if (control === null) {
      this.notice = noEffortReason(link.config, selection);
      return;
    }
    if (requested === undefined) {
      const shown = resolveEffort(link.config, selection, this.effortPick).shown;
      const index = control.choices.findIndex((choice) => choice.value === shown);
      this.picker = { kind: "effort", selected: Math.max(0, index), control };
      return;
    }
    const wanted = requested.toLowerCase();
    const choice = control.choices.find((candidate) => candidate.value.toLowerCase() === wanted);
    if (choice === undefined) {
      this.notice = t("session.c.unknownEffort", {
        value: flatten(requested),
        choices: control.choices.map((entry) => entry.value).join(", "),
      });
      return;
    }
    this.pickEffort(screen, selection, control, choice.value, true);
  }

  private pickEffort(
    screen: ChatScreen,
    selection: ModelSelection,
    control: EffortControl,
    value: string,
    said: boolean,
  ): void {
    const shown = resolveEffort(this.deps.link.config, selection, this.effortPick).shown;
    if (value === shown) {
      if (said) this.notice = t("session.c.alreadyEffort", { value });
      return;
    }
    this.effortPick = value;
    // A resend would carry the old effort.
    this.failedSend = null;
    this.record(
      t("session.c.reasoningEffort"),
      control.promptInjected.includes(value) ? t("session.c.effortNextOnly", { value }) : value,
    );
  }

  // ---- goal ------------------------------------------------------------------------------------

  /** The goal is active and the server would start another turn by itself when this one ends. */
  private goalContinuesByItself(screen: ChatScreen): boolean {
    const goal = this.goalOf(screen);
    if (goal === null || !goal.active) return false;
    const view = this.goalView(screen, goal);
    return view === null || view.state === "working";
  }

  private goalOf(screen: ChatScreen): ThreadGoal | null {
    const settings: Partial<ServerSettings> | undefined = this.deps.link.config?.settings;
    return settings?.threadGoals?.[screen.threadId] ?? null;
  }

  /**
   * How the goal is going. A thread not loaded yet has no answer (null) rather than a count of
   * zero; a draft has run nothing. A window that starts after the goal was set makes the count
   * "at least", which the view says.
   */
  private goalView(screen: ChatScreen, goal: ThreadGoal): GoalView | null {
    if (screen.isDraft) return { state: "working", continues: 0, partial: false };
    const mirror = this.deps.link.thread;
    const thread = mirror.thread;
    if (thread === null || thread.id !== screen.threadId) return null;
    const memo = this.goalMemo;
    if (
      memo !== null &&
      memo.activities === thread.activities &&
      memo.goalId === goal.id &&
      memo.hasOlder === mirror.hasOlder
    ) {
      return memo.view;
    }
    const view = goalViewOf(goal, thread, mirror.hasOlder);
    this.goalMemo = {
      activities: thread.activities,
      goalId: goal.id,
      hasOlder: mirror.hasOlder,
      view,
    };
    return view;
  }

  private goalBarText(screen: ChatScreen): string | null {
    const goal = this.goalOf(screen);
    return goal === null ? null : goalBarText(goal, this.goalView(screen, goal));
  }

  /** `/goal ...`: show, set, clear, or change how many times the thread continues by itself. */
  private runGoalCommand(screen: ChatScreen, args: ReadonlyArray<string>, rest: string): void {
    if (rest === "") {
      this.showGoal(screen);
      return;
    }
    const first = args[0]?.toLowerCase();
    if (first === "clear" && args.length === 1) {
      void this.clearGoal(screen);
      return;
    }
    if (first === "max" && args.length <= 2) {
      const count = args[1] === undefined ? null : parseGoalMax(args[1]);
      if (count === null) {
        this.notice = t("session.c.goalMaxUsage", {
          min: GOAL_MAX_CONTINUES_RANGE.min,
          max: GOAL_MAX_CONTINUES_RANGE.max,
        });
        return;
      }
      void this.saveGoal(screen, null, count);
      return;
    }
    void this.saveGoal(screen, rest);
  }

  /** The goal as a note on the rail; with no goal, the question that asks for one. */
  private showGoal(screen: ChatScreen): void {
    const goal = this.goalOf(screen);
    if (goal === null) {
      this.prompt = { kind: "goal", editor: emptyEditor };
      return;
    }
    const { theme } = this.deps.style;
    const view = this.goalView(screen, goal);
    const room = Math.max(8, this.width - 6);
    const fold = (text: string) => wrapStyled(text, room);
    const status =
      view === null
        ? t("session.c.goalLoading")
        : t("session.c.goalStatus", {
            state: goalStateWord(view.state),
            continues: view.continues,
            plus: view.partial ? "+" : "",
            max: goal.maxContinues,
          });
    const body = [
      ...fold(flatten(goal.text)),
      "",
      ...fold(`${theme.dim(t("session.c.goalStatusLabel"))}  ${status}`),
      ...(view?.reason === undefined
        ? []
        : fold(`${theme.dim(t("session.c.goalReasonLabel"))}  ${flatten(view.reason)}`)),
      ...(view?.partial === true ? fold(theme.dim(t("session.c.goalPartial"))) : []),
      "",
      ...fold(theme.dim(t("session.c.goalHelp"))),
    ];
    this.emit([railGap(this.rail), ...railNote(this.rail, t("session.c.goal"), body, this.width)]);
  }

  /** What a failed settings change says, on the rail like a failed command. */
  private settingsFailed(failure: string, message: string): void {
    this.emit([noticeLine(this.rail, `${failure}: ${message}`, "error")]);
  }

  /**
   * Saves the goal over the settings read just now. Every save is a new goal (a new id), so the
   * progress of an earlier one never counts for it. `text` null keeps the current words and changes
   * only how many times the thread continues. The thread need not exist yet: the desktop app also
   * sets a goal on a new thread before its first message.
   */
  private async saveGoal(
    screen: ChatScreen,
    text: string | null,
    maxContinues?: number,
  ): Promise<void> {
    const id = this.deps.context.uuid();
    const now = this.deps.context.now();
    let saved: ThreadGoal | null = null;
    const result = await this.patchSettings((current) => {
      const previous = current.threadGoals[screen.threadId];
      const words = text ?? previous?.text;
      if (words === undefined) return null;
      const max = maxContinues ?? previous?.maxContinues;
      saved = makeGoal({
        text: words,
        id,
        now,
        ...(max === undefined ? {} : { maxContinues: max }),
      });
      return { threadGoals: goalsWith(current.threadGoals, screen.threadId, saved) };
    });
    if (this.screen !== screen) return;
    if (!result.ok) this.settingsFailed(t("session.c.goalSaveFailed"), result.message);
    else if (saved === null) this.notice = t("session.c.noGoalSet");
    else {
      const goal: ThreadGoal = saved;
      this.record(
        t("session.c.goal"),
        t("session.c.goalRecorded", { text: flatten(goal.text), max: goal.maxContinues }),
      );
      const held = [
        this.runtimeIntent?.reserved === true ? t("session.c.permissionMode") : null,
        this.interactionIntent?.reserved === true ? t("session.c.workMode") : null,
      ].filter((name) => name !== null);
      if (held.length > 0) {
        this.notice = t("session.c.heldFromNext", { held: held.join("·") });
      }
    }
    this.render();
  }

  /** Stops the goal. What it said is shown, with the command that sets it again. */
  private async clearGoal(screen: ChatScreen): Promise<void> {
    const result = await this.patchSettings((current) =>
      current.threadGoals[screen.threadId] === undefined
        ? null
        : { threadGoals: goalsWithout(current.threadGoals, screen.threadId) },
    );
    if (this.screen !== screen) return;
    if (!result.ok) this.settingsFailed(t("session.c.goalClearFailed"), result.message);
    else if (!result.changed) this.notice = t("session.c.noGoal");
    else {
      const cleared = result.before.threadGoals[screen.threadId];
      if (cleared !== undefined) {
        const { theme } = this.deps.style;
        const again = `/goal ${flatten(cleared.text)}`;
        this.emit([
          ...this.answered({ label: t("session.c.goalCleared"), value: flatten(cleared.text) }),
          ...railWrap(
            this.rail,
            theme.dim(t("session.c.toRestore", { command: again })),
            this.width,
          ),
          ...(cleared.maxContinues === DEFAULT_THREAD_GOAL_MAX_CONTINUES
            ? []
            : railWrap(this.rail, theme.dim(`/goal max ${cleared.maxContinues}`), this.width)),
        ]);
      }
    }
    this.render();
  }

  // ---- crew --------------------------------------------------------------------------------

  /** Whether the thread on screen is a crew task's own thread, and the lead that handed it out. */
  private crewSub(
    screen: ChatScreen,
  ): { readonly leadId: ThreadId | null; readonly label: string } | null {
    if (screen.isDraft) return null;
    const { link } = this.deps;
    const known = link.shell?.threads.find((thread) => thread.id === screen.threadId);
    const mirror = link.thread.thread?.id === screen.threadId ? link.thread.thread : null;
    const title = known?.title ?? mirror?.title;
    if (title === undefined) return null;
    const parent = known?.parentThreadId ?? mirror?.parentThreadId ?? null;
    if (!isCrewSubThread({ title, parentThreadId: parent })) return null;
    return { leadId: parent, label: crewSubThreadLabel(title) };
  }

  /** The board of the lead's newest turn that used the crew; null for a thread with none. */
  private crewBoardOf(screen: ChatScreen): CrewBoard | null {
    const thread = this.deps.link.thread.thread;
    if (thread === null || thread.id !== screen.threadId || screen.isDraft) return null;
    const running = this.turnRunning(screen);
    const memo = this.crewBoardMemo;
    if (
      memo !== null &&
      memo.activities === thread.activities &&
      memo.session === thread.session &&
      memo.latestTurn === thread.latestTurn &&
      memo.running === running
    ) {
      return memo.board;
    }
    const board = deriveCrewBoard(thread, running);
    this.crewBoardMemo = {
      activities: thread.activities,
      session: thread.session,
      latestTurn: thread.latestTurn,
      running,
      board,
    };
    return board;
  }

  /** Crew tasks of the thread that wait for an approval or an answer. */
  private crewWaiting(screen: ChatScreen): ReadonlyArray<WaitingCrewThread> {
    const shell = this.deps.link.shell;
    if (shell === null || screen.isDraft || this.crewSub(screen) !== null) return [];
    const memo = this.crewWaitMemo;
    if (memo !== null && memo.threads === shell.threads && memo.leadId === screen.threadId) {
      return memo.waiting;
    }
    const waiting = waitingCrewThreads(shell.threads, {
      id: screen.threadId,
      projectId: screen.projectId,
    });
    this.crewWaitMemo = { threads: shell.threads, leadId: screen.threadId, waiting };
    return waiting;
  }

  /** A crew request that waits while the user looks elsewhere, said so it is not forgotten. */
  private crewWarning(screen: ChatScreen): string | null {
    const { theme } = this.deps.style;
    const sub = this.crewSub(screen);
    if (sub !== null) {
      const lead = this.crewLead(sub);
      if (lead === undefined) return null;
      return theme.warning(
        t(lead.hasPendingApprovals ? "session.c.leadApproval" : "session.c.leadQuestion"),
      );
    }
    const text = waitingText(this.crewWaiting(screen));
    return text === null ? null : theme.warning(text);
  }

  /** The lead of a crew task, when it waits for the user. */
  private crewLead(sub: {
    readonly leadId: ThreadId | null;
  }): OrchestrationThreadShell | undefined {
    if (sub.leadId === null) return undefined;
    const lead = this.deps.link.shell?.threads.find((thread) => thread.id === sub.leadId);
    return lead !== undefined && (lead.hasPendingApprovals || lead.hasPendingUserInput)
      ? lead
      : undefined;
  }

  /** The crew's words for the status bar. */
  private crewBarInput(screen: ChatScreen): Pick<StatusBarInput, "crew" | "crewAlert"> {
    const { link } = this.deps;
    const sub = this.crewSub(screen);
    if (sub !== null)
      return { crew: t("session.c.crewTask"), crewAlert: this.crewLead(sub) !== undefined };
    const settings = crewSettingsOf(link.config?.settings);
    const on = crewEnabledFor(settings, screen.isDraft ? null : screen.threadId);
    const waiting = this.crewWaiting(screen).length;
    const board = this.crewBoardOf(screen);
    const text = crewBarText({ on, board, waiting });
    const unsupported = on && crewBrainProblem(link.config, this.turnSelection(screen)) !== null;
    return {
      crew: text === "crew" && unsupported ? t("session.c.crewUnsupported") : text,
      crewAlert: waiting > 0,
    };
  }

  /** Sub-agents the bar counts, leaving out the crew's tasks, which the crew segment counts. */
  private agentsOutsideCrew(screen: ChatScreen, status: ThreadStatus | null): number {
    const agents = status?.agents ?? [];
    if (agents.length === 0) return 0;
    const crewIds = new Set(this.crewBoardOf(screen)?.tasks.map((task) => task.taskId));
    return agents.filter((agent) => !crewIds.has(agent.id)).length;
  }

  private crewContextOf(screen: ChatScreen, now: number): CrewContext {
    const { link } = this.deps;
    const brain = this.turnSelection(screen);
    return crewContext({
      settings: crewSettingsOf(link.config?.settings),
      threadId: screen.isDraft ? null : screen.threadId,
      providers: link.config?.providers ?? [],
      brain,
      problem: crewBrainProblem(link.config, brain),
      board: this.crewBoardOf(screen),
      waiting: this.crewWaiting(screen),
      now,
    });
  }

  private handleCrewKey(view: CrewView, screen: ChatScreen, event: KeyEvent): void {
    const context = this.crewContextOf(screen, this.deps.now());
    const result = crewKey(view, context, event);
    this.crewView = result.view;
    if (result.notice !== undefined) this.notice = result.notice;
    if (result.effect.kind !== "none") this.runCrewEffect(screen, result.effect, context);
  }

  private runCrewEffect(screen: ChatScreen, effect: CrewEffect, context: CrewContext): void {
    switch (effect.kind) {
      case "toggle": {
        const enabled = !context.crew.enabled;
        if (enabled && context.problem !== null) this.notice = context.problem;
        void this.saveCrew(
          screen,
          { enabled },
          "Crew",
          t(enabled ? "session.c.on" : "session.c.off"),
        );
        return;
      }
      case "preset":
        void this.saveCrew(
          screen,
          { preset: effect.preset },
          t("session.c.crewPreset"),
          presetLabel(effect.preset),
        );
        return;
      case "pin":
        void this.saveCrew(
          screen,
          { pins: { [effect.role]: effect.pick.kind === "auto" ? null : effect.pick.selection } },
          t("session.c.roleModel", { role: roleName(effect.role) }),
          effect.pick.kind === "auto" ? "Auto" : effect.pick.label,
        );
        return;
      case "autoAll":
        void this.saveCrew(
          screen,
          { pins: { worker: null, expert: null, auditor: null } },
          t("session.c.crewRoleModels"),
          t("session.c.allAuto"),
        );
        return;
      case "default":
        void this.saveCrew(
          screen,
          "default",
          t("session.c.crewDefault"),
          t("session.c.crewDefaultNote"),
        );
        return;
      case "open":
        this.openCrewThread(effect.threadId);
        return;
      case "stop":
        void this.stopCrewTask(effect.task);
        return;
      case "retry":
        void this.retryCrewTask(screen, effect.task);
        return;
    }
  }

  /**
   * Writes a crew change over the settings read just now, as the desktop app does: in the thread's
   * own override, or in the defaults for a conversation not started yet. `"default"` makes what the
   * thread runs with the default for new threads.
   */
  private async saveCrew(
    screen: ChatScreen,
    change: CrewChange | "default",
    label: string,
    value: string,
  ): Promise<void> {
    const scope = screen.isDraft ? null : screen.threadId;
    const { link } = this.deps;
    const brain = this.turnSelection(screen);
    const result = await this.patchSettings((current) => {
      const crew: CrewSettings = crewSettingsOf(current);
      const next =
        change === "default"
          ? crewAsDefault(
              crew,
              resolveCrew({
                settings: crew,
                threadId: scope,
                providers: link.config?.providers ?? [],
                brain,
              }),
            )
          : applyCrewChange(crew, scope, change);
      return { crew: next };
    });
    if (this.screen !== screen) return;
    if (!result.ok) this.settingsFailed(t("session.c.crewSaveFailed"), result.message);
    else this.record(label, value);
    this.render();
  }

  /** Interrupts the task's own thread, which ends the task as stopped; it can be retried after. */
  private async stopCrewTask(task: CrewTask): Promise<void> {
    if (task.threadId === null || this.crewBusy) return;
    this.crewBusy = true;
    const outcome = await this.run(
      interruptCommand(this.deps.context, task.threadId),
      t("session.c.crewStopFailed"),
    );
    this.crewBusy = false;
    if (outcome === "sent")
      this.record("Crew", t("session.c.crewStopRequested", { role: roleName(task.role) }));
    this.render();
  }

  /** Runs a task that ended without finishing again, as a new task of the same lead. */
  private async retryCrewTask(screen: ChatScreen, task: CrewTask): Promise<void> {
    if (this.crewBusy) return;
    this.crewBusy = true;
    try {
      await this.deps.link.retryCrewTask({ leadThreadId: screen.threadId, taskId: task.taskId });
      this.record("Crew", t("session.c.crewRestarted", { role: roleName(task.role) }));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.emit([
        noticeLine(
          this.rail,
          t("session.c.crewRetryFailed", {
            detail: sanitizeForTerminal(detail).split("\n")[0] ?? "",
          }),
          "error",
        ),
      ]);
    }
    this.crewBusy = false;
    this.render();
  }

  /** Opens a crew task's own thread, or the lead it came from. */
  private openCrewThread(threadId: ThreadId): void {
    const target = this.deps.link.shell?.threads.find((thread) => thread.id === threadId);
    if (target === undefined) {
      this.notice = t("session.c.threadNotFound");
      return;
    }
    this.deps.link.closeThread();
    this.openChat(target.projectId, target.id, false);
    if (isCrewSubThread(target)) {
      this.record(t("session.c.crewTaskThread"), t("session.c.crewTaskThreadNote"));
    }
  }

  /** `/crew back`: from a crew task's thread to the lead that handed it out. */
  private backToLead(screen: ChatScreen): void {
    const sub = this.crewSub(screen);
    if (sub === null) {
      this.notice = t("session.c.crewBackOnlyInTask");
      return;
    }
    if (sub.leadId === null) {
      this.notice = t("session.c.leadUnknown");
      return;
    }
    this.openCrewThread(sub.leadId);
  }

  /**
   * `/crew` opens the screen; `/crew on|off`, `/crew preset <name>`, `/crew model <role> [model|auto]`
   * and `/crew default` change it directly; `/crew back` leaves a crew task's thread.
   */
  private runCrewCommand(screen: ChatScreen, args: ReadonlyArray<string>): void {
    const word = args[0]?.toLowerCase();
    const sub = this.crewSub(screen);
    if (sub !== null) {
      if (word === undefined || word === "back") this.backToLead(screen);
      else this.notice = t("session.c.crewBackOnly");
      return;
    }
    const context = this.crewContextOf(screen, this.deps.now());
    if (word === undefined) {
      this.crewView = openCrewView(context);
      return;
    }
    switch (word) {
      case "on":
      case "off": {
        const enabled = word === "on";
        if (enabled && context.problem !== null) this.notice = context.problem;
        if (enabled === context.crew.enabled) {
          this.notice ??= t("session.c.crewAlready", {
            state: t(enabled ? "session.c.on" : "session.c.off"),
          });
          return;
        }
        void this.saveCrew(
          screen,
          { enabled },
          "Crew",
          t(enabled ? "session.c.on" : "session.c.off"),
        );
        return;
      }
      case "preset": {
        if (args[1] === undefined) {
          this.crewView = {
            kind: "preset",
            selected: Math.max(
              0,
              PRESETS.findIndex((entry) => entry.value === context.crew.preset),
            ),
          };
          return;
        }
        const preset = parseCrewPreset(args[1]);
        if (preset === null) {
          this.notice = t("session.c.unknownPreset", {
            value: flatten(args[1]),
            words: presetWords(),
          });
          return;
        }
        void this.saveCrew(screen, { preset }, t("session.c.crewPreset"), presetLabel(preset));
        return;
      }
      case "model": {
        const role: CrewRole | null = args[1] === undefined ? null : parseCrewRole(args[1]);
        if (role === null) {
          this.notice =
            args[1] === undefined
              ? t("session.c.crewModelUsage")
              : t("session.c.unknownRole", { value: flatten(args[1]) });
          return;
        }
        const query = args.slice(2).join(" ");
        if (query === "") {
          this.crewView = openModelView(context, role);
          return;
        }
        if (query.toLowerCase() === "auto") {
          void this.saveCrew(
            screen,
            { pins: { [role]: null } },
            t("session.c.roleModel", { role: roleName(role) }),
            "Auto",
          );
          return;
        }
        const matches = crewPickItems(context.providers, null, query).filter(
          (item) => item.kind === "model",
        );
        const only = matches.length === 1 ? matches[0] : undefined;
        if (only?.kind === "model") {
          void this.saveCrew(
            screen,
            { pins: { [role]: only.selection } },
            t("session.c.roleModel", { role: roleName(role) }),
            only.label,
          );
        } else if (matches.length === 0) {
          this.notice = t("session.c.noModelNamed", { query: flatten(query) });
        } else {
          // Several models fit the words: the list, already narrowed, lets the user choose.
          this.crewView = openModelView(context, role, query);
        }
        return;
      }
      case "default":
        if (context.scope !== "thread") {
          this.notice = t("session.c.crewDefaultAlready");
          return;
        }
        void this.saveCrew(
          screen,
          "default",
          t("session.c.crewDefault"),
          t("session.c.crewDefaultNote"),
        );
        return;
      case "back":
        this.backToLead(screen);
        return;
      default:
        this.notice = t("session.c.crewUsage", { words: presetWords() });
    }
  }

  // ---- input -------------------------------------------------------------------------------

  handleKey(event: KeyEvent): void {
    if (this.disposed) return;
    if (event.type === "ctrl" && event.letter === "z") {
      this.deps.suspend?.();
      return;
    }
    if (this.notice !== null && event.type !== "paste") this.notice = null;
    // Only Ctrl-C pressed twice in a row quits; anything in between starts the count again.
    if (!(event.type === "ctrl" && event.letter === "c")) this.lastCtrlC = null;
    const screen = this.screen;
    if (screen.kind === "loading") {
      if (event.type === "ctrl" && (event.letter === "c" || event.letter === "d")) this.deps.exit();
      return;
    }
    this.handlingKey = true;
    try {
      if (screen.kind === "chat") this.handleChatKey(screen, event);
      else this.handlePickerKey(screen, event);
      this.render();
    } finally {
      this.handlingKey = false;
    }
  }

  private handlePickerKey(
    screen: Extract<Screen, { kind: "projects" | "threads" }>,
    event: KeyEvent,
  ): void {
    const projects = screen.kind === "projects" ? this.visibleProjects(screen) : [];
    const threads = screen.kind === "threads" ? this.visibleThreads(screen) : [];
    // The "New thread" row leads the thread list until words are typed.
    const lead = screen.kind === "threads" && screen.query === "" ? 1 : 0;
    const count = screen.kind === "projects" ? projects.length : lead + threads.length;
    const move = (delta: number) => {
      screen.selected = Math.max(0, Math.min(count - 1, screen.selected + delta));
    };
    if (event.type === "ctrl" && (event.letter === "c" || event.letter === "d")) {
      this.deps.exit();
      return;
    }
    if (event.type === "ctrl" && event.letter === "p" && screen.kind === "threads") {
      const pointed = threads[Math.min(screen.selected, count - 1) - lead];
      if (pointed) void this.togglePin(pointed);
      return;
    }
    // Letters are search here, as in `/model`: only the arrows, Home/End and Page keys move.
    if (event.type === "text" || event.type === "paste") {
      screen.query = appendToSearch(screen.query, event.text);
      screen.selected = 0;
      return;
    }
    if (event.type === "ctrl" && event.letter === "u") {
      screen.query = "";
      screen.selected = 0;
      return;
    }
    if (event.type !== "key") return;
    switch (event.name) {
      case "backspace":
        screen.query = eraseFromSearch(screen.query, event.ctrl || event.alt);
        screen.selected = 0;
        return;
      case "up":
        move(-1);
        return;
      case "down":
        move(1);
        return;
      case "pageup":
        move(-5);
        return;
      case "pagedown":
        move(5);
        return;
      case "home":
        screen.selected = 0;
        return;
      case "end":
        screen.selected = Math.max(0, count - 1);
        return;
      case "escape":
        // A search is undone before the list is left.
        if (screen.query !== "") {
          screen.query = "";
          screen.selected = 0;
        } else if (screen.kind === "threads") this.showProjects();
        else if (this.listedFrom !== null) this.closeList();
        return;
      case "enter":
        this.activatePickerItem(screen, projects, threads);
        return;
      default:
        return;
    }
  }

  /** Once the server's list shows the pin changed, the pointer moves to where the thread went. */
  private followPinned(screen: Extract<Screen, { kind: "threads" }>): void {
    const follow = screen.follow;
    if (follow === null) return;
    const rows = this.visibleThreads(screen);
    const at = rows.findIndex((thread) => thread.id === follow.id);
    if (at < 0 || isPinned(rows[at] as OrchestrationThreadShell) !== follow.pinned) return;
    screen.follow = null;
    screen.selected = at + (screen.query === "" ? 1 : 0);
  }

  /** Pins the thread, or unpins it when it is pinned; the list shows the server's word for it. */
  private async togglePin(thread: OrchestrationThreadShell): Promise<void> {
    const link = this.deps.link;
    if (link.config?.environment.capabilities.threadPinning !== true) {
      this.notice = t("session.c.pinUnsupported");
      this.render();
      return;
    }
    const { context } = this.deps;
    const pinning = !isPinned(thread);
    const command = pinning
      ? pinCommand(context, {
          threadId: thread.id,
          // A server that predates arranged order would reject the key.
          orderKey:
            link.config.environment.capabilities.threadPinReorder === true
              ? topPinOrderKey(link.shell?.threads ?? [])
              : undefined,
        })
      : unpinCommand(context, thread.id);
    const screen = this.screen;
    if (screen.kind === "threads") screen.follow = { id: thread.id, pinned: pinning };
    const outcome = await this.run(
      command,
      t(pinning ? "session.c.pinFailed" : "session.c.unpinFailed"),
    );
    if (outcome === "sent") {
      // The shell may have changed before the answer came.
      if (this.screen === screen && screen.kind === "threads") this.followPinned(screen);
    } else if (screen.kind === "threads") screen.follow = null;
    this.render();
  }

  /** Esc on the project list: back to the chat it was opened from, or out of the app if there is none. */
  private closeList(): void {
    const back = this.listedFrom;
    if (back === null) {
      this.deps.exit();
      return;
    }
    this.endSetup(null);
    this.openChat(back.projectId, back.threadId, back.isDraft);
    this.modelOverride = back.choices.modelOverride;
    this.effortPick = back.choices.effortPick;
    this.runtimeIntent = back.choices.runtimeIntent;
    this.interactionIntent = back.choices.interactionIntent;
    this.render();
  }

  private activatePickerItem(
    screen: Extract<Screen, { kind: "projects" | "threads" }>,
    projects: ReadonlyArray<OrchestrationProjectShell>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): void {
    if (this.deps.link.shell === null) return;
    if (screen.kind === "projects") {
      const project = projects[screen.selected];
      if (project) {
        this.hold(this.answered({ label: t("session.c.projectLabel"), value: project.title }));
        if (this.startPrompt !== null) this.openWithPrompt(project.id);
        else this.showThreads(project.id);
      }
      return;
    }
    if (screen.query === "" && screen.selected === 0) {
      this.endSetup({ label: t("session.c.threadLabel"), value: t("session.c.newThread") });
      this.openChat(screen.projectId, null, true);
      return;
    }
    const thread = threads[screen.selected - (screen.query === "" ? 1 : 0)];
    if (thread) {
      this.endSetup({ label: t("session.c.threadLabel"), value: thread.title });
      this.openChat(thread.projectId, thread.id, false);
    }
  }

  private composerWidth(): number {
    return Math.max(2, this.deps.region.usableColumns() - RAIL_COLUMNS);
  }

  private handleChatKey(screen: ChatScreen, event: KeyEvent): void {
    if (event.type === "ctrl" && event.letter === "c") {
      this.onCtrlC(screen);
      return;
    }
    if (this.picker !== null) {
      this.handlePickerListKey(this.picker, event);
      return;
    }
    if (this.stats !== null) {
      this.handleStatsKey(this.stats, screen, event);
      return;
    }
    if (this.prompt !== null) {
      this.handlePromptKey(this.prompt, screen, event);
      return;
    }
    if (this.crewView !== null) {
      this.handleCrewKey(this.crewView, screen, event);
      return;
    }
    if (this.provider.isOpen()) {
      this.provider.key(event);
      return;
    }
    if (event.type === "key" && (event.name === "pageup" || event.name === "pagedown")) {
      if (event.name === "pageup") this.deps.region.scrollUp?.();
      else this.deps.region.scrollDown?.();
      return;
    }
    this.deps.region.follow?.();
    const status = screen.status;
    // A request behind an open menu has no panel yet, so no key of the menu can be its answer.
    const held = this.requestHeld(screen);
    const approval = held ? undefined : status?.pending.approvals[0];
    const question = held ? undefined : status?.pending.userInputs[0];
    // The way out of a panel that wants an answer: nothing is answered, the request stays open.
    if ((approval || question) && event.type === "ctrl" && event.letter === "t") {
      this.leaveChat("threads");
      return;
    }
    // With no panel to leave, Ctrl-T folds the plan of the running turn (and unfolds it again);
    // while the task list shows the plan the fold is not on screen, so the key leaves it alone.
    if (event.type === "ctrl" && event.letter === "t") {
      if (status?.plan.length && !this.tasksOn) screen.planCollapsed = !screen.planCollapsed;
      return;
    }
    if (approval) {
      this.handleApprovalKey(screen, approval, event);
      return;
    }
    // While the menu is open its keys are the menu's: arrows pick, Tab completes, Enter runs, Esc closes.
    const menu = this.slashMenu();
    if (menu !== null && event.type === "key") {
      if (event.name === "escape") {
        this.menuClosedFor = editorText(this.editor);
        return;
      }
      const picked = menu.items[menu.selected];
      if (picked !== undefined) {
        if (event.name === "up" || event.name === "down") {
          this.menuIndex = Math.max(
            0,
            Math.min(menu.items.length - 1, menu.selected + (event.name === "up" ? -1 : 1)),
          );
          return;
        }
        // The provider's own commands are not run here: the composer gets the name, to add arguments.
        // A name typed out in full is the message itself, as it was before the menu listed them.
        if (picked.fill !== undefined && (event.name === "tab" || event.name === "enter")) {
          if (
            event.name === "enter" &&
            editorText(this.editor).toLowerCase() === picked.label.toLowerCase()
          ) {
            void this.submit(screen);
            return;
          }
          this.editor = editorFromText(picked.fill);
          this.menuIndex = 0;
          return;
        }
        if (event.name === "tab") {
          const command = SLASH_COMMANDS.find((candidate) => `/${candidate.name}` === picked.label);
          this.editor = editorFromText(`${picked.label}${command?.takesArgument ? " " : ""}`);
          this.menuIndex = 0;
          return;
        }
        if (event.name === "enter") {
          this.editor = editorFromText(picked.label);
          void this.submit(screen);
          return;
        }
      }
    }
    if (event.type === "key" && event.name === "escape") {
      if (question?.dismissible) this.dismissQuestion(screen, question.requestId);
      else if (status?.interruptible) this.interrupt(screen);
      return;
    }
    if (event.type === "ctrl" && event.letter === "d") {
      if (this.editor.chars.length === 0) this.deps.exit();
      else this.editor = deleteForward(this.editor);
      return;
    }
    if (event.type === "key" && event.name === "enter") {
      void this.submit(screen);
      return;
    }
    // Up on an empty composer takes the newest queued message back to edit or delete.
    if (
      event.type === "key" &&
      event.name === "up" &&
      !event.alt &&
      !event.ctrl &&
      this.editor.chars.length === 0 &&
      question === undefined
    ) {
      const taken = this.queue.takeLast(screen.threadId);
      if (taken !== undefined) {
        this.editor = editorFromText(taken);
        return;
      }
    }
    const before = this.editor.chars;
    this.editComposer(event);
    // An edit builds a new buffer; moving the cursor keeps the old one.
    if (this.editor.chars !== before) {
      this.menuIndex = 0;
      this.menuClosedFor = null;
    }
  }

  /**
   * The statistics screen answers to its own keys and to nothing else, so a word typed there never
   * lands in the composer. It is drawn again on each key, never on a timer.
   */
  private handleStatsKey(stats: StatsScreen, screen: ChatScreen, event: KeyEvent): void {
    const tabs = [0, 1, 2] as const;
    if (event.type === "text") {
      if (event.text === "q") this.stats = null;
      else if (event.text === "1" || event.text === "2" || event.text === "3") {
        stats.tab = tabs[Number(event.text) - 1] ?? stats.tab;
      }
      return;
    }
    if (event.type !== "key") return;
    switch (event.name) {
      case "escape":
        this.stats = null;
        return;
      case "left":
        stats.tab = tabs[Math.max(0, stats.tab - 1)] ?? stats.tab;
        return;
      case "right":
        stats.tab = tabs[Math.min(tabs.length - 1, stats.tab + 1)] ?? stats.tab;
        return;
      case "up":
      case "down": {
        const names = this.statsTools(screen);
        const at = Math.max(0, names.indexOf(stats.selected ?? ""));
        const next = Math.max(0, Math.min(names.length - 1, at + (event.name === "up" ? -1 : 1)));
        stats.selected = names[next] ?? null;
        return;
      }
      default:
        return;
    }
  }

  /** The tools the statistics list, in the order they list them; the pick is one of these by name. */
  private statsTools(screen: ChatScreen): string[] {
    const thread = this.deps.link.thread.thread;
    return thread?.id === screen.threadId ? statsToolNames(thread.activities) : [];
  }

  /**
   * Keys only pick an option; Enter sends the pick. Typing that is not an option drops the pick and
   * locks the numbers, so the tail of a sentence written before the panel appeared (`sleep 3`) cannot
   * add up to a decision. The arrows unlock them.
   */
  private handleApprovalKey(
    screen: ChatScreen,
    approval: {
      readonly requestId: string;
      readonly options?: ReadonlyArray<ProviderApprovalOption>;
    },
    event: KeyEvent,
  ): void {
    const list = this.approvalOptions(approval.options);
    const { requestId } = approval;
    const current = this.approvalChoice?.requestId === requestId ? this.approvalChoice : null;
    const chosen = current?.index ?? null;
    const locked = current?.locked ?? false;
    const pick = (index: number) => {
      this.approvalChoice = { requestId, index, locked: false };
    };
    const lock = () => {
      this.approvalChoice = { requestId, index: null, locked: true };
    };
    if (event.type === "text") {
      const index = /^[1-9]$/u.test(event.text) ? Number(event.text) - 1 : -1;
      if (index >= 0 && index < list.length && !locked) pick(index);
      else lock();
      return;
    }
    if (event.type === "paste") {
      lock();
      return;
    }
    if (event.type !== "key") return;
    switch (event.name) {
      case "escape":
        this.interrupt(screen);
        return;
      case "up":
        pick(chosen === null ? list.length - 1 : Math.max(0, chosen - 1));
        return;
      case "down":
        pick(chosen === null ? 0 : Math.min(list.length - 1, chosen + 1));
        return;
      case "enter": {
        const option = chosen === null ? undefined : list[chosen];
        if (option) this.answerApproval(screen, requestId, option);
        else this.notice = locked ? t("session.c.arrowsThenEnter") : t("session.c.pickFirst");
        return;
      }
      default:
        return;
    }
  }

  private editComposer(event: KeyEvent): void {
    const width = this.composerWidth();
    if (event.type === "text" || event.type === "paste") {
      this.editor = insertText(this.editor, event.text);
      this.historyIndex = -1;
      return;
    }
    if (event.type === "ctrl") {
      switch (event.letter) {
        case "a":
          this.editor = moveHome(this.editor);
          return;
        case "e":
          this.editor = moveEnd(this.editor);
          return;
        case "u":
          this.editor = killToLineStart(this.editor);
          return;
        case "k":
          this.editor = killToLineEnd(this.editor);
          return;
        case "w":
          this.editor = deleteWordBack(this.editor);
          return;
        case "b":
          this.editor = moveLeft(this.editor);
          return;
        case "f":
          this.editor = moveRight(this.editor);
          return;
        case "l":
          this.deps.region.abandon();
          return;
        default:
          return;
      }
    }
    if (event.type !== "key") return;
    const word = event.alt || event.ctrl;
    switch (event.name) {
      case "backspace":
        this.editor = word ? deleteWordBack(this.editor) : backspace(this.editor);
        return;
      case "delete":
        this.editor = deleteForward(this.editor);
        return;
      case "left":
        this.editor = word ? moveWordLeft(this.editor) : moveLeft(this.editor);
        return;
      case "right":
        this.editor = word ? moveWordRight(this.editor) : moveRight(this.editor);
        return;
      case "home":
        this.editor = moveHome(this.editor);
        return;
      case "end":
        this.editor = moveEnd(this.editor);
        return;
      case "newline":
        this.editor = insertNewline(this.editor);
        return;
      case "up": {
        const moved = moveVertical(this.editor, width, -1);
        if (moved) this.editor = moved;
        else this.recallHistory(-1);
        return;
      }
      case "down": {
        const moved = moveVertical(this.editor, width, 1);
        if (moved) this.editor = moved;
        else this.recallHistory(1);
        return;
      }
      default:
        return;
    }
  }

  private recallHistory(direction: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      if (direction === 1) return;
      this.historyDraft = editorText(this.editor);
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += direction === -1 ? -1 : 1;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.editor = editorFromText(this.historyDraft);
        return;
      }
      this.historyIndex = Math.max(0, this.historyIndex);
    }
    this.editor = editorFromText(this.history[this.historyIndex] ?? "");
  }

  /**
   * Two Ctrl-C in quick succession always quit, whatever the state: a pending request or a dead
   * link must never trap the user. The first one interrupts, clears the draft, or just warns.
   */
  private onCtrlC(screen: ChatScreen): void {
    const now = this.deps.now();
    if (this.lastCtrlC !== null && now - this.lastCtrlC < DOUBLE_CTRL_C_MS) {
      this.deps.exit();
      return;
    }
    this.lastCtrlC = now;
    if (screen.status?.interruptible) {
      if (this.interrupt(screen) === "requested") {
        this.notice = t("session.c.interruptCtrlC", { notice: interruptNotice() });
      }
      return;
    }
    const composerShown =
      this.picker === null &&
      this.prompt === null &&
      this.crewView === null &&
      !this.provider.isOpen() &&
      this.panelKey?.startsWith("approval:") !== true;
    if (composerShown && editorText(this.editor) !== "") {
      this.editor = emptyEditor;
      this.notice = t("session.c.inputClearedCtrlC");
      return;
    }
    this.notice = t("session.c.ctrlCAgain");
  }

  // ---- actions -----------------------------------------------------------------------------

  private async run(command: ClientOrchestrationCommand, failure: string): Promise<Outcome> {
    try {
      await this.deps.link.dispatch(command);
      return "sent";
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.emit([
        noticeLine(this.rail, `${failure}: ${sanitizeForTerminal(detail).split("\n")[0]}`, "error"),
      ]);
      return cause instanceof CommandRejectedError ? "rejected" : "failed";
    }
  }

  /** "warned" when live background agents ask for a second press first; nothing is sent then. */
  private interrupt(screen: ChatScreen): "requested" | "warned" {
    if (screen.isDraft) return "requested";
    // A stop already on its way has nothing left to confirm.
    if (this.stopRequested !== screen.threadId) {
      const mirror = this.deps.link.thread.thread;
      const step = nextStopStep({
        liveAgentCount:
          mirror !== null && mirror.id === screen.threadId ? agentModelOf(mirror).liveCount : 0,
        warnedAt: this.stopWarnedAt,
        now: this.deps.now(),
      });
      if (step.kind === "warn") {
        this.stopWarnedAt = this.deps.now();
        this.notice = t("session.c.stopAgentsWarn", { count: step.agentCount });
        return "warned";
      }
    }
    this.stopWarnedAt = null;
    this.takeBackQueue(screen);
    this.notice = interruptNotice();
    this.stopRequested = screen.threadId;
    void this.run(
      interruptCommand(this.deps.context, screen.threadId),
      t("session.c.interruptFailed"),
    ).then((outcome) => {
      if (outcome !== "sent" && this.stopRequested === screen.threadId) this.stopRequested = null;
      // The request is answered now, by the line below or by the failure `run` printed.
      if (this.notice?.startsWith(interruptNotice())) this.notice = null;
      // Said once for the turn, however many times Esc was pressed; nothing is said when it ends by itself.
      if (outcome === "sent" && !this.interruptShown) {
        this.interruptShown = true;
        this.emit([
          railGap(this.rail),
          railCancelled(this.rail, this.deps.style.theme.error(t("session.c.interrupted"))),
        ]);
      }
      this.render();
    });
    return "requested";
  }

  private approvalOptions(options: ReadonlyArray<ProviderApprovalOption> | undefined) {
    return options && options.length > 0 ? options : defaultApprovalOptions();
  }

  private answerApproval(
    screen: ChatScreen,
    requestId: string,
    choice: ProviderApprovalOption,
  ): void {
    if (this.responding === requestId) return;
    this.startResponding(requestId);
    const kind = requestKindLabel(screen.status?.pending.approvals[0]?.requestKind ?? "");
    const command = approvalCommand(this.deps.context, {
      threadId: screen.threadId,
      requestId,
      decision: choice.decision,
    });
    void this.run(command, t("session.c.approvalFailed")).then((outcome) => {
      if (outcome === "sent") {
        this.emit(
          this.answered({ label: t("session.c.approvalLabel", { kind }), value: choice.label }),
        );
      } else {
        // The request is still open; the next answer is a fresh pick, not this one waiting for Enter.
        this.responding = null;
        this.approvalChoice = null;
      }
      this.render();
    });
  }

  private startResponding(requestId: string): void {
    this.responding = requestId;
    this.respondingBaseline = new Set(
      (this.deps.link.thread.thread?.activities ?? [])
        .filter((activity) => FAILED_REPLY_KINDS.has(activity.kind))
        .map((activity) => activity.id),
    );
  }

  private draftFor(requestId: string): QuestionDraft {
    if (this.questionDraft?.requestId !== requestId) {
      this.questionDraft = { requestId, index: 0, answers: {}, sent: "" };
    }
    return this.questionDraft;
  }

  private dismissQuestion(screen: ChatScreen, requestId: string): void {
    this.questionDraft = null;
    void this.run(
      dismissUserInputCommand(this.deps.context, { threadId: screen.threadId, requestId }),
      t("session.c.skipFailed"),
    ).then(() => this.render());
  }

  private answerQuestion(screen: ChatScreen, text: string): void {
    const pending = screen.status?.pending.userInputs[0];
    if (!pending || this.responding === pending.requestId) return;
    const draft = this.draftFor(pending.requestId);
    const question = pending.questions[draft.index];
    if (!question) return;
    let value: string | string[] | null = null;
    const numbers = text.split(/[\s,]+/u).filter((part) => part !== "");
    const picked = numbers.map((part) =>
      /^\d+$/u.test(part) ? question.options[Number(part) - 1] : undefined,
    );
    if (
      question.options.length > 0 &&
      numbers.length > 0 &&
      picked.every((option) => option !== undefined)
    ) {
      const labels = picked.map((option) => option!.label);
      if (question.multiSelect === true) value = labels;
      else if (labels.length === 1) value = labels[0]!;
    }
    if (value === null && question.allowCustomAnswer !== false && text !== "") value = text;
    if (value === null) {
      this.notice =
        question.options.length > 0 ? t("session.c.answerWithNumber") : t("session.c.enterAnswer");
      return;
    }
    draft.answers[question.id] = value;
    this.editor = emptyEditor;
    const step = {
      label:
        pending.questions.length > 1
          ? t("session.c.questionN", { n: draft.index + 1, total: pending.questions.length })
          : t("session.c.question"),
      value: Array.isArray(value) ? value.join(", ") : value,
    };
    if (draft.index + 1 < pending.questions.length) {
      this.emit(this.answered(step));
      draft.index += 1;
      return;
    }
    draft.sent = text;
    this.startResponding(pending.requestId);
    const command = userInputCommand(this.deps.context, {
      threadId: screen.threadId,
      requestId: pending.requestId,
      answers: draft.answers,
    });
    void this.run(command, t("session.c.answerFailed")).then((outcome) => {
      if (outcome === "sent") {
        this.emit(this.answered(step));
      } else {
        // The draft stays: the panel is still on the last question, and the earlier answers are kept.
        this.responding = null;
        // Give the typed answer back so it need not be written again, but only to the panel that
        // asked: once it is gone or another one is up, the answer is no longer anyone's.
        const asking = `input:${pending.requestId}`;
        if (
          this.screen === screen &&
          this.panelKey === asking &&
          this.pendingKey(screen) === asking &&
          editorText(this.editor) === ""
        ) {
          this.editor = editorFromText(text);
        }
      }
      this.render();
    });
  }

  /** Why a message that starts with a slash was not sent, and the way to send it anyway. */
  private heldSlashNotice(screen: ChatScreen, held: HeldSlash): string {
    const word = flatten(held.word);
    const sendAnyway = t("session.c.sendAnyway");
    if (held.kind === "arguments") {
      const alias = held.command !== undefined && held.command !== word.toLowerCase();
      return t("session.c.noArguments", {
        command: `/${word}${alias ? ` (/${held.command})` : ""}`,
        sendAnyway,
      });
    }
    const near =
      held.nearest === null ? "" : t("session.c.nearest", { command: `/${held.nearest}` });
    // The folder's own commands come from a separate ask; until it is answered the list may be short.
    const late = this.workspace.pending(this.currentProvider(screen), this.workspaceCwd(screen))
      ? t("session.c.projectCmdsLate")
      : "";
    return t("session.c.unknownCommand", { word, near, late, sendAnyway });
  }

  private async submit(screen: ChatScreen): Promise<void> {
    const typed = editorText(this.editor);
    const text = typed.trim();
    // Commands first: a question waiting for an answer must not make /threads or /exit unreachable.
    if (this.runSlashCommand(screen, text)) {
      this.render();
      return;
    }
    // Enter in a menu is neither the answer to a request whose panel is not up yet nor a message
    // while the panel on screen is not the request there is.
    if (this.panelDeferred(screen)) return;
    if (screen.status?.pending.userInputs[0]) {
      this.answerQuestion(screen, text);
      this.render();
      return;
    }
    if (text === "") {
      // An empty Enter lets a stopped queue go on; a turn that has not shown yet is still waited for.
      if (this.queue.items(screen.threadId).length > 0) {
        const refusal = this.undoRefusal(screen);
        if (refusal !== null) this.notice = refusal;
        else {
          this.queue.release(screen.threadId);
          this.pumpQueue(screen);
        }
        this.render();
      }
      return;
    }
    if (this.crewSub(screen) !== null) {
      // The lead is the one that is talked to; a message typed here would reach a task, not the lead.
      this.notice = t("session.c.crewSendLead");
      this.render();
      return;
    }
    const refusal = this.startRefusal(screen);
    if (refusal !== null) {
      this.notice = refusal;
      this.render();
      return;
    }
    const again = this.failedSend;
    // A resend of text that already got through this check (or was sent past it) is not asked again.
    const resend = again !== null && again.threadId === screen.threadId && again.text === text;
    const unknown = resend ? null : unknownSlash(typed, this.currentProvider(screen));
    if (unknown !== null) {
      // The words stay in the composer; nothing reaches the agent.
      this.notice = this.heldSlashNotice(screen, unknown);
      this.render();
      return;
    }
    // The server refuses a longer turn; saying so here keeps the text for the user to cut.
    if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      const over = text.length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
      this.notice = t("session.c.messageTooLong", {
        limit: PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US"),
        over: over.toLocaleString("en-US"),
      });
      this.render();
      return;
    }
    // While a turn runs, or one is about to show, the message waits its turn; one typed behind a queue lines up behind it.
    if (
      screen.status?.interruptible === true ||
      this.queue.items(screen.threadId).length > 0 ||
      this.turnStarting(screen)
    ) {
      this.pushHistory(text);
      this.editor = emptyEditor;
      this.queue.push(screen.threadId, text);
      this.queue.release(screen.threadId);
      this.pumpQueue(screen);
      this.render();
      return;
    }
    await this.transmit(screen, text, "composer");
  }

  /** An undo of this thread is on its way: no turn starts, and the queue stays where it is, until the server has answered. */
  private undoRefusal(screen: ChatScreen): string | null {
    return this.undo.active(screen.threadId, this.deps.now()) ? t("session.c.undoingSend") : null;
  }

  /** Why no turn can start from here now, as a notice; every way of starting one asks. */
  private startRefusal(screen: ChatScreen): string | null {
    const undoing = this.undoRefusal(screen);
    if (undoing !== null) return undoing;
    if (this.deps.link.status.phase !== "online" || this.sending) {
      return t("session.c.connectToSend");
    }
    return null;
  }

  private pushHistory(text: string): void {
    this.history = [...this.history.filter((entry) => entry !== text), text].slice(-HISTORY_LIMIT);
    this.historyIndex = -1;
  }

  /**
   * Starts the turn for `text`, from the composer or from the queue. A message that does not go goes
   * back where it came from: into the composer, or to the head of the queue, stopped. Returns
   * whether a send was attempted.
   */
  private async transmit(
    screen: ChatScreen,
    text: string,
    from: "composer" | "queue",
  ): Promise<boolean> {
    const link = this.deps.link;
    this.reconcileDraft(screen);
    const retry = this.failedSend;
    let command: ClientOrchestrationCommand;
    if (retry !== null && retry.threadId === screen.threadId && retry.text === text) {
      // Same text again after a failure: the server may have taken the first try, so resend it as is.
      command = screen.isDraft ? retry.command : withoutBootstrap(retry.command);
    } else {
      const built = this.turnCommandFor(screen, text);
      if (built === null) {
        if (from === "queue") {
          this.queue.restore(screen.threadId, text, "failed");
          this.render();
        }
        return false;
      }
      command = built;
    }
    if (from === "composer") {
      this.pushHistory(text);
      this.editor = emptyEditor;
    }
    const outcome = await this.sendTurn(screen, command);
    if (outcome !== "sent") {
      // Put the words back, and keep the command for a resend, only where the user still is.
      if (this.screen === screen) {
        this.failedSend =
          outcome === "failed" && command.type === "thread.turn.start"
            ? { threadId: screen.threadId, messageId: command.message.messageId, text, command }
            : null;
      }
      if (from === "queue") {
        // The words wait at the head of their own thread's queue, stopped, whichever thread is on screen.
        this.queue.restore(screen.threadId, text, "failed");
      } else if (this.screen === screen) {
        // Under a panel the composer holds its answer; the words wait with the draft put aside.
        this.putInComposer(text, "before");
      }
    } else {
      if (screen.isDraft && this.screen === screen) {
        screen.isDraft = false;
        link.openThread(screen.threadId);
      }
      // The first message is out: this is a conversation now.
      this.endHome();
    }
    // The thread may have moved on while this went out, with nothing left to wake the queue.
    this.pumpQueue(screen);
    this.render();
    return true;
  }

  /**
   * Sends a built turn start: how every turn begins, whether it is typed, queued or `/implement`.
   * The modes picked while the last turn ran go first, and one refused stops the turn. One turn is
   * in flight at a time. A value the agent reads in the prompt belongs to the one message it went
   * with.
   */
  private async sendTurn(
    screen: ChatScreen,
    command: ClientOrchestrationCommand,
  ): Promise<Outcome> {
    this.sending = true;
    this.render();
    const outcome = (await this.applyHeldModes(screen))
      ? await this.run(command, t("session.c.sendFailed"))
      : "rejected";
    this.sending = false;
    if (outcome !== "sent") return outcome;
    this.failedSend = null;
    const sentOn = this.turnSelection(screen);
    if (
      this.screen === screen &&
      sentOn !== null &&
      resolveEffort(this.deps.link.config, sentOn, this.effortPick).promptEffort !== null
    ) {
      this.effortPick = null;
    }
    return outcome;
  }

  /**
   * The turn-start command for `text` on the model on screen. A turn always names that model,
   * options included. Null, with the reason said as a notice, when no model can be named.
   */
  private turnCommandFor(
    screen: ChatScreen,
    text: string,
    options: {
      readonly interactionMode?: ProviderInteractionMode;
      readonly sourceProposedPlan?: {
        readonly threadId: ThreadId;
        readonly planId: OrchestrationProposedPlanId;
      };
    } = {},
  ): ClientOrchestrationCommand | null {
    const { link } = this.deps;
    const project = link.shell?.projects.find((candidate) => candidate.id === screen.projectId);
    const picked = this.modelOverride;
    const base = this.baseModel(screen);
    if (
      picked !== null &&
      !(base !== null && sameModel(picked, base)) &&
      !this.pickableModels(screen).some((choice) => sameModel(choice, picked))
    ) {
      // Never send a model quietly that this thread cannot run; the text stays in the composer.
      this.modelOverride = null;
      this.notice = t("session.c.modelUnusable");
      this.render();
      return null;
    }
    // A turn always names the model on screen, options included: the server runs a turn that
    // names none on the model of the one before, which may be another than the one shown here.
    const chosen = picked ? modelSelectionOf(picked) : (base ?? undefined);
    // The effort on screen is the effort sent; one the agent reads in the prompt goes there.
    const resolved =
      chosen === undefined ? undefined : resolveEffort(link.config, chosen, this.effortPick);
    const override = resolved?.selection;
    let create:
      | { projectId: ProjectId; modelSelection: ReturnType<typeof modelSelectionOf> }
      | undefined;
    if (screen.isDraft) {
      const selection = override ?? defaultModelSelection(project, link.config);
      if (selection === null) {
        this.notice = noModelNotice(link.config);
        this.render();
        return null;
      }
      create = { projectId: screen.projectId, modelSelection: selection };
      this.startedDrafts.add(screen.threadId);
    }
    return turnStartCommand(this.deps.context, {
      threadId: screen.threadId,
      text: withPromptEffort(text, resolved?.promptEffort ?? null),
      titleText: text,
      runtimeMode: this.runtimeModeOf(screen),
      interactionMode: options.interactionMode ?? this.interactionModeOf(screen),
      ...(options.sourceProposedPlan ? { sourceProposedPlan: options.sourceProposedPlan } : {}),
      ...(override ? { modelSelection: override } : {}),
      ...(create ? { create } : {}),
    });
  }

  /** Returns true when `text` was one of our own slash commands. */
  private runSlashCommand(screen: ChatScreen, text: string): boolean {
    const invocation = parseSlash(text);
    if (invocation === null) return false;
    const { command, args, rest } = invocation;
    switch (command.name) {
      case "model": {
        this.picker = { kind: "model", selected: this.modelPointer(screen, ""), query: "" };
        break;
      }
      case "mode": {
        if (args.length === 0) {
          const index = RUNTIME_MODES.findIndex(
            (entry) => entry.value === this.runtimeModeOf(screen),
          );
          this.picker = { kind: "mode", selected: Math.max(0, index) };
          break;
        }
        const mode = parseRuntimeMode(rest);
        if (mode === null) {
          this.notice = t("session.c.unknownMode", {
            value: flatten(rest),
            words: runtimeModeWords(),
          });
          break;
        }
        this.setRuntimeMode(screen, mode, true);
        break;
      }
      case "effort":
        this.runEffortCommand(screen, args[0]);
        break;
      case "plan":
        this.setInteractionMode(screen, "plan");
        break;
      case "default":
        this.setInteractionMode(screen, "default");
        break;
      case "implement":
        void this.implementPlan(screen);
        break;
      case "goal":
        if (this.crewSub(screen) !== null) {
          this.notice = t("session.c.crewNoGoal");
          break;
        }
        this.runGoalCommand(screen, args, rest);
        break;
      case "crew":
        this.runCrewCommand(screen, args);
        break;
      case "provider":
        this.provider.run(rest);
        break;
      case "dag-workflow":
      case "dag-agents":
        if (this.deps.split === undefined) return false;
        this.runPanelCommand(command.name === "dag-agents" ? "agents" : "workflow", screen, args);
        break;
      case "tasks":
        if (this.deps.split === undefined) return false;
        this.runTasksCommand(args);
        break;
      case "theme": {
        if (this.deps.themes === undefined) return false;
        this.runThemeCommand(this.deps.themes, args[0]);
        break;
      }
      case "threads":
        this.editor = emptyEditor;
        this.leaveChat("threads");
        return true;
      case "projects":
        this.editor = emptyEditor;
        this.leaveChat("projects");
        return true;
      case "new":
        this.editor = emptyEditor;
        this.deps.link.closeThread();
        if (this.landing !== null && screen.isDraft) {
          this.dropHeldDraft(screen);
          this.endSetup(null);
        }
        this.openChat(screen.projectId, null, true);
        return true;
      case "exit":
        this.deps.exit();
        return true;
      case "stats":
        this.stats = { tab: 0, selected: null };
        break;
      case "history":
        this.runHistoryCommand(screen, args[0]);
        break;
      case "diff":
        this.runDiffCommand(screen, args);
        break;
      case "undo":
        this.runUndoCommand(screen);
        break;
      case "update":
        this.runUpdateCommand();
        break;
      case "help":
        this.emit(this.helpNote());
        break;
      default:
        return false;
    }
    this.editor = emptyEditor;
    return true;
  }

  // ---- /diff and /undo ---------------------------------------------------------------------

  /** The thread on screen as the server holds it: null for a draft, or before its first snapshot. */
  private serverThreadOf(screen: ChatScreen): OrchestrationThread | null {
    if (screen.isDraft) return null;
    const mirror = this.deps.link.thread.thread;
    return mirror !== null && mirror.id === screen.threadId ? mirror : null;
  }

  /** A refusal or a failure worth keeping: it goes into the scrollback, folded, and stays there. */
  private say(text: string, tone: RailTone = "warning"): void {
    this.emit(noticeRows(this.rail, text, tone, this.width));
  }

  /**
   * `/diff [turn] [file]`: what the last turn (or the numbered one) changed, as the desktop app's diff
   * panel reads it from the turn's checkpoint. It is written into the scrollback, under a count of
   * files, and stops after a few hundred lines; one file can be asked for whole.
   */
  private runDiffCommand(screen: ChatScreen, args: ReadonlyArray<string>): void {
    const request = parseDiffArgs(args);
    if ("error" in request) {
      this.notice = request.error;
      return;
    }
    const thread = this.serverThreadOf(screen);
    if (thread === null) {
      this.notice = t("session.c.diffNoThread");
      return;
    }
    const refusal = this.answerRefusal(screen, "/diff");
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    if (this.diffBusy) {
      this.notice = t("session.c.diffBusy");
      return;
    }
    if (this.deps.link.status.phase !== "online") {
      this.notice = t("session.c.connectToView");
      return;
    }
    const found = diffTurn(thread, request.turn, this.deps.now());
    if (!found.ok) {
      this.say(checkpointGapText(found.gap));
      return;
    }
    const { checkpoint } = found;
    let file: string | undefined;
    if (request.file !== null) {
      const matches = matchFiles(checkpoint.files, request.file);
      const turn = checkpoint.checkpointTurnCount;
      if (matches.length === 0) {
        this.say(t("session.c.diffNoFile", { turn, file: flatten(request.file) }));
        return;
      }
      if (matches.length > 1) {
        const names = matches
          .slice(0, 5)
          .map((entry) => flatten(entry.path))
          .join(", ");
        this.say(
          t("session.c.diffManyFiles", {
            file: flatten(request.file),
            names: `${names}${matches.length > 5 ? " …" : ""}`,
          }),
        );
        return;
      }
      file = matches[0]?.path;
    }
    this.diffBusy = true;
    this.notice = t("session.c.diffLoading");
    void this.showDiff(screen, thread.id, checkpoint.checkpointTurnCount, checkpoint.files, file);
  }

  private async showDiff(
    screen: ChatScreen,
    threadId: ThreadId,
    turn: number,
    files: ReadonlyArray<{
      readonly path: string;
      readonly kind: string;
      readonly additions: number;
      readonly deletions: number;
    }>,
    file: string | undefined,
  ): Promise<void> {
    try {
      const diff = await this.deps.link.getCheckpointDiff({
        threadId,
        fromTurnCount: turn - 1,
        toTurnCount: turn,
      });
      // The user may have moved to another thread while the server was working.
      if (this.disposed || this.screen !== screen) return;
      if (this.notice === t("session.c.diffLoading")) this.notice = null;
      // A reply began while the server was working: the report would end up in the middle of it.
      const refusal = this.answerRefusal(screen, "/diff");
      if (refusal !== null) {
        this.notice = refusal;
        return;
      }
      this.emit(
        diffReportRows({
          rail: this.rail,
          width: this.width,
          turn,
          files,
          diff,
          ...(file === undefined ? {} : { file }),
        }),
      );
    } catch (cause) {
      if (this.disposed || this.screen !== screen) return;
      if (this.notice === t("session.c.diffLoading")) this.notice = null;
      const detail = flatten(cause instanceof Error ? cause.message : String(cause));
      this.say(
        `${t("session.c.diffFailed", { detail })}${cause instanceof CommandRejectedError ? "" : t("session.c.checkConnection")}`,
        "error",
      );
    } finally {
      this.diffBusy = false;
      this.render();
    }
  }

  /**
   * `/undo`: rewinds the thread to before its last turn, as the desktop app's "Edit from here" does
   * for the last message. Nothing is sent until the list it opens is answered, and its first choice is
   * to cancel. It is refused while a turn runs, since the server rewinds only a thread at rest.
   */
  private runUndoCommand(screen: ChatScreen): void {
    const { link } = this.deps;
    const now = this.deps.now();
    const thread = this.serverThreadOf(screen);
    if (thread === null) {
      this.notice = t("session.c.undoNoThread");
      return;
    }
    if (this.undo.active(thread.id, now)) {
      this.notice = t("session.c.undoingRetry");
      return;
    }
    if (link.status.phase !== "online") {
      this.notice = t("session.c.connectToUndo");
      return;
    }
    if (this.turnRunning(screen) || this.sending || this.turnStarting(screen)) {
      this.notice = t("session.c.busyCannotUndo");
      return;
    }
    const providerId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const provider = link.config?.providers.find((entry) => entry.instanceId === providerId);
    if (provider?.supportsConversationRollback === false) {
      this.say(
        t("session.c.undoUnsupported", {
          name: flatten(provider.displayName ?? provider.instanceId),
        }),
      );
      return;
    }
    const found = undoPlan(thread, now);
    if (!found.ok) {
      this.say(checkpointGapText(found.gap));
      return;
    }
    this.picker = { kind: "undo", selected: 0, plan: found.plan };
  }

  /** The list was answered: the plan is read again from the thread, since it may have moved on, and sent. */
  private async sendUndo(screen: ChatScreen, plan: UndoPlan, restoreFiles: boolean): Promise<void> {
    const now = this.deps.now();
    const thread = this.serverThreadOf(screen);
    const again = thread === null ? null : undoPlan(thread, now);
    if (
      thread === null ||
      again === null ||
      !again.ok ||
      again.plan.turn !== plan.turn ||
      // What the choice was offered for must still hold: a folder restore the thread lost is not carried out.
      again.plan.restore !== plan.restore ||
      this.turnRunning(screen) ||
      this.sending ||
      this.turnStarting(screen) ||
      this.undo.active(thread.id, now) ||
      this.deps.link.status.phase !== "online"
    ) {
      this.notice = t("session.c.undoCancelledChanged");
      this.render();
      return;
    }
    // A send that failed belongs to the thread as it was; after the rewind its command would not mean the same.
    this.failedSend = null;
    this.undo.start({ thread, plan: again.plan, restoreFiles, now });
    this.emit([
      railGap(this.rail),
      railRow(this.rail, this.deps.style.theme.dim(t("session.c.undoing"))),
    ]);
    const outcome = await this.run(
      revertCommand(this.deps.context, {
        threadId: thread.id,
        turnCount: again.plan.target,
        restoreFiles,
      }),
      t("session.c.undoRequestFailed"),
    );
    if (outcome !== "sent") {
      this.undo.drop();
      if (outcome === "failed") {
        this.say(t("session.c.undoUncertain"));
      }
    }
    this.render();
  }

  /**
   * The thread has fewer turns than at the last sync, or this client's `/undo` got its answer: the
   * server rewound it. The scrollback still holds the turns that are gone, and cannot be rewritten,
   * so a line says where the conversation now stands. The undone question goes back to the composer.
   */
  private noteRewind(screen: ChatScreen, thread: OrchestrationThread): void {
    const now = turnCountOf(thread);
    const before = screen.turnCount;
    screen.turnCount = now;
    const outcome = this.undo.observe(thread);
    if (outcome?.kind === "failed") {
      this.undoFailed(outcome);
      return;
    }
    const mine = outcome?.kind === "done" ? outcome : null;
    if (mine === null && !(before !== null && now < before)) return;
    const { theme } = this.deps.style;
    const rows = [
      railGap(this.rail),
      railDone(
        this.rail,
        theme.warning(t("session.c.rewound", { from: mine?.plan.turn ?? before ?? now, now })),
      ),
      ...railWrap(this.rail, theme.dim(t("session.c.rewoundGone")), this.width),
    ];
    if (mine !== null) {
      rows.push(
        ...railWrap(
          this.rail,
          theme.dim(
            mine.restoreFiles
              ? t("session.c.filesRestored", {
                  state:
                    mine.plan.target === 0
                      ? t("session.c.beforeThread")
                      : t("session.c.endOfTurn", { target: mine.plan.target }),
                })
              : t("session.c.filesKept"),
          ),
          this.width,
        ),
      );
      // What waited in the queue may rest on the turn that is gone: it goes back to the composer
      // too, behind the question that was asked before it, to be read before anything is sent.
      const queued = this.queue.items(screen.threadId).length;
      this.takeBackQueue(screen);
      if (mine.plan.prompt !== null) {
        this.putInComposer(mine.plan.prompt, "before");
        rows.push(...railWrap(this.rail, theme.dim(t("session.c.questionBack")), this.width));
      }
      if (queued > 0) {
        rows.push(
          ...railWrap(this.rail, theme.dim(t("session.c.queuedBack", { queued })), this.width),
        );
      }
    }
    this.emit(rows);
  }

  private undoFailed(outcome: Extract<UndoOutcome, { kind: "failed" }>): void {
    this.say(
      outcome.restoreFiles ? t("session.c.undoFailedFiles") : t("session.c.undoFailedPlain"),
      "error",
    );
  }

  /**
   * Words put back for the user to edit: after what is typed already (or before it), or with the
   * draft a panel put aside.
   */
  private putInComposer(text: string, where: "before" | "after" = "after"): void {
    const draft = this.panelKey === null ? this.editor : this.stashedDraft;
    const typed = draft === null ? "" : editorText(draft);
    const next =
      typed.trim() === ""
        ? text
        : where === "after"
          ? `${typed}\n\n${text}`
          : `${text}\n\n${typed}`;
    if (this.panelKey === null) this.editor = editorFromText(next);
    else this.stashedDraft = editorFromText(next);
  }

  // ---- the workflow panel ------------------------------------------------------------------

  /** The flows of the thread on screen: null off a chat, none yet for a thread not on the server. */
  private flowsOf(screen: Screen) {
    const { link } = this.deps;
    if (screen.kind !== "chat") return null;
    const thread = link.thread.thread?.id === screen.threadId ? link.thread.thread : null;
    const model = thread?.modelSelection;
    return thread === null
      ? []
      : this.sidePanel.workflow.flows(
          thread,
          model === undefined ? null : this.labelForModel(model.instanceId, model.model),
        );
  }

  /**
   * The Agents view of the thread on screen: null off a chat, empty for a thread not yet on the
   * server, and "loading" for one that is on the server but not yet read.
   */
  private agentsViewOf(screen: Screen): AgentsView | null {
    const { link } = this.deps;
    if (screen.kind !== "chat") return null;
    const thread = link.thread.thread?.id === screen.threadId ? link.thread.thread : null;
    if (thread === null) return screen.isDraft ? EMPTY_AGENTS_VIEW : LOADING_AGENTS_VIEW;
    const model = thread.modelSelection;
    const shell = link.shell?.threads.find((candidate) => candidate.id === screen.threadId);
    const waiting = this.crewWaiting(screen);
    return this.sidePanel.agents.read({
      thread,
      leadModel: this.labelForModel(model.instanceId, model.model),
      board: this.crewBoardOf(screen),
      // A new list of the same waiting threads is no change: the panel compares ids and kinds.
      waiting,
      leadWaiting: shell?.hasPendingApprovals
        ? "approval"
        : shell?.hasPendingUserInput
          ? "input"
          : null,
    });
  }

  /** Draws the panel for the thread on screen while the split layout is on; nothing otherwise. */
  private syncPanel(): void {
    const split = this.deps.split;
    if (split === undefined || !this.panelOpen || !split.active()) return;
    const size = split.panel();
    const screen = this.screen;
    split.setPanel(
      this.sidePanel.lines(
        {
          now: this.deps.now(),
          online: this.deps.link.status.phase === "online",
          columns: size.columns,
          rows: size.rows,
          style: this.deps.style,
          symbols: this.symbols,
        },
        { flows: () => this.flowsOf(screen), agents: () => this.agentsViewOf(screen) },
      ),
    );
  }

  /**
   * `/dag-workflow` and `/dag-agents`: each shows its own view of the right-hand panel. Closed, it
   * opens; showing the other view, it switches without closing; typed again, it closes. The words
   * after it are the same for both and pick which flow the Workflow view shows.
   */
  private runPanelCommand(view: PanelView, screen: ChatScreen, args: ReadonlyArray<string>): void {
    const split = this.deps.split;
    if (split === undefined) return;
    const action = parseFlowAction(args);
    if (action === null) {
      this.notice = t("session.c.usage", { usage: PANEL_USAGE[view] });
      return;
    }
    const open = this.panelOpen;
    const move = planPanelMove(view, action, open ? this.sidePanel.view() : null);
    if (move === "close") {
      this.panelOpen = false;
      this.applyLayout();
      return;
    }
    if (action.kind === "off") {
      const shown = open ? this.sidePanel.view() : null;
      if (shown !== null && shown !== view) this.notice = offElsewhereNotice(view, shown);
      return;
    }
    if (action.kind !== "toggle" && action.kind !== "on") {
      const problem = this.sidePanel.choose(view, () => this.flowsOf(screen), action);
      if (problem !== null) {
        this.notice = problem;
        return;
      }
    }
    if (move === "none") return;
    if (move === "open") {
      const why = split.unavailable({ panel: true, tasks: this.tasksOn });
      if (why !== null) {
        this.notice = why;
        return;
      }
      // The start screen is over once the conversation moves to a layout of its own.
      this.endHome();
    }
    this.sidePanel.show(view);
    if (move === "open") {
      this.panelOpen = true;
      this.applyLayout();
    }
  }

  /**
   * The alternate screen is up while the side panel or the task list is wanted, and is left when
   * neither is. The task list alone gives the conversation the whole width.
   */
  private applyLayout(): void {
    const split = this.deps.split;
    if (split === undefined) return;
    if (!this.panelOpen && !this.tasksOn) {
      split.leave();
      return;
    }
    if (!split.active()) split.enter();
    split.setSide(this.panelOpen);
    if (!this.tasksOn) split.setTasks([]);
  }

  /**
   * The terminal became too small for the split layout. It was closed, or, for `tasks`, only the
   * task list was folded and the side panel stays.
   */
  onSplitClosed(reason: string, part: "all" | "tasks" = "all"): void {
    if (part === "all") this.panelOpen = false;
    this.tasksOn = false;
    this.notice = reason;
    this.render();
  }

  // ---- the task list -----------------------------------------------------------------------

  /** `/tasks`: shows or hides the thread's task list under the conversation, with or without the side panel. */
  private runTasksCommand(args: ReadonlyArray<string>): void {
    const split = this.deps.split;
    const word = args[0]?.toLowerCase();
    if (split === undefined) return;
    if (args.length > 1 || (word !== undefined && word !== "on" && word !== "off")) {
      this.notice = t("session.c.tasksUsage");
      return;
    }
    const wanted = word === undefined ? !this.tasksOn : word === "on";
    if (wanted === this.tasksOn) {
      this.notice = wanted ? t("session.c.tasksOpen") : t("session.c.tasksClosed");
      return;
    }
    if (wanted) {
      const why = split.unavailable({ panel: this.panelOpen, tasks: true });
      if (why !== null) {
        this.notice = why;
        return;
      }
      // The start screen is over once the conversation moves to a layout of its own.
      this.endHome();
    }
    this.tasksOn = wanted;
    this.applyLayout();
  }

  /** The last task list of the thread on screen, which stays through later turns as in the desktop app. */
  private tasksContent(screen: Screen): TasksContent {
    if (screen.kind !== "chat") return { kind: "empty" };
    const { thread } = this.deps.link.thread;
    if (thread === null || thread.id !== screen.threadId) {
      return screen.isDraft || screen.loaded ? { kind: "empty" } : { kind: "loading" };
    }
    const turnId = thread.latestTurn?.turnId;
    let memo = this.activePlanMemo;
    if (memo === null || memo.activities !== thread.activities || memo.turnId !== turnId) {
      memo = {
        activities: thread.activities,
        turnId,
        plan: deriveActivePlanState(thread.activities, turnId),
      };
      this.activePlanMemo = memo;
    }
    const { plan } = memo;
    return plan === null ? { kind: "empty" } : { kind: "plan", plan };
  }

  /** Draws the task list while it is on; the conversation gives it the rows it takes. */
  private syncTasks(): void {
    const split = this.deps.split;
    if (split === undefined || !this.tasksOn || !split.active()) return;
    const size = split.leftSize();
    split.setTasks(
      renderTasksPane(this.tasksContent(this.screen), {
        columns: size.columns,
        rows: tasksPaneRows(size.rows),
        theme: this.deps.style.theme,
        symbols: this.symbols,
      }),
    );
  }

  // ---- older conversation --------------------------------------------------------------------

  /**
   * `/history [n]`: prints the `n` messages before the ones already printed, again at the bottom of
   * the scrollback (the terminal does not let anything be written above what is there). What the
   * opening window loaded comes first; past that, a page of older turns is fetched from the server.
   */
  private runHistoryCommand(screen: ChatScreen, word: string | undefined): void {
    const count = parseHistoryCount(word);
    if (count === null) {
      this.notice = t("session.c.historyUsage", { max: HISTORY_MAX });
      return;
    }
    if (screen.isDraft) {
      this.notice = t("session.c.historyNew");
      return;
    }
    const { link } = this.deps;
    const thread = link.thread.thread;
    if (!screen.loaded || thread === null || thread.id !== screen.threadId) {
      this.notice = t("session.c.historyAfterLoad");
      return;
    }
    if (screen.historyBusy) {
      this.notice = historyLoadingNotice();
      return;
    }
    const refusal = this.answerRefusal(screen, "/history");
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    screen.history ??= openHistoryPool(
      thread,
      screen.printer.skippedMessages,
      link.thread.hasOlder ? link.thread.olderCursor : null,
    );
    const pool = screen.history;
    if (!historyLeft(pool)) {
      this.notice = t("session.c.historyNone");
      return;
    }
    if (pool.messages.length >= count || pool.cursor === null) {
      this.printHistory(screen, pool, count);
      return;
    }
    screen.historyBusy = true;
    this.notice = historyLoadingNotice();
    void this.fillHistory(screen, pool, count);
  }

  /** Why a report cannot be written now: a reply being written would end up in the middle of it. */
  private answerRefusal(screen: ChatScreen, command: string): string | null {
    return screen.status?.phase === "working" ? t("session.c.replyRunning", { command }) : null;
  }

  /** Fetches pages of older turns until the pool holds `count` messages or the server has no more. */
  private async fillHistory(screen: ChatScreen, pool: HistoryPool, count: number): Promise<void> {
    let failure: string | null = null;
    try {
      while (pool.messages.length < count && pool.cursor !== null) {
        const page = await this.deps.link.loadOlderTurns(screen.threadId, pool.cursor);
        addHistoryPage(pool, page);
      }
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    screen.historyBusy = false;
    if (this.notice === historyLoadingNotice()) this.notice = null;
    if (this.disposed || this.screen !== screen) return;
    // The pool keeps what was loaded, so the same command tries the page again.
    if (failure !== null) {
      this.notice = t("session.c.historyFailed", { detail: flatten(failure) });
    } else {
      this.printHistory(screen, pool, count);
    }
    this.render();
  }

  private printHistory(screen: ChatScreen, pool: HistoryPool, count: number): void {
    const thread = this.deps.link.thread.thread;
    if (thread === null || thread.id !== screen.threadId) return;
    const refusal = this.answerRefusal(screen, "/history");
    if (refusal !== null) {
      this.notice = refusal;
      return;
    }
    const batch = takeHistoryBatch(pool, count);
    if (batch.messages.length === 0) {
      this.notice = t("session.c.historyNone");
      return;
    }
    const { theme } = this.deps.style;
    // Older messages are finished by definition; one printer per batch keeps the live one's state apart.
    const rows = this.newPrinter(batch.messages.length).sync({
      ...thread,
      messages: batch.messages.map((message) => ({ ...message, streaming: false })),
      activities: batch.activities,
      // The plans on screen already are not written again.
      proposedPlans: batch.plans,
    }).commit;
    const left = pool.messages.length;
    const more = pool.cursor !== null;
    const remaining =
      left > 0
        ? t(more ? "session.c.moreAtLeast" : "session.c.moreExact", { left })
        : more
          ? t("session.c.moreSome")
          : t("session.c.reachedStart");
    this.emit([
      railGap(this.rail),
      railRow(this.rail, theme.dim(t("session.c.earlierCount", { count: batch.messages.length }))),
      ...rows,
      railGap(this.rail),
      railRow(this.rail, theme.dim(t("session.c.earlierUpToHere", { remaining }))),
    ]);
  }

  /** `/update`: looks the newest release up again and lists what the releases after this one brought. */
  private runUpdateCommand(): void {
    const startup = this.deps.startup;
    if (startup === undefined) return;
    if (this.lookingUp) {
      this.notice = checkingNotice();
      return;
    }
    this.lookingUp = true;
    this.notice = checkingNotice();
    void startup.checkUpdate({ refresh: true }).then(
      (info) => this.finishUpdateCommand(info),
      () => this.finishUpdateCommand(null),
    );
  }

  private finishUpdateCommand(info: LatestRelease | null): void {
    this.lookingUp = false;
    if (this.disposed) return;
    if (this.notice === checkingNotice()) this.notice = null;
    if (info === null) {
      this.emit([noticeLine(this.rail, t("session.c.updateCheckFailed"), "error")]);
    } else {
      this.latest = info;
      this.emit([
        railGap(this.rail),
        ...railNote(this.rail, t("session.c.updateTitle"), this.updateNote(info), this.width),
      ]);
    }
    this.render();
  }

  /** The body of the `/update` note: the verdict, each newer release with its highlights, how to update. */
  private updateNote(info: LatestRelease): string[] {
    const { theme } = this.deps.style;
    const terminal = this.deps.startup?.version ?? "";
    const app = this.appVersion();
    const current = app ?? terminal;
    const report = buildUpdateReport(current, info);
    const room = Math.max(8, this.width - 6);
    const fold = (rows: ReadonlyArray<string>) =>
      rows.flatMap((row) => wrapWithPrefix(row, room, "", "  "));
    const body: string[] = [];
    if (report.status === "current") {
      body.push(...fold([t("session.c.upToDate", { current })]));
    } else {
      body.push(
        ...fold([
          theme.accent.bold(t("session.c.updateAvailable", { current, latest: report.latest })),
        ]),
      );
      const { shown, omitted } = listedReleases(report);
      for (const release of shown) {
        body.push(...fold([theme.text.bold(releaseTitle(release))]));
        for (const highlight of release.highlights.slice(0, LISTED_HIGHLIGHTS)) {
          body.push(...fold([`  ${theme.dim(highlightMark(this.symbols))} ${highlight}`]));
        }
      }
      if (omitted > 0)
        body.push(...fold([theme.dim(t("session.c.moreReleases", { count: omitted }))]));
      body.push("", ...fold([theme.dim(updateHowTo())]));
    }
    if (app !== null && terminalIsBehind(terminal, app)) {
      body.push("", ...fold([theme.warning(terminalBehindText(terminal, app))]));
    }
    return body;
  }

  /** `/help`: the commands, the keys, and how an approval is answered, in one note on the rail. */
  private helpNote(): string[] {
    const { theme } = this.deps.style;
    const room = Math.max(8, this.width - 6);
    const names = SLASH_COMMANDS.map((command) => `/${command.name}`);
    const wide = Math.max(...names.map((name) => name.length));
    const heading = (text: string) => theme.text.bold(text);
    // A row that does not fit is folded under its own start, not cut.
    const fold = (rows: ReadonlyArray<string>) =>
      rows.flatMap((row) => wrapWithPrefix(row, room, "", "  "));
    const body = [
      heading(t("session.c.help.commands")),
      ...fold(
        SLASH_COMMANDS.map(
          (command, index) =>
            `${theme.accent((names[index] ?? "").padEnd(wide))}  ${command.note}${
              command.usage === undefined ? "" : ` ${theme.dim(command.usage)}`
            }`,
        ),
      ),
      "",
      heading(t("session.c.help.keys")),
      ...fold([
        t("session.c.help.keySend"),
        t("session.c.help.keyQueue"),
        t("session.c.help.keyEsc"),
        t("session.c.help.keyQuit"),
        t("session.c.help.keyMenu"),
        t("session.c.help.keyModel"),
        t("session.c.help.keyLists"),
        t("session.c.help.keyScroll"),
      ]),
      "",
      heading("Crew"),
      ...fold([
        t("session.c.help.crewMain"),
        t("session.c.help.crewUsage"),
        t("session.c.help.crewBack"),
      ]),
      "",
      heading("Workflow"),
      ...fold([
        t("session.c.help.wfOpen"),
        t("session.c.help.wfPick"),
        t("session.c.help.wfAgents"),
        t("session.c.help.wfTasks"),
      ]),
      "",
      heading("Provider"),
      ...fold([
        t("session.c.help.providerMain"),
        t("session.c.help.providerSecret"),
        t("session.c.help.providerRefresh"),
      ]),
      "",
      heading(t("session.c.help.undoHeading")),
      ...fold([
        t("session.c.help.diffMain"),
        t("session.c.help.diffFile"),
        t("session.c.help.undoMain"),
      ]),
      "",
      heading(t("session.c.help.approvals")),
      ...fold([
        t("session.c.help.apprPick"),
        t("session.c.help.apprLock"),
        t("session.c.help.apprLeave"),
      ]),
      "",
      heading(t("session.c.helpSettings")),
      ...fold([t("session.c.helpLanguage")]),
    ];
    return [
      railGap(this.rail),
      ...railNote(this.rail, t("session.c.help.title"), body, this.width),
    ];
  }

  /** `/theme` opens the list of themes; `/theme <name>` switches to one now and saves the choice. */
  private runThemeCommand(themes: ThemeSwitcher, requested: string | undefined): void {
    if (requested === undefined) {
      const names = themes.names();
      const current = themes.current().name;
      this.picker = { kind: "theme", selected: Math.max(0, names.indexOf(current)), names };
      return;
    }
    this.applyTheme(themes, requested);
  }

  /** Failing or saving with a caveat is said as a notice; a plain success is the record in the scrollback. */
  private applyTheme(themes: ThemeSwitcher, name: string): void {
    const result = themes.select(name);
    if (!result.ok || result.notes.length > 0) this.notice = result.message;
    if (result.ok) {
      this.emit(this.answered({ label: t("session.c.themeLabel"), value: themes.current().name }));
    }
  }

  private handlePickerListKey(picker: ListPicker, event: KeyEvent): void {
    const screen = this.screen;
    if (screen.kind !== "chat") return;
    const models = picker.kind === "model" ? this.visibleModels(screen, picker.query) : [];
    const count =
      picker.kind === "model"
        ? models.length
        : picker.kind === "theme"
          ? picker.names.length
          : picker.kind === "mode"
            ? RUNTIME_MODES.length
            : picker.kind === "undo"
              ? undoChoices(picker.plan).length
              : picker.control.choices.length;
    // The list can be shorter than when the pointer was last moved (the settings changed under it);
    // the row drawn is the row acted on.
    const at = Math.min(picker.selected, Math.max(0, count - 1));
    picker.selected = at;
    // The search list takes letters: j and k are letters there, and only the arrows move.
    if (picker.kind === "model") {
      if (event.type === "text" || event.type === "paste") {
        picker.query = appendToSearch(picker.query, event.text);
        picker.selected = 0;
        return;
      }
      if (event.type === "ctrl" && event.letter === "u") {
        picker.query = "";
        picker.selected = this.modelPointer(screen, "");
        return;
      }
      if (event.type === "key" && event.name === "backspace") {
        picker.query = eraseFromSearch(picker.query, event.ctrl || event.alt);
        picker.selected = picker.query === "" ? this.modelPointer(screen, "") : 0;
        return;
      }
    }
    if (event.type !== "key") return;
    switch (event.name) {
      case "up":
        picker.selected = Math.max(0, at - 1);
        return;
      case "down":
        picker.selected = Math.max(0, Math.min(count - 1, at + 1));
        return;
      case "escape":
        // A search is undone before the list is left.
        if (picker.kind === "model" && picker.query !== "") {
          picker.query = "";
          picker.selected = this.modelPointer(screen, "");
        } else this.picker = null;
        return;
      case "enter": {
        if (picker.kind === "model" && models.length === 0) {
          if (picker.query === "" && availableModels(this.deps.link.config).length === 0) {
            this.picker = null;
            this.provider.run("add");
            return;
          }
          this.notice = t("session.c.noModelMatch");
          return;
        }
        this.picker = null;
        if (picker.kind === "theme") {
          const name = picker.names[at];
          if (name !== undefined && this.deps.themes !== undefined) {
            this.applyTheme(this.deps.themes, name);
          }
          return;
        }
        if (picker.kind === "mode") {
          const entry = RUNTIME_MODES[at];
          if (entry !== undefined) this.setRuntimeMode(screen, entry.value, false);
          return;
        }
        if (picker.kind === "undo") {
          const choice = undoChoices(picker.plan)[at];
          if (choice === "files" || choice === "conversation") {
            void this.sendUndo(screen, picker.plan, choice === "files");
          }
          return;
        }
        if (picker.kind === "effort") {
          const choice = picker.control.choices[at];
          const selection = this.turnSelection(screen);
          if (choice !== undefined && selection !== null) {
            this.pickEffort(screen, selection, picker.control, choice.value, false);
          }
          return;
        }
        const choice = models[at];
        const current = this.currentModel(screen);
        // The model already in use stays as it is: picking it again would drop its reasoning effort.
        if (choice && !(current !== null && sameModel(choice, current))) {
          // Going back to the thread's own model drops the pick: a turn names the model on screen
          // anyway, and the thread's own selection, effort included, is read live.
          const base = this.baseModel(screen);
          this.modelOverride = base !== null && sameModel(choice, base) ? null : choice;
          this.failedSend = null;
          // An effort the new model does not offer goes with the old model.
          const now = this.turnSelection(screen);
          if (
            this.effortPick !== null &&
            (now === null || !effortStillValid(this.deps.link.config, now, this.effortPick))
          ) {
            this.effortPick = null;
          }
          this.emit(
            this.answered({
              label: t("session.c.modelLabel"),
              value: sanitizeForTerminal(choice.label).split("\n")[0] ?? "",
            }),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /** The goal question: Enter saves, Esc leaves without saving, everything else edits the text. */
  private handlePromptKey(prompt: PromptScreen, screen: ChatScreen, event: KeyEvent): void {
    if (event.type === "key" && event.name === "escape") {
      this.prompt = null;
      return;
    }
    if (event.type === "key" && event.name === "enter" && !event.shift && !event.alt) {
      const text = editorText(prompt.editor).trim();
      if (text === "") {
        this.notice = t("session.c.enterGoalText");
        return;
      }
      this.prompt = null;
      void this.saveGoal(screen, text);
      return;
    }
    prompt.editor = editPromptText(prompt.editor, event);
  }
}
