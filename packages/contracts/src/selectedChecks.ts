import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RELEASE_VERIFICATION_ACTIVITY_KIND } from "./releaseVerification.ts";

/**
 * Server-written record for checks a user selects to run against a thread's
 * workspace: the record kind and limits, the planned-check and
 * tree-observation shapes, validators that name the fault they find, the
 * receipt a finished attempt writes, and the one place a decoded record
 * becomes the public derived state.
 */
export const SELECTED_CHECK_RECEIPT_KIND = "selected-check-receipt";
export const selectedCheckReceiptId = (threadId: ThreadId) => `selected-check-receipt:${threadId}`;

/**
 * Server-owned usage observation written by runtime ingestion: one durable
 * record per token-bearing provider terminal, hidden from work logs like the
 * other server-record kinds. `apps/server/src/usage` reads them back out of
 * retained event history.
 */
export const OWNED_USAGE_ACTIVITY_KIND = "owned-usage";

/**
 * Server-owned record for a thread's pinned requirements and the user's
 * acceptance of a result: one durable record per thread under a fixed id.
 * The constants live here, not in `taskResult.ts`, so that file can import
 * this one without a cycle.
 */
export const TASK_RESULT_ACTIVITY_KIND = "task-result";
export const taskResultRecordId = (threadId: ThreadId) => `task-result:${threadId}`;

/**
 * Activity kinds only the server may write and a client never sends, stored
 * as durable records hidden from client work logs. The verification kinds
 * upsert one record per thread; owned usage appends one record per source
 * delivery.
 */
export const SERVER_RECORD_ACTIVITY_KINDS = [
  RELEASE_VERIFICATION_ACTIVITY_KIND,
  SELECTED_CHECK_RECEIPT_KIND,
  OWNED_USAGE_ACTIVITY_KIND,
  TASK_RESULT_ACTIVITY_KIND,
] as const;

export const SELECTED_CHECK_MAX = 10;
export const SELECTED_CHECK_TIMEOUT_MS_MAX = 3_600_000;

/** Lowercase hex SHA-256, as the executor writes it for commands and output. */
export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type Sha256Hex = typeof Sha256Hex.Type;

/** A Git tree object id: 40 hex characters in SHA-1 repositories, 64 in SHA-256. */
export const GitTreeOid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
export type GitTreeOid = typeof GitTreeOid.Type;

/**
 * Explicit instant grammar: calendar date and time are bounded in the pattern,
 * so only the day-of-month limit and leap years remain to check against the
 * named month. `DateTimeUtcFromString` alone would roll invalid calendars
 * forward and accept dates, local times, and non-ISO spellings.
 */
const SELECTED_CHECK_INSTANT_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const isRealSelectedCheckInstant = (value: string): boolean => {
  const match = SELECTED_CHECK_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const longestMonth =
    month === 2
      ? Number(match[1]) % 4 === 0 && (Number(match[1]) % 100 !== 0 || Number(match[1]) % 400 === 0)
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31;
  return day <= longestMonth;
};

/**
 * A real instant carried as an ISO 8601 string with an explicit `Z` or numeric
 * offset. Decoding rejects rollover spellings like `2026-02-29` and bare dates
 * or local times, then normalizes differing offsets so consumers compare
 * decoded `DateTime.Utc` values instead of the text.
 */
export const SelectedCheckTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      isRealSelectedCheckInstant(value) ||
      "expected a real ISO 8601 timestamp with an explicit Z or numeric offset",
  ),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));
export type SelectedCheckTimestamp = typeof SelectedCheckTimestamp.Type;

/** One check captured at plan time; `commandSha256` pins the command text. */
export const SelectedCheckPlannedCheck = Schema.Struct({
  scriptId: TrimmedNonEmptyString,
  scriptName: Schema.String.check(Schema.isMaxLength(80)),
  commandSha256: Sha256Hex,
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: SELECTED_CHECK_TIMEOUT_MS_MAX }),
  ),
});
export type SelectedCheckPlannedCheck = typeof SelectedCheckPlannedCheck.Type;

export const SelectedCheckTreeObservation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("complete"),
    treeOid: GitTreeOid,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    reason: Schema.Literals(["not-git", "sparse", "gitlink", "staging-failed"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("not-captured"),
  }),
]);
export type SelectedCheckTreeObservation = typeof SelectedCheckTreeObservation.Type;

