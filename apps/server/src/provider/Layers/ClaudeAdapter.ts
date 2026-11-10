// @effect-diagnostics nodeBuiltinImport:off
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  query,
  getSessionMessages,
  forkSession,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { type ClaudeScopedLimitNames } from "./claudeUsageLimits.ts";
import {
  ApprovalRequestId,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../ClaudeModelCatalog.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  type ProviderAdmissionObservation,
  type ProviderSendTurnAdmission,
} from "../Services/ProviderAdapter.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  CLAUDE_INTERRUPT_GRACE,
  type ClaudeQueryRuntime,
  type ClaudeSessionContext,
  type ClaudeTaskAgentState,
  type ClaudeTaskState,
  PROVIDER,
  type PendingApproval,
  type PendingUserInput,
  type PromptQueueItem,
  type ToolInFlight,
  type TurnAdmission,
  encodeJsonStringForDiagnostics,
  toSessionPermissionUpdates,
} from "./ClaudeAdapter.state.ts";
import {
  extractExitPlanModePlan,
  nativeProviderRefs,
  sdkNativeItemId,
  sdkNativeMethod,
  shouldRequestClaudeThinkingSummaries,
  toRequestError,
} from "./ClaudeAdapter.sdkMessages.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  readClaudeResumeState,
  summarizeToolRequest,
  taskLinkageFor,
} from "./ClaudeAdapter.tasks.ts";
import {
  finiteNonNegativeInteger,
  getEffectiveClaudeAgentEffort,
  isClaudeInterruptedCause,
  selectedClaudeContextWindow,
} from "./ClaudeAdapter.results.ts";
import {
  CLAUDE_SETTING_SOURCES,
  type ClaudeRouteProfileSeed,
  DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
  buildClaudeRouteProfile,
  buildUserMessageEffect,
  claudeRouteConfigSha256,
  projectClaudeSendControls,
  resolveClaudePromptInjectedEffort,
  sha256HexUtf8,
} from "./ClaudeAdapter.prompt.ts";
import {
  decodeHistoryFork,
  decodeSessionMessages,
  encodeHistoryArgs,
  isClaudeHumanTurnStart,
  remapClaudeForkTurnBoundaries,
} from "./ClaudeAdapter.history.ts";
import { makeClaudeRuntimeEmitters } from "./ClaudeAdapter.runtime.ts";
import { makeClaudeMessageHandlers } from "./ClaudeAdapter.messages.ts";
import { makeClaudeSystemHandlers } from "./ClaudeAdapter.system.ts";

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly getSessionMessages?: typeof getSessionMessages;
  readonly forkSession?: typeof forkSession;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly modelCatalog?: Effect.Effect<ClaudeModelCatalog>;
  /** Scoped-bucket names the driver's status probe last saw; see `claudeUsageLimits`. */
  readonly scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>;
}

/**
 * Hard wall-clock timeout the SDK applies to each t3-code tool call (the per-server `timeout`
 * of the MCP http-server config, in milliseconds; without it the client's own default governs).
 * It must cover the longest crew_wait a claudeAgent lead may use — the proven-client cap plus
 * its collection budget (crewTaskRecord PROVEN_CLIENT_WAIT_SECONDS + WAIT_COLLECT_SECONDS) —
 * with margin to spare; keep it above that budget when either side moves.
 */
