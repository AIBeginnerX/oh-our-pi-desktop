/**
 * The TODO list of a crew task, as pure data and rules. The server owns the list: it numbers the
 * items, decides what each one's status is, and counts them, so every client shows the same
 * exact progress. A member can only claim an item; only a passing server check verifies it.
 */
import type { CrewProof, CrewTodoProgress, CrewTodoStatus } from "@t3tools/contracts";

import type { CrewTaskOutcome } from "./crewLogic.ts";
import { pathInScope } from "./crewScope.ts";

export const CREW_TODO_MAX = 12;
/** Paths of out-of-scope changes the progress payload and report name before saying "and N more". */
export const OUT_OF_SCOPE_SHOWN = 20;

export interface TodoCheck {
  /** A shell command the server runs in the task's workspace; it passes on exit code 0. */
  readonly command?: string | undefined;
  /** Repo-relative files (or directories) that must have changed since the task started. */
  readonly files?: ReadonlyArray<string> | undefined;
}

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly check?: TodoCheck | undefined;
  readonly status: CrewTodoStatus;
  /** What the member said when it marked the item. */
  readonly note?: string | undefined;
  /** Why the item is `failed`, or why a passing check was not trusted. */
  readonly detail?: string | undefined;
}

/** What the lead may pass per item: bare text, or text with a server check. */
export type TodoInput =
  | string
  | {
      readonly text: string;
      readonly check?:
        | {
            readonly command?: string | undefined;
            readonly files?: ReadonlyArray<string> | undefined;
          }
        | undefined;
    };

export interface OutOfScope {
  readonly files: ReadonlyArray<string>;
  readonly more: number;
  readonly shared: boolean;
}

function normalizeCheck(check: TodoCheck | undefined): TodoCheck | undefined {
  const command = check?.command?.trim();
  const files = (check?.files ?? []).map((file) => file.trim()).filter((file) => file !== "");
  if (!command && files.length === 0) return undefined;
  return { ...(command ? { command } : {}), ...(files.length > 0 ? { files } : {}) };
}

const cleanTodos = (inputs: ReadonlyArray<TodoInput> | undefined) =>
  (inputs ?? [])
    .map((input) => (typeof input === "string" ? { text: input } : input))
    .map((input) => ({ text: input.text.trim(), check: normalizeCheck(input.check) }))
    .filter((input) => input.text !== "");

const numberTodos = (cleaned: ReturnType<typeof cleanTodos>, after: number): TodoItem[] =>
  cleaned.map((input, index): TodoItem => ({
    id: `t${after + index + 1}`,
    text: input.text,
    ...(input.check === undefined ? {} : { check: input.check }),
    status: "pending",
  }));

/** The server numbers the items t1, t2, ... in order; the lead never picks ids. */
export const assignTodos = (inputs: ReadonlyArray<TodoInput> | undefined): TodoItem[] =>
  numberTodos(cleanTodos(inputs).slice(0, CREW_TODO_MAX), 0);

/**
 * Items the lead adds to a running task: numbered after the highest id so far, and refused whole
 * (not truncated) when the list would pass the cap.
 */
export function appendTodos(
  existing: ReadonlyArray<TodoItem>,
  inputs: ReadonlyArray<TodoInput>,
): { readonly items: TodoItem[]; readonly count: number; readonly room: number } {
  const cleaned = cleanTodos(inputs);
  const room = Math.max(0, CREW_TODO_MAX - existing.length);
  const highest = Math.max(0, ...existing.map((todo) => Number(todo.id.slice(1)) || 0));
  return {
    items: cleaned.length > room ? [] : numberTodos(cleaned, highest),
    count: cleaned.length,
    room,
  };
}

/** The same list, every item pending again, for a task that runs from the start. */
export const resetTodos = (todos: ReadonlyArray<TodoItem>): TodoItem[] =>
  todos.map(({ id, text, check }) => ({
    id,
    text,
    ...(check === undefined ? {} : { check }),
    status: "pending" as const,
  }));

export function todoCounts(todos: ReadonlyArray<TodoItem>) {
  const count = (status: CrewTodoStatus) => todos.filter((todo) => todo.status === status).length;
  return {
    total: todos.length,
    pending: count("pending"),
    verified: count("verified"),
    claimed: count("claimed"),
    failed: count("failed"),
    blocked: count("blocked"),
  };
}

/** Items that still need the member's work: not yet done, or done but failing. */
export const openTodoIds = (todos: ReadonlyArray<TodoItem>) =>
  todos.filter((todo) => todo.status === "pending" || todo.status === "failed").map((t) => t.id);

export function summarizeOutOfScope(
  files: ReadonlyArray<string>,
  shared: boolean,
): OutOfScope | undefined {
  if (files.length === 0) return undefined;
  const sorted = files.toSorted();
  return {
    files: sorted.slice(0, OUT_OF_SCOPE_SHOWN),
    more: Math.max(0, sorted.length - OUT_OF_SCOPE_SHOWN),
    shared,
  };
}

