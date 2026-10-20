import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ProjectMemorySendGate from "./memory/ProjectMemorySendGate.ts";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { layer as projectMemorySendLedgerLayer } from "./persistence/ProjectMemorySendLedger.ts";
import * as ProviderSafetyObservations from "./persistence/ProviderSafetyObservations.ts";
import { ProjectionTurnRepository } from "./persistence/Services/ProjectionTurns.ts";
import {
  ProviderContinuationRevokedError,
  ProviderInstanceNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
} from "./provider/Errors.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import { ServerActivation } from "./serverActivation.ts";
import {
  type ContinuationToken,
  layer as restartContinuationsLayer,
  RestartContinuations,
} from "./restartContinuations.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-08-20T12:00:00.000Z";
const noSafetyObservations = ProviderSafetyObservations.ProviderSafetyObservations.of({
  record: () => Effect.void,
  hasUnprojected: () => Effect.succeed(false),
});

const projectMemorySendGateFixtureLayer = ProjectMemorySendGate.layer.pipe(
  Layer.provideMerge(projectMemorySendLedgerLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const makeThread = (
  id: string,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null = null,
  archivedAt: string | null = null,
  deletedAt: string | null = null,
  providerName: "codex" | "claudeAgent" = "codex",
  lastError: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName,
    providerInstanceId:
      providerName === "claudeAgent" ? ProviderInstanceId.make("claudeAgent") : providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId,
    lastError,
    updatedAt,
  },
});

const makeProviderService = (liveThreadIds: ReadonlyArray<ThreadId> = []) =>
  ({
    previewSubmissionRoute: () => Effect.die("unused"),
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    compactThread: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
    getCapabilities: () => Effect.die("unused"),
    assertConversationRollbackSupported: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    uploadFeedback: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderService.ProviderService["Service"];

type ThreadReads = Pick<
  ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  "getThreadShellById" | "getThreadDetailById"
>;

// Reads that find nothing pending and no tool activity, so a thread is clear to continue.
const nothingOpenReads = {
  getThreadShellById: () =>
    Effect.succeedSome({ hasPendingApprovals: false, hasPendingUserInput: false } as never),
  getThreadDetailById: () => Effect.succeedSome({ activities: [] } as never),
} satisfies ThreadReads;

const queryWithThreads = (
  threads: ReadonlyArray<ReturnType<typeof makeThread>>,
  reads: ThreadReads = nothingOpenReads,
) =>
  ({
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.succeed({ threads } as never),
    ...reads,
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>;
  readonly continueAfterRestart?: boolean;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly reads?: ThreadReads;
  readonly providerService?: ProviderService.ProviderService["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
  readonly observations?: ProviderSafetyObservations.ProviderSafetyObservations["Service"];
  readonly projectionTurnRepository?: ProjectionTurnRepository["Service"];
  readonly continuations?: RestartContinuations["Service"];
}) =>
  Effect.gen(function* () {
    // The fixture graph is built in the caller's ambient Scope, not around
    // the reconcile call itself: reconcileProviderSessions forks
    // continuations that now run a late memory-hold query after it returns,
    // and an Effect.provide(layer) scope would close the SQLite client out
    // from under those children.
    const fixture = yield* Layer.build(
      Layer.mergeAll(
        input.projectionTurnRepository === undefined
          ? ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))
          : Layer.succeed(ProjectionTurnRepository, input.projectionTurnRepository),
        input.continuations === undefined
          ? restartContinuationsLayer
          : Layer.succeed(RestartContinuations, input.continuations),
        projectMemorySendGateFixtureLayer,
        ServerSettings.layerTest({
          continueThreadsAfterServerUpdate: input.continueAfterRestart ?? false,
        }),
        NodeServices.layer,
      ),
    );
    return yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(
        ProviderSafetyObservations.ProviderSafetyObservations,
        input.observations ?? noSafetyObservations,
      ),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        queryWithThreads(input.threads, input.reads),
      ),
      Effect.provideService(
        ProviderService.ProviderService,
        input.providerService ?? makeProviderService(input.liveThreadIds),
      ),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: input.dispatch,
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      // Startup reads persisted pending turn starts through the real repository
      // and fences its parked continuation with the real continuation service.
      // Both ride one in-memory SQLite client unless a test supplies the built
      // instances itself (a seeded or failing repository, or a continuations
      // instance the assertions hold a reference to).
      Effect.provide(fixture),
    );
  });

// Builds the real continuation service from the exported layer once, so a test
// can observe the exact instance the startup flow reserves and records on.
const makeRealContinuations = Effect.map(
  Effect.scoped(Layer.build(restartContinuationsLayer)),
  (built) => {
    const continuations = Context.get(built, RestartContinuations);
    return {
      continuations,
      layer: Layer.succeed(RestartContinuations, continuations),
    };
  },
);

// A Deferred waiter resumes inline on the fiber that completes it, so a signal
// fired inside the adapter resolves before the parked send fiber's record
// call. Tests that read token evidence therefore observe the real record: the
// wrapper delegates to the shared service unchanged and completes a thread's
// receipt the moment after record returns on its token. A receipt binds to the
// token current when it is taken, so a later reserve on the same thread cannot
// satisfy an earlier wait, and taking one after the record already committed
// completes immediately.
const makeRecordingContinuations = (real: RestartContinuations["Service"]) => {
  const receipts = new Map<ContinuationToken, Deferred.Deferred<void>>();
  const receiptFor = (threadId: ThreadId): Deferred.Deferred<void> => {
    const token = real.current(threadId);
    if (token === undefined) {
      const unreserved = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(unreserved, Effect.die("no continuation token reserved for thread"));
      return unreserved;
    }
    const existing = receipts.get(token);
    if (existing !== undefined) {
      return existing;
    }
    const receipt = Deferred.makeUnsafe<void>();
    if (token.evidence !== undefined) {
      Deferred.doneUnsafe(receipt, Effect.void);
    }
    receipts.set(token, receipt);
    return receipt;
  };
  const continuations: RestartContinuations["Service"] = {
    ...real,
    record: (token, evidence) => {
      real.record(token, evidence);
      const receipt = receipts.get(token);
      if (receipt !== undefined) {
        Deferred.doneUnsafe(receipt, Effect.void);
      }
    },
  };
  return { continuations, receiptFor };
};

