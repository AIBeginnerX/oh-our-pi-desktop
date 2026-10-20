// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  type ProjectScript,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type SelectedCheckReceipt,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";

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
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ProjectSkillMutationFence,
  type ProjectSkillMutationToken,
} from "../../skills/ProjectSkillMutationFence.ts";
import {
  layer as restartContinuationsLayer,
  RestartContinuations,
  type ContinuationSettlement,
} from "../../restartContinuations.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SelectedChecks from "../../selectedChecks/SelectedChecks.ts";
import * as ScriptExecutor from "../../selectedChecks/ScriptExecutor.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

type OrchestrationEventStoreLayer = typeof OrchestrationEventStoreLive;

function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  eventStoreLayer: OrchestrationEventStoreLayer = OrchestrationEventStoreLive,
  cryptoLayer?: Layer.Layer<Crypto.Crypto>,
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
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
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfigLayer),
    // A test-supplied Crypto must satisfy the engine before NodeServices
    // fills in the platform default.
    Layer.provideMerge(cryptoLayer ?? Layer.empty),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  eventStoreLayer: OrchestrationEventStoreLayer = OrchestrationEventStoreLive,
) {
  const runtime = ManagedRuntime.make(
    makeOrchestrationLayer(databasePath, repositoryIdentityResolver, eventStoreLayer),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const turnRepository = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readThread: (threadId: ThreadId) =>
      runtime.runPromise(snapshotQuery.getThreadDetailById(threadId)),
    readPendingTurnStart: (threadId: ThreadId) =>
      runtime.runPromise(turnRepository.getPendingTurnStartByThreadId({ threadId })),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it.each(["running", "stopped"] as const)(
    "sends async answers with a %s session and rejects old duplicate replies",
    async (status) => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-async-questions-"),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      let system = await createOrchestrationSystem(databasePath);
      const threadId = ThreadId.make("async-thread");
      const projectId = ProjectId.make("async-project");
      const requestId = ApprovalRequestId.make("codex-async:question-1");
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("async-project"),
            projectId,
            title: "Async questions",
            workspaceRoot: "/tmp/async-questions",
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("async-thread"),
            threadId,
            projectId,
            title: "Async questions",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("async-session"),
            threadId,
            createdAt: now(),
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
              lastError: null,
              updatedAt: now(),
            },
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("async-question"),
            threadId,
            createdAt: now(),
            activity: {
              id: EventId.make("async-question"),
              kind: "user-input.requested",
              summary: "User input requested",
              tone: "info",
              turnId: TurnId.make("turn-1"),
              createdAt: now(),
              payload: {
                requestId,
                responseMode: "message",
                questions: [
                  {
                    id: "0",
                    header: "Question",
                    question: "Which package manager?",
                    options: [{ label: "pnpm", description: "" }],
                  },
                  {
                    id: "1",
                    header: "Question",
                    question: "What should it be named?",
                    options: [],
                  },
                ],
              },
            },
          }),
        );
        const appendWork = async (prefix: string, createdAt: string) => {
          for (let index = 0; index < 501; index += 1) {
            await system.run(
              system.engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`${prefix}-${index}`),
                threadId,
                createdAt,
                activity: {
                  id: EventId.make(`${prefix}-${index}`),
                  kind: "tool.completed",
                  summary: "Work continued",
                  payload: {},
                  tone: "info",
                  turnId: TurnId.make("turn-1"),
                  createdAt,
                },
              }),
            );
          }
        };
        await appendWork("work", "2026-01-01T00:00:01.000Z");
        const before = await system.readModel();
        expect(
          before.threads[0]?.activities.some((activity) => activity.id === "async-question"),
        ).toBe(true);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        const response = {
          type: "thread.user-input.respond" as const,
          commandId: CommandId.make("async-response"),
          threadId,
          requestId,
          answers: { "0": "pnpm", "1": "Example" },
          attachmentsByQuestionId: {
            "1": [
              {
                type: "file" as const,
                id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        };
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("incomplete-answer"),
              answers: { "0": "pnpm" },
            }),
          ),
        ).rejects.toThrow("Answer each question before sending.");
        await system.run(system.engine.dispatch(response));
        const after = await system.readModel();
        const userMessages = after.threads[0]?.messages.filter(
          (message) => message.role === "user",
        );
        expect(userMessages).toHaveLength(1);
        expect(userMessages?.[0]?.attachments).toEqual(response.attachmentsByQuestionId["1"]);
        expect(userMessages?.[0]?.text).toBe(
          "Which package manager?\npnpm\n\nWhat should it be named?\nExample\nAttached file: spec.txt (thread-1-00000000-0000-4000-8000-0000000000aa-txt)",
        );
        expect(
          after.threads[0]?.activities.find((activity) => activity.kind === "user-input.resolved")
            ?.payload,
        ).toMatchObject({ requestId, responseMode: "message", answers: response.answers });
        const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
        expect(
          Array.from(events)
            .filter((event) => event.commandId === response.commandId)
            .map((event) => event.type),
        ).toEqual([
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("second-client-reply"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
        await appendWork("later-work", "2026-01-01T00:00:03.000Z");
        const afterEviction = Option.getOrThrow(await system.readThread(threadId));
        expect(
          afterEviction.activities.some((activity) => activity.kind === "user-input.resolved"),
        ).toBe(false);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("reply-after-eviction"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
      } finally {
        await system.dispose();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getDeletedWorktreeThreads: () => Effect.die("unused"),
          listThreadsWithPullRequests: () => Effect.die("unused"),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getProjectShellById: () => Effect.succeedNone,
          getProjectShells: () => Effect.succeed([]),
          getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeedNone,
          getFullThreadDiffContext: () => Effect.succeedNone,
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeedNone,
          getThreadDetailById: () => Effect.succeedNone,
          getThreadDetailSnapshot: () => Effect.succeedNone,
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
          projectEventDeferred: () => Effect.succeed(Effect.void),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(restartContinuationsLayer),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  effectIt.effect("preserves the blocked-settle error and persists its rejected receipt", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const projectId = ProjectId.make("project-blocked-settle");
      const threadId = ThreadId.make("thread-blocked-settle");
      const commandId = CommandId.make("cmd-blocked-settle");
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-blocked-settle-project-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-blocked-settle",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-blocked-settle-thread-create"),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-blocked-settle-session-set"),
        threadId,
        createdAt,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      });

      const sequence = yield* engine.latestSequence;
      const error = yield* engine
        .dispatch({ type: "thread.settle", commandId, threadId })
        .pipe(Effect.flip);
      const message =
        "This thread still needs attention. Resolve or interrupt it first, then try again.";
      expect(error).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId,
        message,
      });
      expect(Option.getOrNull(yield* receipts.getByCommandId({ commandId }))).toMatchObject({
        commandId,
        aggregateKind: "thread",
        aggregateId: threadId,
        status: "rejected",
        error: message,
        resultSequence: sequence,
      });
      expect(yield* engine.latestSequence).toBe(sequence);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  effectIt.effect(
    "rejects persisted changes and live background work without blocking unrelated threads",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now()));
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const backgroundLiveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
        const projectId = ProjectId.make("project-auto-settle-guard");
        const guardedThreadId = ThreadId.make("thread-auto-settle-guarded");
        const unrelatedThreadId = ThreadId.make("thread-auto-settle-unrelated");
        const liveThreadId = ThreadId.make("thread-auto-settle-live");

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-auto-settle-guard-project"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project-auto-settle-guard",
          createdAt: now(),
        });
        for (const threadId of [guardedThreadId, unrelatedThreadId, liveThreadId]) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${threadId}`),
            threadId,
            projectId,
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          });
        }

        const beforeUpdate = yield* snapshots.getSnapshot();
        const snapshotSequence = beforeUpdate.snapshotSequence;
        const originalUpdatedAt = beforeUpdate.threads.find(
          (thread) => thread.id === guardedThreadId,
        )?.updatedAt;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-guard-meta"),
          threadId: guardedThreadId,
          branch: "new-branch",
        });
        const afterUpdate = yield* snapshots.getSnapshot();
        expect(afterUpdate.threads.find((thread) => thread.id === guardedThreadId)?.updatedAt).toBe(
          originalUpdatedAt,
        );

        // Automatic settlement stamps the last activity, never the sweep time.
        const lastActivityAt = "2025-12-20T00:00:00.000Z";
        const staleError = yield* engine
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("cmd-auto-settle-stale-snapshot"),
            threadId: guardedThreadId,
            snapshotSequence,
            settledAt: lastActivityAt,
          })
          .pipe(Effect.flip);
        expect(staleError._tag).toBe("OrchestrationCommandInvariantError");

        const livenessSnapshotSequence = yield* engine.latestSequence;
        for (const [taskType, expectedLiveness] of [
          ["subagent", "working"],
          ["local_bash", "monitoring"],
        ] as const) {
          backgroundLiveness.recordTaskLiveness({
            threadId: liveThreadId,
            taskId: `task-${expectedLiveness}`,
            taskType,
            status: undefined,
            kind: "started",
          });
          expect(backgroundLiveness.getThreadBackgroundLiveness(liveThreadId)).toBe(
            expectedLiveness,
          );
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);

          const livenessError = yield* engine
            .dispatch({
              type: "thread.auto-settle",
              commandId: CommandId.make(`cmd-auto-settle-${expectedLiveness}`),
              threadId: liveThreadId,
              snapshotSequence: livenessSnapshotSequence,
              settledAt: lastActivityAt,
            })
            .pipe(Effect.flip);
          expect(livenessError._tag).toBe("OrchestrationCommandInvariantError");
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);
          backgroundLiveness.clearThreadLiveness(liveThreadId);
        }

        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-liveness-cleared"),
          threadId: liveThreadId,
          snapshotSequence: livenessSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const freshSnapshotSequence = yield* engine.latestSequence;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-unrelated-meta"),
          threadId: unrelatedThreadId,
          title: "Unrelated update",
        });
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-unrelated-update"),
          threadId: guardedThreadId,
          snapshotSequence: freshSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const settled = yield* snapshots.getSnapshot();
        for (const threadId of [guardedThreadId, liveThreadId]) {
          const thread = settled.threads.find((candidate) => candidate.id === threadId);
          expect(thread?.settledOverride).toBe("settled");
          expect(thread?.settledAt).toBe(lastActivityAt);
          expect(thread?.updatedAt).toBe(now());
        }
      }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it.each(["unlink", "relink", "branch", "worktree", "project", "delete"] as const)(
    "rejects PR discovery completed after a newer %s command",
    async (change) => {
      const system = await createOrchestrationSystem(undefined, {
        resolve: (workspaceRoot) =>
          Effect.succeed({
            canonicalKey: "example.test/owner/repository",
            provider: "github",
            displayName: "owner/repository",
            rootPath: workspaceRoot,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
          }),
      });
      // Same-tick links must replace the old PR, not rely on timestamp ordering.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(now()));
      try {
        const projectId = ProjectId.make("pr-race-project");
        const threadId = ThreadId.make("pr-race-thread");
        const previous = {
          projectId,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const replacement = {
          ...previous,
          number: 2,
          url: "https://example.test/owner/repository/pull/2",
        };
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("pr-race-project-create"),
            projectId,
            title: "PR race project",
            workspaceRoot: "/tmp/pr-race-project",
            defaultModelSelection: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("pr-race-thread-create"),
            threadId,
            projectId,
            title: "PR race thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            createdAt: now(),
          }),
        );
        const observed = await system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("pr-race-link"),
            threadId,
            linkedPullRequest: previous,
          }),
        );
        expect((await system.readModel()).threads[0]?.linkedPullRequest).toEqual(previous);
        const metadataChanges = {
          unlink: { linkedPullRequest: null },
          relink: {
            linkedPullRequest: {
              ...previous,
              number: 3,
              url: "https://example.test/owner/repository/pull/3",
            },
          },
          branch: { branch: "another-feature" },
          worktree: { worktreePath: "/tmp/another-worktree" },
          project: {},
        };
        await system.run(
          system.engine.dispatch(
            change === "project"
              ? {
                  type: "project.meta.update",
                  commandId: CommandId.make("pr-race-project-move"),
                  projectId,
                  workspaceRoot: "/tmp/another-project-root",
                }
              : change === "delete"
                ? { type: "thread.delete", commandId: CommandId.make("pr-race-delete"), threadId }
                : {
                    type: "thread.meta.update",
                    commandId: CommandId.make(`pr-race-${change}`),
                    threadId,
                    ...metadataChanges[change],
                  },
          ),
        );
        const command = {
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-race-stale-sync"),
          threadId,
          projectId,
          snapshotSequence: observed.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-race-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: previous,
            branchPullRequest: null,
          },
          branchPullRequest: replacement,
          linkedPullRequest: replacement,
        } satisfies OrchestrationCommand;
        const error = await system.run(system.engine.dispatch(command).pipe(Effect.flip));
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        if (change === "delete") return;
        const current = (await system.readModel()).threads[0];
        expect(current?.branchPullRequest ?? null).toBeNull();
        expect(current?.pullRequests.map((link) => link.number)).toEqual(
          change === "unlink" ? [] : change === "relink" ? [3] : [1],
        );
        expect(current?.linkedPullRequest ?? null).toEqual(
          change === "unlink"
            ? null
            : change === "relink"
              ? metadataChanges.relink.linkedPullRequest
              : previous,
        );
      } finally {
        clock.mockRestore();
        await system.dispose();
      }
    },
  );

  it("saves PR associations through streaming and unrelated metadata edits", async () => {
    const system = await createOrchestrationSystem();
    try {
      const projectId = ProjectId.make("pr-sync-project");
      const threadId = ThreadId.make("pr-sync-thread");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("pr-sync-project-create"),
          projectId,
          title: "PR sync project",
          workspaceRoot: "/tmp/pr-sync-project",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const created = await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("pr-sync-thread-create"),
          threadId,
          projectId,
          title: "PR sync thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const reference = {
        projectId,
        repository: "owner/repository",
        number: 42,
        url: "https://example.test/owner/repository/pull/42",
      };
      const activityAt = "2026-01-01T01:00:00.000Z";
      await system.run(
        system.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("pr-sync-streaming-message"),
          threadId,
          messageId: MessageId.make("pr-sync-message"),
          delta: "The PR is ready.",
          createdAt: activityAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("pr-sync-title-and-model"),
          threadId,
          title: "Renamed thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("pr-sync-project-title"),
          projectId,
          title: "Renamed project",
        }),
      );
      const beforeSync = (await system.readModel()).threads[0];
      await system.run(
        system.engine.dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-sync-discovery"),
          projectId,
          threadId,
          snapshotSequence: created.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-sync-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: reference,
        }),
      );
      const current = (await system.readModel()).threads[0];
      expect(current?.branchPullRequest).toEqual(reference);
      expect(current?.linkedPullRequest ?? null).toBeNull();
      expect(current?.updatedAt).toBe(beforeSync?.updatedAt);
    } finally {
      await system.dispose();
    }
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provideMerge(restartContinuationsLayer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provideMerge(restartContinuationsLayer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provideMerge(restartContinuationsLayer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  effectIt.effect(
    "catches up from the retained checkpoint before an unrelated command decides",
    () => {
      type StoredEvent =
        ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
          ? A
          : never;
      const events: StoredEvent[] = [];
      let nextSequence = 1;
      let failNextRead = true;

      const store: OrchestrationEventStoreShape = {
        append(event) {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return Effect.succeed(savedEvent);
        },
        readFromSequence(sequenceExclusive) {
          if (failNextRead) {
            failNextRead = false;
            return Stream.fail(
              new PersistenceSqlError({
                operation: "test.readFromSequence",
                detail: "read failed",
              }),
            );
          }
          return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
        },
        readAll() {
          return Stream.fromIterable(events);
        },
        hasEventAfter: () => Effect.succeed(false),
        readAggregateRange: () => Stream.die("unused aggregate replay"),
        getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      };

      let shouldFailProjection = true;
      const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: (event) => {
          if (shouldFailProjection && event.commandId === CommandId.make("cmd-gap-archive")) {
            shouldFailProjection = false;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.projection",
                detail: "projection failed",
              }),
            );
          }
          return Effect.succeed(Effect.void);
        },
      };

      const createdAt = now();
      const threadA = ThreadId.make("thread-gap-a");
      const threadB = ThreadId.make("thread-gap-b");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const stream = yield* engine.subscribeDomainEvents;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-gap-project"),
          projectId: asProjectId("project-gap"),
          title: "Gap Project",
          workspaceRoot: "/tmp/project-gap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        });
        for (const [threadId, commandId] of [
          [threadA, "cmd-gap-thread-a"],
          [threadB, "cmd-gap-thread-b"],
        ] as const) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId: asProjectId("project-gap"),
            title: threadId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          });
        }

        // The archive event commits durably but the dispatch fails and its
        // reconcile read fails too, leaving a gap behind the checkpoint.
        const archiveError = yield* engine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-gap-archive"),
            threadId: threadA,
          })
          .pipe(Effect.flip);
        expect(archiveError.message).toContain("projection failed");

        const result = yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-gap-meta"),
          threadId: threadB,
          title: "caught up",
        });
        expect(result.sequence).toBe(5);

        const published = yield* Stream.runCollect(Stream.take(stream, 5));
        expect(Array.from(published).map((event) => event.type)).toEqual([
          "project.created",
          "thread.created",
          "thread.created",
          "thread.archived",
          "thread.meta-updated",
        ]);

        const staleArchiveError = yield* engine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-gap-archive-again"),
            threadId: threadA,
          })
          .pipe(Effect.flip);
        expect(staleArchiveError.message).toContain("already archived");
        expect(yield* engine.latestSequence).toBe(5);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
            Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
            Layer.provide(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "keeps a catch-up failure retryable, unrecorded, and non-blocking once reads recover",
    () => {
      type StoredEvent =
        ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
          ? A
          : never;
      const events: StoredEvent[] = [];
      let nextSequence = 1;
      let readsFail = true;

      const store: OrchestrationEventStoreShape = {
        append(event) {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return Effect.succeed(savedEvent);
        },
        readFromSequence(sequenceExclusive) {
          if (readsFail) {
            return Stream.fail(
              new PersistenceSqlError({
                operation: "test.readFromSequence",
                detail: "read failed",
              }),
            );
          }
          return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
        },
        readAll() {
          return Stream.fromIterable(events);
        },
        hasEventAfter: () => Effect.succeed(false),
        readAggregateRange: () => Stream.die("unused aggregate replay"),
        getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      };

      let shouldFailProjection = true;
      const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: (event) => {
          if (shouldFailProjection && event.commandId === CommandId.make("cmd-unavail-archive")) {
            shouldFailProjection = false;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.projection",
                detail: "projection failed",
              }),
            );
          }
          return Effect.succeed(Effect.void);
        },
      };

      const createdAt = now();
      const threadId = ThreadId.make("thread-unavail");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-unavail-project"),
          projectId: asProjectId("project-unavail"),
          title: "Unavailable Project",
          workspaceRoot: "/tmp/project-unavail",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-unavail-thread"),
          threadId,
          projectId: asProjectId("project-unavail"),
          title: "unavailable",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const archiveError = yield* engine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-unavail-archive"),
            threadId,
          })
          .pipe(Effect.flip);
        expect(archiveError.message).toContain("projection failed");

        const blockedCommand = {
          type: "thread.unarchive" as const,
          commandId: CommandId.make("cmd-unavail-blocked"),
          threadId,
        };
        const blockedError = yield* engine.dispatch(blockedCommand).pipe(Effect.flip);
        expect(blockedError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(blockedError.message).toBe(
          "Server state is catching up after a storage error. Try again.",
        );
        expect(events).toHaveLength(3);
        expect(
          Option.getOrNull(yield* receipts.getByCommandId({ commandId: blockedCommand.commandId })),
        ).toBeNull();
        expect(
          Option.getOrNull(
            yield* receipts.getByCommandId({
              commandId: CommandId.make("cmd-unavail-archive"),
            }),
          ),
        ).toBeNull();

        readsFail = false;
        // Unarchive only decides on an archived thread, so succeeding here
        // proves catch-up folded the committed archive before the retry.
        const retried = yield* engine.dispatch(blockedCommand);
        expect(retried.sequence).toBe(4);
        expect(yield* engine.latestSequence).toBe(4);
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
            Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect("installs no catch-up events when the fold hits a malformed event", () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let corruptStream = true;

    const store: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        const tail = events.filter((event) => event.sequence > sequenceExclusive);
        const last = tail.at(-1);
        if (!corruptStream || last === undefined) {
          return Stream.fromIterable(tail);
        }
        const corrupt = {
          ...last,
          sequence: 999,
          payload: { corrupted: true },
        } as unknown as StoredEvent;
        return Stream.fromIterable([...tail, corrupt]);
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (shouldFailProjection && event.commandId === CommandId.make("cmd-corrupt-archive")) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const createdAt = now();
    const threadId = ThreadId.make("thread-corrupt");

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-corrupt-project"),
        projectId: asProjectId("project-corrupt"),
        title: "Corrupt Project",
        workspaceRoot: "/tmp/project-corrupt",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-corrupt-thread"),
        threadId,
        projectId: asProjectId("project-corrupt"),
        title: "corrupt",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const archiveError = yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-corrupt-archive"),
          threadId,
        })
        .pipe(Effect.flip);
      expect(archiveError.message).toContain("projection failed");

      const blockedCommand = {
        type: "thread.meta.update" as const,
        commandId: CommandId.make("cmd-corrupt-blocked"),
        threadId,
        title: "after corrupt",
      };
      const blockedError = yield* engine.dispatch(blockedCommand).pipe(Effect.flip);
      expect(blockedError._tag).toBe("OrchestrationCommandStateUnavailableError");
      // The archive event folded fine but the malformed sibling must not
      // leave it partially installed behind the checkpoint.
      expect(yield* engine.latestSequence).toBe(2);

      corruptStream = false;
      const retried = yield* engine.dispatch(blockedCommand);
      expect(retried.sequence).toBe(4);
      expect(yield* engine.latestSequence).toBe(4);

      const staleArchiveError = yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-corrupt-archive-again"),
          threadId,
        })
        .pipe(Effect.flip);
      expect(staleArchiveError.message).toContain("already archived");
    }).pipe(
      Effect.provide(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(ThreadBackgroundLiveness.layer),
          Layer.provide(ThreadPlanProgress.layer),
          Layer.provideMerge(restartContinuationsLayer),
          Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
          Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });

  effectIt.effect(
    "replays an ahead accepted receipt only after its committed events arrive",
    () => {
      type StoredEvent =
        ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
          ? A
          : never;
      const events: StoredEvent[] = [];
      let nextSequence = 1;
      let readsFail = false;

      const store: OrchestrationEventStoreShape = {
        append(event) {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return Effect.succeed(savedEvent);
        },
        readFromSequence(sequenceExclusive) {
          if (readsFail) {
            return Stream.fail(
              new PersistenceSqlError({
                operation: "test.readFromSequence",
                detail: "read failed",
              }),
            );
          }
          return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
        },
        readAll() {
          return Stream.fromIterable(events);
        },
        hasEventAfter: () => Effect.succeed(false),
        readAggregateRange: () => Stream.die("unused aggregate replay"),
        getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      };

      const createdAt = now();
      const threadId = ThreadId.make("thread-receipt-ahead");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-receipt-project"),
          projectId: asProjectId("project-receipt-ahead"),
          title: "Receipt Project",
          workspaceRoot: "/tmp/project-receipt-ahead",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-receipt-thread"),
          threadId,
          projectId: asProjectId("project-receipt-ahead"),
          title: "receipt-ahead",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-receipt-archive"),
          threadId,
        });

        const replayCommand = {
          type: "thread.meta.update" as const,
          commandId: CommandId.make("cmd-receipt-replay"),
          threadId,
          title: "replayed receipt",
        };
        yield* receipts.upsert({
          commandId: replayCommand.commandId,
          aggregateKind: "thread",
          aggregateId: threadId,
          acceptedAt: createdAt,
          resultSequence: 4,
          status: "accepted",
          error: null,
        });

        // An accepted receipt ahead of the checkpoint is not proof of
        // applied state; the empty stream cannot acknowledge it.
        const emptyError = yield* engine.dispatch(replayCommand).pipe(Effect.flip);
        expect(emptyError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(events).toHaveLength(3);
        expect(
          Option.getOrNull(yield* receipts.getByCommandId({ commandId: replayCommand.commandId })),
        ).toMatchObject({ resultSequence: 4, status: "accepted", error: null });

        const archived = events.find((event) => event.type === "thread.archived");
        if (archived === undefined) throw new Error("expected a committed archived event");
        events.push({
          ...archived,
          sequence: 4,
          type: "thread.unarchived",
          commandId: CommandId.make("cmd-injected-unarchive"),
          payload: { threadId, updatedAt: createdAt },
        } as unknown as StoredEvent);
        nextSequence = 5;

        const replayed = yield* engine.dispatch(replayCommand);
        expect(replayed.sequence).toBe(4);
        expect(events).toHaveLength(4);
        expect(yield* engine.latestSequence).toBe(4);

        // The injected unarchive must have been folded in: re-archiving the
        // same thread decides successfully instead of "already archived".
        const rearchive = yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-receipt-next"),
          threadId,
        });
        expect(rearchive.sequence).toBe(5);

        // A short stream still cannot acknowledge a receipt whose target is
        // beyond every committed event.
        const archivedAgain = events.find(
          (event) => event.type === "thread.archived" && event.sequence === 5,
        );
        if (archivedAgain === undefined) throw new Error("expected a committed archive event");
        events.push({
          ...archivedAgain,
          sequence: 6,
          commandId: CommandId.make("cmd-injected-archive"),
        } as unknown as StoredEvent);
        nextSequence = 7;
        const shortCommand = {
          type: "thread.meta.update" as const,
          commandId: CommandId.make("cmd-receipt-short"),
          threadId,
          title: "short receipt",
        };
        yield* receipts.upsert({
          commandId: shortCommand.commandId,
          aggregateKind: "thread",
          aggregateId: threadId,
          acceptedAt: createdAt,
          resultSequence: 7,
          status: "accepted",
          error: null,
        });
        const shortError = yield* engine.dispatch(shortCommand).pipe(Effect.flip);
        expect(shortError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(events).toHaveLength(6);
        // Genuinely committed events were still installed; only the
        // acknowledgement is withheld.
        expect(yield* engine.latestSequence).toBe(6);

        readsFail = true;
        const probeError = yield* engine
          .dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("cmd-receipt-probe"),
            threadId,
          })
          .pipe(Effect.flip);
        expect(probeError._tag).toBe("OrchestrationCommandStateUnavailableError");

        // The retained receipt floor blocks every later envelope too: an
        // unrelated command stays unavailable with no append and no
        // permanent rejection until event 7 is actually observed.
        readsFail = false;
        const blockedProbe = yield* engine
          .dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("cmd-receipt-probe"),
            threadId,
          })
          .pipe(Effect.flip);
        expect(blockedProbe._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(events).toHaveLength(6);
        expect(
          Option.getOrNull(
            yield* receipts.getByCommandId({
              commandId: CommandId.make("cmd-receipt-probe"),
            }),
          ),
        ).toBeNull();

        // Once committed evidence reaches the floor the same command decides.
        events.push({
          ...archivedAgain,
          sequence: 7,
          commandId: CommandId.make("cmd-injected-archive-7"),
        } as unknown as StoredEvent);
        nextSequence = 8;
        const probe = yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("cmd-receipt-probe"),
          threadId,
        });
        expect(probe.sequence).toBe(8);
        expect(yield* engine.latestSequence).toBe(8);
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(OrchestrationProjectionPipelineLive),
            Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-orchestration-engine-test-",
              }),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect("delivers a committed batch once when postcommit cleanup fails", () => {
    const cleanupError = new PersistenceSqlError({
      operation: "test.cleanup",
      detail: "attachment cleanup failed",
    });
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) =>
        event.commandId === CommandId.make("cmd-postcommit-turn")
          ? Effect.succeed(Effect.die(cleanupError))
          : Effect.succeed(Effect.void),
    };

    const createdAt = now();
    const threadId = ThreadId.make("thread-postcommit");

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const stream = yield* engine.subscribeDomainEvents;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-postcommit-project"),
        projectId: asProjectId("project-postcommit"),
        title: "Postcommit Project",
        workspaceRoot: "/tmp/project-postcommit",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-postcommit-thread"),
        threadId,
        projectId: asProjectId("project-postcommit"),
        title: "postcommit",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const turnStart = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("cmd-postcommit-turn"),
        threadId,
        message: {
          messageId: asMessageId("msg-postcommit"),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required" as const,
        createdAt,
      };
      const cleanupFailure = yield* engine.dispatch(turnStart).pipe(Effect.flip);
      expect(cleanupFailure.message).toContain("attachment cleanup failed");

      const firstBatch = yield* Stream.runCollect(Stream.take(stream, 4));
      expect(Array.from(firstBatch).map((event) => event.type)).toEqual([
        "project.created",
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      // The receipt committed, so the same id replays it without appending
      // or republishing the batch.
      const retried = yield* engine.dispatch(turnStart);
      expect(retried.sequence).toBe(4);

      const next = yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-postcommit-meta"),
        threadId,
        title: "after cleanup failure",
      });
      expect(next.sequence).toBe(5);

      const rest = yield* Stream.runCollect(Stream.take(stream, 1));
      expect(Array.from(rest).map((event) => event.type)).toEqual(["thread.meta-updated"]);

      const persisted = yield* Stream.runCollect(engine.readEvents(0));
      expect(Array.from(persisted)).toHaveLength(5);
      expect(yield* engine.latestSequence).toBe(5);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(ThreadBackgroundLiveness.layer),
          Layer.provide(ThreadPlanProgress.layer),
          Layer.provideMerge(restartContinuationsLayer),
          Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });

  effectIt.effect(
    "retains an ahead receipt target across envelopes until committed evidence reaches it",
    () => {
      type StoredEvent =
        ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
          ? A
          : never;
      const events: StoredEvent[] = [];
      let nextSequence = 1;
      let hide = false;

      const store: OrchestrationEventStoreShape = {
        append(event) {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return Effect.succeed(savedEvent);
        },
        readFromSequence(sequenceExclusive) {
          return hide
            ? Stream.fromIterable([])
            : Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
        },
        readAll() {
          return Stream.fromIterable(events);
        },
        hasEventAfter: () => Effect.succeed(false),
        readAggregateRange: () => Stream.die("unused aggregate replay"),
        getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      };

      const projectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: () => Effect.succeed(Effect.void),
      };

      const createdAt = now();
      const missingProjectId = asProjectId("project-floor-missing");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        const stream = yield* engine.subscribeDomainEvents;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-floor-seed"),
          projectId: asProjectId("project-floor-seed"),
          title: "Seed Project",
          workspaceRoot: "/tmp/project-floor-seed",
          createdAt,
        });

        // The committed event for the missing project and its accepted
        // receipt exist durably but reads are about to hide them.
        const missingCommand = {
          type: "project.create" as const,
          commandId: CommandId.make("cmd-floor-missing"),
          projectId: missingProjectId,
          title: "Missing Project",
          workspaceRoot: "/tmp/project-floor-missing",
          createdAt,
        };
        const seedEvent = events[0];
        if (seedEvent === undefined) throw new Error("expected the committed seed event");
        events.push({
          ...seedEvent,
          sequence: 2,
          eventId: EventId.make("evt-floor-missing"),
          commandId: missingCommand.commandId,
          aggregateId: missingProjectId,
          payload: {
            ...seedEvent.payload,
            projectId: missingProjectId,
            title: "Missing Project",
            workspaceRoot: "/tmp/project-floor-missing",
          },
        } as unknown as StoredEvent);
        nextSequence = 3;
        yield* receipts.upsert({
          commandId: missingCommand.commandId,
          aggregateKind: "project",
          aggregateId: missingProjectId,
          acceptedAt: createdAt,
          resultSequence: 2,
          status: "accepted",
          error: null,
        });

        hide = true;
        const replayError = yield* engine.dispatch(missingCommand).pipe(Effect.flip);
        expect(replayError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(yield* engine.latestSequence).toBe(1);

        // The retained target blocks unrelated commands too: nothing appends
        // and no permanent rejection is recorded while the floor is unmet.
        const unrelatedCommand = {
          type: "project.create" as const,
          commandId: CommandId.make("cmd-floor-unrelated"),
          projectId: asProjectId("project-floor-unrelated"),
          title: "Unrelated Project",
          workspaceRoot: "/tmp/project-floor-unrelated",
          createdAt,
        };
        const unrelatedError = yield* engine.dispatch(unrelatedCommand).pipe(Effect.flip);
        expect(unrelatedError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(events).toHaveLength(2);
        expect(
          Option.getOrNull(
            yield* receipts.getByCommandId({ commandId: unrelatedCommand.commandId }),
          ),
        ).toBeNull();

        hide = false;
        const replayed = yield* engine.dispatch(missingCommand);
        expect(replayed.sequence).toBe(2);
        expect(events).toHaveLength(2);

        const unrelated = yield* engine.dispatch(unrelatedCommand);
        expect(unrelated.sequence).toBe(3);

        // Event 2 was actually folded in: the recovered project accepts a
        // metadata update instead of rejecting it as nonexistent.
        const updated = yield* engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-floor-update"),
          projectId: missingProjectId,
          title: "Recovered Project",
        });
        expect(updated.sequence).toBe(4);
        expect(yield* engine.latestSequence).toBe(4);

        const published = yield* Stream.runCollect(Stream.take(stream, 4));
        expect(Array.from(published).map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
            Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "holds session-changing commands until the resumed turn is verifiably observed",
    () => {
      const projectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: () => Effect.succeed(Effect.void),
      };

      const createdAt = now();
      const projectId = asProjectId("project-held");
      const threadId = ThreadId.make("thread-held");
      const otherThreadId = ThreadId.make("thread-free");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const resumedTurnId = asTurnId("turn-resumed");
      const turnStart = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("cmd-held-turn"),
        threadId,
        message: {
          messageId: asMessageId("msg-held"),
          role: "user" as const,
          text: "resume me",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required" as const,
        createdAt,
      };

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-held-project"),
          projectId,
          title: "Held Project",
          workspaceRoot: "/tmp/project-held",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-held-thread"),
          threadId,
          projectId,
          title: "held",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const token = continuations.reserve(threadId, providerInstanceId);

        // Every held event type leaves no events, receipt, or activity behind.
        for (const held of [
          turnStart,
          {
            type: "thread.runtime-mode.set" as const,
            commandId: CommandId.make("cmd-held-mode"),
            threadId,
            runtimeMode: "full-access" as const,
            createdAt,
          },
          {
            type: "thread.checkpoint.revert" as const,
            commandId: CommandId.make("cmd-held-revert"),
            threadId,
            turnCount: 0,
            createdAt,
          },
        ]) {
          const heldError = yield* engine.dispatch(held).pipe(Effect.flip);
          expect(heldError._tag).toBe("OrchestrationRestartRecoveryHeldError");
          expect(heldError.message).toBe(
            "This thread is still resuming. Retry when recovery finishes, or stop it and continue in a new thread.",
          );
        }
        expect(yield* engine.latestSequence).toBe(2);
        for (const commandId of ["cmd-held-turn", "cmd-held-mode", "cmd-held-revert"]) {
          expect(
            Option.getOrNull(
              yield* receipts.getByCommandId({ commandId: CommandId.make(commandId) }),
            ),
          ).toBeNull();
        }

        // Commands outside the held set and commands on other threads proceed.
        const meta = yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-held-meta"),
          threadId,
          title: "still works",
        });
        expect(meta.sequence).toBe(3);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-held-other-thread"),
          threadId: otherThreadId,
          projectId,
          title: "free",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const otherTurn = yield* engine.dispatch({
          ...turnStart,
          commandId: CommandId.make("cmd-held-other-turn"),
          threadId: otherThreadId,
        });
        expect(otherTurn.sequence).toBe(6);

        // Returned evidence alone is not enough: the resumed turn must also be
        // observed running under this token.
        continuations.record(token, { kind: "returned", turnId: resumedTurnId });
        const stillHeld = yield* engine.dispatch(turnStart).pipe(Effect.flip);
        expect(stillHeld._tag).toBe("OrchestrationRestartRecoveryHeldError");
        expect(yield* engine.latestSequence).toBe(6);

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-held-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: resumedTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        const released = yield* engine.dispatch(turnStart);
        expect(released.sequence).toBe(9);
        expect(continuations.current(threadId)).toBeUndefined();
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "releases a held thread when the running set was observed before its evidence",
    () => {
      const projectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: () => Effect.succeed(Effect.void),
      };

      const createdAt = now();
      const projectId = asProjectId("project-held-order");
      const threadId = ThreadId.make("thread-held-order");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const resumedTurnId = asTurnId("turn-resumed-order");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-order-project"),
          projectId,
          title: "Order Project",
          workspaceRoot: "/tmp/project-held-order",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-order-thread"),
          threadId,
          projectId,
          title: "held order",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const token = continuations.reserve(threadId, providerInstanceId);

        // The committed running set is observed before the evidence lands:
        // recording the returned turn afterwards still releases the hold.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-order-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: resumedTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        continuations.record(token, { kind: "returned", turnId: resumedTurnId });

        const released = yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-order-turn"),
          threadId,
          message: {
            messageId: asMessageId("msg-order"),
            role: "user",
            text: "after resume",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        expect(released.sequence).toBe(5);
        expect(continuations.current(threadId)).toBeUndefined();
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "keeps threads held when a catch-up batch pairs their running set with stop or deletion",
    () => {
      type StoredEvent =
        ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
          ? A
          : never;
      const events: StoredEvent[] = [];
      let nextSequence = 1;
      let readsFail = false;
      let projectionsFail = false;

      const store: OrchestrationEventStoreShape = {
        append(event) {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return Effect.succeed(savedEvent);
        },
        readFromSequence(sequenceExclusive) {
          if (readsFail) {
            return Stream.fail(
              new PersistenceSqlError({
                operation: "test.readFromSequence",
                detail: "read failed",
              }),
            );
          }
          return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
        },
        readAll() {
          return Stream.fromIterable(events);
        },
        hasEventAfter: () => Effect.succeed(false),
        readAggregateRange: () => Stream.die("unused aggregate replay"),
        getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      };

      const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: (event) => {
          if (projectionsFail && event.commandId === CommandId.make("cmd-holdfail-archive")) {
            projectionsFail = false;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.projection",
                detail: "projection failed",
              }),
            );
          }
          return Effect.succeed(Effect.void);
        },
      };

      const createdAt = now();
      const projectId = asProjectId("project-hold-catchup");
      const stoppedThreadId = ThreadId.make("thread-hold-stopped");
      const deletedThreadId = ThreadId.make("thread-hold-deleted");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const resumedTurnId = asTurnId("turn-held-stopped");
      const resumedDeletedTurnId = asTurnId("turn-held-deleted");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-holdc-project"),
          projectId,
          title: "Catchup Hold Project",
          workspaceRoot: "/tmp/project-hold-catchup",
          createdAt,
        });
        for (const [threadId, commandId] of [
          [stoppedThreadId, "cmd-holdc-stopped-thread"],
          [deletedThreadId, "cmd-holdc-deleted-thread"],
        ] as const) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId,
            title: String(threadId),
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          });
        }

        const stoppedToken = continuations.reserve(stoppedThreadId, providerInstanceId);
        const deletedToken = continuations.reserve(deletedThreadId, providerInstanceId);

        // Durable evidence that has not reached the model yet: each thread ran
        // its resumed turn and then was stopped or deleted in the same batch.
        const runningBase = events.find((event) => event.type === "thread.created");
        if (runningBase === undefined) throw new Error("expected a committed thread event");
        const runningSession = (threadId: ThreadId, turnId: TurnId) => ({
          threadId,
          status: "running" as const,
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "approval-required" as const,
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        });
        events.push(
          {
            ...runningBase,
            sequence: 4,
            type: "thread.session-set",
            commandId: CommandId.make("cmd-injected-running-stopped"),
            aggregateId: stoppedThreadId,
            payload: {
              threadId: stoppedThreadId,
              session: runningSession(stoppedThreadId, resumedTurnId),
            },
          } as unknown as StoredEvent,
          {
            ...runningBase,
            sequence: 5,
            type: "thread.session-stop-requested",
            commandId: CommandId.make("cmd-injected-stop"),
            aggregateId: stoppedThreadId,
            payload: { threadId: stoppedThreadId, createdAt },
          } as unknown as StoredEvent,
          {
            ...runningBase,
            sequence: 6,
            type: "thread.session-set",
            commandId: CommandId.make("cmd-injected-running-deleted"),
            aggregateId: deletedThreadId,
            payload: {
              threadId: deletedThreadId,
              session: runningSession(deletedThreadId, resumedDeletedTurnId),
            },
          } as unknown as StoredEvent,
          {
            ...runningBase,
            sequence: 7,
            type: "thread.deleted",
            commandId: CommandId.make("cmd-injected-delete"),
            aggregateId: deletedThreadId,
            payload: { threadId: deletedThreadId, deletedAt: createdAt },
          } as unknown as StoredEvent,
        );
        nextSequence = 8;

        // The failing dispatch leaves a gap so the batch lands via catch-up.
        projectionsFail = true;
        readsFail = true;
        const archiveError = yield* engine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-holdfail-archive"),
            threadId: stoppedThreadId,
          })
          .pipe(Effect.flip);
        expect(archiveError._tag).toBe("PersistenceSqlError");
        readsFail = false;

        continuations.record(stoppedToken, { kind: "returned", turnId: resumedTurnId });
        continuations.record(deletedToken, {
          kind: "returned",
          turnId: resumedDeletedTurnId,
        });

        // Whole-batch observation applies every flag: evidence and the seen
        // running turn cannot outweigh a committed stop or deletion.
        const stoppedError = yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-holdc-stopped-turn"),
            threadId: stoppedThreadId,
            message: {
              messageId: asMessageId("msg-held-stopped"),
              role: "user",
              text: "after stop",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          })
          .pipe(Effect.flip);
        expect(stoppedError._tag).toBe("OrchestrationRestartRecoveryHeldError");
        expect(stoppedError.message).toBe(
          "Restart recovery could not be verified. Continue in a new thread. Restarting the server will re-check this thread.",
        );
        expect(stoppedToken.canceled).toBe(true);
        expect(stoppedToken.seen.has(resumedTurnId)).toBe(true);

        const deletedError = yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-holdc-deleted-turn"),
            threadId: deletedThreadId,
            message: {
              messageId: asMessageId("msg-held-deleted"),
              role: "user",
              text: "after delete",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          })
          .pipe(Effect.flip);
        expect(deletedError._tag).toBe("OrchestrationRestartRecoveryHeldError");
        expect(deletedToken.deleted).toBe(true);
        expect(deletedToken.seen.has(resumedDeletedTurnId)).toBe(true);

        expect(events).toHaveLength(8);
        for (const commandId of ["cmd-holdc-stopped-turn", "cmd-holdc-deleted-turn"]) {
          expect(
            Option.getOrNull(
              yield* receipts.getByCommandId({ commandId: CommandId.make(commandId) }),
            ),
          ).toBeNull();
        }
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
            Layer.provide(Layer.succeed(OrchestrationEventStore, store)),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "keeps a thread held when interrupt commits between the running set and its evidence",
    () => {
      const projectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: () => Effect.succeed(Effect.void),
      };

      const createdAt = now();
      const projectId = asProjectId("project-held-interrupt");
      const threadId = ThreadId.make("thread-held-interrupt");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const resumedTurnId = asTurnId("turn-held-interrupt");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-hint-project"),
          projectId,
          title: "Interrupt Hold Project",
          workspaceRoot: "/tmp/project-held-interrupt",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-hint-thread"),
          threadId,
          projectId,
          title: "held interrupt",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const token = continuations.reserve(threadId, providerInstanceId);

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-hint-session"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: resumedTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        // The committed interrupt cancels the token before the resumed
        // continuation's evidence lands, regardless of any later provider stop.
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-hint-interrupt"),
          threadId,
          createdAt,
        });
        continuations.record(token, { kind: "returned", turnId: resumedTurnId });

        const heldError = yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-hint-turn"),
            threadId,
            message: {
              messageId: asMessageId("msg-hint"),
              role: "user",
              text: "after interrupt",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          })
          .pipe(Effect.flip);
        expect(heldError._tag).toBe("OrchestrationRestartRecoveryHeldError");
        expect(heldError.message).toBe(
          "Restart recovery could not be verified. Continue in a new thread. Restarting the server will re-check this thread.",
        );
        expect(token.canceled).toBe(true);
        expect(token.seen.has(resumedTurnId)).toBe(true);
        expect(continuations.current(threadId)).toBe(token);
        expect(yield* engine.latestSequence).toBe(4);
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  effectIt.effect(
    "holds on unverified or revoked evidence, instance mismatch, and same-id recreation",
    () => {
      const projectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: () => Effect.void,
        projectEventDeferred: () => Effect.succeed(Effect.void),
      };

      const createdAt = now();
      const projectId = asProjectId("project-held-evidence");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const otherInstanceId = ProviderInstanceId.make("claude");
      const turnStartFor = (threadId: ThreadId, commandId: string) =>
        ({
          type: "thread.turn.start" as const,
          commandId: CommandId.make(commandId),
          threadId,
          message: {
            messageId: asMessageId(`msg-${commandId}`),
            role: "user" as const,
            text: "probe",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required" as const,
          createdAt,
        }) as const;

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-hev-project"),
          projectId,
          title: "Evidence Hold Project",
          workspaceRoot: "/tmp/project-held-evidence",
          createdAt,
        });
        const createThread = (threadId: ThreadId, commandId: string) =>
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId,
            title: String(threadId),
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          });

        const unverifiedThreadId = ThreadId.make("thread-held-unverified");
        const revokedThreadId = ThreadId.make("thread-held-revoked");
        const mismatchedThreadId = ThreadId.make("thread-held-mismatch");
        yield* createThread(unverifiedThreadId, "cmd-hev-unverified-thread");
        yield* createThread(revokedThreadId, "cmd-hev-revoked-thread");
        yield* createThread(mismatchedThreadId, "cmd-hev-mismatched-thread");

        continuations.record(continuations.reserve(unverifiedThreadId, providerInstanceId), {
          kind: "unverified",
        });
        continuations.record(continuations.reserve(revokedThreadId, providerInstanceId), {
          kind: "revoked",
        });

        for (const [threadId, commandId] of [
          [unverifiedThreadId, "cmd-hev-unverified-turn"],
          [revokedThreadId, "cmd-hev-revoked-turn"],
        ] as const) {
          const heldError = yield* engine
            .dispatch(turnStartFor(threadId, commandId))
            .pipe(Effect.flip);
          expect(heldError._tag).toBe("OrchestrationRestartRecoveryHeldError");
          expect(heldError.message).toBe(
            "Restart recovery could not be verified. Continue in a new thread. Restarting the server will re-check this thread.",
          );
        }

        // The resumed turn ran on a different provider instance than the one
        // the token was reserved for: verification cannot complete.
        const mismatchToken = continuations.reserve(mismatchedThreadId, providerInstanceId);
        const mismatchTurnId = asTurnId("turn-held-mismatch");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-hev-mismatch-session"),
          threadId: mismatchedThreadId,
          session: {
            threadId: mismatchedThreadId,
            status: "running",
            providerName: "claude",
            providerInstanceId: otherInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: mismatchTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        continuations.record(mismatchToken, { kind: "returned", turnId: mismatchTurnId });
        const mismatchError = yield* engine
          .dispatch(turnStartFor(mismatchedThreadId, "cmd-hev-mismatch-turn"))
          .pipe(Effect.flip);
        expect(mismatchError._tag).toBe("OrchestrationRestartRecoveryHeldError");

        // A deleted thread's token is no longer live, so recreating the same
        // id is refused without a permanent rejection.
        const recreatedThreadId = ThreadId.make("thread-held-recreated");
        yield* createThread(recreatedThreadId, "cmd-hev-recreated-thread");
        continuations.reserve(recreatedThreadId, providerInstanceId);
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-hev-delete"),
          threadId: recreatedThreadId,
        });
        const recreateError = yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-hev-recreate"),
            threadId: recreatedThreadId,
            projectId,
            title: "recreated",
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          })
          .pipe(Effect.flip);
        expect(recreateError._tag).toBe("OrchestrationRestartRecoveryHeldError");
        expect(recreateError.message).toBe(
          "Restart recovery could not be verified. Continue in a new thread. Restarting the server will re-check this thread.",
        );
        expect(
          Option.getOrNull(
            yield* receipts.getByCommandId({ commandId: CommandId.make("cmd-hev-recreate") }),
          ),
        ).toBeNull();
      }).pipe(
        Effect.provide(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(restartContinuationsLayer),
            Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
            Layer.provide(SqlitePersistenceMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    },
  );

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("replays the accepted receipt for a genuine retry of the same command", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-retry-project-create"),
        projectId: asProjectId("project-retry"),
        title: "Retry Project",
        workspaceRoot: "/tmp/project-retry",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-retry-thread-create"),
        threadId: ThreadId.make("thread-retry"),
        projectId: asProjectId("project-retry"),
        title: "retry",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStart = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-retry-turn-start"),
      threadId: ThreadId.make("thread-retry"),
      message: {
        messageId: asMessageId("msg-retry"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    } as const;

    const first = await system.run(engine.dispatch(turnStart));
    const second = await system.run(engine.dispatch(turnStart));
    expect(second.sequence).toBe(first.sequence);

    const readModel = await system.readModel();
    const thread = readModel.threads.find((candidate) => candidate.id === "thread-retry");
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);

    await system.dispose();
  });

  it("rejects reusing an accepted command id for a different aggregate", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-conflict-project-create"),
        projectId: asProjectId("project-conflict"),
        title: "Conflict Project",
        workspaceRoot: "/tmp/project-conflict",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    for (const threadId of ["thread-conflict-a", "thread-conflict-b"]) {
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${threadId}-create`),
          threadId: ThreadId.make(threadId),
          projectId: asProjectId("project-conflict"),
          title: threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
    }

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-conflict-turn-start"),
        threadId: ThreadId.make("thread-conflict-a"),
        message: {
          messageId: asMessageId("msg-conflict-a"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-conflict-turn-start"),
          threadId: ThreadId.make("thread-conflict-b"),
          message: {
            messageId: asMessageId("msg-conflict-b"),
            role: "user",
            text: "hello again",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toThrow("already used for thread 'thread-conflict-a'");

    const readModel = await system.readModel();
    const targetThread = readModel.threads.find(
      (candidate) => candidate.id === "thread-conflict-b",
    );
    expect(targetThread?.messages.filter((message) => message.role === "user")).toHaveLength(0);

    await system.dispose();
  });

  it("stamps the dispatching client's origin onto persisted event metadata", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-origin-project-create"),
          projectId: asProjectId("project-origin"),
          title: "Origin Project",
          workspaceRoot: "/tmp/project-origin",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        },
        { origin: { surface: "mobile", appVersion: "1.2.3" } },
      ),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-no-origin-project-create"),
        projectId: asProjectId("project-no-origin"),
        title: "No Origin Project",
        workspaceRoot: "/tmp/project-no-origin",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    const withOrigin = events.find((event) => event.commandId === "cmd-origin-project-create");
    const withoutOrigin = events.find(
      (event) => event.commandId === "cmd-no-origin-project-create",
    );

    expect(withOrigin?.metadata.origin).toEqual({ surface: "mobile", appVersion: "1.2.3" });
    expect(withoutOrigin?.metadata.origin).toBeUndefined();

    await system.dispose();
  });

  type TurnStartFailCommand = Extract<OrchestrationCommand, { type: "thread.turn.start.fail" }>;

  const MEMORY_FAIL_SUMMARY = "Message not sent";
  const MEMORY_FAIL_DETAIL = "Project memory is not available for this thread.";

  async function seedTurnStartFailThread(
    system: Awaited<ReturnType<typeof createOrchestrationSystem>>,
    input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly messageId: MessageId;
      readonly turnCommandId: string;
      readonly sessionCommandId: string;
    },
  ) {
    const createdAt = now();
    const { engine } = system;
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.turnCommandId}-project`),
        projectId: input.projectId,
        title: "Turn start fail",
        workspaceRoot: "/tmp/turn-start-fail",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.turnCommandId}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Turn start fail",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const turnReceipt = await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(input.turnCommandId),
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: "memory hold",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt,
      }),
    );
    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    const requestSequence = events.find(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        event.payload.messageId === input.messageId &&
        event.commandId === CommandId.make(input.turnCommandId),
    )?.sequence;
    expect(requestSequence).toBeDefined();

    const sessionReceipt = await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(input.sessionCommandId),
        threadId: input.threadId,
        createdAt,
        session: {
          threadId: input.threadId,
          status: "starting",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      }),
    );
    return {
      createdAt,
      requestSequence: requestSequence!,
      sessionSequence: sessionReceipt.sequence,
      sessionReceipt,
      turnReceipt,
    };
  }

  function makeTurnStartFailCommand(input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly requestSequence: number;
    readonly sessionSequence: number | null;
    readonly restoreStatus?: "ready" | "error";
    readonly failedAt: string;
  }): TurnStartFailCommand {
    return {
      type: "thread.turn.start.fail",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      messageId: input.messageId,
      requestSequence: input.requestSequence,
      sessionSequence: input.sessionSequence,
      restoreStatus: input.restoreStatus ?? "ready",
      activityId: EventId.make(`${input.commandId}-activity`),
      summary: MEMORY_FAIL_SUMMARY,
      detail: MEMORY_FAIL_DETAIL,
      createdAt: input.failedAt,
      failedAt: input.failedAt,
    };
  }

  async function dispatchTurnStartFail(
    system: Awaited<ReturnType<typeof createOrchestrationSystem>>,
    command: TurnStartFailCommand,
  ) {
    return system.run(system.engine.dispatch(command));
  }

  function activityPayloadRequestId(activity: { readonly payload: unknown }) {
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null || !("requestId" in payload)) {
      return undefined;
    }
    const requestId = (payload as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? requestId : undefined;
  }

  it("E1 restores a quiet starting session, clears pending, and accepts the compound command", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.make("thread-turn-start-fail-e1");
    const projectId = asProjectId("project-turn-start-fail-e1");
    const messageId = asMessageId("message-turn-start-fail-e1");
    try {
      const { requestSequence, sessionSequence, createdAt } = await seedTurnStartFailThread(
        system,
        {
          threadId,
          projectId,
          messageId,
          turnCommandId: "cmd-e1-turn",
          sessionCommandId: "cmd-e1-session",
        },
      );
      expect(Option.isSome(await system.readPendingTurnStart(threadId))).toBe(true);

      const failedAt = "2026-01-01T00:00:02.000Z";
      const receipt = await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e1-fail",
          threadId,
          messageId,
          requestSequence,
          sessionSequence,
          failedAt,
        }),
      );
      expect(receipt.sequence).toBeGreaterThan(0);

      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: failedAt,
      });
      expect(Option.isNone(await system.readPendingTurnStart(threadId))).toBe(true);
      const activity = thread.activities.find(
        (entry) => entry.kind === "provider.turn.start.failed",
      );
      expect(activityPayloadRequestId(activity!)).toBe(String(messageId));
      expect(
        (
          await system.run(
            Stream.runCollect(system.engine.readEvents(0)).pipe(
              Effect.map((chunk) => Array.from(chunk)),
            ),
          )
        ).filter((event) => event.commandId === CommandId.make("cmd-e1-fail")),
      ).toMatchObject([{ type: "thread.session-set" }, { type: "thread.activity-appended" }]);
    } finally {
      await system.dispose();
    }
  });

  it("E2 keeps the current pending row for a superseded incarnation and clears only the current one", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.make("thread-turn-start-fail-e2");
    const projectId = asProjectId("project-turn-start-fail-e2");
    const messageId = asMessageId("message-turn-start-fail-e2");
    try {
      const first = await seedTurnStartFailThread(system, {
        threadId,
        projectId,
        messageId,
        turnCommandId: "cmd-e2-turn-1",
        sessionCommandId: "cmd-e2-session-1",
      });
      const { engine } = system;
      const secondTurnReceipt = await system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-e2-turn-2"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "memory hold again",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: first.createdAt,
        }),
      );
      const allEvents = await system.run(
        Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      const secondRequestSequence = allEvents.find(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.commandId === CommandId.make("cmd-e2-turn-2"),
      )?.sequence;
      expect(secondRequestSequence).toBeDefined();
      const secondSessionReceipt = await system.run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-e2-session-2"),
          threadId,
          createdAt: first.createdAt,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: first.createdAt,
          },
        }),
      );
      const eventsAfterSecondSession = await system.run(
        Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      const firstSessionEvent = eventsAfterSecondSession.find(
        (event) => event.sequence === first.sessionSequence,
      );
      const secondSessionEvent = eventsAfterSecondSession.find(
        (event) => event.sequence === secondSessionReceipt.sequence,
      );
      expect(firstSessionEvent?.type).toBe("thread.session-set");
      expect(secondSessionEvent?.type).toBe("thread.session-set");
      expect(firstSessionEvent?.payload).toEqual(secondSessionEvent?.payload);

      const failedAt = "2026-01-01T00:00:03.000Z";
      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e2-fail-old",
          threadId,
          messageId,
          requestSequence: first.requestSequence,
          sessionSequence: first.sessionSequence,
          failedAt,
        }),
      );

      let thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.session?.status).toBe("starting");
      expect(Option.isSome(await system.readPendingTurnStart(threadId))).toBe(true);
      const oldActivity = thread.activities.find(
        (entry) => entry.id === EventId.make("cmd-e2-fail-old-activity"),
      );
      expect(oldActivity).toBeDefined();
      expect(activityPayloadRequestId(oldActivity!)).toBeUndefined();

      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e2-fail-current",
          threadId,
          messageId,
          requestSequence: secondRequestSequence!,
          sessionSequence: secondSessionReceipt.sequence,
          failedAt: "2026-01-01T00:00:04.000Z",
        }),
      );

      thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.session?.status).toBe("starting");
      expect(Option.isNone(await system.readPendingTurnStart(threadId))).toBe(true);
      const currentActivity = thread.activities.find(
        (entry) => entry.id === EventId.make("cmd-e2-fail-current-activity"),
      );
      expect(currentActivity).toBeDefined();
      expect(activityPayloadRequestId(currentActivity!)).toBe(String(messageId));
      expect(secondTurnReceipt.sequence).toBeGreaterThan(first.turnReceipt.sequence);
    } finally {
      await system.dispose();
    }
  });

  it("E2-positive restores after a fresh session-set follows a stale diagnostic", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.make("thread-turn-start-fail-e2-positive");
    const projectId = asProjectId("project-turn-start-fail-e2-positive");
    const messageId = asMessageId("message-turn-start-fail-e2-positive");
    try {
      const first = await seedTurnStartFailThread(system, {
        threadId,
        projectId,
        messageId,
        turnCommandId: "cmd-e2p-turn-1",
        sessionCommandId: "cmd-e2p-session-1",
      });
      const { engine } = system;
      await system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-e2p-turn-2"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "again",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: first.createdAt,
        }),
      );
      const eventsAfterSecondTurn = await system.run(
        Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      );
      const requestSequence = eventsAfterSecondTurn.find(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.commandId === CommandId.make("cmd-e2p-turn-2"),
      )?.sequence;
      expect(requestSequence).toBeDefined();
      const secondSessionReceipt = await system.run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-e2p-session-2"),
          threadId,
          createdAt: first.createdAt,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: first.createdAt,
          },
        }),
      );
      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e2p-fail-old",
          threadId,
          messageId,
          requestSequence: first.requestSequence,
          sessionSequence: first.sessionSequence,
          failedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      const thirdSessionReceipt = await system.run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-e2p-session-3"),
          threadId,
          createdAt: first.createdAt,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: first.createdAt,
          },
        }),
      );
      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e2p-fail-current",
          threadId,
          messageId,
          requestSequence: requestSequence!,
          sessionSequence: thirdSessionReceipt.sequence,
          failedAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.session?.status).toBe("ready");
      expect(Option.isNone(await system.readPendingTurnStart(threadId))).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("E3 rejects stale request sequences without restore or requestId linkage", async () => {
    const system = await createOrchestrationSystem();
    const threadId = ThreadId.make("thread-turn-start-fail-e3");
    const otherThreadId = ThreadId.make("thread-turn-start-fail-e3-other");
    const projectId = asProjectId("project-turn-start-fail-e3");
    const messageId = asMessageId("message-turn-start-fail-e3");
    try {
      const seeded = await seedTurnStartFailThread(system, {
        threadId,
        projectId,
        messageId,
        turnCommandId: "cmd-e3-turn",
        sessionCommandId: "cmd-e3-session",
      });
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-e3-other-thread"),
          threadId: otherThreadId,
          projectId,
          title: "other",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: seeded.createdAt,
        }),
      );
      const failedAt = "2026-01-01T00:00:02.000Z";
      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e3-wrong-thread",
          threadId: otherThreadId,
          messageId,
          requestSequence: seeded.requestSequence,
          sessionSequence: seeded.sessionSequence,
          failedAt,
        }),
      );
      const head = await system.run(system.engine.latestSequence);
      await dispatchTurnStartFail(
        system,
        makeTurnStartFailCommand({
          commandId: "cmd-e3-head",
          threadId,
          messageId,
          requestSequence: head + 50,
          sessionSequence: seeded.sessionSequence,
          failedAt,
        }),
      );
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.session?.status).toBe("starting");
      const otherThread = Option.getOrThrow(await system.readThread(otherThreadId));
      for (const [owner, activityId] of [
        [thread, "cmd-e3-head-activity"],
        [otherThread, "cmd-e3-wrong-thread-activity"],
      ] as const) {
        const activity = owner.activities.find((entry) => entry.id === activityId);
        expect(activity).toBeDefined();
        expect(activity?.kind).toBe("provider.turn.start.failed");
        expect(activityPayloadRequestId(activity!)).toBeUndefined();
      }
    } finally {
      await system.dispose();
    }
  });

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

  const seedScanBoundThread = (
    engine: OrchestrationEngineShape,
    input: {
      readonly createdAt: string;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly fillerCount: number;
      readonly prefix: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.prefix}-project`),
        projectId: input.projectId,
        title: "Scan bound",
        workspaceRoot: `/tmp/scan-bound-${input.prefix}`,
        createdAt: input.createdAt,
      });
      const threadReceipt = yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.prefix}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Scan bound",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`${input.prefix}-turn`),
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: "scan bound",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: input.createdAt,
      });
      const eventsAfterTurn = yield* Stream.runCollect(
        engine.readEvents(threadReceipt.sequence),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const requestSequence = eventsAfterTurn.find(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.commandId === CommandId.make(`${input.prefix}-turn`),
      )?.sequence;
      expect(requestSequence).toBeDefined();
      yield* Effect.forEach(
        Array.from({ length: input.fillerCount }, (_, index) => index),
        (index) =>
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`${input.prefix}-meta-${index}`),
            threadId: input.threadId,
            title: `title-${index}`,
          }),
        { concurrency: 1 },
      );
      const sessionReceipt = yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`${input.prefix}-session`),
        threadId: input.threadId,
        createdAt: input.createdAt,
        session: {
          threadId: input.threadId,
          status: "starting",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
      });
      return { requestSequence: requestSequence!, sessionSequence: sessionReceipt.sequence };
    });

  effectIt.effect(
    "restores through a 1000-event scan window and refuses restore at 1001 returned rows",
    () => {
      const createdAt = now();
      const withinThreadId = ThreadId.make("thread-turn-start-fail-scan-within");
      const withinProjectId = asProjectId("project-turn-start-fail-scan-within");
      const withinMessageId = asMessageId("message-turn-start-fail-scan-within");
      const overflowThreadId = ThreadId.make("thread-turn-start-fail-scan-overflow");
      const overflowProjectId = asProjectId("project-turn-start-fail-scan-overflow");
      const overflowMessageId = asMessageId("message-turn-start-fail-scan-overflow");

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        const within = yield* seedScanBoundThread(engine, {
          createdAt,
          projectId: withinProjectId,
          threadId: withinThreadId,
          messageId: withinMessageId,
          fillerCount: 998,
          prefix: "scan-within",
        });
        const withinFailAt = "2026-01-01T00:00:05.000Z";
        yield* engine.dispatch(
          makeTurnStartFailCommand({
            commandId: "cmd-scan-within-fail",
            threadId: withinThreadId,
            messageId: withinMessageId,
            requestSequence: within.requestSequence,
            sessionSequence: within.sessionSequence,
            failedAt: withinFailAt,
          }),
        );
        const withinThread = yield* snapshotQuery
          .getThreadDetailById(withinThreadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(withinThread.session).toMatchObject({
          status: "ready",
          activeTurnId: null,
          updatedAt: withinFailAt,
        });

        const overflow = yield* seedScanBoundThread(engine, {
          createdAt,
          projectId: overflowProjectId,
          threadId: overflowThreadId,
          messageId: overflowMessageId,
          fillerCount: 999,
          prefix: "scan-overflow",
        });
        const overflowFailAt = "2026-01-01T00:00:06.000Z";
        yield* engine.dispatch(
          makeTurnStartFailCommand({
            commandId: "cmd-scan-overflow-fail",
            threadId: overflowThreadId,
            messageId: overflowMessageId,
            requestSequence: overflow.requestSequence,
            sessionSequence: overflow.sessionSequence,
            failedAt: overflowFailAt,
          }),
        );
        const overflowThread = yield* snapshotQuery
          .getThreadDetailById(overflowThreadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(overflowThread.session?.status).toBe("starting");
        const overflowActivity = overflowThread.activities.find(
          (entry) => entry.id === EventId.make("cmd-scan-overflow-fail-activity"),
        );
        expect(overflowActivity).toBeDefined();
        expect(activityPayloadRequestId(overflowActivity!)).toBeUndefined();
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect("fails the compound command when aggregate scan reads fail", () => {
    const failAggregateReads = { current: false };
    const scanReadAttempts = { current: 0 };
    const failingStoreLayer = decorateOrchestrationEventStoreLayer((store) => ({
      ...store,
      readAggregateRange: (input) => {
        if (failAggregateReads.current) {
          scanReadAttempts.current += 1;
          return Stream.fail(
            new PersistenceSqlError({
              operation: "OrchestrationEventStore.readAggregateRange:query",
              detail: "simulated scan read failure",
            }),
          );
        }
        return store.readAggregateRange(input);
      },
    }));
    const wrappedStore = failingStoreLayer.pipe(Layer.provide(OrchestrationEventStoreLive));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = now();
      const threadId = ThreadId.make("thread-turn-start-fail-read-error");
      const projectId = asProjectId("project-turn-start-fail-read-error");
      const messageId = asMessageId("message-turn-start-fail-read-error");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-read-error-project"),
        projectId,
        title: "Read error",
        workspaceRoot: "/tmp/read-error",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-read-error-thread"),
        threadId,
        projectId,
        title: "Read error",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-read-error-turn"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "read error",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt,
      });
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const requestSequence = events.find(
        (event) => event.type === "thread.turn-start-requested",
      )?.sequence;
      const sessionReceipt = yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-read-error-session"),
        threadId,
        createdAt,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      });
      failAggregateReads.current = true;
      const failure = yield* engine
        .dispatch(
          makeTurnStartFailCommand({
            commandId: "cmd-read-error-fail",
            threadId,
            messageId,
            requestSequence: requestSequence!,
            sessionSequence: sessionReceipt.sequence,
            failedAt: "2026-01-01T00:00:02.000Z",
          }),
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "PersistenceSqlError",
        operation: "OrchestrationEventStore.readAggregateRange:query",
      });
      expect(scanReadAttempts.current).toBe(1);
    }).pipe(Effect.provide(makeOrchestrationLayer(undefined, undefined, wrappedStore)));
  });

  const seedContinuationSettlement = (
    engine: OrchestrationEngineShape,
    continuations: RestartContinuations["Service"],
    input: {
      readonly prefix: string;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly createdAt: string;
      readonly preparationStatus?: "starting" | "running";
      readonly preparationProviderInstanceId?: ProviderInstanceId;
      readonly cleanupProviderInstanceId?: ProviderInstanceId;
    },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.prefix}-project`),
        projectId: input.projectId,
        title: "Settlement",
        workspaceRoot: `/tmp/settlement-${input.prefix}`,
        createdAt: input.createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.prefix}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Settlement",
        modelSelection: { instanceId: input.providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      });
      const preparationCommandId = CommandId.make(`${input.prefix}-prepare`);
      const prepared = yield* engine.dispatch({
        type: "thread.session.set",
        commandId: preparationCommandId,
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: input.preparationStatus ?? "starting",
          providerName: "codex",
          providerInstanceId: input.preparationProviderInstanceId ?? input.providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      const token = continuations.reserve(input.threadId, input.providerInstanceId);
      const cleanupCommandId = CommandId.make(`${input.prefix}-cleanup`);
      continuations.record(token, { kind: "held", commandId: cleanupCommandId });
      const cleanupCommand = {
        type: "thread.session.set" as const,
        commandId: cleanupCommandId,
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "error" as const,
          providerName: "codex",
          providerInstanceId: input.cleanupProviderInstanceId ?? input.providerInstanceId,
          runtimeMode: "approval-required" as const,
          activeTurnId: null,
          lastError: "memory send held",
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      };
      const settlement: ContinuationSettlement = {
        token,
        preparationSequence: prepared.sequence,
        preparationCommandId,
      };
      return { token, cleanupCommand, settlement, prepared };
    });

  effectIt.effect("settles a held continuation and retires only its exact token", () => {
    const createdAt = now();
    const providerInstanceId = ProviderInstanceId.make("codex");
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const seeded = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-ok",
        projectId: asProjectId("project-settle-ok"),
        threadId: ThreadId.make("thread-settle-ok"),
        providerInstanceId,
        createdAt,
      });

      const settled = yield* engine.dispatch(seeded.cleanupCommand, {
        continuationSettlement: seeded.settlement,
      });
      expect(settled.sequence).toBeGreaterThan(seeded.prepared.sequence);
      expect(continuations.current(seeded.token.threadId)).toBeUndefined();
      const thread = yield* snapshotQuery
        .getThreadDetailById(seeded.token.threadId)
        .pipe(Effect.map(Option.getOrThrow));
      expect(thread.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: "memory send held",
      });

      // Replaying the committed cleanup returns the same sequence, writes
      // nothing, and leaves a successor token untouched.
      const replayed = yield* engine.dispatch(seeded.cleanupCommand, {
        continuationSettlement: seeded.settlement,
      });
      expect(replayed.sequence).toBe(settled.sequence);
      const successor = continuations.reserve(seeded.token.threadId, providerInstanceId);
      const replayedWithSuccessor = yield* engine.dispatch(seeded.cleanupCommand, {
        continuationSettlement: seeded.settlement,
      });
      expect(replayedWithSuccessor.sequence).toBe(settled.sequence);
      expect(continuations.current(seeded.token.threadId)).toBe(successor);
      expect(continuations.isLive(successor)).toBe(true);
      const cleanupEvents = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) =>
          Array.from(chunk).filter((event) => event.commandId === seeded.cleanupCommand.commandId),
        ),
      );
      expect(cleanupEvents).toMatchObject([{ type: "thread.session-set" }]);
    }).pipe(Effect.provide(makeOrchestrationLayer()));
  });

  effectIt.effect("rejects a settlement whose held token is missing or was replaced", () => {
    const createdAt = now();
    const providerInstanceId = ProviderInstanceId.make("codex");
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

      const replaced = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-replaced",
        projectId: asProjectId("project-settle-replaced"),
        threadId: ThreadId.make("thread-settle-replaced"),
        providerInstanceId,
        createdAt,
      });
      const successor = continuations.reserve(replaced.token.threadId, providerInstanceId);
      const replacedError = yield* engine
        .dispatch(replaced.cleanupCommand, { continuationSettlement: replaced.settlement })
        .pipe(Effect.flip);
      expect(replacedError._tag).toBe("OrchestrationCommandInvariantError");
      // The refusal is not a decision: no cleanup event, the successor keeps
      // the thread, and the replaced token stays revoked.
      expect(continuations.current(replaced.token.threadId)).toBe(successor);
      expect(continuations.isLive(successor)).toBe(true);
      expect(replaced.token.revoked).toBe(true);

      const missing = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-missing",
        projectId: asProjectId("project-settle-missing"),
        threadId: ThreadId.make("thread-settle-missing"),
        providerInstanceId,
        createdAt,
      });
      continuations.retire(missing.token);
      const missingError = yield* engine
        .dispatch(missing.cleanupCommand, { continuationSettlement: missing.settlement })
        .pipe(Effect.flip);
      expect(missingError._tag).toBe("OrchestrationCommandInvariantError");

      // Both refusals recorded rejected receipts and wrote no cleanup events;
      // replaying them surfaces PreviouslyRejected, not success.
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      for (const refused of [replaced, missing]) {
        expect(events.some((event) => event.commandId === refused.cleanupCommand.commandId)).toBe(
          false,
        );
        const receipt = yield* receipts.getByCommandId({
          commandId: refused.cleanupCommand.commandId,
        });
        expect(Option.getOrThrow(receipt).status).toBe("rejected");
        const replayError = yield* engine
          .dispatch(refused.cleanupCommand, { continuationSettlement: refused.settlement })
          .pipe(Effect.flip);
        expect(replayError._tag).toBe("OrchestrationCommandPreviouslyRejectedError");
      }
      expect(continuations.current(replaced.token.threadId)).toBe(successor);
    }).pipe(Effect.provide(makeOrchestrationLayer()));
  });

  effectIt.effect(
    "rejects a settlement when the thread's committed history moved past preparation",
    () => {
      const createdAt = now();
      const providerInstanceId = ProviderInstanceId.make("codex");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        // An intervening session-set is a new generation the cleanup must not
        // overwrite.
        const mutated = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-mutated",
          projectId: asProjectId("project-settle-mutated"),
          threadId: ThreadId.make("thread-settle-mutated"),
          providerInstanceId,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("settle-mutated-intervene"),
          threadId: mutated.token.threadId,
          session: {
            threadId: mutated.token.threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-intervened"),
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        const mutatedError = yield* engine
          .dispatch(mutated.cleanupCommand, { continuationSettlement: mutated.settlement })
          .pipe(Effect.flip);
        expect(mutatedError._tag).toBe("OrchestrationCommandInvariantError");
        const mutatedThread = yield* snapshotQuery
          .getThreadDetailById(mutated.token.threadId)
          .pipe(Effect.map(Option.getOrThrow));
        // The intervening writer's state wins; the cleanup wrote nothing.
        expect(mutatedThread.session).toMatchObject({
          status: "running",
          activeTurnId: asTurnId("turn-intervened"),
        });

        // A stop committed after preparation is also a new generation.
        const stopped = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-stopped",
          projectId: asProjectId("project-settle-stopped"),
          threadId: ThreadId.make("thread-settle-stopped"),
          providerInstanceId,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("settle-stopped-stop"),
          threadId: stopped.token.threadId,
          createdAt,
        });
        const stoppedError = yield* engine
          .dispatch(stopped.cleanupCommand, { continuationSettlement: stopped.settlement })
          .pipe(Effect.flip);
        expect(stoppedError._tag).toBe("OrchestrationCommandInvariantError");
        expect(stopped.token.canceled).toBe(true);
        const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(events.some((event) => event.commandId === stopped.cleanupCommand.commandId)).toBe(
          false,
        );
        expect(
          events.some(
            (event) =>
              event.type === "thread.session-stop-requested" &&
              event.commandId === CommandId.make("settle-stopped-stop"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect(
    "rejects a settlement whose preparation anchor or command shape mismatches",
    () => {
      const createdAt = now();
      const providerInstanceId = ProviderInstanceId.make("codex");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const seeded = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-anchor",
          projectId: asProjectId("project-settle-anchor"),
          threadId: ThreadId.make("thread-settle-anchor"),
          providerInstanceId,
          createdAt,
        });

        // Each refusal needs its own held token and cleanup command id so one
        // rejected receipt cannot mask the next attempt.
        const rejectCleanup = (suffix: string, settlement: Omit<ContinuationSettlement, "token">) =>
          Effect.gen(function* () {
            const token = continuations.reserve(seeded.token.threadId, providerInstanceId);
            const commandId = CommandId.make(`settle-anchor-${suffix}`);
            continuations.record(token, { kind: "held", commandId });
            const error = yield* engine
              .dispatch(
                {
                  type: "thread.session.set",
                  commandId,
                  threadId: seeded.token.threadId,
                  session: {
                    threadId: seeded.token.threadId,
                    status: "error",
                    providerName: "codex",
                    providerInstanceId,
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: "memory send held",
                    updatedAt: createdAt,
                  },
                  createdAt,
                },
                { continuationSettlement: { ...settlement, token } },
              )
              .pipe(Effect.flip);
            expect(error._tag).toBe("OrchestrationCommandInvariantError");
          });

        // The preparation's command id must match the stored anchor event.
        yield* rejectCleanup("wrong-cmd", {
          preparationSequence: seeded.prepared.sequence,
          preparationCommandId: CommandId.make("not-the-preparation"),
        });
        // The anchor sequence must land on the preparation session-set, not
        // on the thread.created event just before it.
        yield* rejectCleanup("wrong-seq", {
          preparationSequence: seeded.prepared.sequence - 1,
          preparationCommandId: seeded.settlement.preparationCommandId,
        });
        // Nothing committed at the claimed anchor means there is no anchor.
        yield* rejectCleanup("future-seq", {
          preparationSequence: seeded.prepared.sequence + 10,
          preparationCommandId: seeded.settlement.preparationCommandId,
        });
        // A non-positive preparation sequence is not a valid anchor.
        yield* rejectCleanup("zero-seq", {
          preparationSequence: 0,
          preparationCommandId: seeded.settlement.preparationCommandId,
        });

        // A settlement only fits a session.set cleanup command.
        const metaToken = continuations.reserve(seeded.token.threadId, providerInstanceId);
        const metaCommandId = CommandId.make("settle-anchor-meta");
        continuations.record(metaToken, { kind: "held", commandId: metaCommandId });
        const metaError = yield* engine
          .dispatch(
            {
              type: "thread.meta.update",
              commandId: metaCommandId,
              threadId: seeded.token.threadId,
              title: "not a cleanup",
            },
            { continuationSettlement: { ...seeded.settlement, token: metaToken } },
          )
          .pipe(Effect.flip);
        expect(metaError._tag).toBe("OrchestrationCommandInvariantError");

        // A held marker recorded for a different command id is not this cleanup.
        const driftToken = continuations.reserve(seeded.token.threadId, providerInstanceId);
        continuations.record(driftToken, {
          kind: "held",
          commandId: CommandId.make("some-other-cleanup"),
        });
        const driftError = yield* engine
          .dispatch(
            {
              type: "thread.session.set",
              commandId: CommandId.make("settle-anchor-drift"),
              threadId: seeded.token.threadId,
              session: seeded.cleanupCommand.session,
              createdAt,
            },
            { continuationSettlement: { ...seeded.settlement, token: driftToken } },
          )
          .pipe(Effect.flip);
        expect(driftError._tag).toBe("OrchestrationCommandInvariantError");

        // The preparation must be a "starting" session-set, not any session-set.
        const runningSeed = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-running-prep",
          projectId: asProjectId("project-settle-running-prep"),
          threadId: ThreadId.make("thread-settle-running-prep"),
          providerInstanceId,
          createdAt,
          preparationStatus: "running",
        });
        const runningError = yield* engine
          .dispatch(runningSeed.cleanupCommand, {
            continuationSettlement: runningSeed.settlement,
          })
          .pipe(Effect.flip);
        expect(runningError._tag).toBe("OrchestrationCommandInvariantError");

        // The anchor's provider instance must match the captured prepared
        // session the cleanup claims to settle.
        const instanceSeed = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-instance",
          projectId: asProjectId("project-settle-instance"),
          threadId: ThreadId.make("thread-settle-instance"),
          providerInstanceId,
          createdAt,
          cleanupProviderInstanceId: ProviderInstanceId.make("cursor"),
        });
        const instanceError = yield* engine
          .dispatch(instanceSeed.cleanupCommand, {
            continuationSettlement: instanceSeed.settlement,
          })
          .pipe(Effect.flip);
        expect(instanceError._tag).toBe("OrchestrationCommandInvariantError");

        // Anchor and cleanup agreeing on a different instance than the
        // token's is not proof of ownership: the token is A, both sessions
        // say B, and only the token decides who owns the thread.
        const wrongOwner = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-wrong-owner",
          projectId: asProjectId("project-settle-wrong-owner"),
          threadId: ThreadId.make("thread-settle-wrong-owner"),
          providerInstanceId,
          createdAt,
          preparationProviderInstanceId: ProviderInstanceId.make("cursor"),
          cleanupProviderInstanceId: ProviderInstanceId.make("cursor"),
        });
        const wrongOwnerError = yield* engine
          .dispatch(wrongOwner.cleanupCommand, {
            continuationSettlement: wrongOwner.settlement,
          })
          .pipe(Effect.flip);
        expect(wrongOwnerError._tag).toBe("OrchestrationCommandInvariantError");
        expect(continuations.current(wrongOwner.token.threadId)).toBe(wrongOwner.token);
        expect(continuations.isLive(wrongOwner.token)).toBe(true);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect("rejects a settlement whose token dies during the history scan", () => {
    const createdAt = now();
    const providerInstanceId = ProviderInstanceId.make("codex");
    let replaceDuringRead: (() => void) | undefined;
    const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
      ...store,
      readAggregateRange: (input) => {
        replaceDuringRead?.();
        return store.readAggregateRange(input);
      },
    })).pipe(Layer.provide(OrchestrationEventStoreLive));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      const seeded = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-during-scan",
        projectId: asProjectId("project-settle-during-scan"),
        threadId: ThreadId.make("thread-settle-during-scan"),
        providerInstanceId,
        createdAt,
      });

      // Reserving the successor inside the store read makes the post-scan
      // mutable-token recheck the check that refuses the write.
      let successor = seeded.token;
      replaceDuringRead = () => {
        successor = continuations.reserve(seeded.token.threadId, providerInstanceId);
        replaceDuringRead = undefined;
      };
      const error = yield* engine
        .dispatch(seeded.cleanupCommand, { continuationSettlement: seeded.settlement })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      // The scan really ran, so only the final recheck could have refused it.
      expect(replaceDuringRead).toBeUndefined();
      expect(successor).not.toBe(seeded.token);
      expect(continuations.current(seeded.token.threadId)).toBe(successor);
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(events.some((event) => event.commandId === seeded.cleanupCommand.commandId)).toBe(
        false,
      );
    }).pipe(Effect.provide(makeOrchestrationLayer(undefined, undefined, wrappedStore)));
  });

  effectIt.effect("rejects a settlement whose token dies inside the async decider", () => {
    const createdAt = now();
    const providerInstanceId = ProviderInstanceId.make("codex");
    // One-shot gate on the engine's Crypto: the first UUID draw after it is
    // armed pauses the decider so the token can be replaced mid-evaluation.
    const uuidGate: { current: Effect.Effect<void> | undefined } = { current: undefined };
    const gatedCryptoLayer = Layer.effect(
      Crypto.Crypto,
      Effect.gen(function* () {
        const real = yield* Crypto.Crypto;
        return {
          ...real,
          randomUUIDv4: Effect.suspend(() => {
            const gate = uuidGate.current;
            if (gate === undefined) return real.randomUUIDv4;
            uuidGate.current = undefined;
            return gate.pipe(Effect.andThen(real.randomUUIDv4));
          }),
        } satisfies Crypto.Crypto;
      }),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      const seeded = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-decider-drift",
        projectId: asProjectId("project-settle-decider-drift"),
        threadId: ThreadId.make("thread-settle-decider-drift"),
        providerInstanceId,
        createdAt,
      });

      const deciderEntered = yield* Deferred.make<void>();
      const deciderRelease = yield* Deferred.make<void>();
      uuidGate.current = Deferred.succeed(deciderEntered, undefined).pipe(
        Effect.andThen(Deferred.await(deciderRelease)),
      );
      const dispatched = yield* engine
        .dispatch(seeded.cleanupCommand, {
          continuationSettlement: seeded.settlement,
        })
        .pipe(Effect.forkChild);
      // The worker is parked inside the decider after every pre-decider
      // token check already passed.
      yield* Deferred.await(deciderEntered);
      const successor = continuations.reserve(seeded.token.threadId, providerInstanceId);
      yield* Deferred.succeed(deciderRelease, undefined);
      const error = yield* Fiber.join(dispatched).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(continuations.current(seeded.token.threadId)).toBe(successor);
      expect(continuations.isLive(successor)).toBe(true);
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(events.some((event) => event.commandId === seeded.cleanupCommand.commandId)).toBe(
        false,
      );
    }).pipe(
      Effect.provide(
        makeOrchestrationLayer(undefined, undefined, OrchestrationEventStoreLive, gatedCryptoLayer),
      ),
    );
  });

  effectIt.effect("rejects a settlement when its preparation scan is truncated", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      const createdAt = now();
      const providerInstanceId = ProviderInstanceId.make("codex");
      const seeded = yield* seedContinuationSettlement(engine, continuations, {
        prefix: "settle-truncated",
        projectId: asProjectId("project-settle-truncated"),
        threadId: ThreadId.make("thread-settle-truncated"),
        providerInstanceId,
        createdAt,
      });
      // A thousand non-superseding events after the anchor overflow the
      // bounded scan; a truncated scan can never pass for a checked one.
      yield* Effect.forEach(
        Array.from({ length: 1000 }, (_, index) => index),
        (index) =>
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`settle-truncated-meta-${index}`),
            threadId: seeded.token.threadId,
            title: `filler-${index}`,
          }),
        { concurrency: 1 },
      );
      const error = yield* engine
        .dispatch(seeded.cleanupCommand, { continuationSettlement: seeded.settlement })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(events.some((event) => event.commandId === seeded.cleanupCommand.commandId)).toBe(
        false,
      );
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  effectIt.effect(
    "treats a failed settlement read as retryable and a mismatch as permanent",
    () => {
      const failAggregateReads = { current: false };
      const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
        ...store,
        readAggregateRange: (input) => {
          if (failAggregateReads.current) {
            return Stream.fail(
              new PersistenceSqlError({
                operation: "OrchestrationEventStore.readAggregateRange:query",
                detail: "simulated settlement scan failure",
              }),
            );
          }
          return store.readAggregateRange(input);
        },
      })).pipe(Layer.provide(OrchestrationEventStoreLive));

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        const createdAt = now();
        const providerInstanceId = ProviderInstanceId.make("codex");
        const seeded = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-transient",
          projectId: asProjectId("project-settle-transient"),
          threadId: ThreadId.make("thread-settle-transient"),
          providerInstanceId,
          createdAt,
        });

        failAggregateReads.current = true;
        const transientError = yield* engine
          .dispatch(seeded.cleanupCommand, { continuationSettlement: seeded.settlement })
          .pipe(Effect.flip);
        expect(transientError._tag).toBe("OrchestrationCommandStateUnavailableError");
        // Unclear state writes no receipt, so the same command id can retry.
        expect(
          Option.isNone(
            yield* receipts.getByCommandId({ commandId: seeded.cleanupCommand.commandId }),
          ),
        ).toBe(true);
        expect(continuations.current(seeded.token.threadId)).toBe(seeded.token);

        failAggregateReads.current = false;
        const settled = yield* engine.dispatch(seeded.cleanupCommand, {
          continuationSettlement: seeded.settlement,
        });
        expect(settled.sequence).toBeGreaterThan(seeded.prepared.sequence);
        expect(continuations.current(seeded.token.threadId)).toBeUndefined();
      }).pipe(Effect.provide(makeOrchestrationLayer(undefined, undefined, wrappedStore)));
    },
  );

  effectIt.effect(
    "replays an accepted settlement only after the stored event proves the cleanup",
    () => {
      const createdAt = now();
      const providerInstanceId = ProviderInstanceId.make("codex");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const seeded = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-replay",
          projectId: asProjectId("project-settle-replay"),
          threadId: ThreadId.make("thread-settle-replay"),
          providerInstanceId,
          createdAt,
        });

        // Commit the cleanup as a plain dispatch: the accepted receipt exists
        // but the in-memory retire never landed.
        const committed = yield* engine.dispatch(seeded.cleanupCommand);
        expect(continuations.current(seeded.token.threadId)).toBe(seeded.token);

        const replayed = yield* engine.dispatch(seeded.cleanupCommand, {
          continuationSettlement: seeded.settlement,
        });
        expect(replayed.sequence).toBe(committed.sequence);
        // The replay retires only the exact held token and writes nothing.
        expect(continuations.current(seeded.token.threadId)).toBeUndefined();
        const cleanupEvents = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) =>
            Array.from(chunk).filter(
              (event) => event.commandId === seeded.cleanupCommand.commandId,
            ),
          ),
        );
        expect(cleanupEvents).toMatchObject([{ type: "thread.session-set" }]);

        // The same replay against a live successor leaves the successor in
        // place: retire can only remove the identical current object.
        const succeeded = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-replay-successor",
          projectId: asProjectId("project-settle-replay-successor"),
          threadId: ThreadId.make("thread-settle-replay-successor"),
          providerInstanceId,
          createdAt,
        });
        const committedAgain = yield* engine.dispatch(succeeded.cleanupCommand);
        const successor = continuations.reserve(succeeded.token.threadId, providerInstanceId);
        const replayedWithSuccessor = yield* engine.dispatch(succeeded.cleanupCommand, {
          continuationSettlement: succeeded.settlement,
        });
        expect(replayedWithSuccessor.sequence).toBe(committedAgain.sequence);
        expect(continuations.current(succeeded.token.threadId)).toBe(successor);
        expect(continuations.isLive(successor)).toBe(true);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect(
    "refuses to retire on a replay whose stored state does not prove the cleanup",
    () => {
      const createdAt = now();
      const providerInstanceId = ProviderInstanceId.make("codex");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const continuations = yield* RestartContinuations;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

        // An accepted receipt whose stored event is not this cleanup's
        // session-set is unclear state, not proof of success.
        const fabricated = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-fabricated",
          projectId: asProjectId("project-settle-fabricated"),
          threadId: ThreadId.make("thread-settle-fabricated"),
          providerInstanceId,
          createdAt,
        });
        yield* receipts.upsert({
          commandId: fabricated.cleanupCommand.commandId,
          aggregateKind: "thread",
          aggregateId: fabricated.token.threadId,
          acceptedAt: createdAt,
          // Points at the thread.created event, not a session-set.
          resultSequence: fabricated.prepared.sequence - 1,
          status: "accepted",
          error: null,
        });
        const fabricatedError = yield* engine
          .dispatch(fabricated.cleanupCommand, {
            continuationSettlement: fabricated.settlement,
          })
          .pipe(Effect.flip);
        expect(fabricatedError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(continuations.current(fabricated.token.threadId)).toBe(fabricated.token);

        // Held evidence for a different command id cannot prove this cleanup.
        const drifted = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-drifted",
          projectId: asProjectId("project-settle-drifted"),
          threadId: ThreadId.make("thread-settle-drifted"),
          providerInstanceId,
          createdAt,
        });
        yield* engine.dispatch(drifted.cleanupCommand);
        const driftToken = continuations.reserve(drifted.token.threadId, providerInstanceId);
        continuations.record(driftToken, {
          kind: "held",
          commandId: CommandId.make("some-other-cleanup"),
        });
        const driftError = yield* engine
          .dispatch(drifted.cleanupCommand, {
            continuationSettlement: { ...drifted.settlement, token: driftToken },
          })
          .pipe(Effect.flip);
        expect(driftError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(continuations.current(drifted.token.threadId)).toBe(driftToken);

        // A stored session-set that shares every id but is not the cleanup's
        // error payload is not proof of settlement either.
        const wrongPayload = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-wrong-payload",
          projectId: asProjectId("project-settle-wrong-payload"),
          threadId: ThreadId.make("thread-settle-wrong-payload"),
          providerInstanceId,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: wrongPayload.cleanupCommand.commandId,
          threadId: wrongPayload.token.threadId,
          session: {
            threadId: wrongPayload.token.threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-wrong-payload"),
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        const wrongPayloadError = yield* engine
          .dispatch(wrongPayload.cleanupCommand, {
            continuationSettlement: wrongPayload.settlement,
          })
          .pipe(Effect.flip);
        expect(wrongPayloadError._tag).toBe("OrchestrationCommandStateUnavailableError");
        expect(continuations.current(wrongPayload.token.threadId)).toBe(wrongPayload.token);

        // A rejected receipt is not proof of success either: replaying the
        // refused cleanup changes nothing and retires nothing.
        const refused = yield* seedContinuationSettlement(engine, continuations, {
          prefix: "settle-refused",
          projectId: asProjectId("project-settle-refused"),
          threadId: ThreadId.make("thread-settle-refused"),
          providerInstanceId,
          createdAt,
        });
        const refusedError = yield* engine
          .dispatch(refused.cleanupCommand, {
            continuationSettlement: { ...refused.settlement, preparationSequence: 0 },
          })
          .pipe(Effect.flip);
        expect(refusedError._tag).toBe("OrchestrationCommandInvariantError");
        const replayError = yield* engine
          .dispatch(refused.cleanupCommand, { continuationSettlement: refused.settlement })
          .pipe(Effect.flip);
        expect(replayError._tag).toBe("OrchestrationCommandPreviouslyRejectedError");
        expect(continuations.current(refused.token.threadId)).toBe(refused.token);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  describe("skill input-boundary writer fence", () => {
    const SKILL_WRITER_NOW = "2026-01-01T00:00:00.000Z";
    const skillWriterProviderId = ProviderInstanceId.make("codex");
    let skillWriterCommandCounter = 0;
    const skillWriterCommandId = (prefix: string) =>
      CommandId.make(`${prefix}-${skillWriterCommandCounter++}`);

    type PostCommitGate = {
      current:
        | undefined
        | {
            readonly entered: Deferred.Deferred<void>;
            readonly release: Deferred.Deferred<void>;
          };
    };

    const withPostCommitTransactionGate = (
      sql: SqlClient.SqlClient,
      gate: PostCommitGate,
    ): SqlClient.SqlClient =>
      new Proxy(sql, {
        apply(target, thisArg, args) {
          return Reflect.apply(target, thisArg, args);
        },
        get(target, prop, receiver) {
          if (prop === "withTransaction") {
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const existingTransaction = yield* Effect.serviceOption(target.transactionService);
                const value = yield* target.withTransaction(effect);
                const active = gate.current;
                if (Option.isNone(existingTransaction) && active !== undefined) {
                  yield* Deferred.succeed(active.entered, undefined);
                  yield* Deferred.await(active.release);
                }
                return value;
              });
          }
          return Reflect.get(target, prop, receiver);
        },
      });

    const makePostCommitTransactionLayer = (gate: PostCommitGate) =>
      Layer.effect(
        SqlClient.SqlClient,
        Effect.map(SqlClient.SqlClient, (sql) => {
          const decorated = withPostCommitTransactionGate(sql, gate);
          expect(decorated.transactionService).toBe(sql.transactionService);
          return decorated;
        }),
      );

    const makePersistenceWithPostCommit = (databasePath: string, gate: PostCommitGate) =>
      makePostCommitTransactionLayer(gate).pipe(
        Layer.provide(makeSqlitePersistenceLive(databasePath)),
      );

    const writerCheckScript = (id: string): ProjectScript => ({
      id,
      name: id,
      command: "true",
      icon: "play",
      runOnWorktreeCreate: false,
    });

    const mockVcsLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      detect: () =>
        Effect.succeed({
          kind: "git" as const,
          repository: {} as never,
          driver: {
            checkpoints: {
              observeTree: () =>
                Effect.succeed({
                  observation: { kind: "complete", treeOid: "0".repeat(40) },
                  repoIdentity: null,
                }),
            },
          },
        } as never),
      resolve: () =>
        Effect.succeed({
          kind: "git" as const,
          repository: {} as never,
          driver: {
            checkpoints: {
              observeTree: () =>
                Effect.succeed({
                  observation: { kind: "complete", treeOid: "0".repeat(40) },
                  repoIdentity: null,
                }),
            },
          },
        } as never),
      get: () => Effect.die("unused vcs get"),
    });

    const defaultPassedScriptResult = (): ScriptExecutor.ScriptExecutionResult => ({
      status: "passed",
      exitCode: 0,
      exitedBy: "exit",
      exitSignal: null,
      pgid: 4711,
      group: "empty",
      stdout: {
        bytes: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      stderr: {
        bytes: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      failure: null,
    });

    const makeSelectedChecksLayer = (
      runScript: typeof ScriptExecutor.runScript = () =>
        Effect.succeed(defaultPassedScriptResult()),
    ) =>
      Layer.effect(
        SelectedChecks.SelectedChecks,
        SelectedChecks.make({ shutdownGrace: Duration.zero, runScript }),
      );

    const makeSkillWriterFenceLayer = (
      options: {
        readonly databasePath?: string;
        readonly gate?: PostCommitGate;
        readonly runScript?: typeof ScriptExecutor.runScript;
      } = {},
    ) => {
      const persistence =
        options.databasePath !== undefined
          ? makePersistenceWithPostCommit(
              options.databasePath,
              options.gate ?? { current: undefined },
            )
          : SqlitePersistenceMemory;
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-skill-writer-fence-test-",
      });
      const settingsLayer = serverSettingsLayerTest({
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: true,
        defaultProjectScripts: [writerCheckScript("check-a")],
      });
      const infrastructureLayer = Layer.mergeAll(
        ThreadBackgroundLiveness.layer,
        ThreadPlanProgress.layer,
        restartContinuationsLayer,
        OrchestrationEventStoreLive,
        OrchestrationCommandReceiptRepositoryLive,
        RepositoryIdentityResolver.layer,
        ProjectionTurnRepositoryLive,
        ProjectionThreadActivityRepositoryLive,
        ProjectionThreadMessageRepositoryLive,
        mockVcsLayer,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("env-skill-writer-fence"),
            serverVersion: "0.0.0",
          } as never),
        }),
        settingsLayer,
      ).pipe(
        Layer.provideMerge(persistence),
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const orchestrationBase = Layer.mergeAll(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
        ),
        OrchestrationProjectionSnapshotQueryLive,
      ).pipe(Layer.provideMerge(infrastructureLayer));

      return makeSelectedChecksLayer(options.runScript).pipe(Layer.provideMerge(orchestrationBase));
    };

    const appendAssistantMessage = (
      engine: OrchestrationEngineShape,
      threadId: ThreadId,
      messageId: MessageId,
      commandPrefix: string,
    ) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: skillWriterCommandId(`${commandPrefix}-delta`),
          threadId,
          messageId,
          delta: "assistant",
          createdAt: SKILL_WRITER_NOW,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: skillWriterCommandId(`${commandPrefix}-complete`),
          threadId,
          messageId,
          createdAt: SKILL_WRITER_NOW,
        });
      });

    const eventTypesForCommand = (
      engine: OrchestrationEngineShape,
      commandId: CommandId,
      fromSequence = 0,
    ) =>
      Stream.runCollect(engine.readEvents(fromSequence)).pipe(
        Effect.map((chunk) =>
          Array.from(chunk)
            .filter((event) => event.commandId === commandId)
            .map((event) => event.type),
        ),
      );

    const seedProjectThread = (
      engine: OrchestrationEngineShape,
      prefix: string,
      projectId: ProjectId,
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId(`${prefix}-project`),
          projectId,
          title: "Writer fence project",
          workspaceRoot: `/tmp/${prefix}`,
          createWorkspaceRootIfMissing: true,
          createdAt: SKILL_WRITER_NOW,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: skillWriterCommandId(`${prefix}-thread`),
          threadId,
          projectId,
          title: "Writer fence thread",
          modelSelection: { instanceId: skillWriterProviderId, model: "gpt-5.4" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: SKILL_WRITER_NOW,
        });
      });

    const selectedCheckReceipt = (
      threadId: ThreadId,
      projectId: ProjectId,
    ): SelectedCheckReceipt => {
      const treeOid = "c".repeat(40);
      return {
        schemaVersion: 1,
        threadId,
        attemptId: "attempt-writer-fence",
        revision: 0,
        threadAnchorSequence: 2,
        context: {
          projectId,
          workspaceRoot: `/tmp/${projectId}`,
          worktreePath: null,
          cwd: `/tmp/${threadId}`,
          shell: "/bin/bash",
          envSha256: "a".repeat(64),
        },
        planned: [
          {
            scriptId: "lint",
            scriptName: "Lint",
            commandSha256: "b".repeat(64),
            timeoutMs: 60_000,
          },
        ],
        environment: {
          environmentId: EnvironmentId.make("env-writer-fence"),
          platform: "linux",
          arch: "x64",
          osRelease: "6.0",
          serverVersion: "0.0.0",
          nodeVersion: "v24.0.0",
        },
        tree: {
          atStart: { kind: "complete", treeOid },
          atEnd: { kind: "complete", treeOid },
          repoAtStart: null,
          repoAtEnd: null,
        },
        phase: "completed",
        checks: [
          {
            scriptId: "lint",
            status: "passed",
            startedAt: SKILL_WRITER_NOW,
            endedAt: SKILL_WRITER_NOW,
            exitCode: 0,
            exitedBy: "exit",
            exitSignal: null,
            pgid: 42_000,
            group: "empty",
            stdout: { bytes: 1, sha256: "d".repeat(64) },
            stderr: { bytes: 0, sha256: "e".repeat(64) },
            failure: null,
          },
        ],
        startedAt: SKILL_WRITER_NOW,
        endedAt: SKILL_WRITER_NOW,
        error: null,
      };
    };

    const expectFenceWriterInvalidatesToken = (
      dispatch: Effect.Effect<{ sequence: number }, unknown, never>,
      projectId: ProjectId,
      otherProjectId: ProjectId,
      token: ProjectSkillMutationToken,
      otherToken: ProjectSkillMutationToken,
    ) =>
      Effect.gen(function* () {
        const fence = yield* ProjectSkillMutationFence;
        yield* dispatch;
        expect(fence.holds(token)).toBe(false);
        expect(fence.holds(otherToken)).toBe(true);
      });

    effectIt.effect(
      "fences standalone user thread.message-sent without turn-start-requested",
      () => {
        const projectId = asProjectId("project-writer-user-message");
        const otherProjectId = asProjectId("project-writer-user-message-other");
        const threadId = ThreadId.make("thread-writer-user-message");
        const commandId = skillWriterCommandId("writer-user-message");
        return Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const fence = yield* ProjectSkillMutationFence;
          const head = yield* engine.latestSequence;
          yield* seedProjectThread(engine, "writer-user-message", projectId, threadId);
          yield* engine.dispatch({
            type: "project.create",
            commandId: skillWriterCommandId("writer-user-message-other-project"),
            projectId: otherProjectId,
            title: "Other",
            workspaceRoot: "/tmp/other-user-message",
            createWorkspaceRootIfMissing: true,
            createdAt: SKILL_WRITER_NOW,
          });
          const token = fence.acquire(projectId);
          const otherToken = fence.acquire(otherProjectId);
          expect(token).toBeDefined();
          expect(otherToken).toBeDefined();
          yield* expectFenceWriterInvalidatesToken(
            engine.dispatch({
              type: "thread.message.user.append",
              commandId,
              threadId,
              message: {
                messageId: asMessageId("msg-writer-user-only"),
                text: "user only",
                attachments: [],
              },
              createdAt: SKILL_WRITER_NOW,
            }),
            projectId,
            otherProjectId,
            token!,
            otherToken!,
          );
          const types = yield* eventTypesForCommand(engine, commandId, head);
          expect(types).toEqual(["thread.message-sent"]);
        }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
      },
    );

    effectIt.effect("fences thread.turn-start-requested from turn.start", () => {
      const projectId = asProjectId("project-writer-turn-start");
      const otherProjectId = asProjectId("project-writer-turn-start-other");
      const threadId = ThreadId.make("thread-writer-turn-start");
      const commandId = skillWriterCommandId("writer-turn-start-cmd");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        const head = yield* engine.latestSequence;
        yield* seedProjectThread(engine, "writer-turn-start", projectId, threadId);
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId("writer-turn-start-other-project"),
          projectId: otherProjectId,
          title: "Other",
          workspaceRoot: "/tmp/other-turn-start",
          createWorkspaceRootIfMissing: true,
          createdAt: SKILL_WRITER_NOW,
        });
        const token = fence.acquire(projectId);
        const otherToken = fence.acquire(otherProjectId);
        expect(token).toBeDefined();
        expect(otherToken).toBeDefined();
        yield* expectFenceWriterInvalidatesToken(
          engine.dispatch({
            type: "thread.turn.start",
            commandId,
            threadId,
            message: {
              messageId: asMessageId("msg-writer-turn-start"),
              role: "user",
              text: "go",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: SKILL_WRITER_NOW,
          }),
          projectId,
          otherProjectId,
          token!,
          otherToken!,
        );
        const types = yield* eventTypesForCommand(engine, commandId, head);
        expect(types).toContain("thread.turn-start-requested");
        expect(types).toContain("thread.message-sent");
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect("does not fence assistant thread.message-sent", () => {
      const projectId = asProjectId("project-writer-assistant");
      const threadId = ThreadId.make("thread-writer-assistant");
      const messageId = MessageId.make("msg-writer-assistant");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        yield* seedProjectThread(engine, "writer-assistant", projectId, threadId);
        const token = fence.acquire(projectId);
        expect(token).toBeDefined();
        yield* appendAssistantMessage(engine, threadId, messageId, "writer-assistant");
        expect(fence.holds(token!)).toBe(true);
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect("fences thread.user-input-response-requested", () => {
      const projectId = asProjectId("project-writer-user-input");
      const otherProjectId = asProjectId("project-writer-user-input-other");
      const threadId = ThreadId.make("thread-writer-user-input");
      const requestId = ApprovalRequestId.make("user-input-req-writer-fence");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        yield* seedProjectThread(engine, "writer-user-input", projectId, threadId);
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId("writer-user-input-other-project"),
          projectId: otherProjectId,
          title: "Other",
          workspaceRoot: "/tmp/other-user-input",
          createdAt: SKILL_WRITER_NOW,
        });
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: skillWriterCommandId("writer-user-input-question"),
          threadId,
          activity: {
            id: EventId.make("act-user-input-writer-fence"),
            kind: "user-input.requested",
            summary: "Need input",
            payload: {
              requestId,
              questions: [
                {
                  id: "0",
                  header: "Question",
                  question: "Which package manager?",
                  options: [{ label: "pnpm", description: "" }],
                },
              ],
            },
            tone: "info",
            turnId: null,
            createdAt: SKILL_WRITER_NOW,
          },
          createdAt: SKILL_WRITER_NOW,
        });
        const token = fence.acquire(projectId);
        const otherToken = fence.acquire(otherProjectId);
        expect(token).toBeDefined();
        expect(otherToken).toBeDefined();
        const respondCommandId = skillWriterCommandId("writer-user-input-respond");
        const head = yield* engine.latestSequence;
        yield* expectFenceWriterInvalidatesToken(
          engine.dispatch({
            type: "thread.user-input.respond",
            commandId: respondCommandId,
            threadId,
            requestId,
            answers: { "0": "pnpm" },
            attachmentsByQuestionId: {},
            createdAt: SKILL_WRITER_NOW,
          }),
          projectId,
          otherProjectId,
          token!,
          otherToken!,
        );
        const types = yield* eventTypesForCommand(engine, respondCommandId, head);
        expect(types).toContain("thread.user-input-response-requested");
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect("fences thread.approval-response-requested", () => {
      const projectId = asProjectId("project-writer-approval");
      const otherProjectId = asProjectId("project-writer-approval-other");
      const threadId = ThreadId.make("thread-writer-approval");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        yield* seedProjectThread(engine, "writer-approval", projectId, threadId);
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId("writer-approval-other-project"),
          projectId: otherProjectId,
          title: "Other",
          workspaceRoot: "/tmp/other-approval",
          createdAt: SKILL_WRITER_NOW,
        });
        const token = fence.acquire(projectId);
        const otherToken = fence.acquire(otherProjectId);
        expect(token).toBeDefined();
        expect(otherToken).toBeDefined();
        const respondCommandId = skillWriterCommandId("writer-approval-respond");
        const head = yield* engine.latestSequence;
        yield* expectFenceWriterInvalidatesToken(
          engine.dispatch({
            type: "thread.approval.respond",
            commandId: respondCommandId,
            threadId,
            requestId: ApprovalRequestId.make("approval-writer-fence"),
            decision: "accept",
            createdAt: SKILL_WRITER_NOW,
          }),
          projectId,
          otherProjectId,
          token!,
          otherToken!,
        );
        const types = yield* eventTypesForCommand(engine, respondCommandId, head);
        expect(types).toEqual(["thread.approval-response-requested"]);
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect("fences thread.checkpoint-revert-requested", () => {
      const projectId = asProjectId("project-writer-checkpoint");
      const otherProjectId = asProjectId("project-writer-checkpoint-other");
      const threadId = ThreadId.make("thread-writer-checkpoint");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        yield* seedProjectThread(engine, "writer-checkpoint", projectId, threadId);
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId("writer-checkpoint-other-project"),
          projectId: otherProjectId,
          title: "Other",
          workspaceRoot: "/tmp/other-checkpoint",
          createdAt: SKILL_WRITER_NOW,
        });
        const token = fence.acquire(projectId);
        const otherToken = fence.acquire(otherProjectId);
        expect(token).toBeDefined();
        expect(otherToken).toBeDefined();
        const revertCommandId = skillWriterCommandId("writer-checkpoint-revert");
        const head = yield* engine.latestSequence;
        yield* expectFenceWriterInvalidatesToken(
          engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: revertCommandId,
            threadId,
            turnCount: 0,
            createdAt: SKILL_WRITER_NOW,
          }),
          projectId,
          otherProjectId,
          token!,
          otherToken!,
        );
        const types = yield* eventTypesForCommand(engine, revertCommandId, head);
        expect(types).toEqual(["thread.checkpoint-revert-requested"]);
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect(
      "ignores unrelated and non-prefix selected-check activity appends and assistant messages",
      () => {
        const projectId = asProjectId("project-writer-selected-checks");
        const threadId = ThreadId.make("thread-writer-selected-checks");
        const receipt = selectedCheckReceipt(threadId, projectId);
        return Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const fence = yield* ProjectSkillMutationFence;
          yield* seedProjectThread(engine, "writer-selected-checks", projectId, threadId);
          const token = fence.acquire(projectId);
          expect(token).toBeDefined();
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: skillWriterCommandId("writer-unrelated-activity"),
            threadId,
            activity: {
              id: EventId.make("act-unrelated-writer-fence"),
              kind: "tool.completed",
              summary: "Unrelated",
              payload: {},
              tone: "info",
              turnId: null,
              createdAt: SKILL_WRITER_NOW,
            },
            createdAt: SKILL_WRITER_NOW,
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: skillWriterCommandId("client-forged-selected-check"),
            threadId,
            activity: {
              id: EventId.make(selectedCheckReceiptId(threadId)),
              kind: SELECTED_CHECK_RECEIPT_KIND,
              summary: "Forged",
              payload: receipt,
              tone: "info",
              turnId: null,
              createdAt: SKILL_WRITER_NOW,
            },
            createdAt: SKILL_WRITER_NOW,
          });
          yield* appendAssistantMessage(
            engine,
            threadId,
            MessageId.make("msg-selected-checks-assistant"),
            "writer-selected-checks-assistant",
          );
          expect(fence.holds(token!)).toBe(true);
        }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
      },
    );

    effectIt.effect("fences SelectedChecks.run writeRecord through the real engine", () => {
      const projectId = asProjectId("project-writer-selected-checks-run");
      const otherProjectId = asProjectId("project-writer-selected-checks-run-other");
      const threadId = ThreadId.make("thread-writer-selected-checks-run");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        const selectedChecks = yield* SelectedChecks.SelectedChecks;
        yield* selectedChecks.reconcile;
        yield* seedProjectThread(engine, "writer-selected-checks-run", projectId, threadId);
        yield* engine.dispatch({
          type: "project.create",
          commandId: skillWriterCommandId("writer-selected-checks-run-other"),
          projectId: otherProjectId,
          title: "Other",
          workspaceRoot: "/tmp/other-selected-checks-run",
          createWorkspaceRootIfMissing: true,
          createdAt: SKILL_WRITER_NOW,
        });
        const token = fence.acquire(projectId);
        const otherToken = fence.acquire(otherProjectId);
        expect(token).toBeDefined();
        expect(otherToken).toBeDefined();
        const head = yield* engine.latestSequence;
        yield* selectedChecks.run({ threadId, scriptIds: ["check-a"] });
        expect(fence.holds(token!)).toBe(false);
        expect(fence.holds(otherToken!)).toBe(true);
        const events = yield* Stream.runCollect(engine.readEvents(head)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(
          events.some(
            (event) =>
              event.type === "thread.activity-appended" &&
              String(event.commandId).startsWith("server:selected-checks:"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(makeSkillWriterFenceLayer()));
    });

    effectIt.effect(
      "parks SelectedChecks publication after commit with receipt durable while pending",
      () => {
        const projectId = asProjectId("project-writer-selected-checks-park");
        const otherProjectId = asProjectId("project-writer-selected-checks-park-other");
        const threadId = ThreadId.make("thread-writer-selected-checks-park");
        const gate: PostCommitGate = { current: undefined };
        return Effect.gen(function* () {
          const releaseScript = yield* Deferred.make<void>();
          const directory = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(
              NodePath.join(NodeOS.tmpdir(), "t3-skill-writer-selected-checks-park-"),
            ),
          );
          const databasePath = NodePath.join(directory, "state.sqlite");
          const layer = makeSkillWriterFenceLayer({
            databasePath,
            gate,
            runScript: () =>
              Effect.flatMap(Deferred.await(releaseScript), () =>
                Effect.succeed(defaultPassedScriptResult()),
              ),
          });
          return yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const fence = yield* ProjectSkillMutationFence;
            const sql = yield* SqlClient.SqlClient;
            const selectedChecks = yield* SelectedChecks.SelectedChecks;
            yield* selectedChecks.reconcile;
            yield* seedProjectThread(engine, "writer-selected-checks-park", projectId, threadId);
            yield* engine.dispatch({
              type: "project.create",
              commandId: skillWriterCommandId("writer-selected-checks-park-other"),
              projectId: otherProjectId,
              title: "Other",
              workspaceRoot: "/tmp/other-selected-checks-park",
              createWorkspaceRootIfMissing: true,
              createdAt: SKILL_WRITER_NOW,
            });
            const head = yield* engine.latestSequence;
            const token = fence.acquire(projectId);
            const otherToken = fence.acquire(otherProjectId);
            expect(token).toBeDefined();
            expect(otherToken).toBeDefined();
            const entered = yield* Deferred.make<void>();
            const releasePublication = yield* Deferred.make<void>();
            gate.current = { entered, release: releasePublication };
            const runFiber = yield* selectedChecks
              .run({ threadId, scriptIds: ["check-a"] })
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            expect(yield* engine.latestSequence).toBe(head);
            const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM orchestration_events
            WHERE sequence > ${head}
              AND event_type = 'thread.activity-appended'
          `;
            expect(rows[0]?.count).toBeGreaterThan(0);
            expect(fence.snapshotCounters().projectPending(projectId)).toBe(1);
            expect(fence.acquire(projectId)).toBeUndefined();
            expect(fence.holds(token!)).toBe(false);
            expect(fence.holds(otherToken!)).toBe(true);
            yield* Deferred.succeed(releasePublication, undefined);
            yield* Deferred.succeed(releaseScript, undefined);
            yield* Fiber.join(runFiber);
            expect(yield* engine.latestSequence).toBeGreaterThan(head);
            expect(fence.snapshotCounters().projectPending(projectId)).toBe(0);
            expect(fence.acquire(projectId)).toBeDefined();
          }).pipe(Effect.provide(layer));
        });
      },
    );

    effectIt.effect(
      "keeps project pending through post-commit publication and blocks acquire until release",
      () => {
        const gate: PostCommitGate = { current: undefined };
        return Effect.gen(function* () {
          const directory = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-writer-postcommit-")),
          );
          const databasePath = NodePath.join(directory, "state.sqlite");
          const layer = makeSkillWriterFenceLayer({ databasePath, gate });
          return yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const fence = yield* ProjectSkillMutationFence;
            const sql = yield* SqlClient.SqlClient;
            const projectId = asProjectId("project-writer-postcommit");
            const otherProjectId = asProjectId("project-writer-postcommit-other");
            const threadId = ThreadId.make("thread-writer-postcommit");
            yield* seedProjectThread(engine, "writer-postcommit", projectId, threadId);
            yield* engine.dispatch({
              type: "project.create",
              commandId: skillWriterCommandId("writer-postcommit-other-project"),
              projectId: otherProjectId,
              title: "Other",
              workspaceRoot: "/tmp/other-postcommit",
              createWorkspaceRootIfMissing: true,
              createdAt: SKILL_WRITER_NOW,
            });
            const head = yield* engine.latestSequence;
            const token = fence.acquire(projectId);
            const otherToken = fence.acquire(otherProjectId);
            expect(token).toBeDefined();
            expect(otherToken).toBeDefined();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            gate.current = { entered, release };
            const dispatch = yield* engine
              .dispatch({
                type: "thread.message.user.append",
                commandId: skillWriterCommandId("writer-postcommit-user"),
                threadId,
                message: {
                  messageId: asMessageId("msg-writer-postcommit"),
                  text: "park",
                  attachments: [],
                },
                createdAt: SKILL_WRITER_NOW,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const tail = yield* engine.latestSequence;
            expect(tail).toBe(head);
            const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count" FROM orchestration_events WHERE sequence > ${head}
          `;
            expect(rows[0]?.count).toBeGreaterThan(0);
            expect(fence.snapshotCounters().projectPending(projectId)).toBe(1);
            expect(fence.acquire(projectId)).toBeUndefined();
            expect(fence.holds(token!)).toBe(false);
            expect(fence.holds(otherToken!)).toBe(true);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(dispatch);
            expect(yield* engine.latestSequence).toBeGreaterThan(head);
            expect(fence.snapshotCounters().projectPending(projectId)).toBe(0);
            expect(fence.acquire(projectId)).toBeDefined();
          }).pipe(Effect.provide(layer));
        });
      },
    );
  });
});