/**
 * The fields a crew task's `task.progress` and `task.completed` activities carry when it has a
 * TODO list. Counts only, never a percentage.
 */
export function todoProgressFields(
  todos: ReadonlyArray<TodoItem>,
  outOfScope: OutOfScope | undefined,
): CrewTodoProgress {
  const counts = todoCounts(todos);
  return {
    todos: todos.map(({ id, text, status }) => ({ id, text, status })),
    todoTotal: counts.total,
    todoVerified: counts.verified,
    todoClaimed: counts.claimed,
    todoFailed: counts.failed,
    todoBlocked: counts.blocked,
    ...(outOfScope === undefined ? {} : { outOfScope }),
  };
}

function describeCheck(check: TodoCheck | undefined): string {
  if (check === undefined) return "";
  const parts = [
    ...(check.command ? [`runs \`${check.command}\`, which must exit 0`] : []),
    ...(check.files ? [`needs changes in ${check.files.join(", ")}`] : []),
  ];
  return ` (OOP checks this itself: ${parts.join("; ")})`;
}

/**
 * The TODO section of a delegated task's prompt. It goes after the fixed preamble and the task,
 * so tasks without a list read exactly as before.
 */
export function todoPromptLines(
  todos: ReadonlyArray<TodoItem> | undefined,
  options: { readonly scoped: boolean },
): string[] {
  if (todos === undefined || todos.length === 0) return [];
  return [
    "",
    "TODO (the checklist for this task; OOP tracks it and shows its progress):",
    ...todos.map((todo) => `- ${todo.id}: ${todo.text}${describeCheck(todo.check)}`),
    "",
    'Check each item off with the `crew_todo_check` tool (t3-code MCP server) as soon as you finish it, before you start the next one: {"todoId":"t1","status":"done","note":"what you did"}. Do not save the calls for the end, and do not check an item you have not finished. Use status "blocked" with a note saying why when you cannot do an item; do not rework other things or switch tools to make its check pass, invent a value, or search outside the workspace.',
    "For an item OOP checks itself, OOP runs the check when you call the tool; if it fails, the tool returns the output, so fix the cause and call it again. Never edit tests, configuration, or anything else only to make a check pass.",
    ...(options.scoped
      ? ["A check that passes because of files outside your SCOPE does not count as verified."]
      : []),
  ];
}

/**
 * What a later attempt's prompt adds after the original one when an earlier model already got
 * part of the list done: the finished items are not repeated, only the open ones remain.
 */
export function todoResumeLines(todos: ReadonlyArray<TodoItem> | undefined): string[] {
  if (todos === undefined || todos.length === 0) return [];
  const finished = todos.filter((todo) => todo.status === "verified" || todo.status === "claimed");
  const remaining = todos.filter((todo) => todo.status !== "verified" && todo.status !== "claimed");
  return [
    "",
    "TODO PROGRESS (an earlier model worked on this task before you; its file changes are in the workspace and OOP kept the checklist state, which replaces the TODO list above):",
    finished.length === 0
      ? "Finished: nothing yet."
      : `Finished, do not redo: ${finished.map((todo) => `${todo.id} (${todo.status === "verified" ? "verified" : "done, unverified"})`).join(", ")}.`,
    remaining.length === 0
      ? "Nothing is left on the list; confirm the work and write your report."
      : "Still to do:",
    ...remaining.map((todo) => {
      const why =
        todo.status === "pending"
          ? ""
          : ` [${todo.status}: ${todo.detail ?? todo.note ?? "see above"}]`;
      return `- ${todo.id}: ${todo.text}${describeCheck(todo.check)}${why}`;
    }),
  ];
}

/** The lines the lead reads at the end of a report that came from a task with a TODO list. */
export function todoReportNote(
  todos: ReadonlyArray<TodoItem>,
  outOfScope: OutOfScope | undefined,
): string | null {
  if (todos.length === 0) return null;
  const counts = todoCounts(todos);
  const rest = todos.filter((todo) => todo.status !== "verified");
  const parts = [
    `${counts.verified} verified`,
    ...(counts.claimed > 0 ? [`${counts.claimed} claimed without proof`] : []),
    ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
    ...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
    ...(counts.pending > 0 ? [`${counts.pending} not done`] : []),
  ];
  return [
    "",
    "",
    `TODO: ${counts.total} items, ${parts.join(", ")}.`,
    ...rest.map(
      (todo) =>
        `- ${todo.id} (${todo.status}): ${todo.text}${(todo.detail ?? todo.note) ? ` - ${todo.detail ?? todo.note}` : ""}`,
    ),
    ...(outOfScope === undefined
      ? []
      : [
          outOfScope.shared
            ? "Files changed outside the write scope (the workspace is shared, so some may be another agent's work):"
            : "Files this member changed outside its write scope:",
          ...outOfScope.files.map((file) => `- ${file}`),
          ...(outOfScope.more > 0 ? [`- and ${outOfScope.more} more`] : []),
        ]),
  ].join("\n");
}

