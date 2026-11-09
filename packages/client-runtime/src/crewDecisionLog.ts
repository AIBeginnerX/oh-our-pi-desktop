/**
 * The crew decision log: who the lead handed what to, why, on what evidence, and how it came out.
 * Pure and derived from the lead thread's activities, so nothing is stored or kept in step; a
 * client computes it when the user asks. The activities hold decision points, not every action:
 * a task's checklist progress is overwritten in place and has no row.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface CrewDecisionRow {
  /** The activity the row comes from; a key for lists, not a column. */
  readonly id: string;
  /** ISO time of the activity the row comes from. */
  readonly ts: string;
  readonly phase: string;
  readonly decision: string;
  /** The lead's reason when it gave one; empty from an older server or a user's own stop. */
  readonly why: string;
  /** Pointers only: task and thread ids, checklist counts. */
  readonly evidence: string;
  readonly result: string;
}

export const CREW_DECISION_COLUMNS = [
  "ts",
  "phase",
  "decision",
  "why",
  "evidence",
  "result",
] as const satisfies ReadonlyArray<keyof CrewDecisionRow>;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const payloadOf = (activity: OrchestrationThreadActivity): Readonly<Record<string, unknown>> =>
  typeof activity.payload === "object" &&
  activity.payload !== null &&
  !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : {};

const join = (parts: ReadonlyArray<string>) => parts.filter((part) => part !== "").join(" ");

const OUTCOME_WORD: Readonly<Record<string, string>> = {
  completed: "finished",
  partial: "finished part",
  blocked: "blocked",
  failed: "failed",
  stopped: "stopped",
  interrupted: "stopped",
};

const PROOF_WORD: Readonly<Record<string, string>> = {
  verified: "VERIFIED",
  "not-verified": "NOT VERIFIED",
  inconclusive: "INCONCLUSIVE",
};

function rowOf(activity: OrchestrationThreadActivity): CrewDecisionRow | undefined {
  const payload = payloadOf(activity);
  const ts = activity.createdAt;
  const id = activity.id;
  const taskId = str(payload.taskId);
  const crewRole = str(payload.crewRole);
  // Provider-native tasks (the plan's own steps, Agent subagents) emit the same task kinds
  // without a role; they are not the crew's decisions.
  if (activity.kind.startsWith("task.") && crewRole === "") return undefined;
  const role = crewRole || "worker";
  const title = str(payload.title);
  switch (activity.kind) {
    case "task.started":
      return {
        id,
        ts,
        phase: `delegate:${role}`,
        decision: `handed to ${str(payload.model) || role}${title === "" ? "" : `: ${title}`}`,
        why: str(payload.why),
        evidence: join([
          `task:${taskId}`,
          str(payload.threadId) && `thread:${str(payload.threadId)}`,
        ]),
        result: "running",
      };
    case "task.progress":
      // Only a model switch is a decision; the checklist's progress row is not.
      if (!activity.summary.includes(" switched to ")) return undefined;
      return {
        id,
        ts,
        phase: "fallback",
        decision: `switched to ${str(payload.model) || "another model"}`,
        why: str(payload.summary),
        evidence: `task:${taskId}`,
        result: "retrying",
      };
    case "task.completed": {
      if (role === "auditor") {
        const verdict = str(payload.verdict) || str(payload.status) || "unknown";
        return {
          id,
          ts,
          phase: "audit",
          decision: `auditor ${verdict}`,
          why: "",
          evidence: `task:${taskId}`,
          result: verdict,
        };
      }
      const status = str(payload.status);
      const total = count(payload.todoTotal);
      return {
        id,
        ts,
        phase: `result:${role}`,
        decision: `${role} ${OUTCOME_WORD[status] ?? (status || "ended")}`,
        why: "",
        evidence: join([
          `task:${taskId}`,
          total === undefined || total === 0
            ? ""
            : `todos ${count(payload.todoVerified) ?? 0}/${total}`,
        ]),
        // A missing verdict is an older server, which never proved anything.
        result: PROOF_WORD[str(payload.proof)] ?? "UNKNOWN",
      };
    }
    case "crew.follow-up":
      return {
        id,
        ts,
        phase: "follow-up",
        decision: "lead got a follow-up turn",
        why: str(payload.reason),
        evidence: "",
        result: "queued",
      };
    case "crew.results-dropped": {
      const ids = Array.isArray(payload.tasks)
        ? payload.tasks
            .map((task) =>
              typeof task === "object" && task !== null
                ? str((task as Record<string, unknown>).taskId)
                : "",
            )
            .filter(Boolean)
        : [];
      const n = ids.length;
      return {
        id,
        ts,
        phase: "follow-up",
        decision: `${n} unfinished ${n === 1 ? "result" : "results"} dropped (follow-up limit)`,
        why: "",
        evidence: n === 0 ? "" : `tasks:${ids.join(",")}`,
        result: "dropped",
      };
    }
    case "crew.stopped":
    case "crew.stopping": {
      const ids = Array.isArray(payload.taskIds) ? payload.taskIds.map(str).filter(Boolean) : [];
      const stopping = activity.kind === "crew.stopping";
      return {
        id,
        ts,
        phase: "stop",
        decision: `${stopping ? "stopping" : "stopped"} ${ids.length} ${ids.length === 1 ? "task" : "tasks"}`,
        // A stop the user asked for carries only the server's `reason`.
        why: str(payload.why) || str(payload.reason),
        evidence: ids.length === 0 ? "" : `tasks:${ids.join(",")}`,
        result: stopping ? "stopping" : "stopped",
      };
    }
    default:
      return undefined;
  }
}

/**
 * The decision rows of the lead thread's crew activities, oldest first. Activities of other kinds
 * are ignored, as are task activities without a crew role: the provider's own plan steps and Agent
 * subagents emit the same kinds and are not the crew's decisions. `crew.stopped` and
 * `crew.stopping` always count, because a stop is the lead's. A thread's activities may be cut to
 * its newest ones, so the first row's `ts` is where the log really begins.
 */
export function buildCrewDecisionLog(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CrewDecisionRow[] {
  return activities
    .map((activity, index) => ({ row: rowOf(activity), activity, index }))
    .filter((entry) => entry.row !== undefined)
    .sort(
      (a, b) =>
        a.activity.createdAt.localeCompare(b.activity.createdAt) ||
        (a.activity.sequence ?? 0) - (b.activity.sequence ?? 0) ||
        a.index - b.index,
    )
    .flatMap((entry) => (entry.row === undefined ? [] : [entry.row]));
}

const CELL_LIMIT = 500;

/**
 * One TSV cell on one line. Tabs and line breaks become spaces, and a cell that a spreadsheet
 * would read as a formula (`=`, `+`, `-`, `@`) gets a leading `'`.
 */
export function crewDecisionCell(value: string): string {
  const flat = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, CELL_LIMIT);
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

/** The log as TSV: a header line, then a line per row. */
export function crewDecisionLogTsv(rows: ReadonlyArray<CrewDecisionRow>): string {
  return [
    CREW_DECISION_COLUMNS.join("\t"),
    ...rows.map((row) => CREW_DECISION_COLUMNS.map((key) => crewDecisionCell(row[key])).join("\t")),
  ].join("\n");
}
