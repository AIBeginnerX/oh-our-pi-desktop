// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  ComposerContextId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  RESTART_CONTINUATION_COMMAND_PREFIX,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import {
  ProviderAdapterRequestError,
  ProviderWorkspaceMissingError,
  type ProviderServiceError,
} from "../../provider/Errors.ts";
import { PersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
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
  MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
  ProjectMemorySendGate,
  ProjectMemorySendPolicy,
  layer as projectMemorySendGateLayer,
} from "../../memory/ProjectMemorySendGate.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import {
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { MEMORY_ECHO_WITHHELD_ERROR } from "../memoryEcho.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

// Fixture-only observation seam for the B5 diagnostic group: wraps the real
// `makeDrainableWorker` constructor so the reactor still runs its production
// process Effect unmodified, while the test records the Exit the real worker
// fiber observed for one target event type. `reactor.drain` cannot play this
// role — the worker decrements its outstanding count in an ensuring finalizer
// even when processing fails, so a resolved drain proves nothing about the
// outcome. Items are the enqueued orchestration events themselves.
const workerObservation = vi.hoisted(() => ({
  armed: null as {
    readonly type: string;
    exit: Exit.Exit<void, unknown> | null;
    readonly done: Deferred.Deferred<void>;
  } | null,
}));

vi.mock("@t3tools/shared/DrainableWorker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/DrainableWorker")>();
  const makeObservedWorker: typeof actual.makeDrainableWorker = (process) =>
    actual.makeDrainableWorker((item) =>
      Effect.onExit(process(item), (exit) =>
        Effect.gen(function* () {
          const armed = workerObservation.armed;
          const input = item as { readonly type?: string };
          if (!armed || input.type !== armed.type) return;
          armed.exit = exit;
          yield* Deferred.succeed(armed.done, undefined);
        }),
      ),
    );
  return { ...actual, makeDrainableWorker: makeObservedWorker };
});