it.effect("marks active running sessions that have persisted resume state", () => {
  const active = makeThread("thread-mark-active", "running", TurnId.make("turn-mark-active"));
  const archived = makeThread(
    "thread-mark-archived",
    "running",
    TurnId.make("turn-mark-archived"),
    updatedAt,
  );
  const ready = makeThread("thread-mark-ready", "ready");
  const missingResumeState = makeThread(
    "thread-mark-missing-resume-state",
    "running",
    TurnId.make("turn-mark-missing-resume-state"),
  );
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return ServerRuntimeStartup.markRunningProviderSessionsForContinuation.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads([active, archived, ready, missingResumeState]),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: (threadId) =>
        Effect.sync(() => bindingReads.push(threadId)).pipe(
          Effect.as(
            Option.some({
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              ...(threadId === active.id ? { resumeCursor: { threadId } } : {}),
              runtimePayload: { activeTurnId: "turn-mark-active" },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    }),
    Effect.tap((marked) =>
      Effect.sync(() => {
        assert.deepStrictEqual(bindingReads, [active.id, missingResumeState.id]);
        assert.deepStrictEqual(marked, [active.id]);
        assert.deepStrictEqual(upserts[0]?.runtimePayload, {
          activeTurnId: "turn-mark-active",
          continueAfterServerUpdate: active.session.activeTurnId,
          continueAfterServerUpdatePrepared: null,
        });
      }),
    ),
  );
});

it.effect.each(
  (["marked update", "opt-in restart"] as const).flatMap((recovery) =>
    (["current", "previous", "missing"] as const).map((persistedTurn) => ({
      recovery,
      persistedTurn,
    })),
  ),
)(
  "continues $recovery sessions with a $persistedTurn directory turn",
  ({ recovery, persistedTurn }) =>
    Effect.gen(function* () {
      const codex = makeThread(
        "thread-continue-codex",
        "running",
        TurnId.make("turn-continue-codex"),
      );
      const fallbackContinuationTurnId = TurnId.make("turn-continue-fallback");
      const fallback = makeThread(
        "thread-continue-fallback",
        recovery === "marked update" ? "starting" : "running",
        recovery === "marked update" ? null : fallbackContinuationTurnId,
      );
      const fallbackProviderInstanceId = ProviderInstanceId.make("claudeAgent");
      const { continuations: real } = yield* makeRealContinuations;
      const { continuations, receiptFor } = makeRecordingContinuations(real);
      const sends: ProviderSendTurnInput[] = [];
      const dispatched: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>(
        [codex, fallback].map((thread) => [
          thread.id,
          {
            threadId: thread.id,
            provider:
              thread.id === codex.id
                ? ProviderDriverKind.make("codex")
                : ProviderDriverKind.make("claudeAgent"),
            providerInstanceId:
              thread.id === codex.id ? providerInstanceId : fallbackProviderInstanceId,
            status: "running" as const,
            resumeCursor: { threadId: thread.id },
            runtimePayload: {
              activeTurnId:
                thread.id === codex.id && persistedTurn !== "current"
                  ? persistedTurn === "previous"
                    ? "previous-provider-turn"
                    : null
                  : thread.session.activeTurnId,
              ...(recovery === "marked update"
                ? {
                    continueAfterServerUpdate:
                      thread.id === codex.id
                        ? codex.session.activeTurnId
                        : fallbackContinuationTurnId,
                  }
                : {}),
            },
          },
        ]),
      );
      const providerService: ProviderService.ProviderService["Service"] = {
        ...makeProviderService(),
        getCapabilities: (instanceId) =>
          Effect.succeed({
            sessionModelSwitch: "in-session",
            ...(instanceId === providerInstanceId ? { promptlessTurnContinuation: true } : {}),
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            return {
              threadId: input.threadId,
              turnId: TurnId.make(`continued-${String(input.threadId)}`),
            };
          }),
      };

      yield* runReconciliation({
        threads: [codex, fallback],
        continueAfterRestart: recovery === "opt-in restart",
        providerService,
        continuations,
        directory: {
          getBinding: (threadId) =>
            Effect.sync(() => {
              const binding = bindings.get(threadId);
              return binding === undefined ? Option.none() : Option.some(binding);
            }),
          upsert: (binding) =>
            Effect.sync(() => {
              bindings.set(binding.threadId, binding);
              upserts.push(binding);
            }),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });
      assert.isTrue(
        dispatched.every(
          (command) =>
            command.type === "thread.session.set" && command.session.status === "starting",
        ),
      );
      yield* Deferred.await(receiptFor(codex.id));
      yield* Deferred.await(receiptFor(fallback.id));

      assert.deepStrictEqual(
        sends.toSorted((left, right) =>
          String(left.threadId).localeCompare(String(right.threadId)),
        ),
        [
          { threadId: codex.id, continuation: true, interactionMode: "default" },
          {
            threadId: fallback.id,
            input: "Continue where you left off.",
            interactionMode: "default",
          },
        ],
      );
      assert.deepStrictEqual(
        dispatched.map((command) =>
          command.type === "thread.session.set"
            ? {
                threadId: command.threadId,
                status: command.session.status,
                activeTurnId: command.session.activeTurnId,
              }
            : null,
        ),
        [
          {
            threadId: codex.id,
            status: "starting",
            activeTurnId: null,
          },
          {
            threadId: fallback.id,
            status: "starting",
            activeTurnId: null,
          },
        ],
      );
      for (const [thread, continuationTurnId] of [
        [codex, codex.session.activeTurnId],
        [fallback, fallbackContinuationTurnId],
      ] as const) {
        assert.deepStrictEqual(
          upserts
            .filter((binding) => binding.threadId === thread.id)
            .map((binding) => binding.runtimePayload)[0],
          {
            continueAfterServerUpdate: continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
          },
        );
      }
      // A successful continuation records the returned turn as evidence on the
      // reserved token instead of writing a marker-clearing binding update.
      assert.equal(
        upserts.some((binding) => {
          const payload = binding.runtimePayload;
          return (
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "continueAfterServerUpdate" in payload &&
            payload.continueAfterServerUpdate === null
          );
        }),
        false,
      );
      assert.deepStrictEqual(
        [codex, fallback].map((thread) => continuations.current(thread.id)?.evidence),
        [
          { kind: "returned", turnId: TurnId.make(`continued-${String(codex.id)}`) },
          { kind: "returned", turnId: TurnId.make(`continued-${String(fallback.id)}`) },
        ],
      );
    }),
);

it.effect("does not continue archived or deleted marked sessions", () => {
  const archived = makeThread(
    "thread-continue-archived",
    "running",
    TurnId.make("turn-continue-archived"),
    updatedAt,
  );
  const deleted = makeThread(
    "thread-continue-deleted",
    "running",
    TurnId.make("turn-continue-deleted"),
    null,
    updatedAt,
  );
  const sends: ProviderSendTurnInput[] = [];
  const dispatched: OrchestrationCommand[] = [];

  return runReconciliation({
    threads: [archived, deleted],
    providerService: {
      ...makeProviderService(),
      sendTurn: (input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            threadId: input.threadId,
            turnId: TurnId.make("unexpected-archived-turn"),
          };
        }),
    },
    directory: {
      getBinding: (threadId) => {
        const thread = threadId === archived.id ? archived : deleted;
        return Effect.succeedSome({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running" as const,
          resumeCursor: { cursor: threadId },
          runtimePayload: {
            continueAfterServerUpdate: thread.session.activeTurnId,
          },
        });
      },
      upsert: () => Effect.void,
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(sends, []);
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? { threadId: command.threadId, status: command.session.status }
              : null,
          ),
          [
            { threadId: archived.id, status: "error" },
            { threadId: deleted.id, status: "error" },
          ],
        );
      }),
    ),
  );
});

it.effect("retries continuation preparation before settling a persistent failure", () => {
  const thread = makeThread(
    "thread-continuation-preparation-failure",
    "running",
    TurnId.make("turn-continuation-preparation-failure"),
  );
  const dispatched: OrchestrationCommand[] = [];
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated continuation preparation failure",
  });

  return runReconciliation({
    threads: [thread],
    directory: {
      getBinding: () =>
        Effect.succeedSome({
          threadId: thread.id,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running" as const,
          resumeCursor: { cursor: thread.id },
          runtimePayload: {
            continueAfterServerUpdate: thread.session.activeTurnId,
          },
        }),
      upsert: () => Effect.void,
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      dispatched.push(command);
      return command.session.status === "starting"
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: dispatched.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(
          dispatched.map(
            (command) => command.type === "thread.session.set" && command.session.status,
          ),
          ["starting", "starting", "error"],
        ),
      ),
    ),
  );
});

it.effect("reconciles multiple active and archived orphans but skips live sessions", () => {
  const starting = makeThread("thread-starting", "starting");
  const running = makeThread("thread-running", "running", TurnId.make("turn-running"));
  const staleActiveTurn = makeThread(
    "thread-stale-active-turn",
    "ready",
    TurnId.make("turn-stale-active"),
  );
  const archived = makeThread(
    "thread-archived",
    "running",
    TurnId.make("turn-archived"),
    updatedAt,
  );
  const live = makeThread("thread-live", "running", TurnId.make("turn-live"));
  const settled = makeThread("thread-ready", "ready");
  const dispatched: OrchestrationCommand[] = [];
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return runReconciliation({
    threads: [starting, running, staleActiveTurn, archived, live, settled],
    liveThreadIds: [live.id],
    directory: {
      getBinding: (candidate) =>
        Effect.sync(() => bindingReads.push(candidate)).pipe(
          Effect.as(
            Option.some({
              threadId: candidate,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { cursor: candidate },
              runtimePayload: {
                activeTurnId: "stale",
                unrelated: candidate,
                ...(candidate === staleActiveTurn.id
                  ? { continueAfterServerUpdate: "turn-from-an-earlier-update" }
                  : {}),
              },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const orphanIds = [starting.id, running.id, staleActiveTurn.id, archived.id];
        assert.deepStrictEqual(bindingReads, orphanIds);
        assert.deepStrictEqual(
          dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
          orphanIds,
        );
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? {
                  status: command.session.status,
                  activeTurnId: command.session.activeTurnId,
                }
              : null,
          ),
          orphanIds.map(() => ({ status: "error" as const, activeTurnId: null })),
        );
        assert.equal(upserts.length, orphanIds.length);
        for (const binding of upserts) {
          assert.equal(binding.status, "stopped");
          assert.deepStrictEqual(
            binding.runtimePayload,
            binding.threadId === staleActiveTurn.id
              ? {
                  activeTurnId: null,
                  unrelated: binding.threadId,
                  continueAfterServerUpdate: null,
                  continueAfterServerUpdatePrepared: null,
                }
              : { activeTurnId: null, unrelated: binding.threadId },
          );
          assert.deepStrictEqual(binding.resumeCursor, { cursor: binding.threadId });
        }
      }),
    ),
  );
});

it.effect(
  "settles projections when directory bindings are absent, corrupt, or fail to upsert",
  () => {
    const absent = makeThread("thread-binding-absent", "starting");
    const corrupt = makeThread("thread-binding-corrupt", "running");
    const upsertFailure = makeThread("thread-binding-upsert-failure", "running");
    const dispatched: OrchestrationCommand[] = [];
    const corruptFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.getBinding",
      detail: "corrupt persisted binding",
    });
    const writeFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.upsert",
      detail: "failed binding write",
    });

    return runReconciliation({
      threads: [absent, corrupt, upsertFailure],
      directory: {
        getBinding: (candidate) =>
          candidate === absent.id
            ? Effect.succeedNone
            : candidate === corrupt.id
              ? Effect.fail(corruptFailure)
              : Effect.succeedSome({
                  threadId: candidate,
                  provider: ProviderDriverKind.make("codex"),
                  providerInstanceId,
                }),
        upsert: () => Effect.fail(writeFailure),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
            [absent.id, corrupt.id, upsertFailure.id],
          );
        }),
      ),
    );
  },
);

