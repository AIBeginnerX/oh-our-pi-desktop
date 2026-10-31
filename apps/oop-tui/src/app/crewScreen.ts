import {
  CREW_ROLES,
  type CrewPreset,
  type CrewRole,
  type CrewSettings,
  type ModelSelection,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import {
  crewModelOptions,
  recommendCrew,
  resolveCrew,
  type CrewModelOption,
  type ResolvedCrew,
} from "@t3tools/shared/crew";

import type { KeyEvent } from "../input/keys.ts";
import type { RegionFrame } from "../render/liveRegion.ts";
import { boardSummary, roleName, taskDetail, taskHeadline, taskNote } from "../render/crewBoard.ts";
import { RAIL_COLUMNS, type RailTone } from "../render/rail.ts";
import type { Style } from "../render/style.ts";
import type { Symbols } from "../render/symbols.ts";
import { graphemesOf, sanitizeForTerminal } from "../text/width.ts";
import { wrapStyled } from "../text/wrap.ts";
import {
  crewPickItems,
  pickIsCurrent,
  PRESETS,
  presetLabel,
  ROLE_HINT,
  roleModelText,
  type CrewPickItem,
} from "./crew.ts";
import {
  crewSubThreadLabel,
  waitingText,
  type CrewBoard,
  type CrewTask,
  type WaitingCrewThread,
} from "./crewBoard.ts";
import { renderPicker, type PickerItem } from "./view.ts";

/** The screen `/crew` opens: the crew and its board, and the lists reached from them. */
export type CrewView =
  | {
      readonly kind: "main";
      readonly selected: number;
      /**
       * The row the pointer is on, by identity. Rows come and go (a thread starts waiting, a task
       * ends), so the index is worked out from this each time and never trusted on its own.
       */
      readonly rowId?: string;
    }
  | { readonly kind: "preset"; readonly selected: number }
  | {
      readonly kind: "model";
      readonly role: CrewRole;
      readonly selected: number;
      readonly query: string;
    }
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly selected: number;
      readonly confirmStop: boolean;
    };

/** What the screen draws from, read fresh for each frame. */
export interface CrewContext {
  readonly crew: ResolvedCrew;
  /** Where a change lands: the thread's own override, or (for a thread not started yet) the defaults. */
  readonly scope: "thread" | "default";
  /** Why the thread's model cannot lead a crew; null when it can. */
  readonly problem: string | null;
  readonly board: CrewBoard | null;
  readonly waiting: ReadonlyArray<WaitingCrewThread>;
  readonly providers: ServerConfig["providers"];
  /** What the preset alone would put in each role, which Auto stands for. */
  readonly autoPicks: Record<CrewRole, CrewModelOption | null>;
  readonly now: number;
}

export const crewContext = (input: {
  readonly settings: CrewSettings;
  /** The thread the change would belong to; null when it changes the defaults. */
  readonly threadId: string | null;
  readonly providers: ServerConfig["providers"];
  readonly brain: ModelSelection | null;
  readonly problem: string | null;
  readonly board: CrewBoard | null;
  readonly waiting: ReadonlyArray<WaitingCrewThread>;
  readonly now: number;
}): CrewContext => {
  const crew = resolveCrew({
    settings: input.settings,
    threadId: input.threadId,
    providers: input.providers,
    brain: input.brain,
  });
  return {
    crew,
    scope: input.threadId === null ? "default" : "thread",
    problem: input.problem,
    board: input.board,
    waiting: input.waiting,
    providers: input.providers,
    autoPicks: recommendCrew(crewModelOptions(input.providers), input.brain, crew.preset),
    now: input.now,
  };
};

// ---- the rows of the main screen ----------------------------------------------------------------

type CrewRow =
  | { readonly kind: "toggle" }
  | { readonly kind: "preset" }
  | { readonly kind: "role"; readonly role: CrewRole }
  | { readonly kind: "autoAll" }
  | { readonly kind: "default" }
  | { readonly kind: "task"; readonly task: CrewTask }
  /** A crew thread that waits for the user but is on no board (an earlier turn, or an old thread). */
  | { readonly kind: "thread"; readonly entry: WaitingCrewThread };

const waitingOf = (context: CrewContext, task: CrewTask): "approval" | "input" | null =>
  context.waiting.find((entry) => entry.thread.id === task.threadId)?.kind ?? null;

