/**
 * Project memory on the OpenCode 2 path: boots the real adapter over a fake
 * OpenCode 2 client and checks what the client receives. The publish admission
 * must be the last word: a refusal — or a context that was replaced after the
 * caller captured its identity — sends no prompt or command at all and leaves
 * no turn boundary behind: a memory-bearing fresh send only starts its turn
 * once the gate admits, so a refusal never even emits turn.started. The
 * selector in front of both OpenCode adapters routes the memory hooks to the
 * adapter that owns the thread.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import type { ProviderAdmissionObservation } from "../Services/ProviderAdapter.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";
import { selectOpenCodeAdapter } from "./OpenCodeAdapterSelector.ts";
import type { OpenCode2Client } from "./OpenCode2Client.ts";

const instanceId = ProviderInstanceId.make("opencode");
const PROVIDER = ProviderDriverKind.make("opencode");
const SESSION = "ses_main";
const MODEL_SELECTION = { instanceId, model: "provider/model" };

function eventChannel() {
  const queued: Array<unknown> = [];
  let waiting: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;
  const settle = (result: IteratorResult<unknown>) => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(result);
  };
  return {
    push: (event: unknown) =>
      waiting ? settle({ value: event, done: false }) : queued.push(event),
    close: () => {
      closed = true;
      settle({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> =>
          queued.length > 0
            ? Promise.resolve({ value: queued.shift(), done: false })
            : closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => (waiting = resolve)),
      }),
    },
  };
}

const makeSetup = Effect.gen(function* () {
  const channel = eventChannel();
  channel.push({ type: "server.connected", data: {} });
  const ok = async () => ({});
  const prompts: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const instructionPuts: Array<Record<string, unknown>> = [];
  // `command.list` answers `review`. After `holdCommandList(n)` calls wait
  // for `releaseCommandList()`; the returned promises resolve as the next n
  // callers arrive, so slash commands can be held mid-preparation.
  let gate = Promise.resolve();
  let release = () => {};
  const listing: Array<() => void> = [];
  const holdCommandList = (calls = 1) => {
    gate = new Promise<void>((resolve) => (release = resolve));
    return Array.from(
      { length: calls },
      () => new Promise<void>((resolve) => listing.push(resolve)),
    );
  };
  // `failNextPrompt()` makes the next session.prompt reject once.
  let promptFails = false;
  // `malformNextCommandList()` makes the next command.list answer without
  // `data`, which the adapter trips over as a defect rather than a failure.
  let listMalformed = false;
  // `failNextCommand()` does the same for the next session.command.
  let commandFails = false;
  // `holdNextPrompt()` makes the next session.prompt never answer; the
  // returned promise resolves once it is waiting.
  let promptHeld: (() => void) | undefined;
  let interrupts = 0;
  const client = {
    model: { list: async () => ({ data: [] }) },
    command: {
      list: async () => {
        listing.shift()?.();
        await gate;
        if (listMalformed) {
          listMalformed = false;
          return {};
        }
        return { data: [{ name: "review" }] };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener("abort", channel.close);
        return channel.iterable;
      },
    },
    permission: { reply: ok },
    session: {
      create: async () => ({ id: SESSION }),
      switchModel: ok,
      switchAgent: ok,
      instructions: {
        entry: {
          put: async (input: Record<string, unknown>) => {
            instructionPuts.push(input);
            return {};
          },
        },
      },
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input);
        if (promptHeld) {
          promptHeld();
          promptHeld = undefined;
          return new Promise(() => {});
        }
        if (promptFails) {
          promptFails = false;
          throw new Error("prompt rejected");
        }
        return {};
      },
      command: async (input: Record<string, unknown>) => {
        commands.push(input);
        if (commandFails) {
          commandFails = false;
          throw new Error("command rejected");
        }
        return {};
      },
      interrupt: async () => {
        interrupts += 1;
        return {};
      },
      form: { cancel: ok, reply: ok },
    },
  } as unknown as OpenCode2Client;
  const adapter = yield* makeOpenCode2Adapter({ binaryPath: "opencode" } as never, {
    instanceId,
    makeClient: () => client,
  });
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
    adapter.startSession({
      threadId,
      provider: PROVIDER,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection: MODEL_SELECTION,
    } as never);
  return {
    adapter,
    channel,
    next,
    seen,
    startSession,
    prompts,
    commands,
    instructionPuts,
    holdCommandList,
    releaseCommandList: () => release(),
    failNextPrompt: () => {
      promptFails = true;
    },
    malformNextCommandList: () => {
      listMalformed = true;
    },
    failNextCommand: () => {
      commandFails = true;
    },
    holdNextPrompt: () =>
      new Promise<void>((resolve) => {
        promptHeld = resolve;
      }),
    interruptCount: () => interrupts,
  } as const;
});

const threadAfter = (adapter: OpenCodeAdapterShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const found = (yield* adapter.listSessions()).find(
      (candidate) => candidate.threadId === threadId,
    );
    assert.isDefined(found);
    return found!;
  });

const layer = Layer.mergeAll(
  Layer.succeed(OpenCodeRuntime, {
    connectToOpenCodeServer: () =>
      Effect.succeed({
        url: "http://opencode.test",
        serverPassword: "secret",
        version: "2.1.4",
        exitCode: null,
        external: true,
      }),
  } as never),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode2-memory-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const run = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.scoped, Effect.provide(layer));

describe("OpenCode 2 project memory admission", () => {
  it.effect("delivers the prompt and the project-memory note after the publish admission", () =>
    run(
      Effect.gen(function* () {
        const { adapter, channel, next, seen, startSession, prompts, instructionPuts } =
          yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-ok");
        const session = yield* startSession(threadId);
        const support = adapter.memoryAdmission;
        assert.isDefined(support);
        const generation = support!.sessionGeneration(threadId);
        assert.isDefined(generation);
        // The same cursor the directory persists names the provider session the send must publish on.
        const expectedSid = support!.nativeSessionId(session.resumeCursor);
        assert.equal(expectedSid, SESSION);

        const observed: Array<{ sessionGeneration: number; nativeSessionId: string }> = [];
        const result = yield* adapter.sendTurn(
          { threadId, input: "Use the project memory.", modelSelection: MODEL_SELECTION },
          {
            admit: (observation: ProviderAdmissionObservation) => {
              observed.push({
                sessionGeneration: observation.sessionGeneration,
                nativeSessionId: observation.nativeSessionId!,
              });
              return true;
            },
          } as never,
        );

        assert.deepEqual(observed, [
          { sessionGeneration: generation!, nativeSessionId: expectedSid! },
        ]);
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0]!.text, "Use the project memory.");
        assert.equal(prompts[0]!.sessionID, SESSION);
        // The project-memory note reaches the server-side instructions entry.
        assert.equal(instructionPuts.length, 1);
        assert.include(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(instructionPuts[0]),
          "<project_memory>",
        );

        // Drain the turn to its completion: the receipt that every event of
        // the turn has been recorded before the ordering checks below.
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
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
    run(
      Effect.gen(function* () {
        const { adapter, channel, next, seen, startSession, prompts, commands } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-refused");
        const session = yield* startSession(threadId);
        const sessionId = (
          session.resumeCursor as unknown as { sessionId: string; schemaVersion: number }
        ).sessionId;
        assert.equal(sessionId, SESSION);
        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: "Memory send.", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never),
        );
        assert.equal(error._tag, "ProviderAdapterSessionClosedError");
        // A throwing gate is a refusal too, never a publish.
        const thrown = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: "Memory send.", modelSelection: MODEL_SELECTION }, {
            admit: () => {
              throw new Error("gate failed");
            },
          } as never),
        );
        assert.equal(thrown._tag, "ProviderAdapterSessionClosedError");
        assert.deepEqual(prompts, []);
        assert.deepEqual(commands, []);

        // A refusal never reached the agent, so a following ordinary send works
        // normally; completing it is the receipt that every event the refusals
        // emitted has already been recorded.
        yield* adapter.sendTurn({
          threadId,
          input: "Plain follow-up.",
          modelSelection: MODEL_SELECTION,
        } as never);
        assert.equal(prompts.length, 1);
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
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
        const refusedSession = yield* threadAfter(adapter, threadId);
        assert.equal(refusedSession.status, "ready");
        assert.equal(refusedSession.activeTurnId, undefined);
        assert.equal(refusedSession.lastError, undefined);
      }),
    ),
  );

  it.effect("keeps the turn for a send that joined a memory slash command the gate refused", () =>
    run(
      Effect.gen(function* () {
        const {
          adapter,
          channel,
          next,
          seen,
          startSession,
          prompts,
          holdCommandList,
          releaseCommandList,
        } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-joined");
        yield* startSession(threadId);
        // A: a memory slash command held in command.list while its turn is bound.
        const [listed] = holdCommandList();
        const refused = yield* adapter
          .sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => listed!);
        // B: sent meanwhile, it joins A's preparing turn and is admitted.
        const joined = yield* adapter.sendTurn(
          { threadId, input: "Joiner.", modelSelection: MODEL_SELECTION },
          { admit: () => true } as never,
        );
        releaseCommandList();
        const error = yield* Fiber.join(refused);
        assert.equal(error._tag, "ProviderAdapterSessionClosedError");
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0]!.text, "Joiner.");

        // The joiner's turn survived the owner's refusal: its events are
        // delivered and it completes, started exactly once and first.
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
        const completed = yield* next("turn.completed");
        assert.equal(completed.turnId, joined.turnId);
        const starts = seen.filter((event) => event.type === "turn.started");
        assert.equal(starts.length, 1);
        assert.equal(starts[0]!.turnId, joined.turnId);
        assert.equal(seen.find((event) => event.turnId === joined.turnId)?.type, "turn.started");
      }),
    ),
  );

  it.effect("aborts the turn when the joiner fails after its start and the owner is refused", () =>
    run(
      Effect.gen(function* () {
        const {
          adapter,
          next,
          seen,
          startSession,
          holdCommandList,
          releaseCommandList,
          failNextPrompt,
        } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-joiner-fails");
        yield* startSession(threadId);
        const [listed] = holdCommandList();
        const refused = yield* adapter
          .sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => listed!);
        // B publishes the turn's start, then its request fails; A is still preparing.
        failNextPrompt();
        const failed = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: "Joiner.", modelSelection: MODEL_SELECTION }, {
            admit: () => true,
          } as never),
        );
        assert.equal(failed._tag, "ProviderAdapterRequestError");
        releaseCommandList();
        yield* Fiber.join(refused);

        // Nobody was accepted: the turn ends aborted once, never left running.
        const aborted = yield* next("turn.aborted");
        assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 1);
        assert.equal(aborted.turnId, seen.find((event) => event.type === "turn.started")!.turnId);
        const after = yield* threadAfter(adapter, threadId);
        assert.equal(after.status, "ready");
        assert.equal(after.activeTurnId, undefined);
        assert.isDefined(after.lastError);
      }),
    ),
  );

  it.effect("leaves no turn when the slash joiner is interrupted and the owner is refused", () =>
    run(
      Effect.gen(function* () {
        const { adapter, channel, next, seen, startSession, holdCommandList, releaseCommandList } =
          yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-joiner-interrupted");
        yield* startSession(threadId);
        const [listedOwner, listedJoiner] = holdCommandList(2);
        const refused = yield* adapter
          .sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => listedOwner!);
        const joiner = yield* adapter
          .sendTurn({ threadId, input: "/review too", modelSelection: MODEL_SELECTION }, {
            admit: () => true,
          } as never)
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => listedJoiner!);
        yield* Fiber.interrupt(joiner);
        releaseCommandList();
        yield* Fiber.join(refused);

        const after = yield* threadAfter(adapter, threadId);
        assert.equal(after.status, "ready");
        assert.equal(after.activeTurnId, undefined);
        assert.equal(after.lastError, undefined);
        // A plain follow-up completing is the receipt that nothing else was emitted.
        yield* adapter.sendTurn({
          threadId,
          input: "Plain follow-up.",
          modelSelection: MODEL_SELECTION,
        } as never);
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
        yield* next("turn.completed");
        assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 0);
      }),
    ),
  );

  it.effect("leaves no turn when the owner and the joiner are both refused", () =>
    run(
      Effect.gen(function* () {
        const {
          adapter,
          channel,
          next,
          seen,
          startSession,
          prompts,
          holdCommandList,
          releaseCommandList,
        } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-both-refused");
        yield* startSession(threadId);
        const [listed] = holdCommandList();
        const owner = yield* adapter
          .sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => listed!);
        const joiner = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: "Joiner.", modelSelection: MODEL_SELECTION }, {
            admit: () => false,
          } as never),
        );
        assert.equal(joiner._tag, "ProviderAdapterSessionClosedError");
        releaseCommandList();
        yield* Fiber.join(owner);
        assert.deepEqual(prompts, []);

        const after = yield* threadAfter(adapter, threadId);
        assert.equal(after.status, "ready");
        assert.equal(after.activeTurnId, undefined);
        assert.equal(after.lastError, undefined);
        yield* adapter.sendTurn({
          threadId,
          input: "Plain follow-up.",
          modelSelection: MODEL_SELECTION,
        } as never);
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
        yield* next("turn.completed");
        // Only the follow-up started a turn.
        assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 0);
      }),
    ),
  );

  it.effect("leaves an interrupted publish request to interruptTurn", () =>
    run(
      Effect.gen(function* () {
        const { adapter, next, seen, startSession, holdNextPrompt, interruptCount } =
          yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-stop-in-flight");
        yield* startSession(threadId);
        const waiting = holdNextPrompt();
        // Admitted and published, now waiting for the prompt response.
        const send = yield* adapter
          .sendTurn({ threadId, input: "Memory send.", modelSelection: MODEL_SELECTION }, {
            admit: () => true,
          } as never)
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => waiting);
        // The reactor's Stop order: the send fiber first, then interruptTurn.
        yield* Fiber.interrupt(send);
        yield* adapter.interruptTurn(threadId);
        assert.equal(interruptCount(), 1);
        const ending = yield* next("turn.completed").pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        const completed = yield* Fiber.join(ending);
        assert.equal((completed.payload as { state?: unknown }).state, "interrupted");
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 0);
        const after = yield* threadAfter(adapter, threadId);
        assert.equal(after.status, "ready");
        assert.equal(after.lastError, undefined);
      }),
    ),
  );

  it.effect("keeps the turn when the owner fails after the joiner was published", () =>
    run(
      Effect.gen(function* () {
        const {
          adapter,
          channel,
          next,
          seen,
          startSession,
          holdCommandList,
          releaseCommandList,
          failNextCommand,
        } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-owner-fails");
        yield* startSession(threadId);
        const [listed] = holdCommandList();
        const owner = yield* adapter
          .sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => true,
          } as never)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => listed!);
        const joined = yield* adapter.sendTurn(
          { threadId, input: "Joiner.", modelSelection: MODEL_SELECTION },
          { admit: () => true } as never,
        );
        failNextCommand();
        releaseCommandList();
        const error = yield* Fiber.join(owner);
        assert.equal(error._tag, "ProviderAdapterRequestError");

        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
        const completed = yield* next("turn.completed");
        assert.equal(completed.turnId, joined.turnId);
        assert.equal((completed.payload as { state?: unknown }).state, "completed");
        assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 0);
      }),
    ),
  );

  it.effect("undoes a preparing turn when its send dies on a defect", () =>
    run(
      Effect.gen(function* () {
        const { adapter, channel, next, seen, startSession, prompts, malformNextCommandList } =
          yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-defect");
        yield* startSession(threadId);
        malformNextCommandList();
        const exit = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "/review now", modelSelection: MODEL_SELECTION }, {
            admit: () => true,
          } as never),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual(prompts, []);
        const after = yield* threadAfter(adapter, threadId);
        assert.equal(after.status, "ready");
        assert.equal(after.activeTurnId, undefined);
        assert.equal(after.lastError, undefined);
        // A plain follow-up completing is the receipt that nothing else was emitted.
        yield* adapter.sendTurn({
          threadId,
          input: "Plain follow-up.",
          modelSelection: MODEL_SELECTION,
        } as never);
        channel.push({ type: "session.execution.succeeded", data: { sessionID: SESSION } });
        yield* next("turn.completed");
        assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(seen.filter((event) => event.type === "turn.aborted").length, 0);
      }),
    ),
  );

  it.effect(
    "reads a session replaced after the identity was captured as a different generation",
    () =>
      run(
        Effect.gen(function* () {
          const { adapter, startSession, prompts } = yield* makeSetup;
          const threadId = ThreadId.make("thread-opencode2-memory-replaced");
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
              {
                admit: (observation: ProviderAdmissionObservation) =>
                  observation.sessionGeneration === captured,
              } as never,
            ),
          );
          assert.equal(error._tag, "ProviderAdapterSessionClosedError");
          assert.deepEqual(prompts, []);

          yield* adapter.stopSession(threadId);
          // A stopped session reports no generation at all.
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );

  it.effect("changes the generation across a stop and start of the same thread", () =>
    run(
      Effect.gen(function* () {
        const { adapter, startSession } = yield* makeSetup;
        const threadId = ThreadId.make("thread-opencode2-memory-restart");
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

  it.effect("selector memory admission follows the adapter that owns the thread", () =>
    Effect.gen(function* () {
      const makeStubAdapter = (generation: number, withMemory: boolean) => {
        const started = new Set<ThreadId>();
        return {
          provider: PROVIDER,
          capabilities: { sessionModelSwitch: "in-session" as const },
          startSession: (input: { threadId: ThreadId }) =>
            Effect.sync(() => {
              started.add(input.threadId);
              return {
                provider: PROVIDER,
                status: "ready",
                runtimeMode: "approval-required",
                cwd: process.cwd(),
                threadId: input.threadId,
                resumeCursor: { schemaVersion: 1, sessionId: SESSION },
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              };
            }),
          sendTurn: () => Effect.die("unused"),
          ...(withMemory
            ? {
                memoryAdmission: {
                  sessionGeneration: (threadId: ThreadId) =>
                    started.has(threadId) ? generation : undefined,
                  nativeSessionId: () => SESSION,
                },
              }
            : {}),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: (threadId: ThreadId) =>
            Effect.sync(() => {
              started.delete(threadId);
            }),
          listSessions: () => Effect.succeed([]),
          hasSession: () => Effect.succeed(false),
          readThread: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          stopAll: () => Effect.void,
          streamEvents: Stream.empty,
        } as unknown as OpenCodeAdapterShape;
      };

      const threadId = ThreadId.make("thread-opencode2-memory-selector");
      const v1 = makeStubAdapter(101, true);
      const v2 = makeStubAdapter(202, true);
      let routeToV2 = true;
      const selector = selectOpenCodeAdapter({
        v1,
        v2,
        isV2: Effect.sync(() => routeToV2),
      });
      assert.isDefined(selector.memoryAdmission);
      yield* selector.startSession({ threadId } as never);
      assert.equal(selector.memoryAdmission!.sessionGeneration(threadId), 202);
      // Moving the thread back to v1 re-routes the hooks to the new owner.
      routeToV2 = false;
      yield* selector.startSession({ threadId } as never);
      assert.equal(selector.memoryAdmission!.sessionGeneration(threadId), 101);

      // Without support on either side the selector exposes nothing.
      const halfSupported = selectOpenCodeAdapter({
        v1: makeStubAdapter(303, false),
        v2: makeStubAdapter(404, true),
        isV2: Effect.succeed(true),
      });
      assert.isUndefined(halfSupported.memoryAdmission);
    }).pipe(Effect.scoped),
  );
});
