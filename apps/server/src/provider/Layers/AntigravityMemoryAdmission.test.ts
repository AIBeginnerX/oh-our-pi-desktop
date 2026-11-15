/**
 * Project memory on the Antigravity path: boots the REAL AntigravityAdapter
 * over the REAL ACP runtime against the mock agent peer and checks what the
 * peer receives. The envelope the orchestrator hydrates must arrive in
 * `session/prompt`, and the publish admission must be the last word: a
 * refusal, or a context that was replaced or stopped after the caller
 * captured its identity, sends no prompt at all and leaves no turn boundary.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ComposerContextId,
  type ComposerContextRecord,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Cause from "effect/Cause";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProviderAdmissionObservation } from "../Services/ProviderAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { makeAntigravityAcpRuntime } from "../acp/AntigravityAcpSupport.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const SECRET_BODY = "ANTIGRAVITY-MEMORY-BODY-9e4f2a";

const mockAgentPath = NodePath.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");

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

type TurnCompletedEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

const makeSetup = (agentInstructions?: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-memory-workspace-")),
    );
    const requestLogPath = NodePath.join(workspace, "requests.ndjson");
    yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
    const crypto = yield* Crypto.Crypto;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const injectedEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const observedEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({ enabled: true }), {
      instanceId: ProviderInstanceId.make("antigravity-memory-test"),
      withProcess: (_stop, task) => task,
      ...(agentInstructions ? { agentInstructions } : {}),
      makeRuntime: (input) =>
        makeAntigravityAcpRuntime({
          ...input,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: input.cwd,
            env: {
              ...process.env,
              T3_ACP_ANTIGRAVITY: "1",
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
            extendEnv: false,
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime) => ({
            ...runtime,
            getEvents: () => Stream.merge(runtime.getEvents(), Stream.fromQueue(injectedEvents)),
          })),
        ),
    });
    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    // Turn boundaries arrive on the adapter's event stream; the queue is the
    // receipt a test waits on instead of polling.
    const turnCompletions = yield* Queue.unbounded<TurnCompletedEvent>();
    // Every event in arrival order; complete up to the last completion taken.
    const seen: Array<ProviderRuntimeEvent> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => {
        seen.push(event);
        Queue.offerUnsafe(observedEvents, event);
        return event.type === "turn.completed"
          ? Queue.offer(turnCompletions, event).pipe(Effect.asVoid)
          : Effect.void;
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    const startSession = (threadId: ThreadId, resumeCursor?: ProviderSession["resumeCursor"]) =>
      adapter.startSession({
        provider: ANTIGRAVITY,
        threadId,
        cwd: workspace,
        runtimeMode: "full-access",
        ...(resumeCursor ? { resumeCursor } : {}),
      });
    return {
      adapter,
      injectedEvents,
      observedEvents,
      requestLogPath,
      startSession,
      seen,
      nextTurnCompletion: Queue.take(turnCompletions),
    } as const;
  });

const testLayer = ServerConfig.layerTest(NodeOS.tmpdir(), {
  prefix: "t3-antigravity-memory-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const provide = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof testLayer>>,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("Antigravity project memory admission", () => {
  for (const admitted of [false, true]) {
    it.effect(`keeps preparation-window output unbound when admission is ${admitted}`, () =>
      provide(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const { adapter, startSession, seen, injectedEvents, observedEvents } = yield* makeSetup(
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
              return "";
            }),
          );
          const threadId = ThreadId.make(`preparation-${admitted}`);
          yield* startSession(threadId);
          const send = yield* adapter
            .sendTurn({ threadId, input: hydratedInput }, { admit: () => admitted })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(reached);
          yield* Queue.offer(injectedEvents, {
            _tag: "ContentDelta",
            text: "late preparation output",
            rawPayload: {},
          });
          let late: ProviderRuntimeEvent;
          do {
            late = yield* Queue.take(observedEvents);
          } while (late.type !== "content.delta");
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(send);
          assert.equal(Exit.isSuccess(result), admitted);
          const starts = seen.filter((event) => event.type === "turn.started");
          assert.equal(starts.length, admitted ? 1 : 0);
          // With no previous turn, late output must remain unbound even if
          // this send later receives admission.
          assert.isUndefined("turnId" in late ? late.turnId : undefined);
          if (!admitted) {
            assert.isFalse(seen.some((event) => "turnId" in event && event.turnId !== undefined));
          }
        }),
      ),
    );
  }

  it.effect(
    "delivers the hydrated memory envelope in session/prompt after the publish admission",
    () =>
      provide(
        Effect.gen(function* () {
          assert.include(hydratedInput, SECRET_BODY);
          const { adapter, requestLogPath, startSession, seen, nextTurnCompletion } =
            yield* makeSetup();
          const threadId = ThreadId.make("thread-antigravity-memory-ok");
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

          assert.deepEqual(observed, [
            { sessionGeneration: generation!, nativeSessionId: expectedSid! },
          ]);
          const completion = yield* nextTurnCompletion;
          assert.equal(completion.turnId, result.turnId);
          // The admitted turn is announced once, ahead of every other event it carries.
          const turnEvents = seen.filter(
            (event) => "turnId" in event && event.turnId === result.turnId,
          );
          assert.equal(turnEvents.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(turnEvents[0]?.type, "turn.started");
          const promptRequests = recordedPromptRequests(requestLogPath);
          assert.equal(promptRequests.length, 1);
          const sent = yield* encodeJson(promptRequests[0]?.params);
          assert.include(sent, SECRET_BODY);
          // The project-memory runtime note rides with the admitted prompt.
          assert.include(sent, "<project_memory>");
        }),
      ),
  );

  it.effect("sends no session/prompt when the publish admission refuses", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, requestLogPath, startSession, seen, nextTurnCompletion } =
          yield* makeSetup();
        const threadId = ThreadId.make("thread-antigravity-memory-refused");
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
        // The refusals restored the turn state: the session drained back to
        // ready with no active turn, and the only turn boundary on the stream
        // belongs to the follow-up below.
        const live = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );
        assert.equal(live?.status, "ready");
        assert.equal(live?.activeTurnId, undefined);

        // A refused send never reached the agent, so the next one still carries
        // the runtime note — the refused sends must not have recorded it.
        const followUp = yield* adapter.sendTurn({ threadId, input: "Plain follow-up." });
        const completion = yield* nextTurnCompletion;
        assert.equal(completion.turnId, followUp.turnId);
        // Neither refusal announced a turn: the only start is the follow-up's.
        assert.deepEqual(
          seen.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          [followUp.turnId],
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
          const threadId = ThreadId.make("thread-antigravity-memory-replaced");
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
          const failure = Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : undefined;
          assert.equal(failure?._tag, "ProviderAdapterSessionClosedError");
          assert.deepEqual(recordedPromptRequests(requestLogPath), []);

          yield* adapter.stopSession(threadId);
          // A stopped session reports no generation at all.
          assert.isUndefined(adapter.memoryAdmission!.sessionGeneration(threadId));
        }),
      ),
  );

  it.effect("fails closed when the context is stopped while the send is mid-flight", () =>
    provide(
      Effect.gen(function* () {
        // Park the send on its per-turn instructions read — the adapter's last
        // await before model selection and the publish point — and stop the
        // session underneath it. stopAll takes no lock the parked send holds.
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let instructionsReads = 0;
        const { adapter, requestLogPath, startSession } = yield* makeSetup(
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
        const threadId = ThreadId.make("thread-antigravity-memory-stale");
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

        // The send fails closed without publishing. Antigravity runs model
        // selection RPCs before its publish point, so a session that died
        // mid-flight surfaces as a runtime error rather than the publish
        // refusal's session-closed error; either way nothing reaches the peer.
        const sendExit = yield* Fiber.join(send);
        assert.isTrue(Exit.isFailure(sendExit));
        assert.deepEqual(recordedPromptRequests(requestLogPath), []);
      }),
    ),
  );

  it.effect(
    "issues a new session generation when a stopped session restarts on the same native id",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, startSession } = yield* makeSetup();
          const threadId = ThreadId.make("thread-antigravity-memory-restart");
          const first = yield* startSession(threadId);
          const support = adapter.memoryAdmission;
          assert.isDefined(support);
          const firstGeneration = support!.sessionGeneration(threadId);
          const firstSid = support!.nativeSessionId(first.resumeCursor);
          assert.isDefined(firstGeneration);
          assert.isDefined(firstSid);

          yield* adapter.stopSession(threadId);
          assert.isUndefined(support!.sessionGeneration(threadId));

          // The mock agent answers the resume with the same native session id.
          const second = yield* startSession(threadId, first.resumeCursor);
          const secondGeneration = support!.sessionGeneration(threadId);
          const secondSid = support!.nativeSessionId(second.resumeCursor);
          assert.isDefined(secondGeneration);
          assert.notEqual(secondGeneration, firstGeneration);
          assert.equal(secondSid, firstSid);
        }),
      ),
  );
});
