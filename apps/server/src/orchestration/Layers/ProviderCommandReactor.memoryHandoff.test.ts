// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  ComposerContextId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ComposerContextRecord,
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
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderMemoryAdmissionSupport,
  ProviderSendTurnAdmission,
} from "../../provider/Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as ProviderSafetyObservations from "../../persistence/ProviderSafetyObservations.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectMemoryRepository,
  layer as projectMemoryRepositoryLayer,
} from "../../persistence/ProjectMemories.ts";
import {
  ProjectMemorySendLedger,
  layer as projectMemorySendLedgerLayer,
} from "../../persistence/ProjectMemorySendLedger.ts";
import {
  MEMORY_SEND_HOLD_DETAIL,
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
const CODEX_B_INSTANCE = ProviderInstanceId.make("codex-b");
const THREAD_ID = ThreadId.make("thread-1");
const memoryNow = "2026-01-01T00:00:00.000Z";

// Memory title/body are user-authored secrets for these tests: fixed unique
// markers prove they never reach logs, events, activities, or analytics.
const SECRET_TITLE = "MEMORY-SECRET-TITLE-9f3e1d";
const SECRET_BODY = "MEMORY-SECRET-BODY-72ac40f";

// The adapter fake's `sendTurn` increments `sendTurnEntries` inside the
// effect body only after the supplied admission gate returns true, so the
// counter is proof a prompt actually published — not merely that `sendTurn`
// ran (`progress.providerCalled` semantics deliberately differ).
function makeFakeCodexAdapter(
  provider: ProviderDriverKind,
  runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>,
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  // The session context the adapter would actually publish on: a generation
  // that moves on every context recreation, plus the native session id that
  // context currently resumes on. The admission support hooks re-read both at
  // publish, so a parked send can swap the context underneath itself.
  const sessionIdentity = new Map<
    ThreadId,
    { generation: number; nativeSessionId: string | undefined }
  >();
  let nextSessionGeneration = 0;
  let sendTurnEntries = 0;

  // Pure resumeCursor → native session id parse, mirroring the real adapter
  // support hook: only `{opaque: string}` cursors carry an id.
  const nativeSessionIdOf = (cursor: unknown): string | undefined =>
    typeof cursor === "object" &&
    cursor !== null &&
    "opaque" in cursor &&
    typeof (cursor as { readonly opaque?: unknown }).opaque === "string"
      ? (cursor as { readonly opaque: string }).opaque
      : undefined;

  const memoryAdmission: ProviderMemoryAdmissionSupport = {
    sessionGeneration: (threadId) => sessionIdentity.get(threadId)?.generation,
    nativeSessionId: (cursor) => nativeSessionIdOf(cursor),
  };

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
      sessionIdentity.set(session.threadId, {
        generation: ++nextSessionGeneration,
        nativeSessionId: nativeSessionIdOf(session.resumeCursor),
      });
      return session;
    });

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      defaultStartSession(input),
  );

  const defaultSendTurn = (
    input: ProviderSendTurnInput,
    admission?: ProviderSendTurnAdmission,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.suspend((): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }
      // The lazy admission boundary: the observed session context is re-read
      // and the supplied gate runs synchronously inside this publish step —
      // after every await in the send — so a refused verdict queues no prompt
      // and fails the send with the ordinary not-admitted error.
      const identity = sessionIdentity.get(input.threadId);
      if (
        admission !== undefined &&
        !admission.admit({
          sessionGeneration: identity?.generation ?? 0,
          nativeSessionId: identity?.nativeSessionId,
        })
      ) {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider,
            threadId: input.threadId,
          }),
        );
      }
      // The gate verdict and the queued prompt are one synchronous step at L:
      // the counter increments in this same callback so a parked send cannot
      // count a prompt the admission check never let through.
      sendTurnEntries += 1;
      return Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId(`turn-${String(input.threadId)}`),
      });
    });

  const sendTurn = vi.fn(defaultSendTurn);

  const defaultHasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId));
  const hasSession = vi.fn(defaultHasSession);
  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.delete(threadId);
      sessionIdentity.delete(threadId);
    }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: { sessionModelSwitch: "in-session", promptlessTurnContinuation: true },
    startSession,
    sendTurn,
    memoryAdmission,
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
        sessionIdentity.clear();
      }),
    ),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return {
    adapter,
    startSession,
    sendTurn,
    hasSession,
    stopSession,
    defaultStartSession,
    defaultHasSession,
    defaultSendTurn,
    // Recreates the session context for the same thread — new generation,
    // same native session id unless a replacement is given — exactly what a
    // context rebuild underneath a parked send looks like at publish.
    replaceSessionContext: (threadId: ThreadId, nativeSessionId?: string) => {
      const current = sessionIdentity.get(threadId);
      if (current === undefined) {
        return;
      }
      sessionIdentity.set(threadId, {
        generation: ++nextSessionGeneration,
        nativeSessionId: nativeSessionId ?? current.nativeSessionId,
      });
    },
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
    all: () => events,
  };
}

