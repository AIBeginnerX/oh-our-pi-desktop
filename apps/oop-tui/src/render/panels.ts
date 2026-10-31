import type { ProviderApprovalOption } from "@t3tools/contracts";

import type { AgentRow, PlanStep } from "../state/threadStatus.ts";
import { sanitizeForTerminal } from "../text/width.ts";
import { truncateStyled, wrapStyled, wrapWithPrefix } from "../text/wrap.ts";
import { RAIL_COLUMNS, railActive, packHint, railChoice, railRow, type Rail } from "./rail.ts";
import { formatElapsed } from "./spinner.ts";
import type { Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { shellCommand } from "./toolLine.ts";

/** Cleaned text on a single row: a field that must not span lines never carries a line feed. */
const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\n/gu, " ");

const REQUEST_KIND_LABEL: Record<string, string> = {
  command: "명령 실행",
  "file-read": "파일 읽기",
  "file-change": "파일 변경",
  "mcp-elicitation": "MCP 요청",
  permission: "권한 요청",
};

/** What the request was about, in words: `명령 실행`. */
export const requestKindLabel = (requestKind: string): string =>
  REQUEST_KIND_LABEL[requestKind] ?? "승인 요청";

export const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "허용" },
  { decision: "acceptForSession", label: "이 세션 동안 허용" },
  { decision: "decline", label: "거부" },
  { decision: "cancel", label: "턴 취소" },
];

export interface ApprovalView {
  readonly requestKind: string;
  readonly detail: string | undefined;
  readonly appName: string | undefined;
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  /** The option a keypress has picked but Enter has not sent yet; null until the user picks one. */
  readonly selected: number | null;
  /** Typing arrived that is not an option: the numbers are off until the arrows are used. */
  readonly locked: boolean;
}

const DETAIL_ROWS = 6;

/** Where to look to see how a numbered choice is made: the keys that move, and the ones that leave. */
const approvalHint = (view: ApprovalView): string => {
  const leave = "Ctrl-T 나중에 • Esc 턴 중단";
  const chosen = view.selected === null ? undefined : view.options[view.selected];
  if (chosen) {
    return `Enter 로 '${oneLine(chosen.label)}' 확정 • ↑/↓ 번호 바꾸기 • ${leave}`;
  }
  if (view.locked) return `번호 잠김 • ↑/↓ 를 누르면 풀립니다 • Enter 확정 • ${leave}`;
  return `↑/↓ 이동 • 번호 • Enter 확정 • ${leave}`;
};

/**
 * An approval on the rail, in the warning colour: `◆ 승인 필요: 명령 실행`, the command with the
 * shell that wraps it taken off, the options, and how to answer. Nothing is filled until a key picks
 * an option; Enter alone never decides. The rail is left open for whatever closes it. With `maxRows`
 * the panel is no taller than that: the command is cut short (`… 3줄 더`) so that the title and the
 * options always show; on a terminal too short even for those and a line of the command, the hint
 * is cut as well.
 */
