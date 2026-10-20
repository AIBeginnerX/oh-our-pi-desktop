import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProjectMemoryId,
  ProjectSkillId,
  ProviderDriverKind,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderInstanceId,
  type ProviderTurnStartResult,
  type ProviderUploadFeedbackInput,
  type ProviderUploadFeedbackResult,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
  type ComposerContextRecord,
  type ProjectSkillContent,
  type ProjectSkillVersionRef,
  TextGenerationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import {
  MEMORY_SEND_HOLD_DETAIL,
  ProjectMemorySendGate,
  layer as projectMemorySendGateLayer,
} from "./memory/ProjectMemorySendGate.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandStateUnavailableError,
  type OrchestrationDispatchError,
  OrchestrationRestartRecoveryHeldError,
} from "./orchestration/Errors.ts";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import {
  ProjectMemoryRepository,
  layer as projectMemoryRepositoryLayer,
} from "./persistence/ProjectMemories.ts";
import {
  ProjectMemorySendLedger,
  layer as projectMemorySendLedgerLayer,
} from "./persistence/ProjectMemorySendLedger.ts";
import { PROJECT_SKILL_SEND_REJECTION_DETAIL } from "./skills/ProjectSkillSendGate.ts";
import { layer as projectSkillMutationFenceLayer } from "./skills/ProjectSkillMutationFence.ts";
import { layer as projectSkillTrialDeliveryLayer } from "./skills/ProjectSkillTrialDelivery.ts";
import { layer as selectedChecksLayer } from "./selectedChecks/SelectedChecks.ts";
import { layer as projectSkillRepositoryLayer } from "./persistence/ProjectSkills.ts";
import { layer as projectSkillTrialRepositoryLayer } from "./persistence/ProjectSkillTrials.ts";
import { ProjectSkillTrialDelivery } from "./skills/ProjectSkillTrialDelivery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns.ts";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "./persistence/Services/ProjectionTurns.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import {
  ProviderAdapterRequestError,
  ProviderSessionDirectoryPersistenceError,
  type ProviderAdapterError,
} from "./provider/Errors.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import type {
  ProviderAdapterShape,
  ProviderMemoryAdmissionSupport,
  ProviderSendTurnAdmission,
} from "./provider/Services/ProviderAdapter.ts";
import { makeProviderRegistryLayer } from "./provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "./textGeneration/TextGeneration.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import { AnalyticsService } from "./telemetry/AnalyticsService.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as RestartContinuations from "./restartContinuations.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import { ServerActivation } from "./serverActivation.ts";
import { ProviderRuntimeLayerLive } from "./server.ts";

// Must equal the startup constants: the two synchronous conservative
// settlements an interrupted thread can take before any provider work.
const INTERRUPTED_WORK_ERROR =
  "The server restarted while a tool was running or waiting for you, so its result is unknown. Check the workspace, then send a message to continue.";
const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

const createdAt = "2026-01-01T00:00:00.000Z";
const laterAt = "2026-01-01T00:00:01.000Z";
const instanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

interface AdapterHandles {
  readonly counts: {
    readonly startSession: number;
    readonly sendTurn: number;
    readonly stopSession: number;
  };
  readonly sendInputs: ReadonlyArray<ProviderSendTurnInput>;
  readonly hasSessions: Set<ThreadId>;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
}

interface AdapterInput {
  // `hasSession` is the only adapter hook the real ProviderService evaluates
  // before the guarded start/send admissions, so it is where a continuation
  // fiber can be parked between the routing reads and the admission gates.
  readonly parkFirstHasSession?: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  readonly sendEntered?: Deferred.Deferred<void>;
  readonly releaseSend?: Deferred.Deferred<void>;
  readonly failSend?: boolean;
  readonly turnId?: TurnId;
  readonly stopEntered?: Deferred.Deferred<void>;
}

// A real ProviderAdapterShape over in-memory session state.
const makeFakeAdapter = (input?: AdapterInput): AdapterHandles => {
  const counts = { startSession: 0, sendTurn: 0, stopSession: 0 };
  const sendInputs: ProviderSendTurnInput[] = [];
  const hasSessions = new Set<ThreadId>();
  const sessionRecords = new Map<ThreadId, ProviderSession>();
  const sessionIdentity = new Map<
    ThreadId,
    { generation: number; nativeSessionId: string | undefined }
  >();
  let nextSessionGeneration = 0;
  let hasSessionCalls = 0;

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

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: codexDriver,
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: true,
    },
    startSession: (startInput: ProviderSessionStartInput) =>
      Effect.sync(() => {
        counts.startSession += 1;
        hasSessions.add(startInput.threadId);
        const session: ProviderSession = {
          provider: codexDriver,
          providerInstanceId: startInput.providerInstanceId,
          status: "ready",
          runtimeMode: startInput.runtimeMode,
          threadId: startInput.threadId,
          resumeCursor: { opaque: `resume-${counts.startSession}` },
          createdAt,
          updatedAt: createdAt,
        };
        sessionRecords.set(session.threadId, session);
        sessionIdentity.set(session.threadId, {
          generation: ++nextSessionGeneration,
          nativeSessionId: nativeSessionIdOf(session.resumeCursor),
        });
        return session;
      }),
    sendTurn: (sendInput: ProviderSendTurnInput, admission?: ProviderSendTurnAdmission) =>
      Effect.gen(function* () {
        if (input?.sendEntered !== undefined) {
          yield* Deferred.succeed(input.sendEntered, undefined);
        }
        if (input?.releaseSend !== undefined) {
          yield* Deferred.await(input.releaseSend);
        }
        // The supplied admission gate runs synchronously inside this publish
        // step, after every await: a refused verdict queues no prompt, so the
        // send counter stays where it was.
        if (admission !== undefined) {
          const identity = sessionIdentity.get(sendInput.threadId);
          if (
            !admission.admit({
              sessionGeneration: identity?.generation ?? 0,
              nativeSessionId: identity?.nativeSessionId,
            })
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: codexDriver,
              method: "thread/send",
              detail: "adapter admission refused",
            });
          }
        }
        counts.sendTurn += 1;
        sendInputs.push(sendInput);
        if (input?.failSend === true) {
          return yield* new ProviderAdapterRequestError({
            provider: codexDriver,
            method: "thread/send",
            detail: "simulated adapter send failure",
          });
        }
        const turnId = input?.turnId ?? TurnId.make(`continued-${String(sendInput.threadId)}`);
        const result: ProviderTurnStartResult = {
          threadId: sendInput.threadId,
          turnId,
          resumeCursor: { opaque: `cursor-${String(turnId)}` },
        };
        return result;
      }),
    memoryAdmission,
    interruptTurn: () => Effect.die("unused interruptTurn"),
    respondToRequest: () => Effect.die("unused respondToRequest"),
    respondToUserInput: () => Effect.die("unused respondToUserInput"),
    stopSession: (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (input?.stopEntered !== undefined) {
          yield* Deferred.succeed(input.stopEntered, undefined);
        }
        counts.stopSession += 1;
        hasSessions.delete(threadId);
        sessionRecords.delete(threadId);
        sessionIdentity.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => Array.from(sessionRecords.values())),
    hasSession: (threadId: ThreadId) => {
      hasSessionCalls += 1;
      const park =
        input?.parkFirstHasSession !== undefined && hasSessionCalls === 1
          ? input.parkFirstHasSession
          : undefined;
      if (park === undefined) {
        return Effect.succeed(hasSessions.has(threadId));
      }
      return Effect.gen(function* () {
        yield* Deferred.succeed(park.entered, undefined);
        yield* Deferred.await(park.release);
        return hasSessions.has(threadId);
      });
    },
    readThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] as ReadonlyArray<{ id: TurnId; items: [] }> }),
    rollbackThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] as ReadonlyArray<never> }),
    stopAll: () =>
      Effect.sync(() => {
        hasSessions.clear();
        sessionRecords.clear();
        sessionIdentity.clear();
      }),
    uploadFeedback: (feedbackInput: ProviderUploadFeedbackInput) =>
      Effect.succeed({
        feedbackId: `feedback-${String(feedbackInput.threadId)}`,
      } as ProviderUploadFeedbackResult),
    get streamEvents() {
      return Stream.empty;
    },
  };

  return { counts, sendInputs, hasSessions, adapter };
};

const unusedTextGeneration: TextGeneration["Service"] = {
  generateCommitMessage: () => Effect.die("unused generateCommitMessage"),
  generatePrContent: () => Effect.die("unused generatePrContent"),
  generateBranchName: () => Effect.die("unused generateBranchName"),
  generateThreadTitle: () => Effect.die("unused generateThreadTitle"),
};

const makeInstance = (
  requested: ProviderInstanceId,
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderInstance => ({
  instanceId: requested,
  driverKind: codexDriver,
  continuationIdentity: {
    driverKind: codexDriver,
    continuationKey: "codex:test-instance",
  },
  displayName: undefined,
  enabled: true,
  snapshot: {
    resolveMaintenance: () => Effect.die("unused resolveMaintenance"),
    getSnapshot: Effect.die("unused getSnapshot"),
    refresh: Effect.die("unused refresh"),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.die("unused applyUsageLimits"),
  },
  adapter,
  textGeneration: unusedTextGeneration,
});

// `available: false` models an instance whose driver cannot resolve — the
// pre-adapter capability failure startup must hold on.
const makeInstanceRegistryLayer = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  input?: { readonly available?: boolean },
) =>
  Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (requested) =>
      Effect.gen(function* () {
        if (input?.available === false) {
          return undefined;
        }
        return makeInstance(requested, adapter);
      }),
    // Synchronous ownership re-check the adapter-registry facade needs to
    // answer `isCurrentAdapter` at the adapter's publish point.
    getInstanceUnsafe: (requested) =>
      input?.available === false ? undefined : makeInstance(requested, adapter),
    listInstances: Effect.succeed(
      input?.available === false ? [] : [makeInstance(instanceId, adapter)],
    ),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (changes) =>
      PubSub.subscribe(changes),
    ),
  });

interface SupplyInput {
  readonly continueAfterRestart?: boolean;
  readonly availableInstance?: boolean;
  readonly adapter?: AdapterInput;
}

