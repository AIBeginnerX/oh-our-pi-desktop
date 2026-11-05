/**
 * CrewService - runs OOP Crew for a thread.
 *
 * The thread's own model is the brain. It hands a task to the worker or expert model through the
 * crew MCP tools; each task runs as its own thread in the same workspace, and its start and finish
 * are appended to the lead thread as task activities so the Agents panel and the workflow board
 * draw them live. When a lead turn changes files, the auditor model reviews it the same way.
 *
 * @module CrewService
 */
import {
  MessageId,
  ThreadId,
  CREW_WHY_MAX_LENGTH,
  type CrewRole,
  type ModelSelection,
  type TurnId,
} from "@t3tools/contracts";
import { modelFamily } from "@t3tools/shared/crew";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectMemorySendGate from "../memory/ProjectMemorySendGate.ts";
import { CrewFollowUpRecoveryJson, CrewTaskRecoveryJson } from "./crewRecoveryState.ts";
import {
  proofNote,
  todoProgressFields,
  todoReportNote,
  type OutOfScope,
  type TaskProof,
  type TodoItem,
} from "./crewTodos.ts";
import { type CrewWorktree } from "./crewWorktree.ts";
import {
  PROVIDER_STOPPED_START_DETAIL,
  type CrewMemoryRef,
  type CrewTaskOutcome,
} from "./crewLogic.ts";

import type { CrewTaskReport } from "./CrewService.ts";

export const MAX_WAIT_SECONDS = 50;
export const RESULT_TEXT_LIMIT = 6_000;
export const NUDGE_IDLE_WAIT_SECONDS = 30;

export const CREW_LEAD_REFUSAL =
  "OOP Crew can only be led from a Claude or Codex model, and this chat runs on another provider. Do the work yourself and do not call the crew tools.";
export const ISOLATION_FALLBACK_WARNING =
  "The task started in the shared workspace: an isolated worktree could not be created (the workspace is not a git repository with a commit, or git failed).";
/** How long a stop waits for the members it interrupted to wind down before it reports. */
export const STOP_WAIT_SECONDS = 20;
export const STOPPED_WITH_LEAD = "Stopped with the lead turn.";
export const STOPPED_ON_REQUEST = "Stopped on request.";
export const DELETED_LEAD = "Stopped because the lead thread was deleted.";
// A provider that just failed (sign-in, balance, outage) is skipped by new chains for a while,
// so parallel tasks do not each spend a minute rediscovering the same failure.
export const FAILED_PROVIDER_COOLDOWN_MS = 10 * 60_000;
// How long a provider that hit a usage limit cools down when no snapshot window reports a reset.
export const LIMIT_COOLDOWN_MS = 15 * 60_000;

export interface AvoidedTask {
  readonly taskId: string;
  readonly selection: ModelSelection;
  readonly family: string;
}

export interface CrewAttempt {
  readonly model: string;
  threadId?: ThreadId | undefined;
  messageId?: MessageId | undefined;
  error?: string | undefined;
}

