/**
 * Project memory on the Grok path (also the zcode and minimax drivers, which
 * build this adapter): boots the REAL GrokAdapter over the REAL ACP runtime
 * against the mock agent peer and checks what the peer receives. The envelope
 * the orchestrator hydrates must arrive in `session/prompt`, and the publish
 * admission must be the last word: a refusal, or a context that was replaced
 * or stopped after the caller captured its identity, sends no prompt at all.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ComposerContextId,
  type ComposerContextRecord,
  GrokSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderAdmissionObservation } from "../Services/ProviderAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const GROK = ProviderDriverKind.make("grok");
const SECRET_BODY = "GROK-MEMORY-BODY-9e4f2a";

const mockAgentPath = NodePath.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockGrokWrapper(requestLogPath: string, extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-memory-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-grok",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

const recordedPromptRequests = (requestLogPath: string) => {
  try {
    return NodeFS.readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line) as {
            method: string;
            params: Record<string, unknown>;
          },
      )
      .filter((request) => request.method === "session/prompt");
  } catch {
    return [];
  }
};

const memoryRecord: ComposerContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("mem-1"),
  kind: "memory",
  label: "Project memory",
  payload: { memoryId: "mem-1", selectedVersion: 1 },
};

/** What the orchestrator hands the adapter: the reference text hydrated into the version-1 envelope. */
const hydratedInput = projectComposerContextForProvider({
  text: "Use the rule. [Project memory](t3-context://v1/memory/mem-1)",
  records: [memoryRecord],
  hydrated: [{ memoryId: "mem-1", version: 1, kind: "fact", title: "A rule", body: SECRET_BODY }],
});

/** Waits until the mock agent has logged `count` session/prompt requests. */
const waitForPromptRequests = (requestLogPath: string, count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const prompts = recordedPromptRequests(requestLogPath);
      if (prompts.length >= count) {
        return prompts;
      }
      yield* Effect.sleep("25 millis");
    }
    return recordedPromptRequests(requestLogPath);
  });

const makeSetup = (agentInstructions?: Effect.Effect<string>, agentEnv?: Record<string, string>) =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-memory-workspace-")),
    );
    const requestLogPath = NodePath.join(workspace, "requests.ndjson");
    yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
    const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper(requestLogPath, agentEnv));
    const adapter = yield* makeGrokAdapter(decodeGrokSettings({ binaryPath: wrapperPath }), {
      ...(agentInstructions ? { agentInstructions } : {}),
    }).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    const events: ProviderRuntimeEvent[] = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    const startSession = (threadId: ThreadId) =>
      adapter.startSession({
        provider: GROK,
        threadId,
        cwd: workspace,
        runtimeMode: "full-access",
      });
    return { adapter, requestLogPath, startSession, events } as const;
  });