const assistantQuoteText = "Retain the reconnect backoff.";
const assistantCitation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("source-environment"),
  threadId: ThreadId.make("source-thread"),
  messageId: asMessageId("source-message"),
  text: assistantQuoteText,
  start: 0,
  end: assistantQuoteText.length,
  prefix: "",
  suffix: "",
};

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProjectMemorySendLedger
    | ProjectMemoryRepository
    | ProviderRuntimeIngestionService
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let ingestionScope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (ingestionScope !== null || scope !== null) {
      await Effect.runPromise(
        Effect.gen(function* () {
          if (ingestionScope) yield* Scope.close(ingestionScope, Exit.void);
          if (scope) yield* Scope.close(scope, Exit.void);
        }),
      );
    }
    ingestionScope = null;
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly initialTitle?: string;
    readonly deferReactorStart?: boolean;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly unreadableHistory?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly serverActivation?: Effect.Effect<void>;
    readonly beforeReadySessionDispatch?: () => Effect.Effect<void>;
    readonly beforeTurnStartDispatch?: () => Effect.Effect<void>;
    readonly afterTurnStartDispatch?: () => Effect.Effect<void>;
    readonly compactThreadEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly interruptTurnEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly stopSessionEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly sendTurnEffect?: (
      sendInput: ProviderSendTurnInput,
    ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
    readonly respondToRequestEffect?: () => Effect.Effect<void, ProviderServiceError>;
    readonly respondToUserInputEffect?: () => Effect.Effect<void, ProviderServiceError>;
    readonly withRuntimeIngestion?: boolean;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderServiceError>;
    readonly tryHandlePromptCommandEffect?: ProviderAuthService["Service"]["tryHandlePromptCommand"];
    readonly failDispatch?: (
      command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError> | undefined;
    readonly afterCommand?: (
      command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
    ) => Effect.Effect<unknown> | undefined;
    // Parks the Nth getInstanceInfo call strictly after the real lookup result
    // is built, mirroring the memory-gate parks: a scenario can hold the
    // forked send child at the in-child boundary that runs before admission.
    readonly parkGetInstanceInfo?: {
      readonly call: number;
      readonly parked: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
      readonly capture?: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
    };
    readonly memoryGate?: {
      readonly driverKinds?: ReadonlySet<ProviderDriverKind>;
      readonly parkAdmitAfterCommit?: {
        readonly parked: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
        readonly capture?: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
        /** When set, only the Nth committed admit parks (1-based). */
        readonly commit?: number;
      };
      readonly parkThreadHoldAtCall?: {
        readonly call: number;
        readonly parked: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
        readonly capture?: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
        /** "after" (default): park once the real hold result is known. "before": park, then read. */
        readonly timing?: "before" | "after";
      };
      readonly afterSettle?: Deferred.Deferred<void>;
    };
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    // Opt-in live-ingestion fixtures publish acknowledged batch envelopes on a
    // dedicated PubSub; the fake stream completes `enqueued` only after the
    // events were actually dequeued, and `ingestionSubscribed` proves the
    // subscription exists before any publish. Both are created lazily inside
    // startIngestion so this path never runs an Effect runner outside a test.
    let runtimeEventEnvelopePubSub:
      | PubSub.PubSub<{
          readonly events: ReadonlyArray<ProviderRuntimeEvent>;
          readonly enqueued?: Deferred.Deferred<void>;
        }>
      | undefined;
    let ingestionSubscribed: Deferred.Deferred<void> | undefined;
    const tryHandlePromptCommand = vi.fn<ProviderAuthService["Service"]["tryHandlePromptCommand"]>(
      input?.tryHandlePromptCommandEffect ?? (() => Effect.succeed(false)),
    );
    let nextSessionIndex = 1;
    let getInstanceInfoCalls = 0;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>(
      (sendInput) =>
        input?.sendTurnEffect?.(sendInput) ??
        Effect.succeed({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        }),
    );
    const compactThread = vi.fn((_: ThreadId) => input?.compactThreadEffect?.() ?? Effect.void);
    const interruptTurn = vi.fn((_: unknown) => input?.interruptTurnEffect?.() ?? Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(
      () => input?.respondToRequestEffect?.() ?? Effect.void,
    );
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(
      () => input?.respondToUserInputEffect?.() ?? Effect.void,
    );
    const stopSession = vi.fn((stopInput: unknown) =>
      (input?.stopSessionEffect?.() ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const threadId =
              typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
                ? (stopInput as { threadId?: ThreadId }).threadId
                : undefined;
            if (!threadId) {
              return;
            }
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      ),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const pruneWorktrees = vi.fn((_: { readonly cwd: string }) => Effect.void);
    const closeIdleTerminals = vi.fn((_: { readonly threadId: string }) => Effect.void);
    const createWorktree = vi.fn(
      (input: { readonly refName: string; readonly path: string | null }) =>
        Effect.succeed({ worktree: { path: input.path ?? "", refName: input.refName } }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGeneration["Service"]["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGeneration["Service"]["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      compactThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      assertConversationRollbackSupported: () => unsupported(),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude")
            ? "claudeAgent"
            : raw.startsWith("codex")
              ? "codex"
              : raw.startsWith("antigravity")
                ? "antigravity"
                : raw,
        );
        const info = Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
        const park = input?.parkGetInstanceInfo;
        if (park === undefined) {
          return info;
        }
        getInstanceInfoCalls += 1;
        if (getInstanceInfoCalls !== park.call) {
          return info;
        }
        return Effect.gen(function* () {
          if (park.capture !== undefined) {
            yield* Deferred.succeed(park.capture, yield* Effect.fiber);
          }
          const resolved = yield* info;
          yield* Deferred.succeed(park.parked, undefined);
          yield* Deferred.await(park.release);
          return resolved;
        });
      },
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      previewSubmissionRoute: () => unsupported(),
      get streamEvents() {
        if (runtimeEventEnvelopePubSub === undefined || ingestionSubscribed === undefined) {
          return Stream.fromPubSub(runtimeEventPubSub);
        }
        const pubsub = runtimeEventEnvelopePubSub;
        const subscribed = ingestionSubscribed;
        return Stream.unwrap(
          Effect.map(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(pubsub);
              yield* Deferred.succeed(subscribed, undefined);
              return subscription;
            }),
            (subscription) =>
              Stream.fromSubscription(subscription).pipe(
                Stream.flatMap(({ events, enqueued }) =>
                  Stream.concat(
                    Stream.fromIterable(events),
                    enqueued === undefined
                      ? Stream.empty
                      : Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain),
                  ),
                ),
              ),
          ),
        );
      },
    };

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

    // The memory gate is always the real service over the shared SQLite
    // database. Tests only inject policy and, when a scenario must pause the
    // reactor at a gate boundary, a delegating wrapper that parks strictly
    // after the real gate call has already run.
    const realMemoryGateLayer =
      input?.memoryGate?.driverKinds === undefined
        ? projectMemorySendGateLayer
        : projectMemorySendGateLayer.pipe(
            Layer.provide(
              Layer.succeed(ProjectMemorySendPolicy, {
                driverKinds: input.memoryGate.driverKinds,
              }),
            ),
          );
    const memoryGateLayer =
      input?.memoryGate === undefined
        ? realMemoryGateLayer
        : Layer.effect(
            ProjectMemorySendGate,
            Effect.gen(function* () {
              const real = yield* ProjectMemorySendGate;
              let threadHoldCalls = 0;
              let committedAdmitParks = 0;
              // The park runs on the fiber executing the gate call. For the
              // post-commit admission and the L3 recheck that fiber is the
              // forked send fiber itself, so `capture` hands the test the exact
              // fiber to interrupt — closing the reactor's start scope does
              // not reach it.
              const parkEffect = (park: {
                readonly parked: Deferred.Deferred<void>;
                readonly release: Deferred.Deferred<void>;
                readonly capture?: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
              }) =>
                Effect.gen(function* () {
                  if (park.capture !== undefined) {
                    yield* Deferred.succeed(park.capture, yield* Effect.fiber);
                  }
                  yield* Deferred.succeed(park.parked, undefined);
                  yield* Deferred.await(park.release);
                });
              return ProjectMemorySendGate.of({
                threadHold: (threadId) => {
                  threadHoldCalls += 1;
                  const parkConfig = input?.memoryGate?.parkThreadHoldAtCall;
                  const park = parkConfig?.call === threadHoldCalls ? parkConfig : undefined;
                  if (park === undefined) {
                    return real.threadHold(threadId);
                  }
                  if (park.timing === "before") {
                    return parkEffect(park).pipe(Effect.andThen(real.threadHold(threadId)));
                  }
                  return real.threadHold(threadId).pipe(Effect.tap(() => parkEffect(park)));
                },
                driverAllowed: real.driverAllowed,
                admit: (commitInput) =>
                  real.admit(commitInput).pipe(
                    Effect.flatMap((result) => {
                      const park = input?.memoryGate?.parkAdmitAfterCommit;
                      if (result._tag !== "Committed" || park === undefined) {
                        return Effect.succeed(result);
                      }
                      committedAdmitParks += 1;
                      if (park.commit !== undefined && committedAdmitParks !== park.commit) {
                        return Effect.succeed(result);
                      }
                      return parkEffect(park).pipe(Effect.as(result));
                    }),
                  ),
                settle: (attemptSeq, outcome) =>
                  real
                    .settle(attemptSeq, outcome)
                    .pipe(
                      Effect.tap(() =>
                        input?.memoryGate?.afterSettle === undefined
                          ? Effect.void
                          : Deferred.succeed(input.memoryGate.afterSettle, undefined),
                      ),
                    ),
                revalidate: real.revalidate,
                revalidateForAdmission: real.revalidateForAdmission,
              });
            }),
          ).pipe(Layer.provide(realMemoryGateLayer));

    // Arms one deterministic cause for the memory echo guard's attempt lookup
    // on one thread (B5 group only). Unarmed, the wrapper below is a
    // pass-through of the real shared SQLite client.
    const echoLookupTrigger: {
      armed: { readonly threadId: ThreadId; readonly cause: Cause.Cause<unknown> } | null;
    } = { armed: null };
    const sqlitePersistenceLayer = SqlitePersistenceMemory;
    const echoLookupSqlLayer = Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function* () {
        const real = yield* SqlClient.SqlClient;
        return new Proxy(real, {
          get: (target, property) => {
            const value = Reflect.get(target, property, target);
            return typeof value === "function"
              ? (value as (...args: Array<never>) => unknown).bind(target)
              : value;
          },
          apply: (target, thisArg, args) => {
            const armed = echoLookupTrigger.armed;
            const template = Array.isArray(args[0]) ? (args[0] as readonly string[]).join("") : "";
            if (
              armed !== null &&
              template.includes("SELECT 1") &&
              template.includes("project_memory_send_attempts") &&
              args.slice(1).some((param) => String(param) === armed.threadId)
            ) {
              // The fixture never arms a non-failing cause; typing it `never`
              // keeps the layer's error channel closed. Runtime cause unchanged.
              return Effect.failCause(armed.cause as Cause.Cause<never>);
            }
            return Reflect.apply(target, thisArg, args);
          },
        }) as SqlClient.SqlClient;
      }),
    ).pipe(Layer.provide(sqlitePersistenceLayer));
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(echoLookupSqlLayer),
    );

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
    let titleRegenerationCompletionDispatchAttempts = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          readThreadEvents: engine.readThreadEvents,
          getThreadReplayStats: engine.getThreadReplayStats,
          dispatch: (command, options) => {
            const injectedFailure = input?.failDispatch?.(command);
            if (injectedFailure !== undefined) {
              return injectedFailure;
            }
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            const isReplay =
              command.type === "thread.turn.start" &&
              command.commandId.startsWith("server:after-compaction:");
            const before =
              command.type === "thread.session.set" && command.session.status === "ready"
                ? input?.beforeReadySessionDispatch
                : isReplay
                  ? input?.beforeTurnStartDispatch
                  : undefined;
            return (before?.() ?? Effect.void).pipe(
              Effect.andThen(engine.dispatch(command, options)),
              Effect.tap(() =>
                isReplay ? (input?.afterTurnStartDispatch?.() ?? Effect.void) : Effect.void,
              ),
              // The real dispatch commits its events through the synchronous
              // projection transaction, so this tap is a persisted+projected
              // receipt, not a pre-write signal.
              Effect.tap(() => input?.afterCommand?.(command) ?? Effect.void),
            );
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          subscribeDomainEvents: engine.subscribeDomainEvents,
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    // Reactor and live ingestion are sibling consumers of ONE shared provider
    // chain: the same wrapped engine, snapshot query, fake ProviderService,
    // memory gate/ledger, one settings layer (one Ref), the same
    // SqlitePersistenceMemory layer object and NodeServices feed both.
    // Ingestion is always built — its make only allocates idle scoped workers
    // and subscriptions start inside start(), which only opt-in tests call.
    // The fixed CheckpointStore mock covers its sole ambient dependency these
    // cases never reach: they emit no diff events and test no checkpoints.
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const layer = Layer.merge(providerCommandReactorLayer, ProviderRuntimeIngestionLive)
      .pipe(
        Layer.provideMerge(reactorOrchestrationLayer),
        Layer.provideMerge(projectionSnapshotLayer),
        Layer.provideMerge(Layer.succeed(ProviderService, service)),
        Layer.provideMerge(memoryGateLayer),
        Layer.provideMerge(projectMemorySendLedgerLayer),
        Layer.provideMerge(projectMemoryRepositoryLayer),
        Layer.provideMerge(Logger.layer([captureLogger])),
        Layer.provide(Layer.mock(ProviderAuthService, { tryHandlePromptCommand })),
        Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
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
      )
      // Split only to stay under the .pipe overload limit; the provision order
      // and the resulting layer graph are identical to one continuous chain.
      .pipe(
        // One memoized persistence layer: the reactor alone sees the optional
        // echo-lookup proxy; every other consumer resolves the real client.
        Layer.provideMerge(sqlitePersistenceLayer),
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
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const ledger = await runtime.runPromise(Effect.service(ProjectMemorySendLedger));
    const memoryRepository = await runtime.runPromise(Effect.service(ProjectMemoryRepository));
    // Always in the runtime (merged upstream of the shared chain); only
    // opt-in tests call start()/emitAndDrain.
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);
    // SQL-aware runner for fixtures that seed or inspect projection rows
    // directly; the runtime supplies SqlClient.
    const runSqlEffect = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: input?.initialTitle ?? "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    if (input?.unreadableHistory === true) {
      // Metadata commands must not decode this unrelated message body.
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, attachments_json,
              is_streaming, created_at, updated_at
            ) VALUES (
              'old-unreadable-message', 'thread-1', NULL, 'assistant',
              'Old assistant output', 'invalid json', 0, ${now}, ${now}
            )
          `;
        }),
      );
    }
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    const startReactorEffect = () =>
      Effect.gen(function* () {
        const reactorScope = yield* Scope.make("sequential");
        scope = reactorScope;
        yield* reactor
          .start()
          .pipe(
            Scope.provide(reactorScope),
            Effect.provideService(ServerActivation, input?.serverActivation),
          );
      });
    const startReactor = () => Effect.runPromise(startReactorEffect());
    const startReactorExit = () => Effect.runPromise(Effect.exit(startReactorEffect()));
    if (!input?.deferReactorStart) await startReactor();
    const drain = () => Effect.runPromise(reactor.drain);
    const requireIngestion = () => {
      if (input?.withRuntimeIngestion !== true) {
        throw new Error("createHarness requires withRuntimeIngestion: true");
      }
      return ingestion;
    };
    const startIngestion = async () => {
      const service = requireIngestion();
      if (runtimeEventEnvelopePubSub === undefined) {
        runtimeEventEnvelopePubSub = await runEffect(
          PubSub.unbounded<{
            readonly events: ReadonlyArray<ProviderRuntimeEvent>;
            readonly enqueued?: Deferred.Deferred<void>;
          }>(),
        );
        ingestionSubscribed = Deferred.makeUnsafe<void>();
      }
      const nextScope = await runEffect(Scope.make("sequential"));
      ingestionScope = nextScope;
      await runEffect(service.start().pipe(Scope.provide(nextScope)));
    };
    // Publishes a batch envelope, waits for the fake stream to acknowledge
    // that every event was dequeued, then waits for the ingestion workers to
    // go idle. Publication alone is not delivery proof.
    const emitAndDrain = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
      const service = requireIngestion();
      if (runtimeEventEnvelopePubSub === undefined || ingestionSubscribed === undefined) {
        throw new Error("emitAndDrain requires startIngestion first");
      }
      const pubsub = runtimeEventEnvelopePubSub;
      const subscribed = ingestionSubscribed;
      return runEffect(
        Effect.gen(function* () {
          yield* Deferred.await(subscribed);
          const enqueued = yield* Deferred.make<void>();
          const published = yield* PubSub.publish(pubsub, { events, enqueued });
          if (!published) {
            return yield* Effect.die(new Error("runtime event envelope publish was rejected"));
          }
          yield* Deferred.await(enqueued);
          yield* service.drain;
        }),
      );
    };

    return {
      engine,
      snapshotQuery,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readPendingTurnStarts: () =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly threadId: string }>`
              SELECT thread_id AS "threadId"
              FROM projection_turns
              WHERE turn_id IS NULL AND state = 'pending'
            `;
          }),
        ),
      readProjectionTurnRows: (threadId: ThreadId) =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly turnId: string | null;
              readonly pendingMessageId: string | null;
              readonly state: string;
              readonly requestedAt: string;
            }>`
              SELECT
                turn_id AS "turnId",
                pending_message_id AS "pendingMessageId",
                state,
                requested_at AS "requestedAt"
              FROM projection_turns
              WHERE thread_id = ${threadId}
              ORDER BY requested_at ASC, turn_id ASC
            `;
          }),
        ),
      tryHandlePromptCommand,
      startSession,
      sendTurn,
      compactThread,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      pruneWorktrees,
      createWorktree,
      closeIdleTerminals,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      startReactor,
      startReactorExit,
      startIngestion,
      emitAndDrain,
      stopIngestion: async () => {
        const currentScope = ingestionScope;
        ingestionScope = null;
        if (currentScope) {
          await runEffect(Scope.close(currentScope, Exit.void));
        }
      },
      stopReactor: async () => {
        const reactorScope = scope;
        scope = null;
        if (reactorScope) {
          await Effect.runPromise(Scope.close(reactorScope, Exit.void));
        }
      },
      ledger,
      memoryRepository,
      logs: capturedLogs,
      armEchoLookupFailure: (threadId: ThreadId, cause: Cause.Cause<unknown>) => {
        echoLookupTrigger.armed = { threadId, cause };
      },
      disarmEchoLookup: () => {
        echoLookupTrigger.armed = null;
      },
      runEffect,
      runSqlEffect,
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }

  describe("T1 follow-through", () => {
    type T1Harness = Awaited<ReturnType<typeof createHarness>>;

    const threadId = ThreadId.make("thread-1");
    const codexInstanceId = ProviderInstanceId.make("codex");
    const codexDriver = ProviderDriverKind.make("codex");
    const turn1 = asTurnId("t1-turn-1");
    const turn2 = asTurnId("t1-turn-2");
    const message1 = asMessageId("t1-message-m1");
    const message2 = asMessageId("t1-message-m2");

    const at = (offsetSeconds: number) =>
      `2026-01-01T00:00:${String(offsetSeconds).padStart(2, "0")}.000Z`;

    const dispatchTurnStart = (
      harness: T1Harness,
      commandId: string,
      messageId: MessageId,
      text: string,
      createdAt: string,
    ) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId,
          message: { messageId, role: "user", text, attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );

    const turnStartedEvent = (
      eventId: string,
      turnId: TurnId,
      createdAt: string,
    ): ProviderRuntimeEvent => ({
      eventId: EventId.make(eventId),
      provider: codexDriver,
      providerInstanceId: codexInstanceId,
      threadId,
      turnId,
      type: "turn.started",
      payload: {},
      createdAt,
    });

    const readyEvent = (eventId: string, createdAt: string): ProviderRuntimeEvent => ({
      eventId: EventId.make(eventId),
      provider: codexDriver,
      providerInstanceId: codexInstanceId,
      threadId,
      type: "session.state.changed",
      payload: { state: "ready" },
      createdAt,
    });

    const abortedEvent = (
      eventId: string,
      turnId: TurnId,
      createdAt: string,
    ): ProviderRuntimeEvent => ({
      eventId: EventId.make(eventId),
      provider: codexDriver,
      providerInstanceId: codexInstanceId,
      threadId,
      turnId,
      type: "turn.aborted",
      payload: { reason: "turn interrupted" },
      createdAt,
    });

    // The fake provider's own session record: the model ProviderService.listSessions
    // exposes, and the source getExpectedProviderTurnIdForThread reads when a
    // conflicting turn.started arrives.
    const trackProviderTurn = (harness: T1Harness, turnId: TurnId) => {
      const index = harness.runtimeSessions.findIndex((entry) => entry.threadId === threadId);
      expect(index).toBeGreaterThanOrEqual(0);
      const session = harness.runtimeSessions[index]!;
      harness.runtimeSessions[index] = { ...session, activeTurnId: turnId };
    };

    const commandModelThread = async (harness: T1Harness) => {
      const model = await harness.runEffect(harness.snapshotQuery.getCommandReadModel());
      return model.threads.find((entry) => entry.id === threadId);
    };

    // Durable message->turn evidence beyond projection_turns.pendingMessageId:
    // the persisted turn-start-requested events name the user message that
    // requested each turn, in order. User message rows keep turn_id NULL by
    // design (they are never turn-linked); the request event is the link.
    const readTurnStartRequestedMessageIds = async (harness: T1Harness) => {
      const events = await harness.runEffect(Stream.runCollect(harness.engine.readEvents(0)));
      const messageIds: Array<MessageId> = [];
      for (const event of Array.from(events)) {
        if (event.type === "thread.turn-start-requested" && event.payload.threadId === threadId) {
          messageIds.push(event.payload.messageId);
        }
      }
      return messageIds;
    };

    const readUserMessageRows = (harness: T1Harness) =>
      harness.runSqlEffect(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly messageId: string;
            readonly turnId: string | null;
            readonly text: string;
          }>`
            SELECT
              message_id AS "messageId",
              turn_id AS "turnId",
              text
            FROM projection_thread_messages
            WHERE thread_id = ${threadId} AND role = 'user'
            ORDER BY created_at ASC, message_id ASC
          `;
        }),
      );

    // Shared prefix: m1 rides the real reactor send path until fake sendTurn
    // actually enters, the canonical turn.started binds it to T1, the
    // prepare-shaped session.set interrupts T1, an ambiguous ready is a no-op,
    // a same-ID turn.started reactivates T1, and a ready while T1 is active
    // with no pending start is suppressed entirely. `firstSend.fiber` is the
    // captured forked send fiber — joining it is the authoritative post-send
    // completion barrier (reactor.drain does not join forked sends).
    const prepareRestartBoundary = async (
      harness: T1Harness,
      commandIdBase: string,
      firstSend: {
        readonly entered: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
        readonly fiber: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>;
      },
    ) => {
      await dispatchTurnStart(
        harness,
        `${commandIdBase}-turn-m1`,
        message1,
        "t1 first request",
        at(1),
      );
      await harness.runEffect(Deferred.await(firstSend.entered));
      trackProviderTurn(harness, turn1);
      await harness.runEffect(Deferred.succeed(firstSend.release, undefined));
      const sendFiber = await harness.runEffect(Deferred.await(firstSend.fiber));
      const sendExit = await harness.runEffect(Fiber.await(sendFiber));
      expect(Exit.isSuccess(sendExit)).toBe(true);
      await harness.emitAndDrain([
        turnStartedEvent(`${commandIdBase}-evt-turn-started-1`, turn1, at(2)),
      ]);
      expect(await harness.readProjectionTurnRows(threadId)).toEqual([
        expect.objectContaining({
          turnId: turn1,
          pendingMessageId: message1,
          state: "running",
        }),
      ]);
      expect(await harness.readPendingTurnStarts()).toEqual([]);
      expect(await readTurnStartRequestedMessageIds(harness)).toEqual([message1]);
      expect(await readUserMessageRows(harness)).toEqual([
        expect.objectContaining({
          messageId: message1,
          turnId: null,
          text: "t1 first request",
        }),
      ]);
      const bound = await commandModelThread(harness);
      expect(bound?.session?.status).toBe("running");
      expect(bound?.session?.activeTurnId).toBe(turn1);

      // Accepted prepare shape: starting + restart-continuation command id +
      // no active turn, which settles the interrupted turn it replaces.
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`${RESTART_CONTINUATION_COMMAND_PREFIX}${commandIdBase}`),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId: codexInstanceId,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: at(3),
          },
          createdAt: at(3),
        }),
      );
      expect(await harness.readProjectionTurnRows(threadId)).toEqual([
        expect.objectContaining({ turnId: turn1, state: "interrupted" }),
      ]);
      const prepared = await commandModelThread(harness);
      expect(prepared?.session?.status).toBe("starting");
      expect(prepared?.session?.activeTurnId).toBeNull();
      expect(prepared?.latestTurn?.state).toBe("interrupted");

      // No-active prepared boundary: an ambiguous ready applies normally.
      await harness.emitAndDrain([readyEvent(`${commandIdBase}-evt-ready-1`, at(4))]);
      const ready = await commandModelThread(harness);
      expect(ready?.session?.status).toBe("ready");
      expect(ready?.session?.activeTurnId).toBeNull();
      expect(await harness.readProjectionTurnRows(threadId)).toEqual([
        expect.objectContaining({ turnId: turn1, state: "interrupted" }),
      ]);

      // A same-ID turn.started intentionally reopens T1.
      trackProviderTurn(harness, turn1);
      await harness.emitAndDrain([
        turnStartedEvent(`${commandIdBase}-evt-turn-started-2`, turn1, at(5)),
      ]);
      const reactivated = await commandModelThread(harness);
      expect(reactivated?.session?.status).toBe("running");
      expect(reactivated?.session?.activeTurnId).toBe(turn1);
      expect(reactivated?.session?.lastError).toBeNull();
      expect(reactivated?.latestTurn?.state).toBe("running");

      // Active-turn boundary: ready while T1 is active with no pending start
      // is suppressed, persisting zero new session-set events.
      const sequenceBeforeReady = await harness.runEffect(harness.engine.latestSequence);
      await harness.emitAndDrain([readyEvent(`${commandIdBase}-evt-ready-2`, at(6))]);
      const eventsAfterReady = await harness.runEffect(
        Stream.runCollect(harness.engine.readEvents(sequenceBeforeReady)),
      );
      expect(
        Array.from(eventsAfterReady).filter(
          (event) => event.type === "thread.session-set" && event.payload.threadId === threadId,
        ),
      ).toEqual([]);
      const stillRunning = await commandModelThread(harness);
      expect(stillRunning?.session?.status).toBe("running");
      expect(stillRunning?.session?.activeTurnId).toBe(turn1);
      expect(stillRunning?.session?.lastError).toBeNull();
    };

    it("T1 follow-through: next send reaches the real provider path and the steering start consumes its pending row", async () => {
      const send1Entered = Deferred.makeUnsafe<void>();
      const releaseSend1 = Deferred.makeUnsafe<void>();
      const send1Fiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const send2Entered = Deferred.makeUnsafe<void>();
      const releaseSend2 = Deferred.makeUnsafe<void>();
      const send2Fiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      let sendCallCount = 0;
      try {
        const harness = await createHarness({
          withRuntimeIngestion: true,
          sendTurnEffect: (sendInput) => {
            sendCallCount += 1;
            if (sendCallCount === 1) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(send1Fiber, yield* Effect.fiber);
                yield* Deferred.succeed(send1Entered, undefined);
                yield* Deferred.await(releaseSend1);
                return { threadId: sendInput.threadId, turnId: turn1 };
              });
            }
            if (sendCallCount === 2) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(send2Fiber, yield* Effect.fiber);
                yield* Deferred.succeed(send2Entered, undefined);
                yield* Deferred.await(releaseSend2);
                return { threadId: sendInput.threadId, turnId: turn2 };
              });
            }
            return Effect.succeed({ threadId: sendInput.threadId, turnId: turn2 });
          },
        });
        await harness.startIngestion();
        await prepareRestartBoundary(harness, "t1-a", {
          entered: send1Entered,
          release: releaseSend1,
          fiber: send1Fiber,
        });

        // m2 rides the real reactor send path and is held inside fake sendTurn.
        await dispatchTurnStart(harness, "t1-a-turn-m2", message2, "t1 steering request", at(7));
        await harness.runEffect(Deferred.await(send2Entered));
        expect(harness.sendTurn.mock.calls.length).toBe(2);
        expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
          threadId,
          input: "t1 steering request",
        });

        // While held before any provider session/event change: m2 is the
        // pending start, T1 is still active, and m1 -> T1 is intact.
        expect(await harness.readProjectionTurnRows(threadId)).toEqual([
          expect.objectContaining({
            turnId: turn1,
            pendingMessageId: message1,
            state: "running",
          }),
          expect.objectContaining({
            turnId: null,
            pendingMessageId: message2,
            state: "pending",
          }),
        ]);
        expect(await readTurnStartRequestedMessageIds(harness)).toEqual([message1, message2]);
        expect(await readUserMessageRows(harness)).toEqual([
          expect.objectContaining({
            messageId: message1,
            turnId: null,
            text: "t1 first request",
          }),
          expect.objectContaining({
            messageId: message2,
            turnId: null,
            text: "t1 steering request",
          }),
        ]);
        const held = await commandModelThread(harness);
        expect(held?.session?.status).toBe("running");
        expect(held?.session?.activeTurnId).toBe(turn1);

        // The fake provider tracks T2 in its own session record before the
        // canonical turn.started T2 goes through acknowledged live ingestion.
        // The send fiber join is the authoritative post-send barrier.
        await harness.runEffect(Deferred.succeed(releaseSend2, undefined));
        const secondSendFiber = await harness.runEffect(Deferred.await(send2Fiber));
        const secondSendExit = await harness.runEffect(Fiber.await(secondSendFiber));
        expect(Exit.isSuccess(secondSendExit)).toBe(true);
        trackProviderTurn(harness, turn2);
        await harness.emitAndDrain([turnStartedEvent("t1-a-evt-turn-started-t2", turn2, at(8))]);

        expect(await harness.readProjectionTurnRows(threadId)).toEqual([
          expect.objectContaining({
            turnId: turn1,
            pendingMessageId: message1,
            state: "completed",
          }),
          expect.objectContaining({
            turnId: turn2,
            pendingMessageId: message2,
            state: "running",
          }),
        ]);
        expect(await harness.readPendingTurnStarts()).toEqual([]);
        const commandThread = await commandModelThread(harness);
        expect(commandThread?.session?.status).toBe("running");
        expect(commandThread?.session?.activeTurnId).toBe(turn2);
        expect(commandThread?.latestTurn?.turnId).toBe(turn2);
        const snapshot = await harness.readModel();
        const snapshotThread = snapshot.threads.find((entry) => entry.id === threadId);
        expect(snapshotThread?.session?.status).toBe("running");
        expect(snapshotThread?.session?.activeTurnId).toBe(turn2);
        expect(harness.sendTurn.mock.calls.length).toBe(2);
        const failureActivities = await harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly kind: string }>`
              SELECT kind
              FROM projection_thread_activities
              WHERE thread_id = ${threadId} AND kind LIKE '%failed%'
            `;
          }),
        );
        expect(failureActivities).toEqual([]);
      } finally {
        Deferred.doneUnsafe(releaseSend1, Effect.succeed(undefined));
        Deferred.doneUnsafe(releaseSend2, Effect.succeed(undefined));
      }
    });

    it("T1 follow-through: accepted stop reaches the real provider session through the reactor", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const releaseSend = Deferred.makeUnsafe<void>();
      const sendFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const stopEntered = Deferred.makeUnsafe<void>();
      const releaseStop = Deferred.makeUnsafe<void>();
      const stopReturned = Deferred.makeUnsafe<void>();
      try {
        const harness = await createHarness({
          withRuntimeIngestion: true,
          sendTurnEffect: (sendInput) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(sendFiber, yield* Effect.fiber);
              yield* Deferred.succeed(sendEntered, undefined);
              yield* Deferred.await(releaseSend);
              return { threadId: sendInput.threadId, turnId: turn1 };
            }),
          stopSessionEffect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(stopEntered, undefined);
              yield* Deferred.await(releaseStop);
              yield* Deferred.succeed(stopReturned, undefined);
            }),
        });
        await harness.startIngestion();
        await prepareRestartBoundary(harness, "t1-b", {
          entered: sendEntered,
          release: releaseSend,
          fiber: sendFiber,
        });

        const accepted = await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("t1-b-session-stop"),
            threadId,
            createdAt: at(9),
          }),
        );
        expect(accepted.sequence).toBeGreaterThan(0);
        // Reactor delivery is proven by actual provider entry, not the receipt.
        await harness.runEffect(Deferred.await(stopEntered));
        expect(harness.stopSession.mock.calls.length).toBe(1);
        expect(harness.stopSession.mock.calls[0]?.[0]).toMatchObject({ threadId });
        await harness.runEffect(Deferred.succeed(releaseStop, undefined));
        // Fake operation completion plus the serial worker drain cover the
        // whole stop path: the removal tap and any follow-up dispatch are
        // inside the same queue item the drain waits on.
        await harness.runEffect(Deferred.await(stopReturned));
        await harness.drain();

        // The persisted stop-requested event is the acceptance evidence.
        const events = await harness.runEffect(Stream.runCollect(harness.engine.readEvents(0)));
        expect(
          Array.from(events).some(
            (event) =>
              event.type === "thread.session-stop-requested" && event.payload.threadId === threadId,
          ),
        ).toBe(true);
        const stopped = await commandModelThread(harness);
        expect(stopped?.session?.status).toBe("stopped");
        expect(stopped?.session?.activeTurnId).toBeNull();
        const snapshot = await harness.readModel();
        const snapshotThread = snapshot.threads.find((entry) => entry.id === threadId);
        expect(snapshotThread?.session?.status).toBe("stopped");
        expect(await harness.readProjectionTurnRows(threadId)).toEqual([
          expect.objectContaining({ turnId: turn1, state: "interrupted" }),
        ]);
        expect(harness.sendTurn.mock.calls.length).toBe(1);
        expect(harness.runtimeSessions.length).toBe(0);
      } finally {
        Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
        Deferred.doneUnsafe(releaseStop, Effect.succeed(undefined));
      }
    });

    it("T1 follow-through: accepted interrupt reaches the provider and the canonical aborted event settles the turn", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const releaseSend = Deferred.makeUnsafe<void>();
      const sendFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const interruptEntered = Deferred.makeUnsafe<void>();
      const releaseInterrupt = Deferred.makeUnsafe<void>();
      const interruptReturned = Deferred.makeUnsafe<void>();
      try {
        const harness = await createHarness({
          withRuntimeIngestion: true,
          sendTurnEffect: (sendInput) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(sendFiber, yield* Effect.fiber);
              yield* Deferred.succeed(sendEntered, undefined);
              yield* Deferred.await(releaseSend);
              return { threadId: sendInput.threadId, turnId: turn1 };
            }),
          interruptTurnEffect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(interruptEntered, undefined);
              yield* Deferred.await(releaseInterrupt);
              yield* Deferred.succeed(interruptReturned, undefined);
            }),
        });
        await harness.startIngestion();
        await prepareRestartBoundary(harness, "t1-c", {
          entered: sendEntered,
          release: releaseSend,
          fiber: sendFiber,
        });

        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("t1-c-turn-interrupt"),
            threadId,
            turnId: turn1,
            createdAt: at(9),
          }),
        );
        // Orchestration turn ids are not provider turn ids, so the reactor
        // interrupts by session/thread.
        await harness.runEffect(Deferred.await(interruptEntered));
        expect(harness.interruptTurn.mock.calls.length).toBe(1);
        expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({ threadId });
        await harness.runEffect(Deferred.succeed(releaseInterrupt, undefined));
        await harness.runEffect(Deferred.await(interruptReturned));
        await harness.drain();

        // A successful interruptTurn alone does not emit a session update.
        const stillRunning = await commandModelThread(harness);
        expect(stillRunning?.session?.status).toBe("running");
        expect(stillRunning?.session?.activeTurnId).toBe(turn1);

        await harness.emitAndDrain([abortedEvent("t1-c-evt-aborted", turn1, at(10))]);
        const interrupted = await commandModelThread(harness);
        expect(interrupted?.session?.status).toBe("interrupted");
        expect(interrupted?.session?.activeTurnId).toBeNull();
        const snapshot = await harness.readModel();
        const snapshotThread = snapshot.threads.find((entry) => entry.id === threadId);
        expect(snapshotThread?.session?.status).toBe("interrupted");
        expect(await harness.readProjectionTurnRows(threadId)).toEqual([
          expect.objectContaining({ turnId: turn1, state: "interrupted" }),
        ]);
        expect(harness.sendTurn.mock.calls.length).toBe(1);
      } finally {
        Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
        Deferred.doneUnsafe(releaseInterrupt, Effect.succeed(undefined));
      }
    });
  });

  effectIt.effect.each(["new", "ready", "stopped"] as const)(
    "handles sign-out for a %s thread before worktree repair, text helpers, or startup",
    (sessionStatus) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-personal");
        const handled = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({
            ...(sessionStatus === "new"
              ? {}
              : {
                  threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
                }),
            tryHandlePromptCommandEffect: () =>
              Deferred.succeed(handled, undefined).pipe(Effect.as(true)),
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        if (sessionStatus !== "new") {
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-sign-out-bound-session"),
            threadId,
            session: {
              threadId,
              providerInstanceId: instanceId,
              providerName: "antigravity",
              status: sessionStatus,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
        }
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-sign-out-worktree"),
          threadId,
          title: "New thread",
          branch: "t3code/1234abcd",
          worktreePath: NodePath.join(harness.stateDir, "missing-worktree"),
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-provider-sign-out"),
          threadId,
          message: {
            messageId: MessageId.make("message-provider-sign-out"),
            role: "user",
            text: "/logout",
            attachments: [],
          },
          modelSelection: {
            instanceId:
              sessionStatus === "new" ? instanceId : ProviderInstanceId.make("antigravity-other"),
            model: "gemini-3.1-pro",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* Deferred.await(handled);
        yield* Effect.promise(() => harness.drain());

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          providerName: "antigravity",
          providerInstanceId: instanceId,
          activeTurnId: null,
          lastError: null,
        });
        expect(thread?.messages.map((message) => message.text)).toEqual(["/logout"]);
        expect(thread?.activities).toContainEqual(
          expect.objectContaining({ kind: "provider.auth.signed-out", tone: "info", turnId: null }),
        );
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
          instanceId,
          text: "/logout",
          hasAttachments: false,
        });
        expect(harness.pruneWorktrees).not.toHaveBeenCalled();
        expect(harness.createWorktree).not.toHaveBeenCalled();
        expect(harness.generateThreadTitle).not.toHaveBeenCalled();
        expect(harness.generateBranchName).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect("clears a failed sign-out request without sending it as a prompt", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-personal");
      const handled = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
          tryHandlePromptCommandEffect: () =>
            Deferred.succeed(handled, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "logout",
                    detail: "The provider could not sign out. Try again.",
                  }),
                ),
              ),
            ),
        }),
      );
      const threadId = ThreadId.make("thread-1");

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-sign-out-failed"),
        threadId,
        message: {
          messageId: MessageId.make("message-provider-sign-out-failed"),
          role: "user",
          text: "/logout",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(handled);
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: expect.stringContaining("The provider could not sign out. Try again."),
      });
      expect(thread?.activities).toContainEqual(
        expect.objectContaining({ kind: "provider.turn.start.failed", tone: "error" }),
      );
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.auth.signed-out"),
      ).toBe(false);
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect.each([
    { label: "a command mention", text: "What does /logout do?", attachments: [] },
    {
      label: "a command with an attachment",
      text: "/logout",
      attachments: [
        {
          type: "file" as const,
          id: "attached-notes",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        },
      ],
    },
    { label: "another provider's command", text: "/logout", attachments: [] },
  ])("sends $label when the provider auth handler leaves it unhandled", ({ text, attachments }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            Deferred.succeed(started, undefined).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-command-unhandled"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-provider-command-unhandled"),
          role: "user",
          text,
          attachments,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
        instanceId: ProviderInstanceId.make("codex"),
        text,
        hasAttachments: attachments.length > 0,
      });
      expect(harness.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: text,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      );
    }),
  );

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("title");
  });

  effectIt.effect("forwards only a user-renamed title when starting a provider session", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ initialTitle: "Add a progressive blur as you scroll" }),
      );
      const now = "2026-01-01T00:00:00.000Z";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const startTurn = (threadId: string, text: string, titleSeed: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-title-${threadId}`),
          threadId: ThreadId.make(threadId),
          message: {
            messageId: asMessageId(`message-${threadId}`),
            role: "user",
            text,
            attachments: [],
          },
          titleSeed,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

      yield* startTurn(
        "thread-1",
        "Add a progressive blur as you scroll",
        "Add a progressive blur as you scroll",
      );
      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("title");

      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-renamed"),
        threadId: ThreadId.make("thread-renamed"),
        projectId: asProjectId("project-1"),
        title: "New thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-rename"),
        threadId: ThreadId.make("thread-renamed"),
        title: "Keep this name",
      });
      yield* startTurn("thread-renamed", "hello there", "hello there");
      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 2));
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({ title: "Keep this name" });

      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-seeded"),
        threadId: ThreadId.make("thread-seeded"),
        projectId: asProjectId("project-1"),
        title: "New thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-autotitle"),
        threadId: ThreadId.make("thread-seeded"),
        title: "hello there",
      });
      yield* startTurn("thread-seeded", "hello there", "hello there");
      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 3));
      expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("title");
    }),
  );

  effectIt.effect("projects inline context before sending the provider turn", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-with-context"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-with-context"),
          role: "user",
          text: "Inspect [build](t3-context://v1/terminal/terminal-1)",
          attachments: [],
          context: {
            version: 1,
            records: [
              {
                version: 1,
                kind: "terminal",
                contextId: ComposerContextId.make("terminal-1"),
                label: "build",
                terminalId: "terminal-1",
                terminalLabel: "Build",
                lineStart: 7,
                lineEnd: 7,
                text: "compiled successfully",
              },
            ],
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: expect.stringContaining("[Terminal: build; ref=terminal-1]"),
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: expect.stringContaining('<context kind="terminal" id="terminal-1">'),
      });
    }),
  );

  // Memory boundary: a newly persisted user message carrying a forged memory
  // reference is canonicalized to identity/version and the generic label; the
  // provider turn receives that marker plus the hydrated envelope built from
  // the authoritative stored row — never the forged wire fields. The
  // first-turn title input stays text-only: no forged label and no stored
  // memory content. Ordinary user prose stays verbatim on both paths.
  effectIt.effect(
    "hydrates the provider turn from the stored row, not the forged wire fields",
    () =>
      Effect.gen(function* () {
        const titleGenerated = yield* Deferred.make<void>();
        const sendStarted = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({ memoryGate: { driverKinds: codexDriverKinds() } }),
        );
        harness.generateThreadTitle.mockReturnValue(
          Deferred.succeed(titleGenerated, undefined).pipe(Effect.as({ title: "Generated title" })),
        );
        harness.sendTurn.mockImplementation(() =>
          Deferred.succeed(sendStarted, undefined).pipe(
            Effect.as({ threadId: ThreadId.make("thread-1"), turnId: asTurnId("turn-1") }),
          ),
        );
        const secretLabel = "SECRET-ROTATION-LABEL-7f3a";
        const secretBody = "SECRET-ROTATION-BODY-91c2";
        // The real stored row — the only content this send may hydrate — shares
        // nothing with the forged wire fields.
        expect(
          (yield* insertProjectMemory(harness, {
            memoryId: "mem-1",
            title: "Trusted stored title",
            body: "Trusted stored body",
          })).status,
        ).toBe("applied");
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-memory-reference"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-memory-reference"),
            role: "user",
            text: `Please summarize the rotation policy. [${secretLabel}](t3-context://v1/memory/mem-1)`,
            attachments: [],
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("mem-1"),
                  kind: "memory",
                  label: secretLabel,
                  payload: {
                    memoryId: "mem-1",
                    selectedVersion: 1,
                    title: secretBody,
                    body: secretBody,
                  },
                },
              ],
            },
          },
          titleSeed: "Thread",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        yield* Deferred.await(sendStarted);
        yield* Deferred.await(titleGenerated);
        const sendRequest = harness.sendTurn.mock.calls[0]?.[0] as unknown;
        const sendInput =
          typeof sendRequest === "object" &&
          sendRequest !== null &&
          "input" in sendRequest &&
          typeof sendRequest.input === "string"
            ? sendRequest.input
            : "";
        const titleInput = (harness.generateThreadTitle.mock.calls[0]?.[0] as { message?: string })
          ?.message as string;

        // Ordinary user prose survives verbatim on both paths.
        expect(sendInput).toContain("Please summarize the rotation policy.");
        expect(titleInput).toContain("Please summarize the rotation policy.");

        // The reference travels as the generic marker plus the hydrated
        // envelope from the authoritative stored row — the trusted stored
        // title/body/version exactly once, and nothing forged.
        expect(sendInput).toContain("[Memory: Project memory; ref=mem-1]");
        expect(sendInput).toContain(
          '<context kind="memory" id="mem-1">\n' +
            "memory: mem-1 v1 (fact)\n" +
            "title: Trusted stored title\n" +
            "Trusted stored body\n" +
            "</context>",
        );
        expect(sendInput.split("Trusted stored body")).toHaveLength(2);
        expect(sendInput).not.toContain(secretLabel);
        expect(sendInput).not.toContain(secretBody);
        expect(titleInput).toContain("Project memory");
        expect(titleInput).not.toContain(secretLabel);
        expect(titleInput).not.toContain(secretBody);
        // Stored memory content is provider-input only.
        expect(titleInput).not.toContain("Trusted stored title");
        expect(titleInput).not.toContain("Trusted stored body");
      }),
  );

  // Memory boundary (C3): a synthetic same-runtime boundary composition. The
  // real `thread.message.user.append` registers the message identity in the
  // running engine (the reuse predicate is real), then a plain SQL UPDATE gives
  // that same projection row the raw, pre-normalization content a legacy row
  // would hold. The reactor then reads the stored row — not the turn start's
  // command text — for the turn input, the first title input and the branch
  // input; each boundary normalizes the memory label, and the provider turn
  // alone gets the hydrated envelope from the authoritative stored row. This
  // is not historical event replay or a restart path: the engine's command
  // model holds only the placeholder while SQL holds the legacy-shaped
  // content; raw historical reuse semantics are covered separately by the
  // decider/projector tests. Title and branch inputs stay text-only — the
  // provider envelope's payloads must not ride along.
  effectIt.effect(
    "normalizes a reused legacy-shaped row at turn, title and branch boundaries",
    () =>
      Effect.gen(function* () {
        const titleGenerated = yield* Deferred.make<void>();
        const branchGenerated = yield* Deferred.make<void>();
        const sendStarted = yield* Deferred.make<void>();
        const threadId = ThreadId.make("thread-memory-old-row");
        const memoryRecord = {
          version: 1,
          contextId: "mem-1",
          kind: "memory",
          label: "SECRET-L",
          payload: { memoryId: "mem-1", selectedVersion: 1, title: "SECRET-T", body: "SECRET-B" },
        };
        const terminalRecord = {
          version: 1,
          contextId: "term-1",
          kind: "terminal",
          label: "build",
          terminalId: "term-1",
          terminalLabel: "Build",
          lineStart: 7,
          lineEnd: 7,
          text: "compiled successfully",
        };
        const rowText =
          "Please summarize the rotation policy. [SECRET-L](t3-context://v1/memory/mem-1) and inspect [build](t3-context://v1/terminal/term-1)";
        const harness = yield* Effect.promise(() =>
          createHarness({ memoryGate: { driverKinds: codexDriverKinds() } }),
        );
        harness.generateThreadTitle.mockReturnValue(
          Deferred.succeed(titleGenerated, undefined).pipe(Effect.as({ title: "Generated title" })),
        );
        harness.generateBranchName.mockReturnValue(
          Deferred.succeed(branchGenerated, undefined).pipe(
            Effect.as({ branch: "generated-branch-name" }),
          ),
        );
        harness.sendTurn.mockImplementation(() =>
          Deferred.succeed(sendStarted, undefined).pipe(
            Effect.as({ threadId, turnId: asTurnId("turn-memory-old-row") }),
          ),
        );
        // The authoritative stored row the send path hydrates from — trusted
        // content deliberately distinct from every forged field in the raw
        // legacy row below.
        expect(
          (yield* insertProjectMemory(harness, {
            memoryId: "mem-1",
            title: "Trusted stored title",
            body: "Trusted stored body",
          })).status,
        ).toBe("applied");

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-memory-old-row"),
          threadId,
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "t3code/abcd1234",
          worktreePath: "/tmp/provider-project-worktree",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        // The real append registers the user/null-turn message identity in the
        // engine's command model and SQL — without running canonicalization on
        // the secret fixture, which never crosses a command boundary.
        yield* harness.engine.dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make("cmd-append-memory-boundary-placeholder"),
          threadId,
          message: {
            messageId: MessageId.make("old-memory-message"),
            text: "Boundary fixture placeholder",
            attachments: [],
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        // UPDATE the row the append just wrote — same identity, role and null
        // turn — into the raw legacy-shaped content. No second row is created.
        yield* Effect.promise(() =>
          harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                UPDATE projection_thread_messages
                SET text = ${rowText},
                    context_json = ${JSON.stringify({
                      version: 1,
                      records: [memoryRecord, terminalRecord],
                    })}
                WHERE message_id = ${"old-memory-message"}
                  AND thread_id = ${"thread-memory-old-row"}
                  AND role = 'user'
                  AND turn_id IS NULL
              `;
            }),
          ),
        );

        // The UPDATE hit the intended row: still exactly one user/null-turn
        // row, now holding all three raw secret fields.
        const legacyRows = yield* Effect.promise(() =>
          harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                readonly role: string;
                readonly text: string;
                readonly contextJson: string | null;
                readonly turnId: string | null;
              }>`
                SELECT role, text, context_json AS "contextJson", turn_id AS "turnId"
                FROM projection_thread_messages
                WHERE message_id = ${"old-memory-message"}
              `;
            }),
          ),
        );
        expect(legacyRows).toHaveLength(1);
        expect(legacyRows[0]).toMatchObject({ role: "user", turnId: null });
        expect(legacyRows[0]?.text).toContain("SECRET-L");
        expect(legacyRows[0]?.contextJson).toContain("SECRET-T");
        expect(legacyRows[0]?.contextJson).toContain("SECRET-B");
        const sentSequenceRows = yield* Effect.promise(() =>
          harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly maxSequence: number | null }>`
                SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
                WHERE stream_id = ${threadId} AND event_type = 'thread.message-sent'
              `;
            }),
          ),
        );
        const sentSequence = sentSequenceRows[0]?.maxSequence ?? 0;

        // The reuse branch ignores this command message and reads the stored row.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-memory-old-row"),
          threadId,
          message: {
            messageId: MessageId.make("old-memory-message"),
            role: "user",
            text: "ignored by the reuse branch",
            attachments: [],
          },
          titleSeed: "Thread",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        });

        // The turn start requested a turn and no second message-sent was
        // written for this identity: the reuse branch ran, not a new message.
        const appended = yield* Effect.promise(() =>
          harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly eventType: string }>`
                SELECT event_type AS "eventType" FROM orchestration_events
                WHERE stream_id = ${threadId} AND sequence > ${sentSequence}
                ORDER BY sequence
              `;
            }),
          ),
        );
        expect(appended.map((row) => row.eventType)).toContain("thread.turn-start-requested");
        expect(appended.filter((row) => row.eventType === "thread.message-sent")).toEqual([]);

        yield* Deferred.await(sendStarted);
        yield* Deferred.await(titleGenerated);
        yield* Deferred.await(branchGenerated);
        const sendRequest = harness.sendTurn.mock.calls[0]?.[0] as unknown;
        const sendInput =
          typeof sendRequest === "object" &&
          sendRequest !== null &&
          "input" in sendRequest &&
          typeof sendRequest.input === "string"
            ? sendRequest.input
            : "";
        const titleInput = (harness.generateThreadTitle.mock.calls[0]?.[0] as { message?: string })
          ?.message as string;
        const branchInput = (harness.generateBranchName.mock.calls[0]?.[0] as { message?: string })
          ?.message as string;

        // Ordinary prose and the nonmemory link stay exactly as stored; the
        // turn start's own message text is never read — the stored row was.
        expect(sendInput).toContain("Please summarize the rotation policy.");
        expect(sendInput).toContain("[Terminal: build; ref=term-1]");
        expect(sendInput).toContain("compiled successfully");
        expect(titleInput).toContain("build");
        expect(branchInput).toContain("Please summarize the rotation policy.");
        for (const input of [sendInput, titleInput, branchInput]) {
          expect(input).not.toContain("ignored by the reuse branch");
        }

        // Every memory surface is the generic label; the secret label, payload
        // title and payload body never appear. The provider turn alone carries
        // the hydrated envelope from the authoritative stored row — the trusted
        // stored title/body/version exactly once.
        expect(sendInput).toContain("[Memory: Project memory; ref=mem-1]");
        expect(sendInput).toContain(
          '<context kind="memory" id="mem-1">\n' +
            "memory: mem-1 v1 (fact)\n" +
            "title: Trusted stored title\n" +
            "Trusted stored body\n" +
            "</context>",
        );
        expect(sendInput.split("Trusted stored body")).toHaveLength(2);
        for (const secret of ["SECRET-L", "SECRET-T", "SECRET-B"]) {
          expect(sendInput).not.toContain(secret);
          expect(titleInput).not.toContain(secret);
          expect(branchInput).not.toContain(secret);
        }
        expect(titleInput).toContain("Project memory");
        expect(branchInput).toContain("Project memory");
        // Stored memory content is provider-input only.
        for (const trusted of ["Trusted stored title", "Trusted stored body"]) {
          expect(titleInput).not.toContain(trusted);
          expect(branchInput).not.toContain(trusted);
        }
        // Text-only inputs: no provider envelope payload rides along.
        expect(titleInput).not.toContain("compiled successfully");
        expect(branchInput).not.toContain("compiled successfully");
      }),
  );

  // Red phase for memory P2 lane B (C3): the title regeneration input is built
  // from the stored messages, so a pre-normalization row's memory link label
  // must be normalized there too, without inheriting the provider envelope.
  effectIt.effect("normalizes memory labels in the title regeneration input for a stored row", () =>
    Effect.gen(function* () {
      const titleGenerated = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() => createHarness());
      harness.generateThreadTitle.mockReturnValue(
        Deferred.succeed(titleGenerated, undefined).pipe(Effect.as({ title: "Regenerated title" })),
      );
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-memory-regen"),
        threadId: ThreadId.make("thread-memory-regen"),
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
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, attachments_json, context_json,
                is_streaming, created_at, updated_at
              ) VALUES (
                ${"regen-memory-message"},
                ${"thread-memory-regen"},
                NULL,
                'user',
                ${"Please summarize the rotation policy. [SECRET-L](t3-context://v1/memory/mem-1) and inspect [build](t3-context://v1/terminal/term-1)"},
                '[]',
                ${JSON.stringify({
                  version: 1,
                  records: [
                    {
                      version: 1,
                      contextId: "mem-1",
                      kind: "memory",
                      label: "SECRET-L",
                      payload: {
                        memoryId: "mem-1",
                        selectedVersion: 1,
                        title: "SECRET-T",
                        body: "SECRET-B",
                      },
                    },
                    {
                      version: 1,
                      contextId: "term-1",
                      kind: "terminal",
                      label: "build",
                      terminalId: "term-1",
                      terminalLabel: "Build",
                      lineStart: 7,
                      lineEnd: 7,
                      text: "compiled successfully",
                    },
                  ],
                })},
                0,
                ${"2026-01-01T00:00:00.000Z"},
                ${"2026-01-01T00:00:00.000Z"}
              )
            `;
          }),
        ),
      );
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-meta-regenerate-memory"),
        threadId: ThreadId.make("thread-memory-regen"),
        regenerateTitle: true,
      });

      yield* Deferred.await(titleGenerated);
      const titleInput = (harness.generateThreadTitle.mock.calls[0]?.[0] as { message?: string })
        ?.message as string;

      // Ordinary prose and the nonmemory link label stay; the terminal payload
      // proves the title input did not reuse the provider envelope.
      expect(titleInput).toContain("Please summarize the rotation policy.");
      expect(titleInput).toContain("build");
      expect(titleInput).not.toContain("compiled successfully");
      expect(titleInput).toContain("Project memory");
      expect(titleInput).not.toContain("SECRET-L");
      expect(titleInput).not.toContain("SECRET-T");
      expect(titleInput).not.toContain("SECRET-B");
    }),
  );

  effectIt.effect("retains a turn dispatched immediately after start until activation", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const started = yield* Deferred.make<ProviderSession>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          serverActivation: Deferred.await(activation),
          startSessionEffect: (session) =>
            Deferred.succeed(started, session).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-activation"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-before-activation"),
          role: "user",
          text: "Start after activation",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(yield* Deferred.isDone(started)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      const session = yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());
      expect(session.threadId).toBe(ThreadId.make("thread-1"));
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        input: "Start after activation",
      });
    }),
  );

  effectIt.effect("starts a turn and generates its title without loading old message bodies", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const titleGenerated = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          unreadableHistory: true,
          startSessionEffect: (session) =>
            Deferred.succeed(started, undefined).pipe(Effect.as(session)),
        }),
      );
      harness.generateThreadTitle.mockReturnValue(
        Deferred.succeed(titleGenerated, undefined).pipe(Effect.as({ title: "Generated title" })),
      );
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-with-old-history"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-turn-start-with-old-history"),
          role: "user",
          text: "Use the current message",
          attachments: [],
        },
        titleSeed: "Thread",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Deferred.await(started);
      yield* Deferred.await(titleGenerated);
      yield* Effect.promise(() => harness.drain());

      expect(harness.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ input: "Use the current message" }),
      );
      expect(harness.generateThreadTitle).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Use the current message" }),
      );
    }),
  );

  effectIt.effect("rejects /compact without conversation context", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-empty-compact"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-empty-compact"),
          role: "user",
          text: "/compact",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.compactThread).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect.each(["resume", "stop before resume", "stop after send"])(
    "queues messages until compaction restores the session (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const stopBeforeResume = scenario === "stop before resume";
        const readyDispatchStarted = yield* Deferred.make<void>();
        const releaseReadyDispatch = yield* Deferred.make<void>();
        const firstSent = yield* Deferred.make<void>();
        const queuedSent = yield* Deferred.make<void>();
        const resumeStarted = yield* Deferred.make<void>();
        const releaseResume = yield* Deferred.make<void>();
        const resumeDispatched = yield* Deferred.make<void>();
        const queuedSendStarted = yield* Deferred.make<void>();
        const releaseQueuedSend = yield* Deferred.make<void>();
        let blockReadyDispatch = false;
        const harness = yield* Effect.promise(() =>
          createHarness({
            beforeTurnStartDispatch: () =>
              stopBeforeResume
                ? Deferred.succeed(resumeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseResume)),
                  )
                : Effect.void,
            afterTurnStartDispatch: () => Deferred.succeed(resumeDispatched, undefined),
            beforeReadySessionDispatch: () =>
              blockReadyDispatch
                ? Deferred.succeed(readyDispatchStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseReadyDispatch)),
                  )
                : Effect.void,
          }),
        );
        const threadId = ThreadId.make("thread-1");
        let sentCount = 0;
        harness.sendTurn.mockImplementation(() =>
          Effect.succeed({ threadId, turnId: asTurnId("turn-1") }).pipe(
            Effect.tap(() => {
              sentCount++;
              return sentCount === 1
                ? Deferred.succeed(firstSent, undefined)
                : sentCount === 2 && scenario === "stop after send"
                  ? Deferred.succeed(queuedSendStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseQueuedSend)),
                    )
                  : sentCount === 3
                    ? Deferred.succeed(queuedSent, undefined)
                    : Effect.void;
            }),
          ),
        );
        const now = "2026-01-01T00:00:00.000Z";
        const dispatchTurn = (id: string, text: string, createdAt: string) =>
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-${id}`),
            threadId,
            message: {
              messageId: asMessageId(`user-message-${id}`),
              role: "user",
              text,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          });

        yield* dispatchTurn("before-blocked-compact", "hello", now);
        yield* Deferred.await(firstSent);
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-ready-before-blocked-compact"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        blockReadyDispatch = true;
        yield* dispatchTurn("blocked-compact", "/compact", "2026-01-01T00:00:01.000Z");
        yield* Deferred.await(readyDispatchStarted);

        yield* harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-queued-mode-plan"),
          threadId,
          interactionMode: "plan",
          createdAt: now,
        });
        yield* dispatchTurn("during-compact-recovery", "first queued", "2026-01-01T00:00:02.000Z");
        yield* harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-queued-mode-default"),
          threadId,
          interactionMode: "default",
          createdAt: now,
        });
        yield* dispatchTurn(
          "during-compact-recovery-2",
          "second queued",
          "2026-01-01T00:00:03.000Z",
        );
        yield* Effect.promise(() => harness.drain());
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const beforeRestore = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          beforeRestore?.activities.filter(
            (activity) => activity.kind === "provider.turn.start.failed",
          ),
        ).toEqual([]);
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([
          { threadId: "thread-1" },
        ]);

        yield* Deferred.succeed(releaseReadyDispatch, undefined);
        if (scenario === "stop after send") {
          yield* Deferred.await(queuedSendStarted);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-after-queued-send"),
            threadId,
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* Effect.promise(() => harness.drain());
          const stoppedThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(stoppedThread?.session?.status).toBe("stopped");
          expect(
            stoppedThread?.activities.filter(
              (activity) => activity.summary === "Queued message was not sent",
            ),
          ).toEqual([
            expect.objectContaining({
              payload: {
                requestId: "user-message-during-compact-recovery-2",
                detail: expect.any(String),
              },
            }),
          ]);
          expect(harness.sendTurn).toHaveBeenCalledTimes(2);
          yield* Deferred.succeed(releaseQueuedSend, undefined);
          return;
        }
        if (stopBeforeResume) {
          yield* Deferred.await(resumeStarted);
          yield* dispatchTurn("compact-during-resume", "/compact", "2026-01-01T00:00:04.000Z");
          yield* Effect.promise(() => harness.drain());
          expect(harness.compactThread).toHaveBeenCalledTimes(1);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-before-queued-resume"),
            threadId,
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* Effect.promise(() => harness.drain());
          yield* Deferred.succeed(releaseResume, undefined);
          yield* Deferred.await(resumeDispatched);
          yield* Effect.promise(() => harness.drain());
          expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          const stoppedThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(stoppedThread?.session?.status).toBe("stopped");
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(
            stoppedThread?.activities.filter(
              (activity) => activity.summary === "Queued message was not sent",
            ),
          ).toHaveLength(2);
          return;
        }
        yield* Deferred.await(queuedSent);
        expect(harness.sendTurn.mock.calls.slice(1).map(([request]) => request)).toEqual([
          expect.objectContaining({ input: "first queued", interactionMode: "plan" }),
          expect.objectContaining({ input: "second queued", interactionMode: "default" }),
        ]);
        const afterRestore = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          afterRestore?.messages.filter((message) => message.text === "first queued"),
        ).toHaveLength(1);
        expect(
          afterRestore?.messages.filter((message) => message.text === "second queued"),
        ).toHaveLength(1);
      }),
  );

  effectIt.effect("does not overwrite concurrent session state after compaction failure", () => {
    const releaseCompaction = Deferred.makeUnsafe<void>();
    const releaseRunningCompaction = Deferred.makeUnsafe<void, ProviderAdapterRequestError>();
    const releaseFailedStop = Deferred.makeUnsafe<void>();
    const plannedConcurrentCompactionFailure = new ProviderAdapterRequestError({
      provider: "codex",
      method: "compactThread",
      detail: "planned concurrent compaction failure",
    });
    return Effect.gen(function* () {
      const compact1Entered = yield* Deferred.make<void>();
      const compact2Entered = yield* Deferred.make<void>();
      const phaseFiber1D = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const phaseFiber2D = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const providerStopEntered = yield* Deferred.make<void>();
      const compaction2FailureRecorded = yield* Deferred.make<void>();
      const messageCompactRunning = "user-message-compact-before-running";
      let compactionCount = 0;
      const harness = yield* Effect.promise(() =>
        createHarness({
          compactThreadEffect: () =>
            Effect.gen(function* () {
              const phaseFiber = yield* Effect.fiber;
              const index = compactionCount++;
              if (index === 0) {
                yield* Deferred.succeed(phaseFiber1D, phaseFiber);
                yield* Deferred.succeed(compact1Entered, undefined);
                yield* Deferred.await(releaseCompaction);
                return yield* Effect.die("Compaction stopped");
              }
              yield* Deferred.succeed(phaseFiber2D, phaseFiber);
              yield* Deferred.succeed(compact2Entered, undefined);
              yield* Deferred.await(releaseRunningCompaction);
              return yield* Effect.fail(plannedConcurrentCompactionFailure);
            }),
          stopSessionEffect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(providerStopEntered, undefined);
              yield* Deferred.await(releaseFailedStop);
              return yield* Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider stop failed",
                }),
              );
            }),
          afterCommand: (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "provider.turn.start.failed" &&
            command.activity.summary === "Context compaction failed" &&
            typeof command.activity.payload === "object" &&
            command.activity.payload !== null &&
            "requestId" in command.activity.payload &&
            command.activity.payload.requestId === messageCompactRunning &&
            "detail" in command.activity.payload &&
            command.activity.payload.detail === plannedConcurrentCompactionFailure.detail
              ? Deferred.succeed(compaction2FailureRecorded, undefined)
              : undefined,
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const now = "2026-01-01T00:00:00.000Z";
      const dispatchCompact = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-compact-${suffix}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-compact-${suffix}`),
            role: "user",
            text: "/compact",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-message-before-compact"),
        threadId,
        message: {
          messageId: asMessageId("user-message-before-compact"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-ready-before-compact"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* dispatchCompact("before-stop", now);
      yield* Deferred.await(compact1Entered);
      const compactingThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(compactingThread?.session?.status).toBe("starting");
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-queued-before-stop"),
        threadId,
        message: {
          messageId: asMessageId("user-message-queued-before-stop"),
          role: "user",
          text: "do not restart after stopping",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Effect.promise(() => harness.drain());
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-stop-during-compact"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Deferred.await(providerStopEntered);
      const phaseFiber1 = yield* Deferred.await(phaseFiber1D);
      const phase1ExitAtStop = phaseFiber1.pollUnsafe();
      expect(phase1ExitAtStop !== undefined && Exit.isFailure(phase1ExitAtStop)).toBe(true);
      if (phase1ExitAtStop !== undefined && Exit.isFailure(phase1ExitAtStop)) {
        expect(Cause.hasInterrupts(phase1ExitAtStop.cause)).toBe(true);
      }
      const phase1Exit = yield* Fiber.await(phaseFiber1);
      expect(Exit.isFailure(phase1Exit)).toBe(true);
      if (Exit.isFailure(phase1Exit)) {
        expect(Cause.hasInterrupts(phase1Exit.cause)).toBe(true);
      }
      const stoppingThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(stoppingThread?.session?.status).toBe("starting");
      expect(
        stoppingThread?.activities.some(
          (activity) => activity.summary === "Context compaction failed",
        ),
      ).toBe(false);
      yield* Deferred.succeed(releaseFailedStop, undefined);
      yield* Effect.promise(() => harness.drain());

      const recoveredThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(recoveredThread?.session?.status).toBe("ready");
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(
        recoveredThread?.activities.find(
          (activity) => activity.summary === "Queued message was not sent",
        ),
      ).toMatchObject({
        payload: { requestId: "user-message-queued-before-stop" },
      });
      expect(
        recoveredThread?.activities.find(
          (activity) => activity.kind === "provider.session.stop.failed",
        ),
      ).toMatchObject({
        summary: "Provider session stop failed",
        payload: { detail: "provider stop failed" },
      });

      yield* dispatchCompact("before-running", "2026-01-01T00:00:02.000Z");
      yield* Deferred.await(compact2Entered);
      const compactingAgain = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(compactingAgain?.session?.status).toBe("starting");
      const compactingSession = compactingAgain?.session;
      if (!compactingSession) {
        return yield* Effect.die(new Error("Compaction session missing"));
      }
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-during-compact"),
        threadId,
        session: {
          ...compactingSession,
          status: "running",
          activeTurnId: asTurnId("compaction-turn"),
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      const runningWhileParked = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(runningWhileParked?.session?.status).toBe("running");
      expect(Deferred.isDoneUnsafe(releaseRunningCompaction)).toBe(false);
      Deferred.doneUnsafe(
        releaseRunningCompaction,
        Effect.fail(plannedConcurrentCompactionFailure),
      );
      yield* Deferred.await(compaction2FailureRecorded);
      const phaseFiber2 = yield* Deferred.await(phaseFiber2D);
      const phase2Exit = yield* Fiber.await(phaseFiber2);
      expect(Exit.isSuccess(phase2Exit)).toBe(true);
      yield* Effect.promise(() => harness.drain());
      const runningThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(runningThread?.session?.status).toBe("running");
      expect(runningThread?.session?.status).not.toBe("ready");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
          Deferred.doneUnsafe(releaseFailedStop, Effect.succeed(undefined));
          if (!Deferred.isDoneUnsafe(releaseRunningCompaction)) {
            Deferred.doneUnsafe(
              releaseRunningCompaction,
              Effect.fail(plannedConcurrentCompactionFailure),
            );
          }
        }),
      ),
    );
  });
  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("shows the missing workspace message without a provider stack trace", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const missingCwd = "/missing/project/worktree";
      const missingWorkspace = new ProviderWorkspaceMissingError({
        threadId: ThreadId.make("thread-1"),
        cwd: missingCwd,
      });
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: () =>
            Deferred.succeed(attempted, undefined).pipe(
              Effect.andThen(Effect.fail(missingWorkspace)),
            ),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-workspace"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-workspace"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(attempted);
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: missingWorkspace.message,
      });
      const failure = thread?.activities.find(
        (activity) => activity.kind === "provider.turn.start.failed",
      );
      expect(failure?.payload).toMatchObject({ detail: missingWorkspace.message });
      expect(harness.runtimeSessions).toEqual([]);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  effectIt.effect.each(["before completion", "after completion", "before startup"] as const)(
    "refines a vague title once when initial generation finishes %s",
    (timing) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ deferReactorStart: timing === "before startup" }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("title-first-turn");
        const createdAt = "2026-01-01T00:00:01.000Z";
        harness.generateThreadTitle.mockReturnValue(
          Effect.succeed({ title: "Fix QR pairing expiry" }),
        );
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("title-turn"),
          threadId,
          message: {
            messageId: MessageId.make("title-user"),
            role: "user",
            text: "Fix this",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* Effect.promise(() => harness.drain());
        const generate = harness.engine.dispatch({
          type: "thread.title.generate.complete",
          commandId: CommandId.make("initial-title"),
          threadId,
          expectedTitle: "Thread",
          expectedVersion: null,
          title: "Investigate issue",
          needsRefinement: true,
        });
        if (timing !== "after completion") yield* generate;
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("title-running"),
          threadId,
          createdAt,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
        });
        yield* harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("title-answer"),
          threadId,
          messageId: MessageId.make("title-assistant"),
          turnId,
          delta: "The QR pairing token expires before the phone redeems it.",
          createdAt,
        });
        const ready = (commandId: string) =>
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(commandId),
            threadId,
            createdAt,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
          });
        yield* ready("title-ready");
        if (timing === "after completion") yield* generate;
        if (timing === "before startup") {
          yield* Effect.promise(harness.startReactor);
        }
        yield* Effect.promise(() => harness.drain());
        if (timing === "before startup") {
          expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
        }
        yield* ready("title-ready-again");
        yield* Effect.promise(() => harness.drain());
        expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
        expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toContain(
          "QR pairing token",
        );
        const thread = (yield* Effect.promise(() => harness.readModel())).threads[0];
        expect(thread?.title).toBe("Fix QR pairing expiry");
        expect(thread?.titleState?.needsRefinement).toBe(false);
      }),
  );

  effectIt.effect("does not replace a manual title matching the first message seed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = ThreadId.make("thread-1");
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("manual-title"),
        threadId,
        title: "Thread",
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("manual-title-turn"),
        threadId,
        titleSeed: "Thread",
        message: {
          messageId: MessageId.make("manual-title-user"),
          role: "user",
          text: "Fix this",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    }),
  );

  it("retries thread title generation after a transient failure", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    const harness = await createHarness({ initialTitle: seededTitle });
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Claude CLI request timed out.",
              }),
            )
          : Effect.succeed({ title: "Generated title" });
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
    expect(attempts).toBe(2);
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user message when regeneration context is truncated", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const quoteText = "界".repeat(1_000);
    const citation = serializeAssistantCitation({
      ...assistantCitation,
      text: quoteText,
      end: quoteText.length,
    });
    const firstUserMessage = `Review subagent monitoring risks. ${citation} ${"Opening context. ".repeat(200)}`;
    const recentUserMessage = `LATEST FINDING: ${"implementation detail ".repeat(320)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Review subagent monitoring risks" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing-long"),
        threadId: ThreadId.make("thread-1"),
        title: "Generic PR review",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-long-title-regeneration"),
          role: "user",
          text: firstUserMessage,
          attachments: [
            {
              type: "image",
              id: "opening-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-middle-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("middle-message-before-long-title-regeneration"),
          role: "user",
          text: "Temporary handoff details.",
          attachments: [
            {
              type: "image",
              id: "middle-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recent-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("recent-message-before-long-title-regeneration"),
          role: "user",
          text: recentUserMessage,
          attachments: [
            {
              type: "image",
              id: "recent-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-long"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const input = harness.generateThreadTitle.mock.calls[0]?.[0];
    if (!input) {
      throw new Error("Expected a title generation input");
    }
    const message = input.message;
    expect(message).toContain(
      `USER:\nReview subagent monitoring risks. ${quoteText.slice(0, 100)}`,
    );
    expect(message).not.toContain("t3-citation://");
    expect(message).toContain("[Content truncated]");
    expect(message).toContain("[Earlier content truncated]");
    expect(message).toContain("image.png");
    expect(message.length).toBeLessThanOrEqual(8_000);
    expect(input.attachments?.map((attachment) => attachment.id)).toEqual([
      "opening-context-image",
      "middle-context-image",
      "recent-context-image",
    ]);
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find(
          (entry) => entry.id === asMessageId("user-message-before-long-title-regeneration"),
        )?.text,
    ).toBe(firstUserMessage);
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("propagates mixed memory echo lookup cause through startup title recovery", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
      titleRegenerationCompletionDispatchFailures: 1,
      deferReactorStart: true,
    });
    const threadId = ThreadId.make("thread-1");
    const injected = new PersistenceSqlError({
      operation: "B5.echoLookup",
      detail: "B5-MIXED-TITLE-STARTUP-0d73e518",
    });
    const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
    harness.armEchoLookupFailure(threadId, mixedCause);

    let exit: Awaited<ReturnType<typeof harness.startReactorExit>>;
    try {
      exit = await harness.startReactorExit();
    } finally {
      harness.disarmEchoLookup();
      await harness.stopReactor();
    }

    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    if (Exit.isSuccess(exit)) {
      return expect.fail("startup title recovery must fail with the mixed lookup cause");
    }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(injected));
    const logText = harness.logs.map((log) => `${log.message}\n${log.cause}`).join("\n");
    expect(logText).not.toContain("B5-MIXED-TITLE-STARTUP-0d73e518");
  });

  it("propagates mixed memory echo lookup cause through the title regeneration worker", async () => {
    const TITLE_MARK = "B5-TITLE-MARK-f4e8a291";
    const MIXED_DETAIL = "B5-MIXED-TITLE-WORKER-0d73e518";
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    harness.generateThreadTitle.mockReturnValue(
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: TITLE_MARK,
        }),
      ),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-mixed-title-regeneration"),
        threadId,
        message: {
          messageId: asMessageId("user-message-before-mixed-title-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    const injected = new PersistenceSqlError({
      operation: "B5.echoLookup",
      detail: MIXED_DETAIL,
    });
    const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
    const observed = {
      type: "thread.meta-updated",
      exit: null as Exit.Exit<void, unknown> | null,
      done: Deferred.makeUnsafe<void>(),
    };
    workerObservation.armed = observed;
    harness.armEchoLookupFailure(threadId, mixedCause);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-mixed-lookup-regeneration"),
        threadId,
        regenerateTitle: true,
      }),
    );
    await harness.drain();
    await harness.runEffect(Deferred.await(observed.done));
    harness.disarmEchoLookup();
    workerObservation.armed = null;

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const exit = observed.exit;
    if (!exit || Exit.isSuccess(exit)) {
      return expect.fail("title regeneration worker must observe the mixed lookup cause");
    }
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(injected));
    const logText = harness.logs.map((log) => `${log.message}\n${log.cause}`).join("\n");
    expect(logText).not.toContain(TITLE_MARK);
    expect(logText).not.toContain(MIXED_DETAIL);
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user context and attachment before the retained tail", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserContext = "USER:\nOld visual issue\n[Attachments: old-issue.png]";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const context = harness.generateThreadTitle.mock.calls[0]?.[0].message;
    expect(context).toContain(firstUserContext);
    expect(context).toContain("ASSISTANT:\ncontent before retained tail");
    expect(context?.length).toBeLessThanOrEqual(8_000);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        id: "old-title-context-image",
        name: "old-issue.png",
      }),
    ]);
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    const harness = await createHarness({ initialTitle: seededTitle });
    const prompt = `[effort:high]\\n\\nFix reconnect spinner on resume ${serializeAssistantCitation(assistantCitation)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    const titleUpdated = await harness.runEffect(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.meta-updated" &&
            event.payload.title === "Reconnect spinner resume bug",
        ),
        Stream.take(1),
        Stream.toPull,
        Scope.provide(scope!),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: prompt,
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.runEffect(titleUpdated);
    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `[effort:high]\\n\\nFix reconnect spinner on resume ${assistantQuoteText}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).not.toContain("t3-citation://");
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
    expect(
      thread?.messages.find((entry) => entry.id === asMessageId("user-message-title-formatted"))
        ?.text,
    ).toBe(prompt);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: prompt });
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const prompt = `Add a safer reconnect backoff. ${serializeAssistantCitation(assistantCitation)}`;
    const statusRefreshed = await harness.runEffect(Deferred.make<void>());
    const refreshStatus = harness.refreshStatus.getMockImplementation()!;
    harness.refreshStatus.mockImplementation((cwd) =>
      refreshStatus(cwd).pipe(Effect.tap(() => Deferred.succeed(statusRefreshed, undefined))),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: prompt,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.runEffect(Deferred.await(statusRefreshed));
    await harness.drain();
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).toBe(
      `Add a safer reconnect backoff. ${assistantQuoteText}`,
    );
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).not.toContain("t3-citation://");
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find((entry) => entry.id === asMessageId("user-message-branch-model"))?.text,
    ).toBe(prompt);
  });

  it("recreates a missing worktree from the thread branch before starting a turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const worktreePath = NodePath.join(harness.stateDir, "missing-worktree");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/restore",
        worktreePath,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-worktree"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-project" });
    expect(harness.createWorktree).toHaveBeenCalledWith(
      {
        cwd: "/tmp/provider-project",
        refName: "feature/restore",
        path: worktreePath,
      },
      { submodules: null },
    );
    expect(harness.createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startSession.mock.invocationCallOrder[0]!,
    );
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  effectIt.effect(
    "stops a running session and records the failure when provider interrupt fails",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            interruptTurnEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            stopSessionEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider process already exited",
                }),
              ),
          }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-interrupt-failure"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-provider-failure"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const thread = (await harness.readModel()).threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return thread?.session?.status === "stopped";
          }),
        );

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: "provider session disappeared",
        });
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
        ).toMatchObject({
          summary: "Provider turn interrupt failed",
          payload: { detail: "provider session disappeared" },
        });
        expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      }),
  );

  effectIt.effect("stops a starting session without a bound turn when interrupt fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          interruptTurnEffect: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.interrupt",
                detail: "provider session disappeared",
              }),
            ),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-starting"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-starting-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
        lastError: "provider session disappeared",
      });
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toMatchObject({ payload: { detail: "provider session disappeared" } });
    }),
  );

  effectIt.effect("does not overwrite a session that became ready while an interrupt failed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      const completedAt = "2026-01-01T00:00:01.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      harness.interruptTurn.mockImplementation(() =>
        harness.engine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-natural-completion"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          })
          .pipe(
            Effect.catchCause((cause) => Effect.die(cause)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            ),
          ),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toBe(false);
    }),
  );

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("forwards approval responses without reading unrelated message bodies", async () => {
    const harness = await createHarness({ unreadableHistory: true });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("forwards user input answers without reading unrelated message bodies", async () => {
    const harness = await createHarness({ unreadableHistory: true });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("normalizes stale Codex approval callbacks without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/requestApproval/decision",
          detail: "Unknown pending Codex approval request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  effectIt.effect("stops a provider session without reading unrelated message bodies", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ unreadableHistory: true }));
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      const thread = yield* harness.snapshotQuery
        .getThreadShellById(ThreadId.make("thread-1"))
        .pipe(Effect.map(Option.getOrThrow));
      expect(thread.session).not.toBeNull();
      expect(thread.session?.status).toBe("stopped");
      expect(thread.session?.threadId).toBe("thread-1");
      expect(thread.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
      expect(thread.session?.activeTurnId).toBeNull();
    }),
  );

  effectIt.effect("stops a ready provider session after automatic settlement", () =>
    Effect.gen(function* () {
      const sessionStopped = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          stopSessionEffect: () => Deferred.succeed(sessionStopped, undefined).pipe(Effect.asVoid),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-auto-settle"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const beforeSettlement = yield* Effect.promise(() => harness.readModel());

      yield* harness.engine.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto-settle-with-session"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: beforeSettlement.snapshotSequence,
        settledAt: now,
      });

      yield* Deferred.await(sessionStopped);
      yield* Effect.promise(() => harness.drain());
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.settledOverride).toBe("settled");
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
      expect(harness.closeIdleTerminals).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
      });
    }),
  );

  effectIt.effect("closes idle terminals when a thread without a session settles", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const terminalsClosed = yield* Deferred.make<void>();
      harness.closeIdleTerminals.mockImplementation(() =>
        Deferred.succeed(terminalsClosed, undefined).pipe(Effect.asVoid),
      );

      yield* harness.engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd-settle-without-session"),
        threadId: ThreadId.make("thread-1"),
      });
      yield* Deferred.await(terminalsClosed);
      yield* Effect.promise(() => harness.drain());

      expect(harness.closeIdleTerminals).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "keeps terminals when the thread is un-settled before its settle event runs",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const threadId = ThreadId.make("thread-1");
        const firstCloseStarted = yield* Deferred.make<void>();
        const releaseFirstClose = yield* Deferred.make<void>();
        harness.closeIdleTerminals.mockImplementationOnce(() =>
          Deferred.succeed(firstCloseStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstClose)),
          ),
        );

        yield* harness.engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-first"),
          threadId,
        });
        // The reactor is busy with the first settle while the user changes their mind.
        yield* Deferred.await(firstCloseStarted);
        yield* harness.engine.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-first"),
          threadId,
          reason: "user",
        });
        yield* harness.engine.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-second"),
          threadId,
        });
        yield* harness.engine.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-second"),
          threadId,
          reason: "user",
        });
        yield* Deferred.succeed(releaseFirstClose, undefined);
        yield* Effect.promise(() => harness.drain());

        expect(harness.closeIdleTerminals).toHaveBeenCalledTimes(1);
      }),
  );

  const memoryNow = "2026-01-01T00:00:00.000Z";
  type MemoryHarness = Awaited<ReturnType<typeof createHarness>>;

  const codexDriverKinds = (): ReadonlySet<ProviderDriverKind> =>
    new Set([ProviderDriverKind.make("codex")]);

  const asMemoryId = (value: string): ProjectMemoryId => ProjectMemoryId.make(value);

  const insertProjectMemory = (
    harness: MemoryHarness,
    input: { readonly memoryId: string; readonly title: string; readonly body: string },
  ) =>
    Effect.promise(() =>
      harness.runEffect(
        harness.memoryRepository.insert({
          memoryId: asMemoryId(input.memoryId),
          projectId: asProjectId("project-1"),
          kind: "fact",
          title: input.title,
          body: input.body,
          origin: { type: "manual" },
          validUntil: null,
          estimatedTokens: 0,
          now: memoryNow,
        }),
      ),
    );

  // M1 reactor slice: real SQLite (migrations 056/057), real send ledger, real
  // gate, real engine and projection, mock ProviderService. The injected
  // driver policy reaches the constructed gate through
  // Layer.succeed(ProjectMemorySendPolicy, ...). Parked boundaries wrap the
  // real gate and only ever wait after the real call already produced its
  // result, so every commit, hold and settle below is the production path.
  describe("project memory send gate", () => {
    const memoryChip = (contextId: string, memoryId: string, selectedVersion = 1) => ({
      version: 1 as const,
      contextId: ComposerContextId.make(contextId),
      kind: "memory",
      label: "Project memory",
      payload: { memoryId, selectedVersion },
    });

    // Seeds affected state through the real 057 trigger: a committed attempt
    // plus item row, then a real repository update that fires the trigger.
    const seedAffectedRows = (harness: MemoryHarness, memoryId: string) =>
      harness.runSqlEffect(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO project_memory_send_attempts (
              thread_id, message_id, project_id, provider_instance_id,
              owner_instance_id, state, committed_at
            )
            VALUES (
              ${"thread-1"}, ${"affected-seed-message"}, ${"project-1"}, ${"codex"},
              ${"affected-seed-owner"}, 'provider_accepted', ${memoryNow}
            )
          `;
          yield* sql`
            INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
            SELECT attempt_seq, ${memoryId}, 1
            FROM project_memory_send_attempts
            WHERE thread_id = ${"thread-1"} AND message_id = ${"affected-seed-message"}
          `;
        }),
      );

    const changeUsedMemory = (harness: MemoryHarness, memoryId: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          harness.runEffect(
            harness.memoryRepository.update({
              projectId: asProjectId("project-1"),
              memoryId: asMemoryId(memoryId),
              expectedVersion: 1,
              title: "Updated memory",
              body: "Updated body",
              kind: "fact",
              validUntil: null,
              estimatedTokens: 0,
              now: "2026-01-01T00:00:02.000Z",
            }),
          ),
        );
        expect(result.status).toBe("applied");
        expect(yield* affectedRowCount(harness)).toBe(1);
      });

    const dispatchMemoryTurn = (
      harness: MemoryHarness,
      input: {
        readonly commandId: string;
        readonly messageId: string;
        readonly text: string;
        readonly threadId?: ThreadId;
        readonly records?: ReadonlyArray<ComposerContextRecord>;
        readonly titleSeed?: string;
      },
    ) =>
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(input.commandId),
        threadId: input.threadId ?? ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId(input.messageId),
          role: "user",
          text: input.text,
          attachments: [],
          ...(input.records === undefined
            ? {}
            : { context: { version: 1 as const, records: input.records } }),
        },
        ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: memoryNow,
      });

    const threadOf = async (harness: MemoryHarness) =>
      (await harness.readModel()).threads.find((thread) => thread.id === ThreadId.make("thread-1"));

    const failureActivitiesOf = (
      thread: Awaited<ReturnType<MemoryHarness["readModel"]>>["threads"][number] | undefined,
    ) =>
      (thread?.activities ?? []).filter(
        (activity) => activity.kind === "provider.turn.start.failed",
      );

    const waitForSendAttemptState = (harness: MemoryHarness, state: string) =>
      Effect.promise(() =>
        waitFor(async () => {
          const rows = await harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly state: string }>`
                SELECT state FROM project_memory_send_attempts ORDER BY attempt_seq
              `;
            }),
          );
          return rows.length === 1 && rows[0]?.state === state;
        }),
      );

    const sendAttemptStates = (harness: MemoryHarness) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly state: string }>`
              SELECT state FROM project_memory_send_attempts ORDER BY attempt_seq
            `;
          }),
        ),
      );

    const sendItemRows = (harness: MemoryHarness) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly memoryId: string; readonly memoryVersion: number }>`
              SELECT memory_id AS "memoryId", memory_version AS "memoryVersion"
              FROM project_memory_send_items
              ORDER BY attempt_seq, memory_id
            `;
          }),
        ),
      );

    const affectedRowCount = (harness: MemoryHarness) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly total: number }>`
              SELECT COUNT(*) AS total FROM project_memory_affected
              WHERE thread_id = ${"thread-1"}
            `;
            return rows[0]?.total ?? 0;
          }),
        ),
      );

    const sessionSetEventCount = (harness: MemoryHarness) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly total: number }>`
              SELECT COUNT(*) AS total FROM orchestration_events
              WHERE stream_id = ${"thread-1"} AND event_type = 'thread.session-set'
            `;
            return rows[0]?.total ?? 0;
          }),
        ),
      );

    const MEMORY_FAILURE_COMMAND_PREFIX = "server:memory-turn-start-failure";

    const memoryFailureSessionSetRows = (
      harness: MemoryHarness,
      threadId = ThreadId.make("thread-1"),
    ) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly sequence: number; readonly status: string }>`
              SELECT
                sequence,
                json_extract(payload_json, '$.session.status') AS status
              FROM orchestration_events
              WHERE stream_id = ${threadId}
                AND event_type = 'thread.session-set'
                AND command_id LIKE ${`${MEMORY_FAILURE_COMMAND_PREFIX}:%`}
              ORDER BY sequence ASC
            `;
          }),
        ),
      );

    const threadEventPayloads = (harness: MemoryHarness, threadId = ThreadId.make("thread-1")) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly payloadJson: string }>`
              SELECT payload_json AS "payloadJson"
              FROM orchestration_events
              WHERE stream_id = ${threadId}
            `;
          }),
        ),
      );

    const threadMessageRows = (harness: MemoryHarness, threadId = ThreadId.make("thread-1")) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly text: string; readonly contextJson: string | null }>`
              SELECT text, context_json AS "contextJson"
              FROM projection_thread_messages
              WHERE thread_id = ${threadId}
            `;
          }),
        ),
      );

    type ReactorCommand = Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0];

    // Matches the internal memory failure compound command. The wrapped engine
    // only reaches the afterCommand tap after the real dispatch committed its
    // events through the synchronous projection transaction — a receipt, not a
    // poll.
    const isMemoryFailureReport = (
      command: ReactorCommand,
      requestId: string,
      detail?: string,
    ): boolean =>
      command.type === "thread.turn.start.fail" &&
      command.messageId === asMessageId(requestId) &&
      (detail === undefined || command.detail === detail);

    const isFailureActivityAppend = (
      command: ReactorCommand,
      requestId: string,
      detail?: string,
    ): boolean =>
      command.type === "thread.activity.append" &&
      command.activity.kind === "provider.turn.start.failed" &&
      typeof command.activity.payload === "object" &&
      command.activity.payload !== null &&
      "requestId" in command.activity.payload &&
      command.activity.payload.requestId === requestId &&
      (detail === undefined ||
        ("detail" in command.activity.payload && command.activity.payload.detail === detail));

    // Memory holds use thread.turn.start.fail; cancelTurnsAfterCompaction and
    // stop/interrupt paths still use thread.activity.append (see product).
    const isTurnStartFailureReceipt = (
      command: ReactorCommand,
      requestId: string,
      input?: { readonly detail?: string; readonly summary?: string },
    ): boolean =>
      isMemoryFailureReport(command, requestId, input?.detail) ||
      (command.type === "thread.activity.append" &&
        command.activity.kind === "provider.turn.start.failed" &&
        (input?.summary === undefined || command.activity.summary === input.summary) &&
        isFailureActivityAppend(command, requestId, input?.detail));

    const readySessionSetEventCount = (harness: MemoryHarness) =>
      Effect.promise(() =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly total: number }>`
              SELECT COUNT(*) AS total FROM orchestration_events
              WHERE stream_id = ${"thread-1"}
                AND event_type = 'thread.session-set'
                AND payload_json LIKE '%"status":"ready"%'
            `;
            return rows[0]?.total ?? 0;
          }),
        ),
      );

    const activityPayloadRequestId = (payload: unknown): string | undefined => {
      if (typeof payload !== "object" || payload === null || !("requestId" in payload)) {
        return undefined;
      }
      const requestId = payload.requestId;
      return typeof requestId === "string" ? requestId : undefined;
    };

    const serializedLogs = (harness: MemoryHarness) =>
      harness.logs.map((entry) => `${entry.level}|${entry.message}|${entry.cause}`).join("\n");

    const sendInputOf = (harness: MemoryHarness, call = 0): string => {
      const request = harness.sendTurn.mock.calls[call]?.[0] as unknown;
      return typeof request === "object" &&
        request !== null &&
        "input" in request &&
        typeof request.input === "string"
        ? request.input
        : "";
    };

    effectIt.effect(
      "R1: an allowed chip hydrates the send input once and leaks no secret into derived copies",
      () =>
        Effect.gen(function* () {
          const secretTitle = "SECRET-T-R1";
          const secretBody = "SECRET-B-R1";
          const titleGenerated = yield* Deferred.make<void>();
          const branchGenerated = yield* Deferred.make<void>();
          const sendStarted = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({ memoryGate: { driverKinds: codexDriverKinds() } }),
          );
          harness.generateThreadTitle.mockReturnValue(
            Deferred.succeed(titleGenerated, undefined).pipe(
              Effect.as({ title: "Generated title" }),
            ),
          );
          harness.generateBranchName.mockReturnValue(
            Deferred.succeed(branchGenerated, undefined).pipe(
              Effect.as({ branch: "generated-branch-r1" }),
            ),
          );
          const threadId = ThreadId.make("thread-memory-send-r1");
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(sendStarted, undefined).pipe(
              Effect.as({ threadId, turnId: asTurnId("turn-r1") }),
            ),
          );
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-memory-r1"),
            threadId,
            projectId: asProjectId("project-1"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "t3code/a1abcd12",
            worktreePath: "/tmp/provider-project-worktree-r1",
            createdAt: memoryNow,
          });
          const outcome = yield* insertProjectMemory(harness, {
            memoryId: "mem-r1",
            title: secretTitle,
            body: secretBody,
          });
          expect(outcome.status).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-memory-r1",
            messageId: "message-r1",
            text: "Please summarize the rotation policy. [Project memory](t3-context://v1/memory/mem-r1)",
            threadId,
            records: [memoryChip("mem-r1", "mem-r1")],
            titleSeed: "Thread",
          });
          yield* Deferred.await(sendStarted);
          yield* Deferred.await(titleGenerated);
          yield* Deferred.await(branchGenerated);
          yield* Effect.promise(() => harness.drain());

          const sendInput = sendInputOf(harness);
          expect(sendInput).toContain("Please summarize the rotation policy.");
          expect(sendInput).toContain("[Memory: Project memory; ref=mem-r1]");
          expect(sendInput).not.toContain('id="mem-r1" unavailable');
          expect(sendInput.split(secretBody)).toHaveLength(2);
          const titleInput = (
            harness.generateThreadTitle.mock.calls[0]?.[0] as { message?: string }
          )?.message as string;
          const branchInput = (
            harness.generateBranchName.mock.calls[0]?.[0] as { message?: string }
          )?.message as string;

          // The source project_memories row is the one place the secret lives;
          // every derived copy — commands, events, messages, activity, session,
          // logs, title and branch inputs — must be clean.
          const stored = Option.getOrUndefined(
            yield* Effect.promise(() =>
              harness.runEffect(
                harness.memoryRepository.getById({
                  projectId: asProjectId("project-1"),
                  memoryId: asMemoryId("mem-r1"),
                }),
              ),
            ),
          );
          expect(stored?.title).toBe(secretTitle);
          expect(stored?.body).toBe(secretBody);
          const eventPayloads = yield* threadEventPayloads(harness, threadId);
          const messageRows = yield* threadMessageRows(harness, threadId);
          // These queries target the custom thread — prove they found the real
          // turn request and message row before scanning them for secrets.
          expect(eventPayloads.length).toBeGreaterThan(0);
          expect(eventPayloads.some((row) => row.payloadJson.includes("message-r1"))).toBe(true);
          expect(messageRows.length).toBeGreaterThan(0);
          expect(
            messageRows.some((row) => row.text.includes("Please summarize the rotation policy.")),
          ).toBe(true);
          const derivedCopies = [
            serializedLogs(harness),
            eventPayloads.map((row) => row.payloadJson).join("\n"),
            messageRows.map((row) => `${row.text}\n${row.contextJson ?? ""}`).join("\n"),
            JSON.stringify(
              (yield* Effect.promise(() => harness.readModel())).threads.find(
                (thread) => thread.id === threadId,
              ),
            ),
            titleInput,
            branchInput,
          ];
          for (const copy of derivedCopies) {
            expect(copy).not.toContain(secretTitle);
            expect(copy).not.toContain(secretBody);
          }

          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          expect(yield* sendItemRows(harness)).toEqual([{ memoryId: "mem-r1", memoryVersion: 1 }]);
        }),
    );

    effectIt.effect("R2: a memoryless turn sends a byte-identical pre-M1 provider input", () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() => createHarness());
        harness.sendTurn.mockImplementation(() =>
          Deferred.succeed(sent, undefined).pipe(
            Effect.as({ threadId: ThreadId.make("thread-1"), turnId: asTurnId("turn-r2") }),
          ),
        );
        const text = "Inspect [build](t3-context://v1/terminal/term-r2) then summarize";
        const records: ReadonlyArray<ComposerContextRecord> = [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("term-r2"),
            kind: "terminal",
            label: "build",
            terminalId: "term-r2",
            terminalLabel: "Build",
            lineStart: 7,
            lineEnd: 7,
            text: "compiled successfully",
          },
        ];
        yield* dispatchMemoryTurn(harness, {
          commandId: "cmd-turn-memoryless-r2",
          messageId: "message-r2",
          text,
          records,
        });
        yield* Deferred.await(sent);
        yield* Effect.promise(() => harness.drain());

        expect(sendInputOf(harness)).toBe(
          projectComposerContextForProvider({
            text,
            records,
          }),
        );
        expect(yield* sendAttemptStates(harness)).toEqual([]);
      }),
    );

    effectIt.effect("R3: the empty product policy holds a chip turn before any session work", () =>
      Effect.gen(function* () {
        const r3Held = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({
            memoryGate: { driverKinds: new Set<ProviderDriverKind>() },
            afterCommand: (command) =>
              isMemoryFailureReport(command, "message-r3", MEMORY_SEND_HOLD_DETAIL["not-supported"])
                ? Deferred.succeed(r3Held, undefined)
                : undefined,
          }),
        );
        expect(
          (yield* insertProjectMemory(harness, {
            memoryId: "mem-r3",
            title: "T3",
            body: "B3",
          })).status,
        ).toBe("applied");

        yield* dispatchMemoryTurn(harness, {
          commandId: "cmd-turn-chip-r3",
          messageId: "message-r3",
          text: "Summarize [Project memory](t3-context://v1/memory/mem-r3)",
          records: [memoryChip("mem-r3", "mem-r3")],
        });
        yield* Deferred.await(r3Held);
        yield* Effect.promise(() => harness.drain());

        const thread = yield* Effect.promise(() => threadOf(harness));
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(yield* sendAttemptStates(harness)).toEqual([]);
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        expect(yield* sessionSetEventCount(harness)).toBe(0);
        expect(thread?.session).toBeNull();
        expect(failureActivitiesOf(thread)).toEqual([
          expect.objectContaining({
            summary: "Message not sent",
            payload: {
              requestId: "message-r3",
              detail: MEMORY_SEND_HOLD_DETAIL["not-supported"],
            },
          }),
        ]);
      }),
    );

    effectIt.effect(
      "R4: persisted affected state holds even memoryless turns until the ledger acknowledges",
      () =>
        Effect.gen(function* () {
          const r4Held = yield* Deferred.make<void>();
          const sent = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              afterCommand: (command) =>
                isMemoryFailureReport(
                  command,
                  "message-r4-held",
                  MEMORY_SEND_HOLD_DETAIL["affected"],
                )
                  ? Deferred.succeed(r4Held, undefined)
                  : undefined,
            }),
          );
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(sent, undefined).pipe(
              Effect.as({ threadId: ThreadId.make("thread-1"), turnId: asTurnId("turn-r4") }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r4",
              title: "T4",
              body: "B4",
            })).status,
          ).toBe("applied");
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-r4"));
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: asMemoryId("mem-r4"),
                expectedVersion: 1,
                title: "T4 updated",
                body: "B4 updated",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:01.000Z",
              }),
            ),
          );
          expect(yield* affectedRowCount(harness)).toBe(1);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-affected-r4",
            messageId: "message-r4-held",
            text: "plain turn onto affected state",
          });
          yield* Deferred.await(r4Held);
          yield* Effect.promise(() => harness.drain());

          expect(harness.startSession).not.toHaveBeenCalled();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);

          const affected = yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.affectedState({
                threadId: ThreadId.make("thread-1"),
                limit: 1,
              }),
            ),
          );
          expect(affected.held).toBe(true);
          expect(affected.latestChangeSeq).not.toBeNull();
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.acknowledge({
                threadId: ThreadId.make("thread-1"),
                throughChangeSeq: affected.latestChangeSeq ?? 0,
              }),
            ),
          );

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-acknowledged-r4",
            messageId: "message-r4-sent",
            text: "plain turn after acknowledge",
          });
          yield* Deferred.await(sent);
        }),
    );

    effectIt.effect(
      "R5: a failed affected-state read holds with the fixed store-failed wording and no SQL cause",
      () =>
        Effect.gen(function* () {
          const r5Failed = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              afterCommand: (command) =>
                isMemoryFailureReport(
                  command,
                  "message-r5",
                  MEMORY_SEND_HOLD_DETAIL["store-failed"],
                )
                  ? Deferred.succeed(r5Failed, undefined)
                  : undefined,
            }),
          );
          yield* Effect.promise(() =>
            harness.runSqlEffect(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql`ALTER TABLE project_memory_affected RENAME TO project_memory_affected_moved`;
              }),
            ),
          );

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-store-failed-r5",
            messageId: "message-r5",
            text: "plain turn against a broken ledger read",
          });
          // The dispatch receipt can return before the domain-event
          // subscription has enqueued the turn for the worker; the persisted
          // activity append is the receipt that the held report landed.
          yield* Deferred.await(r5Failed);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.startSession).not.toHaveBeenCalled();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              payload: {
                requestId: "message-r5",
                detail: MEMORY_SEND_HOLD_DETAIL["store-failed"],
              },
            }),
          ]);
          const logged = serializedLogs(harness).toLowerCase();
          expect(logged).not.toContain("project_memory_affected");
          expect(logged).not.toContain("no such table");
        }),
    );

    effectIt.effect(
      "R6: a memory deleted behind a paused session start holds without sending and restores ready once",
      () => {
        const startReleased = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const startEntered = yield* Deferred.make<void>();
          const r6Held = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              startSessionEffect: (session) =>
                Deferred.succeed(startEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(startReleased)),
                  Effect.as(session),
                ),
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-r6", MEMORY_SEND_HOLD_DETAIL["unavailable"])
                  ? Deferred.succeed(r6Held, undefined)
                  : undefined,
            }),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r6",
              title: "T6",
              body: "B6",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r6",
            messageId: "message-r6",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r6)",
            records: [memoryChip("mem-r6", "mem-r6")],
          });
          yield* Deferred.await(startEntered);
          expect(
            (yield* Effect.promise(() =>
              harness.runEffect(
                harness.memoryRepository.delete({
                  projectId: asProjectId("project-1"),
                  memoryId: asMemoryId("mem-r6"),
                  expectedVersion: 1,
                }),
              ),
            )).status,
          ).toBe("applied");
          yield* Deferred.succeed(startReleased, undefined);

          yield* Deferred.await(r6Held);
          yield* Effect.promise(() => harness.drain());

          const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([]);
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([
            expect.objectContaining({ status: "ready" }),
          ]);
          expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(startReleased, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "R6′: a quiet thread held at L2 restores ready once with no provider send",
      () =>
        Effect.gen(function* () {
          const l2Parked = yield* Deferred.make<void>();
          const releaseL2 = yield* Deferred.make<void>();
          const heldReported = yield* Deferred.make<void>();
          const seedSent = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              parkGetInstanceInfo: {
                call: 4,
                parked: l2Parked,
                release: releaseL2,
              },
              afterCommand: (command) =>
                isMemoryFailureReport(
                  command,
                  "message-r6-prime",
                  MEMORY_SEND_HOLD_DETAIL.unavailable,
                )
                  ? Deferred.succeed(heldReported, undefined)
                  : undefined,
            }),
          );
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(seedSent, undefined).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId("turn-r6-prime-seed"),
              }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r6-prime",
              title: "T6p",
              body: "B6p",
            })).status,
          ).toBe("applied");

          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-turn-seed-r6-prime"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: asMessageId("message-r6-prime-seed"),
              role: "user",
              text: "seed conversation",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: memoryNow,
          });
          yield* Deferred.await(seedSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r6-prime"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          const readySetsBefore = yield* readySessionSetEventCount(harness);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r6-prime",
            messageId: "message-r6-prime",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r6-prime)",
            records: [memoryChip("mem-r6-prime", "mem-r6-prime")],
          });
          yield* Deferred.await(l2Parked);
          expect(
            (yield* Effect.promise(() =>
              harness.runEffect(
                harness.memoryRepository.delete({
                  projectId: asProjectId("project-1"),
                  memoryId: asMemoryId("mem-r6-prime"),
                  expectedVersion: 1,
                }),
              ),
            )).status,
          ).toBe("applied");
          yield* Deferred.succeed(releaseL2, undefined);
          yield* Deferred.await(heldReported);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          expect(yield* readySessionSetEventCount(harness)).toBe(readySetsBefore + 1);
          expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              payload: {
                requestId: "message-r6-prime",
                detail: MEMORY_SEND_HOLD_DETAIL.unavailable,
              },
            }),
          ]);
        }),
    );

    effectIt.effect(
      "R6n: meta.update during an L3 hold keeps starting and reports with requestId",
      () => {
        const releaseHold = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const holdParked = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const heldReported = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkThreadHoldAtCall: {
                  call: 2,
                  timing: "before",
                  parked: holdParked,
                  release: releaseHold,
                  capture: sendFiber,
                },
              },
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-r6n", MEMORY_SEND_HOLD_DETAIL["affected"])
                  ? Deferred.succeed(heldReported, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r6n",
              title: "T6n",
              body: "B6n",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r6n",
            messageId: "message-r6n",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r6n)",
            records: [memoryChip("mem-r6n", "mem-r6n")],
          });
          yield* Deferred.await(holdParked);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
          yield* harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-meta-r6n"),
            threadId: ThreadId.make("thread-1"),
            title: "Renamed during hold",
          });
          yield* changeUsedMemory(harness, "mem-r6n");
          yield* Deferred.succeed(releaseHold, undefined);
          yield* Fiber.await(yield* Deferred.await(sendFiber));
          yield* Deferred.await(heldReported);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([]);
          expect(thread?.session).toMatchObject({ status: "starting", lastError: null });
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              payload: {
                requestId: "message-r6n",
                detail: MEMORY_SEND_HOLD_DETAIL["affected"],
              },
            }),
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(releaseHold, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "R7: deleting the memory after a real commit holds at L3 and settles the attempt unknown",
      () => {
        const releaseAdmit = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const admitParked = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkAdmitAfterCommit: {
                  parked: admitParked,
                  release: releaseAdmit,
                  capture: sendFiber,
                },
              },
            }),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r7",
              title: "T7",
              body: "B7",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r7",
            messageId: "message-r7",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r7)",
            records: [memoryChip("mem-r7", "mem-r7")],
          });
          yield* Deferred.await(admitParked);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);

          expect(
            (yield* Effect.promise(() =>
              harness.runEffect(
                harness.memoryRepository.delete({
                  projectId: asProjectId("project-1"),
                  memoryId: asMemoryId("mem-r7"),
                  expectedVersion: 1,
                }),
              ),
            )).status,
          ).toBe("applied");
          expect(yield* affectedRowCount(harness)).toBe(1);
          yield* Deferred.succeed(releaseAdmit, undefined);

          // The send fiber's own exit is the receipt: the L3 report and the
          // durable settle are both committed before it terminates.
          yield* Fiber.await(yield* Deferred.await(sendFiber));
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          expect(yield* affectedRowCount(harness)).toBe(1);
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([
            expect.objectContaining({ status: "ready" }),
          ]);
          expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              payload: { requestId: "message-r7", detail: MEMORY_SEND_HOLD_DETAIL["affected"] },
            }),
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(releaseAdmit, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "R8: a committed chip whose hydrated input exceeds the provider limit holds too-large unknown",
      () =>
        Effect.gen(function* () {
          const admitParked = yield* Deferred.make<void>();
          const releaseAdmit = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkAdmitAfterCommit: {
                  parked: admitParked,
                  release: releaseAdmit,
                  capture: sendFiber,
                },
              },
            }),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r8",
              title: "T8",
              body: `SECRET-B-R8${"x".repeat(30_000)}`,
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r8",
            messageId: "message-r8",
            text: `${"a".repeat(61_000)} [Project memory](t3-context://v1/memory/mem-r8) [Project memory](t3-context://v1/memory/mem-r8-second)`,
            records: [memoryChip("mem-r8", "mem-r8"), memoryChip("mem-r8-second", "mem-r8")],
          });
          // Parked only long enough to hand the test the real send fiber;
          // its exit covers the too-large report and the durable settle.
          yield* Deferred.await(admitParked);
          yield* Deferred.succeed(releaseAdmit, undefined);
          yield* Fiber.await(yield* Deferred.await(sendFiber));
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          // One memory referenced through two contexts commits exactly one item.
          expect(yield* sendItemRows(harness)).toEqual([{ memoryId: "mem-r8", memoryVersion: 1 }]);
          // The fixture text plus the twice-rendered envelope clears the
          // provider input limit by construction; the 32k ledger cap did not.
          expect(61_000 + 2 * (30_011 + 80)).toBeGreaterThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              payload: { requestId: "message-r8", detail: MEMORY_SEND_HOLD_DETAIL["too-large"] },
            }),
          ]);
        }),
    );

    effectIt.effect(
      "R9′ (no queue): a held compaction restores ready and clears compact pending",
      () =>
        Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          const secondStartEntered = yield* Deferred.make<void>();
          const startReleased = yield* Deferred.make<void>();
          const compactFailed = yield* Deferred.make<void>();
          let startSessionCalls = 0;
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              startSessionEffect: (session) => {
                startSessionCalls += 1;
                return startSessionCalls === 2
                  ? Deferred.succeed(secondStartEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(startReleased)),
                      Effect.as(session),
                    )
                  : Effect.succeed(session);
              },
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-r9nq-compact")
                  ? Deferred.succeed(compactFailed, undefined)
                  : undefined,
            }),
          );
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(firstSent, undefined).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId("turn-r9nq-first"),
              }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r9nq",
              title: "T9nq",
              body: "B9nq",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-before-compact-r9nq",
            messageId: "message-r9nq-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r9nq"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-r9nq",
            messageId: "message-r9nq-compact",
            text: "/compact",
          });
          yield* Deferred.await(secondStartEntered);
          const readySetsBefore = yield* readySessionSetEventCount(harness);
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-r9nq"));
          yield* changeUsedMemory(harness, "mem-r9nq");
          yield* Deferred.succeed(startReleased, undefined);

          yield* Deferred.await(compactFailed);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.compactThread).not.toHaveBeenCalled();
          expect(yield* readySessionSetEventCount(harness)).toBe(readySetsBefore + 1);
          expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Context compaction failed",
              payload: {
                requestId: "message-r9nq-compact",
                detail: MEMORY_SEND_HOLD_DETAIL["affected"],
              },
            }),
          ]);
        }),
    );

    const COMPACTION_QUEUED_CANCEL_DETAIL =
      "Context compaction failed. Send this message again to continue.";
    const STOPPED_DURING_COMPACTION_QUEUED_DETAIL =
      "The session was stopped during context compaction. Send this message again to continue.";

    effectIt.effect(
      "R9′ (queued): a held compaction branch keeps compactThread silent, cancels queued turns, and stays starting",
      () => {
        const startReleased = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          const afterSent = yield* Deferred.make<void>();
          const secondStartEntered = yield* Deferred.make<void>();
          const markerHeld = yield* Deferred.make<void>();
          const compactFailed = yield* Deferred.make<void>();
          const queuedCanceled = yield* Deferred.make<void>();
          let startSessionCalls = 0;
          let sentCalls = 0;
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              // Only the compaction's re-created session start parks; the
              // first turn's start must complete so a real conversation exists.
              startSessionEffect: (session) => {
                startSessionCalls += 1;
                return startSessionCalls === 2
                  ? Deferred.succeed(secondStartEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(startReleased)),
                      Effect.as(session),
                    )
                  : Effect.succeed(session);
              },
              afterCommand: (command) =>
                isMemoryFailureReport(
                  command,
                  "message-r9-compact",
                  MEMORY_SEND_HOLD_DETAIL["affected"],
                )
                  ? Deferred.succeed(compactFailed, undefined)
                  : isTurnStartFailureReceipt(command, "message-r9-queued", {
                        summary: "Queued message was not sent",
                        detail: COMPACTION_QUEUED_CANCEL_DETAIL,
                      })
                    ? Deferred.succeed(queuedCanceled, undefined)
                    : isMemoryFailureReport(
                          command,
                          "message-r9-marker",
                          MEMORY_SEND_HOLD_DETAIL.unavailable,
                        )
                      ? Deferred.succeed(markerHeld, undefined)
                      : undefined,
            }),
          );
          harness.sendTurn.mockImplementation(() => {
            sentCalls += 1;
            const result = Effect.succeed({
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId(`turn-r9-${sentCalls}`),
            });
            return sentCalls === 1
              ? Deferred.succeed(firstSent, undefined).pipe(Effect.andThen(result))
              : Deferred.succeed(afterSent, undefined).pipe(Effect.andThen(result));
          });
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r9",
              title: "T9",
              body: "B9",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-before-compact-r9",
            messageId: "message-r9-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r9"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-r9",
            messageId: "message-r9-compact",
            text: "/compact",
          });
          // The compaction's second startSession is genuinely parked before
          // the queued turn is dispatched.
          yield* Deferred.await(secondStartEntered);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-r9",
            messageId: "message-r9-queued",
            text: "queued during compaction",
          });
          // The worker is FIFO: this marker turn on a second thread is only
          // processed after the queued turn's work item completed, so its
          // persisted hold receipt proves the queued turn already landed in
          // turnsAfterCompaction before the memory is mutated.
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-marker-r9"),
            threadId: ThreadId.make("thread-2"),
            projectId: asProjectId("project-1"),
            title: "Marker",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "t3code/b2b2b2b2",
            worktreePath: "/tmp/provider-project-worktree-r9-marker",
            createdAt: memoryNow,
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-marker-r9",
            messageId: "message-r9-marker",
            threadId: ThreadId.make("thread-2"),
            text: "marker [Project memory](t3-context://v1/memory/mem-missing)",
            records: [memoryChip("mem-missing", "mem-missing")],
          });
          yield* Deferred.await(markerHeld);

          const sessionSetsWhileParked = yield* sessionSetEventCount(harness);
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-r9"));
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: asMemoryId("mem-r9"),
                expectedVersion: 1,
                title: "T9 updated",
                body: "B9 updated",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:02.000Z",
              }),
            ),
          );
          yield* Deferred.succeed(startReleased, undefined);

          yield* Deferred.await(compactFailed);
          yield* Deferred.await(queuedCanceled);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.compactThread).not.toHaveBeenCalled();
          // The bounded hold path reports the fixed wording for the /compact
          // message and the pre-existing wording for the queued message —
          // exactly these two failure activities, in this order.
          const activities = failureActivitiesOf(thread);
          const compactActivity = activities.find(
            (activity) => activity.summary === "Context compaction failed",
          );
          const queuedActivity = activities.find(
            (activity) => activity.summary === "Queued message was not sent",
          );
          expect(compactActivity?.payload).toEqual({
            requestId: "message-r9-compact",
            detail: MEMORY_SEND_HOLD_DETAIL["affected"],
          });
          expect(queuedActivity?.payload).toEqual({
            requestId: "message-r9-queued",
            detail: COMPACTION_QUEUED_CANCEL_DETAIL,
          });
          // No session restoration or error write: only the ensure path's own
          // bind write landed after the release (A-RESTORE recorded).
          expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsWhileParked + 1);
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([]);
          expect(thread?.session).toMatchObject({ status: "starting", lastError: null });

          // Persisted affected state survives the compaction cleanup: it must
          // be acknowledged for real before a later turn dispatches instead of
          // silently queueing or holding behind the dead compaction.
          const affected = yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 1 }),
            ),
          );
          expect(affected.held).toBe(true);
          expect(affected.latestChangeSeq).not.toBeNull();
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.acknowledge({
                threadId: ThreadId.make("thread-1"),
                throughChangeSeq: affected.latestChangeSeq ?? 0,
              }),
            ),
          );
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-after-held-compaction-r9",
            messageId: "message-r9-after",
            text: "after the held compaction",
          });
          yield* Deferred.await(afterSent);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(startReleased, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "R9i (C2): mixed interrupt from fail dispatch still cancels the owned queue without Stop",
      () => {
        const startReleased = Deferred.makeUnsafe<void>();
        const releaseFailDispatch = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          const secondStartEntered = yield* Deferred.make<void>();
          const phaseFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const queuedCanceled = yield* Deferred.make<void>();
          const markerHeld = yield* Deferred.make<void>();
          const failDispatchEntered = yield* Deferred.make<void>();
          const secret = "SECRET-C2";
          let startSessionCalls = 0;
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              startSessionEffect: (session) => {
                startSessionCalls += 1;
                return startSessionCalls === 2
                  ? Deferred.succeed(secondStartEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(startReleased)),
                      Effect.as(session),
                    )
                  : Effect.succeed(session);
              },
              failDispatch: (command) => {
                if (
                  command.type !== "thread.turn.start.fail" ||
                  command.messageId !== asMessageId("message-r9i-compact")
                ) {
                  return undefined;
                }
                return Effect.gen(function* () {
                  yield* Deferred.succeed(phaseFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(failDispatchEntered, undefined);
                  yield* Deferred.await(releaseFailDispatch);
                  const gate = yield* Deferred.make<void>();
                  const childEntered = yield* Deferred.make<void>();
                  const fiber = yield* Effect.forkChild(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(childEntered, undefined);
                      yield* Deferred.await(gate);
                    }).pipe(Effect.onInterrupt(() => Effect.die(new Error(secret)))),
                  );
                  yield* Deferred.await(childEntered);
                  yield* Fiber.interrupt(fiber);
                  const exit = yield* Fiber.await(fiber);
                  if (!Exit.isFailure(exit)) {
                    return yield* Effect.die(new Error("expected mixed interrupt cause"));
                  }
                  return yield* Effect.failCause(exit.cause);
                });
              },
              afterCommand: (command) =>
                isTurnStartFailureReceipt(command, "message-r9i-queued", {
                  summary: "Queued message was not sent",
                  detail: COMPACTION_QUEUED_CANCEL_DETAIL,
                })
                  ? Deferred.succeed(queuedCanceled, undefined)
                  : isMemoryFailureReport(
                        command,
                        "message-r9i-marker",
                        MEMORY_SEND_HOLD_DETAIL.unavailable,
                      )
                    ? Deferred.succeed(markerHeld, undefined)
                    : undefined,
            }),
          );
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(firstSent, undefined).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId("turn-r9i-first"),
              }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r9i",
              title: "T9i",
              body: "B9i",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-before-compact-r9i",
            messageId: "message-r9i-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r9i"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-r9i",
            messageId: "message-r9i-compact",
            text: "/compact",
          });
          yield* Deferred.await(secondStartEntered);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-r9i",
            messageId: "message-r9i-queued",
            text: "queued during compaction interrupt recovery",
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-marker-r9i"),
            threadId: ThreadId.make("thread-2"),
            projectId: asProjectId("project-1"),
            title: "Marker",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "t3code/d9d9d9d9",
            worktreePath: "/tmp/provider-project-worktree-r9i-marker",
            createdAt: memoryNow,
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-marker-r9i",
            messageId: "message-r9i-marker",
            threadId: ThreadId.make("thread-2"),
            text: "marker [Project memory](t3-context://v1/memory/mem-r9i-missing)",
            records: [memoryChip("mem-r9i-missing", "mem-r9i-missing")],
          });
          yield* Deferred.await(markerHeld);
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-r9i"));
          yield* changeUsedMemory(harness, "mem-r9i");
          yield* Deferred.succeed(startReleased, undefined);
          yield* Deferred.await(failDispatchEntered);
          yield* Deferred.succeed(releaseFailDispatch, undefined);

          const phaseFiber = yield* Deferred.await(phaseFiberD);
          const phaseExit = yield* Fiber.await(phaseFiber);
          expect(Exit.isFailure(phaseExit)).toBe(true);
          if (Exit.isFailure(phaseExit)) {
            expect(Cause.hasInterrupts(phaseExit.cause)).toBe(true);
            expect(Cause.pretty(phaseExit.cause)).not.toContain(secret);
          }
          yield* Deferred.await(queuedCanceled);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.compactThread).not.toHaveBeenCalled();
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Queued message was not sent",
              payload: {
                requestId: "message-r9i-queued",
                detail: COMPACTION_QUEUED_CANCEL_DETAIL,
              },
            }),
          ]);
          expect(serializedLogs(harness)).not.toContain(secret);
          for (const payload of yield* threadEventPayloads(harness)) {
            expect(payload.payloadJson).not.toContain(secret);
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(startReleased, Effect.succeed(undefined));
              Deferred.doneUnsafe(releaseFailDispatch, Effect.succeed(undefined));
            }),
          ),
        );
      },
    );

    effectIt.effect(
      "R9i (C2): Stop while compound failure dispatch is parked interrupts the phase and does not double-cancel the queue",
      () => {
        const startReleased = Deferred.makeUnsafe<void>();
        const releaseFailDispatch = Deferred.makeUnsafe<void>();
        const releaseProvider = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          const secondStartEntered = yield* Deferred.make<void>();
          const phaseFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const failDispatchEntered = yield* Deferred.make<void>();
          const stopHandlerDone = yield* Deferred.make<void>();
          const providerStopEntered = yield* Deferred.make<void>();
          const queuedStopped = yield* Deferred.make<void>();
          const markerHeld = yield* Deferred.make<void>();
          const secret = "SECRET-C2-STOP";
          const order: string[] = [];
          let startSessionCalls = 0;
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              startSessionEffect: (session) => {
                startSessionCalls += 1;
                return startSessionCalls === 2
                  ? Deferred.succeed(secondStartEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(startReleased)),
                      Effect.as(session),
                    )
                  : Effect.succeed(session);
              },
              stopSessionEffect: () =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => {
                    order.push("provider-stop");
                  });
                  yield* Deferred.succeed(providerStopEntered, undefined);
                  yield* Deferred.await(releaseProvider);
                }),
              failDispatch: (command) => {
                if (
                  command.type !== "thread.turn.start.fail" ||
                  command.messageId !== asMessageId("message-r9is-compact")
                ) {
                  return undefined;
                }
                return Effect.gen(function* () {
                  yield* Deferred.succeed(phaseFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(failDispatchEntered, undefined);
                  yield* Deferred.await(releaseFailDispatch);
                  return yield* Effect.die(new Error(secret));
                });
              },
              afterCommand: (command) => {
                if (
                  command.type === "thread.session.set" &&
                  command.threadId === ThreadId.make("thread-1") &&
                  command.session.status === "stopped"
                ) {
                  return Deferred.succeed(stopHandlerDone, undefined);
                }
                if (
                  isTurnStartFailureReceipt(command, "message-r9is-queued", {
                    summary: "Queued message was not sent",
                    detail: STOPPED_DURING_COMPACTION_QUEUED_DETAIL,
                  })
                ) {
                  return Deferred.succeed(queuedStopped, undefined);
                }
                if (
                  isMemoryFailureReport(
                    command,
                    "message-r9is-marker",
                    MEMORY_SEND_HOLD_DETAIL.unavailable,
                  )
                ) {
                  return Deferred.succeed(markerHeld, undefined);
                }
                return undefined;
              },
            }),
          );
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(firstSent, undefined).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId("turn-r9is-first"),
              }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r9is",
              title: "T9is",
              body: "B9is",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-before-compact-r9is",
            messageId: "message-r9is-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r9is"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-r9is",
            messageId: "message-r9is-compact",
            text: "/compact",
          });
          yield* Deferred.await(secondStartEntered);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-r9is",
            messageId: "message-r9is-queued",
            text: "queued during compaction stop recovery",
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-marker-r9is"),
            threadId: ThreadId.make("thread-2"),
            projectId: asProjectId("project-1"),
            title: "Marker",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "t3code/e9e9e9e9",
            worktreePath: "/tmp/provider-project-worktree-r9is-marker",
            createdAt: memoryNow,
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-marker-r9is",
            messageId: "message-r9is-marker",
            threadId: ThreadId.make("thread-2"),
            text: "marker [Project memory](t3-context://v1/memory/mem-r9is-missing)",
            records: [memoryChip("mem-r9is-missing", "mem-r9is-missing")],
          });
          yield* Deferred.await(markerHeld);
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-r9is"));
          yield* changeUsedMemory(harness, "mem-r9is");
          yield* Deferred.succeed(startReleased, undefined);
          yield* Deferred.await(failDispatchEntered);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-r9is"),
            threadId: ThreadId.make("thread-1"),
            createdAt: memoryNow,
          });
          yield* Deferred.await(providerStopEntered);
          const phaseFiber = yield* Deferred.await(phaseFiberD);
          const phaseExit = yield* Fiber.await(phaseFiber);
          expect(Exit.isFailure(phaseExit)).toBe(true);
          if (Exit.isFailure(phaseExit)) {
            expect(Cause.hasInterrupts(phaseExit.cause)).toBe(true);
            expect(Cause.pretty(phaseExit.cause)).not.toContain(secret);
          }
          Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
          yield* Deferred.await(stopHandlerDone);
          yield* Deferred.succeed(releaseFailDispatch, undefined);
          yield* Deferred.await(queuedStopped);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.compactThread).not.toHaveBeenCalled();
          expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
          expect(
            failureActivitiesOf(thread).filter(
              (activity) => activity.summary === "Queued message was not sent",
            ),
          ).toEqual([
            expect.objectContaining({
              payload: {
                requestId: "message-r9is-queued",
                detail: STOPPED_DURING_COMPACTION_QUEUED_DETAIL,
              },
            }),
          ]);
          expect(
            failureActivitiesOf(thread).some(
              (activity) =>
                activity.summary === "Queued message was not sent" &&
                activity.payload !== null &&
                typeof activity.payload === "object" &&
                "detail" in activity.payload &&
                activity.payload.detail === COMPACTION_QUEUED_CANCEL_DETAIL,
            ),
          ).toBe(false);
          expect(order).toEqual(["provider-stop"]);
          expect(serializedLogs(harness)).not.toContain(secret);
          for (const payload of yield* threadEventPayloads(harness)) {
            expect(payload.payloadJson).not.toContain(secret);
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(startReleased, Effect.succeed(undefined));
              Deferred.doneUnsafe(releaseFailDispatch, Effect.succeed(undefined));
              Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            }),
          ),
        );
      },
    );

    effectIt.effect(
      "RN: a different messageId turn stays intact while an older L3 hold reports with requestId",
      () => {
        const releaseHold = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const holdParked = yield* Deferred.make<void>();
          const sendFiberM1 = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const m1Reported = yield* Deferred.make<void>();
          const m2Sent = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkThreadHoldAtCall: {
                  call: 2,
                  timing: "before",
                  parked: holdParked,
                  release: releaseHold,
                  capture: sendFiberM1,
                },
              },
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-rn-m1", MEMORY_SEND_HOLD_DETAIL["affected"])
                  ? Deferred.succeed(m1Reported, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          harness.sendTurn.mockImplementation((request) =>
            request.input?.includes("message-rn-m2")
              ? Deferred.succeed(m2Sent, undefined).pipe(
                  Effect.as({
                    threadId: ThreadId.make("thread-1"),
                    turnId: asTurnId("turn-rn-m2"),
                  }),
                )
              : Effect.succeed({
                  threadId: ThreadId.make("thread-1"),
                  turnId: asTurnId("turn-rn-m1"),
                }),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-rn",
              title: "TRN",
              body: "BRN",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-rn-m1",
            messageId: "message-rn-m1",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-rn)",
            records: [memoryChip("mem-rn", "mem-rn")],
          });
          yield* Deferred.await(holdParked);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-rn-m2",
            messageId: "message-rn-m2",
            text: "message-rn-m2 without memory chip",
          });
          yield* Deferred.await(m2Sent);
          const sessionBeforeM1Report = (yield* Effect.promise(() => threadOf(harness)))?.session;
          const pendingBeforeM1Report = yield* Effect.promise(() =>
            harness
              .readProjectionTurnRows(ThreadId.make("thread-1"))
              .then((rows) => rows.filter((row) => row.state === "pending")),
          );
          expect(pendingBeforeM1Report).toEqual([
            expect.objectContaining({ pendingMessageId: "message-rn-m2", state: "pending" }),
          ]);
          yield* changeUsedMemory(harness, "mem-rn");
          yield* Deferred.succeed(releaseHold, undefined);
          yield* Fiber.await(yield* Deferred.await(sendFiberM1));
          yield* Deferred.await(m1Reported);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          expect(thread?.session).toEqual(sessionBeforeM1Report);
          expect(
            yield* Effect.promise(() =>
              harness
                .readProjectionTurnRows(ThreadId.make("thread-1"))
                .then((rows) => rows.filter((row) => row.state === "pending")),
            ),
          ).toEqual(pendingBeforeM1Report);
          const m1Activity = failureActivitiesOf(thread).find(
            (activity) => activityPayloadRequestId(activity.payload) === "message-rn-m1",
          );
          expect(m1Activity?.payload).toMatchObject({
            requestId: "message-rn-m1",
            detail: MEMORY_SEND_HOLD_DETAIL["affected"],
          });
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(releaseHold, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "RS: stop during an L3 hold ends stopped with no memory restore session-set",
      () => {
        const releaseHold = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const holdParked = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const stopRecorded = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkThreadHoldAtCall: {
                  call: 2,
                  parked: holdParked,
                  release: releaseHold,
                  capture: sendFiber,
                },
              },
              afterCommand: (command) =>
                command.type === "thread.session.set" &&
                command.threadId === ThreadId.make("thread-1") &&
                command.session.status === "stopped"
                  ? Deferred.succeed(stopRecorded, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-rs",
              title: "TRS",
              body: "BRS",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-rs",
            messageId: "message-rs",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-rs)",
            records: [memoryChip("mem-rs", "mem-rs")],
          });
          yield* Deferred.await(holdParked);
          const sessionSetsBefore = yield* sessionSetEventCount(harness);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-rs"),
            threadId: ThreadId.make("thread-1"),
            createdAt: memoryNow,
          });
          const sendExit = yield* Fiber.await(yield* Deferred.await(sendFiber));
          expect(Exit.isFailure(sendExit)).toBe(true);
          if (Exit.isFailure(sendExit)) {
            expect(Cause.hasInterrupts(sendExit.cause)).toBe(true);
          }
          yield* Deferred.await(stopRecorded);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
          expect(yield* memoryFailureSessionSetRows(harness)).toEqual([]);
          expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);
          expect(
            failureActivitiesOf(thread).some((activity) => activity.summary === "Message not sent"),
          ).toBe(true);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => Deferred.doneUnsafe(releaseHold, Effect.succeed(undefined))),
          ),
        );
      },
    );

    effectIt.effect(
      "RI: a same-messageId reissue while M1 is at L3 drops requestId on M1 and keeps pending",
      () => {
        const releaseM1Hold = Deferred.makeUnsafe<void>();
        const releaseM2L2 = Deferred.makeUnsafe<void>();
        return Effect.gen(function* () {
          const m1HoldParked = yield* Deferred.make<void>();
          const m1SendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const m2L2Parked = yield* Deferred.make<void>();
          const m2SendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const m1Reported = yield* Deferred.make<void>();
          const m2Held = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkThreadHoldAtCall: {
                  call: 2,
                  timing: "before",
                  parked: m1HoldParked,
                  release: releaseM1Hold,
                  capture: m1SendFiber,
                },
              },
              // M1: L1′=1, ensure=2/3, child L2=4. M2 reissue: L1′=5, ensure=6/7, L2=8.
              parkGetInstanceInfo: {
                call: 8,
                parked: m2L2Parked,
                release: releaseM2L2,
                capture: m2SendFiber,
              },
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-ri", MEMORY_SEND_HOLD_DETAIL["affected"])
                  ? Deferred.succeed(m1Reported, undefined)
                  : isMemoryFailureReport(
                        command,
                        "message-ri",
                        MEMORY_SEND_HOLD_DETAIL["already-committed"],
                      )
                    ? Deferred.succeed(m2Held, undefined)
                    : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-ri",
              title: "TRI",
              body: "BRI",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-ri-m1",
            messageId: "message-ri",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-ri)",
            records: [memoryChip("mem-ri", "mem-ri")],
          });
          yield* Deferred.await(m1HoldParked);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-ri-m2",
            messageId: "message-ri",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-ri)",
            records: [memoryChip("mem-ri", "mem-ri")],
          });
          yield* Deferred.await(m2L2Parked);
          const sessionBeforeReissue = (yield* Effect.promise(() => threadOf(harness)))?.session;
          const pendingBeforeM1Report = yield* Effect.promise(() =>
            harness.readProjectionTurnRows(ThreadId.make("thread-1")),
          );
          expect(
            pendingBeforeM1Report.some(
              (row) => row.pendingMessageId === "message-ri" && row.state === "pending",
            ),
          ).toBe(true);
          yield* changeUsedMemory(harness, "mem-ri");
          yield* Deferred.succeed(releaseM1Hold, undefined);
          yield* Fiber.await(yield* Deferred.await(m1SendFiber));
          yield* Deferred.await(m1Reported);
          yield* Effect.promise(() => harness.drain());

          const midThread = yield* Effect.promise(() => threadOf(harness));
          const m1Activity = failureActivitiesOf(midThread).find(
            (activity) => activity.summary === "Message not sent",
          );
          expect(activityPayloadRequestId(m1Activity?.payload)).toBeUndefined();
          expect(midThread?.session).toEqual(sessionBeforeReissue);
          expect(
            (yield* Effect.promise(() =>
              harness.readProjectionTurnRows(ThreadId.make("thread-1")),
            )).some((row) => row.pendingMessageId === "message-ri" && row.state === "pending"),
          ).toBe(true);

          yield* Deferred.succeed(releaseM2L2, undefined);
          yield* Fiber.await(yield* Deferred.await(m2SendFiber));
          yield* Deferred.await(m2Held);
          yield* Effect.promise(() => harness.drain());

          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          const finalThread = yield* Effect.promise(() => threadOf(harness));
          const m2Activity = failureActivitiesOf(finalThread).find(
            (activity) =>
              activityPayloadRequestId(activity.payload) === "message-ri" &&
              activity.summary === "Message not sent",
          );
          expect(m2Activity?.payload).toMatchObject({
            requestId: "message-ri",
            detail: MEMORY_SEND_HOLD_DETAIL["already-committed"],
          });
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(releaseM1Hold, Effect.succeed(undefined));
              Deferred.doneUnsafe(releaseM2L2, Effect.succeed(undefined));
            }),
          ),
        );
      },
    );

    effectIt.effect(
      "R10: a queued chip turn commits once on replay, retries hold already-committed, queue keeps moving",
      () =>
        Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          const compactEntered = yield* Deferred.make<void>();
          const releaseCompaction = yield* Deferred.make<void>();
          const secondSendStarted = yield* Deferred.make<void>();
          const releaseSecondSend = yield* Deferred.make<void>();
          const thirdSent = yield* Deferred.make<void>();
          const markerHeld = yield* Deferred.make<void>();
          const asSettled = yield* Deferred.make<void>();
          const bHeld = yield* Deferred.make<void>();
          const aDupHeld = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                afterSettle: asSettled,
              },
              compactThreadEffect: () =>
                Deferred.succeed(compactEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCompaction)),
                ),
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-r10-marker")
                  ? Deferred.succeed(markerHeld, undefined)
                  : isMemoryFailureReport(command, "message-r10-queued-plain")
                    ? Deferred.succeed(bHeld, undefined)
                    : isMemoryFailureReport(command, "message-r10-chip")
                      ? Deferred.succeed(aDupHeld, undefined)
                      : undefined,
            }),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r10",
              title: "T10",
              body: "B10",
            })).status,
          ).toBe("applied");
          let sentCount = 0;
          harness.sendTurn.mockImplementation(() => {
            sentCount += 1;
            const result = Effect.succeed({
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-r10"),
            });
            if (sentCount === 1) {
              return Deferred.succeed(firstSent, undefined).pipe(Effect.andThen(result));
            }
            return sentCount === 2
              ? Deferred.succeed(secondSendStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSecondSend)),
                  Effect.andThen(result),
                )
              : Deferred.succeed(thirdSent, undefined).pipe(Effect.andThen(result));
          });

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-before-compact-r10",
            messageId: "message-r10-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-r10"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-r10",
            messageId: "message-r10-compact",
            text: "/compact",
          });
          yield* Deferred.await(compactEntered);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-chip-r10",
            messageId: "message-r10-chip",
            text: "Queued chip [Project memory](t3-context://v1/memory/mem-r10)",
            records: [memoryChip("mem-r10", "mem-r10")],
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-plain-r10",
            messageId: "message-r10-queued-plain",
            text: "queued plain turn",
          });
          // The worker is FIFO: this marker turn on a second thread is only
          // processed after both queued turns landed in turnsAfterCompaction,
          // so its persisted hold receipt proves queue insertion.
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-marker-r10"),
            threadId: ThreadId.make("thread-2"),
            projectId: asProjectId("project-1"),
            title: "Marker",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: "t3code/c3c3c3c3",
            worktreePath: "/tmp/provider-project-worktree-r10-marker",
            createdAt: memoryNow,
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-marker-r10",
            messageId: "message-r10-marker",
            threadId: ThreadId.make("thread-2"),
            text: "marker [Project memory](t3-context://v1/memory/mem-missing)",
            records: [memoryChip("mem-missing", "mem-missing")],
          });
          yield* Deferred.await(markerHeld);
          yield* Deferred.succeed(releaseCompaction, undefined);

          // The replayed chip turn commits for real, then parks at the provider
          // send boundary. Its resumed.sent resolves only after the send
          // finishes, so the plain turn's replay cannot pass it.
          yield* Deferred.await(secondSendStarted);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
          expect(yield* sendItemRows(harness)).toEqual([{ memoryId: "mem-r10", memoryVersion: 1 }]);

          // The committed item makes the memory affected: the queued plain turn
          // is held at L0 on replay.
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: asMemoryId("mem-r10"),
                expectedVersion: 1,
                title: "T10 updated",
                body: "B10 updated",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:03.000Z",
              }),
            ),
          );
          yield* Deferred.succeed(releaseSecondSend, undefined);
          yield* Deferred.await(asSettled);
          yield* Deferred.await(bHeld);
          yield* Effect.promise(() => harness.drain());

          // A replayed once more after its commit: one accepted attempt, one
          // item — the once-only invariant.
          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(harness.sendTurn).toHaveBeenCalledTimes(2);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          expect(yield* sendItemRows(harness)).toEqual([{ memoryId: "mem-r10", memoryVersion: 1 }]);
          expect(failureActivitiesOf(thread).map((activity) => activity.payload)).toEqual([
            {
              requestId: "message-r10-queued-plain",
              detail: MEMORY_SEND_HOLD_DETAIL["affected"],
            },
          ]);

          // Persisted affected state must be acknowledged before the retry:
          // otherwise L0 correctly holds the duplicate behind the change.
          const affected = yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 1 }),
            ),
          );
          expect(affected.latestChangeSeq).not.toBeNull();
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.acknowledge({
                threadId: ThreadId.make("thread-1"),
                throughChangeSeq: affected.latestChangeSeq ?? 0,
              }),
            ),
          );

          // Only after the compaction queue replayed does the same messageId
          // retry reach the gate — it holds as a duplicate of the already
          // accepted attempt without a third provider call.
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-replay-r10",
            messageId: "message-r10-chip",
            text: "ignored by the reuse branch",
          });
          yield* Deferred.await(aDupHeld);
          yield* Effect.promise(() => harness.drain());

          expect(harness.sendTurn).toHaveBeenCalledTimes(2);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          expect(yield* sendItemRows(harness)).toEqual([{ memoryId: "mem-r10", memoryVersion: 1 }]);
          const requestIdOf = (payload: unknown) =>
            typeof payload === "object" && payload !== null && "requestId" in payload
              ? String(payload.requestId)
              : "";
          expect(
            failureActivitiesOf(yield* Effect.promise(() => threadOf(harness)))
              .map((activity) => activity.payload)
              .sort((a, b) => requestIdOf(a).localeCompare(requestIdOf(b))),
          ).toEqual([
            {
              requestId: "message-r10-chip",
              detail: MEMORY_SEND_HOLD_DETAIL["already-committed"],
            },
            {
              requestId: "message-r10-queued-plain",
              detail: MEMORY_SEND_HOLD_DETAIL["affected"],
            },
          ]);

          // The queue kept moving: a fresh ordinary turn sends.
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-after-queue-r10",
            messageId: "message-r10-after",
            text: "after the drained queue",
          });
          yield* Deferred.await(thirdSent);
        }),
    );

    effectIt.effect(
      "R11′: committed provider send failure restores error with fixed lastError only",
      () =>
        Effect.gen(function* () {
          const secretBody = "SECRET-B-R11";
          const sendFinished = yield* Deferred.make<void>();
          const failureReported = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              afterCommand: (command) =>
                isMemoryFailureReport(command, "message-r11", MEMORY_SEND_PROVIDER_FAILURE_DETAIL)
                  ? Deferred.succeed(failureReported, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          harness.sendTurn.mockImplementation(() =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "sendTurn",
                detail: `provider rejected the turn: ${secretBody}`,
              }),
            ).pipe(Effect.ensuring(Deferred.succeed(sendFinished, undefined))),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r11",
              title: "T11",
              body: "B11",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r11",
            messageId: "message-r11",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r11)",
            records: [memoryChip("mem-r11", "mem-r11")],
          });
          yield* Deferred.await(sendFinished);
          yield* Deferred.await(failureReported);
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Provider turn start failed",
              payload: {
                requestId: "message-r11",
                detail: MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
              },
            }),
          ]);
          expect(thread?.session).toMatchObject({
            status: "error",
            lastError: MEMORY_SEND_PROVIDER_FAILURE_DETAIL,
          });
          const logged = serializedLogs(harness);
          expect(logged).not.toContain(secretBody);
          for (const payload of yield* threadEventPayloads(harness)) {
            expect(payload.payloadJson).not.toContain(secretBody);
          }
        }),
    );

    effectIt.effect(
      "R11′: when thread.turn.start.fail dispatch fails, only the fixed warning is logged",
      () =>
        Effect.gen(function* () {
          const secretBody = "SECRET-B-R11";
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              failDispatch: (command) =>
                command.type === "thread.turn.start.fail"
                  ? Effect.die(new Error("injected activity append failure"))
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          harness.sendTurn.mockImplementation(() =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "sendTurn",
                detail: `provider rejected the turn: ${secretBody}`,
              }),
            ),
          );
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r11",
              title: "T11",
              body: "B11",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r11",
            messageId: "message-r11",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r11)",
            records: [memoryChip("mem-r11", "mem-r11")],
          });
          yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
          yield* waitForSendAttemptState(harness, "external_send_unknown");
          yield* Effect.promise(() => harness.drain());

          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          // Reporting failed, so no failure activity was persisted, and the
          // failure branch wrote no session state (A-RESTORE boundary).
          expect(failureActivitiesOf(thread)).toEqual([]);
          expect(yield* sessionSetEventCount(harness)).toBe(2);
          expect(thread?.session).toMatchObject({ status: "starting", lastError: null });

          // The fallback log is the fixed message with the thread id; the
          // provider cause never reaches any stored field or log argument.
          const fallbackLogs = harness.logs.filter((entry) =>
            entry.message.includes("project memory failure could not be recorded"),
          );
          expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
          expect(fallbackLogs[0]?.message).toContain("thread-1");
          const logged = serializedLogs(harness);
          expect(logged).not.toContain(secretBody);
          for (const payload of yield* threadEventPayloads(harness)) {
            expect(payload.payloadJson).not.toContain(secretBody);
          }
        }),
    );

    effectIt.effect(
      "R12 (lost admission result): an interrupt after the real commit leaves the attempt pending and the retry held",
      () =>
        Effect.gen(function* () {
          const admitParked = yield* Deferred.make<void>();
          const releaseAdmit = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const retryHeld = yield* Deferred.make<void>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkAdmitAfterCommit: {
                  parked: admitParked,
                  release: releaseAdmit,
                  capture: sendFiber,
                },
              },
              afterCommand: (command) =>
                isMemoryFailureReport(
                  command,
                  "message-r12",
                  MEMORY_SEND_HOLD_DETAIL["already-committed"],
                )
                  ? Deferred.succeed(retryHeld, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r12",
              title: "T12",
              body: "B12",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r12",
            messageId: "message-r12",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r12)",
            records: [memoryChip("mem-r12", "mem-r12")],
          });
          yield* Deferred.await(admitParked);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);

          // Interrupt the exact send fiber parked inside the real admit
          // boundary: the Committed result never reaches the reactor, the
          // settlement finalizer is not armed yet, so the attempt stays
          // committed-and-pending and nothing sends.
          const fiber = yield* Deferred.await(sendFiber);
          yield* Fiber.interrupt(fiber);
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);

          // In the same still-subscribed runtime, the retry of the same
          // message is held by the real ledger's unique dispatch record.
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-retry-r12",
            messageId: "message-r12",
            text: "retry of the interrupted turn",
          });
          yield* Deferred.await(retryHeld);
          yield* Effect.promise(() => harness.drain());

          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        }),
    );

    effectIt.effect(
      "R12 (armed settlement): interrupting at the L3 boundary lets the reactor settle unknown, not Held",
      () =>
        Effect.gen(function* () {
          const holdParked = yield* Deferred.make<void>();
          const releaseHold = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                parkThreadHoldAtCall: {
                  call: 2,
                  parked: holdParked,
                  release: releaseHold,
                  capture: sendFiber,
                },
              },
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r12b",
              title: "T12b",
              body: "B12b",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r12b",
            messageId: "message-r12b",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r12b)",
            records: [memoryChip("mem-r12b", "mem-r12b")],
          });
          // First threadHold is L0; the second is the L3 check, reached only
          // after the real commit and with the settlement finalizer armed.
          yield* Deferred.await(holdParked);
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);

          // Interrupting that exact send fiber inside L3 runs the armed
          // finalizer: it settles the attempt unknown, is not converted into
          // a Held report, and nothing sends.
          const fiber = yield* Deferred.await(sendFiber);
          yield* Fiber.interrupt(fiber);
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          expect(harness.sendTurn).not.toHaveBeenCalled();
          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(failureActivitiesOf(thread)).toEqual([]);
        }),
    );

    effectIt.effect(
      "R13: a real turn interrupt cancels the pre-admission in-flight send before the provider stop",
      () =>
        Effect.gen(function* () {
          const infoParked = yield* Deferred.make<void>();
          const releaseInfo = yield* Deferred.make<void>();
          const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const providerStopEntered = yield* Deferred.make<void>();
          const reportRecorded = yield* Deferred.make<void>();
          // Filled from the park before the interrupt is dispatched; the
          // provider mock samples the child's exit at its own entry, so the
          // join-before-cancel order is read off a real sample, not an await.
          let child: Fiber.Fiber<unknown, unknown> | undefined;
          let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: { driverKinds: codexDriverKinds() },
              // getInstanceInfo call order for this turn: the L1′ preflight
              // (1), the session-ensure current/desired lookups (2-3), and the
              // forked send child's L2 lookup (4) — the park holds the child
              // before admission has committed anything.
              parkGetInstanceInfo: {
                call: 4,
                parked: infoParked,
                release: releaseInfo,
                capture: sendFiber,
              },
              // A preparation-only interrupt takes the non-recovering stop
              // path: the provider stop is the first provider call, so the
              // join-before-cancel order proof samples there.
              stopSessionEffect: () =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => {
                    exitAtProviderEntry = child?.pollUnsafe();
                  });
                  yield* Deferred.succeed(providerStopEntered, undefined);
                }),
              afterCommand: (command) =>
                isFailureActivityAppend(
                  command,
                  "message-r13",
                  "Stopped before this message was sent.",
                )
                  ? Deferred.succeed(reportRecorded, undefined)
                  : undefined,
            }),
          );
          harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-r13",
              title: "T13",
              body: "B13",
            })).status,
          ).toBe("applied");

          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-chip-r13",
            messageId: "message-r13",
            text: "Summarize [Project memory](t3-context://v1/memory/mem-r13)",
            records: [memoryChip("mem-r13", "mem-r13")],
          });
          yield* Deferred.await(infoParked);
          child = yield* Deferred.await(sendFiber);
          const sessionSetsBefore = yield* sessionSetEventCount(harness);
          expect(yield* sendAttemptStates(harness)).toEqual([]);
          expect(harness.sendTurn).not.toHaveBeenCalled();

          // The user interrupts through the real orchestration command path
          // while the send child is parked before admission; the park is never
          // released to let the send proceed.
          yield* harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-turn-interrupt-r13"),
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-r13"),
            createdAt: memoryNow,
          });
          // The saved exit was sampled inside the provider mock on entry: a
          // failed, interrupt-bearing exit proves the child was joined before
          // the provider stop ran, not merely before the test looked.
          yield* Deferred.await(providerStopEntered);
          const childExitAtEntry = exitAtProviderEntry;
          expect(childExitAtEntry !== undefined && Exit.isFailure(childExitAtEntry)).toBe(true);
          if (childExitAtEntry !== undefined && Exit.isFailure(childExitAtEntry)) {
            expect(Cause.hasInterrupts(childExitAtEntry.cause)).toBe(true);
          }
          yield* Deferred.await(reportRecorded);
          yield* Effect.promise(() => harness.drain());

          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(harness.interruptTurn).not.toHaveBeenCalled();
          expect(harness.stopSession).toHaveBeenCalledTimes(1);
          expect(yield* sendAttemptStates(harness)).toEqual([]);
          // The guarded settle writes the canceled preparation's terminal
          // "stopped" session on top of its own "starting" anchor.
          expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);
          const thread = yield* Effect.promise(() => threadOf(harness));
          expect(failureActivitiesOf(thread)).toEqual([
            expect.objectContaining({
              summary: "Message not sent",
              turnId: null,
              payload: {
                requestId: "message-r13",
                detail: "Stopped before this message was sent.",
              },
            }),
          ]);
          expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });

          // Releasing the parked lookup can only unblock an already-joined
          // fiber: no send may follow the interrupt, and no attempt appears.
          Deferred.doneUnsafe(releaseInfo, Effect.succeed(undefined));
          yield* Effect.promise(() => harness.drain());
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(yield* sendAttemptStates(harness)).toEqual([]);
        }),
    );

    effectIt.effect(
      "R14: a chipless turn held at L3 swallows a failed failure report into the fixed log only",
      () =>
        Effect.gen(function* () {
          const aL0Parked = yield* Deferred.make<void>();
          const releaseA = yield* Deferred.make<void>();
          const compactStarted = yield* Deferred.make<void>();
          const releaseCompaction = yield* Deferred.make<void>();
          const appendAttempted = yield* Deferred.make<void>();
          const releaseInject = yield* Deferred.make<void>();
          const firstSent = yield* Deferred.make<void>();
          const bSendAttempted = yield* Deferred.make<void>();
          const releaseB = yield* Deferred.make<void>();
          const injectedMarker = "INJECTED-L3X-MARKER";
          const harness = yield* Effect.promise(() =>
            createHarness({
              memoryGate: {
                driverKinds: codexDriverKinds(),
                // threadHold call order: first turn L0/L3 (1-2), /compact L0 and
                // its pre-call check (3-4), queued A/B L0 (5-6). Call 7 is A's
                // replayed L0; the wrapper parks after that clean read.
                parkThreadHoldAtCall: { call: 7, parked: aL0Parked, release: releaseA },
              },
              compactThreadEffect: () =>
                Deferred.succeed(compactStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCompaction)),
                ),
              failDispatch: (command) =>
                command.type === "thread.turn.start.fail"
                  ? Deferred.succeed(appendAttempted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseInject)),
                      Effect.andThen(
                        Effect.die(new Error(`injected append failure ${injectedMarker}`)),
                      ),
                    )
                  : undefined,
            }),
          );
          let sendCount = 0;
          harness.sendTurn.mockImplementation(() => {
            sendCount += 1;
            const result = Effect.succeed({
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId(`turn-l3x-${sendCount}`),
            });
            if (sendCount === 1) {
              return Deferred.succeed(firstSent, undefined).pipe(Effect.andThen(result));
            }
            return Deferred.succeed(bSendAttempted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseB)),
              Effect.andThen(result),
            );
          });
          expect(
            (yield* insertProjectMemory(harness, {
              memoryId: "mem-l3x",
              title: "T-L3X",
              body: "B-L3X",
            })).status,
          ).toBe("applied");

          // Existing conversation and a ready session so /compact is legal.
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-first-l3x",
            messageId: "message-l3x-first",
            text: "hello",
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-ready-l3x"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });

          // The compaction parks mid-flight; the two chipless turns queue
          // behind it and replay through the durable resumed.sent handoff.
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-compact-l3x",
            messageId: "message-l3x-compact",
            text: "/compact",
          });
          yield* Deferred.await(compactStarted);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-a-l3x",
            messageId: "message-l3x-a",
            text: "queued chipless turn held at L3",
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-turn-queued-b-l3x",
            messageId: "message-l3x-b",
            text: "queued chipless turn that later sends",
          });
          // Drain waits for the worker to finish both queued handlers, which
          // is what places A and B into turnsAfterCompaction before the
          // compaction fiber is allowed to resume.
          yield* Effect.promise(() => harness.drain());
          yield* Deferred.succeed(releaseCompaction, undefined);

          // A's replayed L0 already read clean before parking, so the real
          // affected state is seeded in the L0-to-L3 gap via the 057 trigger.
          yield* Deferred.await(aL0Parked);
          yield* Effect.promise(() => seedAffectedRows(harness, "mem-l3x"));
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.memoryRepository.update({
                projectId: asProjectId("project-1"),
                memoryId: asMemoryId("mem-l3x"),
                expectedVersion: 1,
                title: "T-L3X updated",
                body: "B-L3X updated",
                kind: "fact",
                validUntil: null,
                estimatedTokens: 0,
                now: "2026-01-01T00:00:02.000Z",
              }),
            ),
          );
          yield* Deferred.succeed(releaseA, undefined);

          // A's send fiber hits the real L3 hold, then the activity append
          // fails inside the injected dispatch. Acknowledging while the report
          // is parked lets B's replayed L0/L3 read clean afterward.
          yield* Deferred.await(appendAttempted);
          const affected = yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.affectedState({
                threadId: ThreadId.make("thread-1"),
                limit: 1,
              }),
            ),
          );
          expect(affected.held).toBe(true);
          yield* Effect.promise(() =>
            harness.runEffect(
              harness.ledger.acknowledge({
                threadId: ThreadId.make("thread-1"),
                throughChangeSeq: affected.latestChangeSeq ?? 0,
              }),
            ),
          );
          yield* Deferred.succeed(releaseInject, undefined);

          // B replays only after A's resumed.sent settles, so reaching B's
          // sendTurn proves A's send fiber exited completely.
          yield* Deferred.await(bSendAttempted);
          const thread = yield* Effect.promise(() => threadOf(harness));
          // sendTurn calls: the first turn and B only — A never reached the
          // provider. The only attempt row is the affected-state seed; the
          // chipless hold wrote no new memory-specific session state.
          expect(harness.sendTurn.mock.calls.length).toBe(2);
          expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          // The failed append left no activity, and the hold path wrote no
          // session error — generic recovery never ran.
          expect(failureActivitiesOf(thread)).toEqual([]);
          expect(thread?.session?.lastError ?? null).toBeNull();
          const fallbackLogs = harness.logs.filter((entry) =>
            entry.message.includes("project memory failure could not be recorded"),
          );
          expect(fallbackLogs).toHaveLength(1);
          expect(serializedLogs(harness)).not.toContain(injectedMarker);
          for (const payload of yield* threadEventPayloads(harness)) {
            expect(payload.payloadJson).not.toContain(injectedMarker);
          }

          yield* Deferred.succeed(releaseB, undefined);
          yield* Effect.promise(() => harness.drain());
          yield* Effect.promise(() => harness.stopReactor());
        }),
    );

    // A-STOP: Stop and Interrupt issued as real engine commands must signal and
    // join the in-flight ordinary sends the reactor already forked before any
    // provider cancellation call, and report the interrupted sends truthfully
    // afterwards. Every wait below is a receipt — provider entry, the child's
    // own finalizer, or the persisted activity — never a poll or a sleep.
    describe("A-STOP: engine stop and interrupt join in-flight sends", () => {
      const STOPPED_BEFORE_SEND_DETAIL = "Stopped before this message was sent.";
      const STOPPED_DURING_SEND_DETAIL =
        "Stopped while sending. The provider may have received this message.";
      const STOPPED_DURING_COMPACTION_DETAIL =
        "The session was stopped during context compaction. Send this message again to continue.";
      const CANCELED_BEFORE_RESUME_DETAIL =
        "The queued message was canceled before it could resume. Send it again to continue.";

      // The exit a provider mock sampled synchronously on its own entry must
      // show the child was already joined with its interruption preserved.
      const expectChildJoinedAtEntry = (exit: Exit.Exit<unknown, unknown> | undefined) => {
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
        if (exit !== undefined && Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      };

      // Builds a genuine interrupt+defect cause by interrupting a fiber whose
      // interrupt handler dies — the mixed shape the design probe produced.
      // The child signals entry before parking, so the onInterrupt handler is
      // provably installed when the interrupt lands.
      const makeMixedInterruptDieCause = (secret: string) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const childEntered = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.succeed(childEntered, undefined);
              yield* Deferred.await(gate);
            }).pipe(Effect.onInterrupt(() => Effect.die(new Error(secret)))),
          );
          yield* Deferred.await(childEntered);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          if (!Exit.isFailure(exit)) {
            return yield* Effect.die(new Error("expected the mixed-cause fiber to fail"));
          }
          return exit.cause;
        });

      effectIt.effect.each(["stop", "interrupt"] as const)(
        "A-STOP plain: a real engine %s joins the active send before the provider cancel and reports it interrupted once",
        (kind) =>
          Effect.gen(function* () {
            const sendEntered = yield* Deferred.make<void>();
            const releaseSend = yield* Deferred.make<void>();
            const sendFinalized = yield* Deferred.make<void>();
            const providerCancelEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            const order: string[] = [];
            const messageId = "message-astop-plain";
            // Captured inside the fake send before it signals entry; the
            // provider mocks sample its exit at their own entry.
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    child = yield* Effect.fiber;
                    yield* Effect.sync(() => {
                      order.push("send-entered");
                    });
                    yield* Deferred.succeed(sendEntered, undefined);
                    yield* Deferred.await(releaseSend);
                    return {
                      threadId: ThreadId.make("thread-1"),
                      turnId: asTurnId("turn-astop-plain"),
                    };
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.gen(function* () {
                        yield* Effect.sync(() => {
                          order.push("send-finalized");
                        });
                        yield* Deferred.succeed(sendFinalized, undefined);
                      }),
                    ),
                  ),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                    });
                    yield* Effect.sync(() => {
                      order.push("provider-interrupt");
                    });
                    yield* Deferred.succeed(providerCancelEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                    });
                    yield* Effect.sync(() => {
                      order.push("provider-stop");
                    });
                    yield* Deferred.succeed(providerCancelEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_DURING_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : undefined,
              }),
            );

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-plain",
              messageId,
              text: "plain active send cancelled by a real engine command",
            });
            yield* Deferred.await(sendEntered);
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            if (kind === "stop") {
              yield* harness.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.make("cmd-astop-plain"),
                threadId: ThreadId.make("thread-1"),
                createdAt: memoryNow,
              });
            } else {
              yield* harness.engine.dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make("cmd-astop-plain"),
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId("turn-astop-plain"),
                createdAt: memoryNow,
              });
            }

            // The provider cancel parks itself on entry. The exit it sampled
            // there is the order proof: the child was already joined, with its
            // interruption cause preserved, when the provider was entered.
            yield* Deferred.await(providerCancelEntered);
            const exitAtEntry = exitAtProviderEntry;
            expect(exitAtEntry !== undefined && Exit.isFailure(exitAtEntry)).toBe(true);
            if (exitAtEntry !== undefined && Exit.isFailure(exitAtEntry)) {
              expect(Cause.hasInterrupts(exitAtEntry.cause)).toBe(true);
            }
            yield* Deferred.await(sendFinalized);
            expect(order).toEqual([
              "send-entered",
              "send-finalized",
              kind === "stop" ? "provider-stop" : "provider-interrupt",
            ]);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            if (kind === "stop") {
              expect(harness.stopSession).toHaveBeenCalledTimes(1);
              expect(harness.interruptTurn).not.toHaveBeenCalled();
            } else {
              expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
              expect(harness.stopSession).not.toHaveBeenCalled();
            }
            // Exactly one truthful report, and no generic turn-start failure
            // recovery wrote anything: the only session write is the stop's own.
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message interrupted",
                turnId: null,
                payload: {
                  requestId: messageId,
                  detail: STOPPED_DURING_SEND_DETAIL,
                },
              }),
            ]);
            expect(thread?.session?.lastError ?? null).toBeNull();
            expect(yield* sessionSetEventCount(harness)).toBe(
              sessionSetsBefore + (kind === "stop" ? 1 : 0),
            );

            // Releasing the send park can only unblock an already-joined fiber.
            Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          }),
      );

      effectIt.effect(
        "A-STOP memory: a real stop after admission settles the armed attempt unknown before the provider stop",
        () =>
          Effect.gen(function* () {
            const settleReceipt = yield* Deferred.make<void>();
            const sendEntered = yield* Deferred.make<void>();
            const releaseSend = yield* Deferred.make<void>();
            const sendFinalized = yield* Deferred.make<void>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            const order: string[] = [];
            const messageId = "message-astop-armed";
            // Captured inside the fake send before it signals entry; the
            // provider stop samples the child exit and the settlement state at
            // its own entry.
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            let settledAtProviderEntry = false;
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: {
                  driverKinds: codexDriverKinds(),
                  afterSettle: settleReceipt,
                },
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    child = yield* Effect.fiber;
                    yield* Effect.sync(() => {
                      order.push("send-entered");
                    });
                    yield* Deferred.succeed(sendEntered, undefined);
                    yield* Deferred.await(releaseSend);
                    return {
                      threadId: ThreadId.make("thread-1"),
                      turnId: asTurnId("turn-astop-armed"),
                    };
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.gen(function* () {
                        yield* Effect.sync(() => {
                          order.push("send-finalized");
                        });
                        yield* Deferred.succeed(sendFinalized, undefined);
                      }),
                    ),
                  ),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                      settledAtProviderEntry = Deferred.isDoneUnsafe(settleReceipt);
                    });
                    yield* Effect.sync(() => {
                      order.push("provider-stop");
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_DURING_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : undefined,
              }),
            );
            expect(
              (yield* insertProjectMemory(harness, {
                memoryId: "mem-astop-armed",
                title: "T-ASTOP",
                body: "B-ASTOP",
              })).status,
            ).toBe("applied");

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-chip-astop-armed",
              messageId,
              text: "Summarize [Project memory](t3-context://v1/memory/mem-astop-armed)",
              records: [memoryChip("mem-astop-armed", "mem-astop-armed")],
            });
            // The provider call only runs after the real admission committed,
            // so reaching it proves the armed attempt exists.
            yield* Deferred.await(sendEntered);
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-armed"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });

            // The provider stop parks itself on entry. The exit and settlement
            // sampled there are the order proof: the child was already joined
            // and its own finalizer had already settled the attempt unknown.
            yield* Deferred.await(providerStopEntered);
            const exitAtEntry = exitAtProviderEntry;
            expect(exitAtEntry !== undefined && Exit.isFailure(exitAtEntry)).toBe(true);
            if (exitAtEntry !== undefined && Exit.isFailure(exitAtEntry)) {
              expect(Cause.hasInterrupts(exitAtEntry.cause)).toBe(true);
            }
            expect(settledAtProviderEntry).toBe(true);
            // The settled-unknown row is already in the ledger while the
            // provider stop is still parked.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
            yield* Deferred.await(sendFinalized);
            yield* Deferred.await(settleReceipt);
            expect(order).toEqual(["send-entered", "send-finalized", "provider-stop"]);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            expect(harness.interruptTurn).not.toHaveBeenCalled();
            // The child's own finalizer settled the attempt conservatively;
            // the test forced no outcome.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message interrupted",
                turnId: null,
                payload: {
                  requestId: messageId,
                  detail: STOPPED_DURING_SEND_DETAIL,
                },
              }),
            ]);
            expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);

            // Releasing the send park can only unblock an already-joined fiber.
            Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          }),
      );

      effectIt.effect(
        "A-STOP X3: a real stop before admission leaves no attempt and cannot be resurrected",
        () =>
          Effect.gen(function* () {
            const infoParked = yield* Deferred.make<void>();
            const releaseInfo = yield* Deferred.make<void>();
            const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            const messageId = "message-astop-x3";
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: { driverKinds: codexDriverKinds() },
                // Same in-child boundary as R13: the forked send child's L2
                // getInstanceInfo lookup (call 4), before admission commits.
                parkGetInstanceInfo: {
                  call: 4,
                  parked: infoParked,
                  release: releaseInfo,
                  capture: sendFiber,
                },
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_BEFORE_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : undefined,
              }),
            );
            harness.generateThreadTitle.mockReturnValue(
              Effect.succeed({ title: "Generated title" }),
            );
            expect(
              (yield* insertProjectMemory(harness, {
                memoryId: "mem-astop-x3",
                title: "T-X3",
                body: "B-X3",
              })).status,
            ).toBe("applied");

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-chip-astop-x3",
              messageId,
              text: "Summarize [Project memory](t3-context://v1/memory/mem-astop-x3)",
              records: [memoryChip("mem-astop-x3", "mem-astop-x3")],
            });
            yield* Deferred.await(infoParked);
            child = yield* Deferred.await(sendFiber);
            expect(yield* sendAttemptStates(harness)).toEqual([]);
            expect(harness.sendTurn).not.toHaveBeenCalled();
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            // A real engine stop while the child is parked before admission;
            // the lookup park is never released to let the send proceed.
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-x3"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });

            yield* Deferred.await(providerStopEntered);
            expectChildJoinedAtEntry(exitAtProviderEntry);
            // Still nothing committed or sent while the provider stop is parked.
            expect(yield* sendAttemptStates(harness)).toEqual([]);
            expect(harness.sendTurn).not.toHaveBeenCalled();
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            expect(yield* sendAttemptStates(harness)).toEqual([]);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message not sent",
                turnId: null,
                payload: {
                  requestId: messageId,
                  detail: STOPPED_BEFORE_SEND_DETAIL,
                },
              }),
            ]);
            expect(thread?.session?.lastError ?? null).toBeNull();
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);

            // Releasing the parked lookup can only unblock an already-joined
            // fiber: no send and no attempt may follow the stop.
            Deferred.doneUnsafe(releaseInfo, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(yield* sendAttemptStates(harness)).toEqual([]);
          }),
      );

      effectIt.effect(
        "A-STOP X4: a real stop after admission settles the armed pre-send attempt unknown",
        () =>
          Effect.gen(function* () {
            const settleReceipt = yield* Deferred.make<void>();
            const holdParked = yield* Deferred.make<void>();
            const releaseHold = yield* Deferred.make<void>();
            const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            let settledAtProviderEntry = false;
            const messageId = "message-astop-x4";
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: {
                  driverKinds: codexDriverKinds(),
                  afterSettle: settleReceipt,
                  // The restored original R13 schedule: the forked child parks
                  // on the real L3 recheck (threadHold call 2, after L0) with
                  // the armed settlement finalizer already installed.
                  parkThreadHoldAtCall: {
                    call: 2,
                    parked: holdParked,
                    release: releaseHold,
                    capture: sendFiber,
                  },
                },
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                      settledAtProviderEntry = Deferred.isDoneUnsafe(settleReceipt);
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_BEFORE_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : undefined,
              }),
            );
            harness.generateThreadTitle.mockReturnValue(
              Effect.succeed({ title: "Generated title" }),
            );
            expect(
              (yield* insertProjectMemory(harness, {
                memoryId: "mem-astop-x4",
                title: "T-X4",
                body: "B-X4",
              })).status,
            ).toBe("applied");

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-chip-astop-x4",
              messageId,
              text: "Summarize [Project memory](t3-context://v1/memory/mem-astop-x4)",
              records: [memoryChip("mem-astop-x4", "mem-astop-x4")],
            });
            yield* Deferred.await(holdParked);
            child = yield* Deferred.await(sendFiber);
            // Admission returned Committed to the reactor: the attempt is on
            // the ledger with its settlement finalizer armed, and nothing has
            // been sent.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            expect(harness.sendTurn).not.toHaveBeenCalled();
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-x4"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });

            yield* Deferred.await(providerStopEntered);
            expectChildJoinedAtEntry(exitAtProviderEntry);
            expect(settledAtProviderEntry).toBe(true);
            // The child's own finalizer already settled the attempt unknown
            // while the provider stop is parked.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message not sent",
                turnId: null,
                payload: {
                  requestId: messageId,
                  detail: STOPPED_BEFORE_SEND_DETAIL,
                },
              }),
            ]);
            expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);

            // Releasing the L3 park can only unblock an already-joined fiber:
            // no send follows, and the unknown settlement stands.
            Deferred.doneUnsafe(releaseHold, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "external_send_unknown" }]);
          }),
      );

      effectIt.effect(
        "A-STOP lost receipt: a real stop during an unreturned admission keeps it pending and holds the retry",
        () =>
          Effect.gen(function* () {
            const admitParked = yield* Deferred.make<void>();
            const releaseAdmit = yield* Deferred.make<void>();
            const sendFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            const retryHeld = yield* Deferred.make<void>();
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            const messageId = "message-astop-lost";
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: {
                  driverKinds: codexDriverKinds(),
                  // The real commit lands on the ledger, but the Committed
                  // receipt never returns to the reactor, so the armed
                  // settlement finalizer is never installed (accepted R12).
                  parkAdmitAfterCommit: {
                    parked: admitParked,
                    release: releaseAdmit,
                    capture: sendFiber,
                  },
                },
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = child?.pollUnsafe();
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_BEFORE_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : isMemoryFailureReport(
                          command,
                          messageId,
                          MEMORY_SEND_HOLD_DETAIL["already-committed"],
                        )
                      ? Deferred.succeed(retryHeld, undefined)
                      : undefined,
              }),
            );
            harness.generateThreadTitle.mockReturnValue(
              Effect.succeed({ title: "Generated title" }),
            );
            expect(
              (yield* insertProjectMemory(harness, {
                memoryId: "mem-astop-lost",
                title: "T-LOST",
                body: "B-LOST",
              })).status,
            ).toBe("applied");

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-chip-astop-lost",
              messageId,
              text: "Summarize [Project memory](t3-context://v1/memory/mem-astop-lost)",
              records: [memoryChip("mem-astop-lost", "mem-astop-lost")],
            });
            yield* Deferred.await(admitParked);
            child = yield* Deferred.await(sendFiber);
            // The durable attempt is committed on the ledger, but its receipt
            // is parked — the reactor never saw it, so nothing may settle it.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            expect(harness.sendTurn).not.toHaveBeenCalled();
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-lost"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });

            yield* Deferred.await(providerStopEntered);
            expectChildJoinedAtEntry(exitAtProviderEntry);
            // Honestly pending: with no receipt there is no finalizer, so the
            // committed attempt must still be there while the stop is parked.
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            // Session truth right after the stop: the stop's own write is the
            // only one. The retry below legitimately re-prepares the session
            // through the existing ensure path, so write counts measured after
            // the retry are not a cancellation oracle.
            const stoppedThread = yield* Effect.promise(() => threadOf(harness));
            expect(stoppedThread?.session).toMatchObject({ status: "stopped", lastError: null });
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore + 1);

            // Releasing the parked receipt cannot deliver it to a dead child:
            // the attempt stays pending with no forced unknown outcome.
            Deferred.doneUnsafe(releaseAdmit, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            expect(harness.sendTurn).not.toHaveBeenCalled();

            // A later real turn for the same message is held by the durable
            // dispatch record and never duplicates the attempt.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-chip-retry-astop-lost",
              messageId,
              text: "retry of the stopped turn",
            });
            yield* Deferred.await(retryHeld);
            yield* Effect.promise(() => harness.drain());

            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "dispatch_committed" }]);
            const thread = yield* Effect.promise(() => threadOf(harness));
            // Same-createdAt activities tiebreak on a nonsemantic uuid, so
            // assert the exact pair without display ordering.
            const reports = failureActivitiesOf(thread);
            expect(reports).toHaveLength(2);
            expect(reports).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  summary: "Message not sent",
                  turnId: null,
                  payload: {
                    requestId: messageId,
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  },
                }),
                expect.objectContaining({
                  summary: "Message not sent",
                  turnId: null,
                  payload: {
                    requestId: messageId,
                    detail: MEMORY_SEND_HOLD_DETAIL["already-committed"],
                  },
                }),
              ]),
            );
            // After the retry the session was re-prepared by the existing
            // ensure path; assert it is not an error recovery rather than
            // counting session writes.
            expect(thread?.session).toMatchObject({ lastError: null });
            expect(thread?.session?.status).not.toBe("error");
            expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          }),
      );

      effectIt.effect(
        "A-STOP isolation: an interrupt joins both same-thread steer sends and leaves another thread's send working",
        () =>
          Effect.gen(function* () {
            const enteredA1 = yield* Deferred.make<void>();
            const enteredA2 = yield* Deferred.make<void>();
            const enteredB = yield* Deferred.make<void>();
            const releaseA = yield* Deferred.make<void>();
            const releaseB = yield* Deferred.make<void>();
            const providerCancelEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportA1 = yield* Deferred.make<void>();
            const reportA2 = yield* Deferred.make<void>();
            const childBD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const messageA1 = "message-astop-iso-a1";
            const messageA2 = "message-astop-iso-a2";
            const messageB = "message-astop-iso-b";
            const threadBId = ThreadId.make("thread-2");
            // Poll refs for the provider-entry samples; B's fiber is also
            // handed to the test through a Deferred for its exit await.
            let childA1: Fiber.Fiber<unknown, unknown> | undefined;
            let childA2: Fiber.Fiber<unknown, unknown> | undefined;
            let childB: Fiber.Fiber<unknown, unknown> | undefined;
            let exitA1AtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            let exitA2AtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            let exitBAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: (sendInput) =>
                  Effect.gen(function* () {
                    const fiber = yield* Effect.fiber;
                    if (sendInput.threadId === threadBId) {
                      yield* Effect.sync(() => {
                        childB = fiber;
                      });
                      yield* Deferred.succeed(childBD, fiber);
                      yield* Deferred.succeed(enteredB, undefined);
                      yield* Deferred.await(releaseB);
                      return {
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-astop-iso-b"),
                      };
                    }
                    yield* Effect.sync(() => {
                      if (childA1 === undefined) {
                        childA1 = fiber;
                      } else {
                        childA2 = fiber;
                      }
                    });
                    if (childA2 !== undefined) {
                      yield* Deferred.succeed(enteredA2, undefined);
                    } else {
                      yield* Deferred.succeed(enteredA1, undefined);
                    }
                    yield* Deferred.await(releaseA);
                    return {
                      threadId: sendInput.threadId,
                      turnId: asTurnId("turn-astop-iso-a"),
                    };
                  }),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitA1AtProviderEntry = childA1?.pollUnsafe();
                      exitA2AtProviderEntry = childA2?.pollUnsafe();
                      exitBAtProviderEntry = childB?.pollUnsafe();
                    });
                    yield* Deferred.succeed(providerCancelEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageA1, STOPPED_DURING_SEND_DETAIL)
                    ? Deferred.succeed(reportA1, undefined)
                    : isFailureActivityAppend(command, messageA2, STOPPED_DURING_SEND_DETAIL)
                      ? Deferred.succeed(reportA2, undefined)
                      : undefined,
              }),
            );

            // Thread B through the real engine, then its own parked send.
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("cmd-thread-create-astop-iso-b"),
              threadId: threadBId,
              projectId: asProjectId("project-1"),
              title: "Thread B",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: null,
              createdAt: memoryNow,
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-iso-b",
              messageId: messageB,
              text: "other thread send that must survive",
              threadId: threadBId,
            });
            yield* Deferred.await(enteredB);

            // Two steered sends parked on thread A through the accepted steer
            // path: the worker is free after each fork.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-iso-a1",
              messageId: messageA1,
              text: "first steered send",
            });
            yield* Deferred.await(enteredA1);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-iso-a2",
              messageId: messageA2,
              text: "second steered send",
            });
            yield* Deferred.await(enteredA2);

            // A real engine interrupt for thread A only.
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-astop-iso"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-astop-iso"),
              createdAt: memoryNow,
            });

            yield* Deferred.await(providerCancelEntered);
            // Sampled on provider entry: both A children were joined with
            // their interruption preserved; B was not even done, let alone
            // interrupted.
            expectChildJoinedAtEntry(exitA1AtProviderEntry);
            expectChildJoinedAtEntry(exitA2AtProviderEntry);
            expect(exitBAtProviderEntry).toBeUndefined();
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportA1);
            yield* Deferred.await(reportA2);
            yield* Effect.promise(() => harness.drain());

            expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
            expect(harness.stopSession).not.toHaveBeenCalled();
            const threadA = yield* Effect.promise(() => threadOf(harness));
            // Same-createdAt activities tiebreak on a nonsemantic uuid, so
            // assert the exact pair without display ordering.
            const threadAReports = failureActivitiesOf(threadA);
            expect(threadAReports).toHaveLength(2);
            expect(threadAReports).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  summary: "Message interrupted",
                  turnId: null,
                  payload: {
                    requestId: messageA1,
                    detail: STOPPED_DURING_SEND_DETAIL,
                  },
                }),
                expect.objectContaining({
                  summary: "Message interrupted",
                  turnId: null,
                  payload: {
                    requestId: messageA2,
                    detail: STOPPED_DURING_SEND_DETAIL,
                  },
                }),
              ]),
            );
            expect(threadA?.session?.lastError ?? null).toBeNull();

            // Releasing B lets its untouched send complete through its real
            // child exit: no B failure, and the provider saw each message once.
            Deferred.doneUnsafe(releaseB, Effect.succeed(undefined));
            const bChild = yield* Deferred.await(childBD);
            const exitB = yield* Fiber.await(bChild);
            expect(Exit.isSuccess(exitB)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(3);
            const threadB = (yield* Effect.promise(() => harness.readModel())).threads.find(
              (entry) => entry.id === threadBId,
            );
            expect(failureActivitiesOf(threadB)).toEqual([]);
            expect(threadB?.session?.lastError ?? null).toBeNull();

            // Releasing the A parks can only unblock already-joined fibers.
            Deferred.doneUnsafe(releaseA, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(3);
          }),
      );

      effectIt.effect(
        "A-STOP cleanup: an interrupt after completed sends adds no failures and later work sends",
        () =>
          Effect.gen(function* () {
            const firstEntered = yield* Deferred.make<void>();
            const secondEntered = yield* Deferred.make<void>();
            const firstChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const secondChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerCancelEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            let completedChild: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    const fiber = yield* Effect.fiber;
                    const isFirst = yield* Deferred.succeed(firstChildD, fiber);
                    if (isFirst) {
                      yield* Effect.sync(() => {
                        completedChild = fiber;
                      });
                      yield* Deferred.succeed(firstEntered, undefined);
                    } else {
                      yield* Deferred.succeed(secondChildD, fiber);
                      yield* Deferred.succeed(secondEntered, undefined);
                    }
                    return {
                      threadId: ThreadId.make("thread-1"),
                      turnId: asTurnId("turn-astop-cleanup"),
                    };
                  }),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAtProviderEntry = completedChild?.pollUnsafe();
                    });
                    yield* Deferred.succeed(providerCancelEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
              }),
            );

            // The first ordinary send completes; its owned child exit is a
            // full Success, not merely an inner return.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-cleanup-first",
              messageId: "message-astop-cleanup-first",
              text: "first completed send",
            });
            yield* Deferred.await(firstEntered);
            const firstChild = yield* Deferred.await(firstChildD);
            const firstExit = yield* Fiber.await(firstChild);
            expect(Exit.isSuccess(firstExit)).toBe(true);

            // A later real engine interrupt finds nothing in flight.
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-astop-cleanup"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-astop-cleanup-interrupt"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerCancelEntered);
            // Sampled on provider entry: the completed send's exit is a
            // Success — finished work is not interrupted.
            expect(exitAtProviderEntry !== undefined && Exit.isSuccess(exitAtProviderEntry)).toBe(
              true,
            );
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());

            // Recorded-intent evidence, not an empty drain: the interrupt is
            // in the event log, the provider was interrupted once, and no new
            // start-failed activity appeared.
            const events = yield* Effect.promise(() =>
              harness.runEffect(Stream.runCollect(harness.engine.readEvents(0))),
            );
            expect(
              Array.from(events).some(
                (event) =>
                  event.type === "thread.turn-interrupt-requested" &&
                  event.payload.threadId === ThreadId.make("thread-1"),
              ),
            ).toBe(true);
            expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([]);

            // Later ordinary work after the interrupt sends and completes —
            // no leftover cancellation.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-cleanup-second",
              messageId: "message-astop-cleanup-second",
              text: "later ordinary turn",
            });
            yield* Deferred.await(secondEntered);
            const secondChild = yield* Deferred.await(secondChildD);
            const secondExit = yield* Fiber.await(secondChild);
            expect(Exit.isSuccess(secondExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(2);
            const laterThread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(laterThread)).toEqual([]);
          }),
      );

      effectIt.effect.each(["missing-thread", "missing-session"] as const)(
        "A-STOP missing lookup: a real stop joins the parked send before a %s shell lookup",
        (variant) =>
          Effect.gen(function* () {
            const sendEntered = yield* Deferred.make<void>();
            const releaseSend = yield* Deferred.make<void>();
            const readEntered = yield* Deferred.make<void>();
            const reportRecorded = yield* Deferred.make<void>();
            const messageId = "message-astop-lookup";
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAtLookupEntry: Exit.Exit<unknown, unknown> | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    child = yield* Effect.fiber;
                    yield* Deferred.succeed(sendEntered, undefined);
                    yield* Deferred.await(releaseSend);
                    return {
                      threadId: ThreadId.make("thread-1"),
                      turnId: asTurnId("turn-astop-lookup"),
                    };
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageId, STOPPED_DURING_SEND_DETAIL)
                    ? Deferred.succeed(reportRecorded, undefined)
                    : undefined,
              }),
            );

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-lookup",
              messageId,
              text: "parked send under a missing shell lookup",
            });
            yield* Deferred.await(sendEntered);

            // Deliberate query-miss seam on the real snapshot service (the
            // thread row stays in SQL — this is not a deletion proof): the
            // first and only shell read is the stop handler's, and the read
            // itself samples the child exit on entry without awaiting it.
            const realShell = Option.getOrUndefined(
              yield* Effect.promise(() =>
                harness.runEffect(
                  harness.snapshotQuery.getThreadShellById(ThreadId.make("thread-1")),
                ),
              ),
            );
            expect(realShell).toBeDefined();
            if (realShell === undefined) {
              return yield* Effect.die(new Error("thread shell missing before the spy"));
            }
            const shellSpy = vi.spyOn(harness.snapshotQuery, "getThreadShellById");
            shellSpy.mockImplementation(() =>
              Effect.gen(function* () {
                yield* Effect.sync(() => {
                  exitAtLookupEntry = child?.pollUnsafe();
                });
                yield* Deferred.succeed(readEntered, undefined);
                if (variant === "missing-session") {
                  const shellCopy = { ...realShell };
                  (shellCopy as { session: unknown }).session = null;
                  return Option.some(shellCopy);
                }
                return Option.none();
              }),
            );

            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-lookup"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(readEntered);
            expectChildJoinedAtEntry(exitAtLookupEntry);
            yield* Deferred.await(reportRecorded);
            yield* Effect.promise(() => harness.drain());

            // No provider cancellation without a bound session, and exactly
            // one shell read — the stop handler's.
            expect(shellSpy).toHaveBeenCalledTimes(1);
            expect(harness.stopSession).not.toHaveBeenCalled();
            shellSpy.mockRestore();

            // The joined child is still reported truthfully.
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: "Message interrupted",
                turnId: null,
                payload: {
                  requestId: messageId,
                  detail: STOPPED_DURING_SEND_DETAIL,
                },
              }),
            ]);
            expect(thread?.session?.lastError ?? null).toBeNull();

            // Releasing the parked send can only unblock an already-joined
            // fiber: nothing further is sent.
            Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          }),
      );

      effectIt.effect.each(["typed", "defect", "mixed"] as const)(
        "A-STOP report fault: a broken %s interrupted-send report cannot leak or fail the cancel",
        (variant) =>
          Effect.gen(function* () {
            const reportSecret = `ASTOP-REPORT-SECRET-${variant}`;
            const mixedCause =
              variant === "mixed" ? yield* makeMixedInterruptDieCause(reportSecret) : undefined;
            const sendEntered = yield* Deferred.make<void>();
            const releaseSend = yield* Deferred.make<void>();
            const providerInterruptEntered = yield* Deferred.make<void>();
            const reportEntered = yield* Deferred.make<void>();
            const releaseReport = yield* Deferred.make<void>();
            const messageId = "message-astop-report-fault";
            let child: Fiber.Fiber<unknown, unknown> | undefined;
            let providerInterrupted = false;
            let providerInterruptedAtReport = false;
            let childExitAtReport: Exit.Exit<unknown, unknown> | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    child = yield* Effect.fiber;
                    yield* Deferred.succeed(sendEntered, undefined);
                    yield* Deferred.await(releaseSend);
                    return {
                      threadId: ThreadId.make("thread-1"),
                      turnId: asTurnId("turn-astop-report-fault"),
                    };
                  }),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      providerInterrupted = true;
                    });
                    yield* Deferred.succeed(providerInterruptEntered, undefined);
                  }),
                failDispatch: (command) => {
                  if (!isFailureActivityAppend(command, messageId, STOPPED_DURING_SEND_DETAIL)) {
                    return undefined;
                  }
                  return Effect.gen(function* () {
                    // Sampled before the report parks: the provider cancel
                    // already ran and the child was already joined.
                    yield* Effect.sync(() => {
                      providerInterruptedAtReport = providerInterrupted;
                      childExitAtReport = child?.pollUnsafe();
                    });
                    yield* Deferred.succeed(reportEntered, undefined);
                    yield* Deferred.await(releaseReport);
                    if (variant === "typed") {
                      return yield* Effect.fail(
                        new OrchestrationCommandPreviouslyRejectedError({
                          commandId: "cmd-astop-report-fault",
                          detail: `injected typed report failure ${reportSecret}`,
                        }),
                      );
                    }
                    if (variant === "defect") {
                      return yield* Effect.die(new Error(`${reportSecret}: append exploded`));
                    }
                    if (mixedCause === undefined) {
                      return yield* Effect.die(new Error("mixed cause was not built"));
                    }
                    return yield* Effect.failCause(mixedCause);
                  });
                },
              }),
            );

            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-report-fault",
              messageId,
              text: "parked send whose interrupted-report will fail",
            });
            yield* Deferred.await(sendEntered);
            const sessionSetsBefore = yield* sessionSetEventCount(harness);

            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-astop-report-fault"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-astop-report-fault"),
              createdAt: memoryNow,
            });

            // The report attempt parks; the cancel attempt already completed
            // and the child was already joined when the report was entered.
            yield* Deferred.await(providerInterruptEntered);
            yield* Deferred.await(reportEntered);
            expect(providerInterruptedAtReport).toBe(true);
            expectChildJoinedAtEntry(childExitAtReport);
            const parkedThread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(parkedThread)).toEqual([]);

            Deferred.doneUnsafe(releaseReport, Effect.succeed(undefined));
            // The worker drain completes even for the mixed report failure:
            // the outstanding count is protected by an ensuring.
            yield* Effect.promise(() => harness.drain());

            // Fixed, cause-free handling only: no raw marker in logs or event
            // payloads, no session-error writes. Because the report failed, the
            // pending row honestly remains — this is not a stop-cleanup claim.
            expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore);
            expect(serializedLogs(harness)).not.toContain(reportSecret);
            for (const payload of yield* threadEventPayloads(harness)) {
              expect(payload.payloadJson).not.toContain(reportSecret);
            }
            if (variant !== "mixed") {
              const fallbackLogs = harness.logs.filter((entry) =>
                entry.message.includes(
                  "provider command reactor failed to record provider failure activity",
                ),
              );
              expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
            }
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([]);
            expect(thread?.session?.lastError ?? null).toBeNull();
            expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([
              { threadId: "thread-1" },
            ]);

            // Releasing the parked send can only unblock an already-joined
            // fiber.
            Deferred.doneUnsafe(releaseSend, Effect.succeed(undefined));
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          }),
      );

      effectIt.effect(
        "A-STOP mixed send: a returned interrupt+defect cause is preserved, never generic recovery",
        () =>
          Effect.gen(function* () {
            const sendSecret = "ASTOP-SEND-SECRET-MIXED";
            const mixedCause = yield* makeMixedInterruptDieCause(sendSecret);
            const sendAttempted = yield* Deferred.make<void>();
            const releaseFailure = yield* Deferred.make<void>();
            const providerInterruptEntered = yield* Deferred.make<void>();
            const childD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: () =>
                  Effect.gen(function* () {
                    const fiber = yield* Effect.fiber;
                    yield* Deferred.succeed(childD, fiber);
                    yield* Deferred.succeed(sendAttempted, undefined);
                    // Gate the failure so the test samples the session ledger
                    // before the mixed cause can execute.
                    yield* Deferred.await(releaseFailure);
                    return yield* Effect.failCause(mixedCause);
                  }),
                interruptTurnEffect: () =>
                  Deferred.succeed(providerInterruptEntered, undefined).pipe(Effect.asVoid),
              }),
            );

            // No external stop: the fake send itself returns the mixed cause —
            // a semantic edge for the catch boundary, not a Stop claim.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-turn-astop-mixed-send",
              messageId: "message-astop-mixed-send",
              text: "send that returns a mixed cause",
            });
            yield* Deferred.await(sendAttempted);
            // The failure is gated: sample the session ledger while the send is
            // parked before the mixed cause executes, then release and await
            // the child's full exit.
            const sessionSetsBefore = yield* sessionSetEventCount(harness);
            Deferred.doneUnsafe(releaseFailure, Effect.succeed(undefined));
            const child = yield* Deferred.await(childD);
            const exit = yield* Fiber.await(child);
            if (!Exit.isFailure(exit)) {
              return yield* Effect.die(new Error("expected the mixed-cause send to fail"));
            }
            // The original cause keeps both parts: the interruption and the
            // exact secret-bearing defect, not merely any die.
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
            expect(Cause.pretty(exit.cause)).toContain(sendSecret);

            // No recovery, no session error, no activity, no raw secret.
            yield* Effect.promise(() => harness.drain());
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([]);
            expect(thread?.session?.lastError ?? null).toBeNull();
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBefore);
            expect(serializedLogs(harness)).not.toContain(sendSecret);
            for (const payload of yield* threadEventPayloads(harness)) {
              expect(payload.payloadJson).not.toContain(sendSecret);
            }

            // The failed child deregistered itself: a later ordinary interrupt
            // observes an empty in-flight set and invents no failure.
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-astop-mixed-send"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-astop-mixed-send"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerInterruptEntered);
            yield* Effect.promise(() => harness.drain());
            expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
            const laterThread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(laterThread)).toEqual([]);
          }),
      );

      effectIt.effect(
        "A-STOP compaction: a stop joins the replayed send before the provider and the delayed failing queued report cannot hold the replay loop",
        () => {
          // Test-owned gates are released on any exit so a failed assertion
          // cannot leave harness fibers parked through teardown; doneUnsafe is
          // a no-op on already-released barriers.
          const releaseProvider = Deferred.makeUnsafe<void>();
          const releaseReportB = Deferred.makeUnsafe<void>();
          const releaseA = Deferred.makeUnsafe<void>();
          const releaseCompaction = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const queuedReportMarker = "ASTOP-QUEUED-REPORT-FAULT";
            const messageSeed = "message-astop-compaction-seed";
            const messageA = "message-astop-compaction-a";
            const messageB = "message-astop-compaction-b";
            const messageLater = "message-astop-compaction-later";
            const seedSent = yield* Deferred.make<void>();
            const enteredA = yield* Deferred.make<void>();
            const enteredLater = yield* Deferred.make<void>();
            const compactEntered = yield* Deferred.make<void>();
            const compactionChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const seedChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const aChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const laterChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerStopEntered = yield* Deferred.make<void>();
            const reportBAttempted = yield* Deferred.make<void>();
            const reportARecorded = yield* Deferred.make<void>();
            const replayLoopFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            let childA: Fiber.Fiber<unknown, unknown> | undefined;
            let exitAAtProviderEntry: Exit.Exit<unknown, unknown> | undefined;
            let providerStoppedSeen = false;
            let providerStoppedAtReport = false;
            let interceptedQueuedCommand:
              | Extract<ReactorCommand, { type: "thread.activity.append" }>
              | undefined;
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: (sendInput) =>
                  Effect.gen(function* () {
                    const fiber = yield* Effect.fiber;
                    const input = sendInput.input ?? "";
                    if (input.includes("astop compaction seed")) {
                      yield* Deferred.succeed(seedChildD, fiber);
                      yield* Deferred.succeed(seedSent, undefined);
                      return {
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-astop-compaction-seed"),
                      };
                    }
                    if (input.includes("astop compaction queued A")) {
                      yield* Deferred.succeed(aChildD, fiber);
                      yield* Deferred.succeed(enteredA, undefined);
                      yield* Deferred.await(releaseA);
                      return {
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-astop-compaction-a"),
                      };
                    }
                    yield* Deferred.succeed(laterChildD, fiber);
                    yield* Deferred.succeed(enteredLater, undefined);
                    return {
                      threadId: sendInput.threadId,
                      turnId: asTurnId("turn-astop-compaction-later"),
                    };
                  }),
                compactThreadEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(compactionChildD, yield* Effect.fiber);
                    yield* Deferred.succeed(compactEntered, undefined);
                    yield* Deferred.await(releaseCompaction);
                  }),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      exitAAtProviderEntry = childA?.pollUnsafe();
                      providerStoppedSeen = true;
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                failDispatch: (command) => {
                  const matched = isFailureActivityAppend(
                    command,
                    messageB,
                    STOPPED_DURING_COMPACTION_DETAIL,
                  );
                  if (!matched) {
                    return undefined;
                  }
                  return Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      providerStoppedAtReport = providerStoppedSeen;
                      if (command.type === "thread.activity.append") {
                        interceptedQueuedCommand = command;
                      }
                    });
                    yield* Deferred.succeed(reportBAttempted, undefined);
                    yield* Deferred.await(releaseReportB);
                    return yield* Effect.die(new Error(queuedReportMarker));
                  });
                },
                afterTurnStartDispatch: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(replayLoopFiberD, yield* Effect.fiber);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageA, STOPPED_DURING_SEND_DETAIL)
                    ? Deferred.succeed(reportARecorded, undefined)
                    : undefined,
              }),
            );

            // Ordinary successful conversation send, then a ready session.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-compaction-seed",
              messageId: messageSeed,
              text: "astop compaction seed turn",
            });
            yield* Deferred.await(seedSent);
            const seedChild = yield* Deferred.await(seedChildD);
            const seedExit = yield* Fiber.await(seedChild);
            expect(Exit.isSuccess(seedExit)).toBe(true);
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-astop-compaction-ready"),
              threadId: ThreadId.make("thread-1"),
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });

            // Parked compaction; A and B queue behind it, then replay starts.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-compaction-compact",
              messageId: "message-astop-compaction-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-compaction-a",
              messageId: messageA,
              text: "astop compaction queued A",
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-compaction-b",
              messageId: messageB,
              text: "astop compaction queued B",
            });
            yield* Effect.promise(() => harness.drain());
            const parkedPendingRows = yield* Effect.promise(() =>
              harness.readProjectionTurnRows(ThreadId.make("thread-1")),
            );
            expect(
              parkedPendingRows
                .filter((row) => row.turnId === null && row.state === "pending")
                .map((row) => row.pendingMessageId),
            ).toEqual(["message-astop-compaction-compact"]);
            yield* Deferred.succeed(releaseCompaction, undefined);
            yield* Deferred.await(enteredA);
            childA = yield* Deferred.await(aChildD);

            // Real stop: the first provider entry happens only after the
            // replayed A child was joined.
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-compaction-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerStopEntered);
            expectChildJoinedAtEntry(exitAAtProviderEntry);
            // While the provider stop is parked, B's queued report has not
            // even been attempted.
            expect(Deferred.isDoneUnsafe(reportBAttempted)).toBe(false);
            const providerStopPendingRows = yield* Effect.promise(() =>
              harness.readProjectionTurnRows(ThreadId.make("thread-1")),
            );
            expect(
              providerStopPendingRows
                .filter((row) => row.turnId === null && row.state === "pending")
                .map((row) => row.pendingMessageId),
            ).toEqual([messageA]);

            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportBAttempted);
            expect(providerStoppedAtReport).toBe(true);
            const stoppedSessionThread = yield* Effect.promise(() => threadOf(harness));
            expect(stoppedSessionThread?.session).toMatchObject({
              status: "stopped",
              lastError: null,
            });
            expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
            expect(Deferred.isDoneUnsafe(reportARecorded)).toBe(false);
            // The replay loop ended independently of the parked failing
            // report: A's finalizer woke resumed.sent and the detached queue
            // identity ended the loop. After phase/replay split the loop fiber
            // is distinct from the compaction phase fiber — await it here.
            const replayLoopFiber = yield* Deferred.await(replayLoopFiberD);
            const replayLoopExit = yield* Fiber.await(replayLoopFiber);
            expect(Exit.isSuccess(replayLoopExit)).toBe(true);
            const compactionChild = yield* Deferred.await(compactionChildD);
            const compactionExit = yield* Fiber.await(compactionChild);
            expect(Exit.isSuccess(compactionExit)).toBe(true);

            // B's report now fails; the best-effort catch lets A's truthful
            // report follow.
            Deferred.doneUnsafe(releaseReportB, Effect.succeed(undefined));
            yield* Deferred.await(reportARecorded);
            yield* Effect.promise(() => harness.drain());

            expect(interceptedQueuedCommand?.activity.summary).toBe("Queued message was not sent");
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            const fallbackLogs = harness.logs.filter((entry) =>
              entry.message.includes(
                "provider command reactor failed to record provider failure activity",
              ),
            );
            expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
            expect(serializedLogs(harness)).not.toContain(queuedReportMarker);
            for (const payload of yield* threadEventPayloads(harness)) {
              expect(payload.payloadJson).not.toContain(queuedReportMarker);
            }
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
            const threadReports = failureActivitiesOf(thread);
            expect(threadReports).toHaveLength(1);
            expect(threadReports).toEqual([
              expect.objectContaining({
                summary: "Message interrupted",
                turnId: null,
                payload: {
                  requestId: messageA,
                  detail: STOPPED_DURING_SEND_DETAIL,
                },
              }),
            ]);
            // Successful stopped-session projection already cleared the
            // current pending slot; failed queued reporting does not recreate
            // it.
            expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);

            // B never sent; a later ordinary send succeeds through its own
            // full child exit.
            Deferred.doneUnsafe(releaseA, Effect.succeed(undefined));
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-compaction-later",
              messageId: messageLater,
              text: "astop compaction later C",
            });
            yield* Deferred.await(enteredLater);
            const laterChild = yield* Deferred.await(laterChildD);
            const laterExit = yield* Fiber.await(laterChild);
            expect(Exit.isSuccess(laterExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(3);
            const laterThread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(laterThread)).toHaveLength(1);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseReportB, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseA, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-STOP compaction: a replay committed after detach takes the canceled-replay branch and its resumed.sent finalizer ends the loop",
        () =>
          Effect.gen(function* () {
            const messageSeed = "message-astop-replay-seed";
            const messageA = "message-astop-replay-a";
            const messageB = "message-astop-replay-b";
            const messageLater = "message-astop-replay-later";
            const seedSent = yield* Deferred.make<void>();
            const replayBefore = yield* Deferred.make<void>();
            const releaseReplayDispatch = yield* Deferred.make<void>();
            const replayCommitted = yield* Deferred.make<void>();
            const enteredLater = yield* Deferred.make<void>();
            const compactEntered = yield* Deferred.make<void>();
            const releaseCompaction = yield* Deferred.make<void>();
            const compactionChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const seedChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const laterChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const reportARecorded = yield* Deferred.make<void>();
            const reportBRecorded = yield* Deferred.make<void>();
            const replayLoopFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: (sendInput) =>
                  Effect.gen(function* () {
                    const fiber = yield* Effect.fiber;
                    const input = sendInput.input ?? "";
                    if (input.includes("astop replay seed")) {
                      yield* Deferred.succeed(seedChildD, fiber);
                      yield* Deferred.succeed(seedSent, undefined);
                      return {
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-astop-replay-seed"),
                      };
                    }
                    if (input.includes("astop replay later")) {
                      yield* Deferred.succeed(laterChildD, fiber);
                      yield* Deferred.succeed(enteredLater, undefined);
                      return {
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-astop-replay-later"),
                      };
                    }
                    // A and B must never reach the provider.
                    return yield* Effect.die(new Error("unexpected provider send"));
                  }),
                compactThreadEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(compactionChildD, yield* Effect.fiber);
                    yield* Deferred.succeed(compactEntered, undefined);
                    yield* Deferred.await(releaseCompaction);
                  }),
                beforeTurnStartDispatch: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(replayBefore, undefined);
                    yield* Deferred.await(releaseReplayDispatch);
                  }),
                afterTurnStartDispatch: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(replayLoopFiberD, yield* Effect.fiber);
                    yield* Deferred.succeed(replayCommitted, undefined);
                  }),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageB, STOPPED_DURING_COMPACTION_DETAIL)
                    ? Deferred.succeed(reportBRecorded, undefined)
                    : isFailureActivityAppend(command, messageA, CANCELED_BEFORE_RESUME_DETAIL)
                      ? Deferred.succeed(reportARecorded, undefined)
                      : undefined,
              }),
            );

            // Ordinary successful conversation send, then a ready session.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-replay-seed",
              messageId: messageSeed,
              text: "astop replay seed turn",
            });
            yield* Deferred.await(seedSent);
            const seedChild = yield* Deferred.await(seedChildD);
            const seedExit = yield* Fiber.await(seedChild);
            expect(Exit.isSuccess(seedExit)).toBe(true);
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-astop-replay-ready"),
              threadId: ThreadId.make("thread-1"),
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });

            // Parked compaction; A and B queue behind it. Releasing it pops A
            // and parks the replay dispatch before its Engine commit.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-replay-compact",
              messageId: "message-astop-replay-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-replay-a",
              messageId: messageA,
              text: "astop replay queued A",
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-replay-b",
              messageId: messageB,
              text: "astop replay queued B",
            });
            yield* Effect.promise(() => harness.drain());
            yield* Deferred.succeed(releaseCompaction, undefined);
            yield* Deferred.await(replayBefore);

            // Real stop detaches the queue and holds the single worker in the
            // parked provider stop. There is no A send child here.
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-astop-replay-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerStopEntered);

            // The replay commits after the detach but cannot be processed
            // while the worker is held in Stop.
            yield* Deferred.succeed(releaseReplayDispatch, undefined);
            yield* Deferred.await(replayCommitted);

            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            // B's queued report succeeds; the stale replay then takes the
            // early canceled-replay branch with its exact detail.
            yield* Deferred.await(reportBRecorded);
            yield* Deferred.await(reportARecorded);

            // Decisive: the event-level finalizer completed resumed.sent for
            // the unforked replay, so the replay-loop fiber reached a full
            // Success exit (distinct from the compaction phase fiber after
            // A-RESTORE phase split).
            const replayLoopFiber = yield* Deferred.await(replayLoopFiberD);
            const replayLoopExit = yield* Fiber.await(replayLoopFiber);
            expect(Exit.isSuccess(replayLoopExit)).toBe(true);
            const compactionChild = yield* Deferred.await(compactionChildD);
            const compactionExit = yield* Fiber.await(compactionChild);
            expect(Exit.isSuccess(compactionExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());

            const thread = yield* Effect.promise(() => threadOf(harness));
            const reports = failureActivitiesOf(thread);
            expect(reports).toHaveLength(2);
            expect(reports).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  summary: "Queued message was not sent",
                  turnId: null,
                  payload: {
                    requestId: messageA,
                    detail: CANCELED_BEFORE_RESUME_DETAIL,
                  },
                }),
                expect.objectContaining({
                  summary: "Queued message was not sent",
                  turnId: null,
                  payload: {
                    requestId: messageB,
                    detail: STOPPED_DURING_COMPACTION_DETAIL,
                  },
                }),
              ]),
            );
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
            // Successful stopped-session projection already cleared the one
            // current pending slot before these reports landed.
            expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);

            // A and B never sent; a later ordinary send succeeds.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-astop-replay-later",
              messageId: messageLater,
              text: "astop replay later C",
            });
            yield* Deferred.await(enteredLater);
            const laterChild = yield* Deferred.await(laterChildD);
            const laterExit = yield* Fiber.await(laterChild);
            expect(Exit.isSuccess(laterExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(2);
            const laterThread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(laterThread)).toHaveLength(2);
          }),
      );
    });

    // A-LANE: the ordinary-send preparation lane beyond the compaction tests —
    // cross-thread liveness while a preparation is parked, recovery holding the
    // lane against a cancel, a runtime-mode event deferring while compaction
    // owns the thread, and the drain boundary excluding post-lane sends.
    describe("A-LANE: ordinary preparation lane phase coverage", () => {
      const STOPPED_BEFORE_SEND_DETAIL = "Stopped before this message was sent.";
      const PREPARATION_STOP_UNVERIFIED_DETAIL =
        "The provider session could not be cleaned up after the stop. Continue in a new thread, or restart the server and check again.";

      const threadById = async (harness: MemoryHarness, threadId: ThreadId) =>
        (await harness.readModel()).threads.find((thread) => thread.id === threadId);

      const isStoppedSessionSetFor = (command: ReactorCommand, threadId: ThreadId) =>
        command.type === "thread.session.set" &&
        command.threadId === threadId &&
        command.session.status === "stopped";

      const createSecondThread = (harness: MemoryHarness, commandSuffix: string) =>
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-alane-thread-2-${commandSuffix}`),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "t3code/d4d4d4d4",
          worktreePath: "/tmp/provider-project-worktree-alane-2",
          createdAt: memoryNow,
        });

      effectIt.effect(
        "X/X2 vs Y: the global worker handles a stop on another worktree while one thread's preparation is parked",
        () =>
          Effect.gen(function* () {
            const xStartEntered = yield* Deferred.make<void>();
            const releaseXStart = yield* Deferred.make<void>();
            const yStopEntered = yield* Deferred.make<void>();
            const yStoppedSet = yield* Deferred.make<void>();
            const xSendsDone = yield* Deferred.make<void>();
            const messageX = "message-alane-x";
            const messageX2 = "message-alane-x2";
            const threadY = ThreadId.make("thread-2");
            let concurrentStarts = 0;
            let maxConcurrentStarts = 0;
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) =>
                  Effect.gen(function* () {
                    concurrentStarts += 1;
                    maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
                    if (session.threadId === ThreadId.make("thread-1")) {
                      yield* Deferred.succeed(xStartEntered, undefined);
                      yield* Deferred.await(releaseXStart);
                    }
                    return session;
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        concurrentStarts -= 1;
                      }),
                    ),
                  ),
                stopSessionEffect: () => Deferred.succeed(yStopEntered, undefined),
                afterCommand: (command) =>
                  isStoppedSessionSetFor(command, threadY)
                    ? Deferred.succeed(yStoppedSet, undefined)
                    : undefined,
              }),
            );
            // X is thread-1's parked preparation owner; Y is a separate
            // worktree whose ready session was seeded without any send.
            yield* createSecondThread(harness, "y");
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-alane-y-ready"),
              threadId: threadY,
              session: {
                threadId: threadY,
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-x",
              messageId: messageX,
              text: "alane x parked",
            });
            yield* Deferred.await(xStartEntered);
            // X2 waits behind X in thread-1's lane; both are registered
            // synchronously by the worker before Y's stop is handled.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-x2",
              messageId: messageX2,
              text: "alane x2 queued",
            });

            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-alane-y-stop"),
              threadId: threadY,
              createdAt: memoryNow,
            });
            yield* Deferred.await(yStopEntered);
            yield* Deferred.await(yStoppedSet);

            // The parked owner held its lane: X2 never opened a second
            // session, and Y's stop was still handled by the same worker.
            expect(harness.startSession.mock.calls.length).toBe(1);
            expect(maxConcurrentStarts).toBe(1);
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            const stoppedY = yield* Effect.promise(() => threadById(harness, threadY));
            expect(stoppedY?.session).toMatchObject({ status: "stopped", lastError: null });

            // Releasing X resumes preparation FIFO: X sends on its own
            // session and X2 reuses it instead of opening another. The mock
            // installs before the release so no send can outrun it.
            let sentForX = 0;
            harness.sendTurn.mockImplementation((sendInput) =>
              Effect.gen(function* () {
                sentForX += 1;
                if (sentForX === 2) {
                  yield* Deferred.succeed(xSendsDone, undefined);
                }
                return {
                  threadId: sendInput.threadId,
                  turnId: asTurnId(`turn-alane-x-${sentForX}`),
                };
              }),
            );
            Deferred.doneUnsafe(releaseXStart, Effect.void);
            yield* Deferred.await(xSendsDone);
            yield* Effect.promise(() => harness.drain());
            expect(harness.startSession.mock.calls.length).toBe(1);
            expect(
              harness.sendTurn.mock.calls.filter(
                (call) => (call[0] as { readonly threadId: string }).threadId === "thread-1",
              ).length,
            ).toBe(2);
          }),
      );

      effectIt.effect(
        "recovery before B: a preparation's in-lane recovery holds the queued send and a stop leaves its latest write untouched",
        () =>
          Effect.gen(function* () {
            const recoveryParked = yield* Deferred.make<void>();
            const releaseRecovery = yield* Deferred.make<void>();
            const reportA = yield* Deferred.make<void>();
            const reportB = yield* Deferred.make<void>();
            const messageA = "message-alane-recovery-a";
            const messageB = "message-alane-recovery-b";
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) =>
                  session.threadId === ThreadId.make("thread-1")
                    ? Effect.fail(
                        new ProviderAdapterRequestError({
                          provider: "codex",
                          method: "ProviderService.startSession",
                          detail: "injected start failure",
                        }),
                      )
                    : Effect.succeed(session),
                afterCommand: (command) => {
                  if (
                    command.type === "thread.session.set" &&
                    command.threadId === ThreadId.make("thread-1") &&
                    command.session.status === "error"
                  ) {
                    // A's in-lane recovery parked after its error write
                    // committed: the lane tail stays held until released or
                    // the owner is interrupted.
                    return Effect.gen(function* () {
                      yield* Deferred.succeed(recoveryParked, undefined);
                      yield* Deferred.await(releaseRecovery);
                    });
                  }
                  if (isFailureActivityAppend(command, messageA, STOPPED_BEFORE_SEND_DETAIL)) {
                    return Deferred.succeed(reportA, undefined);
                  }
                  if (isFailureActivityAppend(command, messageB, STOPPED_BEFORE_SEND_DETAIL)) {
                    return Deferred.succeed(reportB, undefined);
                  }
                  return undefined;
                },
              }),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-recovery-a",
              messageId: messageA,
              text: "alane recovery a",
            });
            yield* Deferred.await(recoveryParked);
            // B registers as a lane waiter behind A's still-running recovery.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-recovery-b",
              messageId: messageB,
              text: "alane recovery b",
            });
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-alane-recovery-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            // The last report is the terminal receipt: interrupted children
            // were joined, the settle ran, and reporting finished.
            yield* Deferred.await(reportB);
            yield* Deferred.await(reportA);
            yield* Effect.promise(() => harness.drain());

            // B was canceled before any provider work; the settle attempted
            // the cleanup once, but A's committed error write is newer than
            // the canceled preparation's anchor, so the guarded terminal
            // write was refused — the session keeps A's own failure detail.
            expect(harness.startSession.mock.calls.length).toBe(1);
            expect(harness.sendTurn).not.toHaveBeenCalled();
            expect(harness.interruptTurn).not.toHaveBeenCalled();
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(thread?.session?.status).toBe("error");
            expect(thread?.session?.activeTurnId).toBe(null);
            expect(thread?.session?.lastError).toBeTruthy();
            expect(thread?.session?.lastError).not.toBe(PREPARATION_STOP_UNVERIFIED_DETAIL);
            // Reverse-order joins report the queued waiter first, so match
            // unordered while keeping the exact once/detail/request checks.
            const failureActivities = failureActivitiesOf(thread);
            expect(failureActivities).toHaveLength(2);
            expect(failureActivities).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: messageA,
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
                expect.objectContaining({
                  summary: "Message not sent",
                  payload: expect.objectContaining({
                    requestId: messageB,
                    detail: STOPPED_BEFORE_SEND_DETAIL,
                  }),
                }),
              ]),
            );

            // Releasing the interrupted recovery's gate afterwards cannot
            // alter the settled state: no late session write, no extra
            // provider calls.
            Deferred.doneUnsafe(releaseRecovery, Effect.void);
            yield* Effect.promise(() => harness.drain());
            const threadAfter = yield* Effect.promise(() => threadOf(harness));
            expect(threadAfter?.session?.lastError).toBe(thread?.session?.lastError);
            expect(harness.startSession.mock.calls.length).toBe(1);
            expect(failureActivitiesOf(threadAfter)).toHaveLength(2);
          }),
      );

      effectIt.effect(
        "runtime-mode while compaction owns the thread: the session-kind preparation defers and touches no provider",
        () =>
          Effect.gen(function* () {
            const compactEntered = yield* Deferred.make<void>();
            const releaseCompaction = yield* Deferred.make<void>();
            const seedChildD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const harness = yield* Effect.promise(() =>
              createHarness({
                sendTurnEffect: (sendInput) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(seedChildD, yield* Effect.fiber);
                    return { threadId: sendInput.threadId, turnId: asTurnId("turn-alane-seed") };
                  }),
                compactThreadEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(compactEntered, undefined);
                    yield* Deferred.await(releaseCompaction);
                  }),
              }),
            );
            // A finished send plus a ready write seeds a conversation that is
            // eligible for /compact; joining the send child causally empties
            // the in-flight set before compaction is dispatched.
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-compact-seed",
              messageId: "message-alane-compact-seed",
              text: "alane compact seed",
            });
            yield* Fiber.await(yield* Deferred.await(seedChildD));
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-alane-compact-ready"),
              threadId: ThreadId.make("thread-1"),
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-compact",
              messageId: "message-alane-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);

            yield* harness.engine.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("cmd-alane-mode"),
              threadId: ThreadId.make("thread-1"),
              runtimeMode: "full-access",
              createdAt: memoryNow,
            });
            // Drain waits the mode entry's lane turn, which finished by
            // deferring — never by running an ensure while compaction owns
            // the thread.
            yield* Effect.promise(() => harness.drain());
            expect(harness.startSession.mock.calls.length).toBe(1);
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);

            Deferred.doneUnsafe(releaseCompaction, Effect.void);
            yield* Effect.promise(() => harness.drain());
          }),
      );

      effectIt.effect(
        "drain waits a parked preparation recovery but never a held post-lane send",
        () =>
          Effect.gen(function* () {
            const sendEntered = yield* Deferred.make<void>();
            const releaseSend = yield* Deferred.make<void>();
            const sendExited = yield* Deferred.make<void>();
            const bHeld = yield* Deferred.make<void>();
            const releaseB = yield* Deferred.make<void>();
            const threadB = ThreadId.make("thread-2");
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) =>
                  session.threadId === threadB
                    ? Effect.fail(
                        new ProviderAdapterRequestError({
                          provider: "codex",
                          method: "ProviderService.startSession",
                          detail: "injected drain-b start failure",
                        }),
                      )
                    : Effect.succeed(session),
                sendTurnEffect: (sendInput) =>
                  sendInput.threadId === ThreadId.make("thread-1")
                    ? Effect.gen(function* () {
                        yield* Deferred.succeed(sendEntered, undefined);
                        yield* Deferred.await(releaseSend);
                        return {
                          threadId: sendInput.threadId,
                          turnId: asTurnId("turn-alane-held"),
                        };
                      }).pipe(Effect.onExit(() => Deferred.succeed(sendExited, undefined)))
                    : Effect.succeed({
                        threadId: sendInput.threadId,
                        turnId: asTurnId("turn-alane-b"),
                      }),
                afterCommand: (command) =>
                  // thread-2's failed preparation parked inside its in-lane
                  // recovery — committed error write behind it, still owning
                  // the lane tail.
                  command.type === "thread.session.set" &&
                  command.threadId === threadB &&
                  command.session.status === "error"
                    ? Effect.gen(function* () {
                        yield* Deferred.succeed(bHeld, undefined);
                        yield* Deferred.await(releaseB);
                      })
                    : undefined,
              }),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-drain-a",
              messageId: "message-alane-drain-a",
              text: "alane drain a",
            });
            yield* Deferred.await(sendEntered);
            // thread-2's first send fails its ensure and parks mid-recovery,
            // still inside the lane.
            yield* createSecondThread(harness, "drain");
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-alane-drain-b",
              messageId: "message-alane-drain-b",
              threadId: threadB,
              text: "alane drain b",
            });
            yield* Deferred.await(bHeld);

            const drainFiber = yield* Effect.forkChild(Effect.promise(() => harness.drain()));
            yield* Effect.yieldNow;
            // While thread-2's recovery owns a lane tail the drain cannot
            // finish; thread-1's post-lane send staying held is irrelevant.
            expect(drainFiber.pollUnsafe()).toBeUndefined();

            Deferred.doneUnsafe(releaseB, Effect.void);
            const drainExit = yield* Fiber.await(drainFiber);
            expect(Exit.isSuccess(drainExit)).toBe(true);
            // The drain returned as soon as the lane released — the held
            // ordinary send was still inside the provider call. A resumed
            // queued send's `sent` receipt lives in the same post-lane scope,
            // so it is outside the drain boundary by the same mechanism.
            expect(Deferred.isDoneUnsafe(sendExited)).toBe(false);

            Deferred.doneUnsafe(releaseSend, Effect.void);
            yield* Deferred.await(sendExited);
            yield* Effect.promise(() => harness.drain());
            // Only thread-1's held send ever reached the provider.
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          }),
      );
    });

    // A-RESTORE: compaction phase ownership, stop/interrupt during compaction,
    // and replay queue identity. Real engine commands and receipts only.
    describe("A-RESTORE: compaction phase stop, interrupt, and replay boundaries", () => {
      const COMPACTION_NOT_STARTED_SUMMARY = "Context compaction not started";
      const COMPACTION_NOT_STARTED_DETAIL = "Stopped before context compaction started.";
      const COMPACTION_INTERRUPTED_SUMMARY = "Context compaction interrupted";
      const COMPACTION_INTERRUPTED_DETAIL =
        "Stopped during context compaction. The provider may still finish it.";
      const STOPPED_DURING_COMPACTION_DETAIL =
        "The session was stopped during context compaction. Send this message again to continue.";

      const threadById = async (harness: MemoryHarness, threadId: ThreadId) =>
        (await harness.readModel()).threads.find((thread) => thread.id === threadId);

      const createSecondThread = (harness: MemoryHarness) =>
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-arestore-thread-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "t3code/d2d2d2d2",
          worktreePath: "/tmp/provider-project-worktree-arestore-2",
          createdAt: memoryNow,
        });

      const seedReadyConversation = (harness: MemoryHarness, input: { readonly prefix: string }) =>
        Effect.gen(function* () {
          const firstSent = yield* Deferred.make<void>();
          harness.sendTurn.mockImplementation(() =>
            Deferred.succeed(firstSent, undefined).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
                turnId: asTurnId(`turn-${input.prefix}-seed`),
              }),
            ),
          );
          yield* dispatchMemoryTurn(harness, {
            commandId: `cmd-${input.prefix}-seed`,
            messageId: `message-${input.prefix}-seed`,
            text: `${input.prefix} seed`,
          });
          yield* Deferred.await(firstSent);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-${input.prefix}-ready`),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          harness.runtimeSessions.splice(0, harness.runtimeSessions.length);
        });

      const isStoppedSessionSet = (command: ReactorCommand, threadId: ThreadId) =>
        command.type === "thread.session.set" &&
        command.threadId === threadId &&
        command.session.status === "stopped";

      const sessionSetRows = (harness: MemoryHarness, threadId: ThreadId) =>
        Effect.promise(() =>
          harness.runSqlEffect(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly sequence: number; readonly status: string }>`
                SELECT
                  sequence,
                  json_extract(payload_json, '$.session.status') AS status
                FROM orchestration_events
                WHERE stream_id = ${threadId} AND event_type = 'thread.session-set'
                ORDER BY sequence ASC
              `;
            }),
          ),
        );

      const compactionFailedCount = (thread: Awaited<ReturnType<typeof threadById>>): number =>
        (thread?.activities ?? []).filter(
          (activity) => activity.summary === "Context compaction failed",
        ).length;

      effectIt.effect(
        "A-RESTORE A1: stop during compactThread joins the phase, reports compaction interrupted, and leaves no late ready",
        () =>
          Effect.gen(function* () {
            const order: string[] = [];
            const compactEntered = yield* Deferred.make<void>();
            const releaseCompaction = yield* Deferred.make<void>();
            const providerStopEntered = yield* Deferred.make<void>();
            const releaseProvider = yield* Deferred.make<void>();
            const stopHandlerDone = yield* Deferred.make<void>();
            const compactionReported = yield* Deferred.make<void>();
            const messageCompact = "message-arestore-a1-compact";
            const harness = yield* Effect.promise(() =>
              createHarness({
                compactThreadEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      order.push("compact-entered");
                    });
                    yield* Deferred.succeed(compactEntered, undefined);
                    yield* Deferred.await(releaseCompaction);
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        order.push("compact-interrupted");
                      }),
                    ),
                  ),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      order.push("provider-stop");
                    });
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) => {
                  if (isStoppedSessionSet(command, ThreadId.make("thread-1"))) {
                    return Deferred.succeed(stopHandlerDone, undefined);
                  }
                  if (
                    isFailureActivityAppend(command, messageCompact, COMPACTION_INTERRUPTED_DETAIL)
                  ) {
                    return Deferred.succeed(compactionReported, undefined);
                  }
                  return undefined;
                },
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a1" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a1-compact",
              messageId: messageCompact,
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a1-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerStopEntered);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(stopHandlerDone);
            yield* Deferred.await(compactionReported);
            yield* Effect.promise(() => harness.drain());

            expect(order).toEqual(["compact-entered", "compact-interrupted", "provider-stop"]);
            const rows = yield* sessionSetRows(harness, ThreadId.make("thread-1"));
            const stoppedSeq = rows.find((row) => row.status === "stopped")?.sequence;
            expect(stoppedSeq).toBeDefined();
            expect(
              rows.filter((row) => row.sequence > (stoppedSeq ?? 0) && row.status === "ready"),
            ).toEqual([]);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(compactionFailedCount(thread)).toBe(0);
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: COMPACTION_INTERRUPTED_SUMMARY,
                payload: {
                  requestId: messageCompact,
                  detail: COMPACTION_INTERRUPTED_DETAIL,
                },
              }),
            ]);
          }),
      );

      effectIt.effect(
        "A-RESTORE A2: stop after compaction L3 holds before compactThread reports not started",
        () => {
          const releaseHold = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const holdParked = yield* Deferred.make<void>();
            const stopHandlerDone = yield* Deferred.make<void>();
            const compactionReported = yield* Deferred.make<void>();
            const messageCompact = "message-arestore-a2-compact";
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: {
                  driverKinds: codexDriverKinds(),
                  // Seed L0/L3 (1–2), then /compact L0 and phase L3 (3–4); park 4 so
                  // Stop can queue while the worker is not stuck in seed's L0.
                  parkThreadHoldAtCall: { call: 4, parked: holdParked, release: releaseHold },
                },
                afterCommand: (command) => {
                  if (isStoppedSessionSet(command, ThreadId.make("thread-1"))) {
                    return Deferred.succeed(stopHandlerDone, undefined);
                  }
                  if (
                    isFailureActivityAppend(command, messageCompact, COMPACTION_NOT_STARTED_DETAIL)
                  ) {
                    return Deferred.succeed(compactionReported, undefined);
                  }
                  return undefined;
                },
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a2" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a2-compact",
              messageId: messageCompact,
              text: "/compact",
            });
            yield* Deferred.await(holdParked);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a2-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(stopHandlerDone);
            yield* Deferred.await(compactionReported);
            yield* Effect.promise(() => harness.drain());
            expect(harness.compactThread).not.toHaveBeenCalled();
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(failureActivitiesOf(thread)).toEqual([
              expect.objectContaining({
                summary: COMPACTION_NOT_STARTED_SUMMARY,
                payload: {
                  requestId: messageCompact,
                  detail: COMPACTION_NOT_STARTED_DETAIL,
                },
              }),
            ]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseHold, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE A3/A3x: stop during compaction session start orders interrupt before provider stop and does not block other threads",
        () => {
          const releaseStart = Deferred.makeUnsafe<void>();
          const releaseProviderY = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const order: string[] = [];
            const startEntered = yield* Deferred.make<void>();
            const providerStopY = yield* Deferred.make<void>();
            const stopHandlerY = yield* Deferred.make<void>();
            const stopHandlerX = yield* Deferred.make<void>();
            const threadX = ThreadId.make("thread-1");
            const compactionStartGate = { armed: false };
            let startSessionCompletions = 0;
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) => {
                  if (!compactionStartGate.armed || session.threadId !== threadX) {
                    return Effect.succeed(session);
                  }
                  return Effect.gen(function* () {
                    yield* Deferred.succeed(startEntered, undefined);
                    yield* Deferred.await(releaseStart);
                    startSessionCompletions += 1;
                    return session;
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        order.push("start-interrupted");
                      }),
                    ),
                  );
                },
                afterCommand: (command) => {
                  if (isStoppedSessionSet(command, ThreadId.make("thread-2"))) {
                    return Deferred.succeed(stopHandlerY, undefined);
                  }
                  if (isStoppedSessionSet(command, ThreadId.make("thread-1"))) {
                    return Deferred.succeed(stopHandlerX, undefined);
                  }
                  return undefined;
                },
              }),
            );
            harness.stopSession.mockImplementation((stopInput) => {
              const threadId =
                typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
                  ? (stopInput as { threadId: ThreadId }).threadId
                  : ThreadId.make("thread-1");
              if (threadId === ThreadId.make("thread-2")) {
                return Effect.gen(function* () {
                  order.push("provider-stop-y");
                  yield* Deferred.succeed(providerStopY, undefined);
                  yield* Deferred.await(releaseProviderY);
                });
              }
              return Effect.gen(function* () {
                order.push("provider-stop-x");
              });
            });
            yield* seedReadyConversation(harness, { prefix: "arestore-a3" });
            compactionStartGate.armed = true;
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a3-compact",
              messageId: "message-arestore-a3-compact",
              text: "/compact",
            });
            yield* Deferred.await(startEntered);
            yield* createSecondThread(harness);
            const ySeedSent = yield* Deferred.make<void>();
            harness.sendTurn.mockImplementation((sendInput) =>
              sendInput.threadId === ThreadId.make("thread-2")
                ? Deferred.succeed(ySeedSent, undefined).pipe(
                    Effect.as({
                      threadId: ThreadId.make("thread-2"),
                      turnId: asTurnId("turn-arestore-a3-y"),
                    }),
                  )
                : Effect.succeed({
                    threadId: ThreadId.make("thread-1"),
                    turnId: asTurnId("turn-arestore-a3-unused"),
                  }),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a3-y-seed",
              messageId: "message-arestore-a3-y-seed",
              threadId: ThreadId.make("thread-2"),
              text: "y seed",
            });
            yield* Deferred.await(ySeedSent);
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-arestore-a3-y-ready"),
              threadId: ThreadId.make("thread-2"),
              session: {
                threadId: ThreadId.make("thread-2"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a3-y-stop"),
              threadId: ThreadId.make("thread-2"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerStopY);
            Deferred.doneUnsafe(releaseProviderY, Effect.succeed(undefined));
            yield* Deferred.await(stopHandlerY);
            expect(order.indexOf("provider-stop-y")).toBeGreaterThanOrEqual(0);
            expect(Deferred.isDoneUnsafe(releaseStart)).toBe(false);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a3-x-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(stopHandlerX);
            yield* Effect.promise(() => harness.drain());
            expect(order.indexOf("start-interrupted")).toBeLessThan(
              order.indexOf("provider-stop-x"),
            );
            expect(startSessionCompletions).toBe(0);
            const rows = yield* sessionSetRows(harness, ThreadId.make("thread-1"));
            const stoppedSeq = rows.find((row) => row.status === "stopped")?.sequence;
            expect(
              rows.filter((row) => row.sequence > (stoppedSeq ?? 0) && row.status === "ready"),
            ).toEqual([]);
            expect(
              rows.filter((row) => row.sequence > (stoppedSeq ?? 0) && row.status === "starting"),
            ).toEqual([]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseStart, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseProviderY, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE A3n: listSessions fallback stops a listed session when projection reads stopped",
        () => {
          const releaseStart = Deferred.makeUnsafe<void>();
          const releaseProvider = Deferred.makeUnsafe<void>();
          let shellSpy: ReturnType<typeof vi.spyOn> | undefined;
          return Effect.gen(function* () {
            const startEntered = yield* Deferred.make<void>();
            const providerStopEntered = yield* Deferred.make<void>();
            const stopHandlerDone = yield* Deferred.make<void>();
            const threadX = ThreadId.make("thread-1");
            const compactionStartGate = { armed: false };
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) => {
                  if (!compactionStartGate.armed || session.threadId !== threadX) {
                    return Effect.succeed(session);
                  }
                  return Deferred.succeed(startEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseStart)),
                    Effect.as(session),
                  );
                },
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isStoppedSessionSet(command, threadX)
                    ? Deferred.succeed(stopHandlerDone, undefined)
                    : undefined,
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a3n" });
            compactionStartGate.armed = true;
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a3n-compact",
              messageId: "message-arestore-a3n-compact",
              text: "/compact",
            });
            yield* Deferred.await(startEntered);
            // Defensive fixture: ProviderService still lists the thread while the
            // stop handler's projection read is intentionally stale (stopped).
            harness.runtimeSessions.push({
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "ready",
              runtimeMode: "approval-required",
              threadId: ThreadId.make("thread-1"),
              resumeCursor: { opaque: "arestore-a3n" },
              createdAt: memoryNow,
              updatedAt: memoryNow,
            });
            const realShell = Option.getOrUndefined(
              yield* Effect.promise(() =>
                harness.runEffect(
                  harness.snapshotQuery.getThreadShellById(ThreadId.make("thread-1")),
                ),
              ),
            );
            expect(realShell).toBeDefined();
            shellSpy = vi.spyOn(harness.snapshotQuery, "getThreadShellById");
            shellSpy.mockImplementation(() =>
              Effect.succeed(
                Option.some({
                  ...realShell!,
                  session: {
                    threadId: ThreadId.make("thread-1"),
                    status: "stopped",
                    providerName: "codex",
                    providerInstanceId: ProviderInstanceId.make("codex"),
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: memoryNow,
                  },
                }),
              ),
            );
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a3n-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerStopEntered);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(stopHandlerDone);
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                shellSpy?.mockRestore();
                Deferred.doneUnsafe(releaseStart, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE A4: after stop, a new turn sends once without canceling the queued compaction failure path",
        () => {
          const releaseCompaction = Deferred.makeUnsafe<void, ProviderAdapterRequestError>();
          return Effect.gen(function* () {
            const compactEntered = yield* Deferred.make<void>();
            const stopHandlerDone = yield* Deferred.make<void>();
            const nEntered = yield* Deferred.make<void>();
            const compactionTerminal = yield* Deferred.make<void>();
            let compactInterrupted = false;
            const messageCompact = "message-arestore-a4-compact";
            const messageN = "message-arestore-a4-n";
            const injectedCompactionFailure = new ProviderAdapterRequestError({
              provider: "codex",
              method: "compactThread",
              detail: "injected compaction settlement failure",
            });
            const harness = yield* Effect.promise(() =>
              createHarness({
                compactThreadEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(compactEntered, undefined);
                    yield* Deferred.await(releaseCompaction);
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        compactInterrupted = true;
                      }),
                    ),
                  ),
                afterCommand: (command) => {
                  if (isStoppedSessionSet(command, ThreadId.make("thread-1"))) {
                    return Deferred.succeed(stopHandlerDone, undefined);
                  }
                  if (
                    isFailureActivityAppend(
                      command,
                      messageCompact,
                      injectedCompactionFailure.detail,
                    ) ||
                    isFailureActivityAppend(command, messageCompact, COMPACTION_INTERRUPTED_DETAIL)
                  ) {
                    return Deferred.succeed(compactionTerminal, undefined);
                  }
                  return undefined;
                },
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a4" });
            harness.sendTurn.mockImplementation(() =>
              Deferred.succeed(nEntered, undefined).pipe(
                Effect.as({
                  threadId: ThreadId.make("thread-1"),
                  turnId: asTurnId("turn-arestore-a4-n"),
                }),
              ),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a4-compact",
              messageId: messageCompact,
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-a4-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(stopHandlerDone);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a4-n",
              messageId: messageN,
              text: "turn after compaction stop",
            });
            yield* Effect.promise(() => harness.drain());
            if (Deferred.isDoneUnsafe(releaseCompaction) === false && !compactInterrupted) {
              Deferred.doneUnsafe(releaseCompaction, Effect.fail(injectedCompactionFailure));
            }
            yield* Deferred.await(compactionTerminal);
            yield* Effect.promise(() => harness.drain());
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(harness.sendTurn).toHaveBeenCalledTimes(2);
            const requestIdOf = (payload: unknown) =>
              typeof payload === "object" && payload !== null && "requestId" in payload
                ? String((payload as { requestId: string }).requestId)
                : "";
            expect(
              failureActivitiesOf(thread).filter(
                (activity) => requestIdOf(activity.payload) === messageN,
              ),
            ).toEqual([]);
            yield* Deferred.await(nEntered);
            yield* Effect.promise(() => harness.drain());
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!Deferred.isDoneUnsafe(releaseCompaction)) {
                  Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
                }
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE A5: interrupt during compactThread restores ready and allows a later /compact",
        () => {
          const releaseCompaction = Deferred.makeUnsafe<void>();
          const releaseProvider = Deferred.makeUnsafe<void>();
          const releaseSecondCompact = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const compactEntered = yield* Deferred.make<void>();
            const providerInterruptEntered = yield* Deferred.make<void>();
            const readyAfterInterrupt = yield* Deferred.make<void>();
            const secondCompactEntered = yield* Deferred.make<void>();
            const interruptPhase = { armed: false };
            const harness = yield* Effect.promise(() =>
              createHarness({
                compactThreadEffect: () =>
                  Deferred.succeed(compactEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCompaction)),
                  ),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(providerInterruptEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  interruptPhase.armed &&
                  command.type === "thread.session.set" &&
                  command.threadId === ThreadId.make("thread-1") &&
                  command.session.status === "ready"
                    ? Deferred.succeed(readyAfterInterrupt, undefined)
                    : undefined,
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a5" });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a5-compact",
              messageId: "message-arestore-a5-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            interruptPhase.armed = true;
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-arestore-a5-interrupt"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-arestore-a5-interrupt"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerInterruptEntered);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(readyAfterInterrupt);
            yield* Effect.promise(() => harness.drain());
            const afterEntered = yield* Deferred.make<void>();
            const afterSendFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            harness.sendTurn.mockImplementation(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(afterSendFiberD, yield* Effect.fiber);
                yield* Deferred.succeed(afterEntered, undefined);
                return {
                  threadId: ThreadId.make("thread-1"),
                  turnId: asTurnId("turn-arestore-a5-after"),
                };
              }),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a5-after",
              messageId: "message-arestore-a5-after",
              text: "ordinary after interrupt",
            });
            yield* Deferred.await(afterEntered);
            const afterSendExit = yield* Fiber.await(yield* Deferred.await(afterSendFiberD));
            expect(Exit.isSuccess(afterSendExit)).toBe(true);
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("cmd-arestore-a5-after-ready"),
              threadId: ThreadId.make("thread-1"),
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "ready",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: memoryNow,
              },
              createdAt: memoryNow,
            });
            harness.compactThread.mockImplementation(() =>
              Deferred.succeed(secondCompactEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSecondCompact)),
              ),
            );
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a5-compact-2",
              messageId: "message-arestore-a5-compact-2",
              text: "/compact",
            });
            yield* Deferred.await(secondCompactEntered);
            expect(harness.compactThread).toHaveBeenCalledTimes(2);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseSecondCompact, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE A6: interrupt failure after starting during compaction recovers with stopSession",
        () =>
          Effect.gen(function* () {
            const compactEntered = yield* Deferred.make<void>();
            const releaseCompaction = yield* Deferred.make<void>();
            const startingSeen = yield* Deferred.make<void>();
            const providerInterruptEntered = yield* Deferred.make<void>();
            const interruptFailed = yield* Deferred.make<void>();
            const compactionPhase = { armed: false };
            const harness = yield* Effect.promise(() =>
              createHarness({
                compactThreadEffect: () =>
                  Deferred.succeed(compactEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCompaction)),
                  ),
                interruptTurnEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(providerInterruptEntered, undefined);
                    return yield* Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: "codex",
                        method: "interruptTurn",
                        detail: "interrupt failed",
                      }),
                    );
                  }),
                afterCommand: (command) => {
                  if (
                    compactionPhase.armed &&
                    command.type === "thread.session.set" &&
                    command.session.status === "starting"
                  ) {
                    return Deferred.succeed(startingSeen, undefined);
                  }
                  if (
                    command.type === "thread.activity.append" &&
                    command.activity.kind === "provider.turn.interrupt.failed"
                  ) {
                    return Deferred.succeed(interruptFailed, undefined);
                  }
                  return undefined;
                },
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-a6" });
            compactionPhase.armed = true;
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a6-compact",
              messageId: "message-arestore-a6-compact",
              text: "/compact",
            });
            yield* Deferred.await(startingSeen);
            yield* Deferred.await(compactEntered);
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-arestore-a6-interrupt"),
              threadId: ThreadId.make("thread-1"),
              turnId: asTurnId("turn-arestore-a6-interrupt"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(providerInterruptEntered);
            yield* Deferred.await(interruptFailed);
            yield* Effect.promise(() => harness.drain());
            expect(harness.stopSession).toHaveBeenCalledTimes(1);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(thread?.session?.status).toBe("stopped");
            const rows = yield* sessionSetRows(harness, ThreadId.make("thread-1"));
            const stoppedSeq = rows.find((row) => row.status === "stopped")?.sequence;
            expect(
              rows.filter((row) => row.sequence > (stoppedSeq ?? 0) && row.status === "ready"),
            ).toEqual([]);
          }),
      );

      effectIt.effect("A-RESTORE A9: stopping one compacting thread does not disturb another", () =>
        Effect.gen(function* () {
          const xCompactEntered = yield* Deferred.make<void>();
          const releaseXCompact = yield* Deferred.make<void>();
          const yCompactEntered = yield* Deferred.make<void>();
          const releaseYCompact = yield* Deferred.make<void>();
          const yStopHandler = yield* Deferred.make<void>();
          const xReadyAfter = yield* Deferred.make<void>();
          const xRestorePhase = { armed: false };
          let compactCalls = 0;
          const harness = yield* Effect.promise(() =>
            createHarness({
              compactThreadEffect: () => {
                compactCalls += 1;
                return compactCalls === 1
                  ? Deferred.succeed(xCompactEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseXCompact)),
                    )
                  : Deferred.succeed(yCompactEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseYCompact)),
                    );
              },
              afterCommand: (command) => {
                if (isStoppedSessionSet(command, ThreadId.make("thread-2"))) {
                  return Deferred.succeed(yStopHandler, undefined);
                }
                if (
                  xRestorePhase.armed &&
                  command.type === "thread.session.set" &&
                  command.threadId === ThreadId.make("thread-1") &&
                  command.session.status === "ready"
                ) {
                  return Deferred.succeed(xReadyAfter, undefined);
                }
                return undefined;
              },
            }),
          );
          yield* seedReadyConversation(harness, { prefix: "arestore-a9-x" });
          yield* createSecondThread(harness);
          const ySeed = yield* Deferred.make<void>();
          harness.sendTurn.mockImplementation((sendInput) =>
            Deferred.succeed(ySeed, undefined).pipe(
              Effect.as({
                threadId: sendInput.threadId,
                turnId: asTurnId("turn-arestore-a9-y-seed"),
              }),
            ),
          );
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-arestore-a9-y-seed",
            messageId: "message-arestore-a9-y-seed",
            threadId: ThreadId.make("thread-2"),
            text: "y seed",
          });
          yield* Deferred.await(ySeed);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-arestore-a9-y-ready"),
            threadId: ThreadId.make("thread-2"),
            session: {
              threadId: ThreadId.make("thread-2"),
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: memoryNow,
            },
            createdAt: memoryNow,
          });
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-arestore-a9-x-compact",
            messageId: "message-arestore-a9-x-compact",
            threadId: ThreadId.make("thread-1"),
            text: "/compact",
          });
          yield* Deferred.await(xCompactEntered);
          yield* dispatchMemoryTurn(harness, {
            commandId: "cmd-arestore-a9-y-compact",
            messageId: "message-arestore-a9-y-compact",
            threadId: ThreadId.make("thread-2"),
            text: "/compact",
          });
          yield* Deferred.await(yCompactEntered);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-arestore-a9-y-stop"),
            threadId: ThreadId.make("thread-2"),
            createdAt: memoryNow,
          });
          yield* Deferred.await(yStopHandler);
          expect(Deferred.isDoneUnsafe(releaseXCompact)).toBe(false);
          xRestorePhase.armed = true;
          yield* Deferred.succeed(releaseXCompact, undefined);
          yield* Deferred.await(xReadyAfter);
          yield* Effect.promise(() => harness.drain());
          const xThread = yield* Effect.promise(() => threadOf(harness));
          const yThread = yield* Effect.promise(() =>
            threadById(harness, ThreadId.make("thread-2")),
          );
          expect(xThread?.session?.status).toBe("ready");
          expect(yThread?.session?.status).toBe("stopped");
        }),
      );

      effectIt.effect(
        "A-RESTORE A10: replay with ledger hold blocks at L0 without sendTurn or new attempts",
        () => {
          const releaseCompaction = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const compactEntered = yield* Deferred.make<void>();
            const replayHoldReported = yield* Deferred.make<void>();
            const harness = yield* Effect.promise(() =>
              createHarness({
                memoryGate: { driverKinds: codexDriverKinds() },
                compactThreadEffect: () =>
                  Deferred.succeed(compactEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCompaction)),
                  ),
                afterCommand: (command) =>
                  isMemoryFailureReport(
                    command,
                    "message-arestore-a10-queued",
                    MEMORY_SEND_HOLD_DETAIL["affected"],
                  )
                    ? Deferred.succeed(replayHoldReported, undefined)
                    : undefined,
              }),
            );
            expect(
              (yield* insertProjectMemory(harness, {
                memoryId: "mem-a10",
                title: "T-A10",
                body: "B-A10",
              })).status,
            ).toBe("applied");
            yield* seedReadyConversation(harness, { prefix: "arestore-a10" });
            yield* Effect.promise(() => seedAffectedRows(harness, "mem-a10"));
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a10-compact",
              messageId: "message-arestore-a10-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-a10-queued",
              messageId: "message-arestore-a10-queued",
              text: "chip [Project memory](t3-context://v1/memory/mem-a10)",
              records: [memoryChip("mem-a10", "mem-a10")],
            });
            yield* Effect.promise(() => harness.drain());
            yield* Effect.promise(() =>
              harness.runEffect(
                harness.memoryRepository.update({
                  projectId: asProjectId("project-1"),
                  memoryId: asMemoryId("mem-a10"),
                  expectedVersion: 1,
                  title: "T-A10 updated",
                  body: "B-A10 updated",
                  kind: "fact",
                  validUntil: null,
                  estimatedTokens: 0,
                  now: "2026-01-01T00:00:02.000Z",
                }),
              ),
            );
            expect(yield* affectedRowCount(harness)).toBe(1);
            yield* Deferred.succeed(releaseCompaction, undefined);
            yield* Deferred.await(replayHoldReported);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            expect(yield* sendAttemptStates(harness)).toEqual([{ state: "provider_accepted" }]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect(
        "A-RESTORE B1: stop handoff keeps in-transit replay on the canceled branch with sent finalized",
        () => {
          const releaseYStart = Deferred.makeUnsafe<void>();
          const releaseCompaction = Deferred.makeUnsafe<void>();
          const releaseReplayDispatch = Deferred.makeUnsafe<void>();
          const releaseProvider = Deferred.makeUnsafe<void>();
          return Effect.gen(function* () {
            const messageA = "message-arestore-b1-a";
            const messageB = "message-arestore-b1-b";
            const threadY = ThreadId.make("thread-2");
            const CANCELED_BEFORE_RESUME_DETAIL =
              "The queued message was canceled before it could resume. Send it again to continue.";
            const yStartEntered = yield* Deferred.make<void>();
            const ySendEntered = yield* Deferred.make<void>();
            const ySendFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const compactEntered = yield* Deferred.make<void>();
            const replayBefore = yield* Deferred.make<void>();
            const replayCommitted = yield* Deferred.make<void>();
            const providerStopEntered = yield* Deferred.make<void>();
            const reportA = yield* Deferred.make<void>();
            const reportB = yield* Deferred.make<void>();
            const replayLoopFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const harness = yield* Effect.promise(() =>
              createHarness({
                startSessionEffect: (session) =>
                  session.threadId === threadY
                    ? Deferred.succeed(yStartEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseYStart)),
                        Effect.as(session),
                      )
                    : Effect.succeed(session),
                compactThreadEffect: () =>
                  Deferred.succeed(compactEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCompaction)),
                  ),
                beforeTurnStartDispatch: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(replayBefore, undefined);
                    yield* Deferred.await(releaseReplayDispatch);
                  }),
                afterTurnStartDispatch: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(replayLoopFiberD, yield* Effect.fiber);
                    yield* Deferred.succeed(replayCommitted, undefined);
                  }),
                stopSessionEffect: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(providerStopEntered, undefined);
                    yield* Deferred.await(releaseProvider);
                  }),
                afterCommand: (command) =>
                  isFailureActivityAppend(command, messageB, STOPPED_DURING_COMPACTION_DETAIL)
                    ? Deferred.succeed(reportB, undefined)
                    : isFailureActivityAppend(command, messageA, CANCELED_BEFORE_RESUME_DETAIL)
                      ? Deferred.succeed(reportA, undefined)
                      : undefined,
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-b1" });
            harness.sendTurn.mockImplementation((sendInput) => {
              if (sendInput.threadId === threadY) {
                return Effect.gen(function* () {
                  yield* Deferred.succeed(ySendFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(ySendEntered, undefined);
                  return {
                    threadId: threadY,
                    turnId: asTurnId("turn-arestore-b1-y"),
                  };
                });
              }
              const input = sendInput.input ?? "";
              if (input.includes("queued A") || input.includes("queued B")) {
                return Effect.die(new Error("unexpected replay provider send in B1"));
              }
              return Effect.die(new Error("unexpected provider send in B1"));
            });
            harness.runtimeSessions.splice(0, harness.runtimeSessions.length);
            yield* createSecondThread(harness);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b1-compact",
              messageId: "message-arestore-b1-compact",
              text: "/compact",
            });
            yield* Deferred.await(compactEntered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b1-a",
              messageId: messageA,
              text: "queued A",
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b1-b",
              messageId: messageB,
              text: "queued B",
            });
            yield* Effect.promise(() => harness.drain());
            yield* Deferred.succeed(releaseCompaction, undefined);
            yield* Deferred.await(replayBefore);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b1-y",
              messageId: "message-arestore-b1-y",
              threadId: threadY,
              text: "thread Y blocks worker at session start",
            });
            yield* Deferred.await(yStartEntered);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-b1-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            expect(Deferred.isDoneUnsafe(providerStopEntered)).toBe(false);
            yield* Deferred.succeed(releaseReplayDispatch, undefined);
            yield* Deferred.await(replayCommitted);
            Deferred.doneUnsafe(releaseYStart, Effect.succeed(undefined));
            yield* Deferred.await(ySendEntered);
            const ySendExit = yield* Fiber.await(yield* Deferred.await(ySendFiberD));
            expect(Exit.isSuccess(ySendExit)).toBe(true);
            yield* Deferred.await(providerStopEntered);
            Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
            yield* Deferred.await(reportB);
            yield* Deferred.await(reportA);
            const replayLoopFiber = yield* Deferred.await(replayLoopFiberD);
            const replayLoopExit = yield* Fiber.await(replayLoopFiber);
            expect(Exit.isSuccess(replayLoopExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(2);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(releaseYStart, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseCompaction, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseReplayDispatch, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseProvider, Effect.succeed(undefined));
              }),
            ),
          );
        },
      );

      effectIt.effect.each(["release-lookup", "typed-lookup-failure"] as const)(
        "A-RESTORE B2 (%s): old replay lookup against a live successor compaction cannot cancel C or write sessions for D",
        (variant) => {
          const releaseCompact1 = Deferred.makeUnsafe<void>();
          const releaseCompact2 = Deferred.makeUnsafe<void>();
          const releaseLookup = Deferred.makeUnsafe<void, ProjectionRepositoryError>();
          let lookupSpy: ReturnType<typeof vi.spyOn> | undefined;
          return Effect.gen(function* () {
            const messageA = "message-arestore-b2-a";
            const messageC = "message-arestore-b2-c";
            const messageD = "message-arestore-b2-d";
            const textOldA = "queued old A";
            const textSuccessorC = "successor queued C";
            const textSuccessorD = "successor queued D";
            const compact1Entered = yield* Deferred.make<void>();
            const lookupParked = yield* Deferred.make<void>();
            const stopHandlerDone = yield* Deferred.make<void>();
            const injectedReplayLookupFailure = new PersistenceSqlError({
              operation: "ProjectionSnapshotQuery.getTurnStartMessage:query",
              detail: "injected replay lookup failure",
            });
            const compact2Entered = yield* Deferred.make<void>();
            const cEntered = yield* Deferred.make<void>();
            const dEntered = yield* Deferred.make<void>();
            const cSendFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const dSendFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const replayLoopFiberD = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
            const lookupGate = { armed: false };
            const replayFiberCaptured = { done: false };
            let compactCalls = 0;
            const harness = yield* Effect.promise(() =>
              createHarness({
                compactThreadEffect: () => {
                  compactCalls += 1;
                  return compactCalls === 1
                    ? Deferred.succeed(compact1Entered, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseCompact1)),
                      )
                    : Deferred.succeed(compact2Entered, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseCompact2)),
                      );
                },
                afterCommand: (command) =>
                  isStoppedSessionSet(command, ThreadId.make("thread-1"))
                    ? Deferred.succeed(stopHandlerDone, undefined)
                    : undefined,
              }),
            );
            const realGetTurnStart = harness.snapshotQuery.getTurnStartMessage.bind(
              harness.snapshotQuery,
            );
            lookupSpy = vi.spyOn(harness.snapshotQuery, "getTurnStartMessage");
            lookupSpy.mockImplementation((input: Parameters<typeof realGetTurnStart>[0]) =>
              Effect.gen(function* () {
                if (
                  lookupGate.armed &&
                  !replayFiberCaptured.done &&
                  input.messageId === asMessageId(messageA)
                ) {
                  replayFiberCaptured.done = true;
                  lookupGate.armed = false;
                  yield* Deferred.succeed(replayLoopFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(lookupParked, undefined);
                  yield* Deferred.await(releaseLookup);
                  if (variant === "typed-lookup-failure") {
                    return yield* Effect.fail(injectedReplayLookupFailure);
                  }
                }
                return yield* realGetTurnStart(input);
              }),
            );
            yield* seedReadyConversation(harness, { prefix: "arestore-b2" });
            harness.sendTurn.mockImplementation((sendInput) => {
              const input = sendInput.input ?? "";
              if (input.includes(textOldA)) {
                return Effect.die(new Error("unexpected old A provider send in B2"));
              }
              if (input.includes(textSuccessorC)) {
                return Effect.gen(function* () {
                  yield* Deferred.succeed(cSendFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(cEntered, undefined);
                  return {
                    threadId: ThreadId.make("thread-1"),
                    turnId: asTurnId("turn-arestore-b2-c"),
                  };
                });
              }
              if (input.includes(textSuccessorD)) {
                return Effect.gen(function* () {
                  yield* Deferred.succeed(dSendFiberD, yield* Effect.fiber);
                  yield* Deferred.succeed(dEntered, undefined);
                  return {
                    threadId: ThreadId.make("thread-1"),
                    turnId: asTurnId("turn-arestore-b2-d"),
                  };
                });
              }
              return Effect.die(new Error("unexpected provider send in B2"));
            });
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b2-compact1",
              messageId: "message-arestore-b2-compact1",
              text: "/compact",
            });
            yield* Deferred.await(compact1Entered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b2-a",
              messageId: messageA,
              text: textOldA,
            });
            yield* Effect.promise(() => harness.drain());
            lookupGate.armed = true;
            yield* Deferred.succeed(releaseCompact1, undefined);
            yield* Deferred.await(lookupParked);
            yield* harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make("cmd-arestore-b2-stop"),
              threadId: ThreadId.make("thread-1"),
              createdAt: memoryNow,
            });
            yield* Deferred.await(stopHandlerDone);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b2-compact2",
              messageId: "message-arestore-b2-compact2",
              text: "/compact",
            });
            yield* Deferred.await(compact2Entered);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b2-c",
              messageId: messageC,
              text: textSuccessorC,
            });
            yield* Effect.promise(() => harness.drain());
            const sessionSetsBeforeOldReplayCleanup = yield* sessionSetEventCount(harness);
            if (variant === "release-lookup") {
              yield* Deferred.succeed(releaseLookup, undefined);
            } else {
              Deferred.doneUnsafe(releaseLookup, Effect.fail(injectedReplayLookupFailure));
            }
            yield* Effect.promise(() => harness.drain());
            const replayLoopFiber = yield* Deferred.await(replayLoopFiberD);
            const replayLoopExit = yield* Fiber.await(replayLoopFiber);
            expect(Exit.isSuccess(replayLoopExit)).toBe(true);
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBeforeOldReplayCleanup);
            expect(Deferred.isDoneUnsafe(releaseCompact2)).toBe(false);
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            yield* dispatchMemoryTurn(harness, {
              commandId: "cmd-arestore-b2-d",
              messageId: messageD,
              text: textSuccessorD,
            });
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            expect(yield* sessionSetEventCount(harness)).toBe(sessionSetsBeforeOldReplayCleanup);
            const threadBeforeRelease = yield* Effect.promise(() => threadOf(harness));
            const requestIdOf = (payload: unknown) =>
              typeof payload === "object" && payload !== null && "requestId" in payload
                ? String((payload as { requestId: string }).requestId)
                : "";
            expect(
              failureActivitiesOf(threadBeforeRelease).filter(
                (activity) =>
                  requestIdOf(activity.payload) === messageC ||
                  requestIdOf(activity.payload) === messageD,
              ),
            ).toEqual([]);
            yield* Deferred.succeed(releaseCompact2, undefined);
            yield* Deferred.await(cEntered);
            yield* Deferred.await(dEntered);
            const cSendExit = yield* Fiber.await(yield* Deferred.await(cSendFiberD));
            const dSendExit = yield* Fiber.await(yield* Deferred.await(dSendFiberD));
            expect(Exit.isSuccess(cSendExit)).toBe(true);
            expect(Exit.isSuccess(dSendExit)).toBe(true);
            yield* Effect.promise(() => harness.drain());
            expect(harness.sendTurn).toHaveBeenCalledTimes(3);
            const thread = yield* Effect.promise(() => threadOf(harness));
            expect(
              failureActivitiesOf(thread).filter(
                (activity) =>
                  requestIdOf(activity.payload) === messageC ||
                  requestIdOf(activity.payload) === messageD,
              ),
            ).toEqual([]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                lookupSpy?.mockRestore();
                Deferred.doneUnsafe(releaseCompact1, Effect.succeed(undefined));
                Deferred.doneUnsafe(releaseCompact2, Effect.succeed(undefined));
                if (!Deferred.isDoneUnsafe(releaseLookup)) {
                  Deferred.doneUnsafe(releaseLookup, Effect.succeed(undefined));
                }
              }),
            ),
          );
        },
      );
    });
  });

  describe("B5 provider diagnostics on memory-used threads", () => {
    const threadId = ThreadId.make("thread-1");
    const MARK_TURN = "B5-TURN-MARK-e7c41a02";
    const MARK_COMPACT = "B5-COMPACT-MARK-9d02f7b4";
    const MARK_INTERRUPT = "B5-INTERRUPT-MARK-3ab5c911";
    const MARK_STOP = "B5-STOP-MARK-51e8d27a";
    const MARK_RESPOND = "B5-RESPOND-MARK-c7f014e3";
    const MARK_REPORTING = "B5-REPORTING-MARK-b6a90458";
    const MIXED_LOOKUP_REASON = "B5-MIXED-SQLFAIL-0d73e518";
    const LOOKUP_FAILED_LOG =
      "Project memory echo lookup failed; withholding provider diagnostics for this event.";

    const providerFailure = (detail: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread.turn.start",
          detail,
        }),
      );

    // Taints the thread for the echo guard without tripping the send gate: a
    // bare attempt row (no item rows, no memory mutation) never reaches
    // project_memory_affected, so the L0/L3 holds stay clean and the fake
    // provider is really entered before any diagnostic path can run.
    const seedTaint = (harness: MemoryHarness) =>
      harness.runSqlEffect(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO project_memory_send_attempts (
              thread_id, message_id, project_id, provider_instance_id,
              owner_instance_id, state, committed_at
            )
            VALUES (
              ${"thread-1"}, ${"b5-echo-seed-message"}, ${"project-1"}, ${"codex"},
              ${"b5-echo-seed-owner"}, 'provider_accepted', ${memoryNow}
            )
          `;
        }),
      );

    type B5Thread = Awaited<ReturnType<MemoryHarness["readModel"]>>["threads"][number] | undefined;

    const threadOf = async (harness: MemoryHarness): Promise<B5Thread> =>
      (await harness.readModel()).threads.find((entry) => entry.id === threadId);

    const activitiesOf = (thread: B5Thread, kind: string) =>
      (thread?.activities ?? []).filter((activity) => activity.kind === kind);

    // Every persisted byte the diagnostics can reach: the read model (session
    // lastError, activity payloads), the raw event stream behind it, and the
    // captured logger's message and cause fields.
    const storedTextOf = async (harness: MemoryHarness) => {
      const model = await harness.readModel();
      const events = await harness.runEffect(Stream.runCollect(harness.engine.readEvents(0)));
      const logText = harness.logs.map((log) => `${log.message}\n${log.cause}`).join("\n");
      return `${JSON.stringify({ model, events: Array.from(events) })}\n${logText}`;
    };

    const expectStoredMarkers = async (
      harness: MemoryHarness,
      markers: {
        readonly present?: string | undefined;
        readonly absent: ReadonlyArray<string>;
      },
    ) => {
      const stored = await storedTextOf(harness);
      for (const marker of markers.absent) {
        expect(stored).not.toContain(marker);
      }
      if (markers.present !== undefined) {
        expect(stored).toContain(markers.present);
      }
    };

    const dispatchMessage = (
      harness: MemoryHarness,
      input: { readonly commandId: string; readonly messageId: string; readonly text: string },
    ) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(input.commandId),
          threadId,
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

    const setSessionStatus = (
      harness: MemoryHarness,
      commandId: string,
      status: "ready" | "running",
    ) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: status === "running" ? asTurnId("b5-active-turn") : null,
            lastError: null,
            updatedAt: memoryNow,
          },
          createdAt: memoryNow,
        }),
      );

    const dispatchApproval = (harness: MemoryHarness, requestId: string) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make(`cmd-b5-approval-${requestId}`),
          threadId,
          requestId: asApprovalRequestId(requestId),
          decision: "accept",
          createdAt: memoryNow,
        }),
      );

    const dispatchUserInput = (harness: MemoryHarness, requestId: string) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`cmd-b5-user-input-${requestId}`),
          threadId,
          requestId: asApprovalRequestId(requestId),
          answers: { question: "answer" },
          createdAt: memoryNow,
        }),
      );

    // /compact needs an existing conversation and a non-starting session: one
    // successful send seeds the user message, then a direct ready write
    // unblocks the compaction preconditions.
    const seedConversationForCompaction = async (harness: MemoryHarness) => {
      const seeded = Deferred.makeUnsafe<void>();
      const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      harness.sendTurn.mockImplementation(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
          yield* Deferred.succeed(seeded, undefined);
          return { threadId, turnId: asTurnId("b5-compaction-seed") };
        }),
      );
      await dispatchMessage(harness, {
        commandId: "cmd-b5-compaction-seed",
        messageId: "b5-message-compaction-seed",
        text: "seed",
      });
      await harness.runEffect(Deferred.await(seeded));
      await harness.runEffect(Fiber.await(await harness.runEffect(Deferred.await(sendPhaseFiber))));
      await harness.drain();
      await setSessionStatus(harness, "cmd-b5-compaction-ready", "ready");
    };

    const awaitSendPhaseFiber = async (
      harness: MemoryHarness,
      sendPhaseFiber: Deferred.Deferred<Fiber.Fiber<unknown, unknown>>,
    ) => harness.runEffect(Fiber.await(await harness.runEffect(Deferred.await(sendPhaseFiber))));

    it.each(["clean", "tainted"] as const)(
      "withholds a failed send's raw detail on a %s thread",
      async (variant) => {
        const sendEntered = Deferred.makeUnsafe<void>();
        const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
        const harness = await createHarness({
          sendTurnEffect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
              yield* Deferred.succeed(sendEntered, undefined);
              return yield* providerFailure(MARK_TURN);
            }),
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await dispatchMessage(harness, {
          commandId: "cmd-b5-turn-failure",
          messageId: "b5-message-turn",
          text: "hello",
        });
        await harness.runEffect(Deferred.await(sendEntered));
        await awaitSendPhaseFiber(harness, sendPhaseFiber);
        await harness.drain();

        // The fake provider failure was really entered: a pre-send hold could
        // otherwise make the negative marker scan pass vacuously.
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const expected = variant === "tainted" ? MEMORY_ECHO_WITHHELD_ERROR : MARK_TURN;
        const thread = await threadOf(harness);
        expect(thread?.session).toMatchObject({
          status: "error",
          activeTurnId: null,
          lastError: expected,
        });
        const failures = activitiesOf(thread, "provider.turn.start.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.payload).toMatchObject({ detail: expected });
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_TURN,
          absent: variant === "tainted" ? [MARK_TURN] : [],
        });
      },
    );

    it.each(["clean", "tainted"] as const)(
      "withholds a failed compaction's raw detail on a %s thread",
      async (variant) => {
        const compactEntered = Deferred.makeUnsafe<void>();
        const compactPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
        const failureRecorded = Deferred.makeUnsafe<void>();
        const restoreRecorded = Deferred.makeUnsafe<void>();
        let compactCalls = 0;
        const harness = await createHarness({
          sendTurnEffect: () => Effect.succeed({ threadId, turnId: asTurnId("b5-seed") }),
          compactThreadEffect: () =>
            Effect.gen(function* () {
              compactCalls += 1;
              if (compactCalls === 1) {
                yield* Deferred.succeed(compactPhaseFiber, yield* Effect.fiber);
                yield* Deferred.succeed(compactEntered, undefined);
              }
              return yield* providerFailure(MARK_COMPACT);
            }),
          afterCommand: (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "provider.turn.start.failed" &&
            command.activity.summary === "Context compaction failed"
              ? Deferred.succeed(failureRecorded, undefined)
              : command.type === "thread.session.set" && command.session.status === "ready"
                ? Deferred.succeed(restoreRecorded, undefined)
                : undefined,
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await seedConversationForCompaction(harness);
        await dispatchMessage(harness, {
          commandId: "cmd-b5-compact",
          messageId: "b5-message-compact",
          text: "/compact",
        });
        await harness.runEffect(Deferred.await(compactEntered));
        await harness.runEffect(Deferred.await(failureRecorded));
        await harness.runEffect(Deferred.await(restoreRecorded));
        await harness.runEffect(
          Fiber.await(await harness.runEffect(Deferred.await(compactPhaseFiber))),
        );
        await harness.drain();

        expect(harness.compactThread).toHaveBeenCalledTimes(1);
        const thread = await threadOf(harness);
        const failures = activitiesOf(thread, "provider.turn.start.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.summary).toBe("Context compaction failed");
        const compactDetail = (failures[0]?.payload as { detail?: string } | undefined)?.detail;
        if (variant === "tainted") {
          expect(compactDetail).toBe(MEMORY_ECHO_WITHHELD_ERROR);
        } else {
          expect(compactDetail).toContain(MARK_COMPACT);
        }
        expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_COMPACT,
          absent: variant === "tainted" ? [MARK_COMPACT] : [],
        });
      },
    );

    it.each(["clean", "tainted"] as const)(
      "withholds a failed approval response's raw detail on a %s thread",
      async (variant) => {
        const harness = await createHarness({
          respondToRequestEffect: () => providerFailure(MARK_RESPOND),
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await setSessionStatus(harness, "cmd-b5-approval-ready", "ready");
        await dispatchApproval(harness, "b5-approval-1");
        await harness.drain();

        expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
        const thread = await threadOf(harness);
        const failures = activitiesOf(thread, "provider.approval.respond.failed");
        expect(failures).toHaveLength(1);
        const approvalDetail = (failures[0]?.payload as { detail?: string } | undefined)?.detail;
        if (variant === "tainted") {
          expect(approvalDetail).toBe(MEMORY_ECHO_WITHHELD_ERROR);
        } else {
          expect(approvalDetail).toContain(MARK_RESPOND);
        }
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_RESPOND,
          absent: variant === "tainted" ? [MARK_RESPOND] : [],
        });
      },
    );

    it.each(["clean", "tainted"] as const)(
      "withholds a failed user-input response's raw detail on a %s thread",
      async (variant) => {
        const harness = await createHarness({
          respondToUserInputEffect: () => providerFailure(MARK_RESPOND),
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await setSessionStatus(harness, "cmd-b5-user-input-ready", "ready");
        await dispatchUserInput(harness, "b5-input-1");
        await harness.drain();

        expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
        const thread = await threadOf(harness);
        const failures = activitiesOf(thread, "provider.user-input.respond.failed");
        expect(failures).toHaveLength(1);
        const inputDetail = (failures[0]?.payload as { detail?: string } | undefined)?.detail;
        if (variant === "tainted") {
          expect(inputDetail).toBe(MEMORY_ECHO_WITHHELD_ERROR);
        } else {
          expect(inputDetail).toContain(MARK_RESPOND);
        }
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_RESPOND,
          absent: variant === "tainted" ? [MARK_RESPOND] : [],
        });
      },
    );

    it("keeps the stale-pending approval and user-input phrases on a tainted thread", async () => {
      const harness = await createHarness({
        respondToRequestEffect: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "thread.approval.respond",
              detail: "Unknown pending approval request: b5-stale-approval",
            }),
          ),
        respondToUserInputEffect: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "thread.user-input.respond",
              detail: "Unknown pending user-input request: b5-stale-input",
            }),
          ),
      });
      await seedTaint(harness);
      await setSessionStatus(harness, "cmd-b5-stale-ready", "ready");
      await dispatchApproval(harness, "b5-stale-approval");
      await dispatchUserInput(harness, "b5-stale-input");
      await harness.drain();

      // Both fake provider failures were really entered before classification.
      expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
      expect(harness.respondToUserInput).toHaveBeenCalledTimes(1);
      const thread = await threadOf(harness);
      const approvals = activitiesOf(thread, "provider.approval.respond.failed");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.payload).toMatchObject({
        detail:
          "Stale pending approval request: b5-stale-approval. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
      });
      const inputs = activitiesOf(thread, "provider.user-input.respond.failed");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.payload).toMatchObject({
        detail:
          "Stale pending user-input request: b5-stale-input. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
      });
      await expectStoredMarkers(harness, {
        absent: ["Unknown pending approval request", "Unknown pending user-input request"],
      });
    });

    it.each(["clean", "tainted"] as const)(
      "withholds a failed interrupt's session and activity detail on a %s thread",
      async (variant) => {
        const interruptEntered = Deferred.makeUnsafe<void>();
        const harness = await createHarness({
          interruptTurnEffect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(interruptEntered, undefined);
              return yield* providerFailure(MARK_INTERRUPT);
            }),
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await setSessionStatus(harness, "cmd-b5-interrupt-running", "running");
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-b5-interrupt"),
            threadId,
            turnId: asTurnId("b5-active-turn"),
            createdAt: memoryNow,
          }),
        );
        await harness.runEffect(Deferred.await(interruptEntered));
        await harness.drain();

        expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
        const expected = variant === "tainted" ? MEMORY_ECHO_WITHHELD_ERROR : MARK_INTERRUPT;
        const thread = await threadOf(harness);
        expect(thread?.session).toMatchObject({ status: "stopped", lastError: expected });
        const failures = activitiesOf(thread, "provider.turn.interrupt.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.payload).toMatchObject({ detail: expected });
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_INTERRUPT,
          absent: variant === "tainted" ? [MARK_INTERRUPT] : [],
        });
      },
    );

    it.each(["clean", "tainted"] as const)(
      "withholds a failed session stop's activity detail on a %s thread",
      async (variant) => {
        const harness = await createHarness({
          stopSessionEffect: () => providerFailure(MARK_STOP),
        });
        if (variant === "tainted") {
          await seedTaint(harness);
        }
        await setSessionStatus(harness, "cmd-b5-stop-ready", "ready");
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-b5-stop"),
            threadId,
            createdAt: memoryNow,
          }),
        );
        await harness.drain();

        expect(harness.stopSession).toHaveBeenCalledTimes(1);
        const expected = variant === "tainted" ? MEMORY_ECHO_WITHHELD_ERROR : MARK_STOP;
        const thread = await threadOf(harness);
        const failures = activitiesOf(thread, "provider.session.stop.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.payload).toMatchObject({ detail: expected });
        // A failed stop leaves the session as it was; only the report is written.
        expect(thread?.session).toMatchObject({ status: "ready" });
        await expectStoredMarkers(harness, {
          present: variant === "tainted" ? undefined : MARK_STOP,
          absent: variant === "tainted" ? [MARK_STOP] : [],
        });
      },
    );

    it("withholds both original and reporting markers when the turn-start session write fails on a tainted thread", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const harness = await createHarness({
        sendTurnEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
            yield* Deferred.succeed(sendEntered, undefined);
            return yield* providerFailure(MARK_TURN);
          }),
        failDispatch: (command) =>
          command.type === "thread.session.set" && command.session.status === "error"
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "B5.injected.turn-start-reporting",
                  detail: MARK_REPORTING,
                }),
              )
            : undefined,
      });
      await seedTaint(harness);
      await dispatchMessage(harness, {
        commandId: "cmd-b5-reporting-turn",
        messageId: "b5-message-reporting",
        text: "hello",
      });
      await harness.runEffect(Deferred.await(sendEntered));
      await awaitSendPhaseFiber(harness, sendPhaseFiber);
      await harness.drain();

      // The nested reporting failure still ran the recovery fallback — with
      // both causes withheld near the sink.
      const fallback = harness.logs.find((log) =>
        log.message.startsWith("provider command reactor failed to recover turn start failure"),
      );
      if (!fallback) {
        return expect.fail("turn-start recovery fallback must have logged");
      }
      const logText = `${fallback.message}\n${fallback.cause}`;
      expect(logText).not.toContain(MARK_TURN);
      expect(logText).not.toContain(MARK_REPORTING);
      const thread = await threadOf(harness);
      expect(activitiesOf(thread, "provider.turn.start.failed")).toEqual([]);
      await expectStoredMarkers(harness, { absent: [MARK_TURN, MARK_REPORTING] });
    });

    it("uses one memory echo verdict for both turn-start recovery fallback cause fields", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const releaseReportingFailure = Deferred.makeUnsafe<void>();
      const harness = await createHarness({
        sendTurnEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
            yield* Deferred.succeed(sendEntered, undefined);
            return yield* providerFailure(MARK_TURN);
          }),
        failDispatch: (command) =>
          command.type === "thread.session.set" && command.session.status === "error"
            ? Effect.gen(function* () {
                yield* Deferred.await(releaseReportingFailure);
                return yield* Effect.fail(
                  new PersistenceSqlError({
                    operation: "B5.injected.turn-start-reporting",
                    detail: MARK_REPORTING,
                  }),
                );
              })
            : undefined,
      });
      await dispatchMessage(harness, {
        commandId: "cmd-b5-reporting-verdict-race",
        messageId: "b5-message-reporting-verdict-race",
        text: "hello",
      });
      await harness.runEffect(Deferred.await(sendEntered));
      // Taint lands after the provider failure but before recovery formats
      // both cause fields — one lookup must withhold both, not the first only.
      await seedTaint(harness);
      await harness.runEffect(Deferred.succeed(releaseReportingFailure, undefined));
      await awaitSendPhaseFiber(harness, sendPhaseFiber);
      await harness.drain();

      const fallback = harness.logs.find((log) =>
        log.message.startsWith("provider command reactor failed to recover turn start failure"),
      );
      if (!fallback) {
        return expect.fail("turn-start recovery fallback must have logged");
      }
      expect(fallback.message).not.toContain(MARK_TURN);
      expect(fallback.message).not.toContain(MARK_REPORTING);
      expect(fallback.message.match(new RegExp(MEMORY_ECHO_WITHHELD_ERROR, "g"))?.length).toBe(2);
    });

    it("uses one memory echo verdict for both interrupt stop-session fallback cause fields", async () => {
      const interruptEntered = Deferred.makeUnsafe<void>();
      const releaseStopFailure = Deferred.makeUnsafe<void>();
      const harness = await createHarness({
        interruptTurnEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(interruptEntered, undefined);
            return yield* providerFailure(MARK_INTERRUPT);
          }),
        stopSessionEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.await(releaseStopFailure);
            return yield* providerFailure(MARK_STOP);
          }),
      });
      await setSessionStatus(harness, "cmd-b5-interrupt-stop-running", "running");
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-b5-interrupt-stop"),
          threadId,
          turnId: asTurnId("b5-active-turn"),
          createdAt: memoryNow,
        }),
      );
      await harness.runEffect(Deferred.await(interruptEntered));
      await seedTaint(harness);
      await harness.runEffect(Deferred.succeed(releaseStopFailure, undefined));
      await harness.drain();

      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
      expect(harness.stopSession).toHaveBeenCalledTimes(1);
      const fallback = harness.logs.find((log) =>
        log.message.startsWith(
          "provider command reactor failed to stop session after interrupt failure",
        ),
      );
      if (!fallback) {
        return expect.fail("interrupt stop-session recovery fallback must have logged");
      }
      expect(fallback.message).not.toContain(MARK_INTERRUPT);
      expect(fallback.message).not.toContain(MARK_STOP);
      expect(fallback.message.match(new RegExp(MEMORY_ECHO_WITHHELD_ERROR, "g"))?.length).toBe(2);
    });

    it("retains both markers in the turn-start recovery fallback on a clean thread", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const harness = await createHarness({
        sendTurnEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
            yield* Deferred.succeed(sendEntered, undefined);
            return yield* providerFailure(MARK_TURN);
          }),
        failDispatch: (command) =>
          command.type === "thread.session.set" && command.session.status === "error"
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "B5.injected.turn-start-reporting",
                  detail: MARK_REPORTING,
                }),
              )
            : undefined,
      });
      await dispatchMessage(harness, {
        commandId: "cmd-b5-reporting-turn-clean",
        messageId: "b5-message-reporting-clean",
        text: "hello",
      });
      await harness.runEffect(Deferred.await(sendEntered));
      await awaitSendPhaseFiber(harness, sendPhaseFiber);
      await harness.drain();

      const fallback = harness.logs.find((log) =>
        log.message.startsWith("provider command reactor failed to recover turn start failure"),
      );
      if (!fallback) {
        return expect.fail("turn-start recovery fallback must have logged");
      }
      const logText = `${fallback.message}\n${fallback.cause}`;
      expect(logText).toContain(MARK_TURN);
      expect(logText).toContain(MARK_REPORTING);
    });

    // The compaction phase fiber is forked outside the worker queue, so its
    // recovery is observed through a second compaction: it can only enter
    // after the first phase's compaction flag cleared, which happens strictly
    // after the fallback log was written. No polling, no sleeps.
    const compactionReportingHarness = async (tainted: boolean) => {
      const compactEntered = Deferred.makeUnsafe<void>();
      const retryEntered = Deferred.makeUnsafe<void>();
      const reportingAttempted = Deferred.makeUnsafe<void>();
      let compactCalls = 0;
      const harness = await createHarness({
        sendTurnEffect: () => Effect.succeed({ threadId, turnId: asTurnId("b5-seed") }),
        compactThreadEffect: () =>
          Effect.gen(function* () {
            compactCalls += 1;
            if (compactCalls === 1) {
              yield* Deferred.succeed(compactEntered, undefined);
              return yield* providerFailure(MARK_COMPACT);
            }
            yield* Deferred.succeed(retryEntered, undefined);
            return Effect.void;
          }),
        failDispatch: (command) =>
          command.type === "thread.activity.append" &&
          command.activity.summary === "Context compaction failed"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(reportingAttempted, undefined);
                return yield* Effect.fail(
                  new PersistenceSqlError({
                    operation: "B5.injected.compaction-reporting",
                    detail: MARK_REPORTING,
                  }),
                );
              })
            : undefined,
      });
      if (tainted) {
        await seedTaint(harness);
      }
      await seedConversationForCompaction(harness);
      return { harness, compactEntered, retryEntered, reportingAttempted };
    };

    const runCompactionReporting = async (state: {
      readonly harness: MemoryHarness;
      readonly compactEntered: Deferred.Deferred<void>;
      readonly retryEntered: Deferred.Deferred<void>;
      readonly reportingAttempted: Deferred.Deferred<void>;
    }) => {
      const { harness, compactEntered, retryEntered, reportingAttempted } = state;
      await dispatchMessage(harness, {
        commandId: "cmd-b5-compact-1",
        messageId: "b5-message-compact-1",
        text: "/compact",
      });
      await harness.runEffect(Deferred.await(compactEntered));
      await harness.runEffect(Deferred.await(reportingAttempted));
      await setSessionStatus(harness, "cmd-b5-compact-ready-2", "ready");
      await dispatchMessage(harness, {
        commandId: "cmd-b5-compact-2",
        messageId: "b5-message-compact-2",
        text: "/compact",
      });
      await harness.runEffect(Deferred.await(retryEntered));
      await harness.drain();
    };

    it("withholds both markers when the compaction failure report dispatch fails on a tainted thread", async () => {
      const state = await compactionReportingHarness(true);
      await runCompactionReporting(state);

      const fallback = state.harness.logs.find((log) =>
        log.message.startsWith("provider command reactor failed to recover compaction failure"),
      );
      if (!fallback) {
        return expect.fail("compaction recovery fallback must have logged");
      }
      const logText = `${fallback.message}\n${fallback.cause}`;
      expect(logText).not.toContain(MARK_COMPACT);
      expect(logText).not.toContain(MARK_REPORTING);
      const thread = await threadOf(state.harness);
      expect(activitiesOf(thread, "provider.turn.start.failed")).toEqual([]);
      await expectStoredMarkers(state.harness, { absent: [MARK_COMPACT, MARK_REPORTING] });
    });

    it("retains both markers in the compaction recovery fallback on a clean thread", async () => {
      const state = await compactionReportingHarness(false);
      await runCompactionReporting(state);

      const fallback = state.harness.logs.find((log) =>
        log.message.startsWith("provider command reactor failed to recover compaction failure"),
      );
      if (!fallback) {
        return expect.fail("compaction recovery fallback must have logged");
      }
      const logText = `${fallback.message}\n${fallback.cause}`;
      expect(logText).toContain(MARK_COMPACT);
      expect(logText).toContain(MARK_REPORTING);
    });

    it("rechecks the ledger between the session and activity writes when taint lands late", async () => {
      const sendEntered = Deferred.makeUnsafe<void>();
      const sendPhaseFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      const sessionCommitted = Deferred.makeUnsafe<void>();
      const releaseForActivity = Deferred.makeUnsafe<void>();
      const harness = await createHarness({
        sendTurnEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sendPhaseFiber, yield* Effect.fiber);
            yield* Deferred.succeed(sendEntered, undefined);
            return yield* providerFailure(MARK_TURN);
          }),
        afterCommand: (command) =>
          command.type === "thread.session.set" && command.session.status === "error"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(sessionCommitted, undefined);
                yield* Deferred.await(releaseForActivity);
              })
            : undefined,
      });
      await dispatchMessage(harness, {
        commandId: "cmd-b5-race",
        messageId: "b5-message-race",
        text: "hello",
      });
      await harness.runEffect(Deferred.await(sendEntered));
      // The first sink judged clean and its session write carried the raw
      // detail. Taint lands only now, before the second sink looks.
      await harness.runEffect(Deferred.await(sessionCommitted));
      await seedTaint(harness);
      await harness.runEffect(Deferred.succeed(releaseForActivity, undefined));
      await awaitSendPhaseFiber(harness, sendPhaseFiber);
      await harness.drain();

      const thread = await threadOf(harness);
      expect(thread?.session).toMatchObject({ status: "error", lastError: MARK_TURN });
      const failures = activitiesOf(thread, "provider.turn.start.failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.payload).toMatchObject({ detail: MEMORY_ECHO_WITHHELD_ERROR });
    });

    it("fails closed on an unavailable lookup and recovers raw diagnostics after restore", async () => {
      const harness = await createHarness({
        respondToRequestEffect: () => providerFailure(MARK_RESPOND),
      });
      const approvalFailurePayload = (thread: B5Thread, requestId: string) => {
        const requestKey = asApprovalRequestId(requestId);
        const matches = activitiesOf(thread, "provider.approval.respond.failed").filter(
          (activity) => (activity.payload as { requestId?: string }).requestId === requestKey,
        );
        expect(matches).toHaveLength(1);
        return matches[0]?.payload as { detail?: string };
      };
      const renameAttemptsTableAway = () =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO project_memory_send_attempts_b5_gone`;
          }),
        );
      const renameAttemptsTableBack = () =>
        harness.runSqlEffect(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`ALTER TABLE project_memory_send_attempts_b5_gone RENAME TO project_memory_send_attempts`;
          }),
        );

      await setSessionStatus(harness, "cmd-b5-unavailable-ready", "ready");

      // Baseline: the clean thread keeps the raw detail.
      await dispatchApproval(harness, "b5-approval-clean");
      await harness.drain();
      expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
      let thread = await threadOf(harness);
      expect(approvalFailurePayload(thread, "b5-approval-clean").detail).toContain(MARK_RESPOND);

      await renameAttemptsTableAway();
      try {
        await dispatchApproval(harness, "b5-approval-unavailable");
        await harness.drain();
        expect(harness.respondToRequest).toHaveBeenCalledTimes(2);
        thread = await threadOf(harness);
        expect(approvalFailurePayload(thread, "b5-approval-unavailable")).toMatchObject({
          detail: MEMORY_ECHO_WITHHELD_ERROR,
        });
        const lookupWarning = harness.logs.find((log) => log.message.startsWith(LOOKUP_FAILED_LOG));
        if (!lookupWarning) {
          return expect.fail("unavailable lookup must log its fixed cause-free warning");
        }
        expect(lookupWarning.cause).toBe("");
      } finally {
        await renameAttemptsTableBack();
      }

      await dispatchApproval(harness, "b5-approval-restored");
      await harness.drain();
      expect(harness.respondToRequest).toHaveBeenCalledTimes(3);
      thread = await threadOf(harness);
      // The unavailable verdict was not cached: a clean lookup restores raw
      // diagnostics.
      expect(approvalFailurePayload(thread, "b5-approval-restored").detail).toContain(MARK_RESPOND);
    });

    it("propagates a mixed lookup cause past the worker boundary without diagnostics on a failing approval", async () => {
      const respondEntered = Deferred.makeUnsafe<void>();
      const harness = await createHarness({
        respondToRequestEffect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(respondEntered, undefined);
            return yield* providerFailure(MARK_RESPOND);
          }),
      });
      await seedTaint(harness);
      await setSessionStatus(harness, "cmd-b5-mixed-approval-ready", "ready");

      const injected = new PersistenceSqlError({
        operation: "B5.echoLookup",
        detail: MIXED_LOOKUP_REASON,
      });
      const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
      const observed = {
        type: "thread.approval-response-requested",
        exit: null as Exit.Exit<void, unknown> | null,
        done: Deferred.makeUnsafe<void>(),
      };
      workerObservation.armed = observed;
      harness.armEchoLookupFailure(threadId, mixedCause);
      await dispatchApproval(harness, "b5-approval-mixed");
      await harness.runEffect(Deferred.await(respondEntered));
      await harness.runEffect(Deferred.await(observed.done));
      harness.disarmEchoLookup();
      workerObservation.armed = null;

      // The real worker fiber observed the process Effect fail with the whole
      // original mixed cause: drain alone proves nothing about this outcome.
      const exit = observed.exit;
      if (!exit || Exit.isSuccess(exit)) {
        return expect.fail("worker must observe the mixed cause as a process failure");
      }
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(injected));

      // The provider failure was entered, and nothing below the interrupted
      // guard ran: no activity row, no marker anywhere persisted or logged.
      expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
      const thread = await threadOf(harness);
      expect(activitiesOf(thread, "provider.approval.respond.failed")).toEqual([]);
      await expectStoredMarkers(harness, { absent: [MARK_RESPOND, MIXED_LOOKUP_REASON] });
    });

    it("keeps a mixed lookup cause intact through compaction recovery", async () => {
      const compactEntered = Deferred.makeUnsafe<void>();
      const compactFiber = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
      let compactCalls = 0;
      const harness = await createHarness({
        sendTurnEffect: () => Effect.succeed({ threadId, turnId: asTurnId("b5-seed") }),
        compactThreadEffect: () =>
          Effect.gen(function* () {
            compactCalls += 1;
            if (compactCalls === 1) {
              yield* Deferred.succeed(compactFiber, yield* Effect.fiber);
              yield* Deferred.succeed(compactEntered, undefined);
            }
            return yield* providerFailure(MARK_COMPACT);
          }),
      });
      await seedTaint(harness);
      await seedConversationForCompaction(harness);

      const injected = new PersistenceSqlError({
        operation: "B5.echoLookup",
        detail: MIXED_LOOKUP_REASON,
      });
      const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
      harness.armEchoLookupFailure(threadId, mixedCause);
      await dispatchMessage(harness, {
        commandId: "cmd-b5-compact-mixed",
        messageId: "b5-message-compact-mixed",
        text: "/compact",
      });
      await harness.runEffect(Deferred.await(compactEntered));
      const exit = await harness.runEffect(
        Fiber.await(await harness.runEffect(Deferred.await(compactFiber))),
      );
      harness.disarmEchoLookup();

      // The phase child's boundary carries the mixed cause whole: the old
      // compaction recovery reduction to interruptOnly would have stripped
      // the typed component.
      if (!Exit.isFailure(exit)) {
        return expect.fail("compaction phase must exit failing with the mixed lookup cause");
      }
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(injected));

      const thread = await threadOf(harness);
      expect(activitiesOf(thread, "provider.turn.start.failed")).toEqual([]);
      // Masked cleanup still restores the session even when the activity guard
      // lookup fails with the mixed cause before any diagnostic write.
      expect(thread?.session).toMatchObject({ status: "ready", lastError: null });
      await expectStoredMarkers(harness, { absent: [MARK_COMPACT, MIXED_LOOKUP_REASON] });
    });
  });
});
