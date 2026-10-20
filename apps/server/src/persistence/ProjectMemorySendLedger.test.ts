// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import {
  type AcknowledgeProjectMemoryChangesInput,
  type CommitProjectMemoryDispatchInput,
  type RevalidateProjectMemoryDispatchInput,
  make,
  ProjectMemorySendLedger,
  layer as sendLedgerLayer,
} from "./ProjectMemorySendLedger.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

const NOW_ISO = "2026-10-11T09:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);

const combinedLayer = (dbPath: string) =>
  sendLedgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })));

// One fresh file database per test; the ledger layer rides on the same client.
function withTestLedger<A, E, R>(
  run: (dbPath: string) => Effect.Effect<A, E, R | ProjectMemorySendLedger | SqlClient.SqlClient>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-send-ledger-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return run(dbPath).pipe(
    Effect.provide(combinedLayer(dbPath)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

// Bare file handle for tests that manage their own client lifecycles (L5).
function withDbFile<A, E, R>(run: (dbPath: string) => Effect.Effect<A, E, R>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-send-ledger-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return run(dbPath).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

// An independent client on the same file, disposed when the effect ends.
const runWithClient = <A, E, R>(
  dbPath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(NodeSqliteClient.layer({ filename: dbPath })), (context) =>
      Effect.provide(effect, context),
    ),
  );

// An independent client plus a freshly-owned ledger (new ownerInstanceId).
// Layer.fresh bypasses the ambient memo map — otherwise a previously built
// sendLedgerLayer would be returned instead of a distinct owner instance.
const runIsolatedLedger = <A, E, R>(
  dbPath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient | ProjectMemorySendLedger>,
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(Layer.fresh(combinedLayer(dbPath))), (context) =>
      Effect.provide(effect, context),
    ),
  );

const test = (
  name: string,
  run: (
    dbPath: string,
  ) => Effect.Effect<unknown, unknown, ProjectMemorySendLedger | SqlClient.SqlClient>,
) => it.effect(name, () => withTestLedger((dbPath) => run(dbPath)));

const setPragmas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA busy_timeout = 5000`;
});

const seedProject = (projectId: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW_ISO}, ${NOW_ISO}, ${deletedAt})
    `;
  });

const seedThread = (projectId: string, threadId: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (
        ${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default',
        ${NOW_ISO}, ${NOW_ISO}, ${deletedAt}
      )
    `;
  });

const seedMessage = (threadId: string, messageId: string, role = "user") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, ${role}, 'text', 0, ${NOW_ISO}, ${NOW_ISO})
    `;
  });

const seedMemory = (input: {
  readonly memoryId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly version?: number | string;
  readonly validUntil?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (
        ${input.memoryId}, ${input.projectId ?? "project-1"}, 'fact',
        ${input.title ?? "Deploy runbook"}, ${input.body ?? "Restart the server"},
        ${input.version ?? 1}, 'manual', NULL, NULL,
        ${input.validUntil ?? null}, 10, ${NOW_ISO}, ${NOW_ISO}
      )
    `;
  });

// Standard provenance: live project, live thread, user message, live memory.
const seedSendContext = Effect.gen(function* () {
  yield* seedProject("project-1");
  yield* seedThread("project-1", "thread-1");
  yield* seedMessage("thread-1", "message-1");
  yield* seedMemory({ memoryId: "mem-1" });
});

const commitInput = (
  overrides: {
    readonly threadId?: string;
    readonly messageId?: string;
    readonly projectId?: string;
    readonly providerInstanceId?: string;
    readonly items?: ReadonlyArray<{
      readonly memoryId: string;
      readonly selectedVersion: number;
    }>;
    readonly now?: DateTime.Utc;
  } = {},
): CommitProjectMemoryDispatchInput => ({
  threadId: ThreadId.make(overrides.threadId ?? "thread-1"),
  messageId: MessageId.make(overrides.messageId ?? "message-1"),
  projectId: ProjectId.make(overrides.projectId ?? "project-1"),
  providerInstanceId: ProviderInstanceId.make(overrides.providerInstanceId ?? "pi"),
  items: overrides.items?.map((item) => ({
    memoryId: ProjectMemoryId.make(item.memoryId),
    selectedVersion: item.selectedVersion,
  })) ?? [{ memoryId: ProjectMemoryId.make("mem-1"), selectedVersion: 1 }],
  now: overrides.now ?? NOW,
});

const attemptRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly attemptSeq: number;
    readonly threadId: string;
    readonly messageId: string;
    readonly projectId: string;
    readonly providerInstanceId: string;
    readonly ownerInstanceId: string;
    readonly state: string;
    readonly committedAt: string;
    readonly settledAt: string | null;
  }>`
    SELECT attempt_seq AS "attemptSeq", thread_id AS "threadId", message_id AS "messageId",
           project_id AS "projectId", provider_instance_id AS "providerInstanceId",
           owner_instance_id AS "ownerInstanceId", state,
           committed_at AS "committedAt", settled_at AS "settledAt"
    FROM project_memory_send_attempts
    ORDER BY attempt_seq ASC
  `;
});

const itemRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly attemptSeq: number;
    readonly memoryId: string;
    readonly memoryVersion: number;
  }>`
    SELECT attempt_seq AS "attemptSeq", memory_id AS "memoryId", memory_version AS "memoryVersion"
    FROM project_memory_send_items
    ORDER BY attempt_seq ASC, memory_id ASC
  `;
});

const bumpMemory = (memoryId: string, suffix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE project_memories
      SET title = ${`Runbook ${suffix}`}, version = version + 1
      WHERE memory_id = ${memoryId}
    `;
  });

const ackRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly threadId: string; readonly acked: number }>`
    SELECT thread_id AS "threadId", acked_through_change_seq AS "acked"
    FROM project_memory_thread_acks
    ORDER BY thread_id ASC
  `;
});

const ackInput = (
  overrides: {
    readonly threadId?: string;
    readonly throughChangeSeq?: number;
    readonly expectedProjectId?: string;
  } = {},
): AcknowledgeProjectMemoryChangesInput => ({
  threadId: ThreadId.make(overrides.threadId ?? "thread-1"),
  throughChangeSeq: overrides.throughChangeSeq ?? 1,
  ...(overrides.expectedProjectId === undefined
    ? {}
    : { expectedProjectId: ProjectId.make(overrides.expectedProjectId) }),
});