const testLayer = ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "t3-grok-memory-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof testLayer>>,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("Grok project memory admission", () => {
  it.effect(
    "delivers the hydrated memory envelope in session/prompt after the publish admission",
    () =>
      provide(
        Effect.gen(function* () {
          assert.include(hydratedInput, SECRET_BODY);
          const { adapter, requestLogPath, startSession, events } = yield* makeSetup();
          const threadId = ThreadId.make("thread-grok-memory-ok");
          const session = yield* startSession(threadId);
          const support = adapter.memoryAdmission;
          assert.isDefined(support);
          const generation = support!.sessionGeneration(threadId);
          assert.isDefined(generation);
          // The same cursor the directory persists names the provider session the send must publish on.
          const expectedSid = support!.nativeSessionId(session.resumeCursor);
          assert.isDefined(expectedSid);

          const observed: Array<ProviderAdmissionObservation> = [];
          const result = yield* adapter.sendTurn(
            { threadId, input: hydratedInput },
            {
              admit: (observation) => {
                observed.push(observation);
                return true;
              },
            },
          );

          const turnEvents = events.filter((event) => event.turnId === result.turnId);
          assert.equal(turnEvents.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(turnEvents[0]?.type, "turn.started");
          assert.deepEqual(observed, [
            { sessionGeneration: generation!, nativeSessionId: expectedSid! },
          ]);
          const promptRequests = recordedPromptRequests(requestLogPath);
          assert.equal(promptRequests.length, 1);
          assert.include(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              promptRequests[0]?.params,
            ),
            SECRET_BODY,
          );
        }),
      ),
  );

  it.effect("sends no session/prompt when the publish admission refuses", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, requestLogPath, startSession, events } = yield* makeSetup();
        const threadId = ThreadId.make("thread-grok-memory-refused");
        yield* startSession(threadId);
        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: hydratedInput }, { admit: () => false }),
        );
        assert.equal(error._tag, "ProviderAdapterSessionClosedError");
        // A throwing gate is a refusal too, never a publish.
        const thrown = yield* Effect.flip(
          adapter.sendTurn(
            { threadId, input: hydratedInput },
            {
              admit: () => {
                throw new Error("gate failed");
              },
            },
          ),
        );
        assert.equal(thrown._tag, "ProviderAdapterSessionClosedError");
        assert.deepEqual(recordedPromptRequests(requestLogPath), []);
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started"),
          [],
        );

        // A refusal never reached the agent, so the next one still carries the runtime note.
        yield* adapter.sendTurn({ threadId, input: "Plain follow-up." });
        const promptRequests = recordedPromptRequests(requestLogPath);
        assert.equal(promptRequests.length, 1);
        assert.include(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            promptRequests[0]?.params,
          ),
          "<runtime_info>",
        );
      }),
    ),
  );

  it.effect(
    "reads a session replaced after the identity was captured as a different generation",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, requestLogPath, startSession, events } = yield* makeSetup();
          const threadId = ThreadId.make("thread-grok-memory-replaced");
          yield* startSession(threadId);
          const captured = adapter.memoryAdmission!.sessionGeneration(threadId);
          yield* startSession(threadId);
          const current = adapter.memoryAdmission!.sessionGeneration(threadId);
          assert.isDefined(captured);
          assert.notEqual(captured, current);

          // Same gate shape ProviderService installs: the captured generation
          // must still be the one publishing.
          const exit = yield* Effect.exit(
            adapter.sendTurn(
              { threadId, input: hydratedInput },
              { admit: (observation) => observation.sessionGeneration === captured },
            ),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.deepEqual(recordedPromptRequests(requestLogPath), []);
          assert.deepEqual(
            events.filter((event) => event.type === "turn.started"),
            [],
          );

          yield* adapter.stopSession(threadId);
          // A stopped session reports no generation at all.
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );

  it.effect("refuses a stale context even when the gate itself is permissive", () =>
    provide(
      Effect.gen(function* () {
        // Park the send on its per-turn instructions read — the last await
        // before the prompt — so the context is torn down underneath it while
        // it is mid-flight. stopSession needs the thread lock the parked send
        // holds, so the teardown goes through stopAll, which does not.
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let instructionsReads = 0;
        const { adapter, requestLogPath, startSession, events } = yield* makeSetup(
          Effect.gen(function* () {
            instructionsReads += 1;
            if (instructionsReads !== 1) {
              return "";
            }
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
            return "";
          }),
        );
        const threadId = ThreadId.make("thread-grok-memory-stale");
        yield* startSession(threadId);
        const captured = adapter.memoryAdmission!.sessionGeneration(threadId);
        assert.isDefined(captured);

        const send = yield* adapter
          .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reached);
        yield* adapter.stopAll();
        // The context the send prepared on is gone; a stopped session reports
        // no generation at all.
        assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        yield* Deferred.succeed(release, undefined);

        const sendExit = yield* Fiber.join(send);
        assert.isTrue(Exit.isFailure(sendExit));
        const sendFailure = Exit.isFailure(sendExit)
          ? Option.getOrUndefined(Cause.findErrorOption(sendExit.cause))
          : undefined;
        assert.equal(sendFailure?._tag, "ProviderAdapterSessionClosedError");
        assert.deepEqual(recordedPromptRequests(requestLogPath), []);
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started"),
          [],
        );
      }),
    ),
  );

  it.effect(
    "re-judges a send queued behind an in-flight prompt when the gate closes while it waits",
    () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let instructionsReads = 0;
          const { adapter, requestLogPath, startSession } = yield* makeSetup(
            Effect.gen(function* () {
              instructionsReads += 1;
              if (instructionsReads !== 2) {
                return "";
              }
              // Park the second send on its last await before the prompt. It
              // passes every pre-publish check only after the gate has closed,
              // and the verdict it must still obey is the one judged at the
              // publish point inside the ACP dispatch.
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
            // The first prompt never completes on its own; the queued steer's
            // cancel is what frees the runtime's serialization semaphore and
            // drives the queued send to its publish point.
            { T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" },
          );
          const threadId = ThreadId.make("thread-grok-memory-queued");
          yield* startSession(threadId);

          // The first prompt is in flight and holds the runtime's
          // serialization semaphore.
          const first = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
            .pipe(Effect.exit, Effect.forkChild);
          const inFlight = yield* waitForPromptRequests(requestLogPath, 1);
          assert.equal(inFlight.length, 1);

          // The second send queues behind it with its gate open.
          const gate = { open: true };
          const second = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => gate.open })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(reached);
          // Close the gate while the send is parked mid-flight, then release
          // it: as a steer it cancels the in-flight prompt and runs the whole
          // publish path, and must still find the gate closed at the publish
          // point.
          gate.open = false;
          yield* Deferred.succeed(release, undefined);

          // The steer's cancel ends the in-flight prompt; the second send
          // reaches its publish point and finds the gate closed.
          const firstExit = yield* Fiber.join(first);
          assert.isTrue(Exit.isSuccess(firstExit));
          const secondExit = yield* Fiber.join(second);
          const secondFailure = Exit.isFailure(secondExit)
            ? Option.getOrUndefined(Cause.findErrorOption(secondExit.cause))
            : undefined;
          assert.equal(secondFailure?._tag, "ProviderAdapterSessionClosedError");

          // The hold was seen at the publish point: only the first prompt
          // ever reached the agent, and the session drained back to ready.
          assert.equal(recordedPromptRequests(requestLogPath).length, 1);
          const sessionAfter = (yield* adapter.listSessions()).find(
            (candidate) => candidate.threadId === threadId,
          );
          assert.equal(sessionAfter?.status, "ready");

          // A refusal leaves nothing behind: a later send still publishes.
          const third = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
            .pipe(Effect.exit, Effect.forkChild);
          const after = yield* waitForPromptRequests(requestLogPath, 2);
          assert.equal(after.length, 2);
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(third)));
        }).pipe(TestClock.withLive),
      ),
  );

  describe("a steer refused while its turn's prompt is cancelled", () => {
    /** A running turn whose prompt never ends on its own: only a steer's cancel ends it. */
    const runningTurn = (name: string) =>
      Effect.gen(function* () {
        const setup = yield* makeSetup(undefined, { T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" });
        const threadId = ThreadId.make(name);
        yield* setup.startSession(threadId);
        const first = yield* setup.adapter
          .sendTurn({ threadId, input: "Start a long task." })
          .pipe(Effect.forkChild);
        yield* waitForPromptRequests(setup.requestLogPath, 1);
        return { ...setup, threadId, first } as const;
      });

    /** Lets the event collector fiber record what the joined sends already published. */
    const flushEvents = Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
      discard: true,
    });

    const expectOneCancelledCompletion = (
      events: ReadonlyArray<ProviderRuntimeEvent>,
      turnId: string,
    ) => {
      const completions = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      assert.equal(completions.length, 1);
      const completion = completions[0];
      assert.equal(
        completion?.type === "turn.completed" ? completion.payload.state : undefined,
        "cancelled",
      );
    };

    it.effect("completes the turn exactly once when the last steer is refused", () =>
      provide(
        Effect.gen(function* () {
          const { adapter, threadId, first, events } = yield* runningTurn(
            "thread-grok-memory-steer-refused",
          );
          // The steer cancels the running prompt, whose cancelled response
          // settles while the steer is still counted; the steer is then refused
          // at admission and is the last prompt to leave.
          const steer = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => false })
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(steer));
          const firstResult = yield* Fiber.join(first);
          yield* flushEvents;

          expectOneCancelledCompletion(events, firstResult.turnId);
          const sessionAfter = (yield* adapter.listSessions()).find(
            (candidate) => candidate.threadId === threadId,
          );
          assert.equal(sessionAfter?.status, "ready");
          assert.isUndefined(sessionAfter?.activeTurnId);
        }).pipe(TestClock.withLive),
      ),
    );

    it.effect("keeps the cancelled prompt's completion when several steers are refused", () =>
      provide(
        Effect.gen(function* () {
          const { adapter, threadId, first, events } = yield* runningTurn(
            "thread-grok-memory-steers-refused",
          );
          const refused = yield* Effect.all(
            [
              adapter.sendTurn({ threadId, input: hydratedInput }, { admit: () => false }),
              adapter.sendTurn({ threadId, input: hydratedInput }, { admit: () => false }),
            ].map(Effect.exit),
            { concurrency: "unbounded" },
          );
          assert.isTrue(refused.every(Exit.isFailure));
          const firstResult = yield* Fiber.join(first);
          yield* flushEvents;

          expectOneCancelledCompletion(events, firstResult.turnId);
        }).pipe(TestClock.withLive),
      ),
    );

    it.effect("keeps the cancelled prompt's completion when another steer fails to prepare", () =>
      provide(
        Effect.gen(function* () {
          const { adapter, threadId, first, events } = yield* runningTurn(
            "thread-grok-memory-steer-prep-failed",
          );
          const settled = yield* Effect.all(
            [
              adapter.sendTurn({ threadId, input: hydratedInput }, { admit: () => false }),
              // No text and no attachments: preparation fails before any publish.
              adapter.sendTurn({ threadId, input: "  " }),
            ].map(Effect.exit),
            { concurrency: "unbounded" },
          );
          assert.isTrue(settled.every(Exit.isFailure));
          const firstResult = yield* Fiber.join(first);
          yield* flushEvents;

          expectOneCancelledCompletion(events, firstResult.turnId);
        }).pipe(TestClock.withLive),
      ),
    );
  });
});
