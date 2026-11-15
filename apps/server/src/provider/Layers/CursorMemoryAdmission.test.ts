/**
 * Project memory on the Cursor path: boots the REAL CursorAdapter over the REAL
 * ACP runtime against the mock agent peer and checks what the peer receives.
 * The envelope the orchestrator hydrates must arrive in `session/prompt`, and
 * the publish admission must be the last word: a refusal, or a context that was
 * replaced or stopped after the caller captured its identity, sends no prompt
 * at all.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ComposerContextId,
  type ComposerContextRecord,
  CursorSettings,
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
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { assert, describe } from "vite-plus/test";

import type { ProviderAdmissionObservation } from "../Services/ProviderAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const CURSOR = ProviderDriverKind.make("cursor");
const SECRET_BODY = "CURSOR-MEMORY-BODY-9e4f2a";

const mockAgentPath = NodePath.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(requestLogPath: string, extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-memory-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: `
      import { watch, readFileSync } from "node:fs";
      import { dirname, basename } from "node:path";
      const notificationPath = process.env.T3_ACP_REQUEST_LOG_PATH + ".notification";
      watch(dirname(notificationPath), (_event, filename) => {
        if (filename === basename(notificationPath)) {
          process.stdout.write(readFileSync(notificationPath, "utf8"));
        }
      });
      ${execScriptSource({ scriptPath: mockAgentPath })}`,
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
          decodeJson(line) as {
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const prompts = recordedPromptRequests(requestLogPath);
      if (prompts.length >= count) {
        return prompts;
      }
      yield* Effect.yieldNow;
    }
    return recordedPromptRequests(requestLogPath);
  });

const makeSetup = (agentInstructions?: Effect.Effect<string>, agentEnv?: Record<string, string>) =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-memory-workspace-")),
    );
    const requestLogPath = NodePath.join(workspace, "requests.ndjson");
    yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
    const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper(requestLogPath, agentEnv));
    const adapter = yield* makeCursorAdapter(
      decodeCursorSettings({ binaryPath: wrapperPath }),
      agentInstructions ? { agentInstructions } : undefined,
    );
    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    const startSession = (threadId: ThreadId) =>
      adapter.startSession({
        provider: CURSOR,
        threadId,
        cwd: workspace,
        runtimeMode: "full-access",
      });
    return { adapter, requestLogPath, startSession } as const;
  });

const testLayer = ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "t3-cursor-memory-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof testLayer>>,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("Cursor project memory admission", () => {
  for (const admitted of [false, true]) {
    it.effect(
      `keeps preparation notifications on the previous binding when admission is ${admitted}`,
      () =>
        provide(
          Effect.gen(function* () {
            const reached = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const notification = yield* Deferred.make<ProviderRuntimeEvent>();
            const { adapter, startSession, requestLogPath } = yield* makeSetup(
              Effect.gen(function* () {
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
                return "";
              }),
            );
            const events: ProviderRuntimeEvent[] = [];
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.gen(function* () {
                events.push(event);
                if (event.type === "turn.plan.updated")
                  yield* Deferred.succeed(notification, event);
              }),
            ).pipe(Effect.forkChild({ startImmediately: true }));
            const threadId = ThreadId.make(`preparation-${admitted}`);
            yield* startSession(threadId);
            const send = yield* adapter
              .sendTurn({ threadId, input: hydratedInput }, { admit: () => admitted })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(reached);
            const wire = yield* encodeJson({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "mock-session-1",
                update: {
                  sessionUpdate: "plan",
                  entries: [
                    { content: "Late preparation plan", priority: "high", status: "pending" },
                  ],
                },
              },
            });
            yield* Effect.promise(() =>
              NodeFSP.writeFile(requestLogPath + ".notification", wire + "\n"),
            );
            const late = yield* Deferred.await(notification);
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(send);
            assert.isUndefined(late.turnId);
            if (admitted) {
              assert.isTrue(Exit.isSuccess(result));
              if (Exit.isSuccess(result))
                assert.equal(
                  events.filter(
                    (event) =>
                      event.type === "turn.started" && event.turnId === result.value.turnId,
                  ).length,
                  1,
                );
            } else {
              assert.isTrue(Exit.isFailure(result));
              assert.isTrue(events.every((event) => event.turnId === undefined));
              assert.isFalse(events.some((event) => event.type === "turn.started"));
            }
          }),
        ),
    );
  }

  it.effect("a refused steer after its turn's prompt finished still completes that turn", () =>
    provide(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        const { adapter, startSession, requestLogPath } = yield* makeSetup(
          Effect.gen(function* () {
            reads += 1;
            if (reads === 2) {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
            }
            return "";
          }),
          { T3_ACP_HANG_PROMPT_FOREVER: "1" },
        );
        const dispatched = yield* Effect.callback<void>((resume) => {
          const watcher = NodeFS.watch(requestLogPath, () => {
            if (recordedPromptRequests(requestLogPath).length === 1) resume(Effect.void);
          });
          return Effect.sync(() => watcher.close());
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const events: ProviderRuntimeEvent[] = [];
        // session.exited comes after every turn event, so seeing it on this
        // same subscription is the receipt that the completion was collected.
        const drained = yield* Deferred.make<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          events.push(event);
          return event.type === "session.exited"
            ? Deferred.succeed(drained, undefined)
            : Effect.void;
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const threadId = ThreadId.make("refused-steer-completion");
        yield* startSession(threadId);
        const first = yield* adapter
          .sendTurn({ threadId, input: hydratedInput })
          .pipe(Effect.forkChild);
        yield* Fiber.join(dispatched);
        const second = yield* adapter
          .sendTurn({ threadId, input: hydratedInput }, { admit: () => false })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reached);
        yield* adapter.interruptTurn(threadId);
        const turn = yield* Fiber.join(first);
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(second)));
        yield* adapter.stopSession(threadId);
        yield* Deferred.await(drained);
        assert.equal(
          events.filter((event) => event.type === "turn.completed" && event.turnId === turn.turnId)
            .length,
          1,
        );
      }),
    ),
  );

  it.effect("a send made while a memory send is still preparing joins that send's turn", () =>
    provide(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { adapter, startSession } = yield* makeSetup(
          Effect.gen(function* () {
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
            return "";
          }),
        );
        const threadId = ThreadId.make("thread-cursor-steer-while-preparing");
        yield* startSession(threadId);
        const sendA = yield* adapter
          .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reached);
        const sendB = yield* adapter
          .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        const exitA = yield* Fiber.join(sendA);
        const exitB = yield* Fiber.join(sendB);
        assert.isTrue(Exit.isSuccess(exitA));
        assert.isTrue(Exit.isSuccess(exitB));
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB))
          assert.equal(exitA.value.turnId, exitB.value.turnId);
      }),
    ),
  );

  it.effect(
    "a send joining a refused memory send's turn announces that turn once it is admitted",
    () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const { adapter, startSession } = yield* makeSetup(
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
          );
          const threadId = ThreadId.make("thread-cursor-join-refused-preparing");
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* startSession(threadId);
          const sendA = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => false })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(reached);
          const sendB = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(sendA)));
          const exitB = yield* Fiber.join(sendB);
          assert.isTrue(Exit.isSuccess(exitB));
          const turnId = Exit.isSuccess(exitB) ? exitB.value.turnId : undefined;
          const turnEvents = (yield* Fiber.join(eventsFiber)).filter(
            (event) => event.turnId === turnId,
          );
          assert.equal(turnEvents.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(turnEvents[0]?.type, "turn.started");
        }),
      ),
  );

  it.effect(
    "a plain send joining a refused memory send's turn announces that turn once it is admitted",
    () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const { adapter, startSession } = yield* makeSetup(
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
          );
          const threadId = ThreadId.make("thread-cursor-plain-join-refused-preparing");
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* startSession(threadId);
          const sendA = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => false })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(reached);
          const sendB = yield* adapter
            .sendTurn({ threadId, input: "Plain follow-up." })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(sendA)));
          const exitB = yield* Fiber.join(sendB);
          assert.isTrue(Exit.isSuccess(exitB));
          const turnId = Exit.isSuccess(exitB) ? exitB.value.turnId : undefined;
          const turnEvents = (yield* Fiber.join(eventsFiber)).filter(
            (event) => event.turnId === turnId,
          );
          assert.equal(turnEvents.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(turnEvents[0]?.type, "turn.started");
        }),
      ),
  );

  it.effect(
    "a send arriving after a joined memory send is refused joins the still-preparing turn and completes it once",
    () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const releaseA = yield* Deferred.make<void>();
          const releaseRest = yield* Deferred.make<void>();
          let calls = 0;
          const { adapter, startSession } = yield* makeSetup(
            Effect.gen(function* () {
              const call = calls;
              calls += 1;
              if (call === 0) {
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(releaseA);
              } else {
                yield* Deferred.await(releaseRest);
              }
              return "";
            }),
          );
          const threadId = ThreadId.make("thread-cursor-late-join-after-refusal");
          const events: Array<ProviderRuntimeEvent> = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkChild,
          );
          yield* startSession(threadId);
          const sendA = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => false })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(reached);
          const sendB = yield* adapter
            .sendTurn({ threadId, input: "Plain follow-up." })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseA, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(sendA)));
          const sendC = yield* adapter
            .sendTurn({ threadId, input: "Another follow-up." })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseRest, undefined);
          const exitB = yield* Fiber.join(sendB);
          const exitC = yield* Fiber.join(sendC);
          assert.isTrue(Exit.isSuccess(exitB));
          assert.isTrue(Exit.isSuccess(exitC));
          if (!Exit.isSuccess(exitB) || !Exit.isSuccess(exitC)) return;
          assert.equal(exitB.value.turnId, exitC.value.turnId);
          for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
          const boundaries = events
            .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
            .map((event) => `${event.type}:${event.turnId === exitB.value.turnId}`);
          assert.deepEqual(boundaries, ["turn.started:true", "turn.completed:true"]);
        }),
      ),
  );

  it.effect(
    "delivers the hydrated memory envelope in session/prompt after the publish admission",
    () =>
      provide(
        Effect.gen(function* () {
          assert.include(hydratedInput, SECRET_BODY);
          const { adapter, requestLogPath, startSession } = yield* makeSetup();
          const threadId = ThreadId.make("thread-cursor-memory-ok");
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const session = yield* startSession(threadId);
          const support = adapter.memoryAdmission;
          assert.isDefined(support);
          const generation = support!.sessionGeneration(threadId);
          assert.isDefined(generation);
          // The same cursor the directory persists names the provider session the send must publish on.
          const expectedSid = support!.nativeSessionId(session.resumeCursor);
          assert.isDefined(expectedSid);

          const observed: Array<ProviderAdmissionObservation> = [];
          const turn = yield* adapter.sendTurn(
            { threadId, input: hydratedInput },
            {
              admit: (observation) => {
                observed.push(observation);
                return true;
              },
            },
          );

          const turnEvents = (yield* Fiber.join(eventsFiber)).filter(
            (event) => event.turnId === turn.turnId,
          );
          assert.equal(turnEvents.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(turnEvents[0]?.type, "turn.started");

          assert.deepEqual(observed, [
            { sessionGeneration: generation!, nativeSessionId: expectedSid! },
          ]);
          const promptRequests = recordedPromptRequests(requestLogPath);
          assert.equal(promptRequests.length, 1);
          assert.include(yield* encodeJson(promptRequests[0]?.params), SECRET_BODY);
        }),
      ),
  );

  it.effect("sends no session/prompt when the publish admission refuses", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, requestLogPath, startSession } = yield* makeSetup();
        const threadId = ThreadId.make("thread-cursor-memory-refused");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
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

        // A refused send never reached the agent, so the next one still carries the runtime note.
        const followUp = yield* adapter.sendTurn({ threadId, input: "Plain follow-up." });
        const events = yield* Fiber.join(eventsFiber);
        // Only the admitted follow-up may open a turn; both refused fresh sends leave no start.
        assert.deepEqual(
          events.filter(
            (event) => event.type === "turn.started" && event.turnId !== followUp.turnId,
          ),
          [],
        );
        const promptRequests = recordedPromptRequests(requestLogPath);
        assert.equal(promptRequests.length, 1);
        assert.include(yield* encodeJson(promptRequests[0]?.params), "<runtime_info>");
      }),
    ),
  );

  it.effect(
    "reads a session replaced after the identity was captured as a different generation",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, requestLogPath, startSession } = yield* makeSetup();
          const threadId = ThreadId.make("thread-cursor-memory-replaced");
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

          yield* adapter.stopSession(threadId);
          // A stopped session reports no generation at all.
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );

  it.effect("refuses a stale context even when the gate itself is permissive", () =>
    provide(
      Effect.gen(function* () {
        // Park the send on the per-turn instructions read — the last await
        // before the admission — so the replacement deterministically lands
        // while the send is mid-flight.
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { adapter, requestLogPath, startSession } = yield* makeSetup(
          Effect.gen(function* () {
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
            return "";
          }),
        );
        const threadId = ThreadId.make("thread-cursor-memory-stale");
        yield* startSession(threadId);
        const captured = adapter.memoryAdmission!.sessionGeneration(threadId);
        assert.isDefined(captured);
        const send = yield* adapter
          .sendTurn({ threadId, input: hydratedInput }, { admit: () => true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reached);
        // A concurrent startSession swaps the map entry while the send holds
        // the context it resolved at entry.
        yield* startSession(threadId);
        assert.notEqual(adapter.memoryAdmission!.sessionGeneration(threadId), captured);
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Fiber.join(send);
        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual(recordedPromptRequests(requestLogPath), []);
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
              // Park the second send on its last await before the prompt, so
              // the flip below lands while it is queued rather than mid-prefix.
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
            // The first prompt never completes on its own; the test ends it
            // with an interrupt so the queued send reaches its publish point.
            { T3_ACP_HANG_PROMPT_FOREVER: "1" },
          );
          const threadId = ThreadId.make("thread-cursor-memory-queued");
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
          // Release the parked send and let it run into the runtime's prompt
          // queue while the gate is still open.
          yield* Deferred.succeed(release, undefined);
          yield* Effect.yieldNow;
          gate.open = false;

          // Ending the in-flight prompt frees the queue; the second send now
          // reaches its publish point and must find the gate closed.
          yield* adapter.interruptTurn(threadId);
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(first)));
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
          yield* adapter.interruptTurn(threadId);
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(third)));
        }),
      ),
  );
});