const revalidateInput = (
  overrides: {
    readonly threadId?: string;
    readonly attemptSeq?: number;
    readonly providerInstanceId?: string;
  } = {},
): RevalidateProjectMemoryDispatchInput => ({
  threadId: ThreadId.make(overrides.threadId ?? "thread-1"),
  attemptSeq: overrides.attemptSeq ?? 1,
  providerInstanceId: ProviderInstanceId.make(overrides.providerInstanceId ?? "pi"),
});

describe("ProjectMemorySendLedger", () => {
  test("L1 committed result matches the stored version and is visible to an independent client", (dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-2", title: "Second", body: "Body two" });

      const result = yield* ledger.commitDispatch(
        commitInput({
          items: [
            { memoryId: "mem-1", selectedVersion: 1 },
            // Duplicate id collapses into the first selection.
            { memoryId: "mem-1", selectedVersion: 1 },
            { memoryId: "mem-2", selectedVersion: 1 },
          ],
        }),
      );
      assert.deepEqual(result, {
        status: "committed",
        attemptSeq: 1,
        memories: [
          {
            memoryId: ProjectMemoryId.make("mem-1"),
            version: 1,
            kind: "fact",
            title: "Deploy runbook",
            body: "Restart the server",
          },
          {
            memoryId: ProjectMemoryId.make("mem-2"),
            version: 1,
            kind: "fact",
            title: "Second",
            body: "Body two",
          },
        ],
      });

      const attempts = yield* attemptRows;
      assert.equal(attempts.length, 1);
      assert.deepEqual(
        attempts[0] && {
          threadId: attempts[0].threadId,
          messageId: attempts[0].messageId,
          projectId: attempts[0].projectId,
          providerInstanceId: attempts[0].providerInstanceId,
          state: attempts[0].state,
          committedAt: attempts[0].committedAt,
          settledAt: attempts[0].settledAt,
        },
        {
          threadId: "thread-1",
          messageId: "message-1",
          projectId: "project-1",
          providerInstanceId: "pi",
          state: "dispatch_committed",
          committedAt: NOW_ISO,
          settledAt: null,
        },
      );
      assert.equal(typeof attempts[0]?.ownerInstanceId, "string");
      assert.notEqual(attempts[0]?.ownerInstanceId, "");

      const items = yield* itemRows;
      assert.deepEqual(items, [
        { attemptSeq: 1, memoryId: "mem-1", memoryVersion: 1 },
        { attemptSeq: 1, memoryId: "mem-2", memoryVersion: 1 },
      ]);

      // The row is already committed when the caller receives the result:
      // an independent client on the same file sees it.
      const visible = yield* runWithClient(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS "n" FROM project_memory_send_attempts
            `;
        }),
      );
      assert.equal(visible[0]?.n, 1);
    }));

  test("L2 nested transaction: rejected before SQL, outer commit leaves no rows", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const error = yield* sql.withTransaction(Effect.flip(ledger.commitDispatch(commitInput())));
      assert.ok(error instanceof PersistenceSqlError);
      assert.equal(error.detail, "nested-transaction");
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L3 empty and oversized inputs hold before touching the store", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-big", body: "x".repeat(32_001) });

      assert.deepEqual(yield* ledger.commitDispatch(commitInput({ items: [] })), {
        status: "held",
        reason: "empty",
      });
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({
            items: Array.from({ length: 9 }, (_, i) => ({
              memoryId: `mem-${i}`,
              selectedVersion: 1,
            })),
          }),
        ),
        { status: "held", reason: "too-large" },
      );
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({ items: [{ memoryId: "mem-big", selectedVersion: 1 }] }),
        ),
        { status: "held", reason: "too-large" },
      );
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L3 version-changed holds for conflicting selections and stale versions", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-v2", version: 2 });
      yield* seedMessage("thread-1", "message-2");

      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({
            items: [
              { memoryId: "mem-1", selectedVersion: 1 },
              { memoryId: "mem-1", selectedVersion: 2 },
            ],
          }),
        ),
        { status: "held", reason: "version-changed" },
      );
      // Requested version must equal the stored version.
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({
            messageId: "message-2",
            items: [{ memoryId: "mem-v2", selectedVersion: 1 }],
          }),
        ),
        { status: "held", reason: "version-changed" },
      );
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L3 unavailable holds for missing rows and unparseable expiry", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedProject("project-2");
      yield* seedMemory({ memoryId: "mem-other", projectId: "project-2" });
      yield* seedMemory({ memoryId: "mem-bad-date", validUntil: "garbage" });
      yield* seedMessage("thread-1", "message-2");
      yield* seedMessage("thread-1", "message-3");

      // Deleted row: project stays live, the memory row itself is gone.
      yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-1'`;
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({ items: [{ memoryId: "mem-1", selectedVersion: 1 }] }),
        ),
        { status: "held", reason: "unavailable" },
      );
      // A live memory under another project does not resolve.
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({
            messageId: "message-2",
            items: [{ memoryId: "mem-other", selectedVersion: 1 }],
          }),
        ),
        { status: "held", reason: "unavailable" },
      );
      assert.deepEqual(
        yield* ledger.commitDispatch(
          commitInput({
            messageId: "message-3",
            items: [{ memoryId: "mem-bad-date", selectedVersion: 1 }],
          }),
        ),
        { status: "held", reason: "unavailable" },
      );
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L3 expired holds compare numerically, offsets included", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({
        memoryId: "mem-past",
        validUntil: "2026-10-11T08:59:59.000Z",
      });
      yield* seedMemory({ memoryId: "mem-equal", validUntil: NOW_ISO });
      // Same instant written with an offset: 09:00+09:00 == 00:00Z <= now.
      yield* seedMemory({
        memoryId: "mem-offset",
        validUntil: "2026-10-11T09:00:00+09:00",
      });
      yield* seedMemory({ memoryId: "mem-future", validUntil: "2026-10-11T09:00:01.000Z" });
      for (const messageId of ["message-2", "message-3", "message-4", "message-5"]) {
        yield* seedMessage("thread-1", messageId);
      }

      for (const [messageId, memoryId] of [
        ["message-1", "mem-past"],
        ["message-2", "mem-equal"],
        ["message-3", "mem-offset"],
      ] as const) {
        assert.deepEqual(
          yield* ledger.commitDispatch(
            commitInput({
              messageId,
              items: [{ memoryId, selectedVersion: 1 }],
            }),
          ),
          { status: "held", reason: "expired" },
        );
      }
      // A non-expiring row commits — null bypasses expiry entirely.
      const future = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-4",
          items: [{ memoryId: "mem-future", selectedVersion: 1 }],
        }),
      );
      assert.equal(future.status, "committed");
      const noExpiry = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-5",
          items: [{ memoryId: "mem-1", selectedVersion: 1 }],
        }),
      );
      assert.equal(noExpiry.status, "committed");
    }));

  test("L3 context-mismatch holds for tombstoned or foreign provenance", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedProject("project-dead", "2026-10-10T00:00:00.000Z");
      yield* seedThread("project-dead", "thread-dead");
      yield* seedMessage("thread-dead", "message-dead");
      yield* seedThread("project-1", "thread-2", "2026-10-10T00:00:00.000Z");
      yield* seedMessage("thread-2", "message-t2");
      yield* seedThread("project-1", "thread-3");
      yield* seedMessage("thread-3", "message-t3");
      yield* seedMessage("thread-1", "message-assistant", "assistant");

      for (const input of [
        // tombstoned project
        commitInput({
          projectId: "project-dead",
          threadId: "thread-dead",
          messageId: "message-dead",
        }),
        // tombstoned thread
        commitInput({ threadId: "thread-2", messageId: "message-t2" }),
        // missing message
        commitInput({ messageId: "message-missing" }),
        // message belongs to another thread
        commitInput({ threadId: "thread-1", messageId: "message-t3" }),
        // non-user message
        commitInput({ messageId: "message-assistant" }),
      ]) {
        assert.deepEqual(yield* ledger.commitDispatch(input), {
          status: "held",
          reason: "context-mismatch",
        });
      }
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L3 invalid selectedVersion fails with a fixed error", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      for (const selectedVersion of [0, 1.5, 2 ** 53]) {
        const error = yield* Effect.flip(
          ledger.commitDispatch(commitInput({ items: [{ memoryId: "mem-1", selectedVersion }] })),
        );
        assert.ok(error instanceof PersistenceSqlError);
        assert.equal(error.detail, "invalid-input");
      }
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("L4 a second dispatch on the same message holds already-committed without a body", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const first = yield* ledger.commitDispatch(commitInput());
      assert.equal(first.status, "committed");
      const second = yield* ledger.commitDispatch(commitInput());
      assert.deepEqual(second, { status: "held", reason: "already-committed" });
      assert.ok(!("memories" in second));
      expect((yield* attemptRows).length).toBe(1);
    }));

  test("L5 commit-boundary failure: fixed error, zero durable rows, fresh-client retry", () =>
    withDbFile((dbPath) =>
      Effect.gen(function* () {
        // Phase A — client A takes a deferred-FK fault at COMMIT, then its
        // scope disposes the connection entirely.
        yield* runIsolatedLedger(
          dbPath,
          Effect.gen(function* () {
            const ledger = yield* ProjectMemorySendLedger;
            const sql = yield* SqlClient.SqlClient;
            yield* setPragmas;
            yield* runMigrations();
            yield* seedSendContext;
            // Deferred FK: the item fires inside the transaction but only
            // fails when COMMIT checks it — a defect at the commit boundary.
            yield* sql`CREATE TABLE l5_parent (id INTEGER PRIMARY KEY)`;
            yield* sql`
              CREATE TABLE l5_child (
                x INTEGER REFERENCES l5_parent(id) DEFERRABLE INITIALLY DEFERRED
              )
            `;
            yield* sql`
              CREATE TRIGGER l5_commit_fault AFTER INSERT ON project_memory_send_attempts
              BEGIN INSERT INTO l5_child (x) VALUES (1); END
            `;

            const error = yield* Effect.flip(ledger.commitDispatch(commitInput()));
            assert.ok(error instanceof PersistenceSqlError);
            assert.equal(error.detail, "transaction-failed");

            // Observe the shared connection for the report without assuming
            // the failed COMMIT left it clean — recovery below is proven on a
            // fresh client after this scope disposes the connection.
            const self = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS "n" FROM project_memory_send_attempts
            `;
            console.info("l5 same-connection attempts after failed commit:", self[0]?.n);
          }),
        );

        // Phase B — client B sees nothing durable and removes the fault.
        yield* runWithClient(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* setPragmas;
            const rows = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS "n" FROM project_memory_send_attempts
            `;
            assert.equal(rows[0]?.n, 0);
            yield* sql`DROP TRIGGER l5_commit_fault`;
          }),
        );

        // Phase C — a fresh client and a fresh owner commit cleanly. A new
        // ledger over the poisoned connection would not prove recovery, so the
        // failed scope was closed first.
        const result = yield* runIsolatedLedger(
          dbPath,
          Effect.gen(function* () {
            const ledger = yield* ProjectMemorySendLedger;
            yield* setPragmas;
            return yield* ledger.commitDispatch(commitInput());
          }),
        );
        assert.equal(result.status, "committed");
      }),
    ));

  test("L6 item insert failure rolls back the whole commit", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* sql`
          CREATE TRIGGER l6_item_fault BEFORE INSERT ON project_memory_send_items
          BEGIN SELECT RAISE(ABORT, 'injected item failure'); END
        `;

      const error = yield* Effect.flip(ledger.commitDispatch(commitInput()));
      assert.ok(error instanceof PersistenceSqlError);
      expect((yield* attemptRows).length).toBe(0);
      expect((yield* itemRows).length).toBe(0);

      yield* sql`DROP TRIGGER l6_item_fault`;
      const retry = yield* ledger.commitDispatch(commitInput());
      assert.equal(retry.status, "committed");
    }));

  test("L7 ambiguous commit: an interrupted caller leaves durable state only", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      // Deterministic boundary: the child is parked on a gate in front of
      // the ledger call, so this interrupt provably lands before its
      // transaction — the call never ran and nothing is durable.
      const gate = yield* Deferred.make<void>();
      const gated = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(gate);
          return yield* ledger.commitDispatch(commitInput());
        }),
      );
      yield* Fiber.interrupt(gated);
      const gatedExit = yield* Fiber.await(gated);
      if (!Exit.isFailure(gatedExit)) {
        return assert.fail("expected the gated fiber to be interrupted");
      }
      // Interruption propagates; it is not converted into a typed failure.
      assert.ok(Cause.hasInterrupts(gatedExit.cause));
      assert.ok(Option.isNone(Cause.findErrorOption(gatedExit.cause)));
      assert.deepEqual(yield* attemptRows, []);
      assert.deepEqual(yield* itemRows, []);

      // A retry on the clean store commits normally.
      const retry = yield* ledger.commitDispatch(commitInput());
      assert.equal(retry.status, "committed");

      // Ambiguous boundary: an interrupt that races an in-flight commit can
      // only be resolved by durable state — never by the lost body.
      yield* seedMessage("thread-1", "message-2");
      const racing = yield* Effect.forkChild(
        ledger.commitDispatch(commitInput({ messageId: "message-2" })),
      );
      yield* Fiber.interrupt(racing);
      const racingExit = yield* Fiber.await(racing);
      const attempts = yield* attemptRows;
      if (attempts.length === 2) {
        // COMMIT won the race — a second admission only learns the hold.
        assert.deepEqual(yield* ledger.commitDispatch(commitInput({ messageId: "message-2" })), {
          status: "held",
          reason: "already-committed",
        });
        if (Exit.isSuccess(racingExit)) {
          assert.equal(racingExit.value.status, "committed");
        } else {
          assert.ok(Cause.hasInterrupts(racingExit.cause));
        }
      } else {
        // Interrupted before COMMIT — no durable row, retry commits.
        assert.equal(attempts.length, 1);
        if (!Exit.isFailure(racingExit)) {
          return assert.fail("expected the racing fiber to be interrupted");
        }
        assert.ok(Cause.hasInterrupts(racingExit.cause));
        const racedRetry = yield* ledger.commitDispatch(commitInput({ messageId: "message-2" }));
        assert.equal(racedRetry.status, "committed");
      }
    }));

  test("L8 settle distinguishes applied, already-final, not-found and not-owned", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const applied = yield* ledger.settle({
        attemptSeq: committed.attemptSeq,
        outcome: "provider_accepted",
        now: NOW,
      });
      assert.deepEqual(applied, { status: "applied", state: "provider_accepted" });

      // accepted -> unknown is not a supported transition.
      const again = yield* ledger.settle({
        attemptSeq: committed.attemptSeq,
        outcome: "external_send_unknown",
        now: NOW,
      });
      assert.deepEqual(again, { status: "already-final", state: "provider_accepted" });

      const missing = yield* ledger.settle({
        attemptSeq: 9999,
        outcome: "provider_accepted",
        now: NOW,
      });
      assert.deepEqual(missing, { status: "not-found" });

      const badSeq = yield* Effect.flip(
        ledger.settle({ attemptSeq: 1.5, outcome: "provider_accepted", now: NOW }),
      );
      assert.ok(badSeq instanceof PersistenceSqlError);
      assert.equal(badSeq.detail, "invalid-input");

      // A different owner instance cannot settle this ledger's pending row.
      // `make` runs a fresh owner-instance allocation — Layer.build on the
      // same layer reference would return the memoized service instead.
      yield* ledger.reconcileOtherOwners({ now: NOW });
      yield* seedMessage("thread-1", "message-2");
      const second = yield* ledger.commitDispatch(commitInput({ messageId: "message-2" }));
      if (second.status !== "committed") return assert.fail("expected committed");
      const otherLedger = yield* make.pipe(Effect.provide(NodeCrypto.layer));
      const foreign = yield* otherLedger.settle({
        attemptSeq: second.attemptSeq,
        outcome: "provider_accepted",
        now: NOW,
      });
      assert.deepEqual(foreign, { status: "not-owned", state: "dispatch_committed" });
    }));

  test("L9 acknowledge is monotone, bounded, and held spans the whole history", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");

      assert.deepEqual(
        yield* ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 50 }),
        {
          held: false,
          latestChangeSeq: null,
          ackedThrough: 0,
          changes: [],
        },
      );

      yield* bumpMemory("mem-1", "a");
      const heldFirst = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 50,
      });
      assert.equal(heldFirst.held, true);
      assert.equal(heldFirst.latestChangeSeq, 1);

      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 1,
        }),
        { status: "applied", ackedThrough: 1 },
      );
      const cleared = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 50,
      });
      assert.equal(cleared.held, false);
      assert.equal(cleared.ackedThrough, 1);

      // Later changes re-hold the thread.
      yield* bumpMemory("mem-1", "b");
      const heldSecond = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 50,
      });
      assert.equal(heldSecond.held, true);
      assert.equal(heldSecond.latestChangeSeq, 2);

      // Acks beyond the recorded history are invalid; older ones are no-ops.
      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 5,
        }),
        { status: "invalid" },
      );
      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 0,
        }),
        { status: "unchanged", ackedThrough: 1 },
      );
      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 1,
        }),
        { status: "unchanged", ackedThrough: 1 },
      );
      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 2,
        }),
        { status: "applied", ackedThrough: 2 },
      );
      const clearedAgain = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 50,
      });
      assert.equal(clearedAgain.held, false);

      // Sixty more changes: the page is bounded but held/latest are not.
      for (let i = 0; i < 60; i += 1) {
        yield* bumpMemory("mem-1", `p${i}`);
      }
      const paged = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 5,
      });
      assert.equal(paged.held, true);
      assert.equal(paged.latestChangeSeq, 62);
      assert.equal(paged.ackedThrough, 2);
      assert.equal(paged.changes.length, 5);
      assert.equal(paged.changes[0]?.changeSeq, 62);
      assert.ok(
        paged.changes.every(
          (change, index) => change.changeSeq === 62 - index && change.reason === "updated",
        ),
      );
    }));

  test("L10 privacy: malformed stored rows and ledger tables never echo secrets", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      // A raw write outside the supported repository left a TEXT version;
      // the row is refused by decode without quoting any of it.
      yield* seedMemory({
        memoryId: "mem-secret",
        title: "SECRET-T",
        body: "SECRET-B",
        version: "SECRET-X",
      });

      const exit = yield* Effect.exit(
        ledger.commitDispatch(
          commitInput({ items: [{ memoryId: "mem-secret", selectedVersion: 1 }] }),
        ),
      );
      assert.ok(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag !== "Some" || !(failure.value instanceof PersistenceDecodeError)) {
        return assert.fail("expected a refined PersistenceDecodeError");
      }
      assert.equal(failure.value.issue, "row-invalid");
      const rendered = [
        JSON.stringify(exit.cause),
        String(failure.value),
        Cause.pretty(exit.cause),
      ].join("\n");
      for (const secret of ["SECRET-T", "SECRET-B", "SECRET-X"]) {
        assert.notInclude(rendered, secret);
      }

      const sql = yield* SqlClient.SqlClient;
      for (const table of [
        "project_memory_send_attempts",
        "project_memory_send_items",
        "project_memory_affected",
        "project_memory_thread_acks",
      ]) {
        const rows = yield* sql`SELECT * FROM ${sql(table)}`;
        const serialized = JSON.stringify(rows);
        for (const secret of ["SECRET-T", "SECRET-B", "SECRET-X"]) {
          assert.notInclude(serialized, secret);
        }
      }
    }));

  test("L11 malformed ack scalars fail closed without leaking or mutating", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");
      yield* bumpMemory("mem-1", "a");
      assert.deepEqual(
        yield* ledger.acknowledge({
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 1,
        }),
        { status: "applied", ackedThrough: 1 },
      );
      yield* bumpMemory("mem-1", "b");

      const rowInvalidFailure = (exit: Exit.Exit<unknown, unknown>) => {
        if (!Exit.isFailure(exit)) {
          return assert.fail("expected a failure exit for a malformed head");
        }
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag !== "Some" || !(failure.value instanceof PersistenceDecodeError)) {
          return assert.fail("expected a refined PersistenceDecodeError");
        }
        assert.equal(failure.value.issue, "row-invalid");
      };
      const storedAck = Effect.gen(function* () {
        const rows = yield* sql<{ readonly acked: unknown }>`
          SELECT acked_through_change_seq AS "acked"
          FROM project_memory_thread_acks WHERE thread_id = 'thread-1'
        `;
        return rows[0]?.acked;
      });
      const stateAndAck = () =>
        Effect.gen(function* () {
          const stateExit = yield* Effect.exit(
            ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 5 }),
          );
          rowInvalidFailure(stateExit);
          const ackExit = yield* Effect.exit(
            ledger.acknowledge({
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 2,
            }),
          );
          rowInvalidFailure(ackExit);
          return stateExit;
        });

      // INTEGER affinity plus a >=0 CHECK accepts arbitrary TEXT — the
      // corrupted head must fail closed, never coerce the hold away.
      yield* sql`
        UPDATE project_memory_thread_acks SET acked_through_change_seq = 'SECRET-ACK'
        WHERE thread_id = 'thread-1'
      `;
      const textExit = yield* stateAndAck();
      if (!Exit.isFailure(textExit)) {
        return assert.fail("expected a failure exit for a malformed head");
      }
      const textFailure = Cause.findErrorOption(textExit.cause);
      const rendered = [
        JSON.stringify(textExit.cause),
        textFailure._tag === "Some" ? String(textFailure.value) : "",
        Cause.pretty(textExit.cause),
      ].join("\n");
      assert.notInclude(rendered, "SECRET-ACK");
      // The failed acknowledge never wrote — the corrupted value persists.
      assert.equal(yield* storedAck, "SECRET-ACK");

      yield* sql`
        UPDATE project_memory_thread_acks SET acked_through_change_seq = 1.5
        WHERE thread_id = 'thread-1'
      `;
      yield* stateAndAck();
      assert.equal(yield* storedAck, 1.5);

      // A restored valid head reads normally and re-opens the hold.
      yield* sql`
        UPDATE project_memory_thread_acks SET acked_through_change_seq = 1
        WHERE thread_id = 'thread-1'
      `;
      const recovered = yield* ledger.affectedState({
        threadId: ThreadId.make("thread-1"),
        limit: 5,
      });
      assert.equal(recovered.held, true);
      assert.equal(recovered.latestChangeSeq, 2);
      assert.equal(recovered.ackedThrough, 1);
    }));

  test("L12 a foreign persistence error is rebuilt into a fixed local error", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");

      // A dependency that fails with a fully-populated foreign error must
      // not carry its fields across this repository's boundary. The same
      // client instance the ledger captured is faulted in place — a wrapper
      // object would not be a callable sql tag.
      const foreign = new PersistenceSqlError({
        operation: "upstream",
        detail: "SECRET-DETAIL",
        cause: { body: "SECRET-CAUSE" },
      });
      const originalWithTransaction = sql.withTransaction;
      Object.assign(sql, { withTransaction: () => Effect.fail(foreign) });
      yield* seedMessage("thread-1", "message-2");
      const exit = yield* Effect.exit(
        ledger.commitDispatch(commitInput({ messageId: "message-2" })),
      );
      Object.assign(sql, { withTransaction: originalWithTransaction });
      assert.ok(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag !== "Some" || !(failure.value instanceof PersistenceSqlError)) {
        return assert.fail("expected a refined PersistenceSqlError");
      }
      assert.equal(failure.value.operation, "ProjectMemorySendLedger.commitDispatch");
      assert.equal(failure.value.detail, undefined);
      assert.equal(failure.value.cause, undefined);
      assert.equal(failure.value.correlation, undefined);
      const rendered = [
        JSON.stringify(exit.cause),
        String(failure.value),
        Cause.pretty(exit.cause),
      ].join("\n");
      for (const secret of ["SECRET-DETAIL", "SECRET-CAUSE", "upstream"]) {
        assert.notInclude(rendered, secret);
      }
      // The boundary failed before COMMIT — nothing durable was written.
      assert.equal((yield* attemptRows).length, 1);
    }));

  // R1 — revalidateDispatch judges a committed dispatch against the live
  // memory metadata at adapter-entry time: same attempt-bound context rules
  // as commit, memory metadata only (never a title or body), and the clock
  // sampled once inside the read transaction.

  test("R1 revalidate returns valid while memory, provenance, and owner are unchanged", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      const valid = yield* ledger.revalidateDispatch(revalidateInput());
      if (valid.status !== "valid") return assert.fail("expected valid");
      assert.isNull(valid.minValidUntilMillis);
      assert.isTrue(ledger.mutationFenceHolds(valid.fence));
    }));

  test("R1 version-changed holds even after acknowledgement; deletion is unavailable", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      yield* bumpMemory("mem-1", "a");
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput()), {
        status: "held",
        reason: "version-changed",
      });
      // The affected-change acknowledgement is irrelevant to revalidation.
      const state = yield* ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 1 });
      const latest = state.latestChangeSeq;
      assert.notStrictEqual(latest, null);
      const acked = yield* ledger.acknowledge({
        threadId: ThreadId.make("thread-1"),
        throughChangeSeq: latest!,
      });
      assert.equal(acked.status, "applied");
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput()), {
        status: "held",
        reason: "version-changed",
      });

      yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-1'`;
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput()), {
        status: "held",
        reason: "unavailable",
      });
    }));

  test("R1 expiry compares against the sampled clock; unparseable expiry is unavailable", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      // Valid at commit time (commit reads the injected now); revalidation
      // samples the clock inside the read instead.
      yield* seedMemory({ memoryId: "mem-expiring", validUntil: "2026-10-11T09:00:01.000Z" });
      yield* seedMemory({ memoryId: "mem-later-broken", validUntil: "2026-10-12T09:00:00.000Z" });
      yield* seedMessage("thread-1", "message-2");
      yield* seedMessage("thread-1", "message-3");

      const committed = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-2",
          items: [{ memoryId: "mem-expiring", selectedVersion: 1 }],
        }),
      );
      if (committed.status !== "committed") return assert.fail("expected committed");

      // One moment before expiry the dispatch is still valid.
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
      const before = yield* ledger.revalidateDispatch(revalidateInput());
      if (before.status !== "valid") return assert.fail("expected valid");

      // The same instant as valid_until is expired.
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW) + 1_000);
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput()), {
        status: "held",
        reason: "expired",
      });

      // An expiry that was valid at commit but unparseable afterwards is
      // unavailable, not expired.
      const second = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-3",
          items: [{ memoryId: "mem-later-broken", selectedVersion: 1 }],
        }),
      );
      if (second.status !== "committed") return assert.fail("expected committed");
      yield* sql`
        UPDATE project_memories SET valid_until = 'garbage' WHERE memory_id = 'mem-later-broken'
      `;
      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq: second.attemptSeq })),
        { status: "held", reason: "unavailable" },
      );
    }));

  test("R1 context-mismatch: foreign thread, instance, owner, settled state, tombstones, missing message", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMessage("thread-1", "message-2");
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");
      const attemptSeq = committed.attemptSeq;

      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ threadId: "thread-2" })),
        { status: "held", reason: "context-mismatch" },
      );
      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ providerInstanceId: "other" })),
        { status: "held", reason: "context-mismatch" },
      );
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq: 9999 })), {
        status: "held",
        reason: "context-mismatch",
      });

      // A different owner instance never revalidates this process's attempt.
      const otherLedger = yield* make.pipe(Effect.provide(NodeCrypto.layer));
      assert.deepEqual(yield* otherLedger.revalidateDispatch(revalidateInput({ attemptSeq })), {
        status: "held",
        reason: "context-mismatch",
      });

      // A settled attempt is no longer this dispatch.
      yield* ledger.settle({ attemptSeq, outcome: "provider_accepted", now: NOW });
      assert.deepEqual(yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq })), {
        status: "held",
        reason: "context-mismatch",
      });

      // Tombstoned provenance and a missing user message, on a fresh attempt.
      const second = yield* ledger.commitDispatch(commitInput({ messageId: "message-2" }));
      if (second.status !== "committed") return assert.fail("expected committed");
      const secondSeq = second.attemptSeq;

      yield* sql`
        UPDATE projection_threads SET deleted_at = ${NOW_ISO} WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq: secondSeq })),
        { status: "held", reason: "context-mismatch" },
      );
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'thread-1'`;

      yield* sql`
        UPDATE projection_projects SET deleted_at = ${NOW_ISO} WHERE project_id = 'project-1'
      `;
      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq: secondSeq })),
        { status: "held", reason: "context-mismatch" },
      );
      yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project-1'`;

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'message-2'`;
      assert.deepEqual(
        yield* ledger.revalidateDispatch(revalidateInput({ attemptSeq: secondSeq })),
        { status: "held", reason: "context-mismatch" },
      );
    }));

  test("R1 invalid attemptSeq is a fixed typed invalid-input error, never a hold", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      for (const attemptSeq of [0, -3, 1.5, 2 ** 53]) {
        const error = yield* Effect.flip(
          ledger.revalidateDispatch(revalidateInput({ attemptSeq })),
        );
        assert.ok(error instanceof PersistenceSqlError);
        assert.equal(error.operation, "ProjectMemorySendLedger.revalidateDispatch");
        assert.equal(error.detail, "invalid-input");
      }
      expect((yield* attemptRows).length).toBe(0);
    }));

  test("R1 revalidation reads no memory body and never echoes secrets", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-secret", title: "SECRET-T", body: "SECRET-B" });
      yield* seedMessage("thread-1", "message-2");
      const committed = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-2",
          items: [{ memoryId: "mem-secret", selectedVersion: 1 }],
        }),
      );
      if (committed.status !== "committed") return assert.fail("expected committed");
      const valid = yield* ledger.revalidateDispatch(
        revalidateInput({ attemptSeq: committed.attemptSeq }),
      );
      if (valid.status !== "valid") return assert.fail("expected valid");

      // The persisted item rows are immutable by trigger, so the damaged-row
      // fixture drops that guard only inside this test's own database, damages
      // the row, and restores the trigger exactly as migrated — production
      // immutability is never weakened.
      yield* sql`DROP TRIGGER project_memory_send_items_immutable`;
      yield* sql`
        UPDATE project_memory_send_items SET memory_version = 'SECRET-X'
        WHERE attempt_seq = ${committed.attemptSeq}
      `;
      yield* sql`
        CREATE TRIGGER project_memory_send_items_immutable BEFORE UPDATE ON project_memory_send_items
        BEGIN SELECT RAISE(ABORT, 'project memory send item is immutable'); END
      `;
      const exit = yield* Effect.exit(
        ledger.revalidateDispatch(revalidateInput({ attemptSeq: committed.attemptSeq })),
      );
      assert.ok(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag !== "Some" || !(failure.value instanceof PersistenceDecodeError)) {
        return assert.fail("expected a refined PersistenceDecodeError");
      }
      assert.equal(failure.value.operation, "ProjectMemorySendLedger.revalidateDispatch");
      assert.equal(failure.value.issue, "row-invalid");
      const rendered = [
        JSON.stringify(exit.cause),
        String(failure.value),
        Cause.pretty(exit.cause),
      ].join("\n");
      for (const secret of ["SECRET-T", "SECRET-B", "SECRET-X"]) {
        assert.notInclude(rendered, secret);
      }
    }));

  // C1 — the expectedProjectId transaction guard. The scope check runs first
  // inside the acknowledge transaction, so valid integer inputs that would
  // otherwise classify as applied, invalid, or unchanged come back
  // scope-mismatch instead, and no ack row is ever written.

  test("C1 expectedProjectId applies and keeps unchanged on a live matching scope", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");
      yield* bumpMemory("mem-1", "a");

      assert.deepEqual(yield* ledger.acknowledge(ackInput({ expectedProjectId: "project-1" })), {
        status: "applied",
        ackedThrough: 1,
      });
      assert.deepEqual(yield* ackRows, [{ threadId: "thread-1", acked: 1 }]);

      // Same or older watermarks through the live matching scope stay no-ops.
      assert.deepEqual(
        yield* ledger.acknowledge(
          ackInput({ throughChangeSeq: 1, expectedProjectId: "project-1" }),
        ),
        { status: "unchanged", ackedThrough: 1 },
      );
      assert.deepEqual(
        yield* ledger.acknowledge(
          ackInput({ throughChangeSeq: 0, expectedProjectId: "project-1" }),
        ),
        { status: "unchanged", ackedThrough: 1 },
      );
      assert.deepEqual(yield* ackRows, [{ threadId: "thread-1", acked: 1 }]);
    }));

  test("C1 scope-mismatch precedes classification and never mutates acks", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");
      yield* bumpMemory("mem-1", "a");
      yield* seedProject("project-2");

      // A live foreign project (and a missing one) mismatches even for inputs
      // that would otherwise be applied, invalid, or unchanged.
      for (const input of [
        ackInput({ expectedProjectId: "project-2" }),
        ackInput({ throughChangeSeq: 5, expectedProjectId: "project-2" }),
        ackInput({ throughChangeSeq: 0, expectedProjectId: "project-2" }),
        ackInput({ expectedProjectId: "project-missing" }),
      ]) {
        assert.deepEqual(yield* ledger.acknowledge(input), { status: "scope-mismatch" });
      }
      assert.deepEqual(yield* ackRows, []);

      // Tombstoned project under the live thread.
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW_ISO} WHERE project_id = 'project-1'`;
      assert.deepEqual(yield* ledger.acknowledge(ackInput({ expectedProjectId: "project-1" })), {
        status: "scope-mismatch",
      });
      yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project-1'`;

      // Tombstoned thread under the live project.
      yield* sql`UPDATE projection_threads SET deleted_at = ${NOW_ISO} WHERE thread_id = 'thread-1'`;
      assert.deepEqual(yield* ledger.acknowledge(ackInput({ expectedProjectId: "project-1" })), {
        status: "scope-mismatch",
      });
      assert.deepEqual(yield* ackRows, []);
    }));

  test("C1 absent expectedProjectId keeps existing behavior; nested guard still rejects", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      assert.equal(committed.status, "committed");
      yield* bumpMemory("mem-1", "a");

      // The top-level transaction guard still applies to acknowledge.
      const error = yield* sql.withTransaction(
        Effect.flip(ledger.acknowledge(ackInput({ expectedProjectId: "project-1" }))),
      );
      assert.ok(error instanceof PersistenceSqlError);
      assert.equal(error.detail, "nested-transaction");
      assert.deepEqual(yield* ackRows, []);

      // Without the field the outcomes are exactly the existing ones.
      assert.deepEqual(yield* ledger.acknowledge(ackInput()), {
        status: "applied",
        ackedThrough: 1,
      });
      assert.deepEqual(yield* ledger.acknowledge(ackInput({ throughChangeSeq: 0 })), {
        status: "unchanged",
        ackedThrough: 1,
      });
      assert.deepEqual(yield* ackRows, [{ threadId: "thread-1", acked: 1 }]);
    }));

  // F — the mutation fence: a synchronous epoch/inflight pair on this
  // instance. captureMutationFence snapshots the epoch; withMemoryMutation
  // counts the wrapped effect in flight and bumps the epoch on every exit —
  // success, failure, defect, or interruption — so a fence captured before a
  // mutation can never hold afterwards.

  test("F1 a captured fence holds while nothing ran; revalidate returns the same fence", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      const fence = ledger.captureMutationFence();
      assert.isTrue(ledger.mutationFenceHolds(fence));

      const valid = yield* ledger.revalidateDispatch(revalidateInput());
      if (valid.status !== "valid") return assert.fail("expected valid");
      assert.equal(valid.fence.epoch, fence.epoch);
      assert.isTrue(ledger.mutationFenceHolds(valid.fence));
    }));

  test("F2 an update inside withMemoryMutation breaks a fence captured before it", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      yield* ledger.withMemoryMutation(bumpMemory("mem-1", "fenced"));
      assert.isFalse(ledger.mutationFenceHolds(fence));
      // A fence captured after the mutation holds again — the pair is
      // epoch-only, so settling retires in-flight rather than wedging.
      assert.isTrue(ledger.mutationFenceHolds(ledger.captureMutationFence()));
    }));

  test("F3 a delete inside withMemoryMutation breaks a fence captured before it", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      yield* ledger.withMemoryMutation(sql`DELETE FROM project_memories WHERE memory_id = 'mem-1'`);
      assert.isFalse(ledger.mutationFenceHolds(fence));
    }));

  test("F4 an in-flight mutation breaks the fence immediately and permanently", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        ledger.withMemoryMutation(
          Effect.flatMap(Deferred.succeed(started, undefined), () => Deferred.await(release)),
        ),
      );
      // Deterministic: `started` only completes inside the wrapped use, so
      // the in-flight count is already incremented here.
      yield* Deferred.await(started);
      assert.isFalse(ledger.mutationFenceHolds(fence));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(fiber);
      // The old fence stays broken after settle; only a fresh capture holds.
      assert.isFalse(ledger.mutationFenceHolds(fence));
      const fresh = ledger.captureMutationFence();
      assert.equal(fresh.epoch, fence.epoch + 1);
      assert.isTrue(ledger.mutationFenceHolds(fresh));
    }));

  test("F5 interruption retires in-flight and bumps the epoch", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        ledger.withMemoryMutation(
          Effect.flatMap(Deferred.succeed(started, undefined), () => Effect.never),
        ),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      if (!Exit.isFailure(exit)) return assert.fail("expected the parked mutation to interrupt");
      assert.ok(Cause.hasInterrupts(exit.cause));
      assert.isFalse(ledger.mutationFenceHolds(fence));
      const fresh = ledger.captureMutationFence();
      assert.equal(fresh.epoch, fence.epoch + 1);
      assert.isTrue(ledger.mutationFenceHolds(fresh));
    }));

  test("F6 failure and defect exits still bump the epoch; the wrapped cause is transparent", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      const typed = new PersistenceSqlError({ operation: "fence-test" });
      const exit = yield* Effect.exit(
        ledger.withMemoryMutation(
          Effect.failCause(Cause.combine(Cause.fail(typed), Cause.interrupt())),
        ),
      );
      if (!Exit.isFailure(exit)) return assert.fail("expected the mixed cause to fail");
      // The original cause crosses the wrapper untouched: the typed failure
      // survives and the interrupt reason is still interrupt.
      const failure = Cause.findErrorOption(exit.cause);
      assert.ok(Option.isSome(failure));
      assert.strictEqual(failure.value, typed);
      assert.ok(Cause.hasInterrupts(exit.cause));
      assert.isFalse(ledger.mutationFenceHolds(fence));
      assert.isTrue(ledger.mutationFenceHolds(ledger.captureMutationFence()));

      const defectFence = ledger.captureMutationFence();
      const defectExit = yield* Effect.exit(
        ledger.withMemoryMutation(Effect.die(new Error("boom"))),
      );
      if (!Exit.isFailure(defectExit)) return assert.fail("expected the defect to fail");
      assert.ok(defectExit.cause.reasons.some(Cause.isDieReason));
      assert.isFalse(ledger.mutationFenceHolds(defectFence));
    }));

  test("F7 the fence spans the real outer transaction commit, not a savepoint", (dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;

      const fence = ledger.captureMutationFence();
      const inTransaction = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        ledger.withMemoryMutation(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* bumpMemory("mem-1", "fenced");
              yield* Deferred.succeed(inTransaction, undefined);
              yield* Deferred.await(release);
            }),
          ),
        ),
      );
      // The write is uncommitted while the transaction is parked: an
      // independent client still sees the old row and every captured fence
      // is broken.
      yield* Deferred.await(inTransaction);
      assert.isFalse(ledger.mutationFenceHolds(fence));
      const uncommitted = yield* runWithClient(
        dbPath,
        Effect.gen(function* () {
          yield* setPragmas;
          const sql2 = yield* SqlClient.SqlClient;
          return yield* sql2<{ readonly title: string }>`
            SELECT title FROM project_memories WHERE memory_id = 'mem-1'
          `;
        }),
      );
      assert.equal(uncommitted[0]?.title, "Deploy runbook");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(fiber);
      // The wrapper released only after COMMIT: the write is durable and the
      // old fence retired exactly then.
      assert.isFalse(ledger.mutationFenceHolds(fence));
      const fresh = ledger.captureMutationFence();
      assert.isTrue(ledger.mutationFenceHolds(fresh));
      const committed = yield* runWithClient(
        dbPath,
        Effect.gen(function* () {
          yield* setPragmas;
          const sql2 = yield* SqlClient.SqlClient;
          return yield* sql2<{ readonly title: string }>`
            SELECT title FROM project_memories WHERE memory_id = 'mem-1'
          `;
        }),
      );
      assert.equal(committed[0]?.title, "Runbook fenced");
    }));

  test("F8 withMemoryMutation and the admission read refuse an ambient transaction", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      const committed = yield* ledger.commitDispatch(commitInput());
      if (committed.status !== "committed") return assert.fail("expected committed");

      // Inside a caller's transaction the fence is never acquired: the call
      // dies as a fixed programming defect and the counters are untouched.
      const fence = ledger.captureMutationFence();
      const exit = yield* Effect.exit(
        sql.withTransaction(ledger.withMemoryMutation(bumpMemory("mem-1", "nested"))),
      );
      if (!Exit.isFailure(exit)) return assert.fail("expected the nested mutation to die");
      assert.ok(exit.cause.reasons.some(Cause.isDieReason));
      assert.ok(Option.isNone(Cause.findErrorOption(exit.cause)));
      assert.isTrue(ledger.mutationFenceHolds(fence));
      const rows = yield* sql<{ readonly title: string }>`
        SELECT title FROM project_memories WHERE memory_id = 'mem-1'
      `;
      assert.equal(rows[0]?.title, "Deploy runbook");

      // The admission read is a top-level transaction too.
      const error = yield* sql.withTransaction(
        Effect.flip(ledger.revalidateDispatch(revalidateInput())),
      );
      assert.ok(error instanceof PersistenceSqlError);
      assert.equal(error.detail, "nested-transaction");
    }));

  test("F9 the valid result carries the minimum item expiry in millis", (_dbPath) =>
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedSendContext;
      yield* seedMemory({ memoryId: "mem-exp-1", validUntil: "2026-10-11T11:00:00.000Z" });
      yield* seedMemory({ memoryId: "mem-exp-2", validUntil: "2026-10-11T10:00:00.000Z" });
      yield* seedMessage("thread-1", "message-2");
      const committed = yield* ledger.commitDispatch(
        commitInput({
          messageId: "message-2",
          items: [
            { memoryId: "mem-1", selectedVersion: 1 },
            { memoryId: "mem-exp-1", selectedVersion: 1 },
            { memoryId: "mem-exp-2", selectedVersion: 1 },
          ],
        }),
      );
      if (committed.status !== "committed") return assert.fail("expected committed");
      const valid = yield* ledger.revalidateDispatch(
        revalidateInput({ attemptSeq: committed.attemptSeq }),
      );
      if (valid.status !== "valid") return assert.fail("expected valid");
      assert.equal(valid.minValidUntilMillis, Date.parse("2026-10-11T10:00:00.000Z"));
    }));
});