it.effect("retries failed projections and continues after a persistent failure", () =>
  Effect.gen(function* () {
    const transient = makeThread("thread-dispatch-transient-failure", "running");
    const persistent = makeThread("thread-dispatch-persistent-failure", "running");
    const later = makeThread("thread-dispatch-success", "running");
    const attempted: ThreadId[] = [];
    let transientAttempts = 0;
    const failure = new OrchestrationCommandInvariantError({
      commandType: "thread.session.set",
      detail: "simulated startup reconciliation failure",
    });

    const exit = yield* runReconciliation({
      threads: [transient, persistent, later],
      directory: {
        getBinding: () => Effect.succeedNone,
        upsert: () => Effect.void,
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) => {
        if (command.type !== "thread.session.set") {
          return Effect.die("unexpected command");
        }
        attempted.push(command.threadId);
        if (command.threadId === transient.id && transientAttempts++ === 0) {
          return Effect.fail(failure);
        }
        return command.threadId === persistent.id
          ? Effect.fail(failure)
          : Effect.succeed({ sequence: attempted.length });
      },
    }).pipe(Effect.exit);

    assert.deepStrictEqual(attempted, [
      transient.id,
      transient.id,
      persistent.id,
      persistent.id,
      later.id,
    ]);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.isTrue(error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError);
      if (error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError) {
        assert.deepStrictEqual(error.threadIds, [persistent.id]);
      }
    }
  }),
);

it.effect("fails startup when the live provider session inventory cannot be read", () =>
  Effect.gen(function* () {
    let queried = false;
    const exit = yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(
        ProviderSafetyObservations.ProviderSafetyObservations,
        noSafetyObservations,
      ),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () =>
          Effect.sync(() => {
            queried = true;
            return { threads: [] } as never;
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderService.ProviderService, {
        ...makeProviderService(),
        listSessions: () => Effect.die("provider inventory unavailable"),
      }),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
        getBinding: () => Effect.die("unused"),
        upsert: () => Effect.die("unused"),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      // The dying inventory read stops the flow before either service runs,
      // but the requirements are static: ride the same real instances as
      // runReconciliation.
      Effect.provide(
        Layer.mergeAll(
          ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
          restartContinuationsLayer,
          projectMemorySendGateFixtureLayer,
        ),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest())),
      Effect.exit,
    );

    assert.equal(queried, false);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.isTrue(error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError);
      if (error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError) {
        assert.deepStrictEqual(error.threadIds, []);
      }
    }
  }),
);

for (const scenario of [
  "disabled",
  "stopped projection",
  "finished projection",
  "stopped binding",
  "missing cursor",
  "marked without cursor",
  "marked stopped projection",
  "marked superseded turn",
] as const) {
  it.effect(`does not recover an interrupted session with ${scenario}`, () => {
    const turnId = TurnId.make("turn-excluded-recovery");
    const thread = makeThread(
      "thread-excluded-recovery",
      scenario.includes("stopped projection")
        ? "stopped"
        : scenario === "finished projection"
          ? "ready"
          : scenario === "marked superseded turn"
            ? "starting"
            : "running",
      scenario === "marked superseded turn" ? null : turnId,
    );
    const dispatched: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    return runReconciliation({
      threads: [thread],
      continueAfterRestart: scenario !== "disabled",
      directory: {
        getBinding: () =>
          Effect.succeedSome({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: scenario === "stopped binding" ? "stopped" : "running",
            ...(scenario.includes("cursor") ? {} : { resumeCursor: { threadId: thread.id } }),
            runtimePayload: {
              activeTurnId: scenario === "marked superseded turn" ? "another-turn" : turnId,
              ...(scenario.startsWith("marked") ? { continueAfterServerUpdate: turnId } : {}),
            },
          }),
        upsert: (binding) =>
          Effect.sync(() => {
            upserts.push(binding);
          }),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map(
              (command) => command.type === "thread.session.set" && command.session.status,
            ),
            ["error"],
          );
          assert.deepStrictEqual(
            upserts.map((binding) => binding.status),
            ["stopped"],
          );
        }),
      ),
    );
  });
}

for (const preparedStatus of [
  "starting",
  "ready",
  "ready with failed scan",
  "completed after update marking",
] as const) {
  it.effect(`recovers again if startup exits with a prepared ${preparedStatus} session`, () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-interrupted-startup");
      const thread = makeThread("thread-interrupted-startup", "running", turnId);
      const activation = yield* Deferred.make<void>();
      const sends: ProviderSendTurnInput[] = [];
      const { continuations: real } = yield* makeRealContinuations;
      const { continuations, receiptFor } = makeRecordingContinuations(real);
      let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
        threadId: thread.id,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "running",
        resumeCursor: { threadId: thread.id },
        runtimePayload: { activeTurnId: turnId },
      };
      const input = {
        threads: [thread],
        continueAfterRestart: true,
        continuations,
        providerService: {
          ...makeProviderService(),
          getCapabilities: () =>
            Effect.succeed({
              sessionModelSwitch: "in-session" as const,
              promptlessTurnContinuation: true,
            }),
          sendTurn: (input: ProviderSendTurnInput) =>
            Effect.gen(function* () {
              sends.push(input);
              return { threadId: input.threadId, turnId: TurnId.make("turn-recovered") };
            }),
        },
        directory: {
          getBinding: () => Effect.sync(() => Option.some(binding)),
          upsert: (next: ProviderSessionDirectory.ProviderRuntimeBinding) =>
            Effect.sync(() => {
              binding = next;
            }),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () =>
            preparedStatus === "ready with failed scan"
              ? Effect.fail(
                  new ProviderSessionDirectoryPersistenceError({
                    operation: "listBindings",
                    detail: "unreadable unrelated binding",
                  }),
                )
              : Effect.sync(() => [{ ...binding, lastSeenAt: "2026-01-01T00:00:00.000Z" }]),
        },
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            if (command.type === "thread.session.set") {
              thread.session.status = command.session.status;
              thread.session.activeTurnId = command.session.activeTurnId;
            }
            return { sequence: 1 };
          }),
      };

      yield* runReconciliation(input).pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
        Effect.scoped,
      );
      assert.deepStrictEqual(sends, []);
      assert.equal(thread.session.status, "starting");
      assert.equal(thread.session.activeTurnId, null);
      assert.deepStrictEqual(binding.runtimePayload, {
        activeTurnId: null,
        continueAfterServerUpdate: turnId,
        continueAfterServerUpdatePrepared: true,
      });
      // The token is reserved before the fork, so even a continuation that is
      // still parked at activation is fenced for the engine to observe.
      assert.isDefined(continuations.current(thread.id));

      if (preparedStatus === "completed after update marking") {
        thread.session.status = "ready";
        binding = {
          ...binding,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            continueAfterServerUpdate: turnId,
            continueAfterServerUpdatePrepared: null,
          },
        };
        yield* runReconciliation(input);
        assert.deepStrictEqual(sends, []);
        assert.equal(thread.session.status, "ready");
        return;
      }
      thread.session.status =
        preparedStatus === "ready with failed scan" ? "ready" : preparedStatus;
      yield* runReconciliation(input);
      yield* Deferred.await(receiptFor(thread.id));
      assert.deepStrictEqual(sends, [
        { threadId: thread.id, continuation: true, interactionMode: "default" },
      ]);
      // The success records its evidence and leaves the prepared marker in
      // place instead of clearing it.
      assert.deepStrictEqual(binding.runtimePayload, {
        activeTurnId: null,
        continueAfterServerUpdate: turnId,
        continueAfterServerUpdatePrepared: true,
      });
      assert.deepStrictEqual(continuations.current(thread.id)?.evidence, {
        kind: "returned",
        turnId: TurnId.make("turn-recovered"),
      });
    }),
  );
}

