import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  SELECTED_CHECK_MAX,
  SafeNonNegInt,
  SafePositiveInt,
  SelectedCheckAttemptId,
  SelectedChecksGetResult,
  Sha256Hex,
  passedProvenanceFaults,
  selectedCheckPlanAlignmentFaults,
  selectedCheckRunStructureFaults,
} from "./selectedChecks.ts";

/**
 * Bounds on the requirements a user pins for a task. The item cap is an
 * explicit input bound of this slice, not a semantic limit on requirement
 * count; the check cap follows the executor's run limit. A bound check's
 * command hash is pinned when the requirements are set.
 */
export const TASK_RESULT_ITEMS_MAX = 10;
export const TASK_RESULT_ITEM_TEXT_MAX = 500;

/**
 * One requirement item: the text the user wrote plus the checks bound to it.
 * An item with no `scriptIds` is judged by the user, never by a check.
 */
export const TaskResultRequirementItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(TASK_RESULT_ITEM_TEXT_MAX)),
  scriptIds: Schema.Array(TrimmedNonEmptyString),
});
export type TaskResultRequirementItem = typeof TaskResultRequirementItem.Type;

/**
 * A required check with the command hash the requirement pinned when it was
 * set. Only the server writes it, resolved against the project's scripts.
 */
export const TaskResultRequiredCheck = Schema.Struct({
  scriptId: TrimmedNonEmptyString,
  commandSha256: Sha256Hex,
});
export type TaskResultRequiredCheck = typeof TaskResultRequiredCheck.Type;

/**
 * Faults in a requirements item list beyond per-field schema validity:
 * between one and TASK_RESULT_ITEMS_MAX items, each item id once, each
 * script bound at most once across all items, and at least one bound script
 * — a task whose requirements bind no check can never be verified by this
 * slice. Callers reject on any fault; they never silently drop or trim.
 */
export function validateTaskResultItems(
  items: ReadonlyArray<TaskResultRequirementItem>,
): ReadonlyArray<string> {
  const faults: Array<string> = [];
  if (items.length === 0) {
    faults.push("the requirements hold no items");
  }
  if (items.length > TASK_RESULT_ITEMS_MAX) {
    faults.push(`the requirements hold more than ${TASK_RESULT_ITEMS_MAX} items`);
  }
  const itemIds = new Set<string>();
  const boundScriptIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) {
      faults.push(`requirement '${item.id}' is listed more than once`);
    }
    itemIds.add(item.id);
    for (const scriptId of item.scriptIds) {
      if (boundScriptIds.has(scriptId)) {
        faults.push(`script '${scriptId}' is bound to requirements more than once`);
      }
      boundScriptIds.add(scriptId);
    }
  }
  if (items.length > 0 && boundScriptIds.size === 0) {
    faults.push("no requirement binds a check");
  }
  if (boundScriptIds.size > SELECTED_CHECK_MAX) {
    faults.push(`requirements bind more than ${SELECTED_CHECK_MAX} checks`);
  }
  return faults;
}

const TaskResultItems = Schema.Array(TaskResultRequirementItem).check(
  Schema.makeFilter(validateTaskResultItems),
);

const TaskResultRequirements = Schema.Struct({
  /**
   * Content revision of the requirements themselves: 1 on first set, +1 on
   * every later set. Distinct from the record's `revision`, which counts
   * every write for compare-and-set.
   */
  version: SafePositiveInt,
  items: TaskResultItems,
  /**
   * The union of every item's bound scripts, each pinned to the command hash
   * resolved when the requirements were set. The server fills it; a request
   * never supplies it.
   */
  checks: Schema.Array(TaskResultRequiredCheck).check(
    Schema.makeFilter((checks) => {
      if (checks.length < 1 || checks.length > SELECTED_CHECK_MAX) {
        return `expected between 1 and ${SELECTED_CHECK_MAX} pinned checks`;
      }
      const seen = new Set<string>();
      for (const check of checks) {
        if (seen.has(check.scriptId)) {
          return `script '${check.scriptId}' is pinned more than once`;
        }
        seen.add(check.scriptId);
      }
      return true;
    }),
  ),
  setAt: IsoDateTime,
}).check(
  Schema.makeFilter((requirements) => {
    const pinned = new Set(requirements.checks.map((check) => check.scriptId));
    const bound = new Set(requirements.items.flatMap((item) => item.scriptIds));
    return (
      (pinned.size === bound.size && [...bound].every((id) => pinned.has(id))) ||
      "the pinned checks are not exactly the scripts the items bind"
    );
  }),
);

