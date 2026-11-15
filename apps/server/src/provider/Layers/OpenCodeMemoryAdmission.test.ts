/**
 * Project memory on the OpenCode 1.x path: boots the real adapter over a mock
 * OpenCode server SDK and checks what the server receives. The publish
 * admission must be the last word: a refusal — or a context that was replaced
 * after the caller captured its identity, or a gate that closed while the
 * prompt waited behind an in-flight turn — sends no prompt at all and leaves
 * no turn boundary behind: a memory-bearing fresh send only starts its turn
 * once the gate admits, so a refusal never even emits turn.started.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import { assert, describe, it } from "@effect/vitest";
import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const MODEL_SELECTION = createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5");

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    createdSessionIds: [] as string[],
    promptCalls: [] as Array<Record<string, unknown>>,
    commandCalls: [] as Array<Record<string, unknown>>,
    promptAsyncImplementation: null as (() => Promise<void>) | null,
    autoPromptEcho: true,
    autoConnect: true,
    endEventStream: false,
    promptEchoEvents: [] as Array<unknown>,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as Array<unknown | Promise<unknown>>,
  },
  reset() {
    this.state.createdSessionIds.length = 0;
    this.state.promptCalls.length = 0;
    this.state.commandCalls.length = 0;
    this.state.promptAsyncImplementation = null;
    this.state.autoPromptEcho = true;
    this.state.autoConnect = true;
    this.state.endEventStream = false;
    this.state.promptEchoEvents.length = 0;
    this.state.messages = [];
    this.state.subscribedEvents = [];
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die("unused in memory admission tests"),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      version: "1.15.13",
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl }) =>
    ({
      command: {
        list: async () => ({
          data: [{ name: "review", source: "command", hints: ["$ARGUMENTS"] }],
        }),
      },
      session: {
        create: async () => {
          return {
            data: { id: runtimeMock.state.createdSessionIds.shift() ?? `${baseUrl}/session` },
          };
        },
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        update: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        abort: async () => {},
        children: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        command: async (input: Record<string, unknown>) => {
          runtimeMock.state.commandCalls.push(input);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input as Record<string, unknown>);
          await runtimeMock.state.promptAsyncImplementation?.();
          if (
            runtimeMock.state.autoPromptEcho &&
            typeof input === "object" &&
            input !== null &&
            "sessionID" in input &&
            "messageID" in input &&
            typeof input.sessionID === "string" &&
            typeof input.messageID === "string"
          ) {
            runtimeMock.state.messages.push({
              info: { id: input.messageID, role: "user" },
              parts: [],
            });
            runtimeMock.state.promptEchoEvents.push({
              id: `evt-auto-user-${input.messageID}`,
              type: "message.updated",
              properties: {
                sessionID: input.sessionID,
                info: { id: input.messageID, role: "user" },
              },
            });
          }
        },
        summarize: async () => ({ data: true }),
        messages: async () => ({ data: runtimeMock.state.messages }),
        message: async ({ messageID }: { messageID: string }) => {
          // A recorded native command counts as an accepted user message, so
          // the adapter's receipt recovery observes it deterministically.
          const command = runtimeMock.state.commandCalls.find(
            (entry) => entry.messageID === messageID,
          );
          if (command !== undefined) {
            return { data: { info: { id: messageID, role: "user" } } };
          }
          const echo = runtimeMock.state.messages.find((entry) => entry.info.id === messageID);
          if (echo !== undefined) {
            return { data: echo };
          }
          throw new Error(`Message not found: ${messageID}`);
        },
        revert: async () => {},
        fork: async ({ sessionID }: { sessionID: string }) => ({
          data: { id: `${sessionID}_fork` },
        }),
      },
      event: {
        subscribe: async (
          _input: unknown,
          options?: { signal?: AbortSignal; onSseError?: (cause: unknown) => void },
        ) => ({
          stream: (async function* () {
            const aborted = promiseWithResolvers<void>();
            const onAbort = () => aborted.resolve(undefined);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            try {
              if (runtimeMock.state.autoConnect) {
                yield { id: "evt-auto-connected", type: "server.connected", properties: {} };
              }
              for (const event of runtimeMock.state.subscribedEvents) {
                if (options?.signal?.aborted) return;
                const resolved = await Promise.race([event, aborted.promise]);
                if (options?.signal?.aborted) return;
                while (runtimeMock.state.promptEchoEvents.length > 0) {
                  yield runtimeMock.state.promptEchoEvents.shift();
                }
                yield resolved;
              }
              if (!runtimeMock.state.endEventStream && !options?.signal?.aborted) {
                await aborted.promise;
              }
            } finally {
              options?.signal?.removeEventListener("abort", onAbort);
            }
          })(),
        }),
      },
      permission: {
        list: async () => ({ data: [] }),
        reply: async () => ({}),
      },
      question: {
        list: async () => ({ data: [] }),
        reply: async () => ({}),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "not used in memory admission tests",
        cause: null,
      }),
    ),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "not used in memory admission tests",
        cause: null,
      }),
    ),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const openCodeSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof testLayer>>,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

function promiseWithResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Replaces the native event subscription with a queue the test pushes into.
 * Call before `startSession`, which is when the adapter subscribes.
 */