// The real production runtime composition exported from server.ts — one
// RestartContinuations layer merged last over the session reaper, usage
// ingestion, the provider stack, and the orchestration stack — with only its
// environment-level dependencies supplied. Engine, projection pipeline,
// snapshot query, directory, turn repository, ProviderService, and the
// memory repository / send ledger / send gate startup reads through are the
// real ones over one shared in-memory SQLite client. The instance registry,
// analytics, and event loggers are ancillary mocks; only the registry's
// `available` flag is load-bearing.
const makeSupplyLayer = (input: SupplyInput = {}) => {
  const handles = makeFakeAdapter(input.adapter);
  const environmentDescriptor = {
    environmentId: EnvironmentId.make("environment-test"),
    label: "Test environment",
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  };
  const supply = projectSkillTrialDeliveryLayer.pipe(
    Layer.provideMerge(selectedChecksLayer),
    Layer.provideMerge(ProviderRuntimeLayerLive),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentDescriptor.environmentId),
        getDescriptor: Effect.succeed(environmentDescriptor),
      }),
    ),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        projectSkillMutationFenceLayer,
        projectSkillRepositoryLayer,
        projectSkillTrialRepositoryLayer,
      ),
    ),
    Layer.provideMerge(
      makeInstanceRegistryLayer(handles.adapter, {
        available: input.availableInstance ?? true,
      }),
    ),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(
      ServerSettings.layerTest({
        continueThreadsAfterServerUpdate: input.continueAfterRestart ?? false,
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-startup-continuations-" }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        AnalyticsService,
        AnalyticsService.of({
          record: () => Effect.void,
          flush: Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(projectMemoryRepositoryLayer),
    Layer.provideMerge(projectMemorySendLedgerLayer),
    Layer.provideMerge(projectMemorySendGateLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return { handles, supply };
};

// Startup records continuation evidence from its forked fiber only after the
// provider effect settles, so adapter-entry and analytics signals fire before
// the record and cannot stand in for it. This wrapper delegates to the real
// supplied service — the token Map stays the single source of truth — and
// completes once the original record lands for the thread, keeping the token
// that record actually saw. Startup and its fork observe the wrapper through
// normal context inheritance; the engine and provider layers keep using the
// same underlying registry.
const observeStartupRecord = (
  real: RestartContinuations.RestartContinuations["Service"],
  threadId: ThreadId,
) =>
  Effect.map(Deferred.make<void>(), (recorded) => {
    let observed: RestartContinuations.ContinuationToken | undefined;
    const wrapper: RestartContinuations.RestartContinuations["Service"] = {
      ...real,
      record: (token, evidence) => {
        real.record(token, evidence);
        if (token.threadId === threadId) {
          observed = token;
          Deferred.doneUnsafe(recorded, Effect.void);
        }
      },
    };
    return { recorded, wrapper, observedToken: () => observed };
  });

const seedThreadWithRunningTurn = (
  engine: OrchestrationEngineService["Service"],
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project-${String(threadId)}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`${String(threadId)}-project`),
      projectId,
      title: "Startup continuations",
      workspaceRoot: `/tmp/${String(threadId)}`,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${String(threadId)}-create`),
      threadId,
      projectId,
      title: "Startup continuations",
      modelSelection: { instanceId, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${String(threadId)}-running`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: TurnId.make(`interrupted-${String(threadId)}`),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

const seedPendingTurnStart = (engine: OrchestrationEngineService["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project-${String(threadId)}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`${String(threadId)}-project`),
      projectId,
      title: "Startup continuations",
      workspaceRoot: `/tmp/${String(threadId)}`,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${String(threadId)}-create`),
      threadId,
      projectId,
      title: "Startup continuations",
      modelSelection: { instanceId, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${String(threadId)}-ready`),
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    // The running interrupted-turn history precedes the pending start: a
    // session-set to running with an active turn consumes the pending row, so
    // the committed user turn start whose provider turn never began — the
    // pending placeholder row plus the user message — stays the final state.
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${String(threadId)}-running`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: TurnId.make(`interrupted-${String(threadId)}`),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${String(threadId)}-turn-start`),
      threadId,
      message: {
        messageId: MessageId.make(`message-${String(threadId)}`),
        role: "user",
        text: "continue me",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });
  });

// The persisted pre-restart directory state, written through the real
// directory over the shared SQLite client.
const seedRunningBinding = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadId: ThreadId,
) =>
  directory.upsert({
    threadId,
    provider: codexDriver,
    providerInstanceId: instanceId,
    status: "running",
    resumeCursor: { threadId },
    runtimePayload: {
      activeTurnId: TurnId.make(`interrupted-${String(threadId)}`),
      continueAfterServerUpdate: TurnId.make(`interrupted-${String(threadId)}`),
    },
  });

const interruptedTurnIdFor = (threadId: ThreadId) => TurnId.make(`interrupted-${String(threadId)}`);

const readModelThread = (query: ProjectionSnapshotQuery["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const model = yield* query.getCommandReadModel();
    return model.threads.find((thread) => thread.id === threadId) ?? null;
  });

const dispatchObservedRunning = (
  engine: OrchestrationEngineService["Service"],
  threadId: ThreadId,
  turnId: TurnId,
) =>
  engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`${String(threadId)}-observed-running`),
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: laterAt,
    },
    createdAt: laterAt,
  });

const dispatchSettledReady = (engine: OrchestrationEngineService["Service"], threadId: ThreadId) =>
  engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`${String(threadId)}-settled`),
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: laterAt,
    },
    createdAt: laterAt,
  });

const dispatchNextTurnStart = (engine: OrchestrationEngineService["Service"], threadId: ThreadId) =>
  engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`${String(threadId)}-next-turn`),
    threadId,
    message: {
      messageId: MessageId.make(`message-next-${String(threadId)}`),
      role: "user",
      text: "next turn after release",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: laterAt,
  });

