// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OWNED_USAGE_ACTIVITY_KIND,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  layer as projectMemorySendGateLayer,
  ProjectMemorySendGate,
} from "../../memory/ProjectMemorySendGate.ts";
import {
  layer as projectMemoryRepositoryLayer,
  ProjectMemoryRepository,
} from "../../persistence/ProjectMemories.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { MEMORY_ECHO_WITHHELD_ERROR, MEMORY_ECHO_WITHHELD_NOTICE } from "../memoryEcho.ts";

const provider = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("echo-project");
const threadTainted = ThreadId.make("thread-echo-tainted");
const threadClean = ThreadId.make("thread-echo-clean");
const threadMixed = ThreadId.make("thread-echo-mixed");
const threadEcho2Tainted = ThreadId.make("thread-echo2-tainted");
const threadEcho2Clean = ThreadId.make("thread-echo2-clean");
const threadEcho2Controls = ThreadId.make("thread-echo2-controls");
const memoryId = ProjectMemoryId.make("echo-memory-1");
const at = "2026-01-01T00:00:00.000Z";

// The memory body is what a provider could echo back; every covered event
// field on the tainted thread carries it so any single persistence leak is
// caught by the whole-store scan.
const MARK_BODY = "A-ECHO-BODY-9f3e2b1d";
const MARK_DROPPED = "A-ECHO-DROPPED-77aa01cc";
const MARK_CLEAN = "A-ECHO-CLEAN-51d2e844";
const MARK_CLEAN_DROPPED = "A-ECHO-CD-3f09c5b8";
const MARK_EDITED = "A-ECHO-EDITED-b6d04f11";
const MARK_DELETED = "A-ECHO-DELETED-c41a72e9";
const MARK_RESTART = "A-ECHO-RESTART-6d4e8f03";
const MARK_SQLFAIL = "A-ECHO-SQLFAIL-9a1c7d02";
// Baseline diagnostic on the mixed-cause thread: it must survive untouched.
const MARK_KEPT = "A-ECHO-KEPT-2c8b41e7";
const MARK_MIXED = "A-ECHO-MIXED-4e7b09d2";
const MIXED_SQL_REASON = "A-ECHO-MIXED-SQLFAIL-0d73e518";
// Ordinary tool payload on the tainted thread: a non-memory positive control.
const MARK_TOOL = "A-ECHO-TOOL-5d1f7a90";
const NATURAL_TEXT = "Natural assistant answer survives.";
const MARK_E2_TASK_TAINTED = "A-ECHO2-TASK-t8f201bc";
const MARK_E2_TASK_CLEAN = "A-ECHO2-TASK-c51d2e844";
const MARK_E2_CLAUDE_TAINTED = "A-ECHO2-CLAUDE-t4e9031a";
const MARK_E2_CLAUDE_CLEAN = "A-ECHO2-CLAUDE-c91c44e2f";
const MARK_E2_KEEP = "A-ECHO2-KEEP-91c44e2f";
const MARK_E2_SUCCESS = "A-ECHO2-OK-summary-3bc18d04";
const claudeProvider = ProviderDriverKind.make("claudeAgent");
const TASK_TYPED_USAGE = { totalTokens: 24, inputTokens: 10, outputTokens: 14 };
const claudeErrorSnapshotRaw = {
  source: "claude.sdk.message" as const,
  method: "claude/assistant",
  payload: { type: "assistant", error: "authentication_failed" },
};

const turnFor = (tag: string) => TurnId.make(`turn-echo-${tag}`);
const itemFor = (tag: string) => RuntimeItemId.make(`item-echo-${tag}`);

const TOKEN_USAGE = {
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  inputTokens: 100,
  outputTokens: 42,
  cachedInputTokens: 7,
  reasoningTokens: 3,
  hasSubagents: false,
};

let eventSeq = 0;
const nextEventId = () => EventId.make(`evt-echo-${(eventSeq += 1)}`);

type RuntimeEventBatch = {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly enqueued: Deferred.Deferred<void>;
};

// Fixture-only observation seam: wraps the real `makeDrainableWorker`
// constructor so the ingestion worker still runs the production process Effect
// unmodified, while the test records the Exit the real worker fiber observed
// for one target event. `ingestion.drain` cannot play this role — the worker
// decrements its outstanding count in an ensuring finalizer even when
// processing fails, so a resolved drain proves nothing about the outcome.
const workerObservation = vi.hoisted(() => ({
  armed: null as {
    readonly eventId: string;
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
          const input = item as { readonly event?: { readonly eventId?: string } };
          if (!armed || input.event?.eventId !== armed.eventId) return;
          armed.exit = exit;
          yield* Deferred.succeed(armed.done, undefined);
        }),
      ),
    );
  return { ...actual, makeDrainableWorker: makeObservedWorker };
});

type IngestionHarness = {
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<void, unknown>;
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void, unknown>;
  readonly emitAndDrain: (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, unknown>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | undefined, unknown>;
  readonly readAllStoredText: () => Effect.Effect<string, unknown>;
  readonly armGuardLookupFailure: (threadId: ThreadId, cause: Cause.Cause<unknown>) => void;
  readonly disarmGuardLookup: () => void;
  readonly setProviderSession: (session: ProviderSession) => void;
  readonly gate: ProjectMemorySendGate["Service"];
  readonly memories: ProjectMemoryRepository["Service"];
  readonly sql: SqlClient.SqlClient;
};

const base = (threadId: ThreadId) => ({
  provider,
  providerInstanceId: instanceId,
  threadId,
  createdAt: at,
});

const turnStarted = (threadId: ThreadId, turnId: TurnId): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "turn.started",
  eventId: nextEventId(),
  turnId,
  payload: {},
});

const runtimeError = (threadId: ThreadId, mark: string, turnId?: TurnId): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "runtime.error",
  eventId: nextEventId(),
  ...(turnId === undefined ? {} : { turnId }),
  payload: {
    message: `runtime error ${mark}`,
    code: `ERR-${mark}`,
    class: "provider_error",
    detail: { marker: mark },
  },
});

const runtimeWarning = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "runtime.warning",
  eventId: nextEventId(),
  payload: { message: `runtime warning ${mark}`, detail: { marker: mark } },
});

