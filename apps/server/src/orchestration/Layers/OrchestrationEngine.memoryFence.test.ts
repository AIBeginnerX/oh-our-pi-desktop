// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  ProjectMemorySendLedger,
  layer as ProjectMemorySendLedgerLayer,
} from "../../persistence/ProjectMemorySendLedger.ts";
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
} from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";

type OrchestrationEventStoreLayer = typeof OrchestrationEventStoreLive;
type ProjectionThreadMessageRepositoryLayer = typeof ProjectionThreadMessageRepositoryLive;

// The same module-level ledger layer object the engine provides internally,
// so this composite memoizes one ledger instance and the test captures fences
// on the very instance the dispatch path mutates.
function makeOrchestrationLayer(
  databasePath?: string,
  eventStoreLayer: OrchestrationEventStoreLayer = OrchestrationEventStoreLive,
  messageRepositoryLayer: ProjectionThreadMessageRepositoryLayer = ProjectionThreadMessageRepositoryLive,
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-memory-fence-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(messageRepositoryLayer),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectMemorySendLedgerLayer,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provide(eventStoreLayer),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

function decorateProjectionThreadMessageRepositoryLayer(
  decorate: (
    repository: ProjectionThreadMessageRepositoryShape,
  ) => ProjectionThreadMessageRepositoryShape,
) {
  return Layer.effect(
    ProjectionThreadMessageRepository,
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      return decorate(repository);
    }),
  ).pipe(Layer.provide(ProjectionThreadMessageRepositoryLive));
}

const NOW = "2026-01-01T00:00:00.000Z";