/**
 * The user's acceptance of one exact result: the requirements version, the
 * attempt, and the stored receipt row it was judged on. The tuple is the
 * acceptance's identity — a new revision, attempt, or receipt row leaves it
 * behind as stale.
 */
const TaskResultAcceptance = Schema.Struct({
  requirementsVersion: SafePositiveInt,
  checkAttemptId: SelectedCheckAttemptId,
  checkReceiptSequence: SafeNonNegInt,
  acceptedAt: IsoDateTime,
});

/**
 * The server-owned task-result record: the requirements a user pinned for a
 * thread and the acceptance they recorded over one exact check attempt. On
 * its own it claims nothing about the current workspace — currency is judged
 * by `deriveTaskResultState` against a fresh read.
 */
export const TaskResultRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  /**
   * Compare-and-set counter: 0 on the first write, +1 on every mutation.
   * Mutation requests carry the last seen value as `expectedRevision`, where
   * `null` — never a number — asserts the record does not exist yet.
   */
  revision: SafeNonNegInt,
  /**
   * The sequence of the thread's latest `thread.created` event when this
   * record was written. A record read under a different current incarnation
   * is leftover history, never current fact.
   */
  threadIncarnation: SafeNonNegInt,
  requirements: Schema.NullOr(TaskResultRequirements),
  /** User acceptance of the current result — never produced by automated checks. */
  acceptance: Schema.NullOr(TaskResultAcceptance),
});
export type TaskResultRecord = typeof TaskResultRecord.Type;

/**
 * The thread's stored record: absent, not decodable as written, or present
 * with the record and the sequence of the event row that holds it. The
 * sequence is the row's own, never a value inside the record.
 */
export const TaskResultRecordView = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("malformed") }),
  Schema.Struct({
    kind: Schema.Literal("present"),
    record: TaskResultRecord,
    sequence: SafeNonNegInt,
  }),
]);
export type TaskResultRecordView = typeof TaskResultRecordView.Type;

export const TaskResultGetInput = Schema.Struct({ threadId: ThreadId });
export type TaskResultGetInput = typeof TaskResultGetInput.Type;

export const TaskResultGetResult = Schema.Struct({
  record: TaskResultRecordView,
  /**
   * The thread's current incarnation — the sequence of its latest
   * `thread.created` event at read time. Mutation requests must name it, and
   * the judgment binds the record and the check attempt to it. Absent means
   * the incarnation could not be determined: every currency judgment fails
   * closed to unknown.
   */
  threadIncarnation: Schema.optional(SafeNonNegInt),
  checks: SelectedChecksGetResult,
});
export type TaskResultGetResult = typeof TaskResultGetResult.Type;

const TaskResultMutationFields = {
  threadId: ThreadId,
  /**
   * The incarnation the request targets — the thread's latest
   * `thread.created` sequence as the requester last read it. A write naming
   * another incarnation is a conflict, not a write.
   */
  threadIncarnation: SafeNonNegInt,
  /**
   * CAS guard: the record revision the requester last saw. `null` asserts no
   * record exists yet — the single convention for an absent record.
   */
  expectedRevision: Schema.NullOr(SafeNonNegInt),
};

/**
 * Replace the thread's requirements. The request carries items only: the
 * server resolves each bound script, pins its current command hash into
 * `checks`, bumps the requirements version, and clears acceptance. Invalid
 * item lists are rejected, never silently dropped or shortened.
 */
export const TaskResultSetRequirementsInput = Schema.Struct({
  ...TaskResultMutationFields,
  items: TaskResultItems,
});
export type TaskResultSetRequirementsInput = typeof TaskResultSetRequirementsInput.Type;

