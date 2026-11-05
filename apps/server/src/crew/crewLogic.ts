/**
 * Pure rules for OOP Crew: how a delegated or audit thread is named and prompted, how its
 * progress reads from a thread shell, and which finished turns earn an audit.
 */
import type {
  ComposerContextId,
  ComposerContextRecord,
  CrewRole,
  OrchestrationMessageContext,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Clients nest crew threads by this title too, so its rules live in the shared package.
import { CREW_ROLE_LABEL, isCrewThreadTitle } from "@t3tools/shared/crew";
import {
  PROJECT_MEMORY_REFERENCE_LABEL,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

export { CREW_ROLE_LABEL, isCrewThreadTitle };

import { scopeSegments } from "./crewScope.ts";
import { todoPromptLines, type TodoItem } from "./crewTodos.ts";

const CREW_TITLE_PREFIX = "Crew ";

export type CrewTaskStatus = "starting" | "running" | "completed" | "failed" | "interrupted";
/** A finished task as the lead sees it: its thread's status, or the status line of its report. */
export type CrewTaskOutcome = CrewTaskStatus | "partial" | "blocked";

export function crewThreadTitle(role: CrewRole, subject: string): string {
  const oneLine = subject.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  return `${CREW_TITLE_PREFIX}${CREW_ROLE_LABEL[role]} · ${short || "task"}`;
}

export function crewTaskStatus(
  shell: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
): CrewTaskStatus {
  const turn = shell.latestTurn;
  if (turn === null) {
    // A provider that fails before its first turn (sign-in, balance) only leaves a session error.
    const session = shell.session;
    return session !== null &&
      session.lastError !== null &&
      session.status !== "running" &&
      session.status !== "starting"
      ? "failed"
      : "starting";
  }
  switch (turn.state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
  }
}

export const isSettledCrewStatus = (status: CrewTaskStatus): boolean =>
  status === "completed" || status === "failed" || status === "interrupted";

const EVIDENCE_LEVELS = '"said"|"line"|"traced"|"ran"|"app"';
const FINDING_SHAPE = `{"severity":"P0"|"P1"|"P2"|"P3","confidence":number from 0 to 1,"title":string,"file"?:string,"line"?:number,"proven"?:boolean,"level"?:${EVIDENCE_LEVELS},"evidence"?:string}`;
const FINDING_SEVERITIES =
  "P0 breaks the build or loses data, P1 is wrong behavior, P2 should be fixed, P3 is a nit";

const REPORT_SHAPE = `{"status":"done"|"partial"|"blocked","summary":string,"changedFiles":string[],"verification":{"command":string,"passed":boolean|null}|null,"findings":[${FINDING_SHAPE}]}`;

const AUDIT_REPORT_SHAPE = `{"verdict":"approve"|"needs changes","summary":string,"safetyFact":{"fact":string,"level":${EVIDENCE_LEVELS},"evidence":string},"findings":[${FINDING_SHAPE}],"preExistingFailures":string[]}`;

/**
 * The prompt for a delegated task. The preamble is the same for every task so providers can cache
 * it; the task and its optional sections come last.
 */
export function delegatePrompt(input: {
  readonly role: CrewRole;
  readonly leadTitle: string;
  readonly task: string;
  /** Repo-relative files or directories the task may change. */
  readonly writeScope?: ReadonlyArray<string> | undefined;
  /** The literal command(s) that prove the task is done. */
  readonly verify?: string | undefined;
  readonly doneWhen?: string | undefined;
  /** The checklist, already numbered by the server. */
  readonly todos?: ReadonlyArray<TodoItem> | undefined;
}): string {
  const verify = input.verify?.trim();
  const doneWhen = input.doneWhen?.trim();
  return [
    `You are the ${CREW_ROLE_LABEL[input.role].toLowerCase()} on an OOP crew. The lead agent of the thread "${input.leadTitle}" handed you this task.`,
    "Work in the current workspace. Do only this task; the lead owns the plan and the conversation with the user.",
    "When you finish, reply with a short report: what you did, which files you changed, and anything left undone or uncertain.",
    "End the report with one line: `Status: done`, `Status: partial` when part of the task is left, or `Status: blocked` when you could not do it.",
    `After that line, close the reply with the same report as one fenced \`\`\`json block of this shape: ${REPORT_SHAPE}`,
    `In it, \`verification\` is the check you ran (null when you ran none, and \`passed\` null when it gave no clear result), and \`findings\` are problems you found but did not fix (${FINDING_SEVERITIES}); use [] when there are none.`,
    "",
    "TASK:",
    input.task.trim(),
    ...(input.writeScope === undefined || input.writeScope.length === 0
      ? []
      : [
          "",
          "SCOPE (the files you may change; leave everything else alone, and say so in your report if the task needs more):",
          ...input.writeScope.map((path) => `- ${path}`),
        ]),
    ...(verify
      ? [
          "",
          "VERIFY (run exactly this before you report, and put its result in your report):",
          verify,
        ]
      : []),
    ...(doneWhen ? ["", "DONE WHEN:", doneWhen] : []),
    ...todoPromptLines(input.todos, {
      scoped: input.writeScope !== undefined && input.writeScope.length > 0,
    }),
  ].join("\n");
}

/** Appended to a delegated task's prompt when the task works in its own git worktree. */
export const ISOLATED_CHECKOUT_PROMPT =
  "ISOLATED CHECKOUT: you work in your own copy of the repository, started from the lead's tracked files. Untracked and ignored files (for example installed dependencies) are not in it. There is no need to commit; your changes, new files included, are applied back to the lead's workspace when you finish.";

/** Appended to a candidate task's prompt: its work is kept for the lead to compare, not applied. */
export const CANDIDATE_CHECKOUT_PROMPT =
  "CANDIDATE CHECKOUT: you work in your own copy of the repository, started from the lead's tracked files. Your changes are NOT applied to the lead's workspace; they are kept as a patch for the lead to compare with other candidates. Untracked and ignored files (for example installed dependencies) are not in it: if you need an install to run the tests, say so in your report. Do not look at other candidates' work.";

const CREW_MEMORY_HEADER = "Project memory selected by the lead for this task:";

/** The project memories the lead's turn selected, by id and the version it selected. */
export interface CrewMemoryRef {
  readonly memoryId: string;
  readonly selectedVersion: number;
}

/**
 * A crew thread's first message when it carries project memory: the brief, then one inline
 * reference per memory (id and version only) with the matching context records. The memory text is
 * never put here. The orchestrator resolves the references on the member's own thread, so the
 * member's turn passes the same ledger, hold and echo checks as any composer send.
 */
export function withCrewMemoryReferences(
  prompt: string,
  refs: ReadonlyArray<CrewMemoryRef>,
): { readonly text: string; readonly context: OrchestrationMessageContext | undefined } {
  if (refs.length === 0) return { text: prompt, context: undefined };
  const contextIds = refs.map((_, index) => `crew_memory_${index + 1}` as ComposerContextId);
  const links = refs.map((_, index) =>
    formatComposerContextReference({
      kind: "memory",
      contextId: contextIds[index]!,
      label: PROJECT_MEMORY_REFERENCE_LABEL,
    }),
  );
  const records: ReadonlyArray<ComposerContextRecord> = refs.map((ref, index) => ({
    version: 1,
    contextId: contextIds[index]!,
    kind: "memory",
    label: PROJECT_MEMORY_REFERENCE_LABEL,
    payload: { memoryId: ref.memoryId, selectedVersion: ref.selectedVersion },
  }));
  return {
    text: `${prompt}\n\n${CREW_MEMORY_HEADER}\n${links.join(" ")}`,
    context: { version: 1, records: [...records] },
  };
}

/** A stored crew brief without the memory references, so a retry starts from the plain brief. */
export function withoutCrewMemoryReferences(text: string): string {
  const at = text.indexOf(`\n\n${CREW_MEMORY_HEADER}\n`);
  return at === -1 ? text : text.slice(0, at);
}

/** Two write scopes overlap when one path is the other, or a directory containing it. */
function scopesOverlap(a: string, b: string): boolean {
  const left = scopeSegments(a);
  const right = scopeSegments(b);
  return left.slice(0, right.length).every((segment, index) => segment === right[index]);
}

export interface WriteScopeOverlap {
  readonly taskId: string;
  readonly subject: string;
  readonly paths: ReadonlyArray<{ readonly mine: string; readonly theirs: string }>;
}

/**
 * The running tasks whose write scope overlaps a new task's. A running task without a scope is
 * unknown, not overlapping, so only scopes both sides declared can warn. An isolated task writes
 * to its own worktree and cannot clobber anything, so it is left out.
 */
export function overlappingWriteScopes(
  scope: ReadonlyArray<string>,
  running: ReadonlyArray<{
    readonly taskId: string;
    readonly subject: string;
    readonly writeScope?: ReadonlyArray<string> | undefined;
    readonly isolated?: boolean | undefined;
  }>,
): ReadonlyArray<WriteScopeOverlap> {
  return running.flatMap((task) => {
    if (task.isolated === true) return [];
    const paths = scope.flatMap((mine) =>
      (task.writeScope ?? []).flatMap((theirs) =>
        scopesOverlap(mine, theirs) ? [{ mine, theirs }] : [],
      ),
    );
    return paths.length === 0 ? [] : [{ taskId: task.taskId, subject: task.subject, paths }];
  });
}

const WARNED_PATHS_PER_TASK = 5;

/** What crew_delegate tells the brain when the task it just started may collide with others. */
export function writeScopeWarning(overlaps: ReadonlyArray<WriteScopeOverlap>): string | null {
  if (overlaps.length === 0) return null;
  return [
    "The task started, but its write scope overlaps running tasks, which can overwrite each other's edits:",
    ...overlaps.map((overlap) => {
      const shown = overlap.paths
        .slice(0, WARNED_PATHS_PER_TASK)
        .map(({ mine, theirs }) => (mine === theirs ? mine : `${mine} vs ${theirs}`));
      const more = overlap.paths.length - shown.length;
      return `- ${reportExcerpt(overlap.subject, 80)} (task ${overlap.taskId}): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
    }),
    "Wait for those tasks with crew_wait before relying on these files, or narrow the scopes so each task writes different files.",
  ].join("\n");
}

/** The longest diff an audit prompt carries; the auditor reads a bigger change itself. */
export const AUDIT_DIFF_MAX_CHARS = 40_000;

/** A thread diff fit for the audit prompt, or null when it is empty or too long to hand over. */
export function auditDiff(diff: string): string | null {
  return diff.trim().length === 0 || diff.length > AUDIT_DIFF_MAX_CHARS ? null : diff;
}

export function auditPrompt(input: {
  readonly leadTitle: string;
  readonly files: ReadonlyArray<string>;
  /** The user's request the turn answered; the audit judges the change against it. */
  readonly request: string | null;
  /** Everything the thread changed so far, from `auditDiff`; without it the auditor reads the workspace. */
  readonly diff?: string | null;
  /** The workspace snapshots (hidden git refs) from before and after the audited turn. */
  readonly turnRefs?: { readonly from: string; readonly to: string } | null;
}): string {
  const listed = input.files.slice(0, 40);
  const more = input.files.length - listed.length;
  const request = input.request?.trim();
  const diff = input.diff ?? null;
  const turnRefs = input.turnRefs ?? null;
  // Longer than any backtick run in the diff, so a changed markdown file cannot close the fence.
  const fence = "`".repeat(
    Math.max(3, ...[...(diff ?? "").matchAll(/`+/g)].map((run) => run[0].length + 1)),
  );
  return [
    `You are the auditor on an OOP crew. The lead agent of the thread "${input.leadTitle}" just finished a turn that changed these files:`,
    ...listed.map((file) => `- ${file}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    ...(request
      ? ["", "The user asked:", request.length > 2000 ? `${request.slice(0, 1997)}...` : request]
      : []),
    ...(diff === null
      ? []
      : ["", "Everything the thread has changed so far:", `${fence}diff`, diff.trimEnd(), fence]),
    "",
    diff === null
      ? "Review the change in this workspace (read the files and the git diff). Do not edit anything."
      : "Review the change from the diff above. Read other files or run checks only to settle a specific doubt about it. Do not edit anything.",
    "Judge it against what the user asked. A blocking problem means the request is not done or something that worked is now broken: wrong results, failing tests, a broken build, a requested part missing. Hardening beyond the request, style, and extra tests are not blocking; list them under risky changes or missing tests.",
    "A failing test, typecheck, or lint run is a regression only if this turn's change could have caused it. Before calling one a regression, check whether it already failed before the turn.",
    turnRefs === null
      ? "Read the diff to see whether the failing code was touched."
      : `The turn ran from the workspace snapshot \`${turnRefs.from}\` to \`${turnRefs.to}\`. \`git diff ${turnRefs.from} ${turnRefs.to} -- <path>\` shows what the turn changed in a file, and \`git show ${turnRefs.from}:<path>\` reads it as it was before. Never check out, stash, or reset anything.`,
    "A failure in code the turn did not touch, or one that also happens at the turn's start, is pre-existing: list it under preExistingFailures and do not call for changes because of it.",
    'First find the one fact this change is safe because of (for example "this call only drops dead cache entries"), and say in safetyFact how far you proved it. Then interrogate the change: for each way it could break something that worked, find the callers and inputs it touches and try to make it fail.',
    'Prove it by running real code when your tools allow it (level ran or app); when you cannot run anything, a step-by-step trace through real file:line to a concrete failing input (level traced) is the minimum for a finding to count. Put the command and its output line, or the trace, in `evidence` and set `proven` true with that `level`. A concern you could only point at (said, line) is unproven: list it, it never blocks. Do not report style, naming, or "might break in future" risks. A result that does not reproduce is not a finding.',
    "Reply with: blocking problems, risky or unclear changes, missing tests, then one verdict line: `Verdict: needs changes` only when a blocking problem remains, otherwise `Verdict: approve`.",
    `After that line, close the reply with the same review as one fenced \`\`\`json block of this shape: ${AUDIT_REPORT_SHAPE}`,
    `In it, blocking problems are proven P0 or P1 findings (level traced, ran, or app) and the rest are P2 or P3 (${FINDING_SEVERITIES}); \`preExistingFailures\` has one string per failure that predates the turn, naming the command or test; use [] when a list is empty.`,
  ].join("\n");
}

/** Changed lines up to which a turn counts as a small change. */
export const SMALL_CHANGE_LINES = 20;

/**
 * What the crew does with a finished turn.
 * - `none`: the turn is out of scope (no change, crew off, no auditor, crew thread).
 * - `skipped`: a small change whose tests passed in the same turn; no auditor runs.
 * - `fast`: a small change without a passing test run, audited by a fast model.
 * - `full`: everything else, audited by the auditor role's own model. A turn after an audit that
 *   asked for changes is always `full`, so a fix clears the verdict only by passing a review, and a
 *   model the user picked for the auditor is never swapped for a fast one.
 */
export type TurnAuditPlan = "none" | "skipped" | "fast" | "full";

/**
 * How much review a finished turn earns. Auditing every change costs about twice the tokens and
 * time of the single model without a measured gain, so small changes the turn already proved with
 * a passing test run go unaudited, and the rest of the small ones go to a fast model.
 */
export function planTurnAudit(input: {
  readonly changedFiles: number;
  readonly changedLines: number;
  /** The turn ran a test command that finished successfully. */
  readonly testsPassed: boolean;
  /** The thread's latest audit asked for changes, so this turn may be the fix. */
  readonly changesRequested: boolean;
  /** The user picked the auditor's model rather than leaving it to the preset. */
  readonly auditorPinned: boolean;
  readonly threadTitle: string;
  readonly crewEnabled: boolean;
  readonly hasAuditor: boolean;
}): TurnAuditPlan {
  if (
    input.changedFiles === 0 ||
    !input.crewEnabled ||
    !input.hasAuditor ||
    isCrewThreadTitle(input.threadTitle)
  ) {
    return "none";
  }
  if (input.changesRequested || input.changedLines > SMALL_CHANGE_LINES) return "full";
  if (input.testsPassed) return "skipped";
  return input.auditorPinned ? "full" : "fast";
}

/** A turn's changed lines. A file git counts as zero lines, such as a binary or a rename, is never small. */
export function turnChangedLines(
  files: ReadonlyArray<{ readonly additions: number; readonly deletions: number }>,
): number {
  let lines = 0;
  for (const file of files) {
    if (file.additions + file.deletions === 0) return Number.POSITIVE_INFINITY;
    lines += file.additions + file.deletions;
  }
  return lines;
}

/** Whether the thread's latest finished audit asked for changes. */
export function latestAuditAsksChanges(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>,
): boolean {
  let latestAt = Number.NEGATIVE_INFINITY;
  let asks = false;
  for (const activity of activities) {
    if (activity.kind !== "task.completed") continue;
    const payload = activity.payload as {
      readonly crewRole?: unknown;
      readonly verdict?: unknown;
    } | null;
    const at = Date.parse(activity.createdAt);
    if (payload?.crewRole !== "auditor" || !(at >= latestAt)) continue;
    latestAt = at;
    asks = payload.verdict === "needs-changes";
  }
  return asks;
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const TEST_RUNNER =
  /^(?:(?:npx|bunx)\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:vitest|jest|pytest|mocha)\b|^python3?\s+-m\s+(?:pytest|unittest)\b|^(?:go|cargo|dotnet|swift)\s+test\b|^(?:npm|pnpm|yarn|bun|vp)\s+(?:run\s+)?tests?\b|^node\s+--test\b/i;

/**
 * Whether a shell command runs a test runner whose exit status is the command's own. A pipe, `;`,
 * or `||` can hide a failing run, so such commands never count; `cd … &&` and env prefixes do.
 */
export function isTestCommand(command: string): boolean {
  const trimmed = command.trim();
  const inner = SHELL_WRAPPER.exec(trimmed)?.[2] ?? trimmed;
  if (/[|;]/.test(inner)) return false;
  return inner
    .split("&&")
    .some((segment) => TEST_RUNNER.test(segment.trim().replace(ENV_PREFIX, "")));
}

/** The command a finished shell activity ran: Codex `data.item.command`, OpenCode `data.command`, Claude `data.input.command`. */
function commandOf(payload: Record<string, unknown>): string | null {
  const data = payload["data"] as
    | {
        readonly item?: { readonly command?: unknown };
        readonly command?: unknown;
        readonly input?: { readonly command?: unknown };
      }
    | undefined;
  for (const value of [data?.item?.command, data?.command, data?.input?.command]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Whether the turn's last word on its files is a passing test run: a test command the provider
 * reports as completed (a failing run ends as `failed`), with no file edit after it in the turn.
 */
export function turnRanPassingTests(
  turnId: string,
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: string | null;
    readonly payload: unknown;
  }>,
): boolean {
  let passed = false;
  for (const activity of activities) {
    if (activity.turnId !== turnId || activity.kind !== "tool.completed") continue;
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    if (payload["itemType"] === "file_change") passed = false;
    if (payload["itemType"] !== "command_execution" || payload["status"] !== "completed") continue;
    const command = commandOf(payload);
    if (command !== null && isTestCommand(command)) passed = true;
  }
  return passed;
}

const REPORT_CLIP_MARKER = "\n…[truncated]…\n";

/**
 * Caps a stored report at `limit` characters, keeping its head and its tail. Reports end with the
 * `Status:` and `Verdict:` lines, so cutting only the end would hide them. Judge the status and
 * verdict from the full text; the clipped one is only for storing and handing on.
 */
export function clipCrewReport(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const room = Math.max(limit - REPORT_CLIP_MARKER.length, 0);
  const tail = Math.floor(room / 2);
  return `${text.slice(0, room - tail)}${REPORT_CLIP_MARKER}${tail === 0 ? "" : text.slice(-tail)}`;
}

/** The first lines of a report, kept short enough for an activity summary. */
export function reportExcerpt(text: string, limit = 280): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
}

const ROLE_DUTY: Record<CrewRole, string> = {
  worker: "routine, well-specified work: searches, data gathering, edits, tests",
  expert: "hard implementation, debugging, and deep analysis",
  auditor: "reviews every turn that changes files (runs on its own)",
};

/** Model values Claude Code's built-in Agent tool accepts for a subagent. */
export type ClaudeSubagentModel = "sonnet" | "opus" | "haiku" | "fable";

/** The Agent tool model for a Claude model slug, or null when the tool cannot run that model. */
export function claudeSubagentModel(slug: string): ClaudeSubagentModel | null {
  const lower = slug.toLowerCase();
  for (const model of ["haiku", "sonnet", "opus", "fable"] as const) {
    if (lower.includes(model)) return model;
  }
  return null;
}

export interface CrewBriefRole {
  readonly label: string;
  readonly providerLabel: string;
  /** Set when the brain can run this role in-process with its own Agent tool (the fast path). */
  readonly native?: ClaudeSubagentModel | undefined;
}

/** Sent once when the crew is turned off after its note was already in the conversation. */
export const CREW_OFF_NOTE =
  "<oop_crew>OOP Crew is now off for this chat: ignore the earlier <oop_crew> note, do the work yourself, and do not call the crew tools. Tasks started earlier may still report results; use them if they help.</oop_crew>";

/**
 * The note sent ahead of each lead turn while the crew is on. Without it the brain never looks
 * for the crew tools and does everything itself. Roles on the brain's own provider take the fast
 * path: the brain runs them as in-process subagents instead of separate crew threads.
 */
export function crewBrief(roles: Record<CrewRole, CrewBriefRole | null>): string | null {
  const staffed = (["worker", "expert", "auditor"] as const).filter((role) => roles[role] !== null);
  if (roles.worker === null && roles.expert === null) {
    const auditor = roles.auditor;
    if (auditor === null) return null;
    return [
      "<oop_crew>",
      "OOP Crew is on for this chat, but only the auditor is set: there is no worker or expert to delegate to, so do the work yourself and do not call crew_delegate or the Agent tool for crew work. This note replaces any earlier <oop_crew> note in this chat.",
      `The auditor (${auditor.label}, ${auditor.providerLabel}) reviews on its own every turn that changes files; you do not start it. If it asks for changes, you get a follow-up turn.`,
      "</oop_crew>",
    ].join("\n");
  }
  const fast = (["worker", "expert"] as const).filter((role) => roles[role]?.native !== undefined);
  const delegated = (["worker", "expert"] as const).filter(
    (role) => roles[role] !== null && roles[role]?.native === undefined,
  );
  return [
    "<oop_crew>",
    "OOP Crew is on for this chat. You are the brain: you plan, decide, talk with the user, and write the final answer. This note replaces any earlier <oop_crew> note in this chat: the user can change the crew between messages, so use only the assignments below, including the model you pass to the Agent tool. Your crew uses other models:",
    ...staffed.map((role) => {
      const entry = roles[role];
      const route =
        entry?.native === undefined
          ? role === "auditor"
            ? ""
            : " [crew_delegate]"
          : ` [fast path: your Agent tool with model "${entry.native}"]`;
      return `- ${role}: ${entry?.label} (${entry?.providerLabel})${route} - ${ROLE_DUTY[role]}`;
    }),
    "Rules for this turn:",
    "1. Unless the request is a quick question you can answer in one short reply, split the work into self-contained tasks and hand them to the crew. Start independent tasks in parallel.",
    ...(fast.length > 0
      ? [
          `2. Fast path (${fast.join(", ")}): run the task with your built-in Agent tool, passing the model shown for that role, in the background so several run at once. This is fastest; no separate thread is needed.`,
        ]
      : []),
    ...(delegated.length > 0
      ? [
          `${fast.length > 0 ? "3" : "2"}. Other roles (${delegated.join(", ")}): use the crew_delegate tool of the t3-code MCP server (in Claude Code: mcp__t3-code__crew_delegate; if it is not loaded yet, load it with ToolSearch query "select:mcp__t3-code__crew_delegate,mcp__t3-code__crew_wait"), then collect results with crew_wait, calling it again while tasks run. A failed crew model is replaced automatically by another model of the same level. Give each task that edits files a writeScope, and a verify command when one proves it done; if crew_delegate returns a warning, wait for the overlapping tasks or narrow the scopes. For parallel tasks that edit code, pass isolation "worktree" so they cannot clobber each other.`,
        ]
      : []),
    'Each task: specific one-step todos, a check (command or files) where provable; extra work in a new task; unfinished items make it partial. Give crew_delegate and crew_stop a one-sentence "why".',
    'Arena (only when the user asks to compare approaches, or a choice is hard to undo): write 3-6 criteria; give 2-3 tasks the same brief, isolation "candidate", titles "Candidate A: ...", each later one differentFrom the earlier ids; then one expert judge, also a candidate differentFrom all of them, with the criteria and patch paths (if it warns no other family exists, tell the user the judge was not independent). Pick a base, git apply its patch, graft the best parts, verify, remove the worktrees, and tell the user what you kept and rejected.',
    'Call work done only when crew_wait shows proof VERIFIED. On INCONCLUSIVE, say "finished, not verified" to the user, then check it yourself or add a todo with a check.',
    "The user can change the crew while this turn runs. Before you hand out more tasks later in this turn, call crew_roster (mcp__t3-code__crew_roster; load it with ToolSearch if it is not loaded yet): when it differs from this note, follow crew_roster, and for a Claude role pass the Agent tool the matching model (haiku, sonnet, opus or fable).",
    "Do not use built-in subagents with other models, or Workflow tools, for work the crew can do. Check every report, combine them into your answer, and say which crew member did what.",
    "Name every task (the crew_delegate title, the Agent tool description) with a short English summary of its core work, at most eight words, even when you talk with the user in another language; the OOP Agents board shows it.",
    "A report with status partial or blocked is not finished: do the rest yourself or hand a follow-up task to the crew.",
    "Fast-path agents get no OOP fallback or cooling. If one fails, hand that task to crew_delegate. Only when crew_delegate fails or crew_wait reports that every crew model failed, do the task yourself and say so.",
    "</oop_crew>",
  ].join("\n");
}

/** What the brain reads when every model in a task's fallback chain failed. */
export function crewExhaustedReport(
  role: CrewRole,
  attempts: ReadonlyArray<{ readonly model: string; readonly error?: string | undefined }>,
): string {
  return [
    `Every crew model for this ${CREW_ROLE_LABEL[role].toLowerCase()} task failed, so do this task yourself.`,
    ...attempts.map((attempt) => `- ${attempt.model}: ${attempt.error ?? "failed"}`),
  ].join("\n");
}

const EvidenceLevel = Schema.Literals(["said", "line", "traced", "ran", "app"]);

const Finding = Schema.Struct({
  severity: Schema.Literals(["P0", "P1", "P2", "P3"]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  title: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
  proven: Schema.optional(Schema.Boolean),
  level: Schema.optional(EvidenceLevel),
  evidence: Schema.optional(Schema.String),
});

// Only the verdict or status and the summary are required: a crew model that drops an optional
// list still reports, and one that gets the shape wrong falls back to the text lines.
const emptyList = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).pipe(Schema.withDecodingDefault(Effect.succeed([])));

/** The JSON block a worker or expert ends its reply with. */
export const CrewMemberReport = Schema.Struct({
  status: Schema.Literals(["done", "partial", "blocked"]),
  summary: Schema.String,
  changedFiles: emptyList(Schema.String),
  verification: Schema.NullOr(
    Schema.Struct({ command: Schema.String, passed: Schema.NullOr(Schema.Boolean) }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  findings: emptyList(Finding),
});
export type CrewMemberReport = typeof CrewMemberReport.Type;

/** The JSON block the auditor ends its reply with. */
export const CrewAuditReport = Schema.Struct({
  verdict: Schema.Literals(["approve", "needs changes"]),
  summary: Schema.String,
  safetyFact: Schema.optional(
    Schema.Struct({ fact: Schema.String, level: EvidenceLevel, evidence: Schema.String }),
  ),
  findings: emptyList(Finding),
  preExistingFailures: emptyList(Schema.String),
});
export type CrewAuditReport = typeof CrewAuditReport.Type;

/** The most findings a parsed report keeps; the most severe come first. */
export const CREW_REPORT_MAX_FINDINGS = 20;

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

/** Longest `evidence` a parsed finding keeps. */
export const CREW_EVIDENCE_MAX_CHARS = 300;

type FindingProof = Pick<typeof Finding.Type, "proven" | "level" | "evidence">;

/**
 * A finding counts as proven only when the model says so and backs it: a level that walked the
 * failure (traced, ran, app) and some evidence. Pointing at a line is not proof.
 */
const isProvenFinding = (finding: FindingProof) =>
  finding.proven === true &&
  (finding.level === "traced" || finding.level === "ran" || finding.level === "app") &&
  (finding.evidence?.trim() ?? "") !== "";

const withCheckedProof = <T extends typeof Finding.Type>(finding: T): T => ({
  ...finding,
  ...(finding.proven === undefined ? {} : { proven: isProvenFinding(finding) }),
  ...(finding.evidence === undefined
    ? {}
    : { evidence: clipText(finding.evidence.trim(), CREW_EVIDENCE_MAX_CHARS) }),
});

const clipText = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const capFindings = <T extends typeof Finding.Type>(findings: ReadonlyArray<T>) =>
  findings
    .map(withCheckedProof)
    .toSorted(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        Number(b.proven === true) - Number(a.proven === true),
    )
    .slice(0, CREW_REPORT_MAX_FINDINGS);

const FENCED_JSON = /`{3,}json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}/gi;

/** The reply's prose: the text lines are the fallback for a json block, so its keys must not read as them. */
const withoutJsonBlocks = (text: string | null) => (text ?? "").replace(FENCED_JSON, "");

/** Decodes the last fenced json block of a reply; any other reply, or a block of another shape, gives null. */
function parseLastJsonBlock<S extends Schema.Decoder<unknown>>(
  schema: S,
  text: string | null,
): S["Type"] | null {
  const block = [...(text ?? "").matchAll(FENCED_JSON)].at(-1)?.[1];
  return block === undefined
    ? null
    : Option.getOrNull(Schema.decodeOption(Schema.fromJsonString(schema))(block));
}

/** A crew member's structured report from the end of its reply, or null when it has none that decodes. */
export function parseCrewReport(text: string | null): CrewMemberReport | null {
  const report = parseLastJsonBlock(CrewMemberReport, text);
  return report === null ? null : { ...report, findings: capFindings(report.findings) };
}

/** The auditor's structured review from the end of its reply, or null when it has none that decodes. */
export function parseAuditReport(text: string | null): CrewAuditReport | null {
  const report = parseLastJsonBlock(CrewAuditReport, text);
  return report === null ? null : { ...report, findings: capFindings(report.findings) };
}

/**
 * The auditor's verdict: from its JSON review when it has one, else its last `Verdict:` line, or
 * null when the report has neither. Only a proven P0 or P1 finding blocks; a review that asks for
 * changes with no findings at all still blocks (a model that dropped the list is respected), and
 * one that asks for changes only because of failures that predate the turn approves.
 */
export function auditVerdict(report: string | null): "approve" | "needs-changes" | null {
  const audit = parseAuditReport(report);
  if (audit !== null) {
    const isHigh = (finding: (typeof audit.findings)[number]) =>
      finding.severity === "P0" || finding.severity === "P1";
    if (audit.findings.some((finding) => isHigh(finding) && isProvenFinding(finding)))
      return "needs-changes";
    const onlyPreExisting = audit.preExistingFailures.length > 0 && !audit.findings.some(isHigh);
    return audit.verdict === "approve" || onlyPreExisting || audit.findings.length > 0
      ? "approve"
      : "needs-changes";
  }
  const verdicts = [
    ...withoutJsonBlocks(report).matchAll(/verdict\W{0,4}\s*(approve|needs changes)/gi),
  ];
  const last = verdicts.at(-1)?.[1]?.toLowerCase();
  return last === undefined ? null : last === "approve" ? "approve" : "needs-changes";
}

/** Audit fixes the crew asks for after one user message, and follow-up turns of any kind. */
export const CREW_MAX_FIX_ROUNDS = 2;
export const CREW_MAX_FOLLOW_UPS = 4;

const FOLLOW_UP_MARKER = /<oop_crew_follow_up round="(\d+)" fixes="(\d+)">/;

/** A lead message OOP sent as a crew follow-up rather than one the user wrote. */
export function isCrewFollowUp(text: string): boolean {
  return FOLLOW_UP_MARKER.test(text);
}

/**
 * How far a lead is into crew follow-ups, read from the marker on its latest user message. The
 * count lives in the conversation, so it survives a server restart and resets with a real user
 * message.
 */
export function followUpRound(latestUserMessage: string | null): {
  readonly round: number;
  readonly fixes: number;
} {
  const match = FOLLOW_UP_MARKER.exec(latestUserMessage ?? "");
  return match === null
    ? { round: 0, fixes: 0 }
    : { round: Number(match[1]), fixes: Number(match[2]) };
}

export interface CrewFollowUpResult {
  readonly role: CrewRole;
  readonly subject: string;
  readonly status: string;
  readonly report: string | null;
  /** The verdict OOP reached on the work (VERIFIED, NOT VERIFIED, INCONCLUSIVE). */
  readonly proof?: string | undefined;
}

/**
 * The follow-up lead turn for what the crew finished after the lead answered: an audit that asked
 * for changes, and reports the lead never collected. Returns null when nothing is left to send
 * within the round limits; `dropped` says whether anything was held back by them.
 */
export function planFollowUp(input: {
  readonly current: { readonly round: number; readonly fixes: number };
  readonly audits: ReadonlyArray<string>;
  readonly results: ReadonlyArray<CrewFollowUpResult>;
  /**
   * The crew was turned off after these tasks started: results are handed on as plain information
   * and audit fix requests are dropped, since the audit loop is crew work the user switched off.
   */
  readonly crewOff?: boolean;
}): { readonly prompt: string | null; readonly dropped: boolean } {
  const withinFollowUps = input.current.round < CREW_MAX_FOLLOW_UPS;
  const audits =
    input.crewOff !== true && withinFollowUps && input.current.fixes < CREW_MAX_FIX_ROUNDS
      ? input.audits
      : [];
  const results = withinFollowUps ? input.results : [];
  const dropped =
    (input.crewOff !== true && audits.length < input.audits.length) ||
    results.length < input.results.length;
  if (audits.length === 0 && results.length === 0) return { prompt: null, dropped };
  const round = input.current.round + 1;
  const fixes = input.current.fixes + (audits.length > 0 ? 1 : 0);
  return {
    dropped,
    prompt: [
      `<oop_crew_follow_up round="${round}" fixes="${fixes}">`,
      "OOP Crew sent this follow-up; it is not a new request from the user.",
      ...(audits.length > 0
        ? [
            "The auditor reviewed your last turn and asked for changes. Fix the blocking problems it found (or explain why a point is wrong), verify the fix, then give the user an updated answer. Findings marked unproven are leads, not defects; verify one only when it is cheap.",
            ...audits.map((report) => `Auditor report:\n${report.trim()}`),
          ]
        : []),
      ...(results.length > 0
        ? [
            input.crewOff === true
              ? "OOP Crew is off: use these results if they help; do not start new crew tasks. These tasks finished after your last answer, so you have not read their reports."
              : "These crew tasks finished after your last answer, so you have not read their reports. Check them, build on what they did, and update your answer to the user.",
            ...results.map(
              (result) =>
                `- ${CREW_ROLE_LABEL[result.role]} · ${result.subject} (${result.status}${result.proof === undefined ? "" : `, proof ${result.proof}`}): ${result.report?.trim() || "no report"}`,
            ),
          ]
        : []),
      "</oop_crew_follow_up>",
    ].join("\n"),
  };
}

/**
 * How a crew member says its task ended: the status of its JSON report, else the last `Status:`
 * line; a report with neither counts as done.
 */
export function crewReportStatus(report: string | null): "done" | "partial" | "blocked" {
  const structured = parseCrewReport(report);
  if (structured !== null) return structured.status;
  const last = [...withoutJsonBlocks(report).matchAll(/status\W{0,4}\s*(done|partial|blocked)\b/gi)]
    .at(-1)?.[1]
    ?.toLowerCase();
  return last === "partial" || last === "blocked" ? last : "done";
}

/**
 * What a finished crew thread amounts to as a task: its outcome for the lead and, for a worker or
 * expert whose reply ended in a valid JSON block, that report. Judge from the full reply, not the
 * clipped one that is stored.
 */
export function crewMemberOutcome(
  role: CrewRole,
  status: CrewTaskStatus,
  reply: string | null,
  todos?: { readonly pending: number; readonly failed: number; readonly blocked: number },
): { readonly status: CrewTaskOutcome; readonly report: CrewMemberReport | null } {
  if (status !== "completed" || role === "auditor") return { status, report: null };
  const reported = crewReportStatus(reply);
  return {
    status: reported !== "done" ? reported : withTodoOutcome(status, todos),
    report: parseCrewReport(reply),
  };
}

/**
 * A task that says it is done while TODO items are still pending, failing, or blocked has only
 * finished part of the work. Claimed items do not hold it back; they were never checkable.
 */
export function withTodoOutcome(
  status: CrewTaskOutcome,
  todos:
    | { readonly pending: number; readonly failed: number; readonly blocked: number }
    | undefined,
): CrewTaskOutcome {
  const unfinished = todos !== undefined && todos.pending + todos.failed + todos.blocked > 0;
  return status === "completed" && unfinished ? "partial" : status;
}

/**
 * How a provider failure reads, and what the crew should do about it:
 * - `billing` and `auth` last until someone fixes the provider (an empty balance, a signed-out CLI).
 * - `limit` is a usage or rate limit the next attempt after the reset may clear.
 * - `model` is the provider refusing that one model, so nothing is wrong with the provider itself.
 * - `other` is a crash or a timeout that the next attempt may not hit.
 */
export function crewFailureKind(
  error: string | null | undefined,
): "billing" | "auth" | "limit" | "model" | "other" {
  const text = error ?? "";
  if (
    /insufficient (balance|credit|funds|quota)|recharge|out of credits|payment required|billing|resource package/i.test(
      text,
    )
  )
    return "billing";
  if (
    /unauthori[sz]ed|not (logged|signed) in|sign in again|log in again|authentication (required|failed)|invalid api key|\b401\b/i.test(
      text,
    )
  )
    return "auth";
  if (
    /usage[ _-]?limit|rate[ _-]?limit|(?:5[ -]?hours?|five[ -]?hours?|weekly|session|daily|monthly) limit (?:reached|exceeded)|limit will reset|quota (exceeded|reached)|too many requests|(?:hit|reached) your (?:\w+ )?limit|(?:status|code|http|error)[ :=]*429\b/i.test(
      text,
    )
  )
    return "limit";
  if (
    /could not switch to model|unknown model|invalid model|no such model|(?:not|n't) have access to (?:the )?model|\bmodel(?! context)(?:[:\s]+[`'"]?[\w.:/@-]+[`'"]?)?\s+(?:is |was |does |do )?(?:not found|not available|not supported|not exist|n't exist)/i.test(
      text,
    )
  )
    return "model";
  return "other";
}

/**
 * The usage window an error names, when it names one: the five-hour session window, or the
 * weekly one. The reset time printed beside it is not interpreted (providers leave the time
 * zone off); how long to cool comes from the provider's own window snapshot instead.
 */
export function crewLimitWindowName(error: string | null | undefined): "5-hour" | "weekly" | null {
  const text = error ?? "";
  if (/5[ -]?hours?\b|five hours?\b/i.test(text)) return "5-hour";
  if (/\bweek(?:ly)?\b|7[ -]?days?\b|seven days?\b/i.test(text)) return "weekly";
  return null;
}

/**
 * What the reactor reports when the user's own stop cut a message off before it started. Any
 * other refusal is a failure of the send, not a stop.
 */
export const PROVIDER_STOPPED_START_DETAIL = {
  beforeSend: "Stopped before this message was sent.",
  duringSend: "Stopped while sending. The provider may have received this message.",
  beforeCompaction: "Stopped before context compaction started.",
  duringCompaction: "Stopped during context compaction. The provider may still finish it.",
} as const;