export interface CrewTaskRecord {
  readonly taskId: string;
  readonly leadThreadId: ThreadId;
  readonly leadTurnId: TurnId | null;
  readonly role: CrewRole;
  readonly subject: string;
  /** The repo-relative paths the task may change, when the lead named them. */
  readonly writeScope?: ReadonlyArray<string> | undefined;
  /** The task's own worktree, when it runs isolated from the lead's workspace. */
  readonly worktree?: CrewWorktree | undefined;
  /** The worktree is a candidate: its changes are kept for the lead to pick from, never merged. */
  readonly candidate?: boolean | undefined;
  /** The model the task runs on now (its latest attempt), for `differentFrom`; memory only. */
  chosen?: ModelSelection | undefined;
  readonly attempts: CrewAttempt[];
  /** Why the task was stopped while it ran; set once, and the task is never retried after it. */
  stopped?: string | undefined;
  /** The task's checklist, owned by the server; absent when the lead gave none. */
  todos?: ReadonlyArray<TodoItem> | undefined;
  /** Where the checks run and what file checks compare against. */
  readonly todoBase?: { readonly cwd: string; readonly tree: string | null } | undefined;
  /** Changes outside writeScope the latest check saw. */
  outOfScope?: OutOfScope | undefined;
  /**
   * The project memories the lead's turn selected, by id and version; memory only. Each attempt
   * whose provider may receive memory re-admits them on its own thread.
   */
  memory?: ReadonlyArray<CrewMemoryRef> | undefined;
  /** The lead's own reason for the task, so a user's retry carries it on; memory only. */
  why?: string | undefined;
  /** The attempt running now, for progress activities; memory only. */
  live?: {
    readonly threadId: ThreadId;
    readonly model: string;
    readonly providerInstanceId: string;
  };
  /** Ids of items the lead added that the member has not been told about yet. */
  queued?: ReadonlyArray<string> | undefined;
  /**
   * A nudge or added follow-up was dispatched and its turn has not settled; memory only. The
   * thread may still read as idle until the provider starts that turn, so a stop interrupts anyway.
   */
  sending?: boolean;
  /** The one end-of-turn nudge was used; memory only. */
  nudged?: boolean;
  /** The final sweep started, so no more items can be checked; memory only. */
  closed?: boolean;
  /** Why a message to the member was held before a turn started; the task ends blocked on it. */
  held?: string | undefined;
  report: CrewTaskReport | null;
  /** The lead has this report: crew_wait returned it, or a follow-up turn carried it. */
  collected: boolean;
  /** The lead's board has this task's task.completed, so nothing waits on it any more. */
  ended: boolean;
  auditState: "none" | "pending" | "delivered" | "skipped";
  readonly done: Deferred.Deferred<void>;
  /** Everything after the report is finished too: the board's end row, collection, follow-up. */
  readonly over: Deferred.Deferred<void>;
  readonly lock: Semaphore.Semaphore;
  /** One check or sweep runs at a time per task. */
  readonly checkLock: Semaphore.Semaphore;
}

/** The thread of the last attempt that got as far as launching a crew thread. */
export const lastRunThreadId = (record: Pick<CrewTaskRecord, "attempts">) =>
  record.attempts.findLast((attempt) => attempt.error !== "could not start")?.threadId;

/** The lead's why, trimmed and bounded; nothing when it gave none. */
export const cleanWhy = (why: string | undefined) => {
  const text = why?.trim().slice(0, CREW_WHY_MAX_LENGTH);
  return text === undefined || text === "" ? undefined : text;
};

export const encodeTaskRecovery = Schema.encodeEffect(CrewTaskRecoveryJson);
export const decodeTaskRecovery = Schema.decodeEffect(CrewTaskRecoveryJson);
export const encodeFollowUpRecovery = Schema.encodeEffect(CrewFollowUpRecoveryJson);
export const decodeFollowUpRecovery = Schema.decodeEffect(CrewFollowUpRecoveryJson);

export const MEMORY_HOLD_DETAILS: ReadonlySet<string> = new Set(
  Object.values(ProjectMemorySendGate.MEMORY_SEND_HOLD_DETAIL),
);

export const STOPPED_START_DETAILS: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_STOPPED_START_DETAIL),
);

/** Events after which a thread's status (see crewTaskStatus) may differ; the rest never change it. */
export const STATUS_EVENTS: ReadonlySet<string> = new Set([
  "thread.session-set",
  "thread.turn-interrupt-requested",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.deleted",
]);

/**
 * The PROOF line a report ends with. A stopped task keeps its stop text as it is: the stop is
 * the whole story, and its `proof` field already says not-verified.
 */
export const proofLine = (proof: TaskProof | null, status: CrewTaskOutcome) =>
  proof === null || status === "interrupted" ? null : proofNote(proof);

/** What a task with a TODO list adds to its board activities; nothing for one without. */
export const todoPayload = (record: CrewTaskRecord) =>
  record.todos === undefined ? {} : todoProgressFields(record.todos, record.outOfScope);

/** The TODO summary appended to a report; null for a task without a list. */
export const todoNoteOf = (record: CrewTaskRecord) =>
  record.todos === undefined ? null : todoReportNote(record.todos, record.outOfScope);

export const familyOf = (driver: string, selection: ModelSelection) =>
  modelFamily(selection.model, driver);

/** A report's text with the merge note after it, which the clip must not cut. */
export const withNote = (text: string | null, note: string | null) =>
  note === null ? text : `${text ?? ""}${note}`;