const assistantDelta = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  delta: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "content.delta",
  eventId: nextEventId(),
  turnId,
  itemId,
  payload: { streamKind: "assistant_text", delta },
});

const itemCompleted = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  itemType: "assistant_message" | "user_message",
  detail?: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "item.completed",
  eventId: nextEventId(),
  turnId,
  itemId,
  payload: {
    itemType,
    status: "completed",
    ...(detail === undefined ? {} : { detail }),
  },
});

const toolCompleted = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  command: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "item.completed",
  eventId: nextEventId(),
  turnId,
  itemId,
  payload: {
    itemType: "command_execution",
    status: "completed",
    title: "fixture command",
    data: { toolCallId: itemId, command },
  },
});

const droppedDelta = (
  threadId: ThreadId,
  turnId: TurnId,
  streamKind: "command_output" | "unknown",
  delta: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "content.delta",
  eventId: nextEventId(),
  turnId,
  payload: { streamKind, delta },
});

const metadataUpdated = (threadId: ThreadId, name: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "thread.metadata.updated",
  eventId: nextEventId(),
  payload: { name },
});

const threadCompacted = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "thread.state.changed",
  eventId: nextEventId(),
  payload: {
    state: "compacted",
    beforeTokens: 9000,
    afterTokens: 1200,
    detail: { marker: mark },
  },
});

const sessionError = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "session.state.changed",
  eventId: nextEventId(),
  payload: { state: "error", reason: `session reason ${mark}`, detail: { marker: mark } },
});

const turnFailed = (threadId: ThreadId, turnId: TurnId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "turn.completed",
  eventId: nextEventId(),
  turnId,
  payload: {
    state: "failed",
    errorMessage: `turn failed ${mark}`,
    tokenUsage: TOKEN_USAGE,
  },
});

const toolDenied = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "tool.denied",
  eventId: nextEventId(),
  payload: {
    toolName: "fixture-tool",
    toolUseId: "tool-use-echo2",
    reason: `denied ${mark}`,
    agentId: "agent-echo2",
  },
});

const taskProgressErrorOnly = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "task.progress",
  eventId: nextEventId(),
  payload: {
    taskId: RuntimeTaskId.make(`task-${threadId}`),
    description: "Task progress fixture",
    error: `progress error ${mark}`,
    typedUsage: TASK_TYPED_USAGE,
  },
});

const taskUpdatedError = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "task.updated",
  eventId: nextEventId(),
  payload: {
    taskId: RuntimeTaskId.make(`task-${threadId}`),
    status: "failed",
    error: `updated error ${mark}`,
    endedAt: at,
  },
});

const taskCompletedFailed = (threadId: ThreadId, mark: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "task.completed",
  eventId: nextEventId(),
  payload: {
    taskId: RuntimeTaskId.make(`task-${threadId}`),
    status: "failed",
    summary: `failed summary ${mark}`,
    typedUsage: TASK_TYPED_USAGE,
  },
});

const taskCompletedSuccess = (threadId: ThreadId, summary: string): ProviderRuntimeEvent => ({
  ...base(threadId),
  type: "task.completed",
  eventId: nextEventId(),
  payload: {
    taskId: RuntimeTaskId.make(`task-${threadId}-ok`),
    status: "completed",
    summary,
    typedUsage: TASK_TYPED_USAGE,
  },
});

const claudeErrorDelta = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  text: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  provider: claudeProvider,
  type: "content.delta",
  eventId: nextEventId(),
  turnId,
  itemId,
  raw: claudeErrorSnapshotRaw,
  payload: { streamKind: "assistant_text", delta: text },
});

const claudeErrorAssistantCompleted = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  detail: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  provider: claudeProvider,
  type: "item.completed",
  eventId: nextEventId(),
  turnId,
  itemId,
  raw: claudeErrorSnapshotRaw,
  payload: { itemType: "assistant_message", status: "completed", detail },
});

const claudeMaxTokensDelta = (
  threadId: ThreadId,
  turnId: TurnId,
  itemId: RuntimeItemId,
  text: string,
): ProviderRuntimeEvent => ({
  ...base(threadId),
  provider: claudeProvider,
  type: "content.delta",
  eventId: nextEventId(),
  turnId,
  itemId,
  raw: {
    source: "claude.sdk.message" as const,
    method: "claude/assistant",
    payload: { type: "assistant", error: "max_output_tokens" },
  },
  payload: { streamKind: "assistant_text", delta: text },
});

function createProviderServiceHarness(subscription: PubSub.Subscription<RuntimeEventBatch>) {
  const runtimeSessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    previewSubmissionRoute: () => unsupported(),
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported: () => unsupported(),
    getInstanceInfo: (id) => {
      const driverKind = ProviderDriverKind.make(String(id));
      return Effect.succeed({
        instanceId: id,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${id}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    streamEvents: Stream.fromSubscription(subscription).pipe(
      Stream.flatMap(({ events, enqueued }) =>
        Stream.concat(
          Stream.fromIterable(events),
          Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain),
        ),
      ),
    ),
  };
  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };
  return { service, setSession };
}

// Stores a covered event's free text can reach: the event store plus every
// projection row built from it. `project_memories` is intentionally absent —
// the marker's legitimate copy lives there.
const STORED_TEXT_STATEMENTS = [
  `SELECT payload_json AS "p" FROM orchestration_events`,
  `SELECT payload_json AS "p" FROM projection_thread_activities`,
  `SELECT text AS "p" FROM projection_thread_messages`,
  `SELECT last_error AS "p" FROM projection_thread_sessions`,
  `SELECT title AS "p" FROM projection_threads`,
] as const;

const runtimeErrorCount = (thread: OrchestrationThread | undefined) =>
  thread?.activities.filter((activity) => activity.kind === "runtime.error").length ?? 0;

const findActivity = (thread: OrchestrationThread | undefined, kind: string) =>
  thread?.activities.find((activity) => activity.kind === kind);

const payloadUsage = (activity: { readonly payload: unknown } | undefined) =>
  (activity?.payload as { usage?: unknown } | undefined)?.usage;