it.effect("holds a failed opt-in recovery without retrying the provider turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-failed-recovery");
    const thread = makeThread("thread-failed-recovery", "running", turnId);
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const preparedPayloads: unknown[] = [];
    let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: thread.id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: "running",
      resumeCursor: { threadId: thread.id },
      runtimePayload: { activeTurnId: turnId },
    };
    const { continuations: real } = yield* makeRealContinuations;
    const { continuations, receiptFor } = makeRecordingContinuations(real);
    yield* runReconciliation({
      threads: [thread],
      continueAfterRestart: true,
      continuations,
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            preparedPayloads.push(binding.runtimePayload);
            return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
          }),
      },
      directory: {
        getBinding: () => Effect.sync(() => Option.some(binding)),
        upsert: (next) =>
          Effect.sync(() => {
            binding = next;
          }),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    });
    yield* Deferred.await(receiptFor(thread.id));
    assert.equal(sends.length, 1);
    assert.deepStrictEqual(preparedPayloads, [
      {
        activeTurnId: null,
        continueAfterServerUpdate: turnId,
        continueAfterServerUpdatePrepared: true,
      },
    ]);
    // A failed parked continuation holds: startup writes no session failure
    // and no binding stop, so the prepared state survives for the next
    // restart's synchronous re-check. Only the unverified evidence is recorded.
    assert.deepStrictEqual(
      dispatched.map(
        (command) =>
          command.type === "thread.session.set" && {
            status: command.session.status,
            activeTurnId: command.session.activeTurnId,
          },
      ),
      [{ status: "starting", activeTurnId: null }],
    );
    assert.equal(binding.status, "starting");
    assert.deepStrictEqual(binding.runtimePayload, {
      activeTurnId: null,
      continueAfterServerUpdate: turnId,
      continueAfterServerUpdatePrepared: true,
    });
    assert.deepStrictEqual(continuations.current(thread.id)?.evidence, { kind: "unverified" });
  }),
);

// A continuation prompt must not replay work whose outcome the projection cannot
// show: an unfinished tool call or a request still waiting for the user.
const INTERRUPTED_WORK_ERROR =
  "The server restarted while a tool was running or waiting for you, so its result is unknown. Check the workspace, then send a message to continue.";
const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
// Must equal THREAD_DETAIL_ACTIVITY_LIMIT in orchestration/Layers/ProjectionSnapshotQuery.ts.
const THREAD_ACTIVITY_READ_LIMIT = 500;

const interruptedTurnId = TurnId.make("turn-interrupted-work");
const earlierTurnId = TurnId.make("turn-earlier-work");

interface ToolRow {
  readonly kind: "tool.started" | "tool.completed";
  readonly turnId: TurnId | null;
  readonly payload: Record<string, unknown>;
}

const toolRow =
  (kind: ToolRow["kind"]) =>
  (
    toolCallId: string | null,
    itemType = "command_execution",
    turnId: TurnId | null = interruptedTurnId,
  ): ToolRow => ({
    kind,
    turnId,
    payload: { itemType, ...(toolCallId === null ? {} : { toolCallId }) },
  });
const started = toolRow("tool.started");
const completed = toolRow("tool.completed");

// Rows in the order the projection returns them: oldest first.
const toActivities = (rows: ReadonlyArray<ToolRow>) =>
  rows.map((row, index) => ({
    id: EventId.make(`activity-${index}`),
    tone: "tool" as const,
    kind: row.kind,
    summary: row.kind,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: updatedAt,
  }));

const finishedCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => [
    started(`finished-${index}`),
    completed(`finished-${index}`),
  ]).flat();

const activityReads = (rows: ReadonlyArray<ToolRow>) => ({
  ...nothingOpenReads,
  getThreadDetailById: () => Effect.succeedSome({ activities: toActivities(rows) } as never),
});

const persistenceFailure = new PersistenceSqlError({
  operation: "ProjectionSnapshotQuery.read",
  detail: "simulated projection read failure",
});

const readContinuationMarker = (binding: ProviderSessionDirectory.ProviderRuntimeBinding) => {
  const payload = binding.runtimePayload;
  return payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "continueAfterServerUpdate" in payload
    ? payload.continueAfterServerUpdate
    : undefined;
};

const recoveries = [
  "marked update",
  "opt-in restart",
  "prepared starting",
  "prepared ready",
] as const;

// One interrupted thread that is eligible to continue, entered through each path:
// the update marker, the opt-in setting, or a restart after continuation was prepared
// (the projection no longer names a turn, so the marker's turn is the interrupted one).
const runInterruptedThread = (input: {
  readonly recovery: (typeof recoveries)[number];
  readonly reads: ThreadReads;
  readonly provider?: "codex" | "claudeAgent";
  readonly observations?: ProviderSafetyObservations.ProviderSafetyObservations["Service"];
}) =>
  Effect.gen(function* () {
    const prepared = input.recovery.startsWith("prepared");
    const thread = prepared
      ? makeThread(
          "thread-interrupted-work",
          input.recovery === "prepared ready" ? "ready" : "starting",
          null,
          null,
          null,
          input.provider,
        )
      : makeThread(
          "thread-interrupted-work",
          "running",
          interruptedTurnId,
          null,
          null,
          input.provider,
        );
    const binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: thread.id,
      provider: ProviderDriverKind.make(input.provider ?? "codex"),
      providerInstanceId: thread.session.providerInstanceId,
      status: prepared ? "starting" : "running",
      resumeCursor: { threadId: thread.id },
      runtimePayload: prepared
        ? {
            activeTurnId: null,
            continueAfterServerUpdate: interruptedTurnId,
            continueAfterServerUpdatePrepared: true,
          }
        : {
            activeTurnId: interruptedTurnId,
            ...(input.recovery === "marked update"
              ? { continueAfterServerUpdate: interruptedTurnId }
              : {}),
          },
    };
    const { continuations: real } = yield* makeRealContinuations;
    const { continuations, receiptFor } = makeRecordingContinuations(real);
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const exit = yield* runReconciliation({
      threads: [thread],
      continueAfterRestart: input.recovery === "opt-in restart",
      reads: input.reads,
      ...(input.observations === undefined ? {} : { observations: input.observations }),
      continuations,
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        sendTurn: (turnInput) =>
          Effect.gen(function* () {
            sends.push(turnInput);
            return { threadId: turnInput.threadId, turnId: TurnId.make("turn-continued-work") };
          }),
      },
      directory: {
        getBinding: () => Effect.succeedSome(binding),
        upsert: (next) => Effect.sync(() => upserts.push(next)),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () =>
          Effect.succeed(
            input.recovery === "prepared ready"
              ? [{ ...binding, lastSeenAt: "2026-01-01T00:00:00.000Z" }]
              : [],
          ),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(Effect.exit);
    return {
      thread,
      exit,
      sends,
      dispatched,
      upserts,
      recorded: receiptFor(thread.id),
      continuations,
    };
  });

const sessionSets = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "thread.session.set"
      ? [
          {
            status: command.session.status,
            activeTurnId: command.session.activeTurnId,
            lastError: command.session.lastError,
          },
        ]
      : [],
  );

type InterruptedRun = Effect.Success<ReturnType<typeof runInterruptedThread>>;

