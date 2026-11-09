import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CREW_STOPPED_ACTIVITY,
  CREW_STOPPING_ACTIVITY,
  ComposerContextId,
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CrewSettings,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import { layerTest as serverConfigLayerTest } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CrewRuntimeStateLive from "../persistence/Layers/CrewRuntimeState.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CrewRuntimeState } from "../persistence/Services/CrewRuntimeState.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProjectMemorySendGate } from "../memory/ProjectMemorySendGate.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { CREW_AUDIT_SKIPPED_ACTIVITY } from "@t3tools/shared/threadGoal";
import * as CrewService from "./CrewService.ts";
import { CrewTaskRecoveryJson, type CrewTaskRecoveryState } from "./crewRecoveryState.ts";

const NOW = IsoDateTime.make("2026-11-03T00:00:00.000Z");
const LEAD = ThreadId.make("lead-1");
const OTHER_LEAD = ThreadId.make("lead-2");
const decodeTask = Schema.decodeEffect(CrewTaskRecoveryJson);
const encodeTask = Schema.encodeEffect(CrewTaskRecoveryJson);

const provider = (instanceId: string, driver: string, slugs: ReadonlyArray<string>) =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      isLegacy: false,
      capabilities: null,
    })),
  }) as unknown as ServerProvider;
const PROVIDERS = [
  provider("claude", "claudeAgent", ["claude-opus-5", "claude-haiku-5"]),
  provider("codex", "codex", ["gpt-5.4", "gpt-5.4-mini"]),
];

const usageObservation = {
  id: "usage-1",
  kind: "owned-usage",
  tone: "info",
  summary: "usage",
  turnId: null,
  createdAt: NOW,
  payload: {
    v: 1,
    scope: "main-turn",
    source: {
      driver: "claudeAgent",
      instanceId: "claude",
      turnId: "turn",
      runtimeEventId: "e1",
      nativeConversationId: null,
    },
    terminal: "completed",
    usage: {
      usageScope: "main_agent",
      hasSubagents: false,
      usageStatus: "complete",
      inputTokens: 10,
      outputTokens: 5,
    },
  },
};

const leadShell = (id: ThreadId): OrchestrationThreadShell => ({
  id,
  projectId: ProjectId.make("project-1"),
  title: "Lead",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: {
    turnId: TurnId.make(`${id}-turn`),
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
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
});

/** The lead's turn selected a project memory, which its crew members receive by reference. */
const leadWithMemory = {
  id: MessageId.make("lead-memory-message"),
  role: "user",
  text: "Ship it. [Project memory](t3-context://v1/memory/mem-1)",
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
    ],
  },
  turnId: TurnId.make("lead-1-turn"),
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OrchestrationThread["messages"][number];

const TestLayer = Layer.mergeAll(
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive, SqlitePersistenceMemory),
  NodeServices.layer,
);

/**
 * `interruptEnds` is how the provider reports a turn the server interrupted: a clean interrupt,
 * or the error some providers raise when they are cut off.
 */