// The emitted runtime.error must surface as ITS OWN newly persisted activity —
// activity id equal to the emitted event id — carrying the fixed withheld
// payload. Checks on lastError or "some" runtime.error alone can pass on state
// an earlier scope left behind, even if the newer event was dropped entirely.
const expectPinnedWithheldError = Effect.fnUntraced(function* (
  harness: Pick<IngestionHarness, "readThread">,
  input: {
    readonly threadId: ThreadId;
    readonly emitted: ProviderRuntimeEvent;
    readonly expectedCount: number;
  },
) {
  const thread = yield* harness.readThread(input.threadId);
  const errors = thread?.activities.filter((activity) => activity.kind === "runtime.error") ?? [];
  expect(errors).toHaveLength(input.expectedCount);
  const pinned = errors.find((activity) => activity.id === input.emitted.eventId);
  expect(pinned?.payload).toEqual({ message: MEMORY_ECHO_WITHHELD_ERROR });
  expect(thread?.session?.lastError).toBe(MEMORY_ECHO_WITHHELD_ERROR);
});

const seedThread = Effect.fnUntraced(function* (
  harness: Pick<IngestionHarness, "dispatch" | "setProviderSession">,
  threadId: ThreadId,
  messageId: MessageId,
  tag: string,
) {
  yield* harness.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-echo-thread-create-${tag}`),
    threadId,
    projectId,
    title: "New thread",
    modelSelection: { instanceId, model: "gpt-5-codex" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: at,
  });
  yield* harness.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`cmd-echo-session-seed-${tag}`),
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: at,
    },
    createdAt: at,
  });
  yield* harness.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-echo-turn-start-${tag}`),
    threadId,
    message: {
      messageId,
      role: "user",
      text: "Start the turn",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: at,
  });
  harness.setProviderSession({
    provider,
    status: "ready",
    runtimeMode: "approval-required",
    threadId,
    createdAt: at,
    updatedAt: at,
  });
});

const admitTaintedMemory = Effect.fnUntraced(function* (
  harness: Pick<IngestionHarness, "memories" | "gate">,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly body: string;
  },
) {
  const inserted = yield* harness.memories.insert({
    memoryId,
    projectId,
    kind: "fact",
    title: "Echo memory",
    body: input.body,
    origin: { type: "manual" },
    validUntil: null,
    estimatedTokens: 12,
    now: at,
  });
  expect(inserted.status).toBe("applied");
  const admitted = yield* harness.gate.admit({
    threadId: input.threadId,
    messageId: input.messageId,
    projectId,
    providerInstanceId: instanceId,
    items: [{ memoryId, selectedVersion: 1 }],
    now: DateTime.makeUnsafe(at),
  });
  expect(admitted._tag).toBe("Committed");
});

const emitDiagnosticMatrix = Effect.fnUntraced(function* (
  harness: Pick<IngestionHarness, "emitAndDrain" | "readThread">,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly mark: string;
    readonly droppedMark: string;
    readonly expectedLastError: (field: string) => string;
    readonly naturalTool?: { readonly itemId: RuntimeItemId; readonly command: string };
  },
) {
  const { threadId, turnId, mark, droppedMark, expectedLastError, naturalTool } = input;
  const lastError = Effect.map(
    harness.readThread(threadId),
    (thread) => thread?.session?.lastError,
  );

  yield* harness.emitAndDrain([turnStarted(threadId, turnId)]);
  yield* harness.emitAndDrain([runtimeError(threadId, mark, turnId)]);
  expect(yield* lastError).toBe(expectedLastError(`runtime error ${mark}`));
  yield* harness.emitAndDrain([runtimeWarning(threadId, mark)]);
  yield* harness.emitAndDrain([
    assistantDelta(threadId, turnId, itemFor(`${threadId}-assistant`), NATURAL_TEXT),
    itemCompleted(threadId, turnId, itemFor(`${threadId}-assistant`), "assistant_message"),
  ]);
  // An ordinary tool item is not a memory echo carrier: mid-turn it must pass
  // the guard untouched and persist verbatim.
  if (naturalTool) {
    yield* harness.emitAndDrain([
      toolCompleted(threadId, turnId, naturalTool.itemId, naturalTool.command),
    ]);
  }
  yield* harness.emitAndDrain([
    itemCompleted(
      threadId,
      turnId,
      itemFor(`${threadId}-user`),
      "user_message",
      `native ${droppedMark}`,
    ),
    droppedDelta(threadId, turnId, "command_output", `cmdout ${droppedMark}`),
    droppedDelta(threadId, turnId, "unknown", `unk ${droppedMark}`),
  ]);
  yield* harness.emitAndDrain([metadataUpdated(threadId, `echoed title ${mark}`)]);
  yield* harness.emitAndDrain([threadCompacted(threadId, mark)]);
  yield* harness.emitAndDrain([sessionError(threadId, mark)]);
  expect(yield* lastError).toBe(expectedLastError(`session reason ${mark}`));
  yield* harness.emitAndDrain([turnFailed(threadId, turnId, mark)]);
  expect(yield* lastError).toBe(expectedLastError(`turn failed ${mark}`));
});