const assertSettledWithoutContinuing = (run: InterruptedRun, lastError: string) => {
  assert.isTrue(Exit.isSuccess(run.exit));
  assert.deepStrictEqual(run.sends, []);
  assert.deepStrictEqual(sessionSets(run.dispatched), [
    { status: "error", activeTurnId: null, lastError },
  ]);
  assert.deepStrictEqual(
    run.upserts.map((binding) => ({
      status: binding.status,
      runtimePayload: binding.runtimePayload,
    })),
    [
      {
        status: "stopped",
        runtimePayload: {
          activeTurnId: null,
          continueAfterServerUpdate: null,
          continueAfterServerUpdatePrepared: null,
        },
      },
    ],
  );
  // The synchronous conservative settlement runs before prepare and fork, so
  // no continuation token was reserved.
  assert.equal(run.continuations.current(run.thread.id), undefined);
};

const assertContinued = (run: InterruptedRun) =>
  Effect.gen(function* () {
    yield* Deferred.await(run.recorded);
    assert.isTrue(Exit.isSuccess(run.exit));
    assert.deepStrictEqual(run.sends, [
      { threadId: run.thread.id, continuation: true, interactionMode: "default" },
    ]);
    assert.deepStrictEqual(
      sessionSets(run.dispatched).map((set) => set.status),
      ["starting"],
    );
    // Success records the returned turn as evidence and writes no
    // marker-clearing binding update.
    assert.deepStrictEqual(run.continuations.current(run.thread.id)?.evidence, {
      kind: "returned",
      turnId: TurnId.make("turn-continued-work"),
    });
    assert.equal(
      run.upserts.some((binding) => readContinuationMarker(binding) === null),
      false,
    );
  });

const unfinishedWork = {
  "an unfinished command": [started("call-1")],
  "an unfinished file change beside an unrelated completion": [
    started("call-1", "file_change"),
    completed("call-2", "file_change"),
  ],
  "an unfinished call without an id": [started(null)],
  "an unfinished read-only call without an id": [started(null, "web_search")],
  "an unfinished image view without an id": [started(null, "image_view")],
  "an unfinished tool of an unrecognized type": [started("call-1", "future_tool")],
  "an unfinished tool without a type": [
    { kind: "tool.started", turnId: interruptedTurnId, payload: { toolCallId: "call-1" } },
  ],
  "an unfinished tool without a turn": [started("call-1", "command_execution", null)],
  "a completion that precedes its start": [completed("call-1"), started("call-1")],
  "an id started twice before its completion": [
    started("call-1"),
    started("call-1"),
    completed("call-1"),
  ],
  "an id started twice after a completion": [
    completed("call-1"),
    started("call-1"),
    started("call-1"),
  ],
  "a read-only call started twice": [
    started("search-1", "web_search"),
    started("search-1", "web_search"),
  ],
  "a call without a turn started twice and completed once": [
    started("call-1", "command_execution", null),
    started("call-1", "command_execution", null),
    completed("call-1", "command_execution", null),
  ],
  "a completion without a turn for a call started in the turn": [
    started("call-1"),
    completed("call-1", "command_execution", null),
  ],
  "a completion in the turn for a call started without a turn": [
    started("call-1", "command_execution", null),
    completed("call-1"),
  ],
  "an id reused after its completion": [started("call-1"), completed("call-1"), started("call-1")],
  "an id completed only by an earlier turn": [
    started("call-1", "command_execution", earlierTurnId),
    completed("call-1", "command_execution", earlierTurnId),
    started("call-1"),
  ],
} as const satisfies Record<string, ReadonlyArray<ToolRow>>;

it.effect.each(
  recoveries.flatMap((recovery) =>
    (Object.keys(unfinishedWork) as Array<keyof typeof unfinishedWork>).map((scenario) => ({
      recovery,
      scenario,
    })),
  ),
)("does not continue $recovery with $scenario", ({ recovery, scenario }) =>
  Effect.gen(function* () {
    const run = yield* runInterruptedThread({
      recovery,
      reads: activityReads(unfinishedWork[scenario]),
    });
    assertSettledWithoutContinuing(run, INTERRUPTED_WORK_ERROR);
  }),
);

it.effect.each(
  recoveries.flatMap((recovery) =>
    (["hasPendingApprovals", "hasPendingUserInput"] as const).map((pending) => ({
      recovery,
      pending,
    })),
  ),
)("does not continue $recovery while the thread has $pending", ({ recovery, pending }) =>
  Effect.gen(function* () {
    const run = yield* runInterruptedThread({
      recovery,
      reads: {
        ...nothingOpenReads,
        getThreadShellById: () =>
          Effect.succeedSome({
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            [pending]: true,
          } as never),
      },
    });
    assertSettledWithoutContinuing(run, INTERRUPTED_WORK_ERROR);
  }),
);

const unverifiableHistory = {
  "a missing thread shell": { ...nothingOpenReads, getThreadShellById: () => Effect.succeedNone },
  "a missing thread detail": {
    ...nothingOpenReads,
    getThreadDetailById: () => Effect.succeedNone,
  },
  "a failed shell read": {
    ...nothingOpenReads,
    getThreadShellById: () => Effect.fail(persistenceFailure),
  },
  "a failed detail read": {
    ...nothingOpenReads,
    getThreadDetailById: () => Effect.fail(persistenceFailure),
  },
  "a defect while reading the detail": {
    ...nothingOpenReads,
    getThreadDetailById: () => Effect.die("projection unavailable"),
  },
  // The read drops the oldest rows once it is full, so a full read proves nothing.
  "a history that fills the read limit": activityReads(
    finishedCalls(THREAD_ACTIVITY_READ_LIMIT / 2),
  ),
} as const satisfies Record<string, ThreadReads>;

it.effect.each(
  recoveries.flatMap((recovery) =>
    (Object.keys(unverifiableHistory) as Array<keyof typeof unverifiableHistory>).map(
      (scenario) => ({ recovery, scenario }),
    ),
  ),
)("does not continue $recovery with $scenario", ({ recovery, scenario }) =>
  Effect.gen(function* () {
    const run = yield* runInterruptedThread({ recovery, reads: unverifiableHistory[scenario] });
    assertSettledWithoutContinuing(run, ORPHANED_PROVIDER_SESSION_ERROR);
  }),
);

it.effect.each(recoveries.map((recovery) => ({ recovery })))(
  "reports an unfinished call found in a history that fills the read limit for $recovery",
  ({ recovery }) =>
    Effect.gen(function* () {
      const run = yield* runInterruptedThread({
        recovery,
        reads: activityReads([
          ...finishedCalls(THREAD_ACTIVITY_READ_LIMIT / 2 - 1),
          started("open-1"),
          started("open-2"),
        ]),
      });
      assertSettledWithoutContinuing(run, INTERRUPTED_WORK_ERROR);
    }),
);

const cleanHistory = {
  "no tool activity": [],
  "every tool finished and only read-only calls are unfinished": [
    started("call-1"),
    completed("call-1"),
    started("search-1", "web_search"),
    started("image-1", "image_view"),
  ],
  "a call without a turn started and completed without a turn": [
    started("call-1", "command_execution", null),
    completed("call-1", "command_execution", null),
  ],
  "an earlier turn left a tool unfinished": [
    started("old-1", "command_execution", earlierTurnId),
    started("old-2", "mcp_tool_call", earlierTurnId),
    started(null, "command_execution", earlierTurnId),
    started("call-1"),
    completed("call-1"),
  ],
  "an earlier turn left the same id unfinished": [
    started("call-1", "command_execution", earlierTurnId),
    started("call-1"),
    completed("call-1"),
  ],
  "the history is one row short of the read limit": [
    ...finishedCalls(THREAD_ACTIVITY_READ_LIMIT / 2 - 1),
    completed("extra"),
  ],
} as const satisfies Record<string, ReadonlyArray<ToolRow>>;

it.effect("settles Claude as unverified when the safety observation query fails", () =>
  Effect.gen(function* () {
    const queried: Array<{ threadId: ThreadId; turnId: TurnId }> = [];
    const run = yield* runInterruptedThread({
      recovery: "opt-in restart",
      provider: "claudeAgent",
      reads: activityReads([]),
      observations: ProviderSafetyObservations.ProviderSafetyObservations.of({
        record: () => Effect.die("unused"),
        hasUnprojected: (input) =>
          Effect.sync(() => queried.push(input)).pipe(
            Effect.andThen(
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProviderSafetyObservations.hasUnprojected",
                  detail: "simulated query failure",
                }),
              ),
            ),
          ),
      }),
    });
    assert.deepStrictEqual(queried, [{ threadId: run.thread.id, turnId: interruptedTurnId }]);
    assertSettledWithoutContinuing(run, ORPHANED_PROVIDER_SESSION_ERROR);
  }),
);

