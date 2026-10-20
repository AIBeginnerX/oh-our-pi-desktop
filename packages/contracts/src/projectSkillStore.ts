import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PROJECT_SKILL_LIMITS,
  ProjectSkillCandidateSourceIdentity,
  ProjectSkillContent,
  ProjectSkillEvidenceId,
  ProjectSkillExpectedCheckTuple,
  ProjectSkillId,
  ProjectSkillJudgment,
  ProjectSkillJudgmentId,
  ProjectSkillReadinessGap,
  ProjectSkillRetiredReason,
  ProjectSkillScreenReason,
  ProjectSkillSource,
  ProjectSkillVersionRef,
  ProjectSkillVersionState,
} from "./projectSkill.ts";
import {
  ProjectSkillReviewDraftPartial,
  ProjectSkillReviewDraftTruncation,
  ProjectSkillReviewDraftUnavailableReason,
} from "./projectSkillDraft.ts";
import { Sha256Hex } from "./selectedChecks.ts";

/**
 * Storage-slice contracts for inactive candidate project skills: the shapes
 * the persistence repository returns and the inputs the service accepts.
 * These are wire/storage types only — readiness, admission, and hold logic
 * live in `projectSkill.ts` and are not invoked by this slice. Server-owned
 * fields (`judgmentId`, `ref`, `recordedAt`, `recordedBy`, sequences, hashes)
 * are never accepted from client input; the server fills them.
 */

/** Same safe-int constraint the S1 sequence fields use (private there). */
const SafeNonNegInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Same bound the selected-checks receipt puts on its attempt id (private there). */
const CheckAttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * One stored version. `source` is the full S1 source including its
 * `createdAfterEventSequence` watermark; the repository assembles it from the
 * column before decode.
 */
export const ProjectSkillVersionRecord = Schema.Struct({
  ref: ProjectSkillVersionRef,
  content: ProjectSkillContent,
  source: ProjectSkillSource,
  state: ProjectSkillVersionState,
  retiredReason: Schema.NullOr(ProjectSkillRetiredReason),
  createdAt: IsoDateTime,
});
export type ProjectSkillVersionRecord = typeof ProjectSkillVersionRecord.Type;

/**
 * One stored judgment row. `recordedAfterEventSequence` is the write-time
 * high-water mark kept for audit; `withdrawnAt` is null while the judgment
 * counts.
 */
export const ProjectSkillJudgmentRecord = Schema.Struct({
  judgment: ProjectSkillJudgment,
  recordedAfterEventSequence: SafeNonNegInt,
  withdrawnAt: Schema.NullOr(IsoDateTime),
});
export type ProjectSkillJudgmentRecord = typeof ProjectSkillJudgmentRecord.Type;

/**
 * One attempt's check outcome inside a trial window. `receiptSequence` is the
 * event row sequence of the receipt write the reader kept for the attempt,
 * not a value inside the receipt.
 */
const projectSkillTrialObservationBase = {
  attemptId: CheckAttemptId,
  receiptSequence: SafeNonNegInt,
  outcome: Schema.Literals(["all-selected-passed", "failed"]),
  endedAt: Schema.NullOr(IsoDateTime),
} as const;

/**
 * Provisional: derived on each read from the still-open window's event
 * snapshot. It carries no evidence identity — nothing is persisted while the
 * window is open, a later write for the same attempt can still supersede it,
 * and it can never serve as reproduction evidence.
 */
export const ProjectSkillTrialProvisionalObservation = Schema.Struct(
  projectSkillTrialObservationBase,
);
export type ProjectSkillTrialProvisionalObservation =
  typeof ProjectSkillTrialProvisionalObservation.Type;

/**
 * Final: the latest authenticated in-range receipt for one attempt, written
 * with its evidence identity when the window closed. `evidenceId` is the
 * durable identity a later judgment may name.
 */
export const ProjectSkillTrialObservation = Schema.Struct({
  ...projectSkillTrialObservationBase,
  evidenceId: ProjectSkillEvidenceId,
});
export type ProjectSkillTrialObservation = typeof ProjectSkillTrialObservation.Type;