/**
 * Accept the current result. The tuple names the exact evidence the
 * requester judged current — requirements version, attempt, and stored
 * receipt row — so an acceptance can never land on a result it did not see.
 */
export const TaskResultAcceptInput = Schema.Struct({
  ...TaskResultMutationFields,
  requirementsVersion: SafePositiveInt,
  checkAttemptId: SelectedCheckAttemptId,
  checkReceiptSequence: SafeNonNegInt,
});
export type TaskResultAcceptInput = typeof TaskResultAcceptInput.Type;

/** Withdraw the stored acceptance, guarded by the same incarnation and revision. */
export const TaskResultWithdrawInput = Schema.Struct({ ...TaskResultMutationFields });
export type TaskResultWithdrawInput = typeof TaskResultWithdrawInput.Type;

/** Mutations return the same re-read view as `get`, measured after the write. */
export const TaskResultMutationResult = TaskResultGetResult;
export type TaskResultMutationResult = TaskResultGetResult;

/** A rejected mutation names the gate that stopped it; `detail` adds specifics. */
export class TaskResultRejectedError extends Schema.TaggedError<TaskResultRejectedError>()(
  "TaskResultRejectedError",
  {
    reason: Schema.Literals([
      "conflict",
      "turn-active",
      "not-awaiting-acceptance",
      "requirements-invalid",
      "script-not-found",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Task result rejected: ${this.reason}`
      : `Task result rejected: ${this.reason} (${this.detail})`;
  }
}

export class TaskResultThreadNotFoundError extends Schema.TaggedError<TaskResultThreadNotFoundError>()(
  "TaskResultThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist.`;
  }
}

export type TaskResultState =
  | "no-requirements"
  | "failed"
  | "running"
  | "needs-confirmation"
  | "awaiting-acceptance"
  | "verified";

/**
 * `current` only while the stored acceptance still names the exact
 * requirements version, attempt, and receipt row being read *and* every
 * current observation holds. A stored acceptance under anything less stays
 * stored but reads `stale`; re-measurement after an exact restore can make
 * it current again.
 */
export type TaskResultAcceptanceState = "none" | "current" | "stale";

export type TaskResultItemStatus = "checked" | "user-judged" | "unproven";

export interface TaskResultDerivedItem {
  readonly id: string;
  readonly status: TaskResultItemStatus;
}

export interface TaskResultDerivedState {
  readonly state: TaskResultState;
  readonly acceptance: TaskResultAcceptanceState;
  readonly reasons: Array<string>;
  readonly items: ReadonlyArray<TaskResultDerivedItem>;
}

/**
 * The one place a task-result read becomes a state, shared by the server and
 * every client. It fails closed and binds before it judges: the record and
 * the check attempt must both belong to this thread's current incarnation
 * and the receipt must carry this thread's id, every required check must
 * appear in the latest attempt's plan under its pinned command hash with an
 * unchanged current command. Thread, incarnation, plan alignment and anchor
 * bind failed/running precedence; complete window/tree/repository provenance
 * and current observations also gate readiness, checked items and acceptance.
 * Pass evidence is scoped to the
 * pinned required checks: an unpinned check's exit can never veto readiness,
 * though its malformed window still can. Only a required check observed
 * failing in a bound attempt reads `failed`, and it outranks a still-running
 * attempt. Absent or null current observations are unknown, never a match.
 * `verified` needs a current user acceptance on top of a fully current read;
 * acceptance alone can never verify.
 *
 * This slice consults only the thread's latest stored attempt: a required
 * check last proven by an earlier attempt reads unproven, not satisfied.
 */
export function deriveTaskResultState(
  result: TaskResultGetResult,
  turnActive: boolean,
): TaskResultDerivedState {
  const { record, checks } = result;
  if (record.kind === "none") {
    return { state: "no-requirements", acceptance: "none", reasons: [], items: [] };
  }
  if (record.kind === "malformed") {
    return {
      state: "needs-confirmation",
      acceptance: "none",
      reasons: ["the stored record is malformed"],
      items: [],
    };
  }
  const taskResult = record.record;
  const requirements = taskResult.requirements;
  if (requirements === null) {
    return {
      state: "no-requirements",
      acceptance: taskResult.acceptance === null ? "none" : "stale",
      reasons: [],
      items: [],
    };
  }

  const threadIncarnation = result.threadIncarnation;
  const reasons: Array<string> = [];

  // The record must belong to this incarnation of the thread; one written
  // under an earlier `thread.created` is leftover history.
  const recordCurrent =
    threadIncarnation !== undefined && taskResult.threadIncarnation === threadIncarnation;
  if (threadIncarnation === undefined) {
    reasons.push("the thread's current incarnation is unknown");
  } else if (!recordCurrent) {
    reasons.push("the record was written for a different incarnation of this thread");
  }

  const checksRecord = checks.record;
  const receipt = checksRecord.kind === "present" ? checksRecord.receipt : null;
  const receiptSequence = checksRecord.kind === "present" ? checksRecord.sequence : null;
  if (checksRecord.kind === "none") {
    reasons.push("no check attempt has been recorded");
  } else if (checksRecord.kind === "malformed") {
    reasons.push("the stored check record is malformed");
  }
  // The receipt must belong to this thread — one from another thread that
  // happens to match the acceptance tuple is foreign history, not evidence.
  const threadMatches = receipt !== null && receipt.threadId === taskResult.threadId;
  if (receipt !== null && !threadMatches) {
    reasons.push("the recorded check attempt belongs to a different thread");
  }

  // The attempt's anchor must sit at or after the current incarnation —
  // the mirror of the server's "a `thread.created` after the anchor
  // invalidates the record" check.
  const receiptCurrent =
    receipt !== null &&
    threadIncarnation !== undefined &&
    receipt.threadAnchorSequence !== null &&
    receipt.threadAnchorSequence >= threadIncarnation;
  if (
    receipt !== null &&
    threadIncarnation !== undefined &&
    receipt.threadAnchorSequence !== null &&
    receipt.threadAnchorSequence < threadIncarnation
  ) {
    reasons.push("the recorded check attempt belongs to an earlier incarnation of this thread");
  }

  // The shared structural binding every judgment stands on: the receipt is
  // this thread's, its anchor is sane inside the current incarnation, and
  // its recorded checks sit at their planned positions one for one. Without
  // it no recorded row can be trusted to belong to the planned execution —
  // not for readiness, and not for failure or running precedence.
  const planAlignmentReasons = receipt === null ? [] : selectedCheckPlanAlignmentFaults(receipt);
  const runStructureReasons =
    receipt !== null && receiptSequence !== null
      ? selectedCheckRunStructureFaults(receipt, receiptSequence)
      : [];
  const receiptBound =
    receipt !== null &&
    receiptSequence !== null &&
    threadMatches &&
    receiptCurrent &&
    receipt.threadAnchorSequence !== null &&
    receipt.threadAnchorSequence <= receiptSequence &&
    planAlignmentReasons.length === 0;
  const bound = recordCurrent && receiptBound;

  // Every required check must be bound to the latest attempt: planned under
  // the pinned command hash, and its command unchanged since.
  const requiredBound = new Map<string, boolean>();
  if (receipt !== null) {
    const changed = new Set(checks.changedScriptIds);
    for (const required of requirements.checks) {
      const planned = receipt.planned.find((entry) => entry.scriptId === required.scriptId);
      let isBound = true;
      if (planned === undefined) {
        reasons.push(`required check '${required.scriptId}' was not in the latest attempt's plan`);
        isBound = false;
      } else if (planned.commandSha256 !== required.commandSha256) {
        reasons.push(
          `required check '${required.scriptId}' ran a command different from the one the requirement pins`,
        );
        isBound = false;
      }
      if (changed.has(required.scriptId)) {
        reasons.push(
          `the command for required check '${required.scriptId}' changed since the attempt`,
        );
        isBound = false;
      }
      requiredBound.set(required.scriptId, isBound);
    }
  }
  const requiredIds = new Set(requirements.checks.map((check) => check.scriptId));

  // Whole-receipt claims plus pass evidence for required checks only: the
  // attempt completed cleanly, its plan and run structure are intact, and
  // every required check provably passed. An unpinned check's own pass
  // fields never veto readiness; the shared structure still does.
  if (receipt !== null) {
    if (receipt.phase !== "completed") {
      reasons.push(`the attempt was ${receipt.phase}, not completed`);
    }
    if (receipt.error !== null) {
      reasons.push(`the attempt recorded an error: ${receipt.error}`);
    }
    reasons.push(...planAlignmentReasons);
    for (const check of receipt.checks) {
      if (requiredIds.has(check.scriptId)) {
        reasons.push(...passedProvenanceFaults(check));
      }
    }
    reasons.push(...runStructureReasons);
  }

  // Current observations: absent or null is unknown, never a match.
  if (checks.treeUnchanged === false) {
    reasons.push("the workspace tree changed since the attempt observed it");
  } else if (checks.treeUnchanged !== true) {
    reasons.push("the current workspace tree was not measured");
  }
  if (checks.environmentMatches === false) {
    reasons.push("the current environment differs from the attempt's environment");
  } else if (checks.environmentMatches !== true) {
    reasons.push("the current environment was not compared to the attempt's");
  }
  if (checks.contextMatches === false) {
    reasons.push("the current execution context differs from the attempt's");
  } else if (checks.contextMatches !== true) {
    reasons.push("the current execution context was not measured");
  }
  // Everything above is the evidence a current result stands on; a live
  // turn only gates the state, never the proof an item already carries.
  const evidenceClean = reasons.length === 0;
  if (turnActive) {
    reasons.push("a turn is in progress");
  }

  const receiptChecks = receipt === null ? [] : receipt.checks;
  const items: Array<TaskResultDerivedItem> = requirements.items.map((item) => {
    if (item.scriptIds.length === 0) {
      return { id: item.id, status: "user-judged" as const };
    }
    const checked =
      evidenceClean &&
      item.scriptIds.every((scriptId) => {
        if (requiredBound.get(scriptId) !== true) return false;
        const results = receiptChecks.filter((check) => check.scriptId === scriptId);
        return (
          results.length > 0 && results.every((check) => passedProvenanceFaults(check).length === 0)
        );
      });
    return { id: item.id, status: checked ? ("checked" as const) : ("unproven" as const) };
  });

  const acceptance: TaskResultAcceptanceState = (() => {
    const stored = taskResult.acceptance;
    if (stored === null) return "none";
    const tupleMatches =
      receipt !== null &&
      receiptSequence !== null &&
      stored.requirementsVersion === requirements.version &&
      stored.checkAttemptId === receipt.attemptId &&
      stored.checkReceiptSequence === receiptSequence;
    // A matching tuple is still stale while any current observation fails.
    return tupleMatches && reasons.length === 0 ? "current" : "stale";
  })();

  // A bound required check observed failing is positive evidence the
  // requirement fails as pinned; it outranks a still-running attempt.
  if (bound) {
    const failedRequired = requirements.checks.flatMap((required) =>
      requiredBound.get(required.scriptId) === true
        ? receiptChecks
            .filter(
              (check) =>
                check.scriptId === required.scriptId &&
                check.status === "failed" &&
                check.exitCode !== null &&
                check.exitCode !== 0,
            )
            .map((check) => `required check '${check.scriptId}' exited ${check.exitCode}`)
        : [],
    );
    if (failedRequired.length > 0) {
      return { state: "failed", acceptance, reasons: failedRequired, items };
    }
    if (receipt !== null && receipt.phase === "running") {
      return { state: "running", acceptance, reasons: [], items };
    }
  }

  if (reasons.length > 0) {
    return { state: "needs-confirmation", acceptance, reasons, items };
  }
  return {
    state: acceptance === "current" ? "verified" : "awaiting-acceptance",
    acceptance,
    reasons,
    items,
  };
}