export const T3_CODE_TOOL_TIMEOUT_MS = 360_000;

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const modelCatalogEffect = (
    options?.modelCatalog ?? Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG)
  ).pipe(Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  const claudeSdkExecutablePath = yield* resolveClaudeSdkExecutablePath(
    claudeSettings.binaryPath,
    claudeEnvironment,
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  // Every context recreation and every durable session id change consumes
  // the next generation; see ClaudeSessionContext.generation.
  let nextSessionGeneration = 0;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Claude runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeSdkMessage = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const {
    snapshotThread,
    resumeCursorOf,
    updateResumeCursor,
    ensureAssistantTextBlock,
    completeAssistantTextBlock,
    backfillAssistantTextBlocksFromSnapshot,
    emitReasoningSummaryDelta,
    backfillThinkingFromSnapshot,
    ensureThreadId,
    emitRuntimeError,
    emitRuntimeWarning,
    emitThreadTokenUsage,
    emitProposedPlanCompleted,
    emitClaudeTaskPlanUpdated,
    completeTurn,
  } = makeClaudeRuntimeEmitters({
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    runtimeEventQueue,
    nextSessionGeneration: () => ++nextSessionGeneration,
  });
  const {
    handleStreamEvent,
    handleUserMessage,
    handleAssistantMessage,
    handleResultMessage,
    emitWorkflowMemberProgress,
  } = makeClaudeMessageHandlers({
    path,
    claudeEnvironment,
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    backfillAssistantTextBlocksFromSnapshot,
    backfillThinkingFromSnapshot,
    completeAssistantTextBlock,
    completeTurn,
    emitClaudeTaskPlanUpdated,
    emitProposedPlanCompleted,
    emitReasoningSummaryDelta,
    emitRuntimeError,
    emitThreadTokenUsage,
    ensureAssistantTextBlock,
    updateResumeCursor,
  });
  const { runSdkStream } = makeClaudeSystemHandlers({
    makeEventStamp,
    offerRuntimeEvent,
    logNativeSdkMessage,
    scopedLimitNames: options?.scopedLimitNames,
    emitRuntimeError,
    emitRuntimeWarning,
    emitThreadTokenUsage,
    ensureThreadId,
    emitWorkflowMemberProgress,
    handleAssistantMessage,
    handleResultMessage,
    handleStreamEvent,
    handleUserMessage,
  });
  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime interrupted.");
        }
      } else {
        const failures = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error] : [],
        );
        const message = failures[0]?.detail ?? "Claude runtime stream failed.";
        yield* emitRuntimeError(context, message, {
          failureCount: failures.length,
          failureTags: failures.map((failure) => failure._tag),
        });
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    // Schedule process termination before any cleanup that can wait on the
    // provider. The SDK closes stdin, then escalates from SIGTERM to SIGKILL.
    yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Failed to close Claude runtime query.",
          cause,
        }),
    });

    context.stopped = true;
    yield* Deferred.succeed(context.closed, undefined);

    for (const taskId of Array.from(context.liveTaskIds)) {
      if (!context.liveTaskIds.delete(taskId)) {
        continue;
      }
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "task.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        payload: {
          taskId: RuntimeTaskId.make(taskId),
          status: "stopped",
          ...taskLinkageFor(context.taskAgents, taskId),
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();

    // Same reason as the approvals above: a request nobody can answer any more
    // must not stay open, or the thread can never be settled.
    for (const pending of context.pendingUserInputs.values()) {
      yield* pending.cancel;
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(streamFiber);
    }

    // After the stream is interrupted, so Stop never waits for a stream that is
    // completing the turn: an interrupted owner settles its mark and Stop
    // publishes the turn itself, unless the owner already did.
    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false && sessions.get(context.session.threadId) === context) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    if (sessions.get(context.session.threadId) === context) {
      sessions.delete(context.session.threadId);
    }
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const modelCatalog = yield* modelCatalogEffect;
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        });
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;
      const newSessionId = existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined;
      const sessionId = existingResumeSessionId ?? newSessionId;

      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<number, ToolInFlight>();
      const claudeTasks = new Map<string, ClaudeTaskState>();
      const taskAgents = new Map<string, ClaudeTaskAgentState>();
      const pendingTaskModels = new Map<string, string>();
      const workflowMemberFingerprints = new Map<string, string>();
      const liveTaskIds = new Set<string>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: {
          readonly signal: AbortSignal;
          readonly toolUseID?: string;
        },
      ) {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);

        // Parse questions from the SDK's AskUserQuestion input.
        // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
        // up answers by question text in `mapToolResultToToolResultBlockParam`,
        // so the key the UI uses to keep its draft answer must match the SDK's
        // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
            header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === "string" ? opt.label : "",
                  description: typeof opt.description === "string" ? opt.description : "",
                }))
              : [],
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
          }),
        );

        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        let aborted = false;
        const settleAsAborted = Effect.suspend(() => {
          if (!pendingUserInputs.has(requestId)) {
            return Effect.void;
          }
          aborted = true;
          pendingUserInputs.delete(requestId);
          return Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers).pipe(
            Effect.ignore,
          );
        });
        const pendingInput: PendingUserInput = {
          questions,
          answers: answersDeferred,
          cancel: settleAsAborted,
        };

        // Emit user-input.requested so the UI can present the questions.
        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { questions },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion",
            payload: {
              toolName: "AskUserQuestion",
              input: toolInput,
            },
          },
        });

        pendingUserInputs.set(requestId, pendingInput);

        // Handle abort (e.g. turn interrupted while waiting for user input).
        const onAbort = () => {
          runFork(settleAsAborted);
        };
        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        // The signal may have aborted during the awaited event emissions
        // above, before the listener existed; settle now so the dialog
        // cannot hang with a lingering pending question.
        if (callbackOptions.signal.aborted) {
          yield* settleAsAborted;
        }

        // Block until the user provides answers.
        const answers = yield* Deferred.await(answersDeferred);
        pendingUserInputs.delete(requestId);

        // Emit user-input.resolved so the UI knows the interaction completed.
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { answers },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion/resolved",
            payload: { answers },
          },
        });

        if (aborted) {
          return {
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult;
        }

        // Return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: "allow",
          updatedInput: {
            questions: toolInput.questions,
            answers,
          },
        } satisfies PermissionResult;
      });

      const handleResumeDialog = Effect.fn("handleResumeDialog")(function* (
        request: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
        callbackOptions: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
      ) {
        if (request.dialogKind !== "resume_return") {
          return { behavior: "cancelled" as const };
        }

        const context = yield* Ref.get(contextRef);
        if (!context) {
          return { behavior: "cancelled" as const };
        }

        // The question copy lives in @t3tools/shared/claudeCompaction because
        // the web client recognizes this exact text (and the "never" answer)
        // to mirror a permanent dismissal.
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: finiteNonNegativeInteger(request.payload.sessionAgeMinutes) ?? 0,
          estimatedTokens: finiteNonNegativeInteger(request.payload.estimatedTokens) ?? 0,
        });
        const result = yield* handleAskUserQuestion(
          context,
          {
            questions: [
              {
                header: "Resume session",
                question,
                options: [
                  {
                    label: "Compact and continue",
                    description: "Resume with a summary and use fewer tokens.",
                  },
                  {
                    label: "Keep full history",
                    description: "Resume without changing the conversation.",
                  },
                  {
                    label: CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
                    description: "Keep full history and skip future resume prompts.",
                  },
                ],
                multiSelect: false,
              },
            ],
          },
          {
            signal: callbackOptions.signal,
            ...(request.toolUseID ? { toolUseID: request.toolUseID } : {}),
          },
        );

        if (result.behavior !== "allow") {
          return { behavior: "cancelled" as const };
        }

        const answers = result.updatedInput.answers;
        const selection =
          answers && typeof answers === "object" && !Array.isArray(answers)
            ? (answers as Record<string, unknown>)[question]
            : undefined;
        const action =
          selection === "Compact and continue"
            ? "compact"
            : selection === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER
              ? "never"
              : "continue";

        return { behavior: "completed" as const, result: action };
      });

      const canUseToolEffect = Effect.fn("canUseTool")(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        const runtimeMode = input.runtimeMode ?? "full-access";
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput);
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });
        // Same late-listener race as handleAskUserQuestion: the signal may
        // have aborted while the request event emissions were awaited.
        if (callbackOptions.signal.aborted) {
          onAbort();
        }

        const decision = yield* Deferred.await(decisionDeferred);
        pendingApprovals.delete(requestId);

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            decision,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/decision",
            payload: {
              decision,
            },
          },
        });

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "acceptForSession"
              ? {
                  updatedPermissions: toSessionPermissionUpdates(
                    toolName,
                    pendingApproval.suggestions,
                  ),
                }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));
      const onUserDialog: NonNullable<ClaudeQueryOptions["onUserDialog"]> = (
        request,
        callbackOptions,
      ) => runPromise(handleResumeDialog(request, callbackOptions));

      const claudeBinaryPath = claudeSdkExecutablePath;
      const {
        "permission-mode": launchArgPermissionMode,
        "dangerously-skip-permissions": launchArgSkipPermissions,
        ...extraArgs
      } = parseCliArgs(claudeSettings.launchArgs).flags;
      const selectedModel =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const modelSelection = selectedModel
        ? {
            ...selectedModel,
            model: resolveClaudeModelSlug(modelCatalog, selectedModel.model),
          }
        : undefined;
      const caps = getClaudeCatalogModelCapabilities(modelCatalog, modelSelection?.model);
      const descriptors = getProviderOptionDescriptors({ caps });
      const apiModelId = modelSelection
        ? resolveClaudeCatalogApiModelId(modelCatalog, modelSelection)
        : undefined;
      const initialContextWindow = selectedClaudeContextWindow(modelCatalog, modelSelection);
      const autoCompactWindow = claudeSettings.autoCompactWindow
        ? Number(claudeSettings.autoCompactWindow)
        : initialContextWindow !== undefined &&
            initialContextWindow > DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW
          ? DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW
          : undefined;
      const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
      const effort =
        resolveClaudeCatalogEffort(modelCatalog, modelSelection?.model, rawEffort) ?? null;
      const fastModeSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
      );
      const thinkingSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
      );
      const fastMode =
        getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true &&
        fastModeSupported;
      const thinking = thinkingSupported
        ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
        : undefined;
      const thinkingDisplayArg = extraArgs["thinking-display"];
      const requestThinkingSummaries = shouldRequestClaudeThinkingSummaries({
        thinking,
        thinkingDisplay: typeof thinkingDisplayArg === "string" ? thinkingDisplayArg : undefined,
      });
      const ultracode = isClaudeCatalogUltracodeEffort(effort);
      const effectiveEffort = getEffectiveClaudeAgentEffort(
        modelCatalog,
        effort,
        modelSelection?.model,
      );
      const runtimeModeToPermission: Record<string, PermissionMode> = {
        "auto-accept-edits": "acceptEdits",
        auto: "auto",
        "full-access": "bypassPermissions",
      };
      // A permission launch arg is folded into the mode T3 sends rather than
      // passed through: the CLI resolves both inputs together, so argv order
      // never let the user's flag win.
      const permissionMode =
        (launchArgPermissionMode as PermissionMode | null | undefined) ??
        (launchArgSkipPermissions === null || launchArgSkipPermissions === "true"
          ? "bypassPermissions"
          : runtimeModeToPermission[input.runtimeMode]);
      const settings = {
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(requestThinkingSummaries ? { showThinkingSummaries: true } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
        ...(autoCompactWindow !== undefined ? { autoCompactWindow } : {}),
      };
      if (requestThinkingSummaries && extraArgs["thinking-display"] === undefined) {
        extraArgs["thinking-display"] = "summarized";
      }
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      // The attachments dir grant lets the agent Read/copy pasted images at
      // the paths ProviderService injects into the turn text, without an
      // approval prompt. It is a leaf directory holding only attachment
      // files; siblings like secrets/ and state.sqlite stay ungranted.
      const additionalDirectories = [
        ...(input.cwd ? [input.cwd] : []),
        serverConfig.attachmentsDir,
      ];
      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // Model and effort can change after this session-level prompt is set.
          append: buildRuntimeInstructions({ harness: "Claude Code", projectMemory: true }),
        },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        // `ultracode` is a Claude Code setting, not an API effort level. It is
        // normalized to `xhigh` above and paired with `settings.ultracode`.
        ...(effectiveEffort
          ? {
              effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions["effort"]>,
            }
          : {}),
        ...(extraArgs["thinking-display"] === "summarized"
          ? {
              thinking: {
                type: "adaptive" as const,
                display: "summarized" as const,
              },
            }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        includePartialMessages: true,
        canUseTool,
        onUserDialog,
        supportedDialogKinds: ["resume_return"],
        env: McpProviderSession.withAgentDeviceEnvironment(
          claudeSettings.claudeAiConnectors
            ? claudeEnvironment
            : { ...claudeEnvironment, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
          mcpSession,
        ),
        additionalDirectories,
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        ...(mcpSession
          ? {
              mcpServers: {
                "t3-code": {
                  type: "http",
                  url: mcpSession.endpoint,
                  headers: {
                    Authorization: mcpSession.authorizationHeader,
                  },
                  timeout: T3_CODE_TOOL_TIMEOUT_MS,
                },
              },
            }
          : {}),
      };

      // The route profile's launch-fixed half, snapshotted from the exact
      // options and settings constructed above — never recomputed from later
      // state. `thinking-display` is the only launch arg the profile
      // accounts for; a bare flag or any other extra arg leaves the route
      // unprovable, so capture stays unavailable while the send itself is
      // unaffected.
      const systemPromptOption = queryOptions.systemPrompt;
      const systemPromptPresetOption =
        typeof systemPromptOption === "object" &&
        systemPromptOption !== null &&
        !Array.isArray(systemPromptOption) &&
        systemPromptOption.type === "preset"
          ? systemPromptOption
          : undefined;
      const thinkingOption = queryOptions.thinking;
      const queryThinkingDisplay =
        thinkingOption !== undefined && "display" in thinkingOption
          ? (thinkingOption.display ?? null)
          : null;
      const routeProfileSeed: ClaudeRouteProfileSeed | undefined =
        Object.keys(extraArgs).every((key) => key === "thinking-display") &&
        extraArgs["thinking-display"] !== null
          ? {
              launchEffort: queryOptions.effort ?? null,
              queryThinkingDisplay,
              argumentThinkingDisplay: extraArgs["thinking-display"] ?? null,
              alwaysThinkingEnabled: settings.alwaysThinkingEnabled ?? null,
              showThinkingSummaries: settings.showThinkingSummaries ?? null,
              fastMode: settings.fastMode ?? null,
              ultracode: settings.ultracode ?? null,
              autoCompactWindow: settings.autoCompactWindow ?? null,
              settingSources: Object.freeze([...(queryOptions.settingSources ?? [])]),
              systemPromptPreset: systemPromptPresetOption?.preset ?? null,
              systemPromptAppendSha256:
                typeof systemPromptPresetOption?.append === "string"
                  ? sha256HexUtf8(systemPromptPresetOption.append)
                  : null,
            }
          : undefined;

      yield* Effect.annotateCurrentSpan({
        "provider.kind": PROVIDER,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
        "claude.resume.source":
          existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
        "claude.resume.thread_id": resumeState?.threadId ?? "",
        "claude.resume.session_id": existingResumeSessionId ?? "",
        "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
        "claude.resume.turn_count": resumeState?.turnCount ?? -1,
        "claude.query.cwd": input.cwd ?? "",
        "claude.query.model": apiModelId ?? "",
        "claude.query.effort": effectiveEffort ?? "",
        "claude.query.permission_mode": permissionMode ?? "",
        "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
        "claude.query.resume": existingResumeSessionId ?? "",
        "claude.query.session_id": newSessionId ?? "",
        "claude.query.include_partial_messages": true,
        "claude.query.additional_directories": additionalDirectories,
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Failed to start Claude runtime session.",
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
          ...(resumeState?.turnStartMessageIds
            ? { turnStartMessageIds: resumeState.turnStartMessageIds }
            : {}),
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        startInput: input,
        turnStartMessageIds: resumeState?.turnStartMessageIds
          ? [...resumeState.turnStartMessageIds]
          : Array.from({ length: resumeState?.turnCount ?? 0 }, () => null),
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentApiModelId: apiModelId,
        currentEffort: effectiveEffort ?? undefined,
        currentPermissionMode: permissionMode,
        resumeSessionId: sessionId,
        routeProfileSeed,
        generation: ++nextSessionGeneration,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        claudeTasks,
        taskAgents,
        pendingTaskModels,
        workflowMemberFingerprints,
        liveTaskIds,
        turnState: undefined,
        lastKnownContextWindow: initialContextWindow,
        lastKnownTokenUsage: undefined,
        lastKnownTotalProcessedTokens: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        announcedUsageLimits: undefined,
        interruptedTurnSettled: undefined,
        completing: undefined,
        sendTurnLock: yield* Semaphore.make(1),
        closed: yield* Deferred.make<void>(),
        stopped: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit).pipe(
              Effect.catch((cause) =>
                Effect.logError("Failed to close Claude runtime stream.", { cause }),
              ),
            );
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  /**
   * Overlapping sends on one session run setup and admission one at a time.
   * Setup (SDK configuration, skill scan, message build) happens before any
   * turn exists, so a failed send leaves no turn state behind. Admission then
   * decides steer-or-start and publishes the prompt, the turn state and
   * turn.started in one synchronous step, so a turn that finished during setup
   * is never steered into, and Stop or an interrupted caller sees all of a
   * send or none of it. A caller interrupted just after that step still gets
   * the interrupt although its prompt was admitted. The lock covers setup and
   * admission only, never the provider turn's lifetime.
   *
   * A turn is steerable until completeTurn begins. From then on admission
   * waits, holding the lock only for the completion, and stops waiting when the
   * session closes; it then starts its own turn. A send's close of a stale
   * synthetic turn cannot be interrupted partway, so it never leaves the turn
   * half closed.
   *
   * Not covered: a send admitted before completeTurn begins still steers into a
   * turn whose result the SDK has already sent but the stream has not reached,
   * and a result is tied only to the turn the stream saw when it arrived, so a
   * result for a turn already published reports its thread usage alone. A turn
   * whose owner fails partway
   * is published again by the next completion, which repeats the tool and text
   * item events the aborted attempt had already offered.
   */
  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (
    input,
    sendAdmission?: ProviderSendTurnAdmission,
  ) {
    const context = yield* requireSession(input.threadId);
    const modelCatalog = yield* modelCatalogEffect;
    const selectedModel =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;
    const modelSelection = selectedModel
      ? { ...selectedModel, model: resolveClaudeModelSlug(modelCatalog, selectedModel.model) }
      : undefined;

    // Checked against the captured context, so a replacement session for the
    // same thread never counts as this send's session.
    const sessionClosed = () =>
      new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId: input.threadId });
    const isOpen = () => !context.stopped && sessions.get(input.threadId) === context;
    const ensureOpen = Effect.suspend(() =>
      isOpen() ? Effect.void : Effect.fail(sessionClosed()),
    );
    // Stop completes `closed` even when the SDK never settles a pending
    // control request, so a send parked on one is released without the SDK.
    const untilClosed = Deferred.await(context.closed).pipe(
      Effect.flatMap(() => Effect.fail(sessionClosed())),
    );
    const callSdk = <A>(method: string, run: () => Promise<A>) =>
      ensureOpen.pipe(
        Effect.andThen(
          Effect.raceFirst(
            Effect.tryPromise({
              try: run,
              catch: (cause) => toRequestError(input.threadId, method, cause),
            }),
            untilClosed,
          ),
        ),
      );

    return yield* context.sendTurnLock.withPermit(
      Effect.gen(function* () {
        yield* ensureOpen;
        if (modelSelection) {
          context.startInput = { ...context.startInput, modelSelection };
        }

        // The setter targets this send would leave behind — the same pure
        // projection the read-only route preview recomputes for the input.
        const projectedSendControls = projectClaudeSendControls(
          context,
          input,
          modelCatalog,
          boundInstanceId,
        );

        if (modelSelection?.model) {
          const apiModelId = projectedSendControls.apiModel;
          if (apiModelId !== undefined && context.currentApiModelId !== apiModelId) {
            yield* callSdk("turn/setModel", () => context.query.setModel(apiModelId));
            context.currentApiModelId = apiModelId;
          }
          context.session = {
            ...context.session,
            model: modelSelection.model,
          };
          context.currentEffort = projectedSendControls.effort;
        }

        // Apply interaction mode by switching the SDK's permission mode.
        // "plan" maps directly to the SDK's "plan" permission mode;
        // "default" restores the session's original permission mode.
        // When interactionMode is absent we leave the current mode unchanged.
        if (input.interactionMode === "plan") {
          yield* callSdk("turn/setPermissionMode", () => context.query.setPermissionMode("plan"));
          context.currentPermissionMode = "plan";
        } else if (input.interactionMode === "default") {
          const restoredMode = context.basePermissionMode ?? "default";
          yield* callSdk("turn/setPermissionMode", () =>
            context.query.setPermissionMode(restoredMode),
          );
          context.currentPermissionMode = restoredMode;
        }

        // Re-scan on every send: skills are added and switched off mid-session,
        // and the scan is a few directory reads. A skill switched off via
        // skillOverrides, or reserved for the agent with `user-invocable: false`,
        // is left as prose: the CLI would answer `/name` with a notice instead of
        // running it.
        const skills = yield* discoverClaudeSkills(
          claudeSettings,
          context.session.cwd,
          claudeEnvironment,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
          boundInstanceId,
          modelCatalog,
          skillNames: new Set(
            skills
              .filter((skill) => skill.enabled && skill.userInvocable !== false)
              .map((skill) => skill.name),
          ),
        });

        // Admission. A sendTurn while a real turn is running is a steer: the
        // message is queued into the live SDK agent loop and the work continues
        // as the same turn — no synthetic turn boundary. Stale synthetic turns
        // (from background agent responses between user prompts) are
        // auto-closed instead, so they don't block the user's next turn.
        //
        // The decision and everything it publishes (prompt, turn state,
        // turn.started) happen in one synchronous step. Stop or an interrupt of
        // this send can land before it or after it, never inside it.
        const freshTurnId = TurnId.make(yield* randomUUIDv4);
        const publishAdmission = (
          startedAt: string,
          turnStartedStamp: Effect.Success<ReturnType<typeof makeEventStamp>>,
        ): TurnAdmission => {
          if (!isOpen()) {
            return { _tag: "Closed" };
          }
          if (context.completing) {
            return { _tag: "AwaitCompletion", completion: context.completing };
          }
          const current = context.turnState;
          if (current?.synthetic === true) {
            return { _tag: "CloseSynthetic" };
          }
          const turnId = current?.turnId ?? freshTurnId;

          // The managed-capture candidate: the exact final text blocks of the
          // built user message plus the digest of the route profile this
          // context publishes under, computed at the publish point so the
          // observation reads the same context the gate sees. A send whose
          // model, permission mode or native identity is unprovable — or
          // whose launch args carry anything beyond the accounted
          // thinking-display flag — reports no candidate while the send is
          // unchanged.
          let candidate: ProviderAdmissionObservation["submissionCandidate"];
          try {
            candidate = (() => {
              const seed = context.routeProfileSeed;
              // Post-setter state on this exact context: the model,
              // permission mode and session effort the send's setters
              // actually left behind — not the input's request.
              const apiModel = context.currentApiModelId;
              const permissionMode = context.currentPermissionMode;
              const content = message.message.content;
              if (
                seed === undefined ||
                context.resumeSessionId === undefined ||
                apiModel === undefined ||
                permissionMode === undefined ||
                !Array.isArray(content)
              ) {
                return undefined;
              }
              return {
                textBlocks: Object.freeze(
                  content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
                ),
                routeConfigSha256: claudeRouteConfigSha256(
                  buildClaudeRouteProfile({
                    seed,
                    providerInstanceId: boundInstanceId,
                    apiModel,
                    permissionMode,
                    subagentDefaultEffort: context.currentEffort ?? null,
                    promptInjectedEffort: resolveClaudePromptInjectedEffort(
                      modelCatalog,
                      input,
                      boundInstanceId,
                    ),
                  }),
                ),
              };
            })();
          } catch {
            candidate = undefined;
          }

          // The caller's last-word gate: synchronous, on every would-publish
          // path, and after every await this send took. A refusal — or a hook
          // that throws — leaves the prompt, turn state and events untouched,
          // so the send fails Closed.
          let admitted = true;
          if (sendAdmission !== undefined) {
            try {
              admitted = sendAdmission.admit({
                sessionGeneration: context.generation,
                nativeSessionId: context.resumeSessionId,
                ...(candidate !== undefined ? { submissionCandidate: candidate } : {}),
              });
            } catch {
              admitted = false;
            }
          }
          if (!admitted) {
            return { _tag: "Closed" };
          }

          // Offered first so a refusal leaves nothing written. The queue is shut
          // down only by Stop, after it marks the session stopped, so isOpen()
          // above already ruled a refusal out. Its consumer wakes in a later
          // scheduled task, never inside this call.
          const accepted = Queue.offerUnsafe(context.promptQueue, {
            type: "message",
            message:
              current === undefined
                ? { ...message, uuid: turnId as NonNullable<SDKUserMessage["uuid"]> }
                : message,
          });
          if (!accepted) {
            return { _tag: "Closed" };
          }

          if (current === undefined) {
            context.turnState = {
              turnId,
              startedAt,
              assistantTextBlocks: new Map(),
              assistantTextBlockOrder: [],
              capturedProposedPlanKeys: new Set(),
              latestAssistantUsage: undefined,
              compactedSinceLatestAssistantUsage: false,
              hasSubagents: false,
              backgroundAgentTaskIds: new Set(),
              heldResults: [],
              nextSyntheticAssistantBlockIndex: -1,
              authenticationFailureMessage: undefined,
              rejectedRateLimitTypes: new Set(),
              latestAssistantRateLimited: false,
              emittedThinkingText: false,
              thinkingSnapshotIds: new Set(),
            };
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: startedAt,
            };
            context.turnStartMessageIds.push(turnId);
            // The event queue is shut down only by the adapter finalizer, after
            // it has stopped every session, so an open session means it still
            // accepts events. As in offerRuntimeEvent, a refusal is not acted on.
            Queue.offerUnsafe(runtimeEventQueue, {
              type: "turn.started",
              eventId: turnStartedStamp.eventId,
              provider: PROVIDER,
              createdAt: turnStartedStamp.createdAt,
              threadId: context.session.threadId,
              turnId,
              payload: modelSelection?.model ? { model: modelSelection.model } : {},
              providerRefs: {},
            });
          }

          const resumeCursor = resumeCursorOf(context);
          context.session = { ...context.session, resumeCursor, updatedAt: startedAt };
          return { _tag: "Admitted", turnId, resumeCursor };
        };

        while (true) {
          // Stamped on every pass, so a synthetic close never leaves the new
          // turn's timestamps behind the close's own.
          const startedAt = yield* nowIso;
          const turnStartedStamp = yield* makeEventStamp();
          const admission = yield* Effect.sync(() => publishAdmission(startedAt, turnStartedStamp));
          if (admission._tag === "Closed") {
            return yield* sessionClosed();
          }
          if (admission._tag === "AwaitCompletion") {
            yield* Effect.raceFirst(Deferred.await(admission.completion), untilClosed);
            continue;
          }
          if (admission._tag === "CloseSynthetic") {
            // Local state only, so uninterruptible takes bounded time.
            yield* Effect.uninterruptible(completeTurn(context, "completed"));
            continue;
          }
          return {
            threadId: context.session.threadId,
            turnId: admission.turnId,
            resumeCursor: admission.resumeCursor,
          };
        }
      }),
    );
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      yield* settleInterruptedTurn(context);
      // interrupt() can acknowledge while resumed background tasks keep the
      // CLI alive. Stop is a hard session boundary for Claude, so close the
      // query and let the SDK escalate to SIGKILL when graceful exit fails.
      yield* stopSessionInternal(context);
    },
  );

  // Lets Claude abort the running turn through its own path before Stop kills
  // the process, so the prompt reaches the transcript. Killing a first turn
  // before Claude writes it leaves a resume cursor for a session Claude never
  // saved, and every later message fails with "No conversation found".
  const settleInterruptedTurn = Effect.fn("settleInterruptedTurn")(function* (
    context: ClaudeSessionContext,
  ) {
    const interrupt = context.query.interrupt?.bind(context.query);
    if (context.stopped || !context.turnState || !interrupt) return;
    const settled = yield* Deferred.make<void>();
    context.interruptedTurnSettled = settled;
    yield* Effect.tryPromise(interrupt).pipe(
      Effect.ignore,
      Effect.andThen(Deferred.await(settled)),
      Effect.timeoutOption(CLAUDE_INTERRUPT_GRACE),
    );
    context.interruptedTurnSettled = undefined;
  });

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      if (
        context.turnStartMessageIds.length > 0 &&
        context.turnStartMessageIds.every((id) => id !== null) &&
        numTurns >= context.turnStartMessageIds.length
      ) {
        yield* stopSessionInternal(context, { emitExitEvent: false });
        yield* startSession({
          ...context.startInput,
          runtimeMode: context.session.runtimeMode,
          resumeCursor: undefined,
        });
        return yield* snapshotThread(yield* requireSession(threadId));
      }
      const sessionId = context.resumeSessionId;
      if (!sessionId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Claude session id is unavailable.",
        });
      }
      // The single-executable has no sibling script and no Node to run one
      // with, so it hosts the worker as a hidden subcommand of itself.
      const historyWorkerArguments = (yield* HostProcessIsExecutable)
        ? ["__claude-history"]
        : [
            yield* path
              .fromFileUrl(
                new URL(
                  import.meta.url.endsWith(".ts")
                    ? "../../claude-history-worker.ts"
                    : "./claude-history-worker.mjs",
                  import.meta.url,
                ),
              )
              .pipe(Effect.mapError((cause) => toRequestError(threadId, "thread/rollback", cause))),
          ];
      const runScopedHistoryCommand = async (
        method: "getSessionMessages" | "forkSession",
        args: object,
        historySessionId = sessionId,
      ) => {
        // SDK history helpers read process.env. Isolate the provider's home instead
        // of changing the server's environment while other providers are running.
        // @effect-diagnostics-next-line runEffectInsideEffect:off - SDK callback runs outside the fiber; the spawn is self-contained
        const result = await Effect.runPromise(
          spawnAndCollect(
            process.execPath,
            ChildProcess.make(
              process.execPath,
              [...historyWorkerArguments, method, historySessionId, encodeHistoryArgs(args)],
              { env: { ...claudeEnvironment, ELECTRON_RUN_AS_NODE: "1" } },
            ),
          ).pipe(
            Effect.timeout("30 seconds"),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        if (result.code !== 0) throw new Error(result.stderr || "Claude history command failed.");
        return result.stdout;
      };
      const readHistory = (historySessionId: string) =>
        Effect.tryPromise({
          try: async () => {
            const readOptions = {
              ...(context.session.cwd ? { dir: context.session.cwd } : {}),
              includeSystemMessages: true,
            };
            if (options?.getSessionMessages)
              return options.getSessionMessages(historySessionId, readOptions);
            if (claudeEnvironment.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR) {
              return getSessionMessages(historySessionId, readOptions);
            }
            return decodeSessionMessages(
              await runScopedHistoryCommand("getSessionMessages", readOptions, historySessionId),
            );
          },
          catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
        });
      const messages = yield* readHistory(sessionId);
      // Tool results are user-role messages too. Only human prompts begin a turn.
      const turnStarts = messages.flatMap((message, index) =>
        isClaudeHumanTurnStart(message) ? [index] : [],
      );
      if (messages.length === 0) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Claude session history is unavailable.",
        });
      }
      const boundaries = [...context.turnStartMessageIds];
      // Older cursors did not record native boundaries. Infer them only when
      // their T3 turn count agrees; steers must never be treated as extra turns.
      if (
        boundaries.every((id): boolean => id === null) &&
        boundaries.length === turnStarts.length
      ) {
        boundaries.splice(
          0,
          boundaries.length,
          ...turnStarts.map((index) => messages[index]!.uuid),
        );
      }
      const retainedCount = Math.max(0, boundaries.length - numTurns);
      const firstRemovedId = boundaries[retainedCount];
      const firstRemoved = messages.findIndex((message) => message.uuid === firstRemovedId);
      if (
        boundaries.length === 0 ||
        boundaries.some((id) => id === null) ||
        (retainedCount > 0 && firstRemoved < 1)
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail:
            "The exact Claude turn boundary is unavailable, possibly after compaction or recovery of older history. Start a new thread instead.",
        });
      }
      const rollbackAt = retainedCount > 0 ? messages[firstRemoved - 1]?.uuid : undefined;
      const retainedTurns = context.turns.slice(0, Math.max(0, context.turns.length - numTurns));
      const fork = rollbackAt
        ? yield* Effect.tryPromise({
            try: async () => {
              const forkOptions = {
                ...(context.session.cwd ? { dir: context.session.cwd } : {}),
                upToMessageId: rollbackAt,
              };
              if (options?.forkSession) return options.forkSession(sessionId, forkOptions);
              if (claudeEnvironment.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR) {
                return forkSession(sessionId, forkOptions);
              }
              return decodeHistoryFork(await runScopedHistoryCommand("forkSession", forkOptions));
            },
            catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
          })
        : undefined;
      const retainedBoundaries = boundaries.slice(0, retainedCount);
      if (fork) {
        const forkMessages = yield* readHistory(fork.sessionId);
        const remappedBoundaries = remapClaudeForkTurnBoundaries(
          messages,
          forkMessages,
          firstRemoved,
          retainedBoundaries,
        );
        if (!remappedBoundaries) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: "Claude fork history did not preserve the retained turn boundaries.",
          });
        }
        retainedBoundaries.splice(0, retainedBoundaries.length, ...remappedBoundaries);
      }
      yield* stopSessionInternal(context, { emitExitEvent: false });
      yield* startSession({
        ...context.startInput,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: fork
          ? {
              resume: fork.sessionId,
              turnCount: retainedCount,
              turnStartMessageIds: retainedBoundaries,
            }
          : undefined,
      });
      const restarted = yield* requireSession(threadId);
      restarted.turns.push(...retainedTurns);
      return yield* snapshotThread(restarted);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopSessions = Effect.fn("stopSessions")(function* (
    contexts: ReadonlyArray<ClaudeSessionContext>,
    emitExitEvent: boolean,
  ) {
    const results = yield* Effect.forEach(contexts, (context) =>
      stopSessionInternal(context, { emitExitEvent }).pipe(Effect.result),
    );

    for (const result of results) {
      if (result._tag === "Failure") {
        return yield* result.failure;
      }
    }
  });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    stopSessions(Array.from(sessions.values()), true);

  yield* Effect.addFinalizer(() =>
    stopSessions(Array.from(sessions.values()), false).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit Claude session shutdown event.", { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    memoryAdmission: {
      skillTrials: true,
      // Reports the identity of the context currently registered for the
      // thread; a send observes the same values on the context it publishes.
      sessionGeneration: (threadId) => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped && context.session.status !== "closed"
          ? context.generation
          : undefined;
      },
      nativeSessionId: (resumeCursor) => readClaudeResumeState(resumeCursor)?.resume,
    },
    // Read-only: projects the route this exact input would publish under on
    // the context currently open for the thread. Never creates or resumes a
    // session and never calls an SDK setter — `undefined` when the route is
    // unprovable: no open session, no resume id, launch args outside the
    // accounted set, or an out-of-instance/unresolvable model selection.
    previewSubmissionRoute: (input) =>
      Effect.suspend(() => {
        const context = sessions.get(input.threadId);
        if (context === undefined || context.stopped || context.session.status === "closed") {
          return Effect.succeed(undefined);
        }
        const seed = context.routeProfileSeed;
        const nativeSessionId = context.resumeSessionId;
        const sessionGeneration = context.generation;
        if (seed === undefined || nativeSessionId === undefined) {
          return Effect.succeed(undefined);
        }
        return Effect.map(modelCatalogEffect, (modelCatalog) => {
          // The catalog may have suspended: the context read above must
          // still be the pinned open context — same map entry, same
          // generation, same resume id — or this preview is stale.
          const current = sessions.get(input.threadId);
          if (
            current !== context ||
            context.stopped ||
            context.session.status === "closed" ||
            context.generation !== sessionGeneration ||
            context.resumeSessionId !== nativeSessionId
          ) {
            return undefined;
          }
          const selection = input.modelSelection;
          if (
            selection !== undefined &&
            (selection.instanceId !== boundInstanceId ||
              !modelCatalog.models.some(
                (entry) =>
                  entry.model.slug === resolveClaudeModelSlug(modelCatalog, selection.model),
              ))
          ) {
            return undefined;
          }
          const controls = projectClaudeSendControls(context, input, modelCatalog, boundInstanceId);
          if (controls.apiModel === undefined || controls.permissionMode === undefined) {
            return undefined;
          }
          try {
            return {
              sessionGeneration,
              nativeSessionId,
              routeConfigSha256: claudeRouteConfigSha256(
                buildClaudeRouteProfile({
                  seed,
                  providerInstanceId: boundInstanceId,
                  apiModel: controls.apiModel,
                  permissionMode: controls.permissionMode,
                  subagentDefaultEffort: controls.effort ?? null,
                  promptInjectedEffort: controls.promptInjectedEffort,
                }),
              ),
            };
          } catch {
            return undefined;
          }
        });
      }),
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
