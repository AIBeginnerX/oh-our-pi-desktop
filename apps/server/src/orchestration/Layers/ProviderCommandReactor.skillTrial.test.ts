// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  CommandId,
  ComposerContextId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectSkillId,
  ProjectSkillEvidenceId,
  ProjectSkillJudgmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
  type ComposerContextRecord,
  type ProjectScript,
  type ProjectSkillContent,
  type ProjectSkillVersionRef,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderAdmissionObservation,
  ProviderMemoryAdmissionSupport,
  ProviderSendTurnAdmission,
} from "../../provider/Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { makeClaudeAdapter } from "../../provider/Layers/ClaudeAdapter.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as ProviderSafetyObservations from "../../persistence/ProviderSafetyObservations.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as projectSkillRepositoryLayer } from "../../persistence/ProjectSkills.ts";
import { layer as projectSkillTrialRepositoryLayer } from "../../persistence/ProjectSkillTrials.ts";
import {
  PROJECT_SKILL_SEND_REJECTION_DETAIL,
  layer as projectSkillSendGateLayer,
} from "../../skills/ProjectSkillSendGate.ts";
import {
  ProjectSkillUsePolicy,
  projectSkillUsePolicyFrom,
} from "../../skills/ProjectSkillUsePolicy.ts";
import { layer as ProjectSkillMutationFenceLayer } from "../../skills/ProjectSkillMutationFence.ts";
import {
  SelectedChecks,
  layer as selectedChecksLayer,
} from "../../selectedChecks/SelectedChecks.ts";
import {
  ProjectSkillTrialDelivery,
  layer as projectSkillTrialDeliveryLayer,
  type ProjectSkillTrialDeliveryService,
} from "../../skills/ProjectSkillTrialDelivery.ts";
import { layerUnavailable as projectMemorySendGateLayerUnavailable } from "../../memory/ProjectMemorySendGate.ts";
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
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
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
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claude-agent-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-01-01T00:00:00.000Z";

const SKILL_ID = ProjectSkillId.make("psk_trial01skill");
const SKILL_CONTENT: ProjectSkillContent = {
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
};
const skillContentSha256 = NodeCrypto.createHash("sha256")
  .update(canonicalProjectSkillContentJson(SKILL_CONTENT), "utf8")
  .digest("hex");
const SKILL_REF: ProjectSkillVersionRef = {
  projectId: asProjectId("project-1"),
  skillId: SKILL_ID,
  version: 1,
  contentSha256: skillContentSha256,
};
const SKILL_TEXT = `Follow this exactly:\n${renderProjectSkillBlock({ ref: SKILL_REF, content: SKILL_CONTENT, mode: "trial" })}\nThen report back.`;

const skillRecord = (): ComposerContextRecord => ({
  version: 1,
  contextId: ComposerContextId.make("ctx-skill"),
  kind: "project-skill",
  label: "trial",
  // The client-side shape carries only ref+mode — the engine stamps the
  // canonical admitted sequence itself.
  payload: { ref: SKILL_REF, mode: "trial" },
});

// The project script every use selection resolves against: the harness settings
// carry it as the one default script, so the real SelectedChecks plan names it.
const USE_LINT_SCRIPT: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "echo lint",
  icon: "play",
  runOnWorktreeCreate: false,
};
const USE_SELECTED_SCRIPT_IDS = [USE_LINT_SCRIPT.id] as const;
const USE_EVIDENCE_MESSAGE_ID = "m-use-evidence";
const USE_EVIDENCE_ID = ProjectSkillEvidenceId.make("pse-harness-use-ready");
// A reproduction must run in another thread than the version's source thread.
const USE_SOURCE_THREAD_ID = ThreadId.make("thread-use-source");

const useSkillRecord = (selectedScriptIds: ReadonlyArray<string>): ComposerContextRecord => ({
  version: 1,
  contextId: ComposerContextId.make("ctx-skill-use"),
  kind: "project-skill",
  label: "use",
  payload: { ref: SKILL_REF, mode: "use", selectedScriptIds: [...selectedScriptIds] },
});

const USE_SKILL_TEXT = `Follow this exactly:\n${renderProjectSkillBlock({ ref: SKILL_REF, content: SKILL_CONTENT, mode: "use" })}\nThen run the selected checks.`;