const noSafetyObservations = Layer.succeed(
  ProviderSafetyObservations.ProviderSafetyObservations,
  ProviderSafetyObservations.ProviderSafetyObservations.of({
    record: () => Effect.void,
    hasUnprojected: () => Effect.succeed(false),
  }),
);

// Deep-walks logged entries and error objects so secret markers can be proven
// absent from every captured surface.
const collectText = (value: unknown, seen = new Set<object>()): string => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);
  const children: Array<unknown> = [
    ...(Array.isArray(value) ? value : Object.values(value)),
    (value as { cause?: unknown }).cause,
    ...(value instanceof Error ? [value.message] : []),
  ];
  return children.map((child) => collectText(child, seen)).join(" ");
};

describe("ProviderCommandReactor memory handoff integration", () => {
  type ReactorCommand = Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0];

  interface ReactorHarnessInput {
    readonly testClock?: boolean;
    readonly afterSettle?: Deferred.Deferred<void>;
  }

  // Builds the real orchestration graph over the shared in-memory SQLite
  // database inside caller-owned scopes. `dispose` stops the reactor worker
  // first (draining in-flight turns), then closes the layer graph so SQL is
  // the last resource released, then removes the temp directories.
  const buildReactorHarness = (input?: ReactorHarnessInput) =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-memhandoff-"));
      const { stateDir } = yield* deriveServerPathsEffect(baseDir, undefined);
      // The provider stats the workspace directory before entering the adapter,
      // so the project workspace must exist on disk for real.
      const workspaceRoot = NodePath.join(baseDir, "workspace");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const modelSelection = { instanceId: CODEX_INSTANCE, model: "gpt-5-codex" };

      // Mutable adapter map: codexA serves instance "codex", codexB serves
      // "codex-b". Registry lookups resolve through this map so the
      // binding/registry re-read inside the real ProviderService runs against
      // real mutable state.
      const codexAEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexBEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexA = makeFakeCodexAdapter(CODEX_DRIVER, codexAEvents);
      const codexB = makeFakeCodexAdapter(CODEX_DRIVER, codexBEvents);
      const adapters = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>([
        [CODEX_INSTANCE, codexA.adapter],
        [CODEX_B_INSTANCE, codexB.adapter],
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
        // Answers true only for the adapter object the mutable map resolves
        // right now — a swap, replacement, or absent instance answers false,
        // mirroring the live facade's ownership predicate.
        isCurrentAdapter: (instanceId, adapter) => adapters.get(instanceId) === adapter,
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

      // The gate is the real service over the shared SQLite database with the
      // codex driver allowlisted; a purely delegating wrapper only taps settle
      // so tests get a durable-settlement receipt instead of polling.
      const realMemoryGateLayer = projectMemorySendGateLayer.pipe(
        Layer.provide(
          Layer.succeed(ProjectMemorySendPolicy, {
            driverKinds: new Set([CODEX_DRIVER]),
          }),
        ),
      );
      const afterSettle = input?.afterSettle;
      const memoryGateLayer =
        afterSettle === undefined
          ? realMemoryGateLayer
          : Layer.effect(
              ProjectMemorySendGate,
              Effect.gen(function* () {
                const real = yield* ProjectMemorySendGate;
                return ProjectMemorySendGate.of({
                  threadHold: real.threadHold,
                  driverAllowed: real.driverAllowed,
                  admit: real.admit,
                  settle: (attemptSeq, outcome) =>
                    real
                      .settle(attemptSeq, outcome)
                      .pipe(Effect.tap(() => Deferred.succeed(afterSettle, undefined))),
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
      // ProviderRegistry is the instance catalog — distinct from
      // ProviderAdapterRegistry, which is the adapter boundary the real
      // ProviderService routes through. Only refreshWorkspaceSnapshot reaches
      // this stub on these paths.
      const providerRegistryLayer = makeProviderRegistryLayer([
        { instanceId: modelSelection.instanceId },
      ] as never);
      const layer = Layer.merge(ProviderCommandReactorLive, ProviderRuntimeIngestionLive)
        .pipe(
          Layer.provideMerge(reactorOrchestrationLayer),
          Layer.provideMerge(projectionSnapshotLayer),
          // The real ProviderService: its dependencies — adapter registry,
          // session directory + runtime repository, continuations, safety
          // observations, settings, config, analytics, event loggers,
          // NodeServices — resolve from the same ambient merged graph as the
          // reactor, so every routing, binding and handoff fence below is the
          // production path over the shared in-memory SQLite database.
          Layer.provideMerge(makeProviderServiceLive()),
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
          Layer.provideMerge(projectMemorySendLedgerLayer),
          Layer.provideMerge(projectMemoryRepositoryLayer),
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
          Layer.provideMerge(input?.testClock === true ? TestClock.layer() : Layer.empty),
        )
        .pipe(Layer.provide(restartContinuationsLayer));
      const layerScope = yield* Scope.make("sequential");
      const reactorScope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(layer, layerScope);
      const live = Effect.provideContext(context);
      const engine = yield* live(Effect.service(OrchestrationEngineService));
      const snapshotQuery = yield* live(Effect.service(ProjectionSnapshotQuery));
      const reactor = yield* live(Effect.service(ProviderCommandReactor));
      const ledger = yield* live(Effect.service(ProjectMemorySendLedger));
      const memoryRepository = yield* live(Effect.service(ProjectMemoryRepository));
      const directory = yield* live(
        Effect.service(ProviderSessionDirectory.ProviderSessionDirectory),
      );
      const sql = yield* live(Effect.service(SqlClient.SqlClient));

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
        readModel: live(snapshotQuery.getSnapshot()),
        drain: live(reactor.drain),
        ledger,
        memoryRepository,
        directory,
        sql,
        live,
        codexA,
        codexB,
        adapters,
        analytics,
        logs: capturedLogs,
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

  const memoryChip = (contextId: string, memoryId: string, selectedVersion = 1) => ({
    version: 1 as const,
    contextId: ComposerContextId.make(contextId),
    kind: "memory",
    label: "Project memory",
    payload: { memoryId, selectedVersion },
  });

  const insertProjectMemory = (
    harness: Harness,
    input: { readonly memoryId: string; readonly validUntil?: string | null },
  ) =>
    harness.memoryRepository.insert({
      memoryId: ProjectMemoryId.make(input.memoryId),
      projectId: asProjectId("project-1"),
      kind: "fact",
      title: SECRET_TITLE,
      body: SECRET_BODY,
      origin: { type: "manual" },
      validUntil: input.validUntil ?? null,
      estimatedTokens: 0,
      now: memoryNow,
    });

  const dispatchMemoryTurn = (
    harness: Harness,
    dispatchInput: {
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
      readonly records?: ReadonlyArray<ComposerContextRecord>;
    },
  ) =>
    harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(dispatchInput.commandId),
      threadId: THREAD_ID,
      message: {
        messageId: asMessageId(dispatchInput.messageId),
        role: "user",
        text: dispatchInput.text,
        attachments: [],
        ...(dispatchInput.records === undefined
          ? {}
          : { context: { version: 1 as const, records: dispatchInput.records } }),
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: memoryNow,
    });

  // Dispatches a memory turn and parks the send fiber inside the recovery
  // `startSession` (call #2) — strictly after the ledger commit and strictly
  // before the adapter-entry fences the real ProviderService runs inside
  // sendTurn. Mutations applied while parked therefore land in the exact gap
  // the late revalidation covers. Returns the release latch.
  const dispatchParkedMemoryTurn = (
    harness: Harness,
    dispatchInput: {
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
      readonly records: ReadonlyArray<ComposerContextRecord>;
    },
  ) =>
    Effect.gen(function* () {
      const enteredRecoveryStart = yield* Deferred.make<void>();
      const releaseRecoveryStart = yield* Deferred.make<void>();
      // Always report "no active session" so the routed resolution falls into
      // the recovery branch where the second startSession happens.
      harness.codexA.hasSession.mockImplementation(() => Effect.succeed(false));
      let startCalls = 0;
      harness.codexA.startSession.mockImplementation((startInput) => {
        startCalls += 1;
        if (startCalls === 2) {
          return Deferred.succeed(enteredRecoveryStart, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRecoveryStart)),
            Effect.andThen(harness.codexA.defaultStartSession(startInput)),
          );
        }
        return harness.codexA.defaultStartSession(startInput);
      });
      yield* dispatchMemoryTurn(harness, dispatchInput);
      yield* Deferred.await(enteredRecoveryStart);
      return releaseRecoveryStart;
    });

  // Dispatches a memory turn and parks the send fiber inside the adapter's
  // publish step — strictly after every handoff capture the real
  // ProviderService makes (memory recheck, directory write fence, session
  // generation, binding/registry re-observations) and strictly before the
  // synchronous `admit` gate runs. Mutations applied while parked land in the
  // exact gap the admission predicate re-judges. Returns the release latch.
  const dispatchTurnParkedAtAdmission = (
    harness: Harness,
    dispatchInput: {
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
      readonly records: ReadonlyArray<ComposerContextRecord>;
    },
  ) =>
    Effect.gen(function* () {
      const enteredSend = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      harness.codexA.sendTurn.mockImplementationOnce((sendInput, admission) =>
        Deferred.succeed(enteredSend, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSend)),
          Effect.andThen(() => harness.codexA.defaultSendTurn(sendInput, admission)),
        ),
      );
      yield* dispatchMemoryTurn(harness, dispatchInput);
      yield* Deferred.await(enteredSend);
      return releaseSend;
    });

  const sendAttemptStates = (harness: Harness) =>
    Effect.gen(function* () {
      const rows = yield* harness.sql<{ readonly state: string }>`
        SELECT state FROM project_memory_send_attempts ORDER BY attempt_seq
      `;
      return rows.map((row) => row.state);
    });

  const acknowledgeLatestChange = (harness: Harness) =>
    Effect.gen(function* () {
      const state = yield* harness.ledger.affectedState({ threadId: THREAD_ID, limit: 1 });
      if (state.latestChangeSeq === null) {
        return yield* Effect.die(new Error("expected an affected memory change to ack"));
      }
      const result = yield* harness.ledger.acknowledge({
        threadId: THREAD_ID,
        throughChangeSeq: state.latestChangeSeq,
      });
      expect(result.status).toBe("applied");
    });

  const memoryFailureSessionSetRows = (harness: Harness) =>
    Effect.gen(function* () {
      return yield* harness.sql<{ readonly sequence: number; readonly status: string }>`
        SELECT
          sequence,
          json_extract(payload_json, '$.session.status') AS status
        FROM orchestration_events
        WHERE stream_id = ${THREAD_ID}
          AND event_type = 'thread.session-set'
          AND command_id LIKE ${"server:memory-turn-start-failure:%"}
        ORDER BY sequence ASC
      `;
    });

  const threadEventPayloads = (harness: Harness) =>
    Effect.gen(function* () {
      return yield* harness.sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE stream_id = ${THREAD_ID}
      `;
    });

  const threadMessageRows = (harness: Harness) =>
    Effect.gen(function* () {
      return yield* harness.sql<{ readonly text: string; readonly contextJson: string | null }>`
        SELECT text, context_json AS "contextJson"
        FROM projection_thread_messages
        WHERE thread_id = ${THREAD_ID}
      `;
    });

  const failureActivitiesOf = (
    thread: Effect.Success<Harness["readModel"]>["threads"][number] | undefined,
  ) =>
    (thread?.activities ?? []).filter((activity) => activity.kind === "provider.turn.start.failed");

  const isMemoryFailureReport = (
    command: ReactorCommand,
    messageId: string,
    detail: string,
  ): boolean =>
    command.type === "thread.turn.start.fail" &&
    command.messageId === asMessageId(messageId) &&
    command.detail === detail;

  // Shared assertions for a refused send: the adapter never published, the
  // committed attempt conservatively settled unknown, and the fixed report
  // restored the session this ensure left "starting" back to ready.
  const expectRefusalSettlement = (
    harness: Harness,
    input: { readonly detail: string; readonly messageId: string },
  ) =>
    Effect.gen(function* () {
      expect(harness.codexA.sendTurnEntries).toBe(0);
      expect(yield* sendAttemptStates(harness)).toEqual(["external_send_unknown"]);
      const thread = (yield* harness.readModel).threads.find((entry) => entry.id === THREAD_ID);
      const failures = failureActivitiesOf(thread);
      expect(failures.length).toBe(1);
      expect(failures[0]!.summary).toBe("Message not sent");
      expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(input.detail);
      const restoreRows = yield* memoryFailureSessionSetRows(harness);
      expect(restoreRows.length).toBe(1);
      expect(restoreRows[0]!.status).toBe("ready");
    });

  const expectNoSecretLeakage = (harness: Harness) =>
    Effect.gen(function* () {
      const serializedLogs = harness.logs
        .map((entry) => `${entry.level} ${entry.message} ${entry.cause}`)
        .join("\n");
      expect(serializedLogs).not.toContain(SECRET_TITLE);
      expect(serializedLogs).not.toContain(SECRET_BODY);
      const payloadText = (yield* threadEventPayloads(harness))
        .map((row) => row.payloadJson)
        .join("\n");
      expect(payloadText).not.toContain(SECRET_TITLE);
      expect(payloadText).not.toContain(SECRET_BODY);
      const messageText = (yield* threadMessageRows(harness))
        .map((row) => `${row.text} ${row.contextJson ?? ""}`)
        .join("\n");
      expect(messageText).not.toContain(SECRET_TITLE);
      expect(messageText).not.toContain(SECRET_BODY);
      const thread = (yield* harness.readModel).threads.find((entry) => entry.id === THREAD_ID);
      const activityText = collectText(thread?.activities ?? []);
      expect(activityText).not.toContain(SECRET_TITLE);
      expect(activityText).not.toContain(SECRET_BODY);
      const analyticsText = collectText(harness.analytics.all());
      expect(analyticsText).not.toContain(SECRET_TITLE);
      expect(analyticsText).not.toContain(SECRET_BODY);
    });

  effectIt.live(
    "accepts the turn and settles provider_accepted when revalidation stays valid",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-ok" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-ok",
              messageId: "m-ok",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-ok)",
              records: [memoryChip("mem-ok", "mem-ok")],
            });
            // Durable receipt: the committed attempt settled after the adapter ran.
            yield* Deferred.await(afterSettle);
            expect(harness.codexA.sendTurnEntries).toBe(1);
            // The handoff gate reached the adapter as a synchronous publish
            // callback — the actual chain, not a provider stub.
            expect(typeof harness.codexA.sendTurn.mock.calls[0]?.[1]?.admit).toBe("function");
            // The successfully admitted call delivered the version-1 memory
            // envelope to the adapter — not an empty or unhydrated input.
            const publishedInput = harness.codexA.sendTurn.mock.calls[0]?.[0]?.input;
            expect(publishedInput).toContain("mem-ok v1");
            expect(publishedInput).toContain(SECRET_BODY);
            // The committed ledger item pins the exact version that hydrated.
            const itemRows = yield* harness.sql<{ readonly memoryVersion: number }>`
              SELECT i.memory_version AS "memoryVersion"
              FROM project_memory_send_items i
              JOIN project_memory_send_attempts a ON a.attempt_seq = i.attempt_seq
              WHERE a.message_id = ${"m-ok"}
            `;
            expect(itemRows.map((row) => row.memoryVersion)).toEqual([1]);
            expect(yield* sendAttemptStates(harness)).toEqual(["provider_accepted"]);
            expect(harness.analytics.eventsByName("provider.turn.attempted").length).toBe(1);
            expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(1);
            expect(harness.analytics.eventsByName("provider.turn.rejected").length).toBe(0);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
          }),
        );
      }),
  );

  effectIt.live(
    "refuses at the adapter publish point and reports unavailable when the memory updates inside the handoff window",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-ver" });
            const release = yield* dispatchTurnParkedAtAdmission(harness, {
              commandId: "cmd-ver",
              messageId: "m-ver",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-ver)",
              records: [memoryChip("mem-ver", "mem-ver")],
            });
            // The actual fenced CRUD path (a service write is the ledger fence
            // wrap around repository.update): the mutation epoch the
            // stillValid closure pinned moves before the predicate runs at
            // the publish point.
            const updated = yield* harness.ledger.withMemoryMutation(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: ProjectMemoryId.make("mem-ver"),
                expectedVersion: 1,
                title: "Rotated title",
                body: "Rotated body",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:02.000Z",
              }),
            );
            expect(updated.status).toBe("applied");
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-ver",
            });
            expect(harness.analytics.eventsByName("provider.turn.attempted").length).toBe(1);
            const rejected = harness.analytics.eventsByName("provider.turn.rejected");
            expect(rejected.length).toBe(1);
            expect(rejected[0]!.properties?.["errorType"]).toBe(
              "ProviderMemoryHandoffRefusedError",
            );
            expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(0);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses adapter entry and reports version-changed when an acknowledged memory bump is caught at the handoff recheck",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-ver" });
            const release = yield* dispatchParkedMemoryTurn(harness, {
              commandId: "cmd-ver2",
              messageId: "m-ver2",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-ver)",
              records: [memoryChip("mem-ver", "mem-ver")],
            });
            // Late version change + ack, landing while the send is parked
            // between commit and the adapter-entry fences: the recheck is the
            // Held arm of the gate — its exact reason reaches the report.
            const updated = yield* harness.memoryRepository.update({
              projectId: asProjectId("project-1"),
              memoryId: ProjectMemoryId.make("mem-ver"),
              expectedVersion: 1,
              title: "Rotated title",
              body: "Rotated body",
              kind: "fact",
              validUntil: null,
              estimatedTokens: 0,
              now: "2026-01-01T00:00:02.000Z",
            });
            expect(updated.status).toBe("applied");
            yield* acknowledgeLatestChange(harness);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL["version-changed"],
              messageId: "m-ver2",
            });
            expect(harness.codexA.startSession).toHaveBeenCalledTimes(2);
            expect(harness.analytics.eventsByName("provider.turn.attempted").length).toBe(1);
            const rejected = harness.analytics.eventsByName("provider.turn.rejected");
            expect(rejected.length).toBe(1);
            expect(rejected[0]!.properties?.["errorType"]).toBe(
              "ProviderMemoryHandoffRefusedError",
            );
            expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(0);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses at the adapter publish point and reports unavailable when the memory is deleted inside the window",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-del" });
            const release = yield* dispatchTurnParkedAtAdmission(harness, {
              commandId: "cmd-del",
              messageId: "m-del",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-del)",
              records: [memoryChip("mem-del", "mem-del")],
            });
            const deleted = yield* harness.ledger.withMemoryMutation(
              harness.memoryRepository.delete({
                projectId: asProjectId("project-1"),
                memoryId: ProjectMemoryId.make("mem-del"),
                expectedVersion: 1,
              }),
            );
            expect(deleted.status).toBe("applied");
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-del",
            });
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses at the adapter publish point and reports unavailable when TestClock passes the memory's validUntil inside the window",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle, testClock: true }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, {
              memoryId: "mem-exp",
              validUntil: "2026-01-02T00:00:00.000Z",
            });
            const release = yield* dispatchTurnParkedAtAdmission(harness, {
              commandId: "cmd-exp",
              messageId: "m-exp",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-exp)",
              records: [memoryChip("mem-exp", "mem-exp")],
            });
            // The admission predicate reads DateTime.now through the shared
            // TestClock; moving it past validUntil makes the committed
            // selection expire inside the handoff window. The adjustment must
            // resolve the harness context's TestClock — the same instance the
            // worker fibers inherited — not the ambient live clock.
            yield* harness.live(TestClock.setTime(Date.parse("2026-01-03T00:00:00.000Z")));
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-exp",
            });
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses at the adapter publish point and reports unavailable when the session row rewrites the same values inside the window",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-aba" });
            const release = yield* dispatchTurnParkedAtAdmission(harness, {
              commandId: "cmd-aba",
              messageId: "m-aba",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-aba)",
              records: [memoryChip("mem-aba", "mem-aba")],
            });
            // Same values, still a write: the directory fence captured before
            // the binding re-read no longer holds at admission, so a
            // same-value ABA refuses like any other session-row write.
            const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
            yield* harness.directory.upsert(binding);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-aba",
            });
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses at the adapter publish point and reports unavailable when the session context generation changes inside the window",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-gen" });
            const release = yield* dispatchTurnParkedAtAdmission(harness, {
              commandId: "cmd-gen",
              messageId: "m-gen",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-gen)",
              records: [memoryChip("mem-gen", "mem-gen")],
            });
            // Same native session id, new context generation: what publish
            // would observe no longer matches the generation the handoff
            // pinned before adapter entry.
            harness.codexA.replaceSessionContext(THREAD_ID);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-gen",
            });
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "publishes once when a mutation lands after the publish point, then holds the next input at L0",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-post" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-post",
              messageId: "m-post",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-post)",
              records: [memoryChip("mem-post", "mem-post")],
            });
            yield* Deferred.await(afterSettle);
            expect(harness.codexA.sendTurnEntries).toBe(1);
            expect(yield* sendAttemptStates(harness)).toEqual(["provider_accepted"]);

            // A mutation linearizing after this send is ordered after it: the
            // already-published prompt is not recalled, and the affected hold
            // the update leaves is what the next input sees at L0.
            const updated = yield* harness.ledger.withMemoryMutation(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: ProjectMemoryId.make("mem-post"),
                expectedVersion: 1,
                title: "Rotated title",
                body: "Rotated body",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:02.000Z",
              }),
            );
            expect(updated.status).toBe("applied");

            const nextReport = yield* Deferred.make<void>();
            harness.setAfterCommand((command) =>
              isMemoryFailureReport(command, "m-post-next", MEMORY_SEND_HOLD_DETAIL.affected)
                ? Deferred.succeed(nextReport, undefined).pipe(Effect.asVoid)
                : undefined,
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-post-next",
              messageId: "m-post-next",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-post)",
              records: [memoryChip("mem-post", "mem-post")],
            });
            yield* Deferred.await(nextReport);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(1);
            expect(yield* sendAttemptStates(harness)).toEqual(["provider_accepted"]);
            const thread = (yield* harness.readModel).threads.find(
              (entry) => entry.id === THREAD_ID,
            );
            const failures = failureActivitiesOf(thread);
            expect(failures.length).toBe(1);
            expect(failures[0]!.summary).toBe("Message not sent");
            expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(
              MEMORY_SEND_HOLD_DETAIL.affected,
            );
          }),
        );
      }),
  );

  effectIt.live(
    "refuses adapter entry and preserves the new binding when the session row moves A->B after commit",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-bind" });
            const release = yield* dispatchParkedMemoryTurn(harness, {
              commandId: "cmd-bind",
              messageId: "m-bind",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-bind)",
              records: [memoryChip("mem-bind", "mem-bind")],
            });
            // A concurrent recovery for the same thread claimed instance B: the
            // persisted row moved while the A-recovery startSession was parked.
            yield* harness.directory.upsert({
              threadId: THREAD_ID,
              provider: CODEX_DRIVER,
              providerInstanceId: CODEX_B_INSTANCE,
              status: "running",
              resumeCursor: { opaque: "resume-b" },
              runtimeMode: "approval-required",
            });
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              messageId: "m-bind",
            });
            // The refused A-recovery wrote nothing and never speculatively stopped
            // either adapter's session for the new thread key.
            expect(harness.codexA.sendTurnEntries).toBe(0);
            expect(harness.codexB.sendTurnEntries).toBe(0);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
            const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
            expect(binding.providerInstanceId).toBe(CODEX_B_INSTANCE);
            expect(binding.resumeCursor).toEqual({ opaque: "resume-b" });
            // The refusal happened at the locked binding write, before turn
            // analytics acquired: no attempted/rejected events exist to clean up.
            expect(harness.analytics.eventsByName("provider.turn.attempted").length).toBe(0);
            expect(harness.analytics.eventsByName("provider.turn.rejected").length).toBe(0);
            expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(0);
            yield* expectNoSecretLeakage(harness);
          }),
        );
      }),
  );

  effectIt.live(
    "refuses adapter entry and reports store-failed when the committed attempt row cannot decode",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-store" });
            const release = yield* dispatchParkedMemoryTurn(harness, {
              commandId: "cmd-store",
              messageId: "m-store",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-store)",
              records: [memoryChip("mem-store", "mem-store")],
            });
            // Corrupt the committed attempt's item row: the empty memory id fails
            // row decode, so revalidation surfaces a typed store failure with no
            // foreign cause attached to the refusal.
            yield* harness.sql`
              INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
              SELECT attempt_seq, '', 1
              FROM project_memory_send_attempts
              WHERE thread_id = ${THREAD_ID} AND message_id = ${"m-store"}
            `;
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(afterSettle);
            yield* expectRefusalSettlement(harness, {
              detail: MEMORY_SEND_HOLD_DETAIL["store-failed"],
              messageId: "m-store",
            });
            expect(harness.codexA.sendTurnEntries).toBe(0);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            const serializedLogs = harness.logs
              .map((entry) => `${entry.level} ${entry.message} ${entry.cause}`)
              .join("\n");
            expect(serializedLogs).not.toContain("project_memory_send_items");
            yield* expectNoSecretLeakage(harness);

            // Same-message retry after the real late refusal settled unknown:
            // delete only the deliberately malformed item row, leaving the
            // committed attempt and its real item untouched so the retry reaches
            // admission and the unique ledger row fences it as already-committed.
            yield* harness.sql`
              DELETE FROM project_memory_send_items
              WHERE memory_id = ${""}
            `;
            const retryReport = yield* Deferred.make<void>();
            harness.setAfterCommand((command) =>
              isMemoryFailureReport(
                command,
                "m-store",
                MEMORY_SEND_HOLD_DETAIL["already-committed"],
              )
                ? Deferred.succeed(retryReport, undefined).pipe(Effect.asVoid)
                : undefined,
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-store-retry",
              messageId: "m-store",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-store)",
              records: [memoryChip("mem-store", "mem-store")],
            });
            yield* Deferred.await(retryReport);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(0);
            expect(harness.codexB.sendTurnEntries).toBe(0);
            expect(yield* sendAttemptStates(harness)).toEqual(["external_send_unknown"]);
            const retriedThread = (yield* harness.readModel).threads.find(
              (entry) => entry.id === THREAD_ID,
            );
            const retriedFailures = failureActivitiesOf(retriedThread);
            expect(retriedFailures.length).toBe(2);
            const retriedReports = retriedFailures.filter(
              (activity) =>
                (activity.payload as { readonly detail?: string }).detail ===
                MEMORY_SEND_HOLD_DETAIL["already-committed"],
            );
            expect(retriedReports.length).toBe(1);
            expect(retriedReports[0]!.summary).toBe("Message not sent");
          }),
        );
      }),
  );

  effectIt.live(
    "holds a re-dispatch of the same message as already-committed without re-entering the adapter",
    () =>
      Effect.gen(function* () {
        const afterSettle = yield* Deferred.make<void>();
        yield* withReactorHarness({ afterSettle }, (harness) =>
          Effect.gen(function* () {
            yield* insertProjectMemory(harness, { memoryId: "mem-dupe" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-dupe-1",
              messageId: "m-dupe",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-dupe)",
              records: [memoryChip("mem-dupe", "mem-dupe")],
            });
            yield* Deferred.await(afterSettle);
            expect(harness.codexA.sendTurnEntries).toBe(1);
            expect(yield* sendAttemptStates(harness)).toEqual(["provider_accepted"]);

            // A retry with a fresh command id but the same message id is exactly
            // the re-delivery the unique ledger row must fence: admit holds
            // already-committed and no second provider turn ever starts.
            const secondReport = yield* Deferred.make<void>();
            harness.setAfterCommand((command) =>
              isMemoryFailureReport(command, "m-dupe", MEMORY_SEND_HOLD_DETAIL["already-committed"])
                ? Deferred.succeed(secondReport, undefined).pipe(Effect.asVoid)
                : undefined,
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-dupe-2",
              messageId: "m-dupe",
              text: "Summarize [Project memory](t3-context://v1/memory/mem-dupe)",
              records: [memoryChip("mem-dupe", "mem-dupe")],
            });
            yield* Deferred.await(secondReport);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(1);
            expect(harness.codexB.sendTurnEntries).toBe(0);
            expect(yield* sendAttemptStates(harness)).toEqual(["provider_accepted"]);
            const thread = (yield* harness.readModel).threads.find(
              (entry) => entry.id === THREAD_ID,
            );
            const failures = failureActivitiesOf(thread);
            expect(failures.length).toBe(1);
            expect(failures[0]!.summary).toBe("Message not sent");
            expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(
              MEMORY_SEND_HOLD_DETAIL["already-committed"],
            );
            expect(harness.analytics.eventsByName("provider.turn.attempted").length).toBe(1);
            expect(harness.codexA.stopSession).not.toHaveBeenCalled();
            expect(harness.codexB.stopSession).not.toHaveBeenCalled();
          }),
        );
      }),
  );
});
