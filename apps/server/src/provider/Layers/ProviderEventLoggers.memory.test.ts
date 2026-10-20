// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  EventId,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUploadFeedbackInput,
  type ProviderUploadFeedbackResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as RestartContinuations from "../../restartContinuations.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderSafetyObservations from "../../persistence/ProviderSafetyObservations.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as ProjectMemorySendLedger from "../../persistence/ProjectMemorySendLedger.ts";
import * as ProjectMemories from "../../persistence/ProjectMemories.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { makeProviderServiceLive as makeProviderServiceLiveBase } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

// Deterministic purge fault injection: armed targets fail on rmSync alone and
// every other operation delegates to the real fs.
const rmSyncFault = vi.hoisted(() => ({
  armed: false,
  targets: new Set<string>(),
  attempts: [] as Array<string>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const [target] = args;
      const filePath = typeof target === "string" ? target : String(target);
      if (rmSyncFault.armed && rmSyncFault.targets.has(filePath)) {
        rmSyncFault.attempts.push(filePath);
        const error = new Error("simulated purge failure");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.rmSync as (...innerArgs: typeof args) => void)(...args);
    },
  };
});

afterEach(() => {
  rmSyncFault.armed = false;
  rmSyncFault.targets.clear();
  rmSyncFault.attempts.length = 0;
});

const NOW_ISO = "2026-01-01T00:00:00.000Z";
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const PROJECT = ProjectId.make("project-1");
const FLUSH_WINDOW_MS = 1_000;

const messageIdFor = (threadId: ThreadId): MessageId => MessageId.make(`msg-${threadId}`);

// Warning capture doubles as a flush-completion receipt: the store emits taint
// warnings only after a flush has finished lookups, purges, and writes.
const makeWarningCapture = Effect.gen(function* () {
  const entries: Array<ReadonlyArray<unknown>> = [];
  const taintTags: Array<string> = [];
  const taintQueue = yield* Queue.unbounded<string>();
  const capture = Logger.make<unknown, void>(({ message }) => {
    const entry = Array.isArray(message) ? message : [message];
    entries.push(entry);
    const text = entry[0];
    if (typeof text === "string" && text.startsWith("provider event log taint ")) {
      const context = entry[1];
      const failure =
        typeof context === "object" && context !== null && "failure" in context
          ? String((context as { failure: unknown }).failure)
          : "missing-failure-tag";
      taintTags.push(failure);
      Queue.offerUnsafe(taintQueue, failure);
    }
  });
  return { entries, taintTags, taintQueue, capture };
});

const provideWarnings = <A, E, R>(
  capture: Logger.Logger<unknown, void>,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));

// Allocates the capture queue effectfully, installs the capture logger for the
// body, and hands the warnings handle back so tests can await receipts.
const withWarnings = <A, E, R>(
  run: (warnings: Effect.Success<typeof makeWarningCapture>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const warnings = yield* makeWarningCapture;
    return yield* provideWarnings(warnings.capture, run(warnings));
  });

const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-provider-event-loggers-",
}).pipe(Layer.provide(NodeServices.layer));

const baseLayer = Layer.mergeAll(
  serverConfigTestLayer,
  SqlitePersistenceMemory,
  ResourceAttribution.layer,
);

const openBase = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const ctx = yield* Layer.build(baseLayer).pipe(Scope.provide(scope));
  return {
    scope,
    ctx,
    sql: Context.get(ctx, SqlClient.SqlClient),
    config: Context.get(ctx, ServerConfig.ServerConfig),
  };
});
type Base = Effect.Success<typeof openBase>;

const openData = (base: Base) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(ProjectMemorySendLedger.layer).pipe(
      Effect.provide(base.ctx),
      Scope.provide(scope),
    );
    return {
      scope,
      ledger: Context.get(ctx, ProjectMemorySendLedger.ProjectMemorySendLedger),
    };
  });