export const renderApprovalPanel = (
  view: ApprovalView,
  columns: number,
  rail: Rail,
  maxRows?: number,
): string[] => {
  const { theme } = rail.style;
  const width = Math.max(10, columns - 1);
  const app = view.appName ? ` · ${oneLine(view.appName)}` : "";
  const detail = view.detail
    ? sanitizeForTerminal(shellCommand(sanitizeForTerminal(view.detail)))
        .split("\n")
        .flatMap((line) => wrapStyled(line, width - RAIL_COLUMNS))
    : [];
  const options = view.options.map((option, index) => ({
    label: `${index + 1} ${oneLine(option.label)}`,
    ...(option.warning ? { warning: oneLine(option.warning) } : {}),
  }));
  const hint = approvalHint(view);
  // The rows the question and the options need no matter what. Of what is left, the command keeps
  // a line and the `…` row before the hint takes any, and the command gets the rest.
  const fixed = 1 + options.reduce((rows, option) => rows + ("warning" in option ? 2 : 1), 0);
  const hintRows = packHint(hint, width - RAIL_COLUMNS).length;
  const spare = maxRows === undefined ? undefined : Math.max(0, maxRows - fixed);
  const commandFloor = Math.min(2, detail.length);
  const hintShown =
    spare === undefined ? hintRows : Math.min(hintRows, Math.max(0, spare - commandFloor));
  const room = spare === undefined ? DETAIL_ROWS + 1 : spare - hintShown;
  let shown = detail;
  if (detail.length > Math.min(DETAIL_ROWS, room)) {
    const keep = Math.max(0, Math.min(DETAIL_ROWS, room - 1));
    shown = room < 1 ? [] : [...detail.slice(0, keep), theme.dim(`… ${detail.length - keep}줄 더`)];
  }
  const rows = railChoice(rail, {
    question: theme.warning.bold(`승인 필요: ${requestKindLabel(view.requestKind)}${app}`),
    before: shown,
    options,
    selected: view.selected,
    hint,
    width,
    tone: "warning",
  });
  // Only a terminal too short for more than the title and the options cuts the hint.
  return hintShown < hintRows ? rows.slice(0, rows.length - (hintRows - hintShown)) : rows;
};

export interface QuestionView {
  readonly index: number;
  readonly total: number;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly multiSelect: boolean;
  readonly allowCustom: boolean;
  readonly dismissible: boolean;
}

/**
 * A question on the rail: the header, the question, the numbered options and how to answer. The
 * answer is typed into the composer, which carries on the same rail underneath. With `maxRows` the
 * panel is no taller than that where it can be: the question is cut short (`… 3줄 더`) so that the
 * header, the options and how to answer always show.
 */
export const renderQuestionPanel = (
  view: QuestionView,
  columns: number,
  rail: Rail,
  maxRows?: number,
): string[] => {
  const { theme } = rail.style;
  const width = Math.max(10, columns - 1);
  const room = width - RAIL_COLUMNS;
  const progress = view.total > 1 ? ` (${view.index + 1}/${view.total})` : "";
  const title = railActive(
    rail,
    truncateStyled(theme.text.bold(`질문${progress}: ${oneLine(view.header)}`), room),
  );
  const body = wrapStyled(sanitizeForTerminal(view.question), room);
  const lines: string[] = [];
  view.options.forEach((option, index) => {
    const description = option.description ? theme.dim(` - ${oneLine(option.description)}`) : "";
    const number = String(index + 1);
    for (const row of wrapWithPrefix(
      `${oneLine(option.label)}${description}`,
      room,
      `${theme.text.bold(number)}  `,
      " ".repeat(number.length + 2),
    )) {
      lines.push(railRow(rail, row, "active"));
    }
  });
  const how: string[] = [];
  if (view.options.length > 0) {
    how.push(view.multiSelect ? "번호를 쉼표로 구분해 입력" : "번호 입력");
  }
  if (view.allowCustom) how.push(view.options.length > 0 ? "또는 직접 답변" : "답변 입력");
  if (view.dismissible) how.push("Esc 건너뛰기");
  how.push("Ctrl-T 나중에");
  for (const row of packHint(how.join(" • "), room))
    lines.push(railRow(rail, theme.dim(row), "active"));
  // What is left of the room goes to the question, which is cut from its end.
  const spare = maxRows === undefined ? body.length : Math.max(0, maxRows - 1 - lines.length);
  const shown =
    body.length <= spare
      ? body
      : spare < 1
        ? []
        : [...body.slice(0, spare - 1), theme.dim(`… ${body.length - spare + 1}줄 더`)];
  return [title, ...shown.map((row) => railRow(rail, row, "active")), ...lines];
};

const PLAN_BAR_CELLS = 10;
const PLAN_ITEM_ROWS = 5;

