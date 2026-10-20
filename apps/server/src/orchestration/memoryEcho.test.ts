import { assert, describe, expect, it } from "@effect/vitest";
import {
  EventId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  MEMORY_ECHO_WITHHELD_ERROR,
  MEMORY_ECHO_WITHHELD_NOTICE,
  carriesMemoryEchoField,
  lookupMemoryEchoThreadState,
  makeMemoryEchoGuard,
  memoryEchoThreadShouldWithhold,
  withholdMemoryEcho,
} from "./memoryEcho.ts";

const NOW = "2026-10-11T09:00:00.000Z";

type RuntimeErrorEvent = Extract<ProviderRuntimeEvent, { type: "runtime.error" }>;

const runtimeError = (threadId: ThreadId, eventId: string, message: string): RuntimeErrorEvent => ({
  type: "runtime.error",
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make("codex"),
  threadId,
  createdAt: NOW,
  turnId: TurnId.make("turn-1"),
  payload: { message, code: "E_TEST", class: "provider_error" },
});

const contentDelta = (
  threadId: ThreadId,
  eventId: string,
  delta: string,
): Extract<ProviderRuntimeEvent, { type: "content.delta" }> => ({
  type: "content.delta",
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make("codex"),
  threadId,
  createdAt: NOW,
  payload: { streamKind: "assistant_text", delta },
});

const expectMaskedError = (
  event: RuntimeErrorEvent,
  withheld: ProviderRuntimeEvent,
  marker: string,
) => {
  expect(withheld).toEqual({
    ...event,
    payload: { message: MEMORY_ECHO_WITHHELD_ERROR, class: "provider_error" },
  });
  expect(JSON.stringify(withheld)).not.toContain(marker);
};

const insertAttempt = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: string,
  state: string,
) =>
  sql`INSERT INTO project_memory_send_attempts (
    thread_id, message_id, project_id, provider_instance_id, owner_instance_id, state, committed_at, settled_at
  ) VALUES (${threadId}, ${messageId}, 'project-u3', 'codex', 'owner-u3', ${state}, ${NOW}, NULL)`;