const projectSkillTrialSummaryBase = {
  threadId: ThreadId,
  messageId: MessageId,
  /** The canonical accepted user-message event's sequence in this server's
      event domain — never the paired turn-request sequence. */
  inputEventSequence: SafeNonNegInt,
  /** The server's state-seq stamp written at admission; proof the gate
      admitted this input, never a client-supplied value. */
  admittedSkillStateSeq: SafeNonNegInt,
  /**
   * `provider-accepted` means the provider send returned — not that a task or
   * a check completed. `unknown` covers every other exit (cancel, crash, lost
   * commit); it is never a verified delivery and can never back a
   * reproduction claim.
   */
  delivery: Schema.Literals(["unknown", "provider-accepted"]),
  /** The routed instance's actual driver, or null when unconfirmed. */
  providerDriverKind: Schema.NullOr(TrimmedNonEmptyString),
  /** Whether the trial ran in the version's own source thread — a same-thread
      trial is not an independent reproduction. */
  sameThreadAsSource: Schema.Boolean,
} as const;

/**
 * One accepted trial input against this version, as the sweep reports it.
 * `window` is authoritative for how the observation fields must be read:
 * - `open`: the next user input has not arrived; `provisionalObservations`
 *   are derived from a consistent snapshot and can still change.
 * - `closed`: the next input fixed the range; `observations` are the latest
 *   authenticated in-range receipt per attempt, written atomically with the
 *   closure. `uncountedAttempts` holds attempts that crossed the boundary
 *   unresolved — counted, never reported as success or failure.
 * - `thread-recreated`: the thread was recreated inside the window; no fixed
 *   range formed, so no observation fields exist.
 * A trial summary is never reproduction evidence and implies nothing about
 * readiness.
 */
export const ProjectSkillTrialSummary = Schema.Union([
  Schema.Struct({
    ...projectSkillTrialSummaryBase,
    window: Schema.Literal("open"),
    provisionalObservations: Schema.Array(ProjectSkillTrialProvisionalObservation),
  }),
  Schema.Struct({
    ...projectSkillTrialSummaryBase,
    window: Schema.Literal("closed"),
    observations: Schema.Array(ProjectSkillTrialObservation),
    uncountedAttempts: SafeNonNegInt,
  }),
  Schema.Struct({
    ...projectSkillTrialSummaryBase,
    window: Schema.Literal("thread-recreated"),
  }),
]);
export type ProjectSkillTrialSummary = typeof ProjectSkillTrialSummary.Type;

/** One version plus the judgments bound to its exact ref and its trial history. */
export const ProjectSkillVersionView = Schema.Struct({
  version: ProjectSkillVersionRecord,
  judgments: Schema.Array(ProjectSkillJudgmentRecord),
  rightsRecorded: Schema.Boolean,
  reviewRecorded: Schema.Boolean,
  /**
   * Trial history for this exact version. Absent means the history is
   * unavailable — a server that predates trials, or one whose history read
   * failed. A failed read is never reported as an empty list: absent is not
   * the same as `[]`, which genuinely means no trials.
   */
  trials: Schema.optionalKey(Schema.Array(ProjectSkillTrialSummary)),
});
export type ProjectSkillVersionView = typeof ProjectSkillVersionView.Type;

/** `versions` are latest-first; judgments sort by sequence then id. */
export const ProjectSkillDetail = Schema.Struct({
  projectId: ProjectId,
  skillId: ProjectSkillId,
  latestVersion: PositiveInt,
  versions: Schema.Array(ProjectSkillVersionView),
  /**
   * The project's current lifecycle state sequence. Absent means unknown
   * because lifecycle capability is unavailable, never a swallowed read
   * failure. It is not defaulted to zero; `null` does not decode.
   */
  stateSeq: Schema.optionalKey(SafeNonNegInt),
});
export type ProjectSkillDetail = typeof ProjectSkillDetail.Type;

/** One row per skill, describing only its latest version. */
export const ProjectSkillSummary = Schema.Struct({
  ref: ProjectSkillVersionRef,
  title: Schema.String,
  state: ProjectSkillVersionState,
  createdAt: IsoDateTime,
  rightsRecorded: Schema.Boolean,
  reviewRecorded: Schema.Boolean,
});
export type ProjectSkillSummary = typeof ProjectSkillSummary.Type;

export const ProjectSkillListResult = Schema.Struct({
  items: Schema.Array(ProjectSkillSummary),
  truncated: Schema.Boolean,
});
export type ProjectSkillListResult = typeof ProjectSkillListResult.Type;

/** Where a new candidate's content came from; `message` must cite the source thread. */
export const ProjectSkillDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("typed") }),
  Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
  Schema.Struct({
    type: Schema.Literal("derived"),
    messageId: MessageId,
    /** Client equality pin only — the server recomputes authority at insert. */
    expectedSourceIdentitySha256: Sha256Hex,
  }),
]);
export type ProjectSkillDraft = typeof ProjectSkillDraft.Type;

/**
 * Saving a candidate. `expected` pins the exact receipt write the caller
 * observed — the observation itself is server-built; these three values are
 * all the client supplies.
 */
export const CreateProjectSkillCandidateInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  expected: ProjectSkillExpectedCheckTuple,
  content: ProjectSkillContent,
  draft: ProjectSkillDraft,
});
export type CreateProjectSkillCandidateInput = typeof CreateProjectSkillCandidateInput.Type;

export const DeriveProjectSkillReviewDraftInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  expected: ProjectSkillExpectedCheckTuple,
});
export type DeriveProjectSkillReviewDraftInput = typeof DeriveProjectSkillReviewDraftInput.Type;

export const DeriveProjectSkillReviewDraftResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    partial: ProjectSkillReviewDraftPartial,
    truncation: ProjectSkillReviewDraftTruncation,
    source: ProjectSkillCandidateSourceIdentity,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: ProjectSkillReviewDraftUnavailableReason,
  }),
]);
export type DeriveProjectSkillReviewDraftResult = typeof DeriveProjectSkillReviewDraftResult.Type;

/**
 * Revising a version. `expectedLatestVersion` is the optimistic-concurrency
 * guard: a stale value is a conflict, never an overwrite.
 */
export const ReviseProjectSkillInput = Schema.Struct({
  projectId: ProjectId,
  skillId: ProjectSkillId,
  fromVersion: PositiveInt,
  expectedLatestVersion: PositiveInt,
  content: ProjectSkillContent,
});
export type ReviseProjectSkillInput = typeof ReviseProjectSkillInput.Type;

export const PROJECT_SKILL_LIST_LIMIT = { default: 50, minimum: 1, maximum: 100 } as const;

export const ListProjectSkillsInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.Int.check(
    Schema.isBetween({
      minimum: PROJECT_SKILL_LIST_LIMIT.minimum,
      maximum: PROJECT_SKILL_LIST_LIMIT.maximum,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(PROJECT_SKILL_LIST_LIMIT.default))),
});
export type ListProjectSkillsInput = typeof ListProjectSkillsInput.Type;

export const GetProjectSkillInput = Schema.Struct({
  projectId: ProjectId,
  skillId: ProjectSkillId,
});
export type GetProjectSkillInput = typeof GetProjectSkillInput.Type;

/**
 * The judgment a client may record: `rights`, `review`, `reproduction`, and
 * `non-application`, and only the client fields of each — `judgmentId`,
 * `ref`, `recordedAt`, and `recordedBy` are server-filled, so supplying them
 * is ignored on decode and never honored.
 */
export const RecordableProjectSkillJudgment = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rights"),
    basis: Schema.Literals([
      "own-work",
      "project-license",
      "third-party-licensed",
      "permission-granted",
    ]),
    originalSource: Schema.NullOr(
      Schema.String.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.source)),
    ),
    license: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.license))),
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.note)),
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    provenanceChecked: Schema.Literal(true),
    privacyChecked: Schema.Literal(true),
    scopeChecked: Schema.Literal(true),
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.note)),
  }),
  Schema.Struct({
    kind: Schema.Literal("reproduction"),
    observedEvidenceId: ProjectSkillEvidenceId,
    procedureApplied: Schema.Literal(true),
    successConditionConfirmed: Schema.Literal(true),
    taskNotUsedForAuthoring: Schema.Literal(true),
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.note)),
  }),
  Schema.Struct({
    kind: Schema.Literal("non-application"),
    observedEvidenceId: ProjectSkillEvidenceId,
    taskDescription: TrimmedNonEmptyString,
    verdict: Schema.Literals(["correctly-not-applied", "harmful"]),
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.note)),
  }),
]);
export type RecordableProjectSkillJudgment = typeof RecordableProjectSkillJudgment.Type;

export const RecordProjectSkillJudgmentInput = Schema.Struct({
  ref: ProjectSkillVersionRef,
  judgment: RecordableProjectSkillJudgment,
});
export type RecordProjectSkillJudgmentInput = typeof RecordProjectSkillJudgmentInput.Type;

/** Withdrawal is one-way and names the exact version the judgment binds. */
export const WithdrawProjectSkillJudgmentInput = Schema.Struct({
  ref: ProjectSkillVersionRef,
  judgmentId: ProjectSkillJudgmentId,
});
export type WithdrawProjectSkillJudgmentInput = typeof WithdrawProjectSkillJudgmentInput.Type;

/** One-way withdrawal outcome: applied, or why nothing counted differently. */
export const ProjectSkillWithdrawResult = Schema.Struct({
  status: Schema.Literals(["applied", "not-found", "already-withdrawn"]),
});
export type ProjectSkillWithdrawResult = typeof ProjectSkillWithdrawResult.Type;

