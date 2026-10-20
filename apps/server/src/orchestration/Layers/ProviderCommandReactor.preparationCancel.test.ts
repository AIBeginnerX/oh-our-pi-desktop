// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ProviderUploadFeedbackInput,
  type ProviderUploadFeedbackResult,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as ProviderSafetyObservations from "../../persistence/ProviderSafetyObservations.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectMemorySendGate,
  ProjectMemorySendPolicy,
  layer as projectMemorySendGateLayer,
} from "../../memory/ProjectMemorySendGate.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsEffect = (baseDir: string, devUrl: URL | undefined) =>
  deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer));

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_2_ID = ThreadId.make("thread-2");
const memoryNow = "2026-01-01T00:00:00.000Z";
const STOPPED_BEFORE_SEND_DETAIL = "Stopped before this message was sent.";
const PREPARATION_STOP_UNVERIFIED_DETAIL =
  "The provider session could not be cleaned up after the stop. Continue in a new thread, or restart the server and check again.";

// The adapter fake's `sendTurn` increments `sendTurnEntries` inside the effect
// body, so the counter is proof the adapter effect actually ran — a parked or
// interrupted preparation can never reach it.
function makeFakeCodexAdapter(
  provider: ProviderDriverKind,
  runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>,
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  let sendTurnEntries = 0;

  const defaultStartSession = (
    input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.sync(() => {
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: memoryNow,
        updatedAt: memoryNow,
      };
      sessions.set(session.threadId, session);
      return session;
    });

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      defaultStartSession(input),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }
      return Effect.sync(() => {
        sendTurnEntries += 1;
        return {
          threadId: input.threadId,
          turnId: asTurnId(`turn-${String(input.threadId)}`),
        };
      });
    },
  );

  const defaultHasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId));
  const hasSession = vi.fn(defaultHasSession);
  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );

  const adapter = {
    provider,
    capabilities: { sessionModelSwitch: "in-session", promptlessTurnContinuation: true },
    startSession,
    sendTurn,
    interruptTurn: vi.fn(
      (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
        Effect.void,
    ),
    respondToRequest: vi.fn(
      (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
    ),
    respondToUserInput: vi.fn(
      (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
    ),
    stopSession,
    listSessions: vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
    ),
    hasSession,
    readThread: vi.fn(
      (
        threadId: ThreadId,
      ): Effect.Effect<
        { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: readonly [] }> },
        ProviderAdapterError
      > => Effect.succeed({ threadId, turns: [{ id: asTurnId("turn-1"), items: [] }] }),
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
        input: ProviderUploadFeedbackInput,
      ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
        Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
    ),
    stopAll: vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
    ),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;

  return {
    adapter,
    startSession,
    sendTurn,
    hasSession,
    stopSession,
    defaultStartSession,
    defaultHasSession,
    get sendTurnEntries() {
      return sendTurnEntries;
    },
  };
}

interface RecordedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

function makeRecordingAnalytics() {
  const events: Array<RecordedAnalyticsEvent> = [];
  const layer = Layer.succeed(
    AnalyticsService.AnalyticsService,
    AnalyticsService.AnalyticsService.of({
      record: (event, properties) =>
        Effect.sync(() => {
          events.push({ event, ...(properties ? { properties } : {}) });
        }),
      flush: Effect.void,
    }),
  );
  return {
    layer,
    eventsByName: (event: string) => events.filter((entry) => entry.event === event),
  };
}

const noSafetyObservations = Layer.succeed(
  ProviderSafetyObservations.ProviderSafetyObservations,
  ProviderSafetyObservations.ProviderSafetyObservations.of({
    record: () => Effect.void,
    hasUnprojected: () => Effect.succeed(false),
  }),
);