const makeWorld = (
  interruptEnds: "interrupted" | "error" = "interrupted",
  /** The member turn starts (1-based, in order) the reactor holds: no turn begins for them. */
  holdStarts: ReadonlySet<number> = new Set(),
  /** The provider never reports the interrupted turn, so a stopped task cannot end. */
  ignoreInterrupt = false,
  /** Crew settings beyond the crew being on, such as pinned and fallback models. */
  crew: Partial<CrewSettings> = {},
) =>
  Effect.gen(function* () {
    const store = yield* CrewRuntimeStateLive.make;
    /** What the provider registry reports; a test can change it, as a status check would. */
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>(PROVIDERS);
    const events = yield* PubSub.unbounded<never>();
    const shells = yield* Ref.make(
      new Map<ThreadId, OrchestrationThreadShell>([
        [LEAD, leadShell(LEAD)],
        [OTHER_LEAD, leadShell(OTHER_LEAD)],
      ]),
    );
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const activities = yield* Ref.make<
      ReadonlyArray<{ readonly id: string; readonly kind: string; readonly payload: unknown }>
    >([]);
    const memberTurns = yield* Queue.unbounded<ThreadId>();
    const heldStarts = yield* Queue.unbounded<{ threadId: ThreadId; messageId: MessageId }>();
    const threadActivities = yield* Ref.make<
      ReadonlyMap<ThreadId, ReadonlyArray<Record<string, unknown>>>
    >(new Map());
    let startCounter = 0;
    /** Full thread reads, which a streaming member must not multiply. */
    let detailReads = 0;
    const activitySignal = yield* Queue.unbounded<void>();
    const workerTurns = yield* Ref.make<ReadonlyArray<ProjectionTurn>>([]);
    let turnCounter = 0;
    /** What the memory ledger shows as sent with the lead's message. */
    const sentMemory = yield* Ref.make([{ memoryId: "mem-1", version: 2 }]);
    /** Runs once, inside the next member turn start, before the provider has begun that turn. */
    const duringMemberStart = yield* Ref.make<Effect.Effect<unknown> | null>(null);
    /** Runs once, inside the first task checkpoint a delegation writes. */
    const duringFirstSave = yield* Ref.make<Effect.Effect<unknown> | null>(null);
    /**
     * Like the real engine, a follow-up turn on a member that already ran one is only queued by
     * its dispatch: the thread keeps reading as idle until the provider starts that turn.
     */
    const lazyFollowUps = yield* Ref.make(false);

    const setMember = (threadId: ThreadId, change: Partial<OrchestrationThreadShell>) =>
      Ref.update(shells, (all) => {
        const shell = all.get(threadId);
        return shell === undefined ? all : new Map(all).set(threadId, { ...shell, ...change });
      });
    const wake = (threadId: ThreadId) =>
      PubSub.publish(events, {
        aggregateId: threadId,
        type: "thread.session-set",
        payload: { threadId, session: { status: "ready" } },
      } as never);

    const dependencies = Layer.mergeAll(
      Layer.succeed(CrewRuntimeState, {
        ...store,
        saveTask: (row) =>
          Ref.getAndSet(duringFirstSave, null).pipe(
            Effect.flatMap((hook) => (hook === null ? Effect.void : hook)),
            Effect.andThen(store.saveTask(row)),
          ),
      }),
      Layer.mock(ProjectionTurnRepository)({
        listByThreadId: ({ threadId }) =>
          Ref.get(workerTurns).pipe(
            Effect.map((rows) => rows.filter((row) => row.threadId === threadId)),
          ),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          crew: { ...DEFAULT_SERVER_SETTINGS.crew, enabled: true, ...crew },
        }),
      }),
      Layer.mock(CheckpointDiffQuery)({
        getFullThreadDiff: () => Effect.succeed({ diff: "+const a = 1;\n" } as never),
      }),
      Layer.mock(GitVcsDriver)({}),
      Layer.mock(ProcessRunner)({}),
      // Memory is allowed for every member, so a stopped task also carries the lead's memory refs.
      Layer.mock(ProjectMemorySendGate)({
        driverAllowed: () => true,
        threadHold: () => Effect.succeed(Option.none()),
        sentForMessage: () => Ref.get(sentMemory),
      }),
      serverConfigLayerTest(process.cwd(), { prefix: "t3-crew-stop-test-" }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: () => Effect.succeed(Option.none()),
        getThreadShellById: (threadId) =>
          Ref.get(shells).pipe(Effect.map((all) => Option.fromNullishOr(all.get(threadId)))),
        getThreadDetailById: (threadId) =>
          Effect.all([Ref.get(shells), Ref.get(threadActivities), Ref.get(commands)]).pipe(
            Effect.tap(() => Effect.sync(() => void (detailReads += 1))),
            Effect.map(([all, extra, sent]) => {
              const shell = all.get(threadId);
              return shell === undefined
                ? Option.none()
                : Option.some({
                    ...shell,
                    deletedAt: null,
                    messages:
                      threadId === LEAD
                        ? [leadWithMemory]
                        : [
                            ...sent
                              .filter(
                                (command) =>
                                  command.type === "thread.turn.start" &&
                                  command.threadId === threadId,
                              )
                              .map((command) => ({
                                id: (command as { message: { messageId: string } }).message
                                  .messageId,
                                role: "user",
                                text: (command as { message: { text: string } }).message.text,
                              })),
                            // A finished member turn ends with its report marker, as a real reply does.
                            ...(shell?.latestTurn?.state === "completed"
                              ? [
                                  {
                                    id: `member-reply-${threadId}`,
                                    role: "assistant",
                                    text: "Did the work.\nStatus: done",
                                  },
                                ]
                              : []),
                          ],
                    proposedPlans: [],
                    // The usage a finished turn records, so the board's evidence is read at once.
                    activities: [usageObservation, ...(extra.get(threadId) ?? [])],
                    checkpoints: [],
                  } as unknown as OrchestrationThread);
            }),
          ),
      }),
      Layer.mock(OrchestrationEngineService)({
        subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(commands, (previous) => [...previous, command]);
            if (command.type === "thread.create") {
              yield* Ref.update(shells, (all) =>
                new Map(all).set(command.threadId, {
                  ...leadShell(command.threadId),
                  title: command.title,
                  latestTurn: null,
                }),
              );
            } else if (
              command.type === "thread.turn.start" &&
              !command.threadId.startsWith("lead") &&
              holdStarts.has((startCounter += 1))
            ) {
              yield* Queue.offer(heldStarts, {
                threadId: command.threadId,
                messageId: command.message.messageId,
              });
            } else if (
              command.type === "thread.turn.start" &&
              !command.threadId.startsWith("lead")
            ) {
              const hook = yield* Ref.getAndSet(duringMemberStart, null);
              if (hook !== null) yield* hook;
              if (
                (yield* Ref.get(lazyFollowUps)) &&
                (yield* Ref.get(shells)).get(command.threadId)?.latestTurn != null
              )
                return { sequence: 1 };
              turnCounter += 1;
              yield* setMember(command.threadId, {
                latestTurn: {
                  turnId: TurnId.make(`member-turn-${turnCounter}`),
                  state: "running",
                  requestedAt: NOW,
                  startedAt: NOW,
                  completedAt: null,
                  assistantMessageId: null,
                },
                session: { status: "running", lastError: null } as never,
              });
              yield* Queue.offer(memberTurns, command.threadId);
            } else if (command.type === "thread.turn.interrupt" && !ignoreInterrupt) {
              // The provider ends the cut-off turn and tells everyone who listens.
              const shell = (yield* Ref.get(shells)).get(command.threadId);
              if (shell?.latestTurn != null) {
                yield* setMember(command.threadId, {
                  latestTurn: { ...shell.latestTurn, state: interruptEnds, completedAt: NOW },
                  session: {
                    status: interruptEnds === "error" ? "error" : "ready",
                    lastError: interruptEnds === "error" ? "turn aborted" : null,
                  } as never,
                });
                yield* wake(command.threadId);
              }
            } else if (command.type === "thread.activity.append") {
              yield* Ref.update(activities, (previous) => [
                ...previous,
                {
                  id: command.activity.id,
                  kind: command.activity.kind,
                  payload: command.activity.payload,
                },
              ]);
              yield* Queue.offer(activitySignal, undefined);
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

    /** The user presses Stop on a lead: the decider's event, as every client's stop path ends. */
    const stopLead = (threadId: ThreadId) =>
      PubSub.publish(events, {
        type: "thread.turn-interrupt-requested",
        aggregateId: threadId,
        payload: { threadId, createdAt: NOW },
      } as never);

    /**
     * The reactor refuses a message before any turn starts. A memory hold restores the session to
     * ready; a transient failure leaves the session error set first, as the reactor does.
     */
    const failStart = (
      held: { threadId: ThreadId; messageId: MessageId },
      failure: { readonly detail: string; readonly sessionError?: string } = {
        detail: "The selected project memory version changed.",
      },
    ) =>
      Effect.gen(function* () {
        const activity = {
          id: `start-failed-${held.messageId}`,
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Message not sent",
          payload: { detail: failure.detail, requestId: held.messageId },
          turnId: null,
          createdAt: NOW,
        };
        yield* setMember(held.threadId, {
          session: {
            status: failure.sessionError === undefined ? "ready" : "error",
            lastError: failure.sessionError ?? null,
          } as never,
        });
        yield* Ref.update(threadActivities, (all) =>
          new Map(all).set(held.threadId, [...(all.get(held.threadId) ?? []), activity]),
        );
        yield* PubSub.publish(events, {
          aggregateId: held.threadId,
          type: "thread.activity-appended",
          payload: { threadId: held.threadId, activity },
        } as never);
      });
    /** The member's turn ends while its session is still winding down (or already idle). */
    const completeMember = (threadId: ThreadId, idle: boolean) =>
      Effect.gen(function* () {
        const shell = (yield* Ref.get(shells)).get(threadId);
        if (shell?.latestTurn == null) return;
        yield* setMember(threadId, {
          latestTurn: { ...shell.latestTurn, state: "completed", completedAt: NOW },
          session: { status: idle ? "ready" : "running", lastError: null } as never,
        });
        yield* wake(threadId);
      });
    /** The provider reports a thread's session no longer running, as the crew watcher hears it. */
    const sessionReady = (threadId: ThreadId) =>
      PubSub.publish(events, {
        aggregateId: threadId,
        type: "thread.session-set",
        payload: { threadId, session: { status: "ready", lastError: null } },
      } as never);
    const releaseIdle = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* setMember(threadId, { session: { status: "ready", lastError: null } as never });
        yield* wake(threadId);
      });
    const awaitProgress = (taskId: string, status: string) =>
      Effect.gen(function* () {
        while (true) {
          const rows = yield* Ref.get(activities);
          if (
            rows.some(
              (entry) =>
                entry.id === `task-progress:crew:${taskId}` &&
                (entry.payload as { status?: string }).status === status,
            )
          )
            return;
          yield* Queue.take(activitySignal);
        }
      });
    const publishLeadDiff = (turnId: TurnId, additions = 400) =>
      PubSub.publish(events, {
        type: "thread.turn-diff-completed",
        aggregateId: LEAD,
        payload: {
          threadId: LEAD,
          turnId,
          checkpointTurnCount: 0,
          checkpointRef: "ref",
          status: "ready",
          files: [{ path: "a.ts", kind: "modified", additions, deletions: 0 }],
          assistantMessageId: null,
          completedAt: NOW,
        },
      } as never);

    const awaitActivity = (kind: string) =>
      Effect.gen(function* () {
        while (true) {
          const hit = (yield* Ref.get(activities)).find((entry) => entry.kind === kind);
          if (hit !== undefined) return hit.payload as Record<string, unknown>;
          yield* Queue.take(activitySignal);
        }
      });
    const awaitTaskActivity = (kind: string, taskId: string) =>
      Effect.gen(function* () {
        while (true) {
          const hit = (yield* Ref.get(activities)).find(
            (entry) =>
              entry.kind === kind && (entry.payload as { taskId?: string }).taskId === taskId,
          );
          if (hit !== undefined) return hit.payload as Record<string, unknown>;
          yield* Queue.take(activitySignal);
        }
      });
    const saved = (taskId: string) =>
      store.readTasks.pipe(
        Effect.flatMap((rows) => {
          const row = rows.find((candidate) => candidate.task_id === taskId);
          return row === undefined ? Effect.die("missing task") : decodeTask(row.record_json);
        }),
      );
    const issued = Ref.get(commands);
    const interruptsOf = (all: ReadonlyArray<OrchestrationCommand>) =>
      all.flatMap((command) =>
        command.type === "thread.turn.interrupt" ? [command.threadId] : [],
      );
    const progressRows = (taskId: string) =>
      Ref.get(activities).pipe(
        Effect.map((all) => all.filter((entry) => entry.id === `task-progress:crew:${taskId}`)),
      );

    return {
      store,
      events,
      providers,
      start,
      stopLead,
      awaitActivity,
      awaitTaskActivity,
      saved,
      issued,
      interruptsOf,
      progressRows,
      workerTurns,
      memberTurns,
      heldStarts,
      failStart,
      wake,
      setShell: setMember,
      sentMemory,
      duringMemberStart,
      duringFirstSave,
      lazyFollowUps,
      sessionReady,
      detailReads: Effect.sync(() => detailReads),
      completeMember,
      releaseIdle,
      awaitProgress,
      publishLeadDiff,
      /** The lead's turn ended on a passing test run, so a small change counts as proven. */
      recordPassingTests: (turnId: TurnId) =>
        Ref.update(threadActivities, (all) =>
          new Map(all).set(LEAD, [
            ...(all.get(LEAD) ?? []),
            {
              id: "lead-tests",
              kind: "tool.completed",
              turnId,
              payload: {
                itemType: "command_execution",
                status: "completed",
                data: { item: { command: "vp test run foo.test.ts" } },
              },
            },
          ]),
        ),
      activityRows: Ref.get(activities),
    };
  });

