import {
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

const unusedSnapshotQuery = {
  getCommandReadModel: () => Effect.succeed({ threads: [], projects: [] }),
} as unknown as ProjectionSnapshotQuery["Service"];
const unusedCheckpointStore = {
  deleteThreadCheckpointRefs: () => Effect.void,
} as unknown as CheckpointStore.CheckpointStore["Service"];

describe("ThreadDeletionReactor drain", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-deletion-reactor-drain");
  const deletedEvent = (sequence: number): OrchestrationEvent => ({
    sequence,
    eventId: EventId.make(`evt-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${sequence}`),
    metadata: {},
    payload: { threadId, deletedAt: now },
  });

  effectIt.effect("waits for a published deletion the subscriber has not consumed yet", () =>
    Effect.gen(function* () {
      const stops: Array<number> = [];
      const firstCleanupDone = yield* Deferred.make<void>();
      // The engine has already committed and published sequence 2, but the
      // subscriber has not received it yet: the stream releases it on demand.
      const releaseSecondEvent = yield* Deferred.make<void>();
      const latestSequence = yield* Ref.make(0);
      const engine = {
        latestSequence: Ref.get(latestSequence),
        streamDomainEvents: Stream.concat(
          Stream.make(deletedEvent(1)),
          Stream.fromEffect(Deferred.await(releaseSecondEvent)).pipe(
            Stream.map(() => deletedEvent(2)),
          ),
        ),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () =>
          Effect.gen(function* () {
            stops.push(stops.length + 1);
            if (stops.length === 1) {
              yield* Deferred.succeed(firstCleanupDone, undefined);
            }
          }),
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, unusedSnapshotQuery)),
        Layer.provide(Layer.succeed(CheckpointStore.CheckpointStore, unusedCheckpointStore)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(firstCleanupDone);

          // Sequence 1 is fully cleaned and the worker queue is idle. Sequence
          // 2 is committed and published but still in flight to the subscriber.
          yield* Ref.set(latestSequence, 2);
          const drained = yield* Effect.forkChild(reactor.drainThrough(2));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(stops).toEqual([1]);
          expect(drained.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseSecondEvent, undefined);
          yield* Fiber.join(drained);
          expect(stops).toEqual([1, 2]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});

describe("ThreadDeletionReactor checkpoint refs", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-deletion-refs");
  const deletedThread = ThreadId.make("thread-deletion-refs");
  const otherThread = ThreadId.make("thread-deletion-refs-other");
  const RealCheckpointStoreLayer = CheckpointStore.layer.pipe(
    Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      return yield* process.run({
        operation: "ThreadDeletionReactor.test.git",
        command: "git",
        cwd,
        args,
        timeoutMs: 10_000,
      });
    });

  const refsOf = (cwd: string) =>
    git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3/checkpoints"]).pipe(
      Effect.map((result) => result.stdout.split("\n").filter((ref) => ref.length > 0)),
    );

  // One repo holding checkpoints of the deleted thread and of another thread.
  const seedRepo = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-deletion-refs-" });
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(`${cwd}/README.md`, "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    for (const threadId of [deletedThread, otherThread]) {
      for (const turn of [0, 1]) {
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, turn),
        });
      }
    }
    return cwd;
  });

  const deletedEvent = (sequence: number): OrchestrationEvent => ({
    sequence,
    eventId: EventId.make(`evt-refs-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: deletedThread,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-refs-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-refs-deleted-${sequence}`),
    metadata: {},
    payload: { threadId: deletedThread, deletedAt: now },
  });

  // Runs the reactor over one deletion and waits for its cleanup to finish.
  const deleteThread = (input: {
    readonly workspaceRoot: string;
    readonly worktreePath: string | null;
    readonly recreated: boolean;
  }) =>
    Effect.gen(function* () {
      const engine = {
        // The subscription starts before the deletion, which commits at 1.
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.make(deletedEvent(1)),
      } as unknown as OrchestrationEngineShape;
      const query = {
        getCommandReadModel: () =>
          Effect.succeed({
            projects: [{ id: projectId, workspaceRoot: input.workspaceRoot }],
            threads: [
              {
                id: deletedThread,
                projectId,
                worktreePath: input.worktreePath,
                deletedAt: input.recreated ? null : now,
              },
            ],
          }),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(
          Layer.succeed(ProviderService, {
            stopSession: () => Effect.void,
          } as unknown as ProviderServiceShape),
        ),
        Layer.provide(
          Layer.succeed(TerminalManager.TerminalManager, {
            close: () => Effect.void,
          } as unknown as TerminalManager.TerminalManager["Service"]),
        ),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, query)),
        Layer.provide(RealCheckpointStoreLayer),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* reactor.drainThrough(1);
      }).pipe(Effect.provide(layer));
    });

  const otherThreadRefs = [0, 1].map((turn) => checkpointRefForThreadTurn(otherThread, turn));

  effectIt.effect("deletes the deleted thread's checkpoint refs and no one else's", () =>
    Effect.gen(function* () {
      const cwd = yield* seedRepo;
      yield* deleteThread({ workspaceRoot: cwd, worktreePath: null, recreated: false });
      expect(yield* refsOf(cwd)).toEqual(otherThreadRefs);
    }).pipe(Effect.provide(RealCheckpointStoreLayer), Effect.scoped),
  );

  effectIt.effect("keeps refs when the thread id was created again after the delete", () =>
    Effect.gen(function* () {
      const cwd = yield* seedRepo;
      yield* deleteThread({ workspaceRoot: cwd, worktreePath: null, recreated: true });
      expect(yield* refsOf(cwd)).toHaveLength(4);
    }).pipe(Effect.provide(RealCheckpointStoreLayer), Effect.scoped),
  );

  effectIt.effect("falls back to the project repository when the worktree is gone", () =>
    Effect.gen(function* () {
      const cwd = yield* seedRepo;
      yield* deleteThread({
        workspaceRoot: cwd,
        worktreePath: `${cwd}/missing-worktree`,
        recreated: false,
      });
      expect(yield* refsOf(cwd)).toEqual(otherThreadRefs);
    }).pipe(Effect.provide(RealCheckpointStoreLayer), Effect.scoped),
  );
});