describe("ProviderRuntimeIngestion memory echo guard", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Builds the real persistence/gate/engine/ingestion graph over one file
  // database and hands the test Effect-valued operations only. Every scope is
  // armed before any risky acquisition, so a failure mid-setup still closes
  // ingestion, layers, and the subscription in the finally block.
  const withHarness = <A, E>(
    dbPath: string,
    run: (harness: IngestionHarness) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const dir = NodePath.dirname(dbPath);
      const pubsubScope = yield* Scope.make("sequential");
      const liveLayerScope = yield* Scope.make("sequential");
      const ingestionScope = yield* Scope.make("sequential");
      try {
        const runtimeEventPubSub = yield* PubSub.unbounded<RuntimeEventBatch>();
        // Subscribe before ingestion starts: every publish is captured even if
        // the stream consumer has not reached its first pull yet.
        const subscription = yield* PubSub.subscribe(runtimeEventPubSub).pipe(
          Scope.provide(pubsubScope),
        );
        const providerHarness = createProviderServiceHarness(subscription);

        // Arms one deterministic mixed cause (typed SQL failure + interrupt)
        // for the guard's attempt lookup on one thread. Unarmed, the wrapper
        // below is a pass-through of the real file SQLite client.
        const guardTrigger: {
          armed: { readonly threadId: ThreadId; readonly cause: Cause.Cause<unknown> } | null;
        } = { armed: null };

        const persistence = makeSqlitePersistenceLive(dbPath);
        const guardTriggerSqlLayer = Layer.effect(
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
                const armed = guardTrigger.armed;
                const template = Array.isArray(args[0])
                  ? (args[0] as readonly string[]).join("")
                  : "";
                if (
                  armed !== null &&
                  template.includes("SELECT 1") &&
                  template.includes("project_memory_send_attempts") &&
                  args.slice(1).some((param) => String(param) === armed.threadId)
                ) {
                  return Effect.failCause(armed.cause);
                }
                return Reflect.apply(target, thisArg, args);
              },
            });
          }),
        ).pipe(Layer.provide(persistence));

        const engineLayer = OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const snapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const ingestionSnapshotLayer = Layer.effect(
          ProjectionSnapshotQuery,
          Effect.gen(function* () {
            const query = yield* ProjectionSnapshotQuery;
            return ProjectionSnapshotQuery.of({
              ...query,
              getThreadDetailById: () =>
                Effect.die("provider runtime ingestion must not hydrate thread detail"),
            });
          }),
        ).pipe(Layer.provide(snapshotLayer));
        const memoryLayers = Layer.mergeAll(
          projectMemorySendGateLayer,
          projectMemoryRepositoryLayer,
        ).pipe(Layer.provideMerge(persistence));
        const layer = ProviderRuntimeIngestionLive.pipe(
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(ingestionSnapshotLayer),
          Layer.provideMerge(restartContinuationsLayer),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          // Provided before the raw persistence layer so the ingestion layer
          // (and with it the memory echo guard) resolves the wrapped client.
          Layer.provideMerge(guardTriggerSqlLayer),
          Layer.provideMerge(persistence),
          Layer.provideMerge(memoryLayers),
          Layer.provideMerge(Layer.succeed(ProviderService, providerHarness.service)),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(layer, liveLayerScope);
        const live = Effect.provideContext(context);
        const engine = yield* live(Effect.service(OrchestrationEngineService));
        const snapshotQuery = yield* live(Effect.service(ProjectionSnapshotQuery));
        const ingestion = yield* live(Effect.service(ProviderRuntimeIngestionService));
        const gate = yield* live(Effect.service(ProjectMemorySendGate));
        const memories = yield* live(Effect.service(ProjectMemoryRepository));
        const sql = yield* live(Effect.service(SqlClient.SqlClient));
        yield* ingestion.start().pipe(Scope.provide(ingestionScope));

        const emit = Effect.fnUntraced(function* (events: ReadonlyArray<ProviderRuntimeEvent>) {
          const enqueued = yield* Deferred.make<void>();
          yield* PubSub.publish(runtimeEventPubSub, { events, enqueued });
          yield* Deferred.await(enqueued);
        });

        const harness: IngestionHarness = {
          dispatch: (command) => live(engine.dispatch(command)),
          emit: (events) => emit(events),
          emitAndDrain: (events) =>
            Effect.gen(function* () {
              yield* emit(events);
              yield* ingestion.drain;
            }),
          readThread: (threadId) =>
            Effect.map(live(snapshotQuery.getSnapshot()), (snapshot) =>
              snapshot.threads.find((entry) => entry.id === threadId),
            ),
          readAllStoredText: () =>
            live(
              Effect.gen(function* () {
                const chunks: string[] = [];
                for (const statement of STORED_TEXT_STATEMENTS) {
                  const rows = yield* sql.unsafe<{ readonly p: string | null }>(statement);
                  for (const row of rows) {
                    if (row.p !== null) chunks.push(row.p);
                  }
                }
                return chunks.join("\n");
              }),
            ),
          armGuardLookupFailure: (threadId, cause) => {
            guardTrigger.armed = { threadId, cause };
          },
          disarmGuardLookup: () => {
            guardTrigger.armed = null;
          },
          setProviderSession: providerHarness.setSession,
          gate,
          memories,
          sql,
        };
        return yield* run(harness);
      } finally {
        yield* Scope.close(ingestionScope, Exit.void);
        yield* Scope.close(liveLayerScope, Exit.void);
        yield* Scope.close(pubsubScope, Exit.void);
      }
    });

  it.live(
    "withholds covered diagnostics on an admitted thread while the clean thread persists them",
    () =>
      Effect.gen(function* () {
        const dir = makeTempDir("t3-echo-i1-");
        const dbPath = NodePath.join(dir, "live.sqlite");
        yield* withHarness(
          dbPath,
          Effect.fnUntraced(function* (harness) {
            yield* harness.dispatch({
              type: "project.create",
              commandId: CommandId.make("cmd-echo-project-create"),
              projectId,
              title: "Echo Project",
              workspaceRoot: dir,
              defaultModelSelection: { instanceId, model: "gpt-5-codex" },
              createdAt: at,
            });
            yield* seedThread(harness, threadTainted, MessageId.make("msg-tainted-1"), "tainted");
            yield* seedThread(harness, threadClean, MessageId.make("msg-clean-1"), "clean");
            yield* admitTaintedMemory(harness, {
              threadId: threadTainted,
              messageId: MessageId.make("msg-tainted-1"),
              body: MARK_BODY,
            });

            yield* emitDiagnosticMatrix(harness, {
              threadId: threadTainted,
              turnId: turnFor("tainted"),
              mark: MARK_BODY,
              droppedMark: MARK_DROPPED,
              expectedLastError: () => MEMORY_ECHO_WITHHELD_ERROR,
              naturalTool: { itemId: itemFor("tainted-tool"), command: `printf ${MARK_TOOL}` },
            });
            yield* emitDiagnosticMatrix(harness, {
              threadId: threadClean,
              turnId: turnFor("clean"),
              mark: MARK_CLEAN,
              droppedMark: MARK_CLEAN_DROPPED,
              expectedLastError: (field) => field,
            });

            const tainted = yield* harness.readThread(threadTainted);
            expect(tainted?.session?.status).toBe("error");
            expect(tainted?.session?.lastError).toBe(MEMORY_ECHO_WITHHELD_ERROR);
            expect(tainted?.title).toBe("New thread");
            expect(findActivity(tainted, "runtime.error")?.payload).toEqual({
              message: MEMORY_ECHO_WITHHELD_ERROR,
            });
            const taintedWarning = findActivity(tainted, "runtime.warning");
            expect(taintedWarning?.summary).toBe(MEMORY_ECHO_WITHHELD_NOTICE);
            expect(taintedWarning?.payload).toEqual({ message: MEMORY_ECHO_WITHHELD_NOTICE });
            expect(findActivity(tainted, "context-compaction")?.payload).toEqual({
              state: "compacted",
              beforeTokens: 9000,
              afterTokens: 1200,
            });
            expect(
              tainted?.messages.some(
                (message) => message.role === "assistant" && message.text === NATURAL_TEXT,
              ),
            ).toBe(true);
            const taintedUsage = findActivity(tainted, OWNED_USAGE_ACTIVITY_KIND);
            expect(payloadUsage(taintedUsage)).toEqual(TOKEN_USAGE);
            // The ordinary tool item persisted verbatim on the tainted thread:
            // the guard covers six echo-prone shapes, not tool payloads.
            const taintedTool = findActivity(tainted, "tool.completed");
            expect(taintedTool?.payload).toEqual({
              itemType: "command_execution",
              toolCallId: itemFor("tainted-tool"),
              status: "completed",
              title: "fixture command",
              data: { toolCallId: itemFor("tainted-tool"), command: `printf ${MARK_TOOL}` },
            });

            const clean = yield* harness.readThread(threadClean);
            expect(clean?.session?.status).toBe("error");
            expect(clean?.session?.lastError).toBe(`turn failed ${MARK_CLEAN}`);
            expect(clean?.title).toBe(`echoed title ${MARK_CLEAN}`);
            expect(findActivity(clean, "runtime.error")?.payload).toEqual({
              message: `runtime error ${MARK_CLEAN}`,
              code: `ERR-${MARK_CLEAN}`,
            });
            expect(findActivity(clean, "runtime.warning")?.payload).toEqual({
              message: `runtime warning ${MARK_CLEAN}`,
              detail: { marker: MARK_CLEAN },
            });
            expect(findActivity(clean, "context-compaction")?.payload).toEqual({
              state: "compacted",
              beforeTokens: 9000,
              afterTokens: 1200,
              detail: { marker: MARK_CLEAN },
            });
            expect(
              clean?.messages.some(
                (message) => message.role === "assistant" && message.text === NATURAL_TEXT,
              ),
            ).toBe(true);

            const stored = yield* harness.readAllStoredText();
            expect(stored).not.toContain(MARK_BODY);
            expect(stored).not.toContain(MARK_DROPPED);
            expect(stored).toContain(MARK_CLEAN);
            expect(stored).not.toContain(MARK_CLEAN_DROPPED);
            // The tool sentinel rides the same scan as a positive control —
            // no blanket tool exemption weakens the marker absences above.
            expect(stored).toContain(MARK_TOOL);
          }),
        );
      }),
  );

  it.live("keeps withholding after a file-database reopen with a fresh guard", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo-i2-");
      const dbPath = NodePath.join(dir, "live.sqlite");

      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo-project-create"),
            projectId,
            title: "Echo Project",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(harness, threadTainted, MessageId.make("msg-tainted-1"), "tainted");
          yield* admitTaintedMemory(harness, {
            threadId: threadTainted,
            messageId: MessageId.make("msg-tainted-1"),
            body: MARK_BODY,
          });
          const firstError = runtimeError(threadTainted, MARK_BODY);
          yield* harness.emitAndDrain([firstError]);
          yield* expectPinnedWithheldError(harness, {
            threadId: threadTainted,
            emitted: firstError,
            expectedCount: 1,
          });
        }),
      );

      // A reopen builds a new guard with an empty taint cache; the durable
      // attempt row must still withhold. The pin proves the restart event
      // itself was processed after the reopen, not that old state survives.
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          const beforeCount = runtimeErrorCount(yield* harness.readThread(threadTainted));
          expect(beforeCount).toBe(1);
          const restartError = runtimeError(threadTainted, MARK_RESTART);
          yield* harness.emitAndDrain([restartError]);
          yield* expectPinnedWithheldError(harness, {
            threadId: threadTainted,
            emitted: restartError,
            expectedCount: beforeCount + 1,
          });
          const stored = yield* harness.readAllStoredText();
          expect(stored).not.toContain(MARK_BODY);
          expect(stored).not.toContain(MARK_RESTART);
        }),
      );
    }),
  );

  it.live("keeps withholding when the committed memory is updated and deleted", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo-i3-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo-project-create"),
            projectId,
            title: "Echo Project",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(harness, threadTainted, MessageId.make("msg-tainted-1"), "tainted");
          yield* admitTaintedMemory(harness, {
            threadId: threadTainted,
            messageId: MessageId.make("msg-tainted-1"),
            body: MARK_BODY,
          });
          const firstError = runtimeError(threadTainted, MARK_BODY);
          yield* harness.emitAndDrain([firstError]);
          yield* expectPinnedWithheldError(harness, {
            threadId: threadTainted,
            emitted: firstError,
            expectedCount: 1,
          });

          const updated = yield* harness.memories.update({
            projectId,
            memoryId,
            expectedVersion: 1,
            title: "Echo memory",
            body: MARK_EDITED,
            kind: "fact",
            validUntil: null,
            estimatedTokens: 12,
            now: at,
          });
          expect(updated.status).toBe("applied");
          const updateError = runtimeError(threadTainted, MARK_EDITED);
          yield* harness.emitAndDrain([updateError]);
          yield* expectPinnedWithheldError(harness, {
            threadId: threadTainted,
            emitted: updateError,
            expectedCount: 2,
          });

          const deleted = yield* harness.memories.delete({
            projectId,
            memoryId,
            expectedVersion: 2,
          });
          expect(deleted.status).toBe("applied");
          const deleteError = runtimeError(threadTainted, MARK_DELETED);
          yield* harness.emitAndDrain([deleteError]);
          yield* expectPinnedWithheldError(harness, {
            threadId: threadTainted,
            emitted: deleteError,
            expectedCount: 3,
          });

          // The durable attempt row survives memory edits and deletion: taint
          // is owned by the send ledger, not by the memory row's contents.
          const attempts = yield* harness.sql.unsafe<{ readonly n: number }>(
            `SELECT COUNT(*) AS "n" FROM project_memory_send_attempts WHERE thread_id = '${threadTainted}'`,
          );
          expect(attempts[0]?.n).toBe(1);

          const stored = yield* harness.readAllStoredText();
          expect(stored).not.toContain(MARK_BODY);
          expect(stored).not.toContain(MARK_EDITED);
          expect(stored).not.toContain(MARK_DELETED);
        }),
      );
    }),
  );

  it.live("fails closed on a lookup failure and recovers without caching taint", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo-i4-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo-project-create"),
            projectId,
            title: "Echo Project",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(harness, threadClean, MessageId.make("msg-clean-1"), "clean");
          const turnId = turnFor("sqlfail");
          yield* harness.emitAndDrain([turnStarted(threadClean, turnId)]);

          // Renaming the table makes the guard's lookup fail as an ordinary
          // SQL failure — not a defect; the helper's U3g covers defects.
          yield* harness.sql.unsafe(
            "ALTER TABLE project_memory_send_attempts RENAME TO memory_send_attempts_broken",
          );
          yield* harness.emitAndDrain([runtimeError(threadClean, MARK_SQLFAIL, turnId)]);
          // Lookup failure: the clean thread's diagnostic is withheld anyway.
          expect((yield* harness.readThread(threadClean))?.session?.lastError).toBe(
            MEMORY_ECHO_WITHHELD_ERROR,
          );

          // Non-target traffic keeps flowing through the same guard.
          yield* harness.emitAndDrain([
            assistantDelta(threadClean, turnId, itemFor("sqlfail-assistant"), NATURAL_TEXT),
            itemCompleted(threadClean, turnId, itemFor("sqlfail-assistant"), "assistant_message"),
          ]);
          expect(
            (yield* harness.readThread(threadClean))?.messages.some(
              (message) => message.role === "assistant" && message.text === NATURAL_TEXT,
            ),
          ).toBe(true);

          yield* harness.sql.unsafe(
            "ALTER TABLE memory_send_attempts_broken RENAME TO project_memory_send_attempts",
          );
          yield* harness.emitAndDrain([runtimeError(threadClean, MARK_SQLFAIL, turnId)]);
          // The failed lookup was not cached as positive taint: after
          // restoration the raw diagnostics persist instead of staying
          // withheld.
          expect((yield* harness.readThread(threadClean))?.session?.lastError).toBe(
            `runtime error ${MARK_SQLFAIL}`,
          );
          const stored = yield* harness.readAllStoredText();
          expect(stored).toContain(MARK_SQLFAIL);
        }),
      );
    }),
  );

  it.live("preserves owned-usage recording while withholding the failed terminal message", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo-i5-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo-project-create"),
            projectId,
            title: "Echo Project",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(harness, threadTainted, MessageId.make("msg-tainted-1"), "tainted");
          yield* admitTaintedMemory(harness, {
            threadId: threadTainted,
            messageId: MessageId.make("msg-tainted-1"),
            body: MARK_BODY,
          });
          const turnId = turnFor("usage");
          yield* harness.emitAndDrain([turnStarted(threadTainted, turnId)]);
          yield* harness.emitAndDrain([turnFailed(threadTainted, turnId, MARK_BODY)]);

          const tainted = yield* harness.readThread(threadTainted);
          expect(tainted?.session?.status).toBe("error");
          expect(tainted?.session?.lastError).toBe(MEMORY_ECHO_WITHHELD_ERROR);
          const ownedUsage = findActivity(tainted, OWNED_USAGE_ACTIVITY_KIND);
          expect(ownedUsage?.payload).toMatchObject({
            scope: "main-turn",
            terminal: "failed",
          });
          // The retained usage is TOKEN_USAGE exactly — including usageScope
          // and hasSubagents — closing the unchanged-usage contract.
          expect(payloadUsage(ownedUsage)).toEqual(TOKEN_USAGE);
          const stored = yield* harness.readAllStoredText();
          expect(stored).not.toContain(MARK_BODY);
        }),
      );
    }),
  );

  it.live(
    "propagates a mixed lookup cause past the ingestion boundary without dispatch or warning",
    () =>
      Effect.gen(function* () {
        const dir = makeTempDir("t3-echo-mixed-");
        const dbPath = NodePath.join(dir, "live.sqlite");
        const sqlError = new SqlError({
          reason: classifySqliteError(new Error(MIXED_SQL_REASON), {
            message: MIXED_SQL_REASON,
            operation: "execute",
          }),
        });
        const mixedCause = Cause.combine(Cause.fail(sqlError), Cause.interrupt());

        yield* withHarness(
          dbPath,
          Effect.fnUntraced(function* (harness) {
            yield* harness.dispatch({
              type: "project.create",
              commandId: CommandId.make("cmd-echo-project-create"),
              projectId,
              title: "Echo Project",
              workspaceRoot: dir,
              defaultModelSelection: { instanceId, model: "gpt-5-codex" },
              createdAt: at,
            });
            yield* seedThread(harness, threadMixed, MessageId.make("msg-mixed-1"), "mixed");

            // Baseline: the clean thread's diagnostic persists normally and is
            // the thread's only runtime error so far.
            const keptError = runtimeError(threadMixed, MARK_KEPT);
            yield* harness.emitAndDrain([keptError]);
            const before = yield* harness.readThread(threadMixed);
            expect(before?.session?.lastError).toBe(`runtime error ${MARK_KEPT}`);
            expect(runtimeErrorCount(before)).toBe(1);

            // Arm the guard's attempt lookup with a mixed cause (typed SQL
            // failure plus interrupt) and the worker observation for exactly
            // this event, then emit WITHOUT drain: drain is not an exit
            // oracle, and a worker terminated by an interrupt must not be fed
            // more work.
            const mixedEvent = runtimeError(threadMixed, MARK_MIXED);
            const observed = {
              eventId: mixedEvent.eventId,
              exit: null as Exit.Exit<void, unknown> | null,
              done: yield* Deferred.make<void>(),
            };
            workerObservation.armed = observed;
            harness.armGuardLookupFailure(threadMixed, mixedCause);
            yield* harness.emit([mixedEvent]);
            yield* Deferred.await(observed.done);
            harness.disarmGuardLookup();
            workerObservation.armed = null;

            // The real worker fiber observed the process Effect FAIL with the
            // whole original cause. logIngestionFailure recovers only causes
            // that carry no interrupt — had it caught this one, the process
            // would have completed as a logged success. A failing exit with
            // interrupts and the intact typed component is therefore the
            // boundary proof: mixed cause preserved, no cause-bearing warning,
            // and nothing below the guard ran.
            const exit = observed.exit;
            if (!exit || Exit.isSuccess(exit)) {
              return expect.fail("worker must observe the mixed cause as a process failure");
            }
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(sqlError));

            // Nothing from the aborted event reached any store: the baseline
            // error stands, no new runtime.error activity, no marker, and no
            // injected SQL reason anywhere persisted.
            const after = yield* harness.readThread(threadMixed);
            expect(after?.session?.lastError).toBe(`runtime error ${MARK_KEPT}`);
            expect(runtimeErrorCount(after)).toBe(1);
            const stored = yield* harness.readAllStoredText();
            expect(stored).not.toContain(MARK_MIXED);
            expect(stored).not.toContain(MIXED_SQL_REASON);
          }),
        );
      }),
  );

  it.live("withholds A-ECHO-2 task and tool diagnostics on a tainted thread (A1)", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo2-a1-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo2-project-create"),
            projectId,
            title: "Echo2 Project",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(
            harness,
            threadEcho2Tainted,
            MessageId.make("msg-echo2-tainted"),
            "echo2-tainted",
          );
          yield* seedThread(
            harness,
            threadEcho2Clean,
            MessageId.make("msg-echo2-clean"),
            "echo2-clean",
          );
          yield* admitTaintedMemory(harness, {
            threadId: threadEcho2Tainted,
            messageId: MessageId.make("msg-echo2-tainted"),
            body: MARK_BODY,
          });

          const progressTainted = taskProgressErrorOnly(threadEcho2Tainted, MARK_E2_TASK_TAINTED);
          const failedTainted = taskCompletedFailed(threadEcho2Tainted, MARK_E2_TASK_TAINTED);
          const successTainted = taskCompletedSuccess(threadEcho2Tainted, MARK_E2_SUCCESS);
          const progressClean = taskProgressErrorOnly(threadEcho2Clean, MARK_E2_TASK_CLEAN);
          const failedClean = taskCompletedFailed(threadEcho2Clean, MARK_E2_TASK_CLEAN);

          const emitTaskToolBatch = (
            threadId: ThreadId,
            mark: string,
            events: ProviderRuntimeEvent[],
          ) =>
            harness.emitAndDrain([
              toolDenied(threadId, mark),
              ...events,
              taskUpdatedError(threadId, mark),
            ]);

          yield* emitTaskToolBatch(threadEcho2Tainted, MARK_E2_TASK_TAINTED, [
            progressTainted,
            failedTainted,
            successTainted,
          ]);
          yield* emitTaskToolBatch(threadEcho2Clean, MARK_E2_TASK_CLEAN, [
            progressClean,
            failedClean,
            taskCompletedSuccess(threadEcho2Clean, MARK_E2_SUCCESS),
          ]);

          const tainted = yield* harness.readThread(threadEcho2Tainted);
          if (!tainted) {
            return expect.fail("expected tainted thread snapshot");
          }
          const denied = findActivity(tainted, "tool.denied");
          expect(denied).toBeDefined();
          expect(denied!.summary).toBe("Tool denied: fixture-tool");
          expect(denied!.payload).toEqual({
            toolName: "fixture-tool",
            toolUseId: "tool-use-echo2",
            agentId: "agent-echo2",
          });
          const progressRows = tainted.activities.filter(
            (activity) => activity.kind === "task.progress",
          );
          expect(progressRows).toHaveLength(2);
          const stateRow = progressRows.find((row) => row.summary !== "Task usage updated");
          expect(stateRow).toBeDefined();
          const statePayload = stateRow!.payload as { error?: string; typedUsage?: unknown };
          expect(statePayload.error).toBe(MEMORY_ECHO_WITHHELD_ERROR);
          expect(statePayload.typedUsage).toBeUndefined();
          const usageRow = progressRows.find((row) => row.summary === "Task usage updated");
          expect(usageRow).toBeDefined();
          expect(usageRow!.payload).toMatchObject({
            typedUsage: TASK_TYPED_USAGE,
            usageSnapshot: true,
            usageSource: {
              v: 1,
              driver: provider,
              instanceId: instanceId,
              runtimeEventId: progressTainted.eventId,
              phase: "progress",
            },
          });
          const updatedTainted = findActivity(tainted, "task.updated");
          expect(updatedTainted!.payload).toMatchObject({
            error: MEMORY_ECHO_WITHHELD_ERROR,
          });
          const failedTask = tainted.activities.find(
            (activity) =>
              activity.kind === "task.completed" &&
              (activity.payload as { status?: string }).status === "failed",
          );
          expect(failedTask).toBeDefined();
          expect(failedTask!.summary).toBe("Task failed");
          const failedPayload = failedTask!.payload as {
            status?: string;
            summary?: string;
            detail?: string;
            typedUsage?: unknown;
          };
          expect(failedPayload).toMatchObject({
            status: "failed",
            typedUsage: TASK_TYPED_USAGE,
          });
          expect(failedPayload.summary).toBeUndefined();
          expect(failedPayload.detail).toBeUndefined();
          expect(failedPayload).toMatchObject({
            usageSource: {
              runtimeEventId: failedTainted.eventId,
              phase: "completed",
            },
          });
          const successTask = tainted.activities.find(
            (activity) =>
              activity.kind === "task.completed" &&
              (activity.payload as { status?: string }).status === "completed",
          );
          expect(successTask).toBeDefined();
          expect(successTask!.payload).toMatchObject({
            summary: MARK_E2_SUCCESS,
            detail: MARK_E2_SUCCESS,
            usageSource: { runtimeEventId: successTainted.eventId, phase: "completed" },
          });

          const clean = yield* harness.readThread(threadEcho2Clean);
          if (!clean) {
            return expect.fail("expected clean thread snapshot");
          }
          const cleanDenied = findActivity(clean, "tool.denied");
          expect(cleanDenied!.payload).toMatchObject({
            detail: `denied ${MARK_E2_TASK_CLEAN}`,
          });
          const cleanProgress = clean.activities.filter(
            (activity) => activity.kind === "task.progress",
          );
          expect(cleanProgress).toHaveLength(2);
          const cleanStateRow = cleanProgress.find((row) => row.summary !== "Task usage updated");
          expect(cleanStateRow!.payload).toMatchObject({
            error: `progress error ${MARK_E2_TASK_CLEAN}`,
          });
          const cleanUpdated = findActivity(clean, "task.updated");
          expect((cleanUpdated!.payload as { error?: string }).error).toBe(
            `updated error ${MARK_E2_TASK_CLEAN}`,
          );
          const cleanFailed = clean.activities.find(
            (activity) =>
              activity.kind === "task.completed" &&
              (activity.payload as { status?: string }).status === "failed",
          );
          expect(cleanFailed!.payload).toMatchObject({
            summary: `failed summary ${MARK_E2_TASK_CLEAN}`,
            detail: `failed summary ${MARK_E2_TASK_CLEAN}`,
          });

          const stored = yield* harness.readAllStoredText();
          expect(stored).not.toContain(MARK_E2_TASK_TAINTED);
          expect(stored).toContain(MARK_E2_SUCCESS);
          expect(stored).toContain(MARK_E2_TASK_CLEAN);
        }),
      );
    }),
  );

  it.live("withholds Claude error-bearing assistant snapshots on a tainted thread (A2)", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo2-a2-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo2-a2-project"),
            projectId,
            title: "Echo2 Claude",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(
            harness,
            threadEcho2Tainted,
            MessageId.make("msg-echo2-a2-tainted"),
            "echo2-a2-tainted",
          );
          yield* seedThread(
            harness,
            threadEcho2Clean,
            MessageId.make("msg-echo2-a2-clean"),
            "echo2-a2-clean",
          );
          yield* admitTaintedMemory(harness, {
            threadId: threadEcho2Tainted,
            messageId: MessageId.make("msg-echo2-a2-tainted"),
            body: MARK_BODY,
          });

          const turnTainted = turnFor("echo2-claude-tainted");
          const turnClean = turnFor("echo2-claude-clean");
          const itemTainted = itemFor("echo2-claude-tainted");
          const itemClean = itemFor("echo2-claude-clean");

          const emitClaudeError = (
            threadId: ThreadId,
            turnId: TurnId,
            itemId: RuntimeItemId,
            mark: string,
          ) =>
            harness.emitAndDrain([
              turnStarted(threadId, turnId),
              claudeErrorDelta(threadId, turnId, itemId, `claude error body ${mark}`),
              claudeErrorAssistantCompleted(threadId, turnId, itemId, `claude completion ${mark}`),
            ]);

          yield* emitClaudeError(
            threadEcho2Tainted,
            turnTainted,
            itemTainted,
            MARK_E2_CLAUDE_TAINTED,
          );
          yield* emitClaudeError(threadEcho2Clean, turnClean, itemClean, MARK_E2_CLAUDE_CLEAN);

          const tainted = yield* harness.readThread(threadEcho2Tainted);
          if (!tainted) {
            return expect.fail("expected tainted thread snapshot");
          }
          // Delta streaming is what lands assistant message text here; completion
          // on the same item is not a separate proof of fallback consumption.
          expect(
            tainted.messages.some(
              (message) =>
                message.role === "assistant" && message.text === MEMORY_ECHO_WITHHELD_ERROR,
            ),
          ).toBe(true);

          const clean = yield* harness.readThread(threadEcho2Clean);
          if (!clean) {
            return expect.fail("expected clean thread snapshot");
          }
          expect(
            clean.messages.some((message) => message.text?.includes(MARK_E2_CLAUDE_CLEAN)),
          ).toBe(true);

          const stored = yield* harness.readAllStoredText();
          expect(stored).not.toContain(MARK_E2_CLAUDE_TAINTED);
          expect(stored).toContain(MARK_E2_CLAUDE_CLEAN);
        }),
      );
    }),
  );

  it.live("leaves non-target Claude and stream text on a tainted thread (A3)", () =>
    Effect.gen(function* () {
      const dir = makeTempDir("t3-echo2-a3-");
      const dbPath = NodePath.join(dir, "live.sqlite");
      yield* withHarness(
        dbPath,
        Effect.fnUntraced(function* (harness) {
          yield* harness.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-echo2-a3-project"),
            projectId,
            title: "Echo2 Controls",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "gpt-5-codex" },
            createdAt: at,
          });
          yield* seedThread(
            harness,
            threadEcho2Controls,
            MessageId.make("msg-echo2-a3"),
            "echo2-a3",
          );
          yield* admitTaintedMemory(harness, {
            threadId: threadEcho2Controls,
            messageId: MessageId.make("msg-echo2-a3"),
            body: MARK_BODY,
          });

          const turnId = turnFor("echo2-controls");
          const itemId = itemFor("echo2-controls");
          yield* harness.emitAndDrain([
            turnStarted(threadEcho2Controls, turnId),
            assistantDelta(threadEcho2Controls, turnId, itemId, `stream keep ${MARK_E2_KEEP}`),
            itemCompleted(
              threadEcho2Controls,
              turnId,
              itemId,
              "assistant_message",
              `completion keep ${MARK_E2_KEEP}`,
            ),
            claudeMaxTokensDelta(
              threadEcho2Controls,
              turnId,
              itemFor("echo2-max"),
              `max tokens keep ${MARK_E2_KEEP}`,
            ),
          ]);

          const thread = yield* harness.readThread(threadEcho2Controls);
          expect(thread?.messages.some((message) => message.text?.includes(MARK_E2_KEEP))).toBe(
            true,
          );

          const stored = yield* harness.readAllStoredText();
          expect(stored).toContain(MARK_E2_KEEP);
        }),
      );
    }),
  );
});
