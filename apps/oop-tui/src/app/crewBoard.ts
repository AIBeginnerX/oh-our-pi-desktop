import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  crewTaskActions,
  type CrewEvidence,
  type CrewTaskActions,
} from "@t3tools/client-runtime/crew-board";
import { crewGraphs, settleWithTurn } from "@t3tools/client-runtime/thread-flow";
import type { WorkflowNode } from "@t3tools/client-runtime/workflow-graph";
import { isCrewThreadTitle } from "@t3tools/shared/crew";
import { CREW_AUDIT_SKIPPED_ACTIVITY } from "@t3tools/shared/threadGoal";

import { t } from "../i18n/index.ts";
import { auditSkippedText, followUpText } from "../render/crewBoard.ts";
import { asRecord, firstLine } from "../render/toolLine.ts";

/** How a crew task stands. `stopped` also covers a task whose turn ended without any report. */
export type CrewTaskPhase = "running" | "completed" | "partial" | "blocked" | "failed" | "stopped";

export interface CrewTask {
  readonly taskId: string;
  /** `worker`, `expert` or `auditor`. */
  readonly role: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly phase: CrewTaskPhase;
  /** The task has no final report: its turn ended while it was still marked as running. */
  readonly unreported: boolean;
  /** The task's own thread (its latest attempt), which Open and Stop act on. */
  readonly threadId: ThreadId | null;
  readonly summary: string | null;
  /** Epoch milliseconds; null when the activity carried no usable time. */
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly tokens: number | null;
  /** Only when the provider reported a cost. */
  readonly costUsd: number | null;
  readonly evidence: CrewEvidence | null;
  readonly actions: CrewTaskActions;
}

/** Something the crew did about a turn that is not a task: an audit it left out, a follow-up it sent. */
export interface CrewNote {
  readonly kind: "audit-skipped" | "follow-up";
  readonly text: string;
}

export interface CrewBoard {
  readonly turnId: string;
  /** The board is the lead's running or newest turn, not an earlier one. */
  readonly current: boolean;
  readonly tasks: ReadonlyArray<CrewTask>;
  readonly notes: ReadonlyArray<CrewNote>;
  readonly running: number;
  /** Tasks that are no longer running, whatever they ended as. */
  readonly settled: number;
  readonly usage: { readonly tokens: number; readonly costUsd: number | null } | null;
}

const timeOf = (iso: string | undefined): number | null => {
  const value = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

const PHASES: ReadonlyMap<string, CrewTaskPhase> = new Map([
  ["completed", "completed"],
  ["partial", "partial"],
  ["blocked", "blocked"],
  ["failed", "failed"],
]);

const taskOf = (node: WorkflowNode): CrewTask | null => {
  const crew = node.info.crew;
  if (crew === undefined) return null;
  const outcome = crew.outcome;
  const settledWithoutReport = outcome === undefined && node.state !== "running";
  const phase: CrewTaskPhase =
    outcome === undefined
      ? node.state === "running"
        ? "running"
        : "stopped"
      : (PHASES.get(outcome) ?? "stopped");
  const title = firstLine(node.info.actor?.task);
  const model = firstLine(node.info.model);
  const summary = firstLine(node.info.progress);
  return {
    taskId: crew.taskId,
    role: crew.role,
    title: title === "" ? null : title,
    model: model === "" ? null : model,
    phase,
    unreported: settledWithoutReport,
    threadId: (crew.threadId ?? null) as ThreadId | null,
    summary: summary === "" ? null : summary,
    startedAt: timeOf(node.info.startedAt),
    completedAt: timeOf(node.info.completedAt),
    tokens: node.info.tokens ?? null,
    costUsd: node.info.costUsd ?? null,
    evidence: node.info.evidence ?? null,
    actions: crewTaskActions(crew),
  };
};

const notesOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string,
): CrewNote[] => {
  const notes: CrewNote[] = [];
  for (const activity of activities) {
    if (activity.turnId !== turnId) continue;
    const payload = asRecord(activity.payload);
    if (activity.kind === CREW_AUDIT_SKIPPED_ACTIVITY) {
      notes.push({ kind: "audit-skipped", text: auditSkippedText(payload.changedFiles) });
    } else if (activity.kind === "crew.follow-up") {
      notes.push({ kind: "follow-up", text: followUpText(payload.reason) });
    }
  }
  return notes;
};

/**
 * The crew board of the lead's newest turn that used the crew, read from the lead thread's own
 * activities as the desktop app's board reads them. `running` says the lead's turn is still going:
 * once it ends, a task that never reported reads as stopped rather than as busy. Null when the
 * thread has never handed anything to the crew.
 */