// A continuation candidate whose interrupted turn consumed a real user turn
// start: the send ledger's provenance read needs the projected user message,
// while startup's interrupted-turn pre-check needs the pending row gone. The
// running set's own command id stays unique so later post-release dispatches
// against the same thread still commit.
const seedMemoryCarryingOrphan = (
  engine: OrchestrationEngineService["Service"],
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project-${String(threadId)}`);
    yield* seedPendingTurnStart(engine, threadId);
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`${String(threadId)}-memory-orphan-running`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: interruptedTurnIdFor(threadId),
        lastError: null,
        updatedAt: laterAt,
      },
      createdAt: laterAt,
    });
    yield* seedRunningBinding(directory, threadId);
    return projectId;
  });

// A real committed send attempt followed by a real memory write or delete:
// the migration triggers turn it into the affected row the gate's startup
// read reports. Asserting the real ledger itself is held is what makes the
// settle under test mean something.
const seedAffectedMemory = (
  memoryRepository: ProjectMemoryRepository["Service"],
  ledger: ProjectMemorySendLedger["Service"],
  threadId: ThreadId,
  projectId: ProjectId,
  reason: "updated" | "deleted",
) =>
  Effect.gen(function* () {
    const memoryId = ProjectMemoryId.make(`memory-${String(threadId)}`);
    const inserted = yield* memoryRepository.insert({
      memoryId,
      projectId,
      kind: "fact",
      title: "Runbook",
      body: "Restart steps",
      origin: { type: "manual" },
      validUntil: null,
      estimatedTokens: 10,
      now: createdAt,
    });
    assert.strictEqual(inserted.status, "applied");
    const committed = yield* ledger.commitDispatch({
      threadId,
      messageId: MessageId.make(`message-${String(threadId)}`),
      projectId,
      providerInstanceId: instanceId,
      items: [{ memoryId, selectedVersion: 1 }],
      now: yield* DateTime.now,
    });
    assert.strictEqual(committed.status, "committed");
    if (reason === "updated") {
      const updated = yield* memoryRepository.update({
        projectId,
        memoryId,
        expectedVersion: 1,
        title: "Runbook v2",
        body: "Restart steps v2",
        kind: "fact",
        validUntil: null,
        estimatedTokens: 12,
        now: laterAt,
      });
      assert.strictEqual(updated.status, "applied");
    } else {
      const deleted = yield* memoryRepository.delete({
        projectId,
        memoryId,
        expectedVersion: 1,
      });
      assert.strictEqual(deleted.status, "applied");
    }
    const affected = yield* ledger.affectedState({ threadId, limit: 1 });
    assert.isTrue(affected.held);
    assert.strictEqual(affected.changes[0]?.reason, reason);
    return affected;
  });

const couldNotBeVerifiedHint = "could not be verified";
const stillResumingHint = "still resuming";
const isRecoveryHeldError = Schema.is(OrchestrationRestartRecoveryHeldError);
const isCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

// Narrows to the cleanup command id a held token registered, failing the test
// when the evidence is anything else.
const heldCleanupCommandId = (token: RestartContinuations.ContinuationToken): CommandId => {
  if (token.evidence?.kind !== "held") {
    return assert.fail("expected held evidence naming the cleanup command");
  }
  return token.evidence.commandId;
};

// Fails unless the exit is the engine refusing a follow-up command because
// this thread's recovery could not be verified — not because it is merely
// still resuming.
const assertUnverifiedHold = (
  exit: Exit.Exit<{ readonly sequence: number }, OrchestrationDispatchError>,
): void => {
  if (!Exit.isFailure(exit)) {
    return assert.fail("expected the follow-up command to be held");
  }
  const error = Cause.squash(exit.cause);
  if (!isRecoveryHeldError(error)) {
    return assert.fail("expected a restart-recovery hold rejection");
  }
  assert.isTrue(error.detail.includes(couldNotBeVerifiedHint));
  assert.isFalse(error.detail.includes(stillResumingHint));
};

const storedCommandEventCount = (
  eventStore: OrchestrationEventStore["Service"],
  commandId: CommandId,
) =>
  Effect.gen(function* () {
    const stored = Array.from(yield* Stream.runCollect(eventStore.readAll()));
    return stored.filter((event) => event.commandId === commandId).length;
  });

// The gate reports no hold until `flag` flips: the synchronous pre-check
// inside reconcile passes, and the parked continuation's late check holds.
const makeLateHoldGate = (
  real: ProjectMemorySendGate["Service"],
  threadId: ThreadId,
  reason: "affected" | "store-failed",
) =>
  Effect.map(Ref.make(false), (flag) => ({
    flag,
    service: {
      ...real,
      threadHold: (heldThreadId: ThreadId) =>
        heldThreadId === threadId
          ? Effect.map(Ref.get(flag), (on) => (on ? Option.some(reason) : Option.none()))
          : real.threadHold(heldThreadId),
    } satisfies ProjectMemorySendGate["Service"],
  }));

// Startup-only engine wrapper: this thread's settlement dispatches announce
// through `entered`, wait at `release`, and collect their result exits —
// `allSettled` completes once `settleCount` of them have settled. `caller`
// carries the actual parked startup fiber captured at the boundary, whose
// Exit is the only true completion receipt for terminal-state assertions.
// Every other dispatch delegates to the real engine untouched.
const wrapEngineAtCleanup = (
  real: OrchestrationEngineService["Service"],
  threadId: ThreadId,
  settleCount: number,
) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const allSettled = yield* Deferred.make<void>();
    const caller = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const exits: Exit.Exit<{ readonly sequence: number }, OrchestrationDispatchError>[] = [];
    let settled = 0;
    const wrapper: OrchestrationEngineService["Service"] = {
      ...real,
      dispatch: (command, options) => {
        const settlement = options?.continuationSettlement;
        if (settlement === undefined || settlement.token.threadId !== threadId) {
          return real.dispatch(command, options);
        }
        return Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.succeed(caller, yield* Effect.fiber);
          yield* Deferred.await(release);
          return yield* real.dispatch(command, options).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                exits.push(exit);
                settled += 1;
                if (settled >= settleCount) {
                  Deferred.doneUnsafe(allSettled, Effect.void);
                }
              }),
            ),
          );
        });
      },
    };
    return { wrapper, entered, release, allSettled, caller, exits };
  });

it.effect("continues through the real provider stack and releases the engine hold (S0/S1)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-healthy-first");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
      );
      yield* Deferred.await(recorded);

      // The real ProviderService admitted the continuation through fresh
      // recovery and the send; startup reserved before the fork and recorded
      // the returned turn as evidence, writing nothing else itself.
      const resumedTurn = TurnId.make(`continued-${String(threadId)}`);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      assert.strictEqual(token, observedToken());
      assert.strictEqual(token?.providerInstanceId, instanceId);
      assert.deepStrictEqual(token?.evidence, { kind: "returned", turnId: resumedTurn });
      assert.isTrue(continuations.isLive(token!));
      assert.equal(handles.counts.startSession, 1);
      assert.equal(handles.counts.sendTurn, 1);
      assert.equal(handles.counts.stopSession, 0);
      // The fixed promptless continuation signal — the send carries no
      // hydrated text at all.
      const sendInput = handles.sendInputs[0];
      assert.strictEqual(sendInput?.threadId, threadId);
      assert.strictEqual(sendInput?.continuation, true);
      assert.strictEqual(sendInput?.input, undefined);
      assert.strictEqual(sendInput?.interactionMode, "default");

      // The provider's final conditional binding write cleared the markers.
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "running");
        assert.equal(payload.activeTurnId, resumedTurn);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
      }

      // The engine observes the committed running set through the same
      // instance startup reserved on, adding the returned turn to `seen`...
      yield* dispatchObservedRunning(engine, threadId, resumedTurn);
      assert.isTrue(token?.seen.has(resumedTurn));

      // ...and then releases the hold on the next held command, retiring the
      // token: one actual registry judged by both halves of the composition.
      yield* dispatchSettledReady(engine, threadId);
      yield* dispatchNextTurnStart(engine, threadId);
      assert.equal(continuations.current(threadId), undefined);
    }).pipe(Effect.provide(supply));
  }),
);

it.effect(
  "records returned evidence when the running observation commits before the send resolves (S1)",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("continuations-healthy-second");
      const resumedTurn = TurnId.make("continued-known-order");
      const sendEntered = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      const { handles, supply } = makeSupplyLayer({
        continueAfterRestart: true,
        adapter: {
          turnId: resumedTurn,
          sendEntered,
          releaseSend,
        },
      });

      return yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const continuations = yield* RestartContinuations.RestartContinuations;
        const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
          continuations,
          threadId,
        );

        yield* seedThreadWithRunningTurn(engine, threadId);
        yield* seedRunningBinding(directory, threadId);

        yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
          Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        );
        const token = continuations.current(threadId);
        assert.isDefined(token);
        yield* Deferred.await(sendEntered);

        // The committed running observation lands while the send is still in
        // flight, before any evidence exists.
        yield* dispatchObservedRunning(engine, threadId, resumedTurn);
        assert.isTrue(token?.seen.has(resumedTurn));
        assert.strictEqual(token?.evidence, undefined);

        yield* Deferred.succeed(releaseSend, undefined);
        yield* Deferred.await(recorded);
        assert.strictEqual(token, observedToken());
        assert.deepStrictEqual(token?.evidence, { kind: "returned", turnId: resumedTurn });
        assert.isTrue(continuations.isLive(token!));
        assert.equal(handles.counts.sendTurn, 1);

        const binding = yield* directory.getBinding(threadId);
        assert.isTrue(Option.isSome(binding));
        if (Option.isSome(binding)) {
          const payload = payloadRecord(binding.value.runtimePayload);
          assert.equal(payload.activeTurnId, resumedTurn);
          assert.equal(payload.continueAfterServerUpdate, null);
          assert.equal(payload.continueAfterServerUpdatePrepared, null);
        }

        yield* dispatchSettledReady(engine, threadId);
        yield* dispatchNextTurnStart(engine, threadId);
        assert.equal(continuations.current(threadId), undefined);
      }).pipe(Effect.provide(supply));
    }),
);

it.effect("settles a stored pending turn start synchronously through the real engine (S2)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-pending-start");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const turnRepository = yield* ProjectionTurnRepository;
      const sql = yield* SqlClient.SqlClient;
      const messageId = MessageId.make(`message-${String(threadId)}`);

      yield* seedPendingTurnStart(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      // Real precondition: the durable state is genuinely pre-provider-start,
      // with the pending placeholder row startup's pre-check reads still there.
      const seededPending = yield* turnRepository.getPendingTurnStartByThreadId({ threadId });
      assert.isTrue(Option.isSome(seededPending));
      if (Option.isSome(seededPending)) {
        assert.strictEqual(seededPending.value.messageId, messageId);
      }

      // The pending pre-check runs before prepare and fork, so the settle is
      // durable before reconcileProviderSessions even returns.
      yield* ServerRuntimeStartup.reconcileProviderSessions;

      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.lastError, INTERRUPTED_WORK_ERROR);

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "stopped");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
      }

      // The real pipeline removed the placeholder with the failed start while
      // the user message survives it.
      const pending = yield* turnRepository.getPendingTurnStartByThreadId({ threadId });
      assert.isTrue(Option.isNone(pending));
      const storedMessages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
      assert.deepStrictEqual(storedMessages, [{ count: 1 }]);
    }).pipe(Effect.provide(supply));
  }),
);

it.effect("takes the conservative settle when the pending read fails (S2)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-pending-read-failure");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const realRepository = yield* ProjectionTurnRepository;

      // Startup's safety check yields the repository dynamically, so the
      // delegating override has to sit directly on the reconcile effect — a
      // supply-level replacement never becomes the service startup reads.
      const failingRead = new PersistenceSqlError({
        operation: "ProjectionTurnRepository.getPendingTurnStartByThreadId",
        detail: "simulated pending turn read failure",
      });
      let failingReadsForThread = 0;
      const repositoryOverride: ProjectionTurnRepository["Service"] = {
        ...realRepository,
        getPendingTurnStartByThreadId: (input) => {
          if (input.threadId !== threadId) {
            return realRepository.getPendingTurnStartByThreadId(input);
          }
          failingReadsForThread += 1;
          return Effect.fail(failingRead);
        },
      };

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(ProjectionTurnRepository, repositoryOverride),
      );
      assert.isTrue(failingReadsForThread > 0);

      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.lastError, ORPHANED_PROVIDER_SESSION_ERROR);
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        assert.equal(binding.value.status, "stopped");
      }
    }).pipe(Effect.provide(supply));
  }),
);

it.effect("holds a failed capability lookup with zero provider admissions (S3)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-capability-failure");
    const { handles, supply } = makeSupplyLayer({
      continueAfterRestart: true,
      availableInstance: false,
    });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
      );
      yield* Deferred.await(recorded);

      // The parked continuation failed before any adapter effect could be
      // admitted; startup wrote nothing beyond the synchronous prepare.
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      assert.strictEqual(token, observedToken());
      assert.deepStrictEqual(token?.evidence, { kind: "unverified" });

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "starting");
      assert.strictEqual(thread?.session?.activeTurnId, null);
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "starting");
        assert.equal(payload.continueAfterServerUpdate, interruptedTurnIdFor(threadId));
        assert.equal(payload.continueAfterServerUpdatePrepared, true);
      }

      // The hold is real: a held dispatch for the thread fails without
      // committing while the unverified token stays fenced.
      const holdExit = yield* engine
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${String(threadId)}-runtime-mode`),
          threadId,
          runtimeMode: "approval-required",
          createdAt: laterAt,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(holdExit));
      assert.isTrue(continuations.isLive(token!));
    }).pipe(Effect.provide(supply));
  }),
);

it.effect("holds an adapter send failure without startup failure writes (S3)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-adapter-failure");
    const { handles, supply } = makeSupplyLayer({
      continueAfterRestart: true,
      adapter: { failSend: true },
    });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
      );
      yield* Deferred.await(recorded);

      // The real provider leg was admitted (fresh recovery), the adapter send
      // failed, and the parked continuation held: no session failure write
      // and no binding stop beyond the provider's own recovery write.
      assert.equal(handles.counts.startSession, 1);
      assert.equal(handles.counts.sendTurn, 1);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      assert.strictEqual(token, observedToken());
      assert.deepStrictEqual(token?.evidence, { kind: "unverified" });

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "starting");
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        // The provider's recovery write kept the prepared markers (payload
        // merge) and named no active turn; startup added nothing.
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "running");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, interruptedTurnIdFor(threadId));
        assert.equal(payload.continueAfterServerUpdatePrepared, true);
      }
    }).pipe(Effect.provide(supply));
  }),
);

