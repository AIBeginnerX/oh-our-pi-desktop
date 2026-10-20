import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProjectMemoryId,
  ProjectMemoryKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  type ProjectMemoryRepositoryError,
  isPersistenceError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const PROJECT_MEMORY_SEND_MAX_ITEMS = 8;
export const PROJECT_MEMORY_SEND_MAX_CHARS = 32_000;
export const PROJECT_MEMORY_AFFECTED_PAGE_MAX = 50;

export type ProjectMemorySendHoldReason =
  | "empty"
  | "too-large"
  | "context-mismatch"
  | "unavailable"
  | "version-changed"
  | "expired"
  | "already-committed";

export type ProjectMemorySendSettleState = "provider_accepted" | "external_send_unknown";
export type ProjectMemorySendAttemptState = "dispatch_committed" | ProjectMemorySendSettleState;

export interface ProjectMemorySendSelectedItem {
  readonly memoryId: ProjectMemoryId;
  readonly selectedVersion: number;
}

export interface ProjectMemorySendCommittedMemory {
  readonly memoryId: ProjectMemoryId;
  readonly version: number;
  readonly kind: ProjectMemoryKind;
  readonly title: string;
  readonly body: string;
}

export interface CommitProjectMemoryDispatchInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly items: ReadonlyArray<ProjectMemorySendSelectedItem>;
  readonly now: DateTime.Utc;
}

export type ProjectMemorySendCommitResult =
  | {
      readonly status: "committed";
      readonly attemptSeq: number;
      readonly memories: ReadonlyArray<ProjectMemorySendCommittedMemory>;
    }
  | { readonly status: "held"; readonly reason: ProjectMemorySendHoldReason };

export interface RevalidateProjectMemoryDispatchInput {
  readonly threadId: ThreadId;
  readonly attemptSeq: number;
  readonly providerInstanceId: ProviderInstanceId;
}

/** A synchronous snapshot of the ledger's mutation epoch. One
    process-local pair of counters lives on each ledger instance:
    `withMemoryMutation` counts its wrapped effect in flight and bumps the
    epoch on every exit — success, failure, defect, or interruption — so a
    fence captured before a mutation can never hold in `mutationFenceHolds`
    afterwards. A mutation still in flight breaks every captured fence. */
export interface ProjectMemoryMutationFence {
  readonly epoch: number;
}

export type ProjectMemorySendRevalidateResult =
  | {
      readonly status: "valid";
      readonly fence: ProjectMemoryMutationFence;
      readonly minValidUntilMillis: number | null;
    }
  | {
      readonly status: "held";
      readonly reason: "context-mismatch" | "unavailable" | "version-changed" | "expired";
    };

export interface SettleProjectMemorySendInput {
  readonly attemptSeq: number;
  readonly outcome: ProjectMemorySendSettleState;
  readonly now: DateTime.Utc;
}

export type ProjectMemorySendSettleResult =
  | { readonly status: "applied"; readonly state: ProjectMemorySendSettleState }
  | { readonly status: "not-found" }
  | { readonly status: "not-owned"; readonly state: ProjectMemorySendAttemptState }
  | { readonly status: "already-final"; readonly state: ProjectMemorySendAttemptState };

export interface ReconcileProjectMemorySendOwnersInput {
  readonly now: DateTime.Utc;
}

export interface ProjectMemorySendReconcileResult {
  readonly converted: number;
}

export interface AcknowledgeProjectMemoryChangesInput {
  readonly threadId: ThreadId;
  readonly throughChangeSeq: number;
  /** When present, the acknowledge only proceeds if this exact thread is
      currently live under this project; the check runs inside the
      transaction before any history read or write. Absent preserves the
      unscoped behavior. */
  readonly expectedProjectId?: ProjectId;
}

export type ProjectMemorySendAcknowledgeResult =
  | { readonly status: "invalid" }
  | { readonly status: "unchanged"; readonly ackedThrough: number }
  | { readonly status: "applied"; readonly ackedThrough: number }
  | { readonly status: "scope-mismatch" };

export interface ProjectMemoryAffectedStateInput {
  readonly threadId: ThreadId;
  readonly limit: number;
}

