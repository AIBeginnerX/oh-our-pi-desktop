// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectId, ProjectMemoryId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import { ProjectMemoryRepository, layer as projectMemoriesLayer } from "../ProjectMemories.ts";

const NOW = "2026-10-09T00:00:00.000Z";

// One fresh file database per test so migration state and seeded rows never
// leak across cases (same harness as 056_ProjectMemories.test.ts).
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-057-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return effect.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (name: string, run: () => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
  it.effect(name, () => withTestDatabase(run()));

const setPragmas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA busy_timeout = 5000`;
});

const seedProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
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
        ${NOW}, ${NOW}, ${deletedAt}
      )
    `;
  });

const seedMessage = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, 'user', 'text', 0, ${NOW}, ${NOW})
    `;
  });

const seedMemory = (projectId: string, memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly rowid: number }>`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (
        ${memoryId}, ${projectId}, 'fact', 'Deploy runbook', 'Restart the server', 1,
        'manual', NULL, NULL,
        NULL, 10, ${NOW}, ${NOW}
      )
      RETURNING memory_rowid AS rowid
    `;
    yield* sql`
      INSERT INTO project_memory_fts (rowid, title, body)
      VALUES (${rows[0]?.rowid ?? -1}, 'Deploy runbook', 'Restart the server')
    `;
  });

const seedAttempt = (input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly projectId: string;
  readonly memoryIds: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly attemptSeq: number }>`
      INSERT INTO project_memory_send_attempts (
        thread_id, message_id, project_id, provider_instance_id,
        owner_instance_id, state, committed_at, settled_at
      )
      VALUES (
        ${input.threadId}, ${input.messageId}, ${input.projectId}, 'pi',
        'owner-1', 'dispatch_committed', ${NOW}, NULL
      )
      RETURNING attempt_seq AS "attemptSeq"
    `;
    const attemptSeq = rows[0]?.attemptSeq;
    assert.notEqual(attemptSeq, undefined);
    for (const memoryId of input.memoryIds) {
      yield* sql`
        INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
        VALUES (${attemptSeq}, ${memoryId}, 1)
      `;
    }
    return attemptSeq;
  });

const affectedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly changeSeq: number;
    readonly threadId: string;
    readonly memoryId: string;
    readonly reason: string;
  }>`
    SELECT change_seq AS "changeSeq", thread_id AS "threadId", memory_id AS "memoryId", reason
    FROM project_memory_affected
    ORDER BY change_seq ASC
  `;
});

const memoryRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly memoryId: string }>`
    SELECT memory_id AS "memoryId" FROM project_memories
  `;
});

const ftsRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly rowid: number }>`
    SELECT rowid FROM project_memory_fts
    WHERE project_memory_fts MATCH '"Deploy"'
  `;
});

describe("057_ProjectMemorySendLedger", () => {
  test("M1 upgrade: adds empty ledger tables and preserves memory data and FTS", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");

      const executed = yield* runMigrations({ toMigrationInclusive: 57 });
      assert.deepEqual(executed, [[57, "ProjectMemorySendLedger"]]);

      for (const table of [
        "project_memory_send_attempts",
        "project_memory_send_items",
        "project_memory_affected",
        "project_memory_thread_acks",
      ]) {
        const counts = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM ${sql(table)}
        `;
        assert.equal(counts[0]?.n, 0, `${table} starts empty`);
      }
      expect((yield* memoryRows).length).toBe(1);
      expect((yield* ftsRows).length).toBe(1);

      // Idempotent: a second run up to 57 executes nothing.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 57 }), []);
    }));

  test("M2 triggers: update/delete record one row per thread, monotonically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");
      yield* seedMemory("project-1", "mem-2");
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });

      yield* sql`UPDATE project_memories SET title = 'v2' WHERE memory_id = 'mem-1'`;
      let rows = yield* affectedRows;
      assert.deepEqual(
        rows.map((row) => ({ threadId: row.threadId, memoryId: row.memoryId, reason: row.reason })),
        [{ threadId: "thread-1", memoryId: "mem-1", reason: "updated" }],
      );

      // A second attempt on the same thread still yields one DISTINCT row.
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-2",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });
      yield* sql`UPDATE project_memories SET title = 'v3' WHERE memory_id = 'mem-1'`;
      rows = yield* affectedRows;
      assert.equal(rows.length, 2);
      assert.ok(rows[1]!.changeSeq > rows[0]!.changeSeq);

      // A second thread produces its own row in the same statement.
      yield* seedAttempt({
        threadId: "thread-2",
        messageId: "message-3",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });
      yield* sql`UPDATE project_memories SET title = 'v4' WHERE memory_id = 'mem-1'`;
      rows = yield* affectedRows;
      assert.equal(rows.length, 4);
      assert.deepEqual(
        rows
          .slice(2)
          .map((row) => row.threadId)
          .sort(),
        ["thread-1", "thread-2"],
      );
      assert.ok(rows[3]!.changeSeq > rows[2]!.changeSeq && rows[2]!.changeSeq > rows[1]!.changeSeq);

      // A memory with no send items records nothing.
      yield* sql`UPDATE project_memories SET title = 'x' WHERE memory_id = 'mem-2'`;
      rows = yield* affectedRows;
      assert.equal(rows.length, 4);

      yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-1'`;
      rows = yield* affectedRows;
      assert.equal(rows.length, 6);
      assert.deepEqual(
        rows.slice(4).map((row) => ({ threadId: row.threadId, reason: row.reason })),
        [
          { threadId: "thread-1", reason: "deleted" },
          { threadId: "thread-2", reason: "deleted" },
        ],
      );
    }));

  test("M3 tombstone: project tombstone removes memory data and records 'deleted'", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });

      yield* sql`
        UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'
      `;

      expect((yield* memoryRows).length).toBe(0);
      expect((yield* ftsRows).length).toBe(0);
      const rows = yield* affectedRows;
      assert.deepEqual(
        rows.map((row) => ({ threadId: row.threadId, memoryId: row.memoryId, reason: row.reason })),
        [{ threadId: "thread-1", memoryId: "mem-1", reason: "deleted" }],
      );
    }));

  test("M4 fault: a failed affected insert rolls back memory update and project tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });
      yield* sql`
        CREATE TRIGGER abort_affected
        BEFORE INSERT ON project_memory_affected
        BEGIN SELECT RAISE(ABORT, 'injected affected failure'); END
      `;

      // (a) memory update aborts: row and FTS keep the old values.
      const updateExit = yield* Effect.exit(
        sql`UPDATE project_memories SET title = 'v2', version = 2 WHERE memory_id = 'mem-1'`,
      );
      assert.ok(Exit.isFailure(updateExit));
      const version = yield* sql<{ readonly version: number }>`
        SELECT version FROM project_memories WHERE memory_id = 'mem-1'
      `;
      assert.equal(version[0]?.version, 1);
      expect((yield* ftsRows).length).toBe(1);

      // (b) project tombstone aborts atomically: deleted_at stays null and the
      // memory plus its FTS row survive — the probe's result.json shape.
      const tombstoneExit = yield* Effect.exit(
        sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`,
      );
      assert.ok(Exit.isFailure(tombstoneExit));
      const project = yield* sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt" FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.equal(project[0]?.deletedAt, null);
      expect((yield* memoryRows).length).toBe(1);
      expect((yield* ftsRows).length).toBe(1);
      expect((yield* affectedRows).length).toBe(0);

      // (c) removing the fault lets the same tombstone succeed.
      yield* sql`DROP TRIGGER abort_affected`;
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`;
      const projectAfter = yield* sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt" FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.notEqual(projectAfter[0]?.deletedAt, null);
      expect((yield* memoryRows).length).toBe(0);
      expect((yield* ftsRows).length).toBe(0);
      const rows = yield* affectedRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.reason, "deleted");
    }));

  test("M5 finality: settled attempts and items cannot transition again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");
      const first = yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });

      // Pending -> provider_accepted is the supported transition.
      yield* sql`
        UPDATE project_memory_send_attempts
        SET state = 'provider_accepted', settled_at = ${NOW}
        WHERE attempt_seq = ${first}
      `;
      // Final states never move again, identity columns included.
      const swapExit = yield* Effect.exit(
        sql`UPDATE project_memory_send_attempts SET state = 'external_send_unknown' WHERE attempt_seq = ${first}`,
      );
      assert.ok(Exit.isFailure(swapExit));

      const second = yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-2",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });
      const identityExit = yield* Effect.exit(
        sql`UPDATE project_memory_send_attempts SET thread_id = 'thread-2' WHERE attempt_seq = ${second}`,
      );
      assert.ok(Exit.isFailure(identityExit));
      const identitySettleExit = yield* Effect.exit(
        sql`UPDATE project_memory_send_attempts SET thread_id = 'thread-2', state = 'provider_accepted' WHERE attempt_seq = ${second}`,
      );
      assert.ok(Exit.isFailure(identitySettleExit));

      const itemExit = yield* Effect.exit(
        sql`UPDATE project_memory_send_items SET memory_version = 9 WHERE attempt_seq = ${second}`,
      );
      assert.ok(Exit.isFailure(itemExit));
      const items = yield* sql<{ readonly memoryVersion: number }>`
        SELECT memory_version AS "memoryVersion"
        FROM project_memory_send_items WHERE attempt_seq = ${second}
      `;
      assert.equal(items[0]?.memoryVersion, 1);
    }));

  test("M6 preservation: thread lifecycle and raw projection deletes keep ledger rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedThread("project-1", "thread-1");
      yield* seedMemory("project-1", "mem-1");
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });
      yield* sql`UPDATE project_memories SET title = 'v2' WHERE memory_id = 'mem-1'`;
      yield* sql`
        INSERT INTO project_memory_thread_acks (thread_id, acked_through_change_seq)
        VALUES ('thread-1', 1)
      `;

      const ledgerCounts = () =>
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          const attempts = yield* s<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM project_memory_send_attempts`;
          const items = yield* s<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM project_memory_send_items`;
          const affected = yield* s<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM project_memory_affected`;
          const acks = yield* s<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM project_memory_thread_acks`;
          return {
            attempts: attempts[0]?.n,
            items: items[0]?.n,
            affected: affected[0]?.n,
            acks: acks[0]?.n,
          };
        });
      const before = yield* ledgerCounts();

      // Thread tombstone then recreation (deleted_at NULL->non-NULL->NULL)
      // changes nothing in the ledger — it outlives incarnations.
      yield* sql`UPDATE projection_threads SET deleted_at = ${NOW} WHERE thread_id = 'thread-1'`;
      assert.deepEqual(yield* ledgerCounts(), before);
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'thread-1'`;
      assert.deepEqual(yield* ledgerCounts(), before);

      // Raw projection deletes never cascade into exposure history.
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-1'`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;
      assert.deepEqual(yield* ledgerCounts(), before);
      expect((yield* memoryRows).length).toBe(1);
    }));

  test("M7 old loader: a 56-limited loader ignores 057 and unchanged repository writes still record", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setPragmas;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedThread("project-1", "thread-1");
      yield* seedMessage("thread-1", "message-1");
      yield* seedMemory("project-1", "mem-1");
      yield* seedAttempt({
        threadId: "thread-1",
        messageId: "message-1",
        projectId: "project-1",
        memoryIds: ["mem-1"],
      });

      // Reopening with a loader that only knows <=56 is a no-op, not an error.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 56 }), []);

      // The unchanged T5a repository still fires the 057 triggers — this
      // tranche is schema behavior, not API callers.
      const repository = yield* Effect.gen(function* () {
        return yield* ProjectMemoryRepository;
      }).pipe(Effect.provide(projectMemoriesLayer));
      const updated = yield* repository.update({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
        expectedVersion: 1,
        title: "Deploy runbook v2",
        body: "Run migrations, restart, then warm the cache",
        kind: "procedure",
        validUntil: null,
        estimatedTokens: 12,
        now: "2026-10-09T01:00:00.000Z",
      });
      assert.equal(updated.status, "applied");
      let rows = yield* affectedRows;
      assert.deepEqual(
        rows.map((row) => ({ threadId: row.threadId, reason: row.reason })),
        [{ threadId: "thread-1", reason: "updated" }],
      );

      const deleted = yield* repository.delete({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
        expectedVersion: 2,
      });
      assert.equal(deleted.status, "applied");
      rows = yield* affectedRows;
      assert.deepEqual(
        rows.map((row) => ({ threadId: row.threadId, reason: row.reason })),
        [
          { threadId: "thread-1", reason: "updated" },
          { threadId: "thread-1", reason: "deleted" },
        ],
      );
    }));
});
