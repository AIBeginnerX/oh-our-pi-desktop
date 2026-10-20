// @effect-diagnostics abortControllerInEffect:off - Tests hand-built AbortSignals to the SDK query stub to exercise cancellation.
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OWNED_USAGE_ACTIVITY_KIND,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
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
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MEMORY_ECHO_WITHHELD_ERROR } from "../../orchestration/memoryEcho.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type {
  ProviderAdmissionObservation,
  ProviderSendTurnAdmission,
  ProviderSubmissionRoutePreview,
} from "../Services/ProviderAdapter.ts";
import type { ClaudeScopedLimitNames } from "./claudeUsageLimits.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  private readonly permissionModeGates = new Map<number, Promise<void>>();
  private readonly modelGates = new Map<number, Promise<void>>();
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public closeCalls = 0;
  public closeError: unknown | undefined;
  /** Set by tests that exercise Claude's graceful interrupt. */
  public interrupt?: () => Promise<unknown>;
  /** Called when the consumer asks for a message and none is queued: it has handled all that were emitted. */
  public onIdle: (() => void) | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
    const gate = this.modelGates.get(this.setModelCalls.length);
    if (gate) await gate;
  };

  /** Parks the `call`th (1-based) setModel until the test settles it. */
  gateSetModel(call: number): {
    readonly resolve: () => void;
    readonly reject: (cause: unknown) => void;
  } {
    let settle: { resolve: () => void; reject: (cause: unknown) => void } | undefined;
    this.modelGates.set(
      call,
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
    );
    return {
      resolve: () => settle?.resolve(),
      reject: (cause) => settle?.reject(cause),
    };
  }

  /** Parks the `call`th (1-based) setPermissionMode until the test settles it. */
  gatePermissionMode(call: number): {
    readonly resolve: () => void;
    readonly reject: (cause: unknown) => void;
  } {
    let settle: { resolve: () => void; reject: (cause: unknown) => void } | undefined;
    this.permissionModeGates.set(
      call,
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
    );
    return {
      resolve: () => settle?.resolve(),
      reject: (cause) => settle?.reject(cause),
    };
  }

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
    const gate = this.permissionModeGates.get(this.setPermissionModeCalls.length);
    if (gate) await gate;
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
          this.onIdle?.();
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly scopedLimitNames?: ClaudeAdapterLiveOptions["scopedLimitNames"];
  readonly environment?: ClaudeAdapterLiveOptions["environment"];
  readonly getSessionMessages?: ClaudeAdapterLiveOptions["getSessionMessages"];
  readonly forkSession?: ClaudeAdapterLiveOptions["forkSession"];
  readonly modelCatalog?: ClaudeAdapterLiveOptions["modelCatalog"];
}) {
  const query = new FakeClaudeQuery();
  const queries = [query];
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.environment ? { environment: config.environment } : {}),
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    ...(config?.scopedLimitNames ? { scopedLimitNames: config.scopedLimitNames } : {}),
    modelCatalog: config?.modelCatalog ?? Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    ...(config?.getSessionMessages ? { getSessionMessages: config.getSessionMessages } : {}),
    ...(config?.forkSession ? { forkSession: config.forkSession } : {}),
    createQuery: (input) => {
      if (createInput && config?.getSessionMessages) queries.push(new FakeClaudeQuery());
      createInput = input;
      return queries.at(-1)!;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    queries,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

/** Drains the first `count` queued prompts so consecutive turns can be compared. */
async function readPromptMessages(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
  count: number,
): Promise<Array<SDKUserMessage>> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return [];
  }
  const messages: Array<SDKUserMessage> = [];
  while (messages.length < count) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    messages.push(next.value);
  }
  return messages;
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");
const SYNTHETIC_SUBAGENT_MODEL = "claude-synthetic-subagent[expanded]";
const CLAUDE_ORIGINAL_SESSION_ID = "550e8400-e29b-41d4-a716-446655440010";
const CLAUDE_FORK_SESSION_ID = "550e8400-e29b-41d4-a716-446655440020";

function claudeHistoryMessage(input: {
  readonly type: "user" | "assistant" | "system";
  readonly uuid: string;
  readonly sessionId?: string;
  readonly content?: unknown;
  readonly parentToolUseId?: string | null;
}) {
  const content =
    input.content ??
    (input.type === "user" ? "prompt" : input.type === "assistant" ? [] : { subtype: "init" });
  return {
    type: input.type,
    uuid: input.uuid,
    session_id: input.sessionId ?? CLAUDE_ORIGINAL_SESSION_ID,
    parent_tool_use_id: input.parentToolUseId ?? null,
    parent_agent_id: null,
    message: input.type === "system" ? content : { content },
  };
}

const sendCompletedClaudeTurn = (
  adapter: ClaudeAdapterShape,
  harness: ReturnType<typeof makeHarness>,
  threadId: ThreadId,
  input: string,
) =>
  Effect.gen(function* () {
    const turn = yield* adapter.sendTurn({
      threadId,
      input,
      attachments: [],
    });
    const completedFiber = yield* Stream.filter(
      adapter.streamEvents,
      (event) => event.type === "turn.completed",
    ).pipe(Stream.runHead, Effect.forkChild);
    harness.queries.at(-1)!.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      errors: [],
      session_id: CLAUDE_ORIGINAL_SESSION_ID,
      uuid: `result-${turn.turnId}`,
    } as unknown as SDKMessage);
    const completed = yield* Fiber.join(completedFiber);
    assert.equal(completed._tag, "Some");
    return turn;
  });

/**
 * Forks a send that runs synchronously to its first real suspension: the send
 * lock or a gated SDK call. Pair with `Scheduler.PreventSchedulerYield` so the
 * position of each send is known as soon as this returns.
 */
const forkSend = (adapter: ClaudeAdapterShape, input: string) =>
  adapter
    .sendTurn({ threadId: THREAD_ID, input, interactionMode: "default", attachments: [] })
    .pipe(Effect.forkChild({ startImmediately: true }));

const emitClaudeResult = (harness: ReturnType<typeof makeHarness>, uuid: string) =>
  harness.query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: "sdk-session-admission",
    uuid,
  } as unknown as SDKMessage);

/**
 * Runs `inject` just before the `injectAt`th interpreter step of any fiber it
 * schedules. Preemption can only land between steps, so every injection point
 * is an interleaving a real yield could produce. It never yields itself, so
 * step counts repeat exactly from run to run.
 */
class InjectAtStep extends Scheduler.MixedScheduler {
  steps = 0;
  injectAt = Number.POSITIVE_INFINITY;
  inject: () => void = () => undefined;

  override shouldYield(): boolean {
    if (++this.steps === this.injectAt) this.inject();
    return false;
  }
}

/** Hands the injecting scheduler to the wrapped effect only, never to the test fiber. */
const stepInjected =
  (scheduler: InjectAtStep) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Scheduler.Scheduler, scheduler),
      Effect.provideService(Scheduler.PreventSchedulerYield, false),
    );

/** A clock that advances a millisecond per read, so event order shows in `createdAt`. */
const makeTickingClock = (): Clock.Clock => {
  let now = Date.UTC(2026, 0, 1);
  const tick = () => ++now;
  const dies = () => Effect.die("the ticking clock does not sleep");
  return {
    currentTimeMillisUnsafe: tick,
    currentTimeMillis: Effect.sync(tick),
    currentTimeNanosUnsafe: () => BigInt(tick()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(tick()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(tick()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(tick()) * 1_000_000n),
    sleep: dies,
  };
};

const SWEEP_SENTINEL_THREAD_ID = ThreadId.make("thread-claude-sweep-sentinel");
const SWEEP_STEP_LIMIT = 5000;

interface SweepRun {
  readonly steps: number;
  readonly outcome: string;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Counts the steps of one send with nothing injected (twice, to prove the count
 * repeats), then reruns the scenario with the injection before each step in
 * turn. A violation names the step `k` and the step count `N` it was found at.
 */
const sweepSendSteps = Effect.fnUntraced(function* <E>(
  run: (injectAt: number) => Effect.Effect<SweepRun, E>,
) {
  const uninjected = yield* run(Number.POSITIVE_INFINITY);
  const repeated = yield* run(Number.POSITIVE_INFINITY);
  assert.equal(repeated.steps, uninjected.steps, "a send takes the same steps on every run");
  assert.isAbove(uninjected.steps, 0);
  assert.isAtMost(uninjected.steps, SWEEP_STEP_LIMIT);

  const steps = uninjected.steps;
  const runs: Array<SweepRun> = [];
  for (let k = 1; k <= steps; k++) {
    runs.push(yield* run(k));
  }
  return {
    steps,
    outcomes: runs.map((swept) => swept.outcome),
    violations: [
      ...uninjected.violations.map((violation) => `uninjected, N=${steps}: ${violation}`),
      ...runs.flatMap((swept, index) =>
        swept.violations.map((violation) => `k=${index + 1}, N=${steps}: ${violation}`),
      ),
    ],
  };
});

/** Every turn.started needs a later turn.completed of its turn, and every turn.completed an earlier turn.started. */
const turnPairing = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
  const turnEvents = events.filter(
    (event) => event.type === "turn.started" || event.type === "turn.completed",
  );
  const trace = turnEvents.map((event) => `${event.type}(${event.turnId})`).join(" ");
  const violations = turnEvents.flatMap((event, index) => {
    if (event.type === "turn.started") {
      return turnEvents
        .slice(index + 1)
        .some((later) => later.type === "turn.completed" && later.turnId === event.turnId)
        ? []
        : [`turn.started(${event.turnId}) has no later turn.completed [${trace}]`];
    }
    return turnEvents
      .slice(0, index)
      .some((earlier) => earlier.type === "turn.started" && earlier.turnId === event.turnId)
      ? []
      : [`turn.completed(${event.turnId}) has no earlier turn.started [${trace}]`];
  });
  return { turnEvents, trace, violations };
};

/**
 * One send with Stop injected before its `injectAt`th step. Opening the latch
 * resumes the parked stopper inline, so Stop's state changes up to its first
 * real suspension run at the injection point and the send resumes with Stop
 * already underway.
 *
 * Typed errors a send may fail with once Stop is underway:
 * - "not-found": Stop had unregistered the session before `requireSession` read
 *   the registry, so the send never captured a context. Expected for early
 *   steps; it is not SessionClosed because the thread no longer exists.
 * - "closed": the send captured its context and saw it stopped, at
 *   `requireSession`, `ensureOpen`, or the prompt offer.
 * Either error means the send published nothing. A send that returns a turn was
 * admitted before Stop, so its turn.started and prompt came first.
 */
const runSendWithStopAt = (homePath: string, injectAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    // The sentinel session's first event is enqueued after every event this
    // run produced, so collecting up to it yields the complete set.
    const eventsFiber = yield* Stream.takeUntil(
      adapter.streamEvents,
      (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
    ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });

    const scheduler = new InjectAtStep();
    scheduler.injectAt = injectAt;
    const stopGate = yield* Latch.make(false);
    const stopper = yield* stopGate.await.pipe(
      Effect.andThen(adapter.stopSession(THREAD_ID)),
      Effect.forkChild({ startImmediately: true }),
    );
    scheduler.inject = () => {
      Latch.openUnsafe(stopGate);
    };
    const send = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] })
      .pipe(Effect.result, stepInjected(scheduler), Effect.forkChild({ startImmediately: true }));
    const sent = yield* Fiber.join(send);
    const injected = Latch.isOpen(stopGate);
    if (injected) {
      yield* Fiber.join(stopper);
    } else {
      // Without an injection the turn is still open, so close it the way Stop would.
      yield* Fiber.interrupt(stopper);
      yield* adapter.stopSession(THREAD_ID);
    }

    yield* adapter.startSession({
      threadId: SWEEP_SENTINEL_THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
      (event) => event.threadId === THREAD_ID,
    );

    const { turnEvents, trace, violations } = turnPairing(events);
    if (injected !== Number.isFinite(injectAt)) {
      violations.push(`Stop injected: ${injected}`);
    }
    let outcome: "admitted" | "closed" | "not-found" | "other";
    if (sent._tag === "Success") {
      outcome = "admitted";
      const started = turnEvents.filter((event) => event.type === "turn.started");
      if (started.length !== 1 || started[0]?.turnId !== sent.success.turnId) {
        violations.push(
          `send returned ${sent.success.turnId} without exactly its own turn.started [${trace}]`,
        );
      }
    } else {
      outcome =
        sent.failure._tag === "ProviderAdapterSessionNotFoundError"
          ? "not-found"
          : sent.failure._tag === "ProviderAdapterSessionClosedError"
            ? "closed"
            : "other";
      if (outcome === "other") {
        violations.push(`send failed with unexpected ${sent.failure._tag}`);
      }
      if (turnEvents.length > 0) {
        violations.push(`send failed (${outcome}) but left turn events [${trace}]`);
      }
    }
    return { steps: scheduler.steps, outcome, violations } satisfies SweepRun;
  }).pipe(
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/** The text of the first block of a queued prompt. */
const promptTextOf = (message: SDKUserMessage) => {
  const content = message.message.content;
  if (typeof content === "string") return content;
  const block = content[0];
  return block?.type === "text" ? block.text : undefined;
};

/**
 * One send "first" with its caller interrupted before its `injectAt`th step,
 * then a second send "second" and the turn's result. The interrupted caller may
 * see an interrupt even though its prompt was published, so atomicity is read
 * from what was published, not from the first send's result: the prompt queue
 * and the turn events must show either the whole of "first" or none of it.
 */
const runSendInterruptedAt = (homePath: string, injectAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const eventsFiber = yield* Stream.takeUntil(
      adapter.streamEvents,
      (event) => event.type === "turn.completed",
    ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });

    // Not started immediately, so the handle exists before the first step.
    const scheduler = new InjectAtStep();
    scheduler.injectAt = injectAt;
    const first = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] })
      .pipe(stepInjected(scheduler), Effect.forkChild);
    scheduler.inject = () => first.interruptUnsafe();
    const firstExit = yield* Fiber.await(first);

    const second = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] })
      .pipe(Effect.result);
    if (second._tag === "Failure") {
      return {
        steps: scheduler.steps,
        outcome: "second-failed",
        violations: [`the send after the interrupted one failed with ${second.failure._tag}`],
      } satisfies SweepRun;
    }
    const secondTurnId = second.success.turnId;
    // The second send succeeded, so at least its own prompt is queued.
    const prompt = yield* Effect.promise(() =>
      readFirstPromptMessage(harness.getLastCreateQueryInput()),
    );
    emitClaudeResult(harness, "result-interrupt-sweep");
    const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
      (event) => event.threadId === THREAD_ID,
    );

    const { turnEvents, trace, violations } = turnPairing(events);
    const started = turnEvents.filter((event) => event.type === "turn.started");
    const completed = turnEvents.filter((event) => event.type === "turn.completed");
    const firstPublished = prompt !== undefined && promptTextOf(prompt) === "first";
    if (completed.length !== 1 || completed[0]?.turnId !== secondTurnId) {
      violations.push(`the result did not complete the second send's turn [${trace}]`);
    }
    if (firstPublished) {
      // "first" was published, so "second" must have steered into its turn.
      if (prompt.uuid === undefined) {
        violations.push("the published prompt for the first send carries no turn uuid");
      }
      if (String(secondTurnId) !== prompt.uuid) {
        violations.push(`the second send did not steer into ${prompt.uuid}: ${secondTurnId}`);
      }
      if (started.length !== 1 || String(started[0]?.turnId) !== prompt.uuid) {
        violations.push(`expected one turn.started for ${prompt.uuid} [${trace}]`);
      }
    } else {
      // Nothing of "first" was published, so "second" owns a fresh turn.
      if (prompt?.uuid !== String(secondTurnId)) {
        violations.push(
          `the first prompt is the second send's with uuid ${prompt?.uuid}, not its own turn ${secondTurnId}: it steered into a turn whose prompt was never sent`,
        );
      }
      if (started.length !== 1 || started[0]?.turnId !== secondTurnId) {
        violations.push(`expected a single turn.started for ${secondTurnId} [${trace}]`);
      }
    }
    if (firstExit._tag === "Success" && !firstPublished) {
      violations.push("the first send returned a turn but its prompt was never published");
    }
    return {
      steps: scheduler.steps,
      outcome: firstPublished ? "published" : "unpublished",
      violations,
    } satisfies SweepRun;
  }).pipe(
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * A clock that holds the one read picked by `arm` until `release`, so the
 * fiber stops at a known point of its own run. Only `currentTimeMillis` is
 * counted: `DateTime.now` reads it, so it sees every timestamp and event stamp
 * the adapter takes. `held` is a Promise: the waiting test resumes once the held
 * fiber has suspended, not inline inside that fiber's step.
 */
const makeParkingClock = (base: Clock.Clock) => {
  let gate = Latch.makeUnsafe(false);
  const state = { reads: 0, parkAt: Number.POSITIVE_INFINITY };
  let signalHeld = () => {};
  let held = Promise.resolve();
  const arm = (parkAt: number) => {
    state.reads = 0;
    state.parkAt = parkAt;
    gate = Latch.makeUnsafe(false);
    held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
  };
  arm(Number.POSITIVE_INFINITY);
  const read = Effect.suspend(() => {
    if (++state.reads !== state.parkAt) return base.currentTimeMillis;
    signalHeld();
    return gate.await.pipe(Effect.andThen(base.currentTimeMillis));
  });
  return {
    clock: { ...base, currentTimeMillis: read } satisfies Clock.Clock,
    /** Settles when the armed read is held. */
    get held() {
      return held;
    },
    arm,
    reads: () => state.reads,
    isHeld: () => Number.isFinite(state.parkAt) && state.reads >= state.parkAt,
    /** Resumes the held fiber inline, so its work up to its next suspension runs before this returns. */
    release: () => {
      Latch.openUnsafe(gate);
    },
    /** Releases the held read and arms the next in one step, so the resumed fiber already sees it. */
    rearm: (parkAt: number) => {
      const open = gate;
      arm(parkAt);
      Latch.openUnsafe(open);
    },
  };
};

/** Settles once the stream has handled everything emitted so far. Call it just before emitting. */
const untilStreamIdle = (query: FakeClaudeQuery) =>
  new Promise<void>((resolve) => {
    query.onIdle = () => {
      query.onIdle = undefined;
      resolve();
    };
  });

/** A result carries no session id, so the stream takes no clock read for it before `completeTurn`. */
/** The usage fixture of the result-completion usage test, and the thread usage it normalizes to. */
const RESULT_USAGE = {
  input_tokens: 4,
  cache_creation_input_tokens: 2715,
  cache_read_input_tokens: 21144,
  output_tokens: 679,
};
const RESULT_MODEL_USAGE = {
  [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: { contextWindow: 200000, maxOutputTokens: 64000 },
};
const RESULT_THREAD_USAGE = {
  usedTokens: 24542,
  lastUsedTokens: 24542,
  inputTokens: 23863,
  outputTokens: 679,
  maxTokens: 200000,
};
const RESULT_COST_USD = 0.0123;

/**
 * A failed result with usage, stop reason and cost: the stream emits
 * `runtime.error`, which reads the clock before `completeTurn` begins. It has
 * no session id, so nothing else the stream does for it reads the clock first.
 */
const emitFailedResult = (harness: ReturnType<typeof makeHarness>, uuid: string) =>
  harness.query.emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["synthetic failure"],
    stop_reason: "end_turn",
    total_cost_usd: RESULT_COST_USD,
    usage: RESULT_USAGE,
    modelUsage: RESULT_MODEL_USAGE,
    uuid,
  } as unknown as SDKMessage);

/** A successful result with the same usage, stop reason and cost, and no session id. */
const emitUsageResult = (harness: ReturnType<typeof makeHarness>, uuid: string) =>
  harness.query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    stop_reason: "end_turn",
    total_cost_usd: RESULT_COST_USD,
    usage: RESULT_USAGE,
    modelUsage: RESULT_MODEL_USAGE,
    uuid,
  } as unknown as SDKMessage);

const sameFields = (actual: unknown, expected: Readonly<Record<string, unknown>>) =>
  Predicate.isObject(actual) &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => Reflect.get(actual, key) === value);

const emitBareResult = (harness: ReturnType<typeof makeHarness>, uuid: string) =>
  harness.query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    uuid,
  } as unknown as SDKMessage);

/**
 * Forks the send "second" with its own parking clock. Its setup scans skill
 * directories, which is real I/O, so it reaches its first admission read only
 * once the caller suspends. `held` is false when the send ended before that.
 */
const forkSecondSendHeldAtAdmission = Effect.fnUntraced(function* (
  adapter: ClaudeAdapterShape,
  sendClock: ReturnType<typeof makeParkingClock>,
) {
  sendClock.arm(1);
  const fiber = yield* adapter
    .sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] })
    .pipe(
      Effect.result,
      Effect.provideService(Clock.Clock, sendClock.clock),
      Effect.forkChild({ startImmediately: true }),
    );
  const held = yield* Effect.raceFirst(
    Effect.promise(() => sendClock.held).pipe(Effect.as(true)),
    Fiber.await(fiber).pipe(Effect.as(false)),
  );
  return { fiber, held };
});

const decodeTurnStartMessageIds = Schema.decodeUnknownSync(
  Schema.Struct({ turnStartMessageIds: Schema.Array(Schema.NullOr(Schema.String)) }),
);

/**
 * Turn A completes while a second send B, whose setup is done, is held at
 * admission. `parkAt` picks where B's admission lands:
 * - 0: before A's result reaches the stream. A is still steerable.
 * - n >= 1: with the stream held at its nth clock read. The result has no
 *   session id, so every read the stream takes for it is inside `completeTurn`,
 *   between two of its steps. B's admission runs there, then the stream finishes.
 * - past the stream's last read: nothing is held and B is admitted afterwards.
 *
 * The completion-begun boundary is `completeTurn`'s entry. A send admitted
 * before it steers into A; one admitted after it starts its own turn once A
 * has settled. The first outside mark of completion is A showing in
 * `readThread().turns`, so every held read must show it, and what B's admission
 * did is read from the event trace, the queued prompt uuids, B's returned
 * turn and cursor, and the session left behind. Nothing is awaited by timeout:
 * a send still waiting once the stream is idle is reported and interrupted.
 */