export interface ProjectMemoryAffectedChange {
  readonly changeSeq: number;
  readonly memoryId: ProjectMemoryId;
  readonly reason: "updated" | "deleted";
}

export interface ProjectMemoryAffectedState {
  readonly held: boolean;
  readonly latestChangeSeq: number | null;
  readonly ackedThrough: number;
  readonly changes: ReadonlyArray<ProjectMemoryAffectedChange>;
}

export class ProjectMemorySendLedger extends Context.Service<
  ProjectMemorySendLedger,
  {
    readonly commitDispatch: (
      input: CommitProjectMemoryDispatchInput,
    ) => Effect.Effect<ProjectMemorySendCommitResult, ProjectMemoryRepositoryError>;
    readonly captureMutationFence: () => ProjectMemoryMutationFence;
    readonly mutationFenceHolds: (fence: ProjectMemoryMutationFence) => boolean;
    readonly withMemoryMutation: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly revalidateDispatch: (
      input: RevalidateProjectMemoryDispatchInput,
    ) => Effect.Effect<ProjectMemorySendRevalidateResult, ProjectMemoryRepositoryError>;
    readonly settle: (
      input: SettleProjectMemorySendInput,
    ) => Effect.Effect<ProjectMemorySendSettleResult, ProjectMemoryRepositoryError>;
    readonly reconcileOtherOwners: (
      input: ReconcileProjectMemorySendOwnersInput,
    ) => Effect.Effect<ProjectMemorySendReconcileResult, ProjectMemoryRepositoryError>;
    readonly acknowledge: (
      input: AcknowledgeProjectMemoryChangesInput,
    ) => Effect.Effect<ProjectMemorySendAcknowledgeResult, ProjectMemoryRepositoryError>;
    readonly affectedState: (
      input: ProjectMemoryAffectedStateInput,
    ) => Effect.Effect<ProjectMemoryAffectedState, ProjectMemoryRepositoryError>;
  }
>()("t3/persistence/ProjectMemorySendLedger/ProjectMemorySendLedger") {}

// Persisted rows must never carry memory text into a new shape: decode
// failures surface as a fixed "row-invalid" error with no retained cause.
const SendLedgerMemoryRow = Schema.Struct({
  memoryId: ProjectMemoryId,
  kind: ProjectMemoryKind,
  title: Schema.String,
  body: Schema.String,
  version: PositiveInt,
  validUntil: Schema.NullOr(Schema.String),
});

const SendLedgerAttemptStateRow = Schema.Struct({
  state: Schema.Literals(["dispatch_committed", "provider_accepted", "external_send_unknown"]),
  ownerInstanceId: Schema.String,
});

const SendLedgerAffectedRow = Schema.Struct({
  changeSeq: PositiveInt,
  memoryId: ProjectMemoryId,
  reason: Schema.Literals(["updated", "deleted"]),
});

// Scalar head values go through the same row-invalid decode — INTEGER
// affinity plus a >=0 CHECK still accepts arbitrary TEXT, and a coerced
// comparison would silently clear the hold.
const SendLedgerAffectedHeadRow = Schema.Struct({
  latest: Schema.NullOr(PositiveInt),
  acked: NonNegativeInt,
});
const SendLedgerAcknowledgeLatestRow = Schema.Struct({ latest: NonNegativeInt });
const SendLedgerAckedRow = Schema.Struct({ acked: NonNegativeInt });
const SendLedgerAcknowledgeScopeRow = Schema.Struct({ live: NonNegativeInt });

const decodeSendLedgerMemoryRow = Schema.decodeUnknownEffect(SendLedgerMemoryRow);
const decodeSendLedgerAttemptStateRow = Schema.decodeUnknownEffect(SendLedgerAttemptStateRow);
const decodeSendLedgerAffectedRow = Schema.decodeUnknownEffect(SendLedgerAffectedRow);
const decodeSendLedgerAffectedHeadRow = Schema.decodeUnknownEffect(SendLedgerAffectedHeadRow);
const decodeSendLedgerAcknowledgeLatestRow = Schema.decodeUnknownEffect(
  SendLedgerAcknowledgeLatestRow,
);
const decodeSendLedgerAckedRow = Schema.decodeUnknownEffect(SendLedgerAckedRow);
const decodeSendLedgerAcknowledgeScopeRow = Schema.decodeUnknownEffect(
  SendLedgerAcknowledgeScopeRow,
);