/** Starts the service and hands a worker task to each lead; the members are running afterwards. */
const delegateTasks = (world: Effect.Success<ReturnType<typeof makeWorld>>) =>
  Effect.gen(function* () {
    const service = yield* world.start;
    const task = (threadId: ThreadId, title: string, todos?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const delegated = yield* service.crew.delegate({
          threadId,
          role: "worker",
          task: "Do it",
          title,
          ...(todos === undefined ? {} : { todos }),
        });
        return { taskId: delegated.taskId, memberId: yield* Queue.take(world.memberTurns) };
      });
    return { service, crew: service.crew, task };
  });

describe("crew stop: with the lead", () => {
  it.effect(
    "stops only the lead's running tasks through the interrupt command, with no failover",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { service, task } = yield* delegateTasks(world);
        const first = yield* task(LEAD, "First", ["a", "b"]);
        const second = yield* task(LEAD, "Second");
        const foreign = yield* task(OTHER_LEAD, "Foreign");

        yield* world.stopLead(LEAD);
        const receipt = yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);

        assert.sameMembers(receipt.taskIds as string[], [first.taskId, second.taskId]);
        // The members' own turns were interrupted; the other lead's was not.
        const all = yield* world.issued;
        assert.sameMembers(world.interruptsOf(all), [first.memberId, second.memberId]);
        // Nothing was handed to another model.
        assert.strictEqual(all.filter((command) => command.type === "thread.create").length, 3);
        assert.strictEqual(
          all.filter((command) => command.type === "thread.turn.start" && command.threadId !== LEAD)
            .length,
          3,
        );

        const stopped = yield* world.saved(first.taskId);
        assert.strictEqual(stopped.report?.status, "interrupted");
        assert.strictEqual(stopped.stopped, "Stopped with the lead turn.");
        assert.include(stopped.report?.result, "Stopped with the lead turn.");
        assert.isTrue(stopped.ended);
        // The lead stopped it, so the report is not handed back as a follow-up turn.
        assert.isTrue(stopped.collected);
        // Items nobody proved stay pending; the stop counts none of them done.
        assert.deepStrictEqual(
          stopped.todos?.map((todo) => todo.status),
          ["pending", "pending"],
        );
        const completed = yield* world.awaitTaskActivity("task.completed", first.taskId);
        assert.strictEqual(completed.status, "stopped");
        assert.strictEqual(completed.todoVerified, 0);
        const rows = yield* world.progressRows(first.taskId);
        assert.strictEqual((rows.at(-1)!.payload as { status: string }).status, "stopped");

        assert.isNull((yield* world.saved(foreign.taskId)).report);
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stops a task whose member was handed the lead's memory references", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");

      const started = (yield* world.issued).find(
        (command) => command.type === "thread.turn.start" && command.threadId === first.memberId,
      );
      assert.isTrue(started?.type === "thread.turn.start");
      const records = started?.type === "thread.turn.start" ? started.message.context?.records : [];
      assert.deepEqual(
        records?.flatMap((record) => (record.kind === "memory" ? [record.payload] : [])),
        [{ memoryId: "mem-1", selectedVersion: 2 }],
      );

      yield* world.stopLead(LEAD);
      yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);
      assert.sameMembers(world.interruptsOf(yield* world.issued), [first.memberId]);
      const completed = yield* world.awaitTaskActivity("task.completed", first.taskId);
      assert.strictEqual(completed.status, "stopped");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends a task stopped when the interrupted turn reports an error", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("error");
      const { service, task } = yield* delegateTasks(world);
      const running = yield* task(LEAD, "First");

      yield* world.stopLead(LEAD);
      yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);

      assert.strictEqual((yield* world.saved(running.taskId)).report?.status, "interrupted");
      assert.strictEqual(
        (yield* world.issued).filter((command) => command.type === "thread.create").length,
        1,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("is idempotent: a second stop finds nothing running", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const running = yield* task(LEAD, "First");

      yield* world.stopLead(LEAD);
      yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);
      const before = world.interruptsOf(yield* world.issued).length;
      const again = yield* crew.stop({ threadId: LEAD });

      assert.deepStrictEqual(again.stopped, []);
      assert.strictEqual(world.interruptsOf(yield* world.issued).length, before);
      assert.strictEqual((yield* world.saved(running.taskId)).report?.status, "interrupted");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: on request", () => {
  it.effect("stops one task by id or all of them, and only the caller's", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      const second = yield* task(LEAD, "Second");
      const foreign = yield* task(OTHER_LEAD, "Foreign");

      const refused = yield* crew
        .stop({ threadId: LEAD, taskId: foreign.taskId })
        .pipe(Effect.flip);
      assert.include(refused.reason, "not available");
      assert.isNull((yield* world.saved(foreign.taskId)).report);

      const one = yield* crew.stop({ threadId: LEAD, taskId: first.taskId });
      assert.deepStrictEqual(one.stopped, [first.taskId]);
      assert.isNull((yield* world.saved(second.taskId)).report);
      assert.strictEqual((yield* world.saved(first.taskId)).stopped, "Stopped on request.");

      const rest = yield* crew.stop({ threadId: LEAD });
      assert.deepStrictEqual(rest.stopped, [second.taskId]);
      assert.deepStrictEqual(world.interruptsOf(yield* world.issued), [
        first.memberId,
        second.memberId,
      ]);
      assert.isNull((yield* world.saved(foreign.taskId)).report);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: after a restart", () => {
  it.effect("finishes a stopped task as stopped without starting its member again", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const memberId = ThreadId.make("member-1");
      const task: typeof CrewTaskRecoveryState.Type = {
        version: 1,
        taskId: "task-1",
        leadThreadId: LEAD,
        leadTurnId: TurnId.make("lead-1-turn"),
        role: "worker",
        subject: "worker task",
        attempts: [{ model: "m", threadId: memberId, messageId: MessageId.make("member-request") }],
        stopped: "Stopped with the lead turn.",
        report: null,
        collected: false,
        ended: false,
        auditState: "none",
      };
      yield* world.store.saveTask({
        task_id: task.taskId,
        lead_thread_id: LEAD,
        record_json: yield* encodeTask(task),
        updated_at: NOW,
      });
      // The turn was cut off by the error some providers raise, which would normally fail over.
      yield* Ref.set(world.workerTurns, [
        {
          threadId: memberId,
          turnId: TurnId.make("member-turn"),
          pendingMessageId: MessageId.make("member-request"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "error",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        },
      ]);

      const service = yield* world.start;
      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: ["task-1"] });

      assert.strictEqual(report!.status, "interrupted");
      assert.strictEqual(report!.result, "Stopped with the lead turn.");
      assert.isTrue((yield* world.saved("task-1")).collected);
      assert.isFalse(
        (yield* world.issued).some(
          (command) => command.type === "thread.create" || command.type === "thread.turn.start",
        ),
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: a held memory send", () => {
  it.effect("ends the task blocked instead of waiting forever, with no failover", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]));
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* world.failStart(yield* Queue.take(world.heldStarts));

      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report!.status, "blocked");
      assert.include(report!.result, "held");
      assert.include(report!.result, "version changed");
      const all = yield* world.issued;
      assert.strictEqual(all.filter((command) => command.type === "thread.create").length, 1);
      assert.strictEqual(
        all.filter((command) => command.type === "thread.turn.start" && command.threadId !== LEAD)
          .length,
        1,
      );
      const completed = yield* world.awaitTaskActivity("task.completed", delegated.taskId);
      assert.strictEqual(completed.status, "blocked");
      assert.isTrue((yield* world.saved(delegated.taskId)).ended);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends a stopped task whose first message is then held", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]));
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      const held = yield* Queue.take(world.heldStarts);
      const stopping = yield* Effect.forkChild(service.crew.stop({ threadId: LEAD }));
      yield* world.awaitProgress(delegated.taskId, "stopped");
      yield* world.failStart(held);

      const result = yield* Fiber.join(stopping);
      assert.deepStrictEqual(result.stopped, [delegated.taskId]);
      assert.deepStrictEqual(result.stopping, []);
      assert.strictEqual((yield* world.saved(delegated.taskId)).report?.status, "interrupted");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends the task blocked when a nudge to the member is held", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([2]));
      const { service, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First", ["a"]);
      yield* world.completeMember(first.memberId, true);
      yield* world.failStart(yield* Queue.take(world.heldStarts));

      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [first.taskId] });
      assert.strictEqual(report!.status, "blocked");
      assert.strictEqual(
        (yield* world.issued).filter((command) => command.type === "thread.create").length,
        1,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: a refused member message", () => {
  it.effect("does not re-read the thread for every event of a streaming member", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      for (let index = 0; index < 200; index += 1) {
        yield* world.wake(first.memberId);
      }
      yield* world.completeMember(first.memberId, true);
      yield* crew.wait({ threadId: LEAD, taskIds: [first.taskId] });

      // The settle check reads once; the other reads belong to the report itself.
      assert.isBelow(yield* world.detailReads, 20);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "fails over when the first message fails with a session error, in the reactor's order",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld("interrupted", new Set([1]));
        const service = yield* world.start;
        const delegated = yield* service.crew.delegate({
          threadId: LEAD,
          role: "worker",
          task: "Do it",
        });
        yield* world.failStart(yield* Queue.take(world.heldStarts), {
          detail: "Provider turn start failed",
          sessionError: "provider fell over",
        });
        yield* world.completeMember(yield* Queue.take(world.memberTurns), true);

        const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
        assert.strictEqual(report!.status, "completed");
        assert.strictEqual(
          (yield* world.issued).filter((command) => command.type === "thread.create").length,
          2,
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("fails over when a nudge fails transiently, without the memory-hold wording", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([2]));
      const { service, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First", ["a"]);
      yield* world.completeMember(first.memberId, true);
      yield* world.failStart(yield* Queue.take(world.heldStarts), {
        detail: "Provider turn start failed",
        sessionError: "provider fell over",
      });
      yield* world.completeMember(yield* Queue.take(world.memberTurns), true);

      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [first.taskId] });
      assert.notInclude(report!.result ?? "", "held");
      assert.notInclude(report!.result ?? "", "project memory");
      assert.strictEqual(
        (yield* world.issued).filter((command) => command.type === "thread.create").length,
        2,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not call a stop of the member's own thread a memory hold", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]));
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* world.failStart(yield* Queue.take(world.heldStarts), {
        detail: "Stopped before this message was sent.",
      });

      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.notStrictEqual(report!.status, "blocked");
      assert.notInclude(report!.result ?? "", "held");
      assert.notInclude(report!.result ?? "", "project memory");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: a refusal that is not a stop", () => {
  it.effect("fails over when the reactor refuses a start for a reason other than a stop", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]));
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* world.failStart(yield* Queue.take(world.heldStarts), {
        detail:
          "The queued message could not resume after context compaction. Send this message again to continue.",
      });
      yield* world.completeMember(yield* Queue.take(world.memberTurns), true);

      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report!.status, "completed");
      assert.strictEqual(
        (yield* world.issued).filter((command) => command.type === "thread.create").length,
        2,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: a stopped lead is not restarted", () => {
  /** Lets the service's watcher fibers run to quiescence. */
  const drain = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
    discard: true,
  });
  const leadStarts = (all: ReadonlyArray<OrchestrationCommand>) =>
    all.filter((command) => command.type === "thread.turn.start" && command.threadId === LEAD);

  /**
   * One task got its own Stop and then the whole lead was stopped; the member still finished its
   * work whole, so the result waits uncollected. Returns the pieces for the assertions.
   */
  const finishedAfterBothStops = (leadTurn: "interrupted" | "completed") =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set(), true);
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      const taskStop = yield* Effect.forkChild(crew.stop({ threadId: LEAD, taskId: first.taskId }));
      yield* world.awaitProgress(first.taskId, "stopped");
      yield* world.stopLead(LEAD);
      yield* world.setShell(LEAD, {
        latestTurn: { ...leadShell(LEAD).latestTurn!, state: leadTurn, completedAt: NOW },
      });
      yield* world.completeMember(first.memberId, true);
      yield* world.sessionReady(LEAD);
      yield* Fiber.join(taskStop);
      yield* world.awaitTaskActivity("task.completed", first.taskId);
      return { world, service, first };
    });

  for (const leadTurn of ["interrupted", "completed"] as const) {
    it.effect(
      `holds a result that finished after the lead's turn was stopped (${leadTurn}), until the next turn ends`,
      () =>
        Effect.gen(function* () {
          const { world, service } = yield* finishedAfterBothStops(leadTurn);
          yield* drain;
          assert.strictEqual(leadStarts(yield* world.issued).length, 0);

          // The user's next turn ends: that is when the waiting result is handed over.
          yield* world.setShell(LEAD, {
            latestTurn: {
              ...leadShell(LEAD).latestTurn!,
              turnId: TurnId.make("lead-1-turn-2"),
              state: "completed",
              completedAt: NOW,
            },
          });
          yield* world.sessionReady(LEAD);
          yield* drain;
          assert.strictEqual(leadStarts(yield* world.issued).length, 1);
          yield* service.close;
        }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  }
});