const openLoggers = (base: Base) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const ctx = yield* Layer.build(ProviderEventLoggers.layer).pipe(
      Effect.provide(base.ctx),
      Scope.provide(scope),
    );
    const loggers = Context.get(ctx, ProviderEventLoggers.ProviderEventLoggers);
    assert.notEqual(loggers.native, undefined);
    assert.notEqual(loggers.canonical, undefined);
    return { scope, loggers };
  });

const requireNative = (
  loggers: ProviderEventLoggers.ProviderEventLoggers["Service"],
): EventNdjsonLogger => {
  assert(loggers.native !== undefined);
  return loggers.native;
};

const noSafetyObservations = Layer.succeed(
  ProviderSafetyObservations.ProviderSafetyObservations,
  ProviderSafetyObservations.ProviderSafetyObservations.of({
    record: () => Effect.void,
    hasUnprojected: () => Effect.succeed(false),
  }),
);

const makeProviderServiceLive = () =>
  makeProviderServiceLiveBase().pipe(
    Layer.provide(noSafetyObservations),
    Layer.provide(RestartContinuations.layer),
  );

// Fake adapter whose sendTurn writes a native frame and emits a canonical
// echo through the real pubsub, so ProviderService records canonical output
// through the real ProviderEventLoggers before republishing. A `FAIL-` marker
// emits a runtime.error echo and then fails the turn.
//
// The adapter owns its PubSub subscription: it is acquired right here, before
// the ProviderService layer even builds, so the service's forked consumer
// reads a live subscription instead of racing its own `PubSub.subscribe`.
// `subscribed` is the explicit receipt for that acquisition.
const makeLoggingFakeAdapter = (native: EventNdjsonLogger, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const sessions = new Map<ThreadId, ProviderSession>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const subscription = yield* PubSub.subscribe(runtimeEventPubSub).pipe(Scope.provide(scope));
    const subscribed = yield* Deferred.make<void>();
    yield* Deferred.succeed(subscribed, undefined);

    const sendTurn = vi.fn(
      (
        input: ProviderSendTurnInput,
      ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
        if (!sessions.has(input.threadId)) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: String(CODEX_DRIVER),
              threadId: input.threadId,
            }),
          );
        }
        const marker = input.input ?? "";
        return Effect.gen(function* () {
          yield* native.write({ marker: `native ${marker}` }, input.threadId);
          const failing = marker.startsWith("FAIL-");
          yield* PubSub.publish(runtimeEventPubSub, {
            type: failing ? "runtime.error" : "thread.metadata.updated",
            eventId: EventId.make(`evt-${marker}`),
            provider: CODEX_DRIVER,
            providerInstanceId: CODEX_INSTANCE,
            threadId: input.threadId,
            createdAt: NOW_ISO,
            payload: failing
              ? { message: `adapter failed ${marker}` }
              : { name: `canonical ${marker}` },
          } as unknown as ProviderRuntimeEvent);
          if (failing) {
            return yield* new ProviderAdapterRequestError({
              provider: String(CODEX_DRIVER),
              method: "sendTurn",
              detail: `adapter failure ${marker}`,
            });
          }
          return { threadId: input.threadId, turnId: TurnId.make(`turn-${marker}`) };
        });
      },
    );

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: CODEX_DRIVER,
      capabilities: { sessionModelSwitch: "in-session", promptlessTurnContinuation: true },
      startSession: vi.fn(
        (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
          Effect.sync(() => {
            const session: ProviderSession = {
              provider: CODEX_DRIVER,
              providerInstanceId: CODEX_INSTANCE,
              status: "ready",
              runtimeMode: input.runtimeMode,
              threadId: input.threadId,
              resumeCursor: input.resumeCursor ?? { opaque: `resume-${input.threadId}` },
              cwd: input.cwd ?? process.cwd(),
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
            };
            sessions.set(session.threadId, session);
            return session;
          }),
      ),
      sendTurn,
      interruptTurn: vi.fn(
        (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
          Effect.void,
      ),
      respondToRequest: vi.fn(
        (
          _threadId: ThreadId,
          _requestId: string,
          _decision: ProviderApprovalDecision,
        ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
      ),
      respondToUserInput: vi.fn(
        (
          _threadId: ThreadId,
          _requestId: string,
          _answers: Record<string, unknown>,
        ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
      ),
      stopSession: vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
        Effect.sync(() => {
          sessions.delete(threadId);
        }),
      ),
      listSessions: vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
        Effect.sync(() => Array.from(sessions.values())),
      ),
      hasSession: vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
        Effect.succeed(sessions.has(threadId)),
      ),
      readThread: vi.fn(
        (
          threadId: ThreadId,
        ): Effect.Effect<
          { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: readonly [] }> },
          ProviderAdapterError
        > => Effect.succeed({ threadId, turns: [] }),
      ),
      rollbackThread: vi.fn(
        (
          threadId: ThreadId,
          _numTurns: number,
        ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
          Effect.succeed({ threadId, turns: [] }),
      ),
      uploadFeedback: vi.fn(
        (
          _input: ProviderUploadFeedbackInput,
        ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
          Effect.succeed({ feedbackId: "feedback-1" }),
      ),
      stopAll: vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
        Effect.sync(() => {
          sessions.clear();
        }),
      ),
      get streamEvents() {
        return Stream.fromSubscription(subscription);
      },
    };

    return { adapter, subscribed };
  });