it.effect("continues clean Codex history without querying safety observations", () =>
  Effect.gen(function* () {
    let queried = 0;
    const run = yield* runInterruptedThread({
      recovery: "opt-in restart",
      reads: activityReads([]),
      observations: ProviderSafetyObservations.ProviderSafetyObservations.of({
        record: () => Effect.die("unused"),
        hasUnprojected: () =>
          Effect.sync(() => {
            queried += 1;
          }).pipe(Effect.andThen(Effect.die("Codex safety query must not run"))),
      }),
    });
    yield* assertContinued(run);
    assert.equal(queried, 0);
  }),
);

it.effect.each(
  recoveries.flatMap((recovery) =>
    (Object.keys(cleanHistory) as Array<keyof typeof cleanHistory>).map((scenario) => ({
      recovery,
      scenario,
    })),
  ),
)("continues $recovery when $scenario", ({ recovery, scenario }) =>
  Effect.gen(function* () {
    const run = yield* runInterruptedThread({
      recovery,
      reads: activityReads(cleanHistory[scenario]),
    });
    yield* assertContinued(run);
  }),
);

it.effect.each(
  recoveries.flatMap((recovery) =>
    (["shell", "detail"] as const).map((read) => ({ recovery, read })),
  ),
)(
  "stops without sending or settling when the $read read is interrupted for $recovery",
  ({ recovery, read }) =>
    Effect.gen(function* () {
      const run = yield* runInterruptedThread({
        recovery,
        reads: {
          ...nothingOpenReads,
          ...(read === "shell"
            ? { getThreadShellById: () => Effect.interrupt }
            : { getThreadDetailById: () => Effect.interrupt }),
        },
      });
      assert.isTrue(Exit.isFailure(run.exit) && Cause.hasInterrupts(run.exit.cause));
      assert.deepStrictEqual(run.sends, []);
      assert.deepStrictEqual(run.dispatched, []);
      assert.deepStrictEqual(run.upserts, []);
    }),
);

for (const scenario of ["disabled", "stopped binding", "missing cursor"] as const) {
  it.effect(`does not read thread history for an orphan that cannot continue: ${scenario}`, () => {
    const thread = makeThread("thread-no-candidate", "running", interruptedTurnId);
    const dispatched: OrchestrationCommand[] = [];
    let reads = 0;
    const countRead = <A>(value: A) => Effect.sync(() => (reads += 1)).pipe(Effect.as(value));
    return runReconciliation({
      threads: [thread],
      continueAfterRestart: scenario !== "disabled",
      reads: {
        getThreadShellById: () => countRead(Option.none()),
        getThreadDetailById: () => countRead(Option.none()),
      },
      directory: {
        getBinding: () =>
          Effect.succeedSome({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: scenario === "stopped binding" ? "stopped" : "running",
            ...(scenario === "missing cursor" ? {} : { resumeCursor: { threadId: thread.id } }),
            runtimePayload: { activeTurnId: interruptedTurnId },
          }),
        upsert: () => Effect.void,
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.equal(reads, 0);
          assert.deepStrictEqual(sessionSets(dispatched), [
            { status: "error", activeTurnId: null, lastError: ORPHANED_PROVIDER_SESSION_ERROR },
          ]);
        }),
      ),
    );
  });
}

it.effect("settles one thread with unfinished work and still continues the next one", () =>
  Effect.gen(function* () {
    const blocked = makeThread(
      "thread-guard-blocked",
      "running",
      TurnId.make("turn-guard-blocked"),
    );
    const clean = makeThread("thread-guard-clean", "running", TurnId.make("turn-guard-clean"));
    const continued = yield* Deferred.make<void>();
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    // Both threads reuse one call id: it must only be judged inside its own thread and turn.
    const rowsByThread = new Map([
      [blocked.id, [started("call-1", "command_execution", blocked.session.activeTurnId)]],
      [
        clean.id,
        [
          started("call-1", "command_execution", clean.session.activeTurnId),
          completed("call-1", "command_execution", clean.session.activeTurnId),
        ],
      ],
    ]);

    yield* runReconciliation({
      threads: [blocked, clean],
      continueAfterRestart: true,
      reads: {
        ...nothingOpenReads,
        getThreadDetailById: (threadId) =>
          Effect.succeedSome({
            activities: toActivities(rowsByThread.get(threadId) ?? []),
          } as never),
      },
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            yield* Deferred.succeed(continued, undefined);
            return { threadId: input.threadId, turnId: TurnId.make("turn-recovered") };
          }),
      },
      directory: {
        getBinding: (threadId) =>
          Effect.succeedSome({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { threadId },
            runtimePayload: { activeTurnId: threadId === blocked.id ? "blocked" : "clean" },
          }),
        upsert: () => Effect.void,
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    });
    yield* Deferred.await(continued);

    assert.deepStrictEqual(sends, [
      { threadId: clean.id, continuation: true, interactionMode: "default" },
    ]);
    assert.deepStrictEqual(
      dispatched.map(
        (command) =>
          command.type === "thread.session.set" && {
            threadId: command.threadId,
            status: command.session.status,
          },
      ),
      [
        { threadId: blocked.id, status: "error" },
        { threadId: clean.id, status: "starting" },
      ],
    );
  }),
);

