import {
  CommandId,
  EventId,
  TaskResultRecord,
  type TaskResultRecordView,
  type TaskResultAcceptInput,
  type TaskResultGetInput,
  type TaskResultGetResult,
  type TaskResultMutationResult,
  TaskResultRejectedError,
  type TaskResultSetRequirementsInput,
  TaskResultThreadNotFoundError,
  type TaskResultWithdrawInput,
  SelectedChecksThreadNotFoundError,
  type ServerSettingsError,
  type ThreadId,
  type VcsError,
  deriveTaskResultState,
  taskResultRecordId,
  validateTaskResultItems,
  TASK_RESULT_ACTIVITY_KIND,
  type Sha256Hex,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SelectedChecks from "./SelectedChecks.ts";

const SERVER_COMMAND_PREFIX = "server:task-result:";

const SUMMARY = {
  requirements: "Task requirements updated",
  accepted: "Task result accepted",
  withdrawn: "Task result acceptance withdrawn",
} as const;

const decodeRecord = Schema.decodeUnknownOption(TaskResultRecord);
const decodeRecordJson = Schema.decodeUnknownOption(Schema.fromJsonString(TaskResultRecord));

/**
 * Every typed failure a read on this service can surface. Reads only produce
 * one when the failure cause already carries an interruption — the whole
 * cause is re-raised rather than collapsed into a defect, an absent row, or
 * an unknown observation. A plain failure keeps the ordinary boundary policy.
 */
export type TaskResultReadError =
  | SelectedChecksThreadNotFoundError
  | SelectedChecks.SelectedChecksGetError
  | ProjectionRepositoryError
  | ServerSettingsError
  | SqlError
  | VcsError;

/**
 * `Effect.orDie` with one exception: a cause already carrying an interruption
 * is re-raised whole — squashing a Fail+Interrupt into a defect would lose the
 * interrupt and let a torn read judge stale state as current.
 */
const orDiePreservingInterrupt = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.die(Cause.squash(cause)),
    ),
  );

const toHex = (bytes: Uint8Array): Sha256Hex =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Hex;

/**
 * The engine's fixed rejection wording maps to a conflict; anything else may
 * have committed, so it is reported unconfirmed rather than claimed absent.
 */
const mapDispatchFailure = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof OrchestrationCommandInvariantError &&
    squashed.detail === OrchestrationEngine.TASK_RESULT_WRITE_REJECT_DETAIL
    ? new TaskResultRejectedError({ reason: "conflict" })
    : new TaskResultRejectedError({ reason: "conflict", detail: "write-unconfirmed" });
};

/**
 * The thread's durable task-result record plus the judgment reads that turn a
 * mutation into a guarded write. Every mutation dispatches through the
 * engine's `taskResultWrite` guard, so the comparisons below are the service
 * judging a state it saw — the engine independently refuses the write when
 * that state moved.
 */
export class TaskResult extends Context.Service<
  TaskResult,
  {
    /** The stored record, the current incarnation, and a measured check view. */
    readonly get: (
      input: TaskResultGetInput,
    ) => Effect.Effect<TaskResultGetResult, TaskResultThreadNotFoundError | TaskResultReadError>;
    /** Replaces the requirements: pins each bound script's current command hash. */
    readonly setRequirements: (
      input: TaskResultSetRequirementsInput,
    ) => Effect.Effect<
      TaskResultMutationResult,
      | TaskResultRejectedError
      | TaskResultThreadNotFoundError
      | OrchestrationDispatchError
      | TaskResultReadError
    >;
    /** Records acceptance of the exact result tuple the requester judged. */
    readonly accept: (
      input: TaskResultAcceptInput,
    ) => Effect.Effect<
      TaskResultMutationResult,
      | TaskResultRejectedError
      | TaskResultThreadNotFoundError
      | OrchestrationDispatchError
      | TaskResultReadError
    >;
    /** Withdraws the stored acceptance under the same CAS tuple. */
    readonly withdraw: (
      input: TaskResultWithdrawInput,
    ) => Effect.Effect<
      TaskResultMutationResult,
      | TaskResultRejectedError
      | TaskResultThreadNotFoundError
      | OrchestrationDispatchError
      | TaskResultReadError
    >;
  }