/**
 * `계획 2/5 ━━━━──────` and the steps under it (`☑` done, `◐` under way, `☐` waiting). At most
 * `maxRows` rows come back, the header first; a plan longer than the room shows the steps around the
 * one being worked on. `collapsed` leaves the header alone. `foldable` is false while a panel waits
 * for an answer, when Ctrl-T leaves the chat instead of folding, so no key is offered.
 */
export const renderPlan = (
  steps: ReadonlyArray<PlanStep>,
  options: {
    readonly collapsed: boolean;
    readonly foldable: boolean;
    readonly columns: number;
    readonly maxRows: number;
    readonly theme: Theme;
    readonly symbols: Symbols;
  },
): string[] => {
  const { theme, symbols } = options;
  if (steps.length === 0 || options.maxRows < 1) return [];
  const width = Math.max(10, options.columns - 1);
  const done = steps.filter((step) => step.status === "completed").length;
  const filled = Math.round((done / steps.length) * PLAN_BAR_CELLS);
  const bar = `${theme.brand(symbols.progress.full.repeat(filled))}${theme.border(symbols.progress.empty.repeat(PLAN_BAR_CELLS - filled))}`;
  const hint = options.collapsed ? "Ctrl-T 펼치기" : "Ctrl-T 접기";
  const lines = [
    truncateStyled(
      `${theme.brand.bold("계획")} ${theme.text(`${done}/${steps.length}`)} ${bar}${options.foldable ? `  ${theme.dim(hint)}` : ""}`,
      width,
    ),
  ];
  if (options.collapsed) return lines;

  const room = Math.min(PLAN_ITEM_ROWS, options.maxRows - 1);
  if (room < 1) return lines;
  const current = steps.findIndex((step) => step.status === "inProgress");
  const focus =
    current >= 0
      ? current
      : Math.max(
          0,
          steps.findIndex((step) => step.status === "pending"),
        );
  const start = Math.max(0, Math.min(focus - 1, steps.length - room));
  for (const step of steps.slice(start, start + room)) {
    const text = oneLine(step.step);
    const row =
      step.status === "completed"
        ? `${theme.success(symbols.todo.done)} ${theme.dim(text)}`
        : step.status === "inProgress"
          ? `${theme.accent(symbols.todo.active)} ${theme.text.bold(text)}`
          : `${theme.muted(symbols.todo.open)} ${theme.muted(text)}`;
    lines.push(truncateStyled(`  ${row}`, width));
  }
  return lines;
};

/**
 * Running sub-agents as a tree, one row each: `├─ 이름 · 작업 · 12s`. Past `maxRows` the last row
 * counts the rest.
 */
export const renderAgents = (
  agents: ReadonlyArray<AgentRow>,
  options: {
    readonly now: number;
    readonly columns: number;
    readonly maxRows: number;
    readonly theme: Theme;
    readonly symbols: Symbols;
  },
): string[] => {
  const { theme, symbols } = options;
  if (agents.length === 0 || options.maxRows < 1) return [];
  const width = Math.max(10, options.columns - 1);
  const shown = agents.length > options.maxRows ? options.maxRows - 1 : agents.length;
  const hidden = agents.length - shown;
  const lines = agents.slice(0, shown).map((agent, index) => {
    const color = theme.agent(index);
    const branch = index === shown - 1 && hidden === 0 ? symbols.tree.last : symbols.tree.branch;
    const work = agent.work === null ? "" : theme.muted(` · ${oneLine(agent.work)}`);
    const elapsed =
      agent.startedAt === null
        ? ""
        : theme.dim(` · ${formatElapsed(Math.max(0, options.now - agent.startedAt))}`);
    return truncateStyled(
      `${color(branch)} ${color.bold(oneLine(agent.name))}${work}${elapsed}`,
      width,
    );
  });
  if (hidden > 0) {
    lines.push(theme.dim(`${symbols.tree.last} … 외 ${hidden}개`));
  }
  return lines;
};
