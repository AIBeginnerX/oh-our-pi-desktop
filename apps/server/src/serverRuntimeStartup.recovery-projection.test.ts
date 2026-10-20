import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RESTART_CONTINUATION_COMMAND_PREFIX,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyThreadDetailEvent } from "../../../packages/client-runtime/src/state/threadReducer.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import { ServerConfig } from "./config.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "./orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "./orchestration/projector.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "./persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns.ts";
import * as ProjectMemorySendGate from "./memory/ProjectMemorySendGate.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { layer as projectMemorySendLedgerLayer } from "./persistence/ProjectMemorySendLedger.ts";
import * as ProviderSafetyObservations from "./persistence/ProviderSafetyObservations.ts";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "./persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionNotFoundError } from "./provider/Errors.ts";
import {
  layer as restartContinuationsLayer,
  RestartContinuations,
} from "./restartContinuations.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("recovery-projection-project");
const threadId = ThreadId.make("recovery-projection-thread");
const oldTurnId = TurnId.make("recovery-projection-old-turn");
const claudeInstanceId = ProviderInstanceId.make("claude-custom-instance");
const idsFor = (name: string) => ({
  projectId: ProjectId.make(`recovery-${name}-project`),
  threadId: ThreadId.make(`recovery-${name}-thread`),
  oldTurnId: TurnId.make(`recovery-${name}-old-turn`),
});
const fixtureThreadIds = [
  threadId,
  ...[
    "project-opt-in",
    "failed-send",
    "pending-approval",
    "repeat-preparation",
    "other-provider",
    "same-id",
  ].map((name) => idsFor(name).threadId),
];
// Every provider driver crosses the same restart-preparation boundary, so the
// prepare command carries the existing prefix for all of them.
const restartProviders = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
] as const;

// Must equal INTERRUPTED_WORK_ERROR in serverRuntimeStartup.ts: the synchronous
// conservative settlement for an interrupted turn.
const INTERRUPTED_WORK_ERROR =
  "The server restarted while a tool was running or waiting for you, so its result is unknown. Check the workspace, then send a message to continue.";

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    // Merged so the ingestion-based test shares the same liveness and progress
    // instances with the engine and the snapshot query.
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    // Merged so startup's reconcile fences and pending-turn reads ride the
    // same continuation instance the live engine observes and the same
    // in-memory SQLite client the rest of this layer builds on.
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    // Merged so the replay test can read the events that were actually stored.
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProviderSafetyObservations.layer),
    Layer.provideMerge(
      ProjectMemorySendGate.layer.pipe(Layer.provideMerge(projectMemorySendLedgerLayer)),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-recovery-projection-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedRunningClaude = (
  ids = { projectId, threadId, oldTurnId },
  providerName = "claudeAgent",
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const modelSelection = { instanceId: claudeInstanceId, model: "claude-opus-5" };
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`${ids.projectId}-create`),
      projectId: ids.projectId,
      title: "Recovery projection",
      workspaceRoot: `/tmp/${ids.projectId}`,
      defaultModelSelection: modelSelection,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${ids.threadId}-create`),
      threadId: ids.threadId,
      projectId: ids.projectId,
      title: "Recovery projection",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${ids.threadId}-running`),
      threadId: ids.threadId,
      session: {
        threadId: ids.threadId,
        status: "running",
        providerName,
        providerInstanceId: claudeInstanceId,
        runtimeMode: "full-access",
        activeTurnId: ids.oldTurnId,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

const turnStates = (forThreadId = threadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly turnId: string; readonly state: string }>`
    SELECT turn_id AS "turnId", state FROM projection_turns
    WHERE thread_id = ${forThreadId} ORDER BY turn_id
  `;
  });