const describeTreeObservation = (observation: SelectedCheckTreeObservation): string =>
  observation.kind === "complete"
    ? "complete"
    : observation.kind === "unsupported"
      ? `unsupported: ${observation.reason}`
      : "not captured";

/**
 * Null when both ends of a run observed the same complete workspace tree.
 * Otherwise names why the two observations cannot confirm an unchanged
 * workspace.
 */
export function selectedCheckTreeDisagreement(
  atStart: SelectedCheckTreeObservation,
  atEnd: SelectedCheckTreeObservation,
): string | null {
  if (atStart.kind !== "complete") {
    return `the starting tree was ${describeTreeObservation(atStart)}`;
  }
  if (atEnd.kind !== "complete") {
    return `the ending tree was ${describeTreeObservation(atEnd)}`;
  }
  return atStart.treeOid === atEnd.treeOid ? null : "the workspace tree changed during the run";
}

const decodeTimestamp = Schema.decodeUnknownOption(SelectedCheckTimestamp);

/** The instant a timestamp string names, or null when it is not a real timestamp. */
export function parseSelectedCheckInstant(value: unknown): DateTime.Utc | null {
  const decoded = decodeTimestamp(value);
  return Option.isSome(decoded) ? decoded.value : null;
}

/**
 * Null when both timestamps parse and the end is not before the start.
 * Parsed instants are compared, never the raw strings.
 */
export function selectedCheckIntervalDisagreement(
  startedAt: unknown,
  endedAt: unknown,
): string | null {
  const start = parseSelectedCheckInstant(startedAt);
  if (start === null) {
    return startedAt === null || startedAt === undefined
      ? "the start timestamp is missing"
      : "the start timestamp is not a real instant";
  }
  const end = parseSelectedCheckInstant(endedAt);
  if (end === null) {
    return endedAt === null || endedAt === undefined
      ? "the end timestamp is missing"
      : "the end timestamp is not a real instant";
  }
  return DateTime.toEpochMillis(end) < DateTime.toEpochMillis(start)
    ? "the end timestamp is before the start timestamp"
    : null;
}

/**
 * Faults in a planned check list beyond per-field schema validity: the plan
 * must hold between one and SELECTED_CHECK_MAX checks and name each script
 * exactly once.
 */
export function validateSelectedCheckPlan(
  planned: ReadonlyArray<SelectedCheckPlannedCheck>,
): ReadonlyArray<string> {
  const faults: Array<string> = [];
  if (planned.length === 0) {
    faults.push("the plan holds no checks");
  }
  if (planned.length > SELECTED_CHECK_MAX) {
    faults.push(`the plan holds more than ${SELECTED_CHECK_MAX} checks`);
  }
  const scriptIds = new Set<string>();
  for (const check of planned) {
    if (scriptIds.has(check.scriptId)) {
      faults.push(`script '${check.scriptId}' is planned more than once`);
    }
    scriptIds.add(check.scriptId);
  }
  return faults;
}

/**
 * Bounded integers for values the event row and the OS produce — sequences,
 * revisions, byte counts, process group ids — that must round-trip a JS
 * number exactly.
 */
export const SafeNonNegInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const SafePositiveInt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const SelectedCheckAttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type SelectedCheckAttemptId = typeof SelectedCheckAttemptId.Type;

const SelectedCheckOutputStream = Schema.Struct({
  bytes: SafeNonNegInt,
  sha256: Sha256Hex,
});

/** One executed check as the attempt recorded it, in planned order. */
export const SelectedCheckResult = Schema.Struct({
  scriptId: TrimmedNonEmptyString,
  status: Schema.Literals([
    "pending",
    "running",
    "passed",
    "failed",
    "timed-out",
    "cancelled",
    "unproven",
    "not-run",
  ]),
  /** Kept as written; `deriveSelectedCheckState` re-reads them as real instants. */
  startedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  exitedBy: Schema.NullOr(Schema.Literals(["exit", "signal", "timeout", "cancel", "spawn-failed"])),
  exitSignal: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  pgid: Schema.NullOr(SafePositiveInt),
  group: Schema.NullOr(
    Schema.Literals(["not-started", "empty", "terminated", "killed", "unknown"]),
  ),
  stdout: Schema.NullOr(SelectedCheckOutputStream),
  stderr: Schema.NullOr(SelectedCheckOutputStream),
  failure: Schema.NullOr(
    Schema.Literals([
      "spawn-failed",
      "stream-failed",
      "signaled",
      "cleanup-denied",
      "cleanup-timeout",
    ]),
  ),
});
export type SelectedCheckResult = typeof SelectedCheckResult.Type;