function makeOpenCodeEventQueue() {
  let pending = promiseWithResolvers<unknown>();
  const events = [pending.promise];
  runtimeMock.state.subscribedEvents = events;
  return (event: unknown) => {
    const current = pending;
    pending = promiseWithResolvers<unknown>();
    events.push(pending.promise);
    current.resolve(event);
  };
}

const makeSetup = (agentInstructions?: Effect.Effect<string>) =>
  Effect.gen(function* () {
    runtimeMock.reset();
    const adapter = yield* makeOpenCodeAdapter(
      openCodeSettings,
      agentInstructions ? { agentInstructions } : {},
    ).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    // Events are recorded in arrival order; `next` waits for the next
    // occurrence after its call, so a later receipt proves everything before
    // it has already been recorded.
    const seen: Array<ProviderRuntimeEvent> = [];
    const waiters: Array<{
      readonly type: ProviderRuntimeEvent["type"];
      readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];
    const record = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        seen.push(event);
        const index = waiters.findIndex((waiter) => waiter.type === event.type);
        if (index >= 0) {
          const [waiter] = waiters.splice(index, 1);
          yield* Deferred.succeed(waiter!.deferred, event);
        }
      });
    yield* Stream.runForEach(adapter.streamEvents, record).pipe(Effect.forkScoped);
    const next = (type: ProviderRuntimeEvent["type"]) =>
      Effect.gen(function* () {
        const startIndex = seen.length;
        while (true) {
          const index = seen.findIndex(
            (event, position) => position >= startIndex && event.type === type,
          );
          if (index >= 0) {
            return seen[index]!;
          }
          const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
          waiters.push({ type, deferred });
          yield* Deferred.await(deferred);
        }
      });
    const startSession = (threadId: ThreadId) =>
      adapter.startSession({ provider: PROVIDER, threadId, runtimeMode: "full-access" });
    return { adapter, next, seen, startSession } as const;
  });

/** Waits until the mock OpenCode has received `count` promptAsync calls. */
const waitForSdkCalls = (
  calls: ReadonlyArray<unknown>,
  count: number,
  what: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (calls.length >= count) {
        return;
      }
      yield* Effect.yieldNow;
    }
    throw new Error(`${what} never reached ${count} call(s)`);
  });

const waitForPromptCalls = (count: number) =>
  waitForSdkCalls(runtimeMock.state.promptCalls, count, "promptAsync");

const sessionAfter = (adapter: OpenCodeAdapterShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const found = (yield* adapter.listSessions()).find(
      (candidate) => candidate.threadId === threadId,
    );
    assert.isDefined(found);
    return found!;
  });

