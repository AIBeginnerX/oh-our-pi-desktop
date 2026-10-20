import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MessageId,
  PositiveInt,
  PROJECT_SKILL_CONTEXT_KIND,
  PROJECT_SKILL_REVIEW_DRAFT_DERIVATION_FORMAT,
  ProjectId,
  ProjectSkillCandidateSourceIdentity,
  ProjectSkillCheckObservation,
  ProjectSkillContent,
  ProjectSkillContextPayload,
  ProjectSkillDraft,
  ProjectSkillEvidenceScope,
  ProjectSkillHold,
  ProjectSkillHoldId,
  ProjectSkillId,
  ProjectSkillJudgment,
  ProjectSkillJudgmentId,
  ProjectSkillManagedSendEvidence,
  ProjectSkillObservedUse,
  ProjectSkillRetiredReason,
  ProjectSkillSource,
  ProjectSkillVersionRef,
  ProjectSkillVersionState,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  Sha256Hex,
  TASK_RESULT_ACTIVITY_KIND,
  TaskResultRecord,
  ThreadActivityAppendedPayload,
  ThreadId,
  ThreadMessageSentPayload,
  TurnId,
  canonicalProjectSkillCandidateSourceSeedJson,
  canonicalProjectSkillContentJson,
  deriveProjectSkillReadiness,
  deriveSkillReviewDraft,
  deriveTaskResultState,
  evaluateSkillSource,
  extractProjectSkillProcedureSection,
  selectedCheckReceiptId,
  taskResultRecordId,
} from "@t3tools/contracts";
import type {
  DeriveProjectSkillReviewDraftResult,
  DeriveSkillReviewDraftResult,
  ProjectSkillCandidateSourceSeed,
  ProjectSkillEnvironment,
  ProjectSkillEvidenceId,
  ProjectSkillJudgmentRecord,
  ProjectSkillReadinessGap,
  ProjectSkillReviewDraftUnavailableReason,
  ProjectSkillVersionRecord,
  SelectedChecksGetResult,
} from "@t3tools/contracts";

import { screenProjectSkillContent } from "../skills/skillContentScreen.ts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PersistenceErrorCorrelation,
  isPersistenceError,
} from "./Errors.ts";

/**
 * Stored project-skill candidates and their review judgments (S2: inactive
 * candidates only — no activation, admission, or hold writers here).
 *
 * The event store is the source authority for a candidate's provenance:
 * `insertCandidate` reads the receipt event back out of `orchestration_events`,
 * decodes the real `thread.activity-appended` wrapper and the
 * `SelectedCheckReceipt` nested in its activity payload, re-runs the shared
 * `evaluateSkillSource` policy over it, and stores the resulting full
 * observation only when it matches what the caller submitted. Every history
 * and liveness condition rides on the single INSERT statement, and the same
 * raw wrapper `payload_json` is pinned in its WHERE, so nothing can change
 * between verification and write. W (`created_after_event_sequence`) is
 * MAX(orchestration_events.sequence) measured inside the write statement —
 * the same event sequence space as receipt sequences, anchors, and input
 * events, never a client-supplied number.
 *
 * A `derived` draft adds one more source: the accepted, completed turn behind
 * the check. `deriveDraft` and `insertCandidate` both resolve it with the same
 * read (`resolveDraftSource`) — never from a client-chosen message or turn.
 * The insert runs that read inside the same transaction as its INSERT, which
 * holds the connection until it finishes, so the preview is never authority
 * at write time: the caller's pin only has to equal what that read resolves.
 * The stored draft carries the server-resolved source identity and an
 * `edited` flag computed by comparing all saved content to the resolved seed
 * (the exclusion the seed omits is itself an edit); a second save of the same
 * final content from the same source, edited or not, is a duplicate.
 */
export type ProjectSkillRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/**
 * The five committed-user-input event shapes this slice agrees on. This exact
 * predicate is shared by `latestUserInputSequence`, the candidate insert
 * guards, and the trial repository's window scans; assistant messages are
 * never user input. Built per client so the fragment interpolates into any
 * query on that client's transaction context.
 */
export const projectSkillInputEventPredicate = (sql: SqlClient.SqlClient) => sql`(
  (event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'user')
  OR event_type IN (
    'thread.turn-start-requested',
    'thread.user-input-response-requested',
    'thread.approval-response-requested',
    'thread.checkpoint-revert-requested'
  )
)`;

/** Mirrors the server receipt writer's command prefix (SelectedChecks write
 * path): "server:" + "selected-checks:" = 23 characters. It filters events
 * written in the known server format; it is not an author signature. */
export const SELECTED_CHECK_RECEIPT_COMMAND_PREFIX = "server:selected-checks:";

/** Mirrors the task-result writer's command prefix (TaskResult service):
 * "server:" + "task-result:". Like the receipt prefix it filters events
 * written in the known server format; it is not an author signature. */
export const TASK_RESULT_COMMAND_PREFIX = "server:task-result:";

// Decodes any stored `thread.activity-appended` wrapper — the receipt and the
// task-result record both ride in one.
const decodeReceiptActivityWrapper = Schema.decodeUnknownOption(
  Schema.fromJsonString(ThreadActivityAppendedPayload),
);
const decodeStoredSelectedCheckReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);
const decodeStoredTaskResultRecord = Schema.decodeUnknownOption(TaskResultRecord);
const decodeStoredMessageId = Schema.decodeUnknownOption(MessageId);
const decodeStoredTurnId = Schema.decodeUnknownOption(TurnId);

const sha256Hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Where a stored work source's draft came from. Unlike the client's
 * `ProjectSkillDraft`, a stored `derived` draft carries the server-resolved
 * source identity and whether the saved content differs from the server's
 * seed — neither is ever a client assertion.
 */
const StoredDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("typed") }),
  Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
  Schema.Struct({
    type: Schema.Literal("derived"),
    messageId: MessageId,
    sourceIdentity: ProjectSkillCandidateSourceIdentity,
    edited: Schema.Boolean,
  }),
]);
type StoredDraft = typeof StoredDraft.Type;

type DraftResolution =
  | {
      readonly status: "unavailable";
      readonly reason: ProjectSkillReviewDraftUnavailableReason;
    }
  | {
      readonly status: "available";
      readonly derived: Extract<DeriveSkillReviewDraftResult, { outcome: "available" }>;
    };

/**
 * Every field of the final content, compared against the seed to decide
 * `edited`. The seed deliberately has no `doesNotApplyWhen`; a missing
 * exclusion counts as empty, so the exclusion the user must add is itself an
 * edit of the incomplete generated draft.
 */
const DERIVED_CONTENT_FIELDS = [
  "title",
  "purpose",
  "appliesWhen",
  "doesNotApplyWhen",
  "procedure",
  "successCheck",
] as const;

const TASK_RESULT_REQUIREMENTS_DOMAIN = "oop-project-skill-task-requirements/v1\n";

/**
 * Decode one stored `thread.activity-appended` payload as this server's
 * selected-check receipt write for `threadId`: the wrapper and the receipt
 * nested in its activity payload must both bind the same thread.
 * `Option.none()` means the stored bytes are not that receipt — callers
 * decide whether that is a changed source or, in a history scan, a typed
 * integrity failure; it is never read as the absence of history.
 */
export const decodeSelectedCheckReceiptActivity = (
  payloadJson: string,
  threadId: ThreadId,
): Option.Option<SelectedCheckReceipt> => {
  const wrapper = decodeReceiptActivityWrapper(payloadJson);
  if (Option.isNone(wrapper) || wrapper.value.threadId !== threadId) return Option.none();
  const receipt = decodeStoredSelectedCheckReceipt(wrapper.value.activity.payload);
  if (Option.isSome(receipt) && receipt.value.threadId !== threadId) return Option.none();
  return receipt;
};

export type ProjectSkillCandidateOutcome =
  | { readonly status: "applied"; readonly row: ProjectSkillVersionRecord }
  | { readonly status: "project-missing" }
  | { readonly status: "thread-missing" }
  | { readonly status: "source-changed" }
  | { readonly status: "draft-message-invalid" }
  | { readonly status: "duplicate-content"; readonly existingVersion: number };

export type ProjectSkillRevisionOutcome =
  | { readonly status: "applied"; readonly row: ProjectSkillVersionRecord }
  | { readonly status: "not-found" }
  | { readonly status: "project-missing" }
  | { readonly status: "conflict"; readonly currentLatestVersion: number }
  | { readonly status: "duplicate-content"; readonly existingVersion: number };

export type ProjectSkillJudgmentOutcome =
  | { readonly status: "applied"; readonly row: ProjectSkillJudgmentRecord }
  | { readonly status: "ref-mismatch" }
  | { readonly status: "project-missing" };

export type ProjectSkillWithdrawOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-found" }
  | { readonly status: "already-withdrawn" };

export type ProjectSkillDeleteOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-found" }
  | { readonly status: "conflict"; readonly currentLatestVersion: number };

/** The full judgment rows this store accepts: rights and review only. */
export type ProjectSkillStorableJudgment = Extract<
  ProjectSkillJudgment,
  { kind: "rights" | "review" }
>;

/**
 * The evidence-backed judgment kinds this slice accepts: reproduction and
 * non-application, both binding a closed observed-use evidence identity.
 */
export type ProjectSkillEvidenceJudgment = Extract<
  ProjectSkillJudgment,
  { kind: "reproduction" | "non-application" }
>;

export type ProjectSkillEvidenceJudgmentOutcome =
  | { readonly status: "applied"; readonly row: ProjectSkillJudgmentRecord }
  | { readonly status: "project-missing" }
  | { readonly status: "ref-mismatch" }
  | { readonly status: "evidence-mismatch" }
  | { readonly status: "unsupported-kind" };

/**
 * One exact ref's lifecycle view, assembled the way
 * `deriveProjectSkillReadiness` consumes it: the stored version, every
 * active ref in the project (the caller subtracts the same-skill active for
 * the post-switch set), the ref's non-withdrawn judgments and stored
 * holds, the project state sequence, and the ref's observed uses decoded
 * from the closed ledger with their durable mode and verified managed
 * evidence.
 */
export interface ProjectSkillLifecycleRows {
  readonly version: ProjectSkillVersionRecord;
  readonly activeRefs: ReadonlyArray<ProjectSkillVersionRef>;
  readonly judgments: ReadonlyArray<ProjectSkillJudgment>;
  readonly holds: ReadonlyArray<ProjectSkillHold>;
  readonly stateSeq: number;
  readonly observedUses: ReadonlyArray<ProjectSkillObservedUse>;
}

export interface ProjectSkillHoldSweepOutcome {
  /** How many new hold rows the sweep wrote; reruns are idempotent. */
  readonly inserted: number;
}

export type ProjectSkillTransitionOutcome =
  | { readonly status: "applied"; readonly stateSeq: number }
  | { readonly status: "project-missing" }
  | { readonly status: "not-found" }
  | { readonly status: "state-changed"; readonly currentStateSeq: number }
  | { readonly status: "state-invalid" }
  | { readonly status: "not-ready"; readonly gaps: ReadonlyArray<ProjectSkillReadinessGap> };

export type ProjectSkillUseWorkAssessmentOutcome =
  | { readonly status: "ready" }
  | { readonly status: "project-missing" }
  | { readonly status: "not-found" }
  | { readonly status: "state-changed"; readonly currentStateSeq: number }
  | { readonly status: "not-ready"; readonly gaps: ReadonlyArray<ProjectSkillReadinessGap> };

export class ProjectSkillUseWorkAssessor extends Context.Service<
  ProjectSkillUseWorkAssessor,
  {
    /**
     * Transaction-neutral use readiness for one exact active target: the same
     * lifecycle assembly and `purpose: "use"` predicate as admission, without
     * starting a nested transaction. Dies outside the caller's SQL transaction.
     */
    readonly assessUseWork: (input: {
      readonly ref: ProjectSkillVersionRef;
      readonly expectedStateSeq: number;
      readonly current: ProjectSkillEnvironment;
    }) => Effect.Effect<ProjectSkillUseWorkAssessmentOutcome, ProjectSkillRepositoryError>;
  }
>()("t3/persistence/ProjectSkills/ProjectSkillUseWorkAssessor") {}

/** One skill's stored rows: every version (latest first) plus all its judgments. */
export interface ProjectSkillSkillRows {
  readonly versions: ReadonlyArray<ProjectSkillVersionRecord>;
  readonly judgments: ReadonlyArray<ProjectSkillJudgmentRecord>;
}

/** The latest version of each skill, with that exact ref's judgments. */
export interface ProjectSkillListRows {
  readonly items: ReadonlyArray<{
    readonly version: ProjectSkillVersionRecord;
    readonly judgments: ReadonlyArray<ProjectSkillJudgmentRecord>;
  }>;
  readonly truncated: boolean;
}

