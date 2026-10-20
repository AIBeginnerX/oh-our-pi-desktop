import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MessageId,
  PROJECT_SKILL_CONTEXT_KIND,
  ProjectId,
  PositiveInt,
  ProjectSkillContextPayload,
  ProjectSkillEvidenceId,
  ProjectSkillId,
  ProjectSkillManagedSendEvidence,
  SELECTED_CHECK_RECEIPT_KIND,
  Sha256Hex,
  ThreadId,
  ThreadMessageSentPayload,
  TrimmedNonEmptyString,
  evaluateSkillUseWindow,
  selectedCheckReceiptId,
} from "@t3tools/contracts";
import type {
  ProjectSkillCheckObservation,
  ProjectSkillEnvironment,
  ProjectSkillInputObservation,
  ProjectSkillReadinessGap,
  ProjectSkillVersionRef,
  SelectedCheckReceipt,
} from "@t3tools/contracts";

import { isPersistenceError, PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";
import {
  ProjectSkillUseWorkAssessor,
  SELECTED_CHECK_RECEIPT_COMMAND_PREFIX,
  decodeSelectedCheckReceiptActivity,
  projectSkillInputEventPredicate,
  useWorkAssessorLayer,
} from "./ProjectSkills.ts";

/**
 * Trial delivery ownership and observation storage (S4a) — the authority
 * repository the future gate and reader lanes consume.
 *
 * The delivery claim binds the canonical accepted user-message event (the
 * committed `thread.message-sent` row and the thread incarnation governing
 * it), never a turn-request or replay sequence. `claimDelivery` returns
 * `entered` with the one-time settlement token only to the invocation whose
 * INSERT actually committed; an existing row — `unknown` or
 * `provider-accepted` alike — answers a fixed `no-resend`, so a lost commit
 * receipt can never grant a second provider call. `settleDelivery` is bound
 * to the claimed token, not to the bare `(threadId, messageId)` key. Skill
 * deletion reduces input rows to payload-free tombstones (migration 059) and
 * the ownership answer survives it.
 *
 * A settle may carry optional `managedSend` evidence (migration 060): it is
 * written only inside the same UPDATE that accepts delivery, and only while
 * the stored ref, live project/thread incarnation, and a logically open
 * window — checked against the event log, not just the stored flag — all
 * still hold. Absent, invalid, or late evidence leaves an ordinary accepted
 * row that can never be labelled afterwards; a tombstone purges it.
 *
 * The sweep is scoped to one requested version ref. It captures the event
 * head inside its own transaction, finds each open window's boundary (the
 * next real input, excluding paired/re-emitted turn requests and provably
 * same-task approvals within this incarnation, or a thread recreation), and
 * while a window is open derives provisional results without writing evidence. Once
 * a boundary exists it freezes the range: the latest authenticated receipt
 * per attempt in the range becomes an observation and the row closes in the
 * same transaction, with attempts left unresolved counted once as
 * `uncountedAttempts` — repeated sweeps re-read, never re-increment.
 */

/** Fixed persistence errors on non-interrupt exits (sanitized operation/detail/issue). */
export type ProjectSkillTrialRepositoryFailure = PersistenceSqlError | PersistenceDecodeError;

/**
 * Public error channel: fixed repository failures, or the original fail/die value
 * when the cause carries an interrupt (mixed causes are returned whole via failCause).
 */
export type ProjectSkillTrialRepositoryError = ProjectSkillTrialRepositoryFailure | unknown;

export interface ProjectSkillTrialObservationRow {
  readonly evidenceId: ProjectSkillEvidenceId;
  readonly attemptId: string;
  readonly receiptSequence: number;
  readonly outcome: "all-selected-passed" | "failed";
  readonly endedAt: string | null;
}

/** Derived from the live event snapshot while the window is still open; never persisted. */
export interface ProjectSkillTrialProvisionalAttempt {
  readonly attemptId: string;
  readonly receiptSequence: number;
  readonly outcome: "all-selected-passed" | "failed";
  readonly endedAt: string | null;
}

export interface ProjectSkillTrialRow {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  /** Canonical accepted user-message event sequence, not a turn-request sequence. */
  readonly inputEventSequence: number;
  /** The `thread.created` sequence governing the input event. */
  readonly inputIncarnation: number;
  readonly admittedSkillStateSeq: number;
  /** `provider-accepted` means sendTurn returned; `unknown` is never a verified delivery. */
  readonly delivery: "unknown" | "provider-accepted";
  readonly providerDriverKind: string | null;
  /** Always null in this slice: unconfirmed, never an empty digest. */
  readonly nativeSkillInventorySha256: null;
  readonly window: "open" | "closed" | "thread-recreated";
  readonly uncountedAttempts: number;
  readonly tombstonedAt: string | null;
  /** Set once with acceptance, else null; malformed stored JSON decodes to null, never partial. */
  readonly managedSend: ProjectSkillManagedSendEvidence | null;
  readonly observations: ReadonlyArray<ProjectSkillTrialObservationRow>;
  readonly provisional: ReadonlyArray<ProjectSkillTrialProvisionalAttempt>;
}

export type ProjectSkillTrialClaimOutcome =
  | { readonly status: "entered"; readonly attemptToken: string }
  /** Fixed answer for an existing claim, `unknown` or accepted alike. */
  | { readonly status: "no-resend" }
  | { readonly status: "stale-identity" }
  | { readonly status: "thread-recreated" }
  | { readonly status: "ref-changed" }
  | { readonly status: "input-event-missing" };

export type ProjectSkillUseClaimOutcome =
  | { readonly status: "entered"; readonly attemptToken: string }
  | { readonly status: "no-resend" }
  | { readonly status: "stale-identity" }
  | { readonly status: "thread-recreated" }
  | { readonly status: "ref-changed" }
  | { readonly status: "input-event-missing" }
  | { readonly status: "context-invalid" }
  | { readonly status: "selection-missing" }
  | { readonly status: "selection-mismatch" }
  | { readonly status: "not-ready"; readonly gaps: ReadonlyArray<ProjectSkillReadinessGap> }
  | { readonly status: "open-failed-use" }
  | {
      readonly status: "assessment-unavailable";
      readonly dependency: "ProjectSkillUseWorkAssessor";
    };

export type ProjectSkillTrialSettleOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-found" }
  | { readonly status: "not-owned" }
  | { readonly status: "already-final" };

export interface ProjectSkillTrialSweepResult {
  /** Event head this sweep's ranges were measured against. */
  readonly head: number;
  readonly items: ReadonlyArray<ProjectSkillTrialRow>;
}

export interface ClaimProjectSkillUseDeliveryInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly ref: ProjectSkillVersionRef;
  readonly inputEventSequence: number;
  readonly admittedSkillStateSeq: number;
  readonly expectedStateSeq: number;
  readonly current: ProjectSkillEnvironment;
  /** Server-current selected plan script ids; compared to the durable payload. */
  readonly currentSelectedScriptIds: ReadonlyArray<string>;
  readonly now: string;
}

export interface ClaimProjectSkillTrialDeliveryInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly ref: ProjectSkillVersionRef;
  /** Sequence of the committed user `thread.message-sent` event this claim admits. */
  readonly inputEventSequence: number;
  /** Project state sequence stamped at admission; the claim proves it unchanged. */
  readonly admittedSkillStateSeq: number;
  readonly now: string;
}

export interface SettleProjectSkillTrialDeliveryInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** Immutable claim row project; settlement SQL rechecks this binding. */
  readonly projectId: ProjectId;
  /** The token returned by the claim that entered delivery. */
  readonly attemptToken: string;
  /** Driver kind of the routed instance, recorded only on acceptance. */
  readonly providerDriverKind: string;
  readonly now: string;
  /**
   * Optional managed-send evidence, assigned only inside the same UPDATE
   * that accepts delivery and only while the ref binding, live
   * project/thread incarnation, and logically open window all still hold.
   * Absent or ineligible leaves the row accepted but unlabelled forever.
   */
  readonly managedSend?: ProjectSkillManagedSendEvidence;
}

export interface SweepProjectSkillTrialsInput {
  readonly projectId: ProjectId;
  readonly ref: ProjectSkillVersionRef;
  readonly now: string;
}