describe("OpenCode project memory admission", () => {
  it.effect(
    "delivers the project-memory note in session.promptAsync after the publish admission",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, next, seen, startSession } = yield* makeSetup();
          const threadId = ThreadId.make("thread-opencode-memory-ok");
          const pushEvent = makeOpenCodeEventQueue();
          const session = yield* startSession(threadId);
          const sessionId =
            typeof session.resumeCursor === "object" &&
            session.resumeCursor !== null &&
            "sessionId" in session.resumeCursor
              ? (session.resumeCursor as { sessionId: string }).sessionId
              : undefined;
          assert.isDefined(sessionId);
          const support = adapter.memoryAdmission;
          assert.isDefined(support);
          const generation = support!.sessionGeneration(threadId);
          assert.isDefined(generation);
          // The same cursor the directory persists names the provider session the send must publish on.
          const expectedSid = support!.nativeSessionId(session.resumeCursor);
          assert.isDefined(expectedSid);

          const observed: Array<{ sessionGeneration: number; nativeSessionId: string }> = [];
          const result = yield* adapter.sendTurn(
            { threadId, input: "Use the project memory.", modelSelection: MODEL_SELECTION },
            {
              admit: (observation) => {
                observed.push({
                  sessionGeneration: observation.sessionGeneration,
                  nativeSessionId: observation.nativeSessionId!,
                });
                return true;
              },
            },
          );

          assert.deepEqual(observed, [
            { sessionGeneration: generation!, nativeSessionId: expectedSid! },
          ]);
          assert.equal(runtimeMock.state.promptCalls.length, 1);
          const prompt = runtimeMock.state.promptCalls[0]!;
          const parts = prompt.parts as Array<{ type: string; text: string }>;
          assert.deepEqual(parts, [{ type: "text", text: "Use the project memory." }]);
          assert.equal(
            prompt.system,
            buildRuntimeInstructions({
              harness: "OpenCode",
              model: "openai/gpt-5",
              projectMemory: true,
            }),
          );

          // Drain the turn to its completion: the receipt that every event of
          // the turn has been recorded before the ordering checks below.
          pushEvent({
            id: "evt-idle-admitted",
            type: "session.status",
            properties: { sessionID: sessionId, status: { type: "idle" } },
          });
          const completed = yield* next("turn.completed");
          assert.equal(completed.turnId, result.turnId);
          // The admitted turn started exactly once, and the start is the first
          // recorded event carrying its turn id.
          const starts = seen.filter((event) => event.type === "turn.started");
          assert.equal(starts.length, 1);
          assert.equal(starts[0]!.turnId, result.turnId);
          const turnEvents = seen.filter((event) => event.turnId === result.turnId);
          assert.isNotEmpty(turnEvents.slice(1));
          assert.equal(turnEvents[0]!.type, "turn.started");
        }),
      ),
  );

  it.effect("sends no prompt or command when the publish admission refuses", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, next, seen, startSession } = yield* makeSetup();
        const threadId = ThreadId.make("thread-opencode-memory-refused");
        const pushEvent = makeOpenCodeEventQueue();
        const session = yield* startSession(threadId);
        const sessionId =
          typeof session.resumeCursor === "object" &&
          session.resumeCursor !== null &&
          "sessionId" in session.resumeCursor
            ? (session.resumeCursor as { sessionId: string }).sessionId
            : undefined;
        assert.isDefined(sessionId);
        const error = yield* Effect.flip(
          adapter.sendTurn(
            { threadId, input: "Memory send.", modelSelection: MODEL_SELECTION },
            { admit: () => false },
          ),
        );
        assert.equal(error._tag, "ProviderAdapterSessionClosedError");
        // A throwing gate is a refusal too, never a publish.
        const thrown = yield* Effect.flip(
          adapter.sendTurn(
            { threadId, input: "Memory send.", modelSelection: MODEL_SELECTION },
            {
              admit: () => {
                throw new Error("gate failed");
              },
            },
          ),
        );
        assert.equal(thrown._tag, "ProviderAdapterSessionClosedError");
        assert.deepEqual(runtimeMock.state.promptCalls, []);
        assert.deepEqual(runtimeMock.state.commandCalls, []);

        // A refusal never reached the agent, so a following ordinary send works
        // normally and its turn completes — the completion is the receipt that
        // every event the refusals emitted has already been recorded.
        yield* adapter.sendTurn({
          threadId,
          input: "Plain follow-up.",
          modelSelection: MODEL_SELECTION,
        });
        assert.equal(runtimeMock.state.promptCalls.length, 1);
        pushEvent({
          id: "evt-idle",
          type: "session.status",
          properties: { sessionID: sessionId, status: { type: "idle" } },
        });
        const completed = yield* next("turn.completed");
        const boundaries = seen.filter(
          (event) => event.type === "turn.aborted" || event.type === "turn.completed",
        );
        // Exactly one boundary: the plain send's completion. The two refused
        // sends left no turn.aborted and no turn.completed behind.
        assert.equal(boundaries.length, 1);
        assert.equal(boundaries[0]!.type, "turn.completed");
        assert.equal(boundaries[0]!.turnId, completed.turnId);
        // The refused sends emitted no turn.started at all: a memory-bearing
        // fresh send only starts its turn once the gate admits. Only the plain
        // follow-up opened a turn, and it is the start that completed above.
        const starts = seen.filter((event) => event.type === "turn.started");
        assert.equal(starts.length, 1);
        assert.equal(starts[0]!.turnId, completed.turnId);

        // The refusals restored the session: ready, no active turn, no lastError.
        const refusedSession = yield* sessionAfter(adapter, threadId);
        assert.equal(refusedSession.status, "ready");
        assert.equal(refusedSession.activeTurnId, undefined);
        assert.equal(refusedSession.lastError, undefined);
      }),
    ),
  );

  it.effect(
    "reads a session replaced after the identity was captured as a different generation",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, startSession } = yield* makeSetup();
          const threadId = ThreadId.make("thread-opencode-memory-replaced");
          yield* startSession(threadId);
          const captured = adapter.memoryAdmission!.sessionGeneration(threadId);
          yield* startSession(threadId);
          const current = adapter.memoryAdmission!.sessionGeneration(threadId);
          assert.isDefined(captured);
          assert.notEqual(captured, current);

          // Same gate shape ProviderService installs: the captured generation
          // must still be the one publishing.
          const error = yield* Effect.flip(
            adapter.sendTurn(
              { threadId, input: "Stale memory send.", modelSelection: MODEL_SELECTION },
              { admit: (observation) => observation.sessionGeneration === captured },
            ),
          );
          assert.equal(error._tag, "ProviderAdapterSessionClosedError");
          assert.deepEqual(runtimeMock.state.promptCalls, []);

          yield* adapter.stopSession(threadId);
          // A stopped session reports no generation at all.
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );

  it.effect("changes the generation across a stop and start of the same thread", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, startSession } = yield* makeSetup();
        const threadId = ThreadId.make("thread-opencode-memory-restart");
        yield* startSession(threadId);
        const first = adapter.memoryAdmission!.sessionGeneration(threadId);
        assert.isDefined(first);
        yield* adapter.stopSession(threadId);
        assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        yield* startSession(threadId);
        const second = adapter.memoryAdmission!.sessionGeneration(threadId);
        assert.isDefined(second);
        assert.notEqual(first, second);
      }),
    ),
  );

  it.effect(
    "re-judges a prompt queued behind an in-flight turn when the gate closes while it waits",
    () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let instructionsReads = 0;
          const { adapter, startSession } = yield* makeSetup(
            Effect.gen(function* () {
              instructionsReads += 1;
              if (instructionsReads !== 2) {
                return "";
              }
              // Park the second send on its per-turn instructions read — the
              // last await before the prompt. It can only get here once the
              // in-flight first prompt is interrupted, and the verdict it must
              // still obey is the one judged at the publish point.
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
          );
          const threadId = ThreadId.make("thread-opencode-memory-queued");
          yield* startSession(threadId);

          // The first prompt is in flight and holds the prompt semaphore.
          runtimeMock.state.promptAsyncImplementation = () => new Promise<void>(() => {});
          const first = yield* adapter
            .sendTurn(
              { threadId, input: "First.", modelSelection: MODEL_SELECTION },
              { admit: () => true },
            )
            .pipe(Effect.exit, Effect.forkChild);
          yield* waitForPromptCalls(1);

          // The second send queues behind it with its gate open.
          const gate = { open: true };
          const second = yield* adapter
            .sendTurn(
              { threadId, input: "Second.", modelSelection: MODEL_SELECTION },
              { admit: () => gate.open },
            )
            .pipe(Effect.exit, Effect.forkChild);
          // Ending the in-flight prompt frees the semaphore; the queued send
          // reaches its publish point and must find the gate closed.
          yield* adapter.interruptTurn(threadId);
          yield* Deferred.await(reached);
          gate.open = false;
          yield* Deferred.succeed(release, undefined);

          const secondExit = yield* Fiber.join(second);
          const secondFailure = Exit.isFailure(secondExit)
            ? Option.getOrUndefined(Cause.findErrorOption(secondExit.cause))
            : undefined;
          assert.equal(secondFailure?._tag, "ProviderAdapterSessionClosedError");
          yield* Fiber.join(first).pipe(Effect.ignore);

          // The hold was seen at the publish point: only the first prompt ever
          // reached the agent, and the session drained back to ready.
          assert.equal(runtimeMock.state.promptCalls.length, 1);
          const sessionPostRefusal = yield* sessionAfter(adapter, threadId);
          assert.equal(sessionPostRefusal.status, "ready");

          // A refusal leaves nothing behind: a later send still publishes.
          runtimeMock.state.promptAsyncImplementation = null;
          yield* adapter.sendTurn(
            { threadId, input: "Third.", modelSelection: MODEL_SELECTION },
            { admit: () => true },
          );
          yield* waitForPromptCalls(2);
        }),
      ),
  );

  it.effect("refusing a steer leaves the running turn intact", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, next, startSession } = yield* makeSetup();
        const threadId = ThreadId.make("thread-opencode-memory-steer");
        const pushEvent = makeOpenCodeEventQueue();
        const session = yield* startSession(threadId);
        const sessionId =
          typeof session.resumeCursor === "object" &&
          session.resumeCursor !== null &&
          "sessionId" in session.resumeCursor
            ? (session.resumeCursor as { sessionId: string }).sessionId
            : undefined;
        assert.isDefined(sessionId);

        // A native command starts the turn; its receipt recovery observes the
        // recorded command deterministically, so by the time the send returns
        // the turn is running with no admission bookkeeping left behind.
        const command = yield* adapter.sendTurn(
          { threadId, input: "/review", modelSelection: MODEL_SELECTION },
          { admit: () => true },
        );
        assert.isDefined(command.turnId);

        // The steer is refused at its publish point.
        const error = yield* Effect.flip(
          adapter.sendTurn(
            { threadId, input: "Steered follow-up.", modelSelection: MODEL_SELECTION },
            { admit: () => false },
          ),
        );
        assert.equal(error._tag, "ProviderAdapterSessionClosedError");
        assert.deepEqual(runtimeMock.state.promptCalls, []);

        // The steered running turn is untouched: still running on its turn.
        const steeredSession = yield* sessionAfter(adapter, threadId);
        assert.equal(steeredSession.status, "running");
        assert.equal(steeredSession.activeTurnId, command.turnId);

        // The surviving turn can still complete normally.
        pushEvent({
          id: "evt-idle",
          type: "session.status",
          properties: { sessionID: sessionId, status: { type: "idle" } },
        });
        const completed = yield* next("turn.completed");
        assert.equal(completed.turnId, command.turnId);
      }),
    ),
  );
});
