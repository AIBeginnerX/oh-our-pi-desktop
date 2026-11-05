import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CrewThreadOverride,
  type OrchestrationCommand,
  ComposerContextId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import { layerTest as serverConfigLayerTest } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { ProcessRunner } from "../processRunner.ts";
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
import { ProjectMemorySendGate } from "../memory/ProjectMemorySendGate.ts";
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
const OTHER_LEAD = ThreadId.make("lead-2");
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

const decodeTaskRecovery = Schema.decodeEffect(CrewTaskRecoveryJson);

const makeHarness = Effect.gen(function* () {
  const realStore = yield* CrewRuntimeStateLive.make;
  // How many times the service asked for one lead's pending deliveries.
  const pendingReads: string[] = [];
  const store: typeof realStore = {
    ...realStore,
    readPendingFollowUps: (leadId) => {
      pendingReads.push(leadId);
      return realStore.readPendingFollowUps(leadId);
    },
  };
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const shouldFail = yield* Ref.make(false);
  const recordRejection = yield* Ref.make(false);
  const busy = yield* Ref.make(false);
  const crewOn = yield* Ref.make(false);
  const leadCrew = yield* Ref.make<CrewThreadOverride | null>(null);
  const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
  // Drivers the memory gate admits, and the lead's latest user message when a test needs memory on it.
  const memoryDrivers: { current: ReadonlySet<string> } = { current: new Set() };
  // What the ledger says the lead's message really sent; null means everything it referenced.
  const memorySent: {
    current: ReadonlyArray<{ memoryId: string; version: number }> | null;
  } = { current: null };
  const leadMessage = yield* Ref.make<OrchestrationThread["messages"][number] | null>(null);
  const leadMemoryHold = yield* Ref.make(false);
  const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
  const workerTurns = yield* Ref.make<ReadonlyArray<ProjectionTurn>>([]);
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  // Snapshots of crew member threads by id, for tests that need what a member's thread showed.
  const workerDetails = new Map<ThreadId, OrchestrationThread>();
  const dependencies = Layer.mergeAll(
    Layer.succeed(CrewRuntimeState, store),
    OrchestrationCommandReceiptRepositoryLive,
    Layer.mock(ProjectionTurnRepository)({
      listByThreadId: ({ threadId }) =>
        Ref.get(workerTurns).pipe(
          Effect.map((rows) => rows.filter((row) => row.threadId === threadId)),
        ),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
    Layer.mock(ProjectMemorySendGate)({
      driverAllowed: (driverKind) => memoryDrivers.current.has(driverKind),
      sentForMessage: () =>
        Ref.get(leadMessage).pipe(
          Effect.map(
            (message) =>
              memorySent.current ??
              (message?.context?.records ?? []).map((record) => {
                const { memoryId, selectedVersion } = (record as { payload: unknown }).payload as {
                  memoryId: string;
                  selectedVersion: number;
                };
                return { memoryId, version: selectedVersion };
              }),
          ),
        ),
      threadHold: () =>
        Ref.get(leadMemoryHold).pipe(
          Effect.map((held) => (held ? Option.some("affected" as const) : Option.none())),
        ),
    }),
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
    Layer.mock(ProcessRunner)({}),
    serverConfigLayerTest(process.cwd(), { prefix: "t3-crew-service-test-" }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.all([Ref.get(busy), Ref.get(leadCrew)]).pipe(
          Effect.map(([running, crew]) =>
            threadId === OTHER_LEAD
              ? Option.some({ ...lead, id: OTHER_LEAD })
              : threadId !== LEAD
                ? Option.none()
                : Option.some(
                    running
                      ? {
                          ...lead,
                          crew,
                          latestTurn: {
                            turnId: TurnId.make("follow-up-turn"),
                            state: "running" as const,
                            requestedAt: NOW,
                            startedAt: NOW,
                            completedAt: null,
                            assistantMessageId: null,
                          },
                        }
                      : { ...lead, crew },
                  ),
          ),
        ),
      getThreadDetailById: (threadId) =>
        threadId !== LEAD
          ? Effect.succeed(Option.fromNullishOr(workerDetails.get(threadId)))
          : Ref.get(leadMessage).pipe(
              Effect.map((message) =>
                Option.some(
                  message === null
                    ? detail
                    : { ...detail, messages: [...detail.messages, message] },
                ),
              ),
            ),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(Stream.never),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (previous) => [...previous, command]);
          yield* Queue.offer(dispatched, command);
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
    pendingReads,
    receipts,
    shouldFail,
    recordRejection,
    busy,
    crewOn,
    leadCrew,
    providers,
    memoryDrivers,
    memorySent,
    leadMessage,
    leadMemoryHold,
    dispatched,
    workerTurns,
    workerDetails,
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
  it.effect("looks for pending deliveries once per lead at startup, not once per task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const id of ["task-1", "task-2", "task-3"]) {
        yield* harness.seedTask({
          ...finishedTask,
          taskId: id,
          collected: true,
          report: { taskId: id, role: "worker", status: "completed", result: "done" },
        });
      }
      const service = yield* harness.start;
      assert.deepEqual(harness.pendingReads, [LEAD]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

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
        assert.deepEqual(yield* harness.store.readSettledFollowUps, []);
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
      assert.equal((yield* harness.store.readPendingFollowUps(LEAD)).length, 1);
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
      // Both the rejected and the delivered request are finished, so neither row is kept.
      assert.deepEqual(yield* harness.store.readSettledFollowUps, []);
      assert.deepEqual(yield* harness.store.readPendingFollowUps(LEAD), []);
      yield* second.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("acknowledges only audits captured in the persisted delivery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.crewOn, true);
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

  it.effect(
    "queues an audit fix only for a proven P1, not for a lead the auditor only pointed at",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.crewOn, true);
        const finding = (extra: object) => ({
          severity: "P1",
          confidence: 0.9,
          title: "Breaks login",
          ...extra,
        });
        const audit = (taskId: string, extra: object): typeof CrewTaskRecoveryState.Type => ({
          ...finishedTask,
          taskId,
          role: "auditor",
          ended: false,
          auditState: "none",
          report: {
            taskId,
            role: "auditor",
            status: "completed",
            result: `Verdict: needs changes\n\`\`\`json\n${JSON.stringify({
              verdict: "needs changes",
              summary: "x",
              findings: [finding(extra)],
            })}\n\`\`\``,
          },
        });
        yield* harness.seedTask(audit("audit-unproven", { proven: false, level: "line" }));
        yield* harness.seedTask(
          audit("audit-proven", { proven: true, level: "ran", evidence: "login.test.ts fails" }),
        );
        const service = yield* harness.start;
        yield* service.crew.wait({ threadId: LEAD, taskIds: ["audit-unproven", "audit-proven"] });
        const states = yield* Effect.forEach(yield* harness.store.readTasks, (row) =>
          Schema.decodeEffect(CrewTaskRecoveryJson)(row.record_json),
        );
        assert.equal(
          states.find((state) => state.taskId === "audit-unproven")?.auditState,
          "skipped",
        );
        assert.notEqual(
          states.find((state) => state.taskId === "audit-proven")?.auditState,
          "skipped",
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("hands a result that finished after the crew went off on as plain information", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // The harness crew is off: this report arrived after the user switched it off.
      yield* harness.seedTask(finishedTask);
      const service = yield* harness.start;
      const starts = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.turn.start",
      );
      assert.equal(starts.length, 1);
      const text = starts[0]!.type === "thread.turn.start" ? starts[0]!.message.text : "";
      assert.include(text, "worker result");
      assert.include(text, "OOP Crew is off: use these results if they help");
      assert.include(text, "do not start new crew tasks");
      assert.notInclude(text, "crew_wait");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("drops a pending audit fix request once the crew is off, and says why", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedTask({
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
      });
      const service = yield* harness.start;
      const states = yield* Effect.forEach(yield* harness.store.readTasks, (row) =>
        decodeTaskRecovery(row.record_json),
      );
      assert.equal(states[0]!.auditState, "skipped");
      assert.equal(
        (yield* Ref.get(harness.commands)).filter((command) => command.type === "thread.turn.start")
          .length,
        0,
      );
      const activities = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.activity.append",
      );
      assert.isTrue(
        activities.some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.summary.includes("OOP Crew is off"),
        ),
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("does not queue a fix when an audit finishes with the crew off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedTask({
        ...finishedTask,
        taskId: "audit-1",
        role: "auditor",
        ended: false,
        auditState: "none",
        report: {
          taskId: "audit-1",
          role: "auditor",
          status: "completed",
          result: "- missing test\n**Verdict:** needs changes",
        },
      });
      const service = yield* harness.start;
      yield* service.crew.wait({ threadId: LEAD, taskIds: ["audit-1"] });
      const states = yield* Effect.forEach(yield* harness.store.readTasks, (row) =>
        decodeTaskRecovery(row.record_json),
      );
      assert.equal(states[0]!.auditState, "skipped");
      assert.equal(
        (yield* Ref.get(harness.commands)).filter((command) => command.type === "thread.turn.start")
          .length,
        0,
      );
      yield* service.close;
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

  it.effect(
    "restores a pending audit whose report the current rules would no longer block on",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        // Saved by an older server: an unproven P1 then blocked, now it does not.
        const oldAudit: typeof CrewTaskRecoveryState.Type = {
          ...finishedTask,
          taskId: "audit-old",
          role: "auditor",
          ended: true,
          auditState: "pending",
          report: {
            taskId: "audit-old",
            role: "auditor",
            status: "completed",
            result:
              'Verdict: needs changes\n```json\n{"verdict":"needs changes","summary":"x","findings":[{"severity":"P1","confidence":0.9,"title":"bug"}]}\n```',
          },
        };
        yield* harness.seedTask(oldAudit);
        yield* harness.seedTask(finishedTask);
        const service = yield* harness.start;
        const result = yield* service.crew.wait({
          threadId: LEAD,
          taskIds: ["audit-old", "task-1"],
        });
        assert.deepEqual(
          result.map((report) => report.status),
          ["completed", "completed"],
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("skips one corrupt checkpoint and still restores the others", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.store.saveTask({
        task_id: "task-bad",
        lead_thread_id: LEAD,
        record_json: '{"version":99}',
        updated_at: NOW,
      });
      yield* harness.seedTask({
        ...finishedTask,
        taskId: "task-second",
        report: { taskId: "task-second", role: "worker", status: "completed", result: "second" },
      });
      yield* harness.store.saveTask({
        task_id: "task-liar",
        lead_thread_id: LEAD,
        record_json: yield* Schema.encodeEffect(CrewTaskRecoveryJson)({
          ...finishedTask,
          taskId: "other-id",
        }),
        updated_at: NOW,
      });
      yield* harness.seedTask(finishedTask);
      const service = yield* harness.start;
      const result = yield* service.crew.wait({
        threadId: LEAD,
        taskIds: ["task-1", "task-second"],
      });
      assert.deepEqual(
        result.map((report) => report.status),
        ["completed", "completed"],
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("judges a recovered task's proof from the tests its thread ran", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const workerId = ThreadId.make("worker-proof");
      const turnId = TurnId.make("worker-proof-turn");
      yield* harness.seedTask({
        ...finishedTask,
        report: null,
        ended: false,
        attempts: [
          { model: "worker-model", threadId: workerId, messageId: MessageId.make("proof-request") },
        ],
      });
      yield* Ref.set(harness.workerTurns, [
        {
          threadId: workerId,
          turnId,
          pendingMessageId: MessageId.make("proof-request"),
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
        },
      ]);
      harness.workerDetails.set(workerId, {
        ...detail,
        id: workerId,
        latestTurn: { ...lead.latestTurn!, turnId },
        activities: [
          {
            id: EventId.make("proof-activity"),
            tone: "tool",
            kind: "tool.completed",
            summary: "ran tests",
            turnId,
            createdAt: NOW,
            payload: {
              itemType: "command_execution",
              status: "completed",
              data: { command: "vp test run src/a.test.ts" },
            },
          },
        ],
      } as OrchestrationThread);
      const service = yield* harness.start;
      const result = yield* service.crew.wait({ threadId: LEAD, taskIds: ["task-1"] });
      assert.equal(result[0]!.proof?.verdict, "verified");
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
      assert.equal((yield* harness.store.readPendingFollowUps(LEAD)).length, 1);
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
      assert.deepEqual(yield* harness.store.readPendingFollowUps(LEAD), []);
      assert.deepEqual(yield* harness.store.readSettledFollowUps, []);
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

describe("Crew service per-thread crew", () => {
  const provider = (instanceId: string, driver: string, slugs: ReadonlyArray<string>) =>
    ({
      instanceId,
      driver,
      displayName: instanceId,
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated" },
      models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }) as unknown as ServerProvider;
  const team = [
    provider("provider-1", "claudeAgent", ["worker-model", "claude-haiku-5", "claude-opus-5"]),
    provider("codex", "codex", ["gpt-5.4", "gpt-5.4-mini"]),
  ];
  const pin = (modelSlug: string) => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: modelSlug,
  });

  const started = Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.providers, team);
    yield* Ref.set(harness.crewOn, true);
    const service = yield* harness.start;
    return { harness, service };
  });
  const workerOf = (roster: {
    readonly roles: ReadonlyArray<{ role: string; model: string | null }>;
  }) => roster.roles.find((entry) => entry.role === "worker")?.model;

  it.effect("resolves the crew from the thread first, then the default", () =>
    Effect.gen(function* () {
      const { harness, service } = yield* started;
      const defaultWorker = workerOf(yield* service.crew.roster(LEAD));

      yield* Ref.set(harness.leadCrew, { pinned: { worker: pin("gpt-5.4-mini") } });
      assert.equal(workerOf(yield* service.crew.roster(LEAD)), "gpt-5.4-mini");

      // a thread's off wins over a default that is on
      yield* Ref.set(harness.leadCrew, { enabled: false });
      assert.isFalse((yield* service.crew.roster(LEAD)).enabled);

      // reset: no crew of its own, so the default applies again
      yield* Ref.set(harness.leadCrew, null);
      const reset = yield* service.crew.roster(LEAD);
      assert.isTrue(reset.enabled);
      assert.equal(workerOf(reset), defaultWorker);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("lists a role's fallback models in the order they are tried", () =>
    Effect.gen(function* () {
      const { harness, service } = yield* started;
      assert.isUndefined((yield* service.crew.roster(LEAD)).roles[0]!.fallbacks);
      yield* Ref.set(harness.leadCrew, {
        fallbacks: { worker: [pin("gpt-5.4-mini"), pin("gpt-5.4")] },
      });
      const roles = (yield* service.crew.roster(LEAD)).roles;
      assert.deepEqual(
        roles.find((entry) => entry.role === "worker")?.fallbacks?.map((entry) => entry.model),
        ["gpt-5.4-mini", "gpt-5.4"],
      );
      assert.isUndefined(roles.find((entry) => entry.role === "expert")?.fallbacks);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("keeps another thread on the default while one thread has its own crew", () =>
    Effect.gen(function* () {
      const { harness, service } = yield* started;
      yield* Ref.set(harness.leadCrew, {
        enabled: false,
        pinned: { worker: pin("gpt-5.4-mini") },
      });
      const own = yield* service.crew.roster(LEAD);
      const other = yield* service.crew.roster(OTHER_LEAD);
      assert.isFalse(own.enabled);
      assert.equal(workerOf(own), "gpt-5.4-mini");
      assert.isTrue(other.enabled);
      assert.notEqual(workerOf(other), "gpt-5.4-mini");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("keeps the model a running task started with when the thread's crew changes", () =>
    Effect.gen(function* () {
      const { harness, service } = yield* started;
      yield* Ref.set(harness.leadCrew, { pinned: { worker: pin("gpt-5.4-mini") } });
      yield* service.crew.delegate({ threadId: LEAD, role: "worker", task: "first task" });
      const modelOfNextCreate = Effect.gen(function* () {
        for (;;) {
          const command = yield* Queue.take(harness.dispatched);
          if (command.type === "thread.create") return command.modelSelection.model;
        }
      });
      assert.equal(yield* modelOfNextCreate, "gpt-5.4-mini");

      yield* Ref.set(harness.leadCrew, { pinned: { worker: pin("gpt-5.4") } });
      yield* service.crew.delegate({ threadId: LEAD, role: "worker", task: "second task" });
      assert.equal(yield* modelOfNextCreate, "gpt-5.4");

      // the first task's thread was created once, on the model it started with
      const creates = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.create",
      );
      assert.deepEqual(
        creates.map((command) => command.modelSelection.model),
        ["gpt-5.4-mini", "gpt-5.4"],
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );
});

describe("Crew service project memory", () => {
  const provider = (instanceId: string, driver: string, slugs: ReadonlyArray<string>) =>
    ({
      instanceId,
      driver,
      displayName: instanceId,
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated" },
      models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }) as unknown as ServerProvider;
  const team = [
    provider("provider-1", "claudeAgent", ["worker-model", "claude-haiku-5", "claude-opus-5"]),
    provider("codex", "codex", ["gpt-5.4", "gpt-5.4-mini"]),
  ];
  const SECRET_BODY = "CREW-MEMORY-BODY-91c4e0";
  const leadWithMemory: OrchestrationThread["messages"][number] = {
    id: MessageId.make("lead-memory-message"),
    role: "user",
    text: "Ship it. [Project memory](t3-context://v1/memory/mem-1) [Project memory](t3-context://v1/memory/mem-2)",
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("mem-1"),
          kind: "memory",
          label: "Project memory",
          payload: { memoryId: "mem-1", selectedVersion: 2 },
        },
        {
          version: 1,
          contextId: ComposerContextId.make("mem-2"),
          kind: "memory",
          label: "Project memory",
          payload: { memoryId: "mem-2", selectedVersion: 1 },
        },
      ],
    },
    turnId: TurnId.make("lead-turn"),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const pinCodex = {
    pinned: { worker: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" } },
  };
  const pinClaude = {
    pinned: {
      worker: { instanceId: ProviderInstanceId.make("provider-1"), model: "worker-model" },
    },
  };

  const delegated = (input: {
    readonly crew: CrewThreadOverride;
    readonly memoryDrivers: ReadonlyArray<string>;
    readonly message: OrchestrationThread["messages"][number] | null;
    readonly held?: boolean;
    /** What the ledger shows the lead's message sent; absent means all it referenced. */
    readonly sent?: ReadonlyArray<{ memoryId: string; version: number }>;
  }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.memorySent.current = input.sent ?? null;
      yield* Ref.set(harness.providers, team);
      yield* Ref.set(harness.crewOn, true);
      yield* Ref.set(harness.leadCrew, input.crew);
      harness.memoryDrivers.current = new Set(input.memoryDrivers);
      yield* Ref.set(harness.leadMessage, input.message);
      yield* Ref.set(harness.leadMemoryHold, input.held === true);
      const service = yield* harness.start;
      const result = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "change the thing",
      });
      // The member's task runs on its own fiber; wait for its first turn.
      const turn = yield* Effect.gen(function* () {
        for (;;) {
          const command = yield* Queue.take(harness.dispatched);
          if (command.type === "thread.turn.start") return command;
        }
      });
      yield* service.close;
      return { result, message: turn.message };
    });
  const memoryOf = (message: {
    readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
  }) => (message.context?.records ?? []).map((record) => (record as { payload: unknown }).payload);

  it.effect("hands an allowed member the lead's memories by id and version, never as text", () =>
    Effect.gen(function* () {
      const { result, message } = yield* delegated({
        crew: pinCodex,
        memoryDrivers: ["codex"],
        message: leadWithMemory,
      });
      assert.deepEqual(memoryOf(message), [
        { memoryId: "mem-1", selectedVersion: 2 },
        { memoryId: "mem-2", selectedVersion: 1 },
      ]);
      // Fresh context ids for the member's own message; one inline reference per memory.
      assert.include(message.text, "t3-context://v1/memory/crew_memory_1");
      assert.include(message.text, "t3-context://v1/memory/crew_memory_2");
      assert.notInclude(message.text, SECRET_BODY);
      assert.isTrue(message.text.startsWith("You are the worker"));
      assert.isUndefined((result as { warning?: string }).warning);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("sends nothing to a member whose provider does not receive memory, and says so", () =>
    Effect.gen(function* () {
      const { result, message } = yield* delegated({
        crew: pinClaude,
        memoryDrivers: ["codex"],
        message: leadWithMemory,
      });
      assert.isUndefined(message.context);
      assert.notInclude(message.text, "t3-context://");
      const warning = (result as { warning?: string }).warning ?? "";
      assert.include(warning, "was not sent");
      // The lead must not route around the gate by pasting memory into the task.
      assert.include(warning, "Do not copy project memory content into the task");
      assert.notInclude(warning, "Put what it needs");
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("forwards only the memories the ledger shows the lead's own send delivered", () =>
    Effect.gen(function* () {
      const { message } = yield* delegated({
        crew: pinCodex,
        memoryDrivers: ["codex"],
        message: leadWithMemory,
        sent: [{ memoryId: "mem-1", version: 2 }],
      });
      assert.deepEqual(memoryOf(message), [{ memoryId: "mem-1", selectedVersion: 2 }]);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("forwards nothing when the ledger shows another version than the one referenced", () =>
    Effect.gen(function* () {
      const { message } = yield* delegated({
        crew: pinCodex,
        memoryDrivers: ["codex"],
        message: leadWithMemory,
        sent: [{ memoryId: "mem-1", version: 1 }],
      });
      assert.isUndefined(message.context);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("passes nothing on while the lead is held for a changed memory", () =>
    Effect.gen(function* () {
      const { result, message } = yield* delegated({
        crew: pinCodex,
        memoryDrivers: ["codex"],
        message: leadWithMemory,
        held: true,
      });
      assert.isUndefined(message.context);
      assert.include((result as { warning?: string }).warning ?? "", "changed");
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );

  it.effect("starts a member the plain way when the lead selected no memory", () =>
    Effect.gen(function* () {
      const { result, message } = yield* delegated({
        crew: pinCodex,
        memoryDrivers: ["codex"],
        message: null,
      });
      assert.isUndefined(message.context);
      assert.isUndefined((result as { warning?: string }).warning);
    }).pipe(Effect.scoped, Effect.provide(testLayers)),
  );
});
