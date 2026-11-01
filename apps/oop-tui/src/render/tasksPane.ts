import type { ActivePlanState } from "@t3tools/client-runtime/thread-plan";

import { sanitizeForTerminal, visibleWidth } from "../text/width.ts";
import { truncateStyled } from "../text/wrap.ts";
import type { Symbols } from "./symbols.ts";
import type { Theme } from "./theme.ts";
import { t } from "../i18n/index.ts";

/** Shortest terminal that keeps a usable conversation above the task list. */
export const MIN_TASKS_ROWS = 16;
/** Narrowest terminal the task list is offered in. */
export const MIN_TASKS_COLUMNS = 40;

/** Why the task list cannot be used at this size; null when it can. */
export const tasksUnavailable = (columns: number, rows: number): string | null => {
  if (rows < MIN_TASKS_ROWS) {
    return t("render.tasks.tooShort", { min: MIN_TASKS_ROWS, now: rows });
  }
  if (columns < MIN_TASKS_COLUMNS) {
    return t("render.tasks.tooNarrow", { min: MIN_TASKS_COLUMNS, now: columns });
  }
  return null;
};

/** Rows of the whole pane, its rule included: about a third of the terminal. */
export const tasksPaneRows = (terminalRows: number): number =>
  Math.min(12, Math.max(5, Math.floor(terminalRows / 3)));

/** What the pane has to say: the thread's last task list, none yet, or a thread still being read. */
export type TasksContent =
  | { readonly kind: "plan"; readonly plan: ActivePlanState }
  | { readonly kind: "empty" }
  | { readonly kind: "loading" };

const oneLine = (value: string): string => sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

/**
 * Which `room` rows of `count` steps to show so that step `focus` is among them. The steps cut off
 * take a row each for `… 위로 N개` and `… 아래로 N개`, so a window that touches an end gives its
 * marker row back to the steps.
 */
const windowOf = (count: number, focus: number, room: number) => {
  if (count <= room) return { start: 0, size: count };
  const inner = Math.max(1, room - 2);
  const start = Math.max(0, Math.min(focus - Math.floor((inner - 1) / 2), count - inner));
  if (start === 0) return { start: 0, size: Math.max(1, room - 1) };
  if (start + inner >= count) {
    const size = Math.max(1, room - 1);
    return { start: count - size, size };
  }
  return { start, size: inner };
};

/** The step to keep in view: the one under way, else the next to do, else the last. */
const focusOf = (steps: ActivePlanState["steps"]): number => {
  const active = steps.findIndex((step) => step.status === "inProgress");
  if (active >= 0) return active;
  const next = steps.findIndex((step) => step.status === "pending");
  return next >= 0 ? next : steps.length - 1;
};

/**
 * The task list under the conversation, exactly `rows` rows of at most `columns` cells: a rule that
 * carries the count of finished steps, the plan's explanation when it has one, then the steps with
 * `☑` done, `◐` under way and `☐` waiting. More steps than room scroll to keep the one under way
 * in view, the rest counted in `… 위로 N개` and `… 아래로 N개`.
 */
export const renderTasksPane = (
  content: TasksContent,
  options: {
    readonly columns: number;
    readonly rows: number;
    readonly theme: Theme;
    readonly symbols: Symbols;
  },
): string[] => {
  const { theme, symbols, columns, rows } = options;
  const steps = content.kind === "plan" ? content.plan.steps : [];
  const done = steps.filter((step) => step.status === "completed").length;
  const title =
    steps.length === 0
      ? t("render.tasks.title")
      : t("render.tasks.titleProgress", { done, total: steps.length });
  const lead = `${theme.border(symbols.rule.repeat(2))} ${theme.brand.bold(title)} `;
  const header = `${lead}${theme.border(symbols.rule.repeat(Math.max(0, columns - visibleWidth(lead))))}`;
  const lines = [header];

  if (content.kind === "loading") lines.push(theme.dim(t("render.tasks.loading")));
  else if (content.kind === "empty") lines.push(theme.dim(t("render.tasks.empty")));
  else {
    const explanation = oneLine(content.plan.explanation ?? "");
    if (explanation !== "") lines.push(theme.dim(explanation));
    const room = Math.max(1, rows - lines.length);
    const { start, size } = windowOf(steps.length, focusOf(steps), room);
    const above = start;
    const below = steps.length - start - size;
    if (above > 0) lines.push(theme.dim(t("render.moreAbove", { count: above })));
    for (const step of steps.slice(start, start + size)) {
      const text = oneLine(step.step);
      lines.push(
        step.status === "completed"
          ? `  ${theme.success(symbols.todo.done)} ${theme.dim(text)}`
          : step.status === "inProgress"
            ? `  ${theme.accent(symbols.todo.active)} ${theme.text.bold(text)}`
            : `  ${theme.muted(symbols.todo.open)} ${theme.muted(text)}`,
      );
    }
    if (below > 0) lines.push(theme.dim(t("render.moreBelow", { count: below })));
  }

  const shown = lines.slice(0, rows).map((line) => truncateStyled(line, columns));
  while (shown.length < rows) shown.push("");
  return shown;
};
