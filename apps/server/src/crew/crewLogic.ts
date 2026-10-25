/**
 * Pure rules for OOP Crew: how a delegated or audit thread is named and prompted, how its
 * progress reads from a thread shell, and which finished turns earn an audit.
 */
import type { CrewRole, OrchestrationThreadShell } from "@t3tools/contracts";

// Clients nest crew threads by this title too, so its rules live in the shared package.
import { CREW_ROLE_LABEL, isCrewThreadTitle } from "@t3tools/shared/crew";

export { CREW_ROLE_LABEL, isCrewThreadTitle };

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

export function delegatePrompt(input: {
  readonly role: CrewRole;
  readonly leadTitle: string;
  readonly task: string;
}): string {
  return [
    `You are the ${CREW_ROLE_LABEL[input.role].toLowerCase()} on an OOP crew. The lead agent of the thread "${input.leadTitle}" handed you this task.`,
    "Work in the current workspace. Do only this task; the lead owns the plan and the conversation with the user.",
    "When you finish, reply with a short report: what you did, which files you changed, and anything left undone or uncertain.",
    "End the report with one line: `Status: done`, `Status: partial` when part of the task is left, or `Status: blocked` when you could not do it.",
    "",
    "Task:",
    input.task.trim(),
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
}): string {
  const listed = input.files.slice(0, 40);
  const more = input.files.length - listed.length;
  const request = input.request?.trim();
  const diff = input.diff ?? null;
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
    "Reply with: blocking problems, risky or unclear changes, missing tests, then one verdict line: `Verdict: needs changes` only when a blocking problem remains, otherwise `Verdict: approve`.",
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

/** The first lines of a report, kept short enough for an activity summary. */
export function reportExcerpt(text: string, limit = 280): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
}

/** Brains that receive the t3-code MCP server, so they can call the crew tools. */
export const CREW_BRAIN_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);

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

/**
 * The note sent ahead of each lead turn while the crew is on. Without it the brain never looks
 * for the crew tools and does everything itself. Roles on the brain's own provider take the fast
 * path: the brain runs them as in-process subagents instead of separate crew threads.
 */
export function crewBrief(roles: Record<CrewRole, CrewBriefRole | null>): string | null {
  const staffed = (["worker", "expert", "auditor"] as const).filter((role) => roles[role] !== null);
  if (roles.worker === null && roles.expert === null) return null;
  const fast = (["worker", "expert"] as const).filter((role) => roles[role]?.native !== undefined);
  const delegated = (["worker", "expert"] as const).filter(
    (role) => roles[role] !== null && roles[role]?.native === undefined,
  );
  return [
    "<oop_crew>",
    "OOP Crew is on for this chat. You are the brain: you plan, decide, talk with the user, and write the final answer. Your crew uses other models:",
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
          `${fast.length > 0 ? "3" : "2"}. Other roles (${delegated.join(", ")}): use the crew_delegate tool of the t3-code MCP server (in Claude Code: mcp__t3-code__crew_delegate; if it is not loaded yet, load it with ToolSearch query "select:mcp__t3-code__crew_delegate,mcp__t3-code__crew_wait"), then collect results with crew_wait, calling it again while tasks run. A failed crew model is replaced automatically by another model of the same level.`,
        ]
      : []),
    "Do not use built-in subagents with other models, or Workflow tools, for work the crew can do. Check every report, combine them into your answer, and say which crew member did what.",
    "Name every task (the crew_delegate title, the Agent tool description) with a short English summary of its core work, at most eight words, even when you talk with the user in another language; the OOP Agents board shows it.",
    "A report with status partial or blocked is not finished: do the rest yourself or hand a follow-up task to the crew.",
    "If a fast-path agent fails, hand that task to crew_delegate. Only when crew_delegate fails or crew_wait reports that every crew model failed, do the task yourself and say so.",
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

/** The auditor's verdict: its last `Verdict:` line, or null when the report has none. */
export function auditVerdict(report: string | null): "approve" | "needs-changes" | null {
  const verdicts = [...(report ?? "").matchAll(/verdict\W{0,4}\s*(approve|needs changes)/gi)];
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
}): { readonly prompt: string | null; readonly dropped: boolean } {
  const withinFollowUps = input.current.round < CREW_MAX_FOLLOW_UPS;
  const audits = withinFollowUps && input.current.fixes < CREW_MAX_FIX_ROUNDS ? input.audits : [];
  const results = withinFollowUps ? input.results : [];
  const dropped = audits.length < input.audits.length || results.length < input.results.length;
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
            "The auditor reviewed your last turn and asked for changes. Fix the blocking problems it found (or explain why a point is wrong), verify the fix, then give the user an updated answer.",
            ...audits.map((report) => `Auditor report:\n${report.trim()}`),
          ]
        : []),
      ...(results.length > 0
        ? [
            "These crew tasks finished after your last answer, so you have not read their reports. Check them, build on what they did, and update your answer to the user.",
            ...results.map(
              (result) =>
                `- ${CREW_ROLE_LABEL[result.role]} · ${result.subject} (${result.status}): ${result.report?.trim() || "no report"}`,
            ),
          ]
        : []),
      "</oop_crew_follow_up>",
    ].join("\n"),
  };
}

/** The status line a crew member ends its report with; a report without one counts as done. */
export function crewReportStatus(report: string | null): "done" | "partial" | "blocked" {
  const last = [...(report ?? "").matchAll(/status\W{0,4}\s*(done|partial|blocked)\b/gi)]
    .at(-1)?.[1]
    ?.toLowerCase();
  return last === "partial" || last === "blocked" ? last : "done";
}

/**
 * Failures that repeat until someone fixes the provider (an empty balance, a signed-out CLI), as
 * opposed to a crash or a timeout that the next attempt may not hit.
 */
export function crewFailureKind(error: string | null | undefined): "billing" | "auth" | "other" {
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
  return "other";
}