// The paused-reactor proof: an accepted Stop commits and the engine's
// committed-batch observer cancels the shared token while the real command
// reactor is subscribed but parked at activation — so the provider stop runs
// zero times — and releasing the continuation still cannot enter the real
// ProviderService. Only after the reactor is released does the provider stop
// leg run, and it settles the thread durably.
it.effect(
  "accepted Stop with the reactor parked blocks admission and settles durably on release (S4/E)",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("continuations-parked-reactor-stop");
      const aEntered = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const releaseReactor = yield* Deferred.make<void>();
      const stopEntered = yield* Deferred.make<void>();
      const { handles, supply } = makeSupplyLayer({
        continueAfterRestart: true,
        adapter: {
          parkFirstHasSession: { entered: aEntered, release: releaseA },
          stopEntered,
        },
      });

      // The same production runtime composition, with the real command reactor
      // built on top of it the way the server builds ReactorLayerLive over
      // ProviderRuntimeLayerLive. The reactor-only mocks are ancillary services
      // whose methods the stop flow never calls.
      const reactorFixture = ProviderCommandReactorLive.pipe(
        Layer.provideMerge(projectMemoryRepositoryLayer),
        Layer.provideMerge(projectMemorySendLedgerLayer),
        Layer.provideMerge(projectMemorySendGateLayer),
        Layer.provideMerge(makeProviderRegistryLayer([])),
        Layer.provideMerge(
          Layer.mock(ProviderAuthService, { tryHandlePromptCommand: () => Effect.succeed(false) }),
        ),
        Layer.provideMerge(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
        Layer.provideMerge(Layer.mock(VcsStatusBroadcaster)({})),
        Layer.provideMerge(Layer.mock(TextGeneration)({})),
        Layer.provideMerge(Layer.mock(TerminalManager)({})),
        Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
        Layer.provideMerge(supply),
      );

      return yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const query = yield* ProjectionSnapshotQuery;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* ProviderCommandReactor;
        const continuations = yield* RestartContinuations.RestartContinuations;
        const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
          continuations,
          threadId,
        );

        yield* seedThreadWithRunningTurn(engine, threadId);
        yield* seedRunningBinding(directory, threadId);

        // The reactor subscribes before returning and parks its event root at
        // the activation gate; only this start call is gated.
        yield* reactor
          .start()
          .pipe(Effect.provideService(ServerActivation, Deferred.await(releaseReactor)));

        // Startup reserves and forks the continuation with no activation of its
        // own; A parks at the adapter read just before provider admission.
        yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
          Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        );
        const token = continuations.current(threadId);
        assert.isDefined(token);
        yield* Deferred.await(aEntered);
        assert.equal(handles.counts.startSession, 0);
        assert.equal(handles.counts.sendTurn, 0);
        assert.isTrue(continuations.isLive(token!));

        // The accepted stop commits through the real engine; the reactor is
        // still parked, so no provider stop has run, but the engine's
        // committed-batch observer already canceled the shared token.
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`${String(threadId)}-stop`),
          threadId,
          createdAt: laterAt,
        });
        assert.isTrue(token?.canceled);
        assert.isFalse(continuations.isLive(token!));
        assert.equal(handles.counts.stopSession, 0);
        const parkedThread = yield* readModelThread(query, threadId);
        assert.strictEqual(parkedThread?.session?.status, "starting");
        const storedEvents = Array.from(yield* Stream.runCollect(eventStore.readAll()));
        assert.isDefined(
          storedEvents.find(
            (event) =>
              event.type === "thread.session-stop-requested" && event.aggregateId === threadId,
          ),
        );

        // Releasing A cannot re-enter the real ProviderService: the routing
        // guard fails the revoked token with zero adapter start/send calls.
        // The rejection happens during routing, before adapter admission, so
        // the real completion signal is startup's own record(revoked).
        yield* Deferred.succeed(releaseA, undefined);
        yield* Deferred.await(recorded);
        assert.equal(handles.counts.startSession, 0);
        assert.equal(handles.counts.sendTurn, 0);
        assert.strictEqual(token, observedToken());
        assert.deepStrictEqual(token?.evidence, { kind: "revoked" });

        // The surviving provider session is what the reactor's stop leg must
        // actually stop once it is released.
        handles.hasSessions.add(threadId);
        yield* Deferred.succeed(releaseReactor, undefined);
        yield* Deferred.await(stopEntered);
        yield* reactor.drain;

        assert.equal(handles.counts.stopSession, 1);
        assert.equal(handles.counts.startSession, 0);
        assert.equal(handles.counts.sendTurn, 0);
        const binding = yield* directory.getBinding(threadId);
        assert.isTrue(Option.isSome(binding));
        if (Option.isSome(binding)) {
          const payload = payloadRecord(binding.value.runtimePayload);
          assert.equal(binding.value.status, "stopped");
          assert.equal(payload.activeTurnId, null);
          assert.equal(payload.continueAfterServerUpdate, null);
          assert.equal(payload.continueAfterServerUpdatePrepared, null);
        }
        const stoppedThread = yield* readModelThread(query, threadId);
        assert.strictEqual(stoppedThread?.session?.status, "stopped");
        assert.strictEqual(stoppedThread?.session?.activeTurnId, null);
        assert.isTrue(token?.canceled);
        assert.deepStrictEqual(token?.evidence, { kind: "revoked" });
      }).pipe(Effect.provide(reactorFixture));
    }),
);