// The adapter fake's `sendTurn` increments `sendTurnEntries` inside the
// effect body only after the supplied admission gate returns true, so the
// counter is proof a prompt actually published — not merely that `sendTurn`
// ran (`progress.providerCalled` semantics deliberately differ).
function makeFakeCodexAdapter(
  provider: ProviderDriverKind,
  runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>,
) {
  const sessions = new Map<ThreadId, ProviderSession>();
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
        createdAt: NOW,
        updatedAt: NOW,
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
      // The lazy admission boundary: the supplied gate runs synchronously
      // inside this publish step — a refused verdict queues no prompt and
      // fails the send with the ordinary not-admitted error.
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
      // The gate verdict and the queued prompt are one synchronous step: the
      // counter increments in this same callback so a parked send cannot
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

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * Recording double behind the real adapter's `createQuery` seam — the
 * AsyncIterable<SDKMessage> surface the adapter's stream fiber reads, plus
 * the setter methods sendTurn calls. The harness pump feeds emitted results
 * back in response to each prompt the adapter publishes.
 */
class RecordingClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly messages: Array<SDKMessage> = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private done = false;
  readonly setModelCalls: Array<string | undefined> = [];
  readonly setPermissionModeCalls: Array<PermissionMode> = [];

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: message });
      return;
    }
    this.messages.push(message);
  }

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };
  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };
  readonly setMaxThinkingTokens = async (): Promise<void> => {};
  readonly close = (): void => {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.messages.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

describe("ProviderCommandReactor skill-trial delivery integration", () => {
  type ReactorCommand = Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0];

  interface ReactorHarnessInput {
    /** Parks inside the delivery claim: `entered` fires once the claim is
        entered, `release` lets it proceed. Arms the claim-window cases where
        durable state must move while the claim itself is held. */
    readonly claimParking?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    /** Overrides the thread's routed model selection — used to route the
        managed send to the claudeAgent-driven fake so the submission's
        driver check passes end to end. */
    readonly modelSelection?: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
    };
    /** Routes `CLAUDE_INSTANCE` to a real `makeClaudeAdapter` adapter with a
        recording SDK double behind its `createQuery` seam, so a managed send
        exercises the production publish path end to end. */
    readonly realClaudeAdapter?: boolean;
  }

  // Builds the real orchestration graph over the shared in-memory SQLite
  // database inside caller-owned scopes (the effect itself requires only the
  // test's `Scope`). `dispose` stops the reactor worker first (draining
  // in-flight turns), then closes the layer graph so SQL is the last resource
  // released, then removes the temp directories.
  const buildReactorHarness = (input?: ReactorHarnessInput) =>
    Effect.gen(function* () {
      // SelectedChecks plans only against an absolute shell path, and a bare
      // CI environment may not export one. The fallback lives for this
      // harness's scope only: the original value (or its absence) is put back
      // when the test's scope closes, even if the build below fails.
      const originalShell = process.env.SHELL;
      if (originalShell === undefined || !originalShell.startsWith("/")) {
        process.env.SHELL = "/bin/sh";
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (originalShell === undefined) {
            delete process.env.SHELL;
          } else {
            process.env.SHELL = originalShell;
          }
        }),
      );
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-skilltrial-"));
      const { stateDir } = yield* deriveServerPathsEffect(baseDir, undefined);
      // The provider stats the workspace directory before entering the
      // adapter, so the project workspace must exist on disk for real.
      const workspaceRoot = NodePath.join(baseDir, "workspace");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const modelSelection = input?.modelSelection ?? {
        instanceId: CODEX_INSTANCE,
        model: "gpt-5-codex",
      };

      // Mutable adapter map: codexA serves instance "codex", codexB serves
      // "codex-b", and a claudeAgent-driven fake stands ready for managed
      // submissions. Registry lookups resolve through this map so the
      // binding/registry re-read inside the real ProviderService runs against
      // real mutable state.
      const codexAEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexBEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const claudeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const codexA = makeFakeCodexAdapter(CODEX_DRIVER, codexAEvents);
      const codexB = makeFakeCodexAdapter(CODEX_DRIVER, codexBEvents);
      const claude = makeFakeCodexAdapter(CLAUDE_DRIVER, claudeEvents);
      const adapters = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>([
        [CODEX_INSTANCE, codexA.adapter],
        [CODEX_B_INSTANCE, codexB.adapter],
        [CLAUDE_INSTANCE, claude.adapter],
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

      // Optional real-Claude mode: the claudeAgent instance resolves to the
      // production `makeClaudeAdapter` adapter with a recording SDK double
      // behind its `createQuery` seam. The pump answers every published user
      // message with a successful result, so the send exercises the real
      // buildUserMessageEffect → publishAdmission → admit → prompt-queue
      // path while the exact SDKUserMessage stays readable afterwards.
      let realClaude:
        | {
            readonly query: RecordingClaudeQuery;
            readonly publishedMessages: Array<SDKUserMessage>;
            readonly createInput: () =>
              | {
                  readonly prompt: AsyncIterable<SDKUserMessage>;
                  readonly options: ClaudeQueryOptions;
                }
              | undefined;
          }
        | undefined;
      if (input?.realClaudeAdapter === true) {
        const sdkQuery = new RecordingClaudeQuery();
        const publishedMessages: Array<SDKUserMessage> = [];
        let createInput:
          | {
              readonly prompt: AsyncIterable<SDKUserMessage>;
              readonly options: ClaudeQueryOptions;
            }
          | undefined;
        const adapter = yield* makeClaudeAdapter(decodeClaudeSettings({}), {
          instanceId: CLAUDE_INSTANCE,
          createQuery: (queryInput) => {
            createInput = queryInput;
            void (async () => {
              try {
                for await (const message of queryInput.prompt) {
                  publishedMessages.push(message);
                  sdkQuery.emit({
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    errors: [],
                    session_id: queryInput.options.sessionId ?? "sdk-managed-session",
                    uuid: `result-${publishedMessages.length}`,
                  } as unknown as SDKMessage);
                }
              } catch {
                // The prompt stream ends when the adapter tears the query down.
              }
            })();
            return sdkQuery;
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), baseDir).pipe(
                Layer.provide(NodeServices.layer),
              ),
              ServerSettingsService.layerTest(),
              NodeServices.layer,
            ),
          ),
        );
        adapters.set(CLAUDE_INSTANCE, adapter);
        realClaude = {
          query: sdkQuery,
          publishedMessages,
          createInput: () => createInput,
        };
      }

      const analytics = makeRecordingAnalytics();

      const settleQueue = yield* Queue.unbounded<void>();
      const settleInputs: Array<Parameters<ProjectSkillTrialDeliveryService["settle"]>[0]> = [];
      const claimParking = input?.claimParking;

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

      // One shared dependency graph. `provideMerge` feeds the layer on its right
      // into everything already piped on its left, so a consumer is always
      // listed before what it reads, and every module-value layer (SQLite, the
      // event store, the mutation fence, the repositories) is built exactly
      // once by the single `buildWithScope` below — no consumer gets a second
      // engine, event store, fence, or database.
      //
      // The managed-skill send gate and the fence sit right of the engine: the
      // engine captures the gate when it is built and builds the fence from the
      // same module layer value.
      const skillGateLayer = Layer.mergeAll(
        projectSkillSendGateLayer,
        ProjectSkillMutationFenceLayer,
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(projectSkillRepositoryLayer, projectSkillTrialRepositoryLayer),
        ),
      );

      // Delivery reads SelectedChecks, ProviderService, the fence, the trial
      // repository and the projections, so it is listed left of all of them. The
      // real service stays private behind the instrumented one: claim may park,
      // and every settle is recorded and announced.
      const instrumentedDeliveryLayer = Layer.effect(
        ProjectSkillTrialDelivery,
        Effect.gen(function* () {
          const real = yield* ProjectSkillTrialDelivery;
          return {
            resolveInput: real.resolveInput,
            useHandoff: real.useHandoff,
            claim: (claimInput) =>
              claimParking === undefined
                ? real.claim(claimInput)
                : Deferred.succeed(claimParking.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(claimParking.release)),
                    Effect.andThen(real.claim(claimInput)),
                  ),
            settle: (settleInput) => {
              settleInputs.push(settleInput);
              return real
                .settle(settleInput)
                .pipe(Effect.tap(() => Queue.offer(settleQueue, undefined)));
            },
          } satisfies ProjectSkillTrialDeliveryService;
        }),
      ).pipe(Layer.provide(projectSkillTrialDeliveryLayer));

      // The real SelectedChecks over the shared engine, projections and
      // settings. Its event store is the engine's own (the same module layer
      // value, so the same SQLite instance). The environment descriptor and the
      // VCS registry are never read by the target-plan path a use claim takes;
      // an unimplemented member dies loudly if that ever changes.
      const selectedChecksStackLayer = selectedChecksLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            OrchestrationEventStoreLive,
            Layer.mock(ServerEnvironment.ServerEnvironment)({}),
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
          ),
        ),
      );

      const serverSettingsLayer = ServerSettingsService.layerTest({
        defaultProjectScripts: [USE_LINT_SCRIPT],
        projectSettingsFolded: true,
      });
      const providerRegistryLayer = makeProviderRegistryLayer([
        { instanceId: modelSelection.instanceId },
      ] as never);
      const providerServiceLayer =
        input?.realClaudeAdapter === true
          ? makeProviderServiceLive().pipe(
              Layer.provide(
                Layer.succeed(ProjectSkillUsePolicy, projectSkillUsePolicyFrom([CLAUDE_DRIVER])),
              ),
            )
          : makeProviderServiceLive();
      const layer = Layer.merge(ProviderCommandReactorLive, ProviderRuntimeIngestionLive)
        .pipe(
          Layer.provideMerge(instrumentedDeliveryLayer),
          Layer.provideMerge(selectedChecksStackLayer),
          Layer.provideMerge(reactorOrchestrationLayer),
          Layer.provideMerge(projectionSnapshotLayer),
          // The real ProviderService: its dependencies resolve from the same
          // ambient merged graph as the reactor, so every routing, binding
          // and handoff fence below is the production path over the shared
          // in-memory SQLite database.
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
          // Skill sends cross the reactor's ordinary L3 hold too; the
          // unavailable gate answers none so only memory references hold.
          Layer.provideMerge(projectMemorySendGateLayerUnavailable),
          Layer.provideMerge(skillGateLayer),
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
      const selectedChecks = yield* live(Effect.service(SelectedChecks));
      const reactor = yield* live(Effect.service(ProviderCommandReactor));
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
          createdAt: NOW,
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
          createdAt: NOW,
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
        selectedChecks,
        // Read fresh at each use: a snapshot taken here would predate every
        // event the test dispatches.
        readModel: live(snapshotQuery.getSnapshot()),
        drain: live(reactor.drain),
        directory,
        sql,
        live,
        codexA,
        codexB,
        claude,
        realClaude,
        adapters,
        analytics,
        settleQueue,
        settleInputs,
        setAfterCommand: (
          hook: ((command: ReactorCommand) => Effect.Effect<void> | undefined) | undefined,
        ) => {
          afterCommandHook = hook;
        },
        dispose: Effect.gen(function* () {
          yield* Scope.close(reactorScope, Exit.void);
          yield* Scope.close(layerScope, Exit.void);
          realClaude?.query.close();
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

  // A live candidate version row: the claim's version check needs this exact
  // ref as the project's live candidate. `source` names the work thread the
  // version was authored in and the event watermark it was created after.
  const seedSkillVersion = (
    harness: Harness,
    source: { readonly threadId: ThreadId; readonly createdAfterEventSequence: number },
  ) =>
    harness.sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${SKILL_ID}, ${asProjectId("project-1")}, 1, ${JSON.stringify(SKILL_CONTENT)},
        ${skillContentSha256},
        ${JSON.stringify({
          type: "work",
          check: {
            threadId: source.threadId,
            threadAnchorSequence: 10,
            receiptSequence: 15,
            attemptId: "attempt-1",
            revision: 1,
            projectId: asProjectId("project-1"),
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
              environmentId: EnvironmentId.make("env-1"),
              platform: "darwin",
              arch: "arm64",
              osRelease: "25.6.0",
              serverVersion: "1.0.0",
              nodeVersion: "22.11.0",
            },
            startedAt: NOW,
            endedAt: NOW,
            outcome: "all-selected-passed",
          },
          draft: { type: "typed" },
        })},
        ${source.threadId}, ${15}, ${5}, ${source.createdAfterEventSequence}, ${NOW}
      )
    `;

  const seedSkillCandidate = (harness: Harness) =>
    seedSkillVersion(harness, { threadId: THREAD_ID, createdAfterEventSequence: 50 });

  const dispatchSkillTurn = (
    harness: Harness,
    dispatchInput: { readonly commandId: string; readonly messageId: string },
  ) =>
    harness.live(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(dispatchInput.commandId),
        threadId: THREAD_ID,
        message: {
          messageId: asMessageId(dispatchInput.messageId),
          role: "user",
          text: SKILL_TEXT,
          attachments: [],
          context: { version: 1 as const, records: [skillRecord()] },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: NOW,
      }),
    );

  const dispatchUseSkillTurn = (
    harness: Harness,
    dispatchInput: { readonly commandId: string; readonly messageId: string },
    selectedScriptIds: ReadonlyArray<string>,
  ) =>
    harness.live(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(dispatchInput.commandId),
        threadId: THREAD_ID,
        message: {
          messageId: asMessageId(dispatchInput.messageId),
          role: "user",
          text: USE_SKILL_TEXT,
          attachments: [],
          context: { version: 1 as const, records: [useSkillRecord(selectedScriptIds)] },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: NOW,
      }),
    );

  // Dispatches a skill-trial turn and parks the send fiber inside the
  // recovery `startSession` (call #2) — strictly after the routed binding
  // was first observed and strictly before the claim. Mutations applied
  // while parked land inside the claim window. Returns the release latch.
  const dispatchParkedSkillTurn = (
    harness: Harness,
    dispatchInput: { readonly commandId: string; readonly messageId: string },
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
      yield* dispatchSkillTurn(harness, dispatchInput);
      yield* Deferred.await(enteredRecoveryStart);
      return releaseRecoveryStart;
    });

  // Dispatches a skill-trial turn and parks the send fiber inside the
  // adapter's publish step — strictly after the claim committed and every
  // routed re-observation ran, strictly before the synchronous `admit` gate
  // runs. Returns the release latch.
  const dispatchSkillTurnParkedAtAdmission = (
    harness: Harness,
    dispatchInput: { readonly commandId: string; readonly messageId: string },
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
      yield* dispatchSkillTurn(harness, dispatchInput);
      yield* Deferred.await(enteredSend);
      return releaseSend;
    });

  const trialRows = (harness: Harness) =>
    harness.sql<{
      readonly messageId: string;
      readonly delivery: string;
      readonly providerDriverKind: string | null;
      readonly attemptToken: string;
      readonly managedSendJson: string | null;
    }>`
      SELECT
        message_id AS "messageId",
        delivery,
        provider_driver_kind AS "providerDriverKind",
        attempt_token AS "attemptToken",
        managed_send_json AS "managedSendJson"
      FROM project_skill_inputs
      ORDER BY rowid ASC
    `;

  // The hold/failure report writes its session restore under the shared
  // turn-start-failure command tag.
  const failureSessionSetRows = (harness: Harness) =>
    harness.sql<{ readonly sequence: number; readonly status: string }>`
      SELECT
        sequence,
        json_extract(payload_json, '$.session.status') AS status
      FROM orchestration_events
      WHERE stream_id = ${THREAD_ID}
        AND event_type = 'thread.session-set'
        AND command_id LIKE ${"server:memory-turn-start-failure:%"}
      ORDER BY sequence ASC
    `;

  const failureActivitiesOf = (
    thread: Effect.Success<Harness["readModel"]>["threads"][number] | undefined,
  ) =>
    (thread?.activities ?? []).filter((activity) => activity.kind === "provider.turn.start.failed");

  const isTurnStartFailureReport = (
    command: ReactorCommand,
    messageId: string,
    detail: string,
  ): boolean =>
    command.type === "thread.turn.start.fail" &&
    command.messageId === asMessageId(messageId) &&
    command.detail === detail;

  // Arms a deferred that fires once the fixed hold report for `messageId`
  // has committed — the durable receipt a parked test waits on after
  // releasing. Must be armed before the release.
  const armHoldReport = (
    harness: Harness,
    input: { readonly messageId: string; readonly detail: string },
  ) =>
    Effect.gen(function* () {
      const reported = yield* Deferred.make<void>();
      harness.setAfterCommand((command) =>
        isTurnStartFailureReport(command, input.messageId, input.detail)
          ? Deferred.succeed(reported, undefined).pipe(Effect.asVoid)
          : undefined,
      );
      return reported;
    });

  // Adapter failures do not take the turn-start-failure command path: the
  // reactor records them through the shared activity append, carrying the
  // message id as the activity's requestId. Same committed receipt, different
  // envelope.
  const armFailureActivityReport = (
    harness: Harness,
    input: { readonly messageId: string; readonly detail: string },
  ) =>
    Effect.gen(function* () {
      const reported = yield* Deferred.make<void>();
      harness.setAfterCommand((command) => {
        if (command.type !== "thread.activity.append") return undefined;
        const payload = command.activity.payload as
          | { readonly requestId?: string; readonly detail?: string }
          | undefined;
        return command.activity.kind === "provider.turn.start.failed" &&
          payload?.requestId === input.messageId &&
          payload?.detail === input.detail
          ? Deferred.succeed(reported, undefined).pipe(Effect.asVoid)
          : undefined;
      });
      return reported;
    });

  // Shared assertions for a refused send: the adapter never published, the
  // fixed report restored the session this ensure left "starting" back to
  // ready, and no durable row was accepted.
  const expectHoldReported = (harness: Harness, input: { readonly detail: string }) =>
    Effect.gen(function* () {
      const thread = (yield* harness.readModel).threads.find((entry) => entry.id === THREAD_ID);
      const failures = failureActivitiesOf(thread);
      expect(failures.length).toBe(1);
      expect(failures[0]!.summary).toBe("Message not sent");
      expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(input.detail);
      const restoreRows = yield* failureSessionSetRows(harness);
      expect(restoreRows.length).toBe(1);
      expect(restoreRows[0]!.status).toBe("ready");
    });

  // A managed send claims once, publishes through the actual routed adapter
  // exactly once, and settles provider-accepted against the captured token
  // and routed driver.
  effectIt.live(
    "delivers a managed trial through one adapter entry and settles provider-accepted on the routed driver",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            yield* dispatchSkillTurn(harness, { commandId: "cmd-ok", messageId: "m-ok" });
            // Durable receipt: the committed claim settled after the adapter ran.
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(1);
            expect(harness.codexB.sendTurnEntries).toBe(0);
            // The handoff gate reached the adapter as a synchronous publish
            // callback — the actual chain, not a provider stub.
            expect(typeof harness.codexA.sendTurn.mock.calls[0]?.[1]?.admit).toBe("function");
            // The published input carries the managed block verbatim.
            expect(harness.codexA.sendTurn.mock.calls[0]?.[0]?.input).toContain(
              "<oop-project-skill",
            );
            const rows = yield* trialRows(harness);
            expect(rows.length).toBe(1);
            expect(rows[0]!.messageId).toBe("m-ok");
            expect(rows[0]!.delivery).toBe("provider-accepted");
            expect(rows[0]!.providerDriverKind).toBe("codex");
            expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(1);
            expect(harness.analytics.eventsByName("provider.turn.rejected").length).toBe(0);
          }),
        );
      }),
  );

  // The route window opens inside the parked recovery startSession; a
  // candidate version that disappears there makes the claim hold — fixed
  // detail, no adapter entry, no durable row.
  effectIt.live(
    "holds with the fixed copy when the managed version is deleted while the route is parked",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            const release = yield* dispatchParkedSkillTurn(harness, {
              commandId: "cmd-del",
              messageId: "m-del",
            });
            const reported = yield* armHoldReport(harness, {
              messageId: "m-del",
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
            yield* harness.sql`DELETE FROM project_skill_versions WHERE skill_id = ${SKILL_ID}`;
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(reported);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(0);
            expect(harness.codexA.startSession).toHaveBeenCalledTimes(2);
            expect(yield* trialRows(harness)).toEqual([]);
            yield* expectHoldReported(harness, {
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
            const rejected = harness.analytics.eventsByName("provider.turn.rejected");
            expect(rejected.length).toBe(1);
            expect(rejected[0]!.properties?.["errorType"]).toBe(
              "ProviderSkillTrialHandoffRefusedError",
            );
          }),
        );
      }),
  );

  // A binding moved to another instance while the recovery is parked refuses
  // the pinned-route binding write — the claim never runs.
  effectIt.live(
    "refuses adapter entry when the binding moves instances while the route is parked",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            const release = yield* dispatchParkedSkillTurn(harness, {
              commandId: "cmd-reroute",
              messageId: "m-reroute",
            });
            const reported = yield* armHoldReport(harness, {
              messageId: "m-reroute",
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
            const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
            yield* harness.directory.upsert({
              ...binding,
              providerInstanceId: CODEX_B_INSTANCE,
            });
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(reported);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(0);
            expect(harness.codexB.sendTurnEntries).toBe(0);
            // The pinned-route write refused before any claim: no durable row.
            expect(yield* trialRows(harness)).toEqual([]);
            yield* expectHoldReported(harness, {
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
          }),
        );
      }),
  );

  // Claim held open while the route ownership moves: the committed claim
  // still refuses at the post-claim re-observation and stays unknown.
  effectIt.live(
    "refuses after a claim held open across a route move, leaving the attempt unknown",
    () =>
      Effect.gen(function* () {
        const claimEntered = yield* Deferred.make<void>();
        const claimRelease = yield* Deferred.make<void>();
        yield* withReactorHarness(
          { claimParking: { entered: claimEntered, release: claimRelease } },
          (harness) =>
            Effect.gen(function* () {
              yield* seedSkillCandidate(harness);
              const reported = yield* armHoldReport(harness, {
                messageId: "m-claim",
                detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
              });
              yield* dispatchSkillTurn(harness, {
                commandId: "cmd-claim",
                messageId: "m-claim",
              });
              yield* Deferred.await(claimEntered);
              const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
              yield* harness.directory.upsert({
                ...binding,
                providerInstanceId: CODEX_B_INSTANCE,
              });
              yield* Deferred.succeed(claimRelease, undefined);
              yield* Deferred.await(reported);
              yield* harness.drain;
              expect(harness.codexA.sendTurnEntries).toBe(0);
              expect(harness.codexB.sendTurnEntries).toBe(0);
              const rows = yield* trialRows(harness);
              expect(rows.length).toBe(1);
              expect(rows[0]!.delivery).toBe("unknown");
              yield* expectHoldReported(harness, {
                detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
              });
            }),
        );
      }),
  );

  // An admitted send interrupted by Stop after the claim committed reports
  // as interrupted — never swallowed into a hold — and the durable attempt
  // stays unknown.
  effectIt.live("leaves the committed attempt unknown when Stop interrupts after the claim", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(undefined, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          yield* dispatchSkillTurnParkedAtAdmission(harness, {
            commandId: "cmd-stop",
            messageId: "m-stop",
          });
          const stopped = yield* Deferred.make<void>();
          harness.setAfterCommand((command) =>
            command.type === "thread.session.set" && command.session.status === "stopped"
              ? Deferred.succeed(stopped, undefined).pipe(Effect.asVoid)
              : undefined,
          );
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-session-stop"),
            threadId: THREAD_ID,
            createdAt: NOW,
          });
          yield* Deferred.await(stopped);
          yield* harness.drain;
          // The parked send was interrupted before the publish step ran.
          expect(harness.codexA.sendTurnEntries).toBe(0);
          expect(harness.codexA.stopSession).toHaveBeenCalledTimes(1);
          // An interrupted send never reaches the settlement.
          expect(harness.settleInputs.length).toBe(0);
          const rows = yield* trialRows(harness);
          expect(rows.length).toBe(1);
          expect(rows[0]!.delivery).toBe("unknown");
          const thread = (yield* harness.readModel).threads.find((entry) => entry.id === THREAD_ID);
          const failures = failureActivitiesOf(thread);
          expect(
            failures.some(
              (activity) =>
                activity.summary === "Message interrupted" &&
                (activity.payload as { readonly detail?: string }).detail ===
                  "Stopped while sending. The provider may have received this message.",
            ),
          ).toBe(true);
        }),
      );
    }),
  );

  // An adapter failure after the claim leaves the attempt unknown and
  // reports the ordinary fixed send failure — not a hold, not an acceptance.
  effectIt.live("leaves the attempt unknown and reports the send failure on adapter failure", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(undefined, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          harness.codexA.sendTurn.mockImplementationOnce((sendInput) =>
            Effect.fail(
              new ProviderAdapterProcessError({
                provider: CODEX_DRIVER,
                threadId: sendInput.threadId,
                detail: "adapter exploded mid-send",
              }),
            ),
          );
          const reported = yield* armFailureActivityReport(harness, {
            messageId: "m-fail",
            detail: "adapter exploded mid-send",
          });
          yield* dispatchSkillTurn(harness, {
            commandId: "cmd-fail",
            messageId: "m-fail",
          });
          yield* Deferred.await(reported);
          yield* harness.drain;
          expect(harness.codexA.sendTurnEntries).toBe(0);
          // A send that never returned settles nothing.
          expect(harness.settleInputs.length).toBe(0);
          const rows = yield* trialRows(harness);
          expect(rows.length).toBe(1);
          expect(rows[0]!.delivery).toBe("unknown");
          const thread = (yield* harness.readModel).threads.find((entry) => entry.id === THREAD_ID);
          const failures = failureActivitiesOf(thread);
          expect(failures.length).toBe(1);
          expect(failures[0]!.summary).toBe("Provider turn start failed");
          expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(
            "adapter exploded mid-send",
          );
        }),
      );
    }),
  );

  // A same-id redispatch never reaches Delivery.claim: the engine's managed
  // hook refuses it inside the commit transaction — the stored managed input
  // cannot substitute-authorize a new turn — with the fixed unsupported
  // detail. Entry count and the accepted row stand.
  effectIt.live(
    "refuses a same-message managed redispatch at the engine with no additional adapter entry",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-dupe",
              messageId: "m-dupe",
            });
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(1);
            const redispatchError = yield* dispatchSkillTurn(harness, {
              commandId: "cmd-dupe-2",
              messageId: "m-dupe",
            }).pipe(Effect.flip);
            expect(redispatchError).toMatchObject({
              _tag: "OrchestrationCommandInvariantError",
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unsupported,
            });
            yield* harness.drain;
            expect(harness.codexA.sendTurnEntries).toBe(1);
            const rows = yield* trialRows(harness);
            expect(rows.length).toBe(1);
            expect(rows[0]!.delivery).toBe("provider-accepted");
          }),
        );
      }),
  );

  // Two real concurrent sends race one session route on the same thread. The
  // parked loser's directory fence was captured before its claim; the
  // winner's post-claim binding write advances that fence, so on release the
  // loser's admission check fails — a real post-claim refusal reported with
  // the fixed unavailable detail. The loser's committed attempt stays
  // unknown; only the winner's settles, publishes, and accepts.
  effectIt.live(
    "refuses the losing concurrent managed send at the stale route fence and keeps its claim unknown",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            const release = yield* dispatchSkillTurnParkedAtAdmission(harness, {
              commandId: "cmd-c1",
              messageId: "m-c1",
            });
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-c2",
              messageId: "m-c2",
            });
            // The only settle observed is m-c2's — m-c1 is still parked and
            // must never produce one.
            yield* Queue.take(harness.settleQueue);
            const reported = yield* armHoldReport(harness, {
              messageId: "m-c1",
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(reported);
            yield* harness.drain;
            // The loser's refusal still reports the fixed hold — but the
            // successor binding guard correctly keeps the winner's
            // session-set, so the loser's stale restore writes nothing.
            const thread = (yield* harness.readModel).threads.find(
              (entry) => entry.id === THREAD_ID,
            );
            const failures = failureActivitiesOf(thread);
            expect(failures.length).toBe(1);
            expect(failures[0]!.summary).toBe("Message not sent");
            expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(
              PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            );
            expect((yield* failureSessionSetRows(harness)).length).toBe(0);
            const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
            expect(binding.providerInstanceId).toBe(CODEX_INSTANCE);
            expect(binding.status).toBe("running");
            expect(harness.codexA.sendTurnEntries).toBe(1);
            const rows = yield* trialRows(harness);
            expect(rows.length).toBe(2);
            expect(rows[0]!.messageId).toBe("m-c1");
            expect(rows[0]!.delivery).toBe("unknown");
            expect(rows[0]!.providerDriverKind).toBeNull();
            expect(rows[1]!.messageId).toBe("m-c2");
            expect(rows[1]!.delivery).toBe("provider-accepted");
            expect(rows[1]!.providerDriverKind).toBe("codex");
            expect(new Set(rows.map((row) => row.attemptToken)).size).toBe(2);
          }),
        );
      }),
  );

  // A committed claim followed by a route move refuses at the publish-time
  // guard — the durable attempt stays unknown and nothing is accepted.
  effectIt.live("refuses at the publish point after a committed claim when the route moves", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(undefined, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          const release = yield* dispatchSkillTurnParkedAtAdmission(harness, {
            commandId: "cmd-move",
            messageId: "m-move",
          });
          const reported = yield* armHoldReport(harness, {
            messageId: "m-move",
            detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
          });
          const binding = Option.getOrThrow(yield* harness.directory.getBinding(THREAD_ID));
          yield* harness.directory.upsert({
            ...binding,
            providerInstanceId: CODEX_B_INSTANCE,
          });
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(reported);
          yield* harness.drain;
          expect(harness.codexA.sendTurnEntries).toBe(0);
          expect(harness.codexB.sendTurnEntries).toBe(0);
          // A refused send settles nothing — no accepted delivery and no
          // captured submission.
          expect(harness.settleInputs.length).toBe(0);
          const rows = yield* trialRows(harness);
          expect(rows.length).toBe(1);
          expect(rows[0]!.delivery).toBe("unknown");
          yield* expectHoldReported(harness, {
            detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
          });
          const rejected = harness.analytics.eventsByName("provider.turn.rejected");
          expect(rejected.length).toBe(1);
          expect(rejected[0]!.properties?.["errorType"]).toBe(
            "ProviderSkillTrialHandoffRefusedError",
          );
        }),
      );
    }),
  );

  // A settlement that finds no row cannot manufacture acceptance: the send
  // itself published, but the durable side records nothing.
  effectIt.live("records no acceptance when the settlement row disappears before settle", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(undefined, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          const release = yield* dispatchSkillTurnParkedAtAdmission(harness, {
            commandId: "cmd-settle",
            messageId: "m-settle",
          });
          // The committed claim row is gone before the settle runs.
          yield* harness.sql`DELETE FROM project_skill_inputs WHERE message_id = ${"m-settle"}`;
          yield* Deferred.succeed(release, undefined);
          yield* Queue.take(harness.settleQueue);
          yield* harness.drain;
          expect(harness.codexA.sendTurnEntries).toBe(1);
          expect(harness.analytics.eventsByName("provider.turn.sent").length).toBe(1);
          expect(yield* trialRows(harness)).toEqual([]);
        }),
      );
    }),
  );

  // C2 managed capture: the claim-owned observer joins the adapter's real
  // publish-step observation to the settlement — the actual enter route is
  // always reported, the frozen observation only when the publish step
  // produced one the whole send could agree on.
  const EXPECTED_BLOCK = renderProjectSkillBlock({
    ref: SKILL_REF,
    content: SKILL_CONTENT,
    mode: "trial",
  });
  const EXPECTED_BLOCK_SHA256 = NodeCrypto.createHash("sha256")
    .update(EXPECTED_BLOCK, "utf8")
    .digest("hex");
  const ROUTE_SHA256 = "d".repeat(64);
  const CLAUDE_MODEL_SELECTION = { instanceId: CLAUDE_INSTANCE, model: "claude-test" };
  const EXPECTED_USE_BLOCK = renderProjectSkillBlock({
    ref: SKILL_REF,
    content: SKILL_CONTENT,
    mode: "use",
  });
  const EXPECTED_USE_BLOCK_SHA256 = NodeCrypto.createHash("sha256")
    .update(EXPECTED_USE_BLOCK, "utf8")
    .digest("hex");

  // Reproduction evidence for a use claim, built the way the lifecycle builds
  // it. A real managed trial send in this thread — through the real Claude
  // adapter — settles the managed-send label with the adapter's actual route
  // digest and native session. The observed check, the four judgments, and the
  // activation are then recorded as direct rows (controlled inputs: no
  // selected-check run happens in this harness). The observed check is derived
  // from the server-current target plan, so the environment a use claim later
  // compares is the one the evidence ran on. The version's work source lives in
  // another thread, as a reproduction requires. Needs `realClaudeAdapter`.
  const seedActiveUseSkill = (harness: Harness) =>
    Effect.gen(function* () {
      const projectId = asProjectId("project-1");
      yield* seedSkillVersion(harness, {
        threadId: USE_SOURCE_THREAD_ID,
        createdAfterEventSequence: 1,
      });
      yield* dispatchSkillTurn(harness, {
        commandId: "cmd-use-evidence",
        messageId: USE_EVIDENCE_MESSAGE_ID,
      });
      yield* Queue.take(harness.settleQueue);
      yield* harness.drain;
      const evidenceRows = yield* harness.sql<{
        readonly inputEventSequence: number;
        readonly delivery: string;
        readonly managedSendJson: string | null;
      }>`
        SELECT
          input_event_sequence AS "inputEventSequence",
          delivery,
          managed_send_json AS "managedSendJson"
        FROM project_skill_inputs
        WHERE thread_id = ${THREAD_ID} AND message_id = ${USE_EVIDENCE_MESSAGE_ID}
      `;
      expect(evidenceRows.length).toBe(1);
      expect(evidenceRows[0]!.delivery).toBe("provider-accepted");
      expect(typeof evidenceRows[0]!.managedSendJson).toBe("string");
      const evidenceSequence = evidenceRows[0]!.inputEventSequence;
      const plan = yield* harness.selectedChecks.resolveTargetPlan({
        threadId: THREAD_ID,
        scriptIds: USE_SELECTED_SCRIPT_IDS,
      });
      // A trial window closes at the thread's next input; closing it directly
      // is the one transition `project_skill_inputs` permits for an open row.
      yield* harness.sql`
        UPDATE project_skill_inputs
        SET window = 'closed', window_closed_at = ${NOW}
        WHERE thread_id = ${THREAD_ID} AND message_id = ${USE_EVIDENCE_MESSAGE_ID}
      `;
      const checkJson = JSON.stringify({
        threadId: THREAD_ID,
        threadAnchorSequence: evidenceSequence,
        receiptSequence: evidenceSequence + 1,
        attemptId: "attempt-use-evidence",
        revision: 1,
        projectId,
        workspaceRoot: plan.workspaceRoot,
        worktreePath: plan.worktreePath,
        cwd: plan.cwd,
        envSha256: plan.envSha256,
        planned: plan.planned.map((entry) => ({
          scriptId: entry.scriptId,
          scriptName: USE_LINT_SCRIPT.name,
          commandSha256: entry.commandSha256,
          timeoutMs: 60_000,
        })),
        tree: {
          treeOid: "c".repeat(40),
          repoTopLevel: plan.workspaceRoot,
          repoCommonDir: plan.workspaceRoot,
        },
        environment: {
          environmentId: EnvironmentId.make("env-1"),
          platform: plan.platform,
          arch: plan.arch,
          osRelease: "25.6.0",
          serverVersion: "1.0.0",
          nodeVersion: "22.11.0",
        },
        startedAt: NOW,
        endedAt: NOW,
        outcome: "all-selected-passed",
      });
      yield* harness.sql`
        INSERT INTO project_skill_observed_uses (
          evidence_id, thread_id, message_id, attempt_id, project_id, skill_id,
          version, content_sha256, check_json, receipt_sequence, outcome, ended_at,
          recorded_at
        )
        VALUES (
          ${USE_EVIDENCE_ID}, ${THREAD_ID}, ${USE_EVIDENCE_MESSAGE_ID},
          'attempt-use-evidence', ${projectId}, ${SKILL_ID}, 1, ${skillContentSha256},
          ${checkJson}, ${evidenceSequence + 1}, 'all-selected-passed', ${NOW}, ${NOW}
        )
      `;
      const judgments = [
        {
          judgmentId: ProjectSkillJudgmentId.make("psj-harness-rights"),
          kind: "rights",
          judgmentJson: JSON.stringify({
            judgmentId: ProjectSkillJudgmentId.make("psj-harness-rights"),
            ref: SKILL_REF,
            kind: "rights",
            basis: "own-work",
            originalSource: null,
            license: null,
            recordedAt: NOW,
            recordedBy: "authenticated-client",
            note: "ok",
          }),
        },
        {
          judgmentId: ProjectSkillJudgmentId.make("psj-harness-review"),
          kind: "review",
          judgmentJson: JSON.stringify({
            judgmentId: ProjectSkillJudgmentId.make("psj-harness-review"),
            ref: SKILL_REF,
            kind: "review",
            provenanceChecked: true,
            privacyChecked: true,
            scopeChecked: true,
            recordedAt: NOW,
            recordedBy: "authenticated-client",
            note: "ok",
          }),
        },
        {
          judgmentId: ProjectSkillJudgmentId.make("psj-harness-repro"),
          kind: "reproduction",
          judgmentJson: JSON.stringify({
            judgmentId: ProjectSkillJudgmentId.make("psj-harness-repro"),
            ref: SKILL_REF,
            kind: "reproduction",
            observedEvidenceId: USE_EVIDENCE_ID,
            procedureApplied: true,
            successConditionConfirmed: true,
            taskNotUsedForAuthoring: true,
            recordedAt: NOW,
            recordedBy: "authenticated-client",
            note: "ok",
          }),
        },
        {
          judgmentId: ProjectSkillJudgmentId.make("psj-harness-nonapp"),
          kind: "non-application",
          judgmentJson: JSON.stringify({
            judgmentId: ProjectSkillJudgmentId.make("psj-harness-nonapp"),
            ref: SKILL_REF,
            kind: "non-application",
            observedEvidenceId: USE_EVIDENCE_ID,
            taskDescription: "unrelated",
            verdict: "correctly-not-applied",
            recordedAt: NOW,
            recordedBy: "authenticated-client",
            note: "ok",
          }),
        },
      ];
      for (const judgment of judgments) {
        yield* harness.sql`
          INSERT INTO project_skill_judgments (
            judgment_id, project_id, skill_id, version, content_sha256, kind,
            judgment_json, recorded_after_event_sequence, withdrawn_at
          )
          VALUES (
            ${judgment.judgmentId}, ${projectId}, ${SKILL_ID}, 1, ${skillContentSha256},
            ${judgment.kind}, ${judgment.judgmentJson}, 62, NULL
          )
        `;
      }
      yield* harness.sql`
        UPDATE project_skill_versions
        SET state = 'active', retired_reason = NULL
        WHERE project_id = ${projectId} AND skill_id = ${SKILL_ID} AND version = 1
      `;
    });

  // The durable managed-send label a settled row carries (digests and
  // identities only).
  interface ManagedSendLabel {
    readonly scope: string;
    readonly deliveredBlockSha256: string;
    readonly providerInstanceId: string;
    readonly providerSessionId: string;
    readonly routeConfigSha256: string;
  }

  // The text blocks of one SDK user message the real adapter queued.
  const queuedTextBlocksOf = (message: SDKUserMessage): ReadonlyArray<string> => {
    const content = message.message.content;
    return (Array.isArray(content) ? content : []).flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    );
  };

  // Runs the supplied admission gate once per listed observation, exactly as
  // a real adapter's publish step does — a refused verdict fails the send
  // with the ordinary not-admitted error, a passing one queues the prompt.
  const publishThroughObservations = (
    sendInput: ProviderSendTurnInput,
    admission: ProviderSendTurnAdmission | undefined,
    observations: ReadonlyArray<ProviderAdmissionObservation>,
    driver: ProviderDriverKind,
  ) =>
    Effect.suspend(() => {
      for (const observed of observations) {
        if (admission !== undefined && !admission.admit(observed)) {
          return Effect.fail(
            new ProviderAdapterSessionClosedError({
              provider: driver,
              threadId: sendInput.threadId,
            }),
          );
        }
      }
      return Effect.succeed({
        threadId: sendInput.threadId,
        turnId: asTurnId(`turn-${String(sendInput.threadId)}`),
      });
    });

  effectIt.live("joins the real adapter publication to the settled managed evidence", () =>
    Effect.gen(function* () {
      yield* withReactorHarness({ modelSelection: CLAUDE_MODEL_SELECTION }, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          harness.claude.sendTurn.mockImplementationOnce((sendInput, admission) =>
            publishThroughObservations(
              sendInput,
              admission,
              [
                {
                  sessionGeneration: 3,
                  nativeSessionId: "claude-native-1",
                  submissionCandidate: {
                    textBlocks: [typeof sendInput.input === "string" ? sendInput.input : ""],
                    routeConfigSha256: ROUTE_SHA256,
                  },
                },
              ],
              CLAUDE_DRIVER,
            ),
          );
          yield* dispatchSkillTurn(harness, {
            commandId: "cmd-managed",
            messageId: "m-managed",
          });
          yield* Queue.take(harness.settleQueue);
          yield* harness.drain;

          expect(harness.settleInputs.length).toBe(1);
          const settle = harness.settleInputs[0]!;
          // The captured enter route — never a request-side or observed guess.
          expect(settle.providerInstanceId).toBe(CLAUDE_INSTANCE);
          const submission = settle.submission;
          expect(submission?.providerInstanceId).toBe(CLAUDE_INSTANCE);
          expect(submission?.driverKind).toBe(CLAUDE_DRIVER);
          expect(submission?.sessionGeneration).toBe(3);
          expect(submission?.nativeSessionId).toBe("claude-native-1");
          expect(submission?.submissionCandidate?.routeConfigSha256).toBe(ROUTE_SHA256);
          expect(submission?.submissionCandidate?.textBlocks.length).toBe(1);
          expect(submission?.submissionCandidate?.textBlocks[0]).toContain(EXPECTED_BLOCK);

          const rows = yield* trialRows(harness);
          expect(rows.length).toBe(1);
          expect(rows[0]!.delivery).toBe("provider-accepted");
          const managedSendJson = rows[0]!.managedSendJson;
          expect(typeof managedSendJson).toBe("string");
          const evidence = JSON.parse(managedSendJson!) as {
            readonly scope: string;
            readonly deliveredRef: {
              readonly projectId: string;
              readonly skillId: string;
              readonly version: number;
              readonly contentSha256: string;
            };
            readonly deliveredBlockSha256: string;
            readonly providerInstanceId: string;
            readonly providerSessionId: string;
            readonly routeConfigSha256: string;
          };
          expect(evidence.scope).toBe("managed-procedure/v1");
          expect(evidence.deliveredRef).toEqual({
            projectId: SKILL_REF.projectId,
            skillId: SKILL_REF.skillId,
            version: SKILL_REF.version,
            contentSha256: SKILL_REF.contentSha256,
          });
          expect(evidence.deliveredBlockSha256).toBe(EXPECTED_BLOCK_SHA256);
          expect(evidence.providerInstanceId).toBe(CLAUDE_INSTANCE);
          expect(evidence.providerSessionId).toBe("claude-native-1");
          expect(evidence.routeConfigSha256).toBe(ROUTE_SHA256);
          // The durable label is digests and identities only — the
          // submitted block text is never persisted.
          expect(managedSendJson!.includes(EXPECTED_BLOCK)).toBe(false);
        }),
      );
    }),
  );

  effectIt.live(
    "settles provider-accepted with the enter route and no candidate when the adapter reports none",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-plain",
              messageId: "m-plain",
            });
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;

            expect(harness.settleInputs.length).toBe(1);
            const settle = harness.settleInputs[0]!;
            expect(settle.providerInstanceId).toBe(CODEX_INSTANCE);
            // The publish observation was still delivered — the send simply
            // carried nothing the managed label could prove.
            expect(settle.submission?.providerInstanceId).toBe(CODEX_INSTANCE);
            expect(settle.submission?.driverKind).toBe(CODEX_DRIVER);
            expect(settle.submission?.submissionCandidate).toBeUndefined();
            const rows = yield* trialRows(harness);
            expect(rows[0]!.delivery).toBe("provider-accepted");
            expect(rows[0]!.managedSendJson).toBeNull();
          }),
        );
      }),
  );

  effectIt.live(
    "settles nothing for a publication the send never completed, even after the observation",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            harness.codexA.sendTurn.mockImplementationOnce((sendInput, admission) =>
              Effect.suspend(() => {
                // The gate passed and the observation was captured — then
                // the send itself failed before returning, so nothing may
                // settle.
                admission?.admit({
                  sessionGeneration: 3,
                  nativeSessionId: "native-1",
                  submissionCandidate: {
                    textBlocks: ["observed but never sent"],
                    routeConfigSha256: ROUTE_SHA256,
                  },
                });
                return Effect.fail(
                  new ProviderAdapterProcessError({
                    provider: CODEX_DRIVER,
                    threadId: sendInput.threadId,
                    detail: "adapter exploded post-admission",
                  }),
                );
              }),
            );
            const reported = yield* armFailureActivityReport(harness, {
              messageId: "m-postfail",
              detail: "adapter exploded post-admission",
            });
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-postfail",
              messageId: "m-postfail",
            });
            yield* Deferred.await(reported);
            yield* harness.drain;
            expect(harness.settleInputs.length).toBe(0);
            const rows = yield* trialRows(harness);
            expect(rows.length).toBe(1);
            expect(rows[0]!.delivery).toBe("unknown");
            expect(rows[0]!.managedSendJson).toBeNull();
          }),
        );
      }),
  );

  effectIt.live(
    "settles the accepted send without a submission when a second observation disagrees",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(undefined, (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            harness.codexA.sendTurn.mockImplementationOnce((sendInput, admission) =>
              publishThroughObservations(
                sendInput,
                admission,
                [
                  {
                    sessionGeneration: 3,
                    nativeSessionId: "native-1",
                    submissionCandidate: {
                      textBlocks: ["first publication attempt"],
                      routeConfigSha256: ROUTE_SHA256,
                    },
                  },
                  {
                    sessionGeneration: 3,
                    nativeSessionId: "native-1",
                    submissionCandidate: {
                      textBlocks: ["a different second attempt"],
                      routeConfigSha256: ROUTE_SHA256,
                    },
                  },
                ],
                CODEX_DRIVER,
              ),
            );
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-divergent",
              messageId: "m-divergent",
            });
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;
            // Two disagreeing publish observations can name neither — the
            // capture is dropped while the accepted delivery settles plainly.
            expect(harness.settleInputs.length).toBe(1);
            const settle = harness.settleInputs[0]!;
            expect(settle.providerInstanceId).toBe(CODEX_INSTANCE);
            expect(settle.submission).toBeUndefined();
            const rows = yield* trialRows(harness);
            expect(rows[0]!.delivery).toBe("provider-accepted");
            expect(rows[0]!.managedSendJson).toBeNull();
          }),
        );
      }),
  );

  effectIt.live("drops an earlier valid capture when a later observation cannot even be read", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(undefined, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          harness.codexA.sendTurn.mockImplementationOnce((sendInput, admission) =>
            publishThroughObservations(
              sendInput,
              admission,
              [
                {
                  sessionGeneration: 3,
                  nativeSessionId: "native-1",
                  submissionCandidate: {
                    textBlocks: ["a valid earlier capture"],
                    routeConfigSha256: ROUTE_SHA256,
                  },
                },
                {
                  sessionGeneration: 3,
                  nativeSessionId: "native-1",
                  submissionCandidate: {
                    get textBlocks(): readonly string[] {
                      throw new Error("adapter-side candidate defect");
                    },
                    routeConfigSha256: ROUTE_SHA256,
                  },
                },
              ],
              CODEX_DRIVER,
            ),
          );
          yield* dispatchSkillTurn(harness, {
            commandId: "cmd-unreadable",
            messageId: "m-unreadable",
          });
          yield* Queue.take(harness.settleQueue);
          yield* harness.drain;
          // The defect inside the second observation never kept the first:
          // accepted, and permanently unlabelled.
          expect(harness.settleInputs.length).toBe(1);
          const settle = harness.settleInputs[0]!;
          expect(settle.providerInstanceId).toBe(CODEX_INSTANCE);
          expect(settle.submission).toBeUndefined();
          const rows = yield* trialRows(harness);
          expect(rows[0]!.delivery).toBe("provider-accepted");
          expect(rows[0]!.managedSendJson).toBeNull();
        }),
      );
    }),
  );

  effectIt.live("drops a prior valid capture when a later observation cannot even be spread", () =>
    Effect.gen(function* () {
      yield* withReactorHarness({ modelSelection: CLAUDE_MODEL_SELECTION }, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          harness.claude.sendTurn.mockImplementationOnce((sendInput, admission) =>
            publishThroughObservations(
              sendInput,
              admission,
              [
                {
                  sessionGeneration: 3,
                  nativeSessionId: "claude-native-1",
                  submissionCandidate: {
                    textBlocks: [typeof sendInput.input === "string" ? sendInput.input : ""],
                    routeConfigSha256: ROUTE_SHA256,
                  },
                },
                {
                  // The service spreads the adapter's observation into the
                  // observer payload; an enumerable getter that throws
                  // inside that construction must still invalidate the
                  // earlier capture, never leave it to settle stale.
                  get sessionGeneration(): number {
                    throw new Error("adapter-side observation defect");
                  },
                  nativeSessionId: "claude-native-1",
                },
              ],
              CLAUDE_DRIVER,
            ),
          );
          yield* dispatchSkillTurn(harness, {
            commandId: "cmd-unspreadable",
            messageId: "m-unspreadable",
          });
          yield* Queue.take(harness.settleQueue);
          yield* harness.drain;
          // The send published and settled ordinarily — the earlier
          // capture was invalidated instead of fabricating managed
          // evidence for a publish that went unread.
          expect(harness.settleInputs.length).toBe(1);
          const settle = harness.settleInputs[0]!;
          expect(settle.providerInstanceId).toBe(CLAUDE_INSTANCE);
          expect(settle.submission).toBeUndefined();
          const rows = yield* trialRows(harness);
          expect(rows[0]!.delivery).toBe("provider-accepted");
          expect(rows[0]!.managedSendJson).toBeNull();
        }),
      );
    }),
  );

  // The real `makeClaudeAdapter` adapter drives this send: it builds the
  // SDKUserMessage itself, computes the route profile digest, and publishes
  // through the real ProviderService → Reactor → delivery chain. The fake
  // SDK records the exact user message the adapter queued so the durable
  // evidence can be traced back to those bytes — nothing about the
  // observation or the settle is constructed by hand.
  effectIt.live("settles the managed evidence the real Claude adapter actually published", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(
        { modelSelection: CLAUDE_MODEL_SELECTION, realClaudeAdapter: true },
        (harness) =>
          Effect.gen(function* () {
            yield* seedSkillCandidate(harness);
            yield* dispatchSkillTurn(harness, {
              commandId: "cmd-real-claude-managed",
              messageId: "m-real-claude-managed",
            });
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;

            const realClaude = harness.realClaude;
            expect(realClaude).toBeDefined();
            const createInput = realClaude!.createInput();
            expect(createInput).toBeDefined();
            // The real adapter resolved the thread's model selection into
            // the query options and allocated the native session id the
            // candidate's observation later reports.
            expect(createInput!.options.model).toBe("claude-test");
            const nativeSessionId = createInput!.options.sessionId;
            expect(typeof nativeSessionId).toBe("string");

            // Exactly one user message reached the SDK prompt stream, and
            // its text block carries the canonical managed skill block.
            expect(realClaude!.publishedMessages.length).toBe(1);
            const published = realClaude!.publishedMessages[0]!;
            const content = published.message.content;
            expect(Array.isArray(content)).toBe(true);
            const publishedTextBlocks = (Array.isArray(content) ? content : []).flatMap((block) =>
              block.type === "text" && typeof block.text === "string" ? [block.text] : [],
            );
            expect(publishedTextBlocks.length).toBe(1);
            expect(publishedTextBlocks[0]).toContain(EXPECTED_BLOCK);

            expect(harness.settleInputs.length).toBe(1);
            const settle = harness.settleInputs[0]!;
            expect(settle.providerInstanceId).toBe(CLAUDE_INSTANCE);
            const submission = settle.submission;
            expect(submission?.providerInstanceId).toBe(CLAUDE_INSTANCE);
            expect(submission?.driverKind).toBe(CLAUDE_DRIVER);
            // The captured identity is the adapter's own: the same native
            // session id it handed the SDK, and a real publish generation.
            expect(submission?.nativeSessionId).toBe(nativeSessionId);
            expect(submission?.sessionGeneration).toBe(1);
            // The observed text blocks are the published SDK blocks.
            expect(submission?.submissionCandidate?.textBlocks).toEqual(publishedTextBlocks);
            const routeSha = submission?.submissionCandidate?.routeConfigSha256;
            expect(routeSha).toMatch(/^[0-9a-f]{64}$/);

            const rows = yield* trialRows(harness);
            expect(rows.length).toBe(1);
            expect(rows[0]!.delivery).toBe("provider-accepted");
            const managedSendJson = rows[0]!.managedSendJson;
            expect(typeof managedSendJson).toBe("string");
            const evidence = JSON.parse(managedSendJson!) as {
              readonly scope: string;
              readonly deliveredRef: {
                readonly projectId: string;
                readonly skillId: string;
                readonly version: number;
                readonly contentSha256: string;
              };
              readonly deliveredBlockSha256: string;
              readonly providerInstanceId: string;
              readonly providerSessionId: string;
              readonly routeConfigSha256: string;
            };
            expect(evidence.scope).toBe("managed-procedure/v1");
            expect(evidence.deliveredRef).toEqual({
              projectId: SKILL_REF.projectId,
              skillId: SKILL_REF.skillId,
              version: SKILL_REF.version,
              contentSha256: SKILL_REF.contentSha256,
            });
            // The persisted digest is of the block inside the SDK message
            // the adapter actually queued — not a test-supplied constant.
            expect(evidence.deliveredBlockSha256).toBe(EXPECTED_BLOCK_SHA256);
            expect(evidence.providerInstanceId).toBe(CLAUDE_INSTANCE);
            expect(evidence.providerSessionId).toBe(nativeSessionId);
            expect(evidence.routeConfigSha256).toBe(routeSha);
            // The durable label is digests and identities only — the
            // submitted block text is never persisted.
            expect(managedSendJson!.includes(EXPECTED_BLOCK)).toBe(false);
          }),
      );
    }),
  );

  effectIt.live("settles the snapshot the observer copied, not the adapter's mutable buffer", () =>
    Effect.gen(function* () {
      yield* withReactorHarness({ modelSelection: CLAUDE_MODEL_SELECTION }, (harness) =>
        Effect.gen(function* () {
          yield* seedSkillCandidate(harness);
          let publishedInput = "";
          harness.claude.sendTurn.mockImplementationOnce((sendInput, admission) =>
            Effect.suspend(() => {
              publishedInput = typeof sendInput.input === "string" ? sendInput.input : "";
              const textBlocks: Array<string> = [publishedInput];
              const submissionCandidate = {
                textBlocks,
                routeConfigSha256: ROUTE_SHA256,
              };
              if (
                admission !== undefined &&
                !admission.admit({
                  sessionGeneration: 3,
                  nativeSessionId: "claude-native-1",
                  submissionCandidate,
                })
              ) {
                return Effect.fail(
                  new ProviderAdapterSessionClosedError({
                    provider: CLAUDE_DRIVER,
                    threadId: sendInput.threadId,
                  }),
                );
              }
              // The observer already ran synchronously inside `admit` —
              // mutating the source candidate now must not rewrite the
              // bytes it captured.
              textBlocks[0] = "mutated after the gate returned";
              textBlocks.push("injected after the gate returned");
              submissionCandidate.routeConfigSha256 = "0".repeat(64);
              return Effect.succeed({
                threadId: sendInput.threadId,
                turnId: asTurnId(`turn-${String(sendInput.threadId)}`),
              });
            }),
          );
          yield* dispatchSkillTurn(harness, {
            commandId: "cmd-mutated-candidate",
            messageId: "m-mutated-candidate",
          });
          yield* Queue.take(harness.settleQueue);
          yield* harness.drain;

          expect(publishedInput).toContain(EXPECTED_BLOCK);
          expect(harness.settleInputs.length).toBe(1);
          const settle = harness.settleInputs[0]!;
          const submission = settle.submission;
          // The snapshot kept the pre-mutation bytes and digest — a live
          // reference would have lost the managed block entirely.
          expect(submission?.submissionCandidate?.textBlocks).toEqual([publishedInput]);
          expect(submission?.submissionCandidate?.routeConfigSha256).toBe(ROUTE_SHA256);
          const rows = yield* trialRows(harness);
          const managedSendJson = rows[0]!.managedSendJson;
          expect(typeof managedSendJson).toBe("string");
          const evidence = JSON.parse(managedSendJson!) as {
            readonly deliveredBlockSha256: string;
            readonly routeConfigSha256: string;
          };
          expect(evidence.deliveredBlockSha256).toBe(EXPECTED_BLOCK_SHA256);
          expect(evidence.routeConfigSha256).toBe(ROUTE_SHA256);
        }),
      );
    }),
  );

  effectIt.live(
    "settles a durable use handoff through the real Claude adapter with selected scripts",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(
          { modelSelection: CLAUDE_MODEL_SELECTION, realClaudeAdapter: true },
          (harness) =>
            Effect.gen(function* () {
              yield* seedActiveUseSkill(harness);
              const realClaude = harness.realClaude!;
              // The evidence send already queued one prompt and settled once.
              const queuedBefore = realClaude.publishedMessages.length;
              const settledBefore = harness.settleInputs.length;
              expect(queuedBefore).toBe(1);
              expect(settledBefore).toBe(1);

              yield* dispatchUseSkillTurn(
                harness,
                { commandId: "cmd-use-managed", messageId: "m-use-managed" },
                USE_SELECTED_SCRIPT_IDS,
              );
              yield* Queue.take(harness.settleQueue);
              yield* harness.drain;

              // Exactly one more prompt reached the real adapter's SDK queue,
              // carrying the canonical use block once.
              expect(realClaude.publishedMessages.length).toBe(queuedBefore + 1);
              const queuedBlocks = queuedTextBlocksOf(realClaude.publishedMessages[queuedBefore]!);
              expect(queuedBlocks.length).toBe(1);
              expect(queuedBlocks[0]).toContain(EXPECTED_USE_BLOCK);

              // The settle is bound to the committed durable use claim and the
              // actual publish observation of that very queued message.
              expect(harness.settleInputs.length).toBe(settledBefore + 1);
              const settle = harness.settleInputs[settledBefore]!;
              expect(settle.entered.identity.messageId).toBe(asMessageId("m-use-managed"));
              expect(settle.entered.identity.mode).toBe("use");
              expect(settle.entered.identity.selectedScriptIds).toEqual(["lint"]);
              expect(settle.providerInstanceId).toBe(CLAUDE_INSTANCE);
              expect(settle.submission?.driverKind).toBe(CLAUDE_DRIVER);
              expect(settle.submission?.submissionCandidate?.textBlocks).toEqual(queuedBlocks);

              const rows = yield* trialRows(harness);
              const useRow = rows.find((row) => row.messageId === "m-use-managed");
              expect(useRow?.delivery).toBe("provider-accepted");
              expect(useRow?.providerDriverKind).toBe(CLAUDE_DRIVER);
              const evidenceRow = rows.find((row) => row.messageId === USE_EVIDENCE_MESSAGE_ID);
              expect(typeof useRow?.managedSendJson).toBe("string");
              expect(typeof evidenceRow?.managedSendJson).toBe("string");
              const useSend = JSON.parse(useRow!.managedSendJson!) as ManagedSendLabel;
              const evidenceSend = JSON.parse(evidenceRow!.managedSendJson!) as ManagedSendLabel;
              expect(useSend.scope).toBe("managed-procedure/v1");
              expect(useSend.deliveredBlockSha256).toBe(EXPECTED_USE_BLOCK_SHA256);
              expect(useSend.providerInstanceId).toBe(CLAUDE_INSTANCE);
              expect(useSend.providerSessionId).toBe(realClaude.createInput()?.options.sessionId);
              // The claim was ready only because the reproduction ran on the
              // route the real adapter publishes under now.
              expect(useSend.routeConfigSha256).toBe(evidenceSend.routeConfigSha256);
            }),
        );
      }),
  );

  // The durable selection names a script the server-current target plan cannot
  // resolve: the use is held before any claim, so nothing is queued on the real
  // adapter, nothing is claimed, and nothing settles. The control send in the
  // same world — same evidence, valid selection — is queued and settled, so the
  // refusal is the selection's and not the fixture's.
  effectIt.live("refuses a use send when the durable selection drifts from the target plan", () =>
    Effect.gen(function* () {
      yield* withReactorHarness(
        { modelSelection: CLAUDE_MODEL_SELECTION, realClaudeAdapter: true },
        (harness) =>
          Effect.gen(function* () {
            yield* seedActiveUseSkill(harness);
            const realClaude = harness.realClaude!;
            const queuedBefore = realClaude.publishedMessages.length;
            const settledBefore = harness.settleInputs.length;

            const reported = yield* armHoldReport(harness, {
              messageId: "m-use-drift",
              detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            });
            yield* dispatchUseSkillTurn(
              harness,
              { commandId: "cmd-use-drift", messageId: "m-use-drift" },
              ["not-in-plan"],
            );
            yield* Deferred.await(reported);
            yield* harness.drain;

            expect(realClaude.publishedMessages.length).toBe(queuedBefore);
            expect(harness.settleInputs.length).toBe(settledBefore);
            const refusedRows = yield* trialRows(harness);
            expect(refusedRows.some((row) => row.messageId === "m-use-drift")).toBe(false);
            const thread = (yield* harness.readModel).threads.find(
              (entry) => entry.id === THREAD_ID,
            );
            const failures = failureActivitiesOf(thread);
            expect(failures.length).toBe(1);
            expect(failures[0]!.summary).toBe("Message not sent");
            expect((failures[0]!.payload as { readonly detail?: string }).detail).toBe(
              PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
            );

            yield* dispatchUseSkillTurn(
              harness,
              { commandId: "cmd-use-drift-control", messageId: "m-use-drift-control" },
              USE_SELECTED_SCRIPT_IDS,
            );
            yield* Queue.take(harness.settleQueue);
            yield* harness.drain;

            expect(realClaude.publishedMessages.length).toBe(queuedBefore + 1);
            expect(harness.settleInputs.length).toBe(settledBefore + 1);
            const rows = yield* trialRows(harness);
            expect(rows.find((row) => row.messageId === "m-use-drift-control")?.delivery).toBe(
              "provider-accepted",
            );
            expect(rows.some((row) => row.messageId === "m-use-drift")).toBe(false);
          }),
      );
    }),
  );

  // Wraps the real adapter so the route preview it freezes names a native
  // session other than the one it actually publishes under. Everything else —
  // the SDK double, the prompt queue, the publish-step observation — stays the
  // real adapter's, so the only disagreement is the preview's.
  const withFrozenNativeSessionId = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    nativeSessionId: string,
  ): ProviderAdapterShape<ProviderAdapterError> => {
    const preview = adapter.previewSubmissionRoute;
    return {
      ...adapter,
      previewSubmissionRoute: (previewInput) =>
        preview === undefined
          ? Effect.succeed(undefined)
          : Effect.map(preview(previewInput), (route) =>
              route === undefined ? undefined : { ...route, nativeSessionId },
            ),
    };
  };

  // The claim commits (readiness holds and the use row is entered), then the
  // real adapter's publish step observes a native session different from the
  // frozen preview: `verifyUse` vetoes synchronously, before the SDK prompt
  // queue. Nothing is queued, nothing is captured or settled, and the committed
  // attempt stays `unknown` — never resold, never accepted.
  effectIt.live(
    "refuses the publish when verifyUse rejects a mismatched native session identity",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(
          { modelSelection: CLAUDE_MODEL_SELECTION, realClaudeAdapter: true },
          (harness) =>
            Effect.gen(function* () {
              yield* seedActiveUseSkill(harness);
              const realClaude = harness.realClaude!;
              const queuedBefore = realClaude.publishedMessages.length;
              const settledBefore = harness.settleInputs.length;
              const adapter = harness.adapters.get(CLAUDE_INSTANCE);
              expect(adapter).toBeDefined();
              harness.adapters.set(
                CLAUDE_INSTANCE,
                withFrozenNativeSessionId(adapter!, "claude-native-frozen"),
              );

              const reported = yield* armHoldReport(harness, {
                messageId: "m-use-verify-veto",
                detail: PROJECT_SKILL_SEND_REJECTION_DETAIL.unavailable,
              });
              yield* dispatchUseSkillTurn(
                harness,
                { commandId: "cmd-use-verify-veto", messageId: "m-use-verify-veto" },
                USE_SELECTED_SCRIPT_IDS,
              );
              yield* Deferred.await(reported);
              yield* harness.drain;

              expect(realClaude.publishedMessages.length).toBe(queuedBefore);
              expect(harness.settleInputs.length).toBe(settledBefore);
              const rejected = harness.analytics.eventsByName("provider.turn.rejected");
              expect(rejected.length).toBe(1);
              expect(rejected[0]!.properties?.["errorType"]).toBe(
                "ProviderSkillTrialHandoffRefusedError",
              );
              const rows = yield* trialRows(harness);
              const vetoRow = rows.find((row) => row.messageId === "m-use-verify-veto");
              expect(vetoRow?.delivery).toBe("unknown");
              expect(vetoRow?.providerDriverKind).toBeNull();
              expect(vetoRow?.managedSendJson).toBeNull();
            }),
        );
      }),
  );

  // Wraps the real adapter so its route lookup parks on Deferreds: `entered`
  // fires when the real ProviderService preview read reaches the adapter, and
  // the lookup never completes until `release` does. Everything else stays the
  // real adapter's.
  const withHeldRouteLookup = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    held: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> },
  ): ProviderAdapterShape<ProviderAdapterError> => {
    const preview = adapter.previewSubmissionRoute;
    return {
      ...adapter,
      previewSubmissionRoute: (previewInput) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(held.entered, undefined);
          yield* Deferred.await(held.release);
          return preview === undefined ? undefined : yield* preview(previewInput);
        }),
    };
  };

  // The use handoff's preclaim assembly claims nothing, so Stop must cancel it
  // like any other preparation work: with the real route lookup parked, the
  // worker exits and drains, and nothing was claimed, queued on the real
  // adapter's SDK, or settled.
  effectIt.live(
    "cancels a use send parked in its preclaim route lookup without claiming, queueing, or settling",
    () =>
      Effect.gen(function* () {
        yield* withReactorHarness(
          { modelSelection: CLAUDE_MODEL_SELECTION, realClaudeAdapter: true },
          (harness) =>
            Effect.gen(function* () {
              yield* seedActiveUseSkill(harness);
              const realClaude = harness.realClaude!;
              const queuedBefore = realClaude.publishedMessages.length;
              const settledBefore = harness.settleInputs.length;
              const rowsBefore = (yield* trialRows(harness)).length;

              const held = {
                entered: yield* Deferred.make<void>(),
                release: yield* Deferred.make<void>(),
              };
              const adapter = harness.adapters.get(CLAUDE_INSTANCE);
              expect(adapter).toBeDefined();
              harness.adapters.set(CLAUDE_INSTANCE, withHeldRouteLookup(adapter!, held));

              yield* dispatchUseSkillTurn(
                harness,
                { commandId: "cmd-use-cancel", messageId: "m-use-cancel" },
                USE_SELECTED_SCRIPT_IDS,
              );
              // The send is inside the real preclaim lookup, before any claim.
              yield* Deferred.await(held.entered);

              // The cancel lands either as the plain stop's terminal write or,
              // for a preparation that never reached the provider, as the
              // guarded preparation-cancel write (stopped, or error when its
              // cleanup is unverified).
              const settledSession = yield* Deferred.make<void>();
              harness.setAfterCommand((command) =>
                command.type === "thread.session.set" &&
                (command.session.status === "stopped" || command.session.status === "error")
                  ? Deferred.succeed(settledSession, undefined).pipe(Effect.asVoid)
                  : undefined,
              );
              yield* harness.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.make("cmd-use-cancel-stop"),
                threadId: THREAD_ID,
                createdAt: NOW,
              });
              yield* Deferred.await(settledSession);
              yield* harness.drain;

              expect(realClaude.publishedMessages.length).toBe(queuedBefore);
              expect(harness.settleInputs.length).toBe(settledBefore);
              const rows = yield* trialRows(harness);
              expect(rows.length).toBe(rowsBefore);
              expect(rows.some((row) => row.messageId === "m-use-cancel")).toBe(false);
            }),
        );
      }),
  );

  // The shell fallback the harness installs is scoped to it: the original
  // value — here, its absence — is back once the harness scope closes.
  effectIt.live("restores the original shell variable when the harness scope closes", () =>
    Effect.gen(function* () {
      const original = process.env.SHELL;
      delete process.env.SHELL;
      try {
        yield* Effect.scoped(
          withReactorHarness(undefined, () =>
            Effect.sync(() => {
              expect(process.env.SHELL).toBe("/bin/sh");
            }),
          ),
        );
        expect(process.env.SHELL).toBeUndefined();
      } finally {
        if (original === undefined) {
          delete process.env.SHELL;
        } else {
          process.env.SHELL = original;
        }
      }
    }),
  );
});