export class ProjectSkillRepository extends Context.Service<
  ProjectSkillRepository,
  {
    /** Max committed-user-input event sequence for the thread, or null. */
    readonly latestUserInputSequence: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<number | null, ProjectSkillRepositoryError>;
    /**
     * Store one inactive candidate. A `derived` draft carries only the
     * caller's equality pin: the source it names is re-resolved from the
     * event store and projections inside this same transaction as the INSERT,
     * and the identity and `edited` flag are computed here from that one
     * resolution; the caller's pin is only compared to it. `measured` is
     * the service's current-measurement view of the selected checks — the one
     * input storage cannot re-measure — and is required for `derived`.
     */
    readonly insertCandidate: (input: {
      readonly skillId: ProjectSkillId;
      readonly projectId: ProjectId;
      readonly content: ProjectSkillContent;
      readonly contentSha256: Sha256Hex;
      readonly check: ProjectSkillCheckObservation;
      readonly draft: ProjectSkillDraft;
      readonly measured?: SelectedChecksGetResult;
      readonly now: string;
    }) => Effect.Effect<ProjectSkillCandidateOutcome, ProjectSkillRepositoryError>;
    /**
     * Resolve the one accepted source turn behind a passed check and derive
     * the review-draft seed from it, read-only. `check` is the verified
     * observation the caller built from the thread's receipt; `measured` is
     * the service's measured selected-check view. Anything short of a fully
     * coherent source reads `no-coherent-source`; the raw source bytes never
     * leave this method.
     */
    readonly deriveDraft: (input: {
      readonly projectId: ProjectId;
      readonly check: ProjectSkillCheckObservation;
      readonly measured: SelectedChecksGetResult;
    }) => Effect.Effect<DeriveProjectSkillReviewDraftResult, ProjectSkillRepositoryError>;
    readonly insertRevision: (input: {
      readonly projectId: ProjectId;
      readonly skillId: ProjectSkillId;
      readonly fromVersion: number;
      readonly expectedLatestVersion: number;
      readonly content: ProjectSkillContent;
      readonly contentSha256: Sha256Hex;
      readonly now: string;
    }) => Effect.Effect<ProjectSkillRevisionOutcome, ProjectSkillRepositoryError>;
    readonly listSkills: (input: {
      readonly projectId: ProjectId;
      readonly limit: number;
    }) => Effect.Effect<ProjectSkillListRows, ProjectSkillRepositoryError>;
    readonly getSkill: (input: {
      readonly projectId: ProjectId;
      readonly skillId: ProjectSkillId;
    }) => Effect.Effect<Option.Option<ProjectSkillSkillRows>, ProjectSkillRepositoryError>;
    readonly insertJudgment: (input: {
      readonly judgment: ProjectSkillStorableJudgment;
    }) => Effect.Effect<ProjectSkillJudgmentOutcome, ProjectSkillRepositoryError>;
    /**
     * Store a reproduction or non-application judgment whose
     * `observedEvidenceId` names a closed, provider-accepted observed use
     * bound to the same exact full ref. Storage enforces existence only —
     * whether the evidence actually makes the judgment eligible is the
     * shared pure readiness predicate's call at transition time.
     */
    readonly insertEvidenceJudgment: (input: {
      readonly judgment: ProjectSkillEvidenceJudgment;
    }) => Effect.Effect<ProjectSkillEvidenceJudgmentOutcome, ProjectSkillRepositoryError>;
    /** One exact ref's full lifecycle view; `Option.none()` when the
        version row or its live project is gone. */
    readonly readLifecycle: (input: {
      readonly ref: ProjectSkillVersionRef;
    }) => Effect.Effect<Option.Option<ProjectSkillLifecycleRows>, ProjectSkillRepositoryError>;
    /**
     * Write durable `failure-observed` holds for this ref's closed, failed
     * observed uses whose durable mode is `use` — exactly the deterministic
     * holds `transitionState`'s readiness derives on the fly. Idempotent on
     * the evidence-kind unique key; open windows and unknown deliveries
     * produce no holds. `now` stamps any new row's `created_at`.
     */
    readonly sweepFailedUseHolds: (input: {
      readonly ref: ProjectSkillVersionRef;
      readonly now: string;
    }) => Effect.Effect<ProjectSkillHoldSweepOutcome, ProjectSkillRepositoryError>;
    /**
     * Activate or retire one exact ref inside a single transaction.
     * `expectedStateSeq` is the optimistic-concurrency guard on the project
     * state sequence — it is re-checked inside every writing statement, so
     * a raced write lands as `state-changed`, never a partial switch.
     * Activation additionally requires `current`: the server-derived typed
     * `ProjectSkillEnvironment` of the intended target context — never a
     * browser-reported environment and never inferred from the latest
     * stored use. The pure `deriveProjectSkillReadiness` decides whether
     * the post-switch state may activate; a `not-ready` outcome carries
     * its gaps and writes nothing. Readiness counts the ref's derived
     * failure holds together with the stored ones, so a closed failed
     * `use` observation blocks its own target from the moment it exists —
     * before `sweepFailedUseHolds` persists it — and never another ref's.
     * Retire is the explicit `user-retired` transition on an active version.
     */
    readonly transitionState: (
      input:
        | {
            readonly ref: ProjectSkillVersionRef;
            readonly expectedStateSeq: number;
            readonly to: "retired";
          }
        | {
            readonly ref: ProjectSkillVersionRef;
            readonly expectedStateSeq: number;
            readonly to: "active";
            readonly current: ProjectSkillEnvironment;
          },
    ) => Effect.Effect<ProjectSkillTransitionOutcome, ProjectSkillRepositoryError>;
    readonly withdrawJudgment: (input: {
      readonly ref: ProjectSkillVersionRef;
      readonly judgmentId: ProjectSkillJudgmentId;
      readonly now: string;
    }) => Effect.Effect<ProjectSkillWithdrawOutcome, ProjectSkillRepositoryError>;
    readonly deleteSkill: (input: {
      readonly projectId: ProjectId;
      readonly skillId: ProjectSkillId;
      readonly expectedLatestVersion: number;
    }) => Effect.Effect<ProjectSkillDeleteOutcome, ProjectSkillRepositoryError>;
  }
>()("t3/persistence/ProjectSkills/ProjectSkillRepository") {}

/** Same safe-int bound the S1 sequence fields use (private there). */
const SafeNonNegInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** `source_json` strips only the top-level watermark; the root keeps its own. */
const StoredWorkSource = Schema.Struct({
  type: Schema.Literal("work"),
  check: ProjectSkillCheckObservation,
  draft: StoredDraft,
});
const FullWorkSource = Schema.Struct({
  type: Schema.Literal("work"),
  check: ProjectSkillCheckObservation,
  createdAfterEventSequence: SafeNonNegInt,
  draft: StoredDraft,
});
const StoredSource = Schema.Union([
  StoredWorkSource,
  Schema.Struct({
    type: Schema.Literal("revision"),
    fromVersion: PositiveInt,
    root: FullWorkSource,
  }),
]);

const VersionRawDbRow = Schema.Struct({
  skillId: Schema.Unknown,
  projectId: Schema.Unknown,
  version: Schema.Unknown,
  contentJson: Schema.Unknown,
  contentSha256: Schema.Unknown,
  sourceJson: Schema.Unknown,
  sourceThreadId: Schema.Unknown,
  sourceReceiptSequence: Schema.Unknown,
  sourceThreadCreatedSequence: Schema.Unknown,
  createdAfterEventSequence: Schema.Unknown,
  state: Schema.Unknown,
  retiredReason: Schema.Unknown,
  createdAt: Schema.Unknown,
});

const VersionDbRow = Schema.Struct({
  skillId: ProjectSkillId,
  projectId: ProjectId,
  version: PositiveInt,
  contentJson: Schema.String,
  contentSha256: Sha256Hex,
  sourceJson: Schema.String,
  sourceThreadId: ThreadId,
  sourceReceiptSequence: SafeNonNegInt,
  sourceThreadCreatedSequence: SafeNonNegInt,
  createdAfterEventSequence: SafeNonNegInt,
  state: ProjectSkillVersionState,
  retiredReason: Schema.NullOr(ProjectSkillRetiredReason),
  createdAt: Schema.String,
});

const JudgmentRawDbRow = Schema.Struct({
  judgmentId: Schema.Unknown,
  projectId: Schema.Unknown,
  skillId: Schema.Unknown,
  version: Schema.Unknown,
  contentSha256: Schema.Unknown,
  kind: Schema.Unknown,
  judgmentJson: Schema.Unknown,
  recordedAfterEventSequence: Schema.Unknown,
  withdrawnAt: Schema.Unknown,
});

const JudgmentDbRow = Schema.Struct({
  judgmentId: ProjectSkillJudgmentId,
  projectId: ProjectId,
  skillId: ProjectSkillId,
  version: PositiveInt,
  contentSha256: Sha256Hex,
  kind: Schema.String,
  judgmentJson: Schema.String,
  recordedAfterEventSequence: SafeNonNegInt,
  withdrawnAt: Schema.NullOr(Schema.String),
});

const SourceThreadRawDbRow = Schema.Struct({
  projectId: Schema.Unknown,
  worktreePath: Schema.Unknown,
});

const SourceThreadDbRow = Schema.Struct({
  projectId: ProjectId,
  worktreePath: Schema.NullOr(Schema.String),
});

/**
 * One observed-use row joined to the input ledger row it closed under, plus
 * the canonical accepted message event LEFT JOINed by its committed sequence.
 * `check_json`, the ledger's frozen `ProjectSkillCheckObservation`, is the
 * check the window produced; the input columns carry the canonical accepted
 * event binding and the optional managed-send capture. A missing canonical
 * event leaves the payload null and stays an integrity failure in the mapper
 * — never a silently omitted evidence row.
 */
const ObservedUseJoinedRow = Schema.Struct({
  evidenceId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  attemptId: Schema.String,
  checkJson: Schema.String,
  receiptSequence: SafeNonNegInt,
  outcome: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  inputProjectId: Schema.String,
  inputSkillId: Schema.String,
  inputVersion: SafeNonNegInt,
  inputContentSha256: Schema.String,
  inputEventSequence: SafeNonNegInt,
  admittedSkillStateSeq: Schema.NullOr(SafeNonNegInt),
  providerDriverKind: Schema.NullOr(Schema.String),
  nativeSkillInventorySha256: Schema.NullOr(Schema.String),
  managedSendJson: Schema.NullOr(Schema.String),
  inputEventPayloadJson: Schema.NullOr(Schema.String),
});

const HoldDbRow = Schema.Struct({
  holdId: ProjectSkillHoldId,
  projectId: Schema.String,
  skillId: Schema.String,
  version: PositiveInt,
  contentSha256: Schema.String,
  kind: Schema.String,
  evidenceScope: Schema.NullOr(ProjectSkillEvidenceScope),
  threadId: Schema.String,
  messageId: Schema.String,
  attemptId: Schema.String,
  observedAtEventSequence: SafeNonNegInt,
  holdJson: Schema.String,
});

/**
 * Deterministic JSON text for plain decoded data: object keys sort
 * recursively, array order is preserved. Comparing two observations by this
 * text is a field-for-field comparison that never depends on property
 * insertion order.
 */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

function toRepositoryError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ProjectSkillRepositoryError =>
    // Persistence errors raised inside a transaction (the decode helpers)
    // keep their tag; only raw driver/schema failures are wrapped.
    isPersistenceError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
        : new PersistenceSqlError({
            operation: sqlOperation,
            ...(correlation === undefined ? {} : { correlation }),
            cause,
          });
}

const projectSkillRefEquals = (a: ProjectSkillVersionRef, b: ProjectSkillVersionRef): boolean =>
  a.projectId === b.projectId &&
  a.skillId === b.skillId &&
  a.version === b.version &&
  a.contentSha256 === b.contentSha256;