describe("crew follow-up: one wake-up per lead turn", () => {
  const drain = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
    discard: true,
  });
  const leadStarts = (all: ReadonlyArray<OrchestrationCommand>) =>
    all.flatMap((command) =>
      command.type === "thread.turn.start" && command.threadId === LEAD ? [command] : [],
    );

  it.effect("holds a finished report until the other tasks of its lead turn end", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      const second = yield* task(LEAD, "Second");
      yield* world.setShell(LEAD, {
        latestTurn: { ...leadShell(LEAD).latestTurn!, state: "completed", completedAt: NOW },
      });

      yield* world.completeMember(first.memberId, true);
      yield* world.awaitTaskActivity("task.completed", first.taskId);
      yield* world.sessionReady(LEAD);
      yield* drain;
      assert.strictEqual(leadStarts(yield* world.issued).length, 0);

      yield* world.completeMember(second.memberId, true);
      yield* world.awaitTaskActivity("task.completed", second.taskId);
      yield* world.sessionReady(LEAD);
      yield* drain;
      const starts = leadStarts(yield* world.issued);
      assert.strictEqual(starts.length, 1);
      assert.include(starts[0]!.message.text, "First");
      assert.include(starts[0]!.message.text, "Second");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: races around a stop", () => {
  const drain = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, {
    discard: true,
  });
  const commandsOfType = (all: ReadonlyArray<OrchestrationCommand>, type: string) =>
    all.filter((command) => command.type === type);

  it.effect("starts a task stopped when it comes from a lead turn that was already stopped", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      yield* world.stopLead(LEAD);
      yield* drain;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* drain;

      assert.isDefined((yield* world.saved(delegated.taskId)).stopped);
      assert.strictEqual(commandsOfType(yield* world.issued, "thread.create").length, 0);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("marks a task stopped when the lead is stopped as the task is being created", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      // The stop lands after the record is built and before it is listed, so it finds no task.
      yield* Ref.set(
        world.duringFirstSave,
        service.crew.stop({ threadId: LEAD }).pipe(Effect.orDie),
      );
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* drain;

      assert.isDefined((yield* world.saved(delegated.taskId)).stopped);
      assert.strictEqual(commandsOfType(yield* world.issued, "thread.create").length, 0);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps a stopped lead turn marked while the next turn is requested but not started",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const service = yield* world.start;
        yield* world.stopLead(LEAD);
        yield* drain;
        yield* PubSub.publish(world.events, {
          type: "thread.turn-start-requested",
          aggregateId: LEAD,
          payload: { threadId: LEAD },
        } as never);
        yield* drain;
        // The lead's latest turn is still the stopped one: this is its late tool call.
        const delegated = yield* service.crew.delegate({
          threadId: LEAD,
          role: "worker",
          task: "Do it",
        });
        yield* drain;

        assert.isDefined((yield* world.saved(delegated.taskId)).stopped);
        assert.strictEqual(commandsOfType(yield* world.issued, "thread.create").length, 0);
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not hold back a task from the lead's next turn", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      yield* world.stopLead(LEAD);
      yield* drain;
      yield* world.setShell(LEAD, {
        latestTurn: { ...leadShell(LEAD).latestTurn!, turnId: TurnId.make("lead-1-turn-2") },
      });
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });
      yield* Queue.take(world.memberTurns);

      assert.isUndefined((yield* world.saved(delegated.taskId)).stopped);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("starts a user's retry even though the lead's stopped turn is still the latest", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      yield* crew.stop({ threadId: LEAD, taskId: first.taskId });
      yield* world.stopLead(LEAD);
      yield* drain;

      const retried = yield* crew.retryTask({ threadId: LEAD, taskId: first.taskId });
      yield* Queue.take(world.memberTurns);

      assert.isUndefined((yield* world.saved(retried.taskId)).stopped);
      assert.strictEqual(commandsOfType(yield* world.issued, "thread.create").length, 2);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a user's retry keeps finished items and the lead's why, and reopens the rest", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
        title: "First",
        todos: ["a", "b"],
        why: "the login bug blocks the release",
      });
      const member = yield* Queue.take(world.memberTurns);
      yield* service.crew.checkTodo({
        threadId: member,
        todoId: "t1",
        status: "done",
        note: "did a",
      });
      yield* service.crew.stop({ threadId: LEAD, taskId: delegated.taskId });
      yield* world.stopLead(LEAD);
      yield* drain;

      const retried = yield* service.crew.retryTask({ threadId: LEAD, taskId: delegated.taskId });
      yield* Queue.take(world.memberTurns);

      const saved = yield* world.saved(retried.taskId);
      assert.deepStrictEqual(
        saved.todos?.map((todo) => `${todo.id}:${todo.status}`),
        ["t1:claimed", "t2:pending"],
      );
      const starts = commandsOfType(yield* world.issued, "thread.turn.start").filter(
        (command) => command.type === "thread.turn.start" && command.threadId !== LEAD,
      );
      const lastStart = starts.at(-1);
      const retryText = lastStart?.type === "thread.turn.start" ? lastStart.message.text : "";
      assert.include(retryText, "Finished, do not redo: t1 (done, unverified).");
      const open = retryText.slice(retryText.indexOf("TODO PROGRESS"));
      assert.include(open, "- t2: b");
      assert.notInclude(open, "- t1:");
      const started = (yield* world.activityRows).find(
        (entry) =>
          entry.kind === "task.started" &&
          (entry.payload as { taskId?: string }).taskId === retried.taskId,
      );
      assert.strictEqual(
        (started?.payload as { why?: string } | undefined)?.why,
        "the login bug blocks the release",
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("interrupts a nudge that a stop raced with, instead of leaving it running", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First", ["a"]);
      yield* Ref.set(world.lazyFollowUps, true);
      // The stop arrives while the nudge is being sent, before the provider starts that turn,
      // and the thread still reads as idle afterwards.
      yield* Ref.set(
        world.duringMemberStart,
        Effect.gen(function* () {
          yield* Effect.forkDetach(crew.stop({ threadId: LEAD }));
          yield* drain;
        }),
      );
      yield* world.completeMember(first.memberId, true);
      yield* world.awaitProgress(first.taskId, "stopped");
      yield* drain;

      const all = yield* world.issued;
      assert.deepStrictEqual(world.interruptsOf(all), [first.memberId]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: lead memory the ledger did not show as sent", () => {
  it.effect("warns the lead that the memory was not passed to the member", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      yield* Ref.set(world.sentMemory, []);
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
      });

      assert.include(delegated.warning ?? "", "not passed to the member");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says nothing when every selected memory was sent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      const delegated = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
        todos: [{ text: "Do it", check: { command: "true" } }],
      });

      assert.isUndefined(delegated.warning);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: nothing restarts", () => {
  it.effect("sends no nudge to a member whose task was stopped while it wound down", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First", ["a"]);
      // The turn ended but the session is still busy, so the nudge waits for idle.
      yield* world.completeMember(first.memberId, false);
      const stopping = yield* Effect.forkChild(crew.stop({ threadId: LEAD }));
      yield* world.awaitProgress(first.taskId, "stopped");
      yield* world.releaseIdle(first.memberId);
      yield* Fiber.join(stopping);

      const starts = (yield* world.issued).filter(
        (command) => command.type === "thread.turn.start" && command.threadId === first.memberId,
      );
      assert.strictEqual(starts.length, 1);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not audit a lead turn the user stopped, and records the skip", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      yield* world.stopLead(LEAD);
      yield* world.publishLeadDiff(TurnId.make(`${LEAD}-turn`));

      const skipped = yield* world.awaitActivity(CREW_AUDIT_SKIPPED_ACTIVITY);
      assert.strictEqual(skipped.stopped, true);
      assert.isFalse((yield* world.issued).some((command) => command.type === "thread.create"));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs a light audit on the fast model for a small change whose tests passed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const service = yield* world.start;
      const turnId = TurnId.make(`${LEAD}-turn`);
      yield* world.recordPassingTests(turnId);
      yield* world.publishLeadDiff(turnId, 5);

      yield* world.awaitActivity("task.started");
      const created = (yield* world.issued).find((command) => command.type === "thread.create");
      assert.isTrue(created?.type === "thread.create" && created.title.startsWith("Crew Auditor"));
      assert.strictEqual(
        created?.type === "thread.create" ? created.modelSelection.model : null,
        "claude-haiku-5",
      );
      assert.isFalse(
        (yield* world.activityRows).some((entry) => entry.kind === CREW_AUDIT_SKIPPED_ACTIVITY),
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not queue an audit fix for a stopped task, even after a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const task: typeof CrewTaskRecoveryState.Type = {
        version: 1,
        taskId: "audit-1",
        leadThreadId: LEAD,
        leadTurnId: TurnId.make("lead-1-turn"),
        role: "auditor",
        subject: "Review",
        attempts: [],
        stopped: "Stopped on request.",
        report: {
          taskId: "audit-1",
          role: "auditor",
          status: "completed",
          result: "Verdict: needs changes\n- fix it",
        },
        collected: false,
        ended: true,
        auditState: "none",
      };
      yield* world.store.saveTask({
        task_id: task.taskId,
        lead_thread_id: LEAD,
        record_json: yield* encodeTask(task),
        updated_at: NOW,
      });
      const service = yield* world.start;
      yield* service.crew.wait({ threadId: LEAD, taskIds: ["audit-1"] });

      assert.strictEqual((yield* world.saved("audit-1")).auditState, "skipped");
      assert.isFalse((yield* world.activityRows).some((entry) => entry.kind === "crew.follow-up"));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew stop: reports what really happened", () => {
  it.effect("lists a task that is still stopping and does not announce a finished stop", () =>
    Effect.gen(function* () {
      // The member never reports its cut-off turn, so the task cannot end inside the wait.
      const world = yield* makeWorld("interrupted", new Set(), true);
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");

      const stopRun = yield* Effect.forkChild(crew.stop({ threadId: LEAD }));
      yield* world.awaitProgress(first.taskId, "stopped");
      yield* TestClock.adjust("21 seconds");
      const result = yield* Fiber.join(stopRun);
      assert.deepStrictEqual(result.stopped, []);
      assert.deepStrictEqual(result.stopping, [first.taskId]);
      const receipt = yield* world.awaitActivity(CREW_STOPPING_ACTIVITY);
      assert.deepStrictEqual(receipt.stopping, [first.taskId]);
      assert.isFalse(
        (yield* world.activityRows).some((entry) => entry.kind === CREW_STOPPED_ACTIVITY),
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );
});

describe("crew wait: when the member turn is interrupted", () => {
  it.live("settles on the interrupt request even when the provider never sends session-set", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      // The projector turned the member's turn interrupted; the provider stays silent.
      yield* world.setShell(first.memberId, {
        latestTurn: {
          turnId: TurnId.make("member-turn-1"),
          state: "interrupted",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      });
      // Published until the wait has subscribed, so the ordering cannot decide the outcome.
      const requestInterrupt = Effect.forever(
        PubSub.publish(world.events, {
          type: "thread.turn-interrupt-requested",
          aggregateId: first.memberId,
          payload: { threadId: first.memberId, createdAt: NOW },
        } as never).pipe(Effect.andThen(Effect.sleep("10 millis"))),
      );
      const [report] = yield* Effect.race(
        crew.wait({ threadId: LEAD, taskIds: [first.taskId] }),
        requestInterrupt,
      ).pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(report?.status, "interrupted");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew decision log: why", () => {
  it.effect("puts the lead's why in the task.started payload and nowhere else", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew } = yield* delegateTasks(world);
      const why = "Picked the worker: a mechanical rename; considered an expert and rejected it.";
      const withWhy = yield* crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Rename it",
        title: "Rename it",
        why,
      });
      yield* Queue.take(world.memberTurns);
      const withoutWhy = yield* crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
        title: "Plain",
      });
      yield* Queue.take(world.memberTurns);

      const started = yield* world.awaitTaskActivity("task.started", withWhy.taskId);
      assert.strictEqual(started.why, why);
      const plain = yield* world.awaitTaskActivity("task.started", withoutWhy.taskId);
      assert.notProperty(plain, "why");
      const others = (yield* world.activityRows).filter(
        (entry) => entry.kind !== "task.started" && "why" in (entry.payload as object),
      );
      assert.deepStrictEqual(others, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("bounds a long why to the limit and drops a blank one", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew } = yield* delegateTasks(world);
      const long = yield* crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Rename it",
        title: "Long",
        why: "y".repeat(400),
      });
      yield* Queue.take(world.memberTurns);
      const blank = yield* crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Do it",
        title: "Blank",
        why: "  ",
      });
      yield* Queue.take(world.memberTurns);
      const started = yield* world.awaitTaskActivity("task.started", long.taskId);
      assert.strictEqual(started.why, "y".repeat(300));
      assert.notProperty(yield* world.awaitTaskActivity("task.started", blank.taskId), "why");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("puts the lead's why in the crew.stopped payload, keeping the reason", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      yield* crew.stop({ threadId: LEAD, taskId: first.taskId, why: "The user changed the plan." });
      const receipt = yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);
      assert.strictEqual(receipt.why, "The user changed the plan.");
      assert.strictEqual(receipt.reason, "Stopped on request.");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("has no why on a stop the user or the lead turn caused", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const { service, task } = yield* delegateTasks(world);
      yield* task(LEAD, "First");
      yield* world.stopLead(LEAD);
      const receipt = yield* world.awaitActivity(CREW_STOPPED_ACTIVITY);
      assert.notProperty(receipt, "why");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("puts the why in crew.stopping when a task is still winding down", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set(), true);
      const { service, crew, task } = yield* delegateTasks(world);
      const first = yield* task(LEAD, "First");
      const stopRun = yield* Effect.forkChild(
        crew.stop({ threadId: LEAD, taskId: first.taskId, why: "Too slow." }),
      );
      yield* world.awaitProgress(first.taskId, "stopped");
      yield* TestClock.adjust("21 seconds");
      yield* Fiber.join(stopRun);
      const receipt = yield* world.awaitActivity(CREW_STOPPING_ACTIVITY);
      assert.strictEqual(receipt.why, "Too slow.");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );
});