// A memory hold already on the ledger when reconcile runs settles the
// candidate through the same synchronous path as the other pre-send
// failures: the session reports the fixed hold detail, the binding stops
// with its markers cleared and its resume cursor intact, and no token is
// ever reserved. A hold committed only after this check fences the parked
// continuation at its own late re-check instead (L1/L2 below).
it.effect("settles a memory-affected continuation candidate before provider admission", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-memory-affected");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const ledger = yield* ProjectMemorySendLedger;
      const memoryRepository = yield* ProjectMemoryRepository;

      const projectId = yield* seedMemoryCarryingOrphan(engine, directory, threadId);
      const affected = yield* seedAffectedMemory(
        memoryRepository,
        ledger,
        threadId,
        projectId,
        "updated",
      );

      yield* ServerRuntimeStartup.reconcileProviderSessions;

      // The gate read ran before the instance lookup, the prepared writes,
      // and the token reservation: zero provider admissions, and the
      // synchronous settle carries the fixed hold detail.
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.activeTurnId, null);
      assert.strictEqual(thread?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["affected"]);

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "stopped");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }

      // The ledger hold is independent of the session settle: it stays held
      // until the recorded change is acknowledged.
      const stillHeld = yield* ledger.affectedState({ threadId, limit: 1 });
      assert.isTrue(stillHeld.held);

      // No continuation hold was ever reserved, so held-command classes and
      // a user turn start commit through the real engine unfenced.
      const modeSetExit = yield* engine
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${String(threadId)}-runtime-mode`),
          threadId,
          runtimeMode: "approval-required",
          createdAt: laterAt,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(modeSetExit));
      const nextTurnExit = yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(nextTurnExit));

      // Acknowledging the change does not restart the settled thread: a
      // second reconcile finds no orphan candidate and no marker revives.
      assert.isNotNull(affected.latestChangeSeq);
      const acked = yield* ledger.acknowledge({
        threadId,
        throughChangeSeq: affected.latestChangeSeq!,
      });
      assert.strictEqual(acked.status, "applied");
      assert.isFalse((yield* ledger.affectedState({ threadId, limit: 1 })).held);

      yield* ServerRuntimeStartup.reconcileProviderSessions;

      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      assert.equal(continuations.current(threadId), undefined);
      const settled = yield* readModelThread(query, threadId);
      assert.strictEqual(settled?.session?.status, "error");
      assert.strictEqual(settled?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["affected"]);
      const settledBinding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(settledBinding));
      if (Option.isSome(settledBinding)) {
        const payload = payloadRecord(settledBinding.value.runtimePayload);
        assert.equal(settledBinding.value.status, "stopped");
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
      }
    }).pipe(Effect.provide(supply));
  }),
);

// The controlled-result counterpart: startup only ever sees the held result.
// Every other gate method stays the real service, so this proves the startup
// policy on a store-failed hold, not that the real ledger read failed.
it.effect("settles a continuation candidate when the gate reports store-failed", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-memory-store-failed");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const realGate = yield* ProjectMemorySendGate;

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      // Startup yields the gate dynamically, so the delegating override has
      // to sit on the reconcile effect itself — the same reason the S2
      // repository override lives there rather than in the supply.
      const gateOverride: ProjectMemorySendGate["Service"] = {
        ...realGate,
        threadHold: (heldThreadId) =>
          heldThreadId === threadId
            ? Effect.succeed(Option.some("store-failed" as const))
            : realGate.threadHold(heldThreadId),
      };

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(ProjectMemorySendGate, gateOverride),
      );

      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["store-failed"]);

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "stopped");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }
    }).pipe(Effect.provide(supply));
  }),
);

// A held read must never be rewritten as a normal settle: interrupting the
// gate's ledger read interrupts the reconcile fiber whole and leaves the
// candidate's durable state exactly as seeded for the next startup.
it.effect("propagates a threadHold interruption without settling the candidate", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-memory-interrupted");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const realGate = yield* ProjectMemorySendGate;

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const gateOverride: ProjectMemorySendGate["Service"] = {
        ...realGate,
        threadHold: (heldThreadId) =>
          heldThreadId === threadId ? Effect.interrupt : realGate.threadHold(heldThreadId),
      };

      const reconcile = yield* Effect.forkChild(
        ServerRuntimeStartup.reconcileProviderSessions.pipe(
          Effect.provideService(ProjectMemorySendGate, gateOverride),
        ),
      );
      const exit = yield* Fiber.await(reconcile);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }

      // Nothing was written: the interrupt reached the loop before any
      // settle, prepared write, or token reservation.
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      assert.equal(continuations.current(threadId), undefined);
      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "running");
      assert.strictEqual(thread?.session?.activeTurnId, interruptedTurnIdFor(threadId));
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "running");
        assert.equal(payload.activeTurnId, interruptedTurnIdFor(threadId));
        assert.equal(payload.continueAfterServerUpdate, interruptedTurnIdFor(threadId));
      }
    }).pipe(Effect.provide(supply));
  }),
);

// The acknowledged counterpart: a memory change the user already acked
// before the first reconcile reports no hold, so the candidate takes the
// exact normal admission path — real provider recovery, the fixed promptless
// send input, and the engine hold-release lifecycle.
it.effect("admits the continuation when the memory change was acknowledged before reconcile", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-memory-acked");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const ledger = yield* ProjectMemorySendLedger;
      const memoryRepository = yield* ProjectMemoryRepository;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      const projectId = yield* seedMemoryCarryingOrphan(engine, directory, threadId);
      const affected = yield* seedAffectedMemory(
        memoryRepository,
        ledger,
        threadId,
        projectId,
        "deleted",
      );

      // The recorded change is acknowledged before the first reconcile: the
      // gate's read then reports no hold and the candidate admits normally.
      assert.isNotNull(affected.latestChangeSeq);
      const acked = yield* ledger.acknowledge({
        threadId,
        throughChangeSeq: affected.latestChangeSeq!,
      });
      assert.strictEqual(acked.status, "applied");
      assert.isFalse((yield* ledger.affectedState({ threadId, limit: 1 })).held);

      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
      );
      yield* Deferred.await(recorded);

      const resumedTurn = TurnId.make(`continued-${String(threadId)}`);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      assert.strictEqual(token, observedToken());
      assert.strictEqual(token?.providerInstanceId, instanceId);
      assert.deepStrictEqual(token?.evidence, { kind: "returned", turnId: resumedTurn });
      assert.isTrue(continuations.isLive(token!));
      assert.equal(handles.counts.startSession, 1);
      assert.equal(handles.counts.sendTurn, 1);
      assert.equal(handles.counts.stopSession, 0);
      // The same fixed promptless continuation input — no memory text ever
      // reaches the provider send.
      const sendInput = handles.sendInputs[0];
      assert.strictEqual(sendInput?.threadId, threadId);
      assert.strictEqual(sendInput?.continuation, true);
      assert.strictEqual(sendInput?.input, undefined);
      assert.strictEqual(sendInput?.interactionMode, "default");

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "running");
        assert.equal(payload.activeTurnId, resumedTurn);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
      }

      yield* dispatchObservedRunning(engine, threadId, resumedTurn);
      assert.isTrue(token?.seen.has(resumedTurn));
      yield* dispatchSettledReady(engine, threadId);
      yield* dispatchNextTurnStart(engine, threadId);
      assert.equal(continuations.current(threadId), undefined);
    }).pipe(Effect.provide(supply));
  }),
);

// A memory change committed while the continuation sits parked fences it at
// the late hold check, right after capabilities and before any provider
// admission: the real update trip-wires the real ledger trigger, the held
// cleanup registers with the engine against the preparation receipt, and the
// engine retires the exact token after committing the fixed hold detail.
it.effect("settles a parked continuation whose memory changed late (L1)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-late-affected");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const ledger = yield* ProjectMemorySendLedger;
      const memoryRepository = yield* ProjectMemoryRepository;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      const projectId = yield* seedMemoryCarryingOrphan(engine, directory, threadId);
      // The interrupted turn really carried the memory, and nothing has
      // changed yet: the synchronous pre-check sees a clear ledger.
      const memoryId = ProjectMemoryId.make(`memory-${String(threadId)}`);
      const inserted = yield* memoryRepository.insert({
        memoryId,
        projectId,
        kind: "fact",
        title: "Runbook",
        body: "Restart steps",
        origin: { type: "manual" },
        validUntil: null,
        estimatedTokens: 10,
        now: createdAt,
      });
      assert.strictEqual(inserted.status, "applied");
      const dispatched = yield* ledger.commitDispatch({
        threadId,
        messageId: MessageId.make(`message-${String(threadId)}`),
        projectId,
        providerInstanceId: instanceId,
        items: [{ memoryId, selectedVersion: 1 }],
        now: yield* DateTime.now,
      });
      assert.strictEqual(dispatched.status, "committed");
      assert.isFalse((yield* ledger.affectedState({ threadId, limit: 1 })).held);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      const token = continuations.current(threadId);
      assert.isDefined(token);
      assert.strictEqual(token?.evidence, undefined);

      // The late change lands while the continuation is parked: a real
      // update through the real trigger holds the ledger for this thread.
      const updated = yield* memoryRepository.update({
        projectId,
        memoryId,
        expectedVersion: 1,
        title: "Runbook v2",
        body: "Restart steps v2",
        kind: "fact",
        validUntil: null,
        estimatedTokens: 12,
        now: laterAt,
      });
      assert.strictEqual(updated.status, "applied");
      const affected = yield* ledger.affectedState({ threadId, limit: 1 });
      assert.isTrue(affected.held);
      assert.strictEqual(affected.changes[0]?.reason, "updated");

      // Subscribed before release, so the cleanup commit cannot be missed.
      const events = yield* engine.subscribeDomainEvents;
      const cleanupCommitted = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.filter(
            events,
            (event) =>
              event.type === "thread.session-set" &&
              event.aggregateId === threadId &&
              event.payload.session.status === "error",
          ),
          () => Deferred.succeed(cleanupCommitted, undefined),
        ),
      );

      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      yield* Deferred.await(cleanupCommitted);

      // No provider admission for this continuation, one held cleanup event
      // committed, and the engine retired the exact token.
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      assert.strictEqual(token, observedToken());
      assert.isTrue(token?.revoked === false);
      const cleanupCommandId = heldCleanupCommandId(token!);
      assert.strictEqual(yield* storedCommandEventCount(eventStore, cleanupCommandId), 1);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.activeTurnId, null);
      assert.strictEqual(thread?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["affected"]);

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "stopped");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }

      // The engine receipt is the whole claim: the next user turn commits.
      const nextTurn = yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(nextTurn));
    }).pipe(Effect.provide(supply));
  }),
);

// The controlled-result counterpart of L1: the late hold is store-failed, so
// the settle wording changes and nothing else does.
it.effect("settles a parked continuation when the late hold reports store-failed (L2)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-late-store-failed");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "store-failed",
      );

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      const token = continuations.current(threadId);
      assert.isDefined(token);
      yield* Ref.set(flag, true);

      const events = yield* engine.subscribeDomainEvents;
      const cleanupCommitted = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.filter(
            events,
            (event) =>
              event.type === "thread.session-set" &&
              event.aggregateId === threadId &&
              event.payload.session.lastError === MEMORY_SEND_HOLD_DETAIL["store-failed"],
          ),
          () => Deferred.succeed(cleanupCommitted, undefined),
        ),
      );

      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      yield* Deferred.await(cleanupCommitted);

      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(handles.counts.stopSession, 0);
      const cleanupCommandId = heldCleanupCommandId(token!);
      assert.strictEqual(yield* storedCommandEventCount(eventStore, cleanupCommandId), 1);
      assert.equal(continuations.current(threadId), undefined);

      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.activeTurnId, null);
      assert.strictEqual(thread?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["store-failed"]);

      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "stopped");
        assert.equal(payload.activeTurnId, null);
        assert.equal(payload.continueAfterServerUpdate, null);
        assert.equal(payload.continueAfterServerUpdatePrepared, null);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }

      const nextTurn = yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(nextTurn));
    }).pipe(Effect.provide(supply));
  }),
);

// A hold on another thread's memory must not fence this continuation: the
// late per-thread check admits the send and the S0/S1 outcome follows, with
// the decoy hold untouched.
it.effect("sends the parked continuation when only another thread is affected (P)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-late-decoy");
    const decoyId = ThreadId.make("continuations-late-decoy-other");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const ledger = yield* ProjectMemorySendLedger;
      const memoryRepository = yield* ProjectMemoryRepository;
      const { recorded, wrapper, observedToken } = yield* observeStartupRecord(
        continuations,
        threadId,
      );

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);
      // The decoy is a real memory-carrying orphan: commitDispatch needs its
      // real thread and projected user message, and the decoy's own affected
      // hold settles it synchronously instead of ever continuing it.
      const decoyProjectId = yield* seedMemoryCarryingOrphan(engine, directory, decoyId);
      yield* seedAffectedMemory(memoryRepository, ledger, decoyId, decoyProjectId, "updated");

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      const token = continuations.current(threadId);
      assert.isDefined(token);
      // The decoy hold exists while this continuation is parked, and this
      // thread's own ledger is empty.
      assert.isTrue((yield* ledger.affectedState({ threadId: decoyId, limit: 1 })).held);
      assert.isFalse((yield* ledger.affectedState({ threadId, limit: 1 })).held);

      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);

      const resumedTurn = TurnId.make(`continued-${String(threadId)}`);
      assert.strictEqual(token, observedToken());
      assert.deepStrictEqual(token?.evidence, { kind: "returned", turnId: resumedTurn });
      assert.isTrue(continuations.isLive(token!));
      assert.equal(handles.counts.startSession, 1);
      assert.equal(handles.counts.sendTurn, 1);
      assert.equal(handles.counts.stopSession, 0);

      yield* dispatchObservedRunning(engine, threadId, resumedTurn);
      yield* dispatchSettledReady(engine, threadId);
      yield* dispatchNextTurnStart(engine, threadId);
      assert.equal(continuations.current(threadId), undefined);
      assert.isTrue((yield* ledger.affectedState({ threadId: decoyId, limit: 1 })).held);
    }).pipe(Effect.provide(supply));
  }),
);

// The held cleanup waits at the startup engine boundary while a successor
// reserves the thread; when it finally reaches the engine, the settlement
// check refuses both attempts, writes nothing for the cleanup command id,
// and leaves the successor exactly as reserve made it.
it.effect("refuses the held cleanup once a successor reserved the thread (C1a)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-successor");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const {
        wrapper: engineOverride,
        entered,
        release,
        allSettled,
        caller,
        exits,
      } = yield* wrapEngineAtCleanup(engine, threadId, 2);
      // A failed assertion must not strand a writer behind the closed gate.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(entered);

      const successor = continuations.reserve(threadId, instanceId);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(allSettled);
      // Startup's own caller fiber is the completion receipt: the parked
      // attempt handled both refusals and finished its Held result.
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      assert.equal(exits.length, 2);
      const firstExit = exits[0];
      if (firstExit === undefined || !Exit.isFailure(firstExit)) {
        return assert.fail("expected the first cleanup attempt to be refused");
      }
      assert.isTrue(isCommandInvariantError(Cause.squash(firstExit.cause)));
      assert.equal(yield* storedCommandEventCount(eventStore, cleanupCommandId), 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.isTrue(token.revoked);
      assert.strictEqual(continuations.current(threadId), successor);
      assert.isFalse(successor.revoked);
      assert.isTrue(continuations.isLive(successor));
      assert.strictEqual(successor.evidence, undefined);
    }).pipe(Effect.provide(supply));
  }),
);

// The same refusal when there is no current token at all: retiring the exact
// token before the gate opens must invalidate the cleanup just the same.
it.effect("refuses the held cleanup once the token was retired (C1b)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-retired");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const {
        wrapper: engineOverride,
        entered,
        release,
        allSettled,
        caller,
        exits,
      } = yield* wrapEngineAtCleanup(engine, threadId, 2);
      // A failed assertion must not strand a writer behind the closed gate.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(entered);

      continuations.retire(token!);
      assert.equal(continuations.current(threadId), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(allSettled);
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      assert.equal(exits.length, 2);
      const firstExit = exits[0];
      if (firstExit === undefined || !Exit.isFailure(firstExit)) {
        return assert.fail("expected the first cleanup attempt to be refused");
      }
      assert.isTrue(isCommandInvariantError(Cause.squash(firstExit.cause)));
      assert.equal(yield* storedCommandEventCount(eventStore, cleanupCommandId), 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      // The failure path is the only writer of the revoked flag here.
      assert.isTrue(token.revoked);
      assert.equal(continuations.current(threadId), undefined);
    }).pipe(Effect.provide(supply));
  }),
);

// A session-set that commits between the preparation and the cleanup wins the
// projection: the settlement scan sees it after the preparation anchor and
// refuses the cleanup, leaving the interloper's values in place.
it.effect("refuses the held cleanup when another session-set committed first (C2a)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-interloper");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const {
        wrapper: engineOverride,
        entered,
        release,
        allSettled,
        caller,
        exits,
      } = yield* wrapEngineAtCleanup(engine, threadId, 2);
      // A failed assertion must not strand a writer behind the closed gate.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(entered);

      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`${String(threadId)}-interloper`),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "interloper set",
          updatedAt: laterAt,
        },
        createdAt: laterAt,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(allSettled);
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      assert.equal(exits.length, 2);
      const firstExit = exits[0];
      if (firstExit === undefined || !Exit.isFailure(firstExit)) {
        return assert.fail("expected the first cleanup attempt to be refused");
      }
      assert.isTrue(isCommandInvariantError(Cause.squash(firstExit.cause)));
      assert.equal(yield* storedCommandEventCount(eventStore, cleanupCommandId), 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.isTrue(token.revoked);
      // The interloper's values own the projection.
      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "ready");
      assert.strictEqual(thread?.session?.lastError, "interloper set");
    }).pipe(Effect.provide(supply));
  }),
);

// A user stop that commits before the cleanup is judged keeps its outcome:
// the token is canceled, the stop event survives, and the cleanup writes
// nothing.
it.effect("refuses the held cleanup when the thread was stopped first (C2b)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-stopped");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const {
        wrapper: engineOverride,
        entered,
        release,
        allSettled,
        caller,
        exits,
      } = yield* wrapEngineAtCleanup(engine, threadId, 2);
      // A failed assertion must not strand a writer behind the closed gate.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(entered);

      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`${String(threadId)}-stop`),
        threadId,
        createdAt: laterAt,
      });
      assert.isTrue(token.canceled);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(allSettled);
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      assert.equal(exits.length, 2);
      const firstExit = exits[0];
      if (firstExit === undefined || !Exit.isFailure(firstExit)) {
        return assert.fail("expected the first cleanup attempt to be refused");
      }
      assert.isTrue(isCommandInvariantError(Cause.squash(firstExit.cause)));
      const stored = Array.from(yield* Stream.runCollect(eventStore.readAll()));
      assert.isDefined(
        stored.find(
          (event) =>
            event.type === "thread.session-stop-requested" && event.aggregateId === threadId,
        ),
      );
      assert.strictEqual(stored.filter((event) => event.commandId === cleanupCommandId).length, 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.isTrue(token.canceled);
      assert.isTrue(token.revoked);
    }).pipe(Effect.provide(supply));
  }),
);

// A binding writer that takes the row between the preparation and the
// cleanup patch keeps it: the conditional patch refuses, the binding keeps
// the interloper's values, and no cleanup dispatch ever runs.
it.effect("leaves the binding to the writer that took it during the cleanup (C2c)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-binding-taken");
    const foreignInstanceId = ProviderInstanceId.make("codex-interloper");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const patchEntered = yield* Deferred.make<void>();
      const patchSettled =
        yield* Deferred.make<
          Exit.Exit<boolean, ProviderSessionDirectory.ProviderSessionDirectoryWriteError>
        >();
      const caller = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const directoryOverride: ProviderSessionDirectory.ProviderSessionDirectory["Service"] = {
        ...directory,
        upsertIfCurrent: (binding, when) =>
          Effect.gen(function* () {
            // A foreign writer claims the row before the patch is judged.
            yield* directory.upsert({
              threadId,
              provider: codexDriver,
              providerInstanceId: foreignInstanceId,
            });
            yield* Deferred.succeed(patchEntered, undefined);
            yield* Deferred.succeed(caller, yield* Effect.fiber);
            // The Exit oracle sees the actual delegated patch result without
            // disturbing the boolean return startup consumes.
            return yield* directory
              .upsertIfCurrent(binding, when)
              .pipe(Effect.onExit((exit) => Deferred.succeed(patchSettled, exit)));
          }),
      };
      let cleanupDispatches = 0;
      const engineOverride: OrchestrationEngineService["Service"] = {
        ...engine,
        dispatch: (command, options) => {
          if (options?.continuationSettlement?.token.threadId === threadId) {
            cleanupDispatches += 1;
          }
          return engine.dispatch(command, options);
        },
      };

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directoryOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(patchEntered);
      const patchExit = yield* Deferred.await(patchSettled);
      assert.isTrue(Exit.isSuccess(patchExit) && patchExit.value === false);
      // Startup's caller fiber finished its handled Held result before the
      // terminal state is asserted.
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      assert.isTrue(token.revoked);
      assert.equal(cleanupDispatches, 0);
      assert.equal(yield* storedCommandEventCount(eventStore, cleanupCommandId), 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      // The interloper's row survived untouched: its instance, the prepared
      // markers, and the resume cursor.
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.strictEqual(binding.value.providerInstanceId, foreignInstanceId);
        assert.equal(binding.value.status, "starting");
        assert.equal(payload.continueAfterServerUpdate, interruptedTurnIdFor(threadId));
        assert.equal(payload.continueAfterServerUpdatePrepared, true);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }
    }).pipe(Effect.provide(supply));
  }),
);

// Both cleanup attempts failing leaves the token terminal but current: no
// provider call was ever made for it, the Interrupt promotion input stays
// true, and the engine answers follow-up commands with the unverifiable
// wording instead of still-resuming.
it.effect("goes terminal when both held-cleanup attempts fail (C3a)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-cleanup-fails");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      let attempts = 0;
      let settled = 0;
      const allSettled = yield* Deferred.make<void>();
      const caller = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const attemptedCommands: OrchestrationCommand[] = [];
      const attemptedSettlements: RestartContinuations.ContinuationSettlement[] = [];
      const engineOverride: OrchestrationEngineService["Service"] = {
        ...engine,
        dispatch: (command, options) => {
          const settlement = options?.continuationSettlement;
          if (settlement === undefined || settlement.token.threadId !== threadId) {
            return engine.dispatch(command, options);
          }
          return Effect.gen(function* () {
            yield* Deferred.succeed(caller, yield* Effect.fiber);
            return yield* Effect.suspend(() => {
              // Startup constructs one dispatch effect and its retry executes
              // it twice: the counters and captures belong to execution, not
              // to this wrapper method call.
              attempts += 1;
              attemptedCommands.push(command);
              attemptedSettlements.push(settlement);
              if (attempts <= 2) {
                return Effect.fail(
                  new OrchestrationCommandStateUnavailableError({ commandType: command.type }),
                ).pipe(
                  Effect.onExit(() =>
                    Effect.sync(() => {
                      settled += 1;
                      if (settled >= 2) {
                        Deferred.doneUnsafe(allSettled, Effect.void);
                      }
                    }),
                  ),
                );
              }
              return engine.dispatch(command, options);
            });
          });
        },
      };

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(allSettled);
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isSuccess(attemptExit));

      // Both retry executions ran the same constructed command and settlement.
      assert.equal(attempts, 2);
      assert.equal(attemptedCommands.length, 2);
      assert.strictEqual(attemptedCommands[0]?.commandId, cleanupCommandId);
      assert.deepStrictEqual(attemptedCommands[0], attemptedCommands[1]);
      assert.strictEqual(attemptedSettlements[0]?.token, token);
      assert.strictEqual(
        attemptedSettlements[0]?.preparationCommandId,
        attemptedSettlements[1]?.preparationCommandId,
      );
      assert.equal(
        attemptedSettlements[0]?.preparationSequence,
        attemptedSettlements[1]?.preparationSequence,
      );
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.isTrue(token.revoked);
      assert.strictEqual(continuations.current(threadId), token);
      // The held evidence keeps the Interrupt→Stop promotion input true.
      assert.isTrue(continuations.revokeAnyHeld(threadId).wasUnfinished);
      assertUnverifiedHold(yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit));
    }).pipe(Effect.provide(supply));
  }),
);

// When only the binding clear fails before writing (the controlled fixture),
// the projection settle still commits and retires the token, and the binding
// keeps the prepared starting state for the next restart to re-check.
it.effect("commits the projection settle when only the binding clear fails (C3b)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-binding-fails");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const query = yield* ProjectionSnapshotQuery;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      let patchAttempts = 0;
      const directoryOverride: ProviderSessionDirectory.ProviderSessionDirectory["Service"] = {
        ...directory,
        upsertIfCurrent: (binding, when) =>
          Effect.suspend(() => {
            // Startup constructs one patch effect and its retry executes it
            // twice: the count and the fail/delegate choice belong to
            // execution, not to this wrapper method call.
            patchAttempts += 1;
            if (patchAttempts <= 2) {
              return Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "ProviderSessionDirectory.upsertIfCurrent",
                  detail: "simulated held cleanup write failure",
                }),
              );
            }
            return directory.upsertIfCurrent(binding, when);
          }),
      };

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directoryOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);

      const events = yield* engine.subscribeDomainEvents;
      const cleanupCommitted = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.filter(
            events,
            (event) =>
              event.type === "thread.session-set" &&
              event.aggregateId === threadId &&
              event.payload.session.status === "error",
          ),
          () => Deferred.succeed(cleanupCommitted, undefined),
        ),
      );

      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(cleanupCommitted);

      assert.equal(patchAttempts, 2);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);
      assert.equal(continuations.current(threadId), undefined);
      assert.strictEqual(yield* storedCommandEventCount(eventStore, cleanupCommandId), 1);
      const thread = yield* readModelThread(query, threadId);
      assert.strictEqual(thread?.session?.status, "error");
      assert.strictEqual(thread?.session?.lastError, MEMORY_SEND_HOLD_DETAIL["affected"]);
      // The controlled pre-write failure left the binding row at its prepared
      // starting state. The committed error projection with a null active
      // turn keeps the thread out of the next startup's continuation
      // candidates; the next user turn re-judges it through the normal gates.
      const binding = yield* directory.getBinding(threadId);
      assert.isTrue(Option.isSome(binding));
      if (Option.isSome(binding)) {
        const payload = payloadRecord(binding.value.runtimePayload);
        assert.equal(binding.value.status, "starting");
        assert.equal(payload.continueAfterServerUpdate, interruptedTurnIdFor(threadId));
        assert.equal(payload.continueAfterServerUpdatePrepared, true);
        assert.deepStrictEqual(binding.value.resumeCursor, { threadId });
      }
      const nextTurn = yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(nextTurn));
    }).pipe(Effect.provide(supply));
  }),
);

// Interrupting only the startup calling fiber while its cleanup waits at the
// dispatch boundary goes terminal for the old token alone: the held evidence
// survives, no cleanup event is ever written, the engine answers from the
// terminal token, and a successor reserved afterwards is untouched.
it.effect("terminalizes the old token when the parked fiber is interrupted pre-handoff (B1)", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("continuations-held-interrupt");
    const { handles, supply } = makeSupplyLayer({ continueAfterRestart: true });

    return yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const continuations = yield* RestartContinuations.RestartContinuations;
      const eventStore = yield* OrchestrationEventStore;
      const realGate = yield* ProjectMemorySendGate;
      const { recorded, wrapper } = yield* observeStartupRecord(continuations, threadId);
      const { flag, service: gateOverride } = yield* makeLateHoldGate(
        realGate,
        threadId,
        "affected",
      );
      const entered = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const interruptNow = yield* Deferred.make<void>();
      const raceSettled = yield* Deferred.make<void>();
      const caller = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      // A failed assertion must not strand a writer behind the closed gate.
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseDispatch, undefined).pipe(Effect.asVoid),
      );
      const engineOverride: OrchestrationEngineService["Service"] = {
        ...engine,
        dispatch: (command, options) => {
          const settlement = options?.continuationSettlement;
          if (settlement === undefined || settlement.token.threadId !== threadId) {
            return engine.dispatch(command, options);
          }
          return Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            // Captured before the race, so this is the parked startup fiber
            // itself, not one of the race's child fibers.
            yield* Deferred.succeed(caller, yield* Effect.fiber);
            // Only the startup calling fiber is interrupted here, at the
            // wrapper boundary before the real engine queue; the engine stays
            // alive and never judges the command when this arm wins.
            yield* Effect.raceFirst(
              Deferred.await(releaseDispatch),
              Deferred.await(interruptNow).pipe(Effect.andThen(Effect.interrupt)),
            ).pipe(
              Effect.onExit(() =>
                Effect.sync(() => {
                  Deferred.doneUnsafe(raceSettled, Effect.void);
                }),
              ),
            );
            return yield* engine.dispatch(command, options);
          });
        },
      };

      yield* seedThreadWithRunningTurn(engine, threadId);
      yield* seedRunningBinding(directory, threadId);

      const releaseActivation = yield* Deferred.make<void>();
      yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
        Effect.provideService(RestartContinuations.RestartContinuations, wrapper),
        Effect.provideService(ProjectMemorySendGate, gateOverride),
        Effect.provideService(OrchestrationEngineService, engineOverride),
        Effect.provideService(ServerActivation, Deferred.await(releaseActivation)),
      );
      yield* Ref.set(flag, true);
      yield* Deferred.succeed(releaseActivation, undefined);
      yield* Deferred.await(recorded);
      const token = continuations.current(threadId);
      assert.isDefined(token);
      const cleanupCommandId = heldCleanupCommandId(token!);
      yield* Deferred.await(entered);

      yield* Deferred.succeed(interruptNow, undefined);
      yield* Deferred.await(raceSettled);
      // The race ending is not completion: await the parked fiber's real Exit,
      // which must stay interrupted now that startup propagates a pre-handoff
      // interruption after terminalizing the token.
      const attemptExit = yield* Fiber.await(yield* Deferred.await(caller));
      assert.isTrue(Exit.isFailure(attemptExit));
      if (!Exit.isFailure(attemptExit)) {
        return assert.fail("expected the interrupted attempt to fail");
      }
      assert.isTrue(Cause.hasInterruptsOnly(attemptExit.cause));

      assert.isTrue(token.revoked);
      assert.deepStrictEqual(token.evidence, { kind: "held", commandId: cleanupCommandId });
      assert.equal(yield* storedCommandEventCount(eventStore, cleanupCommandId), 0);
      assert.equal(handles.counts.startSession, 0);
      assert.equal(handles.counts.sendTurn, 0);

      // The engine answers the thread from the terminal token.
      assertUnverifiedHold(yield* dispatchNextTurnStart(engine, threadId).pipe(Effect.exit));

      // A successor reserved afterwards is untouched by the terminalization.
      const successor = continuations.reserve(threadId, instanceId);
      assert.strictEqual(continuations.current(threadId), successor);
      assert.isFalse(successor.revoked);
      assert.isTrue(continuations.isLive(successor));
      assert.strictEqual(successor.evidence, undefined);

      // Nothing is left waiting on the abandoned dispatch.
      yield* Deferred.succeed(releaseDispatch, undefined);
    }).pipe(Effect.provide(supply));
  }),
);

// The same digest the gate recomputes before it admits: the stored hash and
// the ref hash must agree on the canonical content bytes.
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const SKILL_ID = ProjectSkillId.make("psk_trial01skill");
const SKILL_CONTENT: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};

// The client-side record carries a bogus client stamp on purpose: the gate
// must never trust it — the committed payload has to show the server's own
// admitted sequence instead.
const skillTrialRecord = (ref: ProjectSkillVersionRef): ComposerContextRecord => ({
  version: 1,
  contextId: ComposerContextId.make("ctx-skill"),
  kind: "project-skill",
  label: "trial",
  payload: { ref, mode: "trial", admittedSkillStateSeq: 9999 },
});

// A live candidate version row: the gate's integrity rehash and the claim's
// version check both need this exact ref as the project's live candidate.
// The source lineage mirrors the real source thread, its receipt sequence,
// and the thread-created sequence the store already committed — no
// authenticated-insert pretense, just a schema-valid row.
const seedSkillCandidate = (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly contentSha256: string;
    readonly sourceThreadCreatedSequence: number;
  },
) =>
  sql`
    INSERT INTO project_skill_versions (
      skill_id, project_id, version, content_json, content_sha256,
      source_json, source_thread_id, source_receipt_sequence,
      source_thread_created_sequence, created_after_event_sequence, created_at
    )
    VALUES (
      ${SKILL_ID}, ${input.projectId}, 1, ${JSON.stringify(SKILL_CONTENT)},
      ${input.contentSha256},
      ${JSON.stringify({
        type: "work",
        check: {
          threadId: input.threadId,
          threadAnchorSequence: 10,
          receiptSequence: 15,
          attemptId: "attempt-1",
          revision: 1,
          projectId: input.projectId,
          workspaceRoot: "/tmp/project",
          worktreePath: null,
          cwd: "/tmp/project",
          envSha256: "a".repeat(64),
          planned: [
            {
              scriptId: "lint",
              scriptName: "Lint",
              commandSha256: "a".repeat(64),
              timeoutMs: 60_000,
            },
          ],
          tree: {
            treeOid: "c".repeat(40),
            repoTopLevel: "/tmp/project",
            repoCommonDir: "/tmp/project",
          },
          environment: {
            environmentId: "env-1",
            platform: "darwin",
            arch: "arm64",
            osRelease: "25.6.0",
            serverVersion: "1.0.0",
            nodeVersion: "22.11.0",
          },
          startedAt: createdAt,
          endedAt: createdAt,
          outcome: "all-selected-passed",
        },
        draft: { type: "typed" },
      })},
      ${input.threadId}, ${15}, ${input.sourceThreadCreatedSequence},
      ${input.sourceThreadCreatedSequence}, ${createdAt}
    )
  `;

// The same production runtime composition, with the real command reactor
// built on top the way ReactorLayerLive sits over ProviderRuntimeLayerLive —
// and only the send-flow ancillaries the turn path actually touches mocked.
// The delivery observer is transparent: the real service still performs the
// claim, every SQL write, and the settle; only its completion is recorded so
// a test can await the provider send the reactor's drain does not cover.
const makeSkillTrialFixture = (
  supply: ReturnType<typeof makeSupplyLayer>["supply"],
  settled: Deferred.Deferred<void>,
) =>
  ProviderCommandReactorLive.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const real = yield* ProjectSkillTrialDelivery;
          return Layer.succeed(ProjectSkillTrialDelivery, {
            ...real,
            settle: (input: Parameters<typeof real.settle>[0]) =>
              real.settle(input).pipe(Effect.tap(() => Deferred.succeed(settled, undefined))),
          });
        }),
      ),
    ),
    Layer.provideMerge(projectMemoryRepositoryLayer),
    Layer.provideMerge(projectMemorySendLedgerLayer),
    Layer.provideMerge(projectMemorySendGateLayer),
    Layer.provideMerge(makeProviderRegistryLayer([])),
    Layer.provideMerge(
      Layer.mock(ProviderAuthService, { tryHandlePromptCommand: () => Effect.succeed(false) }),
    ),
    Layer.provideMerge(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        renameBranch: () => Effect.succeed({ branch: "renamed-branch" }),
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.succeed({ worktree: { path: "", refName: "renamed-branch" } }),
      }),
    ),
    Layer.provideMerge(Layer.mock(VcsStatusBroadcaster)({})),
    Layer.provideMerge(
      Layer.mock(TextGeneration, {
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "disabled in test",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "disabled in test",
            }),
          ),
      }),
    ),
    Layer.provideMerge(Layer.mock(TerminalManager)({ closeIdle: () => Effect.void })),
    Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
    Layer.provideMerge(supply),
  );

// One positive managed send through the exported production composition:
// the real engine gate stamps the server-owned admission sequence onto the
// committed user message, the real reactor resolves the canonical input and
// claims it, the real routed adapter publishes once, and the real delivery
// settles the attempt provider-accepted with the routed driver kind — all
// over the single shared SQLite client.
it.effect(
  "admits, claims, and settles a managed skill send through the real production composition (L1)",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("skill-trial-delivered");
      const projectId = ProjectId.make(`project-${String(threadId)}`);
      const messageId = MessageId.make(`message-${String(threadId)}`);
      const commandId = CommandId.make(`${String(threadId)}-skill-turn`);
      const { handles, supply } = makeSupplyLayer();
      // The provider publish runs on a child fiber the reactor's drain does
      // not await — the real delivery's settle is the causal end instead.
      const settled = yield* Deferred.make<void>();
      const reactorFixture = makeSkillTrialFixture(supply, settled);

      return yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* ProviderCommandReactor;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;

        const contentSha256 = toHex(
          yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(canonicalProjectSkillContentJson(SKILL_CONTENT)),
          ),
        );
        const skillRef: ProjectSkillVersionRef = {
          projectId,
          skillId: SKILL_ID,
          version: 1,
          contentSha256,
        };
        const skillText = `Follow this exactly:\n${renderProjectSkillBlock({ ref: skillRef, content: SKILL_CONTENT, mode: "trial" })}\nThen report back.`;

        // The provider stats the workspace directory before entering the
        // adapter, so the project workspace must exist on disk for real.
        const workspaceRoot = `${serverConfig.stateDir}/skill-workspace`;
        yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`${String(threadId)}-project`),
          projectId,
          title: "Skill trial",
          workspaceRoot,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${String(threadId)}-create`),
          threadId,
          projectId,
          title: "Skill trial",
          modelSelection: { instanceId, model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const threadCreated = Array.from(yield* Stream.runCollect(eventStore.readAll())).find(
          (event) => event.type === "thread.created" && event.aggregateId === threadId,
        );
        if (threadCreated === undefined) {
          return assert.fail("expected a committed thread.created event");
        }
        yield* seedSkillCandidate(sql, {
          projectId,
          threadId,
          contentSha256,
          sourceThreadCreatedSequence: threadCreated.sequence,
        });

        yield* reactor.start().pipe(Effect.provideService(ServerActivation, undefined));
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId,
            role: "user",
            text: skillText,
            attachments: [],
            context: { version: 1, records: [skillTrialRecord(skillRef)] },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
        // Awaiting the real settle receipt covers the claim's commit, the
        // adapter entry, and the settle finalizer — every durable effect of
        // this send; the drain then covers the remaining session/turn commits.
        yield* Deferred.await(settled);
        yield* reactor.drain;

        // The committed user message carries the server-stamped canonical
        // payload — never the client-supplied 9999.
        const stored = Array.from(yield* Stream.runCollect(eventStore.readAll()));
        const messageSent = stored.find(
          (event) => event.type === "thread.message-sent" && event.payload.messageId === messageId,
        );
        if (messageSent === undefined || messageSent.type !== "thread.message-sent") {
          return assert.fail("expected a committed thread.message-sent event");
        }
        const stampedRecord = messageSent.payload.context?.records.find(
          (record) => record.kind === "project-skill",
        );
        if (stampedRecord === undefined) {
          return assert.fail("expected the stamped project-skill record on the committed message");
        }
        const stampedPayload = payloadRecord(
          "payload" in stampedRecord ? stampedRecord.payload : undefined,
        );
        const stampedRef = payloadRecord(stampedPayload.ref);
        assert.strictEqual(stampedPayload.mode, "trial");
        assert.strictEqual(stampedPayload.admittedSkillStateSeq, 0);
        assert.strictEqual(stampedRef.projectId, projectId);
        assert.strictEqual(stampedRef.skillId, SKILL_ID);
        assert.strictEqual(stampedRef.version, 1);
        assert.strictEqual(stampedRef.contentSha256, contentSha256);

        // One admitted publish through the actual routed adapter; the
        // managed block rides the provider input verbatim.
        assert.equal(handles.counts.startSession, 1);
        assert.equal(handles.counts.sendTurn, 1);
        assert.isTrue((handles.sendInputs[0]?.input ?? "").includes("<oop-project-skill"));

        // The real delivery claimed and settled on the same SQLite store:
        // provider-accepted against the canonical input event sequence and
        // the thread incarnation, with the routed driver kind recorded.
        const rows = yield* sql<{
          readonly threadId: string;
          readonly messageId: string;
          readonly projectId: string;
          readonly skillId: string | null;
          readonly version: number | null;
          readonly contentSha256: string | null;
          readonly inputEventSequence: number;
          readonly inputIncarnation: number;
          readonly admittedSkillStateSeq: number | null;
          readonly providerDriverKind: string | null;
          readonly delivery: string;
          readonly deliveryAt: string | null;
          readonly window: string;
          readonly attemptToken: string;
        }>`
          SELECT
            thread_id AS "threadId",
            message_id AS "messageId",
            project_id AS "projectId",
            skill_id AS "skillId",
            version,
            content_sha256 AS "contentSha256",
            input_event_sequence AS "inputEventSequence",
            input_incarnation AS "inputIncarnation",
            admitted_skill_state_seq AS "admittedSkillStateSeq",
            provider_driver_kind AS "providerDriverKind",
            delivery,
            delivery_at AS "deliveryAt",
            window,
            attempt_token AS "attemptToken"
          FROM project_skill_inputs
          ORDER BY rowid ASC
        `;
        assert.equal(rows.length, 1);
        const row = rows[0]!;
        assert.strictEqual(row.threadId, threadId);
        assert.strictEqual(row.messageId, messageId);
        assert.strictEqual(row.projectId, projectId);
        assert.strictEqual(row.skillId, SKILL_ID);
        assert.strictEqual(row.version, 1);
        assert.strictEqual(row.contentSha256, contentSha256);
        assert.strictEqual(row.inputEventSequence, messageSent.sequence);
        assert.strictEqual(row.inputIncarnation, threadCreated.sequence);
        assert.strictEqual(row.admittedSkillStateSeq, 0);
        assert.strictEqual(row.delivery, "provider-accepted");
        assert.strictEqual(row.providerDriverKind, "codex");
        assert.strictEqual(row.window, "open");
        assert.isNotNull(row.deliveryAt);
        assert.isTrue(row.attemptToken.length > 0);
      }).pipe(Effect.provide(reactorFixture));
    }),
);