export type FilesVerdict =
  | { readonly kind: "failed"; readonly missing: ReadonlyArray<string> }
  | { readonly kind: "passed"; readonly outOfScopeOnly: ReadonlyArray<string> };

/**
 * Judges a `files` check against what changed since the task started. A listed file counts only
 * when something inside the write scope changed under it; entries that changed only outside the
 * scope are returned in `outOfScopeOnly` so the caller can refuse to verify on them.
 */
export function judgeFilesCheck(input: {
  readonly files: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly writeScope: ReadonlyArray<string> | undefined;
}): FilesVerdict {
  const scoped = input.writeScope !== undefined && input.writeScope.length > 0;
  const missing: string[] = [];
  const outOfScopeOnly: string[] = [];
  for (const file of input.files) {
    const hits = input.changed.filter((changed) => pathInScope(changed, [file]));
    if (hits.length === 0) missing.push(file);
    else if (scoped && hits.every((hit) => !pathInScope(hit, input.writeScope ?? []))) {
      outOfScopeOnly.push(file);
    }
  }
  return missing.length > 0 ? { kind: "failed", missing } : { kind: "passed", outOfScopeOnly };
}

/** The changed files that lie outside the write scope; none when the task has no scope. */
export const filesOutsideScope = (
  changed: ReadonlyArray<string>,
  writeScope: ReadonlyArray<string> | undefined,
) =>
  writeScope === undefined || writeScope.length === 0
    ? []
    : changed.filter((file) => !pathInScope(file, writeScope));

/** The one follow-up turn a member gets when it stops with items it never marked. */
export function nudgeText(pending: ReadonlyArray<TodoItem>): string {
  return [
    "Your turn ended, but these TODO items were never marked:",
    ...pending.map((todo) => `- ${todo.id}: ${todo.text}`),
    'Finish them and mark each with `crew_todo_check`, or mark one `"blocked"` with a note saying why. Then repeat your final report, with the Status line and the JSON block.',
  ].join("\n");
}

/** The follow-up turn a member gets when the lead added items to its task after it started. */
export function addedTodosText(added: ReadonlyArray<TodoItem>): string {
  return [
    "The lead added these items to your TODO list:",
    ...added.map((todo) => `- ${todo.id}: ${todo.text}${describeCheck(todo.check)}`),
    'Do them, and mark each with `crew_todo_check` as you finish it, or mark one `"blocked"` with a note saying why. Then repeat your final report, with the Status line and the JSON block.',
  ].join("\n");
}

export interface TaskProof {
  readonly verdict: CrewProof;
  /** One short line for the lead, e.g. "2 items claimed without proof". */
  readonly reason: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Whether OOP itself could verify a finished worker or expert task. A member's own "done" never
 * counts: the task is `verified` only when the server verified every checklist item, or, without
 * a checklist, when a passing test run was observed in its thread. Anything the server could not
 * judge is `inconclusive`; an ending other than completed, a failing or unfinished item, or a
 * member's own failed verification is `not-verified`.
 */
export function taskProof(input: {
  readonly status: CrewTaskOutcome;
  readonly todos?: ReturnType<typeof todoCounts> | undefined;
  /** A passing test run seen in the member's thread, not just reported by the member. */
  readonly observedTests: boolean;
  readonly selfReportedPassed: boolean | null | undefined;
}): TaskProof {
  const { todos } = input;
  if (input.status !== "completed") {
    return { verdict: "not-verified", reason: `the task ended ${input.status}` };
  }
  if (todos !== undefined) {
    const open = todos.failed + todos.blocked + todos.pending;
    if (open > 0) {
      const parts = [
        ...(todos.failed > 0 ? [`${todos.failed} failed`] : []),
        ...(todos.blocked > 0 ? [`${todos.blocked} blocked`] : []),
        ...(todos.pending > 0 ? [`${todos.pending} not done`] : []),
      ];
      return {
        verdict: "not-verified",
        reason: `${plural(open, "item")} unfinished (${parts.join(", ")})`,
      };
    }
  }
  if (input.selfReportedPassed === false) {
    return {
      verdict: "not-verified",
      reason: "the member reported that its own verification failed",
    };
  }
  if (todos !== undefined && todos.total > 0) {
    return todos.claimed > 0
      ? {
          verdict: "inconclusive",
          reason: `${plural(todos.claimed, "item")} claimed without proof`,
        }
      : {
          verdict: "verified",
          reason: `all ${plural(todos.total, "item")} verified by server checks`,
        };
  }
  return input.observedTests
    ? { verdict: "verified", reason: "a passing test run was observed in the member's thread" }
    : {
        verdict: "inconclusive",
        reason: "no server check ran and no passing test run was observed",
      };
}

/** How the lead's note and follow-up spell a verdict. */
export const proofLabel = (verdict: CrewProof) =>
  verdict === "not-verified" ? "NOT VERIFIED" : verdict.toUpperCase();

/** The line a report ends with, so a reader of the result text alone sees the verdict. */
export const proofNote = (proof: TaskProof) =>
  `\n\nPROOF: ${proofLabel(proof.verdict)} - ${proof.reason}`;