describe("crew: cooling after a failure", () => {
  const CLAUDE = ProviderInstanceId.make("claude");
  const CODEX = ProviderInstanceId.make("codex");
  const pinnedHaiku = { worker: { instanceId: CLAUDE, model: "claude-haiku-5" } };
  /** Claude with one more worker-sized model, so a fallback on the same provider exists. */
  const withSonnet = [
    provider("claude", "claudeAgent", ["claude-opus-5", "claude-haiku-5", "claude-sonnet-5"]),
    PROVIDERS[1]!,
  ];
  const createdModels = (all: ReadonlyArray<OrchestrationCommand>) =>
    all.flatMap((command) =>
      command.type === "thread.create"
        ? [`${command.modelSelection.instanceId}/${command.modelSelection.model}`]
        : [],
    );
  /**
   * Delegates a worker task; the reactor refuses its first start with this session error, and the
   * model the task moves on to finishes it.
   */
  const failFirstThenFinish = (
    world: Effect.Success<ReturnType<typeof makeWorld>>,
    crew: CrewService.CrewService["Service"],
    error: string,
  ) =>
    Effect.gen(function* () {
      const delegated = yield* crew.delegate({ threadId: LEAD, role: "worker", task: "Do it" });
      yield* world.failStart(yield* Queue.take(world.heldStarts), {
        detail: error,
        sessionError: error,
      });
      yield* world.completeMember(yield* Queue.take(world.memberTurns), true);
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report!.status, "completed");
      return delegated.taskId;
    });
  const switchSummaries = (world: Effect.Success<ReturnType<typeof makeWorld>>, taskId: string) =>
    world.activityRows.pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const payload = row.payload as { taskId?: string; summary?: string };
          return row.kind === "task.progress" && payload.taskId === taskId && payload.summary
            ? [payload.summary]
            : [];
        }),
      ),
    );

  it.effect("blocks only the refused model, so its provider's other model takes over", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CLAUDE, model: "claude-sonnet-5" }] },
      });
      yield* Ref.set(world.providers, withSonnet);
      const service = yield* world.start;
      yield* failFirstThenFinish(
        world,
        service.crew,
        "The agent could not switch to model claude-haiku-5.",
      );
      assert.deepStrictEqual(createdModels(yield* world.issued), [
        "claude/claude-haiku-5",
        "claude/claude-sonnet-5",
      ]);
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        { provider: "claude", model: "claude-haiku-5", reason: "model refused" },
      ]);
      // The provider's next status check lifts the block.
      yield* Ref.set(
        world.providers,
        withSonnet.map((entry) => ({ ...entry, checkedAt: NOW }) as ServerProvider),
      );
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("counts refusals before the provider's next status check as one", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1, 3]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CLAUDE, model: "claude-sonnet-5" }] },
      });
      yield* Ref.set(world.providers, withSonnet);
      const service = yield* world.start;
      const refusal = "The agent could not switch to model claude-haiku-5.";
      yield* failFirstThenFinish(world, service.crew, refusal);
      yield* failFirstThenFinish(world, service.crew, refusal);
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        { provider: "claude", model: "claude-haiku-5", reason: "model refused" },
      ]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("blocks a model refused again for a day, past the provider's status checks", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1, 3]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CLAUDE, model: "claude-sonnet-5" }] },
      });
      yield* Ref.set(world.providers, withSonnet);
      const service = yield* world.start;
      const refusal = "The agent could not switch to model claude-haiku-5.";
      yield* failFirstThenFinish(world, service.crew, refusal);
      yield* Ref.set(
        world.providers,
        withSonnet.map((entry) => ({ ...entry, checkedAt: NOW }) as ServerProvider),
      );
      yield* failFirstThenFinish(world, service.crew, refusal);
      const later = IsoDateTime.make("2026-11-04T00:00:00.000Z");
      yield* Ref.set(
        world.providers,
        withSonnet.map((entry) => ({ ...entry, checkedAt: later }) as ServerProvider),
      );
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        {
          provider: "claude",
          model: "claude-haiku-5",
          until: IsoDateTime.make("1970-01-02T00:00:00.000Z"),
          reason: "model refused again",
        },
      ]);
      yield* TestClock.adjust("24 hours");
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("cools a provider until its full usage window resets", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1, 3]), false, {
        pinned: pinnedHaiku,
      });
      const resetsAt = IsoDateTime.make("1970-01-01T02:00:00.000Z");
      yield* Ref.set(world.providers, [
        {
          ...PROVIDERS[0]!,
          usageLimits: {
            checkedAt: NOW,
            windows: [
              { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100, resetsAt },
              { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 40 },
            ],
          },
        } as ServerProvider,
        PROVIDERS[1]!,
      ]);
      const service = yield* world.start;
      const limit =
        "1308 Usage limit reached for 5 hour. Your limit will reset at 2026-11-04 21:15:17";
      yield* failFirstThenFinish(world, service.crew, limit);
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        { provider: "claude", until: resetsAt, reason: "5-hour limit" },
      ]);

      // A new task still tries the role's own model once first, in case the limit was reset.
      yield* TestClock.adjust("1 hour");
      yield* failFirstThenFinish(world, service.crew, limit);
      const created = createdModels(yield* world.issued);
      assert.strictEqual(created[2], "claude/claude-haiku-5");
      assert.isTrue(created[3]!.startsWith("codex/"));

      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("cools a provider for 15 minutes when no window reports a reset", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CLAUDE, model: "claude-sonnet-5" }] },
      });
      yield* Ref.set(world.providers, withSonnet);
      const service = yield* world.start;
      const taskId = yield* failFirstThenFinish(
        world,
        service.crew,
        "429 Too Many Requests: rate limit exceeded",
      );
      // The fallback on the cooling provider is skipped, and the switch message says why.
      const created = createdModels(yield* world.issued);
      assert.strictEqual(created.length, 2);
      assert.isTrue(created[1]!.startsWith("codex/"));
      const [summary] = yield* switchSummaries(world, taskId);
      assert.include(summary, "cooling claude for 15 more minutes (usage limit)");
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        { provider: "claude", until: "1970-01-01T00:15:00.000Z", reason: "usage limit" },
      ]);

      yield* TestClock.adjust("14 minutes");
      assert.strictEqual((yield* service.crew.roster(LEAD)).cooling.length, 1);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("holds back only the model whose own usage window is full", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CLAUDE, model: "claude-sonnet-5" }] },
      });
      const scoped = (haikuUsed: number, checkedAt: string) =>
        [
          {
            ...withSonnet[0]!,
            usageLimits: {
              checkedAt,
              windows: [
                {
                  id: "seven_day_haiku",
                  kind: "weekly",
                  label: "Weekly · Haiku",
                  modelFamilies: ["Haiku"],
                  usedPercent: haikuUsed,
                  resetsAt: "1970-01-03T00:00:00.000Z",
                },
                // Another model's full window says nothing about this one.
                {
                  id: "seven_day_opus",
                  kind: "weekly",
                  label: "Weekly · Opus",
                  modelFamilies: ["Opus"],
                  usedPercent: 100,
                  resetsAt: "1970-01-05T00:00:00.000Z",
                },
              ],
            },
          } as ServerProvider,
          withSonnet[1]!,
        ] as const;
      yield* Ref.set(world.providers, scoped(100, NOW));
      const service = yield* world.start;
      yield* failFirstThenFinish(world, service.crew, "rate limit exceeded");
      assert.deepStrictEqual(createdModels(yield* world.issued), [
        "claude/claude-haiku-5",
        "claude/claude-sonnet-5",
      ]);
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, [
        {
          provider: "claude",
          model: "claude-haiku-5",
          until: "1970-01-03T00:00:00.000Z",
          reason: "Weekly · Haiku limit",
        },
      ]);
      // A newer usage check shows the window no longer full (the user reset it): it ends now.
      yield* Ref.set(world.providers, scoped(40, "2026-11-03T00:05:00.000Z"));
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("ends a cooling as soon as the role's own model finishes a turn there", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]), false, {
        pinned: pinnedHaiku,
      });
      const service = yield* world.start;
      yield* failFirstThenFinish(world, service.crew, "429 Too Many Requests");
      assert.strictEqual((yield* service.crew.roster(LEAD)).cooling.length, 1);
      // The next task tries the role's model first, and it works: the limit was reset.
      const next = yield* service.crew.delegate({ threadId: LEAD, role: "worker", task: "Again" });
      yield* world.completeMember(yield* Queue.take(world.memberTurns), true);
      yield* service.crew.wait({ threadId: LEAD, taskIds: [next.taskId] });
      assert.strictEqual(createdModels(yield* world.issued)[2], "claude/claude-haiku-5");
      assert.deepStrictEqual((yield* service.crew.roster(LEAD)).cooling, []);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );

  it.effect("hands a failed task to the user's fallback before OOP's own pick", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("interrupted", new Set([1]), false, {
        pinned: pinnedHaiku,
        fallbacks: { worker: [{ instanceId: CODEX, model: "gpt-5.4" }] },
      });
      const service = yield* world.start;
      yield* failFirstThenFinish(world, service.crew, "The session crashed.");
      assert.deepStrictEqual(createdModels(yield* world.issued), [
        "claude/claude-haiku-5",
        "codex/gpt-5.4",
      ]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer), Effect.provide(TestClock.layer())),
  );
});