// Revalidation reads identity and version columns only — never a memory
// title or body — and the LEFT JOIN admits null joined-memory fields so a
// deleted memory decodes as a real row and reports unavailable below. The
// attempt state stays a plain string: a settled attempt is a context
// mismatch, not a malformed row.
const SendLedgerRevalidateAttemptRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  ownerInstanceId: Schema.String,
  state: Schema.String,
});

const SendLedgerRevalidateItemRow = Schema.Struct({
  memoryId: ProjectMemoryId,
  memoryVersion: PositiveInt,
  memoryRowVersion: Schema.NullOr(PositiveInt),
  memoryProjectId: Schema.NullOr(ProjectId),
  validUntil: Schema.NullOr(Schema.String),
});

const decodeSendLedgerRevalidateAttemptRow = Schema.decodeUnknownEffect(
  SendLedgerRevalidateAttemptRow,
);
const decodeSendLedgerRevalidateItemRow = Schema.decodeUnknownEffect(SendLedgerRevalidateItemRow);

// Shared by commit and revalidate: null means no expiry and bypasses parsing
// entirely; anything else must parse to an instant — unparseable is
// unavailable, and a numeric comparison decides expiry so offsets compare
// correctly. Returns the hold reason, or undefined when the row is current.
const expiryHold = (
  validUntil: string | null,
  nowMillis: number,
): "unavailable" | "expired" | undefined => {
  if (validUntil === null) return undefined;
  const expiry = Date.parse(validUntil);
  if (Number.isNaN(expiry)) return "unavailable";
  return expiry <= nowMillis ? "expired" : undefined;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // This is an owner-instance id, not proof another owner died.
  const ownerInstanceId = yield* crypto.randomUUIDv4;

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
  // issue, correlation, or cause cannot cross the boundary. Only the tag
  // survives; detail is an allowlist, and operation is always the local one.
  const rebuildPersistenceError = (
    operation: string,
    cause: PersistenceSqlError | PersistenceDecodeError,
  ): ProjectMemoryRepositoryError =>
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

  // Same boundary policy as the gates' interruptOnly: a cause carrying any
  // interrupt reason rethrows with the interrupt reasons only. Interruption
  // is never folded into a fixed failure — mapError/catchDefect select a
  // Fail or Die reason out of a mixed cause and would discard it — and a
  // foreign Fail/Die leg never crosses this boundary as a stored payload.
  const interruptOnly = <E>(cause: Cause.Cause<E>) =>
    Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));

  // Failures inside the transaction — driver failures, UNIQUE contention —
  // collapse to a fixed refined error with no retained cause. A defect
  // keeps its leg for the boundary below to tag.
  const refineWork = <A>(
    operation: string,
    work: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, ProjectMemoryRepositoryError> =>
    Effect.catchCause(work, (cause) =>
      Cause.hasInterrupts(cause)
        ? interruptOnly(cause)
        : Effect.failCause(
            Cause.map(cause, (error) =>
              isPersistenceError(error)
                ? rebuildPersistenceError(operation, error)
                : sqlError(operation),
            ),
          ),
    );

  // Anything still unrefined past withTransaction came from the transaction
  // boundary — BEGIN/COMMIT/ROLLBACK — never from work, so it is tagged
  // transaction-failed. Every non-interrupt leg — failure or defect —
  // collapses to the same fixed error with no retained cause.
  const refineBoundary = <A>(
    operation: string,
    effect: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, ProjectMemoryRepositoryError> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasInterrupts(cause)) {
        return interruptOnly(cause);
      }
      const error = Cause.findErrorOption(cause);
      return Effect.fail(
        Option.isSome(error) && isPersistenceError(error.value)
          ? rebuildPersistenceError(operation, error.value)
          : sqlError(operation, "transaction-failed"),
      );
    });

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

  const transactRead = <A>(operation: string, work: Effect.Effect<A, unknown>) =>
    refineBoundary(operation, sql.withTransaction(refineWork(operation, work)));

  // Mutation fence state, one pair per ledger instance — the shared
  // memoized layer is the single owner. acquireUseRelease keeps the
  // release uninterruptible and after the wrapped effect fully settles, so
  // a wrapped repository transaction reports in-flight until its real
  // COMMIT or ROLLBACK, never until an inner savepoint.
  let mutationEpoch = 0;
  let mutationInflight = 0;

  const captureMutationFence = (): ProjectMemoryMutationFence => ({ epoch: mutationEpoch });

  const mutationFenceHolds = (fence: ProjectMemoryMutationFence): boolean =>
    mutationInflight === 0 && mutationEpoch === fence.epoch;

  const withMemoryMutation = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (active) =>
      // Same fault as the directory write lock: inside a caller's
      // transaction the release could land at a savepoint while the outer
      // transaction is still open, retiring the in-flight count before the
      // mutation is durable.
      Option.isSome(active)
        ? Effect.die(
            new Error(
              "ProjectMemorySendLedger.withMemoryMutation must not run inside sql.withTransaction",
            ),
          )
        : Effect.acquireUseRelease(
            Effect.sync(() => {
              mutationInflight += 1;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                mutationInflight -= 1;
                mutationEpoch += 1;
              }),
          ),
    );

  const commitDispatch: ProjectMemorySendLedger["Service"]["commitDispatch"] = Effect.fnUntraced(
    function* (
      input: CommitProjectMemoryDispatchInput,
    ): Effect.fn.Return<ProjectMemorySendCommitResult, ProjectMemoryRepositoryError> {
      const operation = "ProjectMemorySendLedger.commitDispatch";

      if (input.items.length === 0) {
        return { status: "held", reason: "empty" } as const;
      }
      if (input.items.length > PROJECT_MEMORY_SEND_MAX_ITEMS) {
        return { status: "held", reason: "too-large" } as const;
      }
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.selectedVersion) || item.selectedVersion < 1) {
          return yield* sqlError(operation, "invalid-input");
        }
      }
      const selectedByMemoryId = new Map<ProjectMemoryId, number>();
      for (const item of input.items) {
        const seen = selectedByMemoryId.get(item.memoryId);
        if (seen === undefined) {
          selectedByMemoryId.set(item.memoryId, item.selectedVersion);
        } else if (seen !== item.selectedVersion) {
          return { status: "held", reason: "version-changed" } as const;
        }
      }
      const items = [...selectedByMemoryId.entries()].map(([memoryId, selectedVersion]) => ({
        memoryId,
        selectedVersion,
      }));

      return yield* transact(
        operation,
        Effect.gen(function* () {
          const committed = yield* sql`
            SELECT 1 FROM project_memory_send_attempts
            WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
          `;
          if (committed.length > 0) {
            // Never echo the earlier body back; the retry only learns the hold.
            return { status: "held", reason: "already-committed" } as const;
          }

          const context = yield* sql<{
            readonly projectLive: number;
            readonly threadLive: number;
            readonly messageInThread: number;
          }>`
            SELECT
              EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id = ${input.projectId} AND p.deleted_at IS NULL) AS "projectLive",
              EXISTS(SELECT 1 FROM projection_threads t WHERE t.thread_id = ${input.threadId} AND t.project_id = ${input.projectId} AND t.deleted_at IS NULL) AS "threadLive",
              EXISTS(SELECT 1 FROM projection_thread_messages m WHERE m.message_id = ${input.messageId} AND m.thread_id = ${input.threadId} AND m.role = 'user') AS "messageInThread"
          `;
          const provenance = context[0];
          if (
            provenance === undefined ||
            provenance.projectLive !== 1 ||
            provenance.threadLive !== 1 ||
            provenance.messageInThread !== 1
          ) {
            return { status: "held", reason: "context-mismatch" } as const;
          }

          const rows = yield* sql<{
            readonly memoryId: unknown;
            readonly kind: unknown;
            readonly title: unknown;
            readonly body: unknown;
            readonly version: unknown;
            readonly validUntil: unknown;
          }>`
            SELECT memory_id AS "memoryId", kind, title, body, version, valid_until AS "validUntil"
            FROM project_memories
            WHERE project_id = ${input.projectId}
              AND memory_id IN ${sql.in(items.map((item) => item.memoryId))}
          `;
          const decodedRows = yield* Effect.forEach(rows, (row) =>
            decodeSendLedgerMemoryRow(row).pipe(Effect.mapError(() => rowInvalid(operation))),
          );
          const byMemoryId = new Map(decodedRows.map((row) => [row.memoryId, row]));

          const nowMillis = DateTime.toEpochMillis(input.now);
          const selected: Array<typeof SendLedgerMemoryRow.Type> = [];
          for (const item of items) {
            const row = byMemoryId.get(item.memoryId);
            if (row === undefined) {
              return { status: "held", reason: "unavailable" } as const;
            }
            if (row.version !== item.selectedVersion) {
              return { status: "held", reason: "version-changed" } as const;
            }
            const expired = expiryHold(row.validUntil, nowMillis);
            if (expired !== undefined) {
              return { status: "held", reason: expired } as const;
            }
            selected.push(row);
          }

          let totalChars = 0;
          for (const row of selected) {
            totalChars += row.title.length + row.body.length;
          }
          if (totalChars > PROJECT_MEMORY_SEND_MAX_CHARS) {
            return { status: "held", reason: "too-large" } as const;
          }

          const committedAt = DateTime.formatIso(input.now);
          const inserted = yield* sql<{ readonly attemptSeq: number }>`
            INSERT INTO project_memory_send_attempts (
              thread_id, message_id, project_id, provider_instance_id,
              owner_instance_id, state, committed_at, settled_at
            )
            VALUES (
              ${input.threadId}, ${input.messageId}, ${input.projectId}, ${input.providerInstanceId},
              ${ownerInstanceId}, 'dispatch_committed', ${committedAt}, NULL
            )
            RETURNING attempt_seq AS "attemptSeq"
          `;
          const attemptSeq = inserted[0]?.attemptSeq;
          if (attemptSeq === undefined || !Number.isSafeInteger(attemptSeq)) {
            return yield* rowInvalid(operation);
          }
          for (const row of selected) {
            yield* sql`
              INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
              VALUES (${attemptSeq}, ${row.memoryId}, ${row.version})
            `;
          }

          return {
            status: "committed",
            attemptSeq,
            memories: selected.map((row) => ({
              memoryId: row.memoryId,
              version: row.version,
              kind: row.kind,
              title: row.title,
              body: row.body,
            })),
          } as const;
        }),
      );
    },
  );

  const revalidateDispatch: ProjectMemorySendLedger["Service"]["revalidateDispatch"] =
    Effect.fnUntraced(function* (
      input: RevalidateProjectMemoryDispatchInput,
    ): Effect.fn.Return<ProjectMemorySendRevalidateResult, ProjectMemoryRepositoryError> {
      const operation = "ProjectMemorySendLedger.revalidateDispatch";
      if (!Number.isSafeInteger(input.attemptSeq) || input.attemptSeq < 1) {
        return yield* sqlError(operation, "invalid-input");
      }
      // Captured synchronously before the read transaction opens, and
      // returned with the valid snapshot: the caller re-judges this exact
      // fence at admission time via mutationFenceHolds.
      const fence = captureMutationFence();
      return yield* transact(
        operation,
        Effect.gen(function* () {
          const attemptRows = yield* sql<{
            readonly threadId: unknown;
            readonly messageId: unknown;
            readonly projectId: unknown;
            readonly providerInstanceId: unknown;
            readonly ownerInstanceId: unknown;
            readonly state: unknown;
          }>`
            SELECT thread_id AS "threadId", message_id AS "messageId",
              project_id AS "projectId", provider_instance_id AS "providerInstanceId",
              owner_instance_id AS "ownerInstanceId", state
            FROM project_memory_send_attempts
            WHERE attempt_seq = ${input.attemptSeq}
          `;
          const attemptRow = attemptRows[0];
          if (attemptRow === undefined) {
            return { status: "held", reason: "context-mismatch" } as const;
          }
          const attempt = yield* decodeSendLedgerRevalidateAttemptRow(attemptRow).pipe(
            Effect.mapError(() => rowInvalid(operation)),
          );
          if (
            attempt.threadId !== input.threadId ||
            attempt.providerInstanceId !== input.providerInstanceId ||
            attempt.ownerInstanceId !== ownerInstanceId ||
            attempt.state !== "dispatch_committed"
          ) {
            return { status: "held", reason: "context-mismatch" } as const;
          }

          // The committed provenance must still be the live context, re-checked
          // with the attempt's own stored project/thread/message values.
          const context = yield* sql<{
            readonly projectLive: number;
            readonly threadLive: number;
            readonly messageInThread: number;
          }>`
            SELECT
              EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id = ${attempt.projectId} AND p.deleted_at IS NULL) AS "projectLive",
              EXISTS(SELECT 1 FROM projection_threads t WHERE t.thread_id = ${attempt.threadId} AND t.project_id = ${attempt.projectId} AND t.deleted_at IS NULL) AS "threadLive",
              EXISTS(SELECT 1 FROM projection_thread_messages m WHERE m.message_id = ${attempt.messageId} AND m.thread_id = ${attempt.threadId} AND m.role = 'user') AS "messageInThread"
          `;
          const provenance = context[0];
          if (
            provenance === undefined ||
            provenance.projectLive !== 1 ||
            provenance.threadLive !== 1 ||
            provenance.messageInThread !== 1
          ) {
            return { status: "held", reason: "context-mismatch" } as const;
          }

          const itemRows = yield* sql<{
            readonly memoryId: unknown;
            readonly memoryVersion: unknown;
            readonly memoryRowVersion: unknown;
            readonly memoryProjectId: unknown;
            readonly validUntil: unknown;
          }>`
            SELECT i.memory_id AS "memoryId", i.memory_version AS "memoryVersion",
              m.version AS "memoryRowVersion", m.project_id AS "memoryProjectId",
              m.valid_until AS "validUntil"
            FROM project_memory_send_items i
            LEFT JOIN project_memories m ON m.memory_id = i.memory_id
            WHERE i.attempt_seq = ${input.attemptSeq}
          `;
          const items = yield* Effect.forEach(itemRows, (row) =>
            decodeSendLedgerRevalidateItemRow(row).pipe(
              Effect.mapError(() => rowInvalid(operation)),
            ),
          );

          // Sampled once after the metadata decode, right before the
          // comparisons below.
          const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);

          if (items.length === 0) {
            return { status: "held", reason: "unavailable" } as const;
          }
          let minValidUntilMillis: number | null = null;
          for (const item of items) {
            // A LEFT JOIN miss (deleted memory) or one that moved projects is
            // unavailable for this dispatch.
            if (item.memoryRowVersion === null || item.memoryProjectId !== attempt.projectId) {
              return { status: "held", reason: "unavailable" } as const;
            }
            if (item.memoryRowVersion !== item.memoryVersion) {
              return { status: "held", reason: "version-changed" } as const;
            }
            const expired = expiryHold(item.validUntil, nowMillis);
            if (expired !== undefined) {
              return { status: "held", reason: expired } as const;
            }
            // The earliest expiry is carried out so stillValid can re-judge
            // it against the admission clock — every item here parsed.
            if (item.validUntil !== null) {
              const expiry = Date.parse(item.validUntil);
              if (minValidUntilMillis === null || expiry < minValidUntilMillis) {
                minValidUntilMillis = expiry;
              }
            }
          }
          return { status: "valid", fence, minValidUntilMillis } as const;
        }),
      );
    });

  const settle: ProjectMemorySendLedger["Service"]["settle"] = Effect.fnUntraced(function* (
    input: SettleProjectMemorySendInput,
  ): Effect.fn.Return<ProjectMemorySendSettleResult, ProjectMemoryRepositoryError> {
    const operation = "ProjectMemorySendLedger.settle";
    if (!Number.isSafeInteger(input.attemptSeq) || input.attemptSeq < 1) {
      return yield* sqlError(operation, "invalid-input");
    }
    return yield* transact(
      operation,
      Effect.gen(function* () {
        const updated = yield* sql<{ readonly attemptSeq: number }>`
            UPDATE project_memory_send_attempts
            SET state = ${input.outcome}, settled_at = ${DateTime.formatIso(input.now)}
            WHERE attempt_seq = ${input.attemptSeq}
              AND owner_instance_id = ${ownerInstanceId}
              AND state = 'dispatch_committed'
            RETURNING attempt_seq AS "attemptSeq"
          `;
        if (updated[0] !== undefined) {
          return { status: "applied", state: input.outcome } as const;
        }
        const rows = yield* sql<{
          readonly state: unknown;
          readonly ownerInstanceId: unknown;
        }>`
            SELECT state, owner_instance_id AS "ownerInstanceId"
            FROM project_memory_send_attempts
            WHERE attempt_seq = ${input.attemptSeq}
          `;
        const row = rows[0];
        if (row === undefined) {
          return { status: "not-found" } as const;
        }
        const decoded = yield* decodeSendLedgerAttemptStateRow(row).pipe(
          Effect.mapError(() => rowInvalid(operation)),
        );
        // "not-owned" is read as possibly exposed: another owner instance
        // committed this dispatch and still considers it pending.
        return decoded.ownerInstanceId !== ownerInstanceId
          ? ({ status: "not-owned", state: decoded.state } as const)
          : ({ status: "already-final", state: decoded.state } as const);
      }),
    );
  });

  const reconcileOtherOwners: ProjectMemorySendLedger["Service"]["reconcileOtherOwners"] =
    Effect.fnUntraced(function* (
      input: ReconcileProjectMemorySendOwnersInput,
    ): Effect.fn.Return<ProjectMemorySendReconcileResult, ProjectMemoryRepositoryError> {
      const operation = "ProjectMemorySendLedger.reconcileOtherOwners";
      return yield* transact(
        operation,
        Effect.gen(function* () {
          // This does not decide whether the other process died — a live
          // sibling owner's pending rows convert too. No resend results: the
          // row stays unique, so a later attempt is held already-committed.
          const converted = yield* sql<{ readonly attemptSeq: number }>`
            UPDATE project_memory_send_attempts
            SET state = 'external_send_unknown', settled_at = ${DateTime.formatIso(input.now)}
            WHERE state = 'dispatch_committed' AND owner_instance_id <> ${ownerInstanceId}
            RETURNING attempt_seq AS "attemptSeq"
          `;
          return { converted: converted.length } as const;
        }),
      );
    });

  const acknowledge: ProjectMemorySendLedger["Service"]["acknowledge"] = Effect.fnUntraced(
    function* (
      input: AcknowledgeProjectMemoryChangesInput,
    ): Effect.fn.Return<ProjectMemorySendAcknowledgeResult, ProjectMemoryRepositoryError> {
      const operation = "ProjectMemorySendLedger.acknowledge";
      if (!Number.isSafeInteger(input.throughChangeSeq) || input.throughChangeSeq < 0) {
        return yield* sqlError(operation, "invalid-input");
      }
      return yield* transact(
        operation,
        Effect.gen(function* () {
          // Scope runs first, inside the same transaction: a mismatched scope
          // reports scope-mismatch even for inputs that would otherwise be
          // invalid/unchanged. Because scope, the watermark check, and the
          // MAX upsert share a transaction, a successful stale-scope
          // acknowledgement cannot be committed after the fact. A concurrent
          // WAL reassignment can still make a write upgrade fail, so the
          // caller must retry rather than assume the result is durable.
          if (input.expectedProjectId !== undefined) {
            const scopeRows = yield* sql`
              SELECT EXISTS(
                SELECT 1
                FROM projection_threads t
                JOIN projection_projects p ON p.project_id = t.project_id
                WHERE t.thread_id = ${input.threadId}
                  AND t.project_id = ${input.expectedProjectId}
                  AND t.deleted_at IS NULL
                  AND p.deleted_at IS NULL
              ) AS "live"
            `;
            const { live } = yield* decodeSendLedgerAcknowledgeScopeRow(
              scopeRows[0] ?? { live: 0 },
            ).pipe(Effect.mapError(() => rowInvalid(operation)));
            if (live !== 1) {
              return { status: "scope-mismatch" } as const;
            }
          }
          const latestRows = yield* sql`
            SELECT COALESCE(MAX(change_seq), 0) AS "latest"
            FROM project_memory_affected
            WHERE thread_id = ${input.threadId}
          `;
          const { latest } = yield* decodeSendLedgerAcknowledgeLatestRow(
            latestRows[0] ?? { latest: 0 },
          ).pipe(Effect.mapError(() => rowInvalid(operation)));
          if (input.throughChangeSeq > latest) {
            return { status: "invalid" } as const;
          }
          const prevRows = yield* sql`
            SELECT acked_through_change_seq AS "acked"
            FROM project_memory_thread_acks
            WHERE thread_id = ${input.threadId}
          `;
          const { acked: prev } = yield* decodeSendLedgerAckedRow(prevRows[0] ?? { acked: 0 }).pipe(
            Effect.mapError(() => rowInvalid(operation)),
          );
          if (input.throughChangeSeq <= prev) {
            // A zero ack also lands here: it never writes and reports the
            // unchanged bound.
            return { status: "unchanged", ackedThrough: prev } as const;
          }
          yield* sql`
            INSERT INTO project_memory_thread_acks (thread_id, acked_through_change_seq)
            VALUES (${input.threadId}, ${input.throughChangeSeq})
            ON CONFLICT(thread_id) DO UPDATE SET
              acked_through_change_seq = MAX(acked_through_change_seq, excluded.acked_through_change_seq)
          `;
          return { status: "applied", ackedThrough: input.throughChangeSeq } as const;
        }),
      );
    },
  );

  const affectedState: ProjectMemorySendLedger["Service"]["affectedState"] = Effect.fnUntraced(
    function* (
      input: ProjectMemoryAffectedStateInput,
    ): Effect.fn.Return<ProjectMemoryAffectedState, ProjectMemoryRepositoryError> {
      const operation = "ProjectMemorySendLedger.affectedState";
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > PROJECT_MEMORY_AFFECTED_PAGE_MAX
      ) {
        return yield* sqlError(operation, "invalid-input");
      }
      // Read-only: one transaction snapshot, and the nested-transaction guard
      // does not apply — a caller's transaction just means a savepoint read.
      return yield* transactRead(
        operation,
        Effect.gen(function* () {
          // held/latest are computed over the thread's whole affected history,
          // independent of the requested page.
          const heads = yield* sql`
            SELECT
              (SELECT MAX(change_seq) FROM project_memory_affected WHERE thread_id = ${input.threadId}) AS "latest",
              COALESCE((SELECT acked_through_change_seq FROM project_memory_thread_acks WHERE thread_id = ${input.threadId}), 0) AS "acked"
          `;
          const head = yield* decodeSendLedgerAffectedHeadRow(
            heads[0] ?? { latest: null, acked: 0 },
          ).pipe(Effect.mapError(() => rowInvalid(operation)));
          const held = head.latest !== null && head.latest > head.acked;
          const rows = yield* sql<{
            readonly changeSeq: unknown;
            readonly memoryId: unknown;
            readonly reason: unknown;
          }>`
            SELECT change_seq AS "changeSeq", memory_id AS "memoryId", reason
            FROM project_memory_affected
            WHERE thread_id = ${input.threadId} AND change_seq > ${head.acked}
            ORDER BY change_seq DESC
            LIMIT ${input.limit}
          `;
          const changes = yield* Effect.forEach(rows, (row) =>
            decodeSendLedgerAffectedRow(row).pipe(Effect.mapError(() => rowInvalid(operation))),
          );
          return {
            held,
            latestChangeSeq: head.latest,
            ackedThrough: head.acked,
            changes,
          } as const;
        }),
      );
    },
  );

  return {
    commitDispatch,
    captureMutationFence,
    mutationFenceHolds,
    withMemoryMutation,
    revalidateDispatch,
    settle,
    reconcileOtherOwners,
    acknowledge,
    affectedState,
  } satisfies ProjectMemorySendLedger["Service"];
});

export const layer = Layer.effect(ProjectMemorySendLedger, make).pipe(
  Layer.provide(NodeCrypto.layer),
);
