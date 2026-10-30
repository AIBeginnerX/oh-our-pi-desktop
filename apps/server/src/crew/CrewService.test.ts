import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import { layerTest as serverConfigLayerTest } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CrewRuntimeStateLive from "../persistence/Layers/CrewRuntimeState.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CrewRuntimeState } from "../persistence/Services/CrewRuntimeState.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as CrewService from "./CrewService.ts";
import {
  CrewFollowUpRecoveryJson,
  CrewTaskRecoveryJson,
  CrewTaskRecoveryState,
} from "./crewRecoveryState.ts";

const NOW = IsoDateTime.make("2026-10-24T00:00:00.000Z");
const LEAD = ThreadId.make("lead-1");
const model = { instanceId: ProviderInstanceId.make("provider-1"), model: "worker-model" };
const lead: OrchestrationThreadShell = {
  id: LEAD,
  projectId: ProjectId.make("project-1"),
  title: "Lead",
  modelSelection: model,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: {
    turnId: TurnId.make("lead-turn"),
    state: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: null,
  },
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: NOW,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const detail: OrchestrationThread = {
  ...lead,
  modelSelection: model,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("user-message"),
      role: "user",
      text: "Implement the requested change.",
      turnId: TurnId.make("lead-turn"),
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
};
const finishedTask: typeof CrewTaskRecoveryState.Type = {
  version: 1,
  taskId: "task-1",
  leadThreadId: LEAD,
  leadTurnId: TurnId.make("lead-turn"),
  role: "worker",
  subject: "worker task",
  attempts: [],
  report: { taskId: "task-1", role: "worker", status: "completed", result: "worker result" },
  collected: false,
  ended: true,
  auditState: "none",
};

const makeHarness = Effect.gen(function* () {
  const store = yield* CrewRuntimeStateLive.make;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const shouldFail = yield* Ref.make(false);
  const recordRejection = yield* Ref.make(false);
  const busy = yield* Ref.make(false);
  const crewOn = yield* Ref.make(false);
  const workerTurns = yield* Ref.make<ReadonlyArray<ProjectionTurn>>([]);
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dependencies = Layer.mergeAll(
    Layer.succeed(CrewRuntimeState, store),
    OrchestrationCommandReceiptRepositoryLive,
    Layer.mock(ProjectionTurnRepository)({
      listByThreadId: ({ threadId }) =>
        Ref.get(workerTurns).pipe(
          Effect.map((rows) => rows.filter((row) => row.threadId === threadId)),
        ),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(crewOn).pipe(
        Effect.map((enabled) => ({
          ...DEFAULT_SERVER_SETTINGS,
          crew: { ...DEFAULT_SERVER_SETTINGS.crew, enabled },
        })),
      ),
    }),
    Layer.mock(CheckpointDiffQuery)({}),
    Layer.mock(GitVcsDriver)({}),
    serverConfigLayerTest(process.cwd(), { prefix: "t3-crew-service-test-" }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(busy).pipe(
          Effect.map((running) =>
            threadId !== LEAD
              ? Option.none()
              : Option.some(
                  running
                    ? {
                        ...lead,
                        latestTurn: {
                          turnId: TurnId.make("follow-up-turn"),
                          state: "running" as const,
                          requestedAt: NOW,
                          startedAt: NOW,
                          completedAt: null,
                          assistantMessageId: null,
                        },
                      }
                    : lead,
                ),
          ),
        ),
      getThreadDetailById: (threadId) =>
        Effect.succeed(threadId === LEAD ? Option.some(detail) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(Stream.never),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (previous) => [...previous, command]);
          if (command.type === "thread.turn.start") {
            const rejected = yield* Ref.get(shouldFail);
            if (!rejected || (yield* Ref.get(recordRejection))) {
              yield* receipts.upsert({
                commandId: command.commandId,
                aggregateKind: "thread",
                aggregateId: command.threadId,
                acceptedAt: NOW,
                resultSequence: NonNegativeInt.make(1),
                status: rejected ? "rejected" : "accepted",
                error: rejected ? "fixture rejection" : null,
              });
            }
            if (rejected) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "fixture rejection",
              });
            }
            yield* Ref.set(busy, true);
          }
          return { sequence: 1 };
        }),
    }),
  );
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(
      Layer.effect(CrewService.CrewService, CrewService.make).pipe(Layer.provide(dependencies)),
      scope,
    );
    return {
      crew: Context.get(context, CrewService.CrewService),
      close: Scope.close(scope, Exit.void),
    };
  });
  const seedTask = (task: typeof CrewTaskRecoveryState.Type) =>
    Effect.gen(function* () {
      yield* store.saveTask({
        task_id: task.taskId,
        lead_thread_id: task.leadThreadId,
        record_json: yield* Schema.encodeEffect(CrewTaskRecoveryJson)(task),
        updated_at: NOW,
      });
    });
  const seed = (task: typeof CrewTaskRecoveryState.Type = finishedTask) =>
    Effect.gen(function* () {
      yield* seedTask(task);
      const delivery: typeof CrewFollowUpRecoveryJson.Type = {
        version: 1,
        taskIds: task.role === "auditor" ? [] : [task.taskId],
        auditTaskIds: task.role === "auditor" ? [task.taskId] : [],
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("server:crew-follow-up:delivery-1"),
          threadId: LEAD,
          message: {
            messageId: MessageId.make("follow-up-message"),
            role: "user",
            text: "Follow up on the completed crew work.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
      };
      yield* store.prepareFollowUp({
        delivery_id: "delivery-1",
        lead_thread_id: LEAD,
        command_id: delivery.command.commandId,
        message_id: delivery.command.message.messageId,
        record_json: yield* Schema.encodeEffect(CrewFollowUpRecoveryJson)(delivery),
        created_at: NOW,
      });
      return delivery;
    });
  return {
    store,
    receipts,
    shouldFail,
    recordRejection,
    busy,
    crewOn,
    workerTurns,
    commands,
    start,
    seed,
    seedTask,
  };
});

