import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  type AntigravitySettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSetupError,
  type ProviderUserInputAnswers,
  type RuntimeTaskStatus,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { isServerShuttingDown } from "../../serverShutdown.ts";
import type { AntigravityAuth } from "../AntigravityAuth.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../antigravityAuthSupport.ts";
import { judgePublishAdmission, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { acpTurnTokenUsageFromPromptResponses } from "../acp/AcpTurnTokenUsage.ts";
import {
  antigravityPermissionMode,
  antigravityModelOptions,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
  resolveAntigravityModel,
} from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravityOpenCommand,
  isAntigravitySubagentReplayStart,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  selectAntigravityPermissionOptionId,
} from "../acp/AntigravityProtocol.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "start"
  | "setMode"
  | "setModel"
  | "getConfigOptions"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;

function mapAntigravityError(threadId: ThreadId, method: string, cause: EffectAcpErrors.AcpError) {
  return isAntigravitySignInRequiredError(cause)
    ? new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause,
      })
    : mapAcpToAdapterError(PROVIDER, threadId, method, cause);
}

export interface AntigravityAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner" | "onAuthorizationUrl">,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError | ProviderSetupError, Scope.Scope>;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onConfigOptionsUpdated?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired?: Effect.Effect<void>;
  /** Model the provider default alias selects, when the account offers it. */
  readonly defaultModel?: Effect.Effect<string | undefined>;
  /**
   * The user's standing instructions from settings, read per turn so a change
   * applies to the next turn. The driver supplies a fail-safe reader.
   */
  readonly agentInstructions?: Effect.Effect<string>;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Defaults to the process-wide marker; tests inject their own. See `serverShutdown`. */
  readonly isShuttingDown?: () => boolean;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface PendingQuestion {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly answers: ProviderUserInputAnswers;
    readonly result: NativePermissionResponse;
  }>;
}

interface OpenCommand {
  readonly toolCall: AcpToolCallState;
  readonly turnId: TurnId | undefined;
  readonly promoted: boolean;
}

interface OpenSubagent {
  readonly turnId: TurnId | undefined;
  readonly status: "pending" | "running" | undefined;
  readonly description?: string;
}