/** Waiting threads first, then the settings, then the tasks of the board. */
const mainRows = (context: CrewContext): ReadonlyArray<CrewRow> => {
  const tasks = context.board?.tasks ?? [];
  const known = new Set(tasks.map((task) => task.threadId));
  return [
    ...context.waiting
      .filter((entry) => !known.has(entry.thread.id))
      .map((entry): CrewRow => ({ kind: "thread", entry })),
    { kind: "toggle" },
    { kind: "preset" },
    ...CREW_ROLES.map((role): CrewRow => ({ kind: "role", role })),
    ...(context.crew.pinned.size > 0 ? [{ kind: "autoAll" } as const] : []),
    ...(context.scope === "thread" ? [{ kind: "default" } as const] : []),
    ...tasks.map((task): CrewRow => ({ kind: "task", task })),
  ];
};

const rowIdOf = (row: CrewRow): string => {
  switch (row.kind) {
    case "role":
      return `role:${row.role}`;
    case "task":
      return `task:${row.task.taskId}`;
    case "thread":
      return `thread:${row.entry.thread.id}`;
    default:
      return row.kind;
  }
};

/** The main screen with the pointer on the row at `index`. */
const mainViewAt = (context: CrewContext, index: number): CrewView => {
  const rows = mainRows(context);
  const at = Math.max(0, Math.min(rows.length - 1, index));
  const row = rows[at];
  return row === undefined
    ? { kind: "main", selected: 0 }
    : { kind: "main", selected: at, rowId: rowIdOf(row) };
};

/**
 * The view with its index brought in line with the rows now listed. A pointer whose row has gone
 * stays at its place in the list, held inside it.
 */
const settle = (view: CrewView, context: CrewContext): CrewView => {
  if (view.kind !== "main") return view;
  const rows = mainRows(context);
  const found =
    view.rowId === undefined ? -1 : rows.findIndex((row) => rowIdOf(row) === view.rowId);
  return mainViewAt(context, found === -1 ? view.selected : found);
};

/** The first screen: the pointer starts on a request that waits for the user, else on the first row. */
export const openCrewView = (context: CrewContext): CrewView => {
  const rows = mainRows(context);
  const waiting = rows.findIndex(
    (row) =>
      row.kind === "thread" || (row.kind === "task" && waitingOf(context, row.task) !== null),
  );
  return mainViewAt(context, Math.max(0, waiting));
};

/** The model list of a role, as `/crew model <role>` opens it; the pointer starts on the role's current model. */
export const openModelView = (context: CrewContext, role: CrewRole, query = ""): CrewView => {
  const current = modelItems(context, role, query).findIndex((item) =>
    pickIsCurrent(item, context.crew, role),
  );
  return { kind: "model", role, selected: Math.max(0, current), query };
};

const rowIndex = (context: CrewContext, match: (row: CrewRow) => boolean): number =>
  Math.max(0, mainRows(context).findIndex(match));

type TaskItem = "open" | "stop" | "retry" | "back" | "confirm" | "cancel";

const taskItems = (task: CrewTask, confirmStop: boolean): ReadonlyArray<TaskItem> => {
  if (confirmStop) return ["confirm", "cancel"];
  return [
    ...(task.actions.open && task.threadId !== null ? (["open"] as const) : []),
    ...(task.actions.stop && task.threadId !== null ? (["stop"] as const) : []),
    ...(task.actions.retry ? (["retry"] as const) : []),
    "back",
  ];
};

const findTask = (context: CrewContext, taskId: string): CrewTask | null =>
  context.board?.tasks.find((task) => task.taskId === taskId) ?? null;

const modelItems = (context: CrewContext, role: CrewRole, query: string) =>
  crewPickItems(context.providers, context.autoPicks[role], query);

const countOf = (view: CrewView, context: CrewContext): number => {
  if (view.kind === "main") return mainRows(context).length;
  if (view.kind === "preset") return PRESETS.length;
  if (view.kind === "model") return modelItems(context, view.role, view.query).length;
  const task = findTask(context, view.taskId);
  return task === null ? 0 : taskItems(task, view.confirmStop).length;
};

// ---- keys -----------------------------------------------------------------------------------------