// A SqlClient whose lookup is replaced by the injected effect, so failure
// shapes (defect, mixed cause, second-lookup dies) are deterministic.
const guardOverInjected = (injected: () => Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
  Effect.gen(function* () {
    const connection = {
      execute: (_sql: string, _params: ReadonlyArray<unknown>) => injected(),
      executeRaw: () => injected(),
      executeValues: () => injected(),
      executeValuesUnprepared: () => injected(),
      executeUnprepared: () => injected(),
      executeStream: () => Stream.die(new Error("unused stream")),
    } as Connection;
    return yield* makeMemoryEchoGuard.pipe(
      Effect.provide(
        Layer.effect(
          SqlClient.SqlClient,
          SqlClient.make({
            acquirer: Effect.succeed(connection),
            compiler: Statement.makeCompilerSqlite(),
            transactionAcquirer: Effect.succeed(connection),
            spanAttributes: [["db.system.name", "memory-echo-test"]],
            transformRows: undefined,
          }),
        ).pipe(Layer.provide(Reactivity.layer)),
      ),
    );
  });

describe("A-ECHO-1 memoryEcho", () => {
  describe("withholdMemoryEcho (U1)", () => {
    const thread = ThreadId.make("thread-u1");

    it.effect("masks the six persisted echo shapes, keeping typed data", () =>
      Effect.sync(() => {
        const mark = "A-ECHO-U1-MARK";

        const errorEvent: RuntimeErrorEvent = {
          ...runtimeError(thread, "evt-u1-error", `${mark} exploded`),
          payload: {
            message: `${mark} exploded`,
            code: `ERR_${mark}`,
            class: "provider_error",
            detail: { stack: mark },
          },
        };
        const withheldError = withholdMemoryEcho(errorEvent);
        // The marker sits in message, detail, and the free-string `code`;
        // none of the three survives.
        expectMaskedError(errorEvent, withheldError, mark);

        const warningEvent: Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> = {
          type: "runtime.warning",
          eventId: EventId.make("evt-u1-warning"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: { message: `warn ${mark}`, detail: { raw: mark } },
        };
        expect(withholdMemoryEcho(warningEvent)).toEqual({
          ...warningEvent,
          payload: { message: MEMORY_ECHO_WITHHELD_NOTICE },
        });

        const completedEvent: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
          type: "turn.completed",
          eventId: EventId.make("evt-u1-completed"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          turnId: TurnId.make("turn-1"),
          payload: {
            state: "failed",
            errorMessage: `${mark} quota exhausted`,
            usage: { native: true },
            tokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              inputTokens: 10,
              outputTokens: 5,
              hasSubagents: false,
            },
          },
        };
        const withheldCompleted = withholdMemoryEcho(completedEvent);
        expect(withheldCompleted).toEqual({
          ...completedEvent,
          payload: {
            ...completedEvent.payload,
            errorMessage: MEMORY_ECHO_WITHHELD_ERROR,
          },
        });
        if (withheldCompleted.type !== "turn.completed") {
          return assert.fail("expected the withheld event to stay turn.completed");
        }
        expect(withheldCompleted.payload.usage).toEqual({ native: true });
        expect(withheldCompleted.payload.tokenUsage).toEqual(completedEvent.payload.tokenUsage);

        const sessionErrorEvent: Extract<ProviderRuntimeEvent, { type: "session.state.changed" }> =
          {
            type: "session.state.changed",
            eventId: EventId.make("evt-u1-session"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { state: "error", reason: mark, detail: { raw: mark } },
          };
        expect(withholdMemoryEcho(sessionErrorEvent)).toEqual({
          ...sessionErrorEvent,
          payload: { state: "error", reason: MEMORY_ECHO_WITHHELD_ERROR },
        });

        const metadataEvent: Extract<ProviderRuntimeEvent, { type: "thread.metadata.updated" }> = {
          type: "thread.metadata.updated",
          eventId: EventId.make("evt-u1-metadata"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: { name: `Title ${mark}`, metadata: { source: "provider" } },
        };
        expect(withholdMemoryEcho(metadataEvent)).toEqual({
          ...metadataEvent,
          payload: { metadata: { source: "provider" } },
        });

        const compactedEvent: Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> = {
          type: "thread.state.changed",
          eventId: EventId.make("evt-u1-compacted"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: {
            state: "compacted",
            beforeTokens: 9000,
            afterTokens: 1200,
            detail: { raw: mark },
          },
        };
        expect(withholdMemoryEcho(compactedEvent)).toEqual({
          ...compactedEvent,
          payload: { state: "compacted", beforeTokens: 9000, afterTokens: 1200 },
        });
      }),
    );
  });

  describe("carriesMemoryEchoField and identity (U2)", () => {
    const thread = ThreadId.make("thread-u2");

    it.effect("returns non-target events by the same reference", () =>
      Effect.sync(() => {
        const mark = "A-ECHO-U2-MARK";
        const nonTargets: ReadonlyArray<ProviderRuntimeEvent> = [
          contentDelta(thread, "evt-u2-delta", mark),
          {
            type: "item.completed",
            eventId: EventId.make("evt-u2-tool"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { itemType: "command_execution", title: "Bash", detail: mark },
          },
          {
            type: "item.completed",
            eventId: EventId.make("evt-u2-native"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { itemType: "user_message", detail: mark },
          },
          {
            type: "task.started",
            eventId: EventId.make("evt-u2-task"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { taskId: RuntimeTaskId.make("task-1"), description: mark },
          },
          {
            type: "user-input.requested",
            eventId: EventId.make("evt-u2-input"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: {
              questions: [
                {
                  id: "q1",
                  header: "Approve",
                  question: mark,
                  options: [{ label: "Yes", description: "ok" }],
                },
              ],
            },
          },
          {
            type: "turn.completed",
            eventId: EventId.make("evt-u2-completed"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { state: "completed", stopReason: "end_turn" },
          },
          {
            type: "session.state.changed",
            eventId: EventId.make("evt-u2-session"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { state: "waiting", reason: mark },
          },
          {
            type: "thread.state.changed",
            eventId: EventId.make("evt-u2-thread-state"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { state: "active", detail: { raw: mark } },
          },
          {
            type: "session.exited",
            eventId: EventId.make("evt-u2-exited"),
            provider: ProviderDriverKind.make("codex"),
            threadId: thread,
            createdAt: NOW,
            payload: { reason: mark, recoverable: false },
          },
        ];
        for (const event of nonTargets) {
          assert.isFalse(carriesMemoryEchoField(event));
          assert.strictEqual(withholdMemoryEcho(event), event);
        }
      }),
    );
  });

  describe("makeMemoryEchoGuard (U3)", () => {
    it.effect("masks every committed attempt state (U3a)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const guard = yield* makeMemoryEchoGuard;
        const mark = "A-ECHO-U3A-MARK";
        const states = [
          "dispatch_committed",
          "provider_accepted",
          "external_send_unknown",
        ] as const;
        for (const [index, state] of states.entries()) {
          const threadId = ThreadId.make(`thread-u3a-${index}`);
          yield* insertAttempt(sql, threadId, `msg-u3a-${index}`, state);
          const event = runtimeError(threadId, `evt-u3a-${index}`, `${mark} ${state}`);
          expectMaskedError(event, yield* guard(event), mark);
        }
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    it.effect("has no negative cache — a clean thread taints once the row lands (U3b)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const guard = yield* makeMemoryEchoGuard;
        const mark = "A-ECHO-U3B-MARK";
        const threadId = ThreadId.make("thread-u3b");

        const before = runtimeError(threadId, "evt-u3b-1", `${mark} not yet`);
        assert.strictEqual(yield* guard(before), before);

        yield* insertAttempt(sql, threadId, "msg-u3b", "provider_accepted");
        expectMaskedError(
          runtimeError(threadId, "evt-u3b-2", `${mark} tainted`),
          yield* guard(runtimeError(threadId, "evt-u3b-2", `${mark} tainted`)),
          mark,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    it.effect("fails closed on lookup errors and recovers without caching the failure (U3c)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const guard = yield* makeMemoryEchoGuard;
        const mark = "A-ECHO-U3C-MARK";
        const tainted = ThreadId.make("thread-u3c-tainted");
        const untainted = ThreadId.make("thread-u3c-untainted");
        yield* insertAttempt(sql, tainted, "msg-u3c", "dispatch_committed");

        yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_attempts`;
        expectMaskedError(
          runtimeError(tainted, "evt-u3c-1", `${mark} tainted down`),
          yield* guard(runtimeError(tainted, "evt-u3c-1", `${mark} tainted down`)),
          mark,
        );
        const maskedUntainted = runtimeError(untainted, "evt-u3c-2", `${mark} clean down`);
        expectMaskedError(maskedUntainted, yield* guard(maskedUntainted), mark);

        yield* sql`ALTER TABLE broken_attempts RENAME TO project_memory_send_attempts`;
        const recovered = runtimeError(untainted, "evt-u3c-3", `${mark} recovered`);
        // The failed lookup was not cached as positive: the clean thread's raw
        // event survives again.
        assert.strictEqual(yield* guard(recovered), recovered);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    it.effect("still masks after reopening with a fresh guard (U3d)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const mark = "A-ECHO-U3D-MARK";
        const threadId = ThreadId.make("thread-u3d");
        yield* insertAttempt(sql, threadId, "msg-u3d", "external_send_unknown");

        const firstGuard = yield* makeMemoryEchoGuard;
        expectMaskedError(
          runtimeError(threadId, "evt-u3d-1", `${mark} first`),
          yield* firstGuard(runtimeError(threadId, "evt-u3d-1", `${mark} first`)),
          mark,
        );

        // A fresh guard starts with an empty cache and still masks: the
        // verdict comes from the durable rows, not from memory.
        const secondGuard = yield* makeMemoryEchoGuard;
        expectMaskedError(
          runtimeError(threadId, "evt-u3d-2", `${mark} second`),
          yield* secondGuard(runtimeError(threadId, "evt-u3d-2", `${mark} second`)),
          mark,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    it.effect("propagates an interrupt raised inside a parked lookup, caching nothing (U3e)", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const guard = yield* makeMemoryEchoGuard;
          const mark = "A-ECHO-U3E-MARK";
          const threadId = ThreadId.make("thread-u3e");

          // Park the shared connection the way the loggers' B2 test does, so
          // the guard's lookup blocks on the semaphore deterministically.
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const txFiber = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);

          const guardFiber = yield* guard(
            runtimeError(threadId, "evt-u3e-1", `${mark} parked`),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.interrupt(guardFiber);
          const exit = yield* Fiber.await(guardFiber);
          assert.isTrue(Exit.hasInterrupts(exit));

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(txFiber);

          // The interrupted lookup cached nothing: the still-untainted
          // thread gets its raw event back afterwards.
          const after = runtimeError(threadId, "evt-u3e-2", `${mark} after`);
          assert.strictEqual(yield* guard(after), after);
        }).pipe(Effect.provide(SqlitePersistenceMemory)),
      ),
    );

    it.effect("propagates the original mixed interrupt cause (U3f)", () =>
      Effect.gen(function* () {
        const mark = "A-ECHO-U3F-MARK";
        const injectedError = new SqlError({
          reason: classifySqliteError(new Error("injected lookup failure"), {
            message: "injected lookup failure",
            operation: "execute",
          }),
        });
        const mixedCause = Cause.combine(Cause.fail(injectedError), Cause.interrupt());
        const guard = yield* guardOverInjected(() => Effect.failCause(mixedCause));

        const exit = yield* Effect.exit(
          guard(runtimeError(ThreadId.make("thread-u3f"), "evt-u3f-1", `${mark} mixed`)),
        );
        if (!Exit.isFailure(exit)) {
          return assert.fail("expected the mixed cause to abort the event");
        }
        assert.isTrue(Cause.hasInterrupts(exit.cause));
        // The original cause comes back — not a fresh pure interrupt and not a
        // masked success: the typed component is still in the cause.
        assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injectedError));
      }),
    );

    it.effect("fails closed on defects without leaking cause or content (U3g)", () =>
      Effect.gen(function* () {
        const mark = "A-ECHO-U3G-MARK";
        const guard = yield* guardOverInjected(() => Effect.die(new Error("A-ECHO-DEFECT")));
        const event = runtimeError(ThreadId.make("thread-u3g"), "evt-u3g-1", `${mark} boom`);
        const result = yield* guard(event);
        expectMaskedError(event, result, mark);
        expect(JSON.stringify(result)).not.toContain("A-ECHO-DEFECT");
      }),
    );

    it.effect("serves cached positives without another SQL round trip (U3h)", () =>
      Effect.gen(function* () {
        const mark = "A-ECHO-U3H-MARK";
        let lookups = 0;
        const guard = yield* guardOverInjected(() => {
          lookups += 1;
          return lookups === 1
            ? Effect.succeed([{ exists: 1 }])
            : Effect.die(new Error("SECOND-LOOKUP-RAN"));
        });
        const threadId = ThreadId.make("thread-u3h");

        expectMaskedError(
          runtimeError(threadId, "evt-u3h-1", `${mark} first`),
          yield* guard(runtimeError(threadId, "evt-u3h-1", `${mark} first`)),
          mark,
        );
        // The backend is gone, but the cached positive still returns the
        // withheld event — the raw one cannot slip back through.
        expectMaskedError(
          runtimeError(threadId, "evt-u3h-2", `${mark} second`),
          yield* guard(runtimeError(threadId, "evt-u3h-2", `${mark} second`)),
          mark,
        );
        assert.strictEqual(lookups, 1);
      }),
    );

    it.effect("non-target events skip SQL entirely (U3i)", () =>
      Effect.gen(function* () {
        const mark = "A-ECHO-U3I-MARK";
        let lookups = 0;
        const guard = yield* guardOverInjected(() => {
          lookups++;
          return Effect.die(new Error("LOOKUP-RAN"));
        });
        const delta = contentDelta(ThreadId.make("thread-u3i"), "evt-u3i-1", mark);
        assert.strictEqual(yield* guard(delta), delta);
        assert.strictEqual(lookups, 0);
      }),
    );

    it.effect("does not cache unavailable as tainted — a later row still taints (U3j)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const guard = yield* makeMemoryEchoGuard;
        const mark = "A-ECHO-U3J-MARK";
        const threadId = ThreadId.make("thread-u3j");

        yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_attempts_u3j`;
        expectMaskedError(
          runtimeError(threadId, "evt-u3j-1", `${mark} unavailable`),
          yield* guard(runtimeError(threadId, "evt-u3j-1", `${mark} unavailable`)),
          mark,
        );

        yield* sql`ALTER TABLE broken_attempts_u3j RENAME TO project_memory_send_attempts`;
        yield* insertAttempt(sql, threadId, "msg-u3j", "dispatch_committed");
        expectMaskedError(
          runtimeError(threadId, "evt-u3j-2", `${mark} tainted`),
          yield* guard(runtimeError(threadId, "evt-u3j-2", `${mark} tainted`)),
          mark,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  });

  describe("lookupMemoryEchoThreadState (U4)", () => {
    it.effect("returns clean, tainted, and unavailable without caching", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tainted = ThreadId.make("thread-u4-tainted");
        const clean = ThreadId.make("thread-u4-clean");
        yield* insertAttempt(sql, tainted, "msg-u4", "provider_accepted");

        assert.strictEqual(yield* lookupMemoryEchoThreadState(sql, clean), "clean");
        assert.strictEqual(yield* lookupMemoryEchoThreadState(sql, tainted), "tainted");
        assert.isFalse(memoryEchoThreadShouldWithhold("clean"));
        assert.isTrue(memoryEchoThreadShouldWithhold("tainted"));
        assert.isTrue(memoryEchoThreadShouldWithhold("unavailable"));

        yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_attempts_u4`;
        assert.strictEqual(yield* lookupMemoryEchoThreadState(sql, clean), "unavailable");
        yield* sql`ALTER TABLE broken_attempts_u4 RENAME TO project_memory_send_attempts`;
        assert.strictEqual(yield* lookupMemoryEchoThreadState(sql, clean), "clean");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    it.effect("propagates mixed interrupt causes from the lookup (U4b)", () => {
      const injectedError = new SqlError({
        reason: classifySqliteError(new Error("u4 lookup failure"), {
          message: "u4 lookup failure",
          operation: "execute",
        }),
      });
      const mixedCause = Cause.combine(Cause.fail(injectedError), Cause.interrupt());
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          lookupMemoryEchoThreadState(yield* SqlClient.SqlClient, ThreadId.make("thread-u4b")),
        );
        if (!Exit.isFailure(exit)) {
          return assert.fail("expected mixed cause to fail the lookup");
        }
        assert.isTrue(Cause.hasInterrupts(exit.cause));
        assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injectedError));
      }).pipe(
        Effect.provide(
          Layer.effect(
            SqlClient.SqlClient,
            Effect.gen(function* () {
              const connection = {
                execute: () => Effect.failCause(mixedCause),
                executeRaw: () => Effect.failCause(mixedCause),
                executeValues: () => Effect.failCause(mixedCause),
                executeValuesUnprepared: () => Effect.failCause(mixedCause),
                executeUnprepared: () => Effect.failCause(mixedCause),
                executeStream: () => Stream.die(new Error("unused stream")),
              } as Connection;
              return yield* SqlClient.make({
                acquirer: Effect.succeed(connection),
                compiler: Statement.makeCompilerSqlite(),
                transactionAcquirer: Effect.succeed(connection),
                spanAttributes: [["db.system.name", "memory-echo-test"]],
                transformRows: undefined,
              });
            }),
          ).pipe(Layer.provide(Reactivity.layer)),
        ),
      );
    });
  });

  describe("A-ECHO-2 withholdMemoryEcho (U5)", () => {
    const thread = ThreadId.make("thread-u5");
    const claudeProvider = ProviderDriverKind.make("claudeAgent");
    const claudeErrorRaw = {
      source: "claude.sdk.message" as const,
      method: "claude/assistant",
      payload: { type: "assistant", error: "authentication_failed" },
    };

    it.effect("omits tool.denied.reason and replaces task errors", () =>
      Effect.sync(() => {
        const mark = "A-ECHO-U5-MARK";
        const denied: Extract<ProviderRuntimeEvent, { type: "tool.denied" }> = {
          type: "tool.denied",
          eventId: EventId.make("evt-u5-denied"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: { toolName: "Bash", toolUseId: "tu-1", reason: mark, agentId: "agent-1" },
        };
        const withheldDenied = withholdMemoryEcho(denied);
        expect(withheldDenied.payload).toEqual({
          toolName: "Bash",
          toolUseId: "tu-1",
          agentId: "agent-1",
        });

        const progress: Extract<ProviderRuntimeEvent, { type: "task.progress" }> = {
          type: "task.progress",
          eventId: EventId.make("evt-u5-progress"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: {
            taskId: RuntimeTaskId.make("task-u5"),
            description: "Working",
            error: mark,
            typedUsage: { totalTokens: 12 },
          },
        };
        expect(withholdMemoryEcho(progress).payload.error).toBe(MEMORY_ECHO_WITHHELD_ERROR);

        const updated: Extract<ProviderRuntimeEvent, { type: "task.updated" }> = {
          type: "task.updated",
          eventId: EventId.make("evt-u5-updated"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: {
            taskId: RuntimeTaskId.make("task-u5"),
            status: "failed",
            error: mark,
            endedAt: NOW,
          },
        };
        expect(withholdMemoryEcho(updated).payload.error).toBe(MEMORY_ECHO_WITHHELD_ERROR);
      }),
    );

    it.effect("drops failed task.completed.summary while preserving success summaries", () =>
      Effect.sync(() => {
        const mark = "A-ECHO-U5-SUMMARY";
        const failed: Extract<ProviderRuntimeEvent, { type: "task.completed" }> = {
          type: "task.completed",
          eventId: EventId.make("evt-u5-failed"),
          provider: ProviderDriverKind.make("codex"),
          threadId: thread,
          createdAt: NOW,
          payload: {
            taskId: RuntimeTaskId.make("task-u5"),
            status: "failed",
            summary: mark,
            typedUsage: { totalTokens: 3 },
          },
        };
        expect(withholdMemoryEcho(failed).payload.summary).toBeUndefined();

        const succeeded: Extract<ProviderRuntimeEvent, { type: "task.completed" }> = {
          ...failed,
          eventId: EventId.make("evt-u5-ok"),
          payload: { ...failed.payload, status: "completed", summary: mark },
        };
        assert.isFalse(carriesMemoryEchoField(succeeded));
        assert.strictEqual(withholdMemoryEcho(succeeded), succeeded);
      }),
    );

    it.effect("masks Claude error-bearing assistant snapshots only", () =>
      Effect.sync(() => {
        const mark = "A-ECHO-U5-CLAUDE";
        const delta: Extract<ProviderRuntimeEvent, { type: "content.delta" }> = {
          type: "content.delta",
          eventId: EventId.make("evt-u5-delta"),
          provider: claudeProvider,
          threadId: thread,
          createdAt: NOW,
          raw: claudeErrorRaw,
          payload: { streamKind: "assistant_text", delta: mark },
        };
        expect(withholdMemoryEcho(delta).payload.delta).toBe(MEMORY_ECHO_WITHHELD_ERROR);

        const completed: Extract<ProviderRuntimeEvent, { type: "item.completed" }> = {
          type: "item.completed",
          eventId: EventId.make("evt-u5-item"),
          provider: claudeProvider,
          threadId: thread,
          createdAt: NOW,
          raw: claudeErrorRaw,
          payload: { itemType: "assistant_message", detail: mark },
        };
        expect(withholdMemoryEcho(completed).payload.detail).toBe(MEMORY_ECHO_WITHHELD_ERROR);

        const maxTokens: Extract<ProviderRuntimeEvent, { type: "content.delta" }> = {
          ...delta,
          eventId: EventId.make("evt-u5-max"),
          raw: {
            ...claudeErrorRaw,
            payload: { type: "assistant", error: "max_output_tokens" },
          },
          payload: { streamKind: "assistant_text", delta: mark },
        };
        assert.isFalse(carriesMemoryEchoField(maxTokens));
        assert.strictEqual(withholdMemoryEcho(maxTokens), maxTokens);

        const normalSnapshot: Extract<ProviderRuntimeEvent, { type: "content.delta" }> = {
          ...delta,
          eventId: EventId.make("evt-u5-normal"),
          raw: {
            source: "claude.sdk.message" as const,
            method: "claude/assistant",
            payload: { type: "assistant" },
          },
        };
        assert.isFalse(carriesMemoryEchoField(normalSnapshot));

        const emptyError: Extract<ProviderRuntimeEvent, { type: "content.delta" }> = {
          ...delta,
          eventId: EventId.make("evt-u5-empty-error"),
          raw: {
            ...claudeErrorRaw,
            payload: { type: "assistant", error: "" },
          },
        };
        assert.isFalse(carriesMemoryEchoField(emptyError));
        assert.strictEqual(withholdMemoryEcho(emptyError), emptyError);
      }),
    );
  });
});