/**
 * The repository identity git reports for a workspace, captured at both ends
 * of an attempt: equal tree oids only confirm an unchanged workspace when
 * both ends were also the same repository.
 */
const RepoIdentity = Schema.Struct({ topLevel: Schema.String, commonDir: Schema.String });

/**
 * The full record of one attempt, rewritten on every milestone. It is a
 * historical claim about the attempt's own window: that a fixed plan ran,
 * each recorded check exited 0 on its own, its captured process group ended
 * empty, both output streams carry complete digests, and the workspace tree
 * and the repository were the same at the window's two ends. It never claims
 * the current tree still matches, that any task is verified, or that
 * descendants leaving the group also ended.
 */
export const SelectedCheckReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  attemptId: SelectedCheckAttemptId,
  /** Goes up with every write of this attempt, so a reader keeps the newest copy. */
  revision: SafeNonNegInt,
  /**
   * The event sequence of the attempt's first write, stamped onto every later
   * write; null only on that first write. Readers use it to reject a record
   * whose thread was deleted and recreated after the attempt began.
   */
  threadAnchorSequence: Schema.NullOr(SafeNonNegInt),
  context: Schema.Struct({
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
    cwd: Schema.String,
    shell: Schema.String,
    /**
     * Digest of the explicit project-script environment overrides — never a
     * digest or pin of the whole process environment.
     */
    envSha256: Sha256Hex,
  }),
  /** The plan copied at start, in request order, each command pinned by its hash. */
  planned: Schema.Array(SelectedCheckPlannedCheck),
  environment: Schema.Struct({
    environmentId: EnvironmentId,
    platform: Schema.String,
    arch: Schema.String,
    osRelease: Schema.String,
    serverVersion: Schema.String,
    nodeVersion: Schema.String,
  }),
  tree: Schema.Struct({
    atStart: SelectedCheckTreeObservation,
    atEnd: SelectedCheckTreeObservation,
    repoAtStart: Schema.NullOr(RepoIdentity),
    repoAtEnd: Schema.NullOr(RepoIdentity),
  }),
  phase: Schema.Literals(["running", "completed", "cancelled", "interrupted", "errored"]),
  checks: Schema.Array(SelectedCheckResult),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(
    Schema.Literals([
      "record-failed",
      "tree-capture-failed",
      "context-changed",
      "owner-marker-failed",
      "owner-marker-mismatch",
      "result-missing",
      "server-restarted",
      "server-stopped",
    ]),
  ),
});
export type SelectedCheckReceipt = typeof SelectedCheckReceipt.Type;

/**
 * Whether a run would be accepted right now, and when it would not, what
 * holds the ownership marker. The server derives it from real disk state at
 * read time; `resolveOwnership` returns it with every outcome. Marker and
 * owner summaries report what was observed, so their strings stay
 * uninterpreted.
 */
export const SelectedCheckAdmission = Schema.Union([
  Schema.Struct({ state: Schema.Literal("open") }),
  Schema.Struct({ state: Schema.Literal("reconciling") }),
  Schema.Struct({ state: Schema.Literal("busy"), threadId: ThreadId, attemptId: Schema.String }),
  Schema.Struct({
    state: Schema.Literal("owner-unresolved"),
    marker: Schema.Struct({
      sha256: Sha256Hex,
      attemptId: Schema.String,
      threadId: ThreadId,
      scriptId: Schema.NullOr(Schema.String),
      pgid: Schema.NullOr(SafePositiveInt),
      writtenAt: Schema.String,
    }),
  }),
  Schema.Struct({
    state: Schema.Literal("owner-corrupt"),
    marker: Schema.Struct({ sha256: Sha256Hex, bytes: SafeNonNegInt }),
  }),
  Schema.Struct({ state: Schema.Literal("owner-unreadable") }),
  Schema.Struct({
    state: Schema.Literal("owner-unrecorded"),
    owner: Schema.Struct({
      attemptId: Schema.String,
      threadId: ThreadId,
      scriptId: Schema.NullOr(Schema.String),
      pgid: Schema.NullOr(SafePositiveInt),
    }),
  }),
]);
export type SelectedCheckAdmission = typeof SelectedCheckAdmission.Type;