const makeDirectory = (
  ids = { projectId, threadId, oldTurnId },
  provider = "claudeAgent",
  withUpdateMarker = true,
) => {
  let binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
    threadId: ids.threadId,
    provider: ProviderDriverKind.make(provider),
    providerInstanceId: claudeInstanceId,
    status: "running",
    resumeCursor: { sessionId: "resumable-provider-session" },
    runtimePayload: {
      activeTurnId: ids.oldTurnId,
      ...(withUpdateMarker ? { continueAfterServerUpdate: ids.oldTurnId } : {}),
    },
    lastSeenAt: createdAt,
  };
  const directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"] = {
    getBinding: (requestedThreadId) =>
      Effect.succeed(requestedThreadId === ids.threadId ? Option.some(binding) : Option.none()),
    upsert: (next) =>
      Effect.sync(() => {
        binding = { ...next, lastSeenAt: createdAt };
      }),
    upsertIf: (next, when) =>
      Effect.sync(() => {
        if (!when()) {
          return false;
        }
        binding = { ...next, lastSeenAt: createdAt };
        return true;
      }),
    upsertIfCurrent: (next, when) =>
      Effect.sync(() => {
        const result = when(
          next.threadId === binding.threadId ? Option.some(binding) : Option.none(),
        );
        if (!result) {
          return false;
        }
        const mergedRuntimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"] =
          (() => {
            const prev = binding.runtimePayload;
            const incoming = next.runtimePayload;
            if (incoming === undefined) {
              return prev;
            }
            if (
              prev !== undefined &&
              typeof prev === "object" &&
              prev !== null &&
              typeof incoming === "object" &&
              incoming !== null &&
              !Array.isArray(prev) &&
              !Array.isArray(incoming)
            ) {
              return { ...prev, ...incoming };
            }
            return incoming;
          })();
        binding = {
          ...binding,
          ...next,
          lastSeenAt: createdAt,
          runtimePayload: mergedRuntimePayload,
        };
        return true;
      }),
    listBindings: () => Effect.succeed([binding]),
    listThreadIds: () => Effect.die("unused"),
    recordImportedTranscript: () => Effect.die("unused"),
    getProvider: () => Effect.die("unused"),
  };
  return { directory, current: () => binding };
};

const makeProvider = (
  sendTurn: ProviderService.ProviderService["Service"]["sendTurn"],
  ownThreadId = threadId,
  streamEvents: ProviderService.ProviderService["Service"]["streamEvents"] = Stream.empty,
): ProviderService.ProviderService["Service"] => ({
  previewSubmissionRoute: () => Effect.die("unused"),
  startSession: () => Effect.die("unused"),
  sendTurn,
  compactThread: () => Effect.die("unused"),
  interruptTurn: () => Effect.die("unused"),
  respondToRequest: () => Effect.die("unused"),
  respondToUserInput: () => Effect.die("unused"),
  stopSession: () => Effect.die("unused"),
  listSessions: () =>
    Effect.succeed(
      fixtureThreadIds.filter((id) => id !== ownThreadId).map((id) => ({ threadId: id }) as never),
    ),
  getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
  assertConversationRollbackSupported: () => Effect.die("unused"),
  getInstanceInfo: () => Effect.die("unused"),
  rollbackConversation: () => Effect.die("unused"),
  uploadFeedback: () => Effect.die("unused"),
  streamEvents,
});

// Ingestion only reads the checkpoint store for diff events, which these flows
// never produce.
const unusedCheckpointStore: CheckpointStore.CheckpointStore["Service"] = {
  isGitRepository: () => Effect.succeed(false),
  captureCheckpoint: () => Effect.die("unused"),
  hasCheckpointRef: () => Effect.die("unused"),
  restoreCheckpoint: () => Effect.die("unused"),
  diffCheckpoints: () => Effect.die("unused"),
  deleteCheckpointRefs: () => Effect.die("unused"),
};

const makeIngestionLayer = (provider: ProviderService.ProviderService["Service"]) =>
  ProviderRuntimeIngestionLive.pipe(
    Layer.provide(ProjectionTurnRepositoryLive),
    Layer.provide(ProjectionThreadMessageRepositoryLive),
    Layer.provide(ProjectionThreadProposedPlanRepositoryLive),
    Layer.provide(ProjectionThreadActivityRepositoryLive),
    Layer.provide(Layer.succeed(ProviderService.ProviderService, provider)),
    Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
    Layer.provide(Layer.succeed(CheckpointStore.CheckpointStore, unusedCheckpointStore)),
  );

const makeRuntimeEventStream = () =>
  Effect.gen(function* () {
    const published = yield* PubSub.unbounded<{
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly enqueued?: Deferred.Deferred<void>;
    }>();
    const streamEvents: ProviderService.ProviderService["Service"]["streamEvents"] =
      Stream.fromPubSub(published).pipe(
        Stream.flatMap(({ events, enqueued }) =>
          Stream.concat(
            Stream.fromIterable(events),
            enqueued
              ? Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain)
              : Stream.empty,
          ),
        ),
      );
    const emitAndDrain = (
      ingestion: ProviderRuntimeIngestionService["Service"],
      events: ReadonlyArray<ProviderRuntimeEvent>,
    ) =>
      Effect.gen(function* () {
        const enqueued = yield* Deferred.make<void>();
        yield* PubSub.publish(published, { events, enqueued });
        // The evidence must come from real ingestion work: wait until the
        // runtime events are enqueued, then until the worker queue is drained.
        yield* Deferred.await(enqueued);
        yield* ingestion.drain;
      });
    return { streamEvents, emitAndDrain };
  });