describe("ProviderCommandReactor preparation cancellation", () => {
  type ReactorCommand = Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0];

  interface ReactorHarnessInput {
    // Parks the Nth gate threadHold call strictly after the real gate read,
    // mirroring the memory-gate parks in the sibling test files. For a
    // memoryless send the worker's L0 read is call 1 and the forked child's
    // L3 read is call 2, so `call: 2` parks the tracked send-side fiber after
    // its lane preparation but before `progress.providerCalled`.
    readonly parkGateThreadHold?: {
      readonly call: number;
      readonly parked: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
      readonly capture?: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
    };
  }

  // Builds the real orchestration graph over the shared in-memory SQLite
  // database inside caller-owned scopes — the real ProviderService routes
  // through a mutable adapter map, so every binding lookup, delegated stop
  // entry and guarded settle write below is the production path.
  const buildReactorHarness = (input?: ReactorHarnessInput) =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-prepcancel-"));
      const { stateDir } = yield* deriveServerPathsEffect(baseDir, undefined);
      const workspaceRoot = NodePath.join(baseDir, "workspace");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const modelSelection = { instanceId: CODEX_INSTANCE, model: "gpt-5-codex" };

      const codexAEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexBEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexA = makeFakeCodexAdapter(CODEX_DRIVER, codexAEvents);
      const codexB = makeFakeCodexAdapter(CODEX_DRIVER, codexBEvents);
      const adapters = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>([
        [CODEX_INSTANCE, codexA.adapter],
        [ProviderInstanceId.make("codex-b"), codexB.adapter],
      ]);
      const unsupported = (instanceId: ProviderInstanceId) =>
        new ProviderUnsupportedError({ provider: ProviderDriverKind.make(instanceId) });
      const adapterRegistry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (instanceId) => {
          const adapter = adapters.get(instanceId);
          return adapter ? Effect.succeed(adapter) : Effect.fail(unsupported(instanceId));
        },
        getInstanceInfo: (instanceId) => {
          const adapter = adapters.get(instanceId);
          return adapter
            ? Effect.succeed({
                instanceId,
                driverKind: adapter.provider,
                displayName: undefined,
                enabled: true,
                continuationIdentity: {
                  driverKind: adapter.provider,
                  continuationKey: `${adapter.provider}:instance:${instanceId}`,
                },
              })
            : Effect.fail(unsupported(instanceId));
        },
        listInstances: () => Effect.succeed(Array.from(adapters.keys())),
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };

      const analytics = makeRecordingAnalytics();

      const capturedLogs: Array<{
        readonly level: string;
        readonly message: string;
        readonly cause: string;
      }> = [];
      const serializeLogValue = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
        try {
          return (
            JSON.stringify(value, (_key, inner) =>
              inner instanceof Error ? `${inner.name}: ${inner.message}` : inner,
            ) ?? String(value)
          );
        } catch {
          return String(value);
        }
      };
      const captureLogger = Logger.make((options) => {
        capturedLogs.push({
          level: String(options.logLevel),
          message: Array.isArray(options.message)
            ? options.message.map(serializeLogValue).join("\n")
            : serializeLogValue(options.message),
          cause: options.cause === undefined ? "" : Cause.pretty(options.cause),
        });
      });

      const realMemoryGateLayer = projectMemorySendGateLayer.pipe(
        Layer.provide(
          Layer.succeed(ProjectMemorySendPolicy, {
            driverKinds: new Set([CODEX_DRIVER]),
          }),
        ),
      );
      const parkGate = input?.parkGateThreadHold;
      const memoryGateLayer =
        parkGate === undefined
          ? realMemoryGateLayer
          : Layer.effect(
              ProjectMemorySendGate,
              Effect.gen(function* () {
                const real = yield* ProjectMemorySendGate;
                let threadHoldCalls = 0;
                return ProjectMemorySendGate.of({
                  threadHold: (threadId) => {
                    threadHoldCalls += 1;
                    const held = real.threadHold(threadId);
                    if (threadHoldCalls !== parkGate.call) {
                      return held;
                    }
                    return held.pipe(
                      Effect.tap(() =>
                        Effect.gen(function* () {
                          if (parkGate.capture !== undefined) {
                            yield* Deferred.succeed(parkGate.capture, yield* Effect.fiber);
                          }
                          yield* Deferred.succeed(parkGate.parked, undefined);
                          yield* Deferred.await(parkGate.release);
                        }),
                      ),
                    );
                  },
                  driverAllowed: real.driverAllowed,
                  admit: real.admit,
                  settle: real.settle,
                  revalidate: real.revalidate,
                  revalidateForAdmission: real.revalidateForAdmission,
                });
              }),
            ).pipe(Layer.provide(realMemoryGateLayer));

      const tryHandlePromptCommand = vi.fn<
        ProviderAuthService["Service"]["tryHandlePromptCommand"]
      >(() => Effect.succeed(false));
      const renameBranch = vi.fn(() => Effect.succeed({ branch: "renamed-branch" }));
      const pruneWorktrees = vi.fn(() => Effect.void);
      const createWorktree = vi.fn(
        (worktreeInput: { readonly refName: string; readonly path: string | null }) =>
          Effect.succeed({
            worktree: { path: worktreeInput.path ?? "", refName: worktreeInput.refName },
          }),
      );
      const closeIdleTerminals = vi.fn(() => Effect.void);
      const refreshStatus = vi.fn(() =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: "renamed-branch",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      );
      const generateBranchName = vi.fn<TextGeneration["Service"]["generateBranchName"]>(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateBranchName",
            detail: "disabled in test harness",
          }),
        ),
      );
      const generateThreadTitle = vi.fn<TextGeneration["Service"]["generateThreadTitle"]>(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "disabled in test harness",
          }),
        ),
      );

      // Armable post-commit hook: the wrapped engine taps this after the real
      // dispatch committed its events through the synchronous projection
      // transaction, so Deferreds armed mid-test are durable receipts.
      let afterCommandHook:
        | ((command: ReactorCommand) => Effect.Effect<void> | undefined)
        | undefined;
      // Armable entry hook on the REAL ProviderService.stopSession: binding-less
      // routes never reach adapter.stopSession, so this seam is the only place a
      // test can prove the canceled child was joined before cleanup began.
      let stopSessionEntryHook: (() => Effect.Effect<void>) | undefined;
      const providerServiceLayer = Layer.effect(
        ProviderService,
        Effect.gen(function* () {
          const real = yield* ProviderService;
          return {
            ...real,
            stopSession: (input) =>
              Effect.gen(function* () {
                yield* stopSessionEntryHook?.() ?? Effect.void;
                return yield* real.stopSession(input);
              }),
          } satisfies typeof real;
        }),
      ).pipe(Layer.provide(makeProviderServiceLive()));

      const orchestrationLayer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      const reactorOrchestrationLayer = Layer.effect(
        OrchestrationEngineService,
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          return {
            readEvents: engine.readEvents,
            readThreadEvents: engine.readThreadEvents,
            getThreadReplayStats: engine.getThreadReplayStats,
            dispatch: (command, options) =>
              engine
                .dispatch(command, options)
                .pipe(Effect.tap(() => afterCommandHook?.(command) ?? Effect.void)),
            get streamDomainEvents() {
              return engine.streamDomainEvents;
            },
            subscribeDomainEvents: engine.subscribeDomainEvents,
            latestSequence: engine.latestSequence,
          } satisfies OrchestrationEngineService["Service"];
        }),
      ).pipe(Layer.provide(orchestrationLayer));

      const serverSettingsLayer = ServerSettingsService.layerTest();
      const providerRegistryLayer = makeProviderRegistryLayer([
        { instanceId: modelSelection.instanceId },
      ] as never);
      const layer = Layer.merge(ProviderCommandReactorLive, ProviderRuntimeIngestionLive)
        .pipe(
          Layer.provideMerge(reactorOrchestrationLayer),
          Layer.provideMerge(projectionSnapshotLayer),
          Layer.provideMerge(providerServiceLayer),
          Layer.provideMerge(ProviderSessionDirectoryLive),
          Layer.provideMerge(ProviderSessionRuntime.layer),
          Layer.provideMerge(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, adapterRegistry),
          ),
          Layer.provideMerge(noSafetyObservations),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(analytics.layer),
          Layer.provideMerge(memoryGateLayer),
          Layer.provideMerge(Logger.layer([captureLogger])),
        )
        .pipe(
          Layer.provide(Layer.mock(ProviderAuthService, { tryHandlePromptCommand })),
          Layer.provideMerge(providerRegistryLayer),
          Layer.provideMerge(
            Layer.mock(GitWorkflowService.GitWorkflowService)({
              renameBranch,
              pruneWorktrees,
              createWorktree,
            } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
          ),
          Layer.provideMerge(
            Layer.succeed(VcsStatusBroadcaster, {
              getStatus: () => Effect.die("getStatus should not be called in this test"),
              refreshLocalStatus: () =>
                Effect.die("refreshLocalStatus should not be called in this test"),
              refreshStatus,
              refreshPullRequestStatus: () =>
                Effect.die("refreshPullRequestStatus should not be called in this test"),
              streamStatus: () => Stream.die("streamStatus should not be called in this test"),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(TextGeneration, {
              generateBranchName,
              generateThreadTitle,
            }),
          ),
          Layer.provideMerge(Layer.mock(TerminalManager)({ closeIdle: closeIdleTerminals })),
          Layer.provideMerge(serverSettingsLayer),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          Layer.provideMerge(
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(false),
            } satisfies Partial<CheckpointStore.CheckpointStore["Service"]>),
          ),
        )
        .pipe(Layer.provide(restartContinuationsLayer));
      const layerScope = yield* Scope.make("sequential");
      const reactorScope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(layer, layerScope);
      const live = Effect.provideContext(context);
      const engine = yield* live(Effect.service(OrchestrationEngineService));
      const snapshotQuery = yield* live(Effect.service(ProjectionSnapshotQuery));
      const sessionDirectory = yield* live(Effect.service(ProviderSessionDirectory));
      const reactor = yield* live(Effect.service(ProviderCommandReactor));

      yield* live(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId: asProjectId("project-1"),
          title: "Provider Project",
          workspaceRoot,
          defaultModelSelection: modelSelection,
          createdAt: memoryNow,
        }),
      );
      yield* live(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: THREAD_ID,
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: memoryNow,
        }),
      );
      yield* live(
        reactor
          .start()
          .pipe(Scope.provide(reactorScope), Effect.provideService(ServerActivation, undefined)),
      );

      return {
        engine,
        snapshotQuery,
        sessionDirectory,
        readModel: live(snapshotQuery.getSnapshot()),
        drain: live(reactor.drain),
        live,
        codexA,
        adapters,
        logs: capturedLogs,
        setStopSessionEntryHook: (hook: (() => Effect.Effect<void>) | undefined) => {
          stopSessionEntryHook = hook;
        },
        setAfterCommand: (
          hook: ((command: ReactorCommand) => Effect.Effect<void> | undefined) | undefined,
        ) => {
          afterCommandHook = hook;
        },
        dispose: Effect.gen(function* () {
          yield* Scope.close(reactorScope, Exit.void);
          yield* Scope.close(layerScope, Exit.void);
          NodeFS.rmSync(stateDir, { recursive: true, force: true });
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }),
      };
    });

  type Harness = Effect.Success<ReturnType<typeof buildReactorHarness>>;

  const withReactorHarness = (
    input: ReactorHarnessInput | undefined,
    body: (harness: Harness) => Effect.Effect<void, unknown>,
  ) =>
    Effect.gen(function* () {
      const harness = yield* buildReactorHarness(input);
      try {
        return yield* body(harness);
      } finally {
        yield* harness.dispose;
      }
    });

  const dispatchTurnStart = (
    harness: Harness,
    input: { readonly commandId: string; readonly messageId: string; readonly text: string },
  ) =>
    harness.live(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(input.commandId),
        threadId: THREAD_ID,
        message: {
          messageId: asMessageId(input.messageId),
          role: "user",
          text: input.text,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: memoryNow,
      }),
    );

  const failureActivitiesOf = (
    thread: Effect.Success<Harness["readModel"]>["threads"][number] | undefined,
  ) =>
    (thread?.activities ?? []).filter((activity) => activity.kind === "provider.turn.start.failed");

  const threadOf = (harness: Harness) =>
    Effect.map(harness.readModel, (snapshot) =>
      snapshot.threads.find((thread) => thread.id === THREAD_ID),
    );

  effectIt.live(
    "stop joins a parked send-side preparation before provider cleanup and settles the anchored session to stopped",
    () =>
      Effect.gen(function* () {
        const holdParked = yield* Deferred.make<void>();
        const holdRelease = yield* Deferred.make<void>();
        const fiberCapture = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        let exitAtStopEntry: Exit.Exit<unknown, unknown> | undefined;
        yield* withReactorHarness(
          {
            parkGateThreadHold: {
              call: 2,
              parked: holdParked,
              release: holdRelease,
              capture: fiberCapture,
            },
          },
          (harness) =>
            Effect.gen(function* () {
              const defaultStopSession = harness.codexA.adapter.stopSession.getMockImplementation();
              yield* dispatchTurnStart(harness, {
                commandId: "cmd-turn-prepcancel-stop",
                messageId: "message-prepcancel-stop",
                text: "first",
              });
              // The send-side preparation is parked inside its own tracked
              // child, after the bound "starting" session-set anchored it.
              yield* Deferred.await(holdParked);
              const prepFiber = yield* Deferred.await(fiberCapture);
              // The delegated adapter stop entry samples the child's exit: a
              // completed interrupt-bearing exit proves the tracked fiber was
              // fully joined before provider cleanup ran, not merely before
              // the test looked.
              harness.codexA.adapter.stopSession.mockImplementationOnce((threadId) =>
                Effect.gen(function* () {
                  exitAtStopEntry = prepFiber.pollUnsafe();
                  if (defaultStopSession !== undefined) {
                    yield* defaultStopSession(threadId);
                  }
                }),
              );

              yield* harness.live(
                harness.engine.dispatch({
                  type: "thread.session.stop",
                  commandId: CommandId.make("cmd-session-stop-prepcancel"),
                  threadId: THREAD_ID,
                  createdAt: memoryNow,
                }),
              );
              yield* harness.drain;

              const childExit = exitAtStopEntry;
              expect(childExit !== undefined && Exit.isFailure(childExit)).toBe(true);
              if (childExit !== undefined && Exit.isFailure(childExit)) {
                expect(Cause.hasInterrupts(childExit.cause)).toBe(true);
              }
              expect(harness.codexA.adapter.stopSession.mock.calls.length).toBe(1);
              expect(harness.codexA.adapter.interruptTurn).not.toHaveBeenCalled();
              expect(harness.codexA.sendTurnEntries).toBe(0);

              const thread = yield* threadOf(harness);
              expect(thread?.session).toMatchObject({
                status: "stopped",
                activeTurnId: null,
                lastError: null,
              });
              expect(failureActivitiesOf(thread)).toEqual([
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: "message-prepcancel-stop",
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
              ]);
              // Releasing the parked hold can only unblock an already-joined
              // fiber: no send may follow the stop.
              Deferred.doneUnsafe(holdRelease, Effect.void);
              yield* harness.drain;
              expect(harness.codexA.sendTurnEntries).toBe(0);
            }),
        );
      }),
  );

  effectIt.live(
    "interrupt settles a parked preparation through the non-recovering stop and never calls interruptTurn",
    () =>
      Effect.gen(function* () {
        const holdParked = yield* Deferred.make<void>();
        const holdRelease = yield* Deferred.make<void>();
        const fiberCapture = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        yield* withReactorHarness(
          {
            parkGateThreadHold: {
              call: 2,
              parked: holdParked,
              release: holdRelease,
              capture: fiberCapture,
            },
          },
          (harness) =>
            Effect.gen(function* () {
              yield* dispatchTurnStart(harness, {
                commandId: "cmd-turn-prepcancel-interrupt",
                messageId: "message-prepcancel-interrupt",
                text: "first",
              });
              yield* Deferred.await(holdParked);
              const prepFiber = yield* Deferred.await(fiberCapture);

              yield* harness.live(
                harness.engine.dispatch({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.make("cmd-turn-interrupt-prepcancel"),
                  threadId: THREAD_ID,
                  turnId: asTurnId("turn-prepcancel"),
                  createdAt: memoryNow,
                }),
              );
              yield* harness.drain;

              // A preparation-only interrupt takes the non-recovering stop:
              // the recovering interruptTurn path could restart the session,
              // so it must not run at all.
              expect(harness.codexA.adapter.interruptTurn).not.toHaveBeenCalled();
              expect(harness.codexA.adapter.stopSession.mock.calls.length).toBe(1);
              expect(harness.codexA.sendTurnEntries).toBe(0);
              const prepExit = prepFiber.pollUnsafe();
              expect(
                prepExit !== undefined &&
                  Exit.isFailure(prepExit) &&
                  Cause.hasInterrupts(prepExit.cause),
              ).toBe(true);

              const thread = yield* threadOf(harness);
              expect(thread?.session).toMatchObject({
                status: "stopped",
                activeTurnId: null,
                lastError: null,
              });
              expect(failureActivitiesOf(thread)).toEqual([
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: "message-prepcancel-interrupt",
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
              ]);
              // No stale "No active provider session" interrupt failure may be
              // left behind either.
              expect(
                (thread?.activities ?? []).some(
                  (activity) => activity.kind === "provider.turn.interrupt.failed",
                ),
              ).toBe(false);

              Deferred.doneUnsafe(holdRelease, Effect.void);
              yield* harness.drain;
              expect(harness.codexA.sendTurnEntries).toBe(0);
            }),
        );
      }),
  );

  effectIt.live(
    "a failed provider cleanup settles the canceled preparation to error with the fixed unverified detail",
    () =>
      Effect.gen(function* () {
        const holdParked = yield* Deferred.make<void>();
        const holdRelease = yield* Deferred.make<void>();
        yield* withReactorHarness(
          {
            parkGateThreadHold: { call: 2, parked: holdParked, release: holdRelease },
          },
          (harness) =>
            Effect.gen(function* () {
              yield* dispatchTurnStart(harness, {
                commandId: "cmd-turn-prepcancel-stopfail",
                messageId: "message-prepcancel-stopfail",
                text: "first",
              });
              yield* Deferred.await(holdParked);
              harness.codexA.adapter.stopSession.mockImplementationOnce(() =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: CODEX_DRIVER,
                    method: "ProviderAdapter.stopSession",
                    detail: "simulated adapter stop failure",
                  }),
                ),
              );

              yield* harness.live(
                harness.engine.dispatch({
                  type: "thread.session.stop",
                  commandId: CommandId.make("cmd-session-stop-stopfail"),
                  threadId: THREAD_ID,
                  createdAt: memoryNow,
                }),
              );
              yield* harness.drain;

              // An unverified cleanup is a fixed actionable error — never a
              // claimed teardown and never left "starting".
              const thread = yield* threadOf(harness);
              expect(thread?.session).toMatchObject({
                status: "error",
                activeTurnId: null,
                lastError: PREPARATION_STOP_UNVERIFIED_DETAIL,
              });
              expect(harness.codexA.adapter.stopSession.mock.calls.length).toBe(1);
              expect(harness.codexA.sendTurnEntries).toBe(0);
              expect(failureActivitiesOf(thread)).toEqual([
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: "message-prepcancel-stopfail",
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
              ]);
              Deferred.doneUnsafe(holdRelease, Effect.void);
              yield* harness.drain;
            }),
        );
      }),
  );

  effectIt.live.each(["stop", "interrupt"] as const)(
    "no persisted binding: %s joins both parked preparations before the real ProviderService stop, settles to the fixed error, and a later message sends once",
    (control) =>
      Effect.gen(function* () {
        const startParked = yield* Deferred.make<void>();
        const startRelease = yield* Deferred.make<void>();
        const fiberCapture = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const prepExited = yield* Deferred.make<void>();
        const terminalWritten = yield* Deferred.make<void>();
        const laterSendEntered = yield* Deferred.make<void>();
        const messageFirst = `message-nobinding-${control}-first`;
        const messageQueued = `message-nobinding-${control}-queued`;
        // The exit the REAL ProviderService.stopSession samples on entry —
        // the only place join-before-cleanup is observable when no binding
        // routes down to the adapter.
        let exitAtServiceStopEntry: Exit.Exit<unknown, unknown> | undefined;
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            // Parked at the delegated adapter start entry: the binding row is
            // written by the real service only after the adapter returns, so
            // interrupting here leaves no persisted binding for the stop to
            // route through.
            harness.codexA.adapter.startSession.mockImplementationOnce((startInput) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(fiberCapture, yield* Effect.fiber);
                yield* Deferred.succeed(startParked, undefined);
                yield* Deferred.await(startRelease);
              }).pipe(
                Effect.andThen(harness.codexA.defaultStartSession(startInput)),
                Effect.onExit(() => Deferred.succeed(prepExited, undefined)),
              ),
            );
            // The settle's guarded terminal write is the durable receipt: it
            // commits only after the interrupted children were joined and the
            // real cleanup attempt returned.
            harness.setAfterCommand((command) =>
              command.type === "thread.session.set" &&
              command.threadId === THREAD_ID &&
              command.session.status === "error" &&
              command.session.lastError === PREPARATION_STOP_UNVERIFIED_DETAIL
                ? Deferred.succeed(terminalWritten, undefined).pipe(Effect.asVoid)
                : undefined,
            );
            yield* dispatchTurnStart(harness, {
              commandId: `cmd-turn-nobinding-${control}-first`,
              messageId: messageFirst,
              text: "first",
            });
            yield* Deferred.await(startParked);
            const prepFiber = yield* Deferred.await(fiberCapture);

            // Queued behind the parked owner in the same per-thread lane: the
            // worker registers it synchronously before the control event is
            // handled.
            yield* dispatchTurnStart(harness, {
              commandId: `cmd-turn-nobinding-${control}-queued`,
              messageId: messageQueued,
              text: "queued",
            });

            harness.setStopSessionEntryHook(() =>
              Effect.sync(() => {
                exitAtServiceStopEntry = prepFiber.pollUnsafe();
              }),
            );

            yield* harness.live(
              harness.engine.dispatch(
                control === "stop"
                  ? {
                      type: "thread.session.stop",
                      commandId: CommandId.make(`cmd-nobinding-${control}`),
                      threadId: THREAD_ID,
                      createdAt: memoryNow,
                    }
                  : {
                      type: "thread.turn.interrupt",
                      commandId: CommandId.make(`cmd-nobinding-${control}`),
                      threadId: THREAD_ID,
                      turnId: asTurnId(`turn-nobinding-${control}`),
                      createdAt: memoryNow,
                    },
              ),
            );
            yield* Deferred.await(terminalWritten);
            yield* Deferred.await(prepExited);
            yield* harness.drain;

            // The parked child was fully joined — interrupt reason intact —
            // before the real cleanup call began.
            const sampled = exitAtServiceStopEntry;
            expect(sampled !== undefined && Exit.isFailure(sampled)).toBe(true);
            if (sampled !== undefined && Exit.isFailure(sampled)) {
              expect(Cause.hasInterrupts(sampled.cause)).toBe(true);
            }

            // No binding row was ever persisted, so the real service refused
            // routing before any adapter call — no recovering interruptTurn,
            // no send.
            expect(
              Option.isNone(yield* harness.live(harness.sessionDirectory.getBinding(THREAD_ID))),
            ).toBe(true);
            expect(harness.codexA.adapter.stopSession).not.toHaveBeenCalled();
            expect(harness.codexA.adapter.interruptTurn).not.toHaveBeenCalled();
            expect(harness.codexA.sendTurnEntries).toBe(0);

            const thread = yield* threadOf(harness);
            expect(thread?.session).toMatchObject({
              status: "error",
              activeTurnId: null,
              lastError: PREPARATION_STOP_UNVERIFIED_DETAIL,
            });
            // Once per canceled message — the queued waiter is reported too.
            // Reverse-order joins report the waiter first, so match unordered
            // while keeping the exact once/detail/request checks per message.
            const failureActivities = failureActivitiesOf(thread);
            expect(failureActivities).toHaveLength(2);
            expect(failureActivities).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: messageFirst,
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: messageQueued,
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
              ]),
            );
            if (control === "interrupt") {
              // The non-recovering path leaves no stale interrupt-failure
              // activity behind either.
              expect(
                (thread?.activities ?? []).some(
                  (activity) => activity.kind === "provider.turn.interrupt.failed",
                ),
              ).toBe(false);
            }

            // Liveness: a later explicit message re-prepares on the
            // registered adapter and sends exactly once. The send runs
            // outside the lane, so delegate the real adapter effect and await
            // the actual send receipt before counting.
            const defaultSendTurn = harness.codexA.adapter.sendTurn.getMockImplementation();
            harness.codexA.adapter.sendTurn.mockImplementation((input) =>
              Effect.gen(function* () {
                if (defaultSendTurn === undefined) {
                  return yield* Effect.die("missing sendTurn default");
                }
                const result = yield* defaultSendTurn(input);
                yield* Deferred.succeed(laterSendEntered, undefined);
                return result;
              }),
            );
            yield* dispatchTurnStart(harness, {
              commandId: `cmd-turn-nobinding-${control}-later`,
              messageId: `${messageFirst}-later`,
              text: "later",
            });
            yield* Deferred.await(laterSendEntered);
            expect(harness.codexA.adapter.startSession.mock.calls.length).toBe(2);
            expect(harness.codexA.sendTurnEntries).toBe(1);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(startRelease, Effect.void);
              }),
            ),
          ),
        );
      }),
  );

  effectIt.live(
    "the per-thread lane serializes preparations: a second message waits behind the first",
    () =>
      Effect.gen(function* () {
        const startParked = yield* Deferred.make<void>();
        const startRelease = yield* Deferred.make<void>();
        const sentinelHandled = yield* Deferred.make<void>();
        const secondSendEntered = yield* Deferred.make<void>();
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            const defaultSendTurn = harness.codexA.adapter.sendTurn.getMockImplementation();
            let sendTurnCalls = 0;
            // Sends run outside the lane in each preparation's own fiber, so
            // the lane orders preparations only — the receipt that both sends
            // actually reached the provider is the second adapter entry, not
            // a drain or a sleep.
            harness.codexA.adapter.sendTurn.mockImplementation((input) =>
              Effect.gen(function* () {
                sendTurnCalls += 1;
                if (defaultSendTurn === undefined) {
                  return yield* Effect.die("missing sendTurn default");
                }
                const result = yield* defaultSendTurn(input);
                if (sendTurnCalls === 2) {
                  yield* Deferred.succeed(secondSendEntered, undefined);
                }
                return result;
              }),
            );
            harness.codexA.adapter.startSession.mockImplementationOnce((startInput) =>
              Deferred.succeed(startParked, undefined).pipe(
                Effect.andThen(Deferred.await(startRelease)),
                Effect.andThen(harness.codexA.defaultStartSession(startInput)),
              ),
            );
            yield* harness.live(
              harness.engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("cmd-thread-create-2"),
                threadId: THREAD_2_ID,
                projectId: asProjectId("project-1"),
                title: "Thread 2",
                modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5-codex" },
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "approval-required",
                branch: null,
                worktreePath: null,
                createdAt: memoryNow,
              }),
            );
            yield* dispatchTurnStart(harness, {
              commandId: "cmd-turn-lane-first",
              messageId: "message-lane-first",
              text: "first",
            });
            yield* Deferred.await(startParked);
            // The second message is dispatched while the first still holds
            // the lane; the interrupt on thread-2 is the trailing sentinel —
            // the serial worker only reaches it after message-two's handler
            // already registered its lane waiter.
            yield* dispatchTurnStart(harness, {
              commandId: "cmd-turn-lane-second",
              messageId: "message-lane-second",
              text: "second",
            });
            harness.setAfterCommand((command) =>
              command.type === "thread.activity.append" && command.threadId === THREAD_2_ID
                ? Deferred.succeed(sentinelHandled, undefined).pipe(Effect.asVoid)
                : undefined,
            );
            yield* harness.live(
              harness.engine.dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make("cmd-turn-interrupt-sentinel"),
                threadId: THREAD_2_ID,
                createdAt: memoryNow,
              }),
            );
            yield* Deferred.await(sentinelHandled);

            // Message two's handler ran but its preparation never started:
            // only message one's ensure reached provider-side calls.
            expect(harness.codexA.adapter.listSessions.mock.calls.length).toBe(1);
            expect(harness.codexA.adapter.startSession.mock.calls.length).toBe(1);
            expect(harness.codexA.sendTurnEntries).toBe(0);

            Deferred.doneUnsafe(startRelease, Effect.void);
            yield* Deferred.await(secondSendEntered);
            yield* harness.drain;

            // Released in registration order: message one finishes preparing
            // and sends; message two's ensure then runs and its send follows.
            expect(harness.codexA.sendTurnEntries).toBe(2);
            expect(
              harness.codexA.adapter.sendTurn.mock.calls.map((call) => call[0].input).toSorted(),
            ).toEqual(["first", "second"]);
            // Each send preparation reads live sessions twice — once inside
            // ensure and once while building the request — so both messages
            // account for four provider-side reads in registration order.
            expect(harness.codexA.adapter.listSessions.mock.calls.length).toBe(4);
            // Message two reuses the session message one prepared.
            expect(harness.codexA.adapter.startSession.mock.calls.length).toBe(1);
          }),
        );
      }),
  );

  effectIt.live(
    "stop joins lane waiters: a queued runtime-mode preparation is interrupted before it can start",
    () =>
      Effect.gen(function* () {
        const startParked = yield* Deferred.make<void>();
        const startRelease = yield* Deferred.make<void>();
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            harness.codexA.adapter.startSession.mockImplementationOnce((startInput) =>
              Deferred.succeed(startParked, undefined).pipe(
                Effect.andThen(Deferred.await(startRelease)),
                Effect.andThen(harness.codexA.defaultStartSession(startInput)),
              ),
            );
            yield* dispatchTurnStart(harness, {
              commandId: "cmd-turn-waiter-first",
              messageId: "message-waiter-first",
              text: "first",
            });
            yield* Deferred.await(startParked);
            // The runtime-mode prepares register as session-kind lane waiters
            // behind the parked send preparation; the worker reaches them
            // before the stop because the stream is ordered. Two waiters pin
            // the signal order: the stop must interrupt every waiter before
            // the owner's lane release can wake any of them.
            yield* harness.live(
              harness.engine.dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("cmd-runtime-mode-waiter"),
                threadId: THREAD_ID,
                runtimeMode: "full-access",
                createdAt: memoryNow,
              }),
            );
            yield* harness.live(
              harness.engine.dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("cmd-runtime-mode-waiter-2"),
                threadId: THREAD_ID,
                runtimeMode: "approval-required",
                createdAt: memoryNow,
              }),
            );
            yield* harness.live(
              harness.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.make("cmd-session-stop-waiter"),
                threadId: THREAD_ID,
                createdAt: memoryNow,
              }),
            );
            yield* harness.drain;

            // Both waiters were interrupted before either ensure could run —
            // the only provider-side session read remains message one's.
            expect(harness.codexA.adapter.listSessions.mock.calls.length).toBe(1);
            // No persisted binding was ever written (the adapter start was
            // parked), so the settle fails at routing and lands the fixed
            // unverified detail — never "starting".
            expect(harness.codexA.adapter.stopSession).not.toHaveBeenCalled();
            const thread = yield* threadOf(harness);
            expect(thread?.session).toMatchObject({
              status: "error",
              activeTurnId: null,
              lastError: PREPARATION_STOP_UNVERIFIED_DETAIL,
            });
            // Session-kind entries are excluded from message reports: only
            // the send-kind "not sent" activity is recorded.
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message not sent",
                payload: expect.objectContaining({
                  requestId: "message-waiter-first",
                  detail: STOPPED_BEFORE_SEND_DETAIL,
                }),
              }),
            ]);
            expect(
              harness.logs.some((entry) =>
                entry.message.includes("failed to prepare session for runtime mode"),
              ),
            ).toBe(false);
          }),
        );
      }),
  );
});