/** What the controller must do for a key; the screen itself only moves between its views. */
export type CrewEffect =
  | { readonly kind: "none" }
  | { readonly kind: "toggle" }
  | { readonly kind: "preset"; readonly preset: CrewPreset }
  | { readonly kind: "pin"; readonly role: CrewRole; readonly pick: CrewPickItem }
  | { readonly kind: "autoAll" }
  | { readonly kind: "default" }
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | { readonly kind: "stop"; readonly task: CrewTask }
  | { readonly kind: "retry"; readonly task: CrewTask };

export interface CrewKeyResult {
  /** The view after the key; null closes the screen. */
  readonly view: CrewView | null;
  readonly effect: CrewEffect;
  readonly notice?: string;
}

const SEARCH_LIMIT = 60;

const stay = (view: CrewView | null, effect: CrewEffect = { kind: "none" }): CrewKeyResult => ({
  view,
  effect,
});

const withSelected = (view: CrewView, context: CrewContext, selected: number): CrewView =>
  view.kind === "main" ? mainViewAt(context, selected) : { ...view, selected };

/**
 * One key on the screen. The arrows and the digits 1-9 move the pointer, Enter acts, Esc goes back
 * a step (or closes). The model list also takes letters, which narrow it, so there the digits are
 * letters too. Nothing a key does is sent from here: the controller carries out the effect.
 */
export const crewKey = (shown: CrewView, context: CrewContext, event: KeyEvent): CrewKeyResult => {
  const view = settle(shown, context);
  const count = countOf(view, context);
  const move = (delta: number) =>
    stay(withSelected(view, context, Math.max(0, Math.min(count - 1, view.selected + delta))));
  const back = (): CrewKeyResult => {
    if (view.kind === "main") return stay(null);
    if (view.kind === "task") {
      if (view.confirmStop) return stay({ ...view, confirmStop: false, selected: 0 });
      return stay(
        mainViewAt(
          context,
          rowIndex(context, (row) => row.kind === "task" && row.task.taskId === view.taskId),
        ),
      );
    }
    return stay(
      mainViewAt(
        context,
        rowIndex(
          context,
          (row) =>
            (view.kind === "preset" && row.kind === "preset") ||
            (view.kind === "model" && row.kind === "role" && row.role === view.role),
        ),
      ),
    );
  };

  if (view.kind === "model") {
    if (event.type === "text" || event.type === "paste") {
      const typed = sanitizeForTerminal(event.text).replace(/\s+/gu, " ");
      const next = `${view.query}${typed}`.replace(/^\s+/u, "").replace(/\s{2,}/gu, " ");
      return stay({
        ...view,
        selected: 0,
        query: graphemesOf(next).slice(0, SEARCH_LIMIT).join(""),
      });
    }
    if (event.type === "ctrl" && event.letter === "u")
      return stay({ ...view, selected: 0, query: "" });
    if (event.type === "key" && event.name === "backspace") {
      const query = event.ctrl || event.alt ? "" : graphemesOf(view.query).slice(0, -1).join("");
      return stay({ ...view, selected: 0, query });
    }
  } else if (event.type === "text") {
    if (event.text === "q") return back();
    const index = /^[1-9]$/u.test(event.text) ? Number(event.text) - 1 : -1;
    if (index >= 0 && index < count) return stay(withSelected(view, context, index));
    return stay(view);
  }
  if (event.type !== "key") return stay(view);
  switch (event.name) {
    case "up":
      return move(-1);
    case "down":
      return move(1);
    case "escape":
      if (view.kind === "model" && view.query !== "")
        return stay({ ...view, query: "", selected: 0 });
      return back();
    case "enter":
      return activate(view, context);
    default:
      return stay(view);
  }
};