export const SelectedChecksGetResult = Schema.Struct({
  capability: Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.NullOr(Schema.Literals(["not-posix", "shell-unavailable"])),
  }),
  /**
   * The thread's stored record: absent, not decodable as written, or present
   * with its receipt and the sequence of the event row that holds it. The
   * sequence is the row's own, never a value inside the receipt.
   */
  record: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("malformed") }),
    Schema.Struct({
      kind: Schema.Literal("present"),
      receipt: SelectedCheckReceipt,
      sequence: SafeNonNegInt,
    }),
  ]),
  /** Scripts whose current command hash differs from the recorded plan; for display only. */
  changedScriptIds: Schema.Array(Schema.String),
  admission: SelectedCheckAdmission,
  /**
   * Whether the workspace's current git tree still equals the tree the
   * recorded attempt observed at its end. Only measured when the caller asks
   * and a finished record exists; absent or null is unknown, never a match.
   */
  treeUnchanged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Whether the current environment equals the attempt's recorded one —
   * environmentId, platform, arch, osRelease, serverVersion, nodeVersion.
   * Absent or null is unknown, never a match.
   */
  environmentMatches: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Whether the current execution context equals the attempt's recorded one —
   * projectId, workspaceRoot, worktreePath, cwd, shell, and the explicit-env
   * digest (envSha256 is never a pin of the whole environment).
   * Absent or null is unknown, never a match.
   */
  contextMatches: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type SelectedChecksGetResult = typeof SelectedChecksGetResult.Type;

export const SelectedChecksRunInput = Schema.Struct({
  threadId: ThreadId,
  scriptIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.makeFilter((ids) => {
      if (ids.length < 1 || ids.length > SELECTED_CHECK_MAX) {
        return `expected between 1 and ${SELECTED_CHECK_MAX} script ids`;
      }
      return new Set(ids).size === ids.length || "expected each script at most once";
    }),
  ),
});
export type SelectedChecksRunInput = typeof SelectedChecksRunInput.Type;

export const SelectedChecksRunResult = Schema.Struct({ attemptId: SelectedCheckAttemptId });
export type SelectedChecksRunResult = typeof SelectedChecksRunResult.Type;

export const SelectedChecksCancelInput = Schema.Struct({
  threadId: ThreadId,
  attemptId: SelectedCheckAttemptId,
});
export type SelectedChecksCancelInput = typeof SelectedChecksCancelInput.Type;

export const SelectedChecksCancelResult = Schema.Struct({ cancelled: Schema.Boolean });
export type SelectedChecksCancelResult = typeof SelectedChecksCancelResult.Type;

export const SelectedChecksResolveOwnershipInput = Schema.Struct({
  /** The exact marker bytes to resolve; null re-reports admission and changes nothing. */
  markerSha256: Schema.NullOr(Sha256Hex),
  acknowledgeUncertainty: Schema.Boolean,
});
export type SelectedChecksResolveOwnershipInput = typeof SelectedChecksResolveOwnershipInput.Type;

export const SelectedChecksResolveOwnershipResult = Schema.Struct({
  outcome: Schema.Literals([
    "cleared-gone",
    "acknowledged",
    "still-unresolved",
    "stale",
    "attempt-live",
    "unreadable",
    "persist-failed",
  ]),
  /** Re-read after the resolution attempt, so it always matches the disk. */
  admission: SelectedCheckAdmission,
});
export type SelectedChecksResolveOwnershipResult = typeof SelectedChecksResolveOwnershipResult.Type;

/** A rejected run names the gate that stopped it and, for per-script gates, the script. */
export class SelectedChecksRejectedError extends Schema.TaggedError<SelectedChecksRejectedError>()(
  "SelectedChecksRejectedError",
  {
    reason: Schema.Literals([
      "not-posix",
      "shell-unavailable",
      "reconciling",
      "busy",
      "owner-unresolved",
      "owner-corrupt",
      "owner-unreadable",
      "owner-unrecorded",
      "turn-active",
      "script-not-found",
      "record-failed",
      "context-changed",
      "owner-marker-failed",
    ]),
    scriptId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.scriptId === undefined
      ? `Selected checks rejected: ${this.reason}`
      : `Selected checks rejected: ${this.reason} (${this.scriptId})`;
  }
}

export class SelectedChecksThreadNotFoundError extends Schema.TaggedError<SelectedChecksThreadNotFoundError>()(
  "SelectedChecksThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist.`;
  }
}