>()("t3/selectedChecks/TaskResult") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const turnRepository = yield* ProjectionTurnRepository;
  const selectedChecks = yield* SelectedChecks.SelectedChecks;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const sha256HexUtf8 = (text: string): Effect.Effect<Sha256Hex> =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie, Effect.map(toHex));

  const conflict = () => new TaskResultRejectedError({ reason: "conflict" });

  const revisionMatches = (view: TaskResultRecordView, expectedRevision: number | null) =>
    expectedRevision === null
      ? view.kind === "none"
      : view.kind === "present" && view.record.revision === expectedRevision;

  const presentOrMalformed = (
    decoded: TaskResultRecord | null,
    sequence: number | null | undefined,
    threadId: ThreadId,
  ): TaskResultRecordView =>
    decoded === null || decoded.threadId !== threadId || typeof sequence !== "number"
      ? { kind: "malformed" }
      : { kind: "present", record: decoded, sequence };

  /** The stored record as written; a row that will not decode is malformed, never absent. */
  const readRecordView = (
    threadId: ThreadId,
  ): Effect.Effect<TaskResultRecordView, ProjectionRepositoryError> =>
    Effect.gen(function* () {
      const rows = yield* activityRepository
        .listByThreadId({ threadId, activityKinds: [TASK_RESULT_ACTIVITY_KIND] })
        .pipe(orDiePreservingInterrupt);
      const row = rows.find((candidate) => candidate.activityId === taskResultRecordId(threadId));
      if (row === undefined) return { kind: "none" };
      return presentOrMalformed(
        Option.getOrNull(decodeRecord(row.payload)),
        row.sequence,
        threadId,
      );
    });

  const incarnationRows = (threadId: ThreadId) =>
    sql<{ readonly incarnation: number | null }>`
      SELECT MAX(sequence) AS "incarnation" FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.created'
    `;

  // get: an unknown incarnation is reported absent; every judgment fails
  // closed. An interrupt-bearing read failure is not a missing field — the
  // whole cause propagates instead.
  const readIncarnationForGet = (threadId: ThreadId): Effect.Effect<number | undefined, SqlError> =>
    incarnationRows(threadId).pipe(
      Effect.map((rows) => rows[0]?.incarnation ?? undefined),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined),
      ),
    );

  // mutation: the guard cannot be built on an unknown incarnation, so the read
  // must succeed and the thread must have been created at least once.
  const readIncarnationForMutation = (threadId: ThreadId): Effect.Effect<number, SqlError> =>
    incarnationRows(threadId).pipe(
      orDiePreservingInterrupt,
      Effect.flatMap((rows) =>
        rows[0]?.incarnation === null || rows[0]?.incarnation === undefined
          ? Effect.die(new Error(`thread '${threadId}' has no creation event`))
          : Effect.succeed(rows[0].incarnation),
      ),
    );

  const readView = Effect.fnUntraced(function* (threadId: ThreadId) {
    const threadShell = yield* query.getThreadShellById(threadId).pipe(orDiePreservingInterrupt);
    if (Option.isNone(threadShell)) {
      return yield* new TaskResultThreadNotFoundError({ threadId });
    }
    const record = yield* readRecordView(threadId);
    const threadIncarnation = yield* readIncarnationForGet(threadId);
    const checks = yield* selectedChecks
      .get(threadId, { measureCurrent: true })
      .pipe(
        Effect.catchCause(
          (
            cause,
          ): Effect.Effect<
            never,
            | TaskResultThreadNotFoundError
            | SelectedChecksThreadNotFoundError
            | SelectedChecks.SelectedChecksGetError
          > =>
            !Cause.hasInterrupts(cause) &&
            Cause.squash(cause) instanceof SelectedChecksThreadNotFoundError
              ? Effect.fail(new TaskResultThreadNotFoundError({ threadId }))
              : Effect.failCause(cause),
        ),
      );
    return { record, threadIncarnation, checks };
  });

  const asGetResult = (view: {
    readonly record: TaskResultRecordView;
    readonly threadIncarnation: number | undefined;
    readonly checks: TaskResultGetResult["checks"];
  }): TaskResultGetResult => ({
    record: view.record,
    ...(view.threadIncarnation === undefined ? {} : { threadIncarnation: view.threadIncarnation }),
    checks: view.checks,
  });

  /**
   * The same read `snapshotFor` plus the accept pre-check use: latestTurn is
   * not the whole story — a pending turn-start placeholder is already turn
   * work in progress.
   */
  const readTurnActive = Effect.fnUntraced(function* (threadId: ThreadId) {
    const threadShell = yield* query.getThreadShellById(threadId).pipe(orDiePreservingInterrupt);
    if (Option.isNone(threadShell)) return true;
    const shell = threadShell.value;
    if (shell.latestTurn?.state === "running") return true;
    if (shell.session?.status === "starting" || shell.session?.status === "running") return true;
    if (shell.session !== null && shell.session.activeTurnId !== null) return true;
    const pending = yield* turnRepository
      .getPendingTurnStartByThreadId({ threadId })
      .pipe(orDiePreservingInterrupt);
    return Option.isSome(pending);
  });

  const get: TaskResult["Service"]["get"] = Effect.fn("TaskResult.get")(function* (input) {
    return yield* readView(input.threadId).pipe(Effect.map(asGetResult));
  });

  /**
   * A guarded write is dispatched and the view is re-read afterwards; the
   * returned state is whatever is current then, never a claim that our write
   * landed. An interruption in the cause is re-raised as-is; a refused write
   * is a conflict and any other failure is unconfirmed.
   */
  const writeAndReread = (input: {
    readonly record: TaskResultRecord;
    readonly summary: (typeof SUMMARY)[keyof typeof SUMMARY];
    readonly guard: OrchestrationEngine.TaskResultWriteGuard;
  }) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch(
          {
            type: "thread.activity.append",
            commandId: CommandId.make(`${SERVER_COMMAND_PREFIX}${uuid}`),
            threadId: input.record.threadId,
            activity: {
              id: EventId.make(taskResultRecordId(input.record.threadId)),
              tone: "info",
              kind: TASK_RESULT_ACTIVITY_KIND,
              summary: input.summary,
              payload: input.record,
              turnId: null,
              createdAt,
            },
            createdAt,
          },
          { taskResultWrite: input.guard },
        )
        .pipe(
          Effect.catchCause(
            (cause): Effect.Effect<never, TaskResultRejectedError | OrchestrationDispatchError> =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.fail(mapDispatchFailure(cause)),
          ),
        );
      return yield* get({ threadId: input.record.threadId });
    });

  const setRequirements: TaskResult["Service"]["setRequirements"] = Effect.fn(
    "TaskResult.setRequirements",
  )(function* (input) {
    const faults = validateTaskResultItems(input.items);
    if (faults.length > 0) {
      return yield* new TaskResultRejectedError({
        reason: "requirements-invalid",
        detail: faults.join("; "),
      });
    }
    const threadShell = yield* query
      .getThreadShellById(input.threadId)
      .pipe(orDiePreservingInterrupt);
    if (Option.isNone(threadShell)) {
      return yield* new TaskResultThreadNotFoundError({ threadId: input.threadId });
    }
    const incarnation = yield* readIncarnationForMutation(input.threadId);
    const view = yield* readRecordView(input.threadId);
    if (incarnation !== input.threadIncarnation || !revisionMatches(view, input.expectedRevision)) {
      return yield* conflict();
    }
    const projectShell = yield* query
      .getProjectShellById(threadShell.value.projectId)
      .pipe(orDiePreservingInterrupt);
    if (Option.isNone(projectShell)) {
      return yield* new TaskResultThreadNotFoundError({ threadId: input.threadId });
    }
    const scripts = resolveProjectScripts(
      yield* settings.getSettings.pipe(orDiePreservingInterrupt),
      {
        id: projectShell.value.id,
        scripts: projectShell.value.scripts,
      },
    );
    const boundScriptIds = [...new Set(input.items.flatMap((item) => item.scriptIds))];
    const checks: Array<{ scriptId: string; commandSha256: Sha256Hex }> = [];
    for (const scriptId of boundScriptIds) {
      const script = scripts.find((candidate) => candidate.id === scriptId);
      if (script === undefined) {
        return yield* new TaskResultRejectedError({
          reason: "script-not-found",
          detail: scriptId,
        });
      }
      checks.push({ scriptId, commandSha256: yield* sha256HexUtf8(script.command) });
    }
    const version =
      view.kind === "present" && view.record.requirements !== null
        ? view.record.requirements.version + 1
        : 1;
    const record: TaskResultRecord = {
      schemaVersion: 1,
      threadId: input.threadId,
      revision: input.expectedRevision === null ? 0 : input.expectedRevision + 1,
      threadIncarnation: incarnation,
      requirements: {
        version,
        items: input.items,
        checks,
        setAt: yield* nowIso,
      },
      acceptance: null,
    };
    return yield* writeAndReread({
      record,
      summary: SUMMARY.requirements,
      guard: { threadIncarnation: incarnation, expectedRevision: input.expectedRevision },
    });
  });

  const accept: TaskResult["Service"]["accept"] = Effect.fn("TaskResult.accept")(function* (input) {
    // Taken before the measurement so a turn-start or checkpoint-revert the
    // engine commits while we measure invalidates the write.
    const observedThroughSequence = yield* engine.latestSequence;
    const view = yield* readView(input.threadId);
    // Strict read: an unresolvable incarnation dies, never reads as conflict.
    const incarnation = yield* readIncarnationForMutation(input.threadId);
    if (incarnation !== input.threadIncarnation) {
      return yield* conflict();
    }
    if (!revisionMatches(view.record, input.expectedRevision)) {
      return yield* conflict();
    }
    const record = view.record.kind === "present" ? view.record.record : null;
    if (record !== null) {
      if (
        record.requirements === null ||
        record.requirements.version !== input.requirementsVersion
      ) {
        return yield* conflict();
      }
      const checksRecord = view.checks.record;
      if (
        checksRecord.kind !== "present" ||
        checksRecord.sequence !== input.checkReceiptSequence ||
        checksRecord.receipt.attemptId !== input.checkAttemptId
      ) {
        return yield* conflict();
      }
    }
    const turnActive = yield* readTurnActive(input.threadId);
    const derived = deriveTaskResultState(asGetResult(view), turnActive);
    if (derived.state !== "awaiting-acceptance" || record === null) {
      return yield* new TaskResultRejectedError({
        reason: turnActive ? "turn-active" : "not-awaiting-acceptance",
      });
    }
    const acceptedAt = yield* nowIso;
    const next: TaskResultRecord = {
      ...record,
      revision: record.revision + 1,
      threadIncarnation: incarnation,
      acceptance: {
        requirementsVersion: input.requirementsVersion,
        checkAttemptId: input.checkAttemptId,
        checkReceiptSequence: input.checkReceiptSequence,
        acceptedAt,
      },
    };
    return yield* writeAndReread({
      record: next,
      summary: SUMMARY.accepted,
      guard: {
        threadIncarnation: incarnation,
        expectedRevision: input.expectedRevision,
        accept: {
          checkReceiptSequence: input.checkReceiptSequence,
          observedThroughSequence,
        },
      },
    });
  });

  /**
   * The withdraw no-op has no CAS behind it: live-thread existence, the live
   * incarnation, and the durable record are judged against one short
   * transaction snapshot so the tuple cannot mix an old incarnation with a
   * record written after recreation. Git observation and dispatch never run
   * inside it.
   */
  const readWithdrawSnapshot = (
    threadId: ThreadId,
  ): Effect.Effect<
    {
      readonly liveIncarnation: number | null;
      readonly record: TaskResultRecordView;
    },
    SqlError
  > =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const lifecycleRows = yield* sql<{
            readonly eventType: string;
            readonly sequence: number;
          }>`
            SELECT event_type AS "eventType", sequence
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
              AND event_type IN ('thread.created', 'thread.deleted')
            ORDER BY sequence DESC
            LIMIT 1
          `;
          const top = lifecycleRows[0];
          const liveIncarnation =
            top !== undefined && top.eventType === "thread.created" ? top.sequence : null;
          const activityRows = yield* sql<{
            readonly sequence: number | null;
            readonly payload: string;
          }>`
            SELECT sequence, payload_json AS "payload"
            FROM projection_thread_activities
            WHERE thread_id = ${threadId}
              AND activity_id = ${taskResultRecordId(threadId)}
              AND kind = ${TASK_RESULT_ACTIVITY_KIND}
          `;
          const row = activityRows[0];
          const record =
            row === undefined
              ? { kind: "none" as const }
              : presentOrMalformed(
                  Option.getOrNull(decodeRecordJson(row.payload)),
                  row.sequence,
                  threadId,
                );
          return { liveIncarnation, record };
        }),
      )
      .pipe(orDiePreservingInterrupt);

  const withdraw: TaskResult["Service"]["withdraw"] = Effect.fn("TaskResult.withdraw")(
    function* (input) {
      const snapshot = yield* readWithdrawSnapshot(input.threadId);
      const liveIncarnation = snapshot.liveIncarnation;
      if (liveIncarnation === null) {
        return yield* new TaskResultThreadNotFoundError({ threadId: input.threadId });
      }
      if (
        liveIncarnation !== input.threadIncarnation ||
        !revisionMatches(snapshot.record, input.expectedRevision) ||
        (snapshot.record.kind === "present" &&
          snapshot.record.record.threadIncarnation !== liveIncarnation)
      ) {
        return yield* conflict();
      }
      if (snapshot.record.kind !== "present" || snapshot.record.record.acceptance === null) {
        // A no-op is still a judgment call: it passed only because the tuple
        // read current inside one transaction — that read is the
        // linearization point. The measured get runs after it ended.
        return yield* get({ threadId: input.threadId });
      }
      const next: TaskResultRecord = {
        ...snapshot.record.record,
        revision: snapshot.record.record.revision + 1,
        threadIncarnation: liveIncarnation,
        acceptance: null,
      };
      return yield* writeAndReread({
        record: next,
        summary: SUMMARY.withdrawn,
        guard: {
          threadIncarnation: liveIncarnation,
          expectedRevision: input.expectedRevision,
        },
      });
    },
  );

  return TaskResult.of({ get, setRequirements, accept, withdraw });
});

export const layer = Layer.effect(TaskResult, make).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