function subagentLinkage(toolCallId: string) {
  return {
    taskId: RuntimeTaskId.make(toolCallId),
    taskType: "subagent_batch",
    toolUseId: toolCallId,
    title: "Antigravity subagent batch",
  };
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly commandLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly commands: Map<string, OpenCommand>;
  /** Keep only IDs after settlement or MCP exclusion so merged late updates cannot change identity. */
  readonly subagents: Map<string, OpenSubagent | "finished" | "mcp">;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  /** The runtime note already in this session's conversation; resent only when it changes. */
  sentRuntimeInstructions?: string;
  /** Per-turn sequence: sendTurn bumps it and finishTurn only settles matching intents. */
  generation: number;
  /**
   * Identity of this context for memory admission, from the adapter-level
   * `nextSessionGeneration`. Unlike the per-turn `generation` it changes only
   * when the context itself is recreated.
   */
  readonly sessionGeneration: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolves an agent-supplied path and rejects anything outside the session roots. */
const resolveClientFilePath = Effect.fn("AntigravityAdapter.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const resolved = path.resolve(input.requestPath);
    // Follow symlinks on the parent so a link out of the workspace cannot escape it.
    const parent = yield* input.fileSystem
      .realPath(path.dirname(resolved))
      .pipe(Effect.orElseSucceed(() => path.dirname(resolved)));
    const real = path.join(parent, path.basename(resolved));
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Path '${input.requestPath}' is outside the session workspace.`,
      );
    }
    return real;
  },
);

const readClientTextFile = Effect.fn("AntigravityAdapter.readClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.ReadTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  const info = yield* input.fileSystem
    .stat(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.resourceNotFound(`File '${input.request.path}' not found.`),
      ),
    );
  if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
  }
  const text = yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
      ),
    );
  const line = input.request.line ?? undefined;
  const limit = input.request.limit ?? undefined;
  if (line === undefined && limit === undefined) {
    return { content: text };
  }
  // ACP lines are 1-indexed. `limit` is a line count.
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  return { content: lines.slice(start, end).join("\n") };
});

const writeClientTextFile = Effect.fn("AntigravityAdapter.writeClientTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.WriteTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  yield* input.fileSystem.makeDirectory(input.path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(input.fileSystem.writeFileString(filePath, input.request.content)),
    Effect.mapError(() =>
      EffectAcpErrors.AcpRequestError.internalError(`Could not write '${input.request.path}'.`),
    ),
  );
  return {};
});

/** Keeps one official ACP process per thread and drains a cancelled prompt before steering. */
export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions,
) {
  const isShuttingDown = options.isShuttingDown ?? isServerShuttingDown;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  // Every context recreation — a fresh start, a resume, or a replacement of
  // an open session — consumes the next session generation; see
  // SessionContext.sessionGeneration. ACP resume reuses the provider's
  // session id in a new runtime, so the generation is the only identity that
  // distinguishes the context a memory observation was captured on.
  let nextSessionGeneration = 0;
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an Antigravity event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("AntigravityAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    for (const pending of context.questions.values()) {
      yield* Deferred.succeed(pending.response, {
        answers: {},
        result: { outcome: { outcome: "cancelled" } },
      });
    }
  });

  const finishBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (!command.promoted) continue;
          yield* emit({
            type: "task.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              status: "stopped",
            },
          });
        }
        context.commands.clear();
      }),
    );

  const finishSubagents = (
    context: SessionContext,
    status: Extract<RuntimeTaskStatus, "cancelled" | "failed" | "idle">,
    error?: string,
  ) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, subagent] of context.subagents) {
          if (subagent === "finished" || subagent === "mcp") continue;
          yield* emit({
            type: "task.updated",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: subagent.turnId,
            payload: {
              ...subagentLinkage(id),
              status,
              ...(status === "idle"
                ? {
                    description: "Turn ended. Individual agent status is unavailable.",
                    timelineBypass: true,
                  }
                : {}),
              ...(error ? { error } : {}),
            },
          });
          context.subagents.set(id, "finished");
        }
      }),
    );

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* finishBackgroundCommands(context);
          yield* finishSubagents(
            context,
            context.disconnected ? "failed" : "cancelled",
            context.disconnected ? "Antigravity process stopped." : undefined,
          );
          context.subagents.clear();
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "Antigravity process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("AntigravityAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const rawPayload = sanitizeAntigravityToolPayload(request);

    if (isAntigravityUserInputRequest(request)) {
      const question = extractAntigravityUserInputQuestion(request);
      if (!question) return { outcome: { outcome: "cancelled" } };
      const response = yield* Deferred.make<{
        answers: ProviderUserInputAnswers;
        result: NativePermissionResponse;
      }>();
      context.questions.set(requestId, { request, response });
      return yield* Effect.gen(function* () {
        yield* emit({
          type: "user-input.requested",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { questions: [question] },
          raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: rawPayload },
        });
        const answer = yield* Deferred.await(response);
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { answers: answer.answers },
        });
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.questions.delete(requestId))));
    }

    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: NativePermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const parsed = parsePermissionRequest(request);
    const toolCall = parsed.toolCall ? normalizeAntigravityToolCall(parsed.toolCall) : undefined;
    const permissionRequest = {
      ...parsed,
      ...(toolCall ? { toolCall } : {}),
      detail:
        toolCall?.command ??
        toolCall?.detail ??
        toolCall?.title ??
        "Antigravity requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: antigravityApprovalOptions(request),
          detail: permissionRequest.detail ?? "Antigravity requests permission.",
          args: rawPayload,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleEvent = Effect.fn("AntigravityAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "ModeChanged":
        return;
      case "AvailableCommandsUpdated":
        yield* options.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void;
        return;
      case "ConfigOptionsUpdated":
        yield* options.onConfigOptionsUpdated?.(event.configOptions) ?? Effect.void;
        return;
      case "ConnectionTerminated":
        // The shutdown signal kills the agent with the server, which is not an
        // error. Leave the session running with its turn:
        // `ProviderService.runStopAll` records the continuation and stops it.
        if (isShuttingDown()) return;
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* context.commandLock.withPermit(
          Effect.gen(function* () {
            const toolCall = normalizeAntigravityToolCall(event.toolCall);
            const tracked = context.subagents.get(toolCall.toolCallId);
            if (tracked === "finished") return;
            const kind = classifyAntigravitySubagentToolCall(toolCall, event.rawPayload);
            const isMcp = tracked === "mcp" || kind === "mcp";
            if (isMcp) context.subagents.set(toolCall.toolCallId, "mcp");
            const subagent = tracked === "mcp" ? undefined : tracked;
            if (!isMcp && (subagent || kind === "subagent")) {
              const turnId = subagent?.turnId ?? context.activeTurnId;
              const linkage = subagentLinkage(toolCall.toolCallId);
              // Replay starts claim completion before the result says whether the call failed.
              if (
                context.activeTurnId === undefined &&
                isAntigravitySubagentReplayStart(event.rawPayload)
              ) {
                context.subagents.set(toolCall.toolCallId, { turnId, status: undefined });
                return;
              }
              if (toolCall.status === "failed") {
                const summary = antigravitySubagentOutput(toolCall);
                yield* emit({
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: toolCall.status,
                    ...(summary ? { summary } : {}),
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else if (context.activeTurnId === undefined && toolCall.status === "completed") {
                yield* emit({
                  type: "task.updated",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: {
                    ...linkage,
                    status: "idle",
                    description: "Individual agent status is unavailable for this earlier batch.",
                    timelineBypass: true,
                  },
                });
                context.subagents.set(toolCall.toolCallId, "finished");
              } else {
                // start_subagent returns after launching a batch. Its output is
                // the launch description, not a child result or completion.
                const status = toolCall.status === "pending" ? "pending" : "running";
                const description =
                  antigravitySubagentOutput(toolCall) ?? subagent?.description ?? linkage.title;
                if (subagent?.status !== status || subagent?.description !== description) {
                  yield* emit({
                    type: "task.progress",
                    ...(yield* stamp),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId,
                    payload: { ...linkage, description, summary: description, status },
                  });
                }
                context.subagents.set(toolCall.toolCallId, { turnId, status, description });
              }
              return;
            }
            const existing = context.commands.get(toolCall.toolCallId);
            yield* emit(
              makeAcpToolCallEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: existing?.turnId ?? context.activeTurnId,
                toolCall,
                rawPayload: sanitizeAntigravityToolPayload(event.rawPayload),
              }),
            );
            if (isAntigravityOpenCommand(toolCall)) {
              context.commands.set(toolCall.toolCallId, {
                toolCall,
                turnId: existing?.turnId ?? context.activeTurnId,
                promoted: existing?.promoted ?? false,
              });
            } else if (toolCall.status === "completed" || toolCall.status === "failed") {
              context.commands.delete(toolCall.toolCallId);
              if (existing?.promoted) {
                yield* emit({
                  type: "task.completed",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId: existing.turnId,
                  payload: {
                    taskId: RuntimeTaskId.make(toolCall.toolCallId),
                    taskType: "local_bash",
                    toolUseId: toolCall.toolCallId,
                    status: toolCall.status === "failed" ? "failed" : "completed",
                  },
                });
              }
            }
          }),
        );
        return;
    }
  });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Antigravity in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Antigravity provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Antigravity session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });
        const stopOwned = Effect.suspend(() =>
          context ? stopContext(context).pipe(Effect.ignore) : Scope.close(sessionScope, Exit.void),
        );

        return yield* options
          .withProcess(
            stopOwned,
            Effect.gen(function* () {
              const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
              // The attachments dir grant lets the agent read path-only uploads
              // at the paths ProviderService injects into the turn text. It is
              // a leaf directory holding only uploads.
              const runtime = yield* options.makeRuntime({
                cwd,
                clientInfo: { name: "t3-code", version: "0.0.0" },
                clientFileSystem: true,
                ...(mcp?.agentDeviceEnvironment
                  ? { agentDeviceEnvironment: mcp.agentDeviceEnvironment }
                  : {}),
                additionalDirectories: [serverConfig.attachmentsDir],
                ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
                mcpServers: mcp
                  ? [
                      {
                        type: "http",
                        name: "t3-code",
                        url: mcp.endpoint,
                        headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                      },
                    ]
                  : [],
                ...makeNativeLoggers({
                  nativeEventLogger: options.nativeEventLogger,
                  provider: PROVIDER,
                  threadId: input.threadId,
                }),
              });
              // Workspace file access requested through the client fs
              // capability. The agent gates each write behind
              // `session/request_permission`, so only path containment is
              // checked here.
              const allowedRoots = [cwd, serverConfig.attachmentsDir];
              yield* runtime.handleReadTextFile((request) =>
                readClientTextFile({ fileSystem, path, allowedRoots, request }),
              );
              yield* runtime.handleWriteTextFile((request) =>
                writeClientTextFile({ fileSystem, path, allowedRoots, request }),
              );
              yield* runtime.handleRequestPermission((request) =>
                context
                  ? handlePermission(context, request).pipe(
                      Effect.mapError((cause) =>
                        EffectAcpErrors.AcpRequestError.internalError(
                          "Could not process an Antigravity permission request.",
                          undefined,
                          { cause },
                        ),
                      ),
                    )
                  : Effect.succeed({
                      outcome: { outcome: "cancelled" },
                    } satisfies NativePermissionResponse),
              );
              const started = yield* runtime.start();
              const model = yield* applyAntigravityAcpModelSelection({
                runtime,
                model: input.modelSelection?.model,
                defaultModel: yield* options.defaultModel ?? Effect.undefined,
                mapError: (cause) => cause,
              });
              yield* runtime.setMode(antigravityPermissionMode(input.runtimeMode));
              yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
              const createdAt = yield* nowIso;
              const session: ProviderSession = {
                provider: PROVIDER,
                providerInstanceId: options.instanceId,
                threadId: input.threadId,
                cwd,
                status: "ready",
                runtimeMode: input.runtimeMode,
                ...(model ? { model } : {}),
                resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
                createdAt,
                updatedAt: createdAt,
              };
              context = {
                threadId: input.threadId,
                cwd,
                nativeSessionId: started.sessionId,
                scope: sessionScope,
                runtime,
                promptLock: yield* Semaphore.make(1),
                stopLock: yield* Semaphore.make(1),
                commandLock: yield* Semaphore.make(1),
                approvals: new Map(),
                questions: new Map(),
                commands: new Map(),
                subagents: new Map(),
                turns: [],
                session,
                activeTurnId: undefined,
                promptFiber: undefined,
                generation: 0,
                sessionGeneration: ++nextSessionGeneration,
                stopped: false,
                closed: false,
                disconnected: false,
              };
              const running = context;
              sessions.set(input.threadId, running);
              yield* Stream.runForEach(runtime.getEvents(), (event) =>
                handleEvent(running, event),
              ).pipe(
                Effect.catchCause(() =>
                  Effect.logError("Could not process an Antigravity runtime event."),
                ),
                Effect.forkIn(sessionScope),
              );
              yield* emit({
                type: "session.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { resume: started.initializeResult },
              });
              yield* emit({
                type: "session.state.changed",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { state: "ready", reason: "Antigravity ACP session ready" },
              });
              yield* emit({
                type: "thread.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: { providerThreadId: started.sessionId },
              });
              yield* runtime.drainEvents;
              if (running.stopped) {
                return yield* new ProviderAdapterSessionClosedError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                });
              }
              transferred = true;
              return session;
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.tapError((cause) =>
              isAntigravitySignInRequiredError(cause)
                ? (options.onAuthRequired ?? Effect.void)
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              isAcpError(cause)
                ? mapAntigravityError(input.threadId, "session/start", cause)
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: "Could not start Antigravity. Check the provider setup status.",
                    cause,
                  }),
            ),
          );
      }).pipe(Effect.scoped),
    );

  const promoteBackgroundCommands = (context: SessionContext) =>
    context.commandLock.withPermit(
      Effect.gen(function* () {
        for (const [id, command] of context.commands) {
          if (command.promoted) continue;
          yield* emit({
            type: "task.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: command.turnId,
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "local_bash",
              toolUseId: id,
              description:
                command.toolCall.command ?? command.toolCall.title ?? "Antigravity command",
            },
          });
          context.commands.set(id, { ...command, promoted: true });
        }
      }),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("AntigravityAdapter.sendTurn")(
    function* (input, admission) {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }
      const prompt = yield* buildAntigravityPrompt({
        input: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => mapAntigravityError(input.threadId, "session/prompt", cause)),
      );
      let intent: TurnIntent | undefined;
      // The caller holds promptLock while it changes or settles the active turn.
      const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
        Effect.gen(function* () {
          if (turn.settled || context.stopped || context.generation !== turn.generation) return;
          turn.settled = true;
          yield* promoteBackgroundCommands(context);
          yield* finishSubagents(
            context,
            payload.state === "cancelled"
              ? "cancelled"
              : payload.state === "failed"
                ? "failed"
                : "idle",
            payload.errorMessage,
          );
          context.activeTurnId = undefined;
          context.promptFiber = undefined;
          context.session = {
            ...context.session,
            status: payload.state === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
            ...(payload.errorMessage
              ? { lastError: payload.errorMessage }
              : { lastError: undefined }),
          };
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: turn.turnId,
            payload,
          });
        }).pipe(Effect.uninterruptible);

      return yield* Effect.gen(function* () {
        // Set by the publish gate below when it refuses this send; the gate runs
        // synchronously before anything is queued, so the verdict is settled by
        // the time the prompt fiber's failure reaches the unwrap below.
        let refused = false;
        // Refusal must settle the unpublished intent so error handling cannot
        // complete a turn that never started. A steer has already cancelled its
        // replaced prompt and must still end that existing turn.
        const refundRefusedTurn = (turn: TurnIntent, replacedPrompt: boolean) =>
          context.promptLock.withPermit(
            replacedPrompt
              ? finishTurn(turn, { state: "cancelled", stopReason: "cancelled" })
              : Effect.sync(() => {
                  turn.settled = true;
                  context.promptFiber = undefined;
                }),
          );
        const launch = yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            yield* requireSession(input.threadId);
            const requestedModel = input.modelSelection?.model ?? context.session.model;
            const configOptions = yield* context.runtime.getConfigOptions;
            const model = resolveAntigravityModel({
              configOptions,
              model: requestedModel,
              defaultModel: yield* options.defaultModel ?? Effect.undefined,
            });
            const availableModels = antigravityModelOptions(configOptions);
            if (model && !availableModels.some((option) => option.value === model)) {
              return yield* EffectAcpErrors.AcpRequestError.invalidParams(
                `Antigravity model '${model}' is unavailable for this Google account. Select an available model.`,
              );
            }
            const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
            const steering = context.activeTurnId !== undefined;
            const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
            intent = turn;
            let replacedPrompt = false;
            // Ordinary sends retain their early active-id binding and later
            // session update. Memory sends apply both together at admission.
            const bindTurn = (updatedAt?: string) => {
              context.activeTurnId = turnId;
              if (updatedAt !== undefined) {
                context.session = {
                  ...context.session,
                  status: "running",
                  activeTurnId: turnId,
                  ...(model ? { model } : {}),
                  updatedAt,
                };
              }
            };
            if (admission === undefined) bindTurn();
            const turnStarted = steering
              ? undefined
              : ({
                  type: "turn.started",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: model ? { model } : {},
                } satisfies ProviderRuntimeEvent);
            // A memory-bearing send announces its turn from the publish gate
            // below, only once admitted, so a refusal leaves no turn boundary.
            if (turnStarted && admission === undefined) yield* emit(turnStarted);
            if (context.promptFiber) {
              replacedPrompt = true;
              yield* cancelRequests(context);
              yield* context.runtime.cancel;
              yield* Fiber.await(context.promptFiber);
              yield* finishSubagents(context, "cancelled");
            }
            yield* applyAntigravityAcpModelSelection({
              runtime: context.runtime,
              model,
              mapError: (cause) => cause,
            });
            yield* context.runtime.setMode(antigravityPermissionMode(context.session.runtimeMode));
            const updatedAt = yield* nowIso;
            if (admission === undefined) bindTurn(updatedAt);
            const runtimeInstructions = buildRuntimeInstructions({
              harness: "Antigravity",
              model,
              projectMemory: true,
              agentInstructions: options?.agentInstructions
                ? yield* options.agentInstructions
                : undefined,
            });
            const freshInstructions =
              runtimeInstructions === context.sentRuntimeInstructions
                ? undefined
                : runtimeInstructions;
            // A memory-bearing send refuses before forking when the context it
            // bound at entry is no longer the one open for the thread — a stop
            // or a concurrent startSession replacement while this send held the
            // prompt lock. Publishing would put the memory on a session the
            // admission never judged, so this fails closed instead of the
            // quiet skip ordinary sends take.
            const staleAtLaunch = context.stopped || sessions.get(input.threadId) !== context;
            if (admission !== undefined && staleAtLaunch) {
              return { _tag: "Refused" as const, turn, replacedPrompt };
            }
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.runtime
              .prompt(
                {
                  prompt: freshInstructions
                    ? [...prompt, { type: "text", text: freshInstructions }]
                    : prompt,
                },
                {
                  dispatched,
                  // The caller's last-word gate: the ACP runtime runs it
                  // synchronously at its publish point — after the semaphores a
                  // prompt waits on are held, before any state mutation or the
                  // RPC fork — so a send queued behind an in-flight turn is
                  // re-judged when it actually publishes. Without a caller
                  // admission the gate still records the runtime note at the
                  // publish point and publishes as before.
                  admit: () => {
                    if (
                      !judgePublishAdmission(admission, {
                        stale: context.stopped || sessions.get(input.threadId) !== context,
                        sessionGeneration: context.sessionGeneration,
                        nativeSessionId: context.nativeSessionId,
                      })
                    ) {
                      refused = true;
                      return false;
                    }
                    // The prompt publishes with the note attached, so only now
                    // does the session remember it; a refused send leaves no
                    // trace and the next send carries it.
                    if (freshInstructions !== undefined) {
                      context.sentRuntimeInstructions = freshInstructions;
                    }
                    // The runtime holds its notification lock while this gate
                    // runs, so the start still precedes every event of the
                    // prompt it opens.
                    if (admission !== undefined) bindTurn(updatedAt);
                    if (turnStarted && admission !== undefined) {
                      PubSub.publishUnsafe(events, turnStarted);
                    }
                    return true;
                  },
                },
              )
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            // Fiber.await completes when the prompt fiber terminates either way,
            // so this resolves as soon as the prompt is dispatched or dead. The
            // exit itself is unwrapped by the caller below, which can still tell
            // a publish refusal from other failures.
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(Effect.asVoid),
            );
            return { _tag: "Launched" as const, turn, replacedPrompt, fiber };
          }),
        );
        if (launch._tag === "Refused") {
          yield* refundRefusedTurn(launch.turn, launch.replacedPrompt);
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const launchExit = yield* Fiber.await(launch.fiber);
        if (refused) {
          yield* refundRefusedTurn(launch.turn, launch.replacedPrompt);
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const result = yield* launchExit;
        yield* context.runtime.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
        if (record) record.items.push(result);
        else context.turns.push({ id: launch.turn.turnId, items: [result] });
        const tokenUsage = acpTurnTokenUsageFromPromptResponses(record?.items ?? [result], {
          // Read before finishTurn settles the open batches and drops their turn.
          hasSubagents: [...context.subagents.values()].some(
            (subagent) => typeof subagent === "object" && subagent.turnId === launch.turn.turnId,
          ),
          completed: result.stopReason !== "cancelled",
        });
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
            ...(tokenUsage ? { tokenUsage } : {}),
          }),
        );
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.tapError((cause) =>
          isAntigravitySignInRequiredError(cause)
            ? (options.onAuthRequired ?? Effect.void)
            : Effect.void,
        ),
        Effect.mapError((cause) =>
          isAcpError(cause) ? mapAntigravityError(input.threadId, "session/prompt", cause) : cause,
        ),
        Effect.tapError((cause) =>
          Effect.suspend(() =>
            intent && !isShuttingDown()
              ? context.promptLock.withPermit(
                  finishTurn(intent, { state: "failed", errorMessage: cause.message }),
                )
              : Effect.void,
          ),
        ),
        Effect.onInterrupt(() =>
          context.promptLock.withPermit(
            Effect.gen(function* () {
              const turn = intent;
              if (
                !turn ||
                turn.settled ||
                context.stopped ||
                context.generation !== turn.generation ||
                isShuttingDown()
              )
                return;
              const promptFiber = context.promptFiber;
              yield* cancelRequests(context);
              yield* Effect.ignore(context.runtime.cancel);
              if (promptFiber) yield* Fiber.interrupt(promptFiber);
              yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
            }),
          ),
        ),
        // While the server shuts down, the agent dies with it and the server
        // interrupts this send. Neither ends the turn: the guards above leave it
        // running for `ProviderService.runStopAll`, and a failure ends
        // interrupted, which the caller does not report.
        Effect.catchCause((cause) =>
          isShuttingDown() ? Effect.interrupt : Effect.failCause(cause),
        ),
      );
    },
  );

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      // A command that outlived its turn keeps running in the agent, and
      // session/cancel only stops a prompt. The agent kills its background
      // commands when its session closes, so Stop with nothing else running
      // ends the session, as Claude's does. The next turn resumes it.
      let idleWithCommands = false;
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            // Decided under the prompt lock so a turn cannot start in between.
            if (!context.promptFiber && [...context.commands.values()].some((c) => c.promoted)) {
              context.stopped = true;
              idleWithCommands = true;
              return;
            }
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
          }),
        )
        .pipe(
          Effect.mapError((cause) => mapAntigravityError(threadId, "session/cancel", cause)),
          // Once marked stopped the session must close, even if this call is
          // interrupted, or it is left unreachable with its commands running.
          Effect.ensuring(
            Effect.suspend(() =>
              idleWithCommands
                ? withThreadLock(threadId, stopContext(context)).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        );
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel"
          ? undefined
          : selectAntigravityPermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "Antigravity did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.questions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This question is no longer pending.",
        });
      }
      const result = makeAntigravityUserInputResponse(pending.request, answers);
      if (!result) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue:
            "Select one of Antigravity's offered answers. Custom answers are not supported for this question.",
        });
      }
      yield* Deferred.succeed(pending.response, { answers, result });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop an Antigravity session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    memoryAdmission: {
      // Reports the identity of the context currently registered for the
      // thread; a send observes the same values on the context it publishes.
      sessionGeneration: (threadId) => {
        const live = sessions.get(threadId);
        return live !== undefined && !live.stopped ? live.sessionGeneration : undefined;
      },
      nativeSessionId: (resumeCursor) => {
        const decoded = decodeResumeCursor(resumeCursor);
        return Option.isSome(decoded) ? decoded.value.sessionId : undefined;
      },
    },
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Antigravity does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