export class ProjectSkillTrialRepository extends Context.Service<
  ProjectSkillTrialRepository,
  {
    /** Current project state sequence (0 before the first change), for admission stamps. */
    readonly stateSequence: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<number, ProjectSkillTrialRepositoryError>;
    readonly claimDelivery: (
      input: ClaimProjectSkillTrialDeliveryInput,
    ) => Effect.Effect<ProjectSkillTrialClaimOutcome, ProjectSkillTrialRepositoryError>;
    readonly settleDelivery: (
      input: SettleProjectSkillTrialDeliveryInput,
    ) => Effect.Effect<ProjectSkillTrialSettleOutcome, ProjectSkillTrialRepositoryError>;
    /** Immutable `project_id` for an exact claim token, including tombstoned rows. */
    readonly claimProjectForSettlement: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly attemptToken: string;
    }) => Effect.Effect<Option.Option<ProjectId>, ProjectSkillTrialRepositoryError>;
    /** Advances open windows for one ref and returns every row's current state. */
    readonly sweepTrials: (
      input: SweepProjectSkillTrialsInput,
    ) => Effect.Effect<ProjectSkillTrialSweepResult, ProjectSkillTrialRepositoryError>;
    readonly claimUseDelivery: (
      input: ClaimProjectSkillUseDeliveryInput,
    ) => Effect.Effect<ProjectSkillUseClaimOutcome, ProjectSkillTrialRepositoryError>;
  }
>()("t3/persistence/ProjectSkillTrials/ProjectSkillTrialRepository") {}

/** Same safe-int bound the S1 sequence fields use. */
const SafeNonNegInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

const InputDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  projectId: ProjectId,
  skillId: ProjectSkillId,
  version: PositiveInt,
  contentSha256: Sha256Hex,
  inputEventSequence: SafeNonNegInt,
  inputIncarnation: SafeNonNegInt,
  admittedSkillStateSeq: Schema.NullOr(SafeNonNegInt),
  delivery: Schema.Literals(["unknown", "provider-accepted"]),
  providerDriverKind: Schema.NullOr(TrimmedNonEmptyString),
  window: Schema.Literals(["open", "closed", "thread-recreated"]),
  uncountedAttempts: SafeNonNegInt,
  tombstonedAt: Schema.NullOr(Schema.String),
  managedSendJson: Schema.NullOr(Schema.String),
});

const ObservationDbRow = Schema.Struct({
  evidenceId: ProjectSkillEvidenceId,
  attemptId: Schema.String,
  receiptSequence: SafeNonNegInt,
  outcome: Schema.Literals(["all-selected-passed", "failed"]),
  endedAt: Schema.NullOr(Schema.String),
});

const ReconciliationObservationDbRow = Schema.Struct({
  ...ObservationDbRow.fields,
  projectId: ProjectId,
  skillId: ProjectSkillId,
  version: PositiveInt,
  contentSha256: Sha256Hex,
  checkJson: Schema.String,
});

const SettleRow = Schema.Struct({
  attemptToken: Schema.String,
  delivery: Schema.Literals(["unknown", "provider-accepted"]),
});
const decodeSettleRow = Schema.decodeUnknownEffect(SettleRow);

const FirstEventRow = Schema.Struct({ first: Schema.NullOr(SafeNonNegInt) });
const LegacyBoundaryRow = Schema.Struct({
  sequence: SafeNonNegInt,
  sameTask: SafeNonNegInt,
});
const HeadRow = Schema.Struct({ head: SafeNonNegInt });
const StateSeqRow = Schema.Struct({ seq: SafeNonNegInt });

interface StoredReceiptWrite {
  readonly receipt: SelectedCheckReceipt;
  readonly sequence: number;
}

/** Only in-window trial attempts left unresolved at closure count — not pre-input or foreign receipts. */
const trialUncountedAtClosure = (verdict: ReturnType<typeof evaluateSkillUseWindow>): boolean =>
  !verdict.ok && verdict.reason === "outcome-incomplete";

/** @public Service construction is part of the canonical Effect module API. */
const decodeContextPayload = Schema.decodeUnknownOption(ProjectSkillContextPayload);
const decodeMessagePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ThreadMessageSentPayload),
);