export const DeleteProjectSkillInput = Schema.Struct({
  projectId: ProjectId,
  skillId: ProjectSkillId,
  expectedLatestVersion: PositiveInt,
});
export type DeleteProjectSkillInput = typeof DeleteProjectSkillInput.Type;

/**
 * Whole-skill delete outcome. A stale caller gets `conflict` with the live
 * latest version so it can retry without a reread; `applied`/`not-found`
 * carry nothing.
 */
export const ProjectSkillDeleteResult = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["applied", "not-found"]) }),
  Schema.Struct({ status: Schema.Literal("conflict"), currentLatestVersion: PositiveInt }),
]);
export type ProjectSkillDeleteResult = typeof ProjectSkillDeleteResult.Type;

/**
 * Activating one exact version into a thread. A retired version's restore
 * sends this same request — there is no third RPC. `expectedStateSeq` is the
 * caller's last-read lifecycle state sequence: a stale value is refused as
 * `state-changed`, never an overwrite. `target` names the thread the managed
 * procedure is confirmed into and the nonempty project-script set it was
 * resolved against.
 */
export const ActivateProjectSkillInput = Schema.Struct({
  ref: ProjectSkillVersionRef,
  expectedStateSeq: SafeNonNegInt,
  target: Schema.Struct({
    threadId: ThreadId,
    scriptIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  }),
});
export type ActivateProjectSkillInput = typeof ActivateProjectSkillInput.Type;

/** Retiring one exact version, guarded by the same state sequence. */
export const RetireProjectSkillInput = Schema.Struct({
  ref: ProjectSkillVersionRef,
  expectedStateSeq: SafeNonNegInt,
});
export type RetireProjectSkillInput = typeof RetireProjectSkillInput.Type;

/** The project's new state sequence after an activate, restore, or retire. */
export const ProjectSkillTransitionResult = Schema.Struct({
  stateSeq: SafeNonNegInt,
});
export type ProjectSkillTransitionResult = typeof ProjectSkillTransitionResult.Type;

/** Mirrors the `reason` union of `evaluateSkillSource`; the detail strings stay server-side. */
export const ProjectSkillSourceRejectReason = Schema.Literals([
  "no-record",
  "record-malformed",
  "not-all-selected-passed",
  "observation-changed",
  "turn-running",
  "input-after-checks",
  "project-mismatch",
  "worktree-changed",
  "check-commands-changed",
]);
export type ProjectSkillSourceRejectReason = typeof ProjectSkillSourceRejectReason.Type;

/** Every rejection the store slice can surface; detail text never crosses the wire. */
export const ProjectSkillStoreRejectReason = Schema.Literals([
  "screen",
  "source-ineligible",
  "source-changed",
  "thread-missing",
  "project-missing",
  "draft-message-invalid",
  "judgment-kind-unavailable",
  "ref-mismatch",
  "duplicate-content",
  "not-ready",
  "state-changed",
  "state-invalid",
  "evidence-mismatch",
  "target-unconfirmed",
]);
export type ProjectSkillStoreRejectReason = typeof ProjectSkillStoreRejectReason.Type;

/**
 * A request the policy refuses without writing. `screenReasons` rides with
 * `screen`, `sourceReason` with `source-ineligible`, `existingVersion` with
 * `duplicate-content`, and `gaps` with `not-ready` — fixed fields only, no
 * source detail or raw JSON.
 */
export class ProjectSkillStoreRejectedError extends Schema.TaggedError<ProjectSkillStoreRejectedError>()(
  "ProjectSkillStoreRejectedError",
  {
    reason: ProjectSkillStoreRejectReason,
    screenReasons: Schema.optionalKey(Schema.Array(ProjectSkillScreenReason)),
    sourceReason: Schema.optionalKey(ProjectSkillSourceRejectReason),
    existingVersion: Schema.optionalKey(PositiveInt),
    gaps: Schema.optionalKey(Schema.Array(ProjectSkillReadinessGap)),
  },
) {}

export class ProjectSkillStoreConflictError extends Schema.TaggedError<ProjectSkillStoreConflictError>()(
  "ProjectSkillStoreConflictError",
  {
    currentLatestVersion: PositiveInt,
  },
) {}

export class ProjectSkillStoreNotFoundError extends Schema.TaggedError<ProjectSkillStoreNotFoundError>()(
  "ProjectSkillStoreNotFoundError",
  {},
) {}

/** Store/integrity failure with a fixed message — SQL causes never leave the server. */
export class ProjectSkillStoreError extends Schema.TaggedError<ProjectSkillStoreError>()(
  "ProjectSkillStoreError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