// The negative half: a managed send whose ref has no stored candidate never
// leaves the engine's transaction — the fixed real rejection reason, no
// committed events, no adapter entry, and no delivery row.
it.effect(
  "rejects a managed send with a missing ref — fixed reason, zero publish, zero rows (L1)",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("skill-trial-missing-ref");
      const projectId = ProjectId.make(`project-${String(threadId)}`);
      const messageId = MessageId.make(`message-${String(threadId)}`);
      const commandId = CommandId.make(`${String(threadId)}-skill-turn`);
      const { handles, supply } = makeSupplyLayer();
      const settled = yield* Deferred.make<void>();
      const reactorFixture = makeSkillTrialFixture(supply, settled);

      return yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* ProviderCommandReactor;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const crypto = yield* Crypto.Crypto;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* ServerConfig;

        const contentSha256 = toHex(
          yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(canonicalProjectSkillContentJson(SKILL_CONTENT)),
          ),
        );
        const skillRef: ProjectSkillVersionRef = {
          projectId,
          skillId: SKILL_ID,
          version: 1,
          contentSha256,
        };
        const skillText = `Follow this exactly:\n${renderProjectSkillBlock({ ref: skillRef, content: SKILL_CONTENT, mode: "trial" })}\nThen report back.`;

        const workspaceRoot = `${serverConfig.stateDir}/skill-workspace`;
        yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`${String(threadId)}-project`),
          projectId,
          title: "Skill trial",
          workspaceRoot,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${String(threadId)}-create`),
          threadId,
          projectId,
          title: "Skill trial",
          modelSelection: { instanceId, model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        yield* reactor.start().pipe(Effect.provideService(ServerActivation, undefined));
        const exit = yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId,
            threadId,
            message: {
              messageId,
              role: "user",
              text: skillText,
              attachments: [],
              context: { version: 1, records: [skillTrialRecord(skillRef)] },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          })
          .pipe(Effect.exit);
        if (!Exit.isFailure(exit)) {
          return assert.fail("expected the managed send to be rejected");
        }
        const error = Cause.squash(exit.cause);
        if (!isCommandInvariantError(error)) {
          return assert.fail("expected an orchestration invariant rejection");
        }
        assert.strictEqual(error.detail, PROJECT_SKILL_SEND_REJECTION_DETAIL["not-admissible"]);

        yield* reactor.drain;
        assert.equal(handles.counts.startSession, 0);
        assert.equal(handles.counts.sendTurn, 0);
        const rows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM project_skill_inputs
        `;
        assert.equal(rows.length, 0);
        assert.equal(yield* storedCommandEventCount(eventStore, commandId), 0);
      }).pipe(Effect.provide(reactorFixture));
    }),
);