const activate = (view: CrewView, context: CrewContext): CrewKeyResult => {
  if (view.kind === "preset") {
    const entry = PRESETS[view.selected];
    if (entry === undefined) return stay(view);
    return {
      view: mainViewAt(
        context,
        rowIndex(context, (row) => row.kind === "preset"),
      ),
      effect: { kind: "preset", preset: entry.value },
    };
  }
  if (view.kind === "model") {
    const pick = modelItems(context, view.role, view.query)[view.selected];
    if (pick === undefined) {
      return { ...stay(view), notice: "일치하는 모델이 없습니다. Esc로 검색어를 지우세요." };
    }
    return {
      view: mainViewAt(
        context,
        rowIndex(context, (row) => row.kind === "role" && row.role === view.role),
      ),
      effect: { kind: "pin", role: view.role, pick },
    };
  }
  if (view.kind === "task") {
    const task = findTask(context, view.taskId);
    const item = task === null ? undefined : taskItems(task, view.confirmStop)[view.selected];
    if (task === null || item === undefined) return stay(mainViewAt(context, 0));
    switch (item) {
      case "open":
        return task.threadId === null
          ? stay(view)
          : stay(null, { kind: "open", threadId: task.threadId });
      case "stop":
        return stay({ ...view, confirmStop: true, selected: 1 });
      case "confirm":
        return stay({ ...view, confirmStop: false, selected: 0 }, { kind: "stop", task });
      case "retry":
        return stay(view, { kind: "retry", task });
      case "cancel":
        return stay({ ...view, confirmStop: false, selected: 0 });
      case "back":
        return stay(
          mainViewAt(
            context,
            rowIndex(context, (row) => row.kind === "task" && row.task.taskId === task.taskId),
          ),
        );
    }
  }
  const row = mainRows(context)[view.selected];
  if (row === undefined) return stay(view);
  switch (row.kind) {
    case "toggle":
      return stay(view, { kind: "toggle" });
    case "autoAll":
      return stay(view, { kind: "autoAll" });
    case "default":
      return stay(view, { kind: "default" });
    case "preset":
      return stay({
        kind: "preset",
        selected: Math.max(
          0,
          PRESETS.findIndex((entry) => entry.value === context.crew.preset),
        ),
      });
    case "role":
      return stay(openModelView(context, row.role));
    case "task":
      return stay({ kind: "task", taskId: row.task.taskId, selected: 0, confirmStop: false });
    case "thread":
      return stay(null, { kind: "open", threadId: row.entry.thread.id as ThreadId });
  }
};

// ---- the frame --------------------------------------------------------------------------------------

/** Rows of a task's summary the detail screen keeps; the rest is in the task's own thread. */
const SUMMARY_ROWS = 5;

const numbered = (items: ReadonlyArray<PickerItem>, from = 0): PickerItem[] =>
  items.map((item, index) => ({
    ...item,
    label: index + from < 9 ? `${index + from + 1}  ${item.label}` : item.label,
  }));

export interface CrewFrameEnv {
  readonly columns: number;
  readonly rows: number;
  readonly style: Style;
  readonly symbols: Symbols;
  readonly banner: string | null;
  readonly tone: RailTone;
}