// A committed user turn start whose provider turn never began leaves a pending
// placeholder row behind. That row is checked before prepare and fork, so the
// turn replays through the existing synchronous conservative settlement with
// zero adapter calls and no continuation token, even with a clean history.
it.effect("settles a stored pending turn start as interrupted work without continuing", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-pending-start");
    const thread = makeThread("thread-pending-start", "running", turnId);
    const pendingReads: Array<{ readonly threadId: ThreadId }> = [];
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const { continuations } = yield* makeRealContinuations;

    yield* Effect.gen(function* () {
      const repo = yield* ProjectionTurnRepository;
      yield* repo.replacePendingTurnStart({
        threadId: thread.id,
        messageId: MessageId.make("msg-pending-start"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: updatedAt,
      });
      yield* runReconciliation({
        threads: [thread],
        continueAfterRestart: true,
        projectionTurnRepository: {
          ...repo,
          getPendingTurnStartByThreadId: (input) =>
            Effect.sync(() => pendingReads.push(input)).pipe(
              Effect.andThen(repo.getPendingTurnStartByThreadId(input)),
            ),
        },
        continuations,
        providerService: {
          ...makeProviderService(),
          getCapabilities: () =>
            Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
          sendTurn: (input) =>
            Effect.sync(() => sends.push(input)).pipe(
              Effect.as({ threadId: input.threadId, turnId: TurnId.make("turn-unexpected") }),
            ),
        },
        directory: {
          getBinding: () =>
            Effect.succeedSome({
              threadId: thread.id,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { threadId: thread.id },
              runtimePayload: { activeTurnId: turnId, continueAfterServerUpdate: turnId },
            }),
          upsert: (binding) => Effect.sync(() => upserts.push(binding)),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqlitePersistenceMemory,
          ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
        ),
      ),
    );

    assert.deepStrictEqual(pendingReads, [{ threadId: thread.id }]);
    assert.deepStrictEqual(sends, []);
    assert.deepStrictEqual(sessionSets(dispatched), [
      { status: "error", activeTurnId: null, lastError: INTERRUPTED_WORK_ERROR },
    ]);
    assert.deepStrictEqual(
      upserts.map((binding) => binding.status),
      ["stopped"],
    );
    assert.equal(continuations.current(thread.id), undefined);
  }),
);

it.effect("settles conservatively when the pending turn start read fails", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-pending-read-failure");
    const thread = makeThread("thread-pending-read-failure", "running", turnId);
    const pendingReads: Array<{ readonly threadId: ThreadId }> = [];
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const { continuations } = yield* makeRealContinuations;

    yield* Effect.gen(function* () {
      const repo = yield* ProjectionTurnRepository;
      yield* runReconciliation({
        threads: [thread],
        continueAfterRestart: true,
        projectionTurnRepository: {
          ...repo,
          getPendingTurnStartByThreadId: (input) =>
            Effect.sync(() => pendingReads.push(input)).pipe(
              Effect.andThen(
                Effect.fail(
                  new PersistenceSqlError({
                    operation: "ProjectionTurnRepository.getPendingTurnStartByThreadId",
                    detail: "simulated pending read failure",
                  }),
                ),
              ),
            ),
        },
        continuations,
        providerService: {
          ...makeProviderService(),
          getCapabilities: () =>
            Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
          sendTurn: (input) =>
            Effect.sync(() => sends.push(input)).pipe(
              Effect.as({ threadId: input.threadId, turnId: TurnId.make("turn-unexpected") }),
            ),
        },
        directory: {
          getBinding: () =>
            Effect.succeedSome({
              threadId: thread.id,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { threadId: thread.id },
              runtimePayload: { activeTurnId: turnId, continueAfterServerUpdate: turnId },
            }),
          upsert: () => Effect.void,
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqlitePersistenceMemory,
          ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
        ),
      ),
    );

    assert.deepStrictEqual(pendingReads, [{ threadId: thread.id }]);
    assert.deepStrictEqual(sends, []);
    assert.deepStrictEqual(sessionSets(dispatched), [
      { status: "error", activeTurnId: null, lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    ]);
    assert.equal(continuations.current(thread.id), undefined);
  }),
);

it.effect(
  "settles an eligible continuation whose provider instance is missing without reserving a token",
  () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-missing-instance");
      const thread = makeThread("thread-missing-instance", "running", turnId);
      const sends: ProviderSendTurnInput[] = [];
      const dispatched: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const { continuations } = yield* makeRealContinuations;

      yield* runReconciliation({
        threads: [thread],
        continueAfterRestart: true,
        continuations,
        providerService: {
          ...makeProviderService(),
          getCapabilities: () =>
            Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
          sendTurn: (input) =>
            Effect.sync(() => sends.push(input)).pipe(
              Effect.as({ threadId: input.threadId, turnId: TurnId.make("turn-unexpected") }),
            ),
        },
        directory: {
          getBinding: () =>
            Effect.succeedSome({
              threadId: thread.id,
              provider: ProviderDriverKind.make("codex"),
              // The instance id is missing: the conservative settlement must
              // run before prepare and reserve instead of inventing an id.
              status: "running" as const,
              resumeCursor: { threadId: thread.id },
              runtimePayload: { activeTurnId: turnId, continueAfterServerUpdate: turnId },
            }),
          upsert: (binding) => Effect.sync(() => upserts.push(binding)),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });

      assert.deepStrictEqual(sends, []);
      assert.deepStrictEqual(
        dispatched.map(
          (command) => command.type === "thread.session.set" && command.session.status,
        ),
        ["error"],
      );
      assert.deepStrictEqual(
        upserts.map((binding) => binding.status),
        ["stopped"],
      );
      assert.equal(continuations.current(thread.id), undefined);
    }),
);

it.effect("holds a failed capability lookup before any provider turn is attempted", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-failed-capability");
    const thread = makeThread("thread-failed-capability", "running", turnId);
    const capabilitiesQueried = yield* Deferred.make<void>();
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: thread.id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: "running",
      resumeCursor: { threadId: thread.id },
      runtimePayload: { activeTurnId: turnId },
    };
    const { continuations: real } = yield* makeRealContinuations;
    const { continuations, receiptFor } = makeRecordingContinuations(real);
    yield* runReconciliation({
      threads: [thread],
      continueAfterRestart: true,
      continuations,
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(capabilitiesQueried, undefined);
            return yield* new ProviderInstanceNotFoundError({ instanceId: providerInstanceId });
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            return { threadId: input.threadId, turnId: TurnId.make("turn-unexpected") };
          }),
      },
      directory: {
        getBinding: () => Effect.sync(() => Option.some(binding)),
        upsert: (next) =>
          Effect.sync(() => {
            binding = next;
          }),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    });
    yield* Deferred.await(capabilitiesQueried);
    assert.deepStrictEqual(sends, []);
    // The pre-adapter failure holds like any other parked failure: the
    // prepared marker and the starting session survive untouched.
    assert.deepStrictEqual(
      dispatched.map(
        (command) =>
          command.type === "thread.session.set" && {
            status: command.session.status,
            activeTurnId: command.session.activeTurnId,
          },
      ),
      [{ status: "starting", activeTurnId: null }],
    );
    assert.equal(binding.status, "starting");
    assert.deepStrictEqual(binding.runtimePayload, {
      activeTurnId: null,
      continueAfterServerUpdate: turnId,
      continueAfterServerUpdatePrepared: true,
    });
    yield* Deferred.await(receiptFor(thread.id));
    assert.deepStrictEqual(continuations.current(thread.id)?.evidence, { kind: "unverified" });
  }),
);

it.effect(
  "records a revoked continuation and writes nothing when a stop lands before the send",
  () =>
    Effect.gen(function* () {
      const held = makeThread("thread-restart-hold", "running", TurnId.make("turn-restart-hold"));
      const fresh = makeThread(
        "thread-restart-fresh",
        "running",
        TurnId.make("turn-restart-fresh"),
      );
      const { continuations: real } = yield* makeRealContinuations;
      const { continuations, receiptFor } = makeRecordingContinuations(real);
      const enteredHold = yield* Deferred.make<void>();
      const releaseHold = yield* Deferred.make<void>();
      const adapterCalls: ThreadId[] = [];
      const dispatched: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>(
        [held, fresh].map((thread) => [
          thread.id,
          {
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { threadId: thread.id },
            runtimePayload: {
              activeTurnId: thread.session.activeTurnId,
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          },
        ]),
      );
      const providerService: ProviderService.ProviderService["Service"] = {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        // Mirrors the provider's continuation entry gate: a token that stopped
        // being live fails before any adapter effect is admitted.
        sendTurn: (input, options) =>
          Effect.gen(function* () {
            const token = options?.continuation;
            if (token === undefined || token.threadId !== held.id) {
              adapterCalls.push(input.threadId);
              return { threadId: input.threadId, turnId: TurnId.make("turn-fresh-continued") };
            }
            yield* Deferred.succeed(enteredHold, undefined);
            yield* Deferred.await(releaseHold);
            if (!continuations.isLive(token)) {
              return yield* new ProviderContinuationRevokedError({
                operation: "sendTurn",
                threadId: String(input.threadId),
                issue: "continuation revoked before the adapter effect",
              });
            }
            adapterCalls.push(input.threadId);
            return { threadId: input.threadId, turnId: TurnId.make("turn-unexpected") };
          }),
      };

      yield* runReconciliation({
        threads: [held, fresh],
        continueAfterRestart: true,
        providerService,
        continuations,
        directory: {
          getBinding: (threadId) => {
            const binding = bindings.get(threadId);
            return binding === undefined ? Effect.succeedNone : Effect.succeedSome(binding);
          },
          upsert: (binding) =>
            Effect.sync(() => {
              bindings.set(binding.threadId, binding);
              upserts.push(binding);
            }),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });
      // Reserve happens before the fork, so the held token exists to revoke.
      const holdToken = continuations.current(held.id);
      assert.isDefined(holdToken);
      yield* Deferred.await(enteredHold);
      // An accepted Stop's first action is revoking whatever token is held.
      assert.deepStrictEqual(continuations.revokeAnyHeld(held.id), { wasUnfinished: true });
      yield* Deferred.succeed(releaseHold, undefined);
      // Each parked send settles past its adapter outcome before it records:
      // the revoked hold after the rejection, the fresh thread after success.
      yield* Deferred.await(receiptFor(held.id));
      yield* Deferred.await(receiptFor(fresh.id));

      // The held thread: zero adapter effects and zero startup failure writes.
      assert.deepStrictEqual(adapterCalls, [fresh.id]);
      assert.deepStrictEqual(
        dispatched.flatMap((command) =>
          command.type === "thread.session.set" && command.threadId === held.id
            ? [{ status: command.session.status, activeTurnId: command.session.activeTurnId }]
            : [],
        ),
        [{ status: "starting", activeTurnId: null }],
      );
      assert.deepStrictEqual(
        upserts
          .filter((binding) => binding.threadId === held.id)
          .map((binding) => binding.runtimePayload),
        [
          {
            activeTurnId: null,
            continueAfterServerUpdate: held.session.activeTurnId,
            continueAfterServerUpdatePrepared: true,
          },
        ],
      );
      assert.deepStrictEqual(continuations.current(held.id)?.evidence, { kind: "revoked" });
      // The other thread continues normally in the same run.
      assert.deepStrictEqual(
        dispatched.flatMap((command) =>
          command.type === "thread.session.set" && command.threadId === fresh.id
            ? [{ status: command.session.status, activeTurnId: command.session.activeTurnId }]
            : [],
        ),
        [{ status: "starting", activeTurnId: null }],
      );
      assert.deepStrictEqual(continuations.current(fresh.id)?.evidence, {
        kind: "returned",
        turnId: TurnId.make("turn-fresh-continued"),
      });
    }),
);

it.effect("re-checks a held thread with the same synchronous gates on the next runtime", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-held-across-restarts");
    const thread = makeThread("thread-held-across-restarts", "running", turnId);
    const { continuations: real } = yield* makeRealContinuations;
    const { continuations, receiptFor } = makeRecordingContinuations(real);
    let sendCount = 0;
    let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: thread.id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: "running",
      resumeCursor: { threadId: thread.id },
      runtimePayload: { activeTurnId: turnId, continueAfterServerUpdate: turnId },
    };
    const dispatched: OrchestrationCommand[] = [];
    const input = {
      threads: [thread],
      continueAfterRestart: true,
      continuations,
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({
            sessionModelSwitch: "in-session" as const,
            promptlessTurnContinuation: true,
          }),
        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.gen(function* () {
            sendCount += 1;
            return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
          }),
      },
      directory: {
        getBinding: () => Effect.sync(() => Option.some(binding)),
        upsert: (next: ProviderSessionDirectory.ProviderRuntimeBinding) =>
          Effect.sync(() => {
            binding = next;
          }),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.session.set") {
            thread.session.status = command.session.status;
            thread.session.activeTurnId = command.session.activeTurnId;
          }
          return { sequence: dispatched.length };
        }),
    };

    yield* runReconciliation(input);
    const firstToken = continuations.current(thread.id);
    assert.isDefined(firstToken);
    yield* Deferred.await(receiptFor(thread.id));
    assert.deepStrictEqual(firstToken?.evidence, { kind: "unverified" });

    // The next runtime re-checks the same durable state through the same
    // synchronous gates and holds again on the same recurring failure.
    yield* runReconciliation(input);
    yield* Deferred.await(receiptFor(thread.id));
    assert.equal(sendCount, 2);
    assert.deepStrictEqual(
      dispatched.map((command) => command.type === "thread.session.set" && command.session.status),
      ["starting", "starting"],
    );
    assert.deepStrictEqual(binding.runtimePayload, {
      activeTurnId: null,
      continueAfterServerUpdate: turnId,
      continueAfterServerUpdatePrepared: true,
    });
    const secondToken = continuations.current(thread.id);
    assert.isDefined(secondToken);
    assert.notStrictEqual(secondToken, firstToken);
    assert.isTrue(firstToken?.revoked);
    assert.deepStrictEqual(secondToken?.evidence, { kind: "unverified" });
  }),
);