const testLayers = Layer.mergeAll(
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive, SqlitePersistenceMemory),
  NodeServices.layer,
);

describe("Crew service restart delivery", () => {
  it.effect(
    "recovers an accepted command before its acknowledgement without starting another turn",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const pending = yield* harness.seed();
        yield* harness.receipts.upsert({
          commandId: pending.command.commandId,
          aggregateKind: "thread",
          aggregateId: LEAD,
          acceptedAt: NOW,
          resultSequence: NonNegativeInt.make(1),
          status: "accepted",
          error: null,
        });
        yield* Ref.set(harness.busy, true);
        const service = yield* harness.start;
        const tasks = yield* harness.store.readTasks;
        const restored = yield* Schema.decodeEffect(CrewTaskRecoveryJson)(tasks[0]!.record_json);
        assert.isTrue(restored.collected);
        assert.isNotNull((yield* harness.store.readFollowUps)[0]!.delivered_at);
        assert.equal(
          (yield* Ref.get(harness.commands)).filter(
            (command) => command.type === "thread.turn.start",
          ).length,
          0,
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("retains a rejected request and gives its next attempt fresh identities", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const original = yield* harness.seed();
      yield* Ref.set(harness.shouldFail, true);
      yield* Ref.set(harness.recordRejection, true);
      const first = yield* harness.start;
      assert.isNull((yield* harness.store.readFollowUps)[0]!.delivered_at);
      const before = yield* Schema.decodeEffect(CrewTaskRecoveryJson)(
        (yield* harness.store.readTasks)[0]!.record_json,
      );
      assert.isFalse(before.collected);
      yield* first.close;
      yield* Ref.set(harness.shouldFail, false);
      const second = yield* harness.start;
      const starts = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.turn.start",
      );
      assert.equal(starts.length, 2);
      assert.equal(starts[0]!.commandId, original.command.commandId);
      assert.notEqual(starts[1]!.commandId, original.command.commandId);
      assert.notEqual(starts[1]!.message.messageId, original.command.message.messageId);
      const deliveries = yield* harness.store.readFollowUps;
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries.filter((row) => row.rejected_at !== null).length, 1);
      assert.equal(deliveries.filter((row) => row.delivered_at !== null).length, 1);
      yield* second.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("acknowledges only audits captured in the persisted delivery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const audit: typeof CrewTaskRecoveryState.Type = {
        ...finishedTask,
        taskId: "audit-1",
        role: "auditor",
        auditState: "pending",
        report: {
          taskId: "audit-1",
          role: "auditor",
          status: "completed",
          result: "- missing test\n**Verdict:** needs changes",
        },
      };
      yield* harness.seed(audit);
      yield* harness.seedTask({
        ...audit,
        taskId: "audit-2",
        report: { ...audit.report!, taskId: "audit-2" },
      });
      const first = yield* harness.start;
      const states = yield* Effect.forEach(yield* harness.store.readTasks, (row) =>
        Schema.decodeEffect(CrewTaskRecoveryJson)(row.record_json),
      );
      assert.equal(states.find((state) => state.taskId === "audit-1")?.auditState, "delivered");
      assert.equal(states.find((state) => state.taskId === "audit-2")?.auditState, "pending");
      yield* first.close;
      yield* Ref.set(harness.busy, false);
      const second = yield* harness.start;
      const delivered = yield* Effect.forEach(yield* harness.store.readTasks, (row) =>
        Schema.decodeEffect(CrewTaskRecoveryJson)(row.record_json),
      );
      assert.isTrue(delivered.every((state) => state.auditState === "delivered"));
      yield* second.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("recovers the original worker turn without replaying or settling later work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const workerId = ThreadId.make("worker-1");
      yield* harness.seedTask({
        ...finishedTask,
        report: null,
        ended: false,
        attempts: [
          {
            model: "worker-model",
            threadId: workerId,
            messageId: MessageId.make("worker-request"),
          },
        ],
      });
      const original: ProjectionTurn = {
        threadId: workerId,
        turnId: TurnId.make("worker-turn"),
        pendingMessageId: MessageId.make("worker-request"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      };
      yield* Ref.set(harness.workerTurns, [
        original,
        {
          ...original,
          turnId: TurnId.make("later-user-turn"),
          pendingMessageId: MessageId.make("later-user-message"),
          state: "running",
          completedAt: null,
        },
      ]);
      const service = yield* harness.start;
      const result = yield* service.crew.wait({ threadId: LEAD, taskIds: ["task-1"] });
      assert.equal(result[0]!.status, "completed");
      assert.isFalse(
        (yield* Ref.get(harness.commands)).some(
          (command) =>
            command.type === "thread.create" ||
            (command.type === "thread.settle" && command.threadId === workerId) ||
            (command.type === "thread.turn.start" && command.threadId === workerId),
        ),
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("retains failed delivery and reuses its identities after service recreation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const pending = yield* harness.seed();
      yield* Ref.set(harness.shouldFail, true);
      const first = yield* harness.start;
      const before = yield* harness.store.readTasks;
      const uncollected = yield* Schema.decodeEffect(CrewTaskRecoveryJson)(before[0]!.record_json);
      assert.isFalse(uncollected.collected);
      assert.isNull((yield* harness.store.readFollowUps)[0]!.delivered_at);
      yield* first.close;
      yield* Ref.set(harness.shouldFail, false);
      const second = yield* harness.start;
      const starts = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.turn.start",
      );
      assert.equal(starts.length, 2);
      for (const start of starts) {
        assert.equal(start.commandId, pending.command.commandId);
        assert.equal(start.message.messageId, pending.command.message.messageId);
      }
      assert.isNotNull((yield* harness.store.readFollowUps)[0]!.delivered_at);
      yield* second.close;
      const third = yield* harness.start;
      assert.equal(
        (yield* Ref.get(harness.commands)).filter((command) => command.type === "thread.turn.start")
          .length,
        2,
      );
      yield* third.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );
});

describe("Crew service task retry", () => {
  const failedTask: typeof CrewTaskRecoveryState.Type = {
    ...finishedTask,
    taskId: "task-2",
    report: { taskId: "task-2", role: "worker", status: "failed", result: null },
  };
  const refusal = (
    input: { readonly threadId?: ThreadId; readonly taskId: string },
    options: { readonly crewOn: boolean },
  ) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedTask(finishedTask);
      yield* harness.seedTask(failedTask);
      yield* Ref.set(harness.crewOn, options.crewOn);
      const service = yield* harness.start;
      const error = yield* service.crew
        .retryTask({ threadId: input.threadId ?? LEAD, taskId: input.taskId })
        .pipe(Effect.flip);
      yield* service.close;
      return error.reason;
    }).pipe(Effect.scoped);

  it.effect("refuses while crew is off", () =>
    Effect.gen(function* () {
      assert.include(yield* refusal({ taskId: "task-2" }, { crewOn: false }), "off");
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("refuses an unknown lead, an unknown task, and a task that finished", () =>
    Effect.gen(function* () {
      const on = { crewOn: true };
      assert.include(
        yield* refusal({ threadId: ThreadId.make("other"), taskId: "task-2" }, on),
        "not available",
      );
      assert.include(yield* refusal({ taskId: "missing" }, on), "not available to retry");
      assert.include(yield* refusal({ taskId: "task-1" }, on), "without finishing");
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("refuses a failed task whose brief is gone", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal({ taskId: "task-2" }, { crewOn: true }),
        "original brief is no longer available",
      );
    }).pipe(Effect.provide(testLayers)),
  );
});