export const crewFrame = (
  shown: CrewView,
  context: CrewContext,
  env: CrewFrameEnv,
): RegionFrame => {
  const view = settle(shown, context);
  const { theme } = env.style;
  const room = Math.max(8, env.columns - 1 - RAIL_COLUMNS);
  const dim = (text: string) => theme.dim(sanitizeForTerminal(text));
  const draw = (picker: Parameters<typeof renderPicker>[0]) =>
    renderPicker(picker, env.columns, env.rows, env.style, env.symbols, env.banner, env.tone);
  const scope = context.scope === "thread" ? "이 스레드" : "새 채팅 기본값";

  if (view.kind === "preset") {
    return draw({
      title: "Crew 프리셋",
      items: numbered(
        PRESETS.map((entry) => ({
          label: entry.label,
          note: [entry.value === context.crew.preset ? "현재" : "", entry.hint]
            .filter((part) => part !== "")
            .join(" · "),
        })),
      ),
      selected: view.selected,
      hint: "↑/↓ 이동 • 1-4 선택 • Enter 적용 • Esc 뒤로",
      empty: "",
      before: [dim(`${scope}에 적용됩니다. 직접 고른 모델은 그대로 둡니다.`)],
    });
  }

  if (view.kind === "model") {
    const items = modelItems(context, view.role, view.query);
    return draw({
      title: `${roleName(view.role)} 모델`,
      items: items.map((item) => ({
        label: item.label,
        note: [pickIsCurrent(item, context.crew, view.role) ? "현재" : "", item.note]
          .filter((part) => part !== "")
          .join(" · "),
      })),
      selected: view.selected,
      hint: `↑/↓ 이동 • Enter 선택 • Esc ${view.query === "" ? "뒤로" : "검색어 지우기"}`,
      empty: "일치하는 모델이 없습니다. Esc로 검색어를 지우세요.",
      before: [
        view.query === ""
          ? dim(`${ROLE_HINT[view.role]} · 글자를 치면 걸러집니다`)
          : `${theme.dim("검색:")} ${theme.text(sanitizeForTerminal(view.query))}`,
      ],
    });
  }

  if (view.kind === "task") {
    const task = findTask(context, view.taskId);
    if (task === null) {
      return draw({
        title: "Crew 작업",
        items: [],
        selected: 0,
        hint: "Esc 뒤로",
        empty: "이 작업은 더 이상 보드에 없습니다.",
      });
    }
    const waiting = waitingOf(context, task);
    const detail = taskDetail(task, context.now, waiting).flatMap(([name, value]) => {
      const rows = wrapStyled(
        `${theme.dim(name.padEnd(4))} ${theme.text(sanitizeForTerminal(value))}`,
        room,
      );
      return name === "요약" && rows.length > SUMMARY_ROWS
        ? [...rows.slice(0, SUMMARY_ROWS - 1), dim("…")]
        : rows;
    });
    const labels: Record<TaskItem, PickerItem> = {
      open: {
        label: "서브 스레드 열기",
        note: waiting === null ? "작업의 대화를 봅니다" : "승인·질문에 답합니다",
      },
      stop: { label: "중단", note: "작업이 있던 곳에서 멈춥니다" },
      retry: { label: "재시도", note: "새 작업으로 다시 실행합니다" },
      back: { label: "보드로" },
      confirm: { label: "중단 확인", note: "이후 재시도할 수 있습니다" },
      cancel: { label: "취소" },
    };
    return draw({
      title: view.confirmStop ? "이 작업을 중단할까요?" : `${roleName(task.role)} 작업`,
      items: numbered(taskItems(task, view.confirmStop).map((item) => labels[item])),
      selected: view.selected,
      hint: view.confirmStop
        ? "↑/↓ 이동 • Enter 확인 • Esc 취소"
        : "↑/↓ 이동 • Enter 실행 • Esc 보드로",
      empty: "",
      before: detail,
    });
  }

  const rows = mainRows(context);
  const items: PickerItem[] = rows.map((row) => {
    switch (row.kind) {
      case "toggle":
        return { label: `Crew  ${context.crew.enabled ? "켜짐" : "꺼짐"}`, note: scope };
      case "preset":
        return {
          label: `프리셋  ${presetLabel(context.crew.preset)}`,
          note: PRESETS.find((entry) => entry.value === context.crew.preset)?.hint ?? "",
        };
      case "role":
        return {
          label: `${roleName(row.role)}  ${roleModelText(context.crew, row.role)}`,
          note: ROLE_HINT[row.role],
        };
      case "autoAll":
        return { label: "역할 모델 모두 Auto", note: "직접 고른 모델을 풉니다" };
      case "default":
        return { label: "새 채팅 기본값으로 사용", note: "지금 설정을 새 스레드에도" };
      case "thread":
        return {
          label: `${row.entry.kind === "approval" ? "승인 대기" : "질문 대기"}  ${crewSubThreadLabel(row.entry.thread.title)}`,
          note: "Enter 로 열기",
        };
      case "task": {
        const waiting = waitingOf(context, row.task);
        return {
          label: `${taskHeadline(row.task)}${waiting === null ? "" : waiting === "approval" ? " · 승인 대기" : " · 질문 대기"}`,
          note: taskNote(row.task, context.now),
        };
      }
    }
  });
  const board = context.board;
  const before: string[] = [];
  if (context.problem !== null)
    before.push(...wrapStyled(theme.warning(sanitizeForTerminal(context.problem)), room));
  const waitingLine = waitingText(context.waiting);
  if (waitingLine !== null) before.push(...wrapStyled(theme.warning(waitingLine), room));
  if (board === null) {
    before.push(dim("이 스레드에는 아직 crew 작업이 없습니다."));
  } else {
    before.push(dim(boardSummary(board)));
    for (const note of board.notes) before.push(...wrapStyled(dim(note.text), room));
  }
  return draw({
    title: "Crew",
    items: numbered(items),
    selected: view.selected,
    hint: "↑/↓ 이동 • 1-9 선택 • Enter 실행 • Esc 닫기",
    empty: "",
    before,
  });
};