it.effect("fails startup when the command read model cannot be read", () =>
  Effect.gen(function* () {
    let inventoried = false;
    const exit = yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(
        ProviderSafetyObservations.ProviderSafetyObservations,
        noSafetyObservations,
      ),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        getCommandReadModel: () => Effect.fail(persistenceFailure),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderService.ProviderService, {
        ...makeProviderService(),
        listSessions: () =>
          Effect.sync(() => {
            inventoried = true;
            return [];
          }),
      }),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
        getBinding: () => Effect.die("unused"),
        upsert: () => Effect.die("unused"),
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      // The failing read-model read stops the flow before either service runs,
      // but the requirements are static: ride the same real instances as
      // runReconciliation.
      Effect.provide(
        Layer.mergeAll(
          ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
          restartContinuationsLayer,
          projectMemorySendGateFixtureLayer,
        ),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest())),
      Effect.exit,
    );

    assert.equal(inventoried, true);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.isTrue(error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError);
      if (error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError) {
        assert.deepStrictEqual(error.threadIds, []);
      }
    }
  }),
);

it.effect("fails startup when an uncertain interrupted session cannot be settled", () =>
  Effect.gen(function* () {
    const thread = makeThread(
      "thread-uncertain-settle-failure",
      "running",
      TurnId.make("turn-uncertain-settle"),
    );
    const sends: ProviderSendTurnInput[] = [];
    const attempted: OrchestrationSessionStatus[] = [];
    const failure = new OrchestrationCommandInvariantError({
      commandType: "thread.session.set",
      detail: "simulated settlement write failure",
    });

    const exit = yield* runReconciliation({
      threads: [thread],
      reads: {
        ...nothingOpenReads,
        getThreadShellById: () =>
          Effect.succeedSome({
            hasPendingApprovals: true,
            hasPendingUserInput: false,
          } as never),
      },
      providerService: {
        ...makeProviderService(),
        sendTurn: (input) =>
          Effect.sync(() => sends.push(input)).pipe(
            Effect.as({ threadId: input.threadId, turnId: TurnId.make("turn-unexpected") }),
          ),
      },
      directory: {
        getBinding: () =>
          Effect.succeedSome({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { threadId: thread.id },
            runtimePayload: {
              activeTurnId: thread.session.activeTurnId,
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          }),
        upsert: () => Effect.void,
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) => {
        if (command.type !== "thread.session.set") {
          return Effect.die("unexpected command");
        }
        attempted.push(command.session.status);
        return Effect.fail(failure);
      },
    }).pipe(Effect.exit);

    assert.deepStrictEqual(attempted, ["error", "error"]);
    assert.deepStrictEqual(sends, []);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.isTrue(error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError);
      if (error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError) {
        assert.deepStrictEqual(error.threadIds, [thread.id]);
      }
    }
  }),
);

it.effect("fails startup when a failed continuation preparation cannot be settled", () =>
  Effect.gen(function* () {
    const thread = makeThread(
      "thread-prepare-settle-failure",
      "running",
      TurnId.make("turn-prepare-settle"),
    );
    const attempted: OrchestrationSessionStatus[] = [];
    const failure = new OrchestrationCommandInvariantError({
      commandType: "thread.session.set",
      detail: "simulated startup reconciliation failure",
    });

    const exit = yield* runReconciliation({
      threads: [thread],
      directory: {
        getBinding: () =>
          Effect.succeedSome({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { threadId: thread.id },
            runtimePayload: {
              activeTurnId: thread.session.activeTurnId,
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          }),
        upsert: () => Effect.void,
        upsertIf: () => Effect.die("unused"),
        upsertIfCurrent: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) => {
        if (command.type !== "thread.session.set") {
          return Effect.die("unexpected command");
        }
        attempted.push(command.session.status);
        return Effect.fail(failure);
      },
    }).pipe(Effect.exit);

    assert.deepStrictEqual(attempted, ["starting", "starting", "error", "error"]);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      assert.isTrue(error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError);
      if (error instanceof ServerRuntimeStartup.ProviderSessionRecoveryError) {
        assert.deepStrictEqual(error.threadIds, [thread.id]);
      }
    }
  }),
);

it.effect("preserves a persisted session error when settling an orphaned error session", () => {
  const savedError =
    "Part of the assistant's response could not be saved, so the answer shown may be incomplete.";
  const thread = makeThread(
    "thread-saved-error",
    "error",
    TurnId.make("turn-saved-error"),
    null,
    null,
    "codex",
    savedError,
  );
  const dispatched: OrchestrationCommand[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return runReconciliation({
    threads: [thread],
    directory: {
      getBinding: () => Effect.succeedNone,
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(sessionSets(dispatched), [
          { status: "error", activeTurnId: null, lastError: savedError },
        ]);
        assert.deepStrictEqual(upserts, []);
      }),
    ),
  );
});

it.effect("leaves an errored session without an active turn untouched", () => {
  const thread = makeThread(
    "thread-settled-error",
    "error",
    null,
    null,
    null,
    "codex",
    "Provider failure reported before the restart.",
  );
  const dispatched: OrchestrationCommand[] = [];
  const bindingReads: ThreadId[] = [];

  return runReconciliation({
    threads: [thread],
    directory: {
      getBinding: (candidate) =>
        Effect.sync(() => bindingReads.push(candidate)).pipe(Effect.as(Option.none())),
      upsert: () => Effect.die("unused"),
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(bindingReads, []);
        assert.deepStrictEqual(dispatched, []);
      }),
    ),
  );
});