export type SelectedChecksState =
  | "none"
  | "incomplete"
  | "running"
  | "failed"
  | "all-selected-passed";

export interface SelectedChecksDerivedState {
  readonly state: SelectedChecksState;
  readonly reasons: Array<string>;
}

const instantMillis = (value: unknown): number | null => {
  const instant = parseSelectedCheckInstant(value);
  return instant === null ? null : DateTime.toEpochMillis(instant);
};

/** Every way one check falls short of a proven pass, each its own named reason. */
export const passedProvenanceFaults = (check: SelectedCheckResult): Array<string> => {
  const faults: Array<string> = [];
  const id = `'${check.scriptId}'`;
  if (check.status !== "passed") faults.push(`${id} was recorded as ${check.status}`);
  if (check.exitCode === null) faults.push(`${id} recorded no exit code`);
  else if (check.exitCode !== 0) faults.push(`${id} exited ${check.exitCode}`);
  if (check.exitedBy !== "exit") faults.push(`${id} did not exit on its own`);
  if (check.exitSignal !== null) faults.push(`${id} exited on a signal`);
  if (check.pgid === null || !Number.isSafeInteger(check.pgid) || check.pgid < 1) {
    faults.push(`${id} has no positive process group recorded`);
  }
  if (check.group !== "empty") faults.push(`${id} did not leave an empty process group`);
  if (check.stdout === null || check.stderr === null)
    faults.push(`${id} is missing an output digest`);
  if (check.failure !== null) faults.push(`${id} recorded a failure: ${check.failure}`);
  return faults;
};

/**
 * The attempt window and each check window must be real instants, every check
 * window must sit inside the attempt, and the windows must be ordered without
 * overlapping. Touching endpoints do not overlap.
 */
const intervalProvenanceFaults = (receipt: SelectedCheckReceipt): Array<string> => {
  const attemptFault = selectedCheckIntervalDisagreement(receipt.startedAt, receipt.endedAt);
  if (attemptFault !== null) return [`the attempt window is invalid: ${attemptFault}`];
  const attemptStartMs = instantMillis(receipt.startedAt);
  const attemptEndMs = instantMillis(receipt.endedAt);
  if (attemptStartMs === null || attemptEndMs === null) {
    return ["the attempt window is invalid: the timestamps are not real instants"];
  }
  const faults: Array<string> = [];
  let previousEndMs: number | null = null;
  for (const check of receipt.checks) {
    const id = `'${check.scriptId}'`;
    const windowFault = selectedCheckIntervalDisagreement(check.startedAt, check.endedAt);
    if (windowFault !== null) {
      faults.push(`${id} has an invalid window: ${windowFault}`);
      continue;
    }
    const startMs = instantMillis(check.startedAt);
    const endMs = instantMillis(check.endedAt);
    if (startMs === null || endMs === null) {
      faults.push(`${id} has an invalid window: the timestamps are not real instants`);
      continue;
    }
    if (startMs < attemptStartMs || endMs > attemptEndMs) {
      faults.push(`${id} ran outside the attempt window`);
    }
    if (previousEndMs !== null && startMs < previousEndMs) {
      faults.push(`${id} overlaps an earlier check`);
    }
    previousEndMs = endMs;
  }
  return faults;
};

/**
 * Faults in how an attempt's recorded checks line up with its plan: the plan
 * itself must be valid, and every recorded check must sit at its planned
 * position in the same order, one for one. Without this a recorded row
 * cannot be trusted to belong to the execution its plan describes.
 */
export const selectedCheckPlanAlignmentFaults = (receipt: SelectedCheckReceipt): Array<string> => {
  const reasons: Array<string> = [];
  for (const fault of validateSelectedCheckPlan(receipt.planned)) {
    reasons.push(`the plan is invalid: ${fault}`);
  }
  if (receipt.checks.length !== receipt.planned.length) {
    reasons.push("the recorded checks do not match the plan one for one");
  } else {
    for (let index = 0; index < receipt.checks.length; index++) {
      const check = receipt.checks[index];
      const planned = receipt.planned[index];
      if (check !== undefined && planned !== undefined && check.scriptId !== planned.scriptId) {
        reasons.push(
          `check ${index} is '${check.scriptId}' where the plan has '${planned.scriptId}'`,
        );
      }
    }
  }
  return reasons;
};