const selectedScriptIdsEqual = (
  durable: ReadonlyArray<string> | undefined,
  current: ReadonlyArray<string>,
): boolean => {
  if (durable === undefined) return false;
  if (durable.length !== current.length) return false;
  for (let index = 0; index < durable.length; index += 1) {
    if (durable[index] !== current[index]) return false;
  }
  return true;
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const useWorkAssessorOption = yield* Effect.serviceOption(ProjectSkillUseWorkAssessor);

  const sqlError = (
    operation: string,
    detail?: "nested-transaction" | "invalid-input" | "transaction-failed",
  ) =>
    new PersistenceSqlError({
      operation,
      ...(detail === undefined ? {} : { detail }),
    });

  const rowInvalid = (operation: string) =>
    new PersistenceDecodeError({ operation, issue: "row-invalid" });

  // A typed persistence error is never returned as-is: it is rebuilt into
  // this repository's fixed shape, so a foreign operation string, detail,
  // issue, correlation, or cause cannot cross the boundary.
  const rebuildPersistenceError = (
    operation: string,
    cause: PersistenceSqlError | PersistenceDecodeError,
  ): ProjectSkillTrialRepositoryFailure =>
    cause instanceof PersistenceDecodeError
      ? rowInvalid(operation)
      : sqlError(
          operation,
          cause.detail === "nested-transaction" ||
            cause.detail === "invalid-input" ||
            cause.detail === "transaction-failed"
            ? cause.detail
            : undefined,
        );

  const refineCause = (
    operation: string,
    cause: Cause.Cause<unknown>,
    boundary: boolean,
  ): Effect.Effect<never, ProjectSkillTrialRepositoryError> => {
    if (Cause.hasInterrupts(cause)) {
      return Effect.failCause(cause);
    }
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure)) {
      const err = failure.value;
      if (isPersistenceError(err)) {
        return Effect.fail(rebuildPersistenceError(operation, err));
      }
      return Effect.fail(
        boundary ? sqlError(operation, "transaction-failed") : sqlError(operation),
      );
    }
    return Effect.fail(sqlError(operation, boundary ? "transaction-failed" : undefined));
  };

  // Refine the full cause before any typed mapping: mixed fail/die+interrupt
  // must return the original cause so cancellation is never stripped.
  const refineWork = <A>(
    operation: string,
    work: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, ProjectSkillTrialRepositoryError> =>
    work.pipe(Effect.catchCause((cause) => refineCause(operation, cause, false)));

  // Anything still unrefined past withTransaction came from the transaction
  // boundary — BEGIN/COMMIT/ROLLBACK — never from work.
  const refineBoundary = <A>(
    operation: string,
    effect: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, ProjectSkillTrialRepositoryError> =>
    effect.pipe(Effect.catchCause((cause) => refineCause(operation, cause, true)));

  // Write methods must own a top-level transaction so the returned value only
  // exists after COMMIT. If the caller already holds this client's transaction
  // permit, nesting would silently savepoint-commit — the row could then
  // vanish with the outer rollback while the caller believes it was durable.
  const transact = <A>(operation: string, work: Effect.Effect<A, unknown>) =>
    refineBoundary(
      operation,
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (active) =>
        Option.isSome(active)
          ? Effect.fail(sqlError(operation, "nested-transaction"))
          : sql.withTransaction(refineWork(operation, work)),
      ),
    );

  const decodeInputRow = Schema.decodeUnknownEffect(InputDbRow);
  const decodeObservationRow = Schema.decodeUnknownEffect(ObservationDbRow);
  const decodeReconciliationObservationRow = Schema.decodeUnknownEffect(
    ReconciliationObservationDbRow,
  );
  const decodeFirstEventRow = Schema.decodeUnknownEffect(FirstEventRow);
  const decodeLegacyBoundaryRow = Schema.decodeUnknownEffect(LegacyBoundaryRow);
  const decodeHeadRow = Schema.decodeUnknownEffect(HeadRow);
  const decodeStateSeqRow = Schema.decodeUnknownEffect(StateSeqRow);

  const refineDecode = <A>(
    effect: Effect.Effect<A, Schema.SchemaError>,
    operation: string,
  ): Effect.Effect<A, PersistenceDecodeError> =>
    Effect.mapError(effect, (cause) => PersistenceDecodeError.fromSchemaError(operation, cause));

  const safeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;

  // Reads and writes alike hide rows whose project row was raw-deleted from
  // the projection — only the tombstone trigger may remove skill data.
  const liveProjectFor = (projectId: string) => sql`
    EXISTS (
      SELECT 1 FROM projection_projects p
      WHERE p.project_id = ${projectId} AND p.deleted_at IS NULL
    )
  `;

  const decodeManagedSendJson = Schema.decodeUnknownOption(
    Schema.fromJsonString(ProjectSkillManagedSendEvidence),
  );

  // A projected turn alone cannot authenticate an old approval: its request
  // must follow an active session for that turn in the trial's incarnation.
  // Unbound, foreign, duplicated, and post-terminal responses remain boundaries.
  const sameTaskApproval = (row?: typeof InputDbRow.Type) => {
    const trialThread =
      row === undefined ? sql`project_skill_inputs.thread_id` : sql`${row.threadId}`;
    const trialMessage =
      row === undefined ? sql`project_skill_inputs.message_id` : sql`${row.messageId}`;
    const trialInput =
      row === undefined
        ? sql`project_skill_inputs.input_event_sequence`
        : sql`${row.inputEventSequence}`;
    const trialIncarnation =
      row === undefined
        ? sql`project_skill_inputs.input_incarnation`
        : sql`${row.inputIncarnation}`;
    return sql`(
      event_type = 'thread.approval-response-requested'
      AND json_type(payload_json, '$.requestId') = 'text'
      AND length(json_extract(payload_json, '$.requestId')) > 0
      AND EXISTS (
        SELECT 1 FROM projection_turns pt
        WHERE pt.thread_id = ${trialThread}
          AND pt.pending_message_id = ${trialMessage}
          AND pt.turn_id IS NOT NULL
          AND (SELECT COUNT(*) FROM projection_turns linked
            WHERE linked.thread_id = ${trialThread}
              AND linked.pending_message_id = ${trialMessage}) = 1
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events recreated
            WHERE recreated.aggregate_kind = 'thread'
              AND recreated.stream_id = ${trialThread}
              AND recreated.event_type = 'thread.created'
              AND recreated.sequence > ${trialIncarnation}
              AND recreated.sequence < orchestration_events.sequence
          )
          AND (SELECT COUNT(*) FROM orchestration_events request
            WHERE request.aggregate_kind = 'thread'
              AND request.stream_id = ${trialThread}
              AND request.event_type = 'thread.activity-appended'
              AND request.sequence > ${trialInput}
              AND request.sequence < orchestration_events.sequence
              AND json_extract(request.payload_json, '$.activity.kind') = 'approval.requested'
              AND json_extract(request.payload_json, '$.activity.payload.requestId') =
                json_extract(orchestration_events.payload_json, '$.requestId')
          ) = 1
          AND EXISTS (
            SELECT 1 FROM orchestration_events request
            WHERE request.aggregate_kind = 'thread'
              AND request.stream_id = ${trialThread}
              AND request.event_type = 'thread.activity-appended'
              AND request.sequence > ${trialInput}
              AND request.sequence < orchestration_events.sequence
              AND json_extract(request.payload_json, '$.activity.kind') = 'approval.requested'
              AND json_extract(request.payload_json, '$.activity.payload.requestId') =
                json_extract(orchestration_events.payload_json, '$.requestId')
              AND json_extract(request.payload_json, '$.activity.turnId') = pt.turn_id
              AND EXISTS (
                SELECT 1 FROM orchestration_events active
                WHERE active.aggregate_kind = 'thread'
                  AND active.stream_id = ${trialThread}
                  AND active.event_type = 'thread.session-set'
                  AND active.sequence > ${trialInput}
                  AND active.sequence < request.sequence
                  AND json_extract(active.payload_json, '$.session.status') = 'running'
                  AND json_extract(active.payload_json, '$.session.activeTurnId') = pt.turn_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events terminal
            WHERE terminal.aggregate_kind = 'thread'
              AND terminal.stream_id = ${trialThread}
              AND terminal.event_type = 'thread.session-set'
              AND terminal.sequence > ${trialInput}
              AND terminal.sequence < orchestration_events.sequence
              AND json_extract(terminal.payload_json, '$.session.activeTurnId') IS NULL
              AND json_extract(terminal.payload_json, '$.session.status')
                IN ('ready', 'idle', 'stopped', 'interrupted', 'error')
              AND EXISTS (
                SELECT 1 FROM orchestration_events active
                WHERE active.aggregate_kind = 'thread'
                  AND active.stream_id = ${trialThread}
                  AND active.event_type = 'thread.session-set'
                  AND active.sequence > ${trialInput}
                  AND active.sequence < terminal.sequence
                  AND json_extract(active.payload_json, '$.session.status') = 'running'
                  AND json_extract(active.payload_json, '$.session.activeTurnId') = pt.turn_id
              )
          )
      )
    )`;
  };

  // The logically-open window a managed label still fits: the stored flag
  // alone is not enough — an unswept row marked `open` is already closed when
  // a real next input or a recreation event landed after the canonical input.
  // Evaluated inside the settle UPDATE so the evidence is assigned atomically
  // with acceptance, on the same row image and event snapshot.
  const managedSendWindowOpen = (evidence: ProjectSkillManagedSendEvidence) => sql`
    window = 'open' AND tombstoned_at IS NULL
    AND project_id = ${evidence.deliveredRef.projectId}
    AND skill_id = ${evidence.deliveredRef.skillId}
    AND version = ${evidence.deliveredRef.version}
    AND content_sha256 = ${evidence.deliveredRef.contentSha256}
    AND ${liveProjectFor(evidence.deliveredRef.projectId)}
    AND EXISTS (
      SELECT 1 FROM projection_threads t
      WHERE t.thread_id = project_skill_inputs.thread_id
        AND t.project_id = project_skill_inputs.project_id
        AND t.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = project_skill_inputs.thread_id
        AND event_type IN ('thread.created', 'thread.deleted')
        AND sequence > project_skill_inputs.input_event_sequence
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = project_skill_inputs.thread_id
        AND ${projectSkillInputEventPredicate(sql)}
        AND NOT (
          event_type = 'thread.turn-start-requested'
          AND json_extract(payload_json, '$.messageId') = project_skill_inputs.message_id
        )
        AND NOT ${sameTaskApproval()}
        AND sequence > project_skill_inputs.input_event_sequence
    )
  `;

  const inputColumns = sql`
    i.thread_id AS "threadId",
    i.message_id AS "messageId",
    i.project_id AS "projectId",
    i.skill_id AS "skillId",
    i.version AS "version",
    i.content_sha256 AS "contentSha256",
    i.input_event_sequence AS "inputEventSequence",
    i.input_incarnation AS "inputIncarnation",
    i.admitted_skill_state_seq AS "admittedSkillStateSeq",
    i.delivery AS "delivery",
    i.provider_driver_kind AS "providerDriverKind",
    i.window AS "window",
    i.uncounted_attempts AS "uncountedAttempts",
    i.tombstoned_at AS "tombstonedAt",
    i.managed_send_json AS "managedSendJson"
  `;

  const stateSequence: ProjectSkillTrialRepository["Service"]["stateSequence"] = Effect.fnUntraced(
    function* (input: {
      readonly projectId: ProjectId;
    }): Effect.fn.Return<number, ProjectSkillTrialRepositoryError> {
      const operation = "ProjectSkillTrialRepository.stateSequence";
      const rows = yield* refineWork(
        operation,
        Effect.flatMap(
          sql`SELECT seq FROM project_skill_state WHERE project_id = ${input.projectId}`,
          (raw) =>
            Effect.forEach(raw, (row) => refineDecode(decodeStateSeqRow(row), `${operation}:row`)),
        ),
      );
      return rows[0]?.seq ?? 0;
    },
  );

  // The claim is a bounded SQL section with no provider in it: it runs
  // uninterruptibly so a caller interrupt cannot land between the conditional
  // checks and the INSERT's COMMIT.
  const claimDelivery: ProjectSkillTrialRepository["Service"]["claimDelivery"] = (
    input,
  ): Effect.Effect<ProjectSkillTrialClaimOutcome, ProjectSkillTrialRepositoryError> => {
    const operation = "ProjectSkillTrialRepository.claimDelivery";
    if (
      !safeInt(input.inputEventSequence) ||
      !safeInt(input.admittedSkillStateSeq) ||
      !Number.isSafeInteger(input.ref.version) ||
      input.ref.version < 1 ||
      input.now.length === 0 ||
      input.ref.projectId !== input.projectId
    ) {
      return Effect.fail(sqlError(operation, "invalid-input"));
    }
    return refineWork(operation, crypto.randomUUIDv4).pipe(
      Effect.flatMap((attemptToken) =>
        Effect.uninterruptible(
          transact(
            operation,
            Effect.gen(function* () {
              // The canonical accepted input: this exact committed user
              // message event must exist in the server's event store. A
              // turn-request sequence can never satisfy this SELECT.
              const inputEvents = yield* sql`
              SELECT 1 FROM orchestration_events
              WHERE sequence = ${input.inputEventSequence}
                AND aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                AND event_type = 'thread.message-sent'
                AND json_extract(payload_json, '$.role') = 'user'
                AND json_extract(payload_json, '$.messageId') = ${input.messageId}
            `;
              if (inputEvents.length === 0) {
                return { status: "input-event-missing" } as const;
              }

              // The input's incarnation must still be the thread's latest: no
              // recreation may sit between the message event and this claim.
              const recreated = yield* sql`
              SELECT 1 FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                AND event_type IN ('thread.created', 'thread.deleted')
                AND sequence > ${input.inputEventSequence}
            `;
              if (recreated.length > 0) {
                return { status: "thread-recreated" } as const;
              }

              const incarnationRows = yield* sql<{ readonly incarnation: number | null }>`
              SELECT MAX(sequence) AS "incarnation"
              FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                AND event_type = 'thread.created'
                AND sequence < ${input.inputEventSequence}
            `;
              const incarnation = incarnationRows[0]?.incarnation ?? 0;

              // The admitted ref must still be this project's live candidate
              // version, the thread still live in that project, and no state
              // change may have landed since the admission stamp.
              const versionRows = yield* sql`
              SELECT 1 FROM project_skill_versions v
              WHERE v.skill_id = ${input.ref.skillId}
                AND v.project_id = ${input.projectId}
                AND v.version = ${input.ref.version}
                AND v.content_sha256 = ${input.ref.contentSha256}
                AND v.state = 'candidate'
                AND ${liveProjectFor(input.projectId)}
                AND EXISTS (
                  SELECT 1 FROM projection_threads t
                  WHERE t.thread_id = ${input.threadId}
                    AND t.project_id = ${input.projectId}
                    AND t.deleted_at IS NULL
                )
            `;
              if (versionRows.length === 0) {
                return { status: "ref-changed" } as const;
              }
              const seqRows = yield* sql<{ readonly seq: number | null }>`
              SELECT seq FROM project_skill_state WHERE project_id = ${input.projectId}
            `;
              if ((seqRows[0]?.seq ?? 0) !== input.admittedSkillStateSeq) {
                return { status: "ref-changed" } as const;
              }

              // One atomic claim: the winner is the invocation whose row this
              // INSERT actually wrote. Every other constraint outcome lands on
              // the fixed, state-free no-resend.
              const inserted = yield* sql<{ readonly attemptToken: unknown }>`
              INSERT OR IGNORE INTO project_skill_inputs (
                thread_id, message_id, project_id, skill_id, version, content_sha256,
                input_event_sequence, input_incarnation, admitted_skill_state_seq,
                provider_driver_kind, native_skill_inventory_sha256,
                delivery, delivery_at, window, window_closed_at, uncounted_attempts,
                attempt_token, claimed_at, tombstoned_at
              )
              VALUES (
                ${input.threadId}, ${input.messageId}, ${input.projectId},
                ${input.ref.skillId}, ${input.ref.version}, ${input.ref.contentSha256},
                ${input.inputEventSequence}, ${incarnation}, ${input.admittedSkillStateSeq},
                NULL, NULL,
                'unknown', NULL, 'open', NULL, 0,
                ${attemptToken}, ${input.now}, NULL
              )
              RETURNING attempt_token AS "attemptToken"
            `;
              if (inserted[0] !== undefined) {
                return { status: "entered", attemptToken } as const;
              }

              // An existing row owns this identity. Read only the binding —
              // never the delivery state, and never the stored token, which is
              // the original claimant's settlement secret.
              const existing = yield* sql<{
                readonly inputEventSequence: number;
                readonly inputIncarnation: number;
              }>`
              SELECT input_event_sequence AS "inputEventSequence",
                input_incarnation AS "inputIncarnation"
              FROM project_skill_inputs
              WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
            `;
              const row = existing[0];
              if (row === undefined) {
                // OR IGNORE swallowed our own insert without a row to show for
                // it: a constraint failure, never a legitimate no-resend.
                return yield* sqlError(operation, "invalid-input");
              }
              if (
                row.inputEventSequence !== input.inputEventSequence ||
                row.inputIncarnation !== incarnation
              ) {
                return { status: "stale-identity" } as const;
              }
              return { status: "no-resend" } as const;
            }),
          ),
        ),
      ),
    );
  };

  // Same bounded section as the claim: settlement is a single guarded UPDATE
  // bound to the claimed token, and a failure leaves `unknown` — it can
  // never manufacture provider acceptance.
  const settleDelivery: ProjectSkillTrialRepository["Service"]["settleDelivery"] = (
    input,
  ): Effect.Effect<ProjectSkillTrialSettleOutcome, ProjectSkillTrialRepositoryError> => {
    const operation = "ProjectSkillTrialRepository.settleDelivery";
    if (
      input.attemptToken.length === 0 ||
      input.projectId.length === 0 ||
      input.providerDriverKind.trim().length === 0 ||
      (input.managedSend !== undefined &&
        (!safeInt(input.managedSend.deliveredRef.version) ||
          input.managedSend.deliveredRef.version < 1))
    ) {
      return Effect.fail(sqlError(operation, "invalid-input"));
    }
    // The label rides the same UPDATE as acceptance: when supplied it is
    // written only while the stored ref, live project/thread, and the
    // logically open window all still hold — otherwise the acceptance lands
    // ordinary and the row can never be enriched later.
    const managedAssign =
      input.managedSend === undefined
        ? sql``
        : sql`, managed_send_json = CASE WHEN ${managedSendWindowOpen(input.managedSend)} THEN ${JSON.stringify(input.managedSend)} ELSE NULL END`;
    return Effect.uninterruptible(
      transact(
        operation,
        Effect.gen(function* () {
          const settled = yield* sql<{ readonly messageId: unknown }>`
            UPDATE project_skill_inputs
            SET delivery = 'provider-accepted',
              provider_driver_kind = ${input.providerDriverKind},
              delivery_at = ${input.now}
              ${managedAssign}
            WHERE thread_id = ${input.threadId}
              AND message_id = ${input.messageId}
              AND project_id = ${input.projectId}
              AND attempt_token = ${input.attemptToken}
              AND delivery = 'unknown'
            RETURNING message_id AS "messageId"
          `;
          if (settled[0] !== undefined) {
            return { status: "applied" } as const;
          }
          const rows = yield* sql<{
            readonly attemptToken: unknown;
            readonly delivery: unknown;
            readonly projectId: ProjectId;
          }>`
            SELECT attempt_token AS "attemptToken", delivery AS "delivery",
              project_id AS "projectId"
            FROM project_skill_inputs
            WHERE thread_id = ${input.threadId}
              AND message_id = ${input.messageId}
          `;
          const row = rows[0];
          if (row === undefined) {
            return { status: "not-found" } as const;
          }
          if (String(row.attemptToken) !== input.attemptToken) {
            return { status: "not-owned" } as const;
          }
          if (row.projectId !== input.projectId) {
            return { status: "not-owned" } as const;
          }
          const decoded = yield* refineDecode(
            decodeSettleRow({
              attemptToken: row.attemptToken,
              delivery: row.delivery,
            }),
            `${operation}:row`,
          );
          return decoded.delivery === "unknown"
            ? ({ status: "not-owned" } as const)
            : ({ status: "already-final" } as const);
        }),
      ),
    );
  };

  const claimProjectForSettlement: ProjectSkillTrialRepository["Service"]["claimProjectForSettlement"] =
    (input) => {
      const operation = "ProjectSkillTrialRepository.claimProjectForSettlement";
      if (input.attemptToken.length === 0) {
        return Effect.fail(sqlError(operation, "invalid-input"));
      }
      // The cause-aware boundary: a typed SQL fault becomes the fixed
      // diagnostic, while any interrupt-bearing cause (even mixed with a typed
      // failure) is returned whole.
      return refineWork(
        operation,
        Effect.map(
          sql<{ readonly projectId: ProjectId | null }>`
            SELECT project_id AS "projectId"
            FROM project_skill_inputs
            WHERE thread_id = ${input.threadId}
              AND message_id = ${input.messageId}
              AND attempt_token = ${input.attemptToken}
          `,
          (rows) => {
            const projectId = rows[0]?.projectId;
            return projectId === null || projectId === undefined
              ? Option.none()
              : Option.some(projectId);
          },
        ),
      );
    };

  const eventHead = (operation: string) =>
    Effect.flatMap(
      sql`SELECT COALESCE(MAX(sequence), 0) AS "head" FROM orchestration_events`,
      (raw) =>
        Effect.flatMap(
          refineDecode(decodeHeadRow(raw[0] ?? { head: 0 }), `${operation}:head`),
          (row) => Effect.succeed(row.head),
        ),
    );

  // First recreation event after the input, or null.
  const recreationAfter = (operation: string, row: typeof InputDbRow.Type) =>
    Effect.flatMap(
      sql`
        SELECT MIN(sequence) AS "first" FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${row.threadId}
          AND event_type IN ('thread.created', 'thread.deleted')
          AND sequence > ${row.inputEventSequence}
      `,
      (raw) =>
        Effect.flatMap(
          refineDecode(decodeFirstEventRow(raw[0] ?? { first: null }), `${operation}:recreation`),
          (decoded) => Effect.succeed(decoded.first),
        ),
    );

  // Next real input after this trial's canonical input event: keep the shared
  // user-input predicate, excluding this message's paired/re-emitted turn
  // requests and approvals proved to belong to this trial's own turn.
  const nextInputAfter = (operation: string, row: typeof InputDbRow.Type) =>
    Effect.flatMap(
      sql`
        SELECT MIN(sequence) AS "first" FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${row.threadId}
          AND ${projectSkillInputEventPredicate(sql)}
          AND NOT (
            event_type = 'thread.turn-start-requested'
            AND json_extract(payload_json, '$.messageId') = ${row.messageId}
          )
          AND NOT ${sameTaskApproval(row)}
          AND sequence > ${row.inputEventSequence}
      `,
      (raw) =>
        Effect.flatMap(
          refineDecode(decodeFirstEventRow(raw[0] ?? { first: null }), `${operation}:next-input`),
          (decoded) => Effect.succeed(decoded.first),
        ),
    );

  const firstLegacyBoundary = (operation: string, row: typeof InputDbRow.Type) =>
    Effect.flatMap(
      sql`
        SELECT sequence AS "sequence", ${sameTaskApproval(row)} AS "sameTask"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${row.threadId}
          AND ${projectSkillInputEventPredicate(sql)}
          AND NOT (
            event_type = 'thread.turn-start-requested'
            AND json_extract(payload_json, '$.messageId') = ${row.messageId}
          )
          AND sequence > ${row.inputEventSequence}
        ORDER BY sequence ASC
        LIMIT 1
      `,
      (raw) =>
        raw[0] === undefined
          ? Effect.succeed(false)
          : Effect.map(
              refineDecode(decodeLegacyBoundaryRow(raw[0]), `${operation}:legacy-boundary`),
              (boundary) => boundary.sameTask === 1,
            ),
    );

  // Every selected-check receipt write in (after, upTo], decoded and bound
  // through the shared decoder, reduced to each attempt's latest write. A
  // candidate row that fails to decode is an integrity failure — never an
  // empty history and never a silently skipped event.
  const attemptReceiptsThrough = (
    operation: string,
    row: typeof InputDbRow.Type,
    upTo: number,
  ): Effect.Effect<ReadonlyArray<StoredReceiptWrite>, ProjectSkillTrialRepositoryError> =>
    refineWork(
      operation,
      Effect.gen(function* () {
        const prefix = SELECTED_CHECK_RECEIPT_COMMAND_PREFIX;
        const rawEvents = yield* sql<{ readonly sequence: number; readonly payloadJson: string }>`
            SELECT sequence AS "sequence", payload_json AS "payloadJson"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${row.threadId}
              AND event_type = 'thread.activity-appended'
              AND substr(command_id, 1, ${prefix.length}) = ${prefix}
              AND json_extract(payload_json, '$.threadId') = ${row.threadId}
              AND json_extract(payload_json, '$.activity.id') = ${selectedCheckReceiptId(row.threadId)}
              AND json_extract(payload_json, '$.activity.kind') = ${SELECTED_CHECK_RECEIPT_KIND}
              AND sequence > ${row.inputEventSequence} AND sequence <= ${upTo}
            ORDER BY sequence ASC
          `;
        const latestByAttempt = new Map<string, StoredReceiptWrite>();
        for (const event of rawEvents) {
          const receipt = decodeSelectedCheckReceiptActivity(event.payloadJson, row.threadId);
          if (Option.isNone(receipt)) {
            return yield* new PersistenceDecodeError({
              operation: `${operation}:receipt`,
              issue: "receipt-activity-invalid",
            });
          }
          // ASC order: the later write for an attempt replaces the earlier.
          latestByAttempt.set(receipt.value.attemptId, {
            receipt: receipt.value,
            sequence: event.sequence,
          });
        }
        return [...latestByAttempt.values()];
      }),
    );

  const canonicalUserMessageForRow = (operation: string, row: typeof InputDbRow.Type) =>
    Effect.gen(function* () {
      const events = yield* sql<{ readonly payloadJson: string | null }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE sequence = ${row.inputEventSequence}
          AND aggregate_kind = 'thread' AND stream_id = ${row.threadId}
          AND event_type = 'thread.message-sent'
      `;
      const payloadJson = events[0]?.payloadJson;
      if (payloadJson === null || payloadJson === undefined) return Option.none();
      const message = decodeMessagePayload(payloadJson);
      if (Option.isNone(message)) return Option.none();
      if (
        message.value.threadId !== row.threadId ||
        message.value.messageId !== row.messageId ||
        message.value.role !== "user"
      ) {
        return yield* new PersistenceDecodeError({
          operation: `${operation}:input-message-binding`,
          issue: "canonical message event does not bind the input row",
        });
      }
      return message;
    });

  /** Sweep policy: legacy trial rows without context records stay `trial`. */
  const inputModeForRow = Effect.fnUntraced(function* (
    operation: string,
    row: typeof InputDbRow.Type,
    ref: ProjectSkillVersionRef,
  ) {
    const message = yield* canonicalUserMessageForRow(operation, row);
    if (Option.isNone(message)) return "trial" as const;
    for (const record of message.value.context?.records ?? []) {
      if (record.kind !== PROJECT_SKILL_CONTEXT_KIND) continue;
      const payload = decodeContextPayload(record.payload);
      if (Option.isNone(payload)) continue;
      const recordRef = payload.value.ref;
      if (
        recordRef.projectId === ref.projectId &&
        recordRef.skillId === ref.skillId &&
        recordRef.version === ref.version &&
        recordRef.contentSha256 === ref.contentSha256
      ) {
        return payload.value.mode;
      }
    }
    return "trial" as const;
  });

  const storedRefEquals = (row: typeof InputDbRow.Type, ref: ProjectSkillVersionRef): boolean =>
    row.projectId === ref.projectId &&
    row.skillId === ref.skillId &&
    row.version === ref.version &&
    row.contentSha256 === ref.contentSha256;

  /**
   * Use-claim guard for provider-accepted rows: reprove stored ref, project,
   * incarnation, and any project-skill context against the ledger row. Legacy
   * trial rows with no skill context remain `skip`; a present but mismatched
   * context is never treated as trial.
   */
  const useClaimGuardModeForRow = Effect.fnUntraced(function* (
    operation: string,
    row: typeof InputDbRow.Type,
    ref: ProjectSkillVersionRef,
  ) {
    if (!storedRefEquals(row, ref)) {
      return { kind: "invalid-binding" } as const;
    }
    const incarnationRows = yield* sql<{ readonly incarnation: number | null }>`
      SELECT MAX(sequence) AS "incarnation"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${row.threadId}
        AND event_type = 'thread.created'
        AND sequence < ${row.inputEventSequence}
    `;
    const incarnation = incarnationRows[0]?.incarnation ?? 0;
    if (row.inputIncarnation !== incarnation) {
      return { kind: "invalid-binding" } as const;
    }
    const message = yield* canonicalUserMessageForRow(operation, row);
    if (Option.isNone(message)) {
      return { kind: "invalid-binding" } as const;
    }
    const rowRef: ProjectSkillVersionRef = {
      projectId: row.projectId,
      skillId: row.skillId,
      version: row.version,
      contentSha256: row.contentSha256,
    };
    let sawSkillContext = false;
    for (const record of message.value.context?.records ?? []) {
      if (record.kind !== PROJECT_SKILL_CONTEXT_KIND) continue;
      sawSkillContext = true;
      const payload = decodeContextPayload(record.payload);
      if (Option.isNone(payload)) {
        return { kind: "invalid-binding" } as const;
      }
      const recordRef = payload.value.ref;
      if (
        recordRef.projectId !== rowRef.projectId ||
        recordRef.skillId !== rowRef.skillId ||
        recordRef.version !== rowRef.version ||
        recordRef.contentSha256 !== rowRef.contentSha256
      ) {
        continue;
      }
      const rowStamp = row.admittedSkillStateSeq ?? 0;
      const stamp = payload.value.admittedSkillStateSeq;
      if (stamp === undefined || stamp !== rowStamp) {
        return { kind: "invalid-binding" } as const;
      }
      if (payload.value.mode === "use") {
        return { kind: "use" } as const;
      }
      return { kind: "skip" } as const;
    }
    if (!sawSkillContext) return { kind: "skip" } as const;
    return { kind: "invalid-binding" } as const;
  });

  const windowInputObservation = (
    row: typeof InputDbRow.Type,
    ref: ProjectSkillVersionRef,
    mode: "use" | "trial",
  ): ProjectSkillInputObservation => ({
    threadId: row.threadId,
    projectId: row.projectId,
    messageId: row.messageId,
    inputEventSequence: row.inputEventSequence,
    admittedSkillStateSeq: row.admittedSkillStateSeq ?? 0,
    providerDriverKind: row.providerDriverKind,
    nativeSkillInventorySha256: null,
    items: [{ ref, mode }],
  });

  const readObservations = (
    operation: string,
    row: typeof InputDbRow.Type,
  ): Effect.Effect<
    ReadonlyArray<ProjectSkillTrialObservationRow>,
    ProjectSkillTrialRepositoryError
  > =>
    refineWork(
      operation,
      Effect.gen(function* () {
        const rawRows: ReadonlyArray<unknown> = yield* sql`
          SELECT evidence_id AS "evidenceId", attempt_id AS "attemptId",
            receipt_sequence AS "receiptSequence", outcome AS "outcome", ended_at AS "endedAt"
          FROM project_skill_observed_uses
          WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
          ORDER BY receipt_sequence ASC, evidence_id ASC
        `;
        return yield* Effect.forEach(rawRows, (raw) =>
          refineDecode(decodeObservationRow(raw), `${operation}:observation`),
        );
      }),
    );

  const readReconciliationObservations = (operation: string, row: typeof InputDbRow.Type) =>
    Effect.flatMap(
      sql`
        SELECT evidence_id AS "evidenceId", attempt_id AS "attemptId",
          receipt_sequence AS "receiptSequence", outcome AS "outcome",
          ended_at AS "endedAt", project_id AS "projectId",
          skill_id AS "skillId", version AS "version",
          content_sha256 AS "contentSha256", check_json AS "checkJson"
        FROM project_skill_observed_uses
        WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
        ORDER BY receipt_sequence ASC, evidence_id ASC
      `,
      (raw) =>
        Effect.forEach(raw, (value) =>
          refineDecode(
            decodeReconciliationObservationRow(value),
            `${operation}:reconciliation-observation`,
          ),
        ),
    );

  const sweepRefWork = (
    operation: string,
    input: SweepProjectSkillTrialsInput,
  ): Effect.Effect<ProjectSkillTrialSweepResult, unknown> =>
    Effect.gen(function* () {
      const head = yield* eventHead(operation);
      const rawRows: ReadonlyArray<unknown> = yield* sql`
        SELECT ${inputColumns}
        FROM project_skill_inputs i
        WHERE i.project_id = ${input.projectId}
          AND i.skill_id = ${input.ref.skillId}
          AND i.version = ${input.ref.version}
          AND i.content_sha256 = ${input.ref.contentSha256}
          AND i.tombstoned_at IS NULL
          AND ${liveProjectFor(input.projectId)}
        ORDER BY i.input_event_sequence ASC, i.message_id ASC
      `;
      const rows = yield* Effect.forEach(rawRows, (raw) =>
        refineDecode(decodeInputRow(raw), `${operation}:row`),
      );

      const items: Array<ProjectSkillTrialRow> = [];
      for (const row of rows) {
        const inputMode = yield* inputModeForRow(operation, row, input.ref);
        const base: ProjectSkillTrialRow = {
          threadId: row.threadId,
          messageId: row.messageId,
          projectId: row.projectId,
          inputEventSequence: row.inputEventSequence,
          inputIncarnation: row.inputIncarnation,
          admittedSkillStateSeq: row.admittedSkillStateSeq ?? 0,
          delivery: row.delivery,
          providerDriverKind: row.providerDriverKind,
          nativeSkillInventorySha256: null,
          window: row.window,
          uncountedAttempts: row.uncountedAttempts,
          tombstonedAt: row.tombstonedAt,
          managedSend: Option.getOrNull(decodeManagedSendJson(row.managedSendJson)),
          observations: [],
          provisional: [],
        };

        const storedObservations =
          row.window === "open" ? [] : yield* readObservations(operation, row);
        if (
          row.window !== "open" &&
          (row.window !== "closed" ||
            row.delivery !== "provider-accepted" ||
            !(yield* firstLegacyBoundary(operation, row)))
        ) {
          items.push({ ...base, observations: storedObservations });
          continue;
        }
        const reconciling = row.window === "closed";

        const recreation = yield* recreationAfter(operation, row);
        const nextInput = yield* nextInputAfter(operation, row);

        if (recreation !== null && (nextInput === null || recreation < nextInput)) {
          if (reconciling) {
            items.push({ ...base, observations: storedObservations });
            continue;
          }
          yield* refineWork(
            operation,
            Effect.gen(function* () {
              const closed = yield* sql<{ readonly messageId: unknown }>`
                UPDATE project_skill_inputs
                SET window = 'thread-recreated', window_closed_at = ${input.now},
                  uncounted_attempts = ${row.uncountedAttempts}
                WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
                  AND window = 'open'
                RETURNING message_id AS "messageId"
              `;
              if (closed[0] === undefined) {
                return yield* sqlError(operation);
              }
            }),
          );
          items.push({ ...base, window: "thread-recreated" });
          continue;
        }

        const scanUpTo = nextInput ?? head;
        const attempts = yield* attemptReceiptsThrough(operation, row, scanUpTo);
        const observation = (write: StoredReceiptWrite) =>
          evaluateSkillUseWindow({
            input: windowInputObservation(row, input.ref, inputMode),
            receipt: { receipt: write.receipt, sequence: write.sequence },
            threadRecreatedAfterInput: false,
            nextInputEventSequence: nextInput,
          });

        if (nextInput === null) {
          if (reconciling && storedObservations.length > 0) {
            items.push({ ...base, observations: storedObservations });
            continue;
          }
          const provisional: Array<ProjectSkillTrialProvisionalAttempt> = [];
          for (const write of attempts) {
            const verdict = observation(write);
            if (verdict.ok) {
              provisional.push({
                attemptId: write.receipt.attemptId,
                receiptSequence: verdict.check.receiptSequence,
                outcome: verdict.check.outcome,
                endedAt: verdict.check.endedAt,
              });
            }
          }
          // A historically closed, empty row is only logically open: the DB
          // closure and its timestamp remain untouched until a real boundary.
          items.push({ ...base, window: "open", provisional });
          continue;
        }

        const observations: Array<ProjectSkillTrialObservationRow> = [];
        const checks: Array<ProjectSkillCheckObservation> = [];
        let uncounted = 0;
        for (const write of attempts) {
          const verdict = observation(write);
          if (!verdict.ok) {
            if (trialUncountedAtClosure(verdict)) {
              uncounted += 1;
            }
            continue;
          }
          const check: ProjectSkillCheckObservation = verdict.check;
          const record: ProjectSkillTrialObservationRow = {
            evidenceId: ProjectSkillEvidenceId.make(
              `pse:${row.threadId}:${row.messageId}:${check.attemptId}`,
            ),
            attemptId: check.attemptId,
            receiptSequence: check.receiptSequence,
            outcome: check.outcome,
            endedAt: check.endedAt,
          };
          observations.push(record);
          checks.push(check);
        }

        if (reconciling) {
          const existing = yield* readReconciliationObservations(operation, row);
          const recomputed = new Map(
            observations.map((observation, index) => [observation.evidenceId, checks[index]]),
          );
          if (
            existing.some((stored) => {
              const check = recomputed.get(stored.evidenceId);
              return (
                check === undefined ||
                stored.projectId !== row.projectId ||
                stored.skillId !== row.skillId ||
                stored.version !== row.version ||
                stored.contentSha256 !== row.contentSha256 ||
                stored.attemptId !== check.attemptId ||
                stored.receiptSequence !== check.receiptSequence ||
                stored.outcome !== check.outcome ||
                stored.endedAt !== check.endedAt ||
                stored.checkJson !== JSON.stringify(check)
              );
            })
          ) {
            items.push({ ...base, observations: storedObservations });
            continue;
          }
        }

        for (let index = 0; index < observations.length; index += 1) {
          const record = observations[index];
          const check = checks[index];
          if (record === undefined || check === undefined) {
            return yield* sqlError(operation);
          }
          yield* refineWork(
            operation,
            Effect.gen(function* () {
              yield* sql`
                INSERT OR IGNORE INTO project_skill_observed_uses (
                  evidence_id, thread_id, message_id, attempt_id, project_id,
                  skill_id, version, content_sha256, check_json, receipt_sequence,
                  outcome, ended_at, recorded_at
                )
                VALUES (
                  ${record.evidenceId}, ${row.threadId}, ${row.messageId}, ${record.attemptId},
                  ${row.projectId}, ${input.ref.skillId}, ${input.ref.version},
                  ${input.ref.contentSha256}, ${JSON.stringify(check)}, ${record.receiptSequence},
                  ${record.outcome}, ${record.endedAt}, ${input.now}
                )
              `;
            }),
          );
        }
        if (reconciling) {
          const persisted = yield* readReconciliationObservations(operation, row);
          const expected = new Map(
            observations.map((observation, index) => [
              observation.evidenceId,
              { observation, check: checks[index] },
            ]),
          );
          if (
            persisted.length !== observations.length ||
            persisted.some((stored) => {
              const desired = expected.get(stored.evidenceId);
              const observation = desired?.observation;
              const check = desired?.check;
              return (
                observation === undefined ||
                check === undefined ||
                stored.evidenceId !== observation.evidenceId ||
                stored.projectId !== row.projectId ||
                stored.skillId !== row.skillId ||
                stored.version !== row.version ||
                stored.contentSha256 !== row.contentSha256 ||
                stored.attemptId !== observation.attemptId ||
                stored.receiptSequence !== observation.receiptSequence ||
                stored.outcome !== observation.outcome ||
                stored.endedAt !== observation.endedAt ||
                stored.checkJson !== JSON.stringify(check)
              );
            })
          ) {
            return yield* sqlError(operation);
          }
        }
        yield* refineWork(
          operation,
          Effect.gen(function* () {
            const closed = reconciling
              ? yield* sql<{ readonly messageId: unknown }>`
                  UPDATE project_skill_inputs SET uncounted_attempts = ${uncounted}
                  WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
                    AND project_id = ${row.projectId} AND skill_id = ${row.skillId}
                    AND version = ${row.version} AND content_sha256 = ${row.contentSha256}
                    AND window = 'closed' AND delivery = 'provider-accepted'
                    AND tombstoned_at IS NULL
                    AND uncounted_attempts = ${row.uncountedAttempts}
                  RETURNING message_id AS "messageId"
                `
              : yield* sql<{ readonly messageId: unknown }>`
                  UPDATE project_skill_inputs
                  SET window = 'closed', window_closed_at = ${input.now},
                    uncounted_attempts = ${uncounted}
                  WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
                    AND window = 'open'
                  RETURNING message_id AS "messageId"
                `;
            if (closed[0] === undefined) {
              return yield* sqlError(operation);
            }
          }),
        );
        items.push({
          ...base,
          window: "closed",
          uncountedAttempts: uncounted,
          observations,
        });
      }
      return { head, items };
    });

  const inputRowKey = (threadId: ThreadId, messageId: MessageId): string =>
    `${threadId}\u0000${messageId}`;

  const openFailedUseBlocksClaim = (
    operation: string,
    ref: ProjectSkillVersionRef,
    items: ReadonlyArray<ProjectSkillTrialRow>,
    excluding: { readonly threadId: ThreadId; readonly messageId: MessageId },
    rows: ReadonlyArray<typeof InputDbRow.Type>,
  ): Effect.Effect<"clear" | "open-failed-use" | "context-invalid", unknown> =>
    Effect.gen(function* () {
      const rowByKey = new Map(
        rows.map((row) => [inputRowKey(row.threadId, row.messageId), row] as const),
      );
      for (const item of items) {
        if (item.threadId === excluding.threadId && item.messageId === excluding.messageId) {
          continue;
        }
        if (item.delivery !== "provider-accepted") continue;
        const row = rowByKey.get(inputRowKey(item.threadId, item.messageId));
        if (row === undefined) continue;
        const guard = yield* useClaimGuardModeForRow(operation, row, ref);
        if (guard.kind === "invalid-binding") {
          return "context-invalid" as const;
        }
        if (guard.kind !== "use") continue;
        if (
          item.window === "open" &&
          item.provisional.some((attempt) => attempt.outcome === "failed")
        ) {
          return "open-failed-use" as const;
        }
      }
      return "clear" as const;
    });

  const decodeUseAdmissionFromMessage = (
    operation: string,
    input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly ref: ProjectSkillVersionRef;
      readonly admittedSkillStateSeq: number;
      readonly payloadJson: string;
    },
  ): Effect.Effect<
    | {
        readonly mode: "use";
        readonly selectedScriptIds: ReadonlyArray<string>;
        readonly admittedSkillStateSeq: number;
      }
    | "context-invalid"
    | "selection-missing",
    PersistenceDecodeError
  > =>
    Effect.gen(function* () {
      const message = decodeMessagePayload(input.payloadJson);
      if (Option.isNone(message)) return "context-invalid";
      if (
        message.value.threadId !== input.threadId ||
        message.value.messageId !== input.messageId ||
        message.value.role !== "user"
      ) {
        return "context-invalid";
      }
      for (const record of message.value.context?.records ?? []) {
        if (record.kind !== PROJECT_SKILL_CONTEXT_KIND) continue;
        const payload = decodeContextPayload(record.payload);
        if (Option.isNone(payload)) return "context-invalid";
        const recordRef = payload.value.ref;
        if (
          recordRef.projectId !== input.ref.projectId ||
          recordRef.skillId !== input.ref.skillId ||
          recordRef.version !== input.ref.version ||
          recordRef.contentSha256 !== input.ref.contentSha256
        ) {
          continue;
        }
        if (payload.value.mode !== "use") return "context-invalid";
        const stamp = payload.value.admittedSkillStateSeq;
        if (stamp === undefined || stamp !== input.admittedSkillStateSeq) {
          return "context-invalid";
        }
        if (payload.value.selectedScriptIds === undefined) {
          return "selection-missing";
        }
        const selectedScriptIds = payload.value.selectedScriptIds;
        return {
          mode: "use",
          selectedScriptIds,
          admittedSkillStateSeq: stamp,
        };
      }
      return "context-invalid";
    });

  const sweepTrials: ProjectSkillTrialRepository["Service"]["sweepTrials"] = (input) => {
    const operation = "ProjectSkillTrialRepository.sweepTrials";
    if (
      !safeInt(input.ref.version) ||
      input.ref.version < 1 ||
      input.now.length === 0 ||
      input.ref.projectId !== input.projectId
    ) {
      return Effect.fail(sqlError(operation, "invalid-input"));
    }
    return transact(operation, sweepRefWork(operation, input));
  };

  const claimUseDelivery: ProjectSkillTrialRepository["Service"]["claimUseDelivery"] = (
    input,
  ): Effect.Effect<ProjectSkillUseClaimOutcome, ProjectSkillTrialRepositoryError> => {
    const operation = "ProjectSkillTrialRepository.claimUseDelivery";
    if (
      !safeInt(input.inputEventSequence) ||
      !safeInt(input.admittedSkillStateSeq) ||
      !safeInt(input.expectedStateSeq) ||
      !Number.isSafeInteger(input.ref.version) ||
      input.ref.version < 1 ||
      input.now.length === 0 ||
      input.ref.projectId !== input.projectId ||
      input.admittedSkillStateSeq !== input.expectedStateSeq
    ) {
      return Effect.fail(sqlError(operation, "invalid-input"));
    }
    if (Option.isNone(useWorkAssessorOption)) {
      return Effect.succeed({
        status: "assessment-unavailable",
        dependency: "ProjectSkillUseWorkAssessor",
      });
    }
    const useWorkAssessor = useWorkAssessorOption.value;
    return refineWork(operation, crypto.randomUUIDv4).pipe(
      Effect.flatMap((attemptToken) =>
        Effect.uninterruptible(
          transact(
            operation,
            Effect.gen(function* () {
              const inputEvents = yield* sql<{ readonly payloadJson: string }>`
                SELECT payload_json AS "payloadJson"
                FROM orchestration_events
                WHERE sequence = ${input.inputEventSequence}
                  AND aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                  AND event_type = 'thread.message-sent'
                  AND json_extract(payload_json, '$.role') = 'user'
                  AND json_extract(payload_json, '$.messageId') = ${input.messageId}
              `;
              const inputEvent = inputEvents[0];
              if (inputEvent === undefined) {
                return { status: "input-event-missing" } as const;
              }

              const admission = yield* decodeUseAdmissionFromMessage(operation, {
                threadId: input.threadId,
                messageId: input.messageId,
                ref: input.ref,
                admittedSkillStateSeq: input.admittedSkillStateSeq,
                payloadJson: inputEvent.payloadJson,
              });
              if (admission === "context-invalid") {
                return { status: "context-invalid" } as const;
              }
              if (admission === "selection-missing") {
                return { status: "selection-missing" } as const;
              }
              if (
                !selectedScriptIdsEqual(admission.selectedScriptIds, input.currentSelectedScriptIds)
              ) {
                return { status: "selection-mismatch" } as const;
              }

              const recreated = yield* sql`
                SELECT 1 FROM orchestration_events
                WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                  AND event_type IN ('thread.created', 'thread.deleted')
                  AND sequence > ${input.inputEventSequence}
              `;
              if (recreated.length > 0) {
                return { status: "thread-recreated" } as const;
              }

              const incarnationRows = yield* sql<{ readonly incarnation: number | null }>`
                SELECT MAX(sequence) AS "incarnation"
                FROM orchestration_events
                WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
                  AND event_type = 'thread.created'
                  AND sequence < ${input.inputEventSequence}
              `;
              const incarnation = incarnationRows[0]?.incarnation ?? 0;

              const versionRows = yield* sql`
                SELECT 1 FROM project_skill_versions v
                WHERE v.skill_id = ${input.ref.skillId}
                  AND v.project_id = ${input.projectId}
                  AND v.version = ${input.ref.version}
                  AND v.content_sha256 = ${input.ref.contentSha256}
                  AND v.state = 'active'
                  AND ${liveProjectFor(input.projectId)}
                  AND EXISTS (
                    SELECT 1 FROM projection_threads t
                    WHERE t.thread_id = ${input.threadId}
                      AND t.project_id = ${input.projectId}
                      AND t.deleted_at IS NULL
                  )
              `;
              if (versionRows.length === 0) {
                return { status: "ref-changed" } as const;
              }
              const seqRows = yield* sql<{ readonly seq: number | null }>`
                SELECT seq FROM project_skill_state WHERE project_id = ${input.projectId}
              `;
              if ((seqRows[0]?.seq ?? 0) !== input.admittedSkillStateSeq) {
                return { status: "ref-changed" } as const;
              }

              const sweepInput: SweepProjectSkillTrialsInput = {
                projectId: input.projectId,
                ref: input.ref,
                now: input.now,
              };
              const swept = yield* sweepRefWork(operation, sweepInput);
              const rawRows: ReadonlyArray<unknown> = yield* sql`
                SELECT ${inputColumns}
                FROM project_skill_inputs i
                WHERE i.project_id = ${input.projectId}
                  AND i.skill_id = ${input.ref.skillId}
                  AND i.version = ${input.ref.version}
                  AND i.content_sha256 = ${input.ref.contentSha256}
                  AND i.tombstoned_at IS NULL
                  AND ${liveProjectFor(input.projectId)}
              `;
              const rows = yield* Effect.forEach(rawRows, (raw) =>
                refineDecode(decodeInputRow(raw), `${operation}:row`),
              );
              const useFailure = yield* openFailedUseBlocksClaim(
                operation,
                input.ref,
                swept.items,
                input,
                rows,
              );
              if (useFailure === "open-failed-use") {
                return { status: "open-failed-use" } as const;
              }
              if (useFailure === "context-invalid") {
                return { status: "context-invalid" } as const;
              }

              const assessment = yield* useWorkAssessor.assessUseWork({
                ref: input.ref,
                expectedStateSeq: input.expectedStateSeq,
                current: input.current,
              });
              if (assessment.status === "not-ready") {
                return { status: "not-ready", gaps: assessment.gaps } as const;
              }
              if (assessment.status !== "ready") {
                return { status: "ref-changed" } as const;
              }

              const inserted = yield* sql<{ readonly attemptToken: unknown }>`
                INSERT OR IGNORE INTO project_skill_inputs (
                  thread_id, message_id, project_id, skill_id, version, content_sha256,
                  input_event_sequence, input_incarnation, admitted_skill_state_seq,
                  provider_driver_kind, native_skill_inventory_sha256,
                  delivery, delivery_at, window, window_closed_at, uncounted_attempts,
                  attempt_token, claimed_at, tombstoned_at
                )
                VALUES (
                  ${input.threadId}, ${input.messageId}, ${input.projectId},
                  ${input.ref.skillId}, ${input.ref.version}, ${input.ref.contentSha256},
                  ${input.inputEventSequence}, ${incarnation}, ${input.admittedSkillStateSeq},
                  NULL, NULL,
                  'unknown', NULL, 'open', NULL, 0,
                  ${attemptToken}, ${input.now}, NULL
                )
                RETURNING attempt_token AS "attemptToken"
              `;
              if (inserted[0] !== undefined) {
                return { status: "entered", attemptToken } as const;
              }

              const existing = yield* sql<{
                readonly inputEventSequence: number;
                readonly inputIncarnation: number;
              }>`
                SELECT input_event_sequence AS "inputEventSequence",
                  input_incarnation AS "inputIncarnation"
                FROM project_skill_inputs
                WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
              `;
              const row = existing[0];
              if (row === undefined) {
                return yield* sqlError(operation, "invalid-input");
              }
              if (
                row.inputEventSequence !== input.inputEventSequence ||
                row.inputIncarnation !== incarnation
              ) {
                return { status: "stale-identity" } as const;
              }
              return { status: "no-resend" } as const;
            }),
          ),
        ),
      ),
    );
  };

  return {
    stateSequence,
    claimDelivery,
    claimUseDelivery,
    claimProjectForSettlement,
    settleDelivery,
    sweepTrials,
  } satisfies ProjectSkillTrialRepository["Service"];
});

export const layer = Layer.effect(ProjectSkillTrialRepository, make).pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(useWorkAssessorLayer),
);