type ProviderServiceValue = ProviderService.ProviderService["Service"];

const openApp = (base: Base) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const loggersCtx = yield* Layer.build(ProviderEventLoggers.layer).pipe(
      Effect.provide(base.ctx),
      Scope.provide(scope),
    );
    const loggers = Context.get(loggersCtx, ProviderEventLoggers.ProviderEventLoggers);
    const adapterHandle = yield* makeLoggingFakeAdapter(requireNative(loggers), scope);
    const appLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistry,
            makeAdapterRegistryMock({ [CODEX_DRIVER]: adapterHandle.adapter }),
          ),
        ),
        Layer.provide(
          ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, loggers)),
      ),
      ProjectMemorySendLedger.layer,
      ProjectMemories.layer,
    );
    const appCtx = yield* Layer.build(appLayer).pipe(
      Effect.provide(base.ctx),
      Scope.provide(scope),
    );
    // The adapter subscription predates this build; awaiting its receipt here
    // makes "no app is handed out without a live adapter subscription" an
    // ordering fact instead of a build-order assumption.
    yield* Deferred.await(adapterHandle.subscribed);
    return {
      scope,
      loggers,
      provider: Context.get(appCtx, ProviderService.ProviderService),
      ledger: Context.get(appCtx, ProjectMemorySendLedger.ProjectMemorySendLedger),
      memories: Context.get(appCtx, ProjectMemories.ProjectMemoryRepository),
    };
  });

const startInput = (threadId: ThreadId, cwd: string): ProviderSessionStartInput => ({
  provider: CODEX_DRIVER,
  providerInstanceId: CODEX_INSTANCE,
  threadId,
  runtimeMode: "full-access",
  cwd,
});