/** @public Service construction is part of the canonical Effect module API. */
const makeShared = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeVersionDbRow = Schema.decodeUnknownEffect(VersionDbRow);
  const decodeJudgmentDbRow = Schema.decodeUnknownEffect(JudgmentDbRow);
  const decodeSourceThreadRow = Schema.decodeUnknownEffect(SourceThreadDbRow);
  const decodeContentJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectSkillContent));
  const decodeStoredSourceJson = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSource));
  const decodeFullSource = Schema.decodeUnknownEffect(ProjectSkillSource);
  const decodeJudgmentJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ProjectSkillJudgment),
  );

  // Stored-row decode failures are integrity failures: they surface as typed
  // decode errors, never as empty reads.
  const decodeStored = <A, Services>(
    effect: Effect.Effect<A, Schema.SchemaError, Services>,
    operation: string,
  ): Effect.Effect<A, PersistenceDecodeError, Services> =>
    effect.pipe(
      Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
    );

  const versionColumns = sql`
    v.skill_id AS "skillId",
    v.project_id AS "projectId",
    v.version AS "version",
    v.content_json AS "contentJson",
    v.content_sha256 AS "contentSha256",
    v.source_json AS "sourceJson",
    v.source_thread_id AS "sourceThreadId",
    v.source_receipt_sequence AS "sourceReceiptSequence",
    v.source_thread_created_sequence AS "sourceThreadCreatedSequence",
    v.created_after_event_sequence AS "createdAfterEventSequence",
    v.state AS "state",
    v.retired_reason AS "retiredReason",
    v.created_at AS "createdAt"
  `;

  const judgmentColumns = sql`
    j.judgment_id AS "judgmentId",
    j.project_id AS "projectId",
    j.skill_id AS "skillId",
    j.version AS "version",
    j.content_sha256 AS "contentSha256",
    j.kind AS "kind",
    j.judgment_json AS "judgmentJson",
    j.recorded_after_event_sequence AS "recordedAfterEventSequence",
    j.withdrawn_at AS "withdrawnAt"
  `;

  // Reads and writes alike hide rows whose project row was raw-deleted from
  // the projection — only the tombstone trigger may remove skill data.
  const liveProjectFor = (projectId: string) => sql`
    EXISTS (
      SELECT 1 FROM projection_projects p
      WHERE p.project_id = ${projectId} AND p.deleted_at IS NULL
    )
  `;

  const inputEventPredicate = projectSkillInputEventPredicate(sql);

  const toVersionRecord = (
    raw: unknown,
  ): Effect.Effect<ProjectSkillVersionRecord, PersistenceDecodeError> =>
    Effect.gen(function* () {
      const row = yield* decodeStored(
        decodeVersionDbRow(raw),
        "ProjectSkillRepository.decodeVersion:row",
      );
      const content = yield* decodeStored(
        decodeContentJson(row.contentJson),
        "ProjectSkillRepository.decodeVersion:content",
      );
      const storedSource = yield* decodeStored(
        decodeStoredSourceJson(row.sourceJson),
        "ProjectSkillRepository.decodeVersion:source",
      );
      const source = yield* decodeStored(
        decodeFullSource({
          ...storedSource,
          createdAfterEventSequence: row.createdAfterEventSequence,
        }),
        "ProjectSkillRepository.decodeVersion:source-shape",
      );
      // The lineage columns must name the stored root work source, and that
      // root must live in this row's own project.
      const rootCheck = storedSource.type === "work" ? storedSource.check : storedSource.root.check;
      if (
        rootCheck.projectId !== row.projectId ||
        rootCheck.threadId !== row.sourceThreadId ||
        rootCheck.receiptSequence !== row.sourceReceiptSequence
      ) {
        return yield* new PersistenceDecodeError({
          operation: "ProjectSkillRepository.decodeVersion:lineage",
          issue: "source lineage columns disagree with the stored source",
        });
      }
      return {
        ref: {
          projectId: row.projectId,
          skillId: row.skillId,
          version: row.version,
          contentSha256: row.contentSha256,
        },
        content,
        source,
        state: row.state,
        retiredReason: row.retiredReason,
        createdAt: row.createdAt,
      };
    });

  const toJudgmentRecord = (
    raw: unknown,
  ): Effect.Effect<ProjectSkillJudgmentRecord, PersistenceDecodeError> =>
    Effect.gen(function* () {
      const row = yield* decodeStored(
        decodeJudgmentDbRow(raw),
        "ProjectSkillRepository.decodeJudgment:row",
      );
      const judgment = yield* decodeStored(
        decodeJudgmentJson(row.judgmentJson),
        "ProjectSkillRepository.decodeJudgment:json",
      );
      // The columns and the stored JSON must bind the same judgment.
      if (
        judgment.judgmentId !== row.judgmentId ||
        judgment.kind !== row.kind ||
        judgment.ref.projectId !== row.projectId ||
        judgment.ref.skillId !== row.skillId ||
        judgment.ref.version !== row.version ||
        judgment.ref.contentSha256 !== row.contentSha256
      ) {
        return yield* new PersistenceDecodeError({
          operation: "ProjectSkillRepository.decodeJudgment:binding",
          issue: "judgment columns disagree with the stored judgment",
        });
      }
      return {
        judgment,
        recordedAfterEventSequence: row.recordedAfterEventSequence,
        withdrawnAt: row.withdrawnAt,
      };
    });

  const decodeObservedUseJoinedRow = Schema.decodeUnknownEffect(ObservedUseJoinedRow);
  const decodeHoldDbRow = Schema.decodeUnknownEffect(HoldDbRow);
  const decodeCheckJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ProjectSkillCheckObservation),
  );
  const decodeManagedSendJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ProjectSkillManagedSendEvidence),
  );
  const decodeInputMessageJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ThreadMessageSentPayload),
  );
  const decodeContextPayload = Schema.decodeUnknownOption(ProjectSkillContextPayload);
  const decodeHoldJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectSkillHold));
  const decodeObservedUseShape = Schema.decodeUnknownEffect(ProjectSkillObservedUse);
  const decodeActiveRefRow = Schema.decodeUnknownEffect(ProjectSkillVersionRef);

  const stateSequence = Effect.fnUntraced(function* (projectId: string) {
    const rows = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM project_skill_state WHERE project_id = ${projectId}
    `;
    return rows[0]?.seq ?? 0;
  });

  const isProjectLive = Effect.fnUntraced(function* (projectId: string) {
    const rows = yield* sql<{ readonly live: number }>`
      SELECT ${liveProjectFor(projectId)} AS "live"
    `;
    return rows[0]?.live === 1;
  });

  const invalidInput = (operation: string) =>
    Effect.fail(new PersistenceSqlError({ operation, detail: "invalid-input" }));

  const requireInTransaction = (operation: string) =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (active) =>
      Option.isNone(active)
        ? Effect.fail(new PersistenceSqlError({ operation, detail: "outside-transaction" }))
        : Effect.void,
    );

  const safeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const validRef = (ref: ProjectSkillVersionRef) => safeInt(ref.version) && ref.version >= 1;

  /**
   * One stored observed-use row re-assembled as the typed contract shape:
   * the ledger's frozen check, the canonical accepted user-message event
   * (LEFT JOINed into the same read by its committed sequence — a missing
   * event is a ledger integrity failure, never an absent observation), the
   * input's durable admitted context record (the only mode authority — never
   * hardcoded), and managed-send evidence reconstructed only when the stored
   * JSON decodes fully and binds this exact ref. Anything short of that is a
   * typed integrity failure; a NULL `managed_send_json` is simply an absent
   * label and stays legacy.
   */
  const toObservedUse = (
    operation: string,
    ref: ProjectSkillVersionRef,
    raw: unknown,
  ): Effect.Effect<ProjectSkillObservedUse, PersistenceDecodeError> =>
    Effect.gen(function* () {
      const row = yield* decodeStored(decodeObservedUseJoinedRow(raw), `${operation}:observed-row`);
      if (
        row.inputProjectId !== ref.projectId ||
        row.inputSkillId !== ref.skillId ||
        row.inputVersion !== ref.version ||
        row.inputContentSha256 !== ref.contentSha256
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:observed-binding`,
          issue: "the input ledger row does not bind the observed-use ref",
        });
      }
      const check = yield* decodeStored(
        decodeCheckJson(row.checkJson),
        `${operation}:observed-check`,
      );
      if (
        check.threadId !== row.threadId ||
        check.projectId !== ref.projectId ||
        check.attemptId !== row.attemptId ||
        check.receiptSequence !== row.receiptSequence ||
        check.outcome !== row.outcome ||
        check.endedAt !== row.endedAt
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:observed-check-binding`,
          issue: "check columns disagree with the stored observation",
        });
      }
      // The LEFT JOIN found no committed message event for the input's
      // sequence: a ledger integrity failure, never an absent observation.
      if (row.inputEventPayloadJson === null) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:input-event`,
          issue: "the input ledger names a committed message event that does not exist",
        });
      }
      const message = yield* decodeStored(
        decodeInputMessageJson(row.inputEventPayloadJson),
        `${operation}:input-event-payload`,
      );
      if (
        message.threadId !== row.threadId ||
        message.messageId !== row.messageId ||
        message.role !== "user"
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:input-event-binding`,
          issue: "the canonical message event does not bind the ledger identity",
        });
      }
      // The record the admission actually stored for this ref — a message
      // may carry other project-skill records the ledger does not attest.
      let admitted:
        | { readonly ref: ProjectSkillVersionRef; readonly mode: "use" | "trial" }
        | undefined;
      for (const record of message.context?.records ?? []) {
        if (record.kind !== PROJECT_SKILL_CONTEXT_KIND) continue;
        const payload = decodeContextPayload(record.payload);
        if (Option.isNone(payload)) {
          return yield* new PersistenceDecodeError({
            operation: `${operation}:context-payload`,
            issue: "a project-skill context record carries a malformed payload",
          });
        }
        const recordRef = payload.value.ref;
        if (
          recordRef.projectId === ref.projectId &&
          recordRef.skillId === ref.skillId &&
          recordRef.version === ref.version &&
          recordRef.contentSha256 === ref.contentSha256
        ) {
          admitted = { ref: recordRef, mode: payload.value.mode };
          // A stamped record must agree with the ledger column; a record
          // written before the stamp existed simply carries nothing.
          if (
            payload.value.admittedSkillStateSeq !== undefined &&
            payload.value.admittedSkillStateSeq !== row.admittedSkillStateSeq
          ) {
            return yield* new PersistenceDecodeError({
              operation: `${operation}:context-stamp`,
              issue: "the durable admission stamp disagrees with the ledger row",
            });
          }
          break;
        }
      }
      if (admitted === undefined) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:context-record`,
          issue: "the canonical message carries no admitted record for the ledger ref",
        });
      }
      // Managed evidence exists only when the stored label decodes fully
      // and binds this ref — a missing label is the legacy meaning, never
      // inferred from a null inventory digest.
      const managedSend =
        row.managedSendJson === null
          ? undefined
          : yield* decodeStored(
              decodeManagedSendJson(row.managedSendJson),
              `${operation}:managed-send`,
            );
      if (
        managedSend !== undefined &&
        !(
          managedSend.deliveredRef.projectId === ref.projectId &&
          managedSend.deliveredRef.skillId === ref.skillId &&
          managedSend.deliveredRef.version === ref.version &&
          managedSend.deliveredRef.contentSha256 === ref.contentSha256
        )
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:managed-binding`,
          issue: "the stored managed-send evidence names a different ref",
        });
      }
      return yield* decodeStored(
        decodeObservedUseShape({
          evidenceId: row.evidenceId,
          input: {
            threadId: row.threadId,
            projectId: row.inputProjectId,
            messageId: row.messageId,
            inputEventSequence: row.inputEventSequence,
            admittedSkillStateSeq: row.admittedSkillStateSeq ?? 0,
            providerDriverKind: row.providerDriverKind,
            nativeSkillInventorySha256: row.nativeSkillInventorySha256,
            items: [admitted],
            ...(managedSend === undefined ? {} : { managedSend }),
          },
          check,
        }),
        `${operation}:observed-use`,
      );
    });

  // Closed, provider-accepted, tombstone-free observed uses bound to the
  // exact ref, in the ledger's deterministic order, with the canonical
  // accepted message event LEFT JOINed by its committed sequence. Open
  // windows and unverified deliveries are stored facts but never evidence —
  // the WHERE clause, not a skipped row, is what excludes them. SQL failures
  // map at the public transaction boundary; decode failures keep their typed
  // labels in the mapper.
  const observedUsesForRef = (operation: string, ref: ProjectSkillVersionRef) =>
    Effect.gen(function* () {
      const rawRows: ReadonlyArray<unknown> = yield* sql`
        SELECT u.evidence_id AS "evidenceId", u.thread_id AS "threadId",
          u.message_id AS "messageId", u.attempt_id AS "attemptId",
          u.check_json AS "checkJson", u.receipt_sequence AS "receiptSequence",
          u.outcome AS "outcome", u.ended_at AS "endedAt",
          i.project_id AS "inputProjectId", i.skill_id AS "inputSkillId",
          i.version AS "inputVersion", i.content_sha256 AS "inputContentSha256",
          i.input_event_sequence AS "inputEventSequence",
          i.admitted_skill_state_seq AS "admittedSkillStateSeq",
          i.provider_driver_kind AS "providerDriverKind",
          i.native_skill_inventory_sha256 AS "nativeSkillInventorySha256",
          i.managed_send_json AS "managedSendJson",
          inputEvent.payload_json AS "inputEventPayloadJson"
        FROM project_skill_observed_uses u
        JOIN project_skill_inputs i
          ON i.thread_id = u.thread_id AND i.message_id = u.message_id
        LEFT JOIN orchestration_events inputEvent
          ON inputEvent.sequence = i.input_event_sequence
          AND inputEvent.aggregate_kind = 'thread'
          AND inputEvent.stream_id = u.thread_id
          AND inputEvent.event_type = 'thread.message-sent'
        WHERE u.project_id = ${ref.projectId}
          AND u.skill_id = ${ref.skillId}
          AND u.version = ${ref.version}
          AND u.content_sha256 = ${ref.contentSha256}
          AND i.tombstoned_at IS NULL
          AND i.window = 'closed'
          AND i.delivery = 'provider-accepted'
          AND i.project_id = ${ref.projectId}
          AND i.skill_id = ${ref.skillId}
          AND i.version = ${ref.version}
          AND i.content_sha256 = ${ref.contentSha256}
          AND ${liveProjectFor(ref.projectId)}
        ORDER BY u.receipt_sequence ASC, u.evidence_id ASC
      `;
      const uses: Array<ProjectSkillObservedUse> = [];
      for (const raw of rawRows) {
        uses.push(yield* toObservedUse(operation, ref, raw));
      }
      return uses;
    });

  const toHold = (
    operation: string,
    raw: unknown,
  ): Effect.Effect<ProjectSkillHold, PersistenceDecodeError> =>
    Effect.gen(function* () {
      const row = yield* decodeStored(decodeHoldDbRow(raw), `${operation}:hold-row`);
      const hold = yield* decodeStored(decodeHoldJson(row.holdJson), `${operation}:hold-json`);
      // The columns and the stored JSON must bind the same hold.
      if (
        hold.holdId !== row.holdId ||
        hold.kind !== row.kind ||
        (hold.evidenceScope ?? null) !== row.evidenceScope ||
        hold.observedAtEventSequence !== row.observedAtEventSequence ||
        hold.ref.projectId !== row.projectId ||
        hold.ref.skillId !== row.skillId ||
        hold.ref.version !== row.version ||
        hold.ref.contentSha256 !== row.contentSha256
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:hold-binding`,
          issue: "hold columns disagree with the stored hold",
        });
      }
      return hold;
    });

  // The shared lifecycle read one exact ref produces for readiness: its
  // non-withdrawn judgments, its stored holds, every active ref in the
  // project, and the assembled observed uses — all inside the caller's
  // transaction so the view cannot mix snapshots. SQL failures map at the
  // public transaction boundary; decode failures keep their typed labels.
  const lifecycleReadsFor = (operation: string, ref: ProjectSkillVersionRef) =>
    Effect.gen(function* () {
      const rawJudgments: ReadonlyArray<unknown> = yield* sql<typeof JudgmentRawDbRow.Type>`
        SELECT ${judgmentColumns}
        FROM project_skill_judgments j
        WHERE j.project_id = ${ref.projectId}
          AND j.skill_id = ${ref.skillId}
          AND j.version = ${ref.version}
          AND j.content_sha256 = ${ref.contentSha256}
          AND j.withdrawn_at IS NULL
          AND ${liveProjectFor(ref.projectId)}
        ORDER BY j.recorded_after_event_sequence ASC, j.judgment_id ASC
      `;
      const judgmentRecords = yield* Effect.forEach(rawJudgments, toJudgmentRecord);
      const rawHolds: ReadonlyArray<unknown> = yield* sql`
        SELECT hold_id AS "holdId", project_id AS "projectId",
          skill_id AS "skillId", version AS "version",
          content_sha256 AS "contentSha256", kind AS "kind",
          evidence_scope AS "evidenceScope", thread_id AS "threadId",
          message_id AS "messageId", attempt_id AS "attemptId",
          observed_at_event_sequence AS "observedAtEventSequence",
          hold_json AS "holdJson"
        FROM project_skill_holds
        WHERE project_id = ${ref.projectId}
          AND skill_id = ${ref.skillId}
          AND version = ${ref.version}
          AND content_sha256 = ${ref.contentSha256}
          AND ${liveProjectFor(ref.projectId)}
        ORDER BY observed_at_event_sequence ASC, hold_id ASC
      `;
      const holds = yield* Effect.forEach(rawHolds, (raw) => toHold(operation, raw));
      const rawActives: ReadonlyArray<unknown> = yield* sql`
        SELECT project_id AS "projectId", skill_id AS "skillId",
          version AS "version", content_sha256 AS "contentSha256"
        FROM project_skill_versions v
        WHERE v.project_id = ${ref.projectId}
          AND v.state = 'active'
          AND ${liveProjectFor(ref.projectId)}
        ORDER BY v.skill_id ASC, v.version ASC
      `;
      const activeRefs = yield* Effect.forEach(rawActives, (raw) =>
        decodeStored(decodeActiveRefRow(raw), `${operation}:actives`),
      );
      const observedUses = yield* observedUsesForRef(operation, ref);
      return {
        activeRefs,
        judgments: judgmentRecords.map((record) => record.judgment),
        holds,
        observedUses,
      };
    });

  // The transaction-neutral exact-full-ref read shared by the lifecycle view,
  // the transition's readiness snapshot, and evidence-judgment refusal
  // diagnosis: version columns, the full four-field ref, the live-project
  // predicate, and the same record decode. Never a new transaction and never
  // a weaker skillId/version key.
  const exactRefVersion = Effect.fnUntraced(function* (ref: ProjectSkillVersionRef) {
    const rawVersions: ReadonlyArray<unknown> = yield* sql`
      SELECT ${versionColumns}
      FROM project_skill_versions v
      WHERE v.project_id = ${ref.projectId}
        AND v.skill_id = ${ref.skillId}
        AND v.version = ${ref.version}
        AND v.content_sha256 = ${ref.contentSha256}
        AND ${liveProjectFor(ref.projectId)}
    `;
    const rawVersion = rawVersions[0];
    if (rawVersion === undefined) return Option.none();
    return Option.some(yield* toVersionRecord(rawVersion));
  });

  /**
   * The deterministic failed-use holds one exact ref's assembled observations
   * stand for, whether or not a sweep has persisted them yet: the assembly
   * already guarantees closure and provider acceptance, so a failed
   * `use`-mode check is a standing block the moment the row exists.
   * `sweepFailedUseHolds` persists exactly these rows, and `transitionState`
   * feeds them to readiness in its own snapshot, so an unswept failure
   * vetoes its own target — and never another ref's — without waiting for an
   * external sweep.
   */
  const deriveFailureHolds = (
    ref: ProjectSkillVersionRef,
    uses: ReadonlyArray<ProjectSkillObservedUse>,
  ): Effect.Effect<
    ReadonlyArray<{
      readonly hold: ProjectSkillHold;
      readonly evidence: Pick<ProjectSkillObservedUse["input"], "threadId" | "messageId"> & {
        readonly attemptId: string;
      };
    }>,
    PersistenceDecodeError
  > =>
    Effect.gen(function* () {
      const entries: Array<{
        readonly hold: ProjectSkillHold;
        readonly evidence: Pick<ProjectSkillObservedUse["input"], "threadId" | "messageId"> & {
          readonly attemptId: string;
        };
      }> = [];
      for (const use of uses) {
        const check = use.check;
        if (check === null || check.outcome !== "failed") continue;
        const item = use.input.items.find(
          (candidate) =>
            candidate.ref.projectId === ref.projectId &&
            candidate.ref.skillId === ref.skillId &&
            candidate.ref.version === ref.version &&
            candidate.ref.contentSha256 === ref.contentSha256,
        );
        if (item === undefined) {
          return yield* new PersistenceDecodeError({
            operation: "ProjectSkillRepository.failureHolds:item",
            issue: "an assembled observed use does not carry the ref it is bound to",
          });
        }
        // Rows whose durable mode is `trial` are trial history, not lifecycle
        // failures.
        if (item.mode !== "use") continue;
        // The scope names the evidence the row actually carries: a bound
        // managed capture marks managed evidence, anything else stays the
        // unmarked legacy scope — never inferred.
        const evidenceScope = use.input.managedSend === undefined ? null : "managed-procedure/v1";
        // The id is the sha256 of the canonical JSON array of the full ref
        // plus the evidence identity and kind: an injective encoding, so
        // distinct evidence never collides and the sweep's rows hash
        // identically to what readiness derived.
        const holdId = ProjectSkillHoldId.make(
          `psh_${NodeCrypto.createHash("sha256")
            .update(
              canonicalJson([
                ref,
                use.input.threadId,
                use.input.messageId,
                check.attemptId,
                "failure-observed",
              ]),
            )
            .digest("hex")}`,
        );
        entries.push({
          hold: {
            holdId,
            ref,
            kind: "failure-observed",
            observedAtEventSequence: check.receiptSequence,
            failure: check,
            environment: null,
            ...(evidenceScope === null ? {} : { evidenceScope }),
          },
          evidence: {
            threadId: use.input.threadId,
            messageId: use.input.messageId,
            attemptId: check.attemptId,
          },
        });
      }
      return entries;
    });

  const latestUserInputSequence: ProjectSkillRepository["Service"]["latestUserInputSequence"] = (
    input,
  ) =>
    sql<{ readonly latest: number | null }>`
      SELECT MAX(sequence) AS "latest"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
        AND ${inputEventPredicate}
    `.pipe(
      Effect.map((rows) => rows[0]?.latest ?? null),
      // A failed read must never be reported as "no user input".
      Effect.mapError(
        toRepositoryError("ProjectSkillRepository.latestUserInputSequence:query", "n/a", {
          threadId: input.threadId,
        }),
      ),
    );

  /**
   * The checks every candidate insert and every draft derive start from, run
   * inside the caller's transaction: the project is live, the receipt event
   * exists in the server writer's exact shape and decodes, and the
   * observation rebuilt from the stored record equals the submitted one.
   */
  const verifyStoredReceipt = (input: {
    readonly projectId: ProjectId;
    readonly check: ProjectSkillCheckObservation;
  }) =>
    Effect.gen(function* () {
      const threadId = input.check.threadId;
      // Project liveness is the first diagnostic, here and in the insert
      // statement's own guard.
      const projectLive = yield* sql<{ readonly live: number }>`
        SELECT ${liveProjectFor(input.projectId)} AS "live"
      `;
      if (projectLive[0]?.live !== 1) return { status: "project-missing" } as const;

      // The receipt event must exist in the server writer's exact shape.
      const eventRows = yield* sql<{
        readonly payloadJson: string;
        readonly sequence: number;
      }>`
        SELECT payload_json AS "payloadJson", sequence AS "sequence"
        FROM orchestration_events
        WHERE sequence = ${input.check.receiptSequence}
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND event_type = 'thread.activity-appended'
          AND substr(command_id, 1, ${SELECTED_CHECK_RECEIPT_COMMAND_PREFIX.length}) = ${SELECTED_CHECK_RECEIPT_COMMAND_PREFIX}
          AND json_extract(payload_json, '$.threadId') = ${threadId}
          AND json_extract(payload_json, '$.activity.id') = ${selectedCheckReceiptId(threadId)}
          AND json_extract(payload_json, '$.activity.kind') = ${SELECTED_CHECK_RECEIPT_KIND}
      `;
      const event = eventRows[0];
      if (event === undefined) return { status: "source-changed" } as const;

      // Decode the real stored wrapper and the receipt nested in its
      // activity payload; a malformed stored event cannot back the claim.
      const receipt = decodeSelectedCheckReceiptActivity(event.payloadJson, threadId);
      if (Option.isNone(receipt)) {
        return { status: "source-changed" } as const;
      }

      const threadRows = yield* sql<typeof SourceThreadRawDbRow.Type>`
        SELECT project_id AS "projectId", worktree_path AS "worktreePath"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      const threadRowRaw = threadRows[0];
      const latestRows = yield* sql<{ readonly latest: number | null }>`
        SELECT MAX(sequence) AS "latest"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND ${inputEventPredicate}
      `;
      const latest = latestRows[0]?.latest ?? null;
      if (threadRowRaw !== undefined) {
        const threadRow = yield* decodeSourceThreadRow(threadRowRaw);
        // Run the shared policy over the record actually stored: only the
        // record feeds the reducer here — capability, admission, and
        // command drift are the real SelectedChecks service's checks, and
        // the running-turn refusal is the service preflight's. The input
        // guard below closes the state race this way or in the statement.
        const evaluation = evaluateSkillSource({
          candidateProjectId: input.projectId,
          thread: {
            threadId,
            projectId: threadRow.projectId,
            worktreePath: threadRow.worktreePath,
            latestTurnState: null,
          },
          latestInputEventSequence: latest,
          checks: {
            capability: { available: true, reason: null },
            record: { kind: "present", receipt: receipt.value, sequence: event.sequence },
            changedScriptIds: [],
            admission: { state: "open" },
          },
          expected: {
            attemptId: input.check.attemptId,
            revision: input.check.revision,
            receiptSequence: input.check.receiptSequence,
          },
        });
        // The full observation built from the stored receipt must equal
        // the submitted one — a failed stored receipt, a tampered tree or
        // command hash, or moved identifiers are all source-changed.
        if (!evaluation.ok || canonicalJson(evaluation.check) !== canonicalJson(input.check)) {
          return { status: "source-changed" } as const;
        }
      }
      return { status: "ok", event, receipt: receipt.value } as const;
    });

  /**
   * Resolve the one accepted source turn a passed check stands on and derive
   * the review-draft seed from it, inside the caller's transaction. Selection
   * is never client-supplied and never time-based: the thread's latest
   * input event (which must precede the check's first write) names the
   * request message, that request owns exactly one completed projection turn
   * through `pending_message_id`, and the turn's own `assistant_message_id`
   * is the source. The authentic task-result record must be the thread's
   * latest write, accepted over this exact receipt and requirements version,
   * and `deriveTaskResultState` over it plus the caller's measurement must
   * read `verified`. The bounded identity hashes every source-derived field.
   * This is the one authoritative read of the source: the insert path runs it
   * inside the same transaction as its INSERT, which holds the connection until
   * it finishes, so the identity it recomputes is the state the write lands on.
   */
  const resolveDraftSource = (input: {
    readonly projectId: ProjectId;
    readonly check: ProjectSkillCheckObservation;
    readonly receipt: SelectedCheckReceipt;
    readonly measured: SelectedChecksGetResult;
  }) =>
    Effect.gen(function* () {
      const { check } = input;
      const threadId = check.threadId;
      const anchor = check.threadAnchorSequence;
      const unavailable = {
        status: "unavailable",
        reason: "no-coherent-source",
      } as const satisfies DraftResolution;

      // The current incarnation of the thread and of its project: the newest
      // create/delete boundary of each. Both must precede the check's first
      // write, and the project must predate the thread it holds.
      const lifecycleRows = yield* sql<{ readonly eventType: string; readonly latest: number }>`
        SELECT event_type AS "eventType", MAX(sequence) AS "latest"
        FROM orchestration_events
        WHERE (aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted'))
          OR (aggregate_kind = 'project' AND stream_id = ${input.projectId}
            AND event_type IN ('project.created', 'project.deleted'))
        GROUP BY event_type
      `;
      const latestOf = (eventType: string) =>
        lifecycleRows.find((row) => row.eventType === eventType)?.latest ?? null;
      const threadCreated = latestOf("thread.created");
      const threadDeleted = latestOf("thread.deleted");
      const projectCreated = latestOf("project.created");
      const projectDeleted = latestOf("project.deleted");
      if (
        threadCreated === null ||
        projectCreated === null ||
        threadCreated >= anchor ||
        projectCreated >= threadCreated ||
        (threadDeleted !== null && threadDeleted > threadCreated) ||
        (projectDeleted !== null && projectDeleted > projectCreated)
      ) {
        return unavailable;
      }
      const createdRows = yield* sql<{ readonly projectId: string | null }>`
        SELECT json_extract(payload_json, '$.projectId') AS "projectId"
        FROM orchestration_events
        WHERE sequence = ${threadCreated} AND aggregate_kind = 'thread'
          AND stream_id = ${threadId} AND event_type = 'thread.created'
      `;
      if (createdRows[0]?.projectId !== input.projectId) return unavailable;
      const threadRows = yield* sql<{ readonly title: string }>`
        SELECT title AS "title" FROM projection_threads
        WHERE thread_id = ${threadId} AND project_id = ${input.projectId}
          AND deleted_at IS NULL AND worktree_path IS ${check.worktreePath}
      `;
      const threadTitle = threadRows[0]?.title;
      if (threadTitle === undefined) return unavailable;

      // The authentic task-result record is the thread's latest write of its
      // fixed activity id, in the server writer's exact shape, written for
      // this incarnation after the receipt it accepts.
      const taskRows = yield* sql<{
        readonly sequence: number;
        readonly commandId: string | null;
        readonly payloadJson: string;
      }>`
        SELECT sequence AS "sequence", command_id AS "commandId", payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND event_type = 'thread.activity-appended'
          AND json_extract(payload_json, '$.activity.id') = ${taskResultRecordId(threadId)}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      const taskRow = taskRows[0];
      if (
        taskRow === undefined ||
        taskRow.commandId === null ||
        !taskRow.commandId.startsWith(TASK_RESULT_COMMAND_PREFIX) ||
        taskRow.sequence <= check.receiptSequence
      ) {
        return unavailable;
      }
      const wrapper = decodeReceiptActivityWrapper(taskRow.payloadJson);
      if (
        Option.isNone(wrapper) ||
        wrapper.value.threadId !== threadId ||
        wrapper.value.activity.id !== taskResultRecordId(threadId) ||
        wrapper.value.activity.kind !== TASK_RESULT_ACTIVITY_KIND
      ) {
        return unavailable;
      }
      const decodedRecord = decodeStoredTaskResultRecord(wrapper.value.activity.payload);
      if (Option.isNone(decodedRecord)) return unavailable;
      const record = decodedRecord.value;
      const requirements = record.requirements;
      const acceptance = record.acceptance;
      if (
        record.threadId !== threadId ||
        record.threadIncarnation !== threadCreated ||
        requirements === null ||
        acceptance === null ||
        acceptance.requirementsVersion !== requirements.version ||
        acceptance.checkAttemptId !== check.attemptId ||
        acceptance.checkReceiptSequence !== check.receiptSequence
      ) {
        return unavailable;
      }

      // The measured view must be the same receipt the storage proved, and
      // the shared task-result judgment over it must read verified now.
      const measuredRecord = input.measured.record;
      if (
        measuredRecord.kind !== "present" ||
        measuredRecord.sequence !== check.receiptSequence ||
        measuredRecord.receipt.attemptId !== check.attemptId ||
        measuredRecord.receipt.revision !== check.revision
      ) {
        return unavailable;
      }
      const engagedRows = yield* sql<{ readonly engaged: number }>`
        SELECT (
          EXISTS (
            SELECT 1 FROM projection_turns
            WHERE thread_id = ${threadId} AND state IN ('pending', 'running')
          )
          OR EXISTS (
            SELECT 1 FROM projection_thread_sessions
            WHERE thread_id = ${threadId}
              AND (status IN ('starting', 'running') OR active_turn_id IS NOT NULL)
          )
        ) AS "engaged"
      `;
      const taskState = deriveTaskResultState(
        {
          record: { kind: "present", record, sequence: taskRow.sequence },
          threadIncarnation: threadCreated,
          checks: {
            ...input.measured,
            record: { kind: "present", receipt: input.receipt, sequence: check.receiptSequence },
          },
        },
        engagedRows[0]?.engaged !== 0,
      );
      if (taskState.state !== "verified" || taskState.acceptance !== "current") return unavailable;

      // All accepted input shapes, including mid-turn approvals, set the
      // causal floor for the assistant's source message.
      const latestCommittedInputRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence AS "sequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND ${inputEventPredicate}
          AND sequence > ${threadCreated} AND sequence < ${anchor}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      const latestCommittedInput = latestCommittedInputRows[0];
      if (latestCommittedInput === undefined) return unavailable;

      // Only a user message or its turn start can name the source request.
      const turnRequestRows = yield* sql<{
        readonly sequence: number;
        readonly messageId: string | null;
      }>`
        SELECT sequence AS "sequence", json_extract(payload_json, '$.messageId') AS "messageId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND sequence > ${threadCreated} AND sequence < ${anchor}
          AND (
            event_type = 'thread.turn-start-requested'
            OR (event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'user')
          )
        ORDER BY sequence DESC
        LIMIT 1
      `;
      const latestTurnRequest = turnRequestRows[0];
      const requestMessageId =
        latestTurnRequest === undefined || latestTurnRequest.messageId === null
          ? Option.none()
          : decodeStoredMessageId(latestTurnRequest.messageId);
      if (latestTurnRequest === undefined || Option.isNone(requestMessageId)) return unavailable;
      const requestId = requestMessageId.value;
      // The request owns both its user message and its turn start.
      const requestEventRows = yield* sql<{ readonly eventType: string }>`
        SELECT DISTINCT event_type AS "eventType"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND sequence > ${threadCreated} AND sequence <= ${latestTurnRequest.sequence}
          AND json_extract(payload_json, '$.messageId') = ${requestId}
          AND (
            event_type = 'thread.turn-start-requested'
            OR (event_type = 'thread.message-sent' AND json_extract(payload_json, '$.role') = 'user')
          )
      `;
      if (
        !requestEventRows.some((row) => row.eventType === "thread.message-sent") ||
        !requestEventRows.some((row) => row.eventType === "thread.turn-start-requested")
      ) {
        return unavailable;
      }

      // That request owns exactly one concrete turn, and it is completed.
      const turnRows = yield* sql<{
        readonly turnId: string | null;
        readonly assistantMessageId: string | null;
        readonly state: string;
      }>`
        SELECT turn_id AS "turnId", assistant_message_id AS "assistantMessageId", state AS "state"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND pending_message_id = ${requestId}
      `;
      const turnRow = turnRows.length === 1 ? turnRows[0] : undefined;
      const turnId =
        turnRow?.turnId === undefined || turnRow.turnId === null
          ? Option.none<TurnId>()
          : decodeStoredTurnId(turnRow.turnId);
      const assistantId =
        turnRow?.assistantMessageId === undefined || turnRow.assistantMessageId === null
          ? Option.none<MessageId>()
          : decodeStoredMessageId(turnRow.assistantMessageId);
      if (turnRow?.state !== "completed" || Option.isNone(turnId) || Option.isNone(assistantId)) {
        return unavailable;
      }

      // The two messages as projected: the user request carries no turn, the
      // assistant message belongs to this turn and is no longer streaming.
      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly role: string;
        readonly turnId: string | null;
        readonly text: string;
        readonly isStreaming: number;
      }>`
        SELECT message_id AS "messageId", role AS "role", turn_id AS "turnId",
          text AS "text", is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (message_id = ${requestId} OR message_id = ${assistantId.value})
      `;
      const requestRow = messageRows.find((row) => row.messageId === requestId);
      const assistantRow = messageRows.find((row) => row.messageId === assistantId.value);
      if (
        requestRow === undefined ||
        assistantRow === undefined ||
        requestRow.role !== "user" ||
        requestRow.turnId !== null ||
        requestRow.isStreaming !== 0 ||
        assistantRow.role !== "assistant" ||
        assistantRow.turnId !== turnId.value ||
        assistantRow.isStreaming !== 0
      ) {
        return unavailable;
      }
      // The assistant message's own events fall between the request and the
      // check's first write, never after it.
      const assistantEventRows = yield* sql<{ readonly inRange: number; readonly late: number }>`
        SELECT
          EXISTS (
            SELECT 1 FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
              AND event_type = 'thread.message-sent'
              AND json_extract(payload_json, '$.messageId') = ${assistantId.value}
              AND json_extract(payload_json, '$.role') = 'assistant'
              AND json_extract(payload_json, '$.turnId') = ${turnId.value}
              AND sequence > ${latestCommittedInput.sequence} AND sequence < ${anchor}
          ) AS "inRange",
          EXISTS (
            SELECT 1 FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
              AND event_type = 'thread.message-sent'
              AND json_extract(payload_json, '$.messageId') = ${assistantId.value}
              AND sequence >= ${anchor}
          ) AS "late"
      `;
      if (assistantEventRows[0]?.inRange !== 1 || assistantEventRows[0]?.late !== 0) {
        return unavailable;
      }

      // Summary-only bodies, a missing, empty, or ambiguous procedure, and an
      // unbounded-empty field all stay unavailable; metadata alone never seeds.
      const extracted = extractProjectSkillProcedureSection(assistantRow.text);
      if (extracted.outcome === "unavailable") {
        return { status: "unavailable", reason: extracted.reason } as const;
      }
      const requirementsText = requirements.items.map((item) => item.text).join("\n");
      const successCheckText = `Required checks pass: ${requirements.checks
        .map((required) => required.scriptId)
        .join(", ")}.`;
      const requirementsContent = JSON.stringify({
        version: requirements.version,
        items: requirements.items.map((item) => ({
          id: item.id,
          text: item.text,
          scriptIds: [...item.scriptIds],
        })),
        checks: requirements.checks.map((required) => ({
          scriptId: required.scriptId,
          commandSha256: required.commandSha256,
        })),
      });
      const seed = {
        derivationFormat: PROJECT_SKILL_REVIEW_DRAFT_DERIVATION_FORMAT,
        projectId: input.projectId,
        projectIncarnationSequence: projectCreated,
        threadId,
        threadIncarnationSequence: threadCreated,
        turnId: turnId.value,
        assistantMessageId: assistantId.value,
        requestMessageId: requestId,
        assistantBodySha256: sha256Hex(assistantRow.text),
        requestBodySha256: sha256Hex(requestRow.text),
        extractedProcedureSha256: sha256Hex(extracted.text),
        requirementsVersion: requirements.version,
        requirementsContentSha256: sha256Hex(
          `${TASK_RESULT_REQUIREMENTS_DOMAIN}${requirementsContent}`,
        ),
        taskResultRecordSequence: taskRow.sequence,
        taskResultRecordRevision: record.revision,
        taskResultRecordSha256: sha256Hex(taskRow.payloadJson),
        // The acceptance stores no revision of its own: the accepted attempt's
        // revision is the current matching receipt's, bound through the
        // accepted receipt sequence the tuple above already proved equal.
        acceptedCheck: {
          attemptId: acceptance.checkAttemptId,
          revision: check.revision,
          receiptSequence: acceptance.checkReceiptSequence,
        },
        currentCheck: {
          attemptId: check.attemptId,
          revision: check.revision,
          receiptSequence: check.receiptSequence,
        },
        threadTitleSha256: sha256Hex(threadTitle),
        boundRequirementTextSha256: sha256Hex(requirementsText),
        boundSuccessCheckTextSha256: sha256Hex(successCheckText),
      } satisfies ProjectSkillCandidateSourceSeed;
      const sourceIdentity = {
        ...seed,
        wholeSourceSha256: sha256Hex(canonicalProjectSkillCandidateSourceSeedJson(seed)),
      };
      const derived = deriveSkillReviewDraft({
        sourceIdentity,
        threadTitle,
        userRequest: requestRow.text,
        boundRequirementText: requirementsText,
        boundSuccessCheckText: successCheckText,
        assistantMessageBody: assistantRow.text,
      });
      if (derived.outcome === "unavailable") {
        return { status: "unavailable", reason: derived.reason } as const;
      }
      return { status: "available", derived } as const satisfies DraftResolution;
    });

  /**
   * One derived source already saved with this final content, edited or not:
   * the project, the content hash, and the exact canonical source identity
   * (`wholeSourceSha256`, which covers the thread, both incarnations, the
   * assistant message, and the accepted task-result evidence). A source whose
   * evidence changed is a different source even for an unchanged message. A
   * revision carries its lineage's derived root, so a revised version of the
   * same source counts.
   */
  const derivedDuplicateWhere = (
    projectId: ProjectId,
    contentSha256: string,
    identity: ProjectSkillCandidateSourceIdentity,
  ) => sql`
    d.project_id = ${projectId} AND d.content_sha256 = ${contentSha256}
    AND COALESCE(
      json_extract(d.source_json, '$.draft.sourceIdentity.wholeSourceSha256'),
      json_extract(d.source_json, '$.root.draft.sourceIdentity.wholeSourceSha256')
    ) = ${identity.wholeSourceSha256}
  `;

  /**
   * The derived half of `insertCandidate`'s pre-statement checks, run in the
   * same transaction as its INSERT: the caller's pin is only an equality
   * expectation against what this one authoritative read resolves, the
   * identity stored is the resolved one, and `edited` is
   * computed here by comparing all of the submitted content to the resolved
   * seed, whose missing exclusion reads as empty.
   */
  const planDerivedInsert = (
    input: {
      readonly projectId: ProjectId;
      readonly content: ProjectSkillContent;
      readonly contentSha256: Sha256Hex;
      readonly check: ProjectSkillCheckObservation;
      readonly measured?: SelectedChecksGetResult;
    },
    draft: Extract<ProjectSkillDraft, { type: "derived" }>,
    receipt: SelectedCheckReceipt,
  ) =>
    Effect.gen(function* () {
      if (input.measured === undefined) return { status: "source-changed" } as const;
      // The duplicate guard keys on the content hash, so it must be the
      // canonical one — a caller-chosen hash would let identical content in.
      if (input.contentSha256 !== sha256Hex(canonicalProjectSkillContentJson(input.content))) {
        return yield* invalidInput("ProjectSkillRepository.insertCandidate:content-sha");
      }
      const resolution = yield* resolveDraftSource({
        projectId: input.projectId,
        check: input.check,
        receipt,
        measured: input.measured,
      });
      if (
        resolution.status !== "available" ||
        resolution.derived.sourceIdentity.wholeSourceSha256 !== draft.expectedSourceIdentitySha256
      ) {
        return { status: "source-changed" } as const;
      }
      if (draft.messageId !== resolution.derived.sourceIdentity.assistantMessageId) {
        return { status: "draft-message-invalid" } as const;
      }
      const seeded: Readonly<Record<(typeof DERIVED_CONTENT_FIELDS)[number], string>> = {
        ...resolution.derived.partial,
        doesNotApplyWhen: "",
      };
      return {
        status: "ok",
        draft: {
          type: "derived",
          messageId: draft.messageId,
          sourceIdentity: resolution.derived.sourceIdentity,
          edited: DERIVED_CONTENT_FIELDS.some(
            (field) => input.content[field] !== seeded[field].trim(),
          ),
        },
      } as const;
    });

  const deriveDraft: ProjectSkillRepository["Service"]["deriveDraft"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const unavailable = {
            status: "unavailable",
            reason: "no-coherent-source",
          } as const satisfies DeriveProjectSkillReviewDraftResult;
          const verified = yield* verifyStoredReceipt(input);
          if (verified.status !== "ok") return unavailable;
          const resolution = yield* resolveDraftSource({
            projectId: input.projectId,
            check: input.check,
            receipt: verified.receipt,
            measured: input.measured,
          });
          if (resolution.status === "unavailable") {
            return { status: "unavailable", reason: resolution.reason } as const;
          }
          return {
            status: "available",
            partial: resolution.derived.partial,
            truncation: resolution.derived.truncation,
            source: resolution.derived.sourceIdentity,
          } as const satisfies DeriveProjectSkillReviewDraftResult;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.deriveDraft:query",
            "ProjectSkillRepository.deriveDraft:decode",
            { threadId: input.check.threadId },
          ),
        ),
      );

  const insertCandidate: ProjectSkillRepository["Service"]["insertCandidate"] = (input) => {
    const threadId = input.check.threadId;
    const contentJson = JSON.stringify(input.content);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const verified = yield* verifyStoredReceipt(input);
          if (verified.status !== "ok") return { status: verified.status } as const;
          const event = verified.event;

          // A derived draft's source is resolved here by one authoritative read
          // in this same transaction, which holds the connection through the
          // INSERT below; the stored draft carries the server's identity and
          // edited flag, never the client's.
          let storedDraft: StoredDraft;
          if (input.draft.type === "derived") {
            const plan = yield* planDerivedInsert(input, input.draft, verified.receipt);
            if (plan.status !== "ok") return { status: plan.status } as const;
            storedDraft = plan.draft;
          } else {
            storedDraft = input.draft;
          }
          // The stored source strips only the top-level watermark; it goes
          // back on from the row's own column when the record is read.
          const sourceJson = JSON.stringify({
            type: "work",
            check: input.check,
            draft: storedDraft,
          });
          const derivedIdentity =
            storedDraft.type === "derived" ? storedDraft.sourceIdentity : null;

          // One statement decides and writes: live project, live thread in
          // that project still on the same worktree, the exact verified
          // receipt row (raw wrapper bytes pinned), no later write of the
          // same receipt activity, no user input at or after the attempt's
          // first write, no thread recreation or deletion after the anchor,
          // no deletion since the current incarnation began, the latest
          // pre-anchor creation of this thread being an incarnation of this
          // project, and a draft message that lives in the source thread. A
          // derived draft adds the one-save-per-content-and-source guard, so
          // concurrent identical saves insert one.
          const inserted = yield* sql<{
            readonly createdAfterEventSequence: number;
          }>`
            INSERT INTO project_skill_versions (
              skill_id, project_id, version, content_json, content_sha256,
              source_json, source_thread_id, source_receipt_sequence,
              source_thread_created_sequence, created_after_event_sequence, created_at
            )
            SELECT
              ${input.skillId}, ${input.projectId}, 1, ${contentJson}, ${input.contentSha256},
              ${sourceJson}, ${threadId}, ${input.check.receiptSequence},
              (
                SELECT MAX(created.sequence) FROM orchestration_events created
                WHERE created.aggregate_kind = 'thread' AND created.stream_id = ${threadId}
                  AND created.event_type = 'thread.created'
                  AND created.sequence < ${input.check.threadAnchorSequence}
              ),
              (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events),
              ${input.now}
            WHERE
              ${liveProjectFor(input.projectId)}
              AND EXISTS (
                SELECT 1 FROM projection_threads t
                WHERE t.thread_id = ${threadId}
                  AND t.project_id = ${input.projectId}
                  AND t.deleted_at IS NULL
                  AND t.worktree_path IS ${input.check.worktreePath}
              )
              AND EXISTS (
                SELECT 1 FROM orchestration_events receipt
                WHERE receipt.sequence = ${input.check.receiptSequence}
                  AND receipt.aggregate_kind = 'thread' AND receipt.stream_id = ${threadId}
                  AND receipt.event_type = 'thread.activity-appended'
                  AND substr(receipt.command_id, 1, ${SELECTED_CHECK_RECEIPT_COMMAND_PREFIX.length}) = ${SELECTED_CHECK_RECEIPT_COMMAND_PREFIX}
                  AND json_extract(receipt.payload_json, '$.threadId') = ${threadId}
                  AND json_extract(receipt.payload_json, '$.activity.id') = ${selectedCheckReceiptId(threadId)}
                  AND json_extract(receipt.payload_json, '$.activity.kind') = ${SELECTED_CHECK_RECEIPT_KIND}
                  AND json_extract(receipt.payload_json, '$.activity.payload.attemptId') = ${input.check.attemptId}
                  AND json_extract(receipt.payload_json, '$.activity.payload.revision') = ${input.check.revision}
                  AND json_extract(receipt.payload_json, '$.activity.payload.threadAnchorSequence') = ${input.check.threadAnchorSequence}
                  AND receipt.payload_json = ${event.payloadJson}
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events rewritten
                WHERE rewritten.aggregate_kind = 'thread' AND rewritten.stream_id = ${threadId}
                  AND rewritten.event_type = 'thread.activity-appended'
                  AND json_extract(rewritten.payload_json, '$.activity.id') = ${selectedCheckReceiptId(threadId)}
                  AND rewritten.sequence > ${input.check.receiptSequence}
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events userInput
                WHERE userInput.aggregate_kind = 'thread' AND userInput.stream_id = ${threadId}
                  AND ${inputEventPredicate}
                  AND userInput.sequence >= ${input.check.threadAnchorSequence}
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events recreated
                WHERE recreated.aggregate_kind = 'thread' AND recreated.stream_id = ${threadId}
                  AND recreated.event_type IN ('thread.created', 'thread.deleted')
                  AND recreated.sequence > ${input.check.threadAnchorSequence}
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events deletedInIncarnation
                WHERE deletedInIncarnation.aggregate_kind = 'thread' AND deletedInIncarnation.stream_id = ${threadId}
                  AND deletedInIncarnation.event_type = 'thread.deleted'
                  AND deletedInIncarnation.sequence > (
                    SELECT MAX(incarnation.sequence) FROM orchestration_events incarnation
                    WHERE incarnation.aggregate_kind = 'thread' AND incarnation.stream_id = ${threadId}
                      AND incarnation.event_type = 'thread.created'
                      AND incarnation.sequence < ${input.check.threadAnchorSequence}
                  )
              )
              AND EXISTS (
                SELECT 1 FROM orchestration_events incarnation
                WHERE incarnation.aggregate_kind = 'thread' AND incarnation.stream_id = ${threadId}
                  AND incarnation.event_type = 'thread.created'
                  AND incarnation.sequence = (
                    SELECT MAX(chosen.sequence) FROM orchestration_events chosen
                    WHERE chosen.aggregate_kind = 'thread' AND chosen.stream_id = ${threadId}
                      AND chosen.event_type = 'thread.created'
                      AND chosen.sequence < ${input.check.threadAnchorSequence}
                  )
                  AND json_extract(incarnation.payload_json, '$.projectId') = ${input.projectId}
              )
              AND (
                ${
                  input.draft.type === "typed"
                    ? sql`1 = 1`
                    : sql`EXISTS (
                        SELECT 1 FROM projection_thread_messages draftMessage
                        JOIN projection_threads draftThread ON draftThread.thread_id = draftMessage.thread_id
                        WHERE draftMessage.message_id = ${input.draft.messageId}
                          AND draftMessage.thread_id = ${threadId}
                          AND draftThread.project_id = ${input.projectId}
                          AND draftThread.deleted_at IS NULL
                      )`
                }
              )
              AND ${
                derivedIdentity === null
                  ? sql`1 = 1`
                  : sql`NOT EXISTS (
                      SELECT 1 FROM project_skill_versions d
                      WHERE ${derivedDuplicateWhere(input.projectId, input.contentSha256, derivedIdentity)}
                    )`
              }
            RETURNING created_after_event_sequence AS "createdAfterEventSequence"
          `;
          const insertedRow = inserted[0];
          if (insertedRow === undefined) {
            // Same-transaction diagnostics name the guard that failed.
            const threadLive = yield* sql<{ readonly live: number }>`
              SELECT EXISTS (
                SELECT 1 FROM projection_threads t
                WHERE t.thread_id = ${threadId}
                  AND t.project_id = ${input.projectId}
                  AND t.deleted_at IS NULL
                  AND t.worktree_path IS ${input.check.worktreePath}
              ) AS "live"
            `;
            if (threadLive[0]?.live !== 1) return { status: "thread-missing" } as const;
            if (input.draft.type === "message") {
              const draftValid = yield* sql<{ readonly valid: number }>`
                SELECT EXISTS (
                  SELECT 1 FROM projection_thread_messages draftMessage
                  JOIN projection_threads draftThread ON draftThread.thread_id = draftMessage.thread_id
                  WHERE draftMessage.message_id = ${input.draft.messageId}
                    AND draftMessage.thread_id = ${threadId}
                    AND draftThread.project_id = ${input.projectId}
                    AND draftThread.deleted_at IS NULL
                ) AS "valid"
              `;
              if (draftValid[0]?.valid !== 1) return { status: "draft-message-invalid" } as const;
            }
            if (derivedIdentity !== null) {
              // Every other guard held on a derived save, so a saved copy of
              // this exact content from this exact source is what refused it.
              const duplicateRows = yield* sql<{ readonly version: number }>`
                SELECT d.version AS "version" FROM project_skill_versions d
                WHERE ${derivedDuplicateWhere(input.projectId, input.contentSha256, derivedIdentity)}
                  AND ${liveProjectFor(input.projectId)}
                ORDER BY d.version ASC
                LIMIT 1
              `;
              const duplicate = duplicateRows[0]?.version;
              if (duplicate !== undefined) {
                return { status: "duplicate-content", existingVersion: duplicate } as const;
              }
            }
            return { status: "source-changed" } as const;
          }
          return {
            status: "applied",
            row: {
              ref: {
                projectId: input.projectId,
                skillId: input.skillId,
                version: 1,
                contentSha256: input.contentSha256,
              },
              content: input.content,
              source: {
                type: "work",
                check: input.check,
                draft: storedDraft,
                createdAfterEventSequence: insertedRow.createdAfterEventSequence,
              },
              state: "candidate",
              retiredReason: null,
              createdAt: input.now,
            },
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.insertCandidate:query",
            "ProjectSkillRepository.insertCandidate:decode",
            { threadId },
          ),
        ),
      );
  };

  const insertRevision: ProjectSkillRepository["Service"]["insertRevision"] = (input) => {
    const contentJson = JSON.stringify(input.content);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          // Liveness rides on the pre-read so an orphaned source row is never
          // decoded — a dead project reports project-missing instead.
          const fromRows = yield* sql<{
            readonly sourceJson: string;
            readonly createdAfterEventSequence: number;
          }>`
            SELECT source_json AS "sourceJson", created_after_event_sequence AS "createdAfterEventSequence"
            FROM project_skill_versions
            WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
              AND version = ${input.fromVersion}
              AND ${liveProjectFor(input.projectId)}
          `;
          const fromRow = fromRows[0];
          if (fromRow === undefined) {
            const projectLive = yield* sql<{ readonly live: number }>`
              SELECT ${liveProjectFor(input.projectId)} AS "live"
            `;
            return projectLive[0]?.live === 1
              ? ({ status: "not-found" } as const)
              : ({ status: "project-missing" } as const);
          }
          // The root work source comes from the database, never from the
          // caller: the from-version's stored source already carries the
          // lineage's immutable root and its original watermark.
          const storedSource = yield* decodeStored(
            decodeStoredSourceJson(fromRow.sourceJson),
            "ProjectSkillRepository.insertRevision:source",
          );
          const fromSource = yield* decodeStored(
            decodeFullSource({
              ...storedSource,
              createdAfterEventSequence: fromRow.createdAfterEventSequence,
            }),
            "ProjectSkillRepository.insertRevision:source-shape",
          );
          const root = fromSource.type === "work" ? fromSource : fromSource.root;
          if (root.check.projectId !== input.projectId) {
            return yield* new PersistenceDecodeError({
              operation: "ProjectSkillRepository.insertRevision:lineage",
              issue: "the stored root work source names a different project",
            });
          }
          const sourceJson = JSON.stringify({
            type: "revision",
            fromVersion: input.fromVersion,
            root,
          });

          // One statement decides and writes: the from-version exists, the
          // expected latest version of this project's skill is still current,
          // no version of it carries the content hash yet, and the project is
          // live. SQLite's writer serialization makes two concurrent
          // revisions with the same expectedLatestVersion mutually exclusive.
          const inserted = yield* sql<{
            readonly version: number;
            readonly createdAfterEventSequence: number;
          }>`
            INSERT INTO project_skill_versions (
              skill_id, project_id, version, content_json, content_sha256,
              source_json, source_thread_id, source_receipt_sequence,
              source_thread_created_sequence, created_after_event_sequence, created_at
            )
            SELECT
              p.skill_id, p.project_id,
              (
                SELECT MAX(v.version) + 1 FROM project_skill_versions v
                WHERE v.skill_id = p.skill_id AND v.project_id = p.project_id
              ),
              ${contentJson}, ${input.contentSha256}, ${sourceJson},
              p.source_thread_id, p.source_receipt_sequence, p.source_thread_created_sequence,
              (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events),
              ${input.now}
            FROM project_skill_versions p
            WHERE p.skill_id = ${input.skillId} AND p.project_id = ${input.projectId}
              AND p.version = ${input.fromVersion}
              AND ${input.expectedLatestVersion} = (
                SELECT MAX(v.version) FROM project_skill_versions v
                WHERE v.skill_id = ${input.skillId} AND v.project_id = ${input.projectId}
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_skill_versions d
                WHERE d.skill_id = ${input.skillId} AND d.project_id = ${input.projectId}
                  AND d.content_sha256 = ${input.contentSha256}
              )
              AND ${liveProjectFor(input.projectId)}
            RETURNING version AS "version", created_after_event_sequence AS "createdAfterEventSequence"
          `;
          const insertedRow = inserted[0];
          if (insertedRow === undefined) {
            const projectLive = yield* sql<{ readonly live: number }>`
              SELECT ${liveProjectFor(input.projectId)} AS "live"
            `;
            if (projectLive[0]?.live !== 1) return { status: "project-missing" } as const;
            const latestRows = yield* sql<{ readonly latest: number | null }>`
              SELECT MAX(version) AS "latest" FROM project_skill_versions
              WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
                AND ${liveProjectFor(input.projectId)}
            `;
            const latest = latestRows[0]?.latest ?? null;
            if (latest === null) return { status: "not-found" } as const;
            if (latest !== input.expectedLatestVersion) {
              return { status: "conflict", currentLatestVersion: latest } as const;
            }
            const duplicateRows = yield* sql<{ readonly version: number }>`
              SELECT version FROM project_skill_versions
              WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
                AND content_sha256 = ${input.contentSha256}
                AND ${liveProjectFor(input.projectId)}
            `;
            const duplicate = duplicateRows[0]?.version;
            return duplicate !== undefined
              ? ({ status: "duplicate-content", existingVersion: duplicate } as const)
              : ({ status: "not-found" } as const);
          }
          return {
            status: "applied",
            row: {
              ref: {
                projectId: input.projectId,
                skillId: input.skillId,
                version: insertedRow.version,
                contentSha256: input.contentSha256,
              },
              content: input.content,
              source: {
                type: "revision",
                fromVersion: input.fromVersion,
                root,
                createdAfterEventSequence: insertedRow.createdAfterEventSequence,
              },
              state: "candidate",
              retiredReason: null,
              createdAt: input.now,
            },
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.insertRevision:query",
            "ProjectSkillRepository.insertRevision:decode",
            { projectId: input.projectId },
          ),
        ),
      );
  };

  const listSkills: ProjectSkillRepository["Service"]["listSkills"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rawRows: ReadonlyArray<unknown> = yield* sql<typeof VersionRawDbRow.Type>`
            SELECT ${versionColumns}
            FROM project_skill_versions v
            WHERE v.project_id = ${input.projectId}
              AND v.version = (
                SELECT MAX(latest.version) FROM project_skill_versions latest
                WHERE latest.skill_id = v.skill_id AND latest.project_id = v.project_id
              )
              AND ${liveProjectFor(input.projectId)}
            ORDER BY v.created_at DESC, v.skill_id ASC
            LIMIT ${input.limit + 1}
          `;
          const truncated = rawRows.length > input.limit;
          const items = yield* Effect.forEach(rawRows.slice(0, input.limit), (raw) =>
            Effect.gen(function* () {
              const version = yield* toVersionRecord(raw);
              // Judgments bind to the exact full ref — earlier versions'
              // judgments never appear on the latest version's item.
              const rawJudgments: ReadonlyArray<unknown> = yield* sql<typeof JudgmentRawDbRow.Type>`
                SELECT ${judgmentColumns}
                FROM project_skill_judgments j
                WHERE j.project_id = ${version.ref.projectId}
                  AND j.skill_id = ${version.ref.skillId}
                  AND j.version = ${version.ref.version}
                  AND j.content_sha256 = ${version.ref.contentSha256}
                  AND ${liveProjectFor(version.ref.projectId)}
                ORDER BY j.recorded_after_event_sequence ASC, j.judgment_id ASC
              `;
              const judgments = yield* Effect.forEach(rawJudgments, toJudgmentRecord);
              return { version, judgments };
            }),
          );
          return { items, truncated };
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.listSkills:query",
            "ProjectSkillRepository.listSkills:decode",
            { projectId: input.projectId },
          ),
        ),
      );

  const getSkill: ProjectSkillRepository["Service"]["getSkill"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rawVersions: ReadonlyArray<unknown> = yield* sql<typeof VersionRawDbRow.Type>`
            SELECT ${versionColumns}
            FROM project_skill_versions v
            WHERE v.project_id = ${input.projectId} AND v.skill_id = ${input.skillId}
              AND ${liveProjectFor(input.projectId)}
            ORDER BY v.version DESC
          `;
          if (rawVersions.length === 0) return Option.none();
          const versions = yield* Effect.forEach(rawVersions, toVersionRecord);
          const rawJudgments: ReadonlyArray<unknown> = yield* sql<typeof JudgmentRawDbRow.Type>`
            SELECT ${judgmentColumns}
            FROM project_skill_judgments j
            WHERE j.project_id = ${input.projectId} AND j.skill_id = ${input.skillId}
              AND ${liveProjectFor(input.projectId)}
            ORDER BY j.recorded_after_event_sequence ASC, j.judgment_id ASC
          `;
          const judgments = yield* Effect.forEach(rawJudgments, toJudgmentRecord);
          return Option.some({ versions, judgments });
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.getSkill:query",
            "ProjectSkillRepository.getSkill:decode",
            { projectId: input.projectId },
          ),
        ),
      );

  // One guarded judgment INSERT for the two public writers: columns,
  // serialized payload, exact-version/live-project guard, and event watermark
  // are written once. Evidence-backed kinds add the closed, provider-accepted
  // observed-use EXISTS predicate to the same statement, so storage still
  // enforces evidence existence in the INSERT itself. Refusal diagnosis is
  // the caller's — the two public outcomes keep their distinct shapes — and
  // runs inside the same transaction as the write.
  const insertJudgmentCore = <Refusal>(core: {
    readonly judgment: ProjectSkillStorableJudgment | ProjectSkillEvidenceJudgment;
    readonly evidence: { readonly observedEvidenceId: ProjectSkillEvidenceId } | undefined;
    readonly operation: string;
    readonly refusals: () => Effect.Effect<Refusal, unknown>;
  }): Effect.Effect<
    { readonly status: "applied"; readonly row: ProjectSkillJudgmentRecord } | Refusal,
    ProjectSkillRepositoryError
  > => {
    const judgmentJson = JSON.stringify(core.judgment);
    const ref = core.judgment.ref;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{
            readonly recordedAfterEventSequence: number;
          }>`
            INSERT INTO project_skill_judgments (
              judgment_id, project_id, skill_id, version, content_sha256, kind,
              judgment_json, recorded_after_event_sequence, withdrawn_at
            )
            SELECT
              ${core.judgment.judgmentId}, ${ref.projectId},
              ${ref.skillId}, ${ref.version},
              ${ref.contentSha256}, ${core.judgment.kind},
              ${judgmentJson},
              (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events),
              NULL
            FROM project_skill_versions v
            WHERE v.skill_id = ${ref.skillId}
              AND v.project_id = ${ref.projectId}
              AND v.version = ${ref.version}
              AND v.content_sha256 = ${ref.contentSha256}
              AND ${liveProjectFor(ref.projectId)}
              ${
                core.evidence === undefined
                  ? sql`AND 1 = 1`
                  : sql`
              AND EXISTS (
                SELECT 1
                FROM project_skill_observed_uses u
                JOIN project_skill_inputs i
                  ON i.thread_id = u.thread_id AND i.message_id = u.message_id
                WHERE u.evidence_id = ${core.evidence.observedEvidenceId}
                  AND u.project_id = ${ref.projectId}
                  AND u.skill_id = ${ref.skillId}
                  AND u.version = ${ref.version}
                  AND u.content_sha256 = ${ref.contentSha256}
                  AND i.tombstoned_at IS NULL
                  AND i.window = 'closed'
                  AND i.delivery = 'provider-accepted'
                  AND i.project_id = ${ref.projectId}
                  AND i.skill_id = ${ref.skillId}
                  AND i.version = ${ref.version}
                  AND i.content_sha256 = ${ref.contentSha256}
              )
            `
              }
            RETURNING recorded_after_event_sequence AS "recordedAfterEventSequence"
          `;
          const insertedRow = inserted[0];
          if (insertedRow === undefined) {
            return yield* core.refusals();
          }
          return {
            status: "applied",
            row: {
              judgment: core.judgment,
              recordedAfterEventSequence: insertedRow.recordedAfterEventSequence,
              withdrawnAt: null,
            },
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(`${core.operation}:query`, `${core.operation}:decode`, {
            projectId: ref.projectId,
          }),
        ),
      );
  };

  const insertJudgment: ProjectSkillRepository["Service"]["insertJudgment"] = (input) =>
    insertJudgmentCore({
      judgment: input.judgment,
      evidence: undefined,
      operation: "ProjectSkillRepository.insertJudgment",
      refusals: () =>
        Effect.gen(function* () {
          const projectLive = yield* sql<{ readonly live: number }>`
            SELECT ${liveProjectFor(input.judgment.ref.projectId)} AS "live"
          `;
          return projectLive[0]?.live === 1
            ? ({ status: "ref-mismatch" } as const)
            : ({ status: "project-missing" } as const);
        }),
    });

  const insertEvidenceJudgment: ProjectSkillRepository["Service"]["insertEvidenceJudgment"] = (
    input,
  ) => {
    const operation = "ProjectSkillRepository.insertEvidenceJudgment";
    const ref = input.judgment.ref;
    if (!validRef(ref)) {
      return invalidInput(operation);
    }
    // Typed values in memory are not guaranteed to have passed decode.
    if (input.judgment.kind !== "reproduction" && input.judgment.kind !== "non-application") {
      return Effect.succeed({ status: "unsupported-kind" } as const);
    }
    return insertJudgmentCore({
      judgment: input.judgment,
      evidence: { observedEvidenceId: input.judgment.observedEvidenceId },
      operation,
      refusals: () =>
        Effect.gen(function* () {
          const live = yield* isProjectLive(ref.projectId);
          if (!live) return { status: "project-missing" } as const;
          // The same exact-ref read the lifecycle views use: a missing
          // version row is a ref mismatch, a present one means the evidence
          // guard itself refused.
          const versionOption = yield* exactRefVersion(ref);
          return Option.isNone(versionOption)
            ? ({ status: "ref-mismatch" } as const)
            : ({ status: "evidence-mismatch" } as const);
        }),
    });
  };

  const readLifecycle: ProjectSkillRepository["Service"]["readLifecycle"] = (input) => {
    const operation = "ProjectSkillRepository.readLifecycle";
    if (!validRef(input.ref)) {
      return invalidInput(operation);
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const live = yield* isProjectLive(input.ref.projectId);
          if (!live) return Option.none();
          const versionOption = yield* exactRefVersion(input.ref);
          if (Option.isNone(versionOption)) return Option.none();
          const stateSeq = yield* stateSequence(input.ref.projectId);
          const lifecycle = yield* lifecycleReadsFor(operation, input.ref);
          return Option.some({ version: versionOption.value, stateSeq, ...lifecycle });
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.readLifecycle:query",
            "ProjectSkillRepository.readLifecycle:decode",
            { projectId: input.ref.projectId },
          ),
        ),
      );
  };

  const sweepFailedUseHolds: ProjectSkillRepository["Service"]["sweepFailedUseHolds"] = (input) => {
    const operation = "ProjectSkillRepository.sweepFailedUseHolds";
    if (!validRef(input.ref) || input.now.length === 0) {
      return invalidInput(operation);
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          // The same verified assembly the lifecycle read produces, and the
          // same deterministic holds readiness derives on the fly: the sweep
          // only makes them durable, idempotently on the evidence-kind key.
          const uses = yield* observedUsesForRef(operation, input.ref);
          const derived = yield* deriveFailureHolds(input.ref, uses);
          let inserted = 0;
          for (const entry of derived) {
            const rows = yield* sql<{ readonly holdId: string }>`
              INSERT OR IGNORE INTO project_skill_holds (
                hold_id, project_id, skill_id, version, content_sha256, kind,
                evidence_scope, thread_id, message_id, attempt_id,
                observed_at_event_sequence, hold_json, created_at
              )
              VALUES (
                ${entry.hold.holdId}, ${input.ref.projectId}, ${input.ref.skillId},
                ${input.ref.version}, ${input.ref.contentSha256}, ${entry.hold.kind},
                ${entry.hold.evidenceScope ?? null}, ${entry.evidence.threadId},
                ${entry.evidence.messageId}, ${entry.evidence.attemptId},
                ${entry.hold.observedAtEventSequence},
                ${JSON.stringify(entry.hold)}, ${input.now}
              )
              RETURNING hold_id AS "holdId"
            `;
            if (rows[0] !== undefined) inserted += 1;
          }
          return { inserted } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(`${operation}:query`, `${operation}:decode`, {
            projectId: input.ref.projectId,
          }),
        ),
      );
  };

  const assessUseWork: ProjectSkillUseWorkAssessor["Service"]["assessUseWork"] = (input) => {
    const operation = "ProjectSkillUseWorkAssessor.assessUseWork";
    if (!validRef(input.ref) || !safeInt(input.expectedStateSeq)) {
      return invalidInput(operation);
    }
    return Effect.gen(function* () {
      yield* requireInTransaction(operation);
      const live = yield* isProjectLive(input.ref.projectId);
      if (!live) return { status: "project-missing" } as const;
      const versionOption = yield* exactRefVersion(input.ref);
      if (Option.isNone(versionOption)) return { status: "not-found" } as const;
      const version = versionOption.value;
      const stateSeq = yield* stateSequence(input.ref.projectId);
      if (stateSeq !== input.expectedStateSeq) {
        return { status: "state-changed", currentStateSeq: stateSeq } as const;
      }
      const lifecycle = yield* lifecycleReadsFor(operation, input.ref);
      const derivedHolds = yield* deriveFailureHolds(input.ref, lifecycle.observedUses);
      const otherActive = lifecycle.activeRefs.filter(
        (active) => !projectSkillRefEquals(active, input.ref),
      );
      const readiness = yield* Effect.try({
        try: () =>
          deriveProjectSkillReadiness({
            purpose: "use",
            target: {
              ref: version.ref,
              state: version.state,
              retiredReason: version.retiredReason,
              source: version.source,
            },
            screenReasons: screenProjectSkillContent(version.content),
            observedUses: lifecycle.observedUses,
            judgments: lifecycle.judgments,
            holds: [...lifecycle.holds, ...derivedHolds.map((entry) => entry.hold)],
            otherActive,
            current: input.current,
          }),
        catch: (cause) =>
          new PersistenceSqlError({
            operation: `${operation}:readiness`,
            cause,
          }),
      });
      if (!readiness.ready) {
        return { status: "not-ready", gaps: readiness.gaps } as const;
      }
      return { status: "ready" } as const;
    }).pipe(
      Effect.mapError(
        toRepositoryError(`${operation}:query`, `${operation}:decode`, {
          projectId: input.ref.projectId,
        }),
      ),
    );
  };

  const transitionState: ProjectSkillRepository["Service"]["transitionState"] = (input) => {
    const operation = "ProjectSkillRepository.transitionState";
    if (!validRef(input.ref) || !safeInt(input.expectedStateSeq)) {
      return invalidInput(operation);
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const live = yield* isProjectLive(input.ref.projectId);
          if (!live) return { status: "project-missing" } as const;
          const versionOption = yield* exactRefVersion(input.ref);
          if (Option.isNone(versionOption)) return { status: "not-found" } as const;
          const version = versionOption.value;
          const stateSeq = yield* stateSequence(input.ref.projectId);
          if (stateSeq !== input.expectedStateSeq) {
            return { status: "state-changed", currentStateSeq: stateSeq } as const;
          }
          // Every state write re-pins the sequence it ran under, atomically:
          // a raced commit that moved the project state makes the guarded
          // UPDATE match nothing instead of writing on a stale snapshot —
          // every state-affecting write in this schema bumps the sequence.
          // Our own writes bump it too, so each statement guards on the
          // sequence the previous statement left, never the caller's value.
          const seqGuard = (expected: number) => sql`
            AND ${expected} = COALESCE(
              (SELECT seq FROM project_skill_state WHERE project_id = ${input.ref.projectId}),
              0
            )
          `;

          if (input.to === "retired") {
            if (version.state !== "active") return { status: "state-invalid" } as const;
            const retired = yield* sql<{ readonly version: number }>`
              UPDATE project_skill_versions
              SET state = 'retired', retired_reason = 'user-retired'
              WHERE skill_id = ${input.ref.skillId}
                AND project_id = ${input.ref.projectId}
                AND version = ${input.ref.version}
                AND content_sha256 = ${input.ref.contentSha256}
                AND state = 'active'
                ${seqGuard(input.expectedStateSeq)}
              RETURNING version AS "version"
            `;
            if (retired[0] === undefined) {
              const current = yield* stateSequence(input.ref.projectId);
              return current !== input.expectedStateSeq
                ? ({ status: "state-changed", currentStateSeq: current } as const)
                : ({ status: "state-invalid" } as const);
            }
            return {
              status: "applied",
              stateSeq: yield* stateSequence(input.ref.projectId),
            } as const;
          }

          // Activation: re-read this ref's full lifecycle inside the
          // transaction, compute the post-switch active set (only the
          // superseded same-skill version leaves it — unrelated skills are
          // never silently retired), and let the pure predicate decide.
          const lifecycle = yield* lifecycleReadsFor(operation, input.ref);
          // Readiness counts the ref's derived failure holds together with
          // the stored ones: a closed failed `use` observation vetoes its own
          // target from the moment it exists, before any sweep persists it.
          // The refusal writes nothing and the sequence does not move.
          const derivedHolds = yield* deriveFailureHolds(input.ref, lifecycle.observedUses);
          const otherActive = lifecycle.activeRefs.filter(
            (active) => active.skillId !== input.ref.skillId,
          );
          const readiness = yield* Effect.try({
            try: () =>
              deriveProjectSkillReadiness({
                purpose: "activate",
                target: {
                  ref: version.ref,
                  state: version.state,
                  retiredReason: version.retiredReason,
                  source: version.source,
                },
                screenReasons: screenProjectSkillContent(version.content),
                observedUses: lifecycle.observedUses,
                judgments: lifecycle.judgments,
                holds: [...lifecycle.holds, ...derivedHolds.map((entry) => entry.hold)],
                otherActive,
                current: input.current,
              }),
            catch: (cause) =>
              new PersistenceSqlError({
                operation: `${operation}:readiness`,
                cause,
              }),
          });
          if (!readiness.ready) {
            return { status: "not-ready", gaps: readiness.gaps } as const;
          }
          // Retire the superseded same-skill version first — the partial
          // unique index permits the activate only after it leaves
          // `active`. The guard runs on the caller's sequence; whatever it
          // writes bumps that sequence, so the activate guards on
          // `expected + own writes`, not on `expected`.
          const superseded = yield* sql<{ readonly version: number }>`
            UPDATE project_skill_versions
            SET state = 'retired', retired_reason = 'superseded'
            WHERE project_id = ${input.ref.projectId}
              AND skill_id = ${input.ref.skillId}
              AND state = 'active'
              AND NOT (
                version = ${input.ref.version}
                AND content_sha256 = ${input.ref.contentSha256}
              )
              ${seqGuard(input.expectedStateSeq)}
            RETURNING version AS "version"
          `;
          const seqAfterSupersede = yield* stateSequence(input.ref.projectId);
          if (superseded.length === 0 && seqAfterSupersede !== input.expectedStateSeq) {
            // The guard saw a foreign sequence and wrote nothing — a clean
            // state-changed with none of our rows touched.
            return {
              status: "state-changed",
              currentStateSeq: seqAfterSupersede,
            } as const;
          }
          const guardSeq = input.expectedStateSeq + superseded.length;
          if (seqAfterSupersede !== guardSeq) {
            // Unreachable in a serialized write transaction; rolled back
            // rather than reasoned about further.
            return yield* new PersistenceSqlError({
              operation: `${operation}:supersede`,
              detail: "state sequence diverged inside the switch transaction",
            });
          }
          const activated = yield* sql<{ readonly version: number }>`
            UPDATE project_skill_versions
            SET state = 'active', retired_reason = NULL
            WHERE skill_id = ${input.ref.skillId}
              AND project_id = ${input.ref.projectId}
              AND version = ${input.ref.version}
              AND content_sha256 = ${input.ref.contentSha256}
              AND state <> 'active'
              ${seqGuard(guardSeq)}
            RETURNING version AS "version"
          `;
          if (activated[0] === undefined) {
            if (superseded.length > 0) {
              // A guarded retire already landed; a partial switch must never
              // commit, so the whole transaction rolls back.
              return yield* new PersistenceSqlError({
                operation: `${operation}:activate`,
                detail: "guarded activate matched no row after the same-skill retire",
              });
            }
            const current = yield* stateSequence(input.ref.projectId);
            return current !== input.expectedStateSeq
              ? ({ status: "state-changed", currentStateSeq: current } as const)
              : ({ status: "state-invalid" } as const);
          }
          return {
            status: "applied",
            stateSeq: yield* stateSequence(input.ref.projectId),
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.transitionState:query",
            "ProjectSkillRepository.transitionState:decode",
            { projectId: input.ref.projectId },
          ),
        ),
      );
  };

  const withdrawJudgment: ProjectSkillRepository["Service"]["withdrawJudgment"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Exactly the one ref's judgment, and only the NULL -> value move —
          // the append-only trigger rejects anything wider.
          const updated = yield* sql<{ readonly judgmentId: string }>`
            UPDATE project_skill_judgments
            SET withdrawn_at = ${input.now}
            WHERE judgment_id = ${input.judgmentId}
              AND project_id = ${input.ref.projectId}
              AND skill_id = ${input.ref.skillId}
              AND version = ${input.ref.version}
              AND content_sha256 = ${input.ref.contentSha256}
              AND withdrawn_at IS NULL
              AND ${liveProjectFor(input.ref.projectId)}
            RETURNING judgment_id AS "judgmentId"
          `;
          if (updated[0] === undefined) {
            // The diagnostic carries the same live-project predicate, so a
            // raw-deleted project reports not-found instead of leaking the
            // orphan row's withdrawn state.
            const rows = yield* sql<{ readonly withdrawnAt: string | null }>`
              SELECT withdrawn_at AS "withdrawnAt"
              FROM project_skill_judgments
              WHERE judgment_id = ${input.judgmentId}
                AND project_id = ${input.ref.projectId}
                AND skill_id = ${input.ref.skillId}
                AND version = ${input.ref.version}
                AND content_sha256 = ${input.ref.contentSha256}
                AND ${liveProjectFor(input.ref.projectId)}
            `;
            const row = rows[0];
            return row !== undefined && row.withdrawnAt !== null
              ? ({ status: "already-withdrawn" } as const)
              : ({ status: "not-found" } as const);
          }
          return { status: "applied" } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.withdrawJudgment:query",
            "ProjectSkillRepository.withdrawJudgment:decode",
            { projectId: input.ref.projectId },
          ),
        ),
      );

  const deleteSkill: ProjectSkillRepository["Service"]["deleteSkill"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // The expected-latest guard is scoped to this project's skill and
          // rides on the version delete itself; the judgment delete only runs
          // once versions actually went, so a conflict or tombstone leaves
          // both tables untouched and another project's skill never leaks.
          const deletedVersions = yield* sql<{ readonly version: number }>`
            DELETE FROM project_skill_versions
            WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
              AND ${input.expectedLatestVersion} = (
                SELECT MAX(version) FROM project_skill_versions
                WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
              )
              AND ${liveProjectFor(input.projectId)}
            RETURNING version
          `;
          if (deletedVersions[0] === undefined) {
            const projectLive = yield* sql<{ readonly live: number }>`
              SELECT ${liveProjectFor(input.projectId)} AS "live"
            `;
            if (projectLive[0]?.live !== 1) return { status: "not-found" } as const;
            const latestRows = yield* sql<{ readonly latest: number | null }>`
              SELECT MAX(version) AS "latest" FROM project_skill_versions
              WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
                AND ${liveProjectFor(input.projectId)}
            `;
            const latest = latestRows[0]?.latest ?? null;
            return latest !== null && latest !== input.expectedLatestVersion
              ? ({ status: "conflict", currentLatestVersion: latest } as const)
              : ({ status: "not-found" } as const);
          }
          yield* sql`
            DELETE FROM project_skill_judgments
            WHERE skill_id = ${input.skillId} AND project_id = ${input.projectId}
          `;
          return { status: "applied" } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toRepositoryError(
            "ProjectSkillRepository.deleteSkill:query",
            "ProjectSkillRepository.deleteSkill:decode",
            { projectId: input.projectId },
          ),
        ),
      );

  const repository = {
    latestUserInputSequence,
    insertCandidate,
    deriveDraft,
    insertRevision,
    listSkills,
    getSkill,
    insertJudgment,
    insertEvidenceJudgment,
    readLifecycle,
    sweepFailedUseHolds,
    transitionState,
    withdrawJudgment,
    deleteSkill,
  } satisfies ProjectSkillRepository["Service"];

  return { repository, assessUseWork };
});

export const make = makeShared.pipe(Effect.map((shared) => shared.repository));

export const makeUseWorkAssessor = makeShared.pipe(
  Effect.map((shared) => ({ assessUseWork: shared.assessUseWork })),
);

export const layer = Layer.effect(ProjectSkillRepository, make);

export const useWorkAssessorLayer = Layer.effect(ProjectSkillUseWorkAssessor, makeUseWorkAssessor);