describe("OrchestrationEngine memory provenance fence", () => {
  const providerInstanceId = ProviderInstanceId.make("codex");

  const seed = (
    engine: OrchestrationEngineShape,
    prefix: string,
    projectId: ProjectId,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${prefix}-project`),
        projectId,
        title: "Fence project",
        workspaceRoot: `/tmp/${prefix}`,
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${prefix}-thread`),
        threadId,
        projectId,
        title: "Fence thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });
    });

  const threadCreate = (prefix: string, projectId: ProjectId, threadId: ThreadId) => ({
    type: "thread.create" as const,
    commandId: CommandId.make(`${prefix}-thread`),
    threadId,
    projectId,
    title: "Fence thread",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required" as const,
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });

  const activityAppend = (prefix: string, threadId: ThreadId) => ({
    type: "thread.activity.append" as const,
    commandId: CommandId.make(`${prefix}-activity`),
    threadId,
    activity: {
      id: EventId.make(`${prefix}-activity`),
      tone: "info" as const,
      kind: "tool.completed",
      summary: "ordinary activity",
      payload: {},
      turnId: null,
      createdAt: NOW,
    },
    createdAt: NOW,
  });

  // Every fence below is captured the way admission capture happens — a
  // synchronous read of the shared ledger before the SQL checks — so a
  // committed mutation of the provenance rows must break it, and an ordinary
  // commit must not.
  effectIt.effect("breaks a captured fence only for provenance-invalidating batches", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sendLedger = yield* ProjectMemorySendLedger;
      const projectId = ProjectId.make("project-fence");
      const threadId = ThreadId.make("thread-fence");
      const otherThreadId = ThreadId.make("thread-fence-other");
      yield* seed(engine, "fence", projectId, threadId);

      // Controls: ordinary commits never move the epoch.
      const controlFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("fence-meta"),
        threadId,
        title: "Renamed",
      });
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("fence-project-meta"),
        projectId,
        title: "Renamed project",
      });
      yield* engine.dispatch(activityAppend("fence-activity", threadId));
      yield* engine.dispatch(threadCreate("fence-fresh", projectId, otherThreadId));
      expect(sendLedger.mutationFenceHolds(controlFence)).toBe(true);

      // History truncation removes the originating message rows.
      const revertFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make("fence-revert"),
        threadId,
        turnCount: 0,
        createdAt: NOW,
      });
      expect(sendLedger.mutationFenceHolds(revertFence)).toBe(false);

      // A tombstone invalidates the live-thread association.
      const deleteFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("fence-thread-delete"),
        threadId,
      });
      expect(sendLedger.mutationFenceHolds(deleteFence)).toBe(false);

      // Recreating the same id resets the row and wipes the history — a
      // decided thread.created on an existing id is still a mutation.
      const recreateFence = sendLedger.captureMutationFence();
      yield* engine.dispatch(threadCreate("fence-recreate", projectId, threadId));
      expect(sendLedger.mutationFenceHolds(recreateFence)).toBe(false);

      // A forced project tombstone arrives as a batch and still counts.
      const projectFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("fence-project-delete"),
        projectId,
        force: true,
      });
      expect(sendLedger.mutationFenceHolds(projectFence)).toBe(false);

      // The epoch settles once nothing is in flight.
      expect(sendLedger.mutationFenceHolds(sendLedger.captureMutationFence())).toBe(true);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // Parking inside the real outer transaction proves the fence window is the
  // actual COMMIT lifetime on a file database: held while the batch is in
  // flight, broken once the commit lands, and untouched by an open
  // transaction whose batch cannot invalidate provenance.
  effectIt.effect("holds the mutation fence for exactly the outer commit lifetime", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-memory-fence-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const gate = {
        current: undefined as
          | {
              readonly entered: Deferred.Deferred<void>;
              readonly release: Deferred.Deferred<void>;
            }
          | undefined,
      };
      const parkedStore = Layer.effect(
        OrchestrationEventStore,
        Effect.gen(function* () {
          const store = yield* OrchestrationEventStore;
          const wrapped: OrchestrationEventStoreShape = {
            ...store,
            append: (event) => {
              const active = gate.current;
              if (active === undefined) return store.append(event);
              return Effect.gen(function* () {
                yield* Deferred.succeed(active.entered, undefined);
                yield* Deferred.await(active.release);
                return yield* store.append(event);
              });
            },
          };
          return wrapped;
        }),
      ).pipe(Layer.provide(OrchestrationEventStoreLive));

      const runEngine = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.flatMap(
            Layer.build(Layer.fresh(makeOrchestrationLayer(databasePath, parkedStore))),
            (context) => Effect.provide(work, context),
          ),
        );

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const sendLedger = yield* ProjectMemorySendLedger;
        const projectId = ProjectId.make("project-park");
        const threadId = ThreadId.make("thread-park");
        yield* seed(engine, "park", projectId, threadId);
        const seededHead = yield* engine.latestSequence;

        // An ordinary batch parks mid-transaction yet never breaks the fence:
        // the fence wraps only provenance-invalidating commits.
        const controlFence = sendLedger.captureMutationFence();
        const controlEntered = yield* Deferred.make<void>();
        const controlRelease = yield* Deferred.make<void>();
        gate.current = { entered: controlEntered, release: controlRelease };
        const control = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("park-meta"),
            threadId,
            title: "Parked",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(controlEntered);
        expect(sendLedger.mutationFenceHolds(controlFence)).toBe(true);
        yield* Deferred.succeed(controlRelease, undefined);
        yield* Fiber.join(control);
        gate.current = undefined;
        expect(sendLedger.mutationFenceHolds(controlFence)).toBe(true);

        // A forced project tombstone parks mid-transaction and the fence is
        // already broken while the commit is still in flight; once the real
        // commit lands the epoch has moved and the old fence stays broken.
        const tombstoneFence = sendLedger.captureMutationFence();
        const tombstoneEntered = yield* Deferred.make<void>();
        const tombstoneRelease = yield* Deferred.make<void>();
        gate.current = { entered: tombstoneEntered, release: tombstoneRelease };
        const tombstone = yield* engine
          .dispatch({
            type: "project.delete",
            commandId: CommandId.make("park-project-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(tombstoneEntered);
        expect(sendLedger.mutationFenceHolds(tombstoneFence)).toBe(false);
        yield* Deferred.succeed(tombstoneRelease, undefined);
        const committed = yield* Fiber.join(tombstone);
        gate.current = undefined;
        expect(committed.sequence).toBeGreaterThan(seededHead);
        expect(sendLedger.mutationFenceHolds(tombstoneFence)).toBe(false);
        expect(sendLedger.mutationFenceHolds(sendLedger.captureMutationFence())).toBe(true);
      }).pipe(
        runEngine,
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  // Message upserts key on the global message id, so replaying an existing
  // user id onto another thread rewrites that row's membership. A fence
  // captured before the move must break; a fresh id must not.
  effectIt.effect("breaks the fence when a user message moves across threads", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sendLedger = yield* ProjectMemorySendLedger;
      const messages = yield* ProjectionThreadMessageRepository;
      const projectId = ProjectId.make("project-move");
      const sourceThreadId = ThreadId.make("thread-move-source");
      const targetThreadId = ThreadId.make("thread-move-target");
      yield* seed(engine, "move-source", projectId, sourceThreadId);
      yield* engine.dispatch(threadCreate("move-target", projectId, targetThreadId));

      const messageId = MessageId.make("move-message");
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("move-append-source"),
        threadId: sourceThreadId,
        message: { messageId, text: "origin", attachments: [] },
        createdAt: NOW,
      });

      // Control: a fresh message id on the other thread commits without
      // touching the fence.
      const controlFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("move-append-fresh"),
        threadId: targetThreadId,
        message: {
          messageId: MessageId.make("move-message-fresh"),
          text: "fresh",
          attachments: [],
        },
        createdAt: NOW,
      });
      expect(sendLedger.mutationFenceHolds(controlFence)).toBe(true);

      // The decider only checks duplicates inside the target thread, so the
      // same id lands a thread.message-sent that moves the durable user row.
      const movedFence = sendLedger.captureMutationFence();
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("move-append-target"),
        threadId: targetThreadId,
        message: { messageId, text: "moved", attachments: [] },
        createdAt: NOW,
      });
      expect(sendLedger.mutationFenceHolds(movedFence)).toBe(false);
      const movedRow = yield* messages.getByMessageId({ messageId });
      expect(Option.isSome(movedRow)).toBe(true);
      if (Option.isSome(movedRow)) {
        expect(movedRow.value.threadId).toBe(targetThreadId);
        expect(movedRow.value.role).toBe("user");
      }
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  // A classification read that fails with a mixed cause must reach the
  // caller with its reasons intact — the same delivery the guarded
  // task-result path gets — and leave no rejected receipt behind.
  effectIt.effect("delivers a mixed classification-read cause with its reasons intact", () => {
    const failMessageReads = { current: false };
    const injectedReadError = new PersistenceSqlError({
      operation: "ProjectionThreadMessageRepository.getByMessageId:query",
      detail: "simulated provenance classification failure",
    });
    const mixedReadCause = Cause.combine(Cause.fail(injectedReadError), Cause.interrupt());
    const wrappedRepository = decorateProjectionThreadMessageRepositoryLayer((repository) => ({
      ...repository,
      getByMessageId: (input) => {
        if (failMessageReads.current) {
          return Effect.failCause(mixedReadCause);
        }
        return repository.getByMessageId(input);
      },
    }));

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const projectId = ProjectId.make("project-classify");
      const sourceThreadId = ThreadId.make("thread-classify-source");
      const targetThreadId = ThreadId.make("thread-classify-target");
      yield* seed(engine, "classify-source", projectId, sourceThreadId);
      yield* engine.dispatch(threadCreate("classify-target", projectId, targetThreadId));
      const messageId = MessageId.make("classify-message");
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("classify-append-source"),
        threadId: sourceThreadId,
        message: { messageId, text: "origin", attachments: [] },
        createdAt: NOW,
      });
      const head = yield* engine.latestSequence;
      const command = {
        type: "thread.message.user.append" as const,
        commandId: CommandId.make("classify-append-target"),
        threadId: targetThreadId,
        message: { messageId, text: "moved", attachments: [] },
        createdAt: NOW,
      };

      failMessageReads.current = true;
      const exit = yield* Effect.exit(engine.dispatch(command));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // The original reasons are delivered in order — never squashed to
        // the mapped unavailable error. Propagation adds the framework's own
        // "effect/Cause/StackTrace" annotation on each reason, and the
        // delivery fiber appends its own Interrupt reason; those are the
        // only tolerated differences from the injected cause.
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

      // Nothing was decided: no event and no rejection receipt, so the same
      // command id retries once the read recovers.
      expect(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId }))).toBe(
        true,
      );

      failMessageReads.current = false;
      const accepted = yield* engine.dispatch(command);
      expect(accepted.sequence).toBeGreaterThan(head);
      const movedRow = yield* messages.getByMessageId({ messageId });
      expect(Option.isSome(movedRow)).toBe(true);
      if (Option.isSome(movedRow)) {
        expect(movedRow.value.threadId).toBe(targetThreadId);
      }
    }).pipe(
      Effect.provide(
        makeOrchestrationLayer(undefined, OrchestrationEventStoreLive, wrappedRepository),
      ),
    );
  });
});