// The public echo receipt must not race `sendTurn`'s publish: an unbounded
// PubSub silently drops publications made while no subscriber exists, and in
// this installed Effect a `Stream.toPull` acquisition does not subscribe —
// the PubSub subscription only registers inside the stream's first pull.
// `forkChild` with `startImmediately` evaluates the consumer inline until its
// first suspension, so the filtered stream's subscription is registered
// before the fork returns and the joined head is a real ordering guarantee.
const subscribeEcho = (
  provider: ProviderServiceValue,
  threadId: ThreadId,
  marker: string,
  type: "thread.metadata.updated" | "runtime.error" = "thread.metadata.updated",
) =>
  provider.streamEvents.pipe(
    Stream.filter(
      (event) =>
        event.threadId === threadId &&
        event.type === type &&
        event.eventId === EventId.make(`evt-${marker}`),
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );

const sendAndAwaitEcho = (provider: ProviderServiceValue, threadId: ThreadId, marker: string) =>
  Effect.gen(function* () {
    const echoFiber = yield* subscribeEcho(provider, threadId, marker);
    yield* provider.sendTurn({ threadId, input: marker });
    const echo = Option.getOrThrow(yield* Fiber.join(echoFiber));
    assert.equal(echo.provider, CODEX_DRIVER);
    assert.equal(echo.providerInstanceId, CODEX_INSTANCE);
    assert.equal(echo.threadId, threadId);
    assert.deepEqual(echo.payload, { name: `canonical ${marker}` });
  });

const sendExpectingFailure = (provider: ProviderServiceValue, threadId: ThreadId, marker: string) =>
  Effect.gen(function* () {
    const echoFiber = yield* subscribeEcho(provider, threadId, marker, "runtime.error");
    const exit = yield* Effect.exit(provider.sendTurn({ threadId, input: marker }));
    const echo = Option.getOrThrow(yield* Fiber.join(echoFiber));
    assert.isTrue(Exit.isFailure(exit));
    assert.equal(echo.providerInstanceId, CODEX_INSTANCE);
    assert.deepEqual(echo.payload, { message: `adapter failed ${marker}` });
  });

const seedProjection = (sql: SqlClient.SqlClient, threads: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${PROJECT}, 'Project', '/tmp/project', '[]', ${NOW_ISO}, ${NOW_ISO}, NULL)
    `;
    for (const threadId of threads) {
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        )
        VALUES (
          ${threadId}, ${PROJECT}, 'Thread', '{}', 'full-access', 'default',
          ${NOW_ISO}, ${NOW_ISO}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (
          ${messageIdFor(threadId)}, ${threadId}, NULL, 'user', 'text', 0, ${NOW_ISO}, ${NOW_ISO}
        )
      `;
    }
  });

const seedMemoryRow = (sql: SqlClient.SqlClient, memoryId: ProjectMemoryId) =>
  sql`
    INSERT INTO project_memories (
      memory_id, project_id, kind, title, body, version,
      origin_type, origin_thread_id, origin_message_id,
      valid_until, estimated_tokens, created_at, updated_at
    )
    VALUES (
      ${memoryId}, ${PROJECT}, 'fact', 'Runbook title', 'Runbook body', 1,
      'manual', NULL, NULL, NULL, 10, ${NOW_ISO}, ${NOW_ISO}
    )
  `;

const commitAttempt = (
  ledger: ProjectMemorySendLedger.ProjectMemorySendLedger["Service"],
  threadId: ThreadId,
  items: ReadonlyArray<ProjectMemoryId>,
) =>
  Effect.gen(function* () {
    const result = yield* ledger.commitDispatch({
      threadId,
      messageId: messageIdFor(threadId),
      projectId: PROJECT,
      providerInstanceId: CODEX_INSTANCE,
      items: items.map((memoryId) => ({ memoryId, selectedVersion: 1 })),
      now: yield* DateTime.now,
    });
    assert.propertyVal(result, "status", "committed");
  });

const directoryFiles = (dir: string): Map<string, string> => {
  const files = new Map<string, string>();
  if (!NodeFS.existsSync(dir)) return files;
  for (const entry of NodeFS.readdirSync(dir).toSorted()) {
    const filePath = NodePath.join(dir, entry);
    if (NodeFS.statSync(filePath).isFile()) {
      files.set(entry, NodeFS.readFileSync(filePath, "utf8"));
    }
  }
  return files;
};

const directoryHasMarker = (dir: string, marker: string): boolean => {
  for (const content of directoryFiles(dir).values()) {
    if (content.includes(marker)) return true;
  }
  return false;
};

const writeFixture = (dir: string, name: string, line: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, name), line);
};

const fixtureLine = (marker: string) => `[${NOW_ISO}] NTIVE: {"marker":"${marker}"}\n`;