// A Deferred waiter resumes inline on the fiber that completes it, so a
// signal fired inside the adapter always resolves before the parked send
// fiber's record call. Tests that read token evidence therefore wrap record
// with this receipt: it is completed by the real service the moment after
// record returns, with no polling in between.
const recordReceipt = (real: RestartContinuations["Service"]) => {
  const evidenceRecorded = Deferred.makeUnsafe<void>();
  return {
    continuations: {
      ...real,
      record: (token, evidence) => {
        real.record(token, evidence);
        Deferred.doneUnsafe(evidenceRecorded, Effect.void);
      },
    } satisfies RestartContinuations["Service"],
    evidenceRecorded,
  };
};

const reconcile = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  provider: ProviderService.ProviderService["Service"],
  continueAfterRestart = false,
  continuations?: RestartContinuations["Service"],
) => {
  const provided = ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
    Effect.provideService(ProviderService.ProviderService, provider),
  );
  return (
    continuations === undefined
      ? provided
      : Effect.provideService(provided, RestartContinuations, continuations)
  ).pipe(
    Effect.provide(
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: continueAfterRestart }),
    ),
  );
};

engineLayer("Provider startup recovery through the live projection", (it) => {
  it.effect("interrupts the old turn before sending the recovery prompt", () =>
    Effect.gen(function* () {
      yield* seedRunningClaude();
      const sql = yield* SqlClient.SqlClient;
      const seenAtSend = yield* Deferred.make<ReadonlyArray<{ turnId: string; state: string }>>();
      const { directory } = makeDirectory();
      const provider = makeProvider((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(
            seenAtSend,
            yield* turnStates().pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
          );
          assert.deepEqual(input, {
            threadId,
            input: "Continue where you left off.",
            interactionMode: "default",
          });
          return { threadId, turnId: TurnId.make("recovery-projection-new-turn") };
        }),
      );

      yield* reconcile(directory, provider);
      assert.deepEqual(yield* Deferred.await(seenAtSend), [
        { turnId: oldTurnId, state: "interrupted" },
      ]);
      const query = yield* ProjectionSnapshotQuery;
      const thread = (yield* query.getCommandReadModel()).threads.find(
        (item) => item.id === threadId,
      );
      assert.strictEqual(thread?.latestTurn?.state, "interrupted");

      // Simulate provider session.started arriving before the recovery prompt
      // yields a new turn, then that distinct turn starting and completing.
      const engine = yield* OrchestrationEngineService;
      const setSession = (
        id: string,
        status: "ready" | "running" | "stopped",
        activeTurnId: TurnId | null,
      ) =>
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(id),
          threadId,
          session: {
            threadId,
            status,
            providerName: "claudeAgent",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });
      yield* setSession("recovery-provider-ready", "ready", null);
      assert.deepEqual(yield* turnStates(), [{ turnId: oldTurnId, state: "interrupted" }]);
      const newTurnId = TurnId.make("recovery-projection-new-turn");
      yield* setSession("recovery-new-running", "running", newTurnId);
      assert.deepEqual(yield* turnStates(), [
        { turnId: newTurnId, state: "running" },
        { turnId: oldTurnId, state: "interrupted" },
      ]);
      yield* setSession("recovery-new-ready", "ready", null);
      assert.deepEqual(yield* turnStates(), [
        { turnId: newTurnId, state: "completed" },
        { turnId: oldTurnId, state: "interrupted" },
      ]);
      const stoppedTurnId = TurnId.make("recovery-projection-stopped-turn");
      yield* setSession("recovery-stop-running", "running", stoppedTurnId);
      yield* setSession("recovery-stop-settled", "stopped", null);
      assert.deepEqual(yield* turnStates(), [
        { turnId: newTurnId, state: "completed" },
        { turnId: oldTurnId, state: "interrupted" },
        { turnId: stoppedTurnId, state: "interrupted" },
      ]);
    }),
  );

  it.effect("interrupts a Claude orphan from project opt-in without an update marker", () =>
    Effect.gen(function* () {
      const ids = idsFor("project-opt-in");
      yield* seedRunningClaude(ids);
      const sql = yield* SqlClient.SqlClient;
      const { directory, current } = makeDirectory(ids, "claudeAgent", false);
      assert.deepEqual(current().runtimePayload, { activeTurnId: ids.oldTurnId });
      const seenAtSend = yield* Deferred.make<ReadonlyArray<{ turnId: string; state: string }>>();
      const provider = makeProvider(
        (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(
              seenAtSend,
              yield* turnStates(ids.threadId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.orDie,
              ),
            );
            assert.deepEqual(input, {
              threadId: ids.threadId,
              input: "Continue where you left off.",
              interactionMode: "default",
            });
            return { threadId: ids.threadId, turnId: TurnId.make("project-opt-in-new-turn") };
          }),
        ids.threadId,
      );
      yield* reconcile(directory, provider, true);
      assert.deepEqual(yield* Deferred.await(seenAtSend), [
        { turnId: ids.oldTurnId, state: "interrupted" },
      ]);
    }),
  );

  it.effect("holds the interrupted old turn when the continuation send fails", () =>
    Effect.gen(function* () {
      const ids = idsFor("failed-send");
      yield* seedRunningClaude(ids);
      const { directory, current } = makeDirectory(ids);
      let sends = 0;
      const real = yield* RestartContinuations;
      const { continuations, evidenceRecorded } = recordReceipt(real);
      const provider = makeProvider(
        () =>
          Effect.gen(function* () {
            sends += 1;
            return yield* new ProviderSessionNotFoundError({ threadId: ids.threadId });
          }),
        ids.threadId,
      );
      yield* reconcile(directory, provider, false, continuations);
      yield* Deferred.await(evidenceRecorded);
      assert.strictEqual(sends, 1);
      // A failed parked continuation holds: startup writes nothing, so the
      // prepared starting state and the interrupted old turn both survive for
      // the next restart's synchronous re-check.
      assert.deepEqual(yield* turnStates(ids.threadId), [
        { turnId: ids.oldTurnId, state: "interrupted" },
      ]);
      const session = (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).threads.find(
        (thread) => thread.id === ids.threadId,
      )?.session;
      assert.strictEqual(session?.status, "starting");
      assert.strictEqual(current().status, "starting");
      assert.deepEqual(current().runtimePayload, {
        activeTurnId: null,
        continueAfterServerUpdate: ids.oldTurnId,
        continueAfterServerUpdatePrepared: true,
      });
      assert.deepEqual(real.current(ids.threadId)?.evidence, { kind: "unverified" });
    }),
  );

  it.effect("does not send when an approval is pending", () =>
    Effect.gen(function* () {
      const ids = idsFor("pending-approval");
      yield* seedRunningClaude(ids);
      const liveEngine = yield* OrchestrationEngineService;
      yield* liveEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("recovery-pending-approval-activity"),
        threadId: ids.threadId,
        activity: {
          id: EventId.make("recovery-pending-approval-id"),
          tone: "info",
          kind: "approval.requested",
          summary: "Approval required",
          payload: { requestId: "recovery-pending-approval-request" },
          turnId: ids.oldTurnId,
          createdAt,
        },
        createdAt,
      });
      const { directory } = makeDirectory(ids);
      let sends = 0;
      const provider = makeProvider(
        () =>
          Effect.sync(() => {
            sends += 1;
            return { threadId: ids.threadId, turnId: TurnId.make("unexpected") };
          }),
        ids.threadId,
      );
      yield* reconcile(directory, provider);
      assert.strictEqual(sends, 0);
      assert.deepEqual(yield* turnStates(ids.threadId), [
        { turnId: ids.oldTurnId, state: "error" },
      ]);
    }),
  );

  it.effect("repeated preparation may resend without completing the old turn", () =>
    Effect.gen(function* () {
      const ids = idsFor("repeat-preparation");
      yield* seedRunningClaude(ids);
      const { directory } = makeDirectory(ids);
      const sends = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let sendCount = 0;
      const provider = makeProvider(
        () =>
          Effect.gen(function* () {
            sendCount += 1;
            if (sendCount === 2) yield* Deferred.succeed(sends, undefined);
            yield* Deferred.await(release);
            return { threadId: ids.threadId, turnId: TurnId.make(`repeat-new-${sendCount}`) };
          }),
        ids.threadId,
      );
      yield* reconcile(directory, provider);
      yield* reconcile(directory, provider);
      yield* Deferred.await(sends);
      assert.strictEqual(sendCount, 2);
      assert.deepEqual(yield* turnStates(ids.threadId), [
        { turnId: ids.oldTurnId, state: "interrupted" },
      ]);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("interrupts the prepared orphan before the continuation send for every provider", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const liveEngine = yield* OrchestrationEngineService;
      // Captured outside the send callbacks so the forked send fiber carries no
      // service requirement of its own.
      const projectionQuery = yield* ProjectionSnapshotQuery;
      const settledSends = new Set<ThreadId>();
      for (const providerName of restartProviders) {
        const ids = idsFor(`six-${providerName}`);
        yield* seedRunningClaude(ids, providerName);
        const { directory } = makeDirectory(ids, providerName);
        const seenAtSend = yield* Deferred.make<ReadonlyArray<{ turnId: string; state: string }>>();
        const preparationIds: string[] = [];
        const engine = {
          ...liveEngine,
          dispatch: (command: Parameters<typeof liveEngine.dispatch>[0]) => {
            if (
              command.type === "thread.session.set" &&
              command.threadId === ids.threadId &&
              command.session.status === "starting"
            ) {
              preparationIds.push(command.commandId);
            }
            return liveEngine.dispatch(command);
          },
        };
        const provider = {
          ...makeProvider(
            (input) =>
              Effect.gen(function* () {
                const rows = yield* turnStates(ids.threadId).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.orDie,
                );
                // Before the continuation prompt is forked, the old turn must
                // already read as interrupted from the command model too.
                const model = yield* projectionQuery.getCommandReadModel().pipe(Effect.orDie);
                const thread = model.threads.find((item) => item.id === ids.threadId);
                assert.strictEqual(thread?.latestTurn?.turnId, ids.oldTurnId);
                assert.strictEqual(thread?.latestTurn?.state, "interrupted");
                assert.deepEqual(input, {
                  threadId: ids.threadId,
                  input: "Continue where you left off.",
                  interactionMode: "default",
                });
                yield* Deferred.succeed(seenAtSend, rows);
                return { threadId: ids.threadId, turnId: TurnId.make(`six-${providerName}-new`) };
              }),
            ids.threadId,
          ),
          // Earlier iterations' sends count as live sessions so their threads
          // are not re-orphaned by a later iteration's reconcile.
          listSessions: () =>
            Effect.succeed(
              [...fixtureThreadIds, ...settledSends]
                .filter((id) => id !== ids.threadId)
                .map((id) => ({ threadId: id }) as never),
            ),
        };
        yield* reconcile(directory, provider).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
        );
        assert.deepEqual(yield* Deferred.await(seenAtSend), [
          { turnId: ids.oldTurnId, state: "interrupted" },
        ]);
        // The captured command id is the one startup actually dispatched, and
        // it carries the existing restart-continuation prefix.
        assert.strictEqual(preparationIds.length, 1);
        assert.strictEqual(
          preparationIds[0]?.startsWith(RESTART_CONTINUATION_COMMAND_PREFIX),
          true,
        );
        settledSends.add(ids.threadId);
      }
    }),
  );

  it.effect("keeps a non-Claude orphan interrupted across ready and distinct new turns", () =>
    Effect.gen(function* () {
      const liveEngine = yield* OrchestrationEngineService;
      const setSession = (
        thread: ThreadId,
        commandId: string,
        status: "ready" | "running",
        activeTurnId: TurnId | null,
        at: string,
      ) =>
        liveEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId: thread,
          session: {
            threadId: thread,
            status,
            providerName: "codex",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId,
            lastError: null,
            updatedAt: at,
          },
          createdAt: at,
        });
      const latestTurn = (thread: ThreadId) =>
        Effect.gen(function* () {
          const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
          return model.threads.find((item) => item.id === thread)?.latestTurn ?? null;
        });

      // (a) Provider ready arrives before the distinct new turn starts.
      const readyIds = idsFor("non-claude-ready");
      yield* seedRunningClaude(readyIds, "codex");
      const { directory: readyDirectory } = makeDirectory(readyIds, "codex");
      const readyNewTurn = TurnId.make("non-claude-ready-new-turn");
      const readyProvider = makeProvider(
        () => Effect.succeed({ threadId: readyIds.threadId, turnId: readyNewTurn }),
        readyIds.threadId,
      );
      yield* reconcile(readyDirectory, readyProvider);
      assert.deepEqual(yield* turnStates(readyIds.threadId), [
        { turnId: readyIds.oldTurnId, state: "interrupted" },
      ]);
      yield* setSession(
        readyIds.threadId,
        "non-claude-ready-provider-ready",
        "ready",
        null,
        "2026-01-01T00:00:02.000Z",
      );
      assert.deepEqual(yield* turnStates(readyIds.threadId), [
        { turnId: readyIds.oldTurnId, state: "interrupted" },
      ]);
      yield* setSession(
        readyIds.threadId,
        "non-claude-ready-new-running",
        "running",
        readyNewTurn,
        "2026-01-01T00:00:03.000Z",
      );
      assert.deepEqual(yield* turnStates(readyIds.threadId), [
        { turnId: readyNewTurn, state: "running" },
        { turnId: readyIds.oldTurnId, state: "interrupted" },
      ]);
      // After a distinct start the latest turn describes the new turn, not the
      // interrupted one.
      assert.strictEqual((yield* latestTurn(readyIds.threadId))?.turnId, readyNewTurn);
      yield* setSession(
        readyIds.threadId,
        "non-claude-ready-settled",
        "ready",
        null,
        "2026-01-01T00:00:04.000Z",
      );
      assert.deepEqual(yield* turnStates(readyIds.threadId), [
        { turnId: readyNewTurn, state: "completed" },
        { turnId: readyIds.oldTurnId, state: "interrupted" },
      ]);

      // (b) Adopt-existing shape: a distinct running turn with no ready in
      // between.
      const adoptIds = idsFor("non-claude-adopt");
      yield* seedRunningClaude(adoptIds, "codex");
      const { directory: adoptDirectory } = makeDirectory(adoptIds, "codex");
      const adoptNewTurn = TurnId.make("non-claude-adopt-new-turn");
      const adoptProvider = makeProvider(
        () => Effect.succeed({ threadId: adoptIds.threadId, turnId: adoptNewTurn }),
        adoptIds.threadId,
      );
      yield* reconcile(adoptDirectory, adoptProvider);
      yield* setSession(
        adoptIds.threadId,
        "non-claude-adopt-new-running",
        "running",
        adoptNewTurn,
        "2026-01-01T00:00:02.000Z",
      );
      assert.deepEqual(yield* turnStates(adoptIds.threadId), [
        { turnId: adoptNewTurn, state: "running" },
        { turnId: adoptIds.oldTurnId, state: "interrupted" },
      ]);
      assert.strictEqual((yield* latestTurn(adoptIds.threadId))?.turnId, adoptNewTurn);
    }),
  );

  it.effect(
    "keeps the prepared orphan interrupted under late assistant, ready and checkpoint signals",
    () =>
      Effect.gen(function* () {
        const ids = idsFor("late-signals");
        yield* seedRunningClaude(ids, "codex");
        const { directory } = makeDirectory(ids, "codex");
        const provider = makeProvider(
          () => Effect.succeed({ threadId: ids.threadId, turnId: TurnId.make("late-signals-new") }),
          ids.threadId,
        );
        yield* reconcile(directory, provider);
        const engine = yield* OrchestrationEngineService;
        const assistantMessageId = MessageId.make("late-signals-assistant");

        // A late assistant completion for the interrupted turn must not relabel
        // it.
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("late-signals-assistant-delta"),
          threadId: ids.threadId,
          messageId: assistantMessageId,
          delta: "Finished before the restart boundary.",
          turnId: ids.oldTurnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("late-signals-assistant-complete"),
          threadId: ids.threadId,
          messageId: assistantMessageId,
          turnId: ids.oldTurnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "interrupted" },
        ]);

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("late-signals-ready"),
          threadId: ids.threadId,
          session: {
            threadId: ids.threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "interrupted" },
        ]);

        // A late checkpoint observation records its capture without changing the
        // interrupted outcome.
        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("late-signals-checkpoint"),
          threadId: ids.threadId,
          turnId: ids.oldTurnId,
          completedAt: "2026-01-01T00:00:04.000Z",
          checkpointRef: CheckpointRef.make("late-signals-checkpoint-ref"),
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "interrupted" },
        ]);
        const thread = (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).threads.find(
          (item) => item.id === ids.threadId,
        );
        assert.strictEqual(thread?.latestTurn?.turnId, ids.oldTurnId);
        assert.strictEqual(thread?.latestTurn?.state, "interrupted");
      }),
  );

  it.effect("reopens a same-ID continuation and completes it only at its real terminal", () =>
    Effect.gen(function* () {
      const ids = idsFor("same-id-ingestion");
      yield* seedRunningClaude(ids, "codex");
      const { directory } = makeDirectory(ids, "codex");
      const { streamEvents, emitAndDrain } = yield* makeRuntimeEventStream();
      const sent = yield* Deferred.make<void>();
      const provider = makeProvider(
        () =>
          Deferred.succeed(sent, undefined).pipe(
            Effect.as({ threadId: ids.threadId, turnId: ids.oldTurnId }),
          ),
        ids.threadId,
        streamEvents,
      );
      yield* Effect.gen(function* () {
        const ingestion = yield* ProviderRuntimeIngestionService;
        yield* ingestion.start();
        yield* reconcile(directory, provider);
        yield* Deferred.await(sent);
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "interrupted" },
        ]);

        // Same-ID reopen driven through real ingestion: interrupted -> running.
        yield* emitAndDrain(ingestion, [
          {
            type: "turn.started",
            eventId: EventId.make("same-id-ingestion-reopen"),
            payload: {},
            provider: ProviderDriverKind.make("codex"),
            threadId: ids.threadId,
            createdAt: "2026-01-01T00:00:02.000Z",
            turnId: ids.oldTurnId,
          },
        ]);
        const reopened =
          (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).threads.find(
            (item) => item.id === ids.threadId,
          );
        assert.strictEqual(reopened?.session?.status, "running");
        assert.strictEqual(reopened?.session?.activeTurnId, ids.oldTurnId);
        assert.strictEqual(reopened?.latestTurn?.turnId, ids.oldTurnId);
        assert.strictEqual(reopened?.latestTurn?.state, "running");
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "running" },
        ]);

        // A canonical terminal naming the reopened turn — through the same real
        // ingestion path — is what completes it.
        yield* emitAndDrain(ingestion, [
          {
            type: "turn.completed",
            eventId: EventId.make("same-id-ingestion-terminal"),
            provider: ProviderDriverKind.make("codex"),
            threadId: ids.threadId,
            createdAt: "2026-01-01T00:00:03.000Z",
            turnId: ids.oldTurnId,
            payload: { state: "completed" },
          },
        ]);
        const completed =
          (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).threads.find(
            (item) => item.id === ids.threadId,
          );
        assert.strictEqual(completed?.session?.status, "ready");
        assert.strictEqual(completed?.session?.activeTurnId, null);
        assert.strictEqual(completed?.latestTurn?.turnId, ids.oldTurnId);
        assert.strictEqual(completed?.latestTurn?.state, "completed");
        assert.deepEqual(yield* turnStates(ids.threadId), [
          { turnId: ids.oldTurnId, state: "completed" },
        ]);
      }).pipe(Effect.provide(makeIngestionLayer(provider)));
    }),
  );

  it.effect("replays the stored prepare event identically through both reducers", () =>
    Effect.gen(function* () {
      const ids = idsFor("replay");
      yield* seedRunningClaude(ids, "codex");
      const { directory } = makeDirectory(ids, "codex");
      const sql = yield* SqlClient.SqlClient;
      const seenAtSend = yield* Deferred.make<ReadonlyArray<{ turnId: string; state: string }>>();
      const provider = makeProvider(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(
              seenAtSend,
              yield* turnStates(ids.threadId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.orDie,
              ),
            );
            return { threadId: ids.threadId, turnId: TurnId.make("replay-new") };
          }),
        ids.threadId,
      );
      yield* reconcile(directory, provider);
      yield* Deferred.await(seenAtSend);

      // Replay the events that were actually stored — including the prepare
      // event startup dispatched — through the server read model reducer and
      // the shared client thread reducer.
      const eventStore = yield* OrchestrationEventStore;
      const storedEvents = Array.from(yield* Stream.runCollect(eventStore.readAll())).filter(
        (event) => event.aggregateId === ids.threadId,
      );
      const prepareEvent = storedEvents.find(
        (event) =>
          event.type === "thread.session-set" &&
          event.commandId?.startsWith(RESTART_CONTINUATION_COMMAND_PREFIX) === true,
      );
      assert.isDefined(prepareEvent);

      let serverModel = createEmptyReadModel(createdAt);
      let clientThread: OrchestrationThread | undefined;
      for (const event of storedEvents) {
        serverModel = yield* projectEvent(serverModel, event);
        if (clientThread === undefined) {
          if (event.type === "thread.created" && event.payload.threadId === ids.threadId) {
            clientThread = serverModel.threads.find((item) => item.id === ids.threadId);
          }
          continue;
        }
        const result = applyThreadDetailEvent(clientThread, event);
        if (result.kind === "updated") {
          clientThread = result.thread;
        }
      }
      const replayedThread = serverModel.threads.find((item) => item.id === ids.threadId);
      assert.strictEqual(replayedThread?.latestTurn?.turnId, ids.oldTurnId);
      assert.strictEqual(replayedThread?.latestTurn?.state, "interrupted");
      assert.strictEqual(replayedThread?.session?.status, "starting");
      assert.isDefined(clientThread);
      assert.strictEqual(clientThread?.latestTurn?.turnId, ids.oldTurnId);
      assert.strictEqual(clientThread?.latestTurn?.state, "interrupted");
      assert.strictEqual(clientThread?.session?.status, "starting");
    }),
  );

  it.effect("documents the same-ID reuse limit after an interrupted recovery", () =>
    Effect.gen(function* () {
      const ids = idsFor("same-id");
      yield* seedRunningClaude(ids);
      const { directory } = makeDirectory(ids);
      const sent = yield* Deferred.make<void>();
      const provider = makeProvider(
        () =>
          Deferred.succeed(sent, undefined).pipe(
            Effect.as({ threadId: ids.threadId, turnId: ids.oldTurnId }),
          ),
        ids.threadId,
      );
      yield* reconcile(directory, provider);
      yield* Deferred.await(sent);
      assert.deepEqual(yield* turnStates(ids.threadId), [
        { turnId: ids.oldTurnId, state: "interrupted" },
      ]);
      const engine = yield* OrchestrationEngineService;
      for (const [status, activeTurnId] of [
        ["running", ids.oldTurnId],
        ["ready", null],
      ] as const) {
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`same-id-${status}`),
          threadId: ids.threadId,
          session: {
            threadId: ids.threadId,
            status,
            providerName: "claudeAgent",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
      }
      assert.deepEqual(yield* turnStates(ids.threadId), [
        { turnId: ids.oldTurnId, state: "completed" },
      ]);
    }),
  );

  it.effect(
    "holds a stored pending turn start before any adapter work and keeps the user message",
    () =>
      Effect.gen(function* () {
        const ids = idsFor("pending-start");
        const modelSelection = { instanceId: claudeInstanceId, model: "claude-opus-5" };
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`${ids.projectId}-create`),
          projectId: ids.projectId,
          title: "Recovery projection",
          workspaceRoot: `/tmp/${ids.projectId}`,
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${ids.threadId}-create`),
          threadId: ids.threadId,
          projectId: ids.projectId,
          title: "Recovery projection",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`${ids.threadId}-ready`),
          threadId: ids.threadId,
          session: {
            threadId: ids.threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        const messageId = MessageId.make("pending-start-user-message");
        // A user turn start whose provider turn never began is what a crash
        // leaves behind: the pending placeholder row and the user message.
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`${ids.threadId}-turn-start`),
          threadId: ids.threadId,
          message: { messageId, role: "user", text: "continue me", attachments: [] },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`${ids.threadId}-running`),
          threadId: ids.threadId,
          session: {
            threadId: ids.threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: claudeInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });

        // Preserve the pending start before the provider begins.
        const beforePending =
          yield* (yield* ProjectionTurnRepository).getPendingTurnStartByThreadId({
            threadId: ids.threadId,
          });
        assert.deepStrictEqual(
          Option.map(beforePending, (pending) => pending.messageId),
          Option.some(messageId),
        );

        const { directory } = makeDirectory(ids, "codex");
        let sends = 0;
        const provider = makeProvider(
          () =>
            Effect.sync(() => {
              sends += 1;
            }).pipe(
              Effect.as({ threadId: ids.threadId, turnId: TurnId.make("pending-start-new") }),
            ),
          ids.threadId,
        );
        yield* reconcile(directory, provider);

        // The pending pre-check settled the thread synchronously before any
        // provider work, through the existing conservative interrupted-work
        // settlement.
        assert.strictEqual(sends, 0);
        const session =
          (yield* (yield* ProjectionSnapshotQuery).getCommandReadModel()).threads.find(
            (thread) => thread.id === ids.threadId,
          )?.session;
        assert.strictEqual(session?.status, "error");
        assert.strictEqual(session?.lastError, INTERRUPTED_WORK_ERROR);
        // The real pipeline removed the placeholder with the failed start, and
        // the user message survives it.
        const turnRepository = yield* ProjectionTurnRepository;
        const pending = yield* turnRepository.getPendingTurnStartByThreadId({
          threadId: ids.threadId,
        });
        assert.isTrue(Option.isNone(pending));
        const sql = yield* SqlClient.SqlClient;
        const storedMessages = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_thread_messages
          WHERE thread_id = ${ids.threadId} AND message_id = ${messageId}
        `;
        assert.deepEqual(storedMessages, [{ count: 1 }]);
      }),
  );

  it.effect("fences startup and the live engine with one continuation instance", () =>
    Effect.gen(function* () {
      const ids = idsFor("shared-instance");
      yield* seedRunningClaude(ids, "codex");
      const continuations = yield* RestartContinuations;
      const { directory } = makeDirectory(ids, "codex");
      const receipt = recordReceipt(continuations);
      const provider = makeProvider(
        () =>
          Effect.succeed({ threadId: ids.threadId, turnId: TurnId.make("shared-instance-new") }),
        ids.threadId,
      );
      yield* reconcile(directory, provider, false, receipt.continuations);
      yield* Deferred.await(receipt.evidenceRecorded);
      const token = continuations.current(ids.threadId);
      assert.isTrue(token !== undefined && continuations.isLive(token));
      assert.deepEqual(token?.evidence, {
        kind: "returned",
        turnId: TurnId.make("shared-instance-new"),
      });
      // The engine observes committed events through the same instance an
      // accepted stop request cancels exactly the token startup reserved.
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("shared-instance-stop"),
        threadId: ids.threadId,
        createdAt: "2026-01-01T00:00:02.000Z",
      });
      assert.isTrue(token !== undefined && token.canceled);
      assert.isTrue(token !== undefined && !continuations.isLive(token));
    }),
  );
});