const runSendDuringCompletion = (homePath: string, parkAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const streamClock = makeParkingClock(base);
  const sendClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const eventsFiber = yield* Stream.takeUntil(
      adapter.streamEvents,
      (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
    ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    // The stream fiber runs on the context startSession captures: it reads the parking clock.
    yield* adapter
      .startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      })
      .pipe(Effect.provideService(Clock.Clock, streamClock.clock));
    const turnA = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
    const staged = yield* forkSecondSendHeldAtAdmission(adapter, sendClock);
    if (!staged.held) {
      return {
        steps: 0,
        outcome: "failed",
        violations: ["the second send ended before it reached admission"],
      } satisfies SweepRun;
    }
    const second = staged.fiber;
    const idA = String(turnA.turnId);
    const violations: Array<string> = [];

    streamClock.arm(parkAt);
    if (parkAt === 0) {
      sendClock.release();
    }
    const firstIdle = untilStreamIdle(harness.query);
    emitBareResult(harness, "result-first");
    let window = "no read held";
    if (parkAt === 0) {
      yield* Effect.promise(() => firstIdle);
    } else {
      const reached = yield* Effect.promise(() =>
        Promise.race([
          streamClock.held.then(() => "held" as const),
          firstIdle.then(() => "idle" as const),
        ]),
      );
      if (reached === "held") {
        const heldSession = (yield* adapter.listSessions())[0];
        const thread = yield* adapter.readThread(THREAD_ID);
        const turnIds = thread.turns.map((turn) => String(turn.id));
        window = `held at read ${parkAt}: status ${heldSession?.status}, active ${heldSession?.activeTurnId}, turns [${turnIds}]`;
        if (!turnIds.includes(idA)) {
          violations.push(
            `read ${parkAt} is before A shows in readThread: not inside completeTurn`,
          );
        }
        sendClock.release();
        if (sendClock.reads() < 2) {
          violations.push("the second send did not run its admission while the stream was held");
        }
        streamClock.release();
        yield* Effect.promise(() => firstIdle);
      } else {
        if (Number.isFinite(parkAt)) {
          violations.push(
            `the stream took ${streamClock.reads()} reads, so read ${parkAt} never held`,
          );
        }
        sendClock.release();
      }
    }

    // Only A's completion is swept: the stream never holds for B's result.
    const completionReads = streamClock.reads();
    streamClock.arm(Number.POSITIVE_INFINITY);
    const exit = second.pollUnsafe();
    if (exit === undefined) {
      violations.push("the second send was still waiting once A had settled");
      yield* Fiber.interrupt(second);
    }
    const sent = exit?._tag === "Success" ? exit.value : undefined;
    if (sent?._tag !== "Success") {
      violations.push(
        `the second send did not return a turn: ${sent?._tag === "Failure" ? sent.failure._tag : "interrupted"}`,
      );
    }
    const turnB = sent?._tag === "Success" ? sent.success : undefined;
    const idB = turnB === undefined ? "(none)" : String(turnB.turnId);
    const steered = idB === idA;
    // Everything after this point is read back from what the adapter published.
    let settledSession = "no second turn";
    if (turnB !== undefined) {
      const settled = (yield* adapter.listSessions())[0];
      settledSession = `status ${settled?.status}, active ${settled?.activeTurnId}`;
      const startedIds = decodeTurnStartMessageIds(turnB.resumeCursor).turnStartMessageIds;
      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      if (parkAt === 0) {
        if (!steered) violations.push(`B admitted before the result did not steer into A: ${idB}`);
        const promptUuids = prompts.map((prompt) => prompt.uuid);
        if (promptUuids.join() !== [idA, undefined].join()) {
          violations.push(`prompts carry uuids [${promptUuids}], a steer carries none: [${idA},]`);
        }
        if (startedIds.join() !== idA) {
          violations.push(`a steer added a turn start to the cursor: [${startedIds}]`);
        }
      } else {
        if (steered) violations.push(`B steered into A, which had begun completing`);
        if (settled?.status !== "running" || settled.activeTurnId !== turnB.turnId) {
          violations.push(`the session does not show B running after A settled: ${settledSession}`);
        }
        const promptUuids = prompts.map((prompt) => prompt.uuid);
        if (promptUuids.length !== 2 || promptUuids[0] !== idA || promptUuids[1] !== idB) {
          violations.push(`prompts carry uuids [${promptUuids}], expected [${idA}, ${idB}]`);
        }
        if (startedIds.join() !== [idA, idB].join()) {
          violations.push(`B's resume cursor starts [${startedIds}], expected [${idA}, ${idB}]`);
        }
      }
      if (!steered) {
        const secondIdle = untilStreamIdle(harness.query);
        emitBareResult(harness, "result-second");
        yield* Effect.promise(() => secondIdle);
      }
    }

    yield* adapter.startSession({
      threadId: SWEEP_SENTINEL_THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
      (event) => event.threadId === THREAD_ID,
    );
    const { turnEvents, trace, violations: pairing } = turnPairing(events);
    violations.push(...pairing);
    // The trace pins order and exactly-once counts; turnPairing alone accepts a duplicate completion.
    const expectedTrace =
      parkAt === 0
        ? [`turn.started(${idA})`, `turn.completed(${idA})`]
        : [
            `turn.started(${idA})`,
            `turn.completed(${idA})`,
            `turn.started(${idB})`,
            `turn.completed(${idB})`,
          ];
    const actualTrace = turnEvents.map((event) => `${event.type}(${event.turnId})`);
    if (actualTrace.join(" ") !== expectedTrace.join(" ")) {
      violations.push(`turn events are [${trace}], expected [${expectedTrace.join(" ")}]`);
    }
    const completedA = turnEvents.find(
      (event) => event.type === "turn.completed" && String(event.turnId) === idA,
    );
    const startedB = turnEvents.find(
      (event) => event.type === "turn.started" && String(event.turnId) === idB,
    );
    if (!steered && completedA && startedB && completedA.createdAt >= startedB.createdAt) {
      violations.push(
        `B started at ${startedB.createdAt}, not after A completed at ${completedA.createdAt}`,
      );
    }
    return {
      steps: completionReads,
      outcome: turnB === undefined ? "failed" : steered ? "steered" : "started",
      violations: violations.map((violation) => `${violation} (${window}; ${settledSession})`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        streamClock.release();
        sendClock.release();
      }),
    ),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * A stale synthetic turn S is open when a send B starts closing it, and B's
 * caller is interrupted while B is held at its `interruptAt`th clock read: at
 * the pass's stamps, or between `completeTurn`'s steps. A third send C follows,
 * then the result for whatever turn is open. S must end up closed exactly once,
 * with one entry in the thread, whenever B was cut off, and B's prompt must be
 * queued exactly when B returned.
 */
const runSyntheticCloseInterruptedAt = (homePath: string, interruptAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const sendClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const eventsFiber = yield* Stream.takeUntil(
      adapter.streamEvents,
      (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
    ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    const turnA = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
    const firstIdle = untilStreamIdle(harness.query);
    emitBareResult(harness, "result-first");
    yield* Effect.promise(() => firstIdle);

    // A background agent answering between prompts auto-starts a synthetic turn.
    const backgroundIdle = untilStreamIdle(harness.query);
    harness.query.emit({
      type: "assistant",
      session_id: CLAUDE_ORIGINAL_SESSION_ID,
      uuid: "assistant-background",
      parent_tool_use_id: null,
      message: {
        id: "assistant-message-background",
        content: [{ type: "text", text: "Background update" }],
      },
    } as unknown as SDKMessage);
    yield* Effect.promise(() => backgroundIdle);

    sendClock.arm(interruptAt);
    const second = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] })
      .pipe(
        Effect.provideService(Clock.Clock, sendClock.clock),
        Effect.forkChild({ startImmediately: true }),
      );
    const held = yield* Effect.raceFirst(
      Effect.promise(() => sendClock.held).pipe(Effect.as(true)),
      Fiber.await(second).pipe(Effect.as(false)),
    );
    if (held) {
      second.interruptUnsafe();
      sendClock.release();
    }
    const secondExit = yield* Fiber.await(second);
    const secondTurn = secondExit._tag === "Success" ? secondExit.value : undefined;

    const violations: Array<string> = [];
    if (Number.isFinite(interruptAt) !== held) {
      violations.push(
        `held: ${held}, but interruptAt is ${interruptAt} of ${sendClock.reads()} reads`,
      );
    }
    if (Number.isFinite(interruptAt) && secondTurn !== undefined) {
      violations.push("the interrupted send still returned a turn");
    }
    if (!Number.isFinite(interruptAt) && secondTurn === undefined) {
      violations.push("the uninterrupted send did not return a turn");
    }

    const turnC = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "third", attachments: [] });
    const idA = String(turnA.turnId);
    const idC = String(turnC.turnId);
    // A returned send queues its prompt; one cut off before admission queues none.
    const prompts = yield* Effect.promise(() =>
      readPromptMessages(harness.getLastCreateQueryInput(), secondTurn === undefined ? 2 : 3),
    );
    const idOpen = secondTurn === undefined ? idC : String(secondTurn.turnId);
    const expectedUuids = secondTurn === undefined ? [idA, idC] : [idA, idOpen, undefined];
    if (prompts.map((prompt) => prompt.uuid).join() !== expectedUuids.join()) {
      violations.push(
        `prompts carry uuids [${prompts.map((prompt) => prompt.uuid)}], expected [${expectedUuids}]`,
      );
    }
    const lastIdle = untilStreamIdle(harness.query);
    emitBareResult(harness, "result-open-turn");
    yield* Effect.promise(() => lastIdle);
    const thread = yield* adapter.readThread(THREAD_ID);
    const threadTurnIds = thread.turns.map((turn) => String(turn.id));

    yield* adapter.startSession({
      threadId: SWEEP_SENTINEL_THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    const events = Array.from(yield* Fiber.join(eventsFiber)).filter(
      (event) => event.threadId === THREAD_ID,
    );
    const { turnEvents, trace, violations: pairing } = turnPairing(events);
    violations.push(...pairing);
    const idS = String(
      turnEvents.filter((event) => event.type === "turn.started")[1]?.turnId ?? "(none)",
    );
    const expectedTrace = [
      `turn.started(${idA})`,
      `turn.completed(${idA})`,
      `turn.started(${idS})`,
      `turn.completed(${idS})`,
      `turn.started(${idOpen})`,
      `turn.completed(${idOpen})`,
    ];
    if (
      turnEvents.map((event) => `${event.type}(${event.turnId})`).join(" ") !==
      expectedTrace.join(" ")
    ) {
      violations.push(`turn events are [${trace}], expected [${expectedTrace.join(" ")}]`);
    }
    if (threadTurnIds.join() !== [idA, idS, idOpen].join()) {
      violations.push(`readThread turns are [${threadTurnIds}], expected [${[idA, idS, idOpen]}]`);
    }
    const completedS = turnEvents.find(
      (event) => event.type === "turn.completed" && String(event.turnId) === idS,
    );
    const startedOpen = turnEvents.find(
      (event) => event.type === "turn.started" && String(event.turnId) === idOpen,
    );
    if (completedS && startedOpen && completedS.createdAt >= startedOpen.createdAt) {
      violations.push(
        `S completed at ${completedS.createdAt}, not before the next turn started at ${startedOpen.createdAt}`,
      );
    }
    return {
      steps: sendClock.reads(),
      outcome: secondTurn === undefined ? "unpublished" : "published",
      violations,
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(Effect.sync(() => sendClock.release())),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * A completed first turn A, a stale synthetic turn S, and the send "second"
 * held at its `holdAt`th clock read: in its first pass (reads 1-2), while it
 * closes S (the reads of `completeTurn`), or in its second pass. A send that
 * ends before the hold is reported as `held: false`.
 */
const stageSendHeldOverStaleSynthetic = Effect.fnUntraced(function* (
  harness: ReturnType<typeof makeHarness>,
  clocks: {
    readonly stream: ReturnType<typeof makeParkingClock>;
    readonly send: ReturnType<typeof makeParkingClock>;
  },
  holdAt: number,
  withSynthetic = true,
) {
  const adapter = yield* ClaudeAdapter;
  const eventsFiber = yield* Stream.takeUntil(
    adapter.streamEvents,
    (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
  ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
  // The stream fiber runs on the context startSession captures: it reads the stream clock.
  yield* adapter
    .startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    })
    .pipe(Effect.provideService(Clock.Clock, clocks.stream.clock));
  const turnA = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
  const firstIdle = untilStreamIdle(harness.query);
  emitBareResult(harness, "result-first");
  yield* Effect.promise(() => firstIdle);
  if (withSynthetic) {
    const backgroundIdle = untilStreamIdle(harness.query);
    harness.query.emit({
      type: "assistant",
      session_id: CLAUDE_ORIGINAL_SESSION_ID,
      uuid: "assistant-background",
      parent_tool_use_id: null,
      message: {
        id: "assistant-message-background",
        content: [{ type: "text", text: "Background update" }],
      },
    } as unknown as SDKMessage);
    yield* Effect.promise(() => backgroundIdle);
  }

  clocks.send.arm(holdAt);
  const second = yield* adapter
    .sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] })
    .pipe(
      Effect.result,
      Effect.provideService(Clock.Clock, clocks.send.clock),
      Effect.forkChild({ startImmediately: true }),
    );
  const held = yield* Effect.raceFirst(
    Effect.promise(() => clocks.send.held).pipe(Effect.as(true)),
    Fiber.await(second).pipe(Effect.as(false)),
  );
  return { adapter, eventsFiber, turnA, second, held };
});

/** Starts the sentinel session, whose first event follows everything this run produced, and returns the thread's events. */
const collectThreadEvents = Effect.fnUntraced(function* (
  adapter: ClaudeAdapterShape,
  eventsFiber: Fiber.Fiber<ReadonlyArray<ProviderRuntimeEvent>>,
) {
  yield* adapter.startSession({
    threadId: SWEEP_SENTINEL_THREAD_ID,
    provider: ProviderDriverKind.make("claudeAgent"),
    runtimeMode: "full-access",
  });
  return Array.from(yield* Fiber.join(eventsFiber)).filter((event) => event.threadId === THREAD_ID);
});

/** The turn lifecycle and the session exit in order: `turn.started(id)`, `turn.completed(id)`, `session.exited`. */
const lifecycleTrace = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "turn.started" || event.type === "turn.completed"
      ? [`${event.type}(${event.turnId})`]
      : event.type === "session.exited"
        ? ["session.exited"]
        : [],
  );

/** After Stop: nothing appears twice, each turn in `completedOnce` completed, and the exit is the single last event. */
const stoppedTraceViolations = (
  trace: ReadonlyArray<string>,
  completedOnce: ReadonlyArray<string>,
) => [
  ...trace
    .filter((entry, index) => trace.indexOf(entry) !== index)
    .map((entry) => `${entry} appears more than once`),
  ...completedOnce
    .filter((id) => !trace.includes(`turn.completed(${id})`))
    .map((id) => `turn.completed(${id}) is missing`),
  ...(trace.at(-1) === "session.exited" ? [] : ["session.exited is not the last event"]),
];

/**
 * A stale synthetic turn S is being closed by the send "second", which is held
 * at its `holdAt`th read (before, inside or after `completeTurn`) when the SDK's
 * failed result for S reaches the stream. S must complete exactly once whichever
 * of the two completes it, `readThread` must list it once, and the send must
 * start its own turn B, which the stream's stale result must not end.
 *
 * A failed result makes the stream read the clock for `runtime.error` before
 * `completeTurn` begins, and that read is the barrier: the send is held, the
 * stream is held, and then one of two orderings is chosen. With `staleLast` the
 * stream's resumed completion is held at its first read, the send is released
 * and finishes (when it owns the close it admits B), and only then does the
 * stream resume. Otherwise the stream's completion runs on while the send is
 * still held. Gates are opened before anything is joined, so a send or
 * completion that waits on the other is released, not deadlocked. What B was
 * before the stale completion resumed is reported but not asserted: a send that
 * waits on the stream's completion is not live yet.
 */
const runStreamResultDuringSyntheticClose = (
  homePath: string,
  holdAt: number,
  staleLast: boolean,
) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const streamClock = makeParkingClock(base);
  const sendClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const { adapter, eventsFiber, turnA, second, held } = yield* stageSendHeldOverStaleSynthetic(
      harness,
      { stream: streamClock, send: sendClock },
      holdAt,
    );
    const violations: Array<string> = [];
    if (Number.isFinite(holdAt) !== held) {
      violations.push(`held: ${held}, but holdAt is ${holdAt}`);
    }
    let window = "send not held";
    let activeAtBarrier = "";
    if (held) {
      streamClock.arm(1);
      const resultIdle = untilStreamIdle(harness.query);
      emitFailedResult(harness, "result-synthetic");
      const reached = yield* Effect.promise(() =>
        Promise.race([
          streamClock.held.then(() => "held" as const),
          resultIdle.then(() => "idle" as const),
        ]),
      );
      if (reached !== "held") {
        violations.push("the stream did not hold at runtime.error before completeTurn");
      }
      // The result reaches completeTurn with S still live and unpublished exactly when S is the active turn here.
      activeAtBarrier = String((yield* adapter.listSessions())[0]?.activeTurnId);
      streamClock.rearm(staleLast ? 1 : Number.POSITIVE_INFINITY);
      const streamInFinish = streamClock.isHeld();
      sendClock.release();
      const live = (yield* adapter.listSessions())[0];
      window = `stream held in its own completion: ${streamInFinish}; before the stale completion resumed: send ${second.pollUnsafe() === undefined ? "waiting" : "done"}, session ${live?.status} active ${live?.activeTurnId}`;
      if (streamClock.isHeld()) {
        streamClock.release();
      }
      yield* Effect.promise(() => resultIdle);
      // A hold armed for the stale completion must not catch the stream's next completion.
      streamClock.arm(Number.POSITIVE_INFINITY);
    }
    const sent = yield* Fiber.await(second);
    const result = sent._tag === "Success" ? sent.value : undefined;
    if (result?._tag !== "Success") {
      violations.push(`the send did not return a turn: ${result?._tag ?? "interrupted"}`);
      return { steps: sendClock.reads(), outcome: "failed", violations } satisfies SweepRun;
    }
    const turnB = result.success;
    const queryInput = harness.getLastCreateQueryInput();
    const prompts = yield* Effect.promise(() => readPromptMessages(queryInput, 2));
    const lastIdle = untilStreamIdle(harness.query);
    emitBareResult(harness, "result-second");
    yield* Effect.promise(() => lastIdle);
    const thread = yield* adapter.readThread(THREAD_ID);
    const settled = (yield* adapter.listSessions())[0];
    const events = yield* collectThreadEvents(adapter, eventsFiber);

    const { turnEvents, trace, violations: pairing } = turnPairing(events);
    violations.push(...pairing);
    const runtimeErrors = events.filter((event) => event.type === "runtime.error").length;
    if (runtimeErrors !== (held ? 1 : 0)) {
      violations.push(`${runtimeErrors} runtime.error events for the failed result`);
    }
    const idA = String(turnA.turnId);
    const idB = String(turnB.turnId);
    const idS = String(turnEvents.filter((event) => event.type === "turn.started")[1]?.turnId);
    const expected = [
      `turn.started(${idA})`,
      `turn.completed(${idA})`,
      `turn.started(${idS})`,
      `turn.completed(${idS})`,
      `turn.started(${idB})`,
      `turn.completed(${idB})`,
    ];
    if (
      turnEvents.map((event) => `${event.type}(${event.turnId})`).join(" ") !== expected.join(" ")
    ) {
      violations.push(`turn events are [${trace}], expected [${expected.join(" ")}]`);
    }
    const threadTurnIds = thread.turns.map((turn) => String(turn.id));
    if (threadTurnIds.join() !== [idA, idS, idB].join()) {
      violations.push(`readThread turns are [${threadTurnIds}], expected [${[idA, idS, idB]}]`);
    }
    if (held) {
      // The result's own thread usage is reported once. B's later result re-reports the last
      // known usage, so the event is picked out by the raw result it came from.
      const resultUsageEvents = events.flatMap((event) => {
        const rawPayload = event.raw?.payload;
        return event.type === "thread.token-usage.updated" &&
          Predicate.hasProperty(rawPayload, "uuid") &&
          rawPayload.uuid === "result-synthetic"
          ? [event]
          : [];
      });
      const usageEvent = resultUsageEvents[0];
      const completedSEvent = events.find(
        (event) => event.type === "turn.completed" && String(event.turnId) === idS,
      );
      if (resultUsageEvents.length !== 1 || usageEvent === undefined) {
        violations.push(`${resultUsageEvents.length} thread usage events for the result of S`);
      } else {
        if (!sameFields(usageEvent.payload.usage, RESULT_THREAD_USAGE)) {
          violations.push(
            `the result's thread usage is ${NodeUtil.inspect(usageEvent.payload.usage)}`,
          );
        }
        if (usageEvent.turnId !== undefined && String(usageEvent.turnId) !== idS) {
          violations.push(`the result's thread usage is attributed to ${usageEvent.turnId}, not S`);
        }
        if (
          usageEvent.turnId === undefined &&
          completedSEvent !== undefined &&
          usageEvent.createdAt <= completedSEvent.createdAt
        ) {
          violations.push(
            `the untargeted thread usage at ${usageEvent.createdAt} is not after completed(S) at ${completedSEvent.createdAt}`,
          );
        }
      }
      // A result that reached completeTurn while S was unpublished rides on the one turn.completed(S),
      // whichever fiber owns it. One that arrived after publication is only usage, as before.
      if (activeAtBarrier === idS) {
        const payload =
          completedSEvent?.type === "turn.completed" ? completedSEvent.payload : undefined;
        if (!NodeUtil.isDeepStrictEqual(payload?.usage, RESULT_USAGE)) {
          violations.push(`completed(S) carries usage ${NodeUtil.inspect(payload?.usage)}`);
        }
        if (payload?.stopReason !== "end_turn" || payload.totalCostUsd !== RESULT_COST_USD) {
          violations.push(
            `completed(S) carries stop reason ${payload?.stopReason} and cost ${payload?.totalCostUsd}`,
          );
        }
        if (!NodeUtil.isDeepStrictEqual(payload?.modelUsage, RESULT_MODEL_USAGE)) {
          violations.push(
            `completed(S) carries model usage ${NodeUtil.inspect(payload?.modelUsage)}`,
          );
        }
        // The state is the owner's: the stream's own failed result, or the send's "completed".
        if (payload?.state !== "completed" && payload?.state !== "failed") {
          violations.push(`completed(S) has state ${payload?.state}`);
        }
      }
    }
    const startedIds = decodeTurnStartMessageIds(settled?.resumeCursor).turnStartMessageIds;
    if (startedIds.join() !== [idA, "assistant-background", idB].join()) {
      violations.push(
        `the resume cursor starts [${startedIds}], expected [${idA}, assistant-background, ${idB}]`,
      );
    }
    if (settled?.status !== "ready" || settled.activeTurnId !== undefined) {
      violations.push(
        `the session is ${settled?.status} with active ${settled?.activeTurnId} after B completed`,
      );
    }
    if (prompts.map((prompt) => prompt.uuid).join() !== [idA, idB].join()) {
      violations.push(
        `prompts carry uuids [${prompts.map((prompt) => prompt.uuid)}], expected [${idA}, ${idB}]`,
      );
    }
    return {
      steps: sendClock.reads(),
      outcome: held ? "raced" : "uncontested",
      violations: violations.map((violation) => `${violation} (${window})`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        streamClock.release();
        sendClock.release();
      }),
    ),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * Stop lands while the stream is held at its `holdAt`th read inside
 * `completeTurn`, and the hold stays until Stop has returned: a Stop that
 * waited for the held stream would never return, so this also checks Stop's
 * liveness. Turn A must complete exactly once, before the session exits, and
 * that one completion carries the usage, model usage, stop reason and cost of
 * the result the stream was completing it with, whether the stream or Stop
 * (with its own state, and no result of its own) publishes it.
 */