/**
 * Run-level provenance faults beyond the plan and each check's pass fields:
 * real windows nested inside the attempt, the same complete tree in the same
 * repository at both ends, and an event anchor no newer than the stored row
 * that holds it. `recordSequence` is the sequence of the stored event row,
 * never a value inside the receipt.
 */
export const selectedCheckRunStructureFaults = (
  receipt: SelectedCheckReceipt,
  recordSequence: number,
): Array<string> => {
  const reasons: Array<string> = [];
  reasons.push(...intervalProvenanceFaults(receipt));
  const treeFault = selectedCheckTreeDisagreement(receipt.tree.atStart, receipt.tree.atEnd);
  if (treeFault !== null) reasons.push(`the workspace tree is unproven: ${treeFault}`);
  const { repoAtStart, repoAtEnd } = receipt.tree;
  if (repoAtStart === null || repoAtEnd === null) {
    reasons.push("the repository identity was not captured at both ends");
  } else if (
    repoAtStart.topLevel !== repoAtEnd.topLevel ||
    repoAtStart.commonDir !== repoAtEnd.commonDir
  ) {
    reasons.push("the run started and ended in different repositories");
  }
  if (receipt.threadAnchorSequence === null) {
    reasons.push("the record is missing its event anchor");
  } else if (receipt.threadAnchorSequence > recordSequence) {
    reasons.push("the record's event anchor is newer than the record itself");
  }
  return reasons;
};

/**
 * Every provenance fault that keeps an attempt's receipt short of its
 * historical claim, one named reason per fault, composed from
 * `selectedCheckPlanAlignmentFaults`, each check's pass fields, and
 * `selectedCheckRunStructureFaults`: the attempt finished without a recorded
 * error, a valid plan matched one-for-one by the recorded checks, each check
 * provably exited 0 on its own with an empty captured group and complete
 * output digests, all windows valid and nested, both ends the same complete
 * tree in the same repository, and an event anchor no newer than the record
 * that holds it. `recordSequence` is the sequence of the stored event row,
 * never a value inside the receipt. `deriveSelectedCheckState` judges on
 * this whole list; the task-result judgment reuses the same parts, applying
 * pass requirements to the checks a requirement pins.
 */
export function selectedCheckReceiptFaults(
  receipt: SelectedCheckReceipt,
  recordSequence: number,
): Array<string> {
  const reasons: Array<string> = [];
  if (receipt.phase !== "completed") {
    reasons.push(`the attempt was ${receipt.phase}, not completed`);
  }
  if (receipt.error !== null) reasons.push(`the attempt recorded an error: ${receipt.error}`);
  reasons.push(...selectedCheckPlanAlignmentFaults(receipt));
  for (const check of receipt.checks) reasons.push(...passedProvenanceFaults(check));
  reasons.push(...selectedCheckRunStructureFaults(receipt, recordSequence));
  return reasons;
}

/**
 * The one place a decoded record becomes the public state, shared by the
 * server and every client. It fails closed: `all-selected-passed` is the
 * historical claim described on the receipt — a plan without faults, checks
 * matching it one for one, each check provably exited 0 on its own with an
 * empty captured group and complete output digests, all windows valid and
 * nested, both ends the same complete tree in the same repository, and the
 * record anchored inside its thread's history. A running phase and an
 * observed failure each win over everything else and can never read as
 * passed. Only a check observed failing reads as failed; everything short of
 * the claim is `incomplete`, with one named reason per fault found.
 */
export function deriveSelectedCheckState(
  record: SelectedChecksGetResult["record"],
): SelectedChecksDerivedState {
  if (record.kind === "none") return { state: "none", reasons: [] };
  if (record.kind === "malformed") {
    return { state: "incomplete", reasons: ["the stored record is malformed"] };
  }
  const { receipt, sequence } = record;
  if (receipt.phase === "running") return { state: "running", reasons: [] };
  const failed = receipt.checks.filter(
    (check) => check.status === "failed" && check.exitCode !== null && check.exitCode !== 0,
  );
  if (failed.length > 0) {
    return {
      state: "failed",
      reasons: failed.map((check) => `'${check.scriptId}' exited ${check.exitCode}`),
    };
  }

  const reasons = selectedCheckReceiptFaults(receipt, sequence);
  return reasons.length === 0
    ? { state: "all-selected-passed", reasons }
    : { state: "incomplete", reasons };
}