export const deriveCrewBoard = (
  thread: OrchestrationThread,
  running: boolean,
): CrewBoard | null => {
  const latestTurn = thread.latestTurn;
  const activeTurnId = running
    ? (thread.session?.activeTurnId ?? (latestTurn?.state === "running" ? latestTurn.turnId : null))
    : null;
  const graphs = crewGraphs(thread.activities).toSorted((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  const newest = graphs[0];
  if (newest === undefined || newest.turnId === undefined) return null;
  const graph = settleWithTurn(newest, activeTurnId);
  const tasks = graph.nodes
    .flatMap((node) => {
      const task = taskOf(node);
      return task === null ? [] : [task];
    })
    .toSorted((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const brain = graph.nodes.find((node) => node.id.startsWith("brain:"));
  const tokens = brain?.info.tokens;
  const notes = notesOf(thread.activities, newest.turnId);
  return {
    turnId: newest.turnId,
    current: newest.turnId === (activeTurnId ?? latestTurn?.turnId ?? null),
    tasks,
    notes,
    running: tasks.filter((task) => task.phase === "running").length,
    settled: tasks.filter((task) => task.phase !== "running").length,
    usage: tokens === undefined ? null : { tokens, costUsd: brain?.info.costUsd ?? null },
  };
};

// ---- the threads the crew started -------------------------------------------------------------

/** Whether the thread is a crew task's own: linked to its lead, or named like one. */
export const isCrewSubThread = (thread: {
  readonly title: string;
  readonly parentThreadId?: string | null | undefined;
}): boolean => thread.parentThreadId != null || isCrewThreadTitle(thread.title);

/** `Worker · subject`: the thread's title without the `Crew ` that every crew thread begins with. */
export const crewSubThreadLabel = (title: string): string =>
  isCrewThreadTitle(title) ? title.slice("Crew ".length) : title;

export interface WaitingCrewThread {
  readonly thread: OrchestrationThreadShell;
  readonly kind: "approval" | "input";
}

/**
 * The crew threads of `lead` that wait for the user. Threads saved before crew threads were linked
 * to their lead have no parent; those in the lead's project count too, since nothing else would
 * show their request.
 */
export const waitingCrewThreads = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  lead: { readonly id: string; readonly projectId: string },
): ReadonlyArray<WaitingCrewThread> =>
  threads.flatMap((thread): WaitingCrewThread[] => {
    if (thread.archivedAt !== null || !isCrewSubThread(thread)) return [];
    if (thread.hasPendingApprovals === false && thread.hasPendingUserInput === false) return [];
    const linked =
      thread.parentThreadId == null
        ? thread.projectId === lead.projectId
        : thread.parentThreadId === lead.id;
    if (!linked) return [];
    return [{ thread, kind: thread.hasPendingApprovals ? "approval" : "input" }];
  });

/** `Crew work is waiting for approval — /crew`, with a count when several wait. */
export const waitingText = (waiting: ReadonlyArray<WaitingCrewThread>): string | null => {
  if (waiting.length === 0) return null;
  const approvals = waiting.filter((entry) => entry.kind === "approval").length;
  return waiting.length === 1
    ? t(approvals > 0 ? "providers.crew.waitOneApproval" : "providers.crew.waitOneInput")
    : t(
        approvals === waiting.length
          ? "providers.crew.waitManyApproval"
          : "providers.crew.waitManyMixed",
        { count: waiting.length },
      );
};

export interface ListedThreads {
  /** In list order: crew threads that wait for the user first, then the rest, newest first. */
  readonly rows: ReadonlyArray<OrchestrationThreadShell>;
  /** Crew threads that are folded under each thread that started them. */
  readonly folded: ReadonlyMap<string, number>;
  /** Crew threads that wait for the user: shown among the rows, whoever started them. */
  readonly waiting: ReadonlySet<string>;
}

/**
 * The threads `/threads` lists for a project, as the desktop app's sidebar groups them: a crew
 * thread leaves the list and is counted under the thread that started it, unless it waits for an
 * approval or an answer, which is never hidden. Crew threads whose lead is gone are left out.
 */
export const listedThreads = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projectId: string,
): ListedThreads => {
  const ofProject = threads
    .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
    .toSorted((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
    );
  const listed = new Set(ofProject.map((thread) => thread.id as string));
  const rows: OrchestrationThreadShell[] = [];
  const waiting: OrchestrationThreadShell[] = [];
  const folded = new Map<string, number>();
  for (const thread of ofProject) {
    if (!isCrewSubThread(thread)) {
      rows.push(thread);
    } else if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      waiting.push(thread);
    } else if (thread.parentThreadId != null && listed.has(thread.parentThreadId)) {
      folded.set(thread.parentThreadId, (folded.get(thread.parentThreadId) ?? 0) + 1);
    }
  }
  return {
    rows: [...waiting, ...rows],
    folded,
    waiting: new Set(waiting.map((thread) => thread.id as string)),
  };
};