const runStopDuringStreamCompletion = (homePath: string, holdAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const streamClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const eventsFiber = yield* Stream.takeUntil(
      adapter.streamEvents,
      (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
    ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
    yield* adapter
      .startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      })
      .pipe(Effect.provideService(Clock.Clock, streamClock.clock));
    const turnA = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });

    streamClock.arm(holdAt);
    const resultIdle = untilStreamIdle(harness.query);
    emitUsageResult(harness, "result-first");
    const reached = yield* Effect.promise(() =>
      Promise.race([
        streamClock.held.then(() => "held" as const),
        resultIdle.then(() => "idle" as const),
      ]),
    );
    const violations: Array<string> = [];
    if (Number.isFinite(holdAt) !== (reached === "held")) {
      violations.push(`the stream ${reached} at holdAt ${holdAt} of ${streamClock.reads()} reads`);
    }
    const completionReads = streamClock.reads();
    const stopped = yield* adapter.stopSession(THREAD_ID).pipe(Effect.result);
    if (stopped._tag !== "Success") {
      violations.push("Stop failed");
    }
    const events = yield* collectThreadEvents(adapter, eventsFiber);
    const trace = lifecycleTrace(events);
    violations.push(...stoppedTraceViolations(trace, [String(turnA.turnId)]));
    const completedEvent = events.find(
      (event) => event.type === "turn.completed" && String(event.turnId) === String(turnA.turnId),
    );
    const payload = completedEvent?.type === "turn.completed" ? completedEvent.payload : undefined;
    if (!NodeUtil.isDeepStrictEqual(payload?.usage, RESULT_USAGE)) {
      violations.push(
        `completed(A, ${payload?.state}) carries usage ${NodeUtil.inspect(payload?.usage)}`,
      );
    }
    if (payload?.stopReason !== "end_turn" || payload.totalCostUsd !== RESULT_COST_USD) {
      violations.push(
        `completed(A, ${payload?.state}) carries stop reason ${payload?.stopReason} and cost ${payload?.totalCostUsd}`,
      );
    }
    if (!NodeUtil.isDeepStrictEqual(payload?.modelUsage, RESULT_MODEL_USAGE)) {
      violations.push(
        `completed(A, ${payload?.state}) carries model usage ${NodeUtil.inspect(payload?.modelUsage)}`,
      );
    }
    return {
      steps: completionReads,
      outcome: reached,
      violations: violations.map((violation) => `${violation} [${trace}]`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(Effect.sync(() => streamClock.release())),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * The caller of the send "second" is cancelled while it is held at its
 * `holdAt`th read, which for the reads of `completeTurn` is inside its
 * uninterruptible close of the stale synthetic turn S, then Stop is forked. S
 * must complete exactly once, nothing may follow `session.exited`, and the
 * cancelled send must not return a turn. Whether Stop was still waiting for the
 * held close when the send was released is reported in the outcome.
 */
const runStopDuringSyntheticClose = (homePath: string, holdAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const sendClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const { adapter, eventsFiber, turnA, second, held } = yield* stageSendHeldOverStaleSynthetic(
      harness,
      { stream: makeParkingClock(base), send: sendClock },
      holdAt,
    );
    const violations: Array<string> = [];
    if (Number.isFinite(holdAt) !== held) {
      violations.push(`held: ${held}, but holdAt is ${holdAt}`);
    }
    if (held) {
      second.interruptUnsafe();
    }
    const stop = yield* adapter
      .stopSession(THREAD_ID)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const stopWaiting = stop.pollUnsafe() === undefined;
    sendClock.release();
    const stopExit = yield* Fiber.await(stop);
    if (stopExit._tag !== "Success") {
      violations.push("Stop did not complete");
    }
    const sent = yield* Fiber.await(second);
    const result = sent._tag === "Success" ? sent.value : undefined;
    const sendOutcome =
      result?._tag === "Success"
        ? "returned"
        : result?._tag === "Failure"
          ? result.failure._tag
          : "interrupted";
    if (held ? sendOutcome === "returned" : sendOutcome !== "returned") {
      violations.push(
        `the send ${held ? "was cancelled and" : "was not cancelled and"} ended with ${sendOutcome}`,
      );
    }
    const events = yield* collectThreadEvents(adapter, eventsFiber);
    const trace = lifecycleTrace(events);
    const startedIds = events.flatMap((event) =>
      event.type === "turn.started" ? [String(event.turnId)] : [],
    );
    const [idA, idS] = [String(turnA.turnId), startedIds[1] ?? ""];
    violations.push(...stoppedTraceViolations(trace, [idA, idS]));
    if (startedIds.length !== (result?._tag === "Success" ? 3 : 2)) {
      violations.push(`the send ${sendOutcome} but turns started are [${startedIds}]`);
    }
    return {
      steps: sendClock.reads(),
      outcome: `${sendOutcome}${stopWaiting ? "+stop-waited" : ""}`,
      violations: violations.map((violation) => `${violation} [${trace}]`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(Effect.sync(() => sendClock.release())),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * The caller of the send closing S is cancelled while the close is held at its
 * last read (inside `updateResumeCursor`, after S is cleared), then Stop runs
 * with its own clock held at its `stopHoldAt`th read. Whatever the stale close
 * finishes once released, a session Stop has closed must still read closed, and
 * S must complete exactly once before the session exits.
 */
const STALE_CLOSE_LAST_READ = 5;
const runStaleCloseFinishingAfterStop = (homePath: string, stopHoldAt: number) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const sendClock = makeParkingClock(base);
  const stopClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const { adapter, eventsFiber, turnA, second, held } = yield* stageSendHeldOverStaleSynthetic(
      harness,
      { stream: makeParkingClock(base), send: sendClock },
      STALE_CLOSE_LAST_READ,
    );
    const violations: Array<string> = [];
    if (!held) {
      violations.push(`the send was not held at its read ${STALE_CLOSE_LAST_READ}`);
    }
    // The caller is cancelled, but its close is uninterruptible: it stays held.
    second.interruptUnsafe();
    stopClock.arm(stopHoldAt);
    const stop = yield* adapter
      .stopSession(THREAD_ID)
      .pipe(
        Effect.provideService(Clock.Clock, stopClock.clock),
        Effect.forkChild({ startImmediately: true }),
      );
    let atRelease = "Stop not held";
    if (Number.isFinite(stopHoldAt) !== stopClock.isHeld()) {
      violations.push(`Stop held: ${stopClock.isHeld()}, but stopHoldAt is ${stopHoldAt}`);
    }
    if (stopClock.isHeld()) {
      // Stop is held before or after it wrote closed: release the stale close now.
      sendClock.release();
      const listed = (yield* adapter.listSessions())[0];
      atRelease = `Stop held at read ${stopHoldAt}, listed ${listed?.status}`;
      if (stopHoldAt >= 2 && listed?.status !== "closed") {
        violations.push(`the stale close left a stopped session ${listed?.status}`);
      }
    }
    sendClock.release();
    stopClock.release();
    const stopExit = yield* Fiber.await(stop);
    if (stopExit._tag !== "Success") {
      violations.push("Stop did not complete");
    }
    const sent = yield* Fiber.await(second);
    if (sent._tag === "Success" && sent.value._tag === "Success") {
      violations.push("the cancelled send returned a turn");
    }
    const events = yield* collectThreadEvents(adapter, eventsFiber);
    const trace = lifecycleTrace(events);
    const idS = String(events.filter((event) => event.type === "turn.started")[1]?.turnId);
    violations.push(...stoppedTraceViolations(trace, [String(turnA.turnId), idS]));
    return {
      steps: stopClock.reads(),
      outcome: atRelease,
      violations: violations.map((violation) => `${violation} [${trace}]`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        sendClock.release();
        stopClock.release();
      }),
    ),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

/**
 * A failed SDK result is held at its `runtime.error` clock read, which is
 * before `completeTurn` begins and after the stream read the live turn: that
 * turn is S (a stale synthetic turn, still live or not) or none. While it is
 * held the send "second" is released and runs to the end, so a new turn B is
 * live when the stream resumes. The result belongs to what the stream saw, so
 * it must not end B: B stays running, its own result later completes it
 * exactly once with its own state, and the failed result's `runtime.error`,
 * thread usage and error are not attributed to B. With `withSynthetic` false
 * the stream saw no turn at all.
 */
const runFailedResultBeforeClaim = (homePath: string, holdAt: number, withSynthetic: boolean) => {
  const harness = makeHarness({ claudeConfig: { homePath } });
  const base = makeTickingClock();
  const streamClock = makeParkingClock(base);
  const sendClock = makeParkingClock(base);
  return Effect.gen(function* () {
    const { adapter, eventsFiber, turnA, second, held } = yield* stageSendHeldOverStaleSynthetic(
      harness,
      { stream: streamClock, send: sendClock },
      holdAt,
      withSynthetic,
    );
    const violations: Array<string> = [];
    if (Number.isFinite(holdAt) !== held) {
      violations.push(`held: ${held}, but holdAt is ${holdAt}`);
    }
    let window = "send not held";
    if (held) {
      streamClock.arm(1);
      const resultIdle = untilStreamIdle(harness.query);
      emitFailedResult(harness, "result-late");
      const reached = yield* Effect.promise(() =>
        Promise.race([
          streamClock.held.then(() => "held" as const),
          resultIdle.then(() => "idle" as const),
        ]),
      );
      if (reached !== "held") {
        violations.push("the stream did not hold at runtime.error before completeTurn");
      }
      const seen = (yield* adapter.listSessions())[0];
      sendClock.release();
      const live = (yield* adapter.listSessions())[0];
      const sendDone = second.pollUnsafe() !== undefined;
      window = `stream saw active ${seen?.activeTurnId}; before it resumed: send ${sendDone ? "done" : "waiting"}, session ${live?.status} active ${live?.activeTurnId}`;
      if (!sendDone || live?.status !== "running" || live.activeTurnId === seen?.activeTurnId) {
        violations.push("the send did not start a new turn while the stream was held");
      }
      streamClock.rearm(Number.POSITIVE_INFINITY);
      yield* Effect.promise(() => resultIdle);
      const resumed = (yield* adapter.listSessions())[0];
      if (resumed?.status !== "running" || resumed.activeTurnId !== live?.activeTurnId) {
        violations.push(
          `the failed result ended the new turn: session ${resumed?.status} active ${resumed?.activeTurnId}, lastError ${resumed?.lastError}`,
        );
      }
    }
    const sent = yield* Fiber.await(second);
    const result = sent._tag === "Success" ? sent.value : undefined;
    if (result?._tag !== "Success") {
      violations.push(`the send did not return a turn: ${result?._tag ?? "interrupted"}`);
      return { steps: sendClock.reads(), outcome: "failed", violations } satisfies SweepRun;
    }
    const idA = String(turnA.turnId);
    const idB = String(result.success.turnId);
    const lastIdle = untilStreamIdle(harness.query);
    emitBareResult(harness, "result-second");
    yield* Effect.promise(() => lastIdle);
    const thread = yield* adapter.readThread(THREAD_ID);
    const settled = (yield* adapter.listSessions())[0];
    const events = yield* collectThreadEvents(adapter, eventsFiber);

    const { turnEvents, trace, violations: pairing } = turnPairing(events);
    violations.push(...pairing);
    const startedIds = turnEvents.flatMap((event) =>
      event.type === "turn.started" ? [String(event.turnId)] : [],
    );
    const idS = withSynthetic ? (startedIds[1] ?? "") : undefined;
    const expectedIds = idS === undefined ? [idA, idB] : [idA, idS, idB];
    const expected = expectedIds.flatMap((id) => [`turn.started(${id})`, `turn.completed(${id})`]);
    if (
      turnEvents.map((event) => `${event.type}(${event.turnId})`).join(" ") !== expected.join(" ")
    ) {
      violations.push(`turn events are [${trace}], expected [${expected.join(" ")}]`);
    }
    const completedB = events.find(
      (event) => event.type === "turn.completed" && String(event.turnId) === idB,
    );
    if (completedB?.type === "turn.completed") {
      const { state, errorMessage } = completedB.payload;
      if (state !== "completed" || errorMessage !== undefined) {
        violations.push(`completed(B) has state ${state} and error ${errorMessage}`);
      }
    }
    const threadTurnIds = thread.turns.map((turn) => String(turn.id));
    if (threadTurnIds.join() !== expectedIds.join()) {
      violations.push(`readThread turns are [${threadTurnIds}], expected [${expectedIds}]`);
    }
    if (settled?.lastError !== undefined) {
      violations.push(`the session carries the failed result's error: ${settled.lastError}`);
    }
    // The failed result is reported once, and not as anything of B's.
    const runtimeErrors = events.flatMap((event) =>
      event.type === "runtime.error" ? [event] : [],
    );
    if (runtimeErrors.length !== (held ? 1 : 0)) {
      violations.push(`${runtimeErrors.length} runtime.error events`);
    }
    if (runtimeErrors.some((event) => String(event.turnId) === idB)) {
      violations.push("runtime.error is attributed to B");
    }
    const resultUsageEvents = events.flatMap((event) => {
      const rawPayload = event.raw?.payload;
      return event.type === "thread.token-usage.updated" &&
        Predicate.hasProperty(rawPayload, "uuid") &&
        rawPayload.uuid === "result-late"
        ? [event]
        : [];
    });
    if (resultUsageEvents.length !== (held ? 1 : 0)) {
      violations.push(`${resultUsageEvents.length} thread usage events for the failed result`);
    }
    for (const usageEvent of resultUsageEvents) {
      if (!sameFields(usageEvent.payload.usage, RESULT_THREAD_USAGE)) {
        violations.push(
          `the result's thread usage is ${NodeUtil.inspect(usageEvent.payload.usage)}`,
        );
      }
      if (String(usageEvent.turnId) === idB) {
        violations.push("the result's thread usage is attributed to B");
      }
    }
    return {
      steps: sendClock.reads(),
      outcome: held ? "raced" : "uncontested",
      violations: violations.map((violation) => `${violation} (${window})`),
    } satisfies SweepRun;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        streamClock.release();
        sendClock.release();
      }),
    ),
    Effect.provideService(Clock.Clock, base),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retains Claude session startup causes without exposing their messages", () => {
    const cause = new Error("credential material that must remain in the cause chain");
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            throw cause;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const error = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.equal(error.detail, "Failed to start Claude runtime session.");
      assert.strictEqual(error.cause, cause);
      assert.notMatch(error.message, /credential material/u);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.deepEqual(createInput?.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: buildRuntimeInstructions({ harness: "Claude Code" }),
      });
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives auto permission mode from auto runtime policy without skip flag", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets a launch-arg permission flag win over the thread runtime mode", () => {
    const harness = makeHarness({
      claudeConfig: { launchArgs: "--dangerously-skip-permissions --verbose" },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto-accept-edits",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
      // The honored flag is dropped from extraArgs so the CLI sees it once.
      assert.deepEqual(createInput?.options.extraArgs, {
        verbose: null,
        "thinking-display": "summarized",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the configured auto-compaction window to Claude", () => {
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "300000" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.settings, {
        showThinkingSummaries: true,
        autoCompactWindow: 300000,
      });
      assert.deepEqual(options?.supportedDialogKinds, ["resume_return"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured CLAUDE_CONFIG_DIR", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(
        createInput?.options.env?.CLAUDE_CONFIG_DIR,
        NodePath.join(NodeOS.homedir(), ".claude-work"),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle for models that support it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_THINKING_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
      assert.equal(createInput?.options.thinking, undefined);
      assert.equal(createInput?.options.extraArgs?.["thinking-display"], undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("requests Claude thinking summaries unless thinking is off", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_THINKING_MODEL,
          [{ id: "thinking", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: true,
        showThinkingSummaries: true,
      });
      assert.deepEqual(createInput?.options.thinking, {
        type: "adaptive",
        display: "summarized",
      });
      assert.equal(createInput?.options.extraArgs?.["thinking-display"], "summarized");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("honors a launch-arg that omits Claude thinking display", () => {
    const harness = makeHarness({
      claudeConfig: { launchArgs: "--thinking-display omitted" },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
      assert.equal(createInput?.options.thinking, undefined);
      assert.equal(createInput?.options.extraArgs?.["thinking-display"], "omitted");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        showThinkingSummaries: true,
      });
      assert.deepEqual(createInput?.options.thinking, {
        type: "adaptive",
        display: "summarized",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        showThinkingSummaries: true,
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        showThinkingSummaries: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keeps a configured custom alias opaque without disabling the canonical built-in",
    () => {
      const claudeConfig = { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] };
      const customHarness = makeHarness({ claudeConfig });
      const builtInHarness = makeHarness({ claudeConfig });
      const start = (harness: ReturnType<typeof makeHarness>, model: string) =>
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model, [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ]),
            runtimeMode: "full-access",
          });
          return harness.getLastCreateQueryInput()!.options;
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      const runCustomFlow = Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ],
          ),
          runtimeMode: "full-access",
        });
        const options = customHarness.getLastCreateQueryInput()!.options;

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "use the built-in model",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
            [{ id: "contextWindow", value: "expanded" }],
          ),
          attachments: [],
        });
        yield* Effect.promise(() => readFirstPromptText(customHarness.getLastCreateQueryInput()));
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "keep this prompt literal",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [{ id: "effort", value: "ultrathink" }],
          ),
          attachments: [],
        });
        const prompt = yield* Effect.promise(() =>
          readFirstPromptText(customHarness.getLastCreateQueryInput()),
        );
        return { options, prompt };
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(customHarness.layer),
      );

      return Effect.gen(function* () {
        const { options: customOptions, prompt: customPrompt } = yield* runCustomFlow;
        assert.equal(customOptions.model, SYNTHETIC_CLAUDE_COLLIDING_ALIAS);
        assert.equal(customOptions.effort, undefined);
        assert.deepEqual(customOptions.settings, { showThinkingSummaries: true });
        assert.deepEqual(customHarness.query.setModelCalls, [
          `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
          SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
        ]);
        assert.equal(customPrompt, "keep this prompt literal");

        const builtInOptions = yield* start(builtInHarness, SYNTHETIC_CLAUDE_CAPABLE_MODEL);
        assert.equal(builtInOptions.model, `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`);
        assert.equal(builtInOptions.effort, "max");
        assert.deepEqual(builtInOptions.settings, {
          showThinkingSummaries: true,
          fastMode: true,
        });
      });
    },
  );

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps compact commands intact when ultrathink is selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_STANDARD_MODEL,
        [{ id: "effort", value: "ultrathink" }],
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
        modelSelection,
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "/compact");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        {
          type: "text",
          text: "What's in this image?",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The Claude CLI reads a streamed user message as a slash-command invocation
  // only when the final content block is text. Leading with the text block sent
  // every image-carrying turn down the plain-prompt path, so `/skill args`
  // reached the agent unexpanded with no error anywhere.
  it.effect("puts the command text last so attachments do not suppress expansion", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-command-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const imageAttachment = {
        type: "image" as const,
        id: "thread-claude-attachment-22345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const fileAttachment = {
        type: "file" as const,
        id: "thread-claude-attachment-32345678-1234-1234-1234-123456789abc",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      };
      for (const attachment of [imageAttachment, fileAttachment]) {
        const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
        NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
        NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      }

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [imageAttachment],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [fileAttachment],
      });

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 3),
      );
      const commandBlock = {
        type: "text" as const,
        text: "/flow-patterns hello",
      };

      assert.deepEqual(prompts[0]?.message.content, [commandBlock]);
      assert.deepEqual(prompts[1]?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        commandBlock,
      ]);
      // Non-image attachments never become content blocks. Claude reaches them
      // through the path line ProviderService writes into the prompt, so the
      // text block stays last on its own.
      assert.deepEqual(prompts[2]?.message.content, [commandBlock]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("dispatches a $skill mention as a trailing slash command block", () => {
    // Claude Code only runs `/name` from the message's last text block, so a
    // chip picked mid-prompt is moved there and the surrounding prose kept.
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-home-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "implement"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "implement", "SKILL.md"),
      "---\ndescription: Implement the tickets.\n---\n# Body\n",
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ok, now $implement all the tickets\nstart with auth",
        attachments: [],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.deepEqual(promptMessage?.message.content, [
        { type: "text", text: "ok, now" },
        { type: "text", text: "/implement all the tickets\nstart with auth" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the skill command block after image attachments", () => {
    // A command block followed by an image is not expanded by the CLI; the
    // image must come first.
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-image-"));
    const homeDir = NodePath.join(baseDir, "claude-home");
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "review"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "review", "SKILL.md"),
      "---\ndescription: Review.\n---\n# Body\n",
    );
    const harness = makeHarness({ baseDir, claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "$review this screenshot",
        attachments: [attachment],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(promptMessage);
      const blocks = promptMessage.message.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(
        blocks.map((block) => (block.type === "text" ? block.text : block.type)),
        ["image", "/review this screenshot"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves a $ mention of an unknown or disabled skill as prose", () => {
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-off-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "deploy"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "deploy", "SKILL.md"),
      "---\ndescription: Deploy.\n---\n# Body\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "settings.json"),
      JSON.stringify({ skillOverrides: { deploy: "off" } }),
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run $deploy and echo $HOME",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "run $deploy and echo $HOME");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("places overage-included rate-limit events on the bucket the probe named", () => {
    const scopedLimitNames = Ref.makeUnsafe<ClaudeScopedLimitNames>({ overageIncluded: undefined });
    const harness = makeHarness({ scopedLimitNames });
    const rateLimitEvent = (utilization: number): SDKMessage =>
      ({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "seven_day_overage_included",
          utilization,
        },
        uuid: `rate-limit-${utilization}`,
        session_id: "sdk-session-1",
      }) as unknown as SDKMessage;
    const resultMessage = (uuid: string): SDKMessage =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid,
      }) as unknown as SDKMessage;
    const limitsUpdates = (events: Iterable<ProviderRuntimeEvent>) =>
      Array.from(events).flatMap((event) =>
        event.type === "account.rate-limits.updated" ? [event.payload.limits] : [],
      );
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Before any probe names the bucket the event has nowhere to land.
      // Collecting through the turn's completion proves the SDK message was
      // handled, not merely still queued.
      const firstTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rateLimitEvent(0.2));
      harness.query.emit(resultMessage("result-1"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(firstTurnFiber)), []);

      // The status probe reads `get_usage` and records the model it saw.
      yield* Ref.set(scopedLimitNames, { overageIncluded: "Fable" });
      const secondTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      harness.query.emit(rateLimitEvent(0.4));
      harness.query.emit(resultMessage("result-2"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(secondTurnFiber)), [
        {
          windows: [
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 40,
              windowDurationMins: 10_080,
            },
          ],
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not emit turn.completed for a result with no active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect through session.exited so the window after the second result
      // is deterministically inside the collection: both results are queued
      // after sendTurn returns and drain in order on the one stream consumer.
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);

      // Second result with no turn in flight — the shape the resume
      // handshake (system/init + result(num_turns: 0)) delivers, and the
      // same completeTurn branch every no-turnState result lands in. This
      // used to emit an untargeted turn.completed; it must emit nothing.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: "sdk-session-1",
        uuid: "result-handshake",
      } as unknown as SDKMessage);

      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      // Exactly one completion — the real turn's, targeted at its turn id.
      // The buggy branch produced a second, untargeted one here.
      assert.equal(completions.length, 1);
      const completed = completions[0];
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run 5 commands",
        attachments: [],
      });

      // Steer: a second sendTurn while the turn is still running continues
      // the same turn — the message is queued into the live agent loop.
      const steeredTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "actually run 15",
        attachments: [],
      });
      assert.equal(String(steeredTurn.turnId), String(turn.turnId));

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-steer",
        uuid: "assistant-steer-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-steer-1",
          content: [{ type: "text", text: "Adjusting to 15." }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-steer",
        uuid: "result-steer-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = runtimeEvents.filter((event) => event.type === "turn.completed");

      // One turn boundary for the whole run: the steer produced no
      // turn.completed/turn.started pair.
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(turn.turnId));
      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("steers an overlapping sendTurn into the turn the first send admitted", () => {
    const harness = makeHarness();
    const permissionGate = harness.query.gatePermissionMode(1);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const sendA = yield* forkSend(adapter, "first");
      const sendB = yield* forkSend(adapter, "second");
      // A is parked in its gated setPermissionMode, so B can only be waiting on
      // the send lock: it must not have started configuring on its own.
      assert.equal(harness.query.setPermissionModeCalls.length, 1);

      permissionGate.resolve();
      const turnA = yield* Fiber.join(sendA);
      const turnB = yield* Fiber.join(sendB);
      assert.equal(String(turnB.turnId), String(turnA.turnId));

      emitClaudeResult(harness, "result-overlap");
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(turnA.turnId));

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.equal(prompts.length, 2);
      assert.equal(prompts[0]?.uuid, String(turnA.turnId));
      assert.equal(prompts[1]?.uuid, undefined);
    }).pipe(
      Effect.ensuring(Effect.sync(() => permissionGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts a new turn when the turn a send waited on completes during its setup", () => {
    const harness = makeHarness();
    const permissionGate = harness.query.gatePermissionMode(2);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const firstTurnEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turnA = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first",
        interactionMode: "default",
        attachments: [],
      });

      const sendB = yield* forkSend(adapter, "second");
      assert.equal(harness.query.setPermissionModeCalls.length, 2);

      // turn.completed is the receipt that A's turn state is already cleared.
      emitClaudeResult(harness, "result-first");
      yield* Fiber.join(firstTurnEventsFiber);
      const secondTurnStartedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.started",
      ).pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));

      permissionGate.resolve();
      const turnB = yield* Fiber.join(sendB);
      assert.notEqual(String(turnB.turnId), String(turnA.turnId));

      const secondTurnStarted = yield* Fiber.join(secondTurnStartedFiber);
      assert.equal(secondTurnStarted._tag, "Some");
      if (secondTurnStarted._tag === "Some") {
        assert.equal(String(secondTurnStarted.value.turnId), String(turnB.turnId));
      }
      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.equal(prompts.length, 2);
      assert.equal(prompts[0]?.uuid, String(turnA.turnId));
      assert.equal(prompts[1]?.uuid, String(turnB.turnId));
    }).pipe(
      Effect.ensuring(Effect.sync(() => permissionGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails a parked and a waiting sendTurn when the session stops before admission", () => {
    const harness = makeHarness();
    const permissionGate = harness.query.gatePermissionMode(1);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const sendA = yield* forkSend(adapter, "first");
      const sendB = yield* forkSend(adapter, "second");
      yield* adapter.stopSession(THREAD_ID);

      // Stop returned while the permission gate is still held, so A can only
      // have been released by the closed signal. Poll instead of joining: a
      // send that missed the signal must fail this test, not hang it.
      assert.isDefined(sendA.pollUnsafe());
      const errorA = yield* Fiber.join(sendA).pipe(Effect.flip);
      const errorB = yield* Fiber.join(sendB).pipe(Effect.flip);
      assert.instanceOf(errorA, ProviderAdapterSessionClosedError);
      assert.instanceOf(errorB, ProviderAdapterSessionClosedError);
      assert.equal(harness.query.setPermissionModeCalls.length, 1);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(runtimeEvents.filter((event) => event.type === "turn.started").length, 0);
      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 1),
      );
      assert.equal(prompts.length, 0);
    }).pipe(
      Effect.ensuring(Effect.sync(() => permissionGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets the next send start a turn after a send fails during setup", () => {
    const harness = makeHarness();
    const permissionGate = harness.query.gatePermissionMode(1);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const sendA = yield* forkSend(adapter, "first");
      const sendB = yield* forkSend(adapter, "second");
      permissionGate.reject(new Error("SDK rejected the permission mode"));

      const errorA = yield* Fiber.join(sendA).pipe(Effect.flip);
      assert.instanceOf(errorA, ProviderAdapterRequestError);
      const turnB = yield* Fiber.join(sendB);

      emitClaudeResult(harness, "result-after-failure");
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(turnB.turnId));

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 1),
      );
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.uuid, String(turnB.turnId));
    }).pipe(
      Effect.ensuring(Effect.sync(() => permissionGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("background agents", () => {
    const taskStarted = (taskId: string, taskType: string, isBackgrounded: boolean) =>
      ({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: `Task ${taskId}`,
        task_type: taskType,
        is_backgrounded: isBackgrounded,
        tool_use_id: `tool-${taskId}`,
        uuid: `started-${taskId}`,
        session_id: CLAUDE_ORIGINAL_SESSION_ID,
      }) as unknown as SDKMessage;
    const taskNotification = (taskId: string) =>
      ({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "completed",
        summary: "done",
        uuid: `notified-${taskId}`,
        session_id: CLAUDE_ORIGINAL_SESSION_ID,
      }) as unknown as SDKMessage;
    const assistantText = (uuid: string, text: string) =>
      ({
        type: "assistant",
        session_id: CLAUDE_ORIGINAL_SESSION_ID,
        uuid,
        parent_tool_use_id: null,
        message: { id: `message-${uuid}`, content: [{ type: "text", text }] },
      }) as unknown as SDKMessage;
    const startTurn = (adapter: ClaudeAdapterShape) =>
      Effect.gen(function* () {
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        return yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });
      });
    const untilCompleted = (adapter: ClaudeAdapterShape) =>
      Stream.takeUntil(adapter.streamEvents, (event) => event.type === "turn.completed").pipe(
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

    it.effect(
      "keeps the turn open until its background agent reports and the lead finishes",
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const turn = yield* startTurn(adapter);
          const eventsFiber = yield* untilCompleted(adapter);

          harness.query.emit(taskStarted("bg-agent", "local_agent", true));
          harness.query.emit(assistantText("reply", "The worker is on it."));
          emitClaudeResult(harness, "result-reply");
          harness.query.emit(taskNotification("bg-agent"));
          harness.query.emit(assistantText("continued", "Tests pass."));
          emitClaudeResult(harness, "result-continued");

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const types = events.map((event) => event.type);
          // The agent's report lands inside the turn, and the continuation joins it
          // instead of opening a synthetic turn.
          assert.isTrue(types.indexOf("task.completed") >= 0, types.join(","));
          assert.isTrue(types.indexOf("task.completed") < types.indexOf("turn.completed"));
          const otherTurns = events.filter(
            (event) =>
              event.type === "turn.started" && String(event.turnId) !== String(turn.turnId),
          );
          assert.equal(otherTurns.length, 0);
          const completed = events.at(-1);
          assert.equal(completed?.type, "turn.completed");
          assert.equal(String(completed?.turnId), String(turn.turnId));
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      },
    );

    it.effect("ends the turn at its result when only a shell or a foreground agent ran", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const turn = yield* startTurn(adapter);
        const eventsFiber = yield* untilCompleted(adapter);

        // A background shell can run for good, and a foreground agent has always
        // reported before the result; neither holds the turn.
        harness.query.emit(taskStarted("dev-server", "local_bash", true));
        harness.query.emit(taskStarted("fg-agent", "local_agent", false));
        emitClaudeResult(harness, "result-reply");

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.at(-1);
        assert.equal(completed?.type, "turn.completed");
        assert.equal(String(completed?.turnId), String(turn.turnId));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("holds the turn for a foreground agent moved to the background", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* startTurn(adapter);
        const eventsFiber = yield* untilCompleted(adapter);

        harness.query.emit(taskStarted("moved-agent", "local_agent", false));
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "moved-agent",
          patch: { is_backgrounded: true },
          uuid: "moved",
          session_id: CLAUDE_ORIGINAL_SESSION_ID,
        } as unknown as SDKMessage);
        emitClaudeResult(harness, "result-reply");
        harness.query.emit(taskNotification("moved-agent"));
        emitClaudeResult(harness, "result-continued");

        const types = Array.from(yield* Fiber.join(eventsFiber)).map((event) => event.type);
        assert.isTrue(types.indexOf("task.completed") >= 0, types.join(","));
        assert.isTrue(types.indexOf("task.completed") < types.indexOf("turn.completed"));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("lets go of an agent the live set drops even when its report is lost", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const turn = yield* startTurn(adapter);
        const eventsFiber = yield* untilCompleted(adapter);

        harness.query.emit(taskStarted("lost-agent", "local_agent", true));
        emitClaudeResult(harness, "result-reply");
        // The agent ends, but its task_notification never reaches the adapter.
        harness.query.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
          uuid: "level-empty",
          session_id: CLAUDE_ORIGINAL_SESSION_ID,
        } as unknown as SDKMessage);
        emitClaudeResult(harness, "result-continued");

        const completed = Array.from(yield* Fiber.join(eventsFiber)).at(-1);
        assert.equal(completed?.type, "turn.completed");
        assert.equal(String(completed?.turnId), String(turn.turnId));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("counts the main-loop usage of a held result toward the turn", () => {
      const harness = makeHarness();
      const usageResult = (uuid: string, inputTokens: number, outputTokens: number) =>
        ({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          usage: {
            input_tokens: inputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: outputTokens,
          },
          session_id: CLAUDE_ORIGINAL_SESSION_ID,
          uuid,
        }) as unknown as SDKMessage;
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* startTurn(adapter);
        const eventsFiber = yield* untilCompleted(adapter);

        harness.query.emit(taskStarted("bg-agent", "local_agent", true));
        harness.query.emit(usageResult("result-reply", 100, 10));
        harness.query.emit(taskNotification("bg-agent"));
        harness.query.emit(usageResult("result-continued", 40, 5));

        const completed = Array.from(yield* Fiber.join(eventsFiber)).at(-1);
        const usage =
          completed?.type === "turn.completed"
            ? (completed.payload.usage as Record<string, unknown> | undefined)
            : undefined;
        assert.equal(usage?.input_tokens, 140);
        assert.equal(usage?.output_tokens, 15);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("closes a stale synthetic turn before the sent turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turnA = yield* sendCompletedClaudeTurn(adapter, harness, THREAD_ID, "first");

      // A background agent answering between prompts auto-starts a synthetic turn.
      const syntheticStartedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.started",
      ).pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
      harness.query.emit({
        type: "assistant",
        session_id: CLAUDE_ORIGINAL_SESSION_ID,
        uuid: "assistant-background",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-background",
          content: [{ type: "text", text: "Background update" }],
        },
      } as unknown as SDKMessage);
      const syntheticStarted = yield* Fiber.join(syntheticStartedFiber);
      assert.equal(syntheticStarted._tag, "Some");
      const syntheticTurnId =
        syntheticStarted._tag === "Some" ? String(syntheticStarted.value.turnId) : undefined;
      assert.notEqual(syntheticTurnId, String(turnA.turnId));

      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.started",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const turnB = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "second",
        attachments: [],
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const closed = events.find((event) => event.type === "turn.completed");
      const started = events.find((event) => event.type === "turn.started");
      assert.equal(String(closed?.turnId), syntheticTurnId);
      assert.equal(String(started?.turnId), String(turnB.turnId));
      assert.notEqual(String(turnB.turnId), syntheticTurnId);
      // The new turn's stamp is taken after the synthetic close, so the close
      // never reads as later than the start it made room for.
      assert.isTrue(
        closed !== undefined && started !== undefined && closed.createdAt <= started.createdAt,
        `turn.completed ${closed?.createdAt} must not follow turn.started ${started?.createdAt}`,
      );

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.equal(prompts[1]?.uuid, String(turnB.turnId));
    }).pipe(
      Effect.provideService(Clock.Clock, makeTickingClock()),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a send all-or-nothing when Stop lands at any step", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
      );
      const sweep = yield* sweepSendSteps((injectAt) => runSendWithStopAt(homePath, injectAt));
      assert.deepEqual(sweep.violations, [], `Stop sweep over N=${sweep.steps} steps`);

      // A sweep that never admitted a send, or never stopped one, proves nothing.
      assert.include(sweep.outcomes, "admitted");
      assert.include(sweep.outcomes, "closed");
      // A send fails as not-found only while it has not captured its session, so
      // those steps come first.
      const firstCaptured = sweep.outcomes.findIndex((outcome) => outcome !== "not-found");
      assert.notInclude(
        firstCaptured === -1 ? [] : sweep.outcomes.slice(firstCaptured),
        "not-found",
      );
    });
  });

  it.effect("keeps a send all-or-nothing when its caller is interrupted at any step", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
      );
      const sweep = yield* sweepSendSteps((injectAt) => runSendInterruptedAt(homePath, injectAt));
      assert.deepEqual(sweep.violations, [], `interrupt sweep over N=${sweep.steps} steps`);

      // Both sides of the publication step must have been exercised.
      assert.include(sweep.outcomes, "published");
      assert.include(sweep.outcomes, "unpublished");
    });
  });

  it.effect("starts its own turn for a send admitted while the previous turn completes", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
      );
      // Before completeTurn begins the turn is still steerable: the boundary's other side.
      const beforeResult = yield* runSendDuringCompletion(homePath, 0);
      assert.deepEqual(beforeResult.violations, [], "send admitted before the result");
      assert.equal(beforeResult.outcome, "steered");

      const sweep = yield* sweepSendSteps((parkAt) => runSendDuringCompletion(homePath, parkAt));
      assert.deepEqual(sweep.violations, [], `completion sweep over N=${sweep.steps} stream reads`);
      // The result has no session id, so every stream read is inside completeTurn.
      assert.isAtLeast(sweep.steps, 2);
      assert.deepEqual(new Set(sweep.outcomes), new Set(["started"]));
    });
  });

  it.effect("releases a send waiting on a completing turn when the session stops", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
    const harness = makeHarness({ claudeConfig: { homePath } });
    const base = makeTickingClock();
    const streamClock = makeParkingClock(base);
    const sendClock = makeParkingClock(base);
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(Clock.Clock, streamClock.clock));
      const turnA = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first",
        attachments: [],
      });
      const staged = yield* forkSecondSendHeldAtAdmission(adapter, sendClock);
      assert.isTrue(staged.held, "the second send reached admission");

      // Read 2 is after turn.completed(A) is offered and before A's state is cleared.
      streamClock.arm(2);
      emitBareResult(harness, "result-first");
      yield* Effect.promise(() => streamClock.held);
      sendClock.release();
      assert.isUndefined(staged.fiber.pollUnsafe(), "the second send waits for A to settle");

      // Stop must not wait for the held completion, and must release the waiting send.
      yield* adapter.stopSession(THREAD_ID);
      const exit = staged.fiber.pollUnsafe();
      assert.isDefined(exit, "Stop released the waiting send");
      const sent = exit?._tag === "Success" ? exit.value : undefined;
      assert.equal(sent?._tag, "Failure");
      if (sent?._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.filter((event) => event.type === "turn.started");
      assert.deepEqual(
        started.map((event) => String(event.turnId)),
        [String(turnA.turnId)],
        "the waiting send never started a turn",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          streamClock.release();
          sendClock.release();
        }),
      ),
      Effect.provideService(Clock.Clock, base),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes a stale synthetic turn once when the send closing it is interrupted", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
      );
      const sweep = yield* sweepSendSteps((interruptAt) =>
        runSyntheticCloseInterruptedAt(homePath, interruptAt),
      );
      assert.deepEqual(sweep.violations, [], `synthetic close sweep over N=${sweep.steps} reads`);
      // The uninterrupted run checks the published side; every held read is the other.
      assert.deepEqual(new Set(sweep.outcomes), new Set(["unpublished"]));
      assert.isAtLeast(sweep.steps, 4);
    });
  });

  it.effect(
    "completes a stale synthetic turn once when the stream's result races the send closing it",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        // The stream's completion runs on while the send is held; the send resumes after.
        const sendLast = yield* sweepSendSteps((holdAt) =>
          runStreamResultDuringSyntheticClose(homePath, holdAt, false),
        );
        // The stream's completion is held; the send resumes first, then the stale completion.
        const streamLast = yield* sweepSendSteps((holdAt) =>
          runStreamResultDuringSyntheticClose(homePath, holdAt, true),
        );
        assert.deepEqual(
          [
            ...sendLast.violations.map((violation) => `send last: ${violation}`),
            ...streamLast.violations.map((violation) => `stream last: ${violation}`),
          ],
          [],
          `result race sweeps over N=${sendLast.steps} and N=${streamLast.steps} reads`,
        );
        assert.include(sendLast.outcomes, "raced");
      });
    },
    30_000,
  );

  it.effect(
    "completes a turn once when Stop lands while the stream completes it",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const sweep = yield* sweepSendSteps((holdAt) =>
          runStopDuringStreamCompletion(homePath, holdAt),
        );
        assert.deepEqual(sweep.violations, [], `Stop sweep over N=${sweep.steps} stream reads`);
        assert.isAtLeast(sweep.steps, 2);
      });
    },
    30_000,
  );

  it.effect(
    "completes a stale synthetic turn once when Stop lands while a send closes it",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const sweep = yield* sweepSendSteps((holdAt) =>
          runStopDuringSyntheticClose(homePath, holdAt),
        );
        assert.deepEqual(
          sweep.violations,
          [],
          `Stop during close sweep over N=${sweep.steps} reads`,
        );
        // Stop waits for a close that is still publishing S, rather than completing S beside it.
        assert.isTrue(sweep.outcomes.some((outcome) => outcome.endsWith("+stop-waited")));
      });
    },
    30_000,
  );

  it.effect(
    "keeps a stopped session closed when a cancelled send's stale close finishes after Stop",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const sweep = yield* sweepSendSteps((stopHoldAt) =>
          runStaleCloseFinishingAfterStop(homePath, stopHoldAt),
        );
        assert.deepEqual(sweep.violations, [], `Stop sweep over N=${sweep.steps} Stop reads`);
        assert.isAtLeast(sweep.steps, 2);
      });
    },
    30_000,
  );

  it.effect(
    "keeps the new turn running when a failed result for a stale synthetic turn resumes after it started",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const sweep = yield* sweepSendSteps((holdAt) =>
          runFailedResultBeforeClaim(homePath, holdAt, true),
        );
        assert.deepEqual(sweep.violations, [], `failed result sweep over N=${sweep.steps} reads`);
        assert.include(sweep.outcomes, "raced");
      });
    },
    30_000,
  );

  it.effect(
    "keeps the new turn running when a failed result that saw no turn resumes after one started",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const sweep = yield* sweepSendSteps((holdAt) =>
          runFailedResultBeforeClaim(homePath, holdAt, false),
        );
        assert.deepEqual(sweep.violations, [], `no-turn result sweep over N=${sweep.steps} reads`);
        assert.include(sweep.outcomes, "raced");
      });
    },
    30_000,
  );

  it.effect(
    "still fails the live turn when a failed result for it is held at its runtime.error",
    () => {
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-sweep-home-"));
      const harness = makeHarness({ claudeConfig: { homePath } });
      const base = makeTickingClock();
      const streamClock = makeParkingClock(base);
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* Stream.takeUntil(
          adapter.streamEvents,
          (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
        ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        yield* adapter
          .startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.provideService(Clock.Clock, streamClock.clock));
        const turnA = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "first",
          attachments: [],
        });
        streamClock.arm(1);
        const resultIdle = untilStreamIdle(harness.query);
        emitFailedResult(harness, "result-a");
        const reached = yield* Effect.promise(() =>
          Promise.race([
            streamClock.held.then(() => "held" as const),
            resultIdle.then(() => "idle" as const),
          ]),
        );
        assert.equal(reached, "held");
        // Nothing else happens while the error is held: the turn it saw is still the live one.
        streamClock.rearm(Number.POSITIVE_INFINITY);
        yield* Effect.promise(() => resultIdle);
        const settled = (yield* adapter.listSessions())[0];
        const events = yield* collectThreadEvents(adapter, eventsFiber);

        const idA = String(turnA.turnId);
        assert.deepEqual(lifecycleTrace(events), [
          `turn.started(${idA})`,
          `turn.completed(${idA})`,
        ]);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(completed?.type, "turn.completed");
        if (completed?.type === "turn.completed") {
          assert.equal(completed.payload.state, "failed");
          assert.equal(completed.payload.errorMessage, "synthetic failure");
          assert.deepEqual(completed.payload.usage, RESULT_USAGE);
          assert.deepEqual(completed.payload.modelUsage, RESULT_MODEL_USAGE);
          assert.equal(completed.payload.stopReason, "end_turn");
          assert.equal(completed.payload.totalCostUsd, RESULT_COST_USD);
        }
        const runtimeErrors = events.flatMap((event) =>
          event.type === "runtime.error" ? [event] : [],
        );
        assert.deepEqual(
          runtimeErrors.map((event) => String(event.turnId)),
          [idA],
        );
        const usageEvents = events.flatMap((event) =>
          event.type === "thread.token-usage.updated" ? [event] : [],
        );
        assert.deepEqual(
          usageEvents.map((event) => String(event.turnId)),
          [idA],
        );
        assert.isTrue(sameFields(usageEvents[0]?.payload.usage, RESULT_THREAD_USAGE));
        assert.equal(settled?.status, "ready");
        assert.equal(settled?.lastError, "synthetic failure");
      }).pipe(
        Effect.ensuring(Effect.sync(() => streamClock.release())),
        Effect.provideService(Clock.Clock, base),
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
    30_000,
  );

  it.effect("shows a tool's input that arrives only in the assistant snapshot", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hi", attachments: [] });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-snapshot-input",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-ps-1", name: "PowerShell", input: {} },
        },
      } as unknown as SDKMessage);
      const snapshot = {
        type: "assistant",
        session_id: "sdk-session-snapshot-input",
        uuid: "assistant-snapshot",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-ps-1",
              name: "PowerShell",
              input: { command: "Get-PSDrive C" },
            },
          ],
        },
      } as unknown as SDKMessage;
      harness.query.emit(snapshot);
      harness.query.emit({
        ...snapshot,
        uuid: "assistant-snapshot-repeat",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-snapshot-input",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-ps-1", content: "C 211 20" }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-snapshot-input",
        uuid: "result-snapshot-input",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolEvents = runtimeEvents.filter(
        (event) =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-ps-1",
      );
      const firstUpdate = toolEvents.find((event) => event.type === "item.updated");
      assert.equal(toolEvents[0]?.type, "item.started");
      assert.equal(firstUpdate?.type, "item.updated");
      if (firstUpdate?.type === "item.updated") {
        assert.equal(firstUpdate.payload.status, "inProgress");
        assert.deepEqual(firstUpdate.payload.data, {
          toolName: "PowerShell",
          input: { command: "Get-PSDrive C" },
        });
        assert.include(firstUpdate.payload.detail ?? "", "Get-PSDrive C");
      }
      // The repeated snapshot carries the same input, so only the tool result updates again.
      assert.equal(toolEvents.filter((event) => event.type === "item.updated").length, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("backfills Claude thinking summaries from assistant snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const thinkingSnapshot = {
        type: "assistant",
        session_id: "sdk-session-thinking-snapshot",
        uuid: "assistant-thinking-snapshot",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-thinking",
          content: [
            { type: "thinking", thinking: "Use Euclidean algorithm." },
            { type: "text", text: "The gcd is 21." },
          ],
        },
      } as unknown as SDKMessage;
      harness.query.emit(thinkingSnapshot);
      harness.query.emit(thinkingSnapshot);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-thinking-snapshot",
        uuid: "assistant-thinking-snapshot-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-thinking-2",
          content: [{ type: "thinking", thinking: "Verify the result." }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-thinking-snapshot",
        uuid: "result-thinking-snapshot",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const reasoningDeltas = runtimeEvents.filter(
        (event) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text",
      );
      assert.equal(reasoningDeltas.length, 2);
      const reasoningDelta = reasoningDeltas[0];
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Use Euclidean algorithm.");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }
      assert.deepEqual(
        runtimeEvents.flatMap((event) =>
          event.type === "content.delta" ? [event.payload.delta] : [],
        ),
        ["Use Euclidean algorithm.", "The gcd is 21.", "Verify the result."],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies only streamed Read image inputs as image views", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "inspect both files",
        attachments: [],
      });

      const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-read-image",
            name: "Read",
            input: {},
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: encodeUnknownJsonString({ file_path: imagePath }),
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-image-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-image",
              content: "Image Size: 1280x720.",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-text-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-read-text",
            name: "Read",
            input: { file_path: "/workspace/src/index.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-text-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-text",
              content: "export {};",
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-read-image",
        uuid: "read-image-turn-result",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const imageEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-image",
      );
      assert.deepEqual(
        imageEvents.map((event) => [event.type, event.payload.itemType]),
        [
          ["item.started", "dynamic_tool_call"],
          ["item.updated", "image_view"],
          ["item.updated", "image_view"],
          ["item.completed", "image_view"],
        ],
      );
      for (const event of imageEvents.slice(1)) {
        assert.equal(event.payload.detail, imagePath);
        assert.equal(
          (event.payload.data as { input?: { file_path?: string } } | undefined)?.input?.file_path,
          imagePath,
        );
      }

      const textEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-text",
      );
      assert.deepEqual(
        textEvents.map((event) => event.payload.itemType),
        ["dynamic_tool_call", "dynamic_tool_call", "dynamic_tool_call"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-agent-1",
        description: "Review the database layer",
        task_type: "local_agent",
        tool_use_id: "tool-task-1",
        uuid: "task-agent-1-uuid",
        session_id: "sdk-session-task",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 20,
        },
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.tokenUsage?.hasSubagents, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
          output_tokens: 4,
        },
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
        assert.deepEqual(turnCompleted.payload.tokenUsage, {
          usageStatus: "partial",
          usageScope: "main_agent",
          inputTokens: 16,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          outputTokens: 4,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats aborted_tools results as interrupted and hides ede_diagnostic errors", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Exact shape the CLI emits when Stop lands mid-tool-call: is_error
      // is true and the only error is internal diagnostic telemetry.
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        stop_reason: "tool_use",
        terminal_reason: "aborted_tools",
        session_id: "sdk-session-abort-tools",
        uuid: "result-abort-tools",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails a turn when the result carries a give-up terminal_reason", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // The CLI stamps subtype success with an empty error list when it
      // gives up after exhausting API retries; the terminal_reason is the
      // only structured failure signal.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        errors: [],
        stop_reason: null,
        terminal_reason: "api_error",
        session_id: "sdk-session-api-error",
        uuid: "result-api-error",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "runtime.error",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Claude gave up after repeated API errors.",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const AUTH_FAILURE_ASSISTANT = {
    type: "assistant",
    session_id: "sdk-session-auth",
    uuid: "assistant-auth",
    parent_tool_use_id: null,
    error: "authentication_failed",
    is_api_error_message: true,
    message: {
      id: "assistant-message-auth",
      model: "<synthetic>",
      content: [{ type: "text", text: "Not logged in \u00b7 Please run /login" }],
    },
  } as unknown as SDKMessage;

  const completedTurn = (runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>) => {
    const event = runtimeEvents[runtimeEvents.length - 1];
    assert.equal(event?.type, "turn.completed");
    assert(event?.type === "turn.completed");
    return event.payload;
  };

  it.effect.each([
    {
      name: "an api_error terminal reason",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    {
      name: "an is_error success with no terminal reason",
      result: { subtype: "success", is_error: true, errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    // Every other outcome names its own cause, and the latch must not speak over it.
    {
      name: "a terminal reason of its own",
      result: {
        subtype: "success",
        is_error: false,
        terminal_reason: "prompt_too_long",
        errors: [],
      },
      state: "failed",
      errorMessage: /prompt exceeds the model's context window/,
    },
    {
      name: "a listed tool failure",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool execution failed: EACCES"],
      },
      state: "failed",
      errorMessage: /EACCES/,
    },
    {
      name: "a user interrupt",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      },
      state: "interrupted",
      errorMessage: undefined,
    },
    {
      name: "a cancellation",
      result: { subtype: "error_during_execution", is_error: true, errors: ["cancelled"] },
      state: "cancelled",
      errorMessage: /cancelled/,
    },
  ])(
    "reports the real cause when an expired login is followed by $name",
    ({ result, state, errorMessage }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });

        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit({
          type: "result",
          ...result,
          session_id: "sdk-session-auth",
          uuid: "result-auth",
        } as unknown as SDKMessage);

        const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
        assert.equal(payload.state, state);
        if (errorMessage === undefined) {
          assert.equal(payload.errorMessage, undefined);
        } else {
          assert.match(payload.errorMessage ?? "", errorMessage);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a usage-limited turn with the limit it parked on", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(nowMs / 1000) + 2 * 60 * 60,
        },
        session_id: "sdk-session-limit",
        uuid: "rate-limit-rejected",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "api_error",
        errors: [],
        session_id: "sdk-session-limit",
        uuid: "result-limit",
      } as unknown as SDKMessage);

      const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
      assert.equal(payload.state, "failed");
      assert.equal(
        payload.errorMessage,
        "Claude usage limit reached. Send the message again once the limit resets.",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const usageLimitMessage =
    "Claude usage limit reached. Send the message again once the limit resets.";
  const genericApiErrorMessage = "Claude gave up after repeated API errors.";
  const rateLimitAssistant = {
    type: "assistant",
    session_id: "sdk-session-limit",
    uuid: "assistant-limit",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: {
      id: "assistant-message-limit",
      model: "<synthetic>",
      content: [{ type: "text", text: "You've hit your session limit" }],
    },
  };
  const rateLimitResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    session_id: "sdk-session-limit",
    uuid: "result-limit",
  };

  it.effect.each([
    {
      name: "an assistant-only rate limit",
      messages: [rateLimitAssistant],
      expected: usageLimitMessage,
    },
    {
      name: "a normal parent response after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: undefined }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a server error after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: "server_error" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent rate limit",
      messages: [{ ...rateLimitAssistant, parent_tool_use_id: "nested-tool" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent response after a parent rate limit",
      messages: [
        rateLimitAssistant,
        { ...rateLimitAssistant, error: undefined, parent_tool_use_id: "nested-tool" },
      ],
      expected: usageLimitMessage,
    },
  ])("classifies the terminal API failure after $name", ({ messages, expected }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      for (const [index, message] of messages.entries()) {
        harness.query.emit({ ...message, uuid: `assistant-${index}` } as unknown as SDKMessage);
      }
      harness.query.emit(rateLimitResult as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const errors = events.filter((event) => event.type === "runtime.error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.payload.message, expected);
      assert.equal(completedTurn(events).state, "failed");
      assert.equal(completedTurn(events).errorMessage, expected);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("names repeated usage limits without carrying them into a later turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      for (const [index, expected] of [
        usageLimitMessage,
        usageLimitMessage,
        genericApiErrorMessage,
      ].entries()) {
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
        if (index === 0) {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
            session_id: "sdk-session-limit",
            uuid: "limit-rejected",
          } as unknown as SDKMessage);
        }
        if (index < 2) {
          harness.query.emit({
            ...rateLimitAssistant,
            uuid: `assistant-limit-${index}`,
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          ...rateLimitResult,
          uuid: `result-limit-${index}`,
        } as unknown as SDKMessage);
        const payload = completedTurn(Array.from(yield* Fiber.join(eventsFiber)));
        assert.equal(payload.state, "failed");
        assert.equal(payload.errorMessage, expected);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each([
    {
      name: "listed error with api_error",
      evidence: "auth",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "api_error",
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "overload with api_error",
      evidence: "auth",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        errors: [],
      },
      expected: /overloaded \(529\)/,
      expectedState: "failed",
    },
    {
      name: "listed error on an is_error success",
      evidence: "auth",
      result: {
        subtype: "success",
        is_error: true,
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "recovered same window",
      evidence: "recovered",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    },
    {
      name: "nested assistant does not poison parent",
      evidence: "nested-auth",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by overload",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 529,
        errors: [],
      },
      expected: /overloaded \(529\)/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by a listed error",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        errors: ["Tool execution failed: EACCES"],
      },
      expected: /EACCES/,
      expectedState: "failed",
    },
    {
      name: "assistant rate limit followed by an interrupt",
      evidence: "assistant-rate-limit",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      },
      expected: undefined,
      expectedState: "interrupted",
    },
    ...[
      "recovered-missing-reset",
      "recovered-next-reset",
      "recovered-warning",
      "two-windows-recovered",
    ].map((evidence) => ({
      name: evidence,
      evidence,
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /repeated API errors/,
      expectedState: "failed",
    })),
    ...["two-windows-one-recovered", "rejected-again"].map((evidence) => ({
      name: evidence,
      evidence,
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      expected: /usage limit reached/,
      expectedState: "failed",
    })),
    {
      name: "successful turn stays successful",
      evidence: "recovered",
      result: { subtype: "success", is_error: false, errors: [] },
      expected: undefined,
      expectedState: "completed",
    },
  ])(
    "preserves terminal failure evidence after $name",
    ({ evidence, result, expected, expectedState }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "synthetic hello",
          attachments: [],
        });
        if (evidence === "assistant-rate-limit") {
          harness.query.emit(rateLimitAssistant as unknown as SDKMessage);
        } else if (evidence === "auth" || evidence === "nested-auth") {
          harness.query.emit({
            type: "assistant",
            session_id: "sdk-audit",
            uuid: "audit-auth",
            parent_tool_use_id: evidence === "nested-auth" ? "synthetic-parent-tool" : null,
            error: "authentication_failed",
            is_api_error_message: true,
            message: {
              id: "audit-message",
              model: "synthetic-audit-model",
              content: [{ type: "text", text: "Not logged in. Please run /login" }],
            },
          } as unknown as SDKMessage);
        } else {
          const nowMs = yield* Clock.currentTimeMillis;
          const resetsAt = Math.floor(nowMs / 1000) + 7200;
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
            session_id: "sdk-audit",
            uuid: "audit-limit-rejected",
          } as unknown as SDKMessage);
          if (evidence.startsWith("two-windows")) {
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt },
              session_id: "sdk-audit",
              uuid: "audit-weekly-rejected",
            } as unknown as SDKMessage);
          }
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: evidence === "recovered-warning" ? "allowed_warning" : "allowed",
              rateLimitType: "five_hour",
              ...(evidence === "recovered-missing-reset"
                ? {}
                : {
                    resetsAt: evidence === "recovered-next-reset" ? resetsAt + 18000 : resetsAt,
                  }),
            },
            session_id: "sdk-audit",
            uuid: "audit-limit-allowed",
          } as unknown as SDKMessage);
          if (evidence === "two-windows-recovered" || evidence === "rejected-again") {
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: {
                status: evidence === "rejected-again" ? "rejected" : "allowed",
                rateLimitType: evidence === "rejected-again" ? "five_hour" : "seven_day",
                resetsAt,
              },
              session_id: "sdk-audit",
              uuid: "audit-final-quota-update",
            } as unknown as SDKMessage);
          }
        }
        harness.query.emit({
          type: "result",
          ...result,
          session_id: "sdk-audit",
          uuid: "audit-result",
        } as unknown as SDKMessage);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const complete = events.at(-1);
        assert(complete?.type === "turn.completed");
        assert.equal(complete.payload.state, expectedState);
        if (expected) assert.match(complete.payload.errorMessage ?? "", expected);
        else assert.equal(complete.payload.errorMessage, undefined);
        if (evidence === "rejected-again")
          assert.equal(events.filter((event) => event.type === "runtime.warning").length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each([
    { homePath: "./synthetic config's $literal", inherited: undefined },
    { homePath: "", inherited: ".synthetic config's $literal" },
    { homePath: "", inherited: " /synthetic/path with edge spaces " },
  ])(
    "reports the same Claude config and cwd used by the spawned query ($homePath, $inherited)",
    ({ homePath, inherited }) => {
      const harness = makeHarness({
        claudeConfig: { homePath },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: inherited },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const cwd = NodePath.resolve("/tmp/synthetic-audit-project");
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd,
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "synthetic",
          attachments: [],
        });
        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          terminal_reason: "api_error",
          errors: [],
          session_id: "sdk-session-auth",
          uuid: "result-auth",
        } as unknown as SDKMessage);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.at(-1);
        assert(completed?.type === "turn.completed");
        const actualQuery = harness.getLastCreateQueryInput();
        assert(actualQuery !== undefined);
        const expectedConfigDir = homePath ? NodePath.resolve(homePath) : inherited;
        assert.equal(actualQuery.options.env?.CLAUDE_CONFIG_DIR, expectedConfigDir);
        assert.equal(actualQuery.options.cwd, cwd);
        assert(
          completed.payload.errorMessage?.includes(
            `CLAUDE_CONFIG_DIR set to ${encodeUnknownJsonString(expectedConfigDir)}`,
          ),
        );
        assert(completed.payload.errorMessage?.includes(`from ${encodeUnknownJsonString(cwd)}`));
        assert(!completed.payload.errorMessage?.includes("CLAUDE_CONFIG_DIR="));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a turn for every dead-turn terminal_reason", () => {
    const reasons = [
      "blocking_limit",
      "rapid_refill_breaker",
      "prompt_too_long",
      "image_error",
      "model_error",
      "malformed_tool_use_exhausted",
      "budget_exhausted",
      "structured_output_retry_exhausted",
      "tool_deferred_unavailable",
      "turn_setup_failed",
    ];
    // One harness per reason: the fake query settles a single turn.
    const runDeadTurn = (reason: string) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const completionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          errors: [],
          stop_reason: null,
          terminal_reason: reason,
          session_id: "sdk-session-dead-turn",
          uuid: `result-${reason}`,
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completionFiber);
        assert.equal(completed._tag, "Some");
        if (completed._tag === "Some" && completed.value.type === "turn.completed") {
          assert.equal(completed.value.payload.state, "failed", reason);
          assert.ok(completed.value.payload.errorMessage, `${reason} carries an error message`);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    };
    return Effect.forEach(reasons, runDeadTurn, { discard: true });
  });

  it.effect.each(["success", "error_during_execution"] as const)(
    "preserves %s behavior for an unknown runtime terminal reason",
    (subtype) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const completionFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        // An installed CLI can send a terminal reason newer than the bundled SDK.
        harness.query.emit({
          type: "result",
          subtype,
          is_error: subtype !== "success",
          result: "",
          errors: subtype === "success" ? [] : ["Provider error detail"],
          stop_reason: null,
          terminal_reason: "future_terminal_reason",
          session_id: "sdk-session-future-reason",
          uuid: "result-future-reason",
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completionFiber);
        assert.equal(completed._tag, "Some");
        if (completed._tag === "Some" && completed.value.type === "turn.completed") {
          assert.equal(
            completed.value.payload.state,
            subtype === "success" ? "completed" : "failed",
          );
          assert.equal(
            completed.value.payload.errorMessage,
            subtype === "success" ? undefined : "Provider error detail",
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails a turn when a success result reports a 529 overload", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result: "",
        errors: [],
        stop_reason: null,
        session_id: "sdk-session-overload",
        uuid: "result-overload",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Claude API is overloaded (529). Try again shortly.",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn settles live tasks and closes the provider session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);

      // Closing the session is the hard stop because SDK interrupt can leave
      // resumed background work alive.
      assert.equal(harness.query.closeCalls, 1);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn lets Claude abort the turn before closing the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      let closeCallsAtInterrupt: number | undefined;
      harness.query.interrupt = async () => {
        closeCallsAtInterrupt = harness.query.closeCalls;
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          session_id: "sdk-session",
          uuid: "result-interrupted",
        } as unknown as SDKMessage);
      };

      yield* adapter.interruptTurn(session.threadId);

      assert.equal(closeCallsAtInterrupt, 0);
      assert.equal(harness.query.closeCalls, 1);
      const [turnCompleted] = Array.from(yield* Fiber.join(turnCompletedFiber));
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn closes the session when Claude never aborts the turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.interrupt = () => new Promise(() => {});

      const interruptFiber = yield* adapter.interruptTurn(session.threadId).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(interruptFiber);

      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the session available when process close fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.closeError = new Error("close failed");

      const result = yield* adapter.interruptTurn(session.threadId).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      }
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopAll attempts every session when one process close fails", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const firstQuery = queries[0];
      if (!firstQuery) {
        return;
      }
      firstQuery.closeError = new Error("close failed");

      const result = yield* adapter.stopAll().pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(yield* adapter.hasSession(RESUME_THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("completes with result usage without querying current context usage", () => {
    const harness = makeHarness();
    let getContextUsageCalls = 0;
    Object.assign(harness.query, {
      getContextUsage: async () => {
        getContextUsageCalls += 1;
        return {
          totalTokens: 999,
          maxTokens: 200000,
          isAutoCompactEnabled: true,
        };
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-1",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 80,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-2",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-3",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-3",
          role: "assistant",
          content: [],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 400,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 10,
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 30 },
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(getContextUsageCalls, 0);
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload.usage, {
          usedTokens: 200,
          lastUsedTokens: 200,
          totalProcessedTokens: 550,
          inputTokens: 180,
          outputTokens: 20,
          maxTokens: 200000,
        });
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.deepEqual(completed.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 500,
          cachedInputTokens: 90,
          cacheCreationTokens: 10,
          reasoningTokens: 30,
          outputTokens: 50,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats omitted Claude cache counters as zero contributions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "uncached turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-uncached-usage",
        usage: {
          input_tokens: 42,
          output_tokens: 9,
        },
      } as unknown as SDKMessage);

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        assert.deepEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 42,
          outputTokens: 9,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses per-turn result usage across consecutive Claude turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const firstTurnSettled = yield* Deferred.make<void>();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) =>
          event.type === "session.state.changed" && event.payload.reason === "api_retry:1/2"
            ? Deferred.succeed(firstTurnSettled, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: "first",
        stop_reason: "end_turn",
        session_id: "sdk-session-consecutive-usage",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 10,
        },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 10_000,
            outputTokens: 1_000,
            cacheReadInputTokens: 2_000,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 1,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 2,
        retry_delay_ms: 1,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "sdk-session-consecutive-usage",
        uuid: "consecutive-usage-barrier",
      } as unknown as SDKMessage);
      yield* Deferred.await(firstTurnSettled);

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "second turn",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 80,
        duration_api_ms: 70,
        num_turns: 2,
        result: "second",
        stop_reason: "end_turn",
        session_id: "sdk-session-consecutive-usage",
        usage: {
          input_tokens: 30,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
          output_tokens: 7,
        },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 20_000,
            outputTokens: 2_000,
            cacheReadInputTokens: 4_000,
            cacheCreationInputTokens: 1_000,
            webSearchRequests: 0,
            costUSD: 2,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
        },
      } as unknown as SDKMessage);

      const completed = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed[0]?.type, "turn.completed");
      assert.equal(completed[1]?.type, "turn.completed");
      if (completed[0]?.type === "turn.completed" && completed[1]?.type === "turn.completed") {
        assert.deepEqual(completed[0].payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 125,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          outputTokens: 10,
          hasSubagents: false,
        });
        assert.deepEqual(completed[1].payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 35,
          cachedInputTokens: 2,
          cacheCreationTokens: 3,
          outputTokens: 7,
          hasSubagents: false,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves compacted usage when completion follows an older assistant frame", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compacted-usage",
        uuid: "assistant-compacted-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-compacted-usage",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: 200,
          post_tokens: 40,
        },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { post_tokens: 40 },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-post-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 2,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-compacted-usage",
        usage: {
          input_tokens: 400,
          output_tokens: 50,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const compactionEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> =>
          event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.equal(compactionEvents[0]?.payload.beforeTokens, 200);
      assert.equal(compactionEvents[0]?.payload.afterTokens, 40);
      assert.equal(compactionEvents[1]?.payload.beforeTokens, undefined);
      assert.equal(compactionEvents[1]?.payload.afterTokens, 40);
      const finalUsageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload.usage, {
          usedTokens: 40,
          totalProcessedTokens: 450,
          maxTokens: 200000,
        });
      }
      assert.equal(
        runtimeEvents.find((event) => event.type === "turn.completed")?.type,
        "turn.completed",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("workflow member coalescing: identical snapshots suppress, changes emit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect task.progress until member-0's tick-3 emission lands, then
      // evaluate member emissions.
      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.takeUntil(
          // Sentinel: member-0's tick-3 emission (tokens 20) — members are
          // emitted after the coordinator row within a tick.
          (event) =>
            (event.payload as { taskId?: string }).taskId === "wf-coalesce:wf:0" &&
            (event.payload as { typedUsage?: { totalTokens?: number } }).typedUsage?.totalTokens ===
              20,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const memberSnapshot = (tokens: number) => [
        { type: "workflow_phase", index: 0, title: "Work" },
        {
          type: "workflow_agent",
          index: 0,
          state: "running",
          label: "member-0",
          phaseIndex: 0,
          tokens,
        },
        {
          type: "workflow_agent",
          index: 1,
          state: "running",
          label: "member-1",
          phaseIndex: 0,
          tokens: 50,
        },
      ];
      const tick = (usageTotal: number, snapshot: ReturnType<typeof memberSnapshot>) =>
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "wf-coalesce",
          description: "Coalescing workflow",
          usage: { total_tokens: usageTotal, tool_uses: 1, duration_ms: 10 },
          workflow_progress: snapshot,
          uuid: `wf-tick-${usageTotal}`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);

      // Tick 1: both members are new -> 2 member events.
      tick(100, memberSnapshot(10));
      // Tick 2: IDENTICAL member snapshot -> 0 member events (coordinator
      // usage changed, but members did not).
      tick(200, memberSnapshot(10));
      // Tick 3: member-0's tokens advanced -> exactly 1 member event.
      tick(300, memberSnapshot(20));

      const progressEvents = Array.from(yield* Fiber.join(progressFiber));
      const byMember = new Map<string, number>();
      for (const event of progressEvents) {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (!taskId.includes(":wf:")) continue;
        byMember.set(taskId, (byMember.get(taskId) ?? 0) + 1);
      }
      // member-0: tick 1 + tick 3. member-1: tick 1 only (tick 2 identical,
      // tick 3 unchanged).
      assert.equal(byMember.get("wf-coalesce:wf:0"), 2);
      assert.equal(byMember.get("wf-coalesce:wf:1"), 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("task.started carries model/effort; subagent snapshots refine the model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // No explicit model/effort on the launch input: the task inherits the
      // session's selection.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-model",
        description: "Agent M",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_m",
        uuid: "task-model-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // The subagent's assistant snapshot carries the authoritative API
      // model id, which refines the linkage on later rows.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_m",
        message: {
          model: SYNTHETIC_SUBAGENT_MODEL,
          content: [],
        },
        uuid: "subagent-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-model",
        description: "Agent M",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-model-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, SYNTHETIC_CLAUDE_CAPABLE_MODEL);
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, SYNTHETIC_SUBAGENT_MODEL);
        assert.equal(progress.payload.effort, "max");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a subagent snapshot that beats task_started still wins over the seed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // The subagent streams its first assistant snapshot before the task is
      // registered, so there is no agent to refine yet.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_early",
        message: {
          model: SYNTHETIC_SUBAGENT_MODEL,
          content: [],
        },
        uuid: "early-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-early",
        description: "Agent E",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_early",
        uuid: "task-early-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-early",
        description: "Agent E",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-early-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, SYNTHETIC_SUBAGENT_MODEL);
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, SYNTHETIC_SUBAGENT_MODEL);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
        assert.deepEqual(turnCompleted.payload.tokenUsage, {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        });
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps Claude stream failure events structural", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("credential material that must stay in the cause chain"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude runtime stream failed.");
        assert.deepEqual(runtimeError.payload.detail, {
          failureCount: 1,
          failureTags: ["ProviderAdapterProcessError"],
        });
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "Claude runtime stream failed.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        () => Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("consumes undeclared and UX-internal system subtypes without warning rows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "session.state.changed" && event.payload.reason === "api_retry:3/10",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Undeclared wire-only roster snapshot + every typed UX-internal
      // subtype and top-level type consumed silently: none may surface as
      // unknown-subtype warnings.
      for (const message of [
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "t1", task_type: "local_agent", description: "Say hi" }],
          session_id: "session",
          uuid: "roster",
        },
        {
          type: "system",
          subtype: "vcs_state_changed",
          kind: "push",
          cwd: "/tmp/worktree",
          session_id: "session",
          uuid: "vcs",
        },
        {
          type: "system",
          subtype: "code_change_published",
          provider: "github",
          url: "https://github.com/pingdotgg/t3code/pull/1",
          repo: "pingdotgg/t3code",
          identifier: "1",
          session_id: "session",
          uuid: "ccp",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: "running" },
          session_id: "session",
          uuid: "tu",
        },
        { type: "system", subtype: "commands_changed", session_id: "session", uuid: "cc" },
        { type: "system", subtype: "local_command_output", session_id: "session", uuid: "lco" },
        { type: "system", subtype: "plugin_install", session_id: "session", uuid: "pi" },
        { type: "system", subtype: "memory_recall", session_id: "session", uuid: "mr" },
        { type: "system", subtype: "elicitation_complete", session_id: "session", uuid: "ec" },
        {
          type: "system",
          subtype: "control_request_progress",
          request_id: "ctrl-1",
          status: "started",
          session_id: "session",
          uuid: "crp",
        },
        {
          type: "system",
          subtype: "worker_shutting_down",
          reason: "host_exit",
          session_id: "session",
          uuid: "wsd",
        },
        {
          type: "system",
          subtype: "informational",
          content: "Loaded 3 skills",
          level: "notice",
          session_id: "session",
          uuid: "info",
        },
        { type: "prompt_suggestion", suggestion: "try this", session_id: "session", uuid: "ps" },
        {
          type: "conversation_reset",
          new_conversation_id: "conv-2",
          session_id: "session",
          uuid: "cr",
        },
        {
          type: "system",
          subtype: "notification",
          key: "context",
          text: "low priority note",
          priority: "low",
          session_id: "session",
          uuid: "notif",
        },
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
      }
      // Safety model-fallback notices DO surface as a warning row.
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        request_id: "req_test",
        api_refusal_category: "cyber",
        api_refusal_explanation: null,
        content: "Safeguards flagged this message. Switched to Opus 4.8.",
        session_id: "session",
        uuid: "mrf",
      } as unknown as SDKMessage);
      // High-priority notifications DO surface as a warning row.
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "limit",
        text: "context window nearly full",
        priority: "high",
        session_id: "session",
        uuid: "notif-high",
      } as unknown as SDKMessage);
      // Warning-level informational notes and refusals without a fallback
      // model surface as warning rows too.
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Stop hook prevented continuation",
        level: "warning",
        prevent_continuation: true,
        session_id: "session",
        uuid: "info-warn",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-opus-5",
        request_id: null,
        api_refusal_explanation: "The request was declined by the API.",
        content: "Model refused",
        session_id: "session",
        uuid: "mrnf",
      } as unknown as SDKMessage);
      // session_state_changed maps to the matching session states.
      for (const [state, uuid] of [
        ["running", "ssc-run"],
        ["requires_action", "ssc-req"],
        ["idle", "ssc-idle"],
      ]) {
        harness.query.emit({
          type: "system",
          subtype: "session_state_changed",
          state,
          session_id: "session",
          uuid,
        } as unknown as SDKMessage);
      }
      // api_retry maps to a session heartbeat, not a warning row.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "session",
        uuid: "retry",
      } as unknown as SDKMessage);
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      // Exactly four warnings: the fallback notice, high-priority notification,
      // warning-level informational note, and the refusal. Nothing else.
      assert.deepEqual(
        warnings.map((event) => event.payload.message),
        [
          "Safeguards flagged this message. Switched to Opus 4.8.",
          "context window nearly full",
          "Stop hook prevented continuation",
          "The request was declined by the API.",
        ],
      );
      const sessionStates = runtimeEvents
        .filter((event) => event.type === "session.state.changed")
        .map((event) =>
          event.type === "session.state.changed"
            ? `${event.payload.state}:${event.payload.reason ?? ""}`
            : "",
        )
        .filter(
          (entry) => entry.startsWith("running:session_state") || entry.includes("session_state"),
        );
      assert.deepEqual(sessionStates, [
        "running:session_state:running",
        "waiting:session_state:requires_action",
        "ready:session_state:idle",
      ]);
      const heartbeat = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          typeof event.payload.reason === "string" &&
          event.payload.reason.startsWith("api_retry:"),
      );
      assert.equal(heartbeat?.type, "session.state.changed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const observeUsageLimitEvents = (adapter: ClaudeAdapterShape, query: FakeClaudeQuery) =>
    Effect.gen(function* () {
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      let receipt: Deferred.Deferred<void> | undefined;
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (
            receipt &&
            event.type === "session.state.changed" &&
            event.payload.reason === "api_retry:1/1"
          ) {
            yield* Deferred.succeed(receipt, undefined);
          }
        }),
      ).pipe(Effect.forkChild);
      const drainSdkMessages = Effect.gen(function* () {
        receipt = yield* Deferred.make<void>();
        // The heartbeat follows queued SDK messages without adding a warning.
        query.emit({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 1,
          retry_delay_ms: 0,
          error_status: 429,
          error: { type: "rate_limit_error" },
          session_id: "sdk-session-limit",
          uuid: "usage-limit-drain",
        } as unknown as SDKMessage);
        yield* Deferred.await(receipt);
      });
      return { runtimeEvents, runtimeEventsFiber, drainSdkMessages };
    });

  it.effect("surfaces a rejected Claude usage limit once per turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      // resetsAt is epoch seconds, so the window reopens 4h 1m30s out.
      const nowMs = yield* Clock.currentTimeMillis;
      const rateLimitInfo = {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: Math.floor(nowMs / 1000) + 4 * 60 * 60 + 90,
      };
      const rejected = {
        type: "rate_limit_event",
        rate_limit_info: rateLimitInfo,
        session_id: "sdk-session-limit",
        uuid: "rate-limit-rejected",
      };
      // Sibling fields drift while the window is parked, so the same rendered
      // line can arrive more than once inside one turn.
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;
      // The repeat lands minutes later, so the remaining wait has visibly
      // shrunk. Deduping on the rendered row would let that drift through.
      yield* TestClock.adjust("5 minutes");
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      const usageLimitRows = () =>
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : ""));
      assert.equal(usageLimitRows().length, 1);
      // A wait, not a wall clock: the server renders this row but clients read
      // it from other timezones. Reading resetsAt as milliseconds would put the
      // window minutes out instead of hours, so the hour also pins the scale.
      assert.match(
        usageLimitRows()[0] ?? "",
        /^Claude usage limit reached\. This turn is paused until the 5-hour limit resets in 4h( \d{1,2}m)?\.$/,
      );
      // The exact instant still rides along for clients that want to render it.
      assert.deepEqual(
        runtimeEvents.find((event) => event.type === "runtime.warning")?.payload.detail,
        rateLimitInfo,
      );
      // The raw telemetry event still flows for every copy.
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        2,
      );

      // Same window, drifting siblings: still the one pause.
      harness.query.emit({
        ...rejected,
        rate_limit_info: { ...rateLimitInfo, utilization: 0.99 },
        uuid: "rate-limit-rejected-drift",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      assert.equal(usageLimitRows().length, 1);

      // Retrying inside the same window renders the identical line. Staying
      // quiet there would put the new turn right back to a silent spin.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-limit",
        uuid: "result-limit",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "retry", attachments: [] });
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(usageLimitRows().length, 2);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps allowed and malformed Claude rate-limit events out of the work log", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      // A turn is in flight, so silence here is the status filter doing its job
      // rather than the between-turns guard.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const rateLimitInfo of [
        { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
        { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 },
        // Undeclared shape from an older/newer CLI must not take the session down.
        undefined,
      ]) {
        harness.query.emit({
          type: "rate_limit_event",
          ...(rateLimitInfo ? { rate_limit_info: rateLimitInfo } : {}),
          session_id: "sdk-session-limit-ok",
          uuid: `rate-limit-${rateLimitInfo?.status ?? "malformed"}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.warning"),
        [],
      );
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        2,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stays quiet when no turn is parked by the Claude limit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const nowMs = yield* Clock.currentTimeMillis;
      const resetsAt = Math.floor(nowMs / 1000) + 60 * 60;
      // The stream stays live between turns, so a reject can land with nothing
      // to pause; claiming "this turn is paused" there would be a lie.
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt,
        },
        session_id: "sdk-session-idle",
        uuid: "rate-limit-idle",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      // Provisioned overage carries the request even though the base window
      // rejected it, so the turn keeps running and needs no row.
      for (const overage of [
        { overageStatus: "allowed" },
        { overageStatus: "allowed_warning" },
        { isUsingOverage: true },
        { overageInUse: true },
      ]) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt,
            utilization: 1,
            ...overage,
          },
          session_id: "sdk-session-idle",
          uuid: "rate-limit-overage",
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.warning"),
        [],
      );
      // Idle and overage-covered events still reach the account telemetry stream.
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        5,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("still surfaces the pause when overage is exhausted too", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const resetsAt = Math.floor(nowMs / 1000) + 60 * 60;
      // The overage-exhausted / out-of-credits shape: the base window and the
      // overage it would have spent both reject, with neither isUsingOverage
      // nor overageInUse set to say anything is still covered. Nothing is
      // carrying the turn here, so staying quiet would be the silent spin
      // this row exists to prevent.
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt,
          overageStatus: "rejected",
        },
        session_id: "sdk-session-dual-reject",
        uuid: "rate-limit-dual-reject",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(runtimeEvents.filter((event) => event.type === "runtime.warning").length, 1);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps one row per window when two Claude limits interleave", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const nowSeconds = Math.floor(nowMs / 1000);
      const rejection = (rateLimitType: string, resetsAt: number, uuid: string) => ({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
        session_id: "sdk-session-interleaved",
        uuid,
      });

      // One turn can park on more than one window; each deserves its own row,
      // and a later repeat of an earlier window deserves none.
      for (const message of [
        rejection("five_hour", nowSeconds + 2 * 60 * 60, "limit-five-hour"),
        rejection("seven_day", nowSeconds + 48 * 60 * 60, "limit-seven-day"),
        rejection("five_hour", nowSeconds + 2 * 60 * 60, "limit-five-hour-repeat"),
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
        yield* drainSdkMessages;
      }

      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : ""))
          .map((message) => message.replace(/ in \d+h( \d{1,2}m)?/, "")),
        [
          "Claude usage limit reached. This turn is paused until the 5-hour limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day limit resets.",
        ],
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("re-announces a Claude limit for a synthetic turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      const nowMs = yield* Clock.currentTimeMillis;
      const rejected = {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(nowMs / 1000) + 2 * 60 * 60,
        },
        session_id: "sdk-session-synthetic",
        uuid: "rate-limit-synthetic",
      };
      harness.query.emit(rejected as unknown as SDKMessage);
      yield* drainSdkMessages;

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-synthetic",
        uuid: "result-synthetic",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;

      // A background agent answering between prompts auto-starts a synthetic
      // turn, which parks on the same window and needs its own row.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-synthetic",
        uuid: "assistant-synthetic",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-synthetic",
          content: [{ type: "text", text: "Following up" }],
        },
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      harness.query.emit({ ...rejected, uuid: "rate-limit-synthetic-2" } as unknown as SDKMessage);
      yield* drainSdkMessages;

      assert.equal(runtimeEvents.filter((event) => event.type === "runtime.warning").length, 2);

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops an unusable Claude reset time, not the row or the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const [rateLimitType, resetsAt] of [
        ["five_hour", undefined],
        // Implausibly far out once scaled to milliseconds: no credible wait.
        ["seven_day", 1e20],
      ] as const) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          session_id: "sdk-session-limit-unusable",
          uuid: `rate-limit-${rateLimitType}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;

      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => (event.type === "runtime.warning" ? event.payload.message : "")),
        [
          "Claude usage limit reached. This turn is paused until the 5-hour limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day limit resets.",
        ],
      );
      // A throw inside the telemetry handler would tear the session down.
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "session.exited" || event.type === "runtime.error")
          .map((event) => event.type),
        [],
      );
      // Still live enough to take the next turn.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "still here", attachments: [] });

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns for unmapped Claude limits and names the probed model bucket", () => {
    const scopedLimitNames = Ref.makeUnsafe<ClaudeScopedLimitNames>({ overageIncluded: undefined });
    const harness = makeHarness({ scopedLimitNames });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { runtimeEvents, runtimeEventsFiber, drainSdkMessages } =
        yield* observeUsageLimitEvents(adapter, harness.query);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      for (const rateLimitType of ["seven_day_overage_included", "future_window"]) {
        harness.query.emit({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType },
          session_id: "sdk-session-unmapped-limit",
          uuid: `rejected-${rateLimitType}`,
        } as unknown as SDKMessage);
      }
      yield* drainSdkMessages;
      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated"),
        [],
      );

      yield* Ref.set(scopedLimitNames, { overageIncluded: "Model A" });
      const nowMs = yield* Clock.currentTimeMillis;
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day_overage_included",
          utilization: 1,
          resetsAt: Math.floor(nowMs / 1000) + 3600,
        },
        session_id: "sdk-session-unmapped-limit",
        uuid: "rejected-probed-bucket",
      } as unknown as SDKMessage);
      yield* drainSdkMessages;
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "runtime.warning")
          .map((event) => event.payload.message),
        [
          "Claude usage limit reached. This turn is paused until the 7-day model limit resets.",
          "Claude usage limit reached. This turn is paused until the limit resets.",
          "Claude usage limit reached. This turn is paused until the 7-day Model A limit resets in 1h.",
        ],
      );
      assert.equal(
        runtimeEvents.filter((event) => event.type === "account.rate-limits.updated").length,
        1,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("consumes Claude command lifecycle notifications silently", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const sessionId = "6e81554e-5cff-4b37-8a39-f3a9051ac234";

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const readyMessage = "command lifecycle test ready";
      const readyFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === readyMessage,
      ).pipe(Stream.runDrain, Effect.forkChild);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-ready",
        text: readyMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-ready",
      } as unknown as SDKMessage);
      yield* Fiber.join(readyFiber);

      const processedMessage = "command lifecycle messages processed";
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === processedMessage,
      ).pipe(Stream.runCollect, Effect.forkChild);
      for (const [state, uuid] of [
        ["started", "command-started"],
        ["completed", "command-completed"],
      ]) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "4cd8e8a3-df7a-425d-b6c9-4053abc0b8fd",
          state,
          session_id: sessionId,
          uuid,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-processed",
        text: processedMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-processed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["runtime.warning"],
      );
      const warning = runtimeEvents[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.equal(warning.payload.message, processedMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits thread token usage updates from Claude task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 321,
            lastUsedTokens: 321,
            toolUses: 2,
            durationMs: 654,
          },
        });
      }
      assert.equal(progressEvent?.type, "task.progress");
      if (usageEvent && progressEvent) {
        assert.notStrictEqual(usageEvent.eventId, progressEvent.eventId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "preserves oversized Claude result totals after task progress snapshots are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 190000,
              lastUsedTokens: 190000,
              totalProcessedTokens: 535000,
              maxTokens: 200000,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          requestId: "request-1",
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("acceptForSession returns session-scoped permission updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this for the session",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const respondToNextRequest = Effect.gen(function* () {
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
          return;
        }
        const runtimeRequestId = requested.value.requestId;
        assert.equal(typeof runtimeRequestId, "string");
        if (runtimeRequestId === undefined) {
          return;
        }
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.make(runtimeRequestId),
          "acceptForSession",
        );
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
      });

      // MCP tools frequently arrive with no usable suggestion (Claude Code
      // sends an empty array); the decision must still stick for the session.
      const mcpPermissionPromise = canUseTool(
        "mcp__linear__create_issue",
        { title: "hello" },
        {
          signal: new AbortController().signal,
          requestId: "request-2",
          suggestions: [],
          toolUseID: "tool-use-mcp-1",
        },
      );
      yield* respondToNextRequest;
      const mcpPermission = (yield* Effect.promise(() => mcpPermissionPromise)) as PermissionResult;
      assert.equal(mcpPermission.behavior, "allow");
      if (mcpPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(mcpPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__linear__create_issue" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      // Received suggestions are reused but rescoped to the session —
      // echoing "localSettings" would persist a session-only choice to disk.
      const bashPermissionPromise = canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          requestId: "request-3",
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-use-bash-1",
        },
      );
      yield* respondToNextRequest;
      const bashPermission = (yield* Effect.promise(
        () => bashPermissionPromise,
      )) as PermissionResult;
      assert.equal(bashPermission.behavior, "allow");
      if (bashPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(bashPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "session",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          requestId: "request-4",
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          requestId: "request-5",
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "starts a fresh turn ID for an explicit continuation of restored Claude history",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const oldTurnId = "550e8400-e29b-41d4-a716-446655440001";
        const startedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.started",
        ).pipe(Stream.runHead, Effect.forkChild);
        const session = yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          resumeCursor: {
            threadId: RESUME_THREAD_ID,
            resume: "550e8400-e29b-41d4-a716-446655440000",
            resumeSessionAt: "assistant-before-restart",
            turnCount: 1,
            turnStartMessageIds: [oldTurnId],
          },
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "Continue where you left off.",
          attachments: [],
        });
        const started = yield* Fiber.join(startedFiber);
        assert.equal(started._tag, "Some");
        assert.notEqual(String(turn.turnId), oldTurnId);
        if (started._tag === "Some" && started.value.type === "turn.started") {
          assert.equal(String(started.value.turnId), String(turn.turnId));
        }
        const prompt = yield* Effect.promise(() =>
          readFirstPromptMessage(harness.getLastCreateQueryInput()),
        );
        assert.equal(prompt ? promptTextOf(prompt) : undefined, "Continue where you left off.");
        assert.equal(String(prompt?.uuid), String(turn.turnId));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds a steered Claude turn after recovery and preserves fork boundaries", () => {
    const forkCalls: Array<Parameters<NonNullable<ClaudeAdapterLiveOptions["forkSession"]>>> = [];
    let firstTurnId = "";
    let secondTurnId = "";
    let missingBoundary = false;
    let legacyHistory = false;
    const harness = makeHarness({
      forkSession: async (...args) => {
        forkCalls.push(args);
        return { sessionId: "550e8400-e29b-41d4-a716-446655440020" };
      },
      getSessionMessages: async (sessionId) => {
        const history: Awaited<
          ReturnType<NonNullable<ClaudeAdapterLiveOptions["getSessionMessages"]>>
        > = [
          {
            type: "user",
            uuid: firstTurnId,
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: "first" },
          },
          {
            type: "assistant",
            uuid: "assistant-1",
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: [] },
          },
          {
            type: "user",
            uuid: "tool-result-1",
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: [{ type: "tool_result" }] },
          },
          {
            type: "assistant",
            uuid: "assistant-1-final",
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: [] },
          },
          {
            type: "user",
            uuid: secondTurnId,
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: "second" },
          },
          {
            type: "assistant",
            uuid: "assistant-2",
            session_id: "550e8400-e29b-41d4-a716-446655440010",
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: [] },
          },
          {
            type: "user",
            uuid: "steer",
            session_id: sessionId,
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: "steer the second turn" },
          },
          {
            type: "assistant",
            uuid: "assistant-steer",
            session_id: sessionId,
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: [] },
          },
        ];
        return sessionId.endsWith("0020")
          ? history.slice(0, 4).map((message) => ({ ...message, uuid: `fork-${message.uuid}` }))
          : legacyHistory
            ? history.slice(0, 6)
            : missingBoundary
              ? history.filter((message) => message.uuid !== secondTurnId)
              : history;
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
      });
      firstTurnId = firstTurn.turnId;

      const firstCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "550e8400-e29b-41d4-a716-446655440010",
        uuid: "result-first",
      } as unknown as SDKMessage);

      const firstCompleted = yield* Fiber.join(firstCompletedFiber);
      assert.equal(firstCompleted._tag, "Some");
      if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
        assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
      }

      const secondTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
      });
      secondTurnId = secondTurn.turnId;
      const steer = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "steer the second turn",
        attachments: [],
      });
      assert.equal(steer.turnId, secondTurn.turnId);

      const secondCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "550e8400-e29b-41d4-a716-446655440010",
        uuid: "result-second",
      } as unknown as SDKMessage);

      const secondCompleted = yield* Fiber.join(secondCompletedFiber);
      assert.equal(secondCompleted._tag, "Some");
      if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
        assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
      }

      const threadBeforeRollback = yield* adapter.readThread(session.threadId);
      assert.equal(threadBeforeRollback.turns.length, 2);
      const cursor = (yield* adapter.listSessions())[0]?.resumeCursor;
      yield* adapter.stopSession(session.threadId);
      legacyHistory = true;
      yield* adapter.startSession({
        threadId: session.threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: session.threadId,
          resume: "550e8400-e29b-41d4-a716-446655440010",
          turnCount: 1,
        },
      });
      const legacyOptions = harness.getLastCreateQueryInput();
      const ambiguousLegacy = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.flip);
      assert.match(ambiguousLegacy.message, /exact Claude turn boundary is unavailable/);
      assert.equal(forkCalls.length, 0);
      assert.equal(harness.getLastCreateQueryInput(), legacyOptions);
      assert.equal((yield* adapter.listSessions()).length, 1);
      yield* adapter.stopSession(session.threadId);
      legacyHistory = false;
      yield* adapter.startSession({
        threadId: session.threadId,
        runtimeMode: "full-access",
        resumeCursor: cursor,
      });
      missingBoundary = true;
      const unavailable = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.flip);
      assert.match(unavailable.message, /exact Claude turn boundary is unavailable/);
      assert.equal(forkCalls.length, 0);
      missingBoundary = false;

      const recoveredQuery = harness.queries.at(-1)!;
      assert.equal(recoveredQuery.closeCalls, 0);
      yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal(recoveredQuery.closeCalls, 1);
      const forkOptions = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(forkCalls, [
        ["550e8400-e29b-41d4-a716-446655440010", { upToMessageId: "assistant-1-final" }],
      ]);
      assert.equal(forkOptions?.resume, "550e8400-e29b-41d4-a716-446655440020");
      assert.equal(forkOptions?.resumeSessionAt, undefined);
      assert.equal(forkOptions?.forkSession, undefined);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: "550e8400-e29b-41d4-a716-446655440020",
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });

      yield* adapter.rollbackThread(session.threadId, 2);
      const resetOptions = harness.getLastCreateQueryInput()?.options;
      assert.equal(resetOptions?.resume, undefined);
      assert.equal(resetOptions?.resumeSessionAt, undefined);
      assert.equal(resetOptions?.forkSession, undefined);
      assert.ok(resetOptions?.sessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("completed turns keep their ids but not the SDK messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);
      yield* Fiber.join(completedFiber);

      const snapshot = yield* adapter.readThread(session.threadId);
      assert.deepEqual(
        snapshot.turns.map((entry) => ({ id: String(entry.id), items: entry.items })),
        [{ id: String(turn.turnId), items: [] }],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds Claude history when the fork omits retained system messages", () => {
    const forkCalls: Array<Parameters<NonNullable<ClaudeAdapterLiveOptions["forkSession"]>>> = [];
    let firstTurnId = "";
    let secondTurnId = "";
    const harness = makeHarness({
      forkSession: async (...args) => {
        forkCalls.push(args);
        return { sessionId: CLAUDE_FORK_SESSION_ID };
      },
      getSessionMessages: async (sessionId) => {
        if (sessionId === CLAUDE_FORK_SESSION_ID) {
          return [
            claudeHistoryMessage({
              type: "user",
              uuid: `fork-${firstTurnId}`,
              sessionId,
              content: "first",
            }),
            claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-assistant-1",
              sessionId,
            }),
          ];
        }
        return [
          claudeHistoryMessage({ type: "system", uuid: "system-init" }),
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({
            type: "system",
            uuid: "compact-boundary",
            content: { subtype: "compact_boundary" },
          }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
        ];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;

      const snapshot = yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(forkCalls, [
        [CLAUDE_ORIGINAL_SESSION_ID, { upToMessageId: "compact-boundary" }],
      ]);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds Claude history when the fork inserts extra system messages", () => {
    let firstTurnId = "";
    let secondTurnId = "";
    const harness = makeHarness({
      forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
      getSessionMessages: async (sessionId) => {
        if (sessionId === CLAUDE_FORK_SESSION_ID) {
          return [
            claudeHistoryMessage({
              type: "system",
              uuid: "fork-system-init",
              sessionId,
            }),
            claudeHistoryMessage({
              type: "user",
              uuid: `fork-${firstTurnId}`,
              sessionId,
              content: "first",
            }),
            claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-assistant-1",
              sessionId,
            }),
          ];
        }
        return [
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
        ];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;

      yield* adapter.rollbackThread(session.threadId, 1);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds Claude history when the fork keeps a compact conversation prefix", () => {
    let firstTurnId = "";
    let secondTurnId = "";
    const harness = makeHarness({
      forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
      getSessionMessages: async (sessionId) => {
        if (sessionId === CLAUDE_FORK_SESSION_ID) {
          return [
            claudeHistoryMessage({
              type: "user",
              uuid: "fork-compacted-user",
              sessionId,
              content: "earlier compacted turn",
            }),
            claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-compacted-assistant",
              sessionId,
            }),
            claudeHistoryMessage({
              type: "user",
              uuid: `fork-${firstTurnId}`,
              sessionId,
              content: "first",
            }),
            claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-assistant-1",
              sessionId,
            }),
          ];
        }
        return [
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
        ];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;

      yield* adapter.rollbackThread(session.threadId, 1);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds a Claude turn that includes tool results and a later steer", () => {
    const forkCalls: Array<Parameters<NonNullable<ClaudeAdapterLiveOptions["forkSession"]>>> = [];
    let firstTurnId = "";
    let secondTurnId = "";
    const harness = makeHarness({
      forkSession: async (...args) => {
        forkCalls.push(args);
        return { sessionId: CLAUDE_FORK_SESSION_ID };
      },
      getSessionMessages: async (sessionId) => {
        const history = [
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1-tool" }),
          claudeHistoryMessage({
            type: "user",
            uuid: "tool-result-1",
            content: [{ type: "tool_result" }],
          }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1-final" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
          claudeHistoryMessage({
            type: "user",
            uuid: "steer",
            sessionId,
            content: "steer the second turn",
          }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-steer", sessionId }),
        ];
        return sessionId === CLAUDE_FORK_SESSION_ID
          ? history.slice(0, 4).map((message) => ({
              ...message,
              uuid: `fork-${message.uuid}`,
              session_id: sessionId,
            }))
          : history;
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      const secondTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
      });
      secondTurnId = secondTurn.turnId;
      const steer = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "steer the second turn",
        attachments: [],
      });
      assert.equal(steer.turnId, secondTurn.turnId);
      const secondCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.queries.at(-1)!.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: CLAUDE_ORIGINAL_SESSION_ID,
        uuid: "result-second",
      } as unknown as SDKMessage);
      yield* Fiber.join(secondCompletedFiber);

      const snapshot = yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(forkCalls, [
        [CLAUDE_ORIGINAL_SESSION_ID, { upToMessageId: "assistant-1-final" }],
      ]);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds the last two turns of a three-turn Claude thread", () => {
    let firstTurnId = "";
    let secondTurnId = "";
    let thirdTurnId = "";
    const harness = makeHarness({
      forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
      getSessionMessages: async (sessionId) => {
        const history = [
          claudeHistoryMessage({ type: "system", uuid: "system-init" }),
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
          claudeHistoryMessage({ type: "user", uuid: thirdTurnId, content: "third" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-3" }),
        ];
        return sessionId === CLAUDE_FORK_SESSION_ID
          ? [
              claudeHistoryMessage({
                type: "user",
                uuid: `fork-${firstTurnId}`,
                sessionId,
                content: "first",
              }),
              claudeHistoryMessage({
                type: "assistant",
                uuid: "fork-assistant-1",
                sessionId,
              }),
            ]
          : history;
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;
      thirdTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "third"))
        .turnId;

      const snapshot = yield* adapter.rollbackThread(session.threadId, 2);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 1,
        turnStartMessageIds: [`fork-${firstTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewinds only the latest turn of a three-turn Claude thread", () => {
    let firstTurnId = "";
    let secondTurnId = "";
    let thirdTurnId = "";
    const harness = makeHarness({
      forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
      getSessionMessages: async (sessionId) => {
        const history = [
          claudeHistoryMessage({ type: "system", uuid: "system-init" }),
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
          claudeHistoryMessage({ type: "user", uuid: thirdTurnId, content: "third" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-3" }),
        ];
        return sessionId === CLAUDE_FORK_SESSION_ID
          ? [
              claudeHistoryMessage({
                type: "user",
                uuid: `fork-${firstTurnId}`,
                sessionId,
                content: "first",
              }),
              claudeHistoryMessage({
                type: "assistant",
                uuid: "fork-assistant-1",
                sessionId,
              }),
              claudeHistoryMessage({
                type: "system",
                uuid: "fork-notice",
                sessionId,
              }),
              claudeHistoryMessage({
                type: "user",
                uuid: `fork-${secondTurnId}`,
                sessionId,
                content: "second",
              }),
              claudeHistoryMessage({
                type: "assistant",
                uuid: "fork-assistant-2",
                sessionId,
              }),
            ]
          : history;
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;
      thirdTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "third"))
        .turnId;

      const snapshot = yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal(snapshot.turns.length, 2);
      assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, {
        threadId: session.threadId,
        resume: CLAUDE_FORK_SESSION_ID,
        turnCount: 2,
        turnStartMessageIds: [`fork-${firstTurnId}`, `fork-${secondTurnId}`],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resets a Claude thread when rewind removes every recorded turn", () => {
    const forkCalls: Array<Parameters<NonNullable<ClaudeAdapterLiveOptions["forkSession"]>>> = [];
    const harness = makeHarness({
      forkSession: async (...args) => {
        forkCalls.push(args);
        return { sessionId: CLAUDE_FORK_SESSION_ID };
      },
      getSessionMessages: async () => [
        claudeHistoryMessage({ type: "user", uuid: "unused", content: "first" }),
      ],
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first");
      yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second");

      const snapshot = yield* adapter.rollbackThread(session.threadId, 2);
      assert.equal(snapshot.turns.length, 0);
      assert.equal(forkCalls.length, 0);
      const resetOptions = harness.getLastCreateQueryInput()?.options;
      assert.equal(resetOptions?.resume, undefined);
      assert.ok(resetOptions?.sessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects a Claude fork that drops a retained user turn", () => {
    let firstTurnId = "";
    let secondTurnId = "";
    const harness = makeHarness({
      forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
      getSessionMessages: async (sessionId) => {
        if (sessionId === CLAUDE_FORK_SESSION_ID) {
          return [
            claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-assistant-1",
              sessionId,
            }),
          ];
        }
        return [
          claudeHistoryMessage({ type: "user", uuid: firstTurnId, content: "first" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-1" }),
          claudeHistoryMessage({ type: "user", uuid: secondTurnId, content: "second" }),
          claudeHistoryMessage({ type: "assistant", uuid: "assistant-2" }),
        ];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      firstTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "first"))
        .turnId;
      secondTurnId = (yield* sendCompletedClaudeTurn(adapter, harness, session.threadId, "second"))
        .turnId;

      const error = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.flip);
      assert.match(error.message, /did not preserve the retained turn boundaries/);
      assert.equal(harness.queries.at(-1)?.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const scenario of [
    "restores conversation messages between retained turns",
    "changes retained assistant content without changing its role",
  ] as const) {
    it.effect(`rejects a Claude fork that ${scenario}`, () => {
      const turnIds: Array<string> = [];
      const harness = makeHarness({
        forkSession: async () => ({ sessionId: CLAUDE_FORK_SESSION_ID }),
        getSessionMessages: async (sessionId) => {
          const history = turnIds.flatMap((turnId, index) => [
            claudeHistoryMessage({
              type: "user",
              uuid: turnId,
              content: `prompt ${index + 1}`,
            }),
            claudeHistoryMessage({
              type: "assistant",
              uuid: `assistant-${index + 1}`,
              content: [{ type: "text", text: `reply ${index + 1}` }],
            }),
          ]);
          if (sessionId !== CLAUDE_FORK_SESSION_ID) return history;
          const forkHistory = history.slice(0, 4).map((message) => ({
            ...message,
            uuid: `fork-${message.uuid}`,
            session_id: sessionId,
          }));
          if (scenario === "restores conversation messages between retained turns") {
            forkHistory.splice(
              2,
              0,
              claudeHistoryMessage({
                type: "user",
                uuid: "fork-restored-steer",
                sessionId,
                content: "earlier steer omitted by compaction",
              }),
              claudeHistoryMessage({
                type: "assistant",
                uuid: "fork-restored-reply",
                sessionId,
                content: [{ type: "text", text: "earlier steering reply" }],
              }),
            );
          } else {
            forkHistory[1] = claudeHistoryMessage({
              type: "assistant",
              uuid: "fork-assistant-1",
              sessionId,
              content: [{ type: "text", text: "different retained reply" }],
            });
          }
          return forkHistory;
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        for (let index = 0; index < 3; index++) {
          const turn = yield* sendCompletedClaudeTurn(
            adapter,
            harness,
            session.threadId,
            `prompt ${index + 1}`,
          );
          turnIds.push(turn.turnId);
        }
        const cursorBeforeRollback = (yield* adapter.listSessions())[0]?.resumeCursor;
        const queryCountBeforeRollback = harness.queries.length;

        const error = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.flip);
        assert.match(error.message, /did not preserve the retained turn boundaries/);
        assert.equal(harness.queries.length, queryCountBeforeRollback);
        assert.equal(harness.queries.at(-1)?.closeCalls, 0);
        assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, cursorBeforeRollback);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "contextWindow", value: "expanded" }],
        ),
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "contextWindow", value: "standard" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
        SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          requestId: "request-6",
          toolUseID: "tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes Claude resume compaction through the shared user-input UI", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onUserDialog = harness.getLastCreateQueryInput()?.options.onUserDialog;
      assert.equal(typeof onUserDialog, "function");
      if (!onUserDialog) return;

      const dialogPromise = onUserDialog(
        {
          dialogKind: "resume_return",
          payload: { sessionAgeMinutes: 145, estimatedTokens: 275123 },
        },
        { signal: new AbortController().signal, requestId: "request-dialog" },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "user-input.requested") return;
      const question = requested.value.payload.questions[0];
      assert.equal(question?.header, "Resume session");
      assert.match(question?.question ?? "", /2h 25m/);
      assert.match(question?.question ?? "", /275,123 tokens/);
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Compact and continue", "Keep full history", "Don't ask again"],
      );
      if (!question || !requested.value.requestId) return;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.make(requested.value.requestId),
        { [question.id]: "Compact and continue" },
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag === "Some") assert.equal(resolved.value.type, "user-input.resolved");
      assert.deepEqual(yield* Effect.promise(() => dialogPromise), {
        behavior: "completed",
        result: "compact",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "request-7",
        toolUseID: "tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        requestId: "request-8",
        toolUseID: "tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          requestId: "request-9",
          toolUseID: "tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the signal aborted before the listener registered", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      // Abort before the call so the adapter's listener registration can
      // never observe the abort event, only the recheck can.
      const controller = new AbortController();
      controller.abort();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          requestId: "request-10",
          toolUseID: "tool-ask-pre-aborted",
        },
      );

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["user-input.requested", "user-input.resolved"],
      );
      const resolvedEvent = runtimeEvents[1];
      if (resolvedEvent?.type === "user-input.resolved") {
        assert.deepEqual(resolvedEvent.payload.answers, {});
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopping a session settles pending user-input waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          requestId: "request-stop",
          toolUseID: "tool-ask-stop",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      // The session dies while the question is still on screen.
      yield* adapter.stopSession(THREAD_ID);

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // A-ECHO supplementary fake-query shape tests (opus-memory-echo-next-design-final §5 C1–C4,
  // bound by astra-memory-echo-next-design-review). They pin adapter-boundary echo shapes only:
  // native-driver proof (§6) and the ingestion guard that masks C4's warning (integration I1,
  // separate lane) are separate obligations. The marker-bearing frame always precedes a benign
  // frame, and the drained window must end with that later frame's event — an empty or
  // early-ended subscription cannot satisfy the window, so non-emission is a causal receipt.

  it.effect("A-ECHO C1: user string envelope replay yields no marker event", () => {
    const harness = makeHarness();
    // Literal composer envelope shape (packages/shared/src/composerContextReferences.ts:471-478, :550).
    const memoryEnvelope = [
      "please remember this",
      "",
      '<t3_context version="1">',
      '<context kind="memory" id="ctx_aecho_c1">',
      "memory: mem-aecho-c1 v3 (note)",
      "title: A-ECHO C1 memory",
      "A-ECHO-C1-MEM-MARKER heirloom body",
      "</context>",
      "</t3_context>",
    ].join("\n");
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      // Replay of our own turn: the SDK hands the envelope back as a string-content
      // user message. toolResultBlocksFromUserMessage only reads array content, so
      // nothing but the one-time thread.started receipt may come out of it.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-aecho-c1",
        uuid: "user-aecho-c1-replay",
        parent_tool_use_id: null,
        message: { role: "user", content: memoryEnvelope },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-aecho-c1",
        uuid: "result-aecho-c1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["thread.started", "turn.completed"],
      );
      const echoEvents = runtimeEvents.filter((event) =>
        JSON.stringify(event.payload).includes("A-ECHO-C1-MEM-MARKER"),
      );
      assert.deepEqual(echoEvents, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("A-ECHO C2: replayed text blocks yield only the tool_result item", () => {
    const harness = makeHarness();
    const replayedTextMarker = "A-ECHO-C2-REPLAY-MARKER";
    const toolResultText = "A-ECHO-C2-TOOL-RESULT-POSITIVE";
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-aecho-c2",
        uuid: "stream-aecho-c2-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-aecho-c2",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      // Replayed user turn: echoed prompt text beside a real tool_result. The tool
      // stays in-flight through content_block_stop (no event there), so the
      // item.updated/item.completed pair below can only come from this message.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-aecho-c2",
        uuid: "user-aecho-c2-replay",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `${replayedTextMarker}: echoed <t3_context version="1"> body`,
            },
            {
              type: "tool_result",
              tool_use_id: "tool-aecho-c2",
              content: toolResultText,
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-aecho-c2",
        uuid: "result-aecho-c2",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["thread.started", "item.started", "item.updated", "item.completed", "turn.completed"],
      );

      // Positive control: the tool_result content really flowed into the tool item.
      const toolCompleted = runtimeEvents.find((event) => event.type === "item.completed");
      assert.equal(toolCompleted?.type, "item.completed");
      if (toolCompleted?.type === "item.completed") {
        assert.equal(JSON.stringify(toolCompleted.payload.data).includes(toolResultText), true);
      }

      // The replayed plain user text reaches no projected payload. The full SDK
      // frame rides in `raw`, which ingestion does not persist (A-ECHO card §1).
      const echoEvents = runtimeEvents.filter((event) =>
        JSON.stringify(event.payload).includes(replayedTextMarker),
      );
      assert.deepEqual(echoEvents, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("A-ECHO C3: marker-bearing prompt_suggestion yields no runtime event", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      harness.query.emit({
        type: "prompt_suggestion",
        session_id: "sdk-session-aecho-c3",
        uuid: "suggestion-aecho-c3",
        suggestion: "A-ECHO-C3-SUGGESTION-MARKER continue with the stored memory",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-aecho-c3",
        uuid: "result-aecho-c3",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      // thread.started is the receipt that the suggestion frame reached the adapter;
      // turn.completed proves the stream moved past it to the later result frame.
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["thread.started", "turn.completed"],
      );
      const echoEvents = runtimeEvents.filter((event) =>
        JSON.stringify(event.payload).includes("A-ECHO-C3-SUGGESTION-MARKER"),
      );
      assert.deepEqual(echoEvents, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("A-ECHO C4: unknown SDK type warning carries the raw marker", () => {
    const harness = makeHarness();
    const unknownFrame = {
      type: "a_echo_probe",
      session_id: "sdk-session-aecho-c4",
      uuid: "unknown-aecho-c4",
      note: "A-ECHO-C4-MARKER unmodeled frame body",
    };
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      harness.query.emit(unknownFrame as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["thread.started", "runtime.warning"],
      );
      const warning = runtimeEvents[1];
      if (warning?.type !== "runtime.warning") {
        assert.fail("Expected runtime.warning for the unknown SDK frame");
        return;
      }
      // Literal preview from previewUnknownSdkContent: non-noise string scalars
      // render as `key: value` after the kind prefix.
      assert.equal(
        warning.payload.message,
        "Claude SDK message 'a_echo_probe' — note: A-ECHO-C4-MARKER unmodeled frame body",
      );
      // The adapter boundary deliberately keeps the whole raw frame as `detail`;
      // masking it is the ingestion guard's job (integration I1), not the adapter's.
      assert.deepEqual(warning.payload.detail, unknownFrame);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // A-ECHO-2 supplementary proof (astra-memory-echo-remaining-design-review):
  // the real adapter's authentication_failed assistant snapshot through the
  // real memory-echo guard into real SQLite storage. FakeClaudeQuery supplies
  // SDK-shaped synthetic frames — not a native credential run — the real
  // adapter emits the runtime events, and the real ingestion is the sole
  // consumer of the adapter's queue-backed stream. That consumer taps every
  // event it takes into a receipt queue, so observed receipts are exactly what
  // the guard processed. Each turn's bounded window ends at its own
  // turn.completed receipt and is sealed by ingestion.drain before stored
  // state is read. Raw payloads are intentionally retained on the observed
  // events and checked by reference; the zero-marker scan covers only the
  // stored fields this fresh fixture actually wrote.

  const ECHO2_THREAD = ThreadId.make("thread-aecho2-claude");
  const ECHO2_PROJECT = ProjectId.make("project-aecho2-claude");
  const ECHO2_INSTANCE = ProviderInstanceId.make("claudeAgent");
  const ECHO2_MEMORY = ProjectMemoryId.make("memory-aecho2-claude");
  const ECHO2_AT = "2026-03-04T00:00:00.000Z";
  const ECHO2_SDK_SESSION = "sdk-session-aecho2";

  const MARK_E2_STREAM = "A-ECHO2-STREAM-6d1a04c3";
  const MARK_E2_SNAPSHOT = "A-ECHO2-SNAPSHOT-2f8b55e1";
  const MARK_E2_MAXTOK = "A-ECHO2-MAXTOK-40c7d91b";
  const MARK_E2_AUTH = "A-ECHO2-AUTH-0e63f2a8";

  const echo2AssistantSnapshot = (input: {
    readonly uuid: string;
    readonly text: string;
    readonly error?: string;
  }): SDKMessage =>
    ({
      type: "assistant",
      session_id: ECHO2_SDK_SESSION,
      uuid: input.uuid,
      parent_tool_use_id: null,
      ...(input.error !== undefined ? { error: input.error, is_api_error_message: true } : {}),
      message: {
        id: `assistant-message-${input.uuid}`,
        model: "<synthetic>",
        content: [{ type: "text", text: input.text }],
      },
    }) as unknown as SDKMessage;

  const echo2Result = (uuid: string, failed: boolean): SDKMessage =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      ...(failed ? { terminal_reason: "api_error" } : {}),
      errors: [],
      usage: { input_tokens: 12, output_tokens: 34 },
      session_id: ECHO2_SDK_SESSION,
      uuid,
    }) as unknown as SDKMessage;

  // Reads the event store and the stored projection columns exercised by this
  // fixture. `project_memories` is
  // intentionally absent — the admitted memory's body legitimately lives there.
  const ECHO2_STORED_TEXT_STATEMENTS = [
    `SELECT payload_json AS "p" FROM orchestration_events`,
    `SELECT payload_json AS "p" FROM projection_thread_activities`,
    `SELECT text AS "p" FROM projection_thread_messages`,
    `SELECT last_error AS "p" FROM projection_thread_sessions`,
    `SELECT title AS "p" FROM projection_threads`,
  ] as const;

  it.live(
    "A-ECHO-2 supplementary: real adapter authentication_failed snapshot is withheld end-to-end while bounded controls pass",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const receipts = yield* Queue.unbounded<ProviderRuntimeEvent>();

        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-aecho2-"));
        const dbPath = NodePath.join(dir, "live.sqlite");

        const unsupported = () =>
          Effect.die(new Error("Unsupported provider call in test")) as never;
        // The adapter's stream has exactly one real consumer: ingestion. The
        // tap copies each taken event into `receipts`, so the receipt queue
        // holds precisely the events the guard processed — no second reader
        // races the single queue.
        const providerService: ProviderServiceShape = {
          startSession: () => unsupported(),
          sendTurn: () => unsupported(),
          previewSubmissionRoute: () => unsupported(),
          compactThread: () => unsupported(),
          interruptTurn: () => unsupported(),
          respondToRequest: () => unsupported(),
          respondToUserInput: () => unsupported(),
          stopSession: () => unsupported(),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
          getInstanceInfo: () => unsupported(),
          assertConversationRollbackSupported: () => unsupported(),
          rollbackConversation: () => unsupported(),
          uploadFeedback: () => unsupported(),
          streamEvents: adapter.streamEvents.pipe(
            // Production ProviderService stamps the bound instance id onto
            // every adapter event before fan-out
            // (correlateRuntimeEventWithInstance); the receipt tap runs after
            // the stamp, so receipts are exactly what the guard consumed.
            Stream.map((event) => ({ ...event, providerInstanceId: ECHO2_INSTANCE })),
            Stream.tap((event) => Queue.offer(receipts, event).pipe(Effect.asVoid)),
          ),
        };

        const persistence = makeSqlitePersistenceLive(dbPath);
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
          Layer.provideMerge(persistence),
          Layer.provideMerge(memoryLayers),
          Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
          Layer.provideMerge(NodeServices.layer),
        );

        const liveLayerScope = yield* Scope.make("sequential");
        const ingestionScope = yield* Scope.make("sequential");
        try {
          const context = yield* Layer.buildWithScope(layer, liveLayerScope);
          const live = Effect.provideContext(context);
          const engine = yield* live(Effect.service(OrchestrationEngineService));
          const snapshotQuery = yield* live(Effect.service(ProjectionSnapshotQuery));
          const ingestion = yield* live(Effect.service(ProviderRuntimeIngestionService));
          const gate = yield* live(Effect.service(ProjectMemorySendGate));
          const memories = yield* live(Effect.service(ProjectMemoryRepository));
          const sql = yield* live(Effect.service(SqlClient.SqlClient));
          yield* ingestion.start().pipe(Scope.provide(ingestionScope));

          const dispatch = (command: OrchestrationCommand) => live(engine.dispatch(command));
          const readThread = () =>
            live(
              Effect.map(snapshotQuery.getSnapshot(), (snapshot) =>
                snapshot.threads.find(
                  (entry): entry is OrchestrationThread => entry.id === ECHO2_THREAD,
                ),
              ),
            );
          const readAllStoredText = () =>
            live(
              Effect.gen(function* () {
                const chunks: string[] = [];
                for (const statement of ECHO2_STORED_TEXT_STATEMENTS) {
                  const rows = yield* sql.unsafe<{ readonly p: string | null }>(statement);
                  for (const row of rows) {
                    if (row.p !== null) chunks.push(row.p);
                  }
                }
                return chunks.join("\n");
              }),
            );

          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-aecho2-project-create"),
            projectId: ECHO2_PROJECT,
            title: "Echo2 Project",
            workspaceRoot: dir,
            defaultModelSelection: {
              instanceId: ECHO2_INSTANCE,
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
            createdAt: ECHO2_AT,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-aecho2-thread-create"),
            threadId: ECHO2_THREAD,
            projectId: ECHO2_PROJECT,
            title: "Echo2 thread",
            modelSelection: {
              instanceId: ECHO2_INSTANCE,
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: ECHO2_AT,
          });
          yield* dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-aecho2-session-seed"),
            threadId: ECHO2_THREAD,
            session: {
              threadId: ECHO2_THREAD,
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: ECHO2_AT,
            },
            createdAt: ECHO2_AT,
          });

          // The first turn's user message is the one that admitted the memory:
          // thread.turn.start, then gate.admit for that message, then the
          // provider send — the production order.
          const firstMessageId = MessageId.make("msg-aecho2-0");
          yield* dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-aecho2-turn-start-0"),
            threadId: ECHO2_THREAD,
            message: {
              messageId: firstMessageId,
              role: "user",
              text: "start streamed text",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: ECHO2_AT,
          });
          const inserted = yield* live(
            memories.insert({
              memoryId: ECHO2_MEMORY,
              projectId: ECHO2_PROJECT,
              kind: "fact",
              title: "Echo2 memory",
              body: "A-ECHO2-MEMORY-BODY-5c1d0a77",
              origin: { type: "manual" },
              validUntil: null,
              estimatedTokens: 12,
              now: ECHO2_AT,
            }),
          );
          assert.equal(inserted.status, "applied");
          const admitted = yield* live(
            gate.admit({
              threadId: ECHO2_THREAD,
              messageId: firstMessageId,
              projectId: ECHO2_PROJECT,
              providerInstanceId: ECHO2_INSTANCE,
              items: [{ memoryId: ECHO2_MEMORY, selectedVersion: 1 }],
              now: DateTime.makeUnsafe(ECHO2_AT),
            }),
          );
          assert.equal(admitted._tag, "Committed");

          yield* adapter.startSession({
            threadId: ECHO2_THREAD,
            provider: ProviderDriverKind.make("claudeAgent"),
            runtimeMode: "full-access",
          });

          const scenarios = [
            {
              name: "streamed text",
              marker: MARK_E2_STREAM,
              expectedText: MARK_E2_STREAM,
              frames: [
                {
                  type: "stream_event",
                  session_id: ECHO2_SDK_SESSION,
                  uuid: "stream-aecho2-delta",
                  parent_tool_use_id: null,
                  event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: MARK_E2_STREAM },
                  },
                } as unknown as SDKMessage,
              ],
              result: echo2Result("result-aecho2-stream", false),
              terminal: "completed",
              withheld: false,
            },
            {
              name: "normal assistant snapshot",
              marker: MARK_E2_SNAPSHOT,
              expectedText: MARK_E2_SNAPSHOT,
              frames: [
                echo2AssistantSnapshot({
                  uuid: "assistant-aecho2-normal",
                  text: MARK_E2_SNAPSHOT,
                }),
              ],
              result: echo2Result("result-aecho2-normal", false),
              terminal: "completed",
              withheld: false,
            },
            {
              name: "max_output_tokens assistant snapshot",
              marker: MARK_E2_MAXTOK,
              expectedText: MARK_E2_MAXTOK,
              frames: [
                echo2AssistantSnapshot({
                  uuid: "assistant-aecho2-maxtok",
                  text: MARK_E2_MAXTOK,
                  error: "max_output_tokens",
                }),
              ],
              result: echo2Result("result-aecho2-maxtok", false),
              terminal: "completed",
              withheld: false,
            },
            {
              name: "authentication_failed assistant snapshot",
              marker: MARK_E2_AUTH,
              expectedText: `Not logged in \u00b7 ${MARK_E2_AUTH} \u00b7 run /login`,
              frames: [
                echo2AssistantSnapshot({
                  uuid: "assistant-aecho2-auth",
                  text: `Not logged in \u00b7 ${MARK_E2_AUTH} \u00b7 run /login`,
                  error: "authentication_failed",
                }),
              ],
              result: echo2Result("result-aecho2-auth", true),
              terminal: "failed",
              withheld: true,
            },
          ] as const;

          const collectTurnEvents = (turnId: TurnId) =>
            Stream.fromQueue(receipts).pipe(
              Stream.takeUntil(
                (event) =>
                  event.type === "turn.completed" && String(event.turnId) === String(turnId),
              ),
              Stream.runCollect,
              Effect.forkChild,
            );

          // Captured on the withheld turn: the adapter-emitted diagnostics the
          // whole-store scan must not find. Receipts are pre-guard, so these
          // are the real provider strings.
          let providerErrorMessage = "";
          let withheldText = "";

          for (const [index, scenario] of scenarios.entries()) {
            if (index > 0) {
              yield* dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`cmd-aecho2-turn-start-${index}`),
                threadId: ECHO2_THREAD,
                message: {
                  messageId: MessageId.make(`msg-aecho2-${index}`),
                  role: "user",
                  text: `start scenario ${index}`,
                  attachments: [],
                },
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "full-access",
                createdAt: ECHO2_AT,
              });
            }
            const turn = yield* adapter.sendTurn({
              threadId: ECHO2_THREAD,
              input: `echo2 scenario ${index}`,
              attachments: [],
            });
            const collector = yield* collectTurnEvents(turn.turnId);
            for (const frame of scenario.frames) {
              harness.query.emit(frame);
            }
            harness.query.emit(scenario.result);
            const turnEvents = Array.from(yield* Fiber.join(collector)).filter(
              (event) => String(event.turnId) === String(turn.turnId),
            );
            yield* live(ingestion.drain);

            // Receipt side: the adapter really emitted this turn's start and
            // terminal, keeping the adapter-assigned turn identity.
            const turnStarted = turnEvents.find((event) => event.type === "turn.started");
            assert(turnStarted !== undefined, `missing turn.started receipt for ${scenario.name}`);
            const turnCompleted = turnEvents.find((event) => event.type === "turn.completed");
            if (turnCompleted === undefined || turnCompleted.type !== "turn.completed") {
              assert.fail(`missing turn.completed receipt for ${scenario.name}`);
              return;
            }
            assert.equal(String(turnCompleted.turnId), String(turn.turnId));
            assert.equal(turnCompleted.payload.state, scenario.terminal);

            const delta = turnEvents.find(
              (event): event is Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }> =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text",
            );
            if (delta === undefined) {
              assert.fail(`missing assistant delta receipt for ${scenario.name}`);
              return;
            }
            assert.equal(delta.payload.delta, scenario.expectedText);
            assert.equal(delta.provider, "claudeAgent");
            assert.strictEqual(delta.raw?.payload, scenario.frames[0]);
            assert.equal(delta.raw?.source, "claude.sdk.message");

            if (!scenario.withheld) {
              // Positive control: non-target shapes pass the guard untouched on
              // the same tainted thread and persist verbatim.
              assert.equal(
                scenario.name === "streamed text"
                  ? delta.raw?.method === "claude/stream_event/content_block_delta"
                  : delta.raw?.method === "claude/assistant",
                true,
              );
              const stored = yield* readThread();
              assert.equal(
                stored?.messages.some(
                  (message) =>
                    message.role === "assistant" && message.text.includes(scenario.marker),
                ),
                true,
              );
              assert.equal(
                stored?.messages.some((message) => message.text === MEMORY_ECHO_WITHHELD_ERROR) ??
                  false,
                false,
              );
            } else {
              const itemCompleted = turnEvents.find(
                (
                  event,
                ): event is Extract<ProviderRuntimeEvent, { readonly type: "item.completed" }> =>
                  event.type === "item.completed" && event.payload.itemType === "assistant_message",
              );
              if (itemCompleted === undefined) {
                assert.fail("missing assistant_message item.completed receipt");
                return;
              }
              assert.equal(delta.raw?.method, "claude/assistant");
              assert.equal(itemCompleted.payload.detail, scenario.expectedText);
              assert.equal(itemCompleted.raw?.method, "claude/assistant");
              assert.strictEqual(itemCompleted.raw?.payload, scenario.frames[0]);
              const rawPayload = itemCompleted.raw?.payload as
                | { readonly type?: unknown; readonly error?: unknown }
                | undefined;
              assert.equal(rawPayload?.type, "assistant");
              assert.equal(rawPayload?.error, "authentication_failed");

              const runtimeError = turnEvents.find(
                (
                  event,
                ): event is Extract<ProviderRuntimeEvent, { readonly type: "runtime.error" }> =>
                  event.type === "runtime.error",
              );
              if (runtimeError === undefined) {
                assert.fail("missing runtime.error receipt");
                return;
              }
              providerErrorMessage = runtimeError.payload.message;
              assert(providerErrorMessage.length > 0);
              assert.equal(turnCompleted.payload.errorMessage, providerErrorMessage);
              assert(turnCompleted.payload.tokenUsage !== undefined);
              withheldText = scenario.expectedText;

              // Stored side after the drain seal: every covered field carries
              // only the fixed withheld phrase; identity, the failed terminal
              // state, and the typed usage survive.
              const stored = yield* readThread();
              assert.equal(
                stored?.messages.some((message) => message.text.includes(scenario.marker)) ?? false,
                false,
              );
              assert.equal(
                stored?.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    String(message.turnId) === String(turn.turnId) &&
                    message.text === MEMORY_ECHO_WITHHELD_ERROR,
                ),
                true,
              );
              assert.equal(stored?.session?.status, "error");
              assert.equal(stored?.session?.lastError, MEMORY_ECHO_WITHHELD_ERROR);
              assert.equal(String(stored?.latestTurn?.turnId), String(turn.turnId));
              assert.equal(stored?.latestTurn?.state, "error");
              const errorActivity = stored?.activities.find(
                (activity) =>
                  activity.kind === "runtime.error" && activity.id === runtimeError.eventId,
              );
              assert.deepEqual(errorActivity?.payload, {
                message: MEMORY_ECHO_WITHHELD_ERROR,
              });
              const usageActivity = stored?.activities.find(
                (activity) =>
                  activity.kind === OWNED_USAGE_ACTIVITY_KIND &&
                  String(activity.turnId) === String(turn.turnId),
              );
              if (usageActivity === undefined) {
                assert.fail("missing owned-usage activity for the failed turn");
                return;
              }
              const observation = usageActivity.payload as
                | {
                    readonly terminal?: unknown;
                    readonly usage?: unknown;
                    readonly source?: {
                      readonly driver?: unknown;
                      readonly instanceId?: unknown;
                      readonly turnId?: unknown;
                      readonly runtimeEventId?: unknown;
                    };
                  }
                | undefined;
              assert.equal(observation?.terminal, "failed");
              assert.deepEqual(observation?.usage, turnCompleted.payload.tokenUsage);
              assert.equal(observation?.source?.driver, "claudeAgent");
              assert.equal(observation?.source?.instanceId, "claudeAgent");
              assert.equal(String(observation?.source?.turnId), String(turn.turnId));
              assert.equal(observation?.source?.runtimeEventId, turnCompleted.eventId);
            }
          }

          assert(withheldText.length > 0);
          assert(providerErrorMessage.length > 0);

          // Zero-marker over the stored fields this fixture wrote: the snapshot
          // text, the observed provider diagnostic, and the SDK error literal
          // survive only inside the retained raw payloads — never persisted.
          const storedText = yield* readAllStoredText();
          assert.equal(storedText.includes(withheldText), false);
          assert.equal(storedText.includes(MARK_E2_AUTH), false);
          assert.equal(storedText.includes(providerErrorMessage), false);
          assert.equal(storedText.includes("authentication_failed"), false);
          // The earlier controls' stored markers are still there: the
          // prospective guard rewrites nothing already persisted.
          for (const marker of [MARK_E2_STREAM, MARK_E2_SNAPSHOT, MARK_E2_MAXTOK]) {
            assert.equal(storedText.includes(marker), true);
          }
        } finally {
          yield* Scope.close(ingestionScope, Exit.void);
          yield* Scope.close(liveLayerScope, Exit.void);
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Lane B C1–C8: the adapter's synchronous admission gate runs on each actual
  // publish path — after the send's last await and immediately before the
  // prompt offer — observing the publishing context's generation and durable
  // session id. A refusal publishes no prompt and no turn boundary and leaves
  // turn state unchanged; a call without admission is unchanged.
  const CLAUDE_MOVED_SESSION_ID = "550e8400-e29b-41d4-a716-446655440099";

  const memoryAdmissionOf = (adapter: ClaudeAdapterShape) => {
    const support = adapter.memoryAdmission;
    if (support === undefined) {
      throw new Error("the Claude adapter must expose memoryAdmission support");
    }
    return support;
  };

  interface ExpectedAdmission {
    readonly sessionGeneration: number;
    readonly nativeSessionId: string | undefined;
  }

  // What a memory-bearing caller captures before its awaited rechecks: the
  // generation of the context open now plus the id its resume cursor binds.
  const captureExpectedAdmission = (
    support: NonNullable<ClaudeAdapterShape["memoryAdmission"]>,
    session: { readonly threadId: ThreadId; readonly resumeCursor?: unknown },
  ): ExpectedAdmission => {
    const sessionGeneration = support.sessionGeneration(session.threadId);
    if (sessionGeneration === undefined) {
      throw new Error("expected an open session generation");
    }
    return {
      sessionGeneration,
      nativeSessionId: support.nativeSessionId(session.resumeCursor),
    };
  };

  // The admit half of that binding: accepts only the exact captured
  // observation, recording every call so tests can count and inspect the gate.
  const recordingAdmission = (
    expected: ExpectedAdmission,
    calls: Array<ProviderAdmissionObservation>,
  ): ProviderSendTurnAdmission => ({
    admit: (observed) => {
      calls.push(observed);
      return (
        observed.sessionGeneration === expected.sessionGeneration &&
        observed.nativeSessionId === expected.nativeSessionId
      );
    },
  });

  const startClaudeTestSession = (adapter: ClaudeAdapterShape, threadId: ThreadId = THREAD_ID) =>
    adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });

  it.effect("reports a fresh session generation per context and none once stopped", () => {
    const harness = makeHarness({ getSessionMessages: async () => [] });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      assert.isUndefined(support.sessionGeneration(THREAD_ID));

      yield* startClaudeTestSession(adapter);
      const first = support.sessionGeneration(THREAD_ID);
      assert.isDefined(first);

      // A second startSession on the same thread replaces the context.
      yield* startClaudeTestSession(adapter);
      const replaced = support.sessionGeneration(THREAD_ID);
      assert.isDefined(replaced);
      assert.notEqual(replaced, first);

      yield* adapter.stopSession(THREAD_ID);
      assert.isUndefined(support.sessionGeneration(THREAD_ID));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("moves the session generation when rollback restarts the session", () => {
    const harness = makeHarness({ getSessionMessages: async () => [] });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      yield* startClaudeTestSession(adapter);
      const first = support.sessionGeneration(THREAD_ID);
      assert.isDefined(first);

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
      yield* adapter.rollbackThread(THREAD_ID, 1);

      const restarted = support.sessionGeneration(THREAD_ID);
      assert.isDefined(restarted);
      assert.notEqual(restarted, first);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("parses the native session id from a resume cursor purely", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);

      assert.equal(
        support.nativeSessionId({ resume: CLAUDE_MOVED_SESSION_ID }),
        CLAUDE_MOVED_SESSION_ID,
      );
      // Legacy cursors carried the id under `sessionId`.
      assert.equal(
        support.nativeSessionId({ sessionId: CLAUDE_MOVED_SESSION_ID }),
        CLAUDE_MOVED_SESSION_ID,
      );
      assert.isUndefined(support.nativeSessionId({ resume: "not-a-uuid" }));
      assert.isUndefined(support.nativeSessionId(undefined));
      assert.isUndefined(support.nativeSessionId({}));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("admits a send whose observation matches the fresh session's generated id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.started",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const session = yield* startClaudeTestSession(adapter);
      // A fresh session binds a generated UUID before any provider turn.
      const expected = captureExpectedAdmission(support, session);
      assert.isString(expected.nativeSessionId);

      const calls: Array<ProviderAdmissionObservation> = [];
      const turn = yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "hello", attachments: [] },
        recordingAdmission(expected, calls),
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], expected);

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 1),
      );
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.uuid, String(turn.turnId));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.filter((event) => event.type === "turn.started");
      assert.equal(started.length, 1);
      assert.equal(String(started[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs the admission gate once, after the send's last SDK await", () => {
    const harness = makeHarness();
    const modelGate = harness.query.gateSetModel(1);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.started",
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const session = yield* startClaudeTestSession(adapter);
      const expected = captureExpectedAdmission(support, session);

      const calls: Array<ProviderAdmissionObservation> = [];
      const send = yield* adapter
        .sendTurn(
          {
            threadId: THREAD_ID,
            input: "change model",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_CAPABLE_MODEL,
            ),
            attachments: [],
          },
          recordingAdmission(expected, calls),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      // Parked inside the SDK setModel call, before admission.
      assert.equal(harness.query.setModelCalls.length, 1);
      assert.isUndefined(send.pollUnsafe());
      assert.equal(calls.length, 0);

      modelGate.resolve();
      const turn = yield* Fiber.join(send);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.sessionGeneration, expected.sessionGeneration);
      assert.equal(calls[0]?.nativeSessionId, expected.nativeSessionId);
      // The send's modelSelection made the route provable, so the admission
      // also carried a candidate: the exact published text plus a real digest.
      assert.deepEqual(calls[0]?.submissionCandidate?.textBlocks, ["change model"]);
      assert.match(calls[0]?.submissionCandidate?.routeConfigSha256 ?? "", /^[0-9a-f]{64}$/u);

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 1),
      );
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.uuid, String(turn.turnId));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
    }).pipe(
      Effect.ensuring(Effect.sync(() => modelGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("publishes nothing and keeps the turn untouched when admission refuses", () => {
    const harness = makeHarness();
    const admissionThrowMarker = "secret-marker-admission-throw";
    const logs: Array<string> = [];
    const logCapture = Logger.make((options) => {
      logs.push(NodeUtil.inspect(options));
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* startClaudeTestSession(adapter);

      const calls: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          { threadId: THREAD_ID, input: "withheld", attachments: [] },
          {
            admit: (observed) => {
              calls.push(observed);
              return false;
            },
          },
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      assert.equal(calls.length, 1);

      // A throwing gate fails the send the same closed way: the foreign error
      // is neither attached to the fixed error nor written to the logs.
      const thrown = yield* adapter
        .sendTurn(
          { threadId: THREAD_ID, input: "withheld by throw", attachments: [] },
          {
            admit: (observed) => {
              calls.push(observed);
              throw new Error(admissionThrowMarker);
            },
          },
        )
        .pipe(Effect.result);
      assert.equal(thrown._tag, "Failure");
      if (thrown._tag === "Failure") {
        assert.instanceOf(thrown.failure, ProviderAdapterSessionClosedError);
        assert.isFalse(NodeUtil.inspect(thrown.failure).includes(admissionThrowMarker));
      }
      assert.equal(calls.length, 2);
      assert.isFalse(logs.some((line) => line.includes(admissionThrowMarker)));

      // Turn state is untouched: still ready, no active turn, no turn published.
      const listed = yield* adapter.listSessions();
      assert.equal(listed[0]?.status, "ready");
      assert.isUndefined(listed[0]?.activeTurnId);
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);

      // The ordinary path is unchanged: a send without admission publishes.
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "ordinary",
        attachments: [],
      });
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the ordinary send's prompt was not queued");
        return;
      }
      assert.equal(promptTextOf(prompt), "ordinary");
      assert.equal(prompt.uuid, String(turn.turnId));

      yield* startClaudeTestSession(adapter, SWEEP_SENTINEL_THREAD_ID);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const threadTurns = events.filter(
        (event) => event.type === "turn.started" && event.threadId === THREAD_ID,
      );
      assert.equal(threadTurns.length, 1);
      assert.equal(String(threadTurns[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(
        Layer.merge(harness.layer, Logger.layer([logCapture], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("refuses a send whose captured generation precedes a session replacement", () => {
    const harness = makeHarness({ getSessionMessages: async () => [] });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const firstSession = yield* startClaudeTestSession(adapter);
      const stale = captureExpectedAdmission(support, firstSession);

      yield* startClaudeTestSession(adapter);

      const calls: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          { threadId: THREAD_ID, input: "withheld", attachments: [] },
          recordingAdmission(stale, calls),
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      // The gate ran once, on the replacement context: it saw that context's
      // generation, not the captured one.
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.sessionGeneration, support.sessionGeneration(THREAD_ID));
      assert.notEqual(calls[0]?.sessionGeneration, stale.sessionGeneration);

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "ordinary",
        attachments: [],
      });
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the ordinary send's prompt was not queued");
        return;
      }
      assert.equal(promptTextOf(prompt), "ordinary");
      assert.equal(prompt.uuid, String(turn.turnId));

      yield* startClaudeTestSession(adapter, SWEEP_SENTINEL_THREAD_ID);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const threadTurns = events.filter(
        (event) => event.type === "turn.started" && event.threadId === THREAD_ID,
      );
      assert.equal(threadTurns.length, 1);
      assert.equal(String(threadTurns[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails a parked send replaced before admission without invoking the gate", () => {
    const harness = makeHarness({ getSessionMessages: async () => [] });
    const modelGate = harness.query.gateSetModel(1);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      const session = yield* startClaudeTestSession(adapter);
      const expected = captureExpectedAdmission(support, session);

      const calls: Array<ProviderAdmissionObservation> = [];
      const send = yield* adapter
        .sendTurn(
          {
            threadId: THREAD_ID,
            input: "change model",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_CAPABLE_MODEL,
            ),
            attachments: [],
          },
          recordingAdmission(expected, calls),
        )
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      // Parked inside the SDK setModel call, before admission.
      assert.equal(harness.query.setModelCalls.length, 1);
      assert.isUndefined(send.pollUnsafe());

      // The parked send's context is replaced underneath it.
      yield* startClaudeTestSession(adapter);

      const sent = yield* Fiber.join(send);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      // The open check refused first, so the gate never ran.
      assert.equal(calls.length, 0);

      // The replacement context received nothing from the parked send.
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "ordinary",
        attachments: [],
      });
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the ordinary send's prompt was not queued");
        return;
      }
      assert.equal(promptTextOf(prompt), "ordinary");
      assert.equal(prompt.uuid, String(turn.turnId));
    }).pipe(
      Effect.ensuring(Effect.sync(() => modelGate.resolve())),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses a send after the SDK moves the durable session id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const support = memoryAdmissionOf(adapter);
      const eventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.threadId === SWEEP_SENTINEL_THREAD_ID,
      ).pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const session = yield* startClaudeTestSession(adapter);
      const expected = captureExpectedAdmission(support, session);

      // A durable frame re-keys the session (e.g. a resumed fork): both the
      // observed id and the generation move.
      const streamIdle = untilStreamIdle(harness.query);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        session_id: CLAUDE_MOVED_SESSION_ID,
        uuid: "result-moved-session",
      } as unknown as SDKMessage);
      yield* Effect.promise(() => streamIdle);

      const moved = support.sessionGeneration(THREAD_ID);
      assert.isDefined(moved);
      assert.notEqual(moved, expected.sessionGeneration);
      const movedCursor = (yield* adapter.listSessions())[0]?.resumeCursor;
      assert.equal(support.nativeSessionId(movedCursor), CLAUDE_MOVED_SESSION_ID);

      const calls: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          { threadId: THREAD_ID, input: "withheld", attachments: [] },
          recordingAdmission(expected, calls),
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.nativeSessionId, CLAUDE_MOVED_SESSION_ID);
      assert.equal(calls[0]?.sessionGeneration, moved);

      // A caller that re-captures the moved session is admitted normally.
      const movedSession = (yield* adapter.listSessions())[0];
      if (movedSession === undefined) {
        assert.fail("the moved session is missing");
        return;
      }
      const recaptured = captureExpectedAdmission(support, movedSession);
      const admittedCalls: Array<ProviderAdmissionObservation> = [];
      const turn = yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "ordinary", attachments: [] },
        recordingAdmission(recaptured, admittedCalls),
      );
      assert.equal(admittedCalls.length, 1);
      assert.deepEqual(admittedCalls[0], recaptured);
      assert.equal(admittedCalls[0]?.sessionGeneration, moved);
      assert.equal(admittedCalls[0]?.nativeSessionId, CLAUDE_MOVED_SESSION_ID);

      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the ordinary send's prompt was not queued");
        return;
      }
      assert.equal(promptTextOf(prompt), "ordinary");
      assert.equal(prompt.uuid, String(turn.turnId));

      yield* startClaudeTestSession(adapter, SWEEP_SENTINEL_THREAD_ID);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const threadTurns = events.filter(
        (event) => event.type === "turn.started" && event.threadId === THREAD_ID,
      );
      assert.equal(threadTurns.length, 1);
      assert.equal(String(threadTurns[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // C2 managed capture: the publish-step admission reports a submission
  // candidate — the exact text blocks of the built SDK user message plus the
  // digest of this context's route profile — only when every profile field is
  // provable from real state. Anything unprovable (no model, an unaccounted
  // launch arg) yields an ordinary admitted send with no candidate.
  const C2_CAPABLE_SELECTION = createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  );
  const C2_API_MODEL = `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`;
  const C2_INSTANCE = ProviderInstanceId.make("claudeAgent");

  const textBlocksOf = (message: SDKUserMessage): ReadonlyArray<string> => {
    const content = message.message.content;
    return Array.isArray(content)
      ? content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      : [];
  };

  // The frozen key order of "oop-claude-route/v1": reproduced here so the
  // expected digest is derived independently of the implementation.
  const CLAUDE_ROUTE_PROFILE_KEYS = [
    "alwaysThinkingEnabled",
    "apiModel",
    "argumentThinkingDisplay",
    "autoCompactWindow",
    "driver",
    "fastMode",
    "launchEffort",
    "permissionMode",
    "promptInjectedEffort",
    "providerInstanceId",
    "queryThinkingDisplay",
    "settingSources",
    "showThinkingSummaries",
    "subagentDefaultEffort",
    "systemPromptAppendSha256",
    "systemPromptPreset",
    "ultracode",
    "v",
  ] as const;

  const sha256HexUtf8 = (text: string): string =>
    NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

  // The digest a correct candidate must carry: launch-fixed fields re-read
  // from the exact options the session was created with, volatile fields
  // supplied by the test that tracked the send's post-setter state.
  const expectedRouteConfigSha256 = (input: {
    readonly options: ClaudeQueryOptions;
    readonly apiModel: string;
    readonly permissionMode: string;
    readonly subagentDefaultEffort: string | null;
    readonly promptInjectedEffort: string | null;
  }): string => {
    const systemPromptOption = input.options.systemPrompt;
    const systemPromptPreset =
      typeof systemPromptOption === "object" &&
      systemPromptOption !== null &&
      !Array.isArray(systemPromptOption) &&
      systemPromptOption.type === "preset"
        ? systemPromptOption
        : undefined;
    const settings = (input.options.settings ?? {}) as unknown as {
      readonly alwaysThinkingEnabled?: boolean;
      readonly showThinkingSummaries?: boolean;
      readonly fastMode?: boolean;
      readonly ultracode?: boolean;
      readonly autoCompactWindow?: number;
    };
    const thinkingOption = input.options.thinking;
    return sha256HexUtf8(
      JSON.stringify(
        {
          v: "oop-claude-route/v1",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          apiModel: input.apiModel,
          permissionMode: input.permissionMode,
          launchEffort: input.options.effort ?? null,
          subagentDefaultEffort: input.subagentDefaultEffort,
          promptInjectedEffort: input.promptInjectedEffort,
          queryThinkingDisplay:
            thinkingOption !== undefined && "display" in thinkingOption
              ? (thinkingOption.display ?? null)
              : null,
          argumentThinkingDisplay: input.options.extraArgs?.["thinking-display"] ?? null,
          alwaysThinkingEnabled: settings.alwaysThinkingEnabled ?? null,
          showThinkingSummaries: settings.showThinkingSummaries ?? null,
          fastMode: settings.fastMode ?? null,
          ultracode: settings.ultracode ?? null,
          autoCompactWindow: settings.autoCompactWindow ?? null,
          settingSources: input.options.settingSources ?? [],
          systemPromptPreset: systemPromptPreset?.preset ?? null,
          systemPromptAppendSha256:
            typeof systemPromptPreset?.append === "string"
              ? sha256HexUtf8(systemPromptPreset.append)
              : null,
        },
        [...CLAUDE_ROUTE_PROFILE_KEYS],
      ),
    );
  };

  const startModeledSession = (adapter: ClaudeAdapterShape, threadId: ThreadId = THREAD_ID) =>
    adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
      modelSelection: C2_CAPABLE_SELECTION,
    });

  const observingAdmission = (
    calls: Array<ProviderAdmissionObservation>,
  ): ProviderSendTurnAdmission => ({
    admit: (observed) => {
      calls.push(observed);
      return true;
    },
  });

  const previewRouteOf = (adapter: ClaudeAdapterShape) => {
    const previewRoute = adapter.previewSubmissionRoute;
    if (previewRoute === undefined) {
      assert.fail("the Claude adapter must support route previews");
    }
    return previewRoute;
  };

  // Mirrors the service's use seam at the gate: the veto judges the actual
  // routed observation first — only a verified publish reaches the observer.
  const useCheckedAdmission = (
    expected: ProviderSubmissionRoutePreview,
    observed: Array<ProviderAdmissionObservation>,
  ): ProviderSendTurnAdmission => ({
    admit: (actual) => {
      if (
        actual.submissionCandidate === undefined ||
        actual.sessionGeneration !== expected.sessionGeneration ||
        actual.nativeSessionId !== expected.nativeSessionId ||
        actual.submissionCandidate.routeConfigSha256 !== expected.routeConfigSha256
      ) {
        return false;
      }
      observed.push(actual);
      return true;
    },
  });

  it.effect("captures the exact published text blocks and the frozen route digest", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-c2-blocks-"));
    const homeDir = NodePath.join(baseDir, "claude-home");
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "implement"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "implement", "SKILL.md"),
      "---\ndescription: Implement the tickets.\n---\n# Body\n",
    );
    const harness = makeHarness({ baseDir, claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-claude-c2-attachment-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      yield* startModeledSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        {
          threadId: THREAD_ID,
          input: "please $implement the tickets\nstart with auth",
          attachments: [attachment],
        },
        observingAdmission(calls),
      );

      // The queued message carried an image block between two text blocks —
      // the candidate is exactly its text blocks, nothing else.
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the send's prompt was not queued");
        return;
      }
      assert.equal(calls.length, 1);
      const candidate = calls[0]?.submissionCandidate;
      assert.isDefined(candidate);
      assert.deepEqual(candidate?.textBlocks, [
        "please",
        "/implement the tickets\nstart with auth",
      ]);
      assert.deepEqual(candidate?.textBlocks, textBlocksOf(prompt));
      const options = harness.getLastCreateQueryInput()?.options;
      assert.isDefined(options);
      assert.equal(
        candidate?.routeConfigSha256,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: C2_API_MODEL,
          permissionMode: "bypassPermissions",
          subagentDefaultEffort: "high",
          promptInjectedEffort: null,
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("tracks post-setter model and permission mode while launch fields stay frozen", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const options = harness.getLastCreateQueryInput()?.options;
      assert.isDefined(options);

      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "baseline", attachments: [] },
        observingAdmission(calls),
      );
      const baseline = calls[0]?.submissionCandidate?.routeConfigSha256;
      assert.equal(
        baseline,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: C2_API_MODEL,
          permissionMode: "bypassPermissions",
          subagentDefaultEffort: "high",
          promptInjectedEffort: null,
        }),
      );

      // A successful permission-mode setter moves the profile's volatile
      // field — the digest changes on exactly that.
      yield* adapter.sendTurn(
        {
          threadId: THREAD_ID,
          input: "plan it",
          interactionMode: "plan",
          attachments: [],
        },
        observingAdmission(calls),
      );
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
      const planHash = calls[1]?.submissionCandidate?.routeConfigSha256;
      assert.equal(
        planHash,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: C2_API_MODEL,
          permissionMode: "plan",
          subagentDefaultEffort: "high",
          promptInjectedEffort: null,
        }),
      );
      assert.notEqual(planHash, baseline);

      // The default interaction mode restores the launch permission mode.
      yield* adapter.sendTurn(
        {
          threadId: THREAD_ID,
          input: "back to work",
          interactionMode: "default",
          attachments: [],
        },
        observingAdmission(calls),
      );
      assert.equal(calls[2]?.submissionCandidate?.routeConfigSha256, baseline);

      // A successful model setter moves apiModel; the launch-fixed fields
      // (effort "high" included) are untouched.
      yield* adapter.sendTurn(
        {
          threadId: THREAD_ID,
          input: "switch model",
          modelSelection: createModelSelection(C2_INSTANCE, SYNTHETIC_CLAUDE_STANDARD_MODEL),
          attachments: [],
        },
        observingAdmission(calls),
      );
      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
      ]);
      const standardHash = calls[3]?.submissionCandidate?.routeConfigSha256;
      assert.equal(
        standardHash,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
          permissionMode: "bypassPermissions",
          subagentDefaultEffort: "high",
          promptInjectedEffort: null,
        }),
      );
      assert.notEqual(standardHash, baseline);

      // A send without a selection retains the post-setter model: identical
      // fields, identical digest.
      yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "keep going", attachments: [] },
        observingAdmission(calls),
      );
      assert.equal(calls[4]?.submissionCandidate?.routeConfigSha256, standardHash);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("marks a prompt-injected effort in both the digest and the transformed block", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const options = harness.getLastCreateQueryInput()?.options;
      assert.isDefined(options);

      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        {
          threadId: THREAD_ID,
          input: "think hard about this",
          modelSelection: createModelSelection(C2_INSTANCE, SYNTHETIC_CLAUDE_CAPABLE_MODEL, [
            { id: "effort", value: "ultrathink" },
          ]),
          attachments: [],
        },
        observingAdmission(calls),
      );

      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      if (prompt === undefined) {
        assert.fail("the send's prompt was not queued");
        return;
      }
      const candidate = calls[0]?.submissionCandidate;
      // The observed block is the transformed prompt — the prefix the SDK
      // will actually see, not the raw input.
      assert.deepEqual(candidate?.textBlocks, ["Ultrathink:\nthink hard about this"]);
      assert.deepEqual(candidate?.textBlocks, textBlocksOf(prompt));
      // Ultrathink is prompt-injected: selecting it never moves the SDK's
      // effort option (resolveDescriptorChoiceValue resolves a
      // prompt-injected selection back to the "high" default), so the
      // session effort subagents inherit stays "high" and only
      // promptInjectedEffort records the injected keyword.
      assert.equal(
        candidate?.routeConfigSha256,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: C2_API_MODEL,
          permissionMode: "bypassPermissions",
          subagentDefaultEffort: "high",
          promptInjectedEffort: "ultrathink",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "leaves the tracked route fields unchanged when a setter fails before admission",
    () => {
      const harness = makeHarness();
      const modelGate = harness.query.gateSetModel(1);
      const modeGate = harness.query.gatePermissionMode(1);
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* startModeledSession(adapter);
        const options = harness.getLastCreateQueryInput()?.options;
        assert.isDefined(options);

        const baselineCalls: Array<ProviderAdmissionObservation> = [];
        yield* adapter.sendTurn(
          { threadId: THREAD_ID, input: "baseline", attachments: [] },
          observingAdmission(baselineCalls),
        );
        const baseline = baselineCalls[0]?.submissionCandidate?.routeConfigSha256;
        assert.isDefined(baseline);

        // The model setter rejects: the send fails before the publish step, so
        // the gate is never consulted and nothing is captured.
        const failingModelCalls: Array<ProviderAdmissionObservation> = [];
        const failedModel = yield* adapter
          .sendTurn(
            {
              threadId: THREAD_ID,
              input: "switch model",
              modelSelection: createModelSelection(C2_INSTANCE, SYNTHETIC_CLAUDE_STANDARD_MODEL),
              attachments: [],
            },
            observingAdmission(failingModelCalls),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.equal(harness.query.setModelCalls.length, 1);
        modelGate.reject(new Error("setModel blew up"));
        const failedModelExit = yield* Fiber.await(failedModel);
        assert.isTrue(Exit.isFailure(failedModelExit));
        assert.equal(failingModelCalls.length, 0);

        // Same for the permission-mode setter: no admission, no candidate, and
        // the tracked mode stays the launch one.
        const failingModeCalls: Array<ProviderAdmissionObservation> = [];
        const failedMode = yield* adapter
          .sendTurn(
            {
              threadId: THREAD_ID,
              input: "plan it",
              interactionMode: "plan",
              attachments: [],
            },
            observingAdmission(failingModeCalls),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.equal(harness.query.setPermissionModeCalls.length, 1);
        modeGate.reject(new Error("setPermissionMode blew up"));
        const failedModeExit = yield* Fiber.await(failedMode);
        assert.isTrue(Exit.isFailure(failedModeExit));
        assert.equal(failingModeCalls.length, 0);

        const afterCalls: Array<ProviderAdmissionObservation> = [];
        yield* adapter.sendTurn(
          { threadId: THREAD_ID, input: "still baseline", attachments: [] },
          observingAdmission(afterCalls),
        );
        assert.equal(afterCalls[0]?.submissionCandidate?.routeConfigSha256, baseline);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            modelGate.resolve();
            modeGate.resolve();
          }),
        ),
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("reports no candidate when the session was started without a model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startClaudeTestSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      const turn = yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "unmodeled", attachments: [] },
        observingAdmission(calls),
      );
      // The send is ordinary and publishes; only the candidate is missing —
      // apiModel cannot be proven so no managed capture may be claimed.
      assert.isDefined(turn.turnId);
      assert.equal(calls.length, 1);
      assert.isDefined(calls[0]?.sessionGeneration);
      assert.isString(calls[0]?.nativeSessionId);
      assert.isUndefined(calls[0]?.submissionCandidate);
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(prompt);
      assert.equal(promptTextOf(prompt!), "unmodeled");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports no candidate when a launch arg escapes the accounted set", () => {
    const harness = makeHarness({ claudeConfig: { launchArgs: "--verbose" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "ordinary still", attachments: [] },
        observingAdmission(calls),
      );
      // The flag rode to the SDK unchanged; only the capture is withheld.
      assert.equal(calls.length, 1);
      assert.isUndefined(calls[0]?.submissionCandidate);
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(prompt);
      assert.equal(promptTextOf(prompt!), "ordinary still");
      // Thinking summaries are on by default, so the adapter adds the
      // accounted thinking-display arg itself; only the foreign --verbose
      // flag is what withholds the candidate.
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.extraArgs, {
        verbose: null,
        "thinking-display": "summarized",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports no candidate for a bare thinking-display flag", () => {
    const harness = makeHarness({ claudeConfig: { launchArgs: "--thinking-display" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "ordinary still", attachments: [] },
        observingAdmission(calls),
      );
      assert.equal(calls.length, 1);
      assert.isUndefined(calls[0]?.submissionCandidate);
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(prompt);
      assert.equal(promptTextOf(prompt!), "ordinary still");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("carries the accounted thinking-display arg inside the digested profile", () => {
    const harness = makeHarness({
      claudeConfig: { launchArgs: "--thinking-display summarized" },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      yield* adapter.sendTurn(
        { threadId: THREAD_ID, input: "summarize my thinking", attachments: [] },
        observingAdmission(calls),
      );
      const candidate = calls[0]?.submissionCandidate;
      assert.isDefined(candidate);
      const options = harness.getLastCreateQueryInput()?.options;
      assert.isDefined(options);
      // The launch arg and the query thinking option it produced are both
      // digest inputs.
      assert.equal(
        candidate?.routeConfigSha256,
        expectedRouteConfigSha256({
          options: options!,
          apiModel: C2_API_MODEL,
          permissionMode: "bypassPermissions",
          subagentDefaultEffort: "high",
          promptInjectedEffort: null,
        }),
      );
      assert.equal(options?.extraArgs?.["thinking-display"], "summarized");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("observes the candidate at a refused gate while publishing nothing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const calls: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          { threadId: THREAD_ID, input: "withheld", attachments: [] },
          {
            admit: (observed) => {
              calls.push(observed);
              return false;
            },
          },
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      // The observation is built before the verdict — the gate saw the
      // candidate even though its refusal left nothing published.
      assert.equal(calls.length, 1);
      assert.isDefined(calls[0]?.submissionCandidate);
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
      const listed = yield* adapter.listSessions();
      assert.isUndefined(listed[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "projects the route a matching send actually publishes under without touching the SDK",
    () => {
      const harness = makeHarness({ instanceId: C2_INSTANCE });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const support = memoryAdmissionOf(adapter);
        yield* startModeledSession(adapter);
        const modelCallsBefore = harness.query.setModelCalls.length;
        const permissionCallsBefore = harness.query.setPermissionModeCalls.length;
        const createInputBefore = harness.getLastCreateQueryInput();
        const sendInput = {
          threadId: THREAD_ID,
          input: "switch to the standard model",
          modelSelection: createModelSelection(C2_INSTANCE, SYNTHETIC_CLAUDE_STANDARD_MODEL),
          attachments: [],
        };
        const preview = yield* previewRouteOf(adapter)(sendInput);
        assert.isDefined(preview);
        const listed = yield* adapter.listSessions();
        assert.equal(preview?.sessionGeneration, support.sessionGeneration(THREAD_ID));
        assert.equal(preview?.nativeSessionId, support.nativeSessionId(listed[0]?.resumeCursor));
        assert.match(preview?.routeConfigSha256 ?? "", /^[0-9a-f]{64}$/u);
        // The projection is a pure read of the open context: no new query,
        // no setter, nothing queued.
        assert.strictEqual(harness.getLastCreateQueryInput(), createInputBefore);
        assert.equal(harness.query.setModelCalls.length, modelCallsBefore);
        assert.equal(harness.query.setPermissionModeCalls.length, permissionCallsBefore);
        // The real send then publishes under exactly the previewed route —
        // the verdict that accepted this preview admits this publish.
        const observed: Array<ProviderAdmissionObservation> = [];
        yield* adapter.sendTurn(sendInput, useCheckedAdmission(preview!, observed));
        assert.equal(observed.length, 1);
        assert.equal(
          observed[0]?.submissionCandidate?.routeConfigSha256,
          preview?.routeConfigSha256,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("refuses the publish when the projected model drifts before use", () => {
    const harness = makeHarness({ instanceId: C2_INSTANCE });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const preview = yield* previewRouteOf(adapter)({
        threadId: THREAD_ID,
        input: "a",
        modelSelection: C2_CAPABLE_SELECTION,
        attachments: [],
      });
      assert.isDefined(preview);
      const observed: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          {
            threadId: THREAD_ID,
            input: "a",
            modelSelection: createModelSelection(C2_INSTANCE, SYNTHETIC_CLAUDE_STANDARD_MODEL),
            attachments: [],
          },
          useCheckedAdmission(preview!, observed),
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      if (sent._tag === "Failure") {
        assert.instanceOf(sent.failure, ProviderAdapterSessionClosedError);
      }
      // The veto refused before the observer and before anything queued —
      // the turn itself was never started.
      assert.equal(observed.length, 0);
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
      const listed = yield* adapter.listSessions();
      assert.isUndefined(listed[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses the publish when the projected permission drifts before use", () => {
    const harness = makeHarness({ instanceId: C2_INSTANCE });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      // Preview without an interaction mode: the session's current
      // permission. The actual send arrives in plan mode — the post-setter
      // profile drifts, so the veto refuses.
      const preview = yield* previewRouteOf(adapter)({
        threadId: THREAD_ID,
        input: "a",
        modelSelection: C2_CAPABLE_SELECTION,
        attachments: [],
      });
      assert.isDefined(preview);
      const observed: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(
          {
            threadId: THREAD_ID,
            input: "a",
            interactionMode: "plan",
            modelSelection: C2_CAPABLE_SELECTION,
            attachments: [],
          },
          useCheckedAdmission(preview!, observed),
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      // The setter did run — the veto judged the post-setter observation and
      // still refused, so nothing queued and no turn was recorded.
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
      assert.equal(observed.length, 0);
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses the publish when the pinned session moves between preview and use", () => {
    const harness = makeHarness({
      instanceId: C2_INSTANCE,
      getSessionMessages: async () => [],
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const sendInput = {
        threadId: THREAD_ID,
        input: "a",
        modelSelection: C2_CAPABLE_SELECTION,
        attachments: [],
      };
      const preview = yield* previewRouteOf(adapter)(sendInput);
      assert.isDefined(preview);
      // The pinned context the preview read is gone — a new generation and a
      // new native session sit behind the same thread.
      yield* adapter.stopSession(THREAD_ID);
      yield* startModeledSession(adapter);
      const observed: Array<ProviderAdmissionObservation> = [];
      const sent = yield* adapter
        .sendTurn(sendInput, useCheckedAdmission(preview!, observed))
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      assert.equal(observed.length, 0);
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses before the queue and turn state when the use verdict itself throws", () => {
    const harness = makeHarness({ instanceId: C2_INSTANCE });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const sent = yield* adapter
        .sendTurn(
          {
            threadId: THREAD_ID,
            input: "a",
            modelSelection: C2_CAPABLE_SELECTION,
            attachments: [],
          },
          {
            admit: () => {
              throw new Error("the use verdict blew up");
            },
          },
        )
        .pipe(Effect.result);
      assert.equal(sent._tag, "Failure");
      assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
      const listed = yield* adapter.listSessions();
      assert.isUndefined(listed[0]?.activeTurnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops the preview when the pinned context moves while the catalog is loading", () => {
    // The catalog effect is a suspend-read box: once the preview parks
    // inside it, the same gate lets the session restart pass without it.
    const catalogGate: { effect: Effect.Effect<void> } = { effect: Effect.void };
    const harness = makeHarness({
      instanceId: C2_INSTANCE,
      getSessionMessages: async () => [],
      modelCatalog: Effect.suspend(() =>
        Effect.andThen(catalogGate.effect, Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG)),
      ),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* startModeledSession(adapter);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      catalogGate.effect = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const previewed = yield* previewRouteOf(adapter)({
        threadId: THREAD_ID,
        input: "a",
        modelSelection: C2_CAPABLE_SELECTION,
        attachments: [],
      }).pipe(Effect.forkChild({ startImmediately: true }));
      // The preview is provably inside the catalog read before the context
      // is swapped out from under it.
      yield* Deferred.await(entered);
      catalogGate.effect = Effect.void;
      yield* adapter.stopSession(THREAD_ID);
      yield* startModeledSession(adapter);
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.await(previewed);
      assert(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit)) {
        assert.isUndefined(exit.value);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("returns no preview where the route cannot be proven", () => {
    const harness = makeHarness({ instanceId: C2_INSTANCE });
    const verboseHarness = makeHarness({
      claudeConfig: { launchArgs: "--verbose" },
      instanceId: C2_INSTANCE,
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const previewRoute = previewRouteOf(adapter);
        // Nothing open at all — no context to prove a route on.
        assert.isUndefined(
          yield* previewRoute({ threadId: THREAD_ID, input: "a", attachments: [] }),
        );
        // An open session that never resolved a model: the profile has no
        // apiModel to stand on.
        yield* startClaudeTestSession(adapter);
        assert.isUndefined(
          yield* previewRoute({ threadId: THREAD_ID, input: "a", attachments: [] }),
        );
        yield* adapter.stopSession(THREAD_ID);
        yield* startModeledSession(adapter);
        // A selection pinned to another instance cannot route here.
        assert.isUndefined(
          yield* previewRoute({
            threadId: THREAD_ID,
            input: "a",
            attachments: [],
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent-other"),
              SYNTHETIC_CLAUDE_STANDARD_MODEL,
            ),
          }),
        );
        // A selection this catalog does not carry cannot produce an apiModel.
        assert.isUndefined(
          yield* previewRoute({
            threadId: THREAD_ID,
            input: "a",
            attachments: [],
            modelSelection: createModelSelection(C2_INSTANCE, "claude-not-a-model"),
          }),
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
      yield* Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* startModeledSession(adapter);
        // The verbose launch arg falls outside the accounted set — no
        // profile seed exists, so no route can be proven.
        assert.isUndefined(
          yield* previewRouteOf(adapter)({
            threadId: THREAD_ID,
            input: "a",
            attachments: [],
          }),
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(verboseHarness.layer),
      );
    });
  });
});
