import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeTimersPromises from "node:timers/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
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
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectMemorySendGate from "../memory/ProjectMemorySendGate.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CrewService from "./CrewService.ts";
import { CrewTaskRecoveryJson, type CrewTaskRecoveryState } from "./crewRecoveryState.ts";
import { delegatePrompt } from "./crewLogic.ts";

const decodeTask = Schema.decodeEffect(CrewTaskRecoveryJson);
const encodeTask = Schema.encodeEffect(CrewTaskRecoveryJson);
const NOW = IsoDateTime.make("2026-11-02T00:00:00.000Z");
const LEAD = ThreadId.make("lead-1");
const TASK_TITLE = "Do the thing";

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

const TestLayer = Layer.mergeAll(
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive, SqlitePersistenceMemory),
  GitVcsDriver.layer,
  ProcessRunner.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-crew-todos-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** A lead workspace that is a real git repository, so file checks and sweeps run for real. */
const makeWorldIn = (
  runtimeMode: OrchestrationThreadShell["runtimeMode"],
  leadModel: ModelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus-5",
  },
  providerList: ReadonlyArray<ServerProvider> = PROVIDERS,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-todos-repo-" });
    const run = (args: ReadonlyArray<string>) =>
      git.execute({ operation: "CrewService.todos.test", cwd: repo, args });
    yield* run(["init"]);
    yield* run(["config", "user.name", "Test"]);
    yield* run(["config", "user.email", "test@test.com"]);
    yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
    yield* fs.writeFileString(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    yield* fs.writeFileString(path.join(repo, "other.txt"), "other\n");
    yield* run(["add", "."]);
    yield* run(["commit", "-m", "initial"]);
    const write = (root: string, name: string, text: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(path.join(root, name)), { recursive: true });
        yield* fs.writeFileString(path.join(root, name), text);
      });

    const lead: OrchestrationThreadShell = {
      id: LEAD,
      projectId: ProjectId.make("project-1"),
      title: "Lead",
      modelSelection: leadModel,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: repo,
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
    const leadDetail: OrchestrationThread = {
      ...lead,
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

    const store = yield* CrewRuntimeStateLive.make;
    // The leads whose pending deliveries the service looked up.
    const pendingReads: string[] = [];
    // Every thread whose shell the service read.
    const shellReads: string[] = [];
    const countingStore: typeof store = {
      ...store,
      readPendingFollowUps: (leadId) => {
        pendingReads.push(leadId);
        return store.readPendingFollowUps(leadId);
      },
    };
    const events = yield* PubSub.unbounded<never>();
    const shells = yield* Ref.make(new Map<ThreadId, OrchestrationThreadShell>());
    const replies = yield* Ref.make(new Map<ThreadId, string>());
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const activities = yield* Ref.make<
      ReadonlyArray<{ readonly id: string; readonly kind: string; readonly payload: unknown }>
    >([]);
    const memberTurns = yield* Queue.unbounded<{
      readonly threadId: ThreadId;
      readonly text: string;
    }>();
    const activitySignal = yield* Queue.unbounded<void>();
    const workerTurns = yield* Ref.make<ReadonlyArray<ProjectionTurn>>([]);
    let turnCounter = 0;

    const dependencies = Layer.mergeAll(
      Layer.succeed(CrewRuntimeState, countingStore),
      Layer.mock(ProjectionTurnRepository)({
        listByThreadId: ({ threadId }) =>
          Ref.get(workerTurns).pipe(
            Effect.map((rows) => rows.filter((row) => row.threadId === threadId)),
          ),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providerList) }),
      ProjectMemorySendGate.layerUnavailable,
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          crew: { ...DEFAULT_SERVER_SETTINGS.crew, enabled: true },
        }),
      }),
      Layer.mock(CheckpointDiffQuery)({}),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.sync(() => shellReads.push(threadId)).pipe(
            Effect.andThen(Ref.get(shells)),
            Effect.map((all) =>
              threadId === LEAD ? Option.some(lead) : Option.fromNullishOr(all.get(threadId)),
            ),
          ),
        getThreadDetailById: (threadId) =>
          Effect.gen(function* () {
            if (threadId === LEAD) return Option.some(leadDetail);
            const shell = (yield* Ref.get(shells)).get(threadId);
            if (shell === undefined) return Option.none();
            const reply = (yield* Ref.get(replies)).get(threadId);
            // The brief this thread was started with, which a user's retry reads back.
            const brief = (yield* Ref.get(commands)).flatMap((command) =>
              command.type === "thread.turn.start" && command.threadId === threadId
                ? [
                    {
                      id: command.message.messageId,
                      role: "user" as const,
                      text: command.message.text,
                    },
                  ]
                : [],
            );
            return Option.some({
              ...leadDetail,
              ...shell,
              messages: [
                ...brief,
                ...(reply === undefined
                  ? []
                  : [
                      {
                        id: MessageId.make(`reply-${threadId}`),
                        role: "assistant" as const,
                        text: reply,
                        turnId: shell.latestTurn?.turnId ?? null,
                        streaming: false,
                        createdAt: NOW,
                        updatedAt: NOW,
                      },
                    ]),
              ],
              // The usage a finished turn records, so the board's evidence is read at once.
              activities: [usageObservation],
            } as unknown as OrchestrationThread);
          }),
      }),
      Layer.mock(OrchestrationEngineService)({
        subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(commands, (previous) => [...previous, command]);
            if (command.type === "thread.create") {
              yield* Ref.update(shells, (all) =>
                new Map(all).set(command.threadId, {
                  ...lead,
                  id: command.threadId,
                  title: command.title,
                  worktreePath: command.worktreePath,
                  latestTurn: null,
                  session: null,
                }),
              );
            } else if (command.type === "thread.turn.start" && command.threadId !== LEAD) {
              turnCounter += 1;
              yield* Ref.update(shells, (all) => {
                const shell = all.get(command.threadId);
                return shell === undefined
                  ? all
                  : new Map(all).set(command.threadId, {
                      ...shell,
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
              });
              yield* Queue.offer(memberTurns, {
                threadId: command.threadId,
                text: command.message.text,
              });
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

    /** Ends the member's current turn the way the provider would, and wakes whoever waits on it. */
    const finishTurn = (
      threadId: ThreadId,
      reply: string,
      outcome: "completed" | "error" = "completed",
    ) =>
      Effect.gen(function* () {
        yield* Ref.update(replies, (all) => new Map(all).set(threadId, reply));
        yield* Ref.update(shells, (all) => {
          const shell = all.get(threadId);
          if (shell === undefined || shell.latestTurn === null) return all;
          return new Map(all).set(threadId, {
            ...shell,
            latestTurn: { ...shell.latestTurn, state: outcome, completedAt: NOW },
            session: {
              status: outcome === "error" ? "error" : "ready",
              lastError: outcome === "error" ? "provider fell over" : null,
            } as never,
          });
        });
        yield* PubSub.publish(events, {
          aggregateId: threadId,
          type: "thread.session-set",
          payload: { threadId, session: { status: "ready" } },
        } as never);
      });

    /** Waits for the next turn a crew member starts, as the provider would receive it. */
    const nextMemberTurn = Queue.take(memberTurns);

    const logged = Ref.get(activities);
    const awaitActivity = (kind: string, taskId: string) =>
      Effect.gen(function* () {
        while (true) {
          const all = yield* Ref.get(activities);
          const hit = all.find(
            (entry) =>
              entry.kind === kind && (entry.payload as { taskId?: string }).taskId === taskId,
          );
          if (hit !== undefined) return hit.payload as Record<string, unknown>;
          yield* Queue.take(activitySignal);
        }
      });
    const progressRows = (taskId: string) =>
      Ref.get(activities).pipe(
        Effect.map((all) => all.filter((entry) => entry.id === `task-progress:crew:${taskId}`)),
      );
    const savedTask = (taskId: string) =>
      store.readTasks.pipe(
        Effect.flatMap((rows) => {
          const row = rows.find((candidate) => candidate.task_id === taskId);
          return row === undefined ? Effect.die("missing task") : decodeTask(row.record_json);
        }),
      );

    return {
      repo,
      pendingReads,
      shellReads,
      lead,
      write,
      run,
      store,
      start,
      finishTurn,
      nextMemberTurn,
      awaitActivity,
      progressRows,
      savedTask,
      logged,
      commands,
      workerTurns,
      shells,
      replies,
      publish: (event: object) => PubSub.publish(events, event as never),
    };
  });

const makeWorld = makeWorldIn("full-access");

const DONE = "All done.\nStatus: done";

/** Starts the service, hands over a task, and returns the member's first turn. */
const delegateTask = (
  world: Effect.Success<typeof makeWorld>,
  input: Partial<Parameters<CrewService.CrewService["Service"]["delegate"]>[0]> = {},
) =>
  Effect.gen(function* () {
    const service = yield* world.start;
    const delegated = yield* service.crew.delegate({
      threadId: LEAD,
      role: "worker",
      task: "Do it",
      title: TASK_TITLE,
      ...input,
    });
    const turn = yield* world.nextMemberTurn;
    return { service, delegated, turn, crew: service.crew };
  });

const check = (
  crew: CrewService.CrewService["Service"],
  threadId: ThreadId,
  todoId: string,
  status: "done" | "blocked" = "done",
  note?: string,
) => crew.checkTodo({ threadId, todoId, status, note });

const statuses = (payload: Record<string, unknown>) =>
  (payload.todos as ReadonlyArray<{ id: string; status: string }>).map(
    (todo) => `${todo.id}:${todo.status}`,
  );

describe("crew todos: delegation", () => {
  it.effect("returns the ids the server assigned and puts the list at the end of the prompt", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn } = yield* delegateTask(world, {
        verify: "vp test run a",
        todos: ["write it", { text: "test it", check: { command: "true" } }],
      });
      assert.deepStrictEqual(delegated.todos, [
        { id: "t1", text: "write it" },
        { id: "t2", text: "test it" },
      ]);
      assert.include(turn.text, "- t1: write it\n- t2: test it (OOP checks this itself:");
      assert.isTrue(
        turn.text.startsWith(
          delegatePrompt({
            role: "worker",
            leadTitle: "Lead",
            task: "Do it",
            verify: "vp test run a",
          }),
        ),
      );
      // The board gets the whole list at 0 verified as soon as the task starts.
      const first = (yield* world.progressRows(delegated.taskId))[0]!;
      assert.strictEqual(
        (first.payload as { todoTotal: number; todoVerified: number }).todoTotal,
        2,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("behaves exactly as before without a list", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world);
      assert.strictEqual(
        turn.text,
        delegatePrompt({ role: "worker", leadTitle: "Lead", task: "Do it" }),
      );
      assert.notProperty(delegated, "todos");
      const rejected = yield* check(crew, turn.threadId, "t1", "done", "x").pipe(Effect.flip);
      assert.include(rejected.reason, "no TODO list");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.strictEqual(completed.status, "completed");
      assert.notProperty(completed, "todos");
      assert.notProperty(completed, "todoTotal");
      assert.deepStrictEqual(yield* world.progressRows(delegated.taskId), []);
      assert.isUndefined((yield* world.savedTask(delegated.taskId)).todos);
      assert.strictEqual(
        (yield* Ref.get(world.commands)).filter(
          (command) => command.type === "thread.turn.start" && command.threadId === turn.threadId,
        ).length,
        1,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: who may check", () => {
  it.effect("accepts only the task's current crew thread", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      const lead = yield* check(crew, LEAD, "t1", "done", "x").pipe(Effect.flip);
      assert.include(lead.reason, "Only crew members");
      const stranger = yield* check(crew, ThreadId.make("nobody"), "t1", "done", "x").pipe(
        Effect.flip,
      );
      assert.include(stranger.reason, "Only crew members");
      const unknown = yield* check(crew, turn.threadId, "t9", "done", "x").pipe(Effect.flip);
      assert.include(unknown.reason, "Valid ids: t1");
      const ok = yield* check(crew, turn.threadId, "t1", "done", "wrote it");
      assert.strictEqual(ok.status, "claimed");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: marking items", () => {
  it.effect(
    "claims an item without a check only with a note, never verifies it, and is idempotent",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { service, delegated, turn, crew } = yield* delegateTask(world, {
          todos: ["a", "b", "c"],
        });
        const noNote = yield* check(crew, turn.threadId, "t1").pipe(Effect.flip);
        assert.include(noNote.reason, "note");
        const first = yield* check(crew, turn.threadId, "t1", "done", "wrote it");
        assert.deepStrictEqual(
          [first.status, first.alreadyChecked, first.remaining],
          ["claimed", false, ["t2", "t3"]],
        );
        const again = yield* check(crew, turn.threadId, "t1", "done", "wrote it again");
        assert.deepStrictEqual([again.status, again.alreadyChecked], ["claimed", true]);
        yield* check(crew, turn.threadId, "t2", "blocked", "needs credentials");
        const blockedNoNote = yield* check(crew, turn.threadId, "t3", "blocked").pipe(Effect.flip);
        assert.include(blockedNoNote.reason, "blocks");

        const rows = yield* world.progressRows(delegated.taskId);
        // Every update replaced the same board row; the last one has the counts.
        assert.isAbove(rows.length, 1);
        const latest = rows.at(-1)!.payload as Record<string, unknown>;
        assert.deepStrictEqual(statuses(latest), ["t1:claimed", "t2:blocked", "t3:pending"]);
        assert.deepStrictEqual(
          [
            latest.todoTotal,
            latest.todoVerified,
            latest.todoClaimed,
            latest.todoFailed,
            latest.todoBlocked,
          ],
          [3, 0, 1, 0, 1],
        );
        assert.strictEqual(latest.status, "running");
        assert.strictEqual(latest.title, TASK_TITLE);
        assert.strictEqual(latest.crewRole, "worker");
        assert.strictEqual(latest.threadId, turn.threadId);
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew lead provider", () => {
  const cursorWorld = makeWorldIn(
    "full-access",
    { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
    [...PROVIDERS, provider("cursor", "cursor", ["composer-2"])],
  );
  const leadDiff = {
    type: "thread.turn-diff-completed",
    aggregateId: LEAD,
    payload: {
      threadId: LEAD,
      turnId: TurnId.make("lead-turn"),
      checkpointTurnCount: 0,
      checkpointRef: "ref",
      status: "ready",
      // Big enough that the audit does not ask for the diff.
      files: [{ path: "a.ts", kind: "modified", additions: 1_000_000, deletions: 0 }],
      assistantMessageId: null,
      completedAt: NOW,
    },
  };
  const creates = (world: Effect.Success<typeof makeWorld>) =>
    Ref.get(world.commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === "thread.create").length),
    );
  // The audit starts through real git work, so give the event handler real time.
  const settle = Effect.promise(() => NodeTimersPromises.setTimeout(500));

  it.effect("refuses crew_delegate for a lead that is not Claude or Codex", () =>
    Effect.gen(function* () {
      const world = yield* cursorWorld;
      const service = yield* world.start;
      const error = yield* service.crew
        .delegate({ threadId: LEAD, role: "worker", task: "Do it", title: TASK_TITLE })
        .pipe(Effect.flip);
      assert.include(error.reason, "Claude or Codex");
      assert.strictEqual(yield* creates(world), 0);
      const roster = yield* service.crew.roster(LEAD);
      assert.isFalse(roster.enabled);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not audit a turn of a lead that is not Claude or Codex", () =>
    Effect.gen(function* () {
      const world = yield* cursorWorld;
      const service = yield* world.start;
      yield* world.publish(leadDiff);
      yield* settle;
      assert.strictEqual(yield* creates(world), 0);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("audits the same turn when the lead is Claude", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const service = yield* world.start;
      yield* world.publish(leadDiff);
      yield* settle;
      assert.isAbove(yield* creates(world), 0);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew member events", () => {
  it.effect("does not re-read the member's thread for events that cannot change its status", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, turn, crew, delegated } = yield* delegateTask(world);
      const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);
      yield* settle;
      const reads = () => world.shellReads.filter((id) => id === turn.threadId).length;
      const before = reads();
      for (const type of ["thread.message-sent", "thread.activity-appended"]) {
        yield* world.publish({
          aggregateId: turn.threadId,
          type,
          payload: { activity: { kind: "tool.updated", summary: "x", payload: {} } },
        });
      }
      yield* settle;
      assert.strictEqual(reads(), before);
      // A status change still ends the wait.
      yield* world.finishTurn(turn.threadId, DONE);
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report?.status, "completed");
      assert.isAbove(reads(), before);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew follow-up flushing", () => {
  const sessionSet = (threadId: ThreadId) => ({
    aggregateId: threadId,
    type: "thread.session-set",
    payload: { threadId, session: { status: "ready" } },
  });
  const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);

  it.effect("only looks at deliveries when a thread that leads a crew goes idle", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service } = yield* delegateTask(world);
      const before = world.pendingReads.length;
      yield* world.publish(sessionSet(ThreadId.make("some-other-thread")));
      yield* settle;
      assert.strictEqual(world.pendingReads.length, before);
      yield* world.publish(sessionSet(LEAD));
      yield* settle;
      assert.deepStrictEqual(world.pendingReads.slice(before), [LEAD]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: command checks", () => {
  it.effect("verifies a passing command and fails a failing one with the output to fix", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          {
            text: "fix it",
            check: { command: "test -f fixed.flag || { echo 'fixed.flag is missing'; exit 2; }" },
          },
        ],
      });
      const failed = yield* check(crew, turn.threadId, "t1", "done", "I fixed it");
      assert.strictEqual(failed.status, "failed");
      assert.include(failed.output ?? "", "fixed.flag is missing");
      assert.include(failed.message ?? "", "exited with code 2");
      assert.deepStrictEqual(failed.remaining, ["t1"]);

      yield* world.write(world.repo, "fixed.flag", "ok\n");
      const passed = yield* check(crew, turn.threadId, "t1", "done");
      assert.deepStrictEqual(
        [passed.status, passed.alreadyChecked, passed.remaining],
        ["verified", false, []],
      );
      // A verified item is settled: no rerun, even if the command would fail now.
      const again = yield* check(crew, turn.threadId, "t1", "done");
      assert.deepStrictEqual([again.status, again.alreadyChecked], ["verified", true]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect.each(["approval-required", "auto-accept-edits"] as const)(
    "does not run a command check for a %s lead, so the item stays claimed",
    (runtimeMode) =>
      Effect.gen(function* () {
        const world = yield* makeWorldIn(runtimeMode);
        const { service, turn, crew } = yield* delegateTask(world, {
          todos: [{ text: "run", check: { command: "touch ran.flag" } }],
        });
        const result = yield* check(crew, turn.threadId, "t1", "done");
        assert.strictEqual(result.status, "claimed");
        assert.include(result.message ?? "", "sandbox");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.isFalse(yield* fs.exists(path.join(world.repo, "ran.flag")));
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs a command check for a full-access lead", () =>
    Effect.gen(function* () {
      const world = yield* makeWorldIn("full-access");
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [{ text: "run", check: { command: "touch ran.flag" } }],
      });
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isTrue(yield* fs.exists(path.join(world.repo, "ran.flag")));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stops a command at the timeout and fails the item with that reason", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [{ text: "slow", check: { command: "exec sleep 30" } }],
      });
      const running = yield* check(crew, turn.threadId, "t1", "done").pipe(Effect.forkChild);
      yield* TestClock.adjust("121 seconds");
      const result = yield* Fiber.join(running);
      assert.strictEqual(result.status, "failed");
      assert.include(result.message ?? "", "120 seconds");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs in the server's own environment, in the task's workspace", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          {
            text: "env",
            check: { command: 'test "$T3_CREW_TODO_SERVICE_ENV" = server && test -f other.txt' },
          },
        ],
      });
      process.env.T3_CREW_TODO_SERVICE_ENV = "server";
      try {
        assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      } finally {
        delete process.env.T3_CREW_TODO_SERVICE_ENV;
      }
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs one check at a time per task", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // Each check appends to the log, then waits for the other's marker only if it ran alone.
      const command = (id: string) =>
        `echo start-${id} >> order.log; sleep 0.2; echo end-${id} >> order.log`;
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "one", check: { command: command("1") } },
          { text: "two", check: { command: command("2") } },
        ],
      });
      const both = yield* Effect.all(
        [check(crew, turn.threadId, "t1", "done"), check(crew, turn.threadId, "t2", "done")],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        both.map((result) => result.status),
        ["verified", "verified"],
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lines = (yield* fs.readFileString(path.join(world.repo, "order.log")))
        .trim()
        .split("\n");
      // Serial runs never interleave: each start is followed by its own end.
      assert.strictEqual(lines[0]!.replace("start", "end"), lines[1]);
      assert.strictEqual(lines[2]!.replace("start", "end"), lines[3]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: files checks", () => {
  it.effect("verifies changed listed files outside git and fails unchanged files", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(world.repo + "/.git", { recursive: true });
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "edit a", check: { files: ["src/a.ts"] } },
          { text: "add b", check: { files: ["src/b.ts"] } },
        ],
      });
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "failed");
      assert.strictEqual((yield* check(crew, turn.threadId, "t2", "done")).status, "failed");
      yield* world.write(world.repo, "src/a.ts", "changed");
      yield* world.write(world.repo, "src/b.ts", "created");
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      assert.strictEqual((yield* check(crew, turn.threadId, "t2", "done")).status, "verified");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("names a never-existing check path as missing, not unchanged, outside git", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(world.repo + "/.git", { recursive: true });
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "edit a", check: { files: ["wrong/root/src/a.ts"] } },
          { text: "edit a", check: { files: ["src/a.ts"] } },
        ],
      });
      const wrongPath = yield* check(crew, turn.threadId, "t1", "done");
      assert.strictEqual(wrongPath.status, "failed");
      assert.include(wrongPath.message ?? "", "do not exist");
      assert.include(wrongPath.message ?? "", world.repo);
      const untouched = yield* check(crew, turn.threadId, "t2", "done");
      assert.strictEqual(untouched.status, "failed");
      assert.include(untouched.message ?? "", "have not changed");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("verifies a file the member changed and fails one it did not touch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // The workspace was already dirty when the task started; that does not count as the member's work.
      yield* world.write(world.repo, "src/a.ts", "export const a = 2;\n");
      const { service, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "edit a", check: { files: ["src/a.ts"] } },
          { text: "add b", check: { files: ["src/b.ts"] } },
        ],
      });
      const untouched = yield* check(crew, turn.threadId, "t1", "done");
      assert.strictEqual(untouched.status, "failed");
      assert.include(untouched.message ?? "", "src/a.ts");
      yield* world.write(world.repo, "src/a.ts", "export const a = 3;\n");
      yield* world.write(world.repo, "src/b.ts", "export const b = 1;\n");
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      assert.strictEqual((yield* check(crew, turn.threadId, "t2", "done")).status, "verified");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: write scope", () => {
  it.effect(
    "in a shared workspace, reports out-of-scope files as possibly someone else's and refuses a files check they satisfy",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { service, delegated, turn, crew } = yield* delegateTask(world, {
          writeScope: ["src/"],
          todos: [
            { text: "edit a", check: { files: ["src/a.ts"] } },
            { text: "config", check: { files: ["other.txt"] } },
            { text: "cmd", check: { command: "true" } },
          ],
        });
        yield* world.write(world.repo, "src/a.ts", "export const a = 9;\n");
        yield* world.write(world.repo, "other.txt", "changed outside the scope\n");
        assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
        const outside = yield* check(crew, turn.threadId, "t2", "done");
        assert.strictEqual(outside.status, "claimed");
        assert.include(outside.message ?? "", "outside the write scope");
        // Others may have written there, so a command result stays trusted in a shared workspace.
        assert.strictEqual((yield* check(crew, turn.threadId, "t3", "done")).status, "verified");

        const latest = (yield* world.progressRows(delegated.taskId)).at(-1)!.payload as {
          outOfScope: { files: string[]; more: number; shared: boolean };
        };
        assert.deepStrictEqual(latest.outOfScope, { files: ["other.txt"], more: 0, shared: true });
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "in the task's own worktree, a command result is not trusted once the member changed files outside the scope",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { service, delegated, turn, crew } = yield* delegateTask(world, {
          isolation: "worktree",
          writeScope: ["src/"],
          todos: [{ text: "cmd", check: { command: "true" } }],
        });
        const shell = (yield* Ref.get(world.shells)).get(turn.threadId)!;
        yield* world.write(shell.worktreePath!, "src/a.ts", "export const a = 4;\n");
        yield* world.write(shell.worktreePath!, "other.txt", "edited to make the check pass\n");
        const result = yield* check(crew, turn.threadId, "t1", "done");
        assert.strictEqual(result.status, "claimed");
        assert.include(result.message ?? "", "outside its write scope");
        const latest = (yield* world.progressRows(delegated.taskId)).at(-1)!.payload as {
          outOfScope: { files: string[]; more: number; shared: boolean };
        };
        assert.deepStrictEqual(latest.outOfScope, { files: ["other.txt"], more: 0, shared: false });

        yield* world.finishTurn(turn.threadId, DONE);
        const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
        assert.deepStrictEqual(completed.outOfScope, latest.outOfScope);
        const report = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
        assert.include(report[0]!.result ?? "", "outside its write scope");
        assert.include(report[0]!.result ?? "", "- other.txt");
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: how a task ends", () => {
  it.effect("reruns command checks at the end and fails an item a later edit broke", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "stays good", check: { command: "true" } },
          { text: "regresses", check: { command: "test ! -f broken.flag" } },
        ],
      });
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      assert.strictEqual((yield* check(crew, turn.threadId, "t2", "done")).status, "verified");
      yield* world.write(world.repo, "broken.flag", "later edit\n");
      yield* world.finishTurn(turn.threadId, DONE);

      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:verified", "t2:failed"]);
      assert.deepStrictEqual(
        [completed.todoTotal, completed.todoVerified, completed.todoFailed],
        [2, 1, 1],
      );
      // The member said done, but a failing item makes the task partial.
      assert.strictEqual(completed.status, "partial");
      const report = yield* service.crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report[0]!.status, "partial");
      assert.include(report[0]!.result ?? "", "- t2 (failed)");
      assert.include(report[0]!.result ?? "", "Failed when the task ended");
      // The list is closed once the sweep ran.
      const late = yield* check(crew, turn.threadId, "t2", "done").pipe(Effect.flip);
      assert.include(late.reason, "ended");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("finishes completed only when nothing is pending, failing, or blocked", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: ["claimed only", { text: "proved", check: { command: "true" } }],
      });
      yield* check(crew, turn.threadId, "t1", "done", "did it");
      yield* check(crew, turn.threadId, "t2", "done");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      // Claimed items never count as verified, but they do not hold the task back.
      assert.deepStrictEqual(
        [completed.status, completed.todoVerified, completed.todoClaimed],
        ["completed", 1, 1],
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says INCONCLUSIVE when the member only claimed its items", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: ["a", "b"],
      });
      yield* check(crew, turn.threadId, "t1", "done", "did a");
      yield* check(crew, turn.threadId, "t2", "done", "did b");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.strictEqual(completed.status, "completed");
      assert.strictEqual(completed.proof, "inconclusive");
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.deepStrictEqual(report!.proof, {
        verdict: "inconclusive",
        reason: "2 items claimed without proof",
      });
      assert.include(report!.result ?? "", "PROOF: INCONCLUSIVE - 2 items claimed without proof");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says VERIFIED when the server verified every item", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: [{ text: "a", check: { command: "true" } }],
      });
      yield* check(crew, turn.threadId, "t1", "done");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.strictEqual(completed.proof, "verified");
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report!.proof?.verdict, "verified");
      assert.include(report!.result ?? "", "PROOF: VERIFIED");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says NOT VERIFIED for a task that ended partial", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a", "b"] });
      yield* check(crew, turn.threadId, "t1", "done", "did it");
      yield* check(crew, turn.threadId, "t2", "blocked", "no access");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual([completed.status, completed.proof], ["partial", "not-verified"]);
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.include(report!.result ?? "", "PROOF: NOT VERIFIED");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a check that timed out in the final sweep claimed, not failed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: [
          { text: "slow later", check: { command: "if [ -f hang.flag ]; then exec sleep 30; fi" } },
        ],
      });
      assert.strictEqual((yield* check(crew, turn.threadId, "t1", "done")).status, "verified");
      yield* world.write(world.repo, "hang.flag", "now it hangs\n");
      yield* world.finishTurn(turn.threadId, DONE);
      const ended = yield* world
        .awaitActivity("task.completed", delegated.taskId)
        .pipe(Effect.forkChild);
      while (ended.pollUnsafe() === undefined) {
        yield* TestClock.adjust("121 seconds");
        yield* Effect.yieldNow;
      }
      const completed = (yield* Fiber.join(ended)) as Record<string, unknown>;
      assert.deepStrictEqual(statuses(completed), ["t1:claimed"]);
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.include(report!.result ?? "", "INCONCLUSIVE: the command did not finish");
      assert.notInclude(report!.result ?? "", "Failed when the task ended");
      assert.strictEqual(report!.proof?.verdict, "inconclusive");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps a check that timed out while the member worked failed, but says INCONCLUSIVE",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { service, turn, crew } = yield* delegateTask(world, {
          todos: [{ text: "slow", check: { command: "exec sleep 30" } }],
        });
        const running = yield* check(crew, turn.threadId, "t1", "done").pipe(Effect.forkChild);
        yield* TestClock.adjust("121 seconds");
        const result = yield* Fiber.join(running);
        assert.strictEqual(result.status, "failed");
        assert.include(
          result.message ?? "",
          "INCONCLUSIVE: the command did not finish within 120 seconds",
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a task with a blocked item from completing", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a", "b"] });
      yield* check(crew, turn.threadId, "t1", "done", "did it");
      yield* check(crew, turn.threadId, "t2", "blocked", "no access");
      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual([completed.status, completed.todoBlocked], ["partial", 1]);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("sends one follow-up turn for pending items, once per task", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: ["a", "b", "c"],
      });
      yield* check(crew, turn.threadId, "t1", "done", "did it");
      yield* world.finishTurn(turn.threadId, DONE);

      const nudge = yield* world.nextMemberTurn;
      assert.strictEqual(nudge.threadId, turn.threadId);
      assert.include(nudge.text, "- t2: b");
      assert.include(nudge.text, "- t3: c");
      assert.notInclude(nudge.text, "- t1:");
      // The member handles one of them, then stops again with one still pending: no second nudge.
      yield* check(crew, turn.threadId, "t2", "done", "did it too");
      yield* world.finishTurn(turn.threadId, DONE);

      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:claimed", "t2:claimed", "t3:pending"]);
      assert.strictEqual(completed.status, "partial");
      const starts = (yield* Ref.get(world.commands)).filter(
        (command) => command.type === "thread.turn.start" && command.threadId === turn.threadId,
      );
      assert.strictEqual(starts.length, 2);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not nudge a member that marked everything, or one whose turn failed", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      yield* check(crew, turn.threadId, "t1", "done", "did it");
      yield* world.finishTurn(turn.threadId, DONE);
      yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.strictEqual(
        (yield* Ref.get(world.commands)).filter(
          (command) => command.type === "thread.turn.start" && command.threadId === turn.threadId,
        ).length,
        1,
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: fallback", () => {
  it.effect("keeps the list across attempts and tells the next model what is finished", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const {
        service,
        delegated,
        turn: first,
        crew,
      } = yield* delegateTask(world, {
        todos: ["a", "b", { text: "c", check: { command: "true" } }],
      });
      yield* check(crew, first.threadId, "t1", "done", "did it");
      yield* check(crew, first.threadId, "t3", "done");
      yield* world.finishTurn(first.threadId, "", "error");

      const second = yield* world.nextMemberTurn;
      assert.notStrictEqual(second.threadId, first.threadId);
      assert.include(second.text, "TODO PROGRESS");
      assert.include(second.text, "Finished, do not redo: t1 (done, unverified), t3 (verified).");
      const afterProgress = second.text.slice(second.text.indexOf("TODO PROGRESS"));
      assert.include(afterProgress, "- t2: b");
      assert.notInclude(afterProgress, "- t1:");
      assert.notInclude(afterProgress, "- t3:");
      // The first attempt's thread no longer owns the list; the new one does.
      const stale = yield* check(crew, first.threadId, "t2", "done", "late").pipe(Effect.flip);
      assert.include(stale.reason, "took this task over");
      yield* check(crew, second.threadId, "t2", "done", "did b");
      yield* world.finishTurn(second.threadId, DONE);

      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:claimed", "t2:claimed", "t3:verified"]);
      assert.strictEqual(completed.status, "completed");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the existing fallback progress row distinct from the checklist row", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn: first } = yield* delegateTask(world, { todos: ["a"] });
      yield* world.finishTurn(first.threadId, "", "error");
      yield* world.nextMemberTurn;
      const switched = (yield* world.logged).filter(
        (entry) => entry.kind === "task.progress" && !entry.id.startsWith("task-progress:crew:"),
      );
      assert.strictEqual(switched.length, 1);
      assert.notStrictEqual(switched[0]!.id, `task-progress:crew:${delegated.taskId}`);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: persistence and recovery", () => {
  it.effect("persists every change under the task id and restores it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        writeScope: ["src/"],
        todos: ["a", { text: "b", check: { command: "true", files: ["src/a.ts"] } }, "c"],
      });
      yield* check(crew, turn.threadId, "t1", "done", "did a");
      yield* check(crew, turn.threadId, "t3", "blocked", "no access");
      const saved = yield* world.savedTask(delegated.taskId);
      assert.deepStrictEqual(
        saved.todos?.map((todo) => [todo.id, todo.status, todo.note]),
        [
          ["t1", "claimed", "did a"],
          ["t2", "pending", undefined],
          ["t3", "blocked", "no access"],
        ],
      );
      assert.isString(saved.todoBase?.tree);
      yield* service.close;

      // After a restart the member's thread is gone; the new service still has the list and
      // reports the task from it.
      const restarted = yield* world.start;
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:claimed", "t2:pending", "t3:blocked"]);
      assert.deepStrictEqual(
        [completed.todoTotal, completed.todoClaimed, completed.todoBlocked],
        [3, 1, 1],
      );
      yield* restarted.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "after a restart, finishes a task whose member completed: re-checks, counts, and a partial outcome",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const workerId = ThreadId.make("worker-after-restart");
        const record: typeof CrewTaskRecoveryState.Type = {
          version: 1,
          taskId: "task-r",
          leadThreadId: LEAD,
          leadTurnId: TurnId.make("lead-turn"),
          role: "worker",
          subject: "recovered",
          todos: [
            {
              id: "t1",
              text: "was verified",
              check: { command: "test ! -f broken.flag" },
              status: "verified",
            },
            { id: "t2", text: "never marked", status: "pending" },
          ],
          todoBase: { cwd: world.repo, tree: null },
          attempts: [
            { model: "m", threadId: workerId, messageId: MessageId.make("worker-request") },
          ],
          report: null,
          collected: false,
          ended: false,
          auditState: "none",
        };
        yield* world.store.saveTask({
          task_id: record.taskId,
          lead_thread_id: LEAD,
          record_json: yield* encodeTask(record),
          updated_at: NOW,
        });
        yield* world.write(world.repo, "broken.flag", "regressed while the server was down\n");
        yield* Ref.update(world.shells, (all) =>
          new Map(all).set(workerId, { ...world.lead, id: workerId, latestTurn: null }),
        );
        yield* Ref.set(world.workerTurns, [
          {
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
          },
        ]);

        const service = yield* world.start;
        const completed = yield* world.awaitActivity("task.completed", "task-r");
        assert.deepStrictEqual(statuses(completed), ["t1:failed", "t2:pending"]);
        assert.strictEqual(completed.status, "partial");
        const report = yield* service.crew.wait({ threadId: LEAD, taskIds: ["task-r"] });
        assert.strictEqual(report[0]!.status, "partial");
        const saved = yield* world.savedTask("task-r");
        assert.deepStrictEqual(
          saved.todos?.map((todo) => todo.status),
          ["failed", "pending"],
        );
        yield* service.close;
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a check that was lost with the server leaves the item as it was, not stuck", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        todos: [{ text: "slow", check: { command: "exec sleep 30" } }],
      });
      // The server goes away while the check runs: the call is interrupted, nothing was recorded.
      const running = yield* check(crew, turn.threadId, "t1", "done").pipe(Effect.forkChild);
      yield* Fiber.interrupt(running);
      const saved = yield* world.savedTask(delegated.taskId);
      assert.deepStrictEqual(
        saved.todos?.map((todo) => todo.status),
        ["pending"],
      );
      // The item can be checked again afterwards.
      const retry = yield* check(crew, turn.threadId, "t1", "done").pipe(Effect.forkChild);
      yield* TestClock.adjust("121 seconds");
      assert.strictEqual((yield* Fiber.join(retry)).status, "failed");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

