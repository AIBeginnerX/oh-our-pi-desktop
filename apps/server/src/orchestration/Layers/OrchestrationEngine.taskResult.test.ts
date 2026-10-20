// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  TASK_RESULT_ACTIVITY_KIND,
  taskResultRecordId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type SelectedCheckReceipt,
  type TaskResultRecord,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
  TASK_RESULT_WRITE_REJECT_DETAIL,
  type TaskResultWriteGuard,
} from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type OrchestrationEventStoreLayer = typeof OrchestrationEventStoreLive;

function makeOrchestrationLayer(
  databasePath?: string,
  eventStoreLayer: OrchestrationEventStoreLayer = OrchestrationEventStoreLive,
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-task-result-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provide(eventStoreLayer),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

function decorateOrchestrationEventStoreLayer(
  decorate: (store: OrchestrationEventStoreShape) => OrchestrationEventStoreShape,
) {
  return Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      return decorate(store);
    }),
  );
}

const NOW = "2026-01-01T00:00:00.000Z";
const TREE_OID = "a".repeat(40);
const sha256 = (value: number) => value.toString(16).padStart(64, "0");

const PREPARATION_CANCEL_REJECT_DETAIL =
  "preparation cancellation rejected; the prepared thread state is no longer current";

describe("OrchestrationEngine taskResultWrite", () => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  let commandCounter = 0;
  const nextCommandId = (prefix: string) =>
    CommandId.make(`server:task-result:${prefix}-${commandCounter++}`);

  const requirements = (
    version: number,
    overrides?: Partial<NonNullable<TaskResultRecord["requirements"]>>,
  ): NonNullable<TaskResultRecord["requirements"]> => ({
    version,
    items: [{ id: "req-lint", text: "Lint passes", scriptIds: ["lint"] }],
    checks: [{ scriptId: "lint", commandSha256: sha256(1) }],
    setAt: NOW,
    ...overrides,
  });

  const record = (input: {
    readonly threadId: ThreadId;
    readonly revision: number;
    readonly threadIncarnation: number;
    readonly requirements?: TaskResultRecord["requirements"] | undefined;
    readonly acceptance?: TaskResultRecord["acceptance"] | undefined;
  }): TaskResultRecord => ({
    schemaVersion: 1,
    threadId: input.threadId,
    revision: input.revision,
    threadIncarnation: input.threadIncarnation,
    requirements: input.requirements === undefined ? requirements(1) : input.requirements,
    acceptance: input.acceptance === undefined ? null : input.acceptance,
  });

  const acceptance = (input: {
    readonly checkReceiptSequence: number;
    readonly checkAttemptId?: string | undefined;
    readonly requirementsVersion?: number | undefined;
  }): NonNullable<TaskResultRecord["acceptance"]> => ({
    requirementsVersion: input.requirementsVersion ?? 1,
    checkAttemptId: input.checkAttemptId ?? "attempt-1",
    checkReceiptSequence: input.checkReceiptSequence,
    acceptedAt: NOW,
  });

  const receipt = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly attemptId?: string;
    readonly revision?: number;
    readonly threadAnchorSequence?: number | null;
    readonly phase?: SelectedCheckReceipt["phase"];
  }): SelectedCheckReceipt => {
    const phase = input.phase ?? "completed";
    return {
      schemaVersion: 1,
      threadId: input.threadId,
      attemptId: input.attemptId ?? "attempt-1",
      revision: input.revision ?? 0,
      threadAnchorSequence: input.threadAnchorSequence ?? null,
      context: {
        projectId: input.projectId,
        workspaceRoot: `/tmp/${input.threadId}`,
        worktreePath: null,
        cwd: `/tmp/${input.threadId}`,
        shell: "/bin/bash",
        envSha256: sha256(2),
      },
      planned: [
        {
          scriptId: "lint",
          scriptName: "Lint",
          commandSha256: sha256(1),
          timeoutMs: 60_000,
        },
      ],
      environment: {
        environmentId: EnvironmentId.make("env-1"),
        platform: "linux",
        arch: "x64",
        osRelease: "6.0",
        serverVersion: "0.0.0",
        nodeVersion: "v24.0.0",
      },
      tree: {
        atStart: { kind: "complete", treeOid: TREE_OID },
        atEnd: { kind: "complete", treeOid: TREE_OID },
        repoAtStart: null,
        repoAtEnd: null,
      },
      phase,
      checks:
        phase === "completed"
          ? [
              {
                scriptId: "lint",
                status: "passed" as const,
                startedAt: NOW,
                endedAt: NOW,
                exitCode: 0,
                exitedBy: "exit" as const,
                exitSignal: null,
                pgid: 42_000,
                group: "empty" as const,
                stdout: { bytes: 1, sha256: sha256(3) },
                stderr: { bytes: 0, sha256: sha256(4) },
                failure: null,
              },
            ]
          : [
              {
                scriptId: "lint",
                status: "running" as const,
                startedAt: NOW,
                endedAt: null,
                exitCode: null,
                exitedBy: null,
                exitSignal: null,
                pgid: 42_000,
                group: null,
                stdout: null,
                stderr: null,
                failure: null,
              },
            ],
      startedAt: NOW,
      endedAt: phase === "completed" ? NOW : null,
      error: null,
    };
  };

  const seedThread = (
    engine: OrchestrationEngineShape,
    input: {
      readonly prefix: string;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.prefix}-project`),
        projectId: input.projectId,
        title: "Task result",
        workspaceRoot: `/tmp/${input.prefix}`,
        createdAt: NOW,
      });
      const created = yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.prefix}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Task result",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });
      // The single thread.created event's sequence is this incarnation.
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        incarnation: created.sequence,
      } as const;
    });

  const taskResultCommand = (
    prefix: string,
    threadId: ThreadId,
    payload: unknown,
    commandId?: CommandId,
  ): Extract<OrchestrationCommand, { type: "thread.activity.append" }> => ({
    type: "thread.activity.append",
    commandId: commandId ?? nextCommandId(prefix),
    threadId,
    activity: {
      id: EventId.make(taskResultRecordId(threadId)),
      tone: "info",
      kind: TASK_RESULT_ACTIVITY_KIND,
      summary: "Task result updated",
      payload,
      turnId: null,
      createdAt: NOW,
    },
    createdAt: NOW,
  });

  const writeReceipt = (
    engine: OrchestrationEngineShape,
    prefix: string,
    threadId: ThreadId,
    payload: SelectedCheckReceipt,
  ) =>
    engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:selected-checks:${prefix}-${commandCounter++}`),
      threadId,
      activity: {
        id: EventId.make(selectedCheckReceiptId(threadId)),
        tone: "info",
        kind: SELECTED_CHECK_RECEIPT_KIND,
        summary: "Check attempt recorded",
        payload,
        turnId: null,
        createdAt: NOW,
      },
      createdAt: NOW,
    });

  const startTurn = (engine: OrchestrationEngineShape, prefix: string, threadId: ThreadId) =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${prefix}-turn-start`),
      threadId,
      message: {
        messageId: MessageId.make(`${prefix}-message`),
        role: "user",
        text: "work",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: NOW,
    });

  const setSessionRunning = (
    engine: OrchestrationEngineShape,
    prefix: string,
    threadId: ThreadId,
  ) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${prefix}-session-running`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId,
        runtimeMode: "approval-required",
        activeTurnId: asTurnId(`${prefix}-turn`),
        lastError: null,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });

  const expectRejected = (
    engine: OrchestrationEngineShape,
    command: OrchestrationCommand,
    options?: Parameters<OrchestrationEngineShape["dispatch"]>[1],
    detail: string = TASK_RESULT_WRITE_REJECT_DETAIL,
  ) =>
    Effect.gen(function* () {
      const error = yield* engine.dispatch(command, options).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError", detail });
    });

  const listTaskResultEvents = (engine: OrchestrationEngineShape) =>
    Stream.runCollect(engine.readEvents(0)).pipe(
      Effect.map((chunk) =>
        Array.from(chunk).filter(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === TASK_RESULT_ACTIVITY_KIND,
        ),
      ),
    );

  const listTaskResultRows = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const repo = yield* ProjectionThreadActivityRepository;
      return yield* repo.listByThreadId({
        threadId,
        activityKinds: [TASK_RESULT_ACTIVITY_KIND],
      });
    });

  const readPendingTurnStart = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const repo = yield* ProjectionTurnRepository;
      return yield* repo.getPendingTurnStartByThreadId({ threadId });
    });

  // E1: the option alone selects the guarded path; both directions of a
  // missing pairing are refusals, as is mixing it with the other internal
  // cleanup paths.
  effectIt.effect("rejects unguarded task-result writes and guards attached elsewhere", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-path");
      const seeded = yield* seedThread(engine, {
        prefix: "path",
        projectId: asProjectId("project-path"),
        threadId,
      });
      const incarnation = seeded.incarnation;
      const payload = record({ threadId, revision: 0, threadIncarnation: incarnation });

      // A task-result append without the guard is refused.
      yield* expectRejected(engine, taskResultCommand("path", threadId, payload));
      // The guard on a different command is refused.
      yield* expectRejected(
        engine,
        {
          type: "thread.meta.update",
          commandId: CommandId.make("path-meta"),
          threadId,
          title: "nope",
        },
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      // The guard on a non-task-result activity append is refused.
      yield* expectRejected(
        engine,
        {
          type: "thread.activity.append",
          commandId: CommandId.make("path-other-kind"),
          threadId,
          activity: {
            id: EventId.make("path-other"),
            tone: "info",
            kind: "tool.completed",
            summary: "nope",
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      // The guard stacked on another internal cleanup path is refused; the
      // earlier preparation-cancel block reports it first.
      yield* expectRejected(
        engine,
        taskResultCommand("path", threadId, payload),
        {
          taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null },
          preparationCancel: { preparationSequence: 1, controlSequence: 2 },
        },
        PREPARATION_CANCEL_REJECT_DETAIL,
      );

      // A refusal is a durable rejection receipt, never a silent success:
      // the refused command id records it.
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const receiptRow = yield* receipts.getByCommandId({
        commandId: CommandId.make("path-meta"),
      });
      expect(Option.isSome(receiptRow) && receiptRow.value.status === "rejected").toBe(true);

      expect(yield* listTaskResultEvents(engine)).toHaveLength(0);
      expect(yield* listTaskResultRows(threadId)).toHaveLength(0);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // E1 review cases: malformed guard tuples and payloads that disagree with
  // their guard are refused before any durable read.
  effectIt.effect("rejects malformed guard tuples and disagreeing payloads", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-malformed");
      const seeded = yield* seedThread(engine, {
        prefix: "malformed",
        projectId: asProjectId("project-malformed"),
        threadId,
      });
      const incarnation = seeded.incarnation;
      const head = yield* engine.latestSequence;

      const writeWith = (
        guard: TaskResultWriteGuard,
        payload: unknown = record({ threadId, revision: 0, threadIncarnation: incarnation }),
        commandId?: CommandId,
      ) =>
        expectRejected(engine, taskResultCommand("malformed", threadId, payload, commandId), {
          taskResultWrite: guard,
        });

      // Incarnation must be a positive safe integer.
      yield* writeWith({ threadIncarnation: 0, expectedRevision: null });
      yield* writeWith({ threadIncarnation: 1.5, expectedRevision: null });
      // Expected revision must be null or a nonnegative safe integer.
      yield* writeWith({ threadIncarnation: incarnation, expectedRevision: -1 });
      yield* writeWith({ threadIncarnation: incarnation, expectedRevision: 0.5 });
      // Accept tuples must carry nonnegative safe integers.
      const acceptBase = {
        checkReceiptSequence: head + 10,
        observedThroughSequence: head,
      };
      yield* writeWith(
        {
          threadIncarnation: incarnation,
          expectedRevision: null,
          accept: { ...acceptBase, checkReceiptSequence: -1 },
        },
        record({
          threadId,
          revision: 0,
          threadIncarnation: incarnation,
          acceptance: acceptance({ checkReceiptSequence: -1 }),
        }),
      );
      yield* writeWith(
        {
          threadIncarnation: incarnation,
          expectedRevision: null,
          accept: { ...acceptBase, observedThroughSequence: -1 },
        },
        record({
          threadId,
          revision: 0,
          threadIncarnation: incarnation,
          acceptance: acceptance({ checkReceiptSequence: acceptBase.checkReceiptSequence }),
        }),
      );

      // A non-null acceptance with no accept guard is refused — and the
      // reverse pairing is refused too.
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null },
        record({
          threadId,
          revision: 0,
          threadIncarnation: incarnation,
          acceptance: acceptance({ checkReceiptSequence: head }),
        }),
      );
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null, accept: acceptBase },
        record({ threadId, revision: 0, threadIncarnation: incarnation }),
      );
      // The payload's receipt sequence must match the guard's exactly.
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null, accept: acceptBase },
        record({
          threadId,
          revision: 0,
          threadIncarnation: incarnation,
          acceptance: acceptance({ checkReceiptSequence: acceptBase.checkReceiptSequence + 1 }),
        }),
      );
      // The payload must name the same thread, incarnation, and next revision.
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null },
        record({
          threadId: ThreadId.make("tr-malformed-other"),
          revision: 0,
          threadIncarnation: incarnation,
        }),
      );
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null },
        record({ threadId, revision: 0, threadIncarnation: incarnation + 1 }),
      );
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: 0 },
        record({ threadId, revision: 0, threadIncarnation: incarnation }),
      );
      // A payload that is not a record, an activity id off the fixed record
      // id, and a command id without the server prefix all refuse.
      yield* writeWith({ threadIncarnation: incarnation, expectedRevision: null }, { bogus: true });
      yield* expectRejected(
        engine,
        {
          ...taskResultCommand(
            "malformed",
            threadId,
            record({ threadId, revision: 0, threadIncarnation: incarnation }),
          ),
          activity: {
            id: EventId.make("task-result:not-the-record"),
            tone: "info",
            kind: TASK_RESULT_ACTIVITY_KIND,
            summary: "Task result updated",
            payload: record({ threadId, revision: 0, threadIncarnation: incarnation }),
            turnId: null,
            createdAt: NOW,
          },
        },
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      yield* writeWith(
        { threadIncarnation: incarnation, expectedRevision: null },
        record({ threadId, revision: 0, threadIncarnation: incarnation }),
        CommandId.make("user-typed-task-result"),
      );

      expect(yield* listTaskResultEvents(engine)).toHaveLength(0);
      expect(yield* listTaskResultRows(threadId)).toHaveLength(0);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // E2/E3: compare-and-set across revisions — a stale expected revision or a
  // stale incarnation is a conflict that writes nothing.
  effectIt.effect("applies compare-and-set across durable record revisions", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-cas");
      const seeded = yield* seedThread(engine, {
        prefix: "cas",
        projectId: asProjectId("project-cas"),
        threadId,
      });
      const incarnation = seeded.incarnation;

      // The first write commits revision 0.
      const first = yield* engine.dispatch(
        taskResultCommand(
          "cas",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      // The same absent-record claim now conflicts with the durable row.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "cas",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );

      // A revision of the requirements commits revision 1.
      const second = yield* engine.dispatch(
        taskResultCommand(
          "cas",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: requirements(2),
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );
      // Both earlier revisions are stale now — a repeat set and a withdraw
      // shape alike.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "cas",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: requirements(2),
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );
      yield* expectRejected(
        engine,
        taskResultCommand(
          "cas",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: requirements(2),
            acceptance: null,
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );
      // An incarnation that does not resolve to this thread's own
      // thread.created is refused.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "cas",
          threadId,
          record({ threadId, revision: 2, threadIncarnation: incarnation + 50 }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation + 50, expectedRevision: 1 } },
      );

      const events = yield* listTaskResultEvents(engine);
      expect(events).toHaveLength(2);
      expect(events[0]?.sequence).toBe(first.sequence);
      expect(events[1]?.sequence).toBe(second.sequence);
      const rows = yield* listTaskResultRows(threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        activityId: taskResultRecordId(threadId),
        kind: TASK_RESULT_ACTIVITY_KIND,
        sequence: second.sequence,
      });
      expect(rows[0]?.payload).toMatchObject({ revision: 1 });
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // E4: a delete + recreate cycle invalidates the old incarnation and wipes
  // the record row, so the new incarnation starts fresh.
  effectIt.effect("invalidates the guard across delete and recreate", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-incarnation");
      const seeded = yield* seedThread(engine, {
        prefix: "incarnation",
        projectId: asProjectId("project-incarnation"),
        threadId,
      });
      const oldIncarnation = seeded.incarnation;
      yield* engine.dispatch(
        taskResultCommand(
          "incarnation",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: oldIncarnation }),
        ),
        { taskResultWrite: { threadIncarnation: oldIncarnation, expectedRevision: null } },
      );

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("incarnation-delete"),
        threadId,
      });
      const recreated = yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("incarnation-create"),
        threadId,
        projectId: seeded.projectId,
        title: "Task result",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });
      const newIncarnation = recreated.sequence;
      expect(newIncarnation).toBeGreaterThan(oldIncarnation);

      // The old incarnation's claim is refused: a newer thread.created and a
      // thread.deleted both sit past it on the log.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "incarnation",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: oldIncarnation }),
        ),
        { taskResultWrite: { threadIncarnation: oldIncarnation, expectedRevision: null } },
      );
      // Recreation wiped the record row: the new incarnation writes the first
      // record cleanly, proving the durable row — not the read model — is the
      // compared state.
      const fresh = yield* engine.dispatch(
        taskResultCommand(
          "incarnation",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: newIncarnation }),
        ),
        { taskResultWrite: { threadIncarnation: newIncarnation, expectedRevision: null } },
      );
      expect(fresh.sequence).toBeGreaterThan(newIncarnation);

      const rows = yield* listTaskResultRows(threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({
        revision: 0,
        threadIncarnation: newIncarnation,
      });
      expect(yield* listTaskResultEvents(engine)).toHaveLength(2);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // E5: an accept judged on receipt row S1 must fail once a newer attempt's
  // write moved the fixed row to S2 — sequence, phase, and attempt all differ.
  effectIt.effect("rejects an accept judged on a superseded receipt row", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-receipt");
      const seeded = yield* seedThread(engine, {
        prefix: "receipt",
        projectId: asProjectId("project-receipt"),
        threadId,
      });
      const incarnation = seeded.incarnation;
      const receiptS1 = yield* writeReceipt(
        engine,
        "receipt",
        threadId,
        receipt({ threadId, projectId: seeded.projectId, attemptId: "attempt-1" }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "receipt",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      // A second attempt rewrote the fixed receipt row before this accept.
      yield* writeReceipt(
        engine,
        "receipt",
        threadId,
        receipt({
          threadId,
          projectId: seeded.projectId,
          attemptId: "attempt-2",
          revision: 1,
          threadAnchorSequence: receiptS1.sequence,
          phase: "running",
        }),
      );

      const head = yield* engine.latestSequence;
      yield* expectRejected(
        engine,
        taskResultCommand(
          "receipt",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            acceptance: acceptance({ checkReceiptSequence: receiptS1.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: receiptS1.sequence,
              observedThroughSequence: head,
            },
          },
        },
      );

      const rows = yield* listTaskResultRows(threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ revision: 0, acceptance: null });
      expect(yield* listTaskResultEvents(engine)).toHaveLength(1);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // E6: an accept refuses once work engaged the thread — the durable pending
  // turn-start row is the sole discriminator before the reactor runs, the
  // running session blocks it after, and any request committed after the
  // observed head blocks it outright.
  effectIt.effect("rejects an accept once the thread has work in flight", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;

      // The pending turn-start placeholder is the only thing between a ready
      // session and an accept: the request is already durable but the
      // command model still shows no running turn.
      const pendingThreadId = ThreadId.make("tr-pending");
      const pending = yield* seedThread(engine, {
        prefix: "pending",
        projectId: asProjectId("project-pending"),
        threadId: pendingThreadId,
      });
      const pendingReceipt = yield* writeReceipt(
        engine,
        "pending",
        pendingThreadId,
        receipt({ threadId: pendingThreadId, projectId: pending.projectId }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "pending",
          pendingThreadId,
          record({
            threadId: pendingThreadId,
            revision: 0,
            threadIncarnation: pending.incarnation,
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: pending.incarnation,
            expectedRevision: null,
          },
        },
      );
      yield* startTurn(engine, "pending", pendingThreadId);
      // Head read after the request commits: its event is already inside the
      // observed window, so only the durable pending row can refuse this.
      const pendingHead = yield* engine.latestSequence;
      expect(Option.isSome(yield* readPendingTurnStart(pendingThreadId))).toBe(true);
      yield* expectRejected(
        engine,
        taskResultCommand(
          "pending",
          pendingThreadId,
          record({
            threadId: pendingThreadId,
            revision: 1,
            threadIncarnation: pending.incarnation,
            acceptance: acceptance({ checkReceiptSequence: pendingReceipt.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: pending.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: pendingReceipt.sequence,
              observedThroughSequence: pendingHead,
            },
          },
        },
      );

      // A running session blocks the accept without any pending row left —
      // the session-set that claimed the turn cleared the placeholder.
      const runningThreadId = ThreadId.make("tr-running");
      const running = yield* seedThread(engine, {
        prefix: "running",
        projectId: asProjectId("project-running"),
        threadId: runningThreadId,
      });
      const runningReceipt = yield* writeReceipt(
        engine,
        "running",
        runningThreadId,
        receipt({ threadId: runningThreadId, projectId: running.projectId }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "running",
          runningThreadId,
          record({
            threadId: runningThreadId,
            revision: 0,
            threadIncarnation: running.incarnation,
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: running.incarnation,
            expectedRevision: null,
          },
        },
      );
      yield* startTurn(engine, "running", runningThreadId);
      yield* setSessionRunning(engine, "running", runningThreadId);
      const runningHead = yield* engine.latestSequence;
      expect(Option.isNone(yield* readPendingTurnStart(runningThreadId))).toBe(true);
      yield* expectRejected(
        engine,
        taskResultCommand(
          "running",
          runningThreadId,
          record({
            threadId: runningThreadId,
            revision: 1,
            threadIncarnation: running.incarnation,
            acceptance: acceptance({ checkReceiptSequence: runningReceipt.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: running.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: runningReceipt.sequence,
              observedThroughSequence: runningHead,
            },
          },
        },
      );

      // Requests committed after the observed head refuse even while the
      // thread still idles — turn starts and checkpoint reverts alike.
      const afterThreadId = ThreadId.make("tr-after");
      const after = yield* seedThread(engine, {
        prefix: "after",
        projectId: asProjectId("project-after"),
        threadId: afterThreadId,
      });
      const afterReceipt = yield* writeReceipt(
        engine,
        "after",
        afterThreadId,
        receipt({ threadId: afterThreadId, projectId: after.projectId }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "after",
          afterThreadId,
          record({ threadId: afterThreadId, revision: 0, threadIncarnation: after.incarnation }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: after.incarnation,
            expectedRevision: null,
          },
        },
      );
      const afterObserved = yield* engine.latestSequence;
      yield* startTurn(engine, "after", afterThreadId);
      yield* expectRejected(
        engine,
        taskResultCommand(
          "after",
          afterThreadId,
          record({
            threadId: afterThreadId,
            revision: 1,
            threadIncarnation: after.incarnation,
            acceptance: acceptance({ checkReceiptSequence: afterReceipt.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: after.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: afterReceipt.sequence,
              observedThroughSequence: afterObserved,
            },
          },
        },
      );
      yield* engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("after-revert"),
        threadId: afterThreadId,
        turnCount: 0,
        createdAt: NOW,
      });
      yield* expectRejected(
        engine,
        taskResultCommand(
          "after",
          afterThreadId,
          record({
            threadId: afterThreadId,
            revision: 1,
            threadIncarnation: after.incarnation,
            acceptance: acceptance({ checkReceiptSequence: afterReceipt.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: after.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: afterReceipt.sequence,
              observedThroughSequence: afterObserved,
            },
          },
        },
      );

      expect(yield* listTaskResultEvents(engine)).toHaveLength(3);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // Review cases around evidence: an accept stands on unchanged requirements
  // and the exact receipt row it judged; a withdraw or requirements revision
  // carries its own transition shape; a malformed stored row never reads as
  // absent.
  effectIt.effect("rejects writes outside the durable transition shapes", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = ThreadId.make("tr-evidence");
      const seeded = yield* seedThread(engine, {
        prefix: "evidence",
        projectId: asProjectId("project-evidence"),
        threadId,
      });
      const incarnation = seeded.incarnation;
      const receiptS1 = yield* writeReceipt(
        engine,
        "evidence",
        threadId,
        receipt({ threadId, projectId: seeded.projectId, attemptId: "attempt-1" }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "evidence",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null } },
      );
      const head = yield* engine.latestSequence;
      const acceptGuard = (overrides?: {
        checkReceiptSequence?: number;
        observedThroughSequence?: number;
      }): TaskResultWriteGuard => ({
        threadIncarnation: incarnation,
        expectedRevision: 0,
        accept: {
          checkReceiptSequence: overrides?.checkReceiptSequence ?? receiptS1.sequence,
          observedThroughSequence: overrides?.observedThroughSequence ?? head,
        },
      });
      const acceptPayload = (overrides?: {
        requirements?: TaskResultRecord["requirements"];
        requirementsVersion?: number;
        checkAttemptId?: string;
        checkReceiptSequence?: number;
      }) =>
        record({
          threadId,
          revision: 1,
          threadIncarnation: incarnation,
          requirements: overrides?.requirements ?? requirements(1),
          acceptance: acceptance({
            checkReceiptSequence: overrides?.checkReceiptSequence ?? receiptS1.sequence,
            checkAttemptId: overrides?.checkAttemptId,
            requirementsVersion: overrides?.requirementsVersion,
          }),
        });

      // An accept may never revise the requirements it was judged under.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "evidence",
          threadId,
          acceptPayload({ requirements: requirements(2), requirementsVersion: 2 }),
        ),
        { taskResultWrite: acceptGuard() },
      );
      // The acceptance must name the stored requirements version.
      yield* expectRejected(
        engine,
        taskResultCommand("evidence", threadId, acceptPayload({ requirementsVersion: 2 })),
        { taskResultWrite: acceptGuard() },
      );
      // The acceptance must name the receipt's attempt.
      yield* expectRejected(
        engine,
        taskResultCommand("evidence", threadId, acceptPayload({ checkAttemptId: "attempt-2" })),
        { taskResultWrite: acceptGuard() },
      );
      // The cited sequence must equal the durable row's own sequence.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "evidence",
          threadId,
          acceptPayload({ checkReceiptSequence: receiptS1.sequence + 1 }),
        ),
        { taskResultWrite: acceptGuard({ checkReceiptSequence: receiptS1.sequence + 1 }) },
      );
      // The observed head must sit inside this incarnation's range — never
      // below the create, never ahead of the real head.
      yield* expectRejected(engine, taskResultCommand("evidence", threadId, acceptPayload()), {
        taskResultWrite: {
          threadIncarnation: incarnation,
          expectedRevision: 0,
          accept: {
            checkReceiptSequence: receiptS1.sequence,
            observedThroughSequence: incarnation - 1,
          },
        },
      });
      const futureHead = yield* engine.latestSequence;
      yield* expectRejected(engine, taskResultCommand("evidence", threadId, acceptPayload()), {
        taskResultWrite: {
          threadIncarnation: incarnation,
          expectedRevision: 0,
          accept: {
            checkReceiptSequence: receiptS1.sequence,
            observedThroughSequence: futureHead + 500,
          },
        },
      });
      // A withdraw may never drop the requirements it preserves.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "evidence",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: null,
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );
      // A requirements revision must number itself stored version + 1.
      yield* expectRejected(
        engine,
        taskResultCommand(
          "evidence",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: requirements(1, {
              items: [{ id: "req-changed", text: "Different", scriptIds: ["lint"] }],
            }),
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );
      yield* expectRejected(
        engine,
        taskResultCommand(
          "evidence",
          threadId,
          record({
            threadId,
            revision: 1,
            threadIncarnation: incarnation,
            requirements: requirements(3),
          }),
        ),
        { taskResultWrite: { threadIncarnation: incarnation, expectedRevision: 0 } },
      );

      // An accept on a thread with no durable receipt row at all is refused.
      const bareThreadId = ThreadId.make("tr-no-receipt");
      const bare = yield* seedThread(engine, {
        prefix: "no-receipt",
        projectId: asProjectId("project-no-receipt"),
        threadId: bareThreadId,
      });
      yield* engine.dispatch(
        taskResultCommand(
          "no-receipt",
          bareThreadId,
          record({ threadId: bareThreadId, revision: 0, threadIncarnation: bare.incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: bare.incarnation, expectedRevision: null } },
      );
      const bareHead = yield* engine.latestSequence;
      yield* expectRejected(
        engine,
        taskResultCommand(
          "no-receipt",
          bareThreadId,
          record({
            threadId: bareThreadId,
            revision: 1,
            threadIncarnation: bare.incarnation,
            acceptance: acceptance({ checkReceiptSequence: bareHead }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: bare.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: bareHead,
              observedThroughSequence: bareHead,
            },
          },
        },
      );

      // An accept judged on a receipt row still in "running" phase is
      // refused even when the sequence matches exactly.
      const runningThreadId = ThreadId.make("tr-running-receipt");
      const running = yield* seedThread(engine, {
        prefix: "running-receipt",
        projectId: asProjectId("project-running-receipt"),
        threadId: runningThreadId,
      });
      const runningReceipt = yield* writeReceipt(
        engine,
        "running-receipt",
        runningThreadId,
        receipt({
          threadId: runningThreadId,
          projectId: running.projectId,
          attemptId: "attempt-1",
          phase: "running",
        }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "running-receipt",
          runningThreadId,
          record({
            threadId: runningThreadId,
            revision: 0,
            threadIncarnation: running.incarnation,
          }),
        ),
        { taskResultWrite: { threadIncarnation: running.incarnation, expectedRevision: null } },
      );
      const runningHead = yield* engine.latestSequence;
      yield* expectRejected(
        engine,
        taskResultCommand(
          "running-receipt",
          runningThreadId,
          record({
            threadId: runningThreadId,
            revision: 1,
            threadIncarnation: running.incarnation,
            acceptance: acceptance({ checkReceiptSequence: runningReceipt.sequence }),
          }),
        ),
        {
          taskResultWrite: {
            threadIncarnation: running.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: runningReceipt.sequence,
              observedThroughSequence: runningHead,
            },
          },
        },
      );

      // A stored row that does not decode is not an absent row: both the
      // absent claim and any revision claim refuse.
      const malformedThreadId = ThreadId.make("tr-bad-row");
      const malformed = yield* seedThread(engine, {
        prefix: "bad-row",
        projectId: asProjectId("project-bad-row"),
        threadId: malformedThreadId,
      });
      const repo = yield* ProjectionThreadActivityRepository;
      yield* repo.upsert({
        activityId: EventId.make(taskResultRecordId(malformedThreadId)),
        threadId: malformedThreadId,
        turnId: null,
        tone: "info",
        kind: TASK_RESULT_ACTIVITY_KIND,
        summary: "corrupt",
        payload: { not: "a record" },
        createdAt: NOW,
      });
      yield* expectRejected(
        engine,
        taskResultCommand(
          "bad-row",
          malformedThreadId,
          record({
            threadId: malformedThreadId,
            revision: 0,
            threadIncarnation: malformed.incarnation,
          }),
        ),
        { taskResultWrite: { threadIncarnation: malformed.incarnation, expectedRevision: null } },
      );
      yield* expectRejected(
        engine,
        taskResultCommand(
          "bad-row",
          malformedThreadId,
          record({
            threadId: malformedThreadId,
            revision: 1,
            threadIncarnation: malformed.incarnation,
          }),
        ),
        { taskResultWrite: { threadIncarnation: malformed.incarnation, expectedRevision: 0 } },
      );

      // Only the three successful writes ever appended an event.
      expect(yield* listTaskResultEvents(engine)).toHaveLength(3);
      const evidenceRows = yield* listTaskResultRows(threadId);
      expect(evidenceRows[0]?.payload).toMatchObject({ revision: 0, acceptance: null });
      const malformedRows = yield* listTaskResultRows(malformedThreadId);
      expect(malformedRows[0]?.payload).toMatchObject({ not: "a record" });
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // A guard read that fails inside the transaction is unclear state: no
  // rejected receipt, so the same command id retries once the store recovers.
  effectIt.effect("treats a failed guard read as retryable unavailability", () => {
    const failAggregateReads = { current: false };
    const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
      ...store,
      readAggregateRange: (input) => {
        if (failAggregateReads.current) {
          return Stream.fail(
            new PersistenceSqlError({
              operation: "OrchestrationEventStore.readAggregateRange:query",
              detail: "simulated task-result guard read failure",
            }),
          );
        }
        return store.readAggregateRange(input);
      },
    })).pipe(Layer.provide(OrchestrationEventStoreLive));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const threadId = ThreadId.make("tr-transient");
      const seeded = yield* seedThread(engine, {
        prefix: "transient",
        projectId: asProjectId("project-transient"),
        threadId,
      });
      const receiptS1 = yield* writeReceipt(
        engine,
        "transient",
        threadId,
        receipt({ threadId, projectId: seeded.projectId }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "transient",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: seeded.incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: seeded.incarnation, expectedRevision: null } },
      );
      const head = yield* engine.latestSequence;
      const command = taskResultCommand(
        "transient",
        threadId,
        record({
          threadId,
          revision: 1,
          threadIncarnation: seeded.incarnation,
          acceptance: acceptance({ checkReceiptSequence: receiptS1.sequence }),
        }),
      );

      failAggregateReads.current = true;
      const transientError = yield* engine
        .dispatch(command, {
          taskResultWrite: {
            threadIncarnation: seeded.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: receiptS1.sequence,
              observedThroughSequence: head,
            },
          },
        })
        .pipe(Effect.flip);
      expect(transientError._tag).toBe("OrchestrationCommandStateUnavailableError");
      // Unclear state writes no receipt, so the same command id can retry.
      expect(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId }))).toBe(
        true,
      );

      failAggregateReads.current = false;
      const accepted = yield* engine.dispatch(command, {
        taskResultWrite: {
          threadIncarnation: seeded.incarnation,
          expectedRevision: 0,
          accept: {
            checkReceiptSequence: receiptS1.sequence,
            observedThroughSequence: head,
          },
        },
      });
      expect(accepted.sequence).toBeGreaterThan(head);
      const rows = yield* listTaskResultRows(threadId);
      expect(rows[0]?.payload).toMatchObject({
        revision: 1,
        acceptance: { checkAttemptId: "attempt-1" },
      });
    }).pipe(Effect.provide(makeOrchestrationLayer(undefined, wrappedStore)));
  });

  // A mixed cause (read failure + interrupt) must reach the caller with its
  // reasons intact — the same delivery the preparation-cancel path gets.
  effectIt.effect("delivers a mixed guard-read cause with its reasons intact", () => {
    const failAggregateReads = { current: false };
    const injectedReadError = new PersistenceSqlError({
      operation: "OrchestrationEventStore.readAggregateRange:query",
      detail: "simulated task-result guard read failure",
    });
    const mixedReadCause = Cause.combine(Cause.fail(injectedReadError), Cause.interrupt());
    const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
      ...store,
      readAggregateRange: (input) => {
        if (failAggregateReads.current) {
          return Stream.failCause(mixedReadCause);
        }
        return store.readAggregateRange(input);
      },
    })).pipe(Layer.provide(OrchestrationEventStoreLive));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const threadId = ThreadId.make("tr-mixed-cause");
      const seeded = yield* seedThread(engine, {
        prefix: "mixed-cause",
        projectId: asProjectId("project-mixed-cause"),
        threadId,
      });
      const receiptS1 = yield* writeReceipt(
        engine,
        "mixed-cause",
        threadId,
        receipt({ threadId, projectId: seeded.projectId }),
      );
      yield* engine.dispatch(
        taskResultCommand(
          "mixed-cause",
          threadId,
          record({ threadId, revision: 0, threadIncarnation: seeded.incarnation }),
        ),
        { taskResultWrite: { threadIncarnation: seeded.incarnation, expectedRevision: null } },
      );
      const head = yield* engine.latestSequence;
      const command = taskResultCommand(
        "mixed-cause",
        threadId,
        record({
          threadId,
          revision: 1,
          threadIncarnation: seeded.incarnation,
          acceptance: acceptance({ checkReceiptSequence: receiptS1.sequence }),
        }),
      );

      failAggregateReads.current = true;
      const exit = yield* Effect.exit(
        engine.dispatch(command, {
          taskResultWrite: {
            threadIncarnation: seeded.incarnation,
            expectedRevision: 0,
            accept: {
              checkReceiptSequence: receiptS1.sequence,
              observedThroughSequence: head,
            },
          },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // The original reasons are delivered in order — never squashed to
        // the mapped unavailable error. Propagation adds the framework's own
        // "effect/Cause/StackTrace" annotation on each reason, and the
        // delivery fiber appends its own Interrupt reason; those are the only
        // tolerated differences from the injected cause.
        const originalReasons = Array.from(mixedReadCause.reasons);
        const deliveredReasons = Array.from(exit.cause.reasons);
        expect(deliveredReasons.length).toBeGreaterThanOrEqual(originalReasons.length);
        for (const [index, original] of originalReasons.entries()) {
          const delivered = deliveredReasons[index]!;
          if (Cause.isFailReason(delivered) && Cause.isFailReason(original)) {
            expect(delivered.error).toBe(original.error);
            expect(delivered.error).toBe(injectedReadError);
          } else if (Cause.isInterruptReason(delivered) && Cause.isInterruptReason(original)) {
            expect(delivered.fiberId).toBe(original.fiberId);
          } else {
            expect.unreachable("delivered reason kinds diverged");
          }
          for (const [key, value] of original.annotations) {
            expect(delivered.annotations.get(key)).toEqual(value);
          }
          for (const key of delivered.annotations.keys()) {
            expect(key === "effect/Cause/StackTrace" || original.annotations.has(key)).toBe(true);
          }
        }
        // Only runtime-added interrupts may trail the original cause.
        for (const extra of deliveredReasons.slice(originalReasons.length)) {
          expect(Cause.isInterruptReason(extra)).toBe(true);
        }
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(true);
      }

      // Nothing was decided: no event and no rejection receipt.
      expect(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId }))).toBe(
        true,
      );

      failAggregateReads.current = false;
      const accepted = yield* engine.dispatch(command, {
        taskResultWrite: {
          threadIncarnation: seeded.incarnation,
          expectedRevision: 0,
          accept: {
            checkReceiptSequence: receiptS1.sequence,
            observedThroughSequence: head,
          },
        },
      });
      expect(accepted.sequence).toBeGreaterThan(head);
    }).pipe(Effect.provide(makeOrchestrationLayer(undefined, wrappedStore)));
  });

  // E7: the same file DB survives an engine-layer restart. Each scoped
  // build owns one engine lifetime on the file; closing the scope ends the
  // worker and the connection before the next build — the same restart the
  // production boot performs. The withdrawn write then passes every durable
  // check even though the fresh command read model holds no activities.
  effectIt.effect("keeps the guarded write durable across an engine restart on the same file", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-task-result-")),
      );
      yield* Effect.gen(function* () {
        const databasePath = NodePath.join(directory, "state.sqlite");
        const threadId = ThreadId.make("tr-restart");
        const projectId = ProjectId.make("project-restart");
        const runEngine = <A, E, R>(work: Effect.Effect<A, E, R>) =>
          Effect.scoped(
            Effect.flatMap(
              Layer.build(Layer.fresh(makeOrchestrationLayer(databasePath))),
              (context) => Effect.provide(work, context),
            ),
          );

        let incarnation = 0;
        let receiptSequence = 0;
        yield* runEngine(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const seeded = yield* seedThread(engine, {
              prefix: "restart",
              projectId,
              threadId,
            });
            incarnation = seeded.incarnation;
            const receiptWrite = yield* writeReceipt(
              engine,
              "restart",
              threadId,
              receipt({ threadId, projectId }),
            );
            receiptSequence = receiptWrite.sequence;
            yield* engine.dispatch(
              taskResultCommand(
                "restart",
                threadId,
                record({ threadId, revision: 0, threadIncarnation: incarnation }),
              ),
              {
                taskResultWrite: { threadIncarnation: incarnation, expectedRevision: null },
              },
            );
            const head = yield* engine.latestSequence;
            const accepted = yield* engine.dispatch(
              taskResultCommand(
                "restart",
                threadId,
                record({
                  threadId,
                  revision: 1,
                  threadIncarnation: incarnation,
                  acceptance: acceptance({ checkReceiptSequence: receiptSequence }),
                }),
              ),
              {
                taskResultWrite: {
                  threadIncarnation: incarnation,
                  expectedRevision: 0,
                  accept: {
                    checkReceiptSequence: receiptSequence,
                    observedThroughSequence: head,
                  },
                },
              },
            );
            expect(accepted.sequence).toBeGreaterThan(head);
          }),
        );

        yield* runEngine(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const activityRepository = yield* ProjectionThreadActivityRepository;
            // A withdraw naming the stored revision and preserving the
            // stored requirements commits entirely off durable reads: the
            // restarted command model holds no activities.
            const withdrawn = yield* engine.dispatch(
              taskResultCommand(
                "restart",
                threadId,
                record({
                  threadId,
                  revision: 2,
                  threadIncarnation: incarnation,
                  requirements: requirements(1),
                  acceptance: null,
                }),
              ),
              {
                taskResultWrite: {
                  threadIncarnation: incarnation,
                  expectedRevision: 1,
                },
              },
            );
            expect(withdrawn.sequence).toBeGreaterThan(incarnation);
            const rows = yield* activityRepository.listByThreadId({
              threadId,
              activityKinds: [TASK_RESULT_ACTIVITY_KIND],
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]?.payload).toMatchObject({ revision: 2, acceptance: null });
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