describe("ProviderEventLoggers memory taint", () => {
  // I1: real commit taints the thread; native and canonical records for it are
  // dropped while an untainted control thread still lands.
  it.effect("blocks tainted-thread records after a real memory send commit (I1)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings(() =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const app = yield* openApp(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);

            yield* app.provider.startSession(U, startInput(U, base.config.baseDir));
            yield* sendAndAwaitEcho(app.provider, U, "MARK-I1-CONTROL");

            yield* commitAttempt(app.ledger, T, [MEM]);
            yield* app.provider.startSession(T, startInput(T, base.config.baseDir));
            yield* sendAndAwaitEcho(app.provider, T, "MARK-I1-TAINTED");

            yield* Scope.close(app.scope, Exit.void);
            const dir = base.config.providerLogsDir;
            assert.isTrue(directoryHasMarker(dir, "native MARK-I1-CONTROL"));
            assert.isTrue(directoryHasMarker(dir, "canonical MARK-I1-CONTROL"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I1-TAINTED"));
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
          }).pipe(Effect.ensuring(Scope.close(app.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // I2: an adapter failure still emits a canonical error event for the tainted
  // thread; both lanes are dropped while the untainted control lands.
  it.effect("drops native and canonical error output for tainted adapter failures (I2)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings(() =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const app = yield* openApp(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);

            yield* app.provider.startSession(U, startInput(U, base.config.baseDir));
            yield* app.provider.startSession(T, startInput(T, base.config.baseDir));
            yield* sendAndAwaitEcho(app.provider, U, "MARK-I2-CONTROL");

            yield* commitAttempt(app.ledger, T, [MEM]);
            yield* sendExpectingFailure(app.provider, T, "FAIL-I2-TAINTED");

            yield* Scope.close(app.scope, Exit.void);
            const dir = base.config.providerLogsDir;
            assert.isTrue(directoryHasMarker(dir, "native MARK-I2-CONTROL"));
            assert.isTrue(directoryHasMarker(dir, "canonical MARK-I2-CONTROL"));
            assert.isFalse(directoryHasMarker(dir, "FAIL-I2-TAINTED"));
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
          }).pipe(Effect.ensuring(Scope.close(app.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // I3: memory edits and deletes through the real repository after the commit
  // do not lift taint; new tainted-thread records are still dropped.
  it.effect("keeps taint through real memory update and delete (I3)", () => {
    const T = ThreadId.make("t-taint");
    const MEM_A = ProjectMemoryId.make("mem-a");
    const MEM_B = ProjectMemoryId.make("mem-b");
    return withWarnings(() =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const app = yield* openApp(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [T]);
            yield* seedMemoryRow(base.sql, MEM_A);
            yield* seedMemoryRow(base.sql, MEM_B);

            yield* app.provider.startSession(T, startInput(T, base.config.baseDir));
            yield* commitAttempt(app.ledger, T, [MEM_A, MEM_B]);

            const updated = yield* app.memories.update({
              projectId: PROJECT,
              memoryId: MEM_A,
              expectedVersion: 1,
              title: "Runbook title",
              body: "edited body",
              kind: "fact",
              validUntil: null,
              estimatedTokens: 10,
              now: NOW_ISO,
            });
            assert.propertyVal(updated, "status", "applied");
            const deleted = yield* app.memories.delete({
              projectId: PROJECT,
              memoryId: MEM_B,
              expectedVersion: 1,
            });
            assert.propertyVal(deleted, "status", "applied");

            const affected = yield* app.ledger.affectedState({ threadId: T, limit: 10 });
            assert.isTrue(affected.held);
            assert.deepEqual(affected.changes.map((change) => change.reason).sort(), [
              "deleted",
              "updated",
            ]);

            yield* sendAndAwaitEcho(app.provider, T, "MARK-I3-TAINTED");

            yield* Scope.close(app.scope, Exit.void);
            const dir = base.config.providerLogsDir;
            assert.isFalse(directoryHasMarker(dir, "MARK-I3-TAINTED"));
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
          }).pipe(Effect.ensuring(Scope.close(app.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // I4: a fresh store discovers committed attempts during the open full scan
  // and purges historical segment files including rotations beyond maxFiles,
  // while foreign segments and _global survive.
  it.effect("purges tainted segment files and rotations on reopen (I4)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const UNREP = ThreadId.make("!!!");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings((warnings) =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const data = yield* openData(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);
            yield* commitAttempt(data.ledger, T, [MEM]);
            yield* base.sql`
              INSERT INTO project_memory_send_attempts (
                thread_id, message_id, project_id, provider_instance_id,
                owner_instance_id, state, committed_at, settled_at
              )
              VALUES (
                ${UNREP}, 'msg-unrep', ${PROJECT}, 'codex',
                'owner-1', 'dispatch_committed', ${NOW_ISO}, NULL
              )
            `;
          }).pipe(Effect.ensuring(Scope.close(data.scope, Exit.void)));

          const dir = base.config.providerLogsDir;
          writeFixture(dir, "events.t-taint.log", fixtureLine("MARK-I4-HIST"));
          writeFixture(dir, "events.t-taint.log.3", fixtureLine("MARK-I4-HIST"));
          writeFixture(dir, "events.t-taint.log.12", fixtureLine("MARK-I4-HIST"));
          writeFixture(dir, "events.t-taint-2.log", fixtureLine("MARK-I4-OTHER"));
          writeFixture(dir, "events.u-ok.log", fixtureLine("MARK-I4-BEFORE-U"));
          writeFixture(dir, "events._global.log", fixtureLine("MARK-I4-BEFORE-G"));

          const gen = yield* openLoggers(base);
          const native = requireNative(gen.loggers);
          yield* Effect.gen(function* () {
            assert.include(warnings.taintTags, "unrepresentable-segment");
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log.3")));
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log.12")));
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events.t-taint-2.log")));
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events._global.log")));

            yield* native.write({ marker: "MARK-I4-T-NEW" }, T);
            yield* native.write({ marker: "MARK-I4-UNREP" }, UNREP);
            yield* native.write({ marker: "MARK-I4-U-NEW" }, U);
            yield* native.write({ marker: "MARK-I4-G-NEW" }, null);

            yield* Scope.close(gen.scope, Exit.void);
            const uContent = NodeFS.readFileSync(NodePath.join(dir, "events.u-ok.log"), "utf8");
            const gContent = NodeFS.readFileSync(NodePath.join(dir, "events._global.log"), "utf8");
            assert.isTrue(uContent.includes("MARK-I4-BEFORE-U"));
            assert.isTrue(uContent.includes("MARK-I4-U-NEW"));
            assert.isTrue(gContent.includes("MARK-I4-BEFORE-G"));
            assert.isTrue(gContent.includes("MARK-I4-G-NEW"));
            assert.isTrue(directoryHasMarker(dir, "MARK-I4-OTHER"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I4-T-NEW"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I4-UNREP"));
          }).pipe(Effect.ensuring(Scope.close(gen.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // I5: a failing taint lookup fails the batch closed (thread records dropped,
  // _global kept), and the next successful flush purges historical files.
  it.effect("fails closed on lookup errors and recovers on retry (I5)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings((warnings) =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const data = yield* openData(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);
            yield* commitAttempt(data.ledger, T, [MEM]);
          }).pipe(Effect.ensuring(Scope.close(data.scope, Exit.void)));

          const dir = base.config.providerLogsDir;
          writeFixture(dir, "events.t-taint.log", fixtureLine("MARK-I5-HIST"));

          yield* base.sql.unsafe(
            "ALTER TABLE project_memory_send_attempts RENAME TO pm_send_attempts_held",
          );
          const gen = yield* openLoggers(base);
          const native = requireNative(gen.loggers);
          yield* Effect.gen(function* () {
            assert.equal(yield* Queue.take(warnings.taintQueue), "lookup-failed");
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));

            yield* native.write({ marker: "MARK-I5-ALPHA" }, U);
            yield* native.write({ marker: "MARK-I5-GLOBAL" }, null);
            yield* TestClock.adjust(`${FLUSH_WINDOW_MS} millis`);
            assert.equal(yield* Queue.take(warnings.taintQueue), "lookup-failed");
            assert.isTrue(directoryHasMarker(dir, "MARK-I5-GLOBAL"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I5-ALPHA"));
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));

            yield* base.sql.unsafe(
              "ALTER TABLE pm_send_attempts_held RENAME TO project_memory_send_attempts",
            );
            yield* native.write({ marker: "MARK-I5-BETA" }, U);
            yield* Scope.close(gen.scope, Exit.void);

            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
            assert.isTrue(directoryHasMarker(dir, "MARK-I5-BETA"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I5-ALPHA"));
            assert.isTrue(directoryHasMarker(dir, "MARK-I5-GLOBAL"));
          }).pipe(Effect.ensuring(Scope.close(gen.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // I6: a malformed thread_id row fails the whole full-scan lookup closed and
  // blocks the purge, but does not suppress valid restricted-batch writes.
  it.effect("fails the full scan closed on malformed taint rows (I6)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings((warnings) =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const data = yield* openData(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);
            yield* commitAttempt(data.ledger, T, [MEM]);
            yield* base.sql`
              INSERT INTO project_memory_send_attempts (
                thread_id, message_id, project_id, provider_instance_id,
                owner_instance_id, state, committed_at, settled_at
              )
              VALUES (
                '   ', 'msg-malformed', ${PROJECT}, 'codex',
                'owner-1', 'dispatch_committed', ${NOW_ISO}, NULL
              )
            `;
          }).pipe(Effect.ensuring(Scope.close(data.scope, Exit.void)));

          const dir = base.config.providerLogsDir;
          writeFixture(dir, "events.t-taint.log", fixtureLine("MARK-I6-HIST"));

          const gen1 = yield* openLoggers(base);
          yield* Effect.gen(function* () {
            assert.equal(yield* Queue.take(warnings.taintQueue), "lookup-failed");
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));

            yield* requireNative(gen1.loggers).write({ marker: "MARK-I6-U" }, U);
            yield* Scope.close(gen1.scope, Exit.void);
            assert.isTrue(directoryHasMarker(dir, "MARK-I6-U"));
            assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
          }).pipe(Effect.ensuring(Scope.close(gen1.scope, Exit.void)));

          yield* base.sql`DELETE FROM project_memory_send_attempts WHERE thread_id = '   '`;

          const gen2 = yield* openLoggers(base);
          const native2 = requireNative(gen2.loggers);
          yield* Effect.gen(function* () {
            assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "events.t-taint.log")));
            yield* native2.write({ marker: "MARK-I6-T2" }, T);
            yield* native2.write({ marker: "MARK-I6-U2" }, U);
            yield* Scope.close(gen2.scope, Exit.void);
            assert.isTrue(directoryHasMarker(dir, "MARK-I6-U2"));
            assert.isFalse(directoryHasMarker(dir, "MARK-I6-T2"));
          }).pipe(Effect.ensuring(Scope.close(gen2.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });

  // B2: the layer finalizer is interruptible while its final flush lookup is
  // blocked on the shared SQL semaphore; teardown kills the timer scope and
  // never writes requeued records.
  it.effect("interrupts a blocked finalizer lookup and cleans up (B2)", () => {
    const U = ThreadId.make("u-ok");
    const W = ThreadId.make("w-pending");
    return Effect.gen(function* () {
      const base = yield* openBase;
      yield* Effect.gen(function* () {
        const gen = yield* openLoggers(base);
        const native = requireNative(gen.loggers);

        // Park the shared SQL semaphore inside a real transaction so the
        // close-time flush's taint lookup cannot acquire the connection.
        const blocker = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const txFiber = yield* base.sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(blocker);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);

        yield* Effect.gen(function* () {
          yield* native.write({ marker: "MARK-B2-U" }, U);
          yield* native.write({ marker: "MARK-B2-G" }, null);
          yield* native.write({ marker: "MARK-B2-W" }, W);

          // Registered after the layer build, so LIFO close order runs this
          // receipt before the logger's store.close finalizer: the interrupt
          // below is only requested once the closer is inside the finalizer
          // chain, never before finalizers start.
          const finalizerEntered = yield* Deferred.make<void>();
          yield* Scope.addFinalizer(gen.scope, Deferred.succeed(finalizerEntered, undefined));

          // startImmediately runs the closer inline to its first suspension:
          // the receipt has fired and the final flush is parked on the held
          // permit by the time the fork returns.
          const closeFiber = yield* Scope.close(gen.scope, Exit.void).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(finalizerEntered);
          yield* Fiber.interrupt(closeFiber);
          const exit = yield* Fiber.await(closeFiber);
          assert.isTrue(Exit.hasInterrupts(exit));

          const dir = base.config.providerLogsDir;
          assert.isFalse(directoryHasMarker(dir, "MARK-B2-U"));
          assert.isFalse(directoryHasMarker(dir, "MARK-B2-W"));
          assert.isFalse(directoryHasMarker(dir, "MARK-B2-G"));
        }).pipe(
          // Release the parked transaction on every path, and before the
          // logger scope close below: a failed assertion must not strand
          // teardown waiting on the held SQL connection. On the success path
          // the release lands after the disk assertions, keeping the negative
          // timing proof meaningful.
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(blocker, undefined);
              yield* Fiber.join(txFiber).pipe(Effect.orDie);
            }),
          ),
          Effect.ensuring(Scope.close(gen.scope, Exit.void)),
        );
      }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
    });
  });

  // B4: a failed segment purge stays pending, retries on the next flush, and
  // completes once the failure clears.
  it.effect("retries a failed segment purge on later flushes (B4)", () => {
    const U = ThreadId.make("u-ok");
    const T = ThreadId.make("t-taint");
    const MEM = ProjectMemoryId.make("mem-1");
    return withWarnings((warnings) =>
      Effect.gen(function* () {
        const base = yield* openBase;
        yield* Effect.gen(function* () {
          const data = yield* openData(base);
          yield* Effect.gen(function* () {
            yield* seedProjection(base.sql, [U, T]);
            yield* seedMemoryRow(base.sql, MEM);
            yield* commitAttempt(data.ledger, T, [MEM]);
          }).pipe(Effect.ensuring(Scope.close(data.scope, Exit.void)));

          const dir = base.config.providerLogsDir;
          const segmentPath = NodePath.join(dir, "events.t-taint.log");
          const rotationPath = NodePath.join(dir, "events.t-taint.log.7");
          writeFixture(dir, "events.t-taint.log", fixtureLine("MARK-B4-HIST"));
          writeFixture(dir, "events.t-taint.log.7", fixtureLine("MARK-B4-HIST"));
          rmSyncFault.armed = true;
          rmSyncFault.targets.add(segmentPath);
          rmSyncFault.targets.add(rotationPath);

          const gen = yield* openLoggers(base);
          const native = requireNative(gen.loggers);
          yield* Effect.gen(function* () {
            assert.equal(yield* Queue.take(warnings.taintQueue), "purge-failed");
            assert.isTrue(NodeFS.existsSync(segmentPath));
            assert.isTrue(NodeFS.existsSync(rotationPath));

            yield* native.write({ marker: "MARK-B4-U" }, U);
            yield* TestClock.adjust(`${FLUSH_WINDOW_MS} millis`);
            assert.equal(yield* Queue.take(warnings.taintQueue), "purge-failed");
            assert.isTrue(directoryHasMarker(dir, "MARK-B4-U"));
            assert.isTrue(rmSyncFault.attempts.length >= 4);

            rmSyncFault.armed = false;
            yield* Scope.close(gen.scope, Exit.void);
            assert.isFalse(NodeFS.existsSync(segmentPath));
            assert.isFalse(NodeFS.existsSync(rotationPath));
          }).pipe(Effect.ensuring(Scope.close(gen.scope, Exit.void)));
        }).pipe(Effect.ensuring(Scope.close(base.scope, Exit.void)));
      }),
    );
  });
});