const startsOf = (world: Effect.Success<typeof makeWorld>, threadId: ThreadId) =>
  Ref.get(world.commands).pipe(
    Effect.map(
      (all) =>
        all.filter(
          (command) => command.type === "thread.turn.start" && command.threadId === threadId,
        ).length,
    ),
  );

describe("crew todos: items added by the lead", () => {
  it.effect("queues items during a running turn and delivers them when it ends", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      const added = yield* crew.addTodos({
        threadId: LEAD,
        taskId: delegated.taskId,
        todos: ["b", { text: "c", check: { command: "true" } }],
      });
      assert.deepStrictEqual(
        added.todos.map((todo) => todo.id),
        ["t2", "t3"],
      );
      assert.strictEqual(added.total, 3);
      // The running turn was left alone, and the board already shows the new total.
      assert.strictEqual(yield* startsOf(world, turn.threadId), 1);
      const latest = (yield* world.progressRows(delegated.taskId)).at(-1)!.payload as Record<
        string,
        unknown
      >;
      assert.deepStrictEqual(statuses(latest), ["t1:pending", "t2:pending", "t3:pending"]);
      assert.deepStrictEqual((yield* world.savedTask(delegated.taskId)).queued, ["t2", "t3"]);

      yield* check(crew, turn.threadId, "t1", "done", "did a");
      yield* world.finishTurn(turn.threadId, DONE);
      const delivery = yield* world.nextMemberTurn;
      assert.strictEqual(delivery.threadId, turn.threadId);
      assert.include(delivery.text, "The lead added");
      assert.include(delivery.text, "- t2: b");
      assert.include(delivery.text, "- t3: c");
      assert.notInclude(delivery.text, "- t1:");
      assert.deepStrictEqual((yield* world.savedTask(delegated.taskId)).queued, []);
      yield* check(crew, turn.threadId, "t2", "done", "did b");
      yield* check(crew, turn.threadId, "t3");
      yield* world.finishTurn(turn.threadId, DONE);

      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:claimed", "t2:claimed", "t3:verified"]);
      assert.strictEqual(completed.status, "completed");
      assert.strictEqual(yield* startsOf(world, turn.threadId), 2);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does not use up the one nudge, and nudges the added items on their own", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      yield* crew.addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["b"] });
      yield* world.finishTurn(turn.threadId, DONE);

      // The nudge names only what the member was told about.
      const nudge = yield* world.nextMemberTurn;
      assert.include(nudge.text, "never marked");
      assert.include(nudge.text, "- t1: a");
      assert.notInclude(nudge.text, "- t2:");
      yield* check(crew, turn.threadId, "t1", "done", "did a");
      yield* world.finishTurn(turn.threadId, DONE);

      const delivery = yield* world.nextMemberTurn;
      assert.include(delivery.text, "- t2: b");
      yield* world.finishTurn(turn.threadId, DONE);

      const second = yield* world.nextMemberTurn;
      assert.include(second.text, "never marked");
      assert.include(second.text, "- t2: b");
      yield* world.finishTurn(turn.threadId, DONE);

      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:claimed", "t2:pending"]);
      assert.strictEqual(completed.status, "partial");
      assert.strictEqual(yield* startsOf(world, turn.threadId), 4);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a finished task and says to delegate a new one", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      yield* check(crew, turn.threadId, "t1", "done", "did a");
      yield* world.finishTurn(turn.threadId, DONE);
      yield* world.awaitActivity("task.completed", delegated.taskId);
      const refused = yield* crew
        .addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["late"] })
        .pipe(Effect.flip);
      assert.include(refused.reason, "Delegate");
      assert.include(refused.reason, "new task");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the list within twelve items and refuses what does not fit whole", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, crew } = yield* delegateTask(world, {
        todos: Array.from({ length: 11 }, (_, i) => `item ${i}`),
      });
      const tooMany = yield* crew
        .addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["x", "y"] })
        .pipe(Effect.flip);
      assert.include(tooMany.reason, "room for 1");
      const fits = yield* crew.addTodos({
        threadId: LEAD,
        taskId: delegated.taskId,
        todos: ["z"],
      });
      assert.deepStrictEqual([fits.todos[0]?.id, fits.total], ["t12", 12]);
      const full = yield* crew
        .addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["w"] })
        .pipe(Effect.flip);
      assert.include(full.reason, "room for 0");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("accepts only the lead of the task", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, { todos: ["a"] });
      const other = ThreadId.make("lead-2");
      yield* Ref.update(world.shells, (all) =>
        new Map(all).set(other, { ...world.lead, id: other }),
      );
      const notYours = yield* crew
        .addTodos({ threadId: other, taskId: delegated.taskId, todos: ["b"] })
        .pipe(Effect.flip);
      assert.include(notYours.reason, "not one of your");
      const member = yield* crew
        .addTodos({ threadId: turn.threadId, taskId: delegated.taskId, todos: ["b"] })
        .pipe(Effect.flip);
      assert.include(member.reason, "cannot hand work on");
      const saved = yield* world.savedTask(delegated.taskId);
      assert.deepStrictEqual(
        saved.todos?.map((todo) => todo.id),
        ["t1"],
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("persists queued items and reports them after a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, crew } = yield* delegateTask(world, { todos: ["a"] });
      yield* crew.addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["b"] });
      const saved = yield* world.savedTask(delegated.taskId);
      assert.deepStrictEqual(
        [saved.todos?.map((todo) => todo.id), saved.queued],
        [["t1", "t2"], ["t2"]],
      );
      yield* service.close;

      const restarted = yield* world.start;
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.deepStrictEqual(statuses(completed), ["t1:pending", "t2:pending"]);
      assert.strictEqual(completed.todoTotal, 2);
      yield* restarted.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("carries queued items to the next model instead of delivering them twice", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const {
        service,
        delegated,
        turn: first,
        crew,
      } = yield* delegateTask(world, {
        todos: ["a"],
      });
      yield* crew.addTodos({ threadId: LEAD, taskId: delegated.taskId, todos: ["b"] });
      yield* world.finishTurn(first.threadId, "", "error");
      const second = yield* world.nextMemberTurn;
      assert.notStrictEqual(second.threadId, first.threadId);
      assert.include(second.text, "- t2: b");
      assert.deepStrictEqual((yield* world.savedTask(delegated.taskId)).queued, []);
      yield* check(crew, second.threadId, "t1", "done", "did a");
      yield* check(crew, second.threadId, "t2", "done", "did b");
      yield* world.finishTurn(second.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.strictEqual(completed.status, "completed");
      assert.strictEqual(yield* startsOf(world, second.threadId), 1);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew todos: retry in a fresh worktree", () => {
  it.effect("restarts every item and sends no resume lines", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        isolation: "worktree",
        todos: ["a", "b"],
      });
      yield* check(crew, turn.threadId, "t1", "done", "did a");
      // A blocked item is not nudged, so the turn ends the task.
      yield* check(crew, turn.threadId, "t2", "blocked", "cannot do b");
      yield* world.finishTurn(turn.threadId, "Stopped early.\nStatus: partial");
      yield* world.awaitActivity("task.completed", delegated.taskId);

      const retried = yield* crew.retryTask({ threadId: LEAD, taskId: delegated.taskId });
      const second = yield* world.nextMemberTurn;

      assert.notInclude(second.text, "TODO PROGRESS");
      assert.deepStrictEqual(
        (yield* world.savedTask(retried.taskId)).todos?.map((todo) => `${todo.id}:${todo.status}`),
        ["t1:pending", "t2:pending"],
      );
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: isolated work of a deleted lead", () => {
  it.effect("is discarded, even when the lead was stopped before it was deleted", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { service, delegated, turn } = yield* delegateTask(world, { isolation: "worktree" });
      const shell = (yield* Ref.get(world.shells)).get(turn.threadId)!;
      yield* world.write(shell.worktreePath!, "kept-out.txt", "from the isolated member\n");

      // The user stops the lead's turn, then deletes the lead; the member still ends whole.
      yield* world.publish({
        type: "thread.turn-interrupt-requested",
        aggregateId: LEAD,
        payload: { threadId: LEAD },
      });
      for (let index = 0; index < 100; index += 1) yield* Effect.yieldNow;
      yield* world.publish({
        type: "thread.deleted",
        aggregateId: LEAD,
        payload: { threadId: LEAD },
      });
      for (let index = 0; index < 100; index += 1) yield* Effect.yieldNow;
      yield* world.finishTurn(turn.threadId, DONE);
      yield* world.awaitActivity("task.completed", delegated.taskId);

      assert.isFalse(yield* fs.exists(path.join(world.repo, "kept-out.txt")));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: candidate isolation", () => {
  const worktreeOf = (world: Effect.Success<typeof makeWorld>, threadId: ThreadId) =>
    Ref.get(world.shells).pipe(Effect.map((all) => all.get(threadId)!.worktreePath!));

  it.effect("keeps the member's work out of the lead's workspace and says so in the report", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        isolation: "candidate",
      });
      const worktree = yield* worktreeOf(world, turn.threadId);
      yield* world.write(worktree, "candidate.txt", "from the candidate\n");
      const statusBefore = (yield* world.run(["status", "--porcelain"])).stdout;

      yield* world.finishTurn(turn.threadId, DONE);
      const completed = yield* world.awaitActivity("task.completed", delegated.taskId);

      // A candidate that finished is a finished task, not a partial one.
      assert.strictEqual(completed.status, "completed");
      assert.isFalse(yield* fs.exists(path.join(world.repo, "candidate.txt")));
      assert.strictEqual((yield* world.run(["status", "--porcelain"])).stdout, statusBefore);
      assert.isTrue(yield* fs.exists(worktree));
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.strictEqual(report!.status, "completed");
      assert.include(report!.result ?? "", "CANDIDATE: changes were NOT applied");
      assert.include(report!.result ?? "", `${worktree}.patch`);
      assert.include(report!.result ?? "", `worktree remove --force ${worktree}`);
      assert.include(yield* fs.readFileString(`${worktree}.patch`), "candidate.txt");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("removes the worktree of a candidate that changed nothing", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      const { service, delegated, turn, crew } = yield* delegateTask(world, {
        isolation: "candidate",
      });
      const worktree = yield* worktreeOf(world, turn.threadId);
      yield* world.finishTurn(turn.threadId, DONE);
      yield* world.awaitActivity("task.completed", delegated.taskId);
      const [report] = yield* crew.wait({ threadId: LEAD, taskIds: [delegated.taskId] });
      assert.notInclude(report!.result ?? "", "CANDIDATE:");
      assert.isFalse(yield* fs.exists(worktree));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("still merges a plain worktree task into the lead's workspace", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { service, delegated, turn } = yield* delegateTask(world, { isolation: "worktree" });
      yield* world.write(yield* worktreeOf(world, turn.threadId), "merged.txt", "applied\n");
      yield* world.finishTurn(turn.threadId, DONE);
      yield* world.awaitActivity("task.completed", delegated.taskId);
      assert.isTrue(yield* fs.exists(path.join(world.repo, "merged.txt")));
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("is not merged after a restart either", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workerId = ThreadId.make("candidate-after-restart");
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-candidate-" });
      const worktreePath = path.join(dir, "wt");
      const base = (yield* world.run(["rev-parse", "HEAD"])).stdout.trim();
      yield* world.run(["worktree", "add", "--detach", worktreePath, base]);
      yield* world.write(worktreePath, "candidate.txt", "written before the restart\n");
      const record: typeof CrewTaskRecoveryState.Type = {
        version: 1,
        taskId: "task-c",
        leadThreadId: LEAD,
        leadTurnId: TurnId.make("lead-turn"),
        role: "worker",
        subject: "candidate",
        candidate: true,
        worktree: { repoRoot: world.repo, path: worktreePath, base, cwd: worktreePath },
        attempts: [{ model: "m", threadId: workerId, messageId: MessageId.make("worker-request") }],
        report: null,
        collected: false,
        ended: false,
        auditState: "none",
      };
      yield* world.store.saveTask({
        task_id: record.taskId,
        lead_thread_id: LEAD,
        record_json: yield* encodeTask(record),
        updated_at: NOW,
      });
      yield* Ref.update(world.shells, (all) =>
        new Map(all).set(workerId, {
          ...world.lead,
          id: workerId,
          latestTurn: {
            turnId: TurnId.make("worker-turn"),
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: MessageId.make(`reply-${workerId}`),
          },
        }),
      );
      yield* Ref.update(world.replies, (all) => new Map(all).set(workerId, DONE));
      yield* Ref.set(world.workerTurns, [
        {
          threadId: workerId,
          turnId: TurnId.make("worker-turn"),
          pendingMessageId: MessageId.make("worker-request"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: MessageId.make(`reply-${workerId}`),
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

      const service = yield* world.start;
      const completed = yield* world.awaitActivity("task.completed", "task-c");
      assert.strictEqual(completed.status, "completed");
      assert.isFalse(yield* fs.exists(path.join(world.repo, "candidate.txt")));
      assert.isTrue(yield* fs.exists(worktreePath));
      const [report] = yield* service.crew.wait({ threadId: LEAD, taskIds: ["task-c"] });
      assert.include(report!.result ?? "", "CANDIDATE: changes were NOT applied");
      assert.strictEqual((yield* world.savedTask("task-c")).candidate, true);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("crew: differentFrom", () => {
  it.effect("starts a task on a model family the earlier tasks did not use", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const service = yield* world.start;
      const first = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Candidate A",
      });
      yield* world.nextMemberTurn;
      const second = yield* service.crew.delegate({
        threadId: LEAD,
        role: "worker",
        task: "Candidate B",
        differentFrom: [first.taskId],
      });
      yield* world.nextMemberTurn;
      assert.include(first.model, "claude");
      assert.include(second.model, "gpt");
      assert.include(second.warning ?? "", "OOP will not be able to verify");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("warns, and picks another model of the family, when every family was used", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const service = yield* world.start;
      const delegate = (differentFrom?: ReadonlyArray<string>) =>
        service.crew.delegate({
          threadId: LEAD,
          role: "worker",
          task: "Candidate",
          ...(differentFrom === undefined ? {} : { differentFrom }),
        });
      const first = yield* delegate();
      yield* world.nextMemberTurn;
      const second = yield* delegate([first.taskId]);
      yield* world.nextMemberTurn;
      const third = yield* delegate([first.taskId, second.taskId]);
      yield* world.nextMemberTurn;

      // Not the very model the second task used, but the same family: the warning says so.
      assert.notStrictEqual(third.model, second.model);
      assert.notStrictEqual(third.model, first.model);
      assert.include(third.warning ?? "", "No model from another family is available");
      assert.include(third.warning ?? "", "shares a family with");
      assert.include(third.warning ?? "", second.taskId);
      assert.notInclude(third.warning ?? "", first.taskId);
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a task id that is not one of the lead's tasks", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const service = yield* world.start;
      const failure = yield* service.crew
        .delegate({ threadId: LEAD, role: "worker", task: "x", differentFrom: ["nope"] })
        .pipe(Effect.flip);
      assert.include(failure.reason, "nope");
      yield* service.close;
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
